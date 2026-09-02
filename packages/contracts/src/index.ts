import { z } from "zod";

export const CitationSchema = z.object({
  sourceId: z.string().uuid(),
  sourceName: z.string(),
  page: z.number().int().positive().nullable(),
  quote: z.string().max(500),
});

export const ReviewFlagSchema = z.object({
  id: z.string().min(1).max(200),
  summary: z.string().min(1).max(240),
  explanation: z.string().min(1).max(2_000),
  citations: z.array(CitationSchema).max(12),
  affectedTemplateParagraphIndexes: z.array(z.number().int().nonnegative()).max(100),
  affectedFieldKeys: z.array(z.string().min(1).max(500)).max(100),
});

export const EvidenceReviewSchema = z.object({
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  reviewFlags: z.array(ReviewFlagSchema).max(100),
  createdAt: z.string().datetime(),
});

export const ExportReadinessSchema = z.object({
  ready: z.boolean(),
  blockIds: z.array(z.string()),
  fieldKeys: z.array(z.string()),
  duplicateParagraphIndexes: z.array(z.number().int().nonnegative()),
  imageIssue: z.object({
    templateCandidates: z.number().int().nonnegative(),
    sourceImages: z.number().int().nonnegative(),
  }).nullable(),
  staleEvidence: z.boolean(),
  blockingReviewFlagIds: z.array(z.string()),
});

export const DraftBlockSchema = z.object({
  id: z.string(),
  kind: z.enum(["heading", "paragraph", "list-item", "table-row", "warning"]),
  text: z.string(),
  templateParagraphIndex: z.number().int().nonnegative().nullable(),
  citations: z.array(CitationSchema),
  verified: z.boolean(),
  userConfirmed: z.boolean().optional(),
});

export const DraftSectionSchema = z.object({
  id: z.string(),
  heading: z.string().nullable(),
  blocks: z.array(DraftBlockSchema),
});

export const DraftFieldSchema = z.object({
  value: z.string(),
  verified: z.boolean(),
  confidence: z.number().min(0).max(1).nullable().default(null),
  userConfirmed: z.boolean().default(false),
  sourceId: z.string().uuid().nullable().default(null),
  page: z.number().int().positive().nullable().default(null),
  sourceLabel: z.string().nullable().default(null),
});

export const GeneratedDraftSchema = z.object({
  title: z.string(),
  matterName: z.string(),
  fields: z.record(z.string(), DraftFieldSchema),
  sections: z.array(DraftSectionSchema),
  warnings: z.array(z.string()),
  reviewFlags: z.array(ReviewFlagSchema).default([]),
});

export const TemplateRegionSchema = z.object({
  paragraphIndex: z.number().int().nonnegative(),
  text: z.string(),
  role: z.enum(["preserve", "editable", "heading"]),
  confidence: z.number().min(0).max(1),
  style: z.string().nullable(),
});

export const TemplateAnalysisSchema = z.object({
  analysisVersion: z.number().int().positive().default(1),
  filename: z.string(),
  paragraphCount: z.number().int().nonnegative(),
  sectionCount: z.number().int().positive(),
  hasMacros: z.boolean(),
  hasTrackedChanges: z.boolean(),
  hasComplexObjects: z.boolean(),
  warnings: z.array(z.string()),
  regions: z.array(TemplateRegionSchema),
  replacementCandidates: z.array(z.object({
    value: z.string().min(1),
    location: z.string(),
    kind: z.enum(["claim-number", "person", "date", "amount"]),
  })).default([]),
  imageCandidates: z.array(z.object({
    paragraphIndex: z.number().int().nonnegative(),
    relationshipId: z.string().min(1),
    partName: z.string().regex(/^word\/media\//),
    contentType: z.string().startsWith("image/"),
  })).default([]),
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
export type ReviewFlag = z.infer<typeof ReviewFlagSchema>;
export type EvidenceReview = z.infer<typeof EvidenceReviewSchema>;
export type ExportReadiness = z.infer<typeof ExportReadinessSchema>;
export type DraftBlock = z.infer<typeof DraftBlockSchema>;
export type DraftSection = z.infer<typeof DraftSectionSchema>;
export type DraftField = z.infer<typeof DraftFieldSchema>;
export type GeneratedDraft = z.infer<typeof GeneratedDraftSchema>;
export type TemplateRegion = z.infer<typeof TemplateRegionSchema>;
export type TemplateAnalysis = z.infer<typeof TemplateAnalysisSchema>;
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
  createdAt: string;
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
