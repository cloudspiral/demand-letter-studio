import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import OpenAI from "openai";
import { z } from "zod";
import {
  CitationSchema,
  FieldProposalSchema,
  GenerationOutcomeSchema,
  GeneratedDraftSchema,
  ReviewFlagSchema,
  RefinementProposalSchema,
  TemplateAnalysisSchema,
  TemplateRegionSchema,
  type EvidenceReview,
  type Citation,
  type FieldProposal,
  type GeneratedDraft,
  type GenerationOutcome,
  type ReviewResolution,
  type ReviewFlag,
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
  evidenceReview?: EvidenceReview | null;
  reviewResolutions?: ReviewResolution[];
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

export interface EvidenceReviewResult {
  fieldProposals: FieldProposal[];
  reviewFlags: ReviewFlag[];
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  analyzeTemplate(input: AnalyzeTemplateInput): Promise<TemplateAnalysis>;
  review(input: GenerateInput): Promise<EvidenceReviewResult>;
  generate(input: GenerateInput): Promise<GeneratedDraft>;
  refine(input: RefineInput): Promise<RefinementProposal>;
}

function strictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _metaSchema, ...jsonSchema } = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  return jsonSchema;
}

const reviewFlagJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "kind", "severity", "summary", "explanation", "citations", "affectedTemplateParagraphIndexes", "affectedFieldKeys", "affectedTargetIds"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 200 },
    kind: { enum: ["keep_conflict", "unsupported", "low_confidence", "looks_reusable", "missing_evidence", "conflict", "general"] },
    severity: { enum: ["blocking", "verification", "informational"] },
    summary: { type: "string", minLength: 1, maxLength: 240 },
    explanation: { type: "string", minLength: 1, maxLength: 2_000 },
    citations: {
      type: "array", maxItems: 12,
      items: {
        type: "object", additionalProperties: false,
        required: ["sourceId", "sourceName", "page", "quote"],
        properties: {
          sourceId: { type: "string" }, sourceName: { type: "string" },
          page: { type: ["integer", "null"] }, quote: { type: "string", maxLength: 500 },
        },
      },
    },
    affectedTemplateParagraphIndexes: { type: "array", maxItems: 100, items: { type: "integer", minimum: 0 } },
    affectedFieldKeys: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 500 } },
    affectedTargetIds: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 500 } },
  },
} as const;

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

const ModelReviewFlagSchema = z.object({
  id: z.string().min(1).max(200),
  kind: z.enum(["keep_conflict", "unsupported", "low_confidence", "looks_reusable", "missing_evidence", "conflict", "general"]),
  severity: z.enum(["blocking", "verification", "informational"]),
  summary: z.string().min(1).max(240),
  explanation: z.string().min(1).max(2_000),
  citations: z.array(ModelCitationSchema).max(12),
  affectedTemplateParagraphIndexes: z.array(z.number().int().nonnegative()).max(100),
  affectedFieldKeys: z.array(z.string().min(1).max(500)).max(100),
  affectedTargetIds: z.array(z.string().min(1).max(500)).max(100),
});

