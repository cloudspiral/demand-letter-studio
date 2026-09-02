import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { TemplateAnalysisSchema, TemplateMapSchema, type GeneratedDraft } from "@steno/contracts";
import { ACTOR_ID, persistCitations, sourceFingerprintForMatter, pool, WORKSPACE_ID } from "./db";
import { exportDocx, extractDocxControls } from "./document-worker";
import { draftExportIssues } from "./draft-export";
import { normalizeDraftContent } from "./draft-compat";
import { supplyOmission } from "./draft-omissions";
import { ensureEditableCoverage } from "./jobs";
import { pathForKey } from "./storage";
import { analysisWithConfirmedMap, deriveGenerationTargets, templateBlockId } from "./template-map";

export interface EditorControlMetadata {
  tag: string;
  kind: "target" | "field-block";
  partName: string;
  paragraphIndex: number;
  targetId?: string;
  sequence?: number;
  blockId?: string;
  fieldKeys?: string[];
}

interface DraftDocumentRow {
  matter_id: string;
  matter_name: string;
  storage_key: string;
  template_analysis: unknown;
  template_map: unknown;
  content: unknown;
  source_fingerprint: string | null;
  current_version: number;
  version: number;
  document_storage_key: string | null;
  document_sha256: string | null;
  document_size: string | number | null;
  editor_controls: unknown;
}

const tagFor = (kind: string, value: string, sequence = 0): string => (
  `steno-${kind}-${createHash("sha256").update(value).digest("hex").slice(0, 24)}-${sequence}`
);

const safeName = (value: string): string => value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "demand-letter";

function parsedControls(value: unknown): EditorControlMetadata[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const control = item as Partial<EditorControlMetadata>;
    if (!control.tag || !control.kind || !control.partName || typeof control.paragraphIndex !== "number") return [];
    return [control as EditorControlMetadata];
  });
}

async function loadDocumentRow(draftId: string, version?: number): Promise<DraftDocumentRow | null> {
  const result = await pool.query<DraftDocumentRow>(`
    SELECT d.matter_id, m.name AS matter_name, t.storage_key,
           t.analysis AS template_analysis, tmv.map AS template_map,
           dv.content, dv.source_fingerprint, d.current_version, dv.version,
           dv.document_storage_key, dv.document_sha256, dv.document_size, dv.editor_controls
    FROM drafts d
    JOIN matters m ON m.id = d.matter_id
    JOIN templates t ON t.id = m.template_id
    JOIN draft_versions dv ON dv.draft_id = d.id AND dv.version = COALESCE($2, d.current_version)
    JOIN template_map_versions tmv ON tmv.template_id = t.id AND tmv.map_version = dv.template_map_version
    WHERE d.id = $1
  `, [draftId, version ?? null]);
  return result.rows[0] ?? null;
}

