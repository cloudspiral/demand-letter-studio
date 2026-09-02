import { performance } from "node:perf_hooks";
import fs from "node:fs/promises";
import { EvidenceReviewSchema, GeneratedDraftSchema, ReviewResolutionSchema, TemplateAnalysisSchema, TemplateMapSchema, type EvidenceReview, type GeneratedDraft, type ReviewResolution } from "@steno/contracts";
import { createAiProvider, type AiProvider, type EvidencePage, type EvidenceReviewResult } from "./ai";
import { ACTOR_ID, persistCitations, pool, sourceFingerprintForMatter, WORKSPACE_ID } from "./db";
import { pathForKey } from "./storage";
import { analysisWithConfirmedMap, deriveGenerationTargets, templateBlockId } from "./template-map";

function requiredRow<T>(rows: T[], message: string): T {
  const row = rows[0];
  if (!row) throw new Error(message);
  return row;
}

export function requireWholeContextFits(template: ReturnType<typeof TemplateAnalysisSchema.parse>, evidence: EvidencePage[]): void {
  const limit = Number(process.env.WHOLE_CONTEXT_MAX_CHARS ?? 1_500_000);
  const imageByteLimit = Number(process.env.WHOLE_CONTEXT_MAX_IMAGE_BYTES ?? 20_000_000);
  const characters = (template.blocks?.length ? template.blocks : template.regions)
    .reduce((total, block) => total + block.text.length, 0)
    + evidence.reduce((total, page) => total + page.text.length, 0);
  if (!Number.isFinite(limit) || limit < 1) throw new Error("WHOLE_CONTEXT_MAX_CHARS must be a positive number.");
  if (!Number.isFinite(imageByteLimit) || imageByteLimit < 1) throw new Error("WHOLE_CONTEXT_MAX_IMAGE_BYTES must be a positive number.");
  if (characters > limit) {
    throw new Error(`The complete template and case packet contain ${characters.toLocaleString()} extracted characters, above the ${limit.toLocaleString()} whole-context limit. Remove or split files; no pages were silently dropped.`);
  }
  const imageBytes = evidence.reduce((total, page) => total + Math.floor((page.imageData?.base64.length ?? 0) * 0.75), 0);
  if (imageBytes > imageByteLimit) {
    throw new Error(`The complete visual packet is above the ${imageByteLimit.toLocaleString()} byte multimodal limit. Remove or resize images; no visual pages were silently dropped.`);
  }
}

export async function appendJobEvent(
  jobId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    "INSERT INTO job_events (job_id, event_type, payload) VALUES ($1, $2, $3)",
    [jobId, eventType, JSON.stringify(payload)],
  );
}

async function setJobProgress(jobId: string, progress: number, step: string): Promise<void> {
  await pool.query(
    "UPDATE jobs SET status = 'processing', progress = $2, step = $3, updated_at = now() WHERE id = $1",
    [jobId, progress, step],
  );
  await appendJobEvent(jobId, "progress", { progress, step });
}

