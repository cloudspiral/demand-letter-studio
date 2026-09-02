import Anthropic from "@anthropic-ai/sdk";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import OpenAI from "openai";
import { z } from "zod";
import {
  CitationSchema,
  GenerationOutcomeSchema,
  GeneratedDraftSchema,
  RefinementProposalSchema,
  TemplateAnalysisSchema,
  TemplateRegionSchema,
  type Citation,
  type GeneratedDraft,
  type GenerationOutcome,
  type RefinementAnnotation,
  type RefinementProposal,
  type TemplateAnalysis,
} from "@steno/contracts";
import { config } from "./config";
import { deriveGenerationTargets, templateBlockId } from "./template-map";

export interface EvidencePage {
  sourceId: string;
  sourceName: string;
  mimeType?: string;
  page: number;
  text: string;
  extractionMethod?: "native" | "ocr" | "visual" | "none";
  extractionStatus?: "ready" | "ocr-required" | "ocr-failed" | "visual-only";
  confidence?: number | null;
  geometry?: unknown[];
  structuredData?: unknown;
  visualInput?: boolean;
  imageData?: {
    mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
    base64: string;
  };
}

export interface GenerateInput {
  matterName: string;
  template: TemplateAnalysis;
  evidence: EvidencePage[];
}

export interface AnalyzeTemplateInput {
  filename: string;
  templateHash: string;
  structuralAnalysis: TemplateAnalysis;
}

export interface RefineInput {
  instruction: string;
  annotations: RefinementAnnotation[];
  evidence: EvidencePage[];
  currentDraftVersion?: number;
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  analyzeTemplate(input: AnalyzeTemplateInput): Promise<TemplateAnalysis>;
  generate(input: GenerateInput): Promise<GeneratedDraft>;
  refine(input: RefineInput): Promise<RefinementProposal>;
}

export function safeAiDiagnostic(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.slice(0, 12).map((issue) => `${issue.path.join(".") || "root"}:${issue.code}`).join(", ");
  }
  if (error instanceof SyntaxError) return `JSON parse failed: ${error.message.slice(0, 160)}`;
  return error instanceof Error ? error.message.slice(0, 300) : "Unknown provider error";
}

function strictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _metaSchema, ...jsonSchema } = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  return jsonSchema;
}

const TemplateDecisionOutputSchema = z.object({
  decisions: z.array(z.object({
    blockId: z.string().min(1),
    role: z.enum(["keep", "replace", "heading"]),
    confidence: z.number().min(0).max(1),
    explanation: z.string().min(1).max(1_000),
    inlineFields: z.array(z.object({
      key: z.string().min(1).max(500),
      label: z.string().min(1).max(240),
      start: z.number().int().nonnegative(),
      end: z.number().int().positive(),
      originalText: z.string().min(1),
      kind: z.enum(["claim-number", "person", "date", "amount", "other"]),
      confidence: z.number().min(0).max(1),
      explanation: z.string().min(1).max(1_000),
      role: z.enum(["keep", "replace"]),
    })).max(100),
  })).min(1),
  knownCaseSpecificValues: z.array(z.string().min(1).max(500)).max(500),
});

const templateAnalysisJsonSchema = strictJsonSchema(TemplateDecisionOutputSchema);

function promptForTemplateAnalysis(input: AnalyzeTemplateInput): string {
  const blocks = (input.structuralAnalysis.blocks?.length
    ? input.structuralAnalysis.blocks
    : input.structuralAnalysis.regions).map((block) => ({
      blockId: block.id ?? `word/document.xml:p:${block.paragraphIndex}`,
      text: block.text,
      anchor: block.anchor ?? {
        partName: "word/document.xml",
        kind: "paragraph",
        paragraphIndex: block.paragraphIndex,
      },
      formatting: block.formatting ?? { styleId: block.style },
      semanticKind: block.semanticKind,
      structuredGroup: block.structuredGroup,
      figure: block.figure,
    }));
  return `Analyze this complete parsed Word demand letter as a completed letter from a previous case.
Return exactly one decision for every supplied blockId and no other blockIds.
- Recommend keep for reusable language, replace for an entire case-specific block, or heading for a heading whose structure and formatting must remain unchanged.
- A heading may still contain exact inline fields such as a client name, date, claim number, or deadline. Mark those fields replace while leaving the heading decision as heading.
- Figure blocks are fixed 1:1 evidence slots. Choose keep for firm branding or replace for a case-specific evidentiary image; never classify a figure as a heading.
- Every member of one structuredGroup must receive the same keep or replace recommendation.
- When only a span inside an otherwise-kept block is case-specific, choose keep and identify every exact inline field span.
- start and end are zero-based JavaScript string offsets into the exact block text. originalText must equal text.slice(start, end).
- Every inline field needs role keep or replace; default genuine case values to replace and false positives such as a statute number to keep.
- Every inline field key must be unique across the complete document. When the same logical value appears more than once, qualify the keys by location, for example header_claim_number and body_claim_number.
- Give a short explanation and confidence for every decision and inline field. Confidence below 0.80 will require user attention.
- List concrete previous-case values that must not be copied into a new draft. Do not infer replacements and do not make legal-validity judgments.
- Make every recommendation independently of any new case. No case files are included.
- Return strict JSON only.

TEMPLATE HASH: ${input.templateHash}
TEMPLATE FILENAME: ${input.filename}
COMPLETE PARSED TEMPLATE:
${JSON.stringify(blocks)}

FIGURE LOCATIONS AND IMMUTABLE OOXML PARTS:
${JSON.stringify(input.structuralAnalysis.imageCandidates)}`;
}

