import {
  PdfFile,
  PdfReadError,
  Update,
  appendDocTimeStamp,
  appendRevision,
  attachFile,
  attachmentChanges,
  latin1,
  dict,
  name,
  isRef,
  ref,
  writeUpdate,
  type PdfRef,
} from '../src/index.ts';
import { TextSink } from '../src/objects.ts';
import type { PdfObject } from '../src/index.ts';
import { ascii, basePdf, fakeStamper } from './helpers.ts';

const latin1Bytes = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

const base = (): Promise<Uint8Array> => basePdf(1);

function withEncrypt(pdf: Uint8Array): Uint8Array {
  const s = ascii(pdf);
  const at = s.lastIndexOf('/Root');
  return latin1Bytes(s.slice(0, at) + '/Encrypt 1 0 R ' + s.slice(at));
}

const written = (bytes: Uint8Array): string => ascii(bytes);
const lastTrailer = (bytes: Uint8Array): string => {
  const s = written(bytes);
  return s.slice(s.lastIndexOf('trailer'));
};

describe('PdfFile', () => {
  it('refuses a file whose trailer has /Encrypt', async () => {
    const pdf = withEncrypt(await base());
    expect(() => new PdfFile(pdf)).toThrow(PdfReadError);
    try {
      new PdfFile(pdf);
    } catch (e) {
      expect((e as PdfReadError).code).toBe('encrypted');
    }
  });
});

describe('Update', () => {
  it('raises /Size when set uses a number beyond next', async () => {
    const file = new PdfFile(await base());
    const u = new Update(file);
    const n = file.size + 5;
    u.set(ref(n), dict({ A: 1 }));
    expect(u.size).toBe(n + 1);
    const out = writeUpdate(file, u).bytes;
    expect(lastTrailer(out)).toContain(`/Size ${n + 1}`);
    expect(u.add(dict({})).num).toBe(n + 1);
  });

  it('get honours set(ref, null)', async () => {
    const file = new PdfFile(await base());
    const u = new Update(file);
    const r = file.rootRef;
    u.set(r, null);
    expect(u.get(r)).toBeNull();
  });

  it('refuses a generation that differs from the file', async () => {
    const file = new PdfFile(await base());
    const u = new Update(file);
    expect(() => u.set(ref(file.rootRef.num, 3), null)).toThrow(/generation/);
    expect(() => u.set(ref(file.size + 1, 1), null)).toThrow(/generation/);
  });

  it('writes the generation of the xref entry for an existing object', async () => {
    const orig = ascii(await base());
    const m = /xref\n0 (\d+)\n/.exec(orig)!;
    const n = Number(m[1]) - 1;
    const entry = m.index + m[0].length + n * 20;
    let s = orig.slice(0, entry + 11) + '00001' + orig.slice(entry + 16);
    s = s.replace(`\n${n} 0 obj`, `\n${n} 1 obj`);
    const pdf = latin1Bytes(s);
    const file = new PdfFile(pdf);
    expect(file.generation(n)).toBe(1);
    const u = new Update(file);
    u.set(ref(n, 1), null);
    const out = written(writeUpdate(file, u).bytes).slice(pdf.length);
    expect(out).toContain(`${n} 1 obj`);
    expect(out).toMatch(/\d{10} 00001 n/);
  });
});

