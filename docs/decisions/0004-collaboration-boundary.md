# ADR 0004: Add collaboration after a verified single-user checkpoint

Status: accepted

Keep workspace, actor, attribution, proposals, and activity boundaries in v1, but add Yjs/Hocuspocus transport only on a branch created from the verified v1 tag.

In collaboration, Yjs convergence handles text state while application events retain semantic attribution. Each user receives an agent identity; agents submit proposed edits on that user’s behalf and never mutate shared text silently. Signed local identities are a demo substitute for production authentication, not a production trust model.

Persist the full Yjs state update as a debounced snapshot and keep awareness ephemeral. Do not automatically reinterpret arbitrary collaborative ProseMirror structure as v1 evidence blocks. Until a bridge can preserve stable block IDs, source/page citations, unsupported markers, and optimistic versions, the Yjs state remains a working copy and reviewed block versions remain the DOCX export authority.
