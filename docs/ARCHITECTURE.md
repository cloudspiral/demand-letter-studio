# Architecture

## End-to-end flow

1. The API hashes an uploaded DOCX, stores the immutable original behind a local object-storage interface, and asks the Python worker for schema-v2 structural analysis. OOXML anchors (`paragraph`, `table-cell`, `header`, or `footer`) remain separate from semantic kinds (`heading`, `prose`, or `figure`).
2. Analysis captures paragraph/run formatting, alignment, indentation, numbering, spacing, real Word tables, paragraph-based row groups, image relationships, and caption anchors. The annotated-letter workbench lets the user confirm Keep/Replace decisions and replaceable inline fields while the complete original letter remains visible.
3. Application code derives stable narrative, structured, and figure generation targets. Consecutive compatible Replace prose becomes one elastic run; headings, Keep blocks, figures, groups, and incompatible styles form hard boundaries. Runs are derived, not persisted as user-editable map entities.
4. PDFs are extracted into `source_pages` with one-based page lineage. Standalone image uploads retain their media for figure replacement. An evidence-review job returns target-scoped advisory flags and field proposals; exact source/page quotes are validated before persistence.
5. A matter may record a one-click pre-generation omission against a stable target and current source fingerprint. The actor and timestamp are audited. Adding evidence changes the fingerprint, so prior decisions become stale instead of silently transferring.
6. One whole-document generation request receives the complete confirmed map, every derived target, all evidence, and current pre-approvals. It must return exactly one explicit outcome for every generation target and replacement field. Narrative targets allow 1-12 paragraphs, structured targets 1-50 rows, and zero content requires an explicit omission outcome.
7. Before reveal, code validates exact coverage, IDs, bounds, citation existence and page validity, standalone figure media, cited not-applicable decisions, current resolution fingerprints, and previous-matter leakage. A failure reveals no partial letter. Models never produce code or OOXML.
8. A successful result creates `drafts`, `draft_versions`, normalized `citations`, and explicit outcomes in one transaction. The clean letter and right-side Review workbench synchronize document markers with Blocking, Needs verification, and Informational cards. Sources, refinement, and activity occupy sibling tabs.
9. A post-generation no-evidence approval creates a new immutable draft version plus a matter resolution. Direct edits and accepted AI proposals also create versions but become unverified until separately reviewed. Refinement remains a bounded, atomic multi-block proposal flow.
10. One server function computes canonical readiness for unverified blocks/fields, unresolved omission outcomes, true cross-target anchor collisions, source staleness, and resolution staleness. Draft reads and Word export use the same object. Pre-approved or confirmed omissions pass; unresolved no-evidence omissions block; cited not-applicable omissions are informational.
11. Once ready, export copies the original ZIP package and applies only deterministic target operations. Narrative runs clone/remove compatible exemplars, real tables preserve their shell while body rows change, paragraph-based groups rebuild their row/total styles, and figures replace the exact media part or remove both figure and caption. Inline fields are substituted across existing runs without flattening surrounding styling; unrelated package entries remain byte-identical.

## Trust and privacy boundaries

- API keys live only in ignored `.env` files or production secret storage. The live EC2 host retrieves its one permitted Secrets Manager ARN through the localhost-only AWS Workload Credentials Provider, and `asm-exec` passes the resolved OpenAI key only when starting the application container. Fastify redacts request bodies, authorization, and cookies; prompts and document contents are not logged.
- Uploaded artifacts live under ignored `.data/storage`. The storage interface validates keys and provides the seam for private/versioned S3. The live demo stores them on an encrypted retained volume; release archives live in a private versioned S3 bucket.
- Model output is untrusted data. It must pass Zod validation and citation/coverage checks before persistence.
- The model cannot execute code, write OOXML, access the filesystem, or call arbitrary tools.
- Exported text is still untrusted legal content and is visibly labeled for attorney review in the web editor.

## Persistence model

`workspaces` and `actors` establish tenancy and attribution even though the current app exposes one local user. Matters pin a specific schema-v2 map version. Source documents own pages and extracted facts. `matter_review_resolutions` keys an omission action by matter, stable target, and source fingerprint, with optional draft/version attribution for post-generation confirmation. Jobs own append-only progress events and strict review/generation results; drafts point to an immutable current version whose content includes explicit target outcomes. Proposals carry their base version and complete edit set. Every review, resolution, generation, edit, proposal decision, and export appends `activity_events`. `ai_runs` records provider/model/purpose/status/latency without prompts or document contents.

## Failure behavior

- Malformed/unsupported uploads fail before a matter can generate.
- Provider/schema failures record an `ai_runs` failure and try the configured fallback once.
- Exhausted generation failures mark the job failed, emit an SSE failure event, and insert a sanitized local dead-letter record. SAM uses the SQS redrive policy for the deployment equivalent.
- Optimistic version conflicts return `409` and never overwrite newer work.
- A generation rejects duplicate active generation jobs, a stale base version, or sources that change while the model is running. Evidence review likewise rejects a result if its source fingerprint became stale before persistence.
- Proposal acceptance returns `409` if the draft advanced after the proposal was created.
- Word export returns `409` with the same canonical readiness object returned by draft reads until every concrete blocker is resolved; internal review warnings are never written into the DOCX.
- A generated figure exports only when its outcome selects the exact ID of a ready standalone uploaded image with a supported media type. Rendered PDF pages may support visual review but cannot become replacement media; unsupported or missing images fail closed.

## Deployment shape

The SAM template in `infra/template.yaml` maps the serverless interfaces to API Gateway/Lambda, SQS with a DLQ, and encrypted/versioned/private S3. The current live demo uses the deployable `infra/live-demo.yaml` CloudFormation stack: Caddy HTTPS fronts one encrypted Graviton EC2 host running isolated app and PostgreSQL containers, with a retained encrypted data volume and private versioned release bucket. Runtime OpenAI credentials resolve from one scoped Secrets Manager ARN through the AWS Workload Credentials Provider and `asm-exec`. This bounded demo keeps the local filesystem/PostgreSQL adapters intact; a larger production deployment should move PostgreSQL to a managed private database and document storage to S3.

## Current local scope boundary

The local schema-v2 implementation is deliberately single-user. It keeps actor attribution, optimistic concurrency, immutable version history, proposals, and activity semantics, but does not include live cursors, collaborator simulation, WebSockets, Yjs, CRDTs, authentication, or simultaneous multi-user editing. The documented public AWS demo was not changed as part of this local-only redesign.
