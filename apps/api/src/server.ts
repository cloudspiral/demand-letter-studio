import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import AdmZip from "adm-zip";
import { z } from "zod";
import {
  EvidenceReviewSchema,
  GeneratedDraftSchema,
  RefinementAnnotationSchema,
  RefinementProposalSchema,
  TemplateAnalysisSchema,
  TemplateRegionSchema,
  type GeneratedDraft,
} from "@steno/contracts";
import { createAiProvider, type EvidencePage } from "./ai";
import { config } from "./config";
import { ACTOR_ID, migrate, persistCitations, pool, sourceFingerprintForMatter, WORKSPACE_ID } from "./db";
import { analyzeTemplate, exportDocx, extractSource } from "./document-worker";
import { draftExportIssues, isDraftExportReady } from "./draft-export";
import { confirmDraftField, exportableFieldReplacements } from "./draft-fields";
import { appendJobEvent, processEvidenceReviewJob, processGenerationJob, recordAiRun, resumeQueuedJobs } from "./jobs";
import { applyDirectDraftEdits, applyRefinementProposal, confirmDraftBlock, validateProposalTargets } from "./refinement";
import { pathForKey, putFile } from "./storage";
import {
  mergedTemplateProvenance,
  templateAnalysisFilename,
  templateDisplayName,
  testTemplateFromHeader,
} from "./template-metadata";

const CreateMatterSchema = z.object({ name: z.string().min(1).max(200), templateId: z.string().uuid() });
const ConfirmTemplateSchema = z.object({ regions: z.array(TemplateRegionSchema).min(1) });
const SaveDraftSchema = z.object({ version: z.number().int().positive(), content: GeneratedDraftSchema });
const GenerationRequestSchema = z.object({
  draftId: z.string().uuid().optional(),
  baseVersion: z.number().int().positive().optional(),
}).refine((body) => Boolean(body.draftId) === Boolean(body.baseVersion), {
  message: "draftId and baseVersion must be supplied together for regeneration.",
});
const RefineSchema = z.union([
  z.object({
    instruction: z.string().min(1).max(2_000),
    annotations: z.array(RefinementAnnotationSchema).min(1).max(5),
  }),
  z.object({
    instruction: z.string().min(1).max(2_000),
    selectedText: z.string().min(1).max(20_000),
  }).transform((body) => ({
    instruction: body.instruction,
    annotations: [{ blockId: "legacy", quote: body.selectedText, start: 0, end: body.selectedText.length }],
  })),
]);
const ConfirmFieldSchema = z.object({
  version: z.number().int().positive(),
  key: z.string().min(1).max(500),
  value: z.string().trim().min(1).max(2_000).refine((value) => value !== "[ATTORNEY REVIEW REQUIRED]", {
    message: "Replace the placeholder with a reviewed value before confirming this field.",
  }),
});
const ConfirmBlockSchema = z.object({
  version: z.number().int().positive(),
  text: z.string().trim().min(1).max(20_000).refine((value) => !/\[ATTORNEY REVIEW REQUIRED/i.test(value), {
    message: "Replace the attorney-review placeholder before confirming this paragraph.",
  }),
  note: z.string().trim().min(3).max(1_000),
});

const mimeFor = (filename: string): string => {
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".pdf") return "application/pdf";
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(extension)) return extension === ".png" ? "image/png" : "image/jpeg";
  return "application/octet-stream";
};

const safeDownloadName = (value: string): string => value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "demand-letter";

const staticContentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function requiredRow<T>(rows: T[], message: string): T {
  const row = rows[0];
  if (!row) throw new Error(message);
  return row;
}

type TemplateRecord = {
  id: string;
  name: string;
  displayName: string;
  isTest: boolean;
  status: "analyzed" | "confirmed";
  analysis: unknown;
  confirmedRegions: unknown;
  createdAt: Date;
};

async function insertTemplate(buffer: Buffer, filename: string, options: { isTest?: boolean } = {}) {
  const originalName = path.basename(filename);
  if (path.extname(originalName).toLowerCase() !== ".docx") {
    throw new Error("Only reviewed .docx templates are accepted. Legacy .doc, PDF, and macro templates are not supported.");
  }
  const uploadMetadata = {
    name: originalName,
    displayName: templateDisplayName(originalName),
    isTest: options.isTest ?? false,
  };
  const stored = await putFile(buffer, originalName);
  const rawAnalysis = await analyzeTemplate(stored.path);
  const existing = await pool.query<TemplateRecord>(`
    SELECT id, name, display_name AS "displayName", is_test AS "isTest", status, analysis,
           confirmed_regions AS "confirmedRegions", created_at AS "createdAt"
    FROM templates WHERE workspace_id = $1 AND sha256 = $2 ORDER BY created_at DESC LIMIT 1
  `, [WORKSPACE_ID, stored.sha256]);
  if (existing.rowCount) {
    const current = requiredRow(existing.rows, "Existing template lookup failed.");
    const provenance = mergedTemplateProvenance(current, uploadMetadata);
    const currentVersion = TemplateAnalysisSchema.parse(current.analysis).analysisVersion;
    const analysis = currentVersion >= rawAnalysis.analysisVersion
      ? current.analysis
      : { ...rawAnalysis, filename: templateAnalysisFilename(provenance.displayName) };
    if (
      provenance.name === current.name
      && provenance.displayName === current.displayName
      && provenance.isTest === current.isTest
      && analysis === current.analysis
    ) return current;
    const updated = await pool.query<TemplateRecord>(`
      UPDATE templates
      SET name = $2, display_name = $3, is_test = $4, analysis = $5
      WHERE id = $1
      RETURNING id, name, display_name AS "displayName", is_test AS "isTest", status, analysis,
                confirmed_regions AS "confirmedRegions", created_at AS "createdAt"
    `, [current.id, provenance.name, provenance.displayName, provenance.isTest, JSON.stringify(analysis)]);
    return requiredRow(updated.rows, "Template update did not return a record.");
  }
  const analysis = { ...rawAnalysis, filename: templateAnalysisFilename(uploadMetadata.displayName) };
  const result = await pool.query<TemplateRecord>(`
    INSERT INTO templates (workspace_id, name, display_name, is_test, status, storage_key, sha256, analysis)
    VALUES ($1, $2, $3, $4, 'analyzed', $5, $6, $7)
    RETURNING id, name, display_name AS "displayName", is_test AS "isTest", status, analysis,
              confirmed_regions AS "confirmedRegions", created_at AS "createdAt"
  `, [
    WORKSPACE_ID,
    uploadMetadata.name,
    uploadMetadata.displayName,
    uploadMetadata.isTest,
    stored.key,
    stored.sha256,
    JSON.stringify(analysis),
  ]);
  return requiredRow(result.rows, "Template insert did not return a record.");
}

