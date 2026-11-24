/**
 * Document time stamps (ISO 32000-2 12.8.5, PAdES `ETSI.RFC3161`): a signature field whose value is a
 * `/DocTimeStamp` dictionary; `/Contents` holds an RFC 3161 TimeStampToken over the SHA-256 of all bytes
 * of the file except the `/Contents` string itself (`/ByteRange`). Nobody's key is needed; the token comes
 * from a function the caller passes in (the library has no network and no trust store).
 */
import { PdfFile, Update, writeUpdate } from './document.ts';
import {
  dict,
  isDict,
  isName,
  isRef,
  name,
  raw,
  textString,
  type PdfDict,
  type PdfObject,
} from './objects.ts';
import { PdfReadError, latin1Text } from './parse.ts';
import { sha256Bytes } from './sha256.ts';

/** Gets a DER TimeStampToken (CMS ContentInfo) for a SHA-256 digest, e.g. through a relay. */
export type Stamper = (sha256: Uint8Array) => Promise<Uint8Array>;

export interface StampOptions {
  /** Bytes reserved for the token (default 16384; FreeTSA-like tokens with chain are about 5–8 KB). */
  readonly reserve?: number;
  /** Field name; default `Zeitstempel <n>`. */
  readonly fieldName?: string;
  /** Page (index) the invisible widget sits on; default 0. */
  readonly page?: number;
}

const BYTE_RANGE_WIDTH = 36; // "[0 " + 3 × 10 digits + spaces + "]"

const clone = (d: PdfDict): PdfDict => ({ t: 'dict', entries: new Map(d.entries) });

function dictOf(u: Update, o: PdfObject | undefined): PdfDict | undefined {
  const v = isRef(o) ? u.get(o) : o;
  return isDict(v as PdfObject) ? (v as PdfDict) : undefined;
}

function arrayOf(u: Update, o: PdfObject | undefined): PdfObject[] {
  const v = isRef(o) ? u.get(o) : o;
  return Array.isArray(v) ? [...v] : [];
}

/**
 * The byte length (header and content) of the element at the start of `bytes`, read from its definite
 * length (up to 4 length bytes); null if there is none (indefinite length, too short). It does not check
 * that the length is minimal DER or that the content is well formed.
 */
export function derLength(bytes: Uint8Array): number | null {
  if (bytes.length < 2) return null;
  const first = bytes[1]!;
  if (first < 0x80) return 2 + first;
  const n = first & 0x7f;
  if (n === 0 || n > 4 || bytes.length < 2 + n) return null;
  let len = 0;
  for (let i = 0; i < n; i++) len = len * 256 + bytes[2 + i]!;
  return 2 + n + len;
}

/** A byte range of four non-negative integers: a = 0, b <= c, c + d <= length. */
function validRange(length: number, range: readonly number[]): boolean {
  if (range.length !== 4 || !range.every((x) => Number.isSafeInteger(x) && x >= 0)) return false;
  const [a, b, c, d] = range as [number, number, number, number];
  return a === 0 && b <= c && c + d <= length;
}

/** The digest a document time stamp covers: SHA-256 over the two ranges. */
export function rangeDigest(bytes: Uint8Array, range: readonly number[]): Uint8Array {
  const [a, b, c, d] = range as [number, number, number, number];
  if (!validRange(bytes.length, range)) return new Uint8Array(0);
  const joined = new Uint8Array(b + d);
  joined.set(bytes.subarray(a, a + b), 0);
  joined.set(bytes.subarray(c, c + d), b);
  return sha256Bytes(joined);
}

/**
 * Appends one revision with a document time stamp over everything before it (and over the new revision
 * itself except the token). Returns the new file.
 */
