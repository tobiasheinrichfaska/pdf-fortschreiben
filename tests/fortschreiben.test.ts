import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import {
  type PdfRef,
  PdfFile,
  appendDocTimeStamp,
  appendRevision,
  attachFile,
  attachmentChanges,
  dict,
  findDocTimeStamps,
  latin1,
  name,
  readAttachments,
  sha256Bytes,
} from '../src/index.ts';
import { Lexer, readXrefSection } from '../src/parse.ts';
import { TextSink } from '../src/objects.ts';
import { ascii, basePdf, failure, fakeStamper, text, must, open, thrown } from './helpers.ts';

const prefixKept = (before: Uint8Array, after: Uint8Array): boolean =>
  after.length > before.length && before.every((b, i) => after[i] === b);

describe('objects', () => {
  it('writes and reads back the same objects', () => {
    const src = '<</A [1 -2.5 true false null (a\\(b\\)c\\\\) <0aFF> /N#20x 3 0 R] /B <</C 7>>>>';
    const o = new Lexer(text(src)).readObject();
    const sink = new TextSink();
    sink.write(o);
    const again = new Lexer(sink.bytes()).readObject();
    expect(again).toEqual(o);
  });

  it('sha256 equals node:crypto', () => {
    for (const s of ['', 'abc', 'x'.repeat(1000)])
      expect(Buffer.from(sha256Bytes(text(s))).toString('hex')).toBe(
        createHash('sha256').update(s).digest('hex'),
      );
  });
});

describe('revisions', () => {
  it('reads a pdf-lib file with a classic xref table', async () => {
    const f = open(await basePdf(2));
    expect(f.revisions).toHaveLength(1);
    expect(f.pages()).toHaveLength(2);
  });

  it('walks a cyclic or shared /Kids graph once per node', async () => {
    const base = await basePdf(1);
    const pagesRef = open(base).catalog.entries.get('Pages') as PdfRef;
    const cyc = must(
      appendRevision(base, (_f, u) => {
        u.set(pagesRef, dict({ Type: name('Pages'), Kids: [pagesRef, pagesRef], Count: 0 }));
      }),
    );
    expect(open(cyc).pages()).toEqual([]);
    // a chain of 30 nodes (below the depth limit of 32), each listing the next one twice, ends in one
    // page; without the visited set this would walk 2^30 paths
    const chain = must(
      appendRevision(base, (f, u) => {
        const page = f.pages()[0]!;
        let next: PdfRef = page;
        for (let i = 0; i < 30; i++) {
          next = u.add(dict({ Type: name('Pages'), Kids: [next, next], Count: 1 }));
        }
        u.set(pagesRef, dict({ Type: name('Pages'), Kids: [next], Count: 1 }));
      }),
    );
    expect(open(chain).pages()).toHaveLength(1);
  });

  it('refuses cross-reference streams', async () => {
    const pdf = await basePdf(1, true);
    expect(PdfFile.open(pdf)).toMatchObject(failure('xref-stream'));
  });

  it('appends without touching the earlier bytes, and others can read the result', async () => {
    const base = await basePdf();
    const next = must(
      appendRevision(base, (_f, u) => {
        u.add(dict({ Note: latin1('neu') }));
      }),
    );
    expect(prefixKept(base, next)).toBe(true);
    const f = open(next);
    expect(f.revisions).toHaveLength(2);
    expect(f.revisions[0]!.end).toBe(base.length);
    // plus the single line end after %%EOF (the writer's lead), which a stamp's /ByteRange covers
    expect(ascii(f.revisionBytes(0))).toBe(ascii(base) + '\n');
    const loaded = await PDFDocument.load(next);
    expect(loaded.getPageCount()).toBe(1);
  });
});

