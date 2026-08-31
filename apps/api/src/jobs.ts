import { performance } from "node:perf_hooks";
import { GeneratedDraftSchema, TemplateAnalysisSchema, type GeneratedDraft } from "@steno/contracts";
import { createAiProvider, type AiProvider, type EvidencePage } from "./ai";
import { ACTOR_ID, persistCitations, pool, WORKSPACE_ID } from "./db";

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
  template: ReturnType<typeof TemplateAnalysisSchema.parse>;
  evidence: EvidencePage[];
}> {
  const context = await pool.query<{
    matter_id: string;
    matter_name: string;
    analysis: unknown;
    confirmed_regions: unknown;
  }>(`
    SELECT j.matter_id, m.name AS matter_name, t.analysis, t.confirmed_regions
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
  const pageKeys = new Set(evidence.map((page) => `${page.sourceId}:${page.page}`));
  const warnings = new Set(draft.warnings);
  const sections = draft.sections.map((section) => ({
    ...section,
    blocks: section.blocks.map((block) => {
      const citations = block.citations.filter((citation) => (
        citation.page !== null && pageKeys.has(`${citation.sourceId}:${citation.page}`)
      ));
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
    fields[candidate.value] = { value: "[ATTORNEY REVIEW REQUIRED]", verified: false, sourceLabel: null };
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

async function recordAiRun(args: {
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

export async function processGenerationJob(jobId: string): Promise<void> {
  const claimed = await pool.query(`
    UPDATE jobs
    SET status = 'processing', attempts = attempts + 1, progress = 5, step = 'Loading evidence', updated_at = now()
    WHERE id = $1 AND status = 'queued'
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
      const draft = await client.query<{ id: string }>(
        "INSERT INTO drafts (matter_id) VALUES ($1) RETURNING id",
        [context.matterId],
      );
      const draftId = requiredRow(draft.rows, "Draft insert did not return an id.").id;
      await client.query(
        "INSERT INTO draft_versions (draft_id, version, content, actor_id) VALUES ($1, 1, $2, $3)",
        [draftId, JSON.stringify(draftContent), ACTOR_ID],
      );
      await persistCitations(client, draftId, 1, draftContent);
      await client.query(`
        UPDATE jobs
        SET status = 'completed', progress = 100, step = 'Draft ready', draft_id = $2, updated_at = now()
        WHERE id = $1
      `, [jobId, draftId]);
      await client.query(`
        INSERT INTO activity_events (workspace_id, matter_id, actor_id, event_type, summary, metadata)
        VALUES ($1, $2, $3, 'draft.generated', 'Generated an evidence-grounded draft', $4)
      `, [WORKSPACE_ID, context.matterId, ACTOR_ID, JSON.stringify({ jobId, draftId })]);
      await client.query("COMMIT");
      await appendJobEvent(jobId, "completed", { progress: 100, step: "Draft ready", draftId });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    const safeMessage = error instanceof Error ? error.message.slice(0, 500) : "Generation failed";
    await pool.query(`
      UPDATE jobs SET status = 'failed', step = 'Generation failed', error = $2, updated_at = now()
      WHERE id = $1
    `, [jobId, safeMessage]);
    await pool.query(`
      INSERT INTO dead_letter_jobs (job_id, job_type, error_code, payload)
      VALUES ($1, 'generation', $2, $3)
      ON CONFLICT (job_id) DO NOTHING
    `, [jobId, error instanceof Error ? error.name : "unknown", JSON.stringify({ retryable: true })]);
    await appendJobEvent(jobId, "failed", { step: "Generation failed", error: safeMessage });
  }
}

export async function resumeQueuedJobs(): Promise<void> {
  const jobs = await pool.query<{ id: string }>("SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 10");
  await Promise.allSettled(jobs.rows.map((job) => processGenerationJob(job.id)));
}
