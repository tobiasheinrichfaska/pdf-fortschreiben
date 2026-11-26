/**
 * Drawing new pages with pdf-lib and appending them as **one incremental revision** (separate entry
 * `pdf-fortschreiben/pdflib`, so that the core stays free of pdf-lib; pdf-lib 1.17.1 is an optional peer
 * dependency).
 *
 * Technique: pdf-lib loads the file and its object counter is set to the file's `/Size` − 1, so new
 * objects get exactly the numbers this library's `Update` gives them. The caller draws its page(s). Then
 * only the **new** objects and the **changed page-tree nodes** (`/Type /Pages`) are taken from pdf-lib's
 * context, serialized by pdf-lib and put into an `Update` with asserted object numbers. Anything else pdf-lib
 * changed is refused (`PdfLibError`), except the trailer's `/Info` dictionary, which is never copied (the
 * revision carries the earlier `/Info` over). The earlier bytes are never changed.
 *
 * `prepareDrawnPages` returns the open `Update`, so the same revision can also hold attachments
 * (`attachFile`) before `writeUpdate`; `appendDrawnPages` does both steps for pages alone.
 */
import {
  PDFDict,
  PDFDocument,
  PDFFont,
  PDFName,
  PDFRef,
  type CustomFontEmbedder,
  type PDFObject,
  type StandardFontEmbedder,
} from 'pdf-lib';
import { PdfFile, Update, writeUpdate } from './document.ts';
import { raw, ref, type PdfRef } from './objects.ts';

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

export class PdfLibError extends Error {
  readonly code: PdfLibFailure;
  constructor(code: PdfLibFailure, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

/** What the draw step gets besides the pdf-lib document. */
export interface DrawContext {
  /** The file as this library reads it (read only). */
  readonly file: PdfFile;
}

export type Draw = (doc: PDFDocument, ctx: DrawContext) => Promise<void> | void;

export interface DrawnPages {
  readonly file: PdfFile;
  /** The open revision: new objects and changed page-tree nodes; the caller may add more, then `writeUpdate`. */
  readonly update: Update;
  /** The new pages in document order. */
  readonly pages: readonly PdfRef[];
}

const latin1Of = (bytes: Uint8Array): string => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192)
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
};

/** The bytes pdf-lib writes for an object (between `n 0 obj` and `endobj`). */
function serialize(o: PDFObject): string {
  const buffer = new Uint8Array(o.sizeInBytes());
  o.copyBytesInto(buffer, 0);
  return latin1Of(buffer);
}

const isPagesNode = (o: PDFObject): boolean =>
  o instanceof PDFDict && o.get(PDFName.of('Type')) === PDFName.of('Pages');

const infoNumber = (doc: PDFDocument): number | undefined => {
  const info = doc.context.trailerInfo.Info;
  return info instanceof PDFRef ? info.objectNumber : undefined;
};

/**
 * Loads `pdf` with pdf-lib, lets `draw` add pages, and returns the revision that holds them (not yet
 * written). Throws `PdfReadError` for a file this library does not continue and `PdfLibError` when pdf-lib
 * did more than add objects and change page-tree nodes.
 */