describe('attachments', () => {
  const day = (n: number) => ({
    name: `monat-tag-${n}.json`,
    data: text(`{"tag":${n}}`),
    mimeType: 'application/json',
  });

  it('adds a new file per state; every earlier state stays readable in the newest revision', async () => {
    const r1 = must(
      appendRevision(await basePdf(), (f, u) => {
        must(attachFile(f, u, { ...day(1), modified: 'D:20261101180000Z' }));
      }),
    );
    const r2 = must(appendRevision(r1, (f, u) => attachFile(f, u, day(2))));
    const now = must(await readAttachments(open(r2)));
    expect(now.map((a) => [a.name, ascii(a.data), a.relationship])).toEqual([
      ['monat-tag-1.json', '{"tag":1}', 'Data'],
      ['monat-tag-2.json', '{"tag":2}', 'Data'],
    ]);
    const af = open(r2).catalog.entries.get('AF');
    expect(Array.isArray(af) && af).toHaveLength(2);
    expect(must(await attachmentChanges(r2))).toEqual([]);
    expect((await PDFDocument.load(r2)).getPageCount()).toBe(1);
  });

  it('refuses a name that is already in the file (nothing is replaced)', async () => {
    const r1 = must(appendRevision(await basePdf(), (f, u) => attachFile(f, u, day(1))));
    expect(appendRevision(r1, (f, u) => attachFile(f, u, day(1)))).toMatchObject(
      failure('name-exists', 'exists'),
    );
  });

  it('reports a file that a later revision removed or changed', async () => {
    const r1 = must(
      appendRevision(await basePdf(), (f, u) => {
        must(attachFile(f, u, day(1)));
        must(attachFile(f, u, day(2)));
      }),
    );
    // Someone rewrites the catalog: tag 1 gone, tag 2 pointing to other bytes.
    const forged = must(
      appendRevision(r1, (f, u) => {
        const ef = u.add({
          t: 'stream',
          dict: dict({ Type: name('EmbeddedFile') }),
          data: text('{"tag":99}'),
        });
        const spec = u.add(
          dict({ Type: name('Filespec'), F: latin1('monat-tag-2.json'), EF: dict({ F: ef }) }),
        );
        const cat = { t: 'dict' as const, entries: new Map(f.catalog.entries) };
        cat.entries.set(
          'Names',
          dict({ EmbeddedFiles: dict({ Names: [latin1('monat-tag-2.json'), spec] }) }),
        );
        cat.entries.set('AF', [spec]);
        u.set(f.rootRef, cat);
      }),
    );
    expect(must(await attachmentChanges(forged))).toEqual([
      { name: 'monat-tag-1.json', kind: 'removed', revision: 2 },
      { name: 'monat-tag-2.json', kind: 'changed', revision: 2 },
    ]);
  });
});

describe('document time stamps', () => {
  it('covers everything but the token, and a later revision keeps the earlier stamp valid', async () => {
    const seen: Uint8Array[] = [];
    const base = await basePdf();
    const day1 = must(
      appendRevision(base, (f, u) =>
        attachFile(f, u, { name: 'm-1.json', data: text('1'), mimeType: 'application/json' }),
      ),
    );
    const s1 = must(await appendDocTimeStamp(day1, fakeStamper(seen), { reserve: 2048 }));
    expect(prefixKept(day1, s1)).toBe(true);
    const day2 = must(
      appendRevision(s1, (f, u) =>
        attachFile(f, u, { name: 'm-2.json', data: text('2'), mimeType: 'application/json' }),
      ),
    );
    const s2 = must(await appendDocTimeStamp(day2, fakeStamper(seen), { reserve: 2048 }));

    const found = must(findDocTimeStamps(s2));
    expect(found.map((t) => [t.field, t.revision, t.rangeOk])).toEqual([
      ['Zeitstempel 1', 2, true],
      ['Zeitstempel 2', 4, true],
    ]);
    found.forEach((t, i) => {
      expect(t.digest).toEqual(seen[i]);
      expect(t.token).toEqual(Uint8Array.from([0x30, 32, ...seen[i]!]));
      expect(t.byteRange[2]! + t.byteRange[3]!).toBe(open(s2).revisions[t.revision!]!.end + 1);
    });
    expect((await PDFDocument.load(s2)).getPageCount()).toBe(1);
  });

  it('a changed byte in an earlier revision changes that stamp’s digest', async () => {
    const seen: Uint8Array[] = [];
    const s1 = must(
      await appendDocTimeStamp(await basePdf(), fakeStamper(seen), { reserve: 2048 }),
    );
    const bad = s1.slice();
    bad[20] = bad[20]! ^ 1;
    const [t] = must(findDocTimeStamps(bad));
    expect(t!.digest).not.toEqual(seen[0]);
  });

  it('refuses a token larger than the reserve and an answer that is not one DER element', async () => {
    const base = await basePdf();
    expect(
      await appendDocTimeStamp(
        base,
        async () => Uint8Array.from([0x30, 0x82, 0x08, 0x00, ...new Uint8Array(2048)]),
        { reserve: 2048 },
      ),
    ).toMatchObject(failure('token-too-large'));
    expect(
      await appendDocTimeStamp(base, async () => Uint8Array.from([0x30, 0x05, 1]), {
        reserve: 2048,
      }),
    ).toMatchObject(failure('bad-token', 'DER'));
  });
});