export async function appendDocTimeStamp(
  pdf: Uint8Array,
  stamp: Stamper,
  options: StampOptions = {},
): Promise<Uint8Array> {
  const reserve = options.reserve ?? 16384;
  if (!Number.isInteger(reserve) || reserve < 1024 || reserve > 65536)
    throw new RangeError('reserve must be 1024..65536');
  const file = new PdfFile(pdf);
  const u = new Update(file);
  const pages = file.pages();
  const pageRef = pages[options.page ?? 0];
  if (pageRef === undefined) throw new RangeError('no such page');

  const catalog = clone(dictOf(u, file.rootRef)!);
  const form = clone(dictOf(u, catalog.entries.get('AcroForm')) ?? dict({}));
  const fields = arrayOf(u, form.entries.get('Fields'));
  const count = fields.filter((f) => isName(dictOf(u, f)?.entries.get('FT'), 'Sig')).length;

  const sig = u.add(
    dict({
      Type: name('DocTimeStamp'),
      Filter: name('Adobe.PPKLite'),
      SubFilter: name('ETSI.RFC3161'),
      ByteRange: raw('[' + ' '.repeat(BYTE_RANGE_WIDTH - 2) + ']', 'byterange'),
      Contents: raw('<' + '0'.repeat(reserve * 2) + '>', 'contents'),
    }),
  );
  // PDF/A wants an appearance for every widget, also an invisible one.
  const ap = u.add({
    t: 'stream',
    dict: dict({ Type: name('XObject'), Subtype: name('Form'), BBox: [0, 0, 0, 0] }),
    data: new Uint8Array(0),
  });
  const widget = u.add(
    dict({
      Type: name('Annot'),
      Subtype: name('Widget'),
      FT: name('Sig'),
      T: textString(options.fieldName ?? `Zeitstempel ${count + 1}`),
      V: sig,
      Rect: [0, 0, 0, 0],
      F: 132, // Print + Locked
      P: pageRef,
      AP: dict({ N: ap }),
    }),
  );
  const page = clone(dictOf(u, pageRef)!);
  page.entries.set('Annots', [...arrayOf(u, page.entries.get('Annots')), widget]);
  u.set(pageRef, page);
  form.entries.set('Fields', [...fields, widget]);
  form.entries.set('SigFlags', 3);
  catalog.entries.set('AcroForm', form);
  u.set(file.rootRef, catalog);

  const { bytes, marks } = writeUpdate(file, u);
  const start = marks.get('contents')!;
  const end = start + reserve * 2 + 2;
  const range = [0, start, end, bytes.length - end];
  const rangeText = `[${range.join(' ')}]`.padEnd(BYTE_RANGE_WIDTH, ' ');
  if (rangeText.length !== BYTE_RANGE_WIDTH) throw new RangeError('file too large for /ByteRange');
  const brAt = marks.get('byterange')!;
  for (let i = 0; i < rangeText.length; i++) bytes[brAt + i] = rangeText.charCodeAt(i);

  const token = await stamp(rangeDigest(bytes, range));
  const len = derLength(token);
  if (token[0] !== 0x30 || len === null || len !== token.length)
    throw new Error(
      'stamp: answer is not one DER SEQUENCE (DER is required, BER indefinite length is not accepted)',
    );
  if (token.length > reserve) throw new RangeError(`token (${token.length} B) exceeds reserve`);
  const HEX = '0123456789ABCDEF';
  for (let i = 0; i < token.length; i++) {
    bytes[start + 1 + i * 2] = HEX.charCodeAt(token[i]! >> 4);
    bytes[start + 2 + i * 2] = HEX.charCodeAt(token[i]! & 15);
  }
  return bytes;
}

export interface FoundTimeStamp {
  /** Field name (partial names of `/Kids` parents joined by a dot). */
  readonly field: string;
  /** Object number of the `/DocTimeStamp` dictionary; 0 if `/V` is a direct dictionary. */
  readonly object: number;
  /** Empty if the dictionary is malformed (see `error`). */
  readonly byteRange: readonly number[];
  /** Index of the revision whose end the range reaches; null if it ends elsewhere (suspicious). */
  readonly revision: number | null;
  /**
   * True if the range covers the whole file up to that revision's end except exactly this stamp's own
   * `/Contents` string (same place, same hex).
   */
  readonly rangeOk: boolean;
  /** Computed on first access (hashing is the costly part of listing a big file). */
  readonly digest: Uint8Array;
  /** The token (padding removed); empty if `tokenOk` is false. */
  readonly token: Uint8Array;
  /** True if `/Contents` starts with one complete DER SEQUENCE followed only by zero padding. */
  readonly tokenOk: boolean;
  /** Set if this stamp dictionary could not be read (then `rangeOk` and `tokenOk` are false). */
  readonly error?: string;
}

