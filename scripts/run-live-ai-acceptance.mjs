#!/usr/bin/env node
/** Run one evidence-grounding acceptance case against a deployed Steno URL. */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function has(name) {
  return process.argv.includes(name);
}

if (has("--help")) {
  console.log(`Usage: node scripts/run-live-ai-acceptance.mjs --base-url URL [options]

Options:
  --template PATH     DOCX template (required unless --demo)
  --sources DIR       Directory containing 1-10 PDF/image sources (required unless --demo)
  --manifest PATH     Expected facts and forbidden markers JSON
  --supplemental PATH Add one source after the initial draft and regenerate the same draft
  --name LABEL        Output/report label
  --output DIR        Report, draft, and export directory
  --job-timeout-ms N  Maximum wait for each queued model job (default: 600000)
  --expect-ready      Require Word export to succeed; otherwise require it to be blocked
  --refine            Run and accept one streamed refinement
  --demo              Use the server's deterministic demo bootstrap`);
  process.exit(0);
}

const baseUrl = (option("--base-url") ?? "").replace(/\/$/, "");
const outputDir = path.resolve(option("--output", ".data/qa/live-acceptance"));
const caseName = option("--name", "Steno live acceptance");
const demo = has("--demo");
const expectedReady = has("--expect-ready");
const runRefinement = has("--refine");
const jobTimeoutMs = Number(option("--job-timeout-ms", process.env.LIVE_AI_JOB_TIMEOUT_MS ?? "600000"));
if (!baseUrl) throw new Error("--base-url is required");
if (!Number.isFinite(jobTimeoutMs) || jobTimeoutMs < 1_000) throw new Error("--job-timeout-ms must be at least 1000");
if (!demo && (!option("--template") || !option("--sources"))) {
  throw new Error("--template and --sources are required unless --demo is used");
}

await mkdir(outputDir, { recursive: true });

