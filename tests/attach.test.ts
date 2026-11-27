import { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import {
  appendRevision,
  attachFile,
  attachmentChanges,
  dict,
  hex,
  latin1,
  name,
  readAttachments,
  textString,
  ref,
  type PdfObject,
} from '../src/index.ts';
import { ascii, basePdf, text, must, open, failure } from './helpers.ts';

const hashed = vi.hoisted(() => ({ big: 0 }));
vi.mock('../src/sha256.ts', async (orig) => {
  const real = await orig<typeof import('../src/sha256.ts')>();
  return {
    ...real,
    sha256Bytes: (d: Uint8Array) => {
      if (d.length >= 1000) hashed.big++;
      return real.sha256Bytes(d);
    },
  };
});

const file = (n: string, body = '{}') => ({
  name: n,
  data: text(body),
  mimeType: 'application/json',
});

/** Replaces the catalog's /Names in a new revision. */
const withNames = (pdf: Uint8Array, build: (u: import('../src/index.ts').Update) => PdfObject) =>
  must(
    appendRevision(pdf, (f, u) => {
      const names = build(u);
      const cat = { t: 'dict' as const, entries: new Map(f.catalog.entries) };
      cat.entries.set('Names', names);
      u.set(f.rootRef, cat);
    }),
  );

const spec = (u: import('../src/index.ts').Update, n: string, body: string, extra = {}) => {
  const ef = u.add({
    t: 'stream',
    dict: dict({ Type: name('EmbeddedFile'), Subtype: name('text/plain'), ...extra }),
    data: text(body),
  });
  return u.add(dict({ Type: name('Filespec'), F: latin1(n), EF: dict({ F: ef }) }));
};

const utf16 = (s: string) =>
  hex(Uint8Array.from([0xfe, 0xff, ...[...s].flatMap((c) => [0, c.charCodeAt(0)])]));

describe('name tree keys', () => {
  it('reads pdf-lib UTF-16 keys, refuses a duplicate of the same logical name and keeps old key bytes', async () => {
    const doc = await PDFDocument.load(await basePdf());
    await doc.attach(text('x'), 'alt.txt', { mimeType: 'text/plain' });
    const base = await doc.save({ useObjectStreams: false });
    expect(must(await readAttachments(open(base))).map((a) => a.name)).toEqual(['alt.txt']);
    expect(appendRevision(base, (f, u) => attachFile(f, u, file('alt.txt')))).toMatchObject(
      failure('name-exists', 'exists'),
    );
    const next = must(appendRevision(base, (f, u) => attachFile(f, u, file('neu.json'))));
    const f2 = open(next);
    const names = must(await readAttachments(f2)).map((a) => a.name);
    expect(names).toEqual(['neu.json', 'alt.txt']); // raw bytes: 'n' (6E) before FE FF
    const tree = f2.dict(f2.dict(f2.catalog.entries.get('Names'))!.entries.get('EmbeddedFiles'))!;
    const pairs = tree.entries.get('Names') as PdfObject[];
    expect((pairs[2] as { t: string }).t).toBe('hex');
    expect(ascii(next)).toContain('<FEFF');
  });

  it('decodes a Latin-1 key', async () => {
    const pdf = withNames(await basePdf(), (u) =>
      dict({
        EmbeddedFiles: dict({
          Names: [{ t: 'str', bytes: Uint8Array.from([0xe4, 0x2e, 0x74]) }, spec(u, 'x', 'a')],
        }),
      }),
    );
    expect(must(await readAttachments(open(pdf))).map((a) => a.name)).toEqual(['ä.t']);
  });

  it('fails on a non-string key instead of dropping it', async () => {
    const pdf = withNames(await basePdf(), (u) =>
      dict({ EmbeddedFiles: dict({ Names: [7, spec(u, 'x', 'a')] }) }),
    );
    expect(appendRevision(pdf, (f, u) => attachFile(f, u, file('n.json')))).toMatchObject(
      failure('syntax'),
    );
    expect(await readAttachments(open(pdf))).toMatchObject(failure('syntax'));
  });
});

describe('indirect name tree parts', () => {
  const indirect = async () => {
    let arr!: PdfObject;
    const pdf = withNames(await basePdf(), (u) => {
      const s = spec(u, 'a.txt', 'A');
      arr = u.add([utf16('a.txt'), s]);
      const tree = u.add(dict({ Names: arr }));
      return u.add(dict({ EmbeddedFiles: tree }));
    });
    return pdf;
  };

  it('reads and extends an indirect /Names array', async () => {
    const pdf = await indirect();
    expect(must(await readAttachments(open(pdf))).map((a) => a.name)).toEqual(['a.txt']);
    expect(appendRevision(pdf, (f, u) => attachFile(f, u, file('a.txt')))).toMatchObject(
      failure('name-exists', 'exists'),
    );
    const next = must(appendRevision(pdf, (f, u) => attachFile(f, u, file('b.json'))));
    expect(must(await readAttachments(open(next))).map((a) => a.name)).toEqual(['b.json', 'a.txt']);
  });

  it('fails when /Names is neither an array nor a reference to one', async () => {
    const pdf = withNames(await basePdf(), () => dict({ EmbeddedFiles: dict({ Names: 5 }) }));
    expect(appendRevision(pdf, (f, u) => attachFile(f, u, file('b.json')))).toMatchObject(
      failure('syntax'),
    );
    const pdf2 = withNames(await basePdf(), () =>
      dict({ EmbeddedFiles: dict({ Names: ref(9999) }) }),
    );
    expect(await readAttachments(open(pdf2))).toMatchObject(failure('object-missing'));
  });
});

describe('/Kids', () => {
  it('readAttachments walks kids; attachFile refuses them', async () => {
    const pdf = withNames(await basePdf(), (u) => {
      const k1 = u.add(dict({ Names: [latin1('a'), spec(u, 'a', 'A')] }));
      const k2 = u.add(dict({ Names: [latin1('b'), spec(u, 'b', 'B')] }));
      return dict({ EmbeddedFiles: dict({ Kids: [k1, k2] }) });
    });
    const found = must(await readAttachments(open(pdf)));
    expect(found.map((a) => [a.name, ascii(a.data)])).toEqual([
      ['a', 'A'],
      ['b', 'B'],
    ]);
    expect(appendRevision(pdf, (f, u) => attachFile(f, u, file('c.json')))).toMatchObject(
      failure('unsupported-name-tree', 'Kids'),
    );
  });

  it('is cycle-safe', async () => {
    const pdf = withNames(await basePdf(), (u) => {
      const k = u.add(dict({}));
      u.set(k, dict({ Kids: [k] }));
      return dict({ EmbeddedFiles: dict({ Kids: [k] }) });
    });
    expect(await readAttachments(open(pdf))).toMatchObject(failure('syntax'));
  });
});

describe('attachmentChanges', () => {
  const forge = (pdf: Uint8Array, desc: string, mime: string, rel: string, extra = {}) =>
    withNames(pdf, (u) => {
      const ef = u.add({
        t: 'stream',
        dict: dict({ Subtype: name(mime), ...extra }),
        data: text('same'),
      });
      const s = u.add(
        dict({
          Type: name('Filespec'),
          F: latin1('f.txt'),
          Desc: latin1(desc),
          AFRelationship: name(rel),
          EF: dict({ F: ef }),
        }),
      );
      return dict({ EmbeddedFiles: dict({ Names: [latin1('f.txt'), s] }) });
    });
  const start = async () => forge(await basePdf(), 'd', 'text/plain', 'Data');

  it('reports a changed MIME type, relationship or description', async () => {
    const r1 = await start();
    for (const [d, m, r] of [
      ['x', 'text/plain', 'Data'],
      ['d', 'text/html', 'Data'],
      ['d', 'text/plain', 'Source'],
    ] as const)
      expect(must(await attachmentChanges(forge(r1, d, m, r)))).toEqual([
        { name: 'f.txt', kind: 'changed', revision: 2 },
      ]);
    expect(must(await attachmentChanges(forge(r1, 'd', 'text/plain', 'Data')))).toEqual([]);
  });

  it('keeps a file with an unsupported filter and reports it as changed, not removed', async () => {
    const r1 = await forge(await basePdf(), 'd', 'text/plain', 'Data', {
      Filter: name('LZWDecode'),
    });
    const found = must(await readAttachments(open(r1)));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ unsupportedFilter: true, filter: 'LZWDecode' });
    expect(must(await attachmentChanges(r1))).toEqual([]);
    const r2 = forge(r1, 'd', 'text/plain', 'Data', { Filter: name('ASCIIHexDecode') });
    expect(must(await attachmentChanges(r2))).toEqual([
      { name: 'f.txt', kind: 'changed', revision: 2 },
    ]);
  });
});

