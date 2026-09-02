# Architecture

## End-to-end flow

1. The API hashes an uploaded DOCX, stores it behind a local object-storage interface, and asks the Python worker to classify body paragraphs without changing the package.
2. A compact post-analysis check lets the user confirm editable, preserved, and heading regions. The immutable original remains the export authority.
3. PDFs are extracted into `source_pages` with one-based page lineage. Images become source records with an explicit visual-review marker. Lightweight deterministic name, date, and amount candidates are stored in `facts`.
4. An evidence-review request creates an `evidence_review` job and returns `202`. The selected provider returns category-free flags under one strict contract. Exact quotes are validated before persistence; a flag without a valid citation is reduced to the generic statement that supporting evidence was not located. Flags are explicitly non-exhaustive and never determine document authenticity or legal validity.
5. A generation request creates a `generation` job and returns `202`. The local runner claims it, records progress events, and streams them over SSE. OpenAI Responses, Anthropic, and Bedrock use the same strict review/generation contracts. Models never produce code or OOXML.
6. The API accepts a citation only when its source/page exists and its normalized quote is actually present in that extracted page. Any factual block without a valid quoted citation becomes an unsupported warning. Any confirmed editable template paragraph omitted by the model is represented as an attorney-review item, preventing completed-letter leakage.
7. A successful initial result creates `drafts`, `draft_versions`, and normalized `citations` in one transaction. A source fingerprint is stored with every version. Adding evidence changes the matter fingerprint immediately, making the visible version stale and unexportable. Regeneration requires the current draft ID and base version, rejects concurrent jobs or changed sources, and appends the next version to the same draft.
8. The UI reveals sections only after a complete result passes validation; SSE reports job progress, not unvalidated model text. During regeneration it keeps the old version visible and restarts the progressive reveal when the next immutable version arrives.
9. Direct edits autosave on blur with an optimistic version check but clear verification and confirmation. Accepting an AI proposal does the same. Either path remains an export blocker until the attorney separately confirms the reviewed replacement text and provides a resolution note. A refinement contains up to five exact block/range annotations and uses SSE from the first status event through one atomic multi-block `edit_proposal`; acceptance validates every target against the proposal base version and applies all edits or none.
10. Draft fields carry confidence, source/page provenance, and explicit user-confirmation state. Confirming or correcting a field creates a new draft version and activity event. One server function computes canonical export readiness for block state, placeholders, fields, duplicate paragraph mappings, image cardinality, and source-fingerprint staleness. Draft responses and the export endpoint use the same object; review flags link to blockers but never create an independent legal-validity gate.
11. Once ready, export copies every entry in the original ZIP package. The worker maps changed text across existing `w:t` nodes instead of flattening runs, preserving run properties, tabs, fields, bookmarks, hyperlinks, breaks, paragraph properties, and section geometry. It updates a `mailto:` relationship only when its displayed email changes and replaces only an explicitly mapped body media part while preserving its drawing relationship, crop, and size. Parts without an actual change remain byte-identical.

## Trust and privacy boundaries

- API keys live only in ignored `.env` files or production secret storage. The live EC2 host retrieves its one permitted Secrets Manager ARN through the localhost-only AWS Workload Credentials Provider, and `asm-exec` passes the resolved OpenAI key only when starting the application container. Fastify redacts request bodies, authorization, and cookies; prompts and document contents are not logged.
- Uploaded artifacts live under ignored `.data/storage`. The storage interface validates keys and provides the seam for private/versioned S3. The live demo stores them on an encrypted retained volume; release archives live in a private versioned S3 bucket.
- Model output is untrusted data. It must pass Zod validation and citation/coverage checks before persistence.
- The model cannot execute code, write OOXML, access the filesystem, or call arbitrary tools.
- Exported text is still untrusted legal content and is visibly labeled for attorney review in the web editor.

## Persistence model

`workspaces` and `actors` establish tenancy and attribution even though v1 exposes one local user. Matters refer to confirmed templates. Source documents own pages and extracted facts. Jobs own append-only progress events, a source fingerprint, and strict review or generation results; exhausted jobs may enter `dead_letter_jobs`. Drafts point to an immutable current version; each version owns a source fingerprint, normalized citations, and field provenance. Proposals carry their base version and complete edit set. Evidence addition/review, generation/regeneration, direct edits, explicit block and field confirmations, proposal decisions, and exports append `activity_events`. Refine-panel chat messages remain session-local. `ai_runs` records provider/model/purpose/status/latency without prompts or document contents.

## Failure behavior

- Malformed/unsupported uploads fail before a matter can generate.
- Provider/schema failures record an `ai_runs` failure and try the configured fallback once.
- Exhausted generation failures mark the job failed, emit an SSE failure event, and insert a sanitized local dead-letter record. SAM uses the SQS redrive policy for the deployment equivalent.
- Optimistic version conflicts return `409` and never overwrite newer work.
- A generation rejects duplicate active generation jobs, a stale base version, or sources that change while the model is running. Evidence review likewise rejects a result if its source fingerprint became stale before persistence.
- Proposal acceptance returns `409` if the draft advanced after the proposal was created.
- Word export returns `409` with the same canonical readiness object returned by draft reads until every concrete blocker is resolved; internal review warnings are never written into the DOCX.
- A template with body image candidates exports only when V1 can prove exactly one mapped slot and one uploaded ready image; unsupported/unsafe images and ambiguous mappings fail closed.

## Deployment shape

The SAM template in `infra/template.yaml` maps the serverless interfaces to API Gateway/Lambda, SQS with a DLQ, and encrypted/versioned/private S3. The current live demo uses the deployable `infra/live-demo.yaml` CloudFormation stack: Caddy HTTPS fronts one encrypted Graviton EC2 host running isolated app and PostgreSQL containers, with a retained encrypted data volume and private versioned release bucket. Runtime OpenAI credentials resolve from one scoped Secrets Manager ARN through the AWS Workload Credentials Provider and `asm-exec`. This bounded demo keeps the local filesystem/PostgreSQL adapters intact; a larger production deployment should move PostgreSQL to a managed private database and document storage to S3.

## V1 scope boundary

The v1 is deliberately single-user. It keeps actor attribution, optimistic concurrency, immutable version history, proposals, and activity semantics, but does not include live cursors, collaborator simulation, WebSockets, Yjs, CRDTs, authentication, or simultaneous multi-user editing. Those are stretch/security boundaries, not hidden claims about the current demo.