async function request(relative, init = {}, accepted = [200]) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${relative}`, init);
  const durationMs = performance.now() - started;
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!accepted.includes(response.status)) {
    throw new Error(`${init.method ?? "GET"} ${relative} returned ${response.status}: ${bytes.toString("utf8").slice(0, 500)}`);
  }
  return { response, bytes, durationMs };
}

async function jsonRequest(relative, init = {}, accepted = [200]) {
  const result = await request(relative, init, accepted);
  return { ...result, data: JSON.parse(result.bytes.toString("utf8")) };
}

function jsonInit(method, body) {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function mimeFor(filename) {
  if (filename.toLowerCase().endsWith(".pdf")) return "application/pdf";
  if (filename.toLowerCase().endsWith(".png")) return "image/png";
  if (filename.toLowerCase().endsWith(".jpg") || filename.toLowerCase().endsWith(".jpeg")) return "image/jpeg";
  if (filename.toLowerCase().endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  return "application/octet-stream";
}

async function multipartFor(files) {
  const body = new FormData();
  for (const filename of files) {
    body.append("file", new Blob([await readFile(filename)], { type: mimeFor(filename) }), path.basename(filename));
  }
  return body;
}

async function setupMatter() {
  if (demo) {
    const bootstrapped = await jsonRequest("/api/demo/bootstrap", jsonInit("POST", {}), [201]);
    const templates = await jsonRequest("/api/templates");
    const template = templates.data.find((entry) => entry.id === bootstrapped.data.templateId);
    if (!template) throw new Error("Bootstrapped template was not returned by /api/templates");
    return {
      matterId: bootstrapped.data.matterId,
      template,
      sourceCount: bootstrapped.data.sources.length,
      setupTimingsMs: { demoBootstrap: bootstrapped.durationMs },
    };
  }

  const templatePath = path.resolve(option("--template"));
  const templateForm = await multipartFor([templatePath]);
  const uploaded = await jsonRequest("/api/templates", {
    method: "POST",
    headers: { "X-Steno-Test-Template": "true" },
    body: templateForm,
  }, [201]);
  const confirmed = await jsonRequest(
    `/api/templates/${uploaded.data.id}/confirm`,
    jsonInit("POST", {
      schemaVersion: 2,
      blocks: uploaded.data.analysis.blocks?.length ? uploaded.data.analysis.blocks : uploaded.data.analysis.regions,
    }),
  );
  const matter = await jsonRequest("/api/matters", jsonInit("POST", {
    templateId: confirmed.data.id,
  }), [201]);
  const sourceDir = path.resolve(option("--sources"));
  const names = (await readdir(sourceDir)).filter((name) => !name.startsWith(".")).sort();
  if (!names.length || names.length > 10) throw new Error(`Source count ${names.length} is outside the API limit of 1-10`);
  const sourceForm = await multipartFor(names.map((name) => path.join(sourceDir, name)));
  const uploadedSources = await jsonRequest(
    `/api/matters/${matter.data.id}/sources`,
    { method: "POST", body: sourceForm },
    [201],
  );
  return {
    matterId: matter.data.id,
    template: confirmed.data,
    sourceCount: uploadedSources.data.length,
    setupTimingsMs: {
      templateUploadExtraction: uploaded.durationMs,
      templateConfirmation: confirmed.durationMs,
      matterCreation: matter.durationMs,
      sourceUploadExtraction: uploadedSources.durationMs,
    },
  };
}

async function firstJobEvent(jobId) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
    headers: { accept: "text/event-stream" },
  });
  if (!response.ok || !response.body) throw new Error(`Job event stream returned ${response.status}`);
  const reader = response.body.getReader();
  const { done, value } = await reader.read();
  await reader.cancel();
  if (done || !value?.length) throw new Error("Job event stream ended before its first event");
  return performance.now() - started;
}

async function queueAndWait(relative, body, label) {
  const started = performance.now();
  const queued = await jsonRequest(relative, jsonInit("POST", body), [202]);
  const firstEventPromise = firstJobEvent(queued.data.jobId);
  let job;
  for (let attempt = 0; attempt < Math.ceil(jobTimeoutMs / 500); attempt += 1) {
    job = (await jsonRequest(`/api/jobs/${queued.data.jobId}`)).data;
    if (["completed", "failed"].includes(job.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!job || !["completed", "failed"].includes(job.status)) throw new Error(`${label} did not finish within ${Math.round(jobTimeoutMs / 1_000)} seconds`);
  if (job.status !== "completed") throw new Error(`${label} failed: ${job.error ?? "unknown error"}`);
  return {
    job,
    queueResponseMs: queued.durationMs,
    firstEventMs: await firstEventPromise,
    totalMs: performance.now() - started,
  };
}

async function generate(matterId, draft = null) {
  return queueAndWait(
    `/api/matters/${matterId}/generations`,
    draft ? { draftId: draft.id, baseVersion: draft.version } : {},
    draft ? "Regeneration" : "Generation",
  );
}

async function addSupplementalEvidence(matterId, supplementalPath) {
  const sourceForm = await multipartFor([path.resolve(supplementalPath)]);
  return jsonRequest(`/api/matters/${matterId}/sources`, { method: "POST", body: sourceForm }, [201]);
}

function normalize(value) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

async function auditDraft(draft, template) {
  const blocks = draft.content.sections.flatMap((section) => section.blocks);
  const mapped = blocks.filter((block) => block.templateParagraphIndex !== null);
  const expectedTargets = draft.targets?.map((target) => target.id) ?? [];
  const outcomeCounts = new Map();
  for (const outcome of draft.content.outcomes) outcomeCounts.set(outcome.targetId, (outcomeCounts.get(outcome.targetId) ?? 0) + 1);
  const pageCache = new Map();
  const invalidCitations = [];
  const citedOwners = [
    ...blocks.map((block) => ({ id: `block:${block.id}`, citations: block.citations })),
    ...draft.content.outcomes.map((outcome) => ({ id: `outcome:${outcome.targetId}`, citations: outcome.citations })),
    ...Object.entries(draft.content.fields).map(([key, field]) => ({ id: `field:${key}`, citations: field.citations })),
  ];
  for (const owner of citedOwners) {
    for (const citation of owner.citations) {
      const key = `${citation.sourceId}:${citation.page}`;
      if (!pageCache.has(key)) {
        const page = await jsonRequest(`/api/sources/${citation.sourceId}/pages/${citation.page}`);
        pageCache.set(key, page.data.text);
      }
      if (citation.evidenceType !== "visual" && !normalize(pageCache.get(key)).includes(normalize(citation.quote))) {
        invalidCitations.push({ ownerId: owner.id, sourceId: citation.sourceId, page: citation.page });
      }
    }
  }
  const manifestPath = option("--manifest");
  const manifest = manifestPath ? JSON.parse(await readFile(path.resolve(manifestPath), "utf8")) : null;
  const allText = `${blocks.map((block) => block.text).join("\n")}\n${Object.values(draft.content.fields).map((field) => field.value).join("\n")}`;
  return {
    blockCount: blocks.length,
    templateBackedBlocks: mapped.length,
    targetCount: expectedTargets.length,
    missingTargetIds: expectedTargets.filter((targetId) => !outcomeCounts.has(targetId)),
    duplicateTargetIds: [...outcomeCounts.entries()].filter(([, count]) => count > 1).map(([targetId]) => targetId),
    unknownTargetIds: [...outcomeCounts.keys()].filter((targetId) => !expectedTargets.includes(targetId)),
    invalidOutcomeStatuses: draft.content.outcomes.filter((outcome) => !["generated", "omitted"].includes(outcome.status)).map((outcome) => outcome.targetId),
    unresolvedOmissionTargetIds: draft.readiness.omittedTargetIds,
    fieldCount: Object.keys(draft.content.fields).length,
    unresolvedFieldKeys: Object.entries(draft.content.fields)
      .filter(([, field]) => field.value === null)
      .map(([key]) => key),
    citationCount: blocks.reduce((total, block) => total + block.citations.length, 0),
    invalidCitations,
    expectedFactsPresent: manifest
      ? Object.fromEntries(Object.entries(manifest.expected).map(([key, value]) => [key, normalize(allText).includes(normalize(value))]))
      : null,
    forbiddenMarkersPresent: manifest
      ? manifest.mustNotAppearInCompleteExport.filter((marker) => normalize(allText).includes(normalize(marker)))
      : [],
  };
}

async function streamRefinement(draft) {
  const block = draft.content.sections.flatMap((section) => section.blocks)
    .find((candidate) => candidate.kind === "paragraph" && candidate.text.length >= 40);
  if (!block) throw new Error("No paragraph is available for refinement");
  const sentenceEnd = block.text.indexOf(".");
  const end = sentenceEnd >= 39 ? sentenceEnd + 1 : Math.min(block.text.length, 180);
  const quote = block.text.slice(0, end);
  const started = performance.now();
  const response = await fetch(`${baseUrl}/api/drafts/${draft.id}/refinements`, {
    ...jsonInit("POST", {
      instruction: "Make this selected passage more concise without adding, removing, or changing any factual detail.",
      annotations: [{ blockId: block.id, quote, start: 0, end: quote.length }],
    }),
    headers: { "content-type": "application/json", accept: "text/event-stream" },
  });
  if (!response.ok || !response.body) throw new Error(`Refinement returned ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  let firstEventMs = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstEventMs === null) firstEventMs = performance.now() - started;
    raw += decoder.decode(value, { stream: true });
  }
  const proposalMatch = raw.match(/event: proposal\ndata: ([^\n]+)\n/);
  if (!proposalMatch) throw new Error(`Refinement stream had no proposal event: ${raw.slice(0, 500)}`);
  const proposal = JSON.parse(proposalMatch[1]);
  const accepted = await jsonRequest(`/api/proposals/${proposal.id}/accept`, jsonInit("POST", {}));
  return {
    firstEventMs,
    totalMs: performance.now() - started,
    proposalId: proposal.id,
    editCount: proposal.proposal.edits.length,
    draft: accepted.data.draft,
  };
}

