/** Error codes of the PDF reader (kept apart from `parse.ts` so `objects.ts` and `parse.ts` do not import each other). */
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

export class PdfReadError extends Error {
  readonly code: ReadFailure;
  constructor(code: ReadFailure, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}