describe('writeUpdate', () => {
  it('refuses an update with no objects', async () => {
    const file = new PdfFile(await base());
    expect(() => writeUpdate(file, new Update(file))).toThrow(/no objects/);
  });

  it.each(['Size', 'Prev', 'Root', 'ID', 'Encrypt'])('refuses trailerExtra %s', async (key) => {
    const file = new PdfFile(await base());
    const u = new Update(file);
    u.add(dict({ A: 1 }));
    expect(() => writeUpdate(file, u, { [key]: 1 })).toThrow(new RegExp(key));
  });

  it('still takes /Info and other keys', async () => {
    const file = new PdfFile(await base());
    const u = new Update(file);
    u.add(dict({ A: 1 }));
    const out = writeUpdate(file, u, { Info: ref(1), Foo: name('Bar') }).bytes;
    expect(lastTrailer(out)).toContain('/Info 1 0 R');
    expect(lastTrailer(out)).toContain('/Foo /Bar');
  });

  it('carries over every other key of the previous trailer (ISO 32000-1 7.5.6); trailerExtra wins', async () => {
    const file = new PdfFile(await base());
    const u = new Update(file);
    u.add(dict({ A: 1 }));
    const once = writeUpdate(file, u, { Foo: name('Bar'), Keep: 7 }).bytes;
    const second = new PdfFile(once);
    const u2 = new Update(second);
    u2.add(dict({ B: 2 }));
    const twice = writeUpdate(second, u2, { Keep: 8 }).bytes;
    const t = new PdfFile(twice).trailer.entries;
    expect(t.get('Foo')).toEqual(name('Bar'));
    expect(t.get('Keep')).toBe(8);
    expect(t.get('Info')).toEqual(file.trailer.entries.get('Info'));
    expect(t.get('Prev')).toBe(second.revisions[1]!.xrefAt);
  });
});

