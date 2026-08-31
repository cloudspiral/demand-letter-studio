# Collaboration Stretch Results

Branch: `stretch/collaboration`, based exactly on annotated tag `v1-checkpoint` (`5a7f6375e0b7dfa844ade4d385f0f903c15f3aff`).

## Implemented and verified

- Self-hosted Hocuspocus/Yjs server on `127.0.0.1:1234` with HMAC-signed local demo identities.
- Draft/workspace authorization before a collaboration document is loaded.
- Two users in separate browser contexts with live presence and named carets.
- Real-time Tiptap text convergence and reconnect from PostgreSQL-persisted Yjs state updates.
- Canonical evidence metadata embedded in Yjs nodes and deterministic reconstruction into the shared draft schema, with existing-block metadata re-anchored server-side to the persisted draft.
- Lightweight live validation plus an authoritative exact-snapshot export check.
- Validated collaborative snapshots published as citation-bearing export checkpoints and rendered through the original OOXML package.
- Debounced snapshots with monotonic versions and human-attributed semantic activity events.
- Paired human/agent actors. Each refinement is proposed by that user's agent on the user's behalf; accept/reject remains explicit and audited.
- Accepted agent proposals applied as ordinary Yjs transactions and observed by connected peers.
- Identity-aware direct edits, proposal resolution, and authenticated Word export.
- Existing single-user upload-to-export Playwright workflow retained.
- Provider tokens and API request bodies redacted from Fastify logs.

## Acceptance evidence

`apps/web/tests/collaboration.spec.ts` uses two independent Chrome contexts. It verifies Faby and Alex presence, a Faby edit converging in Alex's editor, persisted snapshot status, Alex reconnecting with the edit intact, a Faby Agent proposal accepted into both editors, human/agent activity attribution, live detection of an unsupported changed amount, and authoritative export rejection.

`apps/web/tests/studio.spec.ts` verifies a safe collaborative edit, warning refresh, agent acceptance, validated snapshot publication, and genuine Word download through the original template.

The repository gates are recorded in `TEST_RESULTS.md` after the final run.

## Remaining stretch gaps

1. Newly inserted paragraphs do not automatically have an approved Word-template destination. Editing remains fluid, but export blocks them until a future region-mapping UI assigns their placement.
2. Live semantic support checking is deliberately conservative and deterministic. It catches structural failures and unsupported amounts/dates; nuanced entailment remains an attorney-review warning rather than an automated legal conclusion.
3. Local HMAC identities are intentionally demo-only. Production collaboration still needs Cognito or another real identity/session layer, authorization policy, token rotation, and multi-instance Hocuspocus coordination.

These gaps are isolated to this stretch branch and do not change or weaken the pushed `v1-checkpoint` tag.
