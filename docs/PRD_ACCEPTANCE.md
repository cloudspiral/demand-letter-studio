# PRD Acceptance Matrix

This matrix distinguishes implementation proof from the two remaining human/external review boundaries. Detailed timings, artifacts, and negative controls are in [TEST_RESULTS.md](../TEST_RESULTS.md).

| PRD requirement | Status | Evidence |
|---|---|---|
| Generate from a real demand-letter template and relevant case materials | Pass | Live ten-source fictional case used the supplied real six-page DOCX; all 35 editable targets and all 11 expected facts passed |
| Review evidence before generation | Pass | Asynchronous category-free evidence review ran before drafting in API and deployed UI; exact citations were refetched and uncited flags were normalized to generic missing-support language |
| Add evidence and regenerate in the same matter | Pass | Live incremental case preserved v1, stale-locked export immediately after upload, refreshed review, and appended v2 to the same draft ID |
| Explicit attorney confirmation for unsupported or edited content | Pass | Warning edits, ordinary direct edits, and accepted AI proposals stayed blocked until the reviewed text and a resolution note were submitted through the confirmation endpoint |
| Canonical server-computed export readiness | Pass | Browser readiness and export `409.issues` were asserted equal; stale fingerprints, blocks, fields, duplicate mappings, and image ambiguity are computed once on the server |
| Match template structure, formatting, and layout | Strong engineering pass; native Word boundary open | Independent OOXML comparison preserved template package/formatting/geometry and six US-letter pages; all six LibreOffice pages were inspected. Microsoft Word Print Layout is unavailable on the test Mac |
| Accuracy is paramount | Pass at system/evidence layer; attorney sign-off still required | Exact contiguous quote validation, source/page refetch, complete target coverage, field provenance, missing/conflict variants, explicit confirmation, and fail-closed export |
| Attorney can further refine with AI | Pass | Exact annotations, streamed bounded proposal, visible tracked revisions, accept/reject, optimistic versioning, explicit confirmation after acceptance, and activity history passed in deployed Chrome |
| Codegen sandboxing if used | Not applicable | Runtime models return strict content JSON only; they cannot execute code, access files/tools, or write OOXML |
| Online collaboration/editing and change tracking (stretch) | Partial stretch | Direct editing, actor attribution, immutable versions, stale-write rejection, proposals, and activity exist. Simultaneous multi-user/CRDT collaboration is intentionally out of scope |
| Export to Word | Pass | Deployed Chrome downloaded a genuine `.docx`; the export endpoint used the same readiness result returned with the draft |
| Good developer experience and handoff | Pass | Shared contracts, locked worker environment, Docker, CloudFormation, unit/API/browser/live-AI tests, synthetic data generators, live runner, independent DOCX verifier, architecture, AI log, and acceptance reports |
| Reusable template library presentation | Pass | Immutable filenames and stored DOCX keys remain intact while additive display metadata provides clean names, explicit test provenance, searchable labels, timestamps, accessible tooltips, and overflow-safe cards |
| Non-streaming HTTP <=5 seconds | Pass | Public health/readiness p95 226/129 ms; review/generation/regeneration enqueue 54-155 ms; upload/extraction and export under 2.7 s |
| Database queries generally <=2 seconds | Pass | Application database readiness stayed healthy throughout concurrent job and browser testing; earlier 100-run representative query p95 was 0.791 ms |
| AI streaming / asynchronous queued work | Pass | Review and generation persist jobs and return `202`; progress is SSE; measured first events were about 49-56 ms |
| TypeScript, Python if needed, SQL | Pass | React/Fastify/shared contracts in TypeScript, deterministic document worker/QA in Python, PostgreSQL migrations/queries in SQL |
| React, NodeJS, Python, containerization, Lambda (AWS SAM) | Pass in source; live demo uses bounded EC2 shape | React UI, Node API, Python worker, production multi-stage container, and the SAM reference shape are present; the live URL runs the same container on encrypted Graviton EC2 for persistent low-friction demos |
| AWS | Pass | HTTPS public URL, CloudFormation, EC2/SSM, encrypted retained volume, private versioned S3 artifact bucket, CloudWatch alarm, and IAM-scoped runtime secret resolution |
| PostgreSQL persistence preferred | Pass | Templates, sources/pages, jobs/events/dead letters, evidence reviews/fingerprints, immutable draft versions/citations, proposals/activity, and AI-run metadata persist in PostgreSQL 17 |
| Prefer Anthropic Claude | Preference not met on final runtime | Bedrock remained blocked by AWS account-side model authorization. Direct OpenAI uses the same provider contract, grounding, confirmation, and readiness controls |
| No off-limits technology | Pass | No DeepSeek, Vercel, Heroku, Tomcat, IIS, or similar platform shortcut |
| Source code, AI usage log, test results | Pass | Repository source plus [AI_USAGE_LOG.md](../AI_USAGE_LOG.md) and [TEST_RESULTS.md](../TEST_RESULTS.md) |

## Remaining acceptance boundaries

1. Open the final complete export in desktop Microsoft Word Print Layout and compare all six pages with the reviewed template. LibreOffice is strong independent evidence but not a substitute for Word's renderer.
2. Obtain attorney review of the generated legal narrative, demand terms, evidence interpretations, confirmations, and warnings. Engineering checks prove grounding and fail-closed behavior, not legal judgment.
