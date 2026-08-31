# ADR 0004: Add collaboration after a verified single-user checkpoint

Status: accepted

Keep workspace, actor, attribution, proposals, and activity boundaries in v1, but defer Yjs/Hocuspocus transport to a branch created from the verified v1 tag.

In collaboration, Yjs convergence handles text state while application events retain semantic attribution. Each user receives an agent identity; agents submit proposed edits on that user’s behalf and never mutate shared text silently.
