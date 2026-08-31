import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import AdmZip from "adm-zip";
import { z } from "zod";
import {
  GeneratedDraftSchema,
  RefinementProposalSchema,
  TemplateRegionSchema,
  type GeneratedDraft,
} from "@steno/contracts";
import { createAiProvider, type EvidencePage } from "./ai";
import { config } from "./config";
import { ACTOR_ID, migrate, persistCitations, pool, WORKSPACE_ID } from "./db";
import { analyzeTemplate, exportDocx, extractSource } from "./document-worker";
import { appendJobEvent, processGenerationJob, resumeQueuedJobs } from "./jobs";
import { pathForKey, putFile } from "./storage";

const CreateMatterSchema = z.object({ name: z.string().min(1).max(200), templateId: z.string().uuid() });
const ConfirmTemplateSchema = z.object({ regions: z.array(TemplateRegionSchema).min(1) });
const SaveDraftSchema = z.object({ version: z.number().int().positive(), content: GeneratedDraftSchema });
const RefineSchema = z.object({ instruction: z.string().min(1).max(2_000), selectedText: z.string().min(1).max(20_000) });

const mimeFor = (filename: string): string => {
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".pdf") return "application/pdf";
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(extension)) return extension === ".png" ? "image/png" : "image/jpeg";
  return "application/octet-stream";
};

const safeDownloadName = (value: string): string => value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "demand-letter";

function requiredRow<T>(rows: T[], message: string): T {
  const row = rows[0];
  if (!row) throw new Error(message);
  return row;
}

