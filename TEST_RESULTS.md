# Test Results

Last run: 2026-09-01 on macOS with Node 22.23, locked Python 3.13 worker dependencies, Google Chrome, headless LibreOffice, and the live AWS deployment at `https://13.219.250.195.sslip.io` in `us-east-1`.

## Final automated gates

| Gate | Result |
|---|---|
| `pnpm verify` | Passed: typecheck; 4 contract, 41 API, 2 web-client, and 10 Python worker tests (57 total); production API/web build |
| Local Playwright workflows | Passed 2 tests in 11.3 seconds with the deterministic provider, including long-name containment at desktop and narrow widths |
| Deployed template-picker Playwright | Passed in 1.6 seconds against the public AWS bundle; live API metadata and a real-record screenshot were independently inspected |
| Final deployed Playwright workflow | Passed in 8.6 minutes against the public URL and live OpenAI runtime |
| Complete ten-source live AI workflow | Passed: evidence review, 35/35 editable mappings, 61 independently refetched citation quotes, explicit post-refinement confirmation, canonical readiness, and Word export |
| Incremental live AI workflow | Passed: v1, supplemental upload, immediate stale lock, refreshed review, same-draft v2 regeneration, and ready Word export |
| Missing, conflicting, and authorized supplied-packet workflows | Passed fail-closed assertions: each returned the expected `409` export lock with zero invalid citations |
| Independent OOXML/render acceptance | Passed: intended package-part changes only, six US-letter pages, and all six page PNGs inspected |

Coverage includes template display-name normalization, repeated content-address prefixes, explicit test provenance, firm promotion/no-demotion, long-name card containment, review-flag validation, malformed and non-verbatim citations, source fingerprints, stale evidence reviews, duplicate active jobs, immutable regeneration versions, stale base versions, explicit block confirmation, direct and AI edits remaining unverified, canonical export-readiness parity, template coverage, ambiguous image mapping, exact annotation ranges, atomic proposal acceptance, tracked-change rejection, fact extraction, run-safe OOXML patching, split-deadline handling, body-image replacement, and package-part preservation.

## Live AWS latency

The deployed stack `steno-v1-live-direct` is `CREATE_COMPLETE` on an encrypted `t4g.small` Graviton host with PostgreSQL 17 and direct OpenAI `gpt-5.6-sol`. Model completion time is reported separately from synchronous request latency.

| Measurement | Observed | PRD threshold | Result |
|---|---:|---:|---|
| Public `/api/health`, 30 requests | p50 45.1 ms; p95 226.1 ms; max 281.1 ms | <=5 s non-streaming | Pass |
| Public `/api/ready`, 30 requests | p50 45.4 ms; p95 128.6 ms; max 132.3 ms | <=5 s non-streaming | Pass |
| Initial evidence-review enqueue | 54.5 ms with `202` | <=5 s non-streaming | Pass |
| Initial generation enqueue | 146.5 ms with `202` | <=5 s non-streaming | Pass |
| Refreshed review / regeneration enqueue | 54.5 ms / 146.6 ms with `202` | <=5 s non-streaming | Pass |
| SSE first event: review / generation / refinement | 53.8 ms / 49.5 ms / 54.3 ms | Streaming preferred | Pass |
| Ten-source upload plus extraction | 2.603 s | <=5 s non-streaming | Pass |
| Supplemental upload plus extraction | 297.7 ms | <=5 s non-streaming | Pass |
| Ready Word export | 2.669 s | <=5 s non-streaming | Pass |

The complete-case evidence review took 80.651 seconds, generation 148.020 seconds, and refinement 3.696 seconds. The incremental flow measured 103.859-second initial review, 158.725-second initial generation, 99.062-second refreshed review, and 160.040-second regeneration. These are asynchronous job/model durations: the initiating requests returned in 54-155 ms and progress arrived over SSE.

Across the retained final-host audit, 12 evidence reviews completed in 75.961-129.728 seconds, 32 generations completed in 16.607-178.810 seconds, and 13 refinements completed in 3.015-13.975 seconds. One evidence-review response satisfied the earlier provider JSON Schema but violated a stricter downstream Zod length bound; the job failed closed. The provider schema is now generated from the same `ReviewFlag` contract, the new regression test passes, and subsequent incremental and browser workflows passed. The single historical failed/dead-letter record is intentionally retained for auditability.

## Evidence-packet acceptance matrix