function uniqueInlineFieldKey(requestedKey: string, usedKeys: Set<string>): string {
  if (!usedKeys.has(requestedKey)) {
    usedKeys.add(requestedKey);
    return requestedKey;
  }
  for (let occurrence = 2; ; occurrence += 1) {
    const suffix = `_${occurrence}`;
    const candidate = `${requestedKey.slice(0, 500 - suffix.length)}${suffix}`;
    if (!usedKeys.has(candidate)) {
      usedKeys.add(candidate);
      return candidate;
    }
  }
}

export function parseTemplateAnalysis(raw: unknown, input: AnalyzeTemplateInput): TemplateAnalysis {
  const output = TemplateDecisionOutputSchema.parse(raw);
  const structuralBlocks = input.structuralAnalysis.blocks?.length
    ? input.structuralAnalysis.blocks
    : input.structuralAnalysis.regions;
  const byId = new Map(structuralBlocks.map((block) => [block.id ?? `word/document.xml:p:${block.paragraphIndex}`, block]));
  const decisions = new Map<string, z.infer<typeof TemplateDecisionOutputSchema>["decisions"][number]>();
  for (const decision of output.decisions) {
    if (!byId.has(decision.blockId)) throw new Error(`Template analysis returned an unknown block: ${decision.blockId}`);
    if (decisions.has(decision.blockId)) throw new Error(`Template analysis returned a duplicate block: ${decision.blockId}`);
    decisions.set(decision.blockId, decision);
  }
  if (decisions.size !== byId.size) {
    const missing = [...byId.keys()].filter((id) => !decisions.has(id));
    throw new Error(`Template analysis omitted ${missing.length} block(s): ${missing.slice(0, 5).join(", ")}`);
  }

  const usedInlineFieldKeys = new Set<string>();
  const blocks = structuralBlocks.map((block) => {
    const id = block.id ?? `word/document.xml:p:${block.paragraphIndex}`;
    const decision = decisions.get(id)!;
    const inlineFields = decision.inlineFields.map((field) => {
      if (field.end <= field.start || block.text.slice(field.start, field.end) !== field.originalText) {
        throw new Error(`Template analysis returned an invalid exact span for ${id}:${field.key}`);
      }
      return {
        ...field,
        key: uniqueInlineFieldKey(field.key, usedInlineFieldKeys),
        source: "model" as const,
      };
    });
    const role = block.semanticKind === "figure"
      ? (decision.role === "replace" ? "editable" : "preserve")
      : decision.role === "keep" ? "preserve" : decision.role === "replace" ? "editable" : "heading";
    return TemplateRegionSchema.parse({
      ...block,
      id,
      role,
      semanticKind: role === "heading" ? "heading" : block.semanticKind,
      aiRecommendation: role === "editable" ? "replace" : "keep",
      confidence: decision.confidence,
      explanation: decision.explanation,
      needsAttention: decision.confidence < 0.8 || inlineFields.some((field) => field.confidence < 0.8),
      inlineFields,
    });
  });
  const groupedRecommendations = new Map<string, { role: "preserve" | "editable"; attention: boolean; confidence: number }>();
  for (const block of blocks.filter((candidate) => candidate.structuredGroup)) {
    const groupId = block.structuredGroup!.id;
    const current = groupedRecommendations.get(groupId);
    groupedRecommendations.set(groupId, {
      role: current?.role === "editable" || block.role === "editable" ? "editable" : "preserve",
      attention: Boolean(current?.attention || block.needsAttention),
      confidence: Math.min(current?.confidence ?? 1, block.confidence),
    });
  }
  let currentSection: string | null = null;
  const figureCaptionIds = new Set(blocks.flatMap((block) => block.figure?.captionBlockId ? [block.figure.captionBlockId] : []));
  const normalizedBlocks = blocks.map((block) => {
    const grouped = block.structuredGroup ? groupedRecommendations.get(block.structuredGroup.id) : null;
    let normalized = TemplateRegionSchema.parse(grouped ? {
      ...block,
      role: grouped.role,
      aiRecommendation: grouped.role === "editable" ? "replace" : "keep",
      confidence: grouped.confidence,
      needsAttention: grouped.attention,
    } : block);
    if (figureCaptionIds.has(templateBlockId(normalized))) {
      normalized = TemplateRegionSchema.parse({
        ...normalized,
        role: "preserve",
        aiRecommendation: "keep",
        confidence: 1,
        needsAttention: false,
        inlineFields: [],
      });
    }
    if (normalized.semanticKind === "heading") currentSection = normalized.text;
    return TemplateRegionSchema.parse({ ...normalized, section: currentSection });
  });
  const bodyBlocks = normalizedBlocks.filter((block) => (block.anchor?.partName ?? "word/document.xml") === "word/document.xml");
  const replacementCandidates = normalizedBlocks.flatMap((block) => (block.inlineFields ?? []).filter((field) => field.role === "replace").map((field) => ({
    value: field.originalText,
    location: block.anchor?.partName ?? "word/document.xml",
    kind: field.kind,
    fieldKey: field.key,
    label: field.label,
    blockId: block.id,
    start: field.start,
    end: field.end,
  })));
  return TemplateAnalysisSchema.parse({
    ...input.structuralAnalysis,
    analysisVersion: Math.max(5, input.structuralAnalysis.analysisVersion),
    blocks: normalizedBlocks,
    regions: bodyBlocks,
    replacementCandidates,
    knownCaseSpecificValues: [...new Set([
      ...output.knownCaseSpecificValues,
      ...replacementCandidates.map((candidate) => candidate.value),
    ])],
  });
}

