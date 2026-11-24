import { describe, expect, it } from 'vitest';
import { Lexer, PdfReadError, lastStartxref, readIndirect, readXrefSection } from '../src/parse.ts';
import { text } from './helpers.ts';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    if (e instanceof PdfReadError) return e.code;
    throw e;
  }
  return undefined;
};

describe('readXrefSection', () => {
  it('refuses truncated tables instead of looping', { timeout: 2000 }, () => {
    expect(codeOf(() => readXrefSection(text('xref\n0 1\n0000000000 65535 f \n'), 0))).toBe(
      'syntax',
    );
    expect(codeOf(() => readXrefSection(text('xref\n<<'), 0))).toBe('syntax');
    expect(codeOf(() => readXrefSection(text('xref\n'), 0))).toBe('syntax');
  });

  it('refuses non-numeric subsection and entry numbers', () => {
    const t = 'trailer\n<< >>\n';
    expect(codeOf(() => readXrefSection(text(`xref\n0x0 1\n0000000000 65535 f \n${t}`), 0))).toBe(
      'syntax',
    );
    expect(codeOf(() => readXrefSection(text(`xref\n0 1\n0x5 65535 f \n${t}`), 0))).toBe('syntax');
    expect(codeOf(() => readXrefSection(text(`xref\n0 1\n0000000000 99999 f \n${t}`), 0))).toBe(
      'syntax',
    );
    expect(codeOf(() => readXrefSection(text(`xref\n0 1\n0000009999 00000 n \n${t}`), 0))).toBe(
      'syntax',
    );
  });

  it('reports xref-stream only for a real /Type /XRef object', () => {
    expect(codeOf(() => readXrefSection(text('12 junk'), 0))).toBe('syntax');
    expect(codeOf(() => readXrefSection(text('4 0 obj\n<< /Type /Page >>\nendobj\n'), 0))).toBe(
      'syntax',
    );
    expect(
      codeOf(() => readXrefSection(text('4 0 obj\n<< /Type /XRef /Length 0 >>\nstream\n'), 0)),
    ).toBe('xref-stream');
  });

  it('reads a valid table', () => {
    const s = readXrefSection(text('xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 1 >>\n'), 0);
    expect(s.entries.size).toBe(1);
  });
});

describe('lastStartxref', () => {
  it('needs a plain decimal number', () => {
    const pad = 'x'.repeat(20);
    expect(lastStartxref(text(`${pad}\nstartxref\n5\n%%EOF`))).toBe(5);
    expect(codeOf(() => lastStartxref(text(`${pad}\nstartxref\n0x5\n%%EOF`)))).toBe('no-startxref');
    expect(codeOf(() => lastStartxref(text(`${pad}\nstartxref`)))).toBe('no-startxref');
    expect(codeOf(() => lastStartxref(text(`${pad}\nstartxref\n%%EOF`)))).toBe('no-startxref');
  });
});

describe('Lexer', () => {
  it('limits nesting depth', () => {
    expect(codeOf(() => new Lexer(text('['.repeat(200000))).readObject())).toBe('syntax');
    expect(codeOf(() => new Lexer(text('<</A '.repeat(5000))).readObject())).toBe('syntax');
    expect(new Lexer(text('['.repeat(100) + ']'.repeat(100))).readObject()).toBeTruthy();
  });

  it('refuses an unterminated hex string and a bad name escape', () => {
    expect(codeOf(() => new Lexer(text('<414')).readObject())).toBe('syntax');
    expect(codeOf(() => new Lexer(text('/A#zzB')).readObject())).toBe('syntax');
    expect(new Lexer(text('/A#42C')).readObject()).toEqual({ t: 'name', v: 'ABC' });
  });
});

describe('readIndirect', () => {
  const read = (s: string, len?: number) =>
    readIndirect(text(s), 0, 1, (o) => (typeof o === 'number' ? o : (len ?? -1)));

  it('reads a well-formed stream', () => {
    const o = read('1 0 obj\n<< /Length 3 >>\nstream\nabc\nendstream\nendobj\n');
    expect(o).toMatchObject({ t: 'stream' });
  });

  it('refuses bad lengths and a missing endstream', () => {
    expect(codeOf(() => read('1 0 obj\n<< /Length 999 >>\nstream\nabc\nendstream\n'))).toBe(
      'syntax',
    );
    expect(codeOf(() => read('1 0 obj\n<< /Length -1 >>\nstream\nabc\nendstream\n'))).toBe(
      'syntax',
    );
    expect(codeOf(() => read('1 0 obj\n<< /Length 1.5 >>\nstream\nabc\nendstream\n'))).toBe(
      'syntax',
    );
    expect(codeOf(() => read('1 0 obj\n<< /Length 2 >>\nstream\nabc\nendstream\n'))).toBe('syntax');
  });
});
