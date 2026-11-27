import {
  Update,
  name,
  raw,
  writeUpdate,
  appendDocTimeStamp,
  appendRevision,
  dict,
  findDocTimeStamps,
  isDict,
  hex,
  isRef,
  latin1,
  textString,
} from '../src/index.ts';
import type { PdfDict, PdfObject, PdfRef } from '../src/index.ts';
import { ascii, basePdf, failure, must, open } from './helpers.ts';

/** Like helpers' fakeStamper, but a DER SEQUENCE (what the library now requires). */
const fakeStamper = () => async (digest: Uint8Array) =>
  Uint8Array.from([0x30, digest.length, ...digest]);

const HEX = '0123456789ABCDEF';

/** Overwrites the stamp's /Contents hex digits (from the start) in a copy of the file. */
function setContents(pdf: Uint8Array, index: number, bytes: number[]): Uint8Array {
  const out = pdf.slice();
  const s = must(findDocTimeStamps(pdf))[index]!.byteRange;
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
    expect(await appendDocTimeStamp(pdf, async () => Uint8Array.from(out))).toMatchObject(
      failure('bad-token', /DER SEQUENCE/),
    );
  });

  it('accepts one DER SEQUENCE', async () => {
    const pdf = await basePdf();
    const out = must(
      await appendDocTimeStamp(pdf, async () => Uint8Array.from([0x30, 0x03, 1, 2, 3])),
    );
    const [t] = must(findDocTimeStamps(out));
    expect(t!.tokenOk).toBe(true);
    expect([...t!.token]).toEqual([0x30, 0x03, 1, 2, 3]);
  });
});

describe('findDocTimeStamps: token', () => {
  const seq = async (): Promise<Uint8Array> =>
    must(
      await appendDocTimeStamp(await basePdf(), async () => Uint8Array.from([0x30, 0x02, 5, 6])),
    );

  it('reports a valid token', async () => {
    const [t] = must(findDocTimeStamps(await seq()));
    expect(t!.tokenOk).toBe(true);
    expect(t!.rangeOk).toBe(true);
    expect(t!.error).toBeUndefined();
  });

  it('does not clamp a declared length larger than the stored bytes', async () => {
    const [t] = must(findDocTimeStamps(setContents(await seq(), 0, [0x30, 0x82, 0xff, 0xff])));
    expect(t!.tokenOk).toBe(false);
    expect(t!.token.length).toBe(0);
  });

  it('flags the unfilled all-zero placeholder', async () => {
    const [t] = must(findDocTimeStamps(setContents(await seq(), 0, [])));
    expect(t!.tokenOk).toBe(false);
    expect(t!.token.length).toBe(0);
  });

  it('flags a token that does not start with a SEQUENCE or has garbage after it', async () => {
    const pdf = await seq();
    expect(must(findDocTimeStamps(setContents(pdf, 0, [0x04, 0x01, 0x00])))[0]!.tokenOk).toBe(
      false,
    );
    expect(must(findDocTimeStamps(setContents(pdf, 0, [0x30, 0x00, 0x07])))[0]!.tokenOk).toBe(
      false,
    );
  });
});

describe('findDocTimeStamps: range', () => {
  it('rangeOk needs the gap to be this stamp’s own /Contents', async () => {
    const one = must(await appendDocTimeStamp(await basePdf(), fakeStamper()));
    const two = must(await appendDocTimeStamp(one, fakeStamper()));
    const [first, second] = must(findDocTimeStamps(two));
    expect(first!.rangeOk && second!.rangeOk).toBe(true);
    // Point the second stamp's range at the first stamp's string: same length, other bytes.
    const [, b1, c1] = first!.byteRange as [number, number, number];
    const end = second!.byteRange[2]! + second!.byteRange[3]!;
    const text = `[0 ${b1} ${c1} ${end - c1}]`.padEnd(36, ' ');
    const tampered = two.slice();
    const at = ascii(two).indexOf(`[${second!.byteRange.join(' ')}`);
    for (let i = 0; i < text.length; i++) tampered[at + i] = text.charCodeAt(i);
    const found = must(findDocTimeStamps(tampered));
    expect(found.find((s) => s.object === second!.object)!.rangeOk).toBe(false);
    expect(found.find((s) => s.object === first!.object)!.rangeOk).toBe(true);
  });
});