const ModelCitationSchema = z.object({
  sourceId: z.string().uuid(),
  sourceName: z.string(),
  page: z.number().int().positive(),
  quote: z.string().max(500),
  evidenceType: z.enum(["text", "visual"]),
  visualDescription: z.string().max(1_000).nullable(),
});

const ModelGenerationOutputSchema = z.object({
  outcomes: z.array(z.object({
    targetId: z.string().min(1).max(500),
    status: z.enum(["generated", "omitted"]),
    paragraphs: z.array(z.object({
      text: z.string().min(1).max(20_000),
      citations: z.array(ModelCitationSchema).min(1).max(50),
    })).max(12),
    rows: z.array(z.object({
      role: z.enum(["body", "total"]),
      cells: z.array(z.string().max(20_000)).min(1).max(50),
      citations: z.array(ModelCitationSchema).min(1).max(50),
    })).max(50),
    caption: z.string().max(2_000).nullable(),
    sourceId: z.string().uuid().nullable(),
    page: z.number().int().positive().nullable(),
    mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]).nullable(),
    citations: z.array(ModelCitationSchema).max(100),
    note: z.string().max(2_000).nullable(),
  })).max(500),
  replacements: z.array(z.object({
    fieldKey: z.string().min(1).max(500),
    oldValue: z.string().min(1),
    value: z.string().min(1).nullable(),
    citations: z.array(ModelCitationSchema).max(50),
    note: z.string().max(2_000).nullable(),
  })).max(500),
});

export const generatedDraftJsonSchema = strictJsonSchema(ModelGenerationOutputSchema);

const refinementJsonSchema = {
  type: "object", additionalProperties: false,
  required: ["edits", "summary", "citedSourceIds"],
  properties: {
    edits: {
      type: "array", minItems: 1, maxItems: 5,
      items: {
        type: "object", additionalProperties: false,
        required: ["blockId", "targetText", "replacementText", "start", "end"],
        properties: {
          blockId: { type: "string" }, targetText: { type: "string" }, replacementText: { type: "string" },
          start: { type: "integer", minimum: 0 }, end: { type: "integer", minimum: 1 },
        },
      },
    },
    summary: { type: "string" },
    citedSourceIds: { type: "array", items: { type: "string" } },
  },
} as const;

function promptForGeneration(input: GenerateInput): string {
  const blocks = input.template.blocks?.length ? input.template.blocks : input.template.regions;
  const targets = deriveGenerationTargets(input.template).map((target) => ({
    ...target,
    exemplars: target.blockIds.map((id) => {
      const block = blocks.find((candidate) => templateBlockId(candidate) === id)!;
      return { blockId: id, text: block.text, style: block.formatting, structuredGroup: block.structuredGroup, figure: block.figure };
    }),
  }));
  const keptContext = blocks.filter((block) => block.role !== "editable").map((block) => ({
    blockId: templateBlockId(block),
    kind: block.semanticKind,
    section: block.section,
    text: block.text,
    inlineFields: block.inlineFields,
  }));
  const evidenceText = normalizeEvidenceText(input.evidence.map((page) => page.text).join("\n"));
  const forbiddenPreviousCaseValues = (input.template.knownCaseSpecificValues ?? [])
    .filter((value) => value.trim() && !evidenceText.includes(normalizeEvidenceText(value)));
  return `Create an attorney-review draft demand letter for ${input.matterName}.
Accuracy rules:
- The complete mapped template is a previous-case exemplar, never evidence.
- Use only facts explicitly present in the complete new-case EVIDENCE packet.
- Return exactly one outcome for every supplied generation targetId and no other targetIds. Never return Keep or heading text.
- Every factual sentence or claim must cite a sourceId, page, and short exact contiguous quote. Visual support must use evidenceType=visual and an explicit visualDescription; it cannot masquerade as a text quote.
- Citation quotes must be short, exact, contiguous excerpts copied verbatim from the cited page.
- For a narrative target, status generated requires 1-${12} paragraphs, each with citations. The number of paragraphs may differ from the exemplars when the evidence warrants it.
- For a structured target, status generated requires 1-50 rows with role body or total. Preserve the exemplar's column count and total-row semantics; each row requires citations. Use at most one total row and put it last.
- For a figure target, status generated requires an existing standalone uploaded image sourceId/page, its exact image mediaType, a grounded caption, and visual citations. A rendered PDF page is review context, not a replacement image. Never synthesize or invent an image.
- If evidence is missing, ambiguous, or conflicting, return omitted with no generated paragraphs, rows, or figure and a concise user-facing note. Include citations to every conflicting source when a conflict exists.
- If evidence affirmatively establishes a negative fact, generate useful cited language such as "No future medical care is currently recommended." Do not omit a target merely because the supported fact is negative.
- Preserve document order, defined terms, pronouns, chronology, surrounding flow, rhetorical purpose, and approximate layout. Code reuses keep language exactly; do not return it.
- Never repeat a value from FORBIDDEN PREVIOUS-CASE VALUES in any generated text or field value. Omit the affected target or return a null field instead of copying an exemplar value.
- Do not return a document title. Application code supplies the neutral attorney-review title.
- Return concise structured JSON, never HTML, Markdown, code, or OOXML.
- Return exactly one replacement outcome for every INLINE FIELD DECISION and no others. Copy fieldKey and oldValue exactly. A non-null value requires at least one exact grounding citation. A null value requires a concise user-facing note and may include source citations for ambiguity or conflict. A heading value may reformat a cited date, name, reference, or amount to fit the surrounding template. Silent field omission is invalid.
- For every generated target set note to null. For every omitted target provide a non-empty note.

KEEP/HEADING CONTEXT IN DOCUMENT ORDER:
${JSON.stringify(keptContext)}

GENERATION TARGETS AND PREVIOUS-CASE EXEMPLARS:
${JSON.stringify(targets)}

INLINE FIELD DECISIONS:
${JSON.stringify(input.template.replacementCandidates)}

FORBIDDEN PREVIOUS-CASE VALUES:
${JSON.stringify(forbiddenPreviousCaseValues)}

EVIDENCE:
${JSON.stringify(input.evidence.map(({ imageData: _imageData, ...page }) => page))}`;
}