async function loadJobContext(jobId: string): Promise<{
  matterId: string;
  matterName: string;
  jobType: "generation" | "evidence_review";
  targetDraftId: string | null;
  baseVersion: number | null;
  sourceFingerprint: string;
  templateMapVersion: number;
  template: ReturnType<typeof TemplateAnalysisSchema.parse>;
  evidence: EvidencePage[];
  evidenceReview: EvidenceReview | null;
  reviewResolutions: ReviewResolution[];
}> {
  const context = await pool.query<{
    matter_id: string;
    matter_name: string;
    job_type: "generation" | "evidence_review";
    draft_id: string | null;
    base_version: number | null;
    source_fingerprint: string | null;
    analysis: unknown;
    confirmed_regions: unknown;
    template_map_version: number | null;
    template_map: unknown;
  }>(`
    SELECT j.matter_id, j.job_type, j.draft_id, j.base_version, j.source_fingerprint,
           m.name AS matter_name, m.template_map_version, t.analysis, t.confirmed_regions,
           tmv.map AS template_map
    FROM jobs j
    JOIN matters m ON m.id = j.matter_id
    JOIN templates t ON t.id = m.template_id
    LEFT JOIN template_map_versions tmv
      ON tmv.template_id = m.template_id AND tmv.map_version = m.template_map_version
    WHERE j.id = $1 AND t.status = 'confirmed'
  `, [jobId]);
  if (!context.rowCount) throw new Error("The case workspace requires a confirmed template map before generation.");

  const row = requiredRow(context.rows, "Generation context was not found.");
  if (!row.template_map_version || !row.template_map) throw new Error("Matter is not pinned to a confirmed template-map version.");
  const template = analysisWithConfirmedMap(
    TemplateAnalysisSchema.parse(row.analysis),
    TemplateMapSchema.parse(row.template_map),
  );
  const pages = await pool.query<{
    source_id: string;
    source_name: string;
    page_number: number;
    extracted_text: string;
    extraction_method: NonNullable<EvidencePage["extractionMethod"]>;
    extraction_status: NonNullable<EvidencePage["extractionStatus"]>;
    extraction_confidence: number | null;
    geometry: unknown[];
    structured_data: unknown;
    visual_input: boolean;
    mime_type: string;
    storage_key: string;
    visual_data: Buffer | null;
    visual_mime_type: string | null;
  }>(`
    SELECT s.id AS source_id, s.name AS source_name, p.page_number, p.extracted_text,
           p.extraction_method, p.extraction_status, p.extraction_confidence,
           p.geometry, p.structured_data, p.visual_input, p.visual_data, p.visual_mime_type,
           s.mime_type, s.storage_key
    FROM source_documents s
    JOIN source_pages p ON p.source_id = s.id
    WHERE s.matter_id = $1 AND s.status = 'ready'
    ORDER BY s.created_at, p.page_number
  `, [row.matter_id]);
  const latestReview = await pool.query<{ result: unknown }>(`
    SELECT result
    FROM jobs
    WHERE matter_id = $1 AND job_type = 'evidence_review' AND status = 'completed'
      AND source_fingerprint = $2 AND result IS NOT NULL
    ORDER BY updated_at DESC
    LIMIT 1
  `, [row.matter_id, row.source_fingerprint ?? await sourceFingerprintForMatter(row.matter_id)]);
  const resolutions = await pool.query<{
    id: string; matter_id: string; target_id: string; source_fingerprint: string; action: "omit";
    actor_id: string; actor_name: string; draft_id: string | null; draft_version: number | null; created_at: Date;
  }>(`
    SELECT r.id, r.matter_id, r.target_id, r.source_fingerprint, r.action, r.actor_id,
           a.display_name AS actor_name, r.draft_id, r.draft_version, r.created_at
    FROM matter_review_resolutions r
    JOIN actors a ON a.id = r.actor_id
    WHERE r.matter_id = $1 AND r.source_fingerprint = $2
    ORDER BY r.created_at
  `, [row.matter_id, row.source_fingerprint ?? await sourceFingerprintForMatter(row.matter_id)]);
  return {
    matterId: row.matter_id,
    matterName: row.matter_name,
    jobType: row.job_type,
    targetDraftId: row.draft_id,
    baseVersion: row.base_version,
    sourceFingerprint: row.source_fingerprint ?? await sourceFingerprintForMatter(row.matter_id),
    templateMapVersion: row.template_map_version,
    template,
    evidence: await Promise.all(pages.rows.map(async (page) => {
      const mediaType = (["image/png", "image/jpeg", "image/webp", "image/gif"] as const)
        .find((candidate) => candidate === (page.visual_mime_type ?? page.mime_type));
      const imageBytes = page.visual_data
        ?? (page.visual_input && page.mime_type.startsWith("image/") ? await fs.readFile(pathForKey(page.storage_key)) : null);
      const imageData = imageBytes && mediaType ? { mediaType, base64: imageBytes.toString("base64") } : undefined;
      return {
        sourceId: page.source_id,
        sourceName: page.source_name,
        mimeType: page.mime_type,
        page: page.page_number,
        text: page.extracted_text,
        extractionMethod: page.extraction_method,
        extractionStatus: page.extraction_status,
        confidence: page.extraction_confidence === null ? null : Number(page.extraction_confidence),
        geometry: page.geometry,
        structuredData: page.structured_data,
        visualInput: page.visual_input,
        ...(imageData ? { imageData } : {}),
      };
    })),
    evidenceReview: latestReview.rows[0] ? EvidenceReviewSchema.parse(latestReview.rows[0].result) : null,
    reviewResolutions: resolutions.rows.map((resolution) => ReviewResolutionSchema.parse({
      id: resolution.id,
      matterId: resolution.matter_id,
      targetId: resolution.target_id,
      sourceFingerprint: resolution.source_fingerprint,
      action: resolution.action,
      actorId: resolution.actor_id,
      actorName: resolution.actor_name,
      draftId: resolution.draft_id,
      draftVersion: resolution.draft_version,
      createdAt: new Date(resolution.created_at).toISOString(),
    })),
  };
}

