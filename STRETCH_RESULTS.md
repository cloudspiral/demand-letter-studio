# Collaboration Stretch Results

Branch: `stretch/collaboration`, based exactly on annotated tag `v1-checkpoint` (`5a7f6375e0b7dfa844ade4d385f0f903c15f3aff`).

## Implemented and verified

- Self-hosted Hocuspocus/Yjs server on `127.0.0.1:1234` with HMAC-signed local demo identities.
- Draft/workspace authorization before a collaboration document is loaded.
- Two users in separate browser contexts with live presence and named carets.
- Real-time Tiptap text convergence and reconnect from PostgreSQL-persisted Yjs state updates.
- Debounced snapshots with monotonic versions and human-attributed semantic activity events.
- Paired human/agent actors. Each refinement is proposed by that user's agent on the user's behalf; accept/reject remains explicit and audited.
- Identity-aware direct edits, proposal resolution, and authenticated Word export.
- Existing single-user upload-to-export Playwright workflow retained.
- Provider tokens and API request bodies redacted from Fastify logs.

## Acceptance evidence

`apps/web/tests/collaboration.spec.ts` uses two independent Chrome contexts. It verifies Faby and Alex presence, a Faby edit converging in Alex's editor, persisted snapshot status, Alex reconnecting with the edit intact, a Faby Agent proposal, explicit rejection, and human/agent entries in activity history.

The repository gates are recorded in `TEST_RESULTS.md` after the final run.

## Remaining stretch gaps

1. The Yjs state is a persisted collaborative working copy, while `draft_versions` remains the reviewed citation-bearing representation. Publishing a snapshot into a new reviewed version is not implemented.
2. Consequently, DOCX export uses the latest reviewed block version, not unreviewed collaborative text. The UI says this explicitly.
3. AI refinement still targets a reviewed evidence block. Its proposal and decision are correctly attributed, but accepted proposals do not patch the Yjs working copy.
4. Local HMAC identities are intentionally demo-only. Production collaboration still needs Cognito or another real identity/session layer, authorization policy, token rotation, and multi-instance Hocuspocus coordination.

These gaps are isolated to this stretch branch and do not change or weaken the pushed `v1-checkpoint` tag.
