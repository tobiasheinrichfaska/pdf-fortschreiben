import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import {
  PdfFile,
  PdfReadError,
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
import { Lexer } from '../src/parse.ts';
import { TextSink } from '../src/objects.ts';
import { ascii, basePdf, fakeStamper, text } from './helpers.ts';

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
    const f = new PdfFile(await basePdf(2));
    expect(f.revisions).toHaveLength(1);
    expect(f.pages()).toHaveLength(2);
  });

  it('refuses cross-reference streams', async () => {
    const pdf = await basePdf(1, true);
    expect(() => new PdfFile(pdf)).toThrow(PdfReadError);
  });

  it('appends without touching the earlier bytes, and others can read the result', async () => {
    const base = await basePdf();
    const next = appendRevision(base, (_f, u) => {
      u.add(dict({ Note: latin1('neu') }));
    });
    expect(prefixKept(base, next)).toBe(true);
    const f = new PdfFile(next);
    expect(f.revisions).toHaveLength(2);
    expect(f.revisions[0]!.end).toBe(base.length);
    expect(ascii(f.revisionBytes(0))).toBe(ascii(base));
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
    const r1 = appendRevision(await basePdf(), (f, u) => {
      attachFile(f, u, { ...day(1), modified: 'D:20261101180000Z' });
    });
    const r2 = appendRevision(r1, (f, u) => attachFile(f, u, day(2)));
    const now = await readAttachments(new PdfFile(r2));
    expect(now.map((a) => [a.name, ascii(a.data), a.relationship])).toEqual([
      ['monat-tag-1.json', '{"tag":1}', 'Data'],
      ['monat-tag-2.json', '{"tag":2}', 'Data'],
    ]);
    const af = new PdfFile(r2).catalog.entries.get('AF');
    expect(Array.isArray(af) && af).toHaveLength(2);
    expect(await attachmentChanges(r2)).toEqual([]);
    expect((await PDFDocument.load(r2)).getPageCount()).toBe(1);
  });

  it('refuses a name that is already in the file (nothing is replaced)', async () => {
    const r1 = appendRevision(await basePdf(), (f, u) => attachFile(f, u, day(1)));
    expect(() => appendRevision(r1, (f, u) => attachFile(f, u, day(1)))).toThrow('exists');
  });

  it('reports a file that a later revision removed or changed', async () => {
    const r1 = appendRevision(await basePdf(), (f, u) => {
      attachFile(f, u, day(1));
      attachFile(f, u, day(2));
    });
    // Someone rewrites the catalog: tag 1 gone, tag 2 pointing to other bytes.
    const forged = appendRevision(r1, (f, u) => {
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
    });
    expect(await attachmentChanges(forged)).toEqual([
      { name: 'monat-tag-1.json', kind: 'removed', revision: 2 },
      { name: 'monat-tag-2.json', kind: 'changed', revision: 2 },
    ]);
  });
});

describe('document time stamps', () => {
  it('covers everything but the token, and a later revision keeps the earlier stamp valid', async () => {
    const seen: Uint8Array[] = [];
    const base = await basePdf();
    const day1 = appendRevision(base, (f, u) =>
      attachFile(f, u, { name: 'm-1.json', data: text('1'), mimeType: 'application/json' }),
    );
    const s1 = await appendDocTimeStamp(day1, fakeStamper(seen), { reserve: 2048 });
    expect(prefixKept(day1, s1)).toBe(true);
    const day2 = appendRevision(s1, (f, u) =>
      attachFile(f, u, { name: 'm-2.json', data: text('2'), mimeType: 'application/json' }),
    );
    const s2 = await appendDocTimeStamp(day2, fakeStamper(seen), { reserve: 2048 });

    const found = findDocTimeStamps(s2);
    expect(found.map((t) => [t.field, t.revision, t.rangeOk])).toEqual([
      ['Zeitstempel 1', 2, true],
      ['Zeitstempel 2', 4, true],
    ]);
    found.forEach((t, i) => {
      expect(t.digest).toEqual(seen[i]);
      expect(t.token).toEqual(Uint8Array.from([0x04, 32, ...seen[i]!]));
      expect(t.byteRange[2]! + t.byteRange[3]!).toBe(
        new PdfFile(s2).revisions[t.revision!]!.end + 1,
      );
    });
    expect((await PDFDocument.load(s2)).getPageCount()).toBe(1);
  });

  it('a changed byte in an earlier revision changes that stamp’s digest', async () => {
    const seen: Uint8Array[] = [];
    const s1 = await appendDocTimeStamp(await basePdf(), fakeStamper(seen), { reserve: 2048 });
    const bad = s1.slice();
    bad[20] = bad[20]! ^ 1;
    const [t] = findDocTimeStamps(bad);
    expect(t!.digest).not.toEqual(seen[0]);
  });

  it('refuses a token larger than the reserve and an answer that is not one DER element', async () => {
    const base = await basePdf();
    await expect(
      appendDocTimeStamp(
        base,
        async () => Uint8Array.from([0x04, 0x82, 0x08, 0x00, ...new Uint8Array(2048)]),
        {
          reserve: 2048,
        },
      ),
    ).rejects.toThrow(RangeError);
    await expect(
      appendDocTimeStamp(base, async () => Uint8Array.from([0x04, 0x05, 1]), { reserve: 2048 }),
    ).rejects.toThrow('DER');
  });
});