describe('name tree order', () => {
  it('sorts by raw key bytes: ASCII keys before pdf-lib UTF-16 (FE FF) keys', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    await doc.attach(text('z'), 'Zebra.txt', { mimeType: 'text/plain' });
    await doc.attach(text('m'), 'Mango.txt', { mimeType: 'text/plain' });
    const base = new Uint8Array(await doc.save({ useObjectStreams: false }));
    const out = must(appendRevision(base, (f, u) => attachFile(f, u, file('a.txt'))));
    const names = must(await readAttachments(open(out))).map((x) => x.name);
    expect(names[0]).toBe('a.txt');
    expect([...names].sort()).toEqual(['Mango.txt', 'Zebra.txt', 'a.txt']);
    expect(new Set(names.slice(1))).toEqual(new Set(['Mango.txt', 'Zebra.txt']));
  });
});

describe('attachmentChanges cost', () => {
  it('inflates each distinct stream once, however many revisions follow', async () => {
    const deflate = async (d: Uint8Array) =>
      new Uint8Array(
        await new Response(
          new Blob([d as BlobPart]).stream().pipeThrough(new CompressionStream('deflate')),
        ).arrayBuffer(),
      );
    const packed = [await deflate(text('one')), await deflate(text('two'))];
    let pdf = withNames(await basePdf(), (u) => {
      const pairs: PdfObject[] = [];
      packed.forEach((data, i) => {
        const ef = u.add({
          t: 'stream',
          dict: dict({ Subtype: name('text/plain'), Filter: name('FlateDecode') }),
          data,
        });
        const s = u.add(dict({ Type: name('Filespec'), F: latin1(`f${i}`), EF: dict({ F: ef }) }));
        pairs.push(latin1(`f${i}`), s);
      });
      return dict({ EmbeddedFiles: dict({ Names: pairs }) });
    });
    for (let i = 0; i < 4; i++)
      pdf = must(appendRevision(pdf, (f, u) => u.set(f.rootRef, f.catalog)));
    const Real = globalThis.DecompressionStream;
    let calls = 0;
    globalThis.DecompressionStream = class extends Real {
      constructor(format: CompressionFormat) {
        super(format);
        calls++;
      }
    } as typeof DecompressionStream;
    try {
      expect(must(await attachmentChanges(pdf))).toEqual([]);
    } finally {
      globalThis.DecompressionStream = Real;
    }
    expect(calls).toBe(2);
  });
});

