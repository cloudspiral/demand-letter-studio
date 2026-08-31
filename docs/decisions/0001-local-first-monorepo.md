# ADR 0001: Local-first pnpm monorepo with deployable seams

Status: accepted

Use one pnpm workspace for the React client, Fastify API, and contracts, plus a Python document worker and PostgreSQL Compose service. Keep local filesystem/job-runner adapters behind the same boundaries represented by S3/SQS/Lambda in SAM.

This makes the assignment runnable without AWS credentials while leaving explicit replacement seams. AWS is not deployed for v1.