async function insertSource(matterId: string, buffer: Buffer, filename: string, suppliedMime?: string) {
  const mimeType = suppliedMime && suppliedMime !== "application/octet-stream" ? suppliedMime : mimeFor(filename);
  if (mimeType !== "application/pdf" && !mimeType.startsWith("image/")) {
    throw new Error(`${filename}: sources must be PDFs or images.`);
  }
  const stored = await putFile(buffer, filename);
  const document = await pool.query<{ id: string }>(`
    INSERT INTO source_documents (matter_id, name, mime_type, storage_key, sha256, status)
    VALUES ($1, $2, $3, $4, $5, 'processing') RETURNING id
  `, [matterId, filename, mimeType, stored.key, stored.sha256]);
  const sourceId = requiredRow(document.rows, "Source insert did not return an id.").id;
  try {
    const extraction = await extractSource(stored.path, mimeType);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const page of extraction.pages) {
        await client.query(`
          INSERT INTO source_pages (source_id, page_number, extracted_text) VALUES ($1, $2, $3)
        `, [sourceId, page.page, page.text]);
      }
      for (const fact of extraction.facts) {
        await client.query(`
          INSERT INTO facts (matter_id, source_id, page_number, kind, label, value, confidence)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [matterId, sourceId, fact.page, fact.kind, fact.label, fact.value, fact.confidence]);
      }
      await client.query(
        "UPDATE source_documents SET page_count = $2, status = 'ready' WHERE id = $1",
        [sourceId, extraction.pageCount],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    await pool.query("UPDATE source_documents SET status = 'failed' WHERE id = $1", [sourceId]);
    throw error;
  }
  const result = await pool.query(`
    SELECT id, matter_id AS "matterId", name, mime_type AS "mimeType", page_count AS "pageCount", status
    FROM source_documents WHERE id = $1
  `, [sourceId]);
  return result.rows[0];
}

async function loadDraft(draftId: string) {
  const result = await pool.query<{
    id: string;
    matterId: string;
    version: number;
    content: unknown;
    sourceFingerprint: string | null;
    templateAnalysis: unknown;
    createdAt: string;
    updatedAt: string;
  }>(`
    SELECT d.id, d.matter_id AS "matterId", d.current_version AS version,
           dv.content, dv.source_fingerprint AS "sourceFingerprint",
           t.analysis AS "templateAnalysis",
           d.created_at AS "createdAt", d.updated_at AS "updatedAt"
    FROM drafts d
    JOIN draft_versions dv ON dv.draft_id = d.id AND dv.version = d.current_version
    JOIN matters m ON m.id = d.matter_id
    JOIN templates t ON t.id = m.template_id
    WHERE d.id = $1
  `, [draftId]);
  const row = result.rows[0];
  if (!row) return null;
  const content = GeneratedDraftSchema.parse(row.content);
  const currentSourceFingerprint = await sourceFingerprintForMatter(row.matterId);
  const imageSources = await pool.query<{ count: string }>(`
    SELECT count(*)::text AS count
    FROM source_documents
    WHERE matter_id = $1 AND status = 'ready' AND mime_type LIKE 'image/%'
  `, [row.matterId]);
  const template = TemplateAnalysisSchema.parse(row.templateAnalysis);
  const readiness = draftExportIssues(content, {
    draftSourceFingerprint: row.sourceFingerprint,
    currentSourceFingerprint,
    imageCandidates: template.imageCandidates.length,
    imageSources: Number(imageSources.rows[0]?.count ?? 0),
  });
  const { templateAnalysis: _templateAnalysis, ...publicRow } = row;
  return { ...publicRow, content, readiness };
}

async function evidenceForDraft(draftId: string): Promise<EvidencePage[]> {
  const result = await pool.query<{
    source_id: string; source_name: string; page_number: number; extracted_text: string;
  }>(`
    SELECT s.id AS source_id, s.name AS source_name, p.page_number, p.extracted_text
    FROM drafts d
    JOIN source_documents s ON s.matter_id = d.matter_id
    JOIN source_pages p ON p.source_id = s.id
    WHERE d.id = $1 AND s.status = 'ready'
    ORDER BY s.created_at, p.page_number
  `, [draftId]);
  return result.rows.map((row) => ({
    sourceId: row.source_id,
    sourceName: row.source_name,
    page: row.page_number,
    text: row.extracted_text,
  }));
}

export async function buildApp(options: { runMigrations?: boolean } = {}): Promise<FastifyInstance> {
  if (options.runMigrations !== false) await migrate();
  const app = Fastify({ logger: { redact: ["req.headers.authorization", "req.headers.cookie", "req.body"] } });
  await app.register(cors, { origin: config.webOrigin });
  await app.register(multipart, { limits: { fileSize: 30 * 1024 * 1024, files: 10 } });

  app.setErrorHandler((error, _request, reply) => {
    const details = error instanceof Error ? error : new Error("Unknown request error");
    const typed = error as { validation?: unknown; statusCode?: number };
    const statusCode = typed.validation ? 400 : (typed.statusCode && typed.statusCode < 500 ? typed.statusCode : 500);
    reply.status(statusCode).send({ error: statusCode === 500 ? "Request failed" : details.message, detail: details.message });
  });

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/ready", async () => {
    await pool.query("SELECT 1");
    await fs.mkdir(config.storageDir, { recursive: true });
    await fs.access(config.documentWorker);
    return { ok: true, database: "ok", storage: "ok", documentWorker: "ok", aiProvider: config.aiProvider };
  });

  app.get("/api/templates", async () => {
    const result = await pool.query(`
      SELECT DISTINCT ON (sha256) id, name, display_name AS "displayName", is_test AS "isTest", status, analysis,
             confirmed_regions AS "confirmedRegions", created_at AS "createdAt", sha256
      FROM templates WHERE workspace_id = $1 ORDER BY sha256, created_at DESC
    `, [WORKSPACE_ID]);
    return result.rows.sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  });

  app.post("/api/templates", async (request, reply) => {
    let uploaded: { buffer: Buffer; filename: string } | null = null;
    for await (const part of request.parts()) {
      if (part.type === "file") {
        if (uploaded) throw new Error("Upload one DOCX template at a time.");
        uploaded = { buffer: await part.toBuffer(), filename: part.filename };
      }
    }
    if (!uploaded) return reply.status(400).send({ error: "A DOCX file is required." });
    const template = await insertTemplate(uploaded.buffer, uploaded.filename, {
      isTest: testTemplateFromHeader(request.headers["x-steno-test-template"]),
    });
    return reply.status(201).send(template);
  });

  app.post("/api/templates/:id/confirm", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = ConfirmTemplateSchema.parse(request.body);
    const result = await pool.query(`
      UPDATE templates SET status = 'confirmed', confirmed_regions = $2
      WHERE id = $1 AND workspace_id = $3
      RETURNING id, name, display_name AS "displayName", is_test AS "isTest", status, analysis,
                confirmed_regions AS "confirmedRegions", created_at AS "createdAt"
    `, [id, JSON.stringify(body.regions), WORKSPACE_ID]);
    if (!result.rowCount) return reply.status(404).send({ error: "Template not found." });
    return result.rows[0];
  });

  app.post("/api/matters", async (request, reply) => {
    const body = CreateMatterSchema.parse(request.body);
    const confirmed = await pool.query("SELECT 1 FROM templates WHERE id = $1 AND status = 'confirmed'", [body.templateId]);
    if (!confirmed.rowCount) return reply.status(409).send({ error: "Confirm the template regions before creating a matter." });
    const result = await pool.query(`
      INSERT INTO matters (workspace_id, name, template_id) VALUES ($1, $2, $3)
      RETURNING id, name, template_id AS "templateId", created_at AS "createdAt"
    `, [WORKSPACE_ID, body.name, body.templateId]);
    return reply.status(201).send(result.rows[0]);
  });

  app.get("/api/matters/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const matter = await pool.query(`
      SELECT id, name, template_id AS "templateId", created_at AS "createdAt"
      FROM matters WHERE id = $1 AND workspace_id = $2
    `, [id, WORKSPACE_ID]);
    if (!matter.rowCount) return reply.status(404).send({ error: "Matter not found." });
    const sources = await pool.query(`
      SELECT id, matter_id AS "matterId", name, mime_type AS "mimeType", page_count AS "pageCount", status
      FROM source_documents WHERE matter_id = $1 ORDER BY created_at
    `, [id]);
    const sourceFingerprint = await sourceFingerprintForMatter(id);
    const evidenceReview = await pool.query<{ result: unknown; source_fingerprint: string | null }>(`
      SELECT result, source_fingerprint
      FROM jobs
      WHERE matter_id = $1 AND job_type = 'evidence_review' AND status = 'completed' AND result IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT 1
    `, [id]);
    const activeDraft = await pool.query<{ id: string; version: number }>(`
      SELECT id, current_version AS version
      FROM drafts
      WHERE matter_id = $1
      ORDER BY updated_at DESC
      LIMIT 1
    `, [id]);
    const reviewRow = evidenceReview.rows[0];
    const parsedReview = reviewRow ? EvidenceReviewSchema.parse(reviewRow.result) : null;
    return {
      ...matter.rows[0],
      sources: sources.rows,
      sourceFingerprint,
      evidenceReview: parsedReview,
      evidenceReviewStale: parsedReview ? parsedReview.sourceFingerprint !== sourceFingerprint : false,
      activeDraft: activeDraft.rows[0] ?? null,
    };
  });

  app.get("/api/matters/:id/sources", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await pool.query(`
      SELECT id, matter_id AS "matterId", name, mime_type AS "mimeType", page_count AS "pageCount", status
      FROM source_documents WHERE matter_id = $1 ORDER BY created_at
    `, [id]);
    return reply.send(result.rows);
  });

  app.get("/api/sources/:id/pages/:page", async (request, reply) => {
    const params = z.object({ id: z.string().uuid(), page: z.coerce.number().int().positive() }).parse(request.params);
    const result = await pool.query(`
      SELECT s.id AS "sourceId", s.name AS "sourceName", s.mime_type AS "mimeType",
             p.page_number AS page, p.extracted_text AS text
      FROM source_documents s
      JOIN matters m ON m.id = s.matter_id
      JOIN source_pages p ON p.source_id = s.id
      WHERE s.id = $1 AND p.page_number = $2 AND m.workspace_id = $3
    `, [params.id, params.page, WORKSPACE_ID]);
    if (!result.rowCount) return reply.status(404).send({ error: "Source page not found." });
    return result.rows[0];
  });

  app.get("/api/sources/:id/file", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await pool.query<{ name: string; mime_type: string; storage_key: string }>(`
      SELECT s.name, s.mime_type, s.storage_key
      FROM source_documents s JOIN matters m ON m.id = s.matter_id
      WHERE s.id = $1 AND m.workspace_id = $2
    `, [id, WORKSPACE_ID]);
    if (!result.rowCount) return reply.status(404).send({ error: "Source document not found." });
    const source = requiredRow(result.rows, "Source lookup failed.");
    const filename = source.name.replace(/["\r\n]/g, "");
    return reply.header("Content-Type", source.mime_type)
      .header("Content-Disposition", `inline; filename="${filename}"`)
      .send(await fs.readFile(pathForKey(source.storage_key)));
  });

  app.post("/api/matters/:id/sources", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const matter = await pool.query("SELECT 1 FROM matters WHERE id = $1 AND workspace_id = $2", [id, WORKSPACE_ID]);
    if (!matter.rowCount) return reply.status(404).send({ error: "Matter not found." });
    const results = [];
    for await (const part of request.parts()) {
      if (part.type === "file") results.push(await insertSource(id, await part.toBuffer(), part.filename, part.mimetype));
    }
    if (!results.length) return reply.status(400).send({ error: "At least one PDF or image is required." });
    await pool.query(`
      INSERT INTO activity_events (workspace_id, matter_id, actor_id, event_type, summary, metadata)
      VALUES ($1, $2, $3, 'evidence.added', $4, $5)
    `, [
      WORKSPACE_ID,
      id,
      ACTOR_ID,
      `Added ${results.length} evidence ${results.length === 1 ? "file" : "files"}`,
      JSON.stringify({ sourceIds: results.map((source) => (source as { id?: string }).id).filter(Boolean) }),
    ]);
    return reply.status(201).send(results);
  });

  app.post("/api/matters/:id/evidence-reviews", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const eligible = await pool.query(`
      SELECT EXISTS(
        SELECT 1 FROM matters m JOIN templates t ON t.id = m.template_id
        WHERE m.id = $1 AND m.workspace_id = $2 AND t.status = 'confirmed'
      ) AS template_ready,
      EXISTS(SELECT 1 FROM source_documents WHERE matter_id = $1 AND status = 'ready') AS sources_ready
    `, [id, WORKSPACE_ID]);
    if (!eligible.rows[0]?.template_ready || !eligible.rows[0]?.sources_ready) {
      return reply.status(409).send({ error: "A confirmed template and at least one ready source are required." });
    }
    const sourceFingerprint = await sourceFingerprintForMatter(id);
    const result = await pool.query<{ id: string }>(`
      INSERT INTO jobs (matter_id, job_type, source_fingerprint)
      VALUES ($1, 'evidence_review', $2)
      RETURNING id
    `, [id, sourceFingerprint]);
    const jobId = requiredRow(result.rows, "Evidence review job insert did not return an id.").id;
    await appendJobEvent(jobId, "queued", { progress: 0, step: "Queued" });
    setImmediate(() => void processEvidenceReviewJob(jobId));
    return reply.status(202).send({ jobId, jobType: "evidence_review", status: "queued" });
  });

  app.post("/api/matters/:id/generations", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = GenerationRequestSchema.parse(request.body ?? {});
    const eligible = await pool.query(`
      SELECT EXISTS(
        SELECT 1 FROM matters m JOIN templates t ON t.id = m.template_id
        WHERE m.id = $1 AND m.workspace_id = $2 AND t.status = 'confirmed'
      ) AS template_ready,
      EXISTS(SELECT 1 FROM source_documents WHERE matter_id = $1 AND status = 'ready') AS sources_ready
    `, [id, WORKSPACE_ID]);
    if (!eligible.rows[0]?.template_ready || !eligible.rows[0]?.sources_ready) {
      return reply.status(409).send({ error: "A confirmed template and at least one ready source are required." });
    }
    if (body.draftId) {
      const draft = await pool.query<{ current_version: number }>(`
        SELECT current_version FROM drafts WHERE id = $1 AND matter_id = $2
      `, [body.draftId, id]);
      if (!draft.rowCount) return reply.status(404).send({ error: "Draft not found for this matter." });
      if (draft.rows[0]?.current_version !== body.baseVersion) {
        return reply.status(409).send({ error: "Draft changed before regeneration started.", currentVersion: draft.rows[0]?.current_version });
      }
    }
    const sourceFingerprint = await sourceFingerprintForMatter(id);
    let result;
    try {
      result = await pool.query<{ id: string }>(`
        INSERT INTO jobs (matter_id, job_type, draft_id, base_version, source_fingerprint)
        VALUES ($1, 'generation', $2, $3, $4)
        RETURNING id
      `, [id, body.draftId ?? null, body.baseVersion ?? null, sourceFingerprint]);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        return reply.status(409).send({ error: "A generation job is already active for this matter." });
      }
      throw error;
    }
    const jobId = requiredRow(result.rows, "Job insert did not return an id.").id;
    await appendJobEvent(jobId, "queued", { progress: 0, step: "Queued" });
    setImmediate(() => void processGenerationJob(jobId));
    return reply.status(202).send({ jobId, jobType: "generation", status: "queued" });
  });

  app.get("/api/jobs/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await pool.query(`
      SELECT id, matter_id AS "matterId", status, progress, step, draft_id AS "draftId", error,
             job_type AS "jobType", base_version AS "baseVersion", result,
             source_fingerprint AS "sourceFingerprint", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM jobs WHERE id = $1
    `, [id]);
    if (!result.rowCount) return reply.status(404).send({ error: "Job not found." });
    return result.rows[0];
  });

  app.get("/api/jobs/:id/events", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const exists = await pool.query("SELECT status FROM jobs WHERE id = $1", [id]);
    if (!exists.rowCount) return reply.status(404).send({ error: "Job not found." });
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": config.webOrigin,
    });
    let lastId = Number(request.headers["last-event-id"] ?? 0);
    let lastWriteAt = Date.now();
    const sendPending = async () => {
      const events = await pool.query<{ id: string; event_type: string; payload: unknown }>(`
        SELECT id::text, event_type, payload FROM job_events WHERE job_id = $1 AND id > $2 ORDER BY id
      `, [id, lastId]);
      for (const event of events.rows) {
        lastId = Number(event.id);
        reply.raw.write(`id: ${event.id}\nevent: ${event.event_type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
        lastWriteAt = Date.now();
      }
      if (Date.now() - lastWriteAt >= 15_000) {
        reply.raw.write(": keepalive\n\n");
        lastWriteAt = Date.now();
      }
      const status = await pool.query<{ status: string }>("SELECT status FROM jobs WHERE id = $1", [id]);
      return status.rows[0]?.status;
    };
    const timer = setInterval(() => void sendPending().then((status) => {
      if (["completed", "failed"].includes(status ?? "")) {
        clearInterval(timer);
        reply.raw.end();
      }
    }).catch(() => {
      clearInterval(timer);
      reply.raw.end();
    }), 500);
    request.raw.on("close", () => clearInterval(timer));
    await sendPending();
  });

  app.get("/api/drafts/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const draft = await loadDraft(id);
    if (!draft) return reply.status(404).send({ error: "Draft not found." });
    return draft;
  });

  app.put("/api/drafts/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = SaveDraftSchema.parse(request.body);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<{ matter_id: string; current_version: number; content: unknown; source_fingerprint: string | null }>(
        `SELECT d.matter_id, d.current_version, dv.content, dv.source_fingerprint
         FROM drafts d
         JOIN draft_versions dv ON dv.draft_id = d.id AND dv.version = d.current_version
         WHERE d.id = $1 FOR UPDATE OF d`,
        [id],
      );
      if (!locked.rowCount) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ error: "Draft not found." });
      }
      const lockedDraft = requiredRow(locked.rows, "Draft lock failed.");
      if (lockedDraft.current_version !== body.version) {
        await client.query("ROLLBACK");
        return reply.status(409).send({ error: "Draft changed in another session.", currentVersion: lockedDraft.current_version });
      }
      const updated = applyDirectDraftEdits(GeneratedDraftSchema.parse(lockedDraft.content), body.content);
      const nextVersion = body.version + 1;
      await client.query(
        "INSERT INTO draft_versions (draft_id, version, content, actor_id, source_fingerprint) VALUES ($1, $2, $3, $4, $5)",
        [id, nextVersion, JSON.stringify(updated), ACTOR_ID, lockedDraft.source_fingerprint],
      );
      await persistCitations(client, id, nextVersion, updated);
      await client.query("UPDATE drafts SET current_version = $2, updated_at = now() WHERE id = $1", [id, nextVersion]);
      await client.query(`
        INSERT INTO activity_events (workspace_id, matter_id, actor_id, event_type, summary, metadata)
        VALUES ($1, $2, $3, 'draft.saved', 'Saved direct draft edits', $4)
      `, [WORKSPACE_ID, lockedDraft.matter_id, ACTOR_ID, JSON.stringify({ draftId: id, version: nextVersion })]);
      await client.query("COMMIT");
      return await loadDraft(id);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.post("/api/drafts/:id/refinements", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = RefineSchema.parse(request.body);
    const draft = await loadDraft(id);
    if (!draft) return reply.status(404).send({ error: "Draft not found." });
    const content = GeneratedDraftSchema.parse(draft.content);
    const blockById = new Map(content.sections.flatMap((section) => section.blocks).map((block) => [block.id, block]));
    const annotations = body.annotations.map((annotation) => {
      if (annotation.blockId !== "legacy") return annotation;
      const block = content.sections.flatMap((section) => section.blocks).find((candidate) => candidate.text === annotation.quote);
      return block ? { ...annotation, blockId: block.id, end: block.text.length } : annotation;
    });
    const annotationsValid = annotations.every((annotation) => {
      const block = blockById.get(annotation.blockId);
      return block?.text.slice(annotation.start, annotation.end) === annotation.quote;
    });
    if (!annotationsValid) return reply.status(409).send({ error: "Selected text is not part of the current draft version." });
    const wantsStream = request.headers.accept?.includes("text/event-stream") ?? false;
    if (wantsStream) {
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": config.webOrigin,
      });
      reply.raw.write(`event: status\ndata: ${JSON.stringify({ step: "Generating proposal" })}\n\n`);
    }
    const refinementKeepalive = wantsStream
      ? setInterval(() => reply.raw.write(": keepalive\n\n"), 15_000)
      : null;
    if (refinementKeepalive) request.raw.on("close", () => clearInterval(refinementKeepalive));
    const evidence = await evidenceForDraft(id);
    let proposal;
    const primaryProvider = createAiProvider();
    const primaryStarted = performance.now();
    try {
      proposal = RefinementProposalSchema.parse(await primaryProvider.refine({ instruction: body.instruction, annotations, evidence }));
      await recordAiRun({
        matterId: draft.matterId,
        provider: primaryProvider,
        purpose: "refinement",
        status: "completed",
        latencyMs: performance.now() - primaryStarted,
      });
    } catch (primaryError) {
      await recordAiRun({
        matterId: draft.matterId,
        provider: primaryProvider,
        purpose: "refinement",
        status: "failed",
        latencyMs: performance.now() - primaryStarted,
        errorCode: primaryError instanceof Error ? primaryError.name : "unknown",
      });
      try {
        if ((process.env.AI_PROVIDER ?? "openai") === "anthropic" || !process.env.ANTHROPIC_API_KEY) throw primaryError;
        const fallbackProvider = createAiProvider("anthropic");
        const fallbackStarted = performance.now();
        try {
          proposal = RefinementProposalSchema.parse(await fallbackProvider.refine({ instruction: body.instruction, annotations, evidence }));
          await recordAiRun({
            matterId: draft.matterId,
            provider: fallbackProvider,
            purpose: "refinement",
            status: "completed",
            latencyMs: performance.now() - fallbackStarted,
          });
        } catch (fallbackError) {
          await recordAiRun({
            matterId: draft.matterId,
            provider: fallbackProvider,
            purpose: "refinement",
            status: "failed",
            latencyMs: performance.now() - fallbackStarted,
            errorCode: fallbackError instanceof Error ? fallbackError.name : "unknown",
          });
          throw fallbackError;
        }
      } catch (fallbackError) {
        if (wantsStream) {
          if (refinementKeepalive) clearInterval(refinementKeepalive);
          reply.raw.write(`event: failed\ndata: ${JSON.stringify({ error: "Refinement failed" })}\n\n`);
          reply.raw.end();
          return;
        }
        throw fallbackError;
      }
    }
    const allowedSourceIds = new Set(evidence.map((page) => page.sourceId));
    proposal = { ...proposal, citedSourceIds: proposal.citedSourceIds.filter((sourceId) => allowedSourceIds.has(sourceId)) };
    if (refinementKeepalive) clearInterval(refinementKeepalive);
    validateProposalTargets(proposal, annotations);
    const saved = await pool.query(`
      INSERT INTO edit_proposals (draft_id, base_version, status, instruction, proposal, actor_id)
      VALUES ($1, $2, 'pending', $3, $4, $5)
      RETURNING id, draft_id AS "draftId", base_version AS "baseVersion", status, instruction, proposal, created_at AS "createdAt"
    `, [id, draft.version, body.instruction, JSON.stringify(proposal), ACTOR_ID]);
    const savedProposal = requiredRow(saved.rows, "Proposal insert did not return a record.");
    if (wantsStream) {
      reply.raw.write(`event: proposal\ndata: ${JSON.stringify(savedProposal)}\n\n`);
      reply.raw.end();
      return;
    }
    return reply.status(201).send(savedProposal);
  });

  app.post("/api/proposals/:id/accept", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{
        draft_id: string; base_version: number; proposal: unknown; matter_id: string; current_version: number; content: unknown; source_fingerprint: string | null;
      }>(`
        SELECT p.draft_id, p.base_version, p.proposal, d.matter_id, d.current_version, dv.content, dv.source_fingerprint
        FROM edit_proposals p
        JOIN drafts d ON d.id = p.draft_id
        JOIN draft_versions dv ON dv.draft_id = d.id AND dv.version = d.current_version
        WHERE p.id = $1 AND p.status = 'pending'
        FOR UPDATE OF p, d
      `, [id]);
      if (!result.rowCount) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ error: "Pending proposal not found." });
      }
      const row = requiredRow(result.rows, "Proposal lock failed.");
      if (row.base_version !== row.current_version) {
        await client.query("ROLLBACK");
        return reply.status(409).send({ error: "Draft changed after this proposal was created." });
      }
      const proposal = RefinementProposalSchema.parse(row.proposal);
      const content = GeneratedDraftSchema.parse(row.content);
      const updated = applyRefinementProposal(content, proposal);
      const nextVersion = row.current_version + 1;
      await client.query(
        "INSERT INTO draft_versions (draft_id, version, content, actor_id, source_fingerprint) VALUES ($1, $2, $3, $4, $5)",
        [row.draft_id, nextVersion, JSON.stringify(updated), ACTOR_ID, row.source_fingerprint],
      );
      await persistCitations(client, row.draft_id, nextVersion, updated);
      await client.query("UPDATE drafts SET current_version = $2, updated_at = now() WHERE id = $1", [row.draft_id, nextVersion]);
      await client.query("UPDATE edit_proposals SET status = 'accepted', resolved_at = now() WHERE id = $1", [id]);
      await client.query(`
        INSERT INTO activity_events (workspace_id, matter_id, actor_id, event_type, summary, metadata)
        VALUES ($1, $2, $3, 'proposal.accepted', 'Accepted an AI edit proposal', $4)
      `, [WORKSPACE_ID, row.matter_id, ACTOR_ID, JSON.stringify({ proposalId: id, version: nextVersion })]);
      await client.query("COMMIT");
      return reply.send({ proposalId: id, status: "accepted", draft: await loadDraft(row.draft_id) });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.post("/api/drafts/:id/fields/confirm", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = ConfirmFieldSchema.parse(request.body);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ matter_id: string; current_version: number; content: unknown; source_fingerprint: string | null }>(`
        SELECT d.matter_id, d.current_version, dv.content, dv.source_fingerprint
        FROM drafts d JOIN draft_versions dv ON dv.draft_id = d.id AND dv.version = d.current_version
        WHERE d.id = $1 FOR UPDATE OF d
      `, [id]);
      if (!result.rowCount) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ error: "Draft not found." });
      }
      const row = requiredRow(result.rows, "Draft field lock failed.");
      if (row.current_version !== body.version) {
        await client.query("ROLLBACK");
        return reply.status(409).send({ error: "Draft changed in another session.", currentVersion: row.current_version });
      }
      const content = GeneratedDraftSchema.parse(row.content);
      if (!content.fields[body.key]) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ error: "Draft field not found." });
      }
      const { content: updated, corrected } = confirmDraftField(content, body.key, body.value);
      const nextVersion = body.version + 1;
      await client.query(
        "INSERT INTO draft_versions (draft_id, version, content, actor_id, source_fingerprint) VALUES ($1, $2, $3, $4, $5)",
        [id, nextVersion, JSON.stringify(updated), ACTOR_ID, row.source_fingerprint],
      );
      await persistCitations(client, id, nextVersion, updated);
      await client.query("UPDATE drafts SET current_version = $2, updated_at = now() WHERE id = $1", [id, nextVersion]);
      await client.query(`
        INSERT INTO activity_events (workspace_id, matter_id, actor_id, event_type, summary, metadata)
        VALUES ($1, $2, $3, 'field.confirmed', $4, $5)
      `, [WORKSPACE_ID, row.matter_id, ACTOR_ID, corrected ? "Corrected an extracted field" : "Verified an extracted field", JSON.stringify({ draftId: id, version: nextVersion, fieldKey: body.key })]);
      await client.query("COMMIT");
      return await loadDraft(id);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.post("/api/drafts/:id/blocks/:blockId/confirm", async (request, reply) => {
    const params = z.object({ id: z.string().uuid(), blockId: z.string().min(1).max(500) }).parse(request.params);
    const body = ConfirmBlockSchema.parse(request.body);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{
        matter_id: string;
        current_version: number;
        content: unknown;
        source_fingerprint: string | null;
      }>(`
        SELECT d.matter_id, d.current_version, dv.content, dv.source_fingerprint
        FROM drafts d
        JOIN draft_versions dv ON dv.draft_id = d.id AND dv.version = d.current_version
        WHERE d.id = $1
        FOR UPDATE OF d
      `, [params.id]);
      if (!result.rowCount) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ error: "Draft not found." });
      }
      const row = requiredRow(result.rows, "Draft block lock failed.");
      if (row.current_version !== body.version) {
        await client.query("ROLLBACK");
        return reply.status(409).send({ error: "Draft changed in another session.", currentVersion: row.current_version });
      }
      const content = GeneratedDraftSchema.parse(row.content);
      let updated: GeneratedDraft;
      try {
        updated = GeneratedDraftSchema.parse(confirmDraftBlock(content, params.blockId, body.text));
      } catch (error) {
        await client.query("ROLLBACK");
        if (error instanceof Error && error.message === "Draft block not found.") {
          return reply.status(404).send({ error: error.message });
        }
        throw error;
      }
      const nextVersion = body.version + 1;
      await client.query(
        "INSERT INTO draft_versions (draft_id, version, content, actor_id, source_fingerprint) VALUES ($1, $2, $3, $4, $5)",
        [params.id, nextVersion, JSON.stringify(updated), ACTOR_ID, row.source_fingerprint],
      );
      await persistCitations(client, params.id, nextVersion, updated);
      await client.query("UPDATE drafts SET current_version = $2, updated_at = now() WHERE id = $1", [params.id, nextVersion]);
      await client.query(`
        INSERT INTO activity_events (workspace_id, matter_id, actor_id, event_type, summary, metadata)
        VALUES ($1, $2, $3, 'block.confirmed', 'Confirmed an attorney-reviewed draft paragraph', $4)
      `, [WORKSPACE_ID, row.matter_id, ACTOR_ID, JSON.stringify({
        draftId: params.id,
        blockId: params.blockId,
        version: nextVersion,
        note: body.note,
      })]);
      await client.query("COMMIT");
      return await loadDraft(params.id);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.post("/api/proposals/:id/reject", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await pool.query(`
      UPDATE edit_proposals SET status = 'rejected', resolved_at = now()
      WHERE id = $1 AND status = 'pending'
      RETURNING id, draft_id AS "draftId", status
    `, [id]);
    if (!result.rowCount) return reply.status(404).send({ error: "Pending proposal not found." });
    const rejected = requiredRow(result.rows as Array<{ id: string; draftId: string; status: string }>, "Proposal update failed.");
    const matter = await pool.query<{ matter_id: string }>("SELECT matter_id FROM drafts WHERE id = $1", [rejected.draftId]);
    await pool.query(`
      INSERT INTO activity_events (workspace_id, matter_id, actor_id, event_type, summary, metadata)
      VALUES ($1, $2, $3, 'proposal.rejected', 'Rejected an AI edit proposal', $4)
    `, [WORKSPACE_ID, matter.rows[0]?.matter_id ?? null, ACTOR_ID, JSON.stringify({ proposalId: id })]);
    return rejected;
  });

  app.get("/api/drafts/:id/export.docx", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await pool.query<{
      matter_id: string; matter_name: string; storage_key: string; template_analysis: unknown;
      content: unknown; current_version: number; source_fingerprint: string | null;
    }>(`
      SELECT m.id AS matter_id, m.name AS matter_name, t.storage_key,
             t.analysis AS template_analysis, dv.content, dv.source_fingerprint, d.current_version
      FROM drafts d
      JOIN matters m ON m.id = d.matter_id
      JOIN templates t ON t.id = m.template_id
      JOIN draft_versions dv ON dv.draft_id = d.id AND dv.version = d.current_version
      WHERE d.id = $1
    `, [id]);
    if (!result.rowCount) return reply.status(404).send({ error: "Draft not found." });
    const row = requiredRow(result.rows, "Draft export context was not found.");
    const content = GeneratedDraftSchema.parse(row.content);
    const template = TemplateAnalysisSchema.parse(row.template_analysis);
    const imageSources = await pool.query<{ storage_key: string }>(`
      SELECT storage_key FROM source_documents
      WHERE matter_id = $1 AND status = 'ready' AND mime_type LIKE 'image/%'
      ORDER BY created_at
    `, [row.matter_id]);
    const exportIssues = draftExportIssues(content, {
      draftSourceFingerprint: row.source_fingerprint,
      currentSourceFingerprint: await sourceFingerprintForMatter(row.matter_id),
      imageCandidates: template.imageCandidates.length,
      imageSources: imageSources.rowCount ?? 0,
    });
    if (!isDraftExportReady(exportIssues)) {
      return reply.status(409).send({
        error: "Draft is not ready for Word export.",
        detail: `Resolve ${exportIssues.blockIds.length} draft regions, ${exportIssues.fieldKeys.length} template fields, ${exportIssues.duplicateParagraphIndexes.length} duplicate template mappings${exportIssues.imageIssue ? ", the image mapping" : ""}${exportIssues.staleEvidence ? ", and regenerate from the current evidence" : ""} before export.`,
        issues: exportIssues,
      });
    }
    const outputName = `${safeDownloadName(row.matter_name)}-v${row.current_version}-${randomUUID()}.docx`;
    const outputPath = path.join(config.storageDir, "exports", outputName);
    const patches = content.sections.flatMap((section) => section.blocks)
      .filter((block) => block.templateParagraphIndex !== null)
      .map((block) => ({ paragraphIndex: block.templateParagraphIndex as number, text: block.text }));
    const fieldReplacements = exportableFieldReplacements(content.fields);
    const imageReplacements = template.imageCandidates.length === 1 && imageSources.rows[0]
      ? [{
          partName: template.imageCandidates[0]!.partName,
          sourcePath: pathForKey(imageSources.rows[0].storage_key),
        }]
      : [];
    await exportDocx({
      templatePath: pathForKey(row.storage_key),
      outputPath,
      patches,
      fieldReplacements,
      imageReplacements,
    });
    await pool.query(`
      INSERT INTO activity_events (workspace_id, matter_id, actor_id, event_type, summary, metadata)
      SELECT $1, matter_id, $2, 'draft.exported', 'Exported a versioned Word document', $3 FROM drafts WHERE id = $4
    `, [WORKSPACE_ID, ACTOR_ID, JSON.stringify({ draftId: id, version: row.current_version }), id]);
    const buffer = await fs.readFile(outputPath);
    return reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
      .header("Content-Disposition", `attachment; filename="${safeDownloadName(row.matter_name)}-v${row.current_version}.docx"`)
      .send(buffer);
  });

  app.get("/api/matters/:id/activity", async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await pool.query(`
      SELECT e.id, e.event_type AS "eventType", e.summary, e.metadata, e.created_at AS "createdAt",
             a.display_name AS "actorName", a.actor_type AS "actorType"
      FROM activity_events e LEFT JOIN actors a ON a.id = e.actor_id
      WHERE e.matter_id = $1 ORDER BY e.created_at DESC, e.id DESC
    `, [id]);
    return result.rows;
  });

  const demoTemplatePath = path.join(config.demoAssetDir, "AAA Insurance - Time Limited Policy Limits Demand - Pat Donahue.docx");
  const demoZipPath = path.join(config.demoAssetDir, "sample-case-files.zip");
  app.get("/api/demo/status", async () => {
    try {
      await Promise.all([fs.access(demoTemplatePath), fs.access(demoZipPath)]);
      return { available: true };
    } catch {
      return { available: false };
    }
  });

  app.post("/api/demo/bootstrap", async (_request, reply) => {
    const templatePath = demoTemplatePath;
    const zipPath = demoZipPath;
    const templateBuffer = await fs.readFile(templatePath);
    const template = await insertTemplate(templateBuffer, path.basename(templatePath));
    const regions = z.array(TemplateRegionSchema).parse((template.analysis as { regions: unknown }).regions);
    await pool.query("UPDATE templates SET status = 'confirmed', confirmed_regions = $2 WHERE id = $1", [template.id, JSON.stringify(regions)]);
    const matter = await pool.query<{ id: string; name: string; template_id: string }>(`
      INSERT INTO matters (workspace_id, name, template_id)
      VALUES ($1, 'Pat Donahue sample matter', $2) RETURNING id, name, template_id
    `, [WORKSPACE_ID, template.id]);
    const insertedMatter = requiredRow(matter.rows, "Matter insert did not return an id.");
    const zip = new AdmZip(zipPath);
    const sources = [];
    for (const entry of zip.getEntries().filter((item) => !item.isDirectory)) {
      if (!entry.entryName.startsWith("__MACOSX/") && !path.basename(entry.entryName).startsWith(".")) {
        sources.push(await insertSource(insertedMatter.id, entry.getData(), path.basename(entry.entryName), mimeFor(entry.entryName)));
      }
    }
    return reply.status(201).send({ templateId: template.id, matterId: insertedMatter.id, sources });
  });

  if (config.staticDir) {
    const staticRoot = path.resolve(config.staticDir);
    const indexPath = path.join(staticRoot, "index.html");
    app.get("/*", async (request, reply) => {
      const pathname = new URL(request.url, "http://steno.local").pathname;
      if (pathname.startsWith("/api/")) return reply.status(404).send({ error: "API route not found." });

      const relativePath = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
      const candidate = path.resolve(staticRoot, relativePath);
      if (candidate !== staticRoot && !candidate.startsWith(`${staticRoot}${path.sep}`)) {
        return reply.status(400).send({ error: "Invalid static asset path." });
      }

      let target = candidate;
      try {
        if (!(await fs.stat(target)).isFile()) throw new Error("Not a file");
      } catch {
        if (path.extname(relativePath)) return reply.status(404).send({ error: "Static asset not found." });
        target = indexPath;
      }

      const extension = path.extname(target).toLowerCase();
      reply.header("Content-Type", staticContentTypes[extension] ?? "application/octet-stream");
      reply.header("Cache-Control", pathname.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache");
      return reply.send(await fs.readFile(target));
    });
  }

  await resumeQueuedJobs();
  return app;
}