/**
 * Every document time stamp the file ever had: the signature fields of every revision's catalog (a field
 * removed later is still found; `/Kids` are followed). Checks the ranges and computes the digests;
 * checking each token (signature, chain, imprint = digest) is up to the caller's verifier. A malformed
 * stamp dictionary yields an entry with `rangeOk: false` and an `error`, it does not abort the listing.
 */
export function findDocTimeStamps(pdf: Uint8Array): FoundTimeStamp[] {
  const file = new PdfFile(pdf);
  const found = new Map<string, FoundTimeStamp>();
  for (let i = 0; i < file.revisions.length; i++) {
    let view: PdfFile;
    let fields: PdfObject | undefined;
    try {
      view = new PdfFile(file.revisionBytes(i));
      const form = view.dict(view.catalog.entries.get('AcroForm'));
      fields = view.resolve(form?.entries.get('Fields')) as PdfObject | undefined;
    } catch {
      continue;
    }
    if (!Array.isArray(fields)) continue;
    const seen = new Set<number>();
    const walk = (f: PdfObject, prefix: string, depth: number): void => {
      if (depth > 32) return;
      if (isRef(f)) {
        if (seen.has(f.num)) return;
        seen.add(f.num);
      }
      try {
        const field = view.dict(f);
        if (field === undefined) return;
        const t = field.entries.get('T');
        const own = isTextObject(t) ? decodeText(t.bytes) : '';
        const fieldName = prefix === '' ? own : own === '' ? prefix : `${prefix}.${own}`;
        const kids = view.resolve(field.entries.get('Kids'));
        if (Array.isArray(kids)) for (const k of kids) walk(k, fieldName, depth + 1);
        const vObj = field.entries.get('V');
        const v = view.dict(vObj);
        if (v === undefined || !isName(v.entries.get('SubFilter'), 'ETSI.RFC3161')) return;
        const num = isRef(vObj) ? vObj.num : 0;
        // The byte range identifies a stamp (an object number can be reused by a later revision, a direct
        // /V copy has none): look it up before the expensive describe. An indirect entry beats a direct one.
        const br = v.entries.get('ByteRange');
        const rangeKey =
          Array.isArray(br) && br.length === 4 && br.every((n) => typeof n === 'number')
            ? `range:${br.join(' ')}`
            : undefined;
        const known = rangeKey === undefined ? undefined : found.get(rangeKey);
        if (known !== undefined && (num === 0 || known.object !== 0)) return;
        let entry: FoundTimeStamp;
        try {
          entry = describe(file, num, v, fieldName);
        } catch (e) {
          entry = broken(num, fieldName, e);
        }
        const key =
          entry.error === undefined && rangeKey !== undefined
            ? rangeKey
            : `${num}:bad ${entry.error ?? entry.byteRange.join(' ')}`;
        if (!found.has(key) || (known !== undefined && key === rangeKey)) found.set(key, entry);
      } catch (e) {
        const key = `field:${isRef(f) ? f.num : 0}:${String(e)}`;
        if (!found.has(key)) found.set(key, broken(0, prefix, e));
      }
    };
    for (const f of fields) walk(f, '', 0);
  }
  const at = (x: FoundTimeStamp): number => x.byteRange[2] ?? Number.MAX_SAFE_INTEGER;
  return [...found.values()].sort((a, b) => at(a) - at(b));
}