| Packet | Live result | Why |
|---|---|---|
| Complete fictional gold case, 10 sources | Pass; export ready; 35/35 mappings; 61 valid citations; 0 blockers; all 11 expected facts present | Proves review, drafting, refinement, explicit confirmation, readiness, image replacement, and six-page export |
| Missing-critical variant, 3 sources | Pass; export locked `409`; 20 warning regions; 1 unresolved field; 24 valid citations | Proves absent treatment, damages, work, authorization, and deadline support cannot silently pass |
| Deliberately conflicting variant, 10 sources | Pass; export locked `409`; 5 warning regions; 1 unresolved field; 91 valid citations | Proves source conflicts are evidence-linked and not resolved by guessing |
| Incremental fictional case, 9 then 10 sources | Pass; v1 became stale immediately after upload; same draft regenerated to v2; 71 valid citations; export ready | Proves add-evidence and same-matter regeneration with immutable history |
| Authorized supplied packet, 5 sources | Pass; export locked `409`; 19 warning regions; 1 unresolved field; 49 valid citations | Bills and a photograph do not support all liability, recipient, policy, chronology, authorization, and damages targets required by this template |

The supplied-packet runs were performed only after the user explicitly authorized retransmission to the configured external provider. No credentials were transmitted, and OpenAI storage remained disabled.

## DOCX verification

The independently verified complete live export is `.data/qa/live-acceptance/Steno-live-acceptance.docx`, SHA-256 `f7ae9ddd2e83b62f8353eb5afa028e78916b48b3ffe28b4c54b2c47cc13da871`.

- The input and output retain the same package structure. Only `word/document.xml`, `word/header1.xml`, its document relationships, and the explicitly mapped `word/media/image1.png` changed.
- Paragraph/run properties, hyperlinks, bookmarks, fields, drawings, tabs, breaks, relationship IDs, section geometry, styles, numbering, settings, themes, logos, and unrelated media were preserved.
- Old claimant/claim/contact markers and the internal attorney-review marker are absent; every expected synthetic fact is present.
- Headless LibreOffice rendered both documents as six 612x792-point US-letter pages, and every candidate page was visually inspected for clipping, overlap, tables, images, and header/footer drift.
- LibreOffice exposes an inherited template header/body overlap on continuation boundaries: the original already clips the repeating header on page 6, while content redistribution can move that overlap to another continuation page. The exporter preserves the template geometry rather than silently rewriting the firm layout.
- Native Microsoft Word Print Layout remains **unverified** because Word is not installed on this Mac. LibreOffice verification is not mislabeled as native Word proof.

The independent report is `.data/qa/live-acceptance/docx-acceptance.json`; it has no warnings or failures. The deployed browser also downloaded `/private/tmp/steno-redesigned-live-final.docx` after canonical readiness became ready.

## Deployment and runtime checks

- Final documented artifact target: `steno-template-library-final-20260901T215022Z`; the release archive is uploaded to the private versioned CloudFormation bucket and deployed through SSM with runtime-only Secrets Manager resolution.
- The additive template migration retained all three live records: both synthetic fixtures are labeled `isTest: true`, the firm record remains `isTest: false`, and the hash-prefixed AAA storage filename now exposes the clean display name `AAA Insurance - Time Limited Policy Limits Demand - Pat Donahue` without altering the stored DOCX or existing matter references.
- The deployed picker served the new JS/CSS bundle, passed the automated overflow boundary assertions, and was visually inspected at 1440x900: all titles, provenance labels, counts, and test timestamps stayed within their cards.
- The exact verified dirty working tree is packaged with `git ls-files -co --exclude-standard`; no reset, stash, clean, or unrelated staging is used.
- EC2 instance, system, and attached-EBS reachability checks passed; SSM was online; the CloudWatch instance-status alarm was `OK`; public database/storage/document-worker/OpenAI readiness was green.
- Final database audit before documentation packaging: 12 completed evidence-review jobs, 32 completed generation jobs, 13 completed refinements, no queued/processing jobs, and the one intentionally retained pre-repair failed/dead-letter record described above.
- Unsupported formats, macros, tracked changes, unsafe images, malformed packages, ambiguous image mappings, unsupported facts, unconfirmed edits, duplicate mappings, stale evidence, and stale versions fail closed.
- Request bodies, credentials, prompts, source contents, and resolved secret values are excluded from logs. `ai_runs` stores only provider/model/purpose/status/latency and sanitized error metadata.
