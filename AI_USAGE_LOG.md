# AI Usage Log

## Development

Codex was used to inspect the assignment, supplied design handoffs, sample packet, and reference DOCX; implement the repository; generate tests and documentation; deploy to AWS; and perform browser, database, latency, and document QA. Generated code was typechecked, tested, built in the production container, exercised against live PostgreSQL, and visually inspected rather than accepted without verification.

Codex ImageGen created one fully fictional, non-identifying blue-hatchback damage photograph for the synthetic gold packet. It contains no people, logos, readable plate, watermark, or real claim data. The application then exercised its deterministic template-image replacement path with that fixture.

## Application runtime

| Purpose | Provider/model | Data sent | Guardrails |
|---|---|---|---|
| Initial draft | OpenAI Responses / configured `gpt-5.6-sol` | Neutral matter label, complete confirmed schema-v2 map, derived narrative/structured/figure targets, replaceable inline fields, extracted page text and allowed image inputs, source/page IDs | One whole-context call per attempt; at most two primary attempts by default; `store: false`; model does not author the document title; strict JSON Schema and Zod parse; exactly one generated/omitted outcome per target and one nullable value per field; conditional notes/citations; paragraph/row limits; exact quote, source/page/media, fingerprint, and previous-matter leakage validation |
| Comparison/fallback | Anthropic Messages / configured model | Same bounded generation context | JSON-only prompt, Zod parse, same grounding and coverage validation; adapter tested but not used on the final host |
| Refinement | Same configured provider chain | Attorney instruction, up to five exact block/range annotations, page-aware evidence | On-demand only; immediate SSE status, bounded edit proposal, exact target validation, explicit accept/reject, atomic version check; acceptance itself is approval |
| Tests | Deterministic mock adapter | Synthetic fixture text and images | Exact outcomes for every target/field; no external model call or API spend |

Models never receive API keys, execute code, access the filesystem, or generate OOXML. Prompts and document contents are not written to application logs. The Python worker, not the model, performs deterministic package updates. There is no separate evidence-review or audit-model call: omissions and null fields from generation become the actionable post-generation review items. Deterministic grounding, exact coverage, snapshot versioning, attorney decisions, and server-computed export readiness remain authoritative.

## Live validation

- On 2026-09-02, the authorized post-redesign local OpenAI browser acceptance transmitted only the fictional supplied sample packet with `store: false` and passed end to end in 2.1 minutes. The first whole-context attempt completed in 112.919 seconds, validated 9/9 target outcomes and 17/17 nullable field outcomes, and persisted 5 generated plus 4 omitted targets. Browser remediation confirmed all 4 omissions, supplied all missing values, saved direct edits, accepted a 7.036-second OpenAI refinement without a second confirmation, advanced the immutable history to v17, and downloaded a ready Word export.
- Earlier development attempts were not counted as passes: one exceeded the original 180-second browser budget while still processing, one was rejected for unsupported previous-case leakage, and one was rejected for a non-verbatim citation. The final implementation removes model-authored titles, explicitly lists forbidden previous-case values, preserves the deterministic leakage and exact-quote gates, records success only after validation/assembly, and permits one bounded retry of the same whole-context contract.

### Historical pre-redesign runs

- The 2026-09-02 local schema-v2 acceptance used a fully fictional seven-source matter. After repairing a nested OpenAI strict-schema requirement, `gpt-5.6-sol` returned 9/9 target outcomes, 17/17 inline-field outcomes, and 17 generated blocks under the complete-map contract. The queued API persisted 6 generated and 3 explicit no-evidence omissions; audited confirmation of the three omissions advanced the draft to v4 and made canonical readiness ready.
- The same run proved that heading fields may reformat a date/name/reference/amount only when an exact citation from the declared source/page grounds the value. Standalone uploaded images may replace mapped figure media; rendered PDF pages remain review context and are never inserted as replacement media.

- The final AWS runtime used direct OpenAI because Bedrock model invocation remained blocked by AWS account-side authorization. The Bedrock and Anthropic adapters remain behind the same contract; provider choice does not weaken validation.
- The complete fictional case used ten sources and the real six-page Word template. `gpt-5.6-sol` produced 35/35 editable regions and 61 citation quotes that were independently refetched and found verbatim on their cited pages. All eleven semantic expectations were present; a streamed refinement was accepted, explicitly confirmed, and exported.
- Missing-critical and deliberately conflicting packets returned `409` rather than fabricating facts. The incremental packet proved v1 stale-locking and same-draft v2 regeneration after one supplemental source.
- After the user explicitly authorized external processing, the five-source supplied packet was retransmitted for a fresh live test. It produced 49 valid citations but correctly left 19 template regions and one field unresolved; export stayed locked.
- The final deployed Chrome workflow exercised initial review, advisory-flag drafting, source-drawer upload, stale readiness/export parity, same-draft v2 regeneration, warning edits remaining blocked, explicit confirmation, AI proposal acceptance plus confirmation, activity, and Word download.
- Across the retained final-host audit, 12 evidence reviews, 32 generations, and 13 refinements completed. Completed evidence reviews took 75.961-129.728 seconds, generations 16.607-178.810 seconds, and refinements 3.015-13.975 seconds.
- One live evidence-review output exposed a schema-drift defect: the response satisfied the earlier provider JSON Schema but exceeded a stricter downstream Zod bound. The job failed closed and remains in the dead-letter audit. The provider schema is now generated from the same `ReviewFlag` contract, has regression coverage, and subsequent incremental and deployed-browser runs passed.
- One earlier model variation returned a non-verbatim citation and was rejected by the validator. Another duplicated a split deadline time; versioned template analysis plus deterministic post-processing now keep the date in the editable paragraph and the grounded time in its preserved continuation. Both defects have regression coverage.
- Provider errors are sanitized before job/dead-letter persistence; prompts, source contents, credentials, and resolved secrets are excluded.