export async function materializeDraftDocument(draftId: string, version?: number) {
  const row = await loadDocumentRow(draftId, version);
  if (!row) return null;
  const content = normalizeDraftContent(row.content);
  const currentSourceFingerprint = await sourceFingerprintForMatter(row.matter_id);
  const readiness = draftExportIssues(content, {
    draftSourceFingerprint: row.source_fingerprint,
    currentSourceFingerprint,
  });
  if (row.document_storage_key && row.document_sha256) {
    const existingPath = pathForKey(row.document_storage_key);
    try {
      await fs.access(existingPath);
      return {
        path: existingPath,
        storageKey: row.document_storage_key,
        sha256: row.document_sha256,
        size: Number(row.document_size ?? 0),
        version: row.version,
        current: row.current_version === row.version,
        matterName: row.matter_name,
        content,
        readiness,
        controls: parsedControls(row.editor_controls),
      };
    } catch {
      // Recreate a missing local artifact from the immutable version snapshot.
    }
  }

  const templateMap = TemplateMapSchema.parse(row.template_map);
  const template = analysisWithConfirmedMap(TemplateAnalysisSchema.parse(row.template_analysis), templateMap);
  const mappedBlocks = new Map(templateMap.blocks.map((block) => [templateBlockId(block), block]));
  const targets = deriveGenerationTargets(template);
  const outcomeByTarget = new Map(content.outcomes.map((outcome) => [outcome.targetId, outcome]));
  const blocksByTarget = new Map<string, GeneratedDraft["sections"][number]["blocks"]>();
  for (const block of content.sections.flatMap((section) => section.blocks)) {
    if (!block.targetId) continue;
    blocksByTarget.set(block.targetId, [...(blocksByTarget.get(block.targetId) ?? []), block]);
  }
  for (const blocks of blocksByTarget.values()) blocks.sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));

  const imageSources = await pool.query<{ id: string; storage_key: string }>(`
    SELECT id, storage_key FROM source_documents
    WHERE matter_id = $1 AND status = 'ready' AND mime_type LIKE 'image/%'
    ORDER BY created_at
  `, [row.matter_id]);
  const sourcePathById = new Map(imageSources.rows.map((source) => [source.id, pathForKey(source.storage_key)]));
  const confirmed = new Set(content.confirmedOmissionTargetIds);
  const controls: EditorControlMetadata[] = [];
  const occupied = new Set<string>();
  const addControl = (control: EditorControlMetadata): boolean => {
    const position = `${control.partName}:${control.paragraphIndex}`;
    if (occupied.has(position)) return false;
    occupied.add(position);
    controls.push(control);
    return true;
  };

  const targetOperations = targets.map((target) => {
    const outcome = outcomeByTarget.get(target.id);
    if (!outcome) throw new Error(`Draft is missing generation outcome ${target.id}.`);
    const targetBlocks = blocksByTarget.get(target.id) ?? [];
    const generated = outcome.status === "generated" || outcome.status === "attorney-supplied";
    const unresolvedTextOmission = outcome.status === "omitted" && !confirmed.has(target.id) && target.kind === "narrative";
    const controlTags: string[] = [];
    if (target.kind === "narrative" && (generated || unresolvedTextOmission)) {
      const editableCount = unresolvedTextOmission ? 1 : targetBlocks.length;
      Array.from({ length: editableCount }, (_, sequence) => {
        const blockId = target.blockIds[Math.min(sequence, target.blockIds.length - 1)]!;
        const mapped = mappedBlocks.get(blockId);
        if (!mapped) throw new Error(`Template map is missing target block ${blockId}.`);
        const tag = tagFor("target", target.id, sequence);
        controlTags.push(tag);
        controls.push({
          tag,
          kind: "target",
          partName: mapped.anchor?.partName ?? "word/document.xml",
          paragraphIndex: mapped.paragraphIndex,
          targetId: target.id,
          sequence,
        });
        occupied.add(`${mapped.anchor?.partName ?? "word/document.xml"}:${mapped.paragraphIndex}`);
      });
    }
    return {
      targetId: target.id,
      kind: target.kind,
      status: generated ? "generated" as const : "omitted" as const,
      preserveEmptyAnchors: unresolvedTextOmission,
      controlTags,
      anchors: target.blockIds.map((blockId) => {
        const mapped = mappedBlocks.get(blockId);
        if (!mapped) throw new Error(`Template map is missing target block ${blockId}.`);
        return {
          blockId,
          partName: mapped.anchor?.partName ?? "word/document.xml",
          paragraphIndex: mapped.paragraphIndex,
          structuredGroup: mapped.structuredGroup,
          figure: mapped.figure,
        };
      }),
      ...(target.kind === "narrative" ? { paragraphs: targetBlocks.map((block) => block.text) } : {}),
      ...(target.kind === "structured" ? { rows: targetBlocks.map((block) => ({
        role: block.structuredRowRole ?? "body" as const,
        cells: block.structuredCells ?? [block.text],
      })) } : {}),
      ...(target.kind === "figure" ? {
        caption: targetBlocks[0]?.text ?? outcome.caption,
        sourcePath: outcome.sourceId ? sourcePathById.get(outcome.sourceId) ?? null : null,
      } : {}),
    };
  });

  const fieldBlockPatches: Array<{ partName: string; paragraphIndex: number; text: string }> = [];
  for (const region of templateMap.blocks) {
    const replaceFields = (region.inlineFields ?? []).filter((field) => field.role === "replace");
    if (!replaceFields.length) continue;
    const blockId = templateBlockId(region);
    const added = addControl({
      tag: tagFor("field-block", blockId),
      kind: "field-block",
      partName: region.anchor?.partName ?? "word/document.xml",
      paragraphIndex: region.paragraphIndex,
      blockId,
      fieldKeys: replaceFields.map((field) => field.key),
    });
    if (!added) continue;
    let cursor = 0;
    let text = "";
    for (const field of [...replaceFields].sort((left, right) => left.start - right.start)) {
      text += region.text.slice(cursor, field.start);
      text += content.fields[field.key]?.value ?? "";
      cursor = field.end;
    }
    text += region.text.slice(cursor);
    fieldBlockPatches.push({
      partName: region.anchor?.partName ?? "word/document.xml",
      paragraphIndex: region.paragraphIndex,
      text,
    });
  }

  const patches = [...fieldBlockPatches, ...content.sections.flatMap((section) => section.blocks).flatMap((block) => {
    if (block.targetId || !block.attorneyEdited || !block.templateBlockId) return [];
    const mapped = mappedBlocks.get(block.templateBlockId);
    if (!mapped) throw new Error(`Template map is missing edited block ${block.templateBlockId}.`);
    if (occupied.has(`${mapped.anchor?.partName ?? "word/document.xml"}:${mapped.paragraphIndex}`)) return [];
    return [{
      partName: mapped.anchor?.partName ?? "word/document.xml",
      paragraphIndex: mapped.paragraphIndex,
      text: block.text,
    }];
  })];
  const storageKey = `drafts/${draftId}/v${row.version}-${safeName(row.matter_name)}.docx`;
  const outputPath = pathForKey(storageKey);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const exported = await exportDocx({
    templatePath: pathForKey(row.storage_key),
    outputPath,
    patches,
    fieldReplacements: {},
    targetOperations,
    editableControls: controls.filter((control) => control.kind === "field-block")
      .map(({ tag, partName, paragraphIndex }) => ({ tag, partName, paragraphIndex })),
    formsProtection: controls.length > 0,
  });
  await pool.query(`
    UPDATE draft_versions
    SET document_storage_key = $3, document_sha256 = $4, document_size = $5, editor_controls = $6
    WHERE draft_id = $1 AND version = $2
  `, [draftId, row.version, storageKey, exported.sha256, exported.size, JSON.stringify(controls)]);
  return {
    path: outputPath,
    storageKey,
    sha256: exported.sha256,
    size: exported.size,
    version: row.version,
    current: row.current_version === row.version,
    matterName: row.matter_name,
    content,
    readiness,
    controls,
  };
}

