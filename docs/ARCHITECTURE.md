# Architecture

## End-to-end flow

1. The API hashes an uploaded DOCX, stores it behind a local object-storage interface, and asks the Python worker to classify body paragraphs without changing the package.
2. The user confirms editable, preserved, and heading regions. The immutable original remains the export authority.
3. PDFs are extracted into `source_pages` with one-based page lineage. Images become source records with an explicit visual-review marker. Lightweight deterministic name, date, and amount candidates are stored in `facts`.
4. A generation request creates a `jobs` record and returns `202`. The local runner claims it, records progress events, and streams them over SSE. SAM represents the same boundary with SQS and a DLQ.
5. The provider adapter receives reviewed editable regions and page-aware evidence. OpenAI Responses uses strict JSON Schema; Anthropic returns JSON through the same Zod contract. Models never produce code or OOXML.
6. The API rejects citations that do not resolve to a stored source/page. Any factual block without a valid citation becomes an unsupported warning. Any confirmed editable template paragraph omitted by the model is cleared with an attorney-review placeholder, preventing completed-letter leakage.
7. A successful result creates `drafts`, `draft_versions`, and normalized `citations` in one transaction. Direct edits require the current version. Refinements create `edit_proposals`; only acceptance creates the next version.
8. Export copies every entry in the original ZIP package. It applies bounded body-paragraph patches and only evidence-verified replacements from confirmed header/footer candidates. XML parts without an actual text change remain byte-identical; opaque parts and relationships are always copied byte-for-byte.

## Trust and privacy boundaries

- API keys live only in ignored `.env` files or production secret storage. Fastify redacts request bodies, authorization, and cookies; prompts and document contents are not logged.
- Uploaded artifacts live under ignored `.data/storage`. The storage interface validates keys and provides the seam for private/versioned S3.
- Model output is untrusted data. It must pass Zod validation and citation/coverage checks before persistence.
- The model cannot execute code, write OOXML, access the filesystem, or call arbitrary tools.
- Exported text is still untrusted legal content and is visibly labeled for attorney review in the web editor.

## Persistence model

`workspaces` and `actors` establish tenancy and attribution even though v1 exposes one local user. Matters refer to confirmed templates. Source documents own pages and extracted facts. Jobs own append-only progress events and may produce a draft or enter `dead_letter_jobs`. Drafts point to an immutable current version; each version owns normalized citations. Proposals carry their base version, and all material mutations append `activity_events`. `ai_runs` records provider/model/purpose/status/latency without prompts or document contents.

## Failure behavior

- Malformed/unsupported uploads fail before a matter can generate.
- Provider/schema failures record an `ai_runs` failure and try the configured fallback once.
- Exhausted generation failures mark the job failed, emit an SSE failure event, and insert a sanitized local dead-letter record. SAM uses the SQS redrive policy for the deployment equivalent.
- Optimistic version conflicts return `409` and never overwrite newer work.
- Proposal acceptance returns `409` if the draft advanced after the proposal was created.

## Deployment shape

The local API runner and filesystem store are development adapters. `infra/template.yaml` maps the interfaces to API Gateway/Lambda, SQS with a DLQ, and encrypted/versioned/private S3. PostgreSQL remains external and is expected to use a managed private database in a deployment. Cognito is a future identity boundary, not implemented in v1.

## Collaboration seam

The v1 schema already carries workspace/actor attribution, version history, proposals, and activity semantics. The stretch branch can layer Hocuspocus/Yjs transport and snapshots over the editor while retaining proposals as the boundary for agent edits. See ADR 0004.