const health = await jsonRequest("/api/health");
const ready = await jsonRequest("/api/ready");
const setup = await setupMatter();
const generation = await generate(setup.matterId);
let draft = (await jsonRequest(`/api/drafts/${generation.job.draftId}`)).data;
const initialDraft = draft;
const initialAudit = await auditDraft(draft, setup.template);
let supplemental = null;
let regeneration = null;
if (option("--supplemental")) {
  const uploaded = await addSupplementalEvidence(setup.matterId, option("--supplemental"));
  const staleReadiness = (await jsonRequest(`/api/drafts/${draft.id}`)).data.readiness;
  regeneration = await generate(setup.matterId, draft);
  draft = (await jsonRequest(`/api/drafts/${draft.id}`)).data;
  supplemental = {
    uploadExtractionMs: uploaded.durationMs,
    uploadedSourceCount: uploaded.data.length,
    staleReadiness,
    priorDraftVersion: initialDraft.version,
    regeneratedDraftVersion: draft.version,
  };
}
const beforeRefinement = await auditDraft(draft, setup.template);
let refinement = null;
if (runRefinement && beforeRefinement.unresolvedOmissionTargetIds.length === 0) {
  refinement = await streamRefinement(draft);
  draft = refinement.draft;
}
const afterRefinement = await auditDraft(draft, setup.template);
const exportResult = await request(`/api/drafts/${draft.id}/export.docx`, {}, [200, 409]);
const exportReady = exportResult.response.status === 200;
let exportPath = null;
let exportIssues = null;
if (exportReady) {
  exportPath = path.join(outputDir, `${caseName.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}.docx`);
  await writeFile(exportPath, exportResult.bytes);
} else {
  exportIssues = JSON.parse(exportResult.bytes.toString("utf8"));
}

