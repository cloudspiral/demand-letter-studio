# Test Results

Last run: 2026-08-31 on macOS, Node 22.23, PostgreSQL 17 (Docker), locked Python 3.13 worker environment, headless LibreOffice, and installed Google Chrome.

## Automated

| Gate | Result |
|---|---|
| `pnpm typecheck` | Passed for contracts, API, and web |
| `pnpm test` | Passed: 2 contract tests, 8 API tests, 6 Python document-worker tests |
| `pnpm --filter @steno/web test:e2e` | Passed: one complete Playwright workflow (setup, five sources, source page, generation/SSE, edit/save, proposal/accept, activity, Word download) |
| Refinement SSE smoke | Passed: emitted `status` followed by the persisted `proposal` event |
| `pnpm build` | Passed for contracts, API/Lambda bundles, and production web assets |

Coverage includes schema rejection, provider adapter parity, citation resolution, unsupported-fact handling, completed-letter canary names/amounts, editable-region coverage, template classification, tracked-change rejection, name/date/amount extraction, OOXML patching, and opaque asset preservation.

## Live integration

- Supplied DOCX imported and confirmed; four PDFs and one PNG extracted and persisted.
- Generation returned `202`, moved through persisted job events, and produced a versioned/cited draft with the deterministic provider.
- Direct editing created version 2. Accepting a proposal created version 3; rejecting a second proposal left version 3 unchanged.
- Activity attributed generation, save, acceptance, and rejection to the local actor.
- Browser console had no warnings or errors.
- A live OpenAI `gpt-5.6-sol` generation completed in 73.241 seconds with the strict response schema, page-citation validation, editable-region coverage guard, and verified header replacement path enabled.

## DOCX verification

- Reference and generated DOCX packages reopened successfully.
- Package part sets matched exactly: 27 parts in each.
- The output retained exactly the reference package's 27-part set, and only `word/document.xml` changed. Both headers, both footers, all three media assets, styles, numbering, relationships, fields, and section settings were byte-identical or structurally unchanged as applicable.
- The untouched reference rendered to six pages and the final evidence-grounded draft rendered to five letter-size pages through the bundled LibreOffice `soffice` path. Every page image was inspected.
- The dynamic `DATE`/`PAGE` fields survived export, the claim number in the byte-identical continuation header was independently verified from evidence, and legacy sample demand/date values were absent from the generated body.
- LibreOffice clips part of the continuation header at the extreme top of page four in the generated output; the untouched reference exhibits the same renderer-specific crop on continuation pages. This is recorded rather than normalized away from the immutable formatting source.
- Desktop Microsoft Word Print Layout fidelity: **pending manual signoff**. It is not claimed as tested.

## Security/failure checks

- Unsupported template/source formats return bounded errors.
- Existing tracked changes and macro packages are rejected.
- Failed provider jobs enter the local `dead_letter_jobs` abstraction and emit an SSE failure event.
- Request bodies, authorization/cookies, API keys, prompts, and source contents are excluded from logs.
- Optimistic saves and stale proposal acceptance return conflicts instead of overwriting newer versions.
