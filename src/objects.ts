/**
 * The PDF object model of this library and its serializer. Only what the library writes and reads is
 * modelled: numbers, booleans, null, names, literal and hex strings, arrays, dictionaries, references,
 * streams, and `raw` text (fixed-width placeholders whose byte offsets the writer reports).
 */
import { PdfError } from './errors.ts';

export interface PdfName {
  readonly t: 'name';
  readonly v: string;
}
export interface PdfString {
  readonly t: 'str';
  readonly bytes: Uint8Array;
}
export interface PdfHex {
  readonly t: 'hex';
  readonly bytes: Uint8Array;
}
export interface PdfRef {
  readonly t: 'ref';
  readonly num: number;
  readonly gen: number;
}
export interface PdfDict {
  readonly t: 'dict';
  readonly entries: Map<string, PdfObject>;
}
/** Text written as it stands; `id` names it so that the writer can report where it landed. */
export interface PdfRaw {
  readonly t: 'raw';
  readonly text: string;
  readonly id?: string;
}
export type PdfObject =
  null | boolean | number | PdfName | PdfString | PdfHex | PdfRef | PdfDict | PdfRaw | PdfObject[];

/** A stream object: its dictionary (without `/Length`, the writer sets it) and its bytes. */
export interface PdfStream {
  readonly t: 'stream';
  readonly dict: PdfDict;
  readonly data: Uint8Array;
}

export const name = (v: string): PdfName => ({ t: 'name', v });
export const ref = (num: number, gen = 0): PdfRef => ({ t: 'ref', num, gen });
export const raw = (text: string, id?: string): PdfRaw =>
  id === undefined ? { t: 'raw', text } : { t: 'raw', text, id };
export const hex = (bytes: Uint8Array): PdfHex => ({ t: 'hex', bytes });

/** A dictionary from a plain record (keys without the slash; `undefined` values are left out). */
export function dict(entries: Record<string, PdfObject | undefined>): PdfDict {
  const map = new Map<string, PdfObject>();
  for (const [k, v] of Object.entries(entries)) if (v !== undefined) map.set(k, v);
  return { t: 'dict', entries: map };
}

/** A literal string from text: Latin-1 characters as they are; anything else is refused (use `textString`). */
export function latin1(text: string): PdfString {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 0xff) throw new PdfError('bad-object', `latin1: character outside Latin-1 at ${i}`);
    bytes[i] = c;
  }
  return { t: 'str', bytes };
}

/** A PDF text string for any text: UTF-16BE with byte order mark, as a hex string. */
export function textString(text: string): PdfHex {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes[0] = 0xfe;
  bytes[1] = 0xff;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    bytes[2 + i * 2] = c >> 8;
    bytes[3 + i * 2] = c & 0xff;
  }
  return hex(bytes);
}

/**
 * A PDF text string as text: UTF-16BE with byte order mark, UTF-8 with byte order mark (PDF 2.0; the mark is
 * dropped), else PDFDocEncoding (taken as Latin-1). An odd-length UTF-16 string is a `syntax` error.
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    if (bytes.length % 2 !== 0) throw new PdfError('syntax', 'name tree key: odd UTF-16 length');
    let out = '';
    for (let i = 2; i < bytes.length; i += 2)
      out += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
    return out;
  }
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

export const isDict = (o: PdfObject | undefined): o is PdfDict =>
  typeof o === 'object' && o !== null && !Array.isArray(o) && o.t === 'dict';
export const isRef = (o: PdfObject | undefined): o is PdfRef =>
  typeof o === 'object' && o !== null && !Array.isArray(o) && o.t === 'ref';
export const isName = (o: PdfObject | undefined, v?: string): o is PdfName =>
  typeof o === 'object' &&
  o !== null &&
  !Array.isArray(o) &&
  o.t === 'name' &&
  (v === undefined || o.v === v);
export const isStringLike = (o: PdfObject | undefined): o is PdfString | PdfHex =>
  typeof o === 'object' && o !== null && !Array.isArray(o) && (o.t === 'str' || o.t === 'hex');

/** Characters that may stand in a name without `#xx`. */
const isRegular = (c: number): boolean =>
  c > 0x20 && c < 0x7f && !'()<>[]{}/%#'.includes(String.fromCharCode(c));