const normalizeEvidenceText = (value: string): string => value
  .normalize("NFKC")
  .replace(/\s+/g, " ")
  .trim()
  .toLocaleLowerCase();


function groundedCitations(citations: z.infer<typeof ModelCitationSchema>[], evidence: EvidencePage[]): Citation[] {
  const pages = new Map(evidence.map((page) => [`${page.sourceId}:${page.page}`, page]));
  return citations.map((citation) => {
    const page = pages.get(`${citation.sourceId}:${citation.page}`);
    if (!page) throw new Error(`Generation cited an unknown source page: ${citation.sourceId}:${citation.page}`);
    if (citation.evidenceType === "visual") {
      if (!page.visualInput || !citation.visualDescription?.trim()) throw new Error("Generation returned an invalid visual citation.");
    } else if (!citation.quote.trim() || !normalizeEvidenceText(page.text).includes(normalizeEvidenceText(citation.quote))) {
      throw new Error("Generation returned a text citation that is not an exact source-page excerpt.");
    }
    return CitationSchema.parse({ ...citation, sourceName: page.sourceName });
  });
}

export function parseModelDraft(
  raw: unknown,
  evidence: EvidencePage[],
  template: TemplateAnalysis,
): GeneratedDraft {
  const parsed = ModelGenerationOutputSchema.parse(raw);
  const targets = deriveGenerationTargets(template);
  const targetById = new Map(targets.map((target) => [target.id, target]));
  const outputByTarget = new Map<string, (typeof parsed.outcomes)[number]>();
  for (const output of parsed.outcomes) {
    if (!targetById.has(output.targetId)) throw new Error(`Generation returned an unknown target: ${output.targetId}`);
    if (outputByTarget.has(output.targetId)) throw new Error(`Generation returned duplicate output for target ${output.targetId}.`);
    outputByTarget.set(output.targetId, output);
  }
  const missing = targets.filter((target) => !outputByTarget.has(target.id));
  if (missing.length) throw new Error(`Generation omitted ${missing.length} required target outcome(s).`);

  const generatedBlocks: GeneratedDraft["sections"][number]["blocks"] = [];
  const outcomes: GenerationOutcome[] = [];
  for (const target of targets) {
    const output = outputByTarget.get(target.id)!;
    const status = output.status;
    let citations = groundedCitations(output.citations, evidence);

    if (status === "generated") {
      if (target.kind === "narrative") {
        if (output.paragraphs.length < target.minItems || output.paragraphs.length > target.maxItems || output.rows.length || output.sourceId || output.caption) {
          throw new Error(`Narrative target ${target.id} returned an invalid generated shape.`);
        }
        output.paragraphs.forEach((paragraph, sequence) => {
          const paragraphCitations = groundedCitations(paragraph.citations, evidence);
          generatedBlocks.push({
            id: `${target.id}:paragraph:${sequence}`,
            kind: "paragraph",
            text: paragraph.text,
            templateParagraphIndex: null,
            templateBlockId: target.blockIds[Math.min(sequence, target.blockIds.length - 1)]!,
            citations: paragraphCitations,
            attorneyEdited: false,
            targetId: target.id,
            outcomeId: `outcome:${target.id}`,
            sequence,
          });
        });
      } else if (target.kind === "structured") {
        if (output.rows.length < target.minItems || output.rows.length > target.maxItems || output.paragraphs.length || output.sourceId || output.caption) {
          throw new Error(`Structured target ${target.id} returned an invalid generated shape.`);
        }
        const templateBlocks = template.blocks?.length ? template.blocks : template.regions;
        const expectedColumns = Math.max(1, ...target.blockIds.map((id) => templateBlocks.find((block) => templateBlockId(block) === id)?.structuredGroup?.columnCount ?? 1));
        const totalIndexes = output.rows.flatMap((row, rowIndex) => row.role === "total" ? [rowIndex] : []);
        if (totalIndexes.length > 1 || (totalIndexes.length === 1 && totalIndexes[0] !== output.rows.length - 1)) {
          throw new Error(`Structured target ${target.id} returned an invalid total-row position.`);
        }
        if (output.rows.some((row) => row.cells.length !== expectedColumns)) {
          throw new Error(`Structured target ${target.id} must preserve ${expectedColumns} columns.`);
        }
        output.rows.forEach((row, sequence) => {
          const rowCitations = groundedCitations(row.citations, evidence);
          generatedBlocks.push({
            id: `${target.id}:row:${sequence}`,
            kind: "table-row",
            text: row.cells.join(" · "),
            templateParagraphIndex: null,
            templateBlockId: target.blockIds[Math.min(sequence, target.blockIds.length - 1)]!,
            citations: rowCitations,
            attorneyEdited: false,
            targetId: target.id,
            outcomeId: `outcome:${target.id}`,
            sequence,
            structuredCells: row.cells,
            structuredRowRole: row.role,
          });
        });
      } else {
        const page = output.sourceId && output.page ? evidence.find((candidate) => candidate.sourceId === output.sourceId && candidate.page === output.page) : null;
        if (output.paragraphs.length || output.rows.length || !output.sourceId || !output.page || !output.caption || !output.mediaType || !page?.mimeType?.startsWith("image/") || !page.imageData || page.imageData.mediaType !== output.mediaType) {
          throw new Error(`Figure target ${target.id} did not select a valid uploaded evidence image and caption.`);
        }
        if (!citations.length) throw new Error(`Figure target ${target.id} requires a visual citation.`);
        generatedBlocks.push({
          id: `${target.id}:caption`,
          kind: "figure-caption",
          text: output.caption,
          templateParagraphIndex: null,
          templateBlockId: target.blockIds[0]!,
          citations,
          attorneyEdited: false,
          targetId: target.id,
          outcomeId: `outcome:${target.id}`,
          sequence: 0,
        });
      }
      if (target.kind === "narrative") {
        citations = groundedCitations(output.paragraphs.flatMap((paragraph) => paragraph.citations), evidence);
      } else if (target.kind === "structured") {
        citations = groundedCitations(output.rows.flatMap((row) => row.citations), evidence);
      }
    } else {
      if (output.paragraphs.length || output.rows.length || output.caption || output.sourceId || output.page || output.mediaType) {
        throw new Error(`Omitted target ${target.id} returned generated content.`);
      }
    }

    const outcome = GenerationOutcomeSchema.parse({
      id: `outcome:${target.id}`,
      targetId: target.id,
      targetKind: target.kind,
      status,
      citations,
      note: output.note,
      sourceId: target.kind === "figure" && status === "generated" ? output.sourceId : null,
      page: target.kind === "figure" && status === "generated" ? output.page : null,
      sourceName: target.kind === "figure" && status === "generated"
        ? evidence.find((page) => page.sourceId === output.sourceId)?.sourceName ?? null
        : null,
      mediaType: target.kind === "figure" && status === "generated" ? output.mediaType : null,
      caption: target.kind === "figure" && status === "generated" ? output.caption : null,
      exemplarCount: target.exemplarCount,
      generatedCount: target.kind === "narrative" ? output.paragraphs.length : target.kind === "structured" ? output.rows.length : status === "generated" ? 1 : 0,
    });
    outcomes.push(outcome);
  }

  const supportedEvidenceText = normalizeEvidenceText(evidence.map((page) => page.text).join("\n"));
  for (const [oldValueIndex, oldValue] of (template.knownCaseSpecificValues ?? []).entries()) {
    if (!oldValue.trim() || supportedEvidenceText.includes(normalizeEvidenceText(oldValue))) continue;
    const normalizedOldValue = normalizeEvidenceText(oldValue);
    const leakedBlock = generatedBlocks.find((block) => normalizeEvidenceText(block.text).includes(normalizedOldValue));
    if (leakedBlock) throw new Error(`Generation reused unsupported previous-case value #${oldValueIndex + 1} in target ${leakedBlock.targetId}.`);
  }
  const allowedOldValues = new Set(template.replacementCandidates.map((candidate) => candidate.value));
  const fields: GeneratedDraft["fields"] = {};
  const replacementByKey = new Map<string, (typeof parsed.replacements)[number]>();
  for (const replacement of parsed.replacements) {
    const candidate = template.replacementCandidates.find((item) => (
      (item.fieldKey ?? item.value) === replacement.fieldKey && item.value === replacement.oldValue
    ));
    if (!candidate || !allowedOldValues.has(replacement.oldValue)) throw new Error(`Generation returned an unknown inline field: ${replacement.fieldKey}`);
    const fieldKey = candidate.fieldKey ?? candidate.value;
    if (replacementByKey.has(fieldKey)) throw new Error(`Generation returned duplicate output for inline field ${fieldKey}.`);
    replacementByKey.set(fieldKey, replacement);
    if (replacement.value !== null) {
      const replacementCitations = groundedCitations(replacement.citations, evidence);
      if (!replacementCitations.length) throw new Error(`Replacement field ${fieldKey} is missing a grounding citation.`);
      fields[fieldKey] = {
        fieldKey,
        oldValue: replacement.oldValue,
        value: replacement.value,
        label: candidate.label ?? fieldKey,
        citations: replacementCitations,
        note: null,
        attorneyEdited: false,
      };
    } else {
      const omissionCitations = groundedCitations(replacement.citations, evidence);
      fields[fieldKey] = {
        fieldKey,
        oldValue: replacement.oldValue,
        value: null,
        label: candidate.label ?? fieldKey,
        citations: omissionCitations,
        note: replacement.note,
        attorneyEdited: false,
      };
    }
  }
  const missingFields = template.replacementCandidates
    .map((candidate) => candidate.fieldKey ?? candidate.value)
    .filter((fieldKey) => !replacementByKey.has(fieldKey));
  if (missingFields.length) throw new Error(`Generation omitted ${missingFields.length} required inline-field outcome(s).`);
  for (const [oldValueIndex, oldValue] of (template.knownCaseSpecificValues ?? []).entries()) {
    if (!oldValue.trim() || supportedEvidenceText.includes(normalizeEvidenceText(oldValue))) continue;
    const normalizedOldValue = normalizeEvidenceText(oldValue);
    const leakedField = Object.values(fields).find((field) => field.value && normalizeEvidenceText(field.value).includes(normalizedOldValue));
    if (leakedField) {
      throw new Error(`Generation reused unsupported previous-case value #${oldValueIndex + 1} in field ${leakedField.fieldKey}.`);
    }
  }
  return GeneratedDraftSchema.parse({
    title: "Demand letter",
    fields,
    sections: [{ id: "generated-targets", heading: null, blocks: generatedBlocks }],
    outcomes,
    confirmedOmissionTargetIds: [],
  });
}

