/**
 * A small reader for the PDF syntax this library needs: objects, indirect objects at a known offset and
 * classic cross-reference tables. It reads the files the library and pdf-lib write (classic `xref`
 * sections, no cross-reference streams, no object streams); anything else is refused with a code.
 */
import type { PdfDict, PdfObject, PdfStream } from './objects.ts';
import { isDict, isRef } from './objects.ts';

export type ReadFailure =
  | 'syntax'
  | 'no-startxref'
  | 'xref-stream'
  | 'object-stream'
  | 'xref-loop'
  | 'object-missing'
  | 'object-mismatch';

export class PdfReadError extends Error {
  readonly code: ReadFailure;
  constructor(code: ReadFailure, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

const isWhite = (c: number): boolean =>
  c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
const isDelim = (c: number): boolean => '()<>[]{}/%'.includes(String.fromCharCode(c));

export class Lexer {
  readonly buf: Uint8Array;
  pos: number;
  constructor(buf: Uint8Array, pos = 0) {
    this.buf = buf;
    this.pos = pos;
  }

  private fail(what: string): never {
    throw new PdfReadError('syntax', `${what} at ${this.pos}`);
  }

  skipSpace(): void {
    const b = this.buf;
    while (this.pos < b.length) {
      const c = b[this.pos]!;
      if (isWhite(c)) this.pos++;
      else if (c === 0x25) {
        while (this.pos < b.length && b[this.pos] !== 0x0a && b[this.pos] !== 0x0d) this.pos++;
      } else break;
    }
  }

  /** A run of regular characters (keyword or number) without moving past it on failure. */
  peekWord(): string {
    this.skipSpace();
    let end = this.pos;
    while (end < this.buf.length && !isWhite(this.buf[end]!) && !isDelim(this.buf[end]!)) end++;
    return latin1Text(this.buf, this.pos, end);
  }

  word(): string {
    const w = this.peekWord();
    this.pos += w.length;
    return w;
  }

  expectWord(w: string): void {
    if (this.word() !== w) this.fail(`expected ${w}`);
  }

  readObject(): PdfObject {
    this.skipSpace();
    const c = this.buf[this.pos];
    if (c === undefined) this.fail('end of data');
    if (c === 0x2f) return this.readName();
    if (c === 0x28) return this.readLiteral();
    if (c === 0x3c) {
      if (this.buf[this.pos + 1] === 0x3c) return this.readDict();
      return this.readHex();
    }
    if (c === 0x5b) {
      this.pos++;
      const items: PdfObject[] = [];
      for (;;) {
        this.skipSpace();
        if (this.buf[this.pos] === 0x5d) {
          this.pos++;
          return items;
        }
        items.push(this.readObject());
      }
    }
    const w = this.word();
    if (w === 'true') return true;
    if (w === 'false') return false;
    if (w === 'null') return null;
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) this.fail(`unexpected "${w}"`);
    const n = Number(w);
    // An integer may start a reference "num gen R".
    if (/^\d+$/.test(w)) {
      const save = this.pos;
      const g = this.word();
      if (/^\d+$/.test(g) && this.word() === 'R') return { t: 'ref', num: n, gen: Number(g) };
      this.pos = save;
    }
    return n;
  }

  private readName(): PdfObject {
    this.pos++;
    const bytes: number[] = [];
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos]!;
      if (isWhite(c) || isDelim(c)) break;
      if (c === 0x23) {
        bytes.push(parseInt(latin1Text(this.buf, this.pos + 1, this.pos + 3), 16));
        this.pos += 3;
      } else {
        bytes.push(c);
        this.pos++;
      }
    }
    return { t: 'name', v: new TextDecoder().decode(Uint8Array.from(bytes)) };
  }

  private readLiteral(): PdfObject {
    this.pos++;
    const out: number[] = [];
    let depth = 1;
    const b = this.buf;
    while (this.pos < b.length) {
      const c = b[this.pos++]!;
      if (c === 0x5c) {
        const e = b[this.pos++];
        if (e === undefined) break;
        const map: Record<number, number> = {
          0x6e: 0x0a,
          0x72: 0x0d,
          0x74: 0x09,
          0x62: 0x08,
          0x66: 0x0c,
        };
        if (map[e] !== undefined) out.push(map[e]);
        else if (e >= 0x30 && e <= 0x37) {
          let v = e - 0x30;
          for (let k = 0; k < 2 && b[this.pos]! >= 0x30 && b[this.pos]! <= 0x37; k++)
            v = v * 8 + (b[this.pos++]! - 0x30);
          out.push(v & 0xff);
        } else if (e === 0x0d) {
          if (b[this.pos] === 0x0a) this.pos++;
        } else if (e !== 0x0a) out.push(e);
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        if (--depth === 0) return { t: 'str', bytes: Uint8Array.from(out) };
        out.push(c);
      } else out.push(c);
    }
    this.fail('unterminated string');
  }

  private readHex(): PdfObject {
    this.pos++;
    let digits = '';
    while (this.pos < this.buf.length && this.buf[this.pos] !== 0x3e) {
      const c = this.buf[this.pos++]!;
      if (!isWhite(c)) digits += String.fromCharCode(c);
    }
    this.pos++;
    if (!/^[0-9a-fA-F]*$/.test(digits)) this.fail('bad hex string');
    if (digits.length % 2) digits += '0';
    const bytes = new Uint8Array(digits.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(digits.slice(i * 2, i * 2 + 2), 16);
    return { t: 'hex', bytes };
  }

  private readDict(): PdfDict {
    this.pos += 2;
    const entries = new Map<string, PdfObject>();
    for (;;) {
      this.skipSpace();
      if (this.buf[this.pos] === 0x3e && this.buf[this.pos + 1] === 0x3e) {
        this.pos += 2;
        return { t: 'dict', entries };
      }
      const key = this.readObject();
      if (typeof key !== 'object' || key === null || Array.isArray(key) || key.t !== 'name')
        this.fail('dictionary key');
      entries.set(key.v, this.readObject());
    }
  }
}