function broken(num: number, field: string, e: unknown): FoundTimeStamp {
  return {
    field,
    object: num,
    byteRange: [],
    revision: null,
    rangeOk: false,
    digest: new Uint8Array(0),
    token: new Uint8Array(0),
    tokenOk: false,
    error: e instanceof Error ? e.message : String(e),
  };
}

const isTextObject = (t: unknown): t is { t: 'hex' | 'str'; bytes: Uint8Array } =>
  typeof t === 'object' &&
  t !== null &&
  !Array.isArray(t) &&
  ((t as { t?: string }).t === 'hex' || (t as { t?: string }).t === 'str');

/** True if the bytes in `[b, c)` are the hex string `contents`, inside the body of object `num`. */
function isOwnContents(bytes: Uint8Array, num: number, b: number, c: number, contents: Uint8Array) {
  const gap = latin1Text(bytes, b, c);
  const m = /^<([0-9A-Fa-f\s]*)>$/.exec(gap); // whitespace inside a hex string is allowed
  if (m === null) return false;
  const hex = m[1]!.replace(/\s+/g, '');
  if (hex.length !== contents.length * 2) return false;
  for (let i = 0; i < contents.length; i++)
    if (parseInt(hex.slice(i * 2, i * 2 + 2), 16) !== contents[i]) return false;
  if (num === 0) return true; // direct dictionary: no object body to locate
  // The nearest `N G obj` before the string must be this object's, with no `endobj` in between. The
  // dictionary may be any size, so the window grows until a header is found.
  for (let size = 4096; ; size *= 4) {
    const from = Math.max(0, b - size);
    const before = latin1Text(bytes, from, b);
    let last: RegExpExecArray | null = null;
    for (const h of before.matchAll(/(\d+)\s+(\d+)\s+obj\b/g)) last = h;
    if (last !== null && (last.index > 0 || from === 0))
      return Number(last[1]) === num && !before.slice(last.index).includes('endobj');
    if (from === 0) return false;
  }
}

function describe(file: PdfFile, num: number, v: PdfDict, field: string): FoundTimeStamp {
  const br = v.entries.get('ByteRange');
  const contents = v.entries.get('Contents');
  if (
    !Array.isArray(br) ||
    br.length !== 4 ||
    !br.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0) ||
    typeof contents !== 'object' ||
    contents === null ||
    Array.isArray(contents) ||
    contents.t !== 'hex'
  )
    throw new PdfReadError('syntax', `time stamp ${num}: /ByteRange or /Contents malformed`);
  const range = br as number[];
  const [, b, c, d] = range as [number, number, number, number];
  const bytes = file.bytes;
  const endAt = c + d;
  // The range ends with the revision's `%%EOF` and its line end.
  const revision = file.revisions.findIndex(
    (r) => endAt >= r.end && endAt <= r.end + 2 && /^\r?\n?$/.test(latin1Text(bytes, r.end, endAt)),
  );
  const rangeOk =
    validRange(bytes.length, range) && // a = 0, b <= c, c + d <= length (an empty gap fails isOwnContents)
    revision >= 0 &&
    isOwnContents(bytes, num, b, c, contents.bytes);
  const len = derLength(contents.bytes);
  const tokenOk =
    contents.bytes[0] === 0x30 &&
    len !== null &&
    len <= contents.bytes.length &&
    contents.bytes.subarray(len).every((x) => x === 0);
  // SHA-256 is pure JS (a few MB/s per stamp over a big file): compute it on first access, once.
  let digest: Uint8Array | undefined;
  const found: FoundTimeStamp = {
    field,
    object: num,
    byteRange: range,
    revision: revision >= 0 ? revision : null,
    rangeOk,
    get digest(): Uint8Array {
      return (digest ??= rangeDigest(bytes, range));
    },
    token: tokenOk ? contents.bytes.subarray(0, len!) : new Uint8Array(0),
    tokenOk,
  };
  return found;
}

function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    let s = '';
    for (let i = 2; i + 1 < bytes.length; i += 2)
      s += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
    return s;
  }
  return String.fromCharCode(...bytes);
}
