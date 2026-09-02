import { createHash } from "node:crypto";
import {
  GenerationTargetSchema,
  TemplateAnalysisSchema,
  TemplateMapSchema,
  TemplateRegionSchema,
  type GenerationTarget,
  type TemplateAnalysis,
  type TemplateMap,
  type TemplateRegion,
} from "@steno/contracts";

export function templateBlockId(block: TemplateRegion): string {
  return block.id ?? `${block.anchor?.partName ?? "word/document.xml"}:p:${block.paragraphIndex}`;
}

export function validateConfirmedBlocks(
  analysis: TemplateAnalysis,
  submitted: TemplateRegion[],
): TemplateRegion[] {
  const analyzed = analysis.blocks?.length ? analysis.blocks : analysis.regions;
  const analyzedById = new Map(analyzed.map((block) => [templateBlockId(block), block]));
  const seen = new Set<string>();
  const confirmed = submitted.map((candidate) => {
    const block = TemplateRegionSchema.parse(candidate);
    const id = templateBlockId(block);
    const original = analyzedById.get(id);
    if (!original) throw new Error(`Template map contains an unknown block: ${id}`);
    if (seen.has(id)) throw new Error(`Template map contains a duplicate block: ${id}`);
    seen.add(id);
    const immutableShape = (value: TemplateRegion) => ({
      text: value.text,
      anchor: value.anchor ?? null,
      semanticKind: value.semanticKind,
      formatting: value.formatting ?? null,
      structuredGroup: value.structuredGroup ?? null,
      figure: value.figure ?? null,
      section: value.section,
    });
    if (JSON.stringify(immutableShape(block)) !== JSON.stringify(immutableShape(original))) {
      throw new Error(`Template map changed immutable original content or its OOXML anchor: ${id}`);
    }
    for (const field of block.inlineFields ?? []) {
      if (block.text.slice(field.start, field.end) !== field.originalText) {
        throw new Error(`Inline field ${field.key} no longer matches exact original text.`);
      }
    }
    if (block.semanticKind === "heading" && block.role !== "heading") {
      throw new Error(`Template heading structure cannot be changed: ${id}`);
    }
    return TemplateRegionSchema.parse({ ...block, id, needsAttention: false });
  });
  if (seen.size !== analyzedById.size) {
    throw new Error(`Template map omitted ${analyzedById.size - seen.size} original block(s).`);
  }
  const fieldKeys = new Set<string>();
  for (const field of confirmed.flatMap((block) => block.inlineFields ?? [])) {
    if (fieldKeys.has(field.key)) throw new Error(`Inline field keys must be unique: ${field.key}`);
    fieldKeys.add(field.key);
  }
  const structuredRoles = new Map<string, TemplateRegion["role"]>();
  for (const block of confirmed.filter((candidate) => candidate.structuredGroup)) {
    const groupId = block.structuredGroup!.id;
    const normalizedRole = block.role === "heading" ? "preserve" : block.role;
    const prior = structuredRoles.get(groupId);
    if (prior && prior !== normalizedRole) {
      throw new Error(`Structured group decisions must apply to the complete group: ${groupId}`);
    }
    structuredRoles.set(groupId, normalizedRole);
  }
  return confirmed;
}

function stableTargetId(kind: GenerationTarget["kind"], blockIds: string[]): string {
  const digest = createHash("sha256").update(JSON.stringify([kind, blockIds])).digest("hex").slice(0, 20);
  return `${kind}-${digest}`;
}

function narrativeCompatibilityKey(block: TemplateRegion): string {
  const formatting = block.formatting;
  return JSON.stringify([
    block.anchor?.partName ?? "word/document.xml",
    block.section,
    formatting?.styleFamily ?? formatting?.styleId ?? block.style,
    formatting?.numberingId,
    formatting?.numberingLevel,
  ]);
}

