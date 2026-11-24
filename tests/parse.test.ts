import { describe, expect, it } from 'vitest';
import { Lexer, PdfReadError, lastStartxref, readIndirect, readXrefSection } from '../src/parse.ts';
import { TextSink } from '../src/objects.ts';
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

describe('names round-trip byte-exact', () => {
  const written = (src: string): Uint8Array => {
    const sink = new TextSink();
    sink.write(new Lexer(text(src)).readObject());
    return sink.bytes();
  };

  it('keeps non-UTF-8 bytes and a BOM', () => {
    expect(new Lexer(text('/Fl#E4che')).readObject()).toEqual({ t: 'name', v: 'Fl\u00e4che' });
    expect(new Lexer(text('/#EF#BB#BFAb')).readObject()).toEqual({
      t: 'name',
      v: '\u00ef\u00bb\u00bfAb',
    });
    expect(written('<</Fl#E4che 1>>')).toEqual(text('<</Fl#e4che 1\n>>'));
    expect(written('/#EF#BB#BFAb')).toEqual(text('/#ef#bb#bfAb'));
  });

  it('writes characters above U+00FF as UTF-8 bytes', () => {
    const sink = new TextSink();
    sink.write({ t: 'name', v: 'A\u20acB' });
    expect(sink.bytes()).toEqual(text('/A#e2#82#acB'));
  });
});

describe('literal string line ends', () => {
  const str = (s: string) => {
    const o = new Lexer(text(s)).readObject() as { bytes: Uint8Array };
    return Array.from(o.bytes);
  };

  it('reads an unescaped CR or CRLF as one LF', () => {
    expect(str('(a\rb)')).toEqual([0x61, 0x0a, 0x62]);
    expect(str('(a\r\nb)')).toEqual([0x61, 0x0a, 0x62]);
    expect(str('(a\nb)')).toEqual([0x61, 0x0a, 0x62]);
    expect(str('(a\r\rb)')).toEqual([0x61, 0x0a, 0x0a, 0x62]);
  });

  it('keeps escaped line continuations and escaped CR', () => {
    expect(str('(a\\\r\nb)')).toEqual([0x61, 0x62]);
    expect(str('(a\\rb)')).toEqual([0x61, 0x0d, 0x62]);
  });
});

describe('unsafe integers', () => {
  it('refuses integers and generations beyond 2^53', () => {
    expect(codeOf(() => new Lexer(text('99999999999999999999'), 0).readObject())).toBe('syntax');
    expect(codeOf(() => new Lexer(text('1 99999999999999999999 R'), 0).readObject())).toBe(
      'syntax',
    );
    expect(new Lexer(text('123'), 0).readObject()).toBe(123);
  });
});