function promptForRefinement(input: RefineInput): string {
  return `Propose bounded revisions to the passages relevant to the attorney's instruction.
Instruction: ${input.instruction}
Current immutable draft version: ${input.currentDraftVersion ?? "not supplied"}
Ordered editable passages: ${JSON.stringify(input.annotations)}
Evidence: ${JSON.stringify(input.evidence.map(({ imageData: _imageData, ...page }) => page))}
Find the passage or passages the instruction refers to and return edits only for those passages, up to five. Do not edit unrelated passages. Copy blockId, targetText, start, and end exactly from each supplied passage; replacementText must contain the complete revised passage and must differ from targetText. Follow ordinary wording, grammar, tone, and pronoun corrections directly. Do not introduce new substantive case facts unsupported by the evidence. If no supplied passage is relevant or no actual change can be made, throw an error instead of returning an unchanged edit.`;
}

function openAiMultimodalInput(prompt: string, evidence: EvidencePage[]) {
  return [{
    role: "user" as const,
    content: [
      { type: "input_text" as const, text: prompt },
      ...evidence.flatMap((page) => page.imageData ? [
        { type: "input_text" as const, text: `VISUAL INPUT: sourceId=${page.sourceId}; filename=${page.sourceName}; page=${page.page}` },
        { type: "input_image" as const, image_url: `data:${page.imageData.mediaType};base64,${page.imageData.base64}`, detail: "high" as const },
      ] : []),
    ],
  }];
}

