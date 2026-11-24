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
  type PdfRef,
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

/** The byte length of a DER element at the start of `bytes` (null if it is not one). */
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

/** The digest a document time stamp covers: SHA-256 over the two ranges. */
export function rangeDigest(bytes: Uint8Array, range: readonly number[]): Uint8Array {
  const [a, b, c, d] = range as [number, number, number, number];
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
  if (len === null || len !== token.length) throw new Error('stamp: answer is not one DER element');
  if (token.length > reserve) throw new RangeError(`token (${token.length} B) exceeds reserve`);
  const HEX = '0123456789ABCDEF';
  for (let i = 0; i < token.length; i++) {
    bytes[start + 1 + i * 2] = HEX.charCodeAt(token[i]! >> 4);
    bytes[start + 2 + i * 2] = HEX.charCodeAt(token[i]! & 15);
  }
  return bytes;
}

export interface FoundTimeStamp {
  /** Field name. */
  readonly field: string;
  /** Object number of the `/DocTimeStamp` dictionary. */
  readonly object: number;
  readonly byteRange: readonly number[];
  /** Index of the revision whose end the range reaches; null if it ends elsewhere (suspicious). */
  readonly revision: number | null;
  /** True if the range covers the whole file up to that revision's end except exactly the token string. */
  readonly rangeOk: boolean;
  readonly digest: Uint8Array;
  /** The token (padding removed). */
  readonly token: Uint8Array;
}

/**
 * Every document time stamp the file ever had: the signature fields of every revision's catalog (a field
 * removed later is still found). Checks the ranges and computes the digests; checking each token
 * (signature, chain, imprint = digest) is up to the caller's verifier.
 */
export function findDocTimeStamps(pdf: Uint8Array): FoundTimeStamp[] {
  const file = new PdfFile(pdf);
  const found = new Map<number, FoundTimeStamp>();
  for (let i = 0; i < file.revisions.length; i++) {
    const view = new PdfFile(file.revisionBytes(i));
    const form = view.dict(view.catalog.entries.get('AcroForm'));
    const fields = view.resolve(form?.entries.get('Fields'));
    if (!Array.isArray(fields)) continue;
    for (const f of fields) {
      const field = view.dict(f);
      const vRef = field?.entries.get('V');
      if (field === undefined || !isRef(vRef) || found.has(vRef.num)) continue;
      const v = view.dict(vRef);
      if (v === undefined || !isName(v.entries.get('SubFilter'), 'ETSI.RFC3161')) continue;
      found.set(vRef.num, describe(file, vRef, v, field));
    }
  }
  return [...found.values()].sort((a, b) => (a.byteRange[2] ?? 0) - (b.byteRange[2] ?? 0));
}

function describe(file: PdfFile, vRef: PdfRef, v: PdfDict, field: PdfDict): FoundTimeStamp {
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
    throw new PdfReadError('syntax', `time stamp ${vRef.num}`);
  const range = br as number[];
  const [a, b, c, d] = range as [number, number, number, number];
  const bytes = file.bytes;
  const endAt = c + d;
  // The range ends with the revision's `%%EOF` and its line end.
  const revision = file.revisions.findIndex(
    (r) => endAt >= r.end && endAt <= r.end + 2 && /^\r?\n?$/.test(latin1Text(bytes, r.end, endAt)),
  );
  const gap = latin1Text(bytes, b, c);
  const rangeOk =
    a === 0 &&
    c > b &&
    endAt <= bytes.length &&
    revision >= 0 &&
    /^<[0-9A-Fa-f]*>$/.test(gap) &&
    (gap.length - 2) / 2 === contents.bytes.length;
  const len = derLength(contents.bytes);
  const token = contents.bytes.subarray(0, len ?? 0);
  const t = field.entries.get('T');
  const fieldName =
    typeof t === 'object' && t !== null && !Array.isArray(t) && (t.t === 'hex' || t.t === 'str')
      ? decodeText(t.bytes)
      : '';
  return {
    field: fieldName,
    object: vRef.num,
    byteRange: range,
    revision: revision >= 0 ? revision : null,
    rangeOk,
    digest: endAt <= bytes.length ? rangeDigest(bytes, range) : new Uint8Array(0),
    token,
  };
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