/** Adds a revision with the first stamp's dictionary copied into other fields. */
function withCopy(pdf: Uint8Array, shape: 'kids' | 'direct' | 'broken'): Uint8Array {
  return must(
    appendRevision(pdf, (file, u) => {
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
    }),
  );
}

describe('findDocTimeStamps: robustness', () => {
  const base = async (): Promise<Uint8Array> =>
    must(await appendDocTimeStamp(await basePdf(), fakeStamper()));

  it('follows /Kids', async () => {
    const found = must(findDocTimeStamps(withCopy(await base(), 'kids')));
    expect(found.length).toBe(2);
    expect(found.some((s) => s.field === 'Eltern.Kopie')).toBe(true);
  });

  it('accepts a direct /V dictionary (listed once, as the indirect stamp)', async () => {
    const found = must(findDocTimeStamps(withCopy(await base(), 'direct')));
    expect(found.length).toBe(1);
    expect(found[0]!.object).not.toBe(0);
  });

  it('a malformed stamp dictionary does not abort the listing', async () => {
    const pdf = withCopy(await base(), 'broken');
    expect(isDict(open(pdf).catalog)).toBe(true);
    const found = must(findDocTimeStamps(pdf));
    expect(found.length).toBe(2);
    const bad = found.find((s) => s.error !== undefined)!;
    expect(bad.rangeOk).toBe(false);
    expect(bad.tokenOk).toBe(false);
    expect(bad.byteRange).toEqual([]);
    expect(found.some((s) => s.error === undefined && s.rangeOk)).toBe(true);
  });

  it('tells apart a reused object number by its range', async () => {
    const one = await base();
    const two = must(await appendDocTimeStamp(one, fakeStamper()));
    expect(must(findDocTimeStamps(two)).length).toBe(2);
  });
});

/** Hand-built stamp revision (field + stamp dictionary) to shape the stamp object: padding, spaced hex. */
function handStamp(pdf: Uint8Array, opts: { pad?: number; spaced?: boolean }): Uint8Array {
  const file = open(pdf);
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
  const { bytes, marks } = must(writeUpdate(file, u));
  const start = marks.get('contents')!;
  const end = start + contents.length + 2;
  const text = `[0 ${start} ${end} ${bytes.length - end}]`.padEnd(36, ' ');
  const at = marks.get('byterange')!;
  for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
  return bytes;
}

describe('findDocTimeStamps: audit fixes', () => {
  it('a big stamp dictionary (more than 4096 bytes before /Contents) is still rangeOk', async () => {
    const [t] = must(findDocTimeStamps(handStamp(await basePdf(), { pad: 6000 })));
    expect(t!.error).toBeUndefined();
    expect(t!.rangeOk).toBe(true);
  });

  it('whitespace inside the hex string of the gap is tolerated', async () => {
    const [t] = must(findDocTimeStamps(handStamp(await basePdf(), { spaced: true })));
    expect(t!.error).toBeUndefined();
    expect(t!.rangeOk).toBe(true);
  });

  it('a direct /V copy does not inflate the count and the indirect entry wins', async () => {
    const one = must(await appendDocTimeStamp(await basePdf(), fakeStamper()));
    const found = must(findDocTimeStamps(withCopy(one, 'direct')));
    expect(found.length).toBe(1);
    expect(found[0]!.object).not.toBe(0);
    expect(found[0]!.rangeOk).toBe(true);
  });

  it('a direct copy found before the indirect one is replaced by it', async () => {
    const one = must(await appendDocTimeStamp(await basePdf(), fakeStamper()));
    const out = must(
      appendRevision(one, (file, u) => {
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
      }),
    );
    const found = must(findDocTimeStamps(out));
    expect(found.length).toBe(1);
    expect(found[0]!.object).not.toBe(0);
  });

  it('30 stamps in a 4 MB file are listed quickly with unchanged results', async () => {
    let pdf = must(
      appendRevision(await basePdf(), (_, u) => {
        u.add({ t: 'stream', dict: dict({}), data: new Uint8Array(4 * 1024 * 1024).fill(65) });
      }),
    );
    for (let i = 0; i < 30; i++)
      pdf = must(await appendDocTimeStamp(pdf, fakeStamper(), { reserve: 1024 }));
    const t0 = performance.now();
    const found = must(findDocTimeStamps(pdf));
    const ms = performance.now() - t0;
    expect(found.length).toBe(30);
    expect(found.every((s) => s.rangeOk && s.tokenOk)).toBe(true);
    expect(ms).toBeLessThan(2000);
  });
});

