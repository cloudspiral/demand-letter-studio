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
  GeneratedDraftSchema,
  RefinementAnnotationSchema,
  RefinementProposalSchema,
  TemplateAnalysisSchema,
  TemplateMapSchema,
  TemplateRegionSchema,
} from "@steno/contracts";
import { createAiProvider, type EvidencePage } from "./ai";
import { config } from "./config";
import { ACTOR_ID, migrate, persistCitations, pool, sourceFingerprintForMatter, WORKSPACE_ID } from "./db";
import { analyzeTemplate, extractSource } from "./document-worker";
import { draftExportIssues, isDraftExportReady } from "./draft-export";
import { confirmDraftField } from "./draft-fields";
import { ingestEditedDraftDocument, materializeDraftDocument } from "./draft-document";
import { appendJobEvent, ensureEditableCoverage, processGenerationJob, recordAiRun, resumeQueuedJobs } from "./jobs";
import { normalizeDraftContent } from "./draft-compat";
import { confirmOmission, supplyOmission } from "./draft-omissions";
import {
  allowedOnlyOfficeDownload,
  onlyOfficeEditorConfig,
  onlyOfficeEnabled,
  requestOnlyOfficeForceSave,
  requireScopedAccess,
  verifyOnlyOfficeToken,
} from "./onlyoffice";
import { applyDirectDraftEdits, applyRefinementProposal, validateProposalTargets } from "./refinement";
import { pathForKey, putFile } from "./storage";
import {
  mergedTemplateProvenance,
  templateAnalysisFilename,
  templateDisplayName,
  testTemplateFromHeader,
} from "./template-metadata";
import { analysisWithConfirmedMap, deriveGenerationTargets, templateBlockId, validateConfirmedBlocks } from "./template-map";

const CreateMatterSchema = z.object({ name: z.string().min(1).max(200).optional(), templateId: z.string().uuid() });
const RenameMatterSchema = z.object({ name: z.string().trim().min(1).max(200) });
const ConfirmTemplateSchema = z.object({
  schemaVersion: z.literal(2),
  blocks: z.array(TemplateRegionSchema).min(1),
});
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
    annotations: z.array(RefinementAnnotationSchema).max(5),
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
const ConfirmOutcomeSchema = z.object({ version: z.number().int().positive() });
const SupplyOutcomeSchema = z.object({
  version: z.number().int().positive(),
  values: z.array(z.string().trim().max(20_000)).min(1).max(100),
});
const OnlyOfficeCallbackSchema = z.object({
  status: z.number().int(),
  url: z.string().url().optional(),
  token: z.string().optional(),
}).passthrough();
const RestoreDraftSchema = z.object({
  currentVersion: z.number().int().positive(),
  restoreVersion: z.number().int().positive(),
});

const mimeFor = (filename: string): string => {
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".pdf") return "application/pdf";
  if (extension === ".png") return "image/png";
  if ([".jpg", ".jpeg"].includes(extension)) return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
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

async function startScopedJob(matterId: string, jobType: "template_analysis" | "source_extraction", step: string): Promise<string> {
  const result = await pool.query<{ id: string }>(`
    INSERT INTO jobs (matter_id, job_type, status, progress, step, attempts)
    VALUES ($1, $2, 'processing', 5, $3, 1)
    RETURNING id
  `, [matterId, jobType, step]);
  const jobId = requiredRow(result.rows, `${jobType} job insert did not return an id.`).id;
  await appendJobEvent(jobId, "progress", { progress: 5, step });
  return jobId;
}

async function completeScopedJob(jobId: string, step: string, result: Record<string, unknown>): Promise<void> {
  await pool.query(`
    UPDATE jobs SET status = 'completed', progress = 100, step = $2, result = $3, updated_at = now()
    WHERE id = $1
  `, [jobId, step, JSON.stringify(result)]);
  await appendJobEvent(jobId, "completed", { progress: 100, step, result });
}

async function failScopedJob(jobId: string, step: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message.slice(0, 500) : step;
  await pool.query(`
    UPDATE jobs SET status = 'failed', step = $2, error = $3, updated_at = now()
    WHERE id = $1
  `, [jobId, step, message]);
  await appendJobEvent(jobId, "failed", { step, error: message });
}