async function insertTemplate(buffer: Buffer, filename: string) {
  if (path.extname(filename).toLowerCase() !== ".docx") {
    throw new Error("Only reviewed .docx templates are accepted. Legacy .doc, PDF, and macro templates are not supported.");
  }
  const stored = await putFile(buffer, filename);
  const analysis = await analyzeTemplate(stored.path);
  const result = await pool.query<{
    id: string; name: string; status: "analyzed"; analysis: unknown; created_at: Date;
  }>(`
    INSERT INTO templates (workspace_id, name, status, storage_key, sha256, analysis)
    VALUES ($1, $2, 'analyzed', $3, $4, $5)
    RETURNING id, name, status, analysis, created_at
  `, [WORKSPACE_ID, filename, stored.key, stored.sha256, JSON.stringify(analysis)]);
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
  const result = await pool.query(`
    SELECT d.id, d.matter_id AS "matterId", d.current_version AS version,
           dv.content, d.created_at AS "createdAt", d.updated_at AS "updatedAt"
    FROM drafts d
    JOIN draft_versions dv ON dv.draft_id = d.id AND dv.version = d.current_version
    WHERE d.id = $1
  `, [draftId]);
  return result.rows[0] ?? null;
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

  app.get("/api/templates", async () => {
    const result = await pool.query(`
      SELECT id, name, status, analysis, confirmed_regions AS "confirmedRegions", created_at AS "createdAt"
      FROM templates WHERE workspace_id = $1 ORDER BY created_at DESC
    `, [WORKSPACE_ID]);
    return result.rows;
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
    const template = await insertTemplate(uploaded.buffer, uploaded.filename);
    return reply.status(201).send(template);
  });

  app.post("/api/templates/:id/confirm", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = ConfirmTemplateSchema.parse(request.body);
    const result = await pool.query(`
      UPDATE templates SET status = 'confirmed', confirmed_regions = $2
      WHERE id = $1 AND workspace_id = $3
      RETURNING id, name, status, analysis, confirmed_regions AS "confirmedRegions", created_at AS "createdAt"
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
    return { ...matter.rows[0], sources: sources.rows };
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
      FROM source_documents s JOIN source_pages p ON p.source_id = s.id
      WHERE s.id = $1 AND p.page_number = $2
    `, [params.id, params.page]);
    if (!result.rowCount) return reply.status(404).send({ error: "Source page not found." });
    return result.rows[0];
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
    return reply.status(201).send(results);
  });

  app.post("/api/matters/:id/generations", async (request, reply) => {
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
    const result = await pool.query<{ id: string }>(`
      INSERT INTO jobs (matter_id) VALUES ($1) RETURNING id
    `, [id]);
    const jobId = requiredRow(result.rows, "Job insert did not return an id.").id;
    await appendJobEvent(jobId, "queued", { progress: 0, step: "Queued" });
    setImmediate(() => void processGenerationJob(jobId));
    return reply.status(202).send({ jobId, status: "queued" });
  });

  app.get("/api/jobs/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await pool.query(`
      SELECT id, matter_id AS "matterId", status, progress, step, draft_id AS "draftId", error,
             created_at AS "createdAt", updated_at AS "updatedAt"
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
    const sendPending = async () => {
      const events = await pool.query<{ id: string; event_type: string; payload: unknown }>(`
        SELECT id::text, event_type, payload FROM job_events WHERE job_id = $1 AND id > $2 ORDER BY id
      `, [id, lastId]);
      for (const event of events.rows) {
        lastId = Number(event.id);
        reply.raw.write(`id: ${event.id}\nevent: ${event.event_type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
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
      const locked = await client.query<{ matter_id: string; current_version: number }>(
        "SELECT matter_id, current_version FROM drafts WHERE id = $1 FOR UPDATE",
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
      const nextVersion = body.version + 1;
      await client.query(
        "INSERT INTO draft_versions (draft_id, version, content, actor_id) VALUES ($1, $2, $3, $4)",
        [id, nextVersion, JSON.stringify(body.content), ACTOR_ID],
      );
      await persistCitations(client, id, nextVersion, body.content);
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
    const exists = content.sections.some((section) => section.blocks.some((block) => block.text === body.selectedText));
    if (!exists) return reply.status(409).send({ error: "Selected text is not part of the current draft version." });
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
    const evidence = await evidenceForDraft(id);
    let proposal;
    try {
      proposal = RefinementProposalSchema.parse(await createAiProvider().refine({ ...body, evidence }));
    } catch (primaryError) {
      try {
        if ((process.env.AI_PROVIDER ?? "openai") === "anthropic" || !process.env.ANTHROPIC_API_KEY) throw primaryError;
        proposal = RefinementProposalSchema.parse(await createAiProvider("anthropic").refine({ ...body, evidence }));
      } catch (fallbackError) {
        if (wantsStream) {
          reply.raw.write(`event: failed\ndata: ${JSON.stringify({ error: "Refinement failed" })}\n\n`);
          reply.raw.end();
          return;
        }
        throw fallbackError;
      }
    }
    const allowedSourceIds = new Set(evidence.map((page) => page.sourceId));
    proposal = { ...proposal, citedSourceIds: proposal.citedSourceIds.filter((sourceId) => allowedSourceIds.has(sourceId)) };
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
        draft_id: string; base_version: number; proposal: unknown; matter_id: string; current_version: number; content: unknown;
      }>(`
        SELECT p.draft_id, p.base_version, p.proposal, d.matter_id, d.current_version, dv.content
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
      let replacementCount = 0;
      const content = GeneratedDraftSchema.parse(row.content);
      const updated: GeneratedDraft = {
        ...content,
        sections: content.sections.map((section) => ({
          ...section,
          blocks: section.blocks.map((block) => {
            if (!replacementCount && block.text === proposal.targetText) {
              replacementCount += 1;
              return { ...block, text: proposal.replacementText };
            }
            return block;
          }),
        })),
      };
      if (!replacementCount) throw new Error("Proposal target no longer exists in this draft.");
      const nextVersion = row.current_version + 1;
      await client.query(
        "INSERT INTO draft_versions (draft_id, version, content, actor_id) VALUES ($1, $2, $3, $4)",
        [row.draft_id, nextVersion, JSON.stringify(updated), ACTOR_ID],
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
      matter_name: string; storage_key: string; content: unknown; current_version: number;
    }>(`
      SELECT m.name AS matter_name, t.storage_key, dv.content, d.current_version
      FROM drafts d
      JOIN matters m ON m.id = d.matter_id
      JOIN templates t ON t.id = m.template_id
      JOIN draft_versions dv ON dv.draft_id = d.id AND dv.version = d.current_version
      WHERE d.id = $1
    `, [id]);
    if (!result.rowCount) return reply.status(404).send({ error: "Draft not found." });
    const row = requiredRow(result.rows, "Draft export context was not found.");
    const content = GeneratedDraftSchema.parse(row.content);
    const outputName = `${safeDownloadName(row.matter_name)}-v${row.current_version}-${randomUUID()}.docx`;
    const outputPath = path.join(config.storageDir, "exports", outputName);
    const patches = content.sections.flatMap((section) => section.blocks)
      .filter((block) => block.templateParagraphIndex !== null)
      .map((block) => ({ paragraphIndex: block.templateParagraphIndex as number, text: block.text }));
    const fieldReplacements = Object.fromEntries(Object.entries(content.fields).map(([key, field]) => [key, field.value]));
    await exportDocx({ templatePath: pathForKey(row.storage_key), outputPath, patches, fieldReplacements });
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

  app.post("/api/demo/bootstrap", async (_request, reply) => {
    const templatePath = path.join(config.demoAssetDir, "AAA Insurance - Time Limited Policy Limits Demand - Pat Donahue.docx");
    const zipPath = path.join(config.demoAssetDir, "sample-case-files.zip");
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

  await resumeQueuedJobs();
  return app;
}