export function validateGrounding(draft: GeneratedDraft, evidence: EvidencePage[]): GeneratedDraft {
  const normalizedPages = new Map(evidence.map((page) => [
    `${page.sourceId}:${page.page}`,
    page.text.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase(),
  ]));
  const visualPages = new Set(evidence.filter((page) => page.visualInput).map((page) => `${page.sourceId}:${page.page}`));
  const warnings = new Set(draft.warnings);
  const sections = draft.sections.map((section) => ({
    ...section,
    blocks: section.blocks.map((block) => {
      const citations = block.citations.filter((citation) => {
        if (citation.page === null) return false;
        if (citation.evidenceType === "visual") {
          return visualPages.has(`${citation.sourceId}:${citation.page}`) && Boolean(citation.visualDescription?.trim());
        }
        if (!citation.quote.trim()) return false;
        const pageText = normalizedPages.get(`${citation.sourceId}:${citation.page}`);
        const quote = citation.quote.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
        return Boolean(pageText?.includes(quote));
      });
      const supported = block.kind === "warning" || citations.length > 0;
      if (!supported) {
        warnings.add(`Unsupported draft block ${block.id} requires attorney review.`);
      }
      return {
        ...block,
        text: supported ? block.text : "[ATTORNEY REVIEW REQUIRED — this generated block lacks a valid source-page citation.]",
        citations,
        verified: block.kind !== "warning" && supported && block.verified,
        kind: supported ? block.kind : "warning" as const,
      };
    }),
  }));
  return GeneratedDraftSchema.parse({ ...draft, sections, warnings: [...warnings] });
}

export function ensureEditableCoverage(draft: GeneratedDraft, template: ReturnType<typeof TemplateAnalysisSchema.parse>): GeneratedDraft {
  const generatedBlocks = draft.sections.flatMap((section) => section.blocks);
  const completeMap = template.blocks?.length ? template.blocks : template.regions;
  const targets = deriveGenerationTargets(template);
  const figureCaptionIds = new Set(completeMap.flatMap((block) => block.figure?.captionBlockId ? [block.figure.captionBlockId] : []));
  const outcomeByTarget = new Map(draft.outcomes.map((outcome) => [outcome.targetId, outcome]));
  const missingOutcomes = targets.filter((target) => !outcomeByTarget.has(target.id));
  if (missingOutcomes.length) {
    throw new Error(`Validated draft is missing ${missingOutcomes.length} generation target outcome(s).`);
  }
  const blocksByTarget = new Map<string, typeof generatedBlocks>();
  for (const block of generatedBlocks) {
    if (!block.targetId) continue;
    blocksByTarget.set(block.targetId, [...(blocksByTarget.get(block.targetId) ?? []), block]);
  }
  for (const blocks of blocksByTarget.values()) blocks.sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
  const targetByBlockId = new Map(targets.flatMap((target) => target.blockIds.map((blockId) => [blockId, target] as const)));
  const emittedTargets = new Set<string>();
  const fields = { ...draft.fields };
  const missingReplacements = template.replacementCandidates.filter((candidate) => !Object.hasOwn(fields, candidate.fieldKey ?? candidate.value));
  for (const candidate of missingReplacements) {
    const fieldKey = candidate.fieldKey ?? candidate.value;
    fields[fieldKey] = {
      value: "[ATTORNEY REVIEW REQUIRED]",
      label: candidate.label ?? fieldKey,
      templateValue: candidate.value,
      verified: false,
      confidence: null,
      userConfirmed: false,
      sourceId: null,
      page: null,
      sourceLabel: null,
    };
  }
  const renderKeepText = (region: (typeof completeMap)[number]): string => {
    let text = region.text;
    const inlineFields = [...(region.inlineFields ?? [])].filter((field) => field.role === "replace").sort((left, right) => right.start - left.start);
    for (const inlineField of inlineFields) {
      const replacement = fields[inlineField.key]?.value ?? "[ATTORNEY REVIEW REQUIRED]";
      text = `${text.slice(0, inlineField.start)}${replacement}${text.slice(inlineField.end)}`;
    }
    return text;
  };
  const assembledBlocks = completeMap.flatMap<GeneratedDraft["sections"][number]["blocks"][number]>((region) => {
    const blockId = templateBlockId(region);
    if (figureCaptionIds.has(blockId)) return [];
    if (region.role !== "editable") {
      if (region.semanticKind === "figure") return [];
      return [{
        id: `keep-template-${blockId}`,
        kind: region.semanticKind === "heading" ? "heading" as const : region.anchor?.kind === "table-cell" || region.structuredGroup ? "table-row" as const : "paragraph" as const,
        text: renderKeepText(region),
        templateParagraphIndex: region.paragraphIndex,
        templateBlockId: blockId,
        citations: [],
        verified: true,
        userConfirmed: true,
        templateRole: "keep" as const,
        locked: true,
        targetId: null,
        outcomeId: null,
      }];
    }
    const target = targetByBlockId.get(blockId);
    if (!target || emittedTargets.has(target.id)) return [];
    emittedTargets.add(target.id);
    const outcome = outcomeByTarget.get(target.id)!;
    if (outcome.status !== "generated") return [];
    return (blocksByTarget.get(target.id) ?? []).map((block) => ({
      ...block,
      templateRole: "replace" as const,
      locked: false,
    }));
  });
  return GeneratedDraftSchema.parse({
    ...draft,
    fields,
    sections: [{ id: "assembled-document", heading: null, blocks: assembledBlocks }],
    warnings: [
      ...draft.warnings,
      ...(missingReplacements.length ? [`${missingReplacements.length} header/footer values were cleared because no supported replacement was generated.`] : []),
    ],
  });
}