type TemplateRecord = {
  id: string;
  name: string;
  displayName: string;
  isTest: boolean;
  status: "analyzed" | "confirmed";
  analysis: unknown;
  confirmedRegions: unknown;
  currentMapVersion: number | null;
  confirmedMap?: unknown;
  storageKey?: string;
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
  const existing = await pool.query<TemplateRecord>(`
    SELECT id, name, display_name AS "displayName", is_test AS "isTest", status, analysis,
           confirmed_regions AS "confirmedRegions", current_map_version AS "currentMapVersion",
           (SELECT map FROM template_map_versions WHERE template_id = templates.id AND map_version = templates.current_map_version) AS "confirmedMap",
           created_at AS "createdAt"
    FROM templates WHERE workspace_id = $1 AND sha256 = $2 ORDER BY created_at DESC LIMIT 1
  `, [WORKSPACE_ID, stored.sha256]);
  if (existing.rowCount) {
    const current = requiredRow(existing.rows, "Existing template lookup failed.");
    const provenance = mergedTemplateProvenance(current, uploadMetadata);
    const currentAnalysis = TemplateAnalysisSchema.parse(current.analysis);
    const analyzedBlocks = currentAnalysis.blocks?.length ? currentAnalysis.blocks : [];
    const parsedMap = TemplateMapSchema.safeParse(current.confirmedMap);
    const analyzedBlockIds = new Set(analyzedBlocks.map((block) => block.id ?? `word/document.xml:p:${block.paragraphIndex}`));
    const confirmedMapIsComplete = current.status === "confirmed"
      && current.currentMapVersion
      && currentAnalysis.analysisVersion >= 5
      && analyzedBlocks.length > 0
      && parsedMap.success
      && parsedMap.data.templateHash === stored.sha256
      && parsedMap.data.blocks.length === analyzedBlocks.length
      && parsedMap.data.blocks.every((block) => analyzedBlockIds.has(block.id ?? `word/document.xml:p:${block.paragraphIndex}`));
    if (confirmedMapIsComplete) {
      return current;
    }
    if (current.status === "analyzed" && currentAnalysis.analysisVersion >= 5 && analyzedBlocks.length) {
      return current;
    }
    const structuralAnalysis = TemplateAnalysisSchema.parse({
      ...await analyzeTemplate(stored.path),
      filename: templateAnalysisFilename(provenance.displayName),
    });
    const provider = createAiProvider();
    const started = performance.now();
    let analysis;
    try {
      analysis = await provider.analyzeTemplate({
        filename: originalName,
        templateHash: stored.sha256,
        structuralAnalysis,
      });
      await recordAiRun({ matterId: null, provider, purpose: "template_analysis", status: "completed", latencyMs: performance.now() - started });
    } catch (error) {
      await recordAiRun({ matterId: null, provider, purpose: "template_analysis", status: "failed", latencyMs: performance.now() - started, errorCode: error instanceof Error ? error.name : "unknown" });
      throw error;
    }
    if (current.status === "confirmed") {
      const replacement = await pool.query<TemplateRecord>(`
        INSERT INTO templates (workspace_id, name, display_name, is_test, status, storage_key, sha256, analysis)
        VALUES ($1, $2, $3, $4, 'analyzed', $5, $6, $7)
        RETURNING id, name, display_name AS "displayName", is_test AS "isTest", status, analysis,
                  confirmed_regions AS "confirmedRegions", current_map_version AS "currentMapVersion", created_at AS "createdAt"
      `, [
        WORKSPACE_ID,
        provenance.name,
        provenance.displayName,
        provenance.isTest,
        stored.key,
        stored.sha256,
        JSON.stringify(analysis),
      ]);
      return requiredRow(replacement.rows, "Replacement template analysis did not return a record.");
    }
    if (
      provenance.name === current.name
      && provenance.displayName === current.displayName
      && provenance.isTest === current.isTest
      && JSON.stringify(analysis) === JSON.stringify(current.analysis)
    ) return current;
    const updated = await pool.query<TemplateRecord>(`
      UPDATE templates
      SET name = $2, display_name = $3, is_test = $4, analysis = $5,
          status = 'analyzed', confirmed_regions = NULL, current_map_version = NULL
      WHERE id = $1
      RETURNING id, name, display_name AS "displayName", is_test AS "isTest", status, analysis,
                confirmed_regions AS "confirmedRegions", current_map_version AS "currentMapVersion", created_at AS "createdAt"
    `, [current.id, provenance.name, provenance.displayName, provenance.isTest, JSON.stringify(analysis)]);
    return requiredRow(updated.rows, "Template update did not return a record.");
  }
  const structuralAnalysis = TemplateAnalysisSchema.parse({
    ...await analyzeTemplate(stored.path),
    filename: templateAnalysisFilename(uploadMetadata.displayName),
  });
  const provider = createAiProvider();
  const started = performance.now();
  let analysis;
  try {
    analysis = await provider.analyzeTemplate({
      filename: originalName,
      templateHash: stored.sha256,
      structuralAnalysis,
    });
    await recordAiRun({ matterId: null, provider, purpose: "template_analysis", status: "completed", latencyMs: performance.now() - started });
  } catch (error) {
    await recordAiRun({ matterId: null, provider, purpose: "template_analysis", status: "failed", latencyMs: performance.now() - started, errorCode: error instanceof Error ? error.name : "unknown" });
    throw error;
  }
  const result = await pool.query<TemplateRecord>(`
    INSERT INTO templates (workspace_id, name, display_name, is_test, status, storage_key, sha256, analysis)
    VALUES ($1, $2, $3, $4, 'analyzed', $5, $6, $7)
    RETURNING id, name, display_name AS "displayName", is_test AS "isTest", status, analysis,
              confirmed_regions AS "confirmedRegions", current_map_version AS "currentMapVersion", created_at AS "createdAt"
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
          INSERT INTO source_pages (
            source_id, page_number, extracted_text, extraction_method, extraction_status,
            extraction_confidence, geometry, structured_data, visual_input, visual_data, visual_mime_type
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [
          sourceId,
          page.page,
          page.text,
          page.extractionMethod,
          page.extractionStatus,
          page.confidence,
          JSON.stringify(page.geometry),
          JSON.stringify(page.structuredData),
          page.visualInput,
          page.visualDataBase64 ? Buffer.from(page.visualDataBase64, "base64") : null,
          page.visualMimeType,
        ]);
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
    SELECT s.id, s.matter_id AS "matterId", s.name, s.mime_type AS "mimeType", s.page_count AS "pageCount", s.status,
           count(*) FILTER (WHERE p.extraction_status IN ('ocr-required', 'ocr-failed'))::int AS "extractionIssueCount"
    FROM source_documents s LEFT JOIN source_pages p ON p.source_id = s.id
    WHERE s.id = $1 GROUP BY s.id
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
    templateMap: unknown;
    createdAt: string;
    updatedAt: string;
  }>(`
    SELECT d.id, d.matter_id AS "matterId", d.current_version AS version,
           dv.content, dv.source_fingerprint AS "sourceFingerprint",
           t.analysis AS "templateAnalysis", tmv.map AS "templateMap",
           d.created_at AS "createdAt", d.updated_at AS "updatedAt"
    FROM drafts d
    JOIN draft_versions dv ON dv.draft_id = d.id AND dv.version = d.current_version
    JOIN matters m ON m.id = d.matter_id
    JOIN templates t ON t.id = m.template_id
    JOIN template_map_versions tmv ON tmv.template_id = t.id AND tmv.map_version = dv.template_map_version
    WHERE d.id = $1
  `, [draftId]);
  const row = result.rows[0];
  if (!row) return null;
  const historicalResolutions = await pool.query<{ target_id: string }>(`
    SELECT target_id FROM matter_review_resolutions
    WHERE matter_id = $1 AND source_fingerprint = $2
  `, [row.matterId, row.sourceFingerprint]);
  const content = normalizeDraftContent(row.content, historicalResolutions.rows.map((resolution) => resolution.target_id));
  const currentSourceFingerprint = await sourceFingerprintForMatter(row.matterId);
  const template = analysisWithConfirmedMap(
    TemplateAnalysisSchema.parse(row.templateAnalysis),
    TemplateMapSchema.parse(row.templateMap),
  );
  const readiness = draftExportIssues(content, {
    draftSourceFingerprint: row.sourceFingerprint,
    currentSourceFingerprint,
  });
  const { templateAnalysis: _templateAnalysis, templateMap: _templateMap, ...publicRow } = row;
  const templateBlocks = template.blocks?.length ? template.blocks : template.regions;
  const targets = deriveGenerationTargets(template).map((target) => {
    const exemplar = templateBlocks.find((block) => target.blockIds.includes(templateBlockId(block)));
    return {
      ...target,
      label: target.section?.trim() || exemplar?.text.trim().slice(0, 100) || "Unlabeled template section",
      exemplarExcerpt: exemplar?.text.trim().slice(0, 180) ?? "",
    };
  });
  return { ...publicRow, content, readiness, targets };
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
  // A new-template intake may contain one DOCX plus the full ten-file case packet.
  await app.register(multipart, { limits: { fileSize: 30 * 1024 * 1024, files: 11 } });

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
             confirmed_regions AS "confirmedRegions", current_map_version AS "currentMapVersion",
             (SELECT map FROM template_map_versions WHERE template_id = templates.id AND map_version = templates.current_map_version) AS "confirmedMap",
             created_at AS "createdAt", sha256
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
    const parsedBody = ConfirmTemplateSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.status(400).send({ error: "A complete schema-v2 template map is required." });
    }
    const body = parsedBody.data;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const source = await client.query<{ analysis: unknown; sha256: string; current_map_version: number | null }>(`
        SELECT analysis, sha256, current_map_version
        FROM templates
        WHERE id = $1 AND workspace_id = $2
        FOR UPDATE
      `, [id, WORKSPACE_ID]);
      if (!source.rowCount) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ error: "Template not found." });
      }
      const template = requiredRow(source.rows, "Template confirmation lookup failed.");
      const analysis = TemplateAnalysisSchema.parse(template.analysis);
      const blocks = validateConfirmedBlocks(analysis, body.blocks);
      const mapVersion = (template.current_map_version ?? 0) + 1;
      const confirmedMap = TemplateMapSchema.parse({
        schemaVersion: 2,
        mapVersion,
        templateHash: template.sha256,
        analysisVersion: analysis.analysisVersion,
        blocks,
        confirmedBy: ACTOR_ID,
        confirmedAt: new Date().toISOString(),
      });
      await client.query(`
        INSERT INTO template_map_versions (template_id, map_version, analysis_version, template_hash, map, actor_id)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [id, mapVersion, analysis.analysisVersion, template.sha256, JSON.stringify(confirmedMap), ACTOR_ID]);
      const bodyBlocks = blocks.filter((block) => (block.anchor?.partName ?? "word/document.xml") === "word/document.xml");
      const result = await client.query(`
        UPDATE templates
        SET status = 'confirmed', confirmed_regions = $2, current_map_version = $3
        WHERE id = $1
        RETURNING id, name, display_name AS "displayName", is_test AS "isTest", status, analysis,
                  confirmed_regions AS "confirmedRegions", current_map_version AS "currentMapVersion", created_at AS "createdAt"
      `, [id, JSON.stringify(bodyBlocks), mapVersion]);
      await client.query("COMMIT");
      return { ...result.rows[0], confirmedMap };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.get("/api/templates/:id/maps", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await pool.query(`
      SELECT map_version AS "mapVersion", analysis_version AS "analysisVersion", template_hash AS "templateHash",
             map, actor_id AS "actorId", created_at AS "createdAt"
      FROM template_map_versions
      WHERE template_id = $1
      ORDER BY map_version DESC
    `, [id]);
    return reply.send(result.rows);
  });

  app.post("/api/intakes", async (request, reply) => {
    let templateId: string | null = null;
    let templateUpload: { buffer: Buffer; filename: string } | null = null;
    const sourceUploads: Array<{ buffer: Buffer; filename: string; mimeType: string }> = [];
    for await (const part of request.parts()) {
      if (part.type === "field") {
        if (part.fieldname === "templateId") templateId = z.string().uuid().parse(part.value);
        continue;
      }
      const uploaded = { buffer: await part.toBuffer(), filename: part.filename, mimeType: part.mimetype };
      if (part.fieldname === "template") {
        if (templateUpload) throw new Error("Upload one DOCX template at a time.");
        templateUpload = uploaded;
      } else {
        sourceUploads.push(uploaded);
      }
    }
    if (Boolean(templateId) === Boolean(templateUpload)) {
      return reply.status(400).send({ error: "Select one existing template or upload one DOCX template." });
    }
    if (!sourceUploads.length) return reply.status(400).send({ error: "At least one PDF or image is required." });

    const workspace = await pool.query<{ id: string }>(`
      INSERT INTO matters (workspace_id, name, template_id, template_map_version)
      VALUES ($1, $2, NULL, NULL)
      RETURNING id
    `, [WORKSPACE_ID, "New matter"]);
    const caseWorkspaceId = requiredRow(workspace.rows, "Case workspace insert did not return an id.").id;

    const sourceExtractionJobId = await startScopedJob(caseWorkspaceId, "source_extraction", "Extracting complete source packet");
    const templateAnalysisJobId = templateUpload
      ? await startScopedJob(caseWorkspaceId, "template_analysis", "Analyzing complete parsed template")
      : null;

    const templateOperation = templateUpload
      ? insertTemplate(templateUpload.buffer, templateUpload.filename, {
          isTest: testTemplateFromHeader(request.headers["x-steno-test-template"]),
        })
      : pool.query<TemplateRecord>(`
          SELECT id, name, display_name AS "displayName", is_test AS "isTest", status, analysis,
                 confirmed_regions AS "confirmedRegions", current_map_version AS "currentMapVersion",
                 (SELECT map FROM template_map_versions WHERE template_id = templates.id AND map_version = templates.current_map_version) AS "confirmedMap",
                 storage_key AS "storageKey",
                 created_at AS "createdAt"
          FROM templates WHERE id = $1 AND workspace_id = $2
        `, [templateId, WORKSPACE_ID]).then(async (result) => {
          const existingTemplate = requiredRow(result.rows, "Template not found.");
          if (!existingTemplate.storageKey) throw new Error("Stored template original is unavailable.");
          return insertTemplate(
            await fs.readFile(pathForKey(existingTemplate.storageKey)),
            existingTemplate.name,
            { isTest: existingTemplate.isTest },
          );
        });

    const templateTask = templateOperation.then(async (template) => {
      if (templateAnalysisJobId) await completeScopedJob(templateAnalysisJobId, "Template analysis ready", { templateId: template.id });
      return template;
    }).catch(async (error) => {
      if (templateAnalysisJobId) await failScopedJob(templateAnalysisJobId, "Template analysis failed", error);
      throw error;
    });
    const sourceTask = Promise.all(sourceUploads.map((source) => insertSource(caseWorkspaceId, source.buffer, source.filename, source.mimeType)))
      .then(async (sources) => {
        await completeScopedJob(sourceExtractionJobId, "Source extraction ready", { sourceIds: sources.map((source) => (source as { id?: string }).id).filter(Boolean) });
        return sources;
      }).catch(async (error) => {
        await failScopedJob(sourceExtractionJobId, "Source extraction failed", error);
        throw error;
      });

    const [template, sources] = await Promise.all([
      templateTask,
      sourceTask,
    ]);
    await pool.query(`
      UPDATE matters
      SET template_id = $2, template_map_version = $3
      WHERE id = $1
    `, [caseWorkspaceId, template.id, template.currentMapVersion ?? null]);
    return reply.status(201).send({
      caseWorkspace: {
        id: caseWorkspaceId,
        name: "New matter",
        templateId: template.id,
        templateMapVersion: template.currentMapVersion ?? null,
      },
      template,
      sources,
      jobs: {
        templateAnalysisJobId,
        sourceExtractionJobId,
      },
    });
  });

  app.post("/api/matters/:id/template-map", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await pool.query(`
      UPDATE matters m
      SET template_map_version = t.current_map_version
      FROM templates t
      WHERE m.id = $1 AND m.workspace_id = $2 AND t.id = m.template_id
        AND t.status = 'confirmed' AND t.current_map_version IS NOT NULL
      RETURNING m.id, m.template_id AS "templateId", m.template_map_version AS "templateMapVersion"
    `, [id, WORKSPACE_ID]);
    if (!result.rowCount) return reply.status(409).send({ error: "Confirm the template map before continuing." });
    return reply.send(result.rows[0]);
  });

  app.post("/api/matters", async (request, reply) => {
    const body = CreateMatterSchema.parse(request.body);
    const confirmed = await pool.query<{ current_map_version: number | null }>("SELECT current_map_version FROM templates WHERE id = $1 AND status = 'confirmed'", [body.templateId]);
    if (!confirmed.rowCount) return reply.status(409).send({ error: "Confirm the template map before creating a case workspace." });
    const mapVersion = confirmed.rows[0]?.current_map_version;
    if (!mapVersion) return reply.status(409).send({ error: "Confirm the versioned template map before creating a case workspace." });
    const result = await pool.query(`
      INSERT INTO matters (workspace_id, name, template_id, template_map_version) VALUES ($1, $2, $3, $4)
      RETURNING id, name, template_id AS "templateId", template_map_version AS "templateMapVersion", created_at AS "createdAt"
    `, [WORKSPACE_ID, "New matter", body.templateId, mapVersion]);
    return reply.status(201).send(result.rows[0]);
  });

  app.patch("/api/matters/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = RenameMatterSchema.parse(request.body);
    const result = await pool.query(`
      UPDATE matters
      SET name = $3, name_manually_edited = true, updated_at = now()
      WHERE id = $1 AND workspace_id = $2
      RETURNING id, name, template_id AS "templateId", template_map_version AS "templateMapVersion", created_at AS "createdAt"
    `, [id, WORKSPACE_ID, body.name]);
    if (!result.rowCount) return reply.status(404).send({ error: "Case workspace not found." });
    await pool.query(`
      INSERT INTO activity_events (workspace_id, matter_id, actor_id, event_type, summary, metadata)
      VALUES ($1, $2, $3, 'matter.renamed', 'Renamed the matter', $4)
    `, [WORKSPACE_ID, id, ACTOR_ID, JSON.stringify({ name: body.name })]);
    return reply.send(result.rows[0]);
  });

  app.get("/api/matters/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const matter = await pool.query(`
      SELECT id, name, template_id AS "templateId", template_map_version AS "templateMapVersion", created_at AS "createdAt"
      FROM matters WHERE id = $1 AND workspace_id = $2
    `, [id, WORKSPACE_ID]);
    if (!matter.rowCount) return reply.status(404).send({ error: "Case workspace not found." });
    const sources = await pool.query(`
      SELECT s.id, s.matter_id AS "matterId", s.name, s.mime_type AS "mimeType", s.page_count AS "pageCount", s.status,
             count(*) FILTER (WHERE p.extraction_status IN ('ocr-required', 'ocr-failed'))::int AS "extractionIssueCount"
      FROM source_documents s LEFT JOIN source_pages p ON p.source_id = s.id
      WHERE s.matter_id = $1 GROUP BY s.id ORDER BY s.created_at
    `, [id]);
    const sourceFingerprint = await sourceFingerprintForMatter(id);
    const activeDraft = await pool.query<{ id: string; version: number }>(`
      SELECT id, current_version AS version
      FROM drafts
      WHERE matter_id = $1
      ORDER BY updated_at DESC
      LIMIT 1
    `, [id]);
    const map = await pool.query<{ analysis: unknown; map: unknown }>(`
      SELECT t.analysis, tmv.map
      FROM matters m
      JOIN templates t ON t.id = m.template_id
      JOIN template_map_versions tmv ON tmv.template_id = t.id AND tmv.map_version = m.template_map_version
      WHERE m.id = $1
    `, [id]);
    const mappedTemplate = map.rows[0]
      ? analysisWithConfirmedMap(TemplateAnalysisSchema.parse(map.rows[0].analysis), TemplateMapSchema.parse(map.rows[0].map))
      : null;
    return {
      ...matter.rows[0],
      sources: sources.rows,
      sourceFingerprint,
      activeDraft: activeDraft.rows[0] ?? null,
      generationTargets: mappedTemplate ? deriveGenerationTargets(mappedTemplate) : [],
    };
  });

  app.get("/api/matters/:id/sources", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await pool.query(`
      SELECT s.id, s.matter_id AS "matterId", s.name, s.mime_type AS "mimeType", s.page_count AS "pageCount", s.status,
             count(*) FILTER (WHERE p.extraction_status IN ('ocr-required', 'ocr-failed'))::int AS "extractionIssueCount"
      FROM source_documents s LEFT JOIN source_pages p ON p.source_id = s.id
      WHERE s.matter_id = $1 GROUP BY s.id ORDER BY s.created_at
    `, [id]);
    return reply.send(result.rows);
  });

  app.get("/api/sources/:id/pages/:page", async (request, reply) => {
    const params = z.object({ id: z.string().uuid(), page: z.coerce.number().int().positive() }).parse(request.params);
    const result = await pool.query(`
      SELECT s.id AS "sourceId", s.name AS "sourceName", s.mime_type AS "mimeType",
             p.page_number AS page, p.extracted_text AS text,
             p.extraction_method AS "extractionMethod", p.extraction_status AS "extractionStatus",
             p.extraction_confidence AS confidence, p.geometry, p.structured_data AS "structuredData",
             p.visual_input AS "visualInput"
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
    if (!matter.rowCount) return reply.status(404).send({ error: "Case workspace not found." });
    const uploads: Array<{ buffer: Buffer; filename: string; mimeType: string }> = [];
    for await (const part of request.parts()) {
      if (part.type === "file") uploads.push({ buffer: await part.toBuffer(), filename: part.filename, mimeType: part.mimetype });
    }
    if (!uploads.length) return reply.status(400).send({ error: "At least one PDF or image is required." });
    const extractionJobId = await startScopedJob(id, "source_extraction", "Extracting updated source packet");
    let results: Array<Awaited<ReturnType<typeof insertSource>>>;
    try {
      results = await Promise.all(uploads.map((source) => insertSource(id, source.buffer, source.filename, source.mimeType)));
      await completeScopedJob(extractionJobId, "Source extraction ready", { sourceIds: results.map((source) => (source as { id?: string }).id).filter(Boolean) });
    } catch (error) {
      await failScopedJob(extractionJobId, "Source extraction failed", error);
      throw error;
    }
    await pool.query(`
      INSERT INTO activity_events (workspace_id, matter_id, actor_id, event_type, summary, metadata)
      VALUES ($1, $2, $3, 'evidence.added', $4, $5)
    `, [
      WORKSPACE_ID,
      id,
      ACTOR_ID,
      `Added ${results.length} evidence ${results.length === 1 ? "file" : "files"}`,
      JSON.stringify({ sourceIds: results.map((source) => (source as { id?: string }).id).filter(Boolean), extractionJobId }),
    ]);
    return reply.status(201).send(results);
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
      if (!draft.rowCount) return reply.status(404).send({ error: "Draft not found for this case workspace." });
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
        return reply.status(409).send({ error: "A generation job is already active for this case workspace." });
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

  app.get("/api/drafts/:id/versions", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await pool.query(`
      SELECT dv.version, COALESCE(a.display_name, 'System') AS actor,
             dv.created_at AS timestamp, dv.change_summary AS "changeSummary",
             (dv.version = d.current_version) AS current
      FROM draft_versions dv
      JOIN drafts d ON d.id = dv.draft_id
      LEFT JOIN actors a ON a.id = dv.actor_id
      WHERE dv.draft_id = $1
      ORDER BY dv.version DESC
    `, [id]);
    if (!result.rowCount) {
      const draft = await pool.query("SELECT 1 FROM drafts WHERE id = $1", [id]);
      if (!draft.rowCount) return reply.status(404).send({ error: "Draft not found." });
    }
    return reply.send(result.rows);
  });

  app.post("/api/drafts/:id/restore", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = RestoreDraftSchema.parse(request.body);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const draftResult = await client.query<{ matter_id: string; current_version: number }>(`
        SELECT matter_id, current_version FROM drafts WHERE id = $1 FOR UPDATE
      `, [id]);
      if (!draftResult.rowCount) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ error: "Draft not found." });
      }
      const current = requiredRow(draftResult.rows, "Draft restore lock failed.");
      if (current.current_version !== body.currentVersion) {
        await client.query("ROLLBACK");
        return reply.status(409).send({ error: "Draft changed in another session.", currentVersion: current.current_version });
      }
      const selectedResult = await client.query<{ content: unknown; source_fingerprint: string | null; template_map_version: number | null }>(`
        SELECT content, source_fingerprint, template_map_version
        FROM draft_versions WHERE draft_id = $1 AND version = $2
      `, [id, body.restoreVersion]);
      if (!selectedResult.rowCount) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ error: "Draft version not found." });
      }
      const selected = requiredRow(selectedResult.rows, "Draft restore version lookup failed.");
      const historicalResolutions = await client.query<{ target_id: string }>(`
        SELECT target_id FROM matter_review_resolutions
        WHERE matter_id = $1 AND source_fingerprint = $2
      `, [current.matter_id, selected.source_fingerprint]);
      const restored = normalizeDraftContent(selected.content, historicalResolutions.rows.map((resolution) => resolution.target_id));
      const nextVersion = current.current_version + 1;
      const changeSummary = `Restored draft version ${body.restoreVersion}`;
      await client.query(`
        INSERT INTO draft_versions (draft_id, version, content, actor_id, source_fingerprint, template_map_version, change_summary)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [id, nextVersion, JSON.stringify(restored), ACTOR_ID, selected.source_fingerprint, selected.template_map_version, changeSummary]);
      await persistCitations(client, id, nextVersion, restored);
      await client.query("UPDATE drafts SET current_version = $2, updated_at = now() WHERE id = $1", [id, nextVersion]);
      await client.query(`
        INSERT INTO activity_events (workspace_id, matter_id, actor_id, event_type, summary, metadata)
        VALUES ($1, $2, $3, 'draft.restored', $4, $5)
      `, [WORKSPACE_ID, current.matter_id, ACTOR_ID, changeSummary, JSON.stringify({ draftId: id, version: nextVersion, restoreVersion: body.restoreVersion })]);
      await client.query("COMMIT");
      return await loadDraft(id);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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
      const currentContent = normalizeDraftContent(lockedDraft.content);
      const updated = applyDirectDraftEdits(currentContent, body.content);
      const editedCount = currentContent.sections.flatMap((section) => section.blocks)
        .filter((block) => updated.sections.flatMap((section) => section.blocks).find((candidate) => candidate.id === block.id)?.text !== block.text).length;
      const nextVersion = body.version + 1;
      await client.query(
        `INSERT INTO draft_versions (draft_id, version, content, actor_id, source_fingerprint, template_map_version, change_summary)
         SELECT $1, $2, $3, $4, $5, template_map_version, $7
         FROM draft_versions WHERE draft_id = $1 AND version = $6`,
        [id, nextVersion, JSON.stringify(updated), ACTOR_ID, lockedDraft.source_fingerprint, body.version, `Edited ${editedCount} draft ${editedCount === 1 ? "paragraph" : "paragraphs"}`],
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
    const content = normalizeDraftContent(draft.content);
    const blockById = new Map(content.sections.flatMap((section) => section.blocks).map((block) => [block.id, block]));
    const requestedAnnotations = body.annotations.map((annotation) => {
      if (annotation.blockId !== "legacy") return annotation;
      const block = content.sections.flatMap((section) => section.blocks).find((candidate) => candidate.text === annotation.quote);
      return block ? { ...annotation, blockId: block.id, end: block.text.length } : annotation;
    });
    const annotationsValid = requestedAnnotations.every((annotation) => {
      const block = blockById.get(annotation.blockId);
      return block?.text.slice(annotation.start, annotation.end) === annotation.quote;
    });
    if (!annotationsValid) return reply.status(409).send({ error: "Selected text is not part of the current draft version." });
    const annotations = requestedAnnotations.length
      ? requestedAnnotations
      : content.sections.flatMap((section) => section.blocks)
        .filter((block) => block.text.trim())
        .map((block) => ({ blockId: block.id, quote: block.text, start: 0, end: block.text.length }));
    if (!annotations.length) return reply.status(409).send({ error: "This draft does not contain any editable text to refine." });
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
      proposal = RefinementProposalSchema.parse(await primaryProvider.refine({ instruction: body.instruction, annotations, evidence, currentDraftVersion: draft.version }));
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
    try {
      validateProposalTargets(proposal, annotations);
    } catch (error) {
      const message = error instanceof Error && /did not make a change/i.test(error.message)
        ? "The AI did not produce a real change. Try describing the wording you want more explicitly."
        : "The AI response did not match the current draft. Please try the refinement again.";
      if (wantsStream) {
        reply.raw.write(`event: failed\ndata: ${JSON.stringify({ error: message })}\n\n`);
        reply.raw.end();
        return;
      }
      return reply.status(422).send({ error: message });
    }
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
      const content = normalizeDraftContent(row.content);
      const updated = applyRefinementProposal(content, proposal);
      const nextVersion = row.current_version + 1;
      await client.query(
        `INSERT INTO draft_versions (draft_id, version, content, actor_id, source_fingerprint, template_map_version, change_summary)
         SELECT $1, $2, $3, $4, $5, template_map_version, $7
         FROM draft_versions WHERE draft_id = $1 AND version = $6`,
        [row.draft_id, nextVersion, JSON.stringify(updated), ACTOR_ID, row.source_fingerprint, row.current_version, `Accepted AI refinement: ${proposal.summary.slice(0, 300)}`],
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
      const result = await client.query<{
        matter_id: string; current_version: number; content: unknown; source_fingerprint: string | null;
        template_analysis: unknown; template_map: unknown;
      }>(`
        SELECT d.matter_id, d.current_version, dv.content, dv.source_fingerprint,
               t.analysis AS template_analysis, tmv.map AS template_map
        FROM drafts d
        JOIN draft_versions dv ON dv.draft_id = d.id AND dv.version = d.current_version
        JOIN matters m ON m.id = d.matter_id
        JOIN templates t ON t.id = m.template_id
        JOIN template_map_versions tmv ON tmv.template_id = t.id AND tmv.map_version = dv.template_map_version
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
      const content = normalizeDraftContent(row.content);
      if (!content.fields[body.key]) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ error: "Draft field not found." });
      }
      const { content: confirmed, corrected } = confirmDraftField(content, body.key, body.value);
      const templateMap = TemplateMapSchema.parse(row.template_map);
      const template = TemplateAnalysisSchema.parse({
        ...TemplateAnalysisSchema.parse(row.template_analysis),
        blocks: templateMap.blocks,
        regions: templateMap.blocks.filter((block) => (block.anchor?.partName ?? "word/document.xml") === "word/document.xml"),
      });
      const updated = ensureEditableCoverage(confirmed, template);
      const nextVersion = body.version + 1;
      await client.query(
        `INSERT INTO draft_versions (draft_id, version, content, actor_id, source_fingerprint, template_map_version, change_summary)
         SELECT $1, $2, $3, $4, $5, template_map_version, $7
         FROM draft_versions WHERE draft_id = $1 AND version = $6`,
        [id, nextVersion, JSON.stringify(updated), ACTOR_ID, row.source_fingerprint, body.version, `${corrected ? "Corrected" : "Supplied"} ${content.fields[body.key]?.label ?? body.key}`],
      );
      await persistCitations(client, id, nextVersion, updated);
      await client.query("UPDATE drafts SET current_version = $2, updated_at = now() WHERE id = $1", [id, nextVersion]);
      await client.query(`
        INSERT INTO activity_events (workspace_id, matter_id, actor_id, event_type, summary, metadata)
        VALUES ($1, $2, $3, 'field.supplied', $4, $5)
      `, [WORKSPACE_ID, row.matter_id, ACTOR_ID, corrected ? "Corrected a draft field" : "Supplied a missing draft field", JSON.stringify({ draftId: id, version: nextVersion, fieldKey: body.key })]);
      await client.query("COMMIT");
      return await loadDraft(id);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.post("/api/drafts/:id/outcomes/:outcomeId/confirm", async (request, reply) => {
    const params = z.object({ id: z.string().uuid(), outcomeId: z.string().min(1).max(500) }).parse(request.params);
    const body = ConfirmOutcomeSchema.parse(request.body);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{
        matter_id: string; current_version: number; content: unknown; source_fingerprint: string | null;
        template_analysis: unknown; template_map: unknown;
      }>(`
        SELECT d.matter_id, d.current_version, dv.content, dv.source_fingerprint,
               t.analysis AS template_analysis, tmv.map AS template_map
        FROM drafts d
        JOIN draft_versions dv ON dv.draft_id = d.id AND dv.version = d.current_version
        JOIN matters m ON m.id = d.matter_id
        JOIN templates t ON t.id = m.template_id
        JOIN template_map_versions tmv ON tmv.template_id = t.id AND tmv.map_version = dv.template_map_version
        WHERE d.id = $1
        FOR UPDATE OF d
      `, [params.id]);
      if (!result.rowCount) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ error: "Draft not found." });
      }
      const row = requiredRow(result.rows, "Draft outcome lock failed.");
      if (row.current_version !== body.version) {
        await client.query("ROLLBACK");
        return reply.status(409).send({ error: "Draft changed in another session.", currentVersion: row.current_version });
      }
      const currentFingerprint = await sourceFingerprintForMatter(row.matter_id, client);
      if (!row.source_fingerprint || row.source_fingerprint !== currentFingerprint) {
        await client.query("ROLLBACK");
        return reply.status(409).send({ error: "The evidence set changed. Regenerate before approving an omission." });
      }
      const content = normalizeDraftContent(row.content);
      const outcome = content.outcomes.find((candidate) => candidate.id === params.outcomeId);
      if (!outcome) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ error: "Draft outcome not found." });
      }
      if (outcome.status !== "omitted" || content.confirmedOmissionTargetIds.includes(outcome.targetId)) {
        await client.query("ROLLBACK");
        return reply.status(409).send({ error: "Only an unresolved omitted target can be confirmed." });
      }
      const nextVersion = body.version + 1;
      const template = analysisWithConfirmedMap(TemplateAnalysisSchema.parse(row.template_analysis), TemplateMapSchema.parse(row.template_map));
      const { content: updated, headingCleared } = confirmOmission(content, outcome.targetId, template);
      await client.query(
        `INSERT INTO draft_versions (draft_id, version, content, actor_id, source_fingerprint, template_map_version, change_summary)
         SELECT $1, $2, $3, $4, $5, template_map_version, $7
         FROM draft_versions WHERE draft_id = $1 AND version = $6`,
        [params.id, nextVersion, JSON.stringify(updated), ACTOR_ID, currentFingerprint, body.version, `Confirmed omission${headingCleared ? " and cleared its empty heading" : ""}`],
      );
      await persistCitations(client, params.id, nextVersion, updated);
      await client.query("UPDATE drafts SET current_version = $2, updated_at = now() WHERE id = $1", [params.id, nextVersion]);
      await client.query(`
        INSERT INTO activity_events (workspace_id, matter_id, actor_id, event_type, summary, metadata)
        VALUES ($1, $2, $3, 'omission.confirmed', 'Confirmed an omitted target in the reviewed draft', $4)
      `, [WORKSPACE_ID, row.matter_id, ACTOR_ID, JSON.stringify({
        draftId: params.id,
        outcomeId: params.outcomeId,
        targetId: outcome.targetId,
        version: nextVersion,
        headingCleared,
        sourceFingerprint: currentFingerprint,
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

  app.post("/api/drafts/:id/outcomes/:outcomeId/supply", async (request, reply) => {
    const params = z.object({ id: z.string().uuid(), outcomeId: z.string().min(1).max(500) }).parse(request.params);
    const body = SupplyOutcomeSchema.parse(request.body);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{
        matter_id: string; current_version: number; content: unknown; source_fingerprint: string | null;
        template_analysis: unknown; template_map: unknown;
      }>(`
        SELECT d.matter_id, d.current_version, dv.content, dv.source_fingerprint,
               t.analysis AS template_analysis, tmv.map AS template_map
        FROM drafts d
        JOIN draft_versions dv ON dv.draft_id = d.id AND dv.version = d.current_version
        JOIN matters m ON m.id = d.matter_id
        JOIN templates t ON t.id = m.template_id
        JOIN template_map_versions tmv ON tmv.template_id = t.id AND tmv.map_version = dv.template_map_version
        WHERE d.id = $1
        FOR UPDATE OF d
      `, [params.id]);
      if (!result.rowCount) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ error: "Draft not found." });
      }
      const row = requiredRow(result.rows, "Draft outcome lock failed.");
      if (row.current_version !== body.version) {
        await client.query("ROLLBACK");
        return reply.status(409).send({ error: "Draft changed in another session.", currentVersion: row.current_version });
      }
      const content = normalizeDraftContent(row.content);
      const outcome = content.outcomes.find((candidate) => candidate.id === params.outcomeId);
      if (!outcome) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ error: "Draft outcome not found." });
      }
      const template = analysisWithConfirmedMap(TemplateAnalysisSchema.parse(row.template_analysis), TemplateMapSchema.parse(row.template_map));
      const updated = ensureEditableCoverage(supplyOmission(content, outcome.targetId, body.values, template), template);
      const nextVersion = body.version + 1;
      await client.query(
        `INSERT INTO draft_versions (draft_id, version, content, actor_id, source_fingerprint, template_map_version, change_summary)
         SELECT $1, $2, $3, $4, $5, template_map_version, $7
         FROM draft_versions WHERE draft_id = $1 AND version = $6`,
        [params.id, nextVersion, JSON.stringify(updated), ACTOR_ID, row.source_fingerprint, body.version, "Supplied omitted template content"],
      );
      await persistCitations(client, params.id, nextVersion, updated);
      await client.query("UPDATE drafts SET current_version = $2, updated_at = now() WHERE id = $1", [params.id, nextVersion]);
      await client.query(`
        INSERT INTO activity_events (workspace_id, matter_id, actor_id, event_type, summary, metadata)
        VALUES ($1, $2, $3, 'omission.supplied', 'Supplied an omitted target manually', $4)
      `, [WORKSPACE_ID, row.matter_id, ACTOR_ID, JSON.stringify({
        draftId: params.id,
        outcomeId: params.outcomeId,
        targetId: outcome.targetId,
        version: nextVersion,
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

  app.get("/api/drafts/:id/editor-config", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    if (!onlyOfficeEnabled()) {
      return reply.status(503).send({
        error: "The Word editor is unavailable.",
        detail: "Start the local ONLYOFFICE service and configure its public, internal, callback, and JWT settings.",
      });
    }
    const artifact = await materializeDraftDocument(id);
    if (!artifact) return reply.status(404).send({ error: "Draft not found." });
    reply.header("Cache-Control", "no-store");
    return onlyOfficeEditorConfig({
      draftId: id,
      version: artifact.version,
      sha256: artifact.sha256,
      title: safeDownloadName(artifact.matterName),
    });
  });

  app.get("/api/drafts/:id/versions/:version/document.docx", async (request, reply) => {
    const { id, version } = z.object({ id: z.string().uuid(), version: z.coerce.number().int().positive() }).parse(request.params);
    const { access } = z.object({ access: z.string().min(1) }).parse(request.query);
    try {
      requireScopedAccess(access, "document", id, version);
    } catch (error) {
      return reply.status(401).send({ error: error instanceof Error ? error.message : "Invalid editor access token." });
    }
    const artifact = await materializeDraftDocument(id, version);
    if (!artifact) return reply.status(404).send({ error: "Draft version not found." });
    const buffer = await fs.readFile(artifact.path);
    return reply
      .header("Cache-Control", "no-store")
      .header("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
      .header("Content-Disposition", `inline; filename="${safeDownloadName(artifact.matterName)}-v${version}.docx"`)
      .send(buffer);
  });

  app.post("/api/drafts/:id/versions/:version/force-save", async (request, reply) => {
    const { id, version } = z.object({ id: z.string().uuid(), version: z.coerce.number().int().positive() }).parse(request.params);
    if (!onlyOfficeEnabled()) return reply.status(503).send({ error: "The Word editor is unavailable." });
    const artifact = await materializeDraftDocument(id, version);
    if (!artifact) return reply.status(404).send({ error: "Draft version not found." });
    if (!artifact.current) return reply.status(409).send({ error: "A newer draft version already exists. Reload the Word editor." });
    await requestOnlyOfficeForceSave({ draftId: id, version, sha256: artifact.sha256 });
    return reply.status(202).send({ accepted: true, version });
  });

  app.post("/api/drafts/:id/versions/:version/onlyoffice-callback", async (request, reply) => {
    const { id, version } = z.object({ id: z.string().uuid(), version: z.coerce.number().int().positive() }).parse(request.params);
    const { access } = z.object({ access: z.string().min(1) }).parse(request.query);
    try {
      requireScopedAccess(access, "callback", id, version);
    } catch (error) {
      return reply.status(401).send({ error: error instanceof Error ? error.message : "Invalid editor callback token." });
    }
    const callback = OnlyOfficeCallbackSchema.parse(request.body);
    request.log.info({ draftId: id, version, status: callback.status }, "ONLYOFFICE callback received");
    const authorization = request.headers.authorization;
    const callbackToken = callback.token ?? (authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined);
    if (callbackToken) {
      try {
        verifyOnlyOfficeToken(callbackToken);
      } catch (error) {
        return reply.status(401).send({ error: error instanceof Error ? error.message : "Invalid document-server signature." });
      }
    }
    if (![2, 6].includes(callback.status)) return { error: 0 };
    if (!callback.url || !allowedOnlyOfficeDownload(callback.url)) {
      return reply.status(400).send({ error: "The document-server save URL was missing or not trusted." });
    }

    const response = await fetch(callback.url, { redirect: "error" });
    if (!response.ok) throw new Error(`ONLYOFFICE returned ${response.status} while Steno downloaded the saved document.`);
    const declaredSize = Number(response.headers.get("content-length") ?? 0);
    if (declaredSize > 30 * 1024 * 1024) return reply.status(413).send({ error: "The saved Word document exceeds 30 MB." });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > 30 * 1024 * 1024) return reply.status(413).send({ error: "The saved Word document exceeds 30 MB." });
    const tempDirectory = path.join(config.storageDir, "tmp");
    const tempPath = path.join(tempDirectory, `onlyoffice-${id}-${version}-${randomUUID()}.docx`);
    await fs.mkdir(tempDirectory, { recursive: true });
    await fs.writeFile(tempPath, buffer);
    try {
      const saved = await ingestEditedDraftDocument(id, version, tempPath);
      return { error: 0, saved: saved.saved, version: saved.version };
    } finally {
      await fs.unlink(tempPath).catch(() => undefined);
    }
  });

  app.get("/api/drafts/:id/export.docx", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const artifact = await materializeDraftDocument(id);
    if (!artifact) return reply.status(404).send({ error: "Draft not found." });
    if (!isDraftExportReady(artifact.readiness)) {
      const issues = artifact.readiness;
      return reply.status(409).send({
        error: "Draft is not ready for Word export.",
        detail: `Resolve ${issues.omittedTargetIds.length} omitted targets, ${issues.fieldKeys.length} template fields, ${issues.duplicateParagraphIndexes.length} duplicate template mappings${issues.imageIssue ? ", the image mapping" : ""}${issues.staleEvidence ? ", and regenerate from the current evidence" : ""} before export.`,
        issues,
      });
    }
    await pool.query(`
      INSERT INTO activity_events (workspace_id, matter_id, actor_id, event_type, summary, metadata)
      SELECT $1, matter_id, $2, 'draft.exported', 'Exported the exact reviewed Word document', $3 FROM drafts WHERE id = $4
    `, [WORKSPACE_ID, ACTOR_ID, JSON.stringify({ draftId: id, version: artifact.version, sha256: artifact.sha256 }), id]);
    const materialized = await fs.readFile(artifact.path);
    return reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
      .header("Content-Disposition", `attachment; filename="${safeDownloadName(artifact.matterName)}-v${artifact.version}.docx"`)
      .send(materialized);

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
    let mapVersion = template.currentMapVersion;
    if (!mapVersion) {
      const analysis = TemplateAnalysisSchema.parse(template.analysis);
      const blocks = (analysis.blocks?.length ? analysis.blocks : analysis.regions).map((block) => ({ ...block, needsAttention: false }));
      mapVersion = 1;
      const templateHash = (await pool.query<{ sha256: string }>("SELECT sha256 FROM templates WHERE id = $1", [template.id])).rows[0]?.sha256;
      const confirmedMap = TemplateMapSchema.parse({
        schemaVersion: 2,
        mapVersion,
        templateHash,
        analysisVersion: analysis.analysisVersion,
        blocks,
        confirmedBy: ACTOR_ID,
        confirmedAt: new Date().toISOString(),
      });
      await pool.query(`
        INSERT INTO template_map_versions (template_id, map_version, analysis_version, template_hash, map, actor_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (template_id, map_version) DO NOTHING
      `, [template.id, mapVersion, analysis.analysisVersion, confirmedMap.templateHash, JSON.stringify(confirmedMap), ACTOR_ID]);
      const regions = blocks.filter((block) => (block.anchor?.partName ?? "word/document.xml") === "word/document.xml");
      await pool.query("UPDATE templates SET status = 'confirmed', confirmed_regions = $2, current_map_version = $3 WHERE id = $1", [template.id, JSON.stringify(regions), mapVersion]);
    }
    const matter = await pool.query<{ id: string; name: string; template_id: string }>(`
      INSERT INTO matters (workspace_id, name, template_id, template_map_version)
      VALUES ($1, 'New matter', $2, $3) RETURNING id, name, template_id
    `, [WORKSPACE_ID, template.id, mapVersion]);
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
