import { z } from "zod";

export const CitationSchema = z.object({
  sourceId: z.string().uuid(),
  sourceName: z.string(),
  page: z.number().int().positive().nullable(),
  quote: z.string().max(500),
  evidenceType: z.enum(["text", "visual"]).optional(),
  visualDescription: z.string().max(1_000).nullable().optional(),
}).superRefine((citation, context) => {
  if (citation.evidenceType === "text" && (!citation.page || !citation.quote.trim())) {
    context.addIssue({ code: "custom", message: "Text citations require a page and exact quote." });
  }
  if (citation.evidenceType === "visual" && (!citation.page || !citation.visualDescription?.trim())) {
    context.addIssue({ code: "custom", message: "Visual citations require a page and explicit visual description." });
  }
});

export const FieldProposalSchema = z.object({
  fieldKey: z.string().min(1).max(500),
  value: z.string().min(1).max(2_000),
  sourceId: z.string().uuid(),
  sourceName: z.string(),
  page: z.number().int().positive(),
  quote: z.string().min(1).max(500),
  confidence: z.number().min(0).max(1),
});

export const ReviewFlagSchema = z.object({
  id: z.string().min(1).max(200),
  kind: z.enum(["keep_conflict", "unsupported", "low_confidence", "looks_reusable", "missing_evidence", "conflict", "general"]).default("general"),
  severity: z.enum(["blocking", "verification", "informational"]).default("verification"),
  summary: z.string().min(1).max(240),
  explanation: z.string().min(1).max(2_000),
  citations: z.array(CitationSchema).max(12),
  affectedTemplateParagraphIndexes: z.array(z.number().int().nonnegative()).max(100),
  affectedFieldKeys: z.array(z.string().min(1).max(500)).max(100),
  affectedTargetIds: z.array(z.string().min(1).max(500)).max(100).default([]),
});

export const EvidenceReviewSchema = z.object({
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  fieldProposals: z.array(FieldProposalSchema).max(500).optional(),
  reviewFlags: z.array(ReviewFlagSchema).max(100),
  createdAt: z.string().datetime(),
});

export const ExportReadinessSchema = z.object({
  ready: z.boolean(),
  blockIds: z.array(z.string()),
  fieldKeys: z.array(z.string()),
  outcomeIds: z.array(z.string()).default([]),
  duplicateParagraphIndexes: z.array(z.number().int().nonnegative()),
  imageIssue: z.object({
    templateCandidates: z.number().int().nonnegative(),
    sourceImages: z.number().int().nonnegative(),
  }).nullable(),
  staleEvidence: z.boolean(),
  staleResolutionTargetIds: z.array(z.string()).default([]),
  blockingReviewFlagIds: z.array(z.string()),
});

export const GenerationOutcomeSchema = z.object({
  id: z.string().min(1).max(500),
  targetId: z.string().min(1).max(500),
  targetKind: z.enum(["narrative", "structured", "figure"]),
  status: z.enum(["generated", "omitted_no_evidence", "omitted_not_applicable"]),
  resolution: z.enum(["not_required", "unresolved", "preapproved", "confirmed"]),
  citations: z.array(CitationSchema).max(100),
  note: z.string().max(2_000).nullable().default(null),
  sourceId: z.string().uuid().nullable().default(null),
  page: z.number().int().positive().nullable().default(null),
  sourceName: z.string().nullable().default(null),
  mediaType: z.string().startsWith("image/").nullable().default(null),
  caption: z.string().max(2_000).nullable().default(null),
  exemplarCount: z.number().int().nonnegative(),
  generatedCount: z.number().int().nonnegative(),
}).superRefine((outcome, context) => {
  if (outcome.status === "generated" && outcome.resolution !== "not_required") {
    context.addIssue({ code: "custom", path: ["resolution"], message: "Generated outcomes do not require omission approval." });
  }
  if (outcome.status === "omitted_not_applicable" && !outcome.citations.length) {
    context.addIssue({ code: "custom", path: ["citations"], message: "Not-applicable omissions require supporting citations." });
  }
  if (outcome.status === "omitted_no_evidence" && outcome.resolution === "not_required") {
    context.addIssue({ code: "custom", path: ["resolution"], message: "No-evidence omissions must be unresolved or approved." });
  }
  if (outcome.targetKind === "figure" && outcome.status === "generated" && (!outcome.sourceId || !outcome.page || !outcome.caption)) {
    context.addIssue({ code: "custom", path: ["sourceId"], message: "Generated figures require a source image, page, and caption." });
  }
});