const expectedFactsSatisfied = !expectedReady || afterRefinement.expectedFactsPresent === null
  || Object.values(afterRefinement.expectedFactsPresent).every(Boolean);
const readyStateSatisfied = expectedReady
  ? afterRefinement.unresolvedOmissionTargetIds.length === 0
    && afterRefinement.unresolvedFieldKeys.length === 0
  : true;
const incrementalTransitionSatisfied = supplemental === null
  || (supplemental.staleReadiness.staleEvidence === true
    && supplemental.regeneratedDraftVersion === supplemental.priorDraftVersion + 1
    && draft.id === initialDraft.id);
const report = {
  passed: exportReady === expectedReady
    && afterRefinement.invalidCitations.length === 0
    && afterRefinement.missingTargetIds.length === 0
    && afterRefinement.duplicateTargetIds.length === 0
    && afterRefinement.unknownTargetIds.length === 0
    && afterRefinement.invalidOutcomeStatuses.length === 0
    && (!expectedReady || afterRefinement.forbiddenMarkersPresent.length === 0)
    && expectedFactsSatisfied
    && readyStateSatisfied
    && incrementalTransitionSatisfied,
  expectedReady,
  exportReady,
  baseUrl,
  caseName,
  matterId: setup.matterId,
  draftId: draft.id,
  draftVersion: draft.version,
  sourceCount: setup.sourceCount + (supplemental ? 1 : 0),
  timingsMs: {
    health: health.durationMs,
    ready: ready.durationMs,
    setup: setup.setupTimingsMs,
    generationQueueResponse: generation.queueResponseMs,
    generationFirstEvent: generation.firstEventMs,
    generationTotal: generation.totalMs,
    supplementalUploadExtraction: supplemental?.uploadExtractionMs ?? null,
    regenerationQueueResponse: regeneration?.queueResponseMs ?? null,
    regenerationFirstEvent: regeneration?.firstEventMs ?? null,
    regenerationTotal: regeneration?.totalMs ?? null,
    export: exportResult.durationMs,
  },
  readyResponse: ready.data,
  initialAudit,
  supplemental,
  beforeRefinement,
  refinement: refinement && {
    firstEventMs: refinement.firstEventMs,
    totalMs: refinement.totalMs,
    proposalId: refinement.proposalId,
    editCount: refinement.editCount,
  },
  afterRefinement,
  exportPath,
  exportIssues,
};
await writeFile(path.join(outputDir, "draft.json"), JSON.stringify(draft, null, 2) + "\n");
await writeFile(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({
  passed: report.passed,
  caseName,
  sourceCount: report.sourceCount,
  exportReady,
  unresolvedOmissions: afterRefinement.unresolvedOmissionTargetIds.length,
  unresolvedFields: afterRefinement.unresolvedFieldKeys.length,
  invalidCitations: afterRefinement.invalidCitations.length,
  generationMs: Math.round(report.timingsMs.generationTotal),
  report: path.join(outputDir, "report.json"),
  exportPath,
}));
process.exitCode = report.passed ? 0 : 1;
