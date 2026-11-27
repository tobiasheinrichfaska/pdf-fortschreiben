import { PDFDocument, StandardFonts } from 'pdf-lib';
import { PdfFile, type Result } from '../src/index.ts';

/** A small PDF as pdf-lib writes it with a classic cross-reference table (what the library accepts). */
export async function basePdf(pages = 1, objectStreams = false): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Seite ${i + 1}`, { x: 50, y: 780, size: 14, font });
  }
  doc.setTitle('Test');
  doc.setCreationDate(new Date('2026-11-01T00:00:00Z'));
  doc.setModificationDate(new Date('2026-11-01T00:00:00Z'));
  return doc.save({ useObjectStreams: objectStreams });
}

/** A stand-in "token": one DER SEQUENCE holding the digest (checks the plumbing, proves nothing). */
export const fakeStamper =
  (seen: Uint8Array[] = []) =>
  async (digest: Uint8Array): Promise<Uint8Array> => {
    seen.push(digest);
    return Uint8Array.from([0x30, digest.length, ...digest]);
  };

/** The value of a result; a failure fails the test with its code. */
export const must = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`unexpected failure ${r.code}: ${r.detail}`);
  return r.value;
};

/** `PdfFile.open` that must succeed. */
export const open = (bytes: Uint8Array): PdfFile => must(PdfFile.open(bytes));

/** What a failed result looks like: `expect(r).toMatchObject(failure('syntax', /loop/))`. */
export const failure = (code: string, detail?: RegExp | string) => ({
  ok: false as const,
  code,
  ...(detail === undefined ? {} : { detail: expect.stringMatching(detail) }),
});

/** What a thrown `PdfError` of a low-level accessor looks like: `expect(fn).toThrow(thrown('syntax'))`. */
export const thrown = (code: string, detail?: RegExp | string) =>
  expect.objectContaining({
    code,
    ...(detail === undefined ? {} : { detail: expect.stringMatching(detail) }),
  });

/** The code of a failure, or `ok`. */
export const codeOf = (r: Result<unknown>): string => (r.ok ? 'ok' : r.code);

export const text = (s: string): Uint8Array => new TextEncoder().encode(s);
export const ascii = (b: Uint8Array): string => String.fromCharCode(...b);