/** Derive stable generation holes from the confirmed map. Runs are never persisted. */
export function deriveGenerationTargets(input: TemplateAnalysis | TemplateRegion[]): GenerationTarget[] {
  const blocks = Array.isArray(input)
    ? input
    : (input.blocks?.length ? input.blocks : input.regions);
  const figureCaptionIds = new Set(blocks.flatMap((block) => block.figure?.captionBlockId ? [block.figure.captionBlockId] : []));
  const targets: GenerationTarget[] = [];
  const handledGroups = new Set<string>();
  let index = 0;
  while (index < blocks.length) {
    const block = blocks[index]!;
    const blockId = templateBlockId(block);
    if (figureCaptionIds.has(blockId)) {
      index += 1;
      continue;
    }
    if (block.role !== "editable" || block.semanticKind === "heading") {
      index += 1;
      continue;
    }
    if (block.semanticKind === "figure") {
      targets.push(GenerationTargetSchema.parse({
        id: stableTargetId("figure", [blockId]),
        kind: "figure",
        section: block.section,
        blockIds: [blockId],
        partName: block.anchor?.partName ?? "word/document.xml",
        exemplarCount: 1,
        minItems: 1,
        maxItems: 1,
        figure: block.figure,
      }));
      index += 1;
      continue;
    }
    if (block.structuredGroup) {
      const groupId = block.structuredGroup.id;
      if (!handledGroups.has(groupId)) {
        handledGroups.add(groupId);
        const members = blocks.filter((candidate) => candidate.structuredGroup?.id === groupId && candidate.role === "editable");
        const ids = members.map(templateBlockId);
        const rowKeys = new Set(members.map((candidate) => candidate.structuredGroup?.rowIndex ?? candidate.paragraphIndex));
        targets.push(GenerationTargetSchema.parse({
          id: stableTargetId("structured", ids),
          kind: "structured",
          section: block.section,
          blockIds: ids,
          partName: block.anchor?.partName ?? "word/document.xml",
          exemplarCount: Math.max(1, rowKeys.size),
          minItems: 1,
          maxItems: 50,
          structuredGroupId: groupId,
        }));
      }
      index += 1;
      continue;
    }
    const key = narrativeCompatibilityKey(block);
    const run: TemplateRegion[] = [block];
    let cursor = index + 1;
    while (cursor < blocks.length) {
      const candidate = blocks[cursor]!;
      if (
        candidate.role !== "editable"
        || candidate.semanticKind !== "prose"
        || candidate.structuredGroup
        || narrativeCompatibilityKey(candidate) !== key
      ) break;
      run.push(candidate);
      cursor += 1;
    }
    const ids = run.map(templateBlockId);
    const elastic = (block.anchor?.partName ?? "word/document.xml") === "word/document.xml";
    targets.push(GenerationTargetSchema.parse({
      id: stableTargetId("narrative", ids),
      kind: "narrative",
      section: block.section,
      blockIds: ids,
      partName: block.anchor?.partName ?? "word/document.xml",
      exemplarCount: ids.length,
      minItems: 1,
      maxItems: elastic ? 12 : ids.length,
    }));
    index = cursor;
  }
  return targets;
}

export function analysisWithConfirmedMap(analysis: TemplateAnalysis, map: TemplateMap): TemplateAnalysis {
  const parsedMap = TemplateMapSchema.parse(map);
  const bodyBlocks = parsedMap.blocks.filter((block) => (block.anchor?.partName ?? "word/document.xml") === "word/document.xml");
  const replacementCandidates = parsedMap.blocks.flatMap((block) => block.role === "editable" ? [] : (block.inlineFields ?? []).filter((field) => field.role === "replace").map((field) => ({
    value: field.originalText,
    location: block.anchor?.partName ?? "word/document.xml",
    kind: field.kind,
    fieldKey: field.key,
    label: field.label,
    blockId: templateBlockId(block),
    start: field.start,
    end: field.end,
  })));
  return TemplateAnalysisSchema.parse({
    ...analysis,
    blocks: parsedMap.blocks,
    regions: bodyBlocks,
    replacementCandidates,
    knownCaseSpecificValues: [...new Set([
      ...(analysis.knownCaseSpecificValues ?? []),
      ...replacementCandidates.map((candidate) => candidate.value),
    ])],
  });
}