function nameText(v: string): string {
  let out = '/';
  // Characters up to U+00FF are one byte each (as the reader decodes names); others are UTF-8.
  const bytes: number[] = [];
  for (const ch of v) {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0xff) bytes.push(cp);
    else bytes.push(...new TextEncoder().encode(ch));
  }
  for (const c of bytes)
    out += isRegular(c) ? String.fromCharCode(c) : '#' + c.toString(16).padStart(2, '0');
  return out;
}

function numberText(n: number): string {
  if (!Number.isFinite(n)) throw new PdfError('bad-object', 'number: not finite');
  if (Number.isInteger(n)) {
    if (!Number.isSafeInteger(n))
      throw new PdfError('bad-object', 'number: integer beyond the safe range');
    return Object.is(n, -0) ? '0' : String(n);
  }
  // Fractions are below 2^53 here, so toFixed never switches to exponent notation.
  const s = n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' || s === '' ? '0' : s;
}

function literalText(bytes: Uint8Array): string {
  let out = '(';
  for (const c of bytes) {
    if (c === 0x28 || c === 0x29 || c === 0x5c) out += '\\' + String.fromCharCode(c);
    else if (c < 0x20 || c > 0x7e) out += '\\' + c.toString(8).padStart(3, '0');
    else out += String.fromCharCode(c);
  }
  return out + ')';
}

const HEX = '0123456789ABCDEF';
export function hexText(bytes: Uint8Array): string {
  let out = '';
  for (const c of bytes) out += HEX[c >> 4]! + HEX[c & 15]!;
  return out;
}

/** " at /Key[2]" for error messages; empty for the top level. */
const at = (path: string): string => (path === '' ? '' : ` at ${path}`);

/**
 * Writes objects as Latin-1 text and remembers where each `raw` with an id begins (offset from the start
 * of this writer's output).
 */
export class TextSink {
  private parts: (string | Uint8Array)[] = [];
  private length = 0;
  readonly marks = new Map<string, number>();

  push(text: string): void {
    this.parts.push(text);
    this.length += text.length;
  }

  /** Binary data (a stream's content) as it is, without a detour through a string. */
  pushBytes(data: Uint8Array): void {
    this.parts.push(data);
    this.length += data.length;
  }

  get size(): number {
    return this.length;
  }

  /** `path` (dict keys and array indices from the top) only labels errors. */
  write(o: PdfObject, path = ''): void {
    if (o === null) return this.push('null');
    if (typeof o === 'boolean') return this.push(o ? 'true' : 'false');
    if (typeof o === 'number') return this.push(numberText(o));
    if (Array.isArray(o)) {
      this.push('[');
      o.forEach((item, i) => {
        if (i > 0) this.push(' ');
        this.write(item, `${path}[${i}]`);
      });
      return this.push(']');
    }
    if ((o as { t: string }).t === 'stream')
      throw new PdfError(
        'bad-object',
        `write: a stream is only valid as a top-level indirect object${at(path)}`,
      );
    switch (o.t) {
      case 'name':
        return this.push(nameText(o.v));
      case 'str':
        return this.push(literalText(o.bytes));
      case 'hex':
        return this.push('<' + hexText(o.bytes) + '>');
      case 'ref':
        return this.push(`${o.num} ${o.gen} R`);
      case 'raw':
        for (let i = 0; i < o.text.length; i++)
          if (o.text.charCodeAt(i) > 0xff)
            throw new PdfError('bad-object', `raw: character outside Latin-1 at ${i}${at(path)}`);
        if (o.id !== undefined) this.marks.set(o.id, this.length);
        return this.push(o.text);
      case 'dict': {
        this.push('<<');
        for (const [k, v] of o.entries) {
          this.push(nameText(k) + ' ');
          this.write(v, `${path}/${k}`);
          this.push('\n');
        }
        return this.push('>>');
      }
      default:
        throw new PdfError('bad-object', `write: unknown object ${JSON.stringify(o)}${at(path)}`);
    }
  }

  /** Writes everything into `out` starting at `at` (room for `size` bytes); text must be Latin-1. */
  writeTo(out: Uint8Array, at: number): void {
    let pos = at;
    for (const part of this.parts) {
      if (typeof part === 'string') {
        for (let i = 0; i < part.length; i++) {
          const c = part.charCodeAt(i);
          if (c > 0xff)
            throw new PdfError('bad-object', `bytes: character outside Latin-1 at ${pos - at}`);
          out[pos++] = c;
        }
      } else {
        out.set(part, pos);
        pos += part.length;
      }
    }
  }

  /** The content as bytes; every text character is below 256 by construction. */
  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    this.writeTo(out, 0);
    return out;
  }
}
