import type { GeneratedDraft, TemplateAnalysis, TemplateRegion } from "@steno/contracts";

export interface TemplateResponse {
  id: string;
  name: string;
  status: "analyzed" | "confirmed";
  analysis: TemplateAnalysis;
  confirmedRegions?: TemplateRegion[];
}

export interface SourceResponse {
  id: string;
  matterId: string;
  name: string;
  mimeType: string;
  pageCount: number;
  status: string;
}

export interface MatterResponse {
  id: string;
  name: string;
  templateId: string;
  sources: SourceResponse[];
}

export interface JobResponse {
  id?: string;
  jobId?: string;
  status: "queued" | "processing" | "completed" | "failed";
  progress?: number;
  step?: string;
  draftId?: string | null;
  error?: string | null;
}

export interface DraftResponse {
  id: string;
  matterId: string;
  version: number;
  content: GeneratedDraft;
  createdAt: string;
  updatedAt: string;
}

export interface ProposalResponse {
  id: string;
  draftId: string;
  baseVersion: number;
  status: "pending" | "accepted" | "rejected";
  instruction: string;
  proposal: { targetText: string; replacementText: string; summary: string; citedSourceIds: string[] };
}

export interface ActivityResponse {
  id: string;
  eventType: string;
  summary: string;
  actorName: string;
  actorType: "human" | "agent";
  createdAt: string;
}

export interface DemoIdentityResponse {
  id: string;
  slug: "faby" | "alex";
  name: string;
  email: string;
  color: string;
  agentId: string;
  agentName: string;
  token: string;
}

export interface CollaborationIdentitiesResponse {
  websocketUrl: string;
  identities: DemoIdentityResponse[];
}
