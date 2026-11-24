# CLAUDE.md — pdf-fortschreiben

> Workspace-wide conventions (language, git, build, architecture, testing, collaboration):
> [`c:\skripte\private\general stuff\CLAUDE.md`](../../private/general%20stuff/CLAUDE.md)

---

## Project overview

Append revisions to a PDF without rewriting it (incremental update), attach files as PDF/A-3 associated
files, add PAdES document time stamps (`/DocTimeStamp`, `SubFilter ETSI.RFC3161`) over the whole state, and
read all of it back (revisions, attachments of any revision, every time stamp the file ever had with its
byte range and digest). Created 2026-11-24 for the running monthly PDF of `Zeiterfassung` (decision Tobias
2026-11-24: only time stamps, no personal signature; one PDF per month).

**TEMPORARY LOCATION:** a subdirectory of the `Zeiterfassung` repo because the cloud session could not
create a repository. **Claude on the PC: extract it next time — follow `HERAUSLOESEN.md`.**

**Platform:** library for browsers and Node (standard APIs only)
**Language:** TypeScript (erasable syntax only)
**Architecture:** pure functions over `Uint8Array`; no network, no clock (dates are parameters), no trust
store (the token comes from a `Stamper` the caller passes; verifying it is the caller's job, e.g.
`zeitstempel`'s `verifyTimestampToken`). Own small PDF syntax reader (`parse.ts`) for the files it writes.

## Key rules

- **Public repo (AGPLv3 + commercial):** no private project names, no real data, no credentials.
- **Earlier bytes are never changed.** Every write is `old bytes + new revision`; tests check the prefix.
- **Attachments are add only** (decision Tobias 2026-11-24): every state is a new file with a new name, so the
  newest revision shows how each earlier state looked, and a removal or change is detectable
  (`attachmentChanges`).
- **Only files with a classic xref table** are continued; xref streams, object streams and hybrid files are
  refused with a code (`PdfReadError.code`). No general-purpose PDF parser.
- Core imports nothing from `node:` and no `fetch`/`Buffer`/`process` (tests may).
- Nothing is published, tagged or released without Tobias' OK.

## Project Directory

| File/Folder        | Purpose                                                                                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/objects.ts`   | Object model (`dict`, `name`, `ref`, `raw` placeholders with reported offsets) and serializer                                                                                                      |
| `src/parse.ts`     | Lexer, indirect objects, classic xref sections, `PdfReadError` codes                                                                                                                               |
| `src/document.ts`  | `PdfFile` (revisions oldest first, objects of the newest, pages, `revisionBytes`), `Update`, `writeUpdate`                                                                                         |
| `src/attach.ts`    | `attachFile` (EmbeddedFile + Filespec + `/Names /EmbeddedFiles` + `/AF`, **add only**: a used name is refused), `readAttachments`, `attachmentChanges` (files a later revision removed or changed) |
| `src/timestamp.ts` | `appendDocTimeStamp` (placeholder, `/ByteRange`, digest, token), `findDocTimeStamps` (all revisions), `derLength`, `rangeDigest`                                                                   |
| `src/sha256.ts`    | Synchronous SHA-256 (copied from `Zeiterfassung/src/logic/sha256.ts`)                                                                                                                              |
| `tests/`           | Vitest; base PDFs from pdf-lib (dev dependency only)                                                                                                                                               |
| `scripts/`         | External check: test PKI + `openssl ts` stamper, `openssl ts -verify`, `pdfsig`, pyHanko (`npm run extern`)                                                                                        |
| `HERAUSLOESEN.md`  | Steps to move this directory into its own repository (delete after doing it)                                                                                                                       |

## Tests

```bash
npm ci
npm run typecheck
npm run format:check
npm test
```

## Open tasks (in this order)

1. Extract into its own repo (`HERAUSLOESEN.md`).
2. Errors as codes instead of exceptions (`Result`, like `zeitstempel`), keep `PdfReadError` codes.
3. ESLint config and a guard test „no `node:` in `src/`“ like `zeitstempel`; a coupling test for private names.
4. DSS (`/DSS` with `/Certs`, later `/OCSPs`/`/CRLs`) as its own revision after a time stamp (PAdES-LTA).
5. Visible content per day: decide in the app whether a day changes the page's content stream or adds a page;
   offer a helper here only if it stays app-independent.
6. Report what changed between revisions (only allowed objects: annotations, AcroForm, attachments, pages).
7. A build (`dist` + `prepare` or committed build) before an app depends on it by tag.

## Known Limitations

- **Not validated:** no PDF/A checker (veraPDF) run; the invisible widget has `/F 132` and an empty
  appearance stream, which PDF/A-3 should accept, unchecked.
- The trailer's `/ID` is carried over unchanged (the second element „should“ change per update; optional).
- **External check (2026-11-24, `npm run extern` + `scripts/pyhanko-pruefen.py`, test PKI, no real service):**
  both document time stamps of a two-day file pass `openssl ts -verify` and pyHanko 0.38.2
  (`INTACT:TRUSTED`); pikepdf opens the file with no syntax findings. `pdfsig` (poppler 24.02) lists the
  stamps but cannot validate `ETSI.RFC3161`. **pyHanko rates the day-1 stamp's following changes as
  modification level `OTHER`** because catalog `/Names`/`/AF` changed; this holds for replacing **and** for
  adding a file with a new name (rechecked 2026-11-24 with add-only names: still `OTHER`); with no
  attachment change it rates them `FORM_FILLING`. pyHanko has no rule for added attachments. The stamps stay
  intact; a viewer may still show a warning. The library's own check for removed or changed files is
  `attachmentChanges`.
- The external check depends on `openssl`, `pdfsig` and pyHanko on the machine; see `scripts/`.
