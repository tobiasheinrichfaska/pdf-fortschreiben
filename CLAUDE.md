# CLAUDE.md — pdf-fortschreiben

> Workspace-wide conventions (language, git, build, architecture, testing, collaboration):
> [`c:\skripte\private\general stuff\CLAUDE.md`](../../private/general%20stuff/CLAUDE.md)

---

## Project overview

Append revisions to a PDF without rewriting it (incremental update), attach files as PDF/A-3 associated
files, add PAdES document time stamps (`/DocTimeStamp`, `SubFilter ETSI.RFC3161`) over the whole state, and
read all of it back (revisions, attachments of any revision, every time stamp the file ever had with its
byte range and digest). Created 2026-11-24 for a running monthly PDF of an app (decision Tobias
2026-11-24: only time stamps, no personal signature; one PDF per month).

**Location:** its own repository (decision Tobias 2026-11-25: this repo is the final home; the earlier plan to
extract it from a subdirectory of the consuming app is done).

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
- **Only files with a classic xref table** are continued; xref streams, object streams and hybrid files and
  encrypted files (`/Encrypt`) are refused with a code (`Failure.code`). No general-purpose PDF parser.
- Core imports nothing from `node:` and nothing from pdf-lib (only `src/pdflib.ts`, a separate entry, does) and no `fetch`/`Buffer`/`process` (tests may).
- **Errors are values (since 2026-11-27, decision Tobias):** every public function (`appendRevision`, `writeUpdate`,
  `PdfFile.open`, `attachFile`, `readAttachments`, `attachmentChanges`, `appendDocTimeStamp`, `findDocTimeStamps`,
  `prepareDrawnPages`, `appendDrawnPages`) returns `Result<T>` = `{ ok: true; value } | { ok: false; code; detail }`
  (mirrors `zeitstempel`'s `Result`, but the field is `code`, not `reason`). One failure type for reading, usage and
  pdf-lib refusals (`FailureCode` in `src/errors.ts`); internally everything throws `PdfError` and the public boundary
  converts (`guard`). The low-level accessors (`PdfFile.object/pages/catalog/revisionBytes`, `Update.add/set`, the
  object builders `latin1`/`textString`/`TextSink`) still throw `PdfError`: inside `appendRevision`'s callback that
  becomes a failure; an error the caller throws passes through. A new failure needs a code, a test and an entry in README.
- Nothing is published, tagged or released without Tobias' OK.

## Project Directory

| File/Folder                    | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                 | Public exports and `appendRevision` (build one revision with a callback)                                                                                                                                                                                                                                                                                                                                                               |
| `src/objects.ts`               | Object model (`dict`, `name`, `ref`, `raw` placeholders with reported offsets), serializer (`TextSink`), type guards                                                                                                                                                                                                                                                                                                                   |
| `src/errors.ts`                | `Result`/`Failure`/`FailureCode` (`ReadFailure`, `UsageFailure`, `PdfLibFailure`), `PdfError` (thrown internally and by low-level accessors), `guard`/`guardAsync`/`unwrap`; own file so `objects.ts` and `parse.ts` do not import each other                                                                                                                                                                                          |
| `src/parse.ts`                 | Lexer, indirect objects, classic xref sections, `readRevisionEnd`; re-exports `PdfError`                                                                                                                                                                                                                                                                                                                                               |
| `src/document.ts`              | `PdfFile` (opened with `PdfFile.open`, which returns a `Result`; revisions oldest first, objects of the newest, pages, `revisionBytes`), `Update`, `writeUpdate`, `MAX_SIZE`; refuses `/Linearized` and non-sequential `/Prev` chains (code `linearized`)                                                                                                                                                                              |
| `src/attach.ts`                | `attachFile` (EmbeddedFile + Filespec + `/Names /EmbeddedFiles` + `/AF`, **add only**: a used name is refused), `readAttachments`, `attachmentChanges` (files a later revision removed or changed)                                                                                                                                                                                                                                     |
| `src/timestamp.ts`             | `appendDocTimeStamp` (placeholder, `/ByteRange`, digest, token), `findDocTimeStamps` (all revisions), `derLength`, `rangeDigest`                                                                                                                                                                                                                                                                                                       |
| `src/pdflib.ts`                | Separate entry `pdf-fortschreiben/pdflib` (pdf-lib 1.17.1 optional peer): `prepareDrawnPages`/`appendDrawnPages` (pages drawn by pdf-lib as one revision: only new objects and changed page-tree nodes, asserted numbers; other changes refused with `PdfLibFailure` codes; the earlier pages must stay the unchanged start of the page list, else `pages-changed`; `/Info` never copied), `reuseFont` (a font of an earlier revision) |
| `src/sha256.ts`                | Synchronous SHA-256 (copied from the consuming app's own SHA-256): `Sha256` class (streaming `update`/`digest`), `sha256Bytes`, `toHex`, `sha256Hex`; `index.ts` exports only `sha256Bytes`                                                                                                                                                                                                                                            |
| `tests/`                       | Vitest; base PDFs from pdf-lib (dev dependency only)                                                                                                                                                                                                                                                                                                                                                                                   |
| `scripts/`                     | External check: test PKI + `openssl ts` stamper, `openssl ts -verify`, `pdfsig`, pyHanko (`npm run extern`); build: `prepare.mjs` (`prepare` builds only if typescript resolves, else one line on stderr and exit 0), `clean-dist.mjs`, `fix-declarations.mjs`                                                                                                                                                                         |
| `scripts/extern-validitaet.ts` | `npm run extern:validitaet`: writes outputs to `.tmp/extern/` (`ausgaben.ts`), `qpdf --check` on each, veraPDF `--flavour 3b` differential against the base; `verapdf.ts` = pure report parser/comparison (tested in `tests/verapdf.test.ts`), `teststamper.ts` = test-PKI stamper shared with `extern-pruefen.ts`, `verapdf-docker.sh` = CI wrapper                                                                                   |
| `SECURITY.md`                  | How to report a vulnerability; what never to put into issues                                                                                                                                                                                                                                                                                                                                                                           |
| `eslint.config.js`             | TypeScript strict; `src/` may not import `node:` or use `fetch`/`process`/`Buffer`                                                                                                                                                                                                                                                                                                                                                     |
| `tests/coupling.test.ts`       | Guard tests: core uses standard APIs only; no private project names in files or commit messages                                                                                                                                                                                                                                                                                                                                        |
| `.github/workflows/tests.yml`  | CI (check „Tests“): typecheck, lint, format, tests, build, smoke test                                                                                                                                                                                                                                                                                                                                                                  |

## Tests

```bash
npm ci
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm run extern:validitaet   # needs openssl, qpdf, veraPDF; runs in CI job "External checks"
```

`tests/verapdf.test.ts` tests the report comparison with fixture strings (no external tool).

## Build and release

- **0.1.0 with a build (2026-11-26):** `npm run build` writes `dist/` (JS + `.d.ts`, `tsconfig.build.json`); `dist/`
  is not committed. `prepare` builds on a Git install (consumers: `github:tobiasheinrichfaska/pdf-fortschreiben#v0.1.0`).
  `exports` `.` and `./pdflib` point to `dist`; pdf-lib stays an optional peer. `tests/package.test.ts` builds a copy
  with `prepare` (no tsc on PATH) and imports `dist/index.js` and `dist/pdflib.js`. CI: `.github/workflows/tests.yml`
  (check „Tests“, actions pinned by tag, not by SHA).
- **Tag `v0.1.0` approved by Tobias, not yet pushed:** Claude on the PC pushes it on the commit of this build (the
  cloud session cannot push tags).

## Open tasks (in this order)

1. ~~Errors as codes instead of exceptions (`Result`, like `zeitstempel`), keep the read codes~~ (done 2026-11-27, see Key rules).
2. ~~ESLint config and guard tests (no `node:` in `src/`, no private names)~~ (done: `eslint.config.js`, `tests/coupling.test.ts`).
3. DSS (`/DSS` with `/Certs`, later `/OCSPs`/`/CRLs`) as its own revision after a time stamp (PAdES-LTA).
4. Visible content: new pages drawn by pdf-lib are done (`src/pdflib.ts`, app-independent); changing an
   existing page's content stream is not offered (an app adds pages instead).
5. Report what changed between revisions (only allowed objects: annotations, AcroForm, attachments, pages).
6. ~~A build before an app depends on it by tag~~ (done 2026-11-26, see „Build and release“; tag `v0.1.0` pending).
7. Async SHA-256 via `crypto.subtle` as an option for big files (the pure-JS `Sha256` runs at ~55 MB/s).
8. ~~Unify error classes (usage errors vs `PdfReadError`)~~ (done 2026-11-27: one `Failure` with `code`).
9. Check output with `qpdf --check` and veraPDF in `scripts/`: **written 2026-11-27, done in CI pending the first green run** (job `external` „External checks“, `npm run extern:validitaet`). qpdf/veraPDF/Java cannot be installed on the PC, so the job has never run; the veraPDF image tag and the report parsing against real output are unverified.

## Known Limitations

- **Linearized files are refused** (failure code `linearized`): a first object that is a `/Linearized`
  dictionary, or a `/Prev` chain whose revisions do not lie one after the other, cannot be continued by appending.
- **Leading junk before `%PDF` is not supported:** offsets are taken relative to the file start, not the header;
  such a file fails with a code (not continued).
- **Not validated (yet):** no `qpdf --check` and no veraPDF run has ever succeeded; the CI job `external` is written
  but has not run green. veraPDF is a **differential** check (PDF/A-3b): pdf-lib's base is not PDF/A, so a result
  may fail only rules (clause/testNumber) the base fails too. The invisible widget has `/F 132` and an empty
  appearance stream, which PDF/A-3 should accept, unchecked until then.
- `appendDocTimeStamp` reserves `options.reserve` bytes for the token (default 16384, allowed 1024..65536 else `bad-options`); a longer token is `token-too-large`.
- `PdfFile.revisionBytes(i)` includes the single line end after `%%EOF`; it is a prefix of the updated file, not necessarily byte-equal to the original base.
- **Trailer `/ID`:** every revision writes `/ID [<A> <B>]` as hex strings. B = first 16 bytes of SHA-256 over the old file plus the new revision's objects (trailer excluded), so deterministic (no clock, no randomness). A is kept from the old `/ID`; a file without `/ID` gets A = B. A malformed `/ID` (not an array of two strings) is failure `syntax`.
- **External check (2026-11-24, `npm run extern` + `scripts/pyhanko-pruefen.py`, test PKI, no real service):**
  both document time stamps of a two-day file pass `openssl ts -verify` and pyHanko 0.38.2
  (`INTACT:TRUSTED`); pikepdf opens the file with no syntax findings. `pdfsig` (poppler 24.02) lists the
  stamps but cannot validate `ETSI.RFC3161`. **pyHanko rates the day-1 stamp's following changes as
  modification level `OTHER`** because catalog `/Names`/`/AF` changed; this holds for replacing **and** for
  adding a file with a new name (rechecked 2026-11-24 with add-only names: still `OTHER`); with no
  attachment change it rates them `FORM_FILLING`. pyHanko has no rule for added attachments. The stamps stay
  intact; a viewer may still show a warning. The library's own check for removed or changed files is
  `attachmentChanges`.
- `findDocTimeStamps` does not abort on a malformed stamp: the entry has `error`, `rangeOk` and `tokenOk` false.
  `rangeOk` means the range covers everything up to the revision's end except exactly its own `/Contents`,
  and that `/Contents` was written in that revision.
- A `Stamper` answer must be one DER SEQUENCE; BER indefinite length is rejected. `derLength` only measures.
- `readAttachments` decodes only uncompressed or single `FlateDecode` streams; others come back raw with
  `unsupportedFilter` and `filter`. `attachFile` refuses name trees with `/Kids`, reading follows them.
- A reference whose generation differs from the file's is refused on purpose (`object-mismatch`) instead of
  being read as null (the spec's rule for readers): the library only appends and must not skip silently.
- `FoundTimeStamp.digest` is computed lazily over the caller's buffer; it must not change after
  `findDocTimeStamps`.
- `/Size` is capped at 2147483647 (what `PdfFile` accepts): `Update.add`/`set`/`writeUpdate` refuse more.
- `attachmentChanges` digest covers data, MIME, relationship, description, filter, Filespec `/Type` `/F` `/UF`, a separate
  `/EF /UF` stream, `/Params` Size/ModDate, stream `/Type` and membership in the catalog `/AF`. Files only in `/AF`
  are read (`source: 'af'`), only their removal/change is reported (never additions). **Not read:** `/FileAttachment`
  page annotations. A malformed name tree key makes `attachmentChanges` fail with `syntax` (fail loud, intended).
  `attachFile` refuses a catalog `/AF` that is not an array.
- The external check depends on `openssl`, `pdfsig` and pyHanko on the machine; see `scripts/`.
- `npm run extern:validitaet` needs `openssl`, `qpdf` and veraPDF (env `VERAPDF` = command; CI uses the official
  `verapdf/cli` Docker image via `scripts/verapdf-docker.sh`, tag in `tests.yml`); a missing tool stops it with one
  line and exit 2, never a pass. **Licenses:** qpdf (Apache 2.0) and veraPDF (GPLv3+/MPL 2.0) are used only as
  separate programs for checking; nothing is linked, vendored, installed as a dependency or shipped.
