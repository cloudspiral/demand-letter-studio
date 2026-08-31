# ADR 0004: Add collaboration after a verified single-user checkpoint

Status: accepted

Keep workspace, actor, attribution, proposals, and activity boundaries in v1, but add Yjs/Hocuspocus transport only on a branch created from the verified v1 tag.

In collaboration, Yjs convergence handles text state while application events retain semantic attribution. Each user receives an agent identity; agents submit proposed edits on that user’s behalf and never mutate shared text silently. Signed local identities are a demo substitute for production authentication, not a production trust model.

Persist the full Yjs state update as a debounced snapshot and keep awareness ephemeral. Make Yjs the canonical editing state by storing stable block IDs, source/page citations, original text, unsupported status, and Word-template mappings as collaborative node attributes.

Run inexpensive deterministic checks after editing pauses and run the authoritative check against the exact submitted state update during export. A successful export creates a citation-bearing `draft_version` checkpoint and renders that same content. Agent acceptance becomes a normal Yjs transaction after the server verifies the target and records the semantic decision.

Free-form nodes without a reviewed Word-template mapping may exist in the live document but block export. This is safer than silently dropping them or rebuilding the immutable template package.
