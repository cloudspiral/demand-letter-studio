# Steno Demand Letter Studio

Demand Letter Studio turns a reviewed firm Word template and a case evidence packet into an evidence-linked attorney-review draft. It is a local, end-to-end v1 for the Steno take-home assignment: uploaded state is persisted in PostgreSQL, generation runs as a job with SSE progress, edits are versioned, AI changes remain proposals until accepted, and export modifies the original DOCX package instead of rebuilding it.

> This system produces a draft for attorney review. It does not provide legal advice and must not send a demand without a qualified attorney validating every fact, citation, deadline, term, and amount.

## What works

- Import and analyze a reviewed `.docx`; confirm which paragraphs may be case-specific.
- Reject legacy `.doc`, PDF templates, macros, existing tracked changes, malformed packages, and unsupported source types with specific errors.
- Upload PDFs and images. PDF text is stored by page; images remain separate visual evidence.
- Generate asynchronously through OpenAI Responses, with an Anthropic adapter available for comparison/fallback and a deterministic mock for tests.
- Validate model JSON, resolve every citation to an uploaded source page, and visibly clear any unfilled case-specific template region.
- Edit draft paragraphs in Tiptap, save with optimistic version checks, and inspect exact-page sources in the evidence rail.
- Request AI refinements as proposals; accept or reject them explicitly and retain a semantic activity log.
- Export a genuine `.docx` by copying the reviewed OOXML package and applying bounded paragraph plus verified header/footer text replacements. Styles, numbering, media, fields, relationships, and section settings remain intact.
- Run locally with PostgreSQL and inspect the undeployed AWS SAM shape for API Gateway, Lambda, SQS/DLQ, and encrypted/versioned S3.

## Quick start

Prerequisites: Node 22+, pnpm 10+, Python 3.13+, [uv](https://docs.astral.sh/uv/), Docker, and LibreOffice/`soffice` for visual DOCX QA.

```bash
cp .env.example .env
pnpm install
uv sync --project services/document-worker --locked
docker compose up -d postgres
pnpm dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). Add the reference DOCX and source ZIP at the repository root if you want the local **Use the supplied Steno sample packet** shortcut; those assignment artifacts are intentionally ignored by Git.

For a no-cost deterministic run, set `AI_PROVIDER=mock`. The normal configuration uses `AI_PROVIDER=openai`, `OPENAI_MODEL=gpt-5.6-sol`, `OPENAI_STORE=false`, and `OPENAI_REASONING_EFFORT=high`. An Anthropic identity-linked key also requires `ANTHROPIC_WORKSPACE_ID`; ordinary Anthropic API keys do not.

## Verification

```bash
pnpm verify
pnpm --filter @steno/web test:e2e
```

The e2e test expects the API and web application to be running with `AI_PROVIDER=mock` and the supplied local artifacts present. See [TEST_RESULTS.md](./TEST_RESULTS.md) for the latest evidence and Word-rendering boundary.

## Repository map

```text
apps/web                 React, Vite, Tiptap, browser acceptance test
apps/api                 Fastify API, PostgreSQL workflow, AI adapters
packages/contracts       Shared Zod schemas and transport/domain types
services/document-worker Python PDF extraction and bounded OOXML operations
infra/template.yaml      Undeployed AWS SAM production shape
docs                     Architecture and decision records
```

## API

- `POST /api/templates` and `POST /api/templates/:id/confirm`
- `POST /api/matters` and `POST /api/matters/:id/sources`
- `POST /api/matters/:id/generations`
- `GET /api/jobs/:id` and `GET /api/jobs/:id/events`
- `GET /api/drafts/:id` and `PUT /api/drafts/:id`
- `POST /api/drafts/:id/refinements`
- `POST /api/proposals/:id/accept` or `/reject`
- `GET /api/drafts/:id/export.docx`

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for data flow, storage boundaries, failure behavior, and the collaboration seam.
