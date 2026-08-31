# AI Usage Log

## Development

Codex was used to inspect the assignment, supplied design handoff, sample packet, and reference DOCX; make architecture decisions with the user; implement the repository; write tests and documentation; and run browser/document QA. Generated code was typechecked, tested, exercised against live PostgreSQL, and visually inspected rather than accepted without verification.

## Application runtime

| Purpose | Provider/model | Data sent | Guardrails |
|---|---|---|---|
| Initial draft | OpenAI Responses / configured `gpt-5.6-sol` | Matter label, confirmed editable template text, extracted page text, source/page IDs | `store: false`, strict JSON Schema, Zod parse, citation resolution, editable-region coverage guard |
| Comparison/fallback | Anthropic Messages / configured `claude-opus-5` | Same bounded generation context | JSON-only prompt, Zod parse, same grounding and coverage validation |
| Refinement | Same configured provider chain | Instruction, one selected paragraph, page-aware evidence | Proposal only; exact target required; explicit accept/reject |
| Tests | Deterministic mock adapter | Synthetic or supplied local fixture text | No network or API spend |

Models never receive API keys, execute code, access the filesystem, or generate OOXML. Prompts and document contents are not written to application logs. Provider/model/status/latency metadata is stored in `ai_runs`; token fields are available for adapters that expose stable counts.

## Live validation notes

- The first OpenAI attempt failed closed because the initial strict response schema used a dynamic object map unsupported by the provider’s strict-schema rules. The schema was narrowed and the parsed domain object adds an empty field map deterministically.
- The checkpoint `gpt-5.6-sol` run completed in 73.241 seconds using the strict generation schema. Fourteen factual blocks resolved citations to uploaded source pages, the claim-header value was independently grounded, and eighteen unfilled case-specific template regions were cleared to attorney-review markers before export. Reusable settlement boilerplate remained untouched.
- The supplied Anthropic credential is identity-linked and requires `ANTHROPIC_WORKSPACE_ID`; the adapter now supports that optional header. An ordinary Anthropic API key does not need it.
- The Anthropic comparison/fallback path is unit-tested through the common adapter contract but was not live-validated because no workspace ID was configured. OpenAI is the verified primary path for this checkpoint.
- Provider errors are sanitized and truncated before reaching job/dead-letter metadata; prompts and source contents are excluded.
