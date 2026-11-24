import {
  PdfFile,
  appendDocTimeStamp,
  appendRevision,
  dict,
  findDocTimeStamps,
  isDict,
  isRef,
  textString,
} from '../src/index.ts';
import type { PdfDict, PdfObject, PdfRef } from '../src/index.ts';
import { ascii, basePdf } from './helpers.ts';

/** Like helpers' fakeStamper, but a DER SEQUENCE (what the library now requires). */
const fakeStamper = () => async (digest: Uint8Array) =>
  Uint8Array.from([0x30, digest.length, ...digest]);

const HEX = '0123456789ABCDEF';

/** Overwrites the stamp's /Contents hex digits (from the start) in a copy of the file. */
function setContents(pdf: Uint8Array, index: number, bytes: number[]): Uint8Array {
  const out = pdf.slice();
  const s = findDocTimeStamps(pdf)[index]!.byteRange;
  const start = s[1]! + 1;
  const total = s[2]! - s[1]! - 2;
  for (let i = 0; i < total; i++) out[start + i] = '0'.charCodeAt(0);
  bytes.forEach((x, i) => {
    out[start + i * 2] = HEX.charCodeAt(x >> 4);
    out[start + i * 2 + 1] = HEX.charCodeAt(x & 15);
  });
  return out;
}

describe('appendDocTimeStamp: stamper output', () => {
  it.each([
    ['tiny garbage', [0, 0]],
    ['an OCTET STRING', [0x04, 0x01, 0x00]],
    ['a SEQUENCE with a wrong length', [0x30, 0x05, 0x00]],
    ['trailing bytes', [0x30, 0x00, 0x00]],
    ['empty', []],
  ])('refuses %s', async (_, out) => {
    const pdf = await basePdf();
    await expect(appendDocTimeStamp(pdf, async () => Uint8Array.from(out))).rejects.toThrow(
      /DER SEQUENCE/,
    );
  });

  it('accepts one DER SEQUENCE', async () => {
    const pdf = await basePdf();
    const out = await appendDocTimeStamp(pdf, async () => Uint8Array.from([0x30, 0x03, 1, 2, 3]));
    const [t] = findDocTimeStamps(out);
    expect(t!.tokenOk).toBe(true);
    expect([...t!.token]).toEqual([0x30, 0x03, 1, 2, 3]);
  });
});

describe('findDocTimeStamps: token', () => {
  const seq = async (): Promise<Uint8Array> =>
    appendDocTimeStamp(await basePdf(), async () => Uint8Array.from([0x30, 0x02, 5, 6]));

  it('reports a valid token', async () => {
    const [t] = findDocTimeStamps(await seq());
    expect(t!.tokenOk).toBe(true);
    expect(t!.rangeOk).toBe(true);
    expect(t!.error).toBeUndefined();
  });

  it('does not clamp a declared length larger than the stored bytes', async () => {
    const [t] = findDocTimeStamps(setContents(await seq(), 0, [0x30, 0x82, 0xff, 0xff]));
    expect(t!.tokenOk).toBe(false);
    expect(t!.token.length).toBe(0);
  });

  it('flags the unfilled all-zero placeholder', async () => {
    const [t] = findDocTimeStamps(setContents(await seq(), 0, []));
    expect(t!.tokenOk).toBe(false);
    expect(t!.token.length).toBe(0);
  });

  it('flags a token that does not start with a SEQUENCE or has garbage after it', async () => {
    const pdf = await seq();
    expect(findDocTimeStamps(setContents(pdf, 0, [0x04, 0x01, 0x00]))[0]!.tokenOk).toBe(false);
    expect(findDocTimeStamps(setContents(pdf, 0, [0x30, 0x00, 0x07]))[0]!.tokenOk).toBe(false);
  });
});

