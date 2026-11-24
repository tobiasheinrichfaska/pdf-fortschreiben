import {
  PdfFile,
  Update,
  name,
  raw,
  writeUpdate,
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
    const other = new Map(v.entries); // a different range: not a duplicate of the original stamp
    other.set('ByteRange', [0, 1, 2, 3]);
    const copy: PdfDict =
      shape === 'broken'
        ? dict({ SubFilter: v.entries.get('SubFilter')! })
        : shape === 'kids'
          ? { t: 'dict', entries: other }
          : v;
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

  it('accepts a direct /V dictionary (listed once, as the indirect stamp)', async () => {
    const found = findDocTimeStamps(withCopy(await base(), 'direct'));
    expect(found.length).toBe(1);
    expect(found[0]!.object).not.toBe(0);
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

/** Hand-built stamp revision (field + stamp dictionary) to shape the stamp object: padding, spaced hex. */
function handStamp(pdf: Uint8Array, opts: { pad?: number; spaced?: boolean }): Uint8Array {
  const file = new PdfFile(pdf);
  const u = new Update(file);
  const hex = '0'.repeat(2048);
  const contents = opts.spaced ? hex.replace(/(.{64})/g, '$1\n ') : hex;
  const sig = u.add(
    dict({
      Type: name('DocTimeStamp'),
      Pad: textString('x'.repeat(opts.pad ?? 0)),
      Filter: name('Adobe.PPKLite'),
      SubFilter: name('ETSI.RFC3161'),
      ByteRange: raw('[' + ' '.repeat(34) + ']', 'byterange'),
      Contents: raw('<' + contents + '>', 'contents'),
    }),
  );
  const field = u.add(dict({ FT: name('Sig'), T: textString('Hand'), V: sig }));
  const catalog = new Map(file.catalog.entries);
  catalog.set('AcroForm', dict({ Fields: [field], SigFlags: 3 }));
  u.set(file.rootRef, { t: 'dict', entries: catalog });
  const { bytes, marks } = writeUpdate(file, u);
  const start = marks.get('contents')!;
  const end = start + contents.length + 2;
  const text = `[0 ${start} ${end} ${bytes.length - end}]`.padEnd(36, ' ');
  const at = marks.get('byterange')!;
  for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
  return bytes;
}

describe('findDocTimeStamps: audit fixes', () => {
  it('a big stamp dictionary (more than 4096 bytes before /Contents) is still rangeOk', async () => {
    const [t] = findDocTimeStamps(handStamp(await basePdf(), { pad: 6000 }));
    expect(t!.error).toBeUndefined();
    expect(t!.rangeOk).toBe(true);
  });

  it('whitespace inside the hex string of the gap is tolerated', async () => {
    const [t] = findDocTimeStamps(handStamp(await basePdf(), { spaced: true }));
    expect(t!.error).toBeUndefined();
    expect(t!.rangeOk).toBe(true);
  });

  it('a direct /V copy does not inflate the count and the indirect entry wins', async () => {
    const one = await appendDocTimeStamp(await basePdf(), fakeStamper());
    const found = findDocTimeStamps(withCopy(one, 'direct'));
    expect(found.length).toBe(1);
    expect(found[0]!.object).not.toBe(0);
    expect(found[0]!.rangeOk).toBe(true);
  });

  it('a direct copy found before the indirect one is replaced by it', async () => {
    const one = await appendDocTimeStamp(await basePdf(), fakeStamper());
    const out = appendRevision(one, (file, u) => {
      const catalog = file.catalog;
      const form = file.dict(catalog.entries.get('AcroForm'))!;
      const fields = file.resolve(form.entries.get('Fields')) as PdfObject[];
      const v = file.dict(file.dict(fields[0]!)!.entries.get('V'))!;
      const copy = u.add(dict({ T: textString('Kopie'), V: v }));
      const f2 = new Map(form.entries);
      f2.set('Fields', [copy, ...fields]); // copy first
      const ref = catalog.entries.get('AcroForm');
      if (isRef(ref)) u.set(ref, { t: 'dict', entries: f2 });
      else {
        const c2 = new Map(catalog.entries);
        c2.set('AcroForm', { t: 'dict', entries: f2 });
        u.set(file.rootRef, { t: 'dict', entries: c2 });
      }
    });
    const found = findDocTimeStamps(out);
    expect(found.length).toBe(1);
    expect(found[0]!.object).not.toBe(0);
  });

  it('30 stamps in a 4 MB file are listed quickly with unchanged results', async () => {
    let pdf = appendRevision(await basePdf(), (_, u) => {
      u.add({ t: 'stream', dict: dict({}), data: new Uint8Array(4 * 1024 * 1024).fill(65) });
    });
    for (let i = 0; i < 30; i++)
      pdf = await appendDocTimeStamp(pdf, fakeStamper(), { reserve: 1024 });
    const t0 = performance.now();
    const found = findDocTimeStamps(pdf);
    const ms = performance.now() - t0;
    expect(found.length).toBe(30);
    expect(found.every((s) => s.rangeOk && s.tokenOk)).toBe(true);
    expect(ms).toBeLessThan(2000);
  });
});
