# Steno Demand Letter Studio

Demand Letter Studio turns a reviewed firm Word template and a case evidence packet into an evidence-linked attorney-review draft. It is a local, end-to-end v1 for the Steno take-home assignment: uploaded state is persisted in PostgreSQL, generation runs as a job with SSE progress, edits are versioned, AI changes remain proposals until accepted, and export modifies the original DOCX package instead of rebuilding it.

> This system produces a draft for attorney review. It does not provide legal advice and must not send a demand without a qualified attorney validating every fact, citation, deadline, term, and amount.

## What works

- Start from the handoff2 setup experience: search persisted templates, upload a `.docx` first, stage up to ten PDF/image sources, or use the clearly labeled supplied-sample shortcut.
- Keep immutable upload filenames and content-addressed storage separate from clean template display names; automation fixtures remain visible but are explicitly labeled **Test template**, and long names stay contained within their cards.
- Import and analyze a reviewed `.docx`; use the compact post-analysis check to confirm editable, preserved, and heading regions.
- Reject legacy `.doc`, PDF templates, macros, existing tracked changes, malformed packages, and unsupported source types with specific errors.
- Upload PDFs and images. PDF text is stored by page; images remain separate visual evidence. When a reviewed template has exactly one body image slot and the matter has exactly one uploaded image, export replaces only that mapped media part while retaining its crop, dimensions, relationship, and surrounding layout.
- Review evidence asynchronously before drafting. Category-free review flags provide a short, non-exhaustive explanation, exact source/page excerpts when available, and links to affected template regions or fields without classifying a document or deciding authenticity or legal validity.
- Generate asynchronously through OpenAI Responses, with Anthropic and Bedrock adapters behind the same strict contracts and a deterministic mock for tests.
- Validate model JSON, require every citation quote to occur on its uploaded source page, and visibly flag any unfilled case-specific template region. A review flag is advisory; only its concrete blocked draft target affects export.
- Reveal only a fully validated generated draft, then edit body paragraphs directly in the paper view with optimistic autosave on blur. An edit becomes unverified and requires a separate attorney confirmation with the reviewed text and a resolution note.
- Add evidence from the source drawer without leaving the matter. The current draft remains visible but becomes stale immediately; a fresh evidence review and same-draft regeneration append the next immutable version while retaining history.
- Inspect reading-order citations in the drawer, including exact extracted pages and an authorized link to the original PDF at the cited page.
- Verify or correct low-confidence merge fields before they can enter export; every confirmation is versioned and recorded in activity.
- Annotate up to five exact text ranges and stream one atomic multi-block AI proposal over SSE; accept or reject the entire proposal and retain a semantic activity log.
- Compute one canonical export-readiness result on the server and return it with every draft. The browser and Word endpoint use that identical result to lock export for warning, placeholder, unconfirmed, unresolved-field, duplicate-mapping, ambiguous-image, and stale-evidence conditions. A ready export is a genuine `.docx` copied from the reviewed OOXML package with bounded paragraph, field, hyperlink-target, and explicitly mapped image replacements; run properties, styles, numbering, fields, bookmarks, section settings, logos, and unrelated package parts remain intact.
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

The live AWS demo uses direct OpenAI rather than routing through Bedrock. Its API key remains in AWS Secrets Manager and is resolved only at container startup through the AWS Workload Credentials Provider and AWS Agent Toolkit `asm-exec` wrapper; the key is never stored in the source archive, CloudFormation parameters, EC2 user data, or deployment logs.

Live demo: [https://13.219.250.195.sslip.io](https://13.219.250.195.sslip.io). Documented release: `steno-template-library-final-20260901T215022Z` in stack `steno-v1-live-direct` (`us-east-1`).

## Verification

```bash
pnpm verify
pnpm --filter @steno/web test:e2e
python scripts/generate-gold-case-fixtures.py --help
UV_CACHE_DIR=.data/uv-cache uv run --project services/document-worker python scripts/verify-docx-acceptance.py --help
node scripts/run-live-ai-acceptance.mjs --help
```

The e2e test accepts `E2E_BASE_URL`, `E2E_TEMPLATE_PATH`, `E2E_SOURCE_DIR`, `E2E_CONFIRMED_FIELD_VALUE`, `E2E_DOWNLOAD_PATH`, and async-aware timeout overrides. Without explicit fixture paths it expects the supplied local artifacts and a running deterministic development stack. See [TEST_RESULTS.md](./TEST_RESULTS.md) and [docs/PRD_ACCEPTANCE.md](./docs/PRD_ACCEPTANCE.md) for the latest local/deployed evidence and the native Word boundary.

## Repository map

```text
apps/web                 React, Vite, Tiptap, browser acceptance test
apps/api                 Fastify API, PostgreSQL workflow, AI adapters
packages/contracts       Shared Zod schemas and transport/domain types
services/document-worker Python PDF extraction and bounded OOXML operations
infra/template.yaml      Undeployed AWS SAM production shape
infra/live-demo.yaml     Deployable encrypted AWS demo stack
scripts                  Synthetic data, live-AI, and independent DOCX acceptance tools
docs                     Architecture and decision records
```

## API

- `POST /api/templates` and `POST /api/templates/:id/confirm`
- `POST /api/matters`, `GET /api/matters/:id`, and `POST /api/matters/:id/sources`
- `POST /api/matters/:id/evidence-reviews`
- `POST /api/matters/:id/generations` for initial generation or same-draft regeneration with `draftId` and `baseVersion`
- `GET /api/jobs/:id` and `GET /api/jobs/:id/events`
- `GET /api/drafts/:id` and `PUT /api/drafts/:id`
- `POST /api/drafts/:id/fields/confirm`
- `POST /api/drafts/:id/blocks/:blockId/confirm`
- `POST /api/drafts/:id/refinements`
- `POST /api/proposals/:id/accept` or `/reject`
- `GET /api/sources/:id/file`
- `GET /api/drafts/:id/export.docx`

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for data flow, storage boundaries, failure behavior, and the collaboration seam.