const ModelGenerationOutputSchema = z.object({
  title: z.string(),
  matterName: z.string(),
  outcomes: z.array(z.object({
    targetId: z.string().min(1).max(500),
    status: z.enum(["generated", "omitted_no_evidence", "omitted_not_applicable"]),
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
  warnings: z.array(z.string().max(2_000)).max(100),
  reviewFlags: z.array(ModelReviewFlagSchema).max(100),
  replacements: z.array(z.object({
    fieldKey: z.string().min(1).max(500),
    oldValue: z.string().min(1),
    status: z.enum(["replaced", "omitted_no_evidence", "omitted_not_applicable"]),
    newValue: z.string().min(1).nullable(),
    sourceId: z.string().uuid().nullable(),
    page: z.number().int().positive().nullable(),
    citations: z.array(ModelCitationSchema).max(50),
    note: z.string().max(2_000).nullable(),
  })).max(500),
});

export const generatedDraftJsonSchema = strictJsonSchema(ModelGenerationOutputSchema);

export const evidenceReviewJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["fieldProposals", "reviewFlags"],
  properties: {
    fieldProposals: {
      type: "array",
      maxItems: 500,
      items: strictJsonSchema(FieldProposalSchema),
    },
    reviewFlags: {
      type: "array",
      maxItems: 100,
      items: reviewFlagJsonSchema,
    },
  },
} as const;

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
    preapprovedOmission: Boolean(input.reviewResolutions?.some((resolution) => resolution.targetId === target.id)),
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
- If evidence is silent, return omitted_no_evidence with no generated paragraphs/rows/figure. If evidence positively establishes that a target is inapplicable, return omitted_not_applicable with supporting citations.
- A target marked preapprovedOmission must return omitted_no_evidence. Do not draft content for it.
- If sources conflict about a name, claim number, date, amount, coverage, liability, treatment, or deadline, do not choose a value. Omit the affected target as no evidence and describe the conflict in warnings and reviewFlags.
- Carry forward the advisory evidence-review field proposals and warnings, but independently ground all generated factual content in EVIDENCE.
- Preserve document order, defined terms, pronouns, chronology, surrounding flow, rhetorical purpose, and approximate layout. Code reuses keep language exactly; do not return it.
- Return concise structured JSON, never HTML, Markdown, code, or OOXML.
- Return exactly one replacement outcome for every INLINE FIELD DECISION and no others. Copy fieldKey and oldValue exactly. Use replaced with a grounded newValue/sourceId/page and at least one exact quote citation from that same source page, or an explicit omitted status with null value/source/page. A heading value may reformat a cited date, name, reference, or amount to fit the surrounding template. Silent field omission is invalid.
- Review flags must use only supplied targetIds, paragraph indexes, and field keys. Use severity blocking for unresolved missing/conflicting evidence, verification for a kept-content conflict or low confidence, and informational for not-applicable or shape changes.

KEEP/HEADING CONTEXT IN DOCUMENT ORDER:
${JSON.stringify(keptContext)}

GENERATION TARGETS AND PREVIOUS-CASE EXEMPLARS:
${JSON.stringify(targets)}

INLINE FIELD DECISIONS:
${JSON.stringify(input.template.replacementCandidates)}

ADVISORY EVIDENCE REVIEW:
${JSON.stringify(input.evidenceReview ?? null)}

EVIDENCE:
${JSON.stringify(input.evidence.map(({ imageData: _imageData, ...page }) => page))}`;
}

function promptForEvidenceReview(input: GenerateInput): string {
  const completeMap = (input.template.blocks?.length ? input.template.blocks : input.template.regions).map((region) => ({
    blockId: region.id ?? `word/document.xml:p:${region.paragraphIndex}`,
    paragraphIndex: region.paragraphIndex,
    partName: region.anchor?.partName ?? "word/document.xml",
    text: region.text,
    role: region.role === "editable" ? "replace" : region.role === "heading" ? "heading" : "keep",
    inlineFields: region.inlineFields,
  }));
  const targets = deriveGenerationTargets(input.template);
  return `Review the uploaded evidence before drafting an attorney-review demand letter for ${input.matterName}.
The complete mapped template is from a previous case. Its text is context only and is never evidence.
Return provenance-backed proposals for inline fields plus high-signal advisory review flags.
- Use only the complete uploaded case packet in EVIDENCE.
- For every proposed field value, copy an exact source-page quote and provide sourceId, sourceName, page, and confidence.
- If support is missing, do not invent a value. Create a missing_evidence blocking flag linked to the affected targetIds and/or field keys.
- Do not classify documents or assign types, severities, or validity labels.
- Do not decide authenticity, evidentiary admissibility, legal sufficiency, or legal validity.
- Do not draft letter language and do not produce a case summary.
- When sources appear inconsistent, cite short exact contiguous quotes from every relevant source page.
- Visual-only observations must use evidenceType=visual with an explicit visualDescription; never present a visual observation as quoted text.
- When supporting evidence cannot be located, use no citations and identify the affected stable targetIds and/or field keys.
- A review flag is advisory and non-exhaustive. Do not claim the packet is complete.
- Use only targetIds, paragraph indexes, and field keys supplied below. Use empty target arrays only for a genuinely packet-wide advisory concern.

COMPLETE CONFIRMED TEMPLATE MAP:
${JSON.stringify(completeMap)}

TEMPLATE REPLACEMENT CANDIDATES:
${JSON.stringify(input.template.replacementCandidates)}

STABLE GENERATION TARGETS:
${JSON.stringify(targets)}

EVIDENCE:
${JSON.stringify(input.evidence.map(({ imageData: _imageData, ...page }) => page))}`;
}

const ReviewFlagsOutputSchema = z.object({
  fieldProposals: z.array(FieldProposalSchema).max(500).default([]),
  reviewFlags: z.array(ReviewFlagSchema).max(100),
});

const normalizeEvidenceText = (value: string): string => value
  .normalize("NFKC")
  .replace(/\s+/g, " ")
  .trim()
  .toLocaleLowerCase();

function stableFlagId(flag: Omit<ReviewFlag, "id">): string {
  return `source-review-${createHash("sha256").update(JSON.stringify({
    kind: flag.kind,
    severity: flag.severity,
    summary: normalizeEvidenceText(flag.summary),
    paragraphs: flag.affectedTemplateParagraphIndexes,
    fields: flag.affectedFieldKeys,
    targets: flag.affectedTargetIds,
    citations: flag.citations.map((citation) => [
      citation.sourceId,
      citation.page,
      citation.evidenceType ?? "text",
      normalizeEvidenceText(citation.quote),
      normalizeEvidenceText(citation.visualDescription ?? ""),
    ]),
  })).digest("hex").slice(0, 16)}`;
}

export function validateReviewFlags(
  rawFlags: unknown,
  evidence: EvidencePage[],
  template: TemplateAnalysis,
): ReviewFlag[] {
  const parsed = z.array(ReviewFlagSchema).max(100).parse(rawFlags);
  const pages = new Map(evidence.map((page) => [`${page.sourceId}:${page.page}`, page]));
  const paragraphIndexes = new Set(template.regions.filter((region) => region.role === "editable").map((region) => region.paragraphIndex));
  const fieldKeys = new Set(template.replacementCandidates.flatMap((candidate) => [candidate.fieldKey, candidate.value]
    .filter((value): value is string => Boolean(value))));
  const targets = deriveGenerationTargets(template);
  const targetIds = new Set(targets.map((target) => target.id));
  const blockById = new Map((template.blocks?.length ? template.blocks : template.regions).map((block) => [templateBlockId(block), block]));
  const flags: ReviewFlag[] = [];
  const seen = new Set<string>();

  for (const flag of parsed) {
    const citations = flag.citations.flatMap((citation) => {
      if (citation.page === null) return [];
      const page = pages.get(`${citation.sourceId}:${citation.page}`);
      if (!page) return [];
      if (citation.evidenceType === "visual") {
        if (!page.visualInput || !citation.visualDescription?.trim()) return [];
        return [{ ...citation, sourceName: page.sourceName }];
      }
      if (!citation.quote.trim() || !normalizeEvidenceText(page.text).includes(normalizeEvidenceText(citation.quote))) return [];
      return [{ ...citation, sourceName: page.sourceName }];
    });
    if (flag.citations.length > 0 && citations.length === 0) continue;

    const affectedTemplateParagraphIndexes = [...new Set(flag.affectedTemplateParagraphIndexes.filter((index) => paragraphIndexes.has(index)))];
    const affectedFieldKeys = [...new Set(flag.affectedFieldKeys.filter((key) => fieldKeys.has(key)))];
    const affectedTargetIds = [...new Set([
      ...flag.affectedTargetIds.filter((id) => targetIds.has(id)),
      ...targets.filter((target) => target.blockIds.some((blockId) => (
        affectedTemplateParagraphIndexes.includes(blockById.get(blockId)?.paragraphIndex ?? -1)
      ))).map((target) => target.id),
    ])];
    const uncitedTarget = affectedTargetIds.length
      ? `the affected generation ${affectedTargetIds.length === 1 ? "target" : "targets"}`
      : affectedFieldKeys.length
      ? `the affected template ${affectedFieldKeys.length === 1 ? "field" : "fields"}`
      : affectedTemplateParagraphIndexes.length
        ? `the affected template ${affectedTemplateParagraphIndexes.length === 1 ? "region" : "regions"}`
        : "the case-specific draft";
    const normalized: Omit<ReviewFlag, "id"> = citations.length
      ? {
          kind: flag.kind,
          severity: flag.severity,
          summary: flag.summary,
          explanation: flag.explanation,
          citations,
          affectedTemplateParagraphIndexes,
          affectedFieldKeys,
          affectedTargetIds,
        }
      : {
          kind: "missing_evidence" as const,
          severity: "blocking" as const,
          summary: "Supporting evidence not located",
          explanation: `The uploaded sources did not provide support for ${uncitedTarget}. Review the source materials before relying on this point.`,
          citations: [],
          affectedTemplateParagraphIndexes,
          affectedFieldKeys,
          affectedTargetIds,
        };
    const id = stableFlagId(normalized);
    if (seen.has(id)) continue;
    seen.add(id);
    flags.push({ id, ...normalized });
  }
  return flags;
}

export function parseEvidenceReview(raw: unknown, evidence: EvidencePage[], template: TemplateAnalysis): EvidenceReviewResult {
  const parsed = ReviewFlagsOutputSchema.parse(raw);
  const pages = new Map(evidence.map((page) => [`${page.sourceId}:${page.page}`, page]));
  const allowedFieldKeys = new Set(template.replacementCandidates.flatMap((candidate) => [candidate.fieldKey, candidate.value].filter((value): value is string => Boolean(value))));
  const fieldProposals = parsed.fieldProposals.filter((proposal) => {
    const page = pages.get(`${proposal.sourceId}:${proposal.page}`);
    return Boolean(
      page
      && allowedFieldKeys.has(proposal.fieldKey)
      && normalizeEvidenceText(page.text).includes(normalizeEvidenceText(proposal.quote))
      && normalizeEvidenceText(proposal.quote).includes(normalizeEvidenceText(proposal.value)),
    );
  }).map((proposal) => ({ ...proposal, sourceName: pages.get(`${proposal.sourceId}:${proposal.page}`)!.sourceName }));
  const proposedFieldKeys = new Set<string>();
  for (const proposal of fieldProposals) {
    if (proposedFieldKeys.has(proposal.fieldKey)) {
      throw new Error(`Evidence review returned duplicate proposals for field ${proposal.fieldKey}.`);
    }
    proposedFieldKeys.add(proposal.fieldKey);
  }
  return {
    fieldProposals,
    reviewFlags: validateReviewFlags(parsed.reviewFlags, evidence, template),
  };
}

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
  reviewResolutions: ReviewResolution[] = [],
): GeneratedDraft {
  const parsed = ModelGenerationOutputSchema.parse(raw);
  const pages = new Map(evidence.map((page) => [`${page.sourceId}:${page.page}`, page]));
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

  const currentResolutionTargets = new Set(reviewResolutions.map((resolution) => resolution.targetId));
  const generatedBlocks: GeneratedDraft["sections"][number]["blocks"] = [];
  const outcomes: GenerationOutcome[] = [];
  for (const target of targets) {
    const output = outputByTarget.get(target.id)!;
    const preapproved = currentResolutionTargets.has(target.id);
    if (preapproved && output.status !== "omitted_no_evidence") {
      throw new Error(`Generation wrote target ${target.id} despite its pre-approved omission.`);
    }
    let status = output.status;
    let citations = groundedCitations(output.citations, evidence);
    if (status === "omitted_not_applicable" && !citations.length) status = "omitted_no_evidence";

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
            verified: true,
            userConfirmed: false,
            templateRole: "replace",
            locked: false,
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
            verified: true,
            userConfirmed: false,
            templateRole: "replace",
            locked: false,
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
          verified: true,
          userConfirmed: false,
          templateRole: "replace",
          locked: false,
          targetId: target.id,
          outcomeId: `outcome:${target.id}`,
          sequence: 0,
        });
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
      resolution: status === "generated" || status === "omitted_not_applicable"
        ? "not_required"
        : preapproved ? "preapproved" : "unresolved",
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
  for (const oldValue of template.knownCaseSpecificValues ?? []) {
    if (!oldValue.trim() || supportedEvidenceText.includes(normalizeEvidenceText(oldValue))) continue;
    const leaked = generatedBlocks
      .some((block) => normalizeEvidenceText(block.text).includes(normalizeEvidenceText(oldValue)));
    if (leaked) throw new Error("Generation reused a previous-case value without new-case support.");
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
    if (replacement.status === "replaced") {
      if (!replacement.newValue || !replacement.sourceId || !replacement.page) throw new Error(`Replacement field ${fieldKey} is missing its grounded value or source.`);
      const source = pages.get(`${replacement.sourceId}:${replacement.page}`);
      const replacementCitations = groundedCitations(replacement.citations, evidence);
      if (!source || !replacementCitations.some((citation) => citation.sourceId === source.sourceId && citation.page === source.page)) {
        throw new Error(`Replacement field ${fieldKey} is not grounded on its cited source page.`);
      }
      fields[fieldKey] = {
        value: replacement.newValue,
        label: candidate.label ?? fieldKey,
        templateValue: replacement.oldValue,
        verified: true,
        confidence: 1,
        userConfirmed: false,
        sourceId: source.sourceId,
        page: source.page,
        sourceLabel: `${source.sourceName} p. ${source.page}`,
        quote: replacementCitations.find((citation) => citation.sourceId === source.sourceId && citation.page === source.page)!.quote,
      };
    } else {
      if (replacement.newValue || replacement.sourceId || replacement.page) throw new Error(`Omitted replacement field ${fieldKey} returned generated content.`);
      const omissionCitations = groundedCitations(replacement.citations, evidence);
      if (replacement.status === "omitted_not_applicable" && !omissionCitations.length) {
        throw new Error(`Not-applicable replacement field ${fieldKey} requires supporting evidence.`);
      }
      fields[fieldKey] = {
        value: "[ATTORNEY REVIEW REQUIRED]",
        label: candidate.label ?? fieldKey,
        templateValue: replacement.oldValue,
        verified: false,
        confidence: null,
        userConfirmed: false,
        sourceId: null,
        page: null,
        sourceLabel: null,
      };
    }
  }
  const missingFields = template.replacementCandidates
    .map((candidate) => candidate.fieldKey ?? candidate.value)
    .filter((fieldKey) => !replacementByKey.has(fieldKey));
  if (missingFields.length) throw new Error(`Generation omitted ${missingFields.length} required inline-field outcome(s).`);
  return GeneratedDraftSchema.parse({
    title: parsed.title,
    matterName: parsed.matterName,
    fields,
    sections: [{ id: "generated-targets", heading: null, blocks: generatedBlocks }],
    warnings: parsed.warnings,
    reviewFlags: validateReviewFlags(parsed.reviewFlags, evidence, template),
    outcomes,
  });
}

function promptForRefinement(input: RefineInput): string {
  return `Propose bounded revisions to one or more selected passages in a demand letter.
Instruction: ${input.instruction}
Current immutable draft version: ${input.currentDraftVersion ?? "not supplied"}
Selections: ${JSON.stringify(input.annotations)}
Evidence: ${JSON.stringify(input.evidence.map(({ imageData: _imageData, ...page }) => page))}
Return one edit per changed selection. Copy blockId, targetText, start, and end exactly from each supplied selection. Do not introduce facts unsupported by the evidence. If the instruction requires unsupported facts, keep the relevant text unchanged and explain why in summary.`;
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

  async review(input: GenerateInput): Promise<EvidenceReviewResult> {
    const response = await this.client.responses.create({
      model: this.model,
      input: openAiMultimodalInput(promptForEvidenceReview(input), input.evidence),
      reasoning: { effort: (process.env.OPENAI_REASONING_EFFORT as "low" | "medium" | "high") ?? "high" },
      store: false,
      text: { format: { type: "json_schema", name: "evidence_review", strict: true, schema: evidenceReviewJsonSchema } },
    });
    return parseEvidenceReview(JSON.parse(response.output_text), input.evidence, input.template);
  }

  async generate(input: GenerateInput): Promise<GeneratedDraft> {
    const response = await this.client.responses.create({
      model: this.model,
      input: openAiMultimodalInput(promptForGeneration(input), input.evidence),
      reasoning: { effort: (process.env.OPENAI_REASONING_EFFORT as "low" | "medium" | "high") ?? "high" },
      store: false,
      text: { format: { type: "json_schema", name: "generated_draft", strict: true, schema: generatedDraftJsonSchema } },
    });
    return parseModelDraft(JSON.parse(response.output_text), input.evidence, input.template, input.reviewResolutions);
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

  async review(input: GenerateInput): Promise<EvidenceReviewResult> {
    return parseEvidenceReview(await this.json(promptForEvidenceReview(input), evidenceReviewJsonSchema, input.evidence), input.evidence, input.template);
  }

  async generate(input: GenerateInput): Promise<GeneratedDraft> {
    return parseModelDraft(await this.json(promptForGeneration(input), generatedDraftJsonSchema, input.evidence), input.evidence, input.template, input.reviewResolutions);
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

  async review(input: GenerateInput): Promise<EvidenceReviewResult> {
    return parseEvidenceReview(await this.json(promptForEvidenceReview(input), evidenceReviewJsonSchema, 8_000, input.evidence), input.evidence, input.template);
  }

  async generate(input: GenerateInput): Promise<GeneratedDraft> {
    return parseModelDraft(await this.json(promptForGeneration(input), generatedDraftJsonSchema, 16_000, input.evidence), input.evidence, input.template, input.reviewResolutions);
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

  async review(input: GenerateInput): Promise<EvidenceReviewResult> {
    await this.modelDelay();
    const textualEvidence = input.evidence.filter((page) => page.text.trim() && !page.text.startsWith("[Image evidence:"));
    const affectedTemplateParagraphIndexes = input.template.regions
      .filter((region) => region.role === "editable")
      .slice(textualEvidence.length ? 1 : 0, textualEvidence.length ? 3 : 2)
      .map((region) => region.paragraphIndex);
    const affectedFieldKeys = input.template.replacementCandidates
      .filter((candidate) => !textualEvidence.some((page) => page.text.includes(candidate.value)))
      .slice(0, 3)
      .map((candidate) => candidate.fieldKey ?? candidate.value);
    if (!affectedTemplateParagraphIndexes.length && !affectedFieldKeys.length) return { fieldProposals: [], reviewFlags: [] };
    return { fieldProposals: [], reviewFlags: validateReviewFlags([{
      id: "mock-review",
      summary: "Supporting evidence not located",
      explanation: "The deterministic review did not locate support for every case-specific template target.",
      citations: [],
      affectedTemplateParagraphIndexes,
      affectedFieldKeys,
    }], input.evidence, input.template) };
  }

  async generate(input: GenerateInput): Promise<GeneratedDraft> {
    await this.modelDelay();
    const textual = input.evidence.find((page) => page.text.trim() && !page.text.startsWith("[Image evidence:"));
    const visual = input.evidence.find((page) => page.mimeType?.startsWith("image/") && page.imageData);
    const targets = deriveGenerationTargets(input.template);
    const preapproved = new Set(input.reviewResolutions?.map((resolution) => resolution.targetId) ?? []);
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
        if (preapproved.has(target.id)) return {
          targetId: target.id, status: "omitted_no_evidence", paragraphs: [], rows: [], caption: null,
          sourceId: null, page: null, mediaType: null, citations: [], note: "Omitted for this matter before generation.",
        };
        if (target.kind === "figure") {
          if (!visual?.imageData) return {
            targetId: target.id, status: "omitted_no_evidence", paragraphs: [], rows: [], caption: null,
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
          targetId: target.id, status: "omitted_no_evidence", paragraphs: [], rows: [], caption: null,
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
      warnings: ["The provided packet contains billing documents and an image, not the complete underlying case record."],
      reviewFlags: (await this.review(input)).reviewFlags,
      replacements: input.template.replacementCandidates.map((candidate) => ({
        fieldKey: candidate.fieldKey ?? candidate.value,
        oldValue: candidate.value,
        status: "omitted_no_evidence",
        newValue: null,
        sourceId: null,
        page: null,
        citations: [],
        note: "The deterministic provider did not identify a grounded replacement value.",
      })),
    }, input.evidence, input.template, input.reviewResolutions);
  }

  async refine(input: RefineInput): Promise<RefinementProposal> {
    await this.modelDelay();
    const edits = input.annotations.map((annotation) => ({
      blockId: annotation.blockId,
      targetText: annotation.quote,
      replacementText: annotation.quote.replace(/\bvery\b/gi, "").replace(/\s{2,}/g, " ").trim(),
      start: annotation.start,
      end: annotation.end,
    }));
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