describe('forged /ByteRange', () => {
  it(
    'rangeDigest returns an empty digest for invalid ranges without allocating',
    { timeout: 2000 },
    async () => {
      const { rangeDigest } = await import('../src/index.ts');
      const b = new Uint8Array(100);
      for (const r of [
        [0, 4e9, 0, 1],
        [1, 2, 3, 4],
        [0, 50, 10, 1],
        [0, 4, 90, 20],
        [0, -1, 5, 1],
        [0, 1.5, 5, 1],
        [0, 4],
      ])
        expect(rangeDigest(b, r).length).toBe(0);
      expect(rangeDigest(b, [0, 4, 10, 90]).length).toBe(32);
    },
  );
});

/** Replaces the /ByteRange text of the index-th listed stamp (the width stays 36). */
function setRange(pdf: Uint8Array, index: number, range: number[]): Uint8Array {
  const old = must(findDocTimeStamps(pdf))[index]!.byteRange;
  const out = pdf.slice();
  const at = ascii(pdf).indexOf(`[${old.join(' ')}`);
  const text = `[${range.join(' ')}]`.padEnd(36, ' ');
  for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i);
  return out;
}

interface Hand {
  /** Hex digits of the stamp's own /Contents (default 2048 zeros). */
  readonly hex?: string;
  /** Where the range's gap is: the stamp's own string, a copy inside another object, or a direct /V. */
  readonly where: 'own' | 'other' | 'direct';
  /** Literal text put into the stamp dictionary before /Contents. */
  readonly pad?: string;
}

/** Hand-built stamp revision whose /ByteRange gap can be put elsewhere than the stamp's own string. */
function handRange(pdf: Uint8Array, o: Hand): Uint8Array {
  const file = open(pdf);
  const u = new Update(file);
  const hex = o.hex ?? '0'.repeat(2048);
  const entries = {
    ...(o.pad === undefined ? {} : { Pad: raw('(' + o.pad + ')') }),
    SubFilter: name('ETSI.RFC3161'),
    ByteRange: raw('[' + ' '.repeat(34) + ']', 'byterange'),
    Contents: raw('<' + hex + '>', 'contents'),
  };
  let field: PdfRef;
  if (o.where === 'direct')
    field = u.add(dict({ FT: name('Sig'), T: textString('H'), V: dict(entries) }));
  else {
    const sig = u.add(dict(entries));
    field = u.add(dict({ FT: name('Sig'), T: textString('H'), V: sig }));
    if (o.where === 'other') u.add(dict({ Copy: raw('<' + hex + '>', 'other') }));
  }
  const catalog = new Map(file.catalog.entries);
  catalog.set('AcroForm', dict({ Fields: [field], SigFlags: 3 }));
  u.set(file.rootRef, { t: 'dict', entries: catalog });
  const { bytes, marks } = must(writeUpdate(file, u));
  const start = marks.get(o.where === 'other' ? 'other' : 'contents')!;
  const end = start + hex.length + 2;
  const text = `[0 ${start} ${end} ${bytes.length - end}]`.padEnd(36, ' ');
  const at = marks.get('byterange')!;
  for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
  return bytes;
}

describe('findDocTimeStamps: isOwnContents', () => {
  it('the hand-built own string is rangeOk (control)', async () => {
    const [t] = must(findDocTimeStamps(handRange(await basePdf(), { where: 'own' })));
    expect(t!.error).toBeUndefined();
    expect(t!.rangeOk).toBe(true);
  });

  it('a gap inside another object is not rangeOk (wrong object number)', async () => {
    const [t] = must(findDocTimeStamps(handRange(await basePdf(), { where: 'other' })));
    expect(t!.error).toBeUndefined();
    expect(t!.revision).not.toBeNull();
    expect(t!.rangeOk).toBe(false);
  });

  it('an `endobj` between the object header and the string is not rangeOk', async () => {
    const [t] = must(
      findDocTimeStamps(handRange(await basePdf(), { where: 'own', pad: 'endobj' })),
    );
    expect(t!.error).toBeUndefined();
    expect(t!.rangeOk).toBe(false);
  });

  it('extra trailing hex digits in the gap compared with the parsed value are not rangeOk', async () => {
    // An odd digit count parses to one byte more than half the digits; the gap has a digit beyond them.
    const odd = must(
      findDocTimeStamps(handRange(await basePdf(), { where: 'own', hex: '0'.repeat(2049) })),
    );
    expect(odd[0]!.error).toBeUndefined();
    expect(odd[0]!.rangeOk).toBe(false);
  });

  it('a direct /V dictionary with a correct range is rangeOk with object 0', async () => {
    const [t] = must(findDocTimeStamps(handRange(await basePdf(), { where: 'direct' })));
    expect(t!.error).toBeUndefined();
    expect(t!.object).toBe(0);
    expect(t!.rangeOk).toBe(true);
  });
});