export function latin1Text(buf: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end && i < buf.length; i++) s += String.fromCharCode(buf[i]!);
  return s;
}

/** Last occurrence of an ASCII marker before `before`. */
export function lastIndexOf(buf: Uint8Array, marker: string, before = buf.length): number {
  outer: for (let i = Math.min(before, buf.length) - marker.length; i >= 0; i--) {
    for (let k = 0; k < marker.length; k++) if (buf[i + k] !== marker.charCodeAt(k)) continue outer;
    return i;
  }
  return -1;
}

export function indexOf(buf: Uint8Array, marker: string, from = 0): number {
  outer: for (let i = from; i <= buf.length - marker.length; i++) {
    for (let k = 0; k < marker.length; k++) if (buf[i + k] !== marker.charCodeAt(k)) continue outer;
    return i;
  }
  return -1;
}

/** One `xref` section with its trailer, as found in the file. */
export interface XrefSection {
  /** Offset of the `xref` keyword (the value `startxref` points to). */
  readonly at: number;
  readonly entries: Map<number, { offset: number; gen: number; inUse: boolean }>;
  readonly trailer: PdfDict;
}

export function readXrefSection(buf: Uint8Array, at: number): XrefSection {
  const lx = new Lexer(buf, at);
  const w = lx.peekWord();
  if (w !== 'xref') {
    if (/^\d+$/.test(w)) throw new PdfReadError('xref-stream', `cross-reference stream at ${at}`);
    throw new PdfReadError('syntax', `no xref at ${at}`);
  }
  lx.word();
  const entries = new Map<number, { offset: number; gen: number; inUse: boolean }>();
  for (;;) {
    const head = lx.peekWord();
    if (head === 'trailer') break;
    const start = Number(lx.word());
    const count = Number(lx.word());
    if (!Number.isInteger(start) || !Number.isInteger(count) || count < 0)
      throw new PdfReadError('syntax', `xref subsection at ${lx.pos}`);
    for (let i = 0; i < count; i++) {
      const offset = Number(lx.word());
      const gen = Number(lx.word());
      const kind = lx.word();
      if (kind !== 'n' && kind !== 'f') throw new PdfReadError('syntax', `xref entry at ${lx.pos}`);
      entries.set(start + i, { offset, gen, inUse: kind === 'n' });
    }
  }
  lx.word();
  const trailer = lx.readObject();
  if (!isDict(trailer)) throw new PdfReadError('syntax', 'trailer');
  if (trailer.entries.has('XRefStm'))
    throw new PdfReadError('xref-stream', 'hybrid file with /XRefStm');
  return { at, entries, trailer };
}

/** The offset the last `startxref` (before `end`) points to. */
export function lastStartxref(buf: Uint8Array, end = buf.length): number {
  const i = lastIndexOf(buf, 'startxref', end);
  if (i < 0) throw new PdfReadError('no-startxref', 'no startxref');
  const n = Number(new Lexer(buf, i + 'startxref'.length).word());
  if (!Number.isInteger(n) || n < 0 || n >= buf.length)
    throw new PdfReadError('no-startxref', 'bad startxref');
  return n;
}

/** Reads the object `num` at `offset`: either a plain object or a stream. */
export function readIndirect(
  buf: Uint8Array,
  offset: number,
  num: number,
  resolveLength: (o: PdfObject) => number,
): PdfObject | PdfStream {
  const lx = new Lexer(buf, offset);
  const n = Number(lx.word());
  lx.word();
  if (lx.word() !== 'obj' || n !== num)
    throw new PdfReadError('object-mismatch', `object ${num} not at ${offset}`);
  const value = lx.readObject();
  if (lx.peekWord() === 'stream' && isDict(value)) {
    lx.word();
    if (buf[lx.pos] === 0x0d) lx.pos++;
    if (buf[lx.pos] === 0x0a) lx.pos++;
    const len = resolveLength(value.entries.get('Length') ?? null);
    const data = buf.slice(lx.pos, lx.pos + len);
    const type = value.entries.get('Type');
    if (typeof type === 'object' && type !== null && !Array.isArray(type) && type.t === 'name') {
      if (type.v === 'ObjStm') throw new PdfReadError('object-stream', `object ${num}`);
      if (type.v === 'XRef') throw new PdfReadError('xref-stream', `object ${num}`);
    }
    const dictCopy: PdfDict = { t: 'dict', entries: new Map(value.entries) };
    dictCopy.entries.delete('Length');
    return { t: 'stream', dict: dictCopy, data };
  }
  return value;
}

export const isStream = (o: unknown): o is PdfStream =>
  typeof o === 'object' && o !== null && (o as { t?: string }).t === 'stream';

export { isRef };
