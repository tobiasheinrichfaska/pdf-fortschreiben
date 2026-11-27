/**
 * One code-based failure type for the whole library (kept apart from `parse.ts` so `objects.ts` and
 * `parse.ts` do not import each other). Public functions return `Result`; the low-level accessors of
 * `PdfFile` and `Update` (and everything internal) throw `PdfError`, which the public boundary turns into a
 * `Failure` with the same code.
 */

/** The input file cannot be read or continued. */
export type ReadFailure =
  | 'syntax'
  | 'no-startxref'
  | 'xref-stream'
  | 'object-stream'
  | 'xref-loop'
  | 'object-missing'
  | 'object-mismatch'
  | 'encrypted'
  | 'linearized';

/** The caller asked for something the library refuses. */
export type UsageFailure =
  /** An option or argument is out of range or of the wrong kind. */
  | 'bad-options'
  /** Attachment name is not printable ASCII (1..200). */
  | 'bad-name'
  /** Attachment MIME type is not `type/subtype`. */
  | 'bad-mime'
  /** The attachment name is already in the file (add only). */
  | 'name-exists'
  /** The `/EmbeddedFiles` tree has `/Kids` (not supported when attaching). */
  | 'unsupported-name-tree'
  /** The catalog `/AF` is neither an array nor a reference to one. */
  | 'bad-af'
  /** `writeUpdate` was given an update without objects. */
  | 'empty-update'
  /** `trailerExtra` sets a key the writer owns. */
  | 'reserved-trailer-key'
  /** An object number or `/Size` beyond the supported limit, or object 0, or a wrong generation. */
  | 'bad-reference'
  /** An object cannot be serialized. */
  | 'bad-object'
  /** No revision with that index. */
  | 'no-revision'
  /** The page option names no page. */
  | 'no-page'
  /** The file is too large for the fixed-width `/ByteRange`. */
  | 'file-too-large'
  /** The `Stamper` rejected or threw. */
  | 'stamper-failed'
  /** The `Stamper` answer is not one DER SEQUENCE. */
  | 'bad-token'
  /** The token does not fit into the reserved bytes. */
  | 'token-too-large';

/** The pdf-lib entry (`pdf-fortschreiben/pdflib`) refuses what pdf-lib did. */
export type PdfLibFailure =
  /** pdf-lib numbers objects differently from the file's xref (its counter is above `/Size` − 1). */
  | 'numbering'
  /** pdf-lib wrote an object with a generation other than 0. */
  | 'generation'
  /** pdf-lib changed an earlier object that is not a page-tree node (e.g. an existing page). */
  | 'changed-object'
  /** pdf-lib created a new `/Info` dictionary (it is never copied, and would leave a gap in the numbers). */
  | 'info-created'
  /** The draw step added no page. */
  | 'no-new-page'
  /** The earlier pages are not, in their order, the start of the new page list (removed, moved, inserted). */
  | 'pages-changed';

export type FailureCode = ReadFailure | UsageFailure | PdfLibFailure;

export interface Failure {
  ok: false;
  code: FailureCode;
  /** Facts that help a person (object numbers, offsets); not meant for matching. */
  detail: string;
}

export type Result<T> = { ok: true; value: T } | Failure;

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = (code: FailureCode, detail: string): Failure => ({ ok: false, code, detail });

/** Thrown inside the library and by the low-level accessors; the public functions return it as a `Failure`. */
export class PdfError extends Error {
  readonly code: FailureCode;
  readonly detail: string;
  constructor(code: FailureCode, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.detail = detail;
  }
}

/** Runs `run` and turns a `PdfError` into a failure; any other error is a bug or the caller's and passes through. */
export function guard<T>(run: () => T): Result<T> {
  try {
    return ok(run());
  } catch (e) {
    if (e instanceof PdfError) return fail(e.code, e.detail);
    throw e;
  }
}

/** Async `guard`. */
export async function guardAsync<T>(run: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await run());
  } catch (e) {
    if (e instanceof PdfError) return fail(e.code, e.detail);
    throw e;
  }
}

/** The value of a result, or the failure thrown as a `PdfError` (for internal code that composes steps). */
export function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw new PdfError(r.code, r.detail);
  return r.value;
}
