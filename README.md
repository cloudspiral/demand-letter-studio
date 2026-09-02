# Steno Demand Letter Studio

Demand Letter Studio turns a reviewed firm Word template and a case evidence packet into an evidence-linked attorney-review draft. The local checkout uses template-map schema v2: uploaded state is persisted in PostgreSQL, generation runs as a job with SSE progress, edits and omission decisions are versioned, AI changes remain proposals until accepted, and export modifies a copy of the original DOCX package instead of rebuilding it.

> This system produces a draft for attorney review. It does not provide legal advice and must not send a demand without a qualified attorney validating every fact, citation, deadline, term, and amount.

## What works

- Start from the handoff2 setup experience: search persisted templates, upload a `.docx` first, stage up to ten PDF/image sources, or use the clearly labeled supplied-sample shortcut.
- Keep immutable upload filenames and content-addressed storage separate from clean template display names; automation fixtures remain visible but are explicitly labeled **Test template**, and long names stay contained within their cards.
- Import and analyze a reviewed `.docx`; use the full annotated-letter workbench to confirm Keep/Replace blocks, locked headings with replaceable inline fields, structured groups, and evidence-backed figure slots. Queue filters never hide the complete letter, and document/card selection stays synchronized.
- Reject legacy `.doc`, PDF templates, macros, existing tracked changes, malformed packages, and unsupported source types with specific errors.
- Upload PDFs and images. PDF text is stored by page; standalone uploads remain eligible visual evidence. Every mapped figure keeps its exact media relationship and caption anchor; generation may select an existing uploaded image or explicitly omit the figure, but it may never synthesize one.
- Start generation directly after source upload for a saved template, or after Keep/Replace map confirmation for a new template. There is no standalone evidence-review job or pre-generation omission workflow.
- Start each matter as `New matter`; after the first validated generation, derive `Claimant - claim number` from grounded replacement fields. An inline attorney rename is sticky across regeneration.
- Generate asynchronously through one whole-document OpenAI Responses request, with Anthropic and Bedrock adapters behind the same strict contracts and a deterministic mock for tests. Application code derives elastic prose runs from the confirmed map; the model returns exactly one `generated` or `omitted` outcome for every narrative, structured, and figure target plus one nullable result for every replaceable inline field.
- Validate exact target and field coverage, bounds, citations, figure media, source fingerprints, structured rows, and previous-matter leakage before persisting or revealing any draft. A missing, ambiguous, or conflicting fact becomes one omission or null field with a concise note; a grounded negative fact remains cited generated content.
- Open every completed draft as the real template-backed DOCX in a self-hosted ONLYOFFICE form-filling editor. The original letterhead, headers, footers, tables, images, spacing, and pagination remain visible while mapped/generated controls are editable and the rest of the template stays protected.
- Add evidence from the source drawer without leaving the matter. The current draft becomes stale immediately and same-draft regeneration appends a new version without carrying forward old omission approvals.
- Inspect reading-order citations in the drawer, including exact extracted pages and an authorized link to the original PDF at the cited page.
- Supply any missing merge-field value before export; the saved correction is the attorney's approval and creates an audited version.
- Select a mapped paragraph and stream one atomic AI proposal over SSE; inspect its before-and-after text, accept or reject it, and retain a semantic activity log.
- Supply reviewed text for any non-image omission or choose **Leave blank**. Either decision creates an immutable audited version; supplied text is marked attorney-edited rather than source-grounded.
- Edit mapped/generated content controls directly inside the Word view. ONLYOFFICE force-save callbacks create a new immutable DOCX version, synchronize the edited controls back into structured draft content, and preserve every prior version. Unmapped template content remains protected.
- Undo the latest persisted operation by restoring its preceding snapshot, or restore any older snapshot from Activity. Restoring always appends a new latest version and never overwrites history.
- Compute one canonical export-readiness result on the server and return it with every draft. The browser and Word endpoint use that identical result to lock export only for unresolved omissions, null fields, stale evidence, and invalid or duplicate template mappings.
- Materialize each version as a genuine `.docx` from the immutable template plus validated model or attorney values. Code expands/contracts compatible prose exemplars, rebuilds structured rows, patches each repeated inline field independently, and replaces or removes mapped figures while preserving unrelated styles, numbering, headers, footers, relationships, and section settings. Export serves the exact reviewed version artifact.
- Run locally with PostgreSQL and inspect the undeployed AWS SAM shape for API Gateway, Lambda, SQS/DLQ, and encrypted/versioned S3.

## Quick start