export const DraftBlockSchema = z.object({
  id: z.string(),
  kind: z.enum(["heading", "paragraph", "list-item", "table-row", "figure-caption", "warning"]),
  text: z.string(),
  templateParagraphIndex: z.number().int().nonnegative().nullable(),
  templateBlockId: z.string().min(1).max(500).nullable().optional(),
  citations: z.array(CitationSchema),
  verified: z.boolean(),
  userConfirmed: z.boolean().optional(),
  templateRole: z.enum(["keep", "replace"]).optional(),
  locked: z.boolean().optional(),
  targetId: z.string().min(1).max(500).nullable().optional(),
  outcomeId: z.string().min(1).max(500).nullable().optional(),
  sequence: z.number().int().nonnegative().optional(),
  structuredCells: z.array(z.string().max(20_000)).max(50).optional(),
  structuredRowRole: z.enum(["body", "total"]).optional(),
});

export const DraftSectionSchema = z.object({
  id: z.string(),
  heading: z.string().nullable(),
  blocks: z.array(DraftBlockSchema),
});

export const DraftFieldSchema = z.object({
  value: z.string(),
  label: z.string().nullable().optional(),
  templateValue: z.string().nullable().optional(),
  verified: z.boolean(),
  confidence: z.number().min(0).max(1).nullable().default(null),
  userConfirmed: z.boolean().default(false),
  sourceId: z.string().uuid().nullable().default(null),
  page: z.number().int().positive().nullable().default(null),
  sourceLabel: z.string().nullable().default(null),
  quote: z.string().max(500).nullable().optional(),
});

export const GeneratedDraftSchema = z.object({
  title: z.string(),
  matterName: z.string(),
  fields: z.record(z.string(), DraftFieldSchema),
  sections: z.array(DraftSectionSchema),
  warnings: z.array(z.string()),
  reviewFlags: z.array(ReviewFlagSchema).default([]),
  outcomes: z.array(GenerationOutcomeSchema).default([]),
});

export const TemplateFormattingSchema = z.object({
  styleId: z.string().nullable(),
  styleFamily: z.string().nullable().default(null),
  alignment: z.string().nullable(),
  bold: z.boolean(),
  italic: z.boolean(),
  underline: z.boolean().default(false),
  runCount: z.number().int().nonnegative(),
  indentLeft: z.number().int().nullable().default(null),
  indentRight: z.number().int().nullable().default(null),
  firstLine: z.number().int().nullable().default(null),
  hanging: z.number().int().nullable().default(null),
  spacingBefore: z.number().int().nullable().default(null),
  spacingAfter: z.number().int().nullable().default(null),
  lineSpacing: z.number().int().nullable().default(null),
  numberingId: z.string().nullable().default(null),
  numberingLevel: z.number().int().nonnegative().nullable().default(null),
  hasTabs: z.boolean().default(false),
  keepNext: z.boolean().default(false),
  pageBreakBefore: z.boolean().default(false),
});

export const TemplateStructuredGroupSchema = z.object({
  id: z.string().min(1).max(500),
  representation: z.enum(["word-table", "paragraph-rows"]),
  rowRole: z.enum(["header", "body", "total"]),
  tableIndex: z.number().int().nonnegative().nullable().default(null),
  rowIndex: z.number().int().nonnegative().nullable().default(null),
  cellIndex: z.number().int().nonnegative().nullable().default(null),
  columnCount: z.number().int().positive(),
  columnWidths: z.array(z.number().int().nonnegative()).max(50).default([]),
});