describe('xref reader hardening', () => {
  const read = (s: string) => readXrefSection(new TextEncoder().encode(s), 0);
  it('refuses a truncated xref table instead of looping', () => {
    expect(() => read('xref\n0 1\n0000000000 65535 f \n')).toThrow(thrown('syntax'));
  });
  it('refuses a delimiter where a subsection header is expected', () => {
    expect(() => read('xref\n0 1\n0000000000 65535 f \n<< >>')).toThrow(thrown('syntax'));
    expect(() => read('xref\n0 1\n0000000000 65535 f \n)')).toThrow(thrown('syntax'));
  });
  it('refuses non-decimal subsection numbers', () => {
    expect(() => read('xref\n1e3 1\n0000000000 65535 f \ntrailer\n<< >>')).toThrow(
      thrown('syntax'),
    );
    expect(() => read('xref\n0x10 1\n0000000000 65535 f \ntrailer\n<< >>')).toThrow(
      thrown('syntax'),
    );
  });
});

describe('Result values instead of exceptions (public API)', () => {
  it('every public function returns a failure with a code for a file it cannot read', async () => {
    const junk = text('not a pdf');
    expect(PdfFile.open(junk)).toMatchObject(failure('no-startxref'));
    expect(appendRevision(junk, () => {})).toMatchObject(failure('no-startxref'));
    expect(findDocTimeStamps(junk)).toMatchObject(failure('no-startxref'));
    expect(await attachmentChanges(junk)).toMatchObject(failure('no-startxref'));
    expect(await appendDocTimeStamp(junk, fakeStamper())).toMatchObject(failure('no-startxref'));
  });

  it('appendRevision returns the failure a build step hands back', async () => {
    const r = appendRevision(await basePdf(), (f, u) =>
      attachFile(f, u, { name: 'a\n', data: text('x'), mimeType: 'text/plain' }),
    );
    expect(r).toMatchObject(failure('bad-name'));
  });

  it('appendRevision returns the PdfError a low-level accessor throws inside the build step', async () => {
    const r = appendRevision(await basePdf(), (f) => {
      f.object({ t: 'ref', num: 9999, gen: 0 });
    });
    expect(r).toMatchObject(failure('object-missing', /9999/));
  });

  it('appendRevision lets an error of the caller pass through', async () => {
    const pdf = await basePdf();
    expect(() =>
      appendRevision(pdf, () => {
        throw new TypeError('mine');
      }),
    ).toThrow(TypeError);
  });

  it('a Stamper that rejects or throws is stamper-failed, not an exception', async () => {
    const pdf = await basePdf();
    expect(
      await appendDocTimeStamp(pdf, () => Promise.reject(new Error('relay down'))),
    ).toMatchObject(failure('stamper-failed', 'relay down'));
    expect(
      await appendDocTimeStamp(pdf, () => {
        throw new Error('sync boom');
      }),
    ).toMatchObject(failure('stamper-failed', 'sync boom'));
  });

  it('a page that does not exist is no-page', async () => {
    expect(await appendDocTimeStamp(await basePdf(), fakeStamper(), { page: 5 })).toMatchObject(
      failure('no-page'),
    );
  });

  it('an object builder refuses what the writer cannot serialize with bad-object', () => {
    expect(() => latin1('Ā')).toThrow(thrown('bad-object'));
  });
});
