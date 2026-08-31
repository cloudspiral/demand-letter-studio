import { spawn } from "node:child_process";
import { z } from "zod";
import { ExtractedFactSchema, TemplateAnalysisSchema } from "@steno/contracts";
import { config } from "./config";

const WorkerEnvelopeSchema = z.object({ ok: z.boolean(), result: z.unknown().optional(), error: z.string().optional() });

export async function runDocumentOperation<T>(payload: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.pythonBin, [config.documentWorker], {
      cwd: config.repositoryRoot,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", () => {
      try {
        const envelope = WorkerEnvelopeSchema.parse(JSON.parse(stdout));
        if (!envelope.ok) throw new Error(envelope.error ?? "Document worker failed");
        resolve(schema.parse(envelope.result));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reject(new Error(`${message}${stderr ? ` (${stderr.trim()})` : ""}`));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

export const SourceExtractionSchema = z.object({
  filename: z.string(),
  mimeType: z.string(),
  pageCount: z.number().int().nonnegative(),
  pages: z.array(z.object({ page: z.number().int().positive(), text: z.string() })),
  facts: z.array(ExtractedFactSchema),
  sha256: z.string(),
});

export const ExportResultSchema = z.object({
  path: z.string(),
  size: z.number().int().positive(),
  sha256: z.string(),
  patchCount: z.number().int().nonnegative(),
});

export async function analyzeTemplate(path: string) {
  return runDocumentOperation({ operation: "analyze-template", path }, TemplateAnalysisSchema.passthrough());
}

export async function extractSource(path: string, mimeType: string) {
  return runDocumentOperation({ operation: "extract-source", path, mimeType }, SourceExtractionSchema);
}

export async function exportDocx(payload: {
  templatePath: string;
  outputPath: string;
  patches: Array<{ paragraphIndex: number; text: string }>;
  fieldReplacements: Record<string, string>;
}) {
  return runDocumentOperation({ operation: "export-docx", ...payload }, ExportResultSchema);
}
