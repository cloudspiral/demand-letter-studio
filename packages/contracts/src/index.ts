import { z } from "zod";

export const CitationSchema = z.object({
  sourceId: z.string().uuid(),
  sourceName: z.string(),
  page: z.number().int().positive().nullable(),
  quote: z.string().max(500),
});

export const DraftBlockSchema = z.object({
  id: z.string(),
  kind: z.enum(["heading", "paragraph", "list-item", "table-row", "warning"]),
  text: z.string(),
  templateParagraphIndex: z.number().int().nonnegative().nullable(),
  citations: z.array(CitationSchema),
  verified: z.boolean(),
});

export const DraftSectionSchema = z.object({
  id: z.string(),
  heading: z.string().nullable(),
  blocks: z.array(DraftBlockSchema),
});

export const GeneratedDraftSchema = z.object({
  title: z.string(),
  matterName: z.string(),
  fields: z.record(z.string(), z.object({
    value: z.string(),
    verified: z.boolean(),
    sourceLabel: z.string().nullable(),
  })),
  sections: z.array(DraftSectionSchema),
  warnings: z.array(z.string()),
});

export const TemplateRegionSchema = z.object({
  paragraphIndex: z.number().int().nonnegative(),
  text: z.string(),
  role: z.enum(["preserve", "editable", "heading"]),
  confidence: z.number().min(0).max(1),
  style: z.string().nullable(),
});

export const TemplateAnalysisSchema = z.object({
  filename: z.string(),
  paragraphCount: z.number().int().nonnegative(),
  sectionCount: z.number().int().positive(),
  hasMacros: z.boolean(),
  hasTrackedChanges: z.boolean(),
  hasComplexObjects: z.boolean(),
  warnings: z.array(z.string()),
  regions: z.array(TemplateRegionSchema),
});

export const RefinementProposalSchema = z.object({
  targetText: z.string(),
  replacementText: z.string(),
  summary: z.string(),
  citedSourceIds: z.array(z.string().uuid()),
});

export const JobStatusSchema = z.enum(["queued", "processing", "completed", "failed"]);

export const ExtractedFactSchema = z.object({
  kind: z.enum(["amount", "person", "date"]),
  label: z.string(),
  value: z.string(),
  page: z.number().int().positive(),
  confidence: z.number().min(0).max(1),
});

export type Citation = z.infer<typeof CitationSchema>;
export type DraftBlock = z.infer<typeof DraftBlockSchema>;
export type DraftSection = z.infer<typeof DraftSectionSchema>;
export type GeneratedDraft = z.infer<typeof GeneratedDraftSchema>;
export type TemplateRegion = z.infer<typeof TemplateRegionSchema>;
export type TemplateAnalysis = z.infer<typeof TemplateAnalysisSchema>;
export type RefinementProposal = z.infer<typeof RefinementProposalSchema>;
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
