import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import {
  PdfFile,
  PdfReadError,
  appendDocTimeStamp,
  appendRevision,
  attachFile,
  dict,
  findDocTimeStamps,
  latin1,
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
  it('adds, replaces by name, and every revision keeps its own copy', async () => {
    const base = await basePdf();
    const r1 = appendRevision(base, (f, u) => {
      attachFile(f, u, {
        name: 'monat.json',
        data: text('{"tag":1}'),
        mimeType: 'application/json',
        modified: 'D:20261101180000Z',
      });
      attachFile(f, u, { name: 'andere.txt', data: text('x'), mimeType: 'text/plain' });
    });
    const r2 = appendRevision(r1, (f, u) => {
      attachFile(f, u, {
        name: 'monat.json',
        data: text('{"tag":2}'),
        mimeType: 'application/json',
      });
    });
    const now = await readAttachments(new PdfFile(r2));
    expect(now.map((a) => [a.name, ascii(a.data), a.relationship])).toEqual([
      ['andere.txt', 'x', 'Data'],
      ['monat.json', '{"tag":2}', 'Data'],
    ]);
    const f = new PdfFile(r2);
    const before = await readAttachments(new PdfFile(f.revisionBytes(1)));
    expect(before.find((a) => a.name === 'monat.json')?.data).toEqual(text('{"tag":1}'));
    const catalog = f.catalog;
    expect(Array.isArray(catalog.entries.get('AF')) && catalog.entries.get('AF')).toHaveLength(2);
    // pdf-lib still opens it.
    expect((await PDFDocument.load(r2)).getPageCount()).toBe(1);
  });
});

describe('document time stamps', () => {
  it('covers everything but the token, and a later revision keeps the earlier stamp valid', async () => {
    const seen: Uint8Array[] = [];
    const base = await basePdf();
    const day1 = appendRevision(base, (f, u) =>
      attachFile(f, u, { name: 'm.json', data: text('1'), mimeType: 'application/json' }),
    );
    const s1 = await appendDocTimeStamp(day1, fakeStamper(seen), { reserve: 2048 });
    expect(prefixKept(day1, s1)).toBe(true);
    const day2 = appendRevision(s1, (f, u) =>
      attachFile(f, u, { name: 'm.json', data: text('2'), mimeType: 'application/json' }),
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
