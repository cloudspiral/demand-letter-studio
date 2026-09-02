# Architecture

## End-to-end flow

1. The API hashes an uploaded DOCX, stores the immutable original behind a local object-storage interface, and asks the Python worker for schema-v2 structural analysis. OOXML anchors (`paragraph`, `table-cell`, `header`, or `footer`) remain separate from semantic kinds (`heading`, `prose`, or `figure`).
2. Analysis captures paragraph/run formatting, alignment, indentation, numbering, spacing, real Word tables, paragraph-based row groups, image relationships, and caption anchors. The annotated-letter workbench lets the user confirm Keep/Replace decisions and replaceable inline fields while the complete original letter remains visible.
3. Application code derives stable narrative, structured, and figure generation targets. Consecutive compatible Replace prose becomes one elastic run; headings, Keep blocks, figures, groups, and incompatible styles form hard boundaries. Runs are derived, not persisted as user-editable map entities.
4. PDFs are extracted into `source_pages` with one-based page lineage. Standalone image uploads retain their media for figure replacement. A saved template now proceeds directly to generation; a new template proceeds after the attorney confirms its Keep/Replace map. There is no evidence-review job, advisory model pass, or pre-generation omission state.
5. One whole-context generation request receives the complete confirmed map, every derived target, all evidence, and every replaceable inline field. It must return exactly one `generated` or `omitted` result per target and one nullable result per field. Missing, ambiguous, and conflicting evidence use the same omission shape and concise note; conflicts may cite both sources without introducing another status. Affirmatively supported negative facts remain cited generated prose.
6. Before persistence, code validates exact target and field coverage, IDs, bounds, conditional notes and citations, exact source-page quotes, standalone figure media, structured-row shape, the current source fingerprint, and previous-matter leakage. Missing, duplicate, unknown, malformed, uncited, stale, or leaking output rejects the whole attempt; no partial letter is revealed. Models never produce code or OOXML.
7. A successful result creates or advances `drafts`, `draft_versions`, normalized `citations`, and explicit outcomes in one transaction. The first successful draft can derive the neutral matter's name from grounded claimant and claim-number fields. A manual rename sets a sticky flag so regeneration never overwrites attorney intent.
8. The completed draft opens in the letter workspace. Its Review panel derives one actionable card per unresolved omitted target or null field, plus concrete stale-evidence and mapping blockers. It does not persist or display duplicate warning or review-flag taxonomies.
9. Confirming an omission, supplying a missing field, editing existing text, accepting an AI proposal, restoring history, or undoing persisted work always appends a new immutable version snapshot. "Immutable" describes historical snapshots, not the editor: the attorney may freely change all existing generated, Keep, heading, header, and footer text. Original citation pills remain attached after edits but receive an Attorney edited label because the changed wording is not revalidated.
10. Omission confirmation lives in the snapshot's `confirmedOmissionTargetIds`. If confirming every target below a heading would leave no content in that section, deterministic code blanks the heading text in the same version while preserving its original paragraph anchor. Adding evidence changes the fingerprint, marks the current version stale, and regeneration starts from the complete updated packet without inheriting prior confirmations.
11. One server function computes readiness from unresolved omitted targets, null fields, stale evidence, and invalid or cross-target duplicate mappings. Draft reads and Word export use the same object. Once ready, export copies the original ZIP package, applies deterministic target operations and inline fields, and patches attorney-edited anchored paragraphs. Unrelated package entries remain unchanged.

## Trust and privacy boundaries

- API keys live only in ignored `.env` files or production secret storage. The live EC2 host retrieves its one permitted Secrets Manager ARN through the localhost-only AWS Workload Credentials Provider, and `asm-exec` passes the resolved OpenAI key only when starting the application container. Fastify redacts request bodies, authorization, and cookies; prompts and document contents are not logged.
- Uploaded artifacts live under ignored `.data/storage`. The storage interface validates keys and provides the seam for private/versioned S3. The live demo stores them on an encrypted retained volume; release archives live in a private versioned S3 bucket.
- Model output is untrusted data. It must pass Zod validation and citation/coverage checks before persistence.
- The model cannot execute code, write OOXML, access the filesystem, or call arbitrary tools.
- Exported text is still untrusted legal content and is visibly labeled for attorney review in the web editor.

## Persistence model

`workspaces` and `actors` establish tenancy and attribution even though the current app exposes one local user. Matters pin a specific schema-v2 map version and track whether their name was manually edited. Source documents own pages and extracted facts. Jobs own append-only progress events and generation results. Drafts point to a current version while `draft_versions` retain immutable content, source fingerprint, template-map version, omission confirmations, actor, timestamp, and a free-text change summary. Proposals carry their base version and complete edit set. Generation, omission confirmation, field correction, direct editing, proposal decisions, restoration, rename, and export append `activity_events`. `ai_runs` records provider/model/purpose/status/latency without prompts or document contents. Legacy evidence-review and resolution rows remain inert audit history and are consulted only for backward normalization where necessary; new versions do not write their schemas.

## Failure behavior

- Malformed/unsupported uploads fail before a matter can generate.
- Provider/schema failures record a failed `ai_runs` entry. Generation may retry the primary provider with the same complete contract up to the configured bounded attempt count before trying the configured fallback once; no retry is misrecorded as completed before validation and assembly succeed.
- Exhausted generation failures mark the job failed, emit an SSE failure event, and insert a sanitized local dead-letter record. SAM uses the SQS redrive policy for the deployment equivalent.
- Optimistic version conflicts return `409` and never overwrite newer work.
- A generation rejects duplicate active generation jobs, a stale base version, or sources that change while the model is running.
- Proposal acceptance returns `409` if the draft advanced after the proposal was created.
- Word export returns `409` with the same canonical readiness object returned by draft reads until every concrete blocker is resolved. No advisory warning or review-flag layer participates in readiness.
- A generated figure exports only when its outcome selects the exact ID of a ready standalone uploaded image with a supported media type. Rendered PDF pages may support visual review but cannot become replacement media; unsupported or missing images fail closed.

## Deployment shape

The SAM template in `infra/template.yaml` maps the serverless interfaces to API Gateway/Lambda, SQS with a DLQ, and encrypted/versioned/private S3. The current live demo uses the deployable `infra/live-demo.yaml` CloudFormation stack: Caddy HTTPS fronts one encrypted Graviton EC2 host running isolated app, PostgreSQL, and ONLYOFFICE containers, with a retained encrypted data volume and private versioned release bucket. Caddy publishes the app and editor on separate IP-derived HTTPS hostnames while their origin ports stay loopback-only; the app and editor communicate over the private `steno-internal` Docker network. Runtime OpenAI and dedicated ONLYOFFICE JWT credentials resolve from scoped Secrets Manager ARNs through the AWS Workload Credentials Provider and `asm-exec`. This bounded demo keeps the local filesystem/PostgreSQL adapters intact; a larger production deployment should move PostgreSQL to a managed private database and document storage to S3.

## Current local scope boundary

The local schema-v2 implementation is deliberately single-user. It keeps actor attribution, optimistic concurrency, immutable version history, proposals, and activity semantics, but does not include live cursors, collaborator simulation, WebSockets, Yjs, CRDTs, authentication, or simultaneous multi-user editing. The documented public AWS demo was not changed as part of this local-only redesign.
