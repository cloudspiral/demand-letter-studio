import { createHash } from "node:crypto";
import * as Y from "yjs";
import { CitationSchema, GeneratedDraftSchema, type Citation, type DraftBlock, type DraftSection, type GeneratedDraft } from "@steno/contracts";
import { pool, WORKSPACE_ID } from "./db";

export interface CollaborationValidationIssue {
  blockId: string | null;
  severity: "warning" | "error";
  code: "unsupported" | "edited-citation" | "broken-citation" | "unsupported-value" | "unmapped-block" | "duplicate-template-mapping" | "empty-document";
  message: string;
}

export interface CollaborationValidationReport {
  status: "ready" | "needs-review" | "blocked";
  checkedAt: string;
  snapshotHash: string;
  errors: number;
  warnings: number;
  issues: CollaborationValidationIssue[];
}

export interface CollaborationEvidencePage {
  sourceId: string;
  sourceName: string;
  page: number;
  text: string;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function xmlText(node: Y.XmlText | Y.XmlElement | Y.XmlFragment): string {
  if (node instanceof Y.XmlText) return node.toString();
  if (node instanceof Y.XmlElement || node instanceof Y.XmlFragment) {
    return node.toArray().map((child) => xmlText(child as Y.XmlText | Y.XmlElement)).join("");
  }
  return "";
}

function nullableIndex(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

function booleanAttr(value: unknown): boolean {
  return value === true || value === "true";
}

function citationsFrom(value: unknown, fallback: Citation[]): Citation[] {
  const parsed = CitationSchema.array().safeParse(parseJson(value, fallback));
  return parsed.success ? parsed.data : fallback;
}

function blockKind(value: unknown, nodeName: string, fallback?: DraftBlock["kind"]): DraftBlock["kind"] {
  const allowed: DraftBlock["kind"][] = ["heading", "paragraph", "list-item", "table-row", "warning"];
  if (allowed.includes(value as DraftBlock["kind"])) return value as DraftBlock["kind"];
  return fallback ?? (nodeName === "heading" ? "heading" : "paragraph");
}

export function documentFromBase64Update(update: string): Y.Doc {
  const bytes = Buffer.from(update, "base64");
  if (!bytes.length || bytes.length > 15 * 1024 * 1024) throw Object.assign(new Error("Invalid collaboration snapshot."), { statusCode: 400 });
  const document = new Y.Doc();
  try { Y.applyUpdate(document, new Uint8Array(bytes)); } catch {
    document.destroy();
    throw Object.assign(new Error("Invalid collaboration snapshot."), { statusCode: 400 });
  }
  return document;
}

export function draftFromCollaborationDocument(document: Y.Doc, base: GeneratedDraft): GeneratedDraft {
  const fragment = document.getXmlFragment("default");
  const baseSections = new Map(base.sections.map((section) => [section.id, section]));
  const baseBlocks = new Map(base.sections.flatMap((section) => section.blocks).map((block) => [block.id, block]));
  const sections: DraftSection[] = [];
  const sectionById = new Map<string, DraftSection>();
  const usedBlockIds = new Set<string>();
  let currentSectionId = base.sections[0]?.id ?? "collaboration-section";

  const ensureSection = (id: string): DraftSection => {
    const existing = sectionById.get(id);
    if (existing) return existing;
    const baseSection = baseSections.get(id);
    const section: DraftSection = { id, heading: baseSection?.heading ?? null, blocks: [] };
    sections.push(section); sectionById.set(id, section);
    return section;
  };

  for (const [nodeIndex, item] of fragment.toArray().entries()) {
    if (!(item instanceof Y.XmlElement)) continue;
    const attrs = item.getAttributes() as Record<string, unknown>;
    const text = xmlText(item).trim();
    const role = typeof attrs.stenoRole === "string" ? attrs.stenoRole : "draft-block";
    const requestedSectionId = typeof attrs.sectionId === "string" && attrs.sectionId ? attrs.sectionId : currentSectionId;
    if (role === "section-heading") {
      currentSectionId = requestedSectionId;
      ensureSection(currentSectionId).heading = text || null;
      continue;
    }
    if (role === "document-title") continue;
    currentSectionId = requestedSectionId;
    const section = ensureSection(currentSectionId);
    const requestedBlockId = typeof attrs.blockId === "string" && attrs.blockId ? attrs.blockId : `collaboration-${nodeIndex}`;
    const blockId = usedBlockIds.has(requestedBlockId) ? `${requestedBlockId}-${nodeIndex}` : requestedBlockId;
    usedBlockIds.add(blockId);
    const baseBlock = baseBlocks.get(requestedBlockId);
    const originalText = baseBlock?.text ?? (typeof attrs.originalText === "string" ? attrs.originalText : "");
    const citations = baseBlock?.citations ?? citationsFrom(attrs.citations, []);
    section.blocks.push({
      id: blockId,
      kind: baseBlock?.kind ?? blockKind(attrs.blockKind, item.nodeName),
      text,
      templateParagraphIndex: baseBlock?.templateParagraphIndex ?? nullableIndex(attrs.templateParagraphIndex),
      citations,
      verified: booleanAttr(baseBlock?.verified ?? attrs.verified) && text === originalText,
    });
  }

  const content = {
    title: base.title,
    matterName: base.matterName,
    fields: base.fields,
    sections: sections.length ? sections : base.sections.map((section) => ({ ...section, blocks: [] })),
    warnings: base.warnings,
  };
  return GeneratedDraftSchema.parse(content);
}

const factualValues = (text: string): string[] => {
  const values = [
    ...text.matchAll(/\$\s?\d[\d,]*(?:\.\d{2})?/g),
    ...text.matchAll(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g),
    ...text.matchAll(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/gi),
  ];
  return [...new Set(values.map((match) => match[0]))];
};

const normalized = (value: string): string => value.toLowerCase().replace(/[$,\s]/g, "");

function snapshotHash(document: Y.Doc): string {
  return createHash("sha256").update(Y.encodeStateAsUpdate(document)).digest("hex");
}

export function validateCollaborativeDraft(
  document: Y.Doc,
  content: GeneratedDraft,
  evidence: CollaborationEvidencePage[],
): { content: GeneratedDraft; report: CollaborationValidationReport } {
  const issues: CollaborationValidationIssue[] = [];
  const evidenceByPage = new Map(evidence.map((page) => [`${page.sourceId}:${page.page}`, page]));
  const templateParagraphCounts = new Map<number, number>();
  for (const block of content.sections.flatMap((section) => section.blocks)) {
    if (block.templateParagraphIndex !== null) {
      templateParagraphCounts.set(block.templateParagraphIndex, (templateParagraphCounts.get(block.templateParagraphIndex) ?? 0) + 1);
    }
  }
  const originalById = new Map<string, string>();
  for (const item of document.getXmlFragment("default").toArray()) {
    if (item instanceof Y.XmlElement) {
      const attrs = item.getAttributes() as Record<string, unknown>;
      if (typeof attrs.blockId === "string" && typeof attrs.originalText === "string") originalById.set(attrs.blockId, attrs.originalText);
    }
  }

  if (!content.sections.some((section) => section.blocks.some((block) => block.text.trim()))) {
    issues.push({ blockId: null, severity: "error", code: "empty-document", message: "The collaborative document is empty." });
  }

  const validated: GeneratedDraft = {
    ...content,
    sections: content.sections.map((section) => ({
      ...section,
      blocks: section.blocks.map((block) => {
        const blockIssues: CollaborationValidationIssue[] = [];
        const citedPages: CollaborationEvidencePage[] = [];
        for (const citation of block.citations) {
          const page = citation.page === null ? undefined : evidenceByPage.get(`${citation.sourceId}:${citation.page}`);
          if (!page) blockIssues.push({ blockId: block.id, severity: "error", code: "broken-citation", message: "A citation no longer resolves to an uploaded source page." });
          else citedPages.push(page);
        }
        if (!block.citations.length && block.text.trim()) {
          blockIssues.push({ blockId: block.id, severity: "warning", code: "unsupported", message: "This paragraph has no source citation and requires attorney review." });
        }
        const originalText = originalById.get(block.id);
        if (originalText !== undefined && originalText !== block.text && block.citations.length) {
          blockIssues.push({ blockId: block.id, severity: "warning", code: "edited-citation", message: "Cited language changed and should be re-checked against its source." });
        }
        if (block.templateParagraphIndex === null && block.text.trim() && block.kind !== "warning") {
          blockIssues.push({ blockId: block.id, severity: "error", code: "unmapped-block", message: "This new paragraph is not mapped to an editable Word-template region." });
        }
        if (block.templateParagraphIndex !== null && (templateParagraphCounts.get(block.templateParagraphIndex) ?? 0) > 1) {
          blockIssues.push({ blockId: block.id, severity: "error", code: "duplicate-template-mapping", message: "Multiple collaborative paragraphs map to the same Word-template region." });
        }
        const citedText = normalized(citedPages.map((page) => page.text).join(" "));
        for (const value of factualValues(block.text)) {
          if (citedPages.length && !citedText.includes(normalized(value))) {
            blockIssues.push({ blockId: block.id, severity: "error", code: "unsupported-value", message: `${value} does not appear on the cited source page.` });
          }
        }
        issues.push(...blockIssues);
        return { ...block, verified: block.citations.length > 0 && !blockIssues.length };
      }),
    })),
  };
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.length - errors;
  return {
    content: validated,
    report: {
      status: errors ? "blocked" : warnings ? "needs-review" : "ready",
      checkedAt: new Date().toISOString(),
      snapshotHash: snapshotHash(document),
      errors,
      warnings,
      issues,
    },
  };
}

export async function persistCollaborationDocument(draftId: string, document: Y.Doc): Promise<number> {
  const snapshot = Buffer.from(Y.encodeStateAsUpdate(document));
  const result = await pool.query<{ version: string | number }>(`
    INSERT INTO collaboration_documents (document_name, workspace_id, draft_id, snapshot, version)
    VALUES ($1, $2, $3, $4, 1)
    ON CONFLICT (document_name) DO UPDATE
      SET snapshot = EXCLUDED.snapshot, version = collaboration_documents.version + 1, updated_at = now()
    RETURNING version
  `, [`draft:${draftId}`, WORKSPACE_ID, draftId, snapshot]);
  return Number(result.rows[0]?.version ?? 1);
}

export async function storedCollaborationDocument(draftId: string): Promise<Y.Doc | null> {
  const result = await pool.query<{ snapshot: Buffer }>("SELECT snapshot FROM collaboration_documents WHERE draft_id = $1", [draftId]);
  const snapshot = result.rows[0]?.snapshot;
  if (!snapshot?.length) return null;
  const document = new Y.Doc();
  Y.applyUpdate(document, new Uint8Array(snapshot));
  return document;
}
