# ADR 0003: Grounded asynchronous generation with explicit proposals

Status: accepted

Treat AI generation as a persisted job and stream progress via SSE. Require schema-valid content, source/page citations, and complete coverage of confirmed editable template regions. Treat refinements as proposals; only an explicit acceptance may create a new draft version.

This favors auditability and failure recovery over lower latency. The model is a bounded content service, not an autonomous document or code agent.