Prerequisites: Node 22+, pnpm 10+, Python 3.13+, [uv](https://docs.astral.sh/uv/), Docker, and LibreOffice/`soffice` for visual DOCX QA. The local Word editor also needs enough memory for the ONLYOFFICE Community container.

```bash
cp .env.example .env
pnpm install
uv sync --project services/document-worker --locked
docker compose up -d postgres
pnpm onlyoffice:up
pnpm dev:onlyoffice
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). Add the reference DOCX and source ZIP at the repository root if you want the local **Use the supplied Steno sample packet** shortcut; those assignment artifacts are intentionally ignored by Git.

For a no-cost deterministic run, set `AI_PROVIDER=mock`. The normal configuration uses `AI_PROVIDER=openai`, `OPENAI_MODEL=gpt-5.6-sol`, `OPENAI_STORE=false`, `OPENAI_REASONING_EFFORT=high`, and up to two complete generation attempts (`AI_GENERATION_ATTEMPTS=2`) when strict output validation rejects a model variation. Each attempt is one whole-context drafting call; there is no separate evidence-review call. An Anthropic identity-linked key also requires `ANTHROPIC_WORKSPACE_ID`; ordinary Anthropic API keys do not.

The live AWS demo uses direct OpenAI rather than routing through Bedrock. Its API key remains in AWS Secrets Manager and is resolved only at container startup through the AWS Workload Credentials Provider and AWS Agent Toolkit `asm-exec` wrapper; the key is never stored in the source archive, CloudFormation parameters, EC2 user data, or deployment logs.

Live demo: [https://13.219.250.195.sslip.io](https://13.219.250.195.sslip.io). Documented release: `steno-template-library-final-20260901T215022Z` in stack `steno-v1-live-direct` (`us-east-1`).

## Verification

```bash
pnpm verify
pnpm --filter @steno/web test:e2e
python scripts/generate-gold-case-fixtures.py --help
UV_CACHE_DIR=.data/uv-cache uv run --project services/document-worker --with reportlab==4.4.9 python scripts/generate-demo-case-fixtures.py --help
UV_CACHE_DIR=.data/uv-cache uv run --project services/document-worker python scripts/verify-docx-acceptance.py --help
node scripts/run-live-ai-acceptance.mjs --help
```

`generate-demo-case-fixtures.py` builds three fully fictional, seven-source demo packets under `output/pdf/demo-cases/`: a conservative-care rear-end case, a surgical side-impact case, and a concussion/orthopedic offset-frontal case. Each packet is designed to be uploaded with the supplied Pat Donahue DOCX used only as the reviewed firm template. It includes a manifest of expected facts and forbidden template leakage markers; never mix sources between packets.

The e2e test accepts `E2E_BASE_URL`, `E2E_TEMPLATE_PATH`, `E2E_SOURCE_DIR`, `E2E_CONFIRMED_FIELD_VALUE`, `E2E_DOWNLOAD_PATH`, and async-aware timeout overrides. Without explicit fixture paths it expects the supplied local artifacts and a running deterministic development stack. See [TEST_RESULTS.md](./TEST_RESULTS.md) and [docs/PRD_ACCEPTANCE.md](./docs/PRD_ACCEPTANCE.md) for the latest local/deployed evidence and the native Word boundary.

## Repository map

```text
apps/web                 React, Vite, embedded ONLYOFFICE, browser acceptance tests
apps/api                 Fastify API, PostgreSQL workflow, AI adapters
packages/contracts       Shared Zod schemas and transport/domain types
services/document-worker Python PDF extraction and bounded OOXML operations
infra/template.yaml      Undeployed AWS SAM production shape
infra/live-demo.yaml     Deployable encrypted AWS demo stack
scripts                  Synthetic data, live-AI, and independent DOCX acceptance tools
docs                     Architecture and decision records
```

## API

- `POST /api/templates` and schema-v2-only `POST /api/templates/:id/confirm`
- `POST /api/matters`, `GET /api/matters/:id`, `PATCH /api/matters/:id`, and `POST /api/matters/:id/sources`
- `POST /api/matters/:id/generations` for initial generation or same-draft regeneration with `draftId` and `baseVersion`
- `GET /api/jobs/:id` and `GET /api/jobs/:id/events`
- `GET /api/drafts/:id`, `PUT /api/drafts/:id`, and `GET /api/drafts/:id/versions`
- `POST /api/drafts/:id/restore`
- `POST /api/drafts/:id/fields/confirm`
- `POST /api/drafts/:id/outcomes/:outcomeId/supply` or `/confirm` (Leave blank)
- `GET /api/drafts/:id/editor-config`, signed version-document retrieval, force-save, and callback routes
- `POST /api/drafts/:id/refinements`
- `POST /api/proposals/:id/accept` or `/reject`
- `GET /api/sources/:id/file`
- `GET /api/drafts/:id/export.docx`

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for data flow, storage boundaries, failure behavior, and the collaboration seam.