describe('guards of the name tree and the writer', () => {
  /** A /Kids chain `depth` nodes deep with one file in the deepest node. */
  const chain = async (depth: number) =>
    withNames(await basePdf(), (u) => {
      let cur: PdfObject = u.add(dict({ Names: [latin1('deep'), spec(u, 'deep', 'D')] }));
      for (let i = 1; i < depth; i++) cur = u.add(dict({ Kids: [cur] }));
      return dict({ EmbeddedFiles: dict({ Kids: [cur] }) });
    });

  it('names the loop of a cyclic /Kids', async () => {
    const pdf = withNames(await basePdf(), (u) => {
      const k = u.add(dict({}));
      u.set(k, dict({ Kids: [k] }));
      return dict({ EmbeddedFiles: dict({ Kids: [k] }) });
    });
    expect(await readAttachments(open(pdf))).toMatchObject(failure('syntax', /loop/));
  });

  it('follows a /Kids chain of 20 levels and refuses one of 40', async () => {
    const ok = must(await readAttachments(open(await chain(20))));
    expect(ok.map((a) => a.name)).toEqual(['deep']);
    const deep = await chain(40);
    expect(await readAttachments(open(deep))).toMatchObject(failure('syntax'));
    expect(await readAttachments(open(deep))).toMatchObject(failure('syntax', /too deep/));
  });

  it('refuses names with a line end or non-ASCII and MIME types without a subtype', async () => {
    const pdf = await basePdf();
    for (const n of ['ä\n', 'a\n', '', 'ä.txt'])
      expect(appendRevision(pdf, (f, u) => attachFile(f, u, file(n)))).toMatchObject(
        failure('bad-name', /printable/),
      );
    for (const m of ['text', 'text/plain\n', '/plain', 'text/'])
      expect(
        appendRevision(pdf, (f, u) =>
          attachFile(f, u, { name: 'a.txt', data: text('x'), mimeType: m }),
        ),
      ).toMatchObject(failure('bad-mime', /MIME/));
  });
});

describe('attachmentChanges reporting', () => {
  const version = (
    pdf: Uint8Array,
    body: string | undefined,
    desc = 'd',
    extra: Record<string, PdfObject> = {},
  ) =>
    withNames(pdf, (u) => {
      if (body === undefined) return dict({});
      const ef = u.add({
        t: 'stream',
        dict: dict({ Subtype: name('text/plain'), ...extra }),
        data: text(body),
      });
      const s = u.add(
        dict({
          Type: name('Filespec'),
          F: latin1('f.txt'),
          Desc: latin1(desc),
          EF: dict({ F: ef }),
        }),
      );
      return dict({ EmbeddedFiles: dict({ Names: [latin1('f.txt'), s] }) });
    });

  it('reports a file changed in one revision and removed in a later one once, at the change', async () => {
    const r1 = version(await basePdf(), 'one');
    const r2 = version(r1, 'two');
    const r3 = version(r2, undefined);
    expect(must(await attachmentChanges(r3))).toEqual([
      { name: 'f.txt', kind: 'changed', revision: 2 },
    ]);
  });

  it('length-prefixes the fields: description "ab" + filter "c" differs from "a" + "bc"', async () => {
    const r1 = version(await basePdf(), 'same', 'ab', { Filter: name('c') });
    const r2 = version(r1, 'same', 'a', { Filter: name('bc') });
    expect(must(await attachmentChanges(r2))).toEqual([
      { name: 'f.txt', kind: 'changed', revision: 2 },
    ]);
    expect(must(await attachmentChanges(version(r1, 'same', 'ab', { Filter: name('c') })))).toEqual(
      [],
    );
  });
});

describe('attachmentChanges hashing of unfiltered attachments', () => {
  it('hashes each distinct attachment once over 8 revisions', async () => {
    let pdf = await basePdf();
    for (let i = 0; i < 8; i++) {
      const data = new Uint8Array(2000).fill(i + 1);
      pdf = must(
        appendRevision(pdf, (f, u) =>
          attachFile(f, u, { name: `a${i}.bin`, data, mimeType: 'application/octet-stream' }),
        ),
      );
    }
    hashed.big = 0;
    expect(must(await attachmentChanges(pdf))).toEqual([]);
    expect(hashed.big).toBe(8);
  });

  it('does not mix an unfiltered stream with a deflated one of equal raw bytes', async () => {
    const raw = new Uint8Array(
      await new Response(
        new Blob([text('hello hello hello') as BlobPart])
          .stream()
          .pipeThrough(new CompressionStream('deflate')),
      ).arrayBuffer(),
    );
    const mk = (n: string, u: import('../src/index.ts').Update, filter: boolean) => {
      const ef = u.add({
        t: 'stream',
        dict: dict({
          Subtype: name('text/plain'),
          ...(filter ? { Filter: name('FlateDecode') } : {}),
        }),
        data: raw,
      });
      return [
        latin1(n),
        u.add(dict({ Type: name('Filespec'), F: latin1(n), EF: dict({ F: ef }) })),
      ];
    };
    const pdf = withNames(await basePdf(), (u) =>
      dict({ EmbeddedFiles: dict({ Names: [...mk('a', u, false), ...mk('b', u, true)] }) }),
    );
    const found = must(await readAttachments(open(pdf), new Map()));
    expect(found.find((a) => a.name === 'a')!.data).toEqual(raw);
    expect(ascii(found.find((a) => a.name === 'b')!.data)).toBe('hello hello hello');
  });
});