export const TemplateFigureSchema = z.object({
  relationshipId: z.string().min(1),
  partName: z.string().regex(/^word\/media\//),
  contentType: z.string().startsWith("image/"),
  captionBlockId: z.string().min(1).max(500).nullable().default(null),
});

export const TemplateRegionSchema = z.object({
  id: z.string().min(1).max(500).optional(),
  paragraphIndex: z.number().int().nonnegative(),
  text: z.string(),
  role: z.enum(["preserve", "editable", "heading"]),
  semanticKind: z.enum(["heading", "prose", "figure"]),
  section: z.string().nullable().default(null),
  aiRecommendation: z.enum(["keep", "replace"]).default("keep"),
  confidence: z.number().min(0).max(1),
  style: z.string().nullable(),
  explanation: z.string().max(1_000).optional(),
  needsAttention: z.boolean().optional(),
  anchor: z.object({
    partName: z.string().min(1),
    kind: z.enum(["paragraph", "table-cell", "header", "footer"]),
    paragraphIndex: z.number().int().nonnegative(),
    path: z.string().min(1),
  }).optional(),
  formatting: TemplateFormattingSchema.optional(),
  structuredGroup: TemplateStructuredGroupSchema.nullable().default(null),
  figure: TemplateFigureSchema.nullable().default(null),
  inlineFields: z.array(z.object({
    key: z.string().min(1).max(500),
    label: z.string().min(1).max(240),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    originalText: z.string().min(1),
    kind: z.enum(["claim-number", "person", "date", "amount", "other"]).default("other"),
    confidence: z.number().min(0).max(1),
    explanation: z.string().max(1_000),
    source: z.enum(["model", "user"]),
    role: z.enum(["keep", "replace"]),
  })).max(100).optional(),
}).superRefine((region, context) => {
  const fields = [...(region.inlineFields ?? [])].sort((left, right) => left.start - right.start);
  for (const [index, field] of fields.entries()) {
    if (field.end <= field.start || region.text.slice(field.start, field.end) !== field.originalText) {
      context.addIssue({ code: "custom", path: ["inlineFields"], message: "Inline fields must point to exact original template text." });
    }
    if (index > 0 && field.start < fields[index - 1]!.end) {
      context.addIssue({ code: "custom", path: ["inlineFields"], message: "Inline fields may not overlap." });
    }
  }
  if (region.semanticKind === "heading" && region.role !== "heading") {
    context.addIssue({ code: "custom", path: ["role"], message: "Heading structure is always locked." });
  }
  if (region.semanticKind === "figure" && !region.figure) {
    context.addIssue({ code: "custom", path: ["figure"], message: "Figure blocks require immutable OOXML figure metadata." });
  }
});

export const TemplateMapSchema = z.object({
  schemaVersion: z.literal(2),
  mapVersion: z.number().int().positive(),
  templateHash: z.string().regex(/^[a-f0-9]{64}$/),
  analysisVersion: z.number().int().positive(),
  blocks: z.array(TemplateRegionSchema).min(1),
  confirmedBy: z.string().uuid(),
  confirmedAt: z.string().datetime(),
});

export const TemplateAnalysisSchema = z.object({
  analysisVersion: z.number().int().positive().default(5),
  filename: z.string(),
  paragraphCount: z.number().int().nonnegative(),
  sectionCount: z.number().int().positive(),
  hasMacros: z.boolean(),
  hasTrackedChanges: z.boolean(),
  hasComplexObjects: z.boolean(),
  warnings: z.array(z.string()),
  regions: z.array(TemplateRegionSchema),
  blocks: z.array(TemplateRegionSchema).optional(),
  replacementCandidates: z.array(z.object({
    value: z.string().min(1),
    location: z.string(),
    kind: z.enum(["claim-number", "person", "date", "amount", "other"]),
    fieldKey: z.string().min(1).max(500).optional(),
    label: z.string().min(1).max(240).optional(),
    blockId: z.string().min(1).max(500).optional(),
    start: z.number().int().nonnegative().optional(),
    end: z.number().int().positive().optional(),
  })).default([]),
  knownCaseSpecificValues: z.array(z.string().min(1).max(500)).max(500).optional(),
  imageCandidates: z.array(z.object({
    blockId: z.string().min(1).max(500),
    paragraphIndex: z.number().int().nonnegative(),
    relationshipId: z.string().min(1),
    partName: z.string().regex(/^word\/media\//),
    contentType: z.string().startsWith("image/"),
    captionBlockId: z.string().min(1).max(500).nullable().default(null),
  })).default([]),
});

export const GenerationTargetSchema = z.object({
  id: z.string().min(1).max(500),
  kind: z.enum(["narrative", "structured", "figure"]),
  section: z.string().nullable(),
  blockIds: z.array(z.string().min(1).max(500)).min(1),
  partName: z.string().min(1),
  exemplarCount: z.number().int().positive(),
  minItems: z.number().int().positive(),
  maxItems: z.number().int().positive(),
  structuredGroupId: z.string().min(1).max(500).nullable().default(null),
  figure: TemplateFigureSchema.nullable().default(null),
});

export const ReviewResolutionSchema = z.object({
  id: z.string().uuid(),
  matterId: z.string().uuid(),
  targetId: z.string().min(1).max(500),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  action: z.literal("omit"),
  actorId: z.string().uuid(),
  actorName: z.string(),
  draftId: z.string().uuid().nullable().default(null),
  draftVersion: z.number().int().positive().nullable().default(null),
  createdAt: z.string().datetime(),
});

export const RefinementAnnotationSchema = z.object({
  blockId: z.string().min(1),
  quote: z.string().min(1).max(20_000),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
}).refine((annotation) => annotation.end > annotation.start, { message: "Annotation end must be after start." });

export const RefinementEditSchema = z.object({
  blockId: z.string().min(1),
  targetText: z.string().min(1),
  replacementText: z.string(),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
}).refine((edit) => edit.end > edit.start, { message: "Edit end must be after start." });

const CurrentRefinementProposalSchema = z.object({
  edits: z.array(RefinementEditSchema).min(1).max(5),
  summary: z.string(),
  citedSourceIds: z.array(z.string().uuid()),
});

const LegacyRefinementProposalSchema = z.object({
  targetText: z.string().min(1),
  replacementText: z.string(),
  summary: z.string(),
  citedSourceIds: z.array(z.string().uuid()),
});

export const RefinementProposalSchema = z.union([
  CurrentRefinementProposalSchema,
  LegacyRefinementProposalSchema.transform((proposal) => ({
    edits: [{
      blockId: "legacy",
      targetText: proposal.targetText,
      replacementText: proposal.replacementText,
      start: 0,
      end: proposal.targetText.length,
    }],
    summary: proposal.summary,
    citedSourceIds: proposal.citedSourceIds,
  })),
]);

export const JobStatusSchema = z.enum(["queued", "processing", "completed", "failed"]);

export const ExtractedFactSchema = z.object({
  kind: z.enum(["amount", "person", "date"]),
  label: z.string(),
  value: z.string(),
  page: z.number().int().positive(),
  confidence: z.number().min(0).max(1),
});

export type Citation = z.infer<typeof CitationSchema>;
export type FieldProposal = z.infer<typeof FieldProposalSchema>;
export type ReviewFlag = z.infer<typeof ReviewFlagSchema>;
export type EvidenceReview = z.infer<typeof EvidenceReviewSchema>;
export type ExportReadiness = z.infer<typeof ExportReadinessSchema>;
export type GenerationOutcome = z.infer<typeof GenerationOutcomeSchema>;
export type DraftBlock = z.infer<typeof DraftBlockSchema>;
export type DraftSection = z.infer<typeof DraftSectionSchema>;
export type DraftField = z.infer<typeof DraftFieldSchema>;
export type GeneratedDraft = z.infer<typeof GeneratedDraftSchema>;
export type TemplateRegion = z.infer<typeof TemplateRegionSchema>;
export type TemplateFormatting = z.infer<typeof TemplateFormattingSchema>;
export type TemplateStructuredGroup = z.infer<typeof TemplateStructuredGroupSchema>;
export type TemplateFigure = z.infer<typeof TemplateFigureSchema>;
export type TemplateMap = z.infer<typeof TemplateMapSchema>;
export type TemplateAnalysis = z.infer<typeof TemplateAnalysisSchema>;
export type GenerationTarget = z.infer<typeof GenerationTargetSchema>;
export type ReviewResolution = z.infer<typeof ReviewResolutionSchema>;
export type RefinementProposal = z.infer<typeof RefinementProposalSchema>;
export type RefinementAnnotation = z.infer<typeof RefinementAnnotationSchema>;
export type RefinementEdit = z.infer<typeof RefinementEditSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;
export type ExtractedFact = z.infer<typeof ExtractedFactSchema>;

export interface TemplateRecord {
  id: string;
  name: string;
  status: "analyzed" | "confirmed";
  analysis: TemplateAnalysis;
  confirmedMap?: TemplateMap;
  currentMapVersion?: number;
  createdAt: string;
}

export interface SourceDocument {
  id: string;
  matterId: string;
  name: string;
  mimeType: string;
  pageCount: number;
  status: "processing" | "ready" | "failed";
}

export interface Matter {
  id: string;
  name: string;
  templateId: string | null;
  templateMapVersion: number | null;
  createdAt: string;
  reviewResolutions?: ReviewResolution[];
}

export interface DraftRecord {
  id: string;
  matterId: string;
  version: number;
  content: GeneratedDraft;
  createdAt: string;
  updatedAt: string;
}

export interface JobRecord {
  id: string;
  matterId: string;
  status: JobStatus;
  progress: number;
  step: string;
  draftId: string | null;
  error: string | null;
}
