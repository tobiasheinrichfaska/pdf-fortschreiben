# Critical User Paths — pdf-fortschreiben

**Purpose:** Core workflows that must not break. Audit validates these end-to-end.
Status 2026-11-27: library built (see CLAUDE.md). `[x]` = covered by automated tests (`tests/`);
`[ ]` = not yet validated (CI job `external` written, no green run yet, task 9 in CLAUDE.md).

- [x] **Append a revision** — `old bytes + new revision`; the earlier bytes are never changed (prefix check)
- [x] **Attach a file (PDF/A-3, add only)** — name tree + `/AF`; a duplicate or changed name is refused or reported
- [x] **Add a document time stamp** — `/DocTimeStamp` (`ETSI.RFC3161`) over the whole state; the token comes from the caller's `Stamper`
- [x] **Read everything back** — revisions, attachments of any revision, every time stamp with byte range and digest
- [x] **Report changes between revisions** — `attachmentChanges` reports changed, removed or forged attachments; honest add-only revisions report nothing
- [x] **Malformed input fails loudly** — a `Result` failure with a code (`Failure.code`), no silent drop and no exception from the public API; deep or cyclic trees refused
- [x] **Draw new pages with pdf-lib** — earlier pages stay the start of the page list
- [x] **No app data and no `node:` imports in `src/`** — guard test `tests/coupling.test.ts`
- [ ] **Output passes external checkers** — `openssl ts -verify`, pyHanko, pikepdf checked by hand (`npm run extern`); `qpdf --check` and veraPDF (differential, PDF/A-3b) via `npm run extern:validitaet` — tick only after the CI job "External checks" has run green

| Path                                      | Impact                                       | Audit Check                                                                    |
| ----------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------ |
| Earlier bytes unchanged                   | a changed history voids the time stamps      | prefix assertions in `tests/fortschreiben.test.ts`                             |
| Stamp covers the whole state              | a stamp over part of the file proves nothing | `tests/stamp-range.test.ts`                                                    |
| Attachments add only                      | a silent change or removal goes unnoticed    | `tests/attachment-identity.test.ts`                                            |
| Built package works without `tsc` on PATH | consumers install by git tag                 | `tests/package.test.ts` (needs symlink rights on Windows; runs in CI on Linux) |