describe('very long strings', () => {
  it('reads a 300000 byte /Desc and a 300000 byte name tree key back', async () => {
    const big = 'x'.repeat(300000);
    const pdf = must(
      appendRevision(await basePdf(), (f, u) => {
        const ef = u.add({
          t: 'stream',
          dict: dict({ Subtype: name('text/plain') }),
          data: text('d'),
        });
        const s = u.add(
          dict({ Type: name('Filespec'), F: latin1('k'), Desc: latin1(big), EF: dict({ F: ef }) }),
        );
        const cat = { t: 'dict' as const, entries: new Map(f.catalog.entries) };
        cat.entries.set('Names', dict({ EmbeddedFiles: dict({ Names: [latin1(big), s] }) }));
        u.set(f.rootRef, cat);
      }),
    );
    const found = must(await readAttachments(open(pdf)));
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe(big);
    expect(found[0]!.description).toBe(big);
  });
});

describe('inflate cap', () => {
  const deflate = async (d: Uint8Array) =>
    new Uint8Array(
      await new Response(
        new Blob([d as BlobPart]).stream().pipeThrough(new CompressionStream('deflate')),
      ).arrayBuffer(),
    );
  const withFlate = (pdf: Uint8Array, raw: Uint8Array) =>
    withNames(pdf, (u) => {
      const ef = u.add({
        t: 'stream',
        dict: dict({ Subtype: name('text/plain'), Filter: name('FlateDecode') }),
        data: raw,
      });
      const s = u.add(dict({ Type: name('Filespec'), F: latin1('z.bin'), EF: dict({ F: ef }) }));
      return dict({ EmbeddedFiles: dict({ Names: [latin1('z.bin'), s] }) });
    });

  it('returns a too large stream raw and flagged, and still compares it', async () => {
    const raw = await deflate(new Uint8Array(5_000_000));
    expect(raw.length).toBeLessThan(100_000);
    const pdf = await withFlate(await basePdf(), raw);
    const f = open(pdf);
    const small = must(await readAttachments(f, undefined, { maxInflatedBytes: 1_000_000 }));
    expect(small[0]).toMatchObject({ tooLarge: true, filter: 'FlateDecode' });
    expect(small[0]!.data).toEqual(raw);
    const all = must(await readAttachments(f, undefined, { maxInflatedBytes: 5_000_000 }));
    expect(all[0]!.tooLarge).toBeUndefined();
    expect(all[0]!.data.length).toBe(5_000_000);
    // a cached larger result does not leak past a smaller cap
    const cache = new Map();
    must(await readAttachments(f, cache));
    expect(must(await readAttachments(f, cache, { maxInflatedBytes: 10 }))[0]!.tooLarge).toBe(true);
    expect(must(await attachmentChanges(pdf))).toEqual([]);
  });
});

describe('UTF-8 key and duplicate hardening', () => {
  const utf8Key = (s: string) => hex(Uint8Array.from([0xef, 0xbb, 0xbf, ...text(s)]));
  const deflate = async (d: Uint8Array) =>
    new Uint8Array(
      await new Response(
        new Blob([d as BlobPart]).stream().pipeThrough(new CompressionStream('deflate')),
      ).arrayBuffer(),
    );
  const flateFile = (
    pdf: Uint8Array,
    raw: Uint8Array,
    extra: Record<string, PdfObject> = {},
    n = 'z.bin',
  ) =>
    withNames(pdf, (u) => {
      const ef = u.add({
        t: 'stream',
        dict: dict({ Subtype: name('text/plain'), Filter: name('FlateDecode'), ...extra }),
        data: raw,
      });
      const s = u.add(dict({ Type: name('Filespec'), F: latin1(n), EF: dict({ F: ef }) }));
      return dict({ EmbeddedFiles: dict({ Names: [latin1(n), s] }) });
    });

  it('decodes a UTF-8 BOM key and refuses the same logical name', async () => {
    const pdf = must(
      await appendRevision(await basePdf(), (f, u) => {
        const s = spec(u, 'a.txt', 'x');
        const cat = { t: 'dict' as const, entries: new Map(f.catalog.entries) };
        cat.entries.set('Names', dict({ EmbeddedFiles: dict({ Names: [utf8Key('a.txt'), s] }) }));
        u.set(f.rootRef, cat);
      }),
    );
    expect(must(await readAttachments(open(pdf))).map((a) => a.name)).toEqual(['a.txt']);
    expect(appendRevision(pdf, (f, u) => attachFile(f, u, file('a.txt')))).toMatchObject(
      failure('name-exists', /exists/),
    );
  });

  it('reports a duplicate name inside one revision as changed', async () => {
    const pdf = await withNames(await basePdf(), (u) => {
      const orig = spec(u, 'a', 'orig');
      const evil = spec(u, 'a', 'evil');
      return dict({ EmbeddedFiles: dict({ Names: [latin1('a'), evil, latin1('a'), orig] }) });
    });
    expect(must(await attachmentChanges(pdf))).toEqual([
      { name: 'a', kind: 'changed', revision: 1 },
    ]);
  });

  it('refuses bad maxInflatedBytes with bad-options', async () => {
    const f = open(await basePdf());
    for (const bad of [Number.NaN, -1, 1.5, '5' as unknown as number, null as unknown as number])
      expect(await readAttachments(f, undefined, { maxInflatedBytes: bad })).toMatchObject(
        failure('bad-options'),
      );
    expect(must(await readAttachments(f, undefined, { maxInflatedBytes: Infinity }))).toEqual([]);
    expect(must(await readAttachments(f, undefined, { maxInflatedBytes: 0 }))).toEqual([]);
  });

  it('returns a corrupt or truncated stream raw with inflateError and still compares it', async () => {
    const good = await deflate(text('hello hello hello hello'));
    const cases = [good.slice(0, good.length - 6), Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])];
    for (const raw of cases) {
      const pdf = await flateFile(await basePdf(), raw);
      const found = must(await readAttachments(open(pdf)));
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ unsupportedFilter: true, filter: 'FlateDecode' });
      expect(typeof found[0]!.inflateError).toBe('string');
      expect(found[0]!.data).toEqual(raw);
      expect(must(await attachmentChanges(pdf))).toEqual([]);
    }
  });

  it('flags trailing junk after the deflate data', async () => {
    const raw = Uint8Array.from([...(await deflate(text('abc'))), 9, 9, 9, 9]);
    const found = must(await readAttachments(open(await flateFile(await basePdf(), raw))));
    expect(found).toHaveLength(1);
    if (found[0]!.inflateError === undefined) expect(ascii(found[0]!.data)).toBe('abc');
    else expect(found[0]!.data).toEqual(raw);
  });

  it('flags /FlateDecode with predictor /DecodeParms as unsupported (raw bytes)', async () => {
    const raw = await deflate(text('some predicted data'));
    for (const parms of [
      dict({ Predictor: 12, Columns: 4 }),
      dict({ Predictor: 2 }),
      [dict({ Predictor: 12 })],
    ]) {
      const pdf = await flateFile(await basePdf(), raw, { DecodeParms: parms as PdfObject });
      const [a] = must(await readAttachments(open(pdf)));
      expect(a).toMatchObject({ unsupportedFilter: true, filter: 'FlateDecode' });
      expect(a!.data).toEqual(raw);
    }
    const plain = await flateFile(await basePdf(), raw, { DecodeParms: dict({ Predictor: 1 }) });
    expect(ascii(must(await readAttachments(open(plain)))[0]!.data)).toBe('some predicted data');
  });
});

