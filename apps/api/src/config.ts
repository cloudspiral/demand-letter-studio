import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
dotenv.config({ path: path.join(repositoryRoot, ".env") });

const required = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

export const config = {
  repositoryRoot,
  port: Number(process.env.PORT ?? 3001),
  databaseUrl: required("DATABASE_URL", "postgresql://steno:steno@127.0.0.1:5438/steno"),
  storageDir: path.resolve(repositoryRoot, process.env.STORAGE_DIR ?? ".data/storage"),
  demoAssetDir: path.resolve(repositoryRoot, process.env.DEMO_ASSET_DIR ?? "."),
  webOrigin: process.env.WEB_ORIGIN ?? "http://127.0.0.1:5173",
  pythonBin: process.env.PYTHON_BIN ?? "/Users/matt/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3",
  documentWorker: path.join(repositoryRoot, "services/document-worker/worker.py"),
  aiProvider: process.env.AI_PROVIDER ?? "openai",
  openaiModel: process.env.OPENAI_MODEL ?? "gpt-5.6-sol",
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-opus-5",
};
