import type { EvidenceReview, ExportReadiness, GeneratedDraft, GenerationTarget, ReviewResolution, TemplateAnalysis, TemplateMap, TemplateRegion } from "@steno/contracts";

export interface TemplateResponse {
  id: string;
  name: string;
  displayName: string;
  isTest: boolean;
  status: "analyzed" | "confirmed";
  analysis: TemplateAnalysis;
  confirmedRegions?: TemplateRegion[];
  confirmedMap?: TemplateMap;
  currentMapVersion?: number;
  createdAt?: string;
}

export interface SourceResponse {
  id: string;
  matterId: string;
  name: string;
  mimeType: string;
  pageCount: number;
  status: string;
  extractionIssueCount?: number;
}

export interface MatterResponse {
  id: string;
  name: string;
  templateId: string;
  templateMapVersion: number;
  sources: SourceResponse[];
  sourceFingerprint: string;
  evidenceReview: EvidenceReview | null;
  evidenceReviewStale: boolean;
  activeDraft: { id: string; version: number } | null;
  reviewResolutions: ReviewResolution[];
  generationTargets: GenerationTarget[];
}

export interface JobResponse {
  id?: string;
  jobId?: string;
  jobType?: "generation" | "evidence_review" | "template_analysis" | "source_extraction";
  status: "queued" | "processing" | "completed" | "failed";
  progress?: number;
  step?: string;
  draftId?: string | null;
  error?: string | null;
  result?: EvidenceReview | { draftId: string; version: number; sourceFingerprint: string } | null;
}

export interface DraftResponse {
  id: string;
  matterId: string;
  version: number;
  content: GeneratedDraft;
  readiness: ExportReadiness;
  sourceFingerprint: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProposalResponse {
  id: string;
  draftId: string;
  baseVersion: number;
  status: "pending" | "accepted" | "rejected";
  instruction: string;
  proposal: {
    edits: Array<{ blockId: string; targetText: string; replacementText: string; start: number; end: number }>;
    summary: string;
    citedSourceIds: string[];
  };
}

export interface ActivityResponse {
  id: string;
  eventType: string;
  summary: string;
  actorName: string;
  actorType: "human" | "agent";
  createdAt: string;
}