describe('findDocTimeStamps: range', () => {
  it('rangeOk needs the gap to be this stamp’s own /Contents', async () => {
    const one = await appendDocTimeStamp(await basePdf(), fakeStamper());
    const two = await appendDocTimeStamp(one, fakeStamper());
    const [first, second] = findDocTimeStamps(two);
    expect(first!.rangeOk && second!.rangeOk).toBe(true);
    // Point the second stamp's range at the first stamp's string: same length, other bytes.
    const [, b1, c1] = first!.byteRange as [number, number, number];
    const end = second!.byteRange[2]! + second!.byteRange[3]!;
    const text = `[0 ${b1} ${c1} ${end - c1}]`.padEnd(36, ' ');
    const tampered = two.slice();
    const at = ascii(two).indexOf(`[${second!.byteRange.join(' ')}`);
    for (let i = 0; i < text.length; i++) tampered[at + i] = text.charCodeAt(i);
    const found = findDocTimeStamps(tampered);
    expect(found.find((s) => s.object === second!.object)!.rangeOk).toBe(false);
    expect(found.find((s) => s.object === first!.object)!.rangeOk).toBe(true);
  });
});

/** Adds a revision with the first stamp's dictionary copied into other fields. */
function withCopy(pdf: Uint8Array, shape: 'kids' | 'direct' | 'broken'): Uint8Array {
  return appendRevision(pdf, (file, u) => {
    const catalog = file.catalog;
    const form = file.dict(catalog.entries.get('AcroForm'))!;
    const fields = file.resolve(form.entries.get('Fields')) as PdfObject[];
    const widget = file.dict(fields[0]!)!;
    const v = file.dict(widget.entries.get('V'))!;
    const copy: PdfDict = shape === 'broken' ? dict({ SubFilter: v.entries.get('SubFilter')! }) : v;
    const newField = (extra: Record<string, PdfObject>): PdfRef =>
      u.add(dict({ T: textString('Kopie'), ...extra }));
    let added: PdfRef;
    if (shape === 'kids') {
      const kid = newField({ V: u.add(copy) });
      added = u.add(dict({ T: textString('Eltern'), Kids: [kid] }));
    } else if (shape === 'direct') added = newField({ V: copy });
    else added = newField({ V: u.add(copy) });
    const f2 = new Map(form.entries);
    f2.set('Fields', [...fields, added]);
    const ref = catalog.entries.get('AcroForm');
    if (isRef(ref)) u.set(ref, { t: 'dict', entries: f2 });
    else {
      const c2 = new Map(catalog.entries);
      c2.set('AcroForm', { t: 'dict', entries: f2 });
      u.set(file.rootRef, { t: 'dict', entries: c2 });
    }
  });
}

describe('findDocTimeStamps: robustness', () => {
  const base = async (): Promise<Uint8Array> => appendDocTimeStamp(await basePdf(), fakeStamper());

  it('follows /Kids', async () => {
    const found = findDocTimeStamps(withCopy(await base(), 'kids'));
    expect(found.length).toBe(2);
    expect(found.some((s) => s.field === 'Eltern.Kopie')).toBe(true);
  });

  it('accepts a direct /V dictionary', async () => {
    const found = findDocTimeStamps(withCopy(await base(), 'direct'));
    expect(found.length).toBe(2);
    const direct = found.find((s) => s.object === 0)!;
    expect(direct.field).toBe('Kopie');
    expect(direct.byteRange).toEqual(found.find((s) => s.object !== 0)!.byteRange);
  });

  it('a malformed stamp dictionary does not abort the listing', async () => {
    const pdf = withCopy(await base(), 'broken');
    expect(isDict(new PdfFile(pdf).catalog)).toBe(true);
    const found = findDocTimeStamps(pdf);
    expect(found.length).toBe(2);
    const bad = found.find((s) => s.error !== undefined)!;
    expect(bad.rangeOk).toBe(false);
    expect(bad.tokenOk).toBe(false);
    expect(bad.byteRange).toEqual([]);
    expect(found.some((s) => s.error === undefined && s.rangeOk)).toBe(true);
  });

  it('tells apart a reused object number by its range', async () => {
    const one = await base();
    const two = await appendDocTimeStamp(one, fakeStamper());
    expect(findDocTimeStamps(two).length).toBe(2);
  });
});
