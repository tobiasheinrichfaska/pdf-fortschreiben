import { PdfFile, PdfReadError, Update, dict, name, ref, writeUpdate } from '../src/index.ts';
import { TextSink } from '../src/objects.ts';
import { ascii, basePdf } from './helpers.ts';

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