describe('findDocTimeStamps: range end', () => {
  const two = async (): Promise<Uint8Array> =>
    must(
      await appendDocTimeStamp(
        must(await appendDocTimeStamp(await basePdf(), fakeStamper())),
        fakeStamper(),
      ),
    );

  it('a range ending at the revision end plus a line end is accepted', async () => {
    const [first] = must(findDocTimeStamps(await two()));
    expect(first!.revision).not.toBeNull();
    expect(first!.rangeOk).toBe(true);
  });

  it('a range ending two non-EOL bytes after the revision end is not rangeOk, revision null', async () => {
    const pdf = await two();
    const [r] = must(findDocTimeStamps(pdf));
    const [a, b, c, d] = r!.byteRange as [number, number, number, number];
    const t = must(findDocTimeStamps(setRange(pdf, 0, [a, b, c, d + 1])))[0]!;
    expect(t.byteRange[3]).toBe(d + 1);
    expect(t.revision).toBeNull();
    expect(t.rangeOk).toBe(false);
  });

  it('a range ending in the middle of a revision is not rangeOk, revision null', async () => {
    const pdf = must(await appendDocTimeStamp(await basePdf(), fakeStamper()));
    const [a, b, c, d] = must(findDocTimeStamps(pdf))[0]!.byteRange as [
      number,
      number,
      number,
      number,
    ];
    const t = must(findDocTimeStamps(setRange(pdf, 0, [a, b, c, d - 50])))[0]!;
    expect(t.revision).toBeNull();
    expect(t.rangeOk).toBe(false);
  });
});

describe('appendDocTimeStamp: reserve', () => {
  it.each([10, 1023, 65537, 70000, 1.5, Number.NaN])(
    'refuses reserve %s (bad-options)',
    async (reserve) => {
      expect(await appendDocTimeStamp(await basePdf(), fakeStamper(), { reserve })).toMatchObject(
        failure('bad-options'),
      );
    },
  );

  it.each([1024, 65536])('accepts reserve %s', async (reserve) => {
    const out = must(await appendDocTimeStamp(await basePdf(), fakeStamper(), { reserve }));
    expect(must(findDocTimeStamps(out))[0]!.rangeOk).toBe(true);
  });
});

describe('findDocTimeStamps: /ByteRange length', () => {
  it.each([3, 5])('a /ByteRange of %s entries yields an entry with an error', async (n) => {
    const one = must(await appendDocTimeStamp(await basePdf(), fakeStamper()));
    const pdf = must(
      appendRevision(one, (file, u) => {
        const form = file.dict(file.catalog.entries.get('AcroForm'))!;
        const fields = file.resolve(form.entries.get('Fields')) as PdfObject[];
        const v = file.dict(file.dict(fields[0]!)!.entries.get('V'))!;
        const bad = new Map(v.entries);
        bad.set(
          'ByteRange',
          Array.from({ length: n }, (_, i) => i),
        );
        const field = u.add(
          dict({ T: textString('Kaputt'), V: u.add({ t: 'dict', entries: bad }) }),
        );
        const f2 = new Map(form.entries);
        f2.set('Fields', [...fields, field]);
        const ref = file.catalog.entries.get('AcroForm');
        if (isRef(ref)) u.set(ref, { t: 'dict', entries: f2 });
        else {
          const c2 = new Map(file.catalog.entries);
          c2.set('AcroForm', { t: 'dict', entries: f2 });
          u.set(file.rootRef, { t: 'dict', entries: c2 });
        }
      }),
    );
    const bad = must(findDocTimeStamps(pdf)).find((s) => s.error !== undefined);
    expect(bad).toBeDefined();
    expect(bad!.rangeOk).toBe(false);
    expect(bad!.byteRange).toEqual([]);
  });
});