describe('numbers', () => {
  const num = (n: number): string => {
    const s = new TextSink();
    s.write(n);
    return ascii(s.bytes());
  };
  it('writes plain decimals', () => {
    expect(num(1e-7)).toBe('0');
    expect(num(0.5)).toBe('0.5');
    expect(num(-2.25)).toBe('-2.25');
    expect(num(123456.5)).toBe('123456.5');
    expect(num(1e-7)).not.toMatch(/e/i);
  });
  it('refuses non-finite and unsafe integers', () => {
    expect(() => num(NaN)).toThrow();
    expect(() => num(Infinity)).toThrow();
    expect(() => num(2 ** 60)).toThrow();
    expect(() => num(1e21)).toThrow();
    expect(num(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991');
  });
});

describe('writer refusals and freed objects', () => {
  it('refuses a stream nested in an array or dict, and unknown objects', () => {
    const st = { t: 'stream' as const, dict: dict({}), data: new Uint8Array(0) };
    expect(() => new TextSink().write([st] as never)).toThrow();
    expect(() => new TextSink().write(dict({ A: st as never }))).toThrow();
    expect(() => new TextSink().write({ t: 'bogus' } as never)).toThrow();
  });
  it('refuses raw text above 0xFF', () => {
    expect(() => new TextSink().write({ t: 'raw', text: 'aĀ' })).toThrow();
    const s = new TextSink();
    s.push('Ā');
    expect(() => s.bytes()).toThrow();
  });
  it('does not let the exposed maps bypass the generation check', async () => {
    const file = new PdfFile(await base());
    const u = new Update(file);
    (u.objects as Map<number, never>).set(1, dict({}) as never);
    (u.generations as Map<number, number>).set(1, 9);
    expect(u.objects.size).toBe(0);
    expect(() => writeUpdate(file, u)).toThrow();
  });
  it('reuses a freed object number with its freed generation', async () => {
    const pdf = await base();
    const file0 = new PdfFile(pdf);
    const u0 = new Update(file0);
    const r = u0.add(dict({ A: 1 }));
    const w0 = writeUpdate(file0, u0).bytes;
    const file1 = new PdfFile(w0);
    // Free the object by hand: a revision with an 'f' entry of generation 1.
    const s = written(w0);
    const xrefAt = s.length;
    const freeRev =
      s +
      `xref\n${r.num} 1\n0000000000 00001 f\r\ntrailer\n<</Size ${file1.size} /Root ${file1.rootRef.num} 0 R /Prev ${file1.revisions[file1.revisions.length - 1]!.xrefAt}>>\nstartxref\n${xrefAt}\n%%EOF\n`;
    const file2 = new PdfFile(latin1Bytes(freeRev));
    expect(file2.generation(r.num)).toBe(1);
    expect(file2.generation(0)).toBeUndefined();
    const u = new Update(file2);
    expect(() => u.set(ref(r.num, 0), dict({ B: 2 }))).toThrow();
    u.set(ref(r.num, 1), dict({ B: 2 }));
    const out = written(writeUpdate(file2, u).bytes);
    expect(out).toContain(`${r.num} 1 obj`);
    expect(out).toMatch(/\d{10} 00001 n/);
    expect(() => u.set(ref(0, 0), dict({}))).toThrow();
  });
});

describe('forged references and sizes', () => {
  it('a reference with the wrong generation fails at read time with a code', async () => {
    const f = new PdfFile(await base());
    const r = f.rootRef;
    let code: string | undefined;
    try {
      f.object(ref(r.num, r.gen + 1));
    } catch (e) {
      code = (e as PdfReadError).code;
    }
    expect(code).toBe('object-mismatch');
    expect(() => f.object(r)).not.toThrow();
  });

  it('refuses a trailer /Size beyond 2^31-1', async () => {
    const s = ascii(await base());
    const m = /\/Size (\d+)/.exec(s)!;
    const pdf = latin1Bytes(s.replace(m[0], '/Size 9999999999'));
    expect(() => new PdfFile(pdf)).toThrow(PdfReadError);
    try {
      new PdfFile(pdf);
    } catch (e) {
      expect((e as PdfReadError).code).toBe('syntax');
    }
  });
});

describe('object count limit', () => {
  const MAX = 2147483647;
  /** The base file with its trailer /Size set to `size` (the table itself is unchanged). */
  const withSize = async (size: number): Promise<Uint8Array> => {
    const s = ascii(await base());
    const m = /\/Size (\d+)/.exec(s)!;
    return latin1Bytes(s.replace(m[0], `/Size ${size}`));
  };

  it('refuses add and set that would push /Size past what PdfFile accepts', async () => {
    const file = new PdfFile(await withSize(MAX));
    expect(file.size).toBe(MAX);
    const u = new Update(file);
    expect(() => u.add(dict({}))).toThrow(/Size/);
    expect(() => u.set(ref(MAX), dict({}))).toThrow(/Size/);
    expect(u.objects.size).toBe(0);
  });

  it('writes a readable file up to the limit and refuses the object after it', async () => {
    const pdf = await withSize(MAX - 1);
    const file = new PdfFile(pdf);
    const u = new Update(file);
    const r = u.add(dict({ A: 1 }));
    expect(r.num).toBe(MAX - 1);
    expect(u.size).toBe(MAX);
    expect(() => u.add(dict({}))).toThrow(/Size/);
    const out = writeUpdate(file, u).bytes;
    const again = new PdfFile(out);
    expect(again.size).toBe(MAX);
    expect(again.object(r)).toMatchObject({ t: 'dict' });
  });

  it('writeUpdate refuses a size beyond the limit even if the maps were bypassed', async () => {
    const file = new PdfFile(await withSize(MAX));
    const u = new Update(file);
    Object.defineProperty(u, 'objects', { get: () => new Map([[MAX, dict({})]]) });
    expect(() => writeUpdate(file, u)).toThrow(/Size/);
  });
});

describe('page tree depth', () => {
  const nested = async (depth: number): Promise<Uint8Array> =>
    appendRevision(await base(), (f, u) => {
      let cur = u.add(dict({ Type: name('Page') }));
      for (let i = 0; i < depth; i++) cur = u.add(dict({ Type: name('Pages'), Kids: [cur] }));
      const cat = { t: 'dict' as const, entries: new Map(f.catalog.entries) };
      cat.entries.set('Pages', cur);
      u.set(f.rootRef, cat);
    });

  it('follows a chain within the limit and refuses one of 40 levels (no page is lost silently)', async () => {
    expect(new PdfFile(await nested(20)).pages()).toHaveLength(1);
    const deep = new PdfFile(await nested(40));
    expect(() => deep.pages()).toThrow(PdfReadError);
    expect(() => deep.pages()).toThrow(/deeper than 32/);
  });
});

describe('writeUpdate with stream data', () => {
  const streamUpdate = async (data: Uint8Array) => {
    const pdf = await base();
    const file = new PdfFile(pdf);
    const u = new Update(file);
    const r = u.add({ t: 'stream', dict: dict({ Type: name('X') }), data });
    return { pdf, r, out: writeUpdate(file, u).bytes };
  };

  it('writes binary data byte for byte between stream and endstream, prefix unchanged', async () => {
    const data = Uint8Array.from({ length: 256 }, (_, i) => i);
    const { pdf, r, out } = await streamUpdate(data);
    expect(out.subarray(0, pdf.length)).toEqual(pdf);
    const head = latin1Bytes(`\nstream\n`);
    const text = ascii(out);
    const at = text.indexOf(`${r.num} 0 obj\n`, pdf.length);
    const s = text.indexOf('\nstream\n', at) + head.length;
    expect(text.slice(at, s)).toContain('/Length 256');
    expect(out.subarray(s, s + 256)).toEqual(data);
    expect(text.slice(s + 256, s + 256 + 18)).toBe('\nendstream\nendobj\n');
    const offset = Number(/(\d{10}) 00000 n/.exec(text.slice(pdf.length))![1]);
    expect(text.slice(offset, offset + `${r.num} 0 obj`.length)).toBe(`${r.num} 0 obj`);
    expect(new PdfFile(out).revisions.length).toBe(2);
  });

  it('writes a 20 MB stream in reasonable time', async () => {
    const data = new Uint8Array(20 * 1024 * 1024);
    for (let i = 0; i < data.length; i += 4099) data[i] = i & 0xff;
    const t0 = performance.now();
    const { r, out } = await streamUpdate(data);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(5000);
    const file = new PdfFile(out);
    const o = file.object(r) as { data: Uint8Array };
    expect(o.data.length).toBe(data.length);
    expect(o.data[4099]).toBe(4099 & 0xff);
  });
});

describe('writeUpdate error context', () => {
  it('names object number and dict key / array index of an invalid object', async () => {
    const f = new PdfFile(await base());
    const u = new Update(f);
    const bad = { t: 'string', v: 'x' } as unknown as PdfObject;
    const r = u.add(dict({ A: [1, dict({ B: bad })] }));
    expect(() => writeUpdate(f, u)).toThrow(
      new RegExp(`object ${r.num}: .*unknown object.* at /A\\[1\\]/B`),
    );
    const u2 = new Update(f);
    const r2 = u2.add(bad);
    expect(() => writeUpdate(f, u2)).toThrow(`object ${r2.num}: write: unknown object`);
  });
});

describe('revision end', () => {
  it('ignores a %%EOF inside the trailer and still sees a removed attachment', async () => {
    const r1 = appendRevision(await base(), (f, u) =>
      attachFile(f, u, { name: 'a.txt', data: latin1Bytes('x'), mimeType: 'text/plain' }),
    );
    const f1 = new PdfFile(r1);
    const u = new Update(f1);
    const cat = new Map(f1.catalog.entries);
    cat.delete('Names');
    cat.delete('AF');
    u.set(f1.rootRef, { t: 'dict', entries: cat });
    const r2 = writeUpdate(f1, u, { Foo: latin1('%%EOF') }).bytes;
    const f2 = new PdfFile(r2);
    expect(f2.revisions).toHaveLength(3);
    expect(f2.revisions[2]!.end).toBe(r2.length - 1);
    expect(f2.revisionBytes(2)).toHaveLength(r2.length);
    expect(await attachmentChanges(r2)).toEqual([{ name: 'a.txt', kind: 'removed', revision: 2 }]);
  });

  it('refuses a revision without startxref and %%EOF after the trailer', async () => {
    const pdf = await base();
    const s = ascii(pdf);
    const cut = latin1Bytes(s.slice(0, s.lastIndexOf('startxref')) + 'startxref\n1\n');
    expect(() => new PdfFile(cut)).toThrow(PdfReadError);
  });
});

describe('PdfFile hostile layouts', () => {
  it('refuses a linearized file (revisions not monotonic)', () => {
    const parts: string[] = ['%PDF-1.4\n'];
    const at = (): number => parts.join('').length;
    const offs: number[] = [];
    offs[1] = at();
    parts.push('1 0 obj\n<</Linearized 1 /L 0>>\nendobj\n');
    offs[2] = at();
    parts.push('2 0 obj\n<</Type/Catalog>>\nendobj\n');
    const first = at();
    const mainAt = 'x'.repeat(0);
    void mainAt;
    // Main section goes to the end; its offset is fixed below.
    const pad = (n: number): string => String(n).padStart(10, '0');
    const firstXref = (prev: number): string =>
      `xref\n1 2\n${pad(offs[1]!)} 00000 n \n${pad(offs[2]!)} 00000 n \ntrailer\n<</Size 3/Root 2 0 R/Prev ${String(prev).padStart(6, '0')}>>\nstartxref\n0\n%%EOF\n`;
    const body = firstXref(0);
    const mainStart = first + body.length;
    parts.push(firstXref(mainStart));
    parts.push(
      `xref\n0 1\n0000000000 65535 f \ntrailer\n<</Size 3/Root 2 0 R>>\nstartxref\n${first}\n%%EOF\n`,
    );
    const bytes = latin1Bytes(parts.join(''));
    try {
      new PdfFile(bytes);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PdfReadError);
      expect((e as PdfReadError).code).toBe('linearized');
    }
  });

  it.each([
    ['self', '<</Length 7 0 R>>', '<</Length 7 0 R>>'],
    ['A-B-A', '<</Length 8 0 R>>', '<</Length 7 0 R>>'],
  ])('refuses a cyclic stream /Length (%s)', (_n, d7, d8) => {
    const parts: string[] = ['%PDF-1.4\n'];
    const offs: number[] = [];
    const add = (n: number, body: string): void => {
      offs[n] = parts.join('').length;
      parts.push(`${n} 0 obj\n${body}\nendobj\n`);
    };
    add(1, '<</Type/Catalog>>');
    add(7, `${d7}\nstream\nabc\nendstream`);
    add(8, `${d8}\nstream\nabc\nendstream`);
    const x = parts.join('').length;
    const pad = (n: number): string => String(n).padStart(10, '0');
    parts.push(
      `xref\n0 1\n0000000000 65535 f \n1 1\n${pad(offs[1]!)} 00000 n \n7 2\n${pad(offs[7]!)} 00000 n \n${pad(offs[8]!)} 00000 n \ntrailer\n<</Size 9/Root 1 0 R>>\nstartxref\n${x}\n%%EOF\n`,
    );
    const file = new PdfFile(latin1Bytes(parts.join('')));
    expect(() => file.object(ref(7))).toThrow(PdfReadError);
    expect(() => file.object(ref(7))).not.toThrow(RangeError);
  });
});

describe('pages() with an indirect /Kids', () => {
  const indirectKids = async (): Promise<Uint8Array> => {
    const pdf = await basePdf(1);
    return appendRevision(pdf, (f, u) => {
      const pagesRef = f.catalog.entries.get('Pages') as PdfRef;
      const node = f.dict(pagesRef)!;
      const kids = u.add(node.entries.get('Kids') as PdfObject);
      const copy = { t: 'dict' as const, entries: new Map(node.entries) };
      copy.entries.set('Kids', kids);
      u.set(pagesRef, copy);
    });
  };

  it('returns the page, not the Pages node, and stamps the page', async () => {
    const pdf = await indirectKids();
    const f = new PdfFile(pdf);
    const pagesRef = f.catalog.entries.get('Pages') as PdfRef;
    expect(isRef(f.dict(pagesRef)!.entries.get('Kids'))).toBe(true);
    const pages = f.pages();
    expect(pages).toHaveLength(1);
    expect(pages[0]!.num).not.toBe(pagesRef.num);
    const stamped = new PdfFile(await appendDocTimeStamp(pdf, fakeStamper(), { reserve: 2048 }));
    expect(stamped.dict(pagesRef)!.entries.has('Annots')).toBe(false);
    expect(stamped.dict(pages[0])!.entries.has('Annots')).toBe(true);
  });

  it('refuses a /Pages node as a page', async () => {
    const pdf = await basePdf(1);
    const bad = appendRevision(pdf, (f, u) => {
      const pagesRef = f.catalog.entries.get('Pages') as PdfRef;
      const copy = { t: 'dict' as const, entries: new Map(f.dict(pagesRef)!.entries) };
      copy.entries.set('Kids', name('X'));
      u.set(pagesRef, copy);
    });
    expect(() => new PdfFile(bad).pages()).toThrow(PdfReadError);
  });
});

describe('hand-built revision chains and guards', () => {
  const header = '%PDF-1.7\n';
  const obj = (n: number, body: string): string => `${n} 0 obj\n${body}\nendobj\n`;
  const entry = (off: number): string => `${String(off).padStart(10, '0')} 00000 n\r\n`;
  const free = '0000000000 65535 f\r\n';
  const cat = '<< /Type /Catalog >>';

  /** One revision with the given objects; `entries` overrides the offset written for an object number. */
  const single = (
    bodies: string[],
    opts: { size?: string; tail?: string; entries?: Record<number, number> } = {},
  ): Uint8Array => {
    let out = header;
    const offs: number[] = [];
    bodies.forEach((b, i) => {
      offs.push(out.length);
      out += obj(i + 1, b);
    });
    const xrefAt = out.length;
    out += `xref\n0 ${bodies.length + 1}\n${free}`;
    offs.forEach((o, i) => (out += entry(opts.entries?.[i + 1] ?? o)));
    out += `trailer\n<< /Size ${opts.size ?? bodies.length + 1} /Root 1 0 R >>\n`;
    out += `startxref\n${xrefAt}\n${opts.tail ?? '%%EOF\n'}`;
    return latin1Bytes(out);
  };

  const codeOf = (fn: () => unknown): string | undefined => {
    try {
      fn();
    } catch (e) {
      if (e instanceof PdfReadError) return e.code;
      throw e;
    }
    return undefined;
  };

  it('refuses a /Linearized dictionary as the first object, even with a single revision', () => {
    const f = single(['<< /Linearized 1 /L 100 /O 3 /E 50 /N 1 /T 90 /H [1 2] >>', cat]);
    expect(codeOf(() => new PdfFile(f))).toBe('linearized');
    // /Linearized further down is only an ordinary key.
    const g = single([cat, '<< /Linearized 1 >>']);
    expect(new PdfFile(g).revisions).toHaveLength(1);
  });

  it('refuses revisions that do not lie one after the other (/Prev points forward)', () => {
    // The newest section (found by the last startxref) lies first in the file; its /Prev points forward.
    const o1 = header.length;
    const xAt = o1 + obj(1, cat).length;
    const xPart = (prev: number): string =>
      `xref\n0 2\n${free}${entry(o1)}trailer\n<< /Size 2 /Root 1 0 R /Prev ${String(prev).padStart(6, '0')} >>\nstartxref\n${xAt}\n%%EOF\n`;
    const yAt = xAt + xPart(xAt).length; // /Prev has a fixed width
    const y = `xref\n0 1\n${free}trailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n${xAt}\n%%EOF\n`;
    const file = latin1Bytes(header + obj(1, cat) + xPart(yAt) + y);
    expect(ascii(file).indexOf('xref\n0 1')).toBe(yAt);
    expect(codeOf(() => new PdfFile(file))).toBe('linearized');
  });

  it('refuses two revisions that end at the same %%EOF', () => {
    // The newest xref section sits inside a comment of the oldest one: both end at one %%EOF.
    const o1 = header.length;
    const yAt = o1 + obj(1, cat).length;
    const yHead = `xref\n0 2\n${free}${entry(o1)}trailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n${yAt}\n% `;
    const xAt = yAt + yHead.length;
    const tail = `xref trailer << /Size 2 /Root 1 0 R /Prev ${yAt} >> startxref ${xAt}\n%%EOF\n`;
    const bytes = latin1Bytes(header + obj(1, cat) + yHead + tail);
    expect(codeOf(() => new PdfFile(bytes))).toBe('linearized');
  });

  it('refuses a /Size that is not a whole non-negative number', () => {
    expect(new PdfFile(single([cat], { size: '2' })).size).toBe(2);
    expect(codeOf(() => new PdfFile(single([cat], { size: '3.5' })))).toBe('syntax');
    expect(codeOf(() => new PdfFile(single([cat], { size: '-1' })))).toBe('syntax');
  });

  it('revisionBytes takes one line end after %%EOF: CRLF as two bytes, a lone CR or LF as one', () => {
    const crlf = new PdfFile(single([cat], { tail: '%%EOF\r\nrest' }));
    expect(crlf.revisionBytes(0).length).toBe(crlf.revisions[0]!.end + 2);
    const cr = new PdfFile(single([cat], { tail: '%%EOF\rxrest' }));
    expect(cr.revisionBytes(0).length).toBe(cr.revisions[0]!.end + 1);
    const lf = new PdfFile(single([cat], { tail: '%%EOF\nrest' }));
    expect(lf.revisionBytes(0).length).toBe(lf.revisions[0]!.end + 1);
    const none = new PdfFile(single([cat], { tail: '%%EOF' }));
    expect(none.revisionBytes(0).length).toBe(none.revisions[0]!.end);
    expect(() => none.revisionBytes(1)).toThrow(RangeError);
  });

  it('refuses an xref entry that points at another object (object-mismatch)', () => {
    const bodies = [cat, '<< /A 1 >>', '<< /A 2 >>', '<< /A 3 >>', '<< /A 4 >>'];
    const ok = single(bodies);
    const f0 = new PdfFile(ok);
    expect(f0.object(ref(5))).toMatchObject({ t: 'dict' });
    const at4 = ascii(ok).indexOf('4 0 obj');
    const f = new PdfFile(single(bodies, { entries: { 5: at4 } }));
    expect(codeOf(() => f.object(ref(5)))).toBe('object-mismatch');
    expect(codeOf(() => f.object(ref(4)))).toBeUndefined();
  });

  it('PdfFile.object caches a good object and throws the same code again for a broken one', () => {
    const bodies = [cat, '<< /A 1 >>'];
    const at1 = ascii(single(bodies)).indexOf('1 0 obj');
    const f = new PdfFile(single(bodies, { entries: { 2: at1 } }));
    expect(codeOf(() => f.object(ref(2)))).toBe('object-mismatch');
    expect(codeOf(() => f.object(ref(2)))).toBe('object-mismatch');
    const g = new PdfFile(single(bodies));
    const a = g.object(ref(2));
    expect(g.object(ref(2))).toBe(a);
    expect(g.object(ref(2, 0))).toBe(a);
  });
});

describe('revision directly after an EOL-less %%EOF', () => {
  async function glued(prefix: string): Promise<{ bytes: Uint8Array; num: number }> {
    let s = ascii(await base());
    s = s.replace(/%%EOF\s*$/, '%%EOF');
    const f = new PdfFile(latin1Bytes(s));
    const num = f.size;
    const prev = f.revisions[f.revisions.length - 1]!.xrefAt;
    const objAt = s.length + prefix.length;
    const xrefAt = objAt + `${num} 0 obj\n<</A 1>>\nendobj\n`.length;
    const pad = (n: number): string => String(n).padStart(10, '0');
    s +=
      `${prefix}${num} 0 obj\n<</A 1>>\nendobj\n` +
      `xref\n${num} 1\n${pad(objAt)} 00000 n \ntrailer\n<</Size ${num + 1}/Root ${f.rootRef.num} 0 R/Prev ${prev}>>\nstartxref\n${xrefAt}\n%%EOF\n`;
    return { bytes: latin1Bytes(s), num };
  }

  it('reads the older revision, attachmentChanges and appendRevision work', async () => {
    const { bytes, num } = await glued('');
    const f = new PdfFile(bytes);
    expect(f.revisions).toHaveLength(2);
    expect(f.object(ref(num))).toBeDefined();
    expect(await attachmentChanges(bytes)).toEqual([]);
    const out = appendRevision(bytes, (file, u) =>
      attachFile(file, u, { name: 'a.txt', data: latin1Bytes('x'), mimeType: 'text/plain' }),
    );
    expect(new PdfFile(out).revisions).toHaveLength(3);
    expect(out.slice(0, bytes.length)).toEqual(bytes);
  });

  it('still refuses a header right behind a digit', async () => {
    const { bytes, num } = await glued('7');
    let code: string | undefined;
    try {
      new PdfFile(bytes).object(ref(num));
    } catch (e) {
      code = (e as PdfReadError).code;
    }
    expect(code).toBe('object-mismatch');
  });
});

describe('trailer /ID', () => {
  const ids = (bytes: Uint8Array): string[] =>
    [...lastTrailer(bytes).matchAll(/\/ID\s*\[<([0-9a-fA-F]*)>\s*<([0-9a-fA-F]*)>\]/g)].flatMap(
      (m) => [m[1]!, m[2]!],
    );
  const add = (pdf: Uint8Array, n = 1): Uint8Array =>
    appendRevision(pdf, (_f, u) => {
      u.add(dict({ N: n }));
    });

  it('creates one for a base without /ID: two 16 byte hex strings', async () => {
    const pdf = await base();
    expect(written(pdf)).not.toContain('/ID');
    const [a, b] = ids(add(pdf));
    expect(a).toMatch(/^[0-9a-fA-F]{32}$/);
    expect(b).toMatch(/^[0-9a-fA-F]{32}$/);
    expect(a).toBe(b);
  });

  it('keeps the first element and changes the second on a later revision', async () => {
    const r1 = add(await base());
    const r2 = add(r1, 2);
    const [a1, b1] = ids(r1);
    const [a2, b2] = ids(r2);
    expect(a2).toBe(a1);
    expect(b2).not.toBe(b1);
    expect(b2).toMatch(/^[0-9a-fA-F]{32}$/);
  });

  it('is deterministic', async () => {
    const pdf = await base();
    expect(add(pdf)).toEqual(add(pdf));
  });

  it('throws on a malformed /ID', async () => {
    const r1 = add(await base());
    for (const bad of ['/ID [<00>]', '/ID 5', '/ID [<00> 7]']) {
      const s = written(r1);
      const at = s.lastIndexOf('/ID');
      const end = s.indexOf(']', at) + 1;
      const pdf = latin1Bytes(s.slice(0, at) + bad + s.slice(end));
      expect(() => add(pdf)).toThrow(PdfReadError);
    }
  });

  it('keeps the first element of an /ID set with pdf-lib', async () => {
    const { PDFDocument, PDFHexString } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    doc.addPage([100, 100]);
    const first = '0123456789abcdef0123456789abcdef';
    doc.context.trailerInfo.ID = doc.context.obj([PDFHexString.of(first), PDFHexString.of(first)]);
    const out = add(await doc.save({ useObjectStreams: false }));
    const [a, b] = ids(out).map((x) => x.toLowerCase());
    expect(a).toBe(first);
    expect(b).not.toBe(first);
  });
});
