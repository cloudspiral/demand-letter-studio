import { performance } from "node:perf_hooks";
import { EvidenceReviewSchema, GeneratedDraftSchema, TemplateAnalysisSchema, type GeneratedDraft, type ReviewFlag } from "@steno/contracts";
import { createAiProvider, type AiProvider, type EvidencePage } from "./ai";
import { ACTOR_ID, persistCitations, pool, sourceFingerprintForMatter, WORKSPACE_ID } from "./db";

function requiredRow<T>(rows: T[], message: string): T {
  const row = rows[0];
  if (!row) throw new Error(message);
  return row;
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
  template: ReturnType<typeof TemplateAnalysisSchema.parse>;
  evidence: EvidencePage[];
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
  }>(`
    SELECT j.matter_id, j.job_type, j.draft_id, j.base_version, j.source_fingerprint,
           m.name AS matter_name, t.analysis, t.confirmed_regions
    FROM jobs j
    JOIN matters m ON m.id = j.matter_id
    JOIN templates t ON t.id = m.template_id
    WHERE j.id = $1 AND t.status = 'confirmed'
  `, [jobId]);
  if (!context.rowCount) throw new Error("Matter requires a confirmed template before generation.");

  const row = requiredRow(context.rows, "Generation context was not found.");
  const template = TemplateAnalysisSchema.parse({
    ...(row.analysis as object),
    regions: row.confirmed_regions ?? (row.analysis as { regions?: unknown }).regions,
  });
  const pages = await pool.query<{
    source_id: string;
    source_name: string;
    page_number: number;
    extracted_text: string;
  }>(`
    SELECT s.id AS source_id, s.name AS source_name, p.page_number, p.extracted_text
    FROM source_documents s
    JOIN source_pages p ON p.source_id = s.id
    WHERE s.matter_id = $1 AND s.status = 'ready'
    ORDER BY s.created_at, p.page_number
  `, [row.matter_id]);
  return {
    matterId: row.matter_id,
    matterName: row.matter_name,
    jobType: row.job_type,
    targetDraftId: row.draft_id,
    baseVersion: row.base_version,
    sourceFingerprint: row.source_fingerprint ?? await sourceFingerprintForMatter(row.matter_id),
    template,
    evidence: pages.rows.map((page) => ({
      sourceId: page.source_id,
      sourceName: page.source_name,
      page: page.page_number,
      text: page.extracted_text,
    })),
  };
}

export function validateGrounding(draft: GeneratedDraft, evidence: EvidencePage[]): GeneratedDraft {
  const normalizedPages = new Map(evidence.map((page) => [
    `${page.sourceId}:${page.page}`,
    page.text.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase(),
  ]));
  const warnings = new Set(draft.warnings);
  const sections = draft.sections.map((section) => ({
    ...section,
    blocks: section.blocks.map((block) => {
      const citations = block.citations.filter((citation) => {
        if (citation.page === null || !citation.quote.trim()) return false;
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
  const used = new Set(draft.sections.flatMap((section) => section.blocks)
    .map((block) => block.templateParagraphIndex)
    .filter((index): index is number => index !== null));
  const missing = template.regions.filter((region) => region.role === "editable" && !used.has(region.paragraphIndex));
  const fields = { ...draft.fields };
  const missingReplacements = template.replacementCandidates.filter((candidate) => !Object.hasOwn(fields, candidate.value));
  for (const candidate of missingReplacements) {
    fields[candidate.value] = {
      value: "[ATTORNEY REVIEW REQUIRED]",
      verified: false,
      confidence: null,
      userConfirmed: false,
      sourceId: null,
      page: null,
      sourceLabel: null,
    };
  }
  if (!missing.length && !missingReplacements.length) return draft;
  const coverageSection = {
    id: "attorney-review-required",
    heading: "ATTORNEY REVIEW REQUIRED",
    blocks: missing.map((region) => ({
      id: `unsupported-template-${region.paragraphIndex}`,
      kind: "warning" as const,
      text: "[ATTORNEY REVIEW REQUIRED — no supported replacement was generated for this case-specific template region.]",
      templateParagraphIndex: region.paragraphIndex,
      citations: [],
      verified: false,
    })),
  };
  return GeneratedDraftSchema.parse({
    ...draft,
    fields,
    sections: missing.length ? [...draft.sections, coverageSection] : draft.sections,
    warnings: [
      ...draft.warnings,
      ...(missing.length ? [`${missing.length} case-specific template regions were cleared because no supported replacement was generated.`] : []),
      ...(missingReplacements.length ? [`${missingReplacements.length} header/footer values were cleared because no supported replacement was generated.`] : []),
    ],
  });
}

export async function recordAiRun(args: {
  matterId: string;
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
      return ensureEditableCoverage(validateGrounding(result, context.evidence), context.template);
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

async function reviewWithFallback(context: Awaited<ReturnType<typeof loadJobContext>>): Promise<ReviewFlag[]> {
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
        "INSERT INTO draft_versions (draft_id, version, content, actor_id, source_fingerprint) VALUES ($1, $2, $3, $4, $5)",
        [draftId, version, JSON.stringify(draftContent), ACTOR_ID, context.sourceFingerprint],
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
    await setJobProgress(jobId, 35, "Reviewing source coverage");
    const reviewFlags = await reviewWithFallback(context);
    await setJobProgress(jobId, 85, "Validating source references");
    const currentFingerprint = await sourceFingerprintForMatter(context.matterId);
    requireCurrentSourceFingerprint(context.sourceFingerprint, currentFingerprint, "evidence review");
    const result = EvidenceReviewSchema.parse({
      sourceFingerprint: context.sourceFingerprint,
      reviewFlags,
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
      flagCount: reviewFlags.length,
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
  const jobs = await pool.query<{ id: string }>("SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 10");
  await Promise.allSettled(jobs.rows.map((job) => processQueuedJob(job.id)));
}
