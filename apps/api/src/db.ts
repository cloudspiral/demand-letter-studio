import { createHash } from "node:crypto";
import pg from "pg";
import { config } from "./config";
import { isLegacySyntheticTemplate, templateDisplayName } from "./template-metadata";

const { Pool } = pg;
export const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });

const migrations = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS actors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  actor_type text NOT NULL CHECK (actor_type IN ('human','agent')),
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL,
  display_name text NOT NULL,
  is_test boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('analyzed','confirmed')),
  storage_key text NOT NULL,
  sha256 text NOT NULL,
  analysis jsonb NOT NULL,
  confirmed_regions jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS matters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL,
  template_id uuid REFERENCES templates(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS source_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  matter_id uuid NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  name text NOT NULL,
  mime_type text NOT NULL,
  storage_key text NOT NULL,
  sha256 text NOT NULL,
  page_count integer NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('processing','ready','failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS source_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  page_number integer NOT NULL,
  extracted_text text NOT NULL,
  UNIQUE(source_id, page_number)
);
CREATE TABLE IF NOT EXISTS facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  matter_id uuid NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  page_number integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('amount','person','date')),
  label text NOT NULL,
  value text NOT NULL,
  confidence numeric(4,3) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  matter_id uuid NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  job_type text NOT NULL DEFAULT 'generation',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','completed','failed')),
  progress integer NOT NULL DEFAULT 0,
  step text NOT NULL DEFAULT 'Queued',
  draft_id uuid,
  error text,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS job_events (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS dead_letter_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  job_type text NOT NULL,
  error_code text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(job_id)
);
CREATE TABLE IF NOT EXISTS drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  matter_id uuid NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  current_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS draft_versions (
  draft_id uuid NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  version integer NOT NULL,
  content jsonb NOT NULL,
  actor_id uuid REFERENCES actors(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (draft_id, version)
);
CREATE TABLE IF NOT EXISTS citations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id uuid NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  draft_version integer NOT NULL,
  block_id text NOT NULL,
  source_id uuid NOT NULL REFERENCES source_documents(id),
  page_number integer NOT NULL,
  quote text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (draft_id, draft_version) REFERENCES draft_versions(draft_id, version) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS edit_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id uuid NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  base_version integer NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','accepted','rejected')),
  instruction text NOT NULL,
  proposal jsonb NOT NULL,
  actor_id uuid REFERENCES actors(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE TABLE IF NOT EXISTS activity_events (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  matter_id uuid REFERENCES matters(id),
  actor_id uuid REFERENCES actors(id),
  event_type text NOT NULL,
  summary text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ai_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  matter_id uuid REFERENCES matters(id),
  provider text NOT NULL,
  model text NOT NULL,
  purpose text NOT NULL,
  status text NOT NULL,
  input_tokens integer,
  output_tokens integer,
  latency_ms integer,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE jobs ALTER COLUMN status SET DEFAULT 'queued';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS result jsonb;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS base_version integer;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source_fingerprint text;
ALTER TABLE draft_versions ADD COLUMN IF NOT EXISTS source_fingerprint text;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;
DROP INDEX IF EXISTS jobs_one_active_type_per_matter;
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_active_generation_per_matter
  ON jobs (matter_id)
  WHERE job_type = 'generation' AND status IN ('queued', 'processing');
`;

export async function migrate(): Promise<void> {
  await pool.query(migrations);
  await pool.query(`
    INSERT INTO workspaces (id, name)
    VALUES ('00000000-0000-4000-8000-000000000001', 'Steno Demo Firm')
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO actors (id, workspace_id, actor_type, display_name)
    VALUES ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000001', 'human', 'Faby Rivera')
    ON CONFLICT (id) DO NOTHING;
  `);
  const templateDisplayMetadata = await pool.query<{
    id: string;
    name: string;
    display_name: string | null;
    is_test: boolean;
  }>(`
    SELECT id, name, display_name, is_test
    FROM templates
  `);
  for (const template of templateDisplayMetadata.rows) {
    const displayName = templateDisplayName(template.name);
    const isTest = template.is_test || isLegacySyntheticTemplate(template.name);
    if (template.display_name === displayName && template.is_test === isTest) continue;
    await pool.query(`
      UPDATE templates
      SET display_name = $2,
          is_test = $3
      WHERE id = $1
    `, [
      template.id,
      displayName,
      isTest,
    ]);
  }
  await pool.query("ALTER TABLE templates ALTER COLUMN display_name SET NOT NULL");
  const missingFingerprints = await pool.query<{ draft_id: string; matter_id: string }>(`
    SELECT DISTINCT dv.draft_id, d.matter_id
    FROM draft_versions dv
    JOIN drafts d ON d.id = dv.draft_id
    WHERE dv.source_fingerprint IS NULL
  `);
  for (const row of missingFingerprints.rows) {
    await pool.query(
      "UPDATE draft_versions SET source_fingerprint = $2 WHERE draft_id = $1 AND source_fingerprint IS NULL",
      [row.draft_id, await sourceFingerprintForMatter(row.matter_id)],
    );
  }
}

export const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
export const ACTOR_ID = "00000000-0000-4000-8000-000000000101";

type Queryable = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

export async function sourceFingerprintForMatter(
  matterId: string,
  queryable: Queryable = pool,
): Promise<string> {
  const sources = await queryable.query<{ id: string; sha256: string }>(`
    SELECT id, sha256
    FROM source_documents
    WHERE matter_id = $1 AND status = 'ready'
    ORDER BY id
  `, [matterId]);
  return sourceFingerprintForSources(sources.rows);
}

export function sourceFingerprintForSources(sources: Array<{ id: string; sha256: string }>): string {
  const stableSources = [...sources]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((source) => [source.id, source.sha256]);
  return createHash("sha256").update(JSON.stringify(stableSources)).digest("hex");
}

export async function persistCitations(
  client: pg.PoolClient,
  draftId: string,
  version: number,
  content: { sections: Array<{ blocks: Array<{ id: string; citations: Array<{ sourceId: string; page: number | null; quote: string }> }> }> },
): Promise<void> {
  for (const block of content.sections.flatMap((section) => section.blocks)) {
    for (const citation of block.citations) {
      if (citation.page !== null) {
        await client.query(`
          INSERT INTO citations (draft_id, draft_version, block_id, source_id, page_number, quote)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [draftId, version, block.id, citation.sourceId, citation.page, citation.quote]);
      }
    }
  }
}
