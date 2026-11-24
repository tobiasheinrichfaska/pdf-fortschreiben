import { PDFDocument } from 'pdf-lib';
import {
  PdfFile,
  PdfReadError,
  appendRevision,
  attachFile,
  attachmentChanges,
  dict,
  hex,
  latin1,
  name,
  readAttachments,
  ref,
  type PdfObject,
} from '../src/index.ts';
import { ascii, basePdf, text } from './helpers.ts';

const file = (n: string, body = '{}') => ({
  name: n,
  data: text(body),
  mimeType: 'application/json',
});

/** Replaces the catalog's /Names in a new revision. */
const withNames = (pdf: Uint8Array, build: (u: import('../src/index.ts').Update) => PdfObject) =>
  appendRevision(pdf, (f, u) => {
    const names = build(u);
    const cat = { t: 'dict' as const, entries: new Map(f.catalog.entries) };
    cat.entries.set('Names', names);
    u.set(f.rootRef, cat);
  });

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
    expect((await readAttachments(new PdfFile(base))).map((a) => a.name)).toEqual(['alt.txt']);
    expect(() => appendRevision(base, (f, u) => attachFile(f, u, file('alt.txt')))).toThrow(
      'exists',
    );
    const next = appendRevision(base, (f, u) => attachFile(f, u, file('neu.json')));
    const f2 = new PdfFile(next);
    const names = (await readAttachments(f2)).map((a) => a.name);
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
    expect((await readAttachments(new PdfFile(pdf))).map((a) => a.name)).toEqual(['ä.t']);
  });

  it('throws on a non-string key instead of dropping it', async () => {
    const pdf = withNames(await basePdf(), (u) =>
      dict({ EmbeddedFiles: dict({ Names: [7, spec(u, 'x', 'a')] }) }),
    );
    expect(() => appendRevision(pdf, (f, u) => attachFile(f, u, file('n.json')))).toThrow(
      PdfReadError,
    );
    await expect(readAttachments(new PdfFile(pdf))).rejects.toBeInstanceOf(PdfReadError);
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
    expect((await readAttachments(new PdfFile(pdf))).map((a) => a.name)).toEqual(['a.txt']);
    expect(() => appendRevision(pdf, (f, u) => attachFile(f, u, file('a.txt')))).toThrow('exists');
    const next = appendRevision(pdf, (f, u) => attachFile(f, u, file('b.json')));
    expect((await readAttachments(new PdfFile(next))).map((a) => a.name)).toEqual([
      'b.json',
      'a.txt',
    ]);
  });

  it('throws when /Names is neither an array nor a reference to one', async () => {
    const pdf = withNames(await basePdf(), () => dict({ EmbeddedFiles: dict({ Names: 5 }) }));
    expect(() => appendRevision(pdf, (f, u) => attachFile(f, u, file('b.json')))).toThrow(
      PdfReadError,
    );
    const pdf2 = withNames(await basePdf(), () =>
      dict({ EmbeddedFiles: dict({ Names: ref(9999) }) }),
    );
    await expect(readAttachments(new PdfFile(pdf2))).rejects.toThrow();
  });
});

