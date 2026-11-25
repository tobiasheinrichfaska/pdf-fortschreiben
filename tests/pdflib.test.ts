import { PDFDocument, PDFName, StandardFontEmbedder, StandardFonts, rgb } from 'pdf-lib';
import {
  PdfFile,
  appendDocTimeStamp,
  attachFile,
  attachmentChanges,
  findDocTimeStamps,
  readAttachments,
  writeUpdate,
} from '../src/index.ts';
import {
  PdfLibError,
  appendDrawnPages,
  prepareDrawnPages,
  reuseFont,
  type Draw,
} from '../src/pdflib.ts';
import { ascii, basePdf, fakeStamper, text } from './helpers.ts';

const prefixKept = (before: Uint8Array, after: Uint8Array): boolean =>
  after.length > before.length && before.every((b, i) => after[i] === b);

const pageCount = async (pdf: Uint8Array): Promise<number> =>
  (await PDFDocument.load(pdf)).getPageCount();

// pdf-lib types the name with its own enum copy (same values)
const standard = (font: StandardFonts): StandardFontEmbedder =>
  StandardFontEmbedder.for(font as unknown as Parameters<typeof StandardFontEmbedder.for>[0]);

/** Draws `n` pages with the Helvetica object of the first revision (no font is embedded again). */
const drawPages =
  (n: number, label: string): Draw =>
  async (doc) => {
    const font = await reuseFont(doc, 'Helvetica', () => standard(StandardFonts.Helvetica));
    if (font === undefined) throw new Error('no Helvetica in the file');
    for (let i = 0; i < n; i++) {
      const page = doc.addPage([595, 842]);
      page.drawText(`${label} ${i + 1}`, { x: 50, y: 780, size: 14, font, color: rgb(0, 0, 0) });
    }
  };

describe('pdf-lib pages as one revision', () => {
  it('appends 3 drawn pages and an attachment in one revision; earlier bytes are a prefix', async () => {
    const base = await basePdf();
    const { file, update, pages } = await prepareDrawnPages(base, drawPages(3, 'Tag'));
    expect(pages).toHaveLength(3);
    attachFile(file, update, {
      name: 'monat-tag-01.json',
      data: text('{"tag":1}'),
      mimeType: 'application/json',
    });
    const next = writeUpdate(file, update).bytes;

    expect(prefixKept(base, next)).toBe(true);
    const f = new PdfFile(next);
    expect(f.revisions).toHaveLength(2);
    expect(f.pages()).toHaveLength(4);
    expect(f.pages().slice(1)).toEqual(pages);
    expect(await pageCount(base)).toBe(1);
    expect(await pageCount(next)).toBe(4);
    const att = await readAttachments(f);
    expect(att.map((a) => [a.name, ascii(a.data)])).toEqual([['monat-tag-01.json', '{"tag":1}']]);

    // the revision holds no font object: the pages use the one of the first revision
    const tail = ascii(next.subarray(base.length));
    expect(tail).not.toContain('/Type /Font');
    expect(tail).toContain('/Helvetica');
  });

  it('every state loads; time stamps still work before and after drawn pages', async () => {
    const seen: Uint8Array[] = [];
    const base = await basePdf();
    const states = [base];
    let pdf = await appendDrawnPages(base, drawPages(1, 'Tag 1'));
    states.push(pdf);
    pdf = await appendDocTimeStamp(pdf, fakeStamper(seen), { reserve: 2048 });
    states.push(pdf);
    const { file, update } = await prepareDrawnPages(pdf, drawPages(2, 'Tag 2'));
    attachFile(file, update, { name: 'm-2.json', data: text('2'), mimeType: 'application/json' });
    pdf = writeUpdate(file, update).bytes;
    states.push(pdf);
    pdf = await appendDocTimeStamp(pdf, fakeStamper(seen), { reserve: 2048 });
    states.push(pdf);

    for (let i = 1; i < states.length; i++)
      expect(prefixKept(states[i - 1]!, states[i]!)).toBe(true);
    expect(await Promise.all(states.map(pageCount))).toEqual([1, 2, 2, 4, 4]);
    const found = findDocTimeStamps(pdf);
    expect(found.map((t) => [t.revision, t.rangeOk])).toEqual([
      [2, true],
      [4, true],
    ]);
    found.forEach((t, i) => expect(t.digest).toEqual(seen[i]));
    expect(await attachmentChanges(pdf)).toEqual([]);
    // the stamp widget sits on the first page; that page was not rewritten by a drawn revision
    expect(new PdfFile(pdf).pages()).toHaveLength(4);
  });

  it('does not copy pdf-lib’s /Info changes', async () => {
    const base = await basePdf();
    const infoBefore = new PdfFile(base).trailer.entries.get('Info');
    const next = await appendDrawnPages(base, async (doc, ctx) => {
      expect(ctx.file.revisions).toHaveLength(1);
      doc.setTitle('Anders');
      doc.setProducer('jemand');
      await drawPages(1, 'Seite')(doc, ctx);
    });
    const f = new PdfFile(next);
    expect(f.trailer.entries.get('Info')).toEqual(infoBefore);
    expect(ascii(next.subarray(base.length))).not.toContain('Anders');
    expect((await PDFDocument.load(next)).getTitle()).toBe('Test');
  });

  it('refuses a change to an earlier page and a draw step without a page', async () => {
    const base = await basePdf();
    const changed = appendDrawnPages(base, (doc) => {
      doc.getPage(0).node.set(PDFName.of('Rotate'), doc.context.obj(90));
      doc.addPage();
    });
    await expect(changed).rejects.toThrow(PdfLibError);
    await expect(changed).rejects.toMatchObject({ code: 'changed-object' });
    await expect(appendDrawnPages(base, () => {})).rejects.toMatchObject({ code: 'no-new-page' });
  });

  it('refuses a new /Info dictionary (it would not be copied and leave a gap)', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.addPage();
    delete doc.context.trailerInfo.Info;
    const bare = await doc.save({ useObjectStreams: false });
    expect(new PdfFile(bare).trailer.entries.get('Info')).toBeUndefined();
    await expect(
      appendDrawnPages(bare, (d) => {
        d.setTitle('neu');
        d.addPage();
      }),
    ).rejects.toMatchObject({ code: 'info-created' });
  });

  it('reuseFont finds nothing in a file without that font', async () => {
    const doc = await PDFDocument.load(await basePdf());
    expect(await reuseFont(doc, 'Courier', () => standard(StandardFonts.Courier))).toBeUndefined();
  });
});