describe('attachmentChanges: every field of the attachment', () => {
  interface Opts {
    f?: string;
    uf?: string | null;
    efUf?: 'same' | 'other' | 'otherType' | 'otherData' | 'otherFilter' | null;
    size?: number | null;
    mod?: string | null;
    efType?: string | null;
    specType?: string | null;
    af?: 'in' | 'out' | 'none';
    tree?: boolean;
  }
  const build = (pdf: Uint8Array, o: Opts = {}) =>
    must(
      appendRevision(pdf, (f, u) => {
        const params = dict({
          Size: o.size === null ? undefined : (o.size ?? 4),
          ModDate: o.mod === null ? undefined : latin1(o.mod ?? 'D:20261124000000Z'),
        });
        const ef = u.add({
          t: 'stream',
          dict: dict({
            Type: o.efType === null ? undefined : name(o.efType ?? 'EmbeddedFile'),
            Subtype: name('text/plain'),
            Params: params,
          }),
          data: text('same'),
        });
        const mode = o.efUf === undefined ? 'same' : o.efUf;
        const other =
          mode === 'same' || mode === null
            ? undefined
            : u.add({
                t: 'stream',
                dict: dict({
                  Subtype: name(mode === 'otherType' ? 'text/html' : 'text/plain'),
                  ...(mode === 'otherFilter' ? { Filter: name('ASCIIHexDecode') } : {}),
                }),
                data: text(mode === 'otherData' ? 'diff' : 'same'),
              });
        const ufRef = mode === null ? undefined : mode === 'same' ? ef : other;
        const s = u.add(
          dict({
            Type: o.specType === null ? undefined : name(o.specType ?? 'Filespec'),
            F: latin1(o.f ?? 'f.txt'),
            UF: o.uf === null ? undefined : textString(o.uf ?? 'f.txt'),
            AFRelationship: name('Data'),
            EF: dict({ F: ef, UF: ufRef }),
          }),
        );
        const cat = { t: 'dict' as const, entries: new Map(f.catalog.entries) };
        if (o.tree !== false)
          cat.entries.set('Names', dict({ EmbeddedFiles: dict({ Names: [latin1('f.txt'), s] }) }));
        else cat.entries.delete('Names');
        if (o.af === 'none') cat.entries.delete('AF');
        else cat.entries.set('AF', o.af === 'out' ? [] : [s]);
        u.set(f.rootRef, cat);
      }),
    );
  const changed = { name: 'f.txt', kind: 'changed', revision: 2 };

  it('keeps an identical rebuild and a stamp-free no-op quiet', async () => {
    const r1 = build(await basePdf());
    expect(must(await attachmentChanges(build(r1)))).toEqual([]);
    expect(must(await attachmentChanges(r1))).toEqual([]);
  });

  it.each<[string, Opts]>([
    ['Filespec /F', { f: 'g.txt' }],
    ['Filespec /UF', { uf: 'g.txt' }],
    ['missing Filespec /UF', { uf: null }],
    ['/EF /UF removed', { efUf: null }],
    ['/EF /UF stream with other data', { efUf: 'otherData' }],
    ['/EF /UF stream with other /Subtype', { efUf: 'otherType' }],
    ['/EF /UF stream with a filter', { efUf: 'otherFilter' }],
    ['/Params /Size', { size: 5 }],
    ['/Params /Size removed', { size: null }],
    ['/Params /ModDate', { mod: 'D:20271124000000Z' }],
    ['/Params /ModDate removed', { mod: null }],
    ['EmbeddedFile /Type', { efType: 'Other' }],
    ['EmbeddedFile /Type removed', { efType: null }],
    ['Filespec /Type', { specType: 'Other' }],
    ['Filespec /Type removed', { specType: null }],
    ['removal from /AF', { af: 'out' }],
    ['deleted /AF', { af: 'none' }],
  ])('reports a change of %s', async (_n, o) => {
    const r1 = build(await basePdf());
    expect(must(await attachmentChanges(build(r1, o)))).toEqual([changed]);
  });
});