export async function prepareDrawnPages(pdf: Uint8Array, draw: Draw): Promise<DrawnPages> {
  const file = new PdfFile(pdf);
  const oldSize = file.size;
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const { context } = doc;
  if (context.largestObjectNumber >= oldSize)
    throw new PdfLibError('numbering', `pdf-lib sees object ${context.largestObjectNumber}`);
  // new objects must get exactly the numbers the update will give them
  context.largestObjectNumber = oldSize - 1;
  const before = new Map<number, string>();
  for (const [r, o] of context.enumerateIndirectObjects()) before.set(r.objectNumber, serialize(o));
  const pagesBefore = doc.getPageCount();

  await draw(doc, { file });
  await doc.flush();

  const info = infoNumber(doc);
  const update = new Update(file);
  const all = context
    .enumerateIndirectObjects()
    .sort(([a], [b]) => a.objectNumber - b.objectNumber);
  for (const [r, o] of all) {
    if (r.generationNumber !== 0)
      throw new PdfLibError('generation', `object ${r.objectNumber} ${r.generationNumber}`);
    const old = before.get(r.objectNumber);
    if (r.objectNumber === info) {
      if (old === undefined) throw new PdfLibError('info-created', `object ${r.objectNumber}`);
      continue; // the earlier /Info stays; pdf-lib's change is dropped
    }
    if (old === undefined) {
      if (r.objectNumber < oldSize)
        throw new PdfLibError('numbering', `new object ${r.objectNumber} below /Size`);
      const added = update.add(raw(serialize(o)));
      if (added.num !== r.objectNumber)
        throw new PdfLibError('numbering', `object ${r.objectNumber} would be ${added.num}`);
      continue;
    }
    const now = serialize(o);
    if (now === old) continue;
    if (!isPagesNode(o)) throw new PdfLibError('changed-object', `object ${r.objectNumber}`);
    update.set(ref(r.objectNumber), raw(now));
  }
  if (update.size !== Math.max(oldSize, context.largestObjectNumber + 1))
    throw new PdfLibError('numbering', `pdf-lib counter ${context.largestObjectNumber}`);

  // The page list as the written revision will show it: the earlier pages, unchanged and in their
  // order, then only new page objects.
  // writeUpdate refuses an update without objects; a draw step that changed nothing added no page.
  if (update.objects.size === 0) throw new PdfLibError('no-new-page', 'draw added no page');
  const oldPages = file.pages().map((r) => r.num);
  const newPages = new PdfFile(writeUpdate(file, update).bytes).pages().map((r) => r.num);
  if (
    newPages.length < oldPages.length ||
    oldPages.some((n, i) => newPages[i] !== n) ||
    newPages.slice(oldPages.length).some((n) => n < oldSize)
  )
    throw new PdfLibError('pages-changed', 'earlier pages are not kept as the start, in order');
  if (newPages.length === oldPages.length || doc.getPageCount() === pagesBefore)
    throw new PdfLibError('no-new-page', 'draw added no page');
  const pages = newPages.slice(oldPages.length).map((n) => ref(n));
  return { file, update, pages };
}

/** `prepareDrawnPages` and `writeUpdate` in one: a revision with the drawn pages only. */
export async function appendDrawnPages(pdf: Uint8Array, draw: Draw): Promise<Uint8Array> {
  const { file, update } = await prepareDrawnPages(pdf, draw);
  return writeUpdate(file, update).bytes;
}

/**
 * A font that an earlier revision embedded, as a pdf-lib font that draws with that font object and is
 * never embedded again (it is not registered with the document, so `flush` writes nothing for it).
 * Found by `/Type /Font` and `/BaseFont` (the first match); undefined when the file has none.
 *
 * `embedder` must describe the same font: a standard font (`StandardFontEmbedder.for(StandardFonts.X)`),
 * or for a custom font `CustomFontEmbedder.for(fontkit, bytes, baseFont)` — and then the earlier revision
 * must have embedded it **complete** (`subset: false`), since glyph numbers are taken from the full font.
 */
export async function reuseFont(
  doc: PDFDocument,
  baseFont: string,
  embedder: () =>
    CustomFontEmbedder | StandardFontEmbedder | Promise<CustomFontEmbedder | StandardFontEmbedder>,
): Promise<PDFFont | undefined> {
  for (const [r, o] of doc.context.enumerateIndirectObjects()) {
    if (
      o instanceof PDFDict &&
      o.get(PDFName.of('Type')) === PDFName.of('Font') &&
      o.get(PDFName.of('BaseFont')) === PDFName.of(baseFont)
    )
      return PDFFont.of(r, doc, await embedder());
  }
  return undefined;
}