function anthropicMultimodalContent(prompt: string, evidence: EvidencePage[]) {
  return [
    { type: "text" as const, text: prompt },
    ...evidence.flatMap((page) => page.imageData ? [
      { type: "text" as const, text: `VISUAL INPUT: sourceId=${page.sourceId}; filename=${page.sourceName}; page=${page.page}` },
      { type: "image" as const, source: { type: "base64" as const, media_type: page.imageData.mediaType, data: page.imageData.base64 } },
    ] : []),
  ];
}

function bedrockMultimodalContent(prompt: string, evidence: EvidencePage[]) {
  const formats = new Map<NonNullable<EvidencePage["imageData"]>["mediaType"], "png" | "jpeg" | "gif" | "webp">([
    ["image/png", "png"], ["image/jpeg", "jpeg"], ["image/gif", "gif"], ["image/webp", "webp"],
  ]);
  return [
    { text: prompt },
    ...evidence.flatMap((page) => page.imageData ? [
      { text: `VISUAL INPUT: sourceId=${page.sourceId}; filename=${page.sourceName}; page=${page.page}` },
      { image: { format: formats.get(page.imageData.mediaType)!, source: { bytes: Uint8Array.from(Buffer.from(page.imageData.base64, "base64")) } } },
    ] : []),
  ];
}

class OpenAiProvider implements AiProvider {
  readonly name = "openai";
  readonly model = config.openaiModel;
  private readonly client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  async analyzeTemplate(input: AnalyzeTemplateInput): Promise<TemplateAnalysis> {
    const response = await this.client.responses.create({
      model: this.model,
      input: promptForTemplateAnalysis(input),
      reasoning: { effort: (process.env.OPENAI_REASONING_EFFORT as "low" | "medium" | "high") ?? "high" },
      store: false,
      text: { format: { type: "json_schema", name: "template_analysis", strict: true, schema: templateAnalysisJsonSchema } },
    });
    return parseTemplateAnalysis(JSON.parse(response.output_text), input);
  }