describe('files listed only in /AF', () => {
  const afOnly = (pdf: Uint8Array, body = 'same', uf = true) =>
    must(
      appendRevision(pdf, (f, u) => {
        const ef = u.add({
          t: 'stream',
          dict: dict({ Subtype: name('text/plain') }),
          data: text(body),
        });
        const s = u.add(
          dict({
            Type: name('Filespec'),
            ...(uf ? { UF: textString('h.txt') } : { F: latin1('h.txt') }),
            EF: dict({ F: ef }),
          }),
        );
        const cat = { t: 'dict' as const, entries: new Map(f.catalog.entries) };
        cat.entries.set('AF', [s]);
        u.set(f.rootRef, cat);
      }),
    );

  it('reads them with source "af" (name from /UF or /F)', async () => {
    for (const uf of [true, false]) {
      const found = must(await readAttachments(open(afOnly(await basePdf(), 'x', uf))));
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ name: 'h.txt', source: 'af', mimeType: 'text/plain' });
      expect(ascii(found[0]!.data)).toBe('x');
    }
  });

  it('does not list a tree file twice and gives it no source', async () => {
    const pdf = must(appendRevision(await basePdf(), (f, u) => attachFile(f, u, file('a.json'))));
    const found = must(await readAttachments(open(pdf)));
    expect(found.map((a) => a.name)).toEqual(['a.json']);
    expect(found[0]!.source).toBeUndefined();
  });

  it('reports a changed or removed /AF-only file, never an addition', async () => {
    const r1 = afOnly(await basePdf());
    expect(must(await attachmentChanges(r1))).toEqual([]);
    expect(must(await attachmentChanges(afOnly(r1)))).toEqual([]);
    expect(must(await attachmentChanges(afOnly(r1, 'other')))).toEqual([
      { name: 'h.txt', kind: 'changed', revision: 2 },
    ]);
    const gone = must(
      appendRevision(r1, (f, u) => {
        const cat = { t: 'dict' as const, entries: new Map(f.catalog.entries) };
        cat.entries.delete('AF');
        u.set(f.rootRef, cat);
      }),
    );
    expect(must(await attachmentChanges(gone))).toEqual([
      { name: 'h.txt', kind: 'removed', revision: 2 },
    ]);
  });
});

describe('malformed input and /AF guard', () => {
  it('attachmentChanges fails on a malformed name tree key (fail loud)', async () => {
    const pdf = withNames(await basePdf(), (u) =>
      dict({ EmbeddedFiles: dict({ Names: [7, spec(u, 'x', 'a')] }) }),
    );
    expect(await attachmentChanges(pdf)).toMatchObject(failure('syntax'));
  });

  it('attachFile refuses a catalog /AF that is not an array', async () => {
    for (const [bad, code] of [
      [5, 'bad-af'],
      [dict({}), 'bad-af'],
      [ref(9999), 'object-missing'],
    ] as const) {
      const pdf = must(
        appendRevision(await basePdf(), (f, u) => {
          const cat = { t: 'dict' as const, entries: new Map(f.catalog.entries) };
          cat.entries.set('AF', bad as PdfObject);
          u.set(f.rootRef, cat);
        }),
      );
      expect(appendRevision(pdf, (f, u) => attachFile(f, u, file('n.json')))).toMatchObject(
        failure(code),
      );
    }
    const viaRef = must(
      appendRevision(await basePdf(), (f, u) => {
        const cat = { t: 'dict' as const, entries: new Map(f.catalog.entries) };
        cat.entries.set('AF', u.add(dict({})));
        u.set(f.rootRef, cat);
      }),
    );
    expect(appendRevision(viaRef, (f, u) => attachFile(f, u, file('n.json')))).toMatchObject(
      failure('bad-af', '/AF'),
    );
  });
});

describe('/Limits of the /EmbeddedFiles root', () => {
  it('is not left stale after attachFile', async () => {
    const pdf = await basePdf();
    const withLimits = withNames(pdf, (u) => {
      const s = spec(u, 'm', 'x');
      return dict({
        EmbeddedFiles: dict({ Limits: [latin1('m'), latin1('m')], Names: [latin1('m'), s] }),
      });
    });
    const one = must(appendRevision(withLimits, (f, u) => attachFile(f, u, file('a.json'))));
    const two = must(appendRevision(one, (f, u) => attachFile(f, u, file('z.json'))));
    const f = open(two);
    const tree = f.dict(f.dict(f.catalog.entries.get('Names'))!.entries.get('EmbeddedFiles'))!;
    const names = (tree.entries.get('Names') as PdfObject[]).filter((_, i) => i % 2 === 0);
    expect(names).toHaveLength(3);
    const limits = tree.entries.get('Limits') as { bytes: Uint8Array }[] | undefined;
    if (limits !== undefined) {
      expect(limits[0]).toEqual(names[0]);
      expect(limits[1]).toEqual(names[2]);
    }
    expect(
      must(await readAttachments(f))
        .map((a) => a.name)
        .sort(),
    ).toEqual(['a.json', 'm', 'z.json']);
  });
});

