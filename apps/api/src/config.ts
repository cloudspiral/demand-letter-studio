import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
dotenv.config({ path: path.join(repositoryRoot, ".env") });

const executable = (value: string): string => (
  value.includes(path.sep) && !path.isAbsolute(value) ? path.resolve(repositoryRoot, value) : value
);

const required = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

export const config = {
  repositoryRoot,
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3001),
  databaseUrl: required("DATABASE_URL", "postgresql://steno:steno@127.0.0.1:5438/steno"),
  storageDir: path.resolve(repositoryRoot, process.env.STORAGE_DIR ?? ".data/storage"),
  demoAssetDir: path.resolve(repositoryRoot, process.env.DEMO_ASSET_DIR ?? "."),
  staticDir: process.env.STATIC_DIR ? path.resolve(repositoryRoot, process.env.STATIC_DIR) : null,
  webOrigin: process.env.WEB_ORIGIN ?? "http://127.0.0.1:5173",
  pythonBin: executable(process.env.PYTHON_BIN ?? "services/document-worker/.venv/bin/python"),
  documentWorker: path.join(repositoryRoot, "services/document-worker/worker.py"),
  aiProvider: process.env.AI_PROVIDER ?? "openai",
  awsRegion: process.env.AWS_REGION ?? "us-east-1",
  bedrockModel: process.env.BEDROCK_MODEL ?? "us.anthropic.claude-sonnet-4-6",
  openaiModel: process.env.OPENAI_MODEL ?? "gpt-5.6-sol",
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-opus-5",
};