function inlineValues(
  region: ReturnType<typeof TemplateMapSchema.parse>["blocks"][number],
  editedText: string,
): Map<string, string> {
  const fields = [...(region.inlineFields ?? [])].filter((field) => field.role === "replace").sort((left, right) => left.start - right.start);
  const result = new Map<string, string>();
  if (!fields.length) return result;
  const leading = region.text.slice(0, fields[0]!.start);
  if (!editedText.startsWith(leading)) throw new Error(`Edited field paragraph no longer matches template block ${templateBlockId(region)}.`);
  let cursor = leading.length;
  for (const [index, field] of fields.entries()) {
    const next = fields[index + 1];
    const separator = region.text.slice(field.end, next?.start ?? region.text.length);
    const end = separator ? editedText.indexOf(separator, cursor) : editedText.length;
    if (end < cursor) throw new Error(`Edited field ${field.key} no longer has its protected template boundary.`);
    const value = editedText.slice(cursor, end).trim();
    result.set(field.key, value);
    cursor = end + separator.length;
  }
  return result;
}

export async function ingestEditedDraftDocument(draftId: string, baseVersion: number, editedPath: string) {
  const row = await loadDocumentRow(draftId, baseVersion);
  if (!row) throw new Error("Draft document version was not found.");
  const controls = parsedControls(row.editor_controls);
  if (!controls.length) throw new Error("Draft document has no editable controls.");
  const extracted = await extractDocxControls(editedPath);
  const byTag = new Map<string, string>();
  for (const control of extracted.controls) {
    if (byTag.has(control.tag)) throw new Error(`Edited DOCX contains duplicate control ${control.tag}.`);
    byTag.set(control.tag, control.text);
  }
  for (const control of controls) {
    if (!byTag.has(control.tag)) throw new Error(`Edited DOCX removed required control ${control.tag}.`);
  }

  const templateMap = TemplateMapSchema.parse(row.template_map);
  const template = analysisWithConfirmedMap(TemplateAnalysisSchema.parse(row.template_analysis), templateMap);
  let updated = normalizeDraftContent(row.content);
  const targetControls = new Map<string, EditorControlMetadata[]>();
  for (const control of controls.filter((candidate) => candidate.kind === "target" && candidate.targetId)) {
    targetControls.set(control.targetId!, [...(targetControls.get(control.targetId!) ?? []), control]);
  }
  for (const [targetId, targetItems] of targetControls) {
    const values = targetItems
      .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0))
      .map((control) => byTag.get(control.tag)?.trim() ?? "");
    const outcome = updated.outcomes.find((candidate) => candidate.targetId === targetId);
    if (!outcome) throw new Error(`Edited DOCX references unknown target ${targetId}.`);
    if (outcome.status === "omitted") {
      if (values.some(Boolean)) updated = supplyOmission(updated, targetId, values, template);
      continue;
    }
    updated = {
      ...updated,
      sections: updated.sections.map((section) => ({
        ...section,
        blocks: section.blocks.map((block) => {
          if (block.targetId !== targetId) return block;
          const replacement = values[block.sequence ?? 0];
          return replacement === undefined || replacement === block.text ? block : { ...block, text: replacement, attorneyEdited: true };
        }),
      })),
    };
  }

  const regions = new Map(templateMap.blocks.map((region) => [templateBlockId(region), region]));
  for (const control of controls.filter((candidate) => candidate.kind === "field-block" && candidate.blockId)) {
    const editedText = byTag.get(control.tag) ?? "";
    const region = regions.get(control.blockId!);
    if (!region) throw new Error(`Edited DOCX references unknown field block ${control.blockId}.`);
    const values = inlineValues(region, editedText);
    updated = {
      ...updated,
      fields: Object.fromEntries(Object.entries(updated.fields).map(([key, field]) => {
        if (!values.has(key)) return [key, field];
        const value = values.get(key)?.trim() ?? "";
        return [key, value ? { ...field, value, note: null, attorneyEdited: true } : field];
      })),
      sections: updated.sections.map((section) => ({
        ...section,
        blocks: section.blocks.map((block) => block.templateBlockId === control.blockId && block.text !== editedText
          ? { ...block, text: editedText, attorneyEdited: true }
          : block),
      })),
    };
  }
  updated = ensureEditableCoverage(updated, template);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ current_version: number; matter_id: string }>(`
      SELECT current_version, matter_id FROM drafts WHERE id = $1 FOR UPDATE
    `, [draftId]);
    const current = locked.rows[0];
    if (!current) throw new Error("Draft was not found while saving the edited DOCX.");
    if (current.current_version !== baseVersion) {
      await client.query("ROLLBACK");
      return { saved: false, version: current.current_version };
    }
    const nextVersion = baseVersion + 1;
    const storageKey = `drafts/${draftId}/v${nextVersion}-${safeName(row.matter_name)}.docx`;
    const outputPath = pathForKey(storageKey);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.copyFile(editedPath, outputPath);
    await client.query(`
      INSERT INTO draft_versions (
        draft_id, version, content, document_storage_key, document_sha256, document_size,
        editor_controls, actor_id, source_fingerprint, template_map_version, change_summary
      )
      SELECT $1, $2, $3, $4, $5, $6, $7, $8, source_fingerprint, template_map_version, 'Edited mapped content in Word view'
      FROM draft_versions WHERE draft_id = $1 AND version = $9
    `, [draftId, nextVersion, JSON.stringify(updated), storageKey, extracted.sha256, extracted.size, JSON.stringify(controls), ACTOR_ID, baseVersion]);
    await persistCitations(client, draftId, nextVersion, updated);
    await client.query("UPDATE drafts SET current_version = $2, updated_at = now() WHERE id = $1", [draftId, nextVersion]);
    await client.query(`
      INSERT INTO activity_events (workspace_id, matter_id, actor_id, event_type, summary, metadata)
      VALUES ($1, $2, $3, 'draft.word-saved', 'Saved mapped edits from the Word view', $4)
    `, [WORKSPACE_ID, current.matter_id, ACTOR_ID, JSON.stringify({ draftId, version: nextVersion, baseVersion })]);
    await client.query("COMMIT");
    return { saved: true, version: nextVersion };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