describe('/Kids', () => {
  it('readAttachments walks kids; attachFile refuses them', async () => {
    const pdf = withNames(await basePdf(), (u) => {
      const k1 = u.add(dict({ Names: [latin1('a'), spec(u, 'a', 'A')] }));
      const k2 = u.add(dict({ Names: [latin1('b'), spec(u, 'b', 'B')] }));
      return dict({ EmbeddedFiles: dict({ Kids: [k1, k2] }) });
    });
    const found = await readAttachments(new PdfFile(pdf));
    expect(found.map((a) => [a.name, ascii(a.data)])).toEqual([
      ['a', 'A'],
      ['b', 'B'],
    ]);
    expect(() => appendRevision(pdf, (f, u) => attachFile(f, u, file('c.json')))).toThrow('Kids');
  });

  it('is cycle-safe', async () => {
    const pdf = withNames(await basePdf(), (u) => {
      const k = u.add(dict({}));
      u.set(k, dict({ Kids: [k] }));
      return dict({ EmbeddedFiles: dict({ Kids: [k] }) });
    });
    await expect(readAttachments(new PdfFile(pdf))).rejects.toBeInstanceOf(PdfReadError);
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
      expect(await attachmentChanges(forge(r1, d, m, r))).toEqual([
        { name: 'f.txt', kind: 'changed', revision: 2 },
      ]);
    expect(await attachmentChanges(forge(r1, 'd', 'text/plain', 'Data'))).toEqual([]);
  });

  it('keeps a file with an unsupported filter and reports it as changed, not removed', async () => {
    const r1 = await forge(await basePdf(), 'd', 'text/plain', 'Data', {
      Filter: name('LZWDecode'),
    });
    const found = await readAttachments(new PdfFile(r1));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ unsupportedFilter: true, filter: 'LZWDecode' });
    expect(await attachmentChanges(r1)).toEqual([]);
    const r2 = forge(r1, 'd', 'text/plain', 'Data', { Filter: name('ASCIIHexDecode') });
    expect(await attachmentChanges(r2)).toEqual([{ name: 'f.txt', kind: 'changed', revision: 2 }]);
  });
});

describe('name tree order', () => {
  it('sorts by raw key bytes: ASCII keys before pdf-lib UTF-16 (FE FF) keys', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    await doc.attach(text('z'), 'Zebra.txt', { mimeType: 'text/plain' });
    await doc.attach(text('m'), 'Mango.txt', { mimeType: 'text/plain' });
    const base = new Uint8Array(await doc.save({ useObjectStreams: false }));
    const out = appendRevision(base, (f, u) => attachFile(f, u, file('a.txt')));
    const names = (await readAttachments(new PdfFile(out))).map((x) => x.name);
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
    for (let i = 0; i < 4; i++) pdf = appendRevision(pdf, (f, u) => u.set(f.rootRef, f.catalog));
    const Real = globalThis.DecompressionStream;
    let calls = 0;
    globalThis.DecompressionStream = class extends Real {
      constructor(format: CompressionFormat) {
        super(format);
        calls++;
      }
    } as typeof DecompressionStream;
    try {
      expect(await attachmentChanges(pdf)).toEqual([]);
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
    await expect(readAttachments(new PdfFile(pdf))).rejects.toThrow(/loop/);
  });

  it('follows a /Kids chain of 20 levels and refuses one of 40', async () => {
    const ok = await readAttachments(new PdfFile(await chain(20)));
    expect(ok.map((a) => a.name)).toEqual(['deep']);
    const deep = await chain(40);
    await expect(readAttachments(new PdfFile(deep))).rejects.toBeInstanceOf(PdfReadError);
    await expect(readAttachments(new PdfFile(deep))).rejects.toThrow(/too deep/);
  });

  it('refuses names with a line end or non-ASCII and MIME types without a subtype', async () => {
    const pdf = await basePdf();
    for (const n of ['ä\n', 'a\n', '', 'ä.txt'])
      expect(() => appendRevision(pdf, (f, u) => attachFile(f, u, file(n)))).toThrow(/printable/);
    for (const m of ['text', 'text/plain\n', '/plain', 'text/'])
      expect(() =>
        appendRevision(pdf, (f, u) =>
          attachFile(f, u, { name: 'a.txt', data: text('x'), mimeType: m }),
        ),
      ).toThrow(/MIME/);
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
    expect(await attachmentChanges(r3)).toEqual([{ name: 'f.txt', kind: 'changed', revision: 2 }]);
  });

  it('length-prefixes the fields: description "ab" + filter "c" differs from "a" + "bc"', async () => {
    const r1 = version(await basePdf(), 'same', 'ab', { Filter: name('c') });
    const r2 = version(r1, 'same', 'a', { Filter: name('bc') });
    expect(await attachmentChanges(r2)).toEqual([{ name: 'f.txt', kind: 'changed', revision: 2 }]);
    expect(await attachmentChanges(version(r1, 'same', 'ab', { Filter: name('c') }))).toEqual([]);
  });
});