export async function recordAiRun(args: {
  matterId: string | null;
  provider: AiProvider;
  purpose: string;
  status: "completed" | "failed";
  latencyMs: number;
  errorCode?: string;
}): Promise<void> {
  await pool.query(`
    INSERT INTO ai_runs (workspace_id, matter_id, provider, model, purpose, status, latency_ms, error_code)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [
    WORKSPACE_ID,
    args.matterId,
    args.provider.name,
    args.provider.model,
    args.purpose,
    args.status,
    Math.round(args.latencyMs),
    args.errorCode ?? null,
  ]);
}

async function generateWithFallback(context: Awaited<ReturnType<typeof loadJobContext>>): Promise<GeneratedDraft> {
  const names = [process.env.AI_PROVIDER ?? "openai"];
  if (names[0] !== "anthropic" && process.env.ANTHROPIC_API_KEY) names.push("anthropic");
  const failures: string[] = [];
  for (const name of names) {
    const provider = createAiProvider(name);
    const started = performance.now();
    try {
      const result = await provider.generate(context);
      await recordAiRun({ matterId: context.matterId, provider, purpose: "generation", status: "completed", latencyMs: performance.now() - started });
      const proposalFields: GeneratedDraft["fields"] = {};
      for (const proposal of context.evidenceReview?.fieldProposals ?? []) {
        const candidate = context.template.replacementCandidates.find((item) => (item.fieldKey ?? item.value) === proposal.fieldKey);
        if (!candidate) continue;
        proposalFields[proposal.fieldKey] = {
          value: proposal.value,
          label: candidate.label ?? proposal.fieldKey,
          templateValue: candidate.value,
          verified: true,
          confidence: proposal.confidence,
          userConfirmed: false,
          sourceId: proposal.sourceId,
          page: proposal.page,
          sourceLabel: `${proposal.sourceName} p. ${proposal.page}`,
          quote: proposal.quote,
        };
      }
      const grounded = validateGrounding({
        ...result,
        fields: { ...proposalFields, ...result.fields },
        reviewFlags: context.evidenceReview?.reviewFlags ?? result.reviewFlags,
      }, context.evidence);
      return ensureEditableCoverage(grounded, context.template);
    } catch (error) {
      const code = error instanceof Error ? error.name : "ProviderError";
      failures.push(`${provider.name}:${code}`);
      await recordAiRun({
        matterId: context.matterId,
        provider,
        purpose: "generation",
        status: "failed",
        latencyMs: performance.now() - started,
        errorCode: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  throw new Error(failures.length ? `All AI providers failed (${failures.join(", ")}).` : "All AI providers failed.");
}

async function reviewWithFallback(context: Awaited<ReturnType<typeof loadJobContext>>): Promise<EvidenceReviewResult> {
  const names = [process.env.AI_PROVIDER ?? "openai"];
  if (names[0] !== "anthropic" && process.env.ANTHROPIC_API_KEY) names.push("anthropic");
  const failures: string[] = [];
  for (const name of names) {
    const provider = createAiProvider(name);
    const started = performance.now();
    try {
      const result = await provider.review(context);
      await recordAiRun({ matterId: context.matterId, provider, purpose: "evidence_review", status: "completed", latencyMs: performance.now() - started });
      return result;
    } catch (error) {
      const code = error instanceof Error ? error.name : "ProviderError";
      failures.push(`${provider.name}:${code}`);
      await recordAiRun({
        matterId: context.matterId,
        provider,
        purpose: "evidence_review",
        status: "failed",
        latencyMs: performance.now() - started,
        errorCode: code,
      });
    }
  }
  throw new Error(failures.length ? `All AI providers failed (${failures.join(", ")}).` : "All AI providers failed.");
}

async function failJob(jobId: string, jobType: string, error: unknown): Promise<void> {
  const safeMessage = error instanceof Error ? error.message.slice(0, 500) : `${jobType} failed`;
  await pool.query(`
    UPDATE jobs SET status = 'failed', step = $2, error = $3, updated_at = now()
    WHERE id = $1
  `, [jobId, jobType === "evidence_review" ? "Evidence review failed" : "Generation failed", safeMessage]);
  await pool.query(`
    INSERT INTO dead_letter_jobs (job_id, job_type, error_code, payload)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (job_id) DO NOTHING
  `, [jobId, jobType, error instanceof Error ? error.name : "unknown", JSON.stringify({ retryable: true })]);
  await appendJobEvent(jobId, "failed", {
    step: jobType === "evidence_review" ? "Evidence review failed" : "Generation failed",
    error: safeMessage,
  });
}

export function requireCurrentSourceFingerprint(
  expected: string,
  current: string,
  operation: "generation" | "evidence review",
): void {
  if (expected !== current) {
    throw new Error(operation === "generation"
      ? "Source materials changed during generation. Run the evidence review and generation again."
      : "Source materials changed during evidence review. Run the review again.");
  }
}

export async function processGenerationJob(jobId: string): Promise<void> {
  const claimed = await pool.query(`
    UPDATE jobs
    SET status = 'processing', attempts = attempts + 1, progress = 5, step = 'Loading evidence', updated_at = now()
    WHERE id = $1 AND status = 'queued' AND job_type = 'generation'
    RETURNING id
  `, [jobId]);
  if (!claimed.rowCount) return;

  try {
    await appendJobEvent(jobId, "progress", { progress: 5, step: "Loading evidence" });
    const context = await loadJobContext(jobId);
    if (!context.evidence.length) throw new Error("At least one ready source page is required.");
    requireWholeContextFits(context.template, context.evidence);
    await setJobProgress(jobId, 30, "Grounding draft in source pages");
    const draftContent = await generateWithFallback(context);
    await setJobProgress(jobId, 80, "Saving versioned draft");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const currentFingerprint = await sourceFingerprintForMatter(context.matterId, client);
      requireCurrentSourceFingerprint(context.sourceFingerprint, currentFingerprint, "generation");
      let draftId: string;
      let version: number;
      if (context.targetDraftId) {
        const locked = await client.query<{ current_version: number }>(`
          SELECT current_version
          FROM drafts
          WHERE id = $1 AND matter_id = $2
          FOR UPDATE
        `, [context.targetDraftId, context.matterId]);
        if (!locked.rowCount) throw new Error("The draft selected for regeneration no longer exists.");
        const currentVersion = requiredRow(locked.rows, "Draft regeneration lock failed.").current_version;
        if (context.baseVersion === null || currentVersion !== context.baseVersion) {
          throw new Error("Draft changed during regeneration. Start again from the latest version.");
        }
        draftId = context.targetDraftId;
        version = currentVersion + 1;
      } else {
        const draft = await client.query<{ id: string }>(
          "INSERT INTO drafts (matter_id) VALUES ($1) RETURNING id",
          [context.matterId],
        );
        draftId = requiredRow(draft.rows, "Draft insert did not return an id.").id;
        version = 1;
      }
      await client.query(
        "INSERT INTO draft_versions (draft_id, version, content, actor_id, source_fingerprint, template_map_version) VALUES ($1, $2, $3, $4, $5, $6)",
        [draftId, version, JSON.stringify(draftContent), ACTOR_ID, context.sourceFingerprint, context.templateMapVersion],
      );
      await persistCitations(client, draftId, version, draftContent);
      if (context.targetDraftId) {
        await client.query("UPDATE drafts SET current_version = $2, updated_at = now() WHERE id = $1", [draftId, version]);
      }
      await client.query(`
        UPDATE jobs
        SET status = 'completed', progress = 100, step = 'Draft ready', draft_id = $2,
            result = $3, updated_at = now()
        WHERE id = $1
      `, [jobId, draftId, JSON.stringify({ draftId, version, sourceFingerprint: context.sourceFingerprint })]);
      await client.query(`
        INSERT INTO activity_events (workspace_id, matter_id, actor_id, event_type, summary, metadata)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        WORKSPACE_ID,
        context.matterId,
        ACTOR_ID,
        context.targetDraftId ? "draft.regenerated" : "draft.generated",
        context.targetDraftId ? `Regenerated evidence-grounded draft v${version}` : "Generated an evidence-grounded draft",
        JSON.stringify({ jobId, draftId, version, sourceFingerprint: context.sourceFingerprint }),
      ]);
      await client.query("COMMIT");
      await appendJobEvent(jobId, "completed", { progress: 100, step: "Draft ready", draftId, version });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    await failJob(jobId, "generation", error);
  }
}