  async generate(input: GenerateInput): Promise<GeneratedDraft> {
    const response = await this.client.responses.create({
      model: this.model,
      input: openAiMultimodalInput(promptForGeneration(input), input.evidence),
      reasoning: { effort: (process.env.OPENAI_REASONING_EFFORT as "low" | "medium" | "high") ?? "high" },
      store: false,
      text: { format: { type: "json_schema", name: "generated_draft", strict: true, schema: generatedDraftJsonSchema } },
    });
    return parseModelDraft(JSON.parse(response.output_text), input.evidence, input.template);
  }

  async refine(input: RefineInput): Promise<RefinementProposal> {
    const response = await this.client.responses.create({
      model: this.model,
      input: openAiMultimodalInput(promptForRefinement(input), input.evidence),
      reasoning: { effort: "high" },
      store: false,
      text: { format: { type: "json_schema", name: "refinement", strict: true, schema: refinementJsonSchema } },
    });
    return RefinementProposalSchema.parse(JSON.parse(response.output_text));
  }
}

class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";
  readonly model = config.anthropicModel;
  private readonly client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    ...(process.env.ANTHROPIC_WORKSPACE_ID
      ? { defaultHeaders: { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID } }
      : {}),
  });

  private async json(prompt: string, schema: unknown, evidence: EvidencePage[] = []): Promise<unknown> {
    const fullPrompt = `${prompt}\nJSON SCHEMA:\n${JSON.stringify(schema)}`;
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 16_000,
      system: "You draft evidence-grounded legal documents. Never invent facts. Return only JSON matching the requested schema.",
      messages: [{ role: "user", content: anthropicMultimodalContent(fullPrompt, evidence) }],
    });
    const block = response.content.find((item) => item.type === "text");
    if (!block || block.type !== "text") throw new Error("Anthropic returned no text output");
    const cleaned = block.text.replace(/^```json\s*/i, "").replace(/\s*```$/, "");
    return JSON.parse(cleaned);
  }

  async analyzeTemplate(input: AnalyzeTemplateInput): Promise<TemplateAnalysis> {
    return parseTemplateAnalysis(await this.json(promptForTemplateAnalysis(input), templateAnalysisJsonSchema), input);
  }

  async generate(input: GenerateInput): Promise<GeneratedDraft> {
    return parseModelDraft(await this.json(promptForGeneration(input), generatedDraftJsonSchema, input.evidence), input.evidence, input.template);
  }

  async refine(input: RefineInput): Promise<RefinementProposal> {
    return RefinementProposalSchema.parse(await this.json(promptForRefinement(input), refinementJsonSchema, input.evidence));
  }
}

class BedrockProvider implements AiProvider {
  readonly name = "bedrock";
  readonly model = config.bedrockModel;
  private readonly client = new BedrockRuntimeClient({
    region: config.awsRegion,
    maxAttempts: 5,
    retryMode: "adaptive",
  });

  private async json(prompt: string, schema: unknown, maxTokens: number, evidence: EvidencePage[] = []): Promise<unknown> {
    const fullPrompt = `${prompt}\nJSON SCHEMA:\n${JSON.stringify(schema)}`;
    const response = await this.client.send(new ConverseCommand({
      modelId: this.model,
      system: [{ text: "You draft evidence-grounded legal documents. Never invent facts. Return only JSON matching the requested schema." }],
      messages: [{ role: "user", content: bedrockMultimodalContent(fullPrompt, evidence) }],
      inferenceConfig: { maxTokens, temperature: 0 },
      requestMetadata: { application: "steno-demand-letter-studio" },
    }));
    const text = response.output?.message?.content
      ?.map((block) => block.text ?? "")
      .join("")
      .trim();
    if (!text) throw new Error("Bedrock returned no text output");
    const cleaned = text.replace(/^```json\s*/i, "").replace(/\s*```$/, "");
    return JSON.parse(cleaned);
  }

  async analyzeTemplate(input: AnalyzeTemplateInput): Promise<TemplateAnalysis> {
    return parseTemplateAnalysis(await this.json(promptForTemplateAnalysis(input), templateAnalysisJsonSchema, 16_000), input);
  }

  async generate(input: GenerateInput): Promise<GeneratedDraft> {
    return parseModelDraft(await this.json(promptForGeneration(input), generatedDraftJsonSchema, 16_000, input.evidence), input.evidence, input.template);
  }

  async refine(input: RefineInput): Promise<RefinementProposal> {
    return RefinementProposalSchema.parse(await this.json(promptForRefinement(input), refinementJsonSchema, 4_000, input.evidence));
  }
}

class MockProvider implements AiProvider {
  readonly name = "mock";
  readonly model = "deterministic-fixture";