describe('mutation guards: digest fields, predictors, cap, text decoding, duplicates', () => {
  type Upd = import('../src/index.ts').Update;
  const deflate = async (d: Uint8Array) =>
    new Uint8Array(
      await new Response(
        new Blob([d as BlobPart]).stream().pipeThrough(new CompressionStream('deflate')),
      ).arrayBuffer(),
    );
  const setCat = (
    pdf: Uint8Array,
    build: (u: Upd) => { names?: PdfObject; af?: PdfObject[] },
  ): Uint8Array =>
    must(
      appendRevision(pdf, (f, u) => {
        const { names, af } = build(u);
        const cat = { t: 'dict' as const, entries: new Map(f.catalog.entries) };
        if (names === undefined) cat.entries.delete('Names');
        else cat.entries.set('Names', names);
        if (af === undefined) cat.entries.delete('AF');
        else cat.entries.set('AF', af);
        u.set(f.rootRef, cat);
      }),
    );
  const changed = { name: 'f.txt', kind: 'changed', revision: 2 };

  it('digests the source: tree entry moved to /AF only is a change', async () => {
    const r1 = must(appendRevision(await basePdf(), (f, u) => attachFile(f, u, file('a.json'))));
    const r2 = must(
      appendRevision(r1, (f, u) => {
        const cat = { t: 'dict' as const, entries: new Map(f.catalog.entries) };
        cat.entries.delete('Names');
        u.set(f.rootRef, cat);
      }),
    );
    const found = must(await readAttachments(open(r2)));
    expect(found.map((a) => [a.name, a.source])).toEqual([['a.json', 'af']]);
    expect(must(await attachmentChanges(r2))).toEqual([
      { name: 'a.json', kind: 'changed', revision: 2 },
    ]);
  });

  it('length-prefixes MIME type and relationship: "json"+"Data" vs "jso"+"nData"', async () => {
    const mk = (pdf: Uint8Array, mime: string, rel: string) =>
      setCat(pdf, (u) => {
        const ef = u.add({ t: 'stream', dict: dict({ Subtype: name(mime) }), data: text('same') });
        const s = u.add(
          dict({
            Type: name('Filespec'),
            F: latin1('f.txt'),
            AFRelationship: name(rel),
            EF: dict({ F: ef }),
          }),
        );
        return { names: dict({ EmbeddedFiles: dict({ Names: [latin1('f.txt'), s] }) }) };
      });
    const r1 = mk(await basePdf(), 'application/json', 'Data');
    expect(must(await attachmentChanges(mk(r1, 'application/json', 'Data')))).toEqual([]);
    expect(must(await attachmentChanges(mk(r1, 'application/jso', 'nData')))).toEqual([changed]);
  });

  it('compares a separate /EF /UF stream by /Subtype and by /Type; odd /UF values do not throw', async () => {
    const mk = (pdf: Uint8Array, sub: string, type: string | null, ufMode = 'stream') =>
      setCat(pdf, (u) => {
        const uf = u.add({
          t: 'stream',
          dict: dict({
            Subtype: name(sub),
            ...(type === null ? {} : { Type: name(type) }),
          }),
          data: text('same'),
        });
        const ef = u.add({
          t: 'stream',
          dict: dict({ Subtype: name('text/plain') }),
          data: text('same'),
        });
        const efDict =
          ufMode === 'stream'
            ? dict({ F: ef, UF: uf })
            : ufMode === 'null'
              ? dict({ F: ef, UF: null as unknown as PdfObject })
              : dict({ F: ef, UF: u.add(dict({})) });
        const s = u.add(dict({ Type: name('Filespec'), F: latin1('f.txt'), EF: efDict }));
        return { names: dict({ EmbeddedFiles: dict({ Names: [latin1('f.txt'), s] }) }) };
      });
    const r1 = mk(await basePdf(), 'text/plain', 'EmbeddedFile');
    expect(must(await attachmentChanges(mk(r1, 'text/plain', 'EmbeddedFile')))).toEqual([]);
    expect(must(await attachmentChanges(mk(r1, 'text/html', 'EmbeddedFile')))).toEqual([changed]);
    expect(must(await attachmentChanges(mk(r1, 'text/plain', 'Other')))).toEqual([changed]);
    expect(must(await attachmentChanges(mk(r1, 'text/plain', null)))).toEqual([changed]);
    for (const m of ['null', 'dict']) {
      const odd = mk(await basePdf(), 'text/plain', null, m);
      expect(must(await readAttachments(open(odd))).map((a) => a.name)).toEqual(['f.txt']);
      expect(must(await attachmentChanges(odd))).toEqual([]);
      expect(must(await attachmentChanges(mk(odd, 'text/plain', null, m)))).toEqual([]);
    }
  });

  it('treats every kind of predictor as unsupported without trying to inflate', async () => {
    const raw = await deflate(text('predicted'));
    const cases: Record<string, (u: Upd) => Record<string, PdfObject>> = {
      DP: () => ({ DP: dict({ Predictor: 12 }) }),
      'array of a number': () => ({ DecodeParms: [5] }),
      'indirect /Predictor': (u) => ({ DecodeParms: dict({ Predictor: u.add(12) }) }),
      'indirect array element': (u) => ({
        DecodeParms: [u.add(dict({ Predictor: 12 }))],
      }),
    };
    const Real = globalThis.DecompressionStream;
    let calls = 0;
    globalThis.DecompressionStream = class extends Real {
      constructor(format: CompressionFormat) {
        super(format);
        calls++;
      }
    } as typeof DecompressionStream;
    try {
      for (const [label, parms] of Object.entries(cases)) {
        const pdf = setCat(await basePdf(), (u) => {
          const ef = u.add({
            t: 'stream',
            dict: dict({
              Subtype: name('text/plain'),
              Filter: name('FlateDecode'),
              ...parms(u),
            }),
            data: raw,
          });
          const s = u.add(dict({ Type: name('Filespec'), F: latin1('p'), EF: dict({ F: ef }) }));
          return { names: dict({ EmbeddedFiles: dict({ Names: [latin1('p'), s] }) }) };
        });
        const [a] = must(await readAttachments(open(pdf)));
        expect(a, label).toMatchObject({ unsupportedFilter: true, filter: 'FlateDecode' });
        expect(a!.inflateError, label).toBeUndefined();
        expect(a!.data, label).toEqual(raw);
      }
      const plain = setCat(await basePdf(), (u) => {
        const ef = u.add({
          t: 'stream',
          dict: dict({
            Subtype: name('text/plain'),
            Filter: name('FlateDecode'),
            DecodeParms: dict({ Predictor: u.add(1) }),
          }),
          data: raw,
        });
        const s = u.add(dict({ Type: name('Filespec'), F: latin1('p'), EF: dict({ F: ef }) }));
        return { names: dict({ EmbeddedFiles: dict({ Names: [latin1('p'), s] }) }) };
      });
      const [b] = must(await readAttachments(open(plain)));
      expect(b!.unsupportedFilter).toBeUndefined();
      expect(ascii(b!.data)).toBe('predicted');
    } finally {
      globalThis.DecompressionStream = Real;
    }
    expect(calls).toBe(1);
  });

  it('decodes exactly maxInflatedBytes and refuses one byte more; an over-size result is not cached', async () => {
    const raw = await deflate(new Uint8Array(1000));
    const pdf = setCat(await basePdf(), (u) => {
      const ef = u.add({
        t: 'stream',
        dict: dict({ Subtype: name('text/plain'), Filter: name('FlateDecode') }),
        data: raw,
      });
      const s = u.add(dict({ Type: name('Filespec'), F: latin1('z'), EF: dict({ F: ef }) }));
      return { names: dict({ EmbeddedFiles: dict({ Names: [latin1('z'), s] }) }) };
    });
    const f = open(pdf);
    const exact = must(await readAttachments(f, undefined, { maxInflatedBytes: 1000 }));
    expect(exact[0]!.tooLarge).toBeUndefined();
    expect(exact[0]!.data.length).toBe(1000);
    const over = must(await readAttachments(f, undefined, { maxInflatedBytes: 999 }));
    expect(over[0]).toMatchObject({ tooLarge: true });
    // cache hit: same boundary
    const warm = new Map();
    must(await readAttachments(f, warm));
    expect(
      must(await readAttachments(f, warm, { maxInflatedBytes: 1000 }))[0]!.tooLarge,
    ).toBeUndefined();
    expect(must(await readAttachments(f, warm, { maxInflatedBytes: 999 }))[0]!.tooLarge).toBe(true);
    // over-size first, then default with the same cache
    const cache = new Map();
    expect(must(await readAttachments(f, cache, { maxInflatedBytes: 1 }))[0]!.tooLarge).toBe(true);
    const again = must(await readAttachments(f, cache));
    expect(again[0]!.tooLarge).toBeUndefined();
    expect(again[0]!.data.length).toBe(1000);
  });

  it('decodeText: a partial UTF-8 mark is Latin-1, an odd UTF-16 key is a syntax error', async () => {
    const key = (b: number[]) =>
      setCat(basePdfSync, (u) => ({
        names: dict({
          EmbeddedFiles: dict({ Names: [hex(Uint8Array.from(b)), spec(u, 'x', 'a')] }),
        }),
      }));
    const basePdfSync = await basePdf();
    const ok = must(await readAttachments(open(key([0xef, 0xbb, 0x41]))));
    expect(ok.map((a) => a.name)).toEqual(['ï»A']);
    const bad = key([0xfe, 0xff, 0x00, 0x41, 0x00]);
    expect(await readAttachments(open(bad))).toMatchObject(failure('syntax'));
  });

  it('names a /AF-only file by /UF before /F', async () => {
    const pdf = setCat(await basePdf(), (u) => {
      const ef = u.add({
        t: 'stream',
        dict: dict({ Subtype: name('text/plain') }),
        data: text('x'),
      });
      const s = u.add(
        dict({ Type: name('Filespec'), F: latin1('a'), UF: textString('b'), EF: dict({ F: ef }) }),
      );
      return { af: [s] };
    });
    expect(must(await readAttachments(open(pdf))).map((a) => a.name)).toEqual(['b']);
  });

  it('reports a duplicated name once, however often it occurs', async () => {
    const dup = (pdf: Uint8Array, times: number) =>
      setCat(pdf, (u) => {
        const pairs: PdfObject[] = [];
        for (let i = 0; i < times; i++) pairs.push(latin1('a'), spec(u, 'a', `v${i}`));
        return { names: dict({ EmbeddedFiles: dict({ Names: pairs }) }) };
      });
    expect(must(await attachmentChanges(dup(await basePdf(), 3)))).toEqual([
      { name: 'a', kind: 'changed', revision: 1 },
    ]);
    const r1 = dup(await basePdf(), 1);
    const r2 = dup(r1, 2);
    const r3 = dup(r2, 2);
    expect(must(await attachmentChanges(r3))).toEqual([
      { name: 'a', kind: 'changed', revision: 2 },
    ]);
  });

  it('gives a non-empty inflateError for a corrupt stream', async () => {
    const pdf = setCat(await basePdf(), (u) => {
      const ef = u.add({
        t: 'stream',
        dict: dict({ Subtype: name('text/plain'), Filter: name('FlateDecode') }),
        data: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
      });
      const s = u.add(dict({ Type: name('Filespec'), F: latin1('c'), EF: dict({ F: ef }) }));
      return { names: dict({ EmbeddedFiles: dict({ Names: [latin1('c'), s] }) }) };
    });
    const [a] = must(await readAttachments(open(pdf)));
    expect(a!.inflateError!.length).toBeGreaterThan(0);
  });
});