export async function processEvidenceReviewJob(jobId: string): Promise<void> {
  const claimed = await pool.query(`
    UPDATE jobs
    SET status = 'processing', attempts = attempts + 1, progress = 5,
        step = 'Loading evidence', updated_at = now()
    WHERE id = $1 AND status = 'queued' AND job_type = 'evidence_review'
    RETURNING id
  `, [jobId]);
  if (!claimed.rowCount) return;

  try {
    await appendJobEvent(jobId, "progress", { progress: 5, step: "Loading evidence" });
    const context = await loadJobContext(jobId);
    if (!context.evidence.length) throw new Error("At least one ready source page is required.");
    requireWholeContextFits(context.template, context.evidence);
    await setJobProgress(jobId, 35, "Reviewing source coverage");
    const review = await reviewWithFallback(context);
    await setJobProgress(jobId, 85, "Validating source references");
    const currentFingerprint = await sourceFingerprintForMatter(context.matterId);
    requireCurrentSourceFingerprint(context.sourceFingerprint, currentFingerprint, "evidence review");
    const result = EvidenceReviewSchema.parse({
      sourceFingerprint: context.sourceFingerprint,
      fieldProposals: review.fieldProposals,
      reviewFlags: review.reviewFlags,
      createdAt: new Date().toISOString(),
    });
    await pool.query(`
      UPDATE jobs
      SET status = 'completed', progress = 100, step = 'Evidence review ready', result = $2, updated_at = now()
      WHERE id = $1
    `, [jobId, JSON.stringify(result)]);
    await pool.query(`
      INSERT INTO activity_events (workspace_id, matter_id, actor_id, event_type, summary, metadata)
      VALUES ($1, $2, $3, 'evidence.reviewed', 'Completed an AI-assisted evidence review', $4)
    `, [WORKSPACE_ID, context.matterId, ACTOR_ID, JSON.stringify({
      jobId,
      sourceFingerprint: context.sourceFingerprint,
      flagCount: review.reviewFlags.length,
      fieldProposalCount: review.fieldProposals.length,
    })]);
    await appendJobEvent(jobId, "completed", { progress: 100, step: "Evidence review ready", result });
  } catch (error) {
    await failJob(jobId, "evidence_review", error);
  }
}

export async function processQueuedJob(jobId: string): Promise<void> {
  const job = await pool.query<{ job_type: string }>("SELECT job_type FROM jobs WHERE id = $1", [jobId]);
  const jobType = job.rows[0]?.job_type;
  if (jobType === "generation") return processGenerationJob(jobId);
  if (jobType === "evidence_review") return processEvidenceReviewJob(jobId);
  throw new Error(`Unsupported job type: ${jobType ?? "unknown"}`);
}

export async function resumeQueuedJobs(): Promise<void> {
  const jobs = await pool.query<{ id: string }>(`
    SELECT id FROM jobs
    WHERE status = 'queued' AND job_type IN ('generation', 'evidence_review')
    ORDER BY created_at LIMIT 10
  `);
  await Promise.allSettled(jobs.rows.map((job) => processQueuedJob(job.id)));
}