  private async modelDelay(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  async analyzeTemplate(input: AnalyzeTemplateInput): Promise<TemplateAnalysis> {
    await this.modelDelay();
    const blocks = input.structuralAnalysis.blocks?.length
      ? input.structuralAnalysis.blocks
      : input.structuralAnalysis.regions;
    return parseTemplateAnalysis({
      decisions: blocks.map((block, index) => ({
        blockId: block.id ?? `word/document.xml:p:${block.paragraphIndex}`,
        role: blocks.length === 1 ? "replace" : index === 0 ? "heading" : index === blocks.length - 1 ? "keep" : "replace",
        confidence: 0.95,
        explanation: blocks.length === 1 ? "The fixture replaces the only case narrative block." : index === 0 ? "The fixture treats the first block as a heading." : index === blocks.length - 1 ? "The fixture keeps the final reusable block." : "The fixture replaces the case narrative block.",
        inlineFields: [],
      })),
      knownCaseSpecificValues: [],
    }, input);
  }

  async generate(input: GenerateInput): Promise<GeneratedDraft> {
    await this.modelDelay();
    const textual = input.evidence.find((page) => page.text.trim() && !page.text.startsWith("[Image evidence:"));
    const visual = input.evidence.find((page) => page.mimeType?.startsWith("image/") && page.imageData);
    const targets = deriveGenerationTargets(input.template);
    const textCitation = textual ? {
      sourceId: textual.sourceId,
      sourceName: textual.sourceName,
      page: textual.page,
      quote: textual.text.slice(0, 180),
      evidenceType: "text" as const,
      visualDescription: null,
    } : null;
    return parseModelDraft({
      title: "Time-Limited Policy Limits Demand",
      matterName: input.matterName,
      outcomes: targets.map((target) => {
        if (target.kind === "figure") {
          if (!visual?.imageData) return {
            targetId: target.id, status: "omitted", paragraphs: [], rows: [], caption: null,
            sourceId: null, page: null, mediaType: null, citations: [], note: "No uploaded image supports this figure slot.",
          };
          const citation = {
            sourceId: visual.sourceId, sourceName: visual.sourceName, page: visual.page, quote: "",
            evidenceType: "visual" as const, visualDescription: "Uploaded visual evidence selected for the mapped figure slot.",
          };
          return {
            targetId: target.id, status: "generated", paragraphs: [], rows: [], caption: "Photograph: Uploaded evidence for attorney review.",
            sourceId: visual.sourceId, page: visual.page, mediaType: visual.imageData.mediaType,
            citations: [citation], note: null,
          };
        }
        if (!textCitation) return {
          targetId: target.id, status: "omitted", paragraphs: [], rows: [], caption: null,
          sourceId: null, page: null, mediaType: null, citations: [], note: "No extractable evidence supports this target.",
        };
        if (target.kind === "structured") {
          const blocks = input.template.blocks?.length ? input.template.blocks : input.template.regions;
          const columnCount = Math.max(1, ...target.blockIds.map((id) => blocks.find((block) => templateBlockId(block) === id)?.structuredGroup?.columnCount ?? 1));
          return {
            targetId: target.id, status: "generated", paragraphs: [],
            rows: [{ role: "body", cells: Array.from({ length: columnCount }, (_unused, index) => index === 0 ? "Documented item" : index === columnCount - 1 ? "See cited source" : ""), citations: [textCitation] }],
            caption: null, sourceId: null, page: null, mediaType: null, citations: [], note: null,
          };
        }
        return {
          targetId: target.id, status: "generated",
          paragraphs: [{ text: "The enclosed records document the facts reflected in the cited source materials. Attorney review is required before adding any unsupported narrative from the prior completed letter.", citations: [textCitation] }],
          rows: [], caption: null, sourceId: null, page: null, mediaType: null, citations: [], note: null,
        };
      }),
      replacements: input.template.replacementCandidates.map((candidate) => ({
        fieldKey: candidate.fieldKey ?? candidate.value,
        oldValue: candidate.value,
        value: null,
        citations: [],
        note: "The deterministic provider did not identify a grounded replacement value.",
      })),
    }, input.evidence, input.template);
  }

  async refine(input: RefineInput): Promise<RefinementProposal> {
    await this.modelDelay();
    const edits = input.annotations.flatMap((annotation) => {
      const replacementText = annotation.quote
        .replace(/\bvery\s+/gi, "")
        .replace(/the facts reflected in the cited source materials/gi, "the cited facts")
        .replace(/any unsupported narrative from the prior completed letter/gi, "unsupported prior-letter narrative")
        .replace(/\s{2,}/g, " ")
        .trim();
      return replacementText === annotation.quote ? [] : [{
        blockId: annotation.blockId,
        targetText: annotation.quote,
        replacementText,
        start: annotation.start,
        end: annotation.end,
      }];
    }).slice(0, 5);
    if (!edits.length) throw new Error("The mock provider could not produce a real refinement for the supplied passages.");
    return RefinementProposalSchema.parse({
      edits,
      summary: `Tightened ${edits.length === 1 ? "the selected passage" : `${edits.length} selected passages`} without adding facts.`,
      citedSourceIds: [],
    });
  }
}

export function createAiProvider(name = config.aiProvider): AiProvider {
  if (name === "openai") return new OpenAiProvider();
  if (name === "anthropic") return new AnthropicProvider();
  if (name === "bedrock") return new BedrockProvider();
  if (name === "mock") return new MockProvider();
  throw new Error(`Unsupported AI provider: ${name}`);
}