describe('rangeDigest', () => {
  it('equals the node:crypto digest of the joined ranges', async () => {
    const { createHash, randomBytes } = await import('node:crypto');
    const { rangeDigest } = await import('../src/index.ts');
    const bytes = new Uint8Array(randomBytes(1000));
    for (const range of [
      [0, 100, 300, 700],
      [0, 63, 64, 936],
      [0, 0, 500, 500],
      [0, 1000, 1000, 0],
      [0, 129, 400, 3],
    ]) {
      const [, b, c, d] = range as [number, number, number, number];
      const joined = Buffer.concat([bytes.subarray(0, b), bytes.subarray(c, c + d)]);
      expect(Buffer.from(rangeDigest(bytes, range)).toString('hex')).toBe(
        createHash('sha256').update(joined).digest('hex'),
      );
    }
    expect(rangeDigest(bytes, [0, 10, 5, 1])).toHaveLength(0);
  });
});

describe('revisionBytes and time stamps', () => {
  it('every revision prefix keeps its stamps rangeOk, tokenOk and with the same digest', async () => {
    let pdf = must(await appendDocTimeStamp(await basePdf(), fakeStamper()));
    pdf = must(
      appendRevision(pdf, (_f, u) => {
        u.add(dict({ Note: textString('x') }));
      }),
    );
    pdf = must(await appendDocTimeStamp(pdf, fakeStamper()));
    const full = must(findDocTimeStamps(pdf));
    expect(full).toHaveLength(2);
    const file = open(pdf);
    for (let i = 0; i < file.revisions.length; i++) {
      const part = must(findDocTimeStamps(file.revisionBytes(i)));
      for (const [k, t] of part.entries()) {
        expect(t.rangeOk).toBe(true);
        expect(t.tokenOk).toBe(true);
        expect(t.digest).toEqual(full[k]!.digest);
      }
      expect(part.length).toBe(full.filter((t) => t.revision! <= i).length);
    }
  });
});

describe('field names', () => {
  it('lists a stamp whose Latin-1 /T has 300000 bytes, with the name decoded', async () => {
    const base = await basePdf();
    const long = 'a'.repeat(300000);
    const pdf = must(
      appendRevision(base, (_f, u) => {
        const field = u.add(
          dict({
            FT: name('Sig'),
            T: latin1(long),
            V: dict({
              Type: name('DocTimeStamp'),
              SubFilter: name('ETSI.RFC3161'),
              ByteRange: [0, 0, 0, 0],
              Contents: hex(new Uint8Array(8)),
            }),
          }),
        );
        const catalog = new Map(_f.catalog.entries);
        catalog.set('AcroForm', dict({ Fields: [field] }));
        u.set(_f.rootRef, { t: 'dict', entries: catalog });
      }),
    );
    const found = must(findDocTimeStamps(pdf));
    expect(found).toHaveLength(1);
    expect(found[0]!.field).toBe(long);
  });

  it('lists a stamp whose /T is an odd-length UTF-16 string, named by its bytes', async () => {
    const base = await basePdf();
    const stamp = () =>
      dict({
        Type: name('DocTimeStamp'),
        SubFilter: name('ETSI.RFC3161'),
        ByteRange: [0, 0, 0, 0],
        Contents: hex(new Uint8Array(8)),
      });
    const pdf = must(
      appendRevision(base, (f, u) => {
        const field = u.add(
          dict({
            FT: name('Sig'),
            T: hex(Uint8Array.from([0xfe, 0xff, 0x00, 0x41, 0x00])),
            V: stamp(),
          }),
        );
        const catalog = new Map(f.catalog.entries);
        catalog.set('AcroForm', dict({ Fields: [field] }));
        u.set(f.rootRef, { t: 'dict', entries: catalog });
      }),
    );
    const found = must(findDocTimeStamps(pdf));
    expect(found).toHaveLength(1);
    expect(found[0]!.error).toBeUndefined();
    expect(found[0]!.field).toBe('\u00fe\u00ff\u0000A\u0000');
  });
});
