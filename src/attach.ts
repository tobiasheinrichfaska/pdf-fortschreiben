/**
 * Embedded files as PDF/A-3 associated files: an `/EmbeddedFile` stream, a `/Filespec` with
 * `/AFRelationship`, an entry in the catalog's `/Names /EmbeddedFiles` tree and in the catalog's `/AF`.
 * **Add only:** a name can be used once; a later state is a new file with a new name, so every earlier
 * state stays readable in the newest revision, and `attachmentChanges` reports a file that a later revision
 * removed or changed.
 */
import { PdfFile, Update } from './document.ts';
import {
  dict,
  isDict,
  isRef,
  isStringLike,
  latin1,
  name,
  textString,
  type PdfDict,
  type PdfObject,
  type PdfRef,
} from './objects.ts';
import { PdfReadError, isStream } from './parse.ts';
import type { PdfStream } from './objects.ts';
import { sha256Bytes } from './sha256.ts';

export type Relationship = 'Data' | 'Source' | 'Alternative' | 'Supplement' | 'Unspecified';

export interface Attachment {
  /** File name, e.g. `zeiterfassung-2026-11.json`. Printable ASCII only (it is also the tree key). */
  readonly name: string;
  readonly data: Uint8Array;
  /** MIME type, e.g. `application/json`. */
  readonly mimeType: string;
  readonly description?: string;
  /** PDF date of the file's last change, e.g. `D:20261124150000Z`; the library reads no clock. */
  readonly modified?: string;
  readonly relationship?: Relationship;
}

const PRINTABLE = /^[\x20-\x7e]{1,200}$/;

const clone = (d: PdfDict): PdfDict => ({ t: 'dict', entries: new Map(d.entries) });

function getDict(u: Update, o: PdfObject | undefined): PdfDict | undefined {
  const v = isRef(o) ? u.get(o) : o;
  return isStream(v) ? undefined : isDict(v as PdfObject) ? (v as PdfDict) : undefined;
}

/** A PDF text string as text: UTF-16BE with byte order mark, else PDFDocEncoding (taken as Latin-1). */
function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    if (bytes.length % 2 !== 0)
      throw new PdfReadError('syntax', 'name tree key: odd UTF-16 length');
    let out = '';
    for (let i = 2; i < bytes.length; i += 2)
      out += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
    return out;
  }
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

const keyText = (o: PdfObject | undefined): string => {
  if (!isStringLike(o)) throw new PdfReadError('syntax', 'name tree key is not a string');
  return decodeText(o.bytes);
};

interface Pair {
  readonly key: string;
  /** The key object as the file has it (kept byte for byte when rewriting). */
  readonly keyObject: PdfObject;
  readonly value: PdfObject;
}

const MAX_DEPTH = 32;

/**
 * The key/value pairs of a name tree node. `/Names` may be indirect. `/Kids` are followed (depth limit,
 * cycle-safe) when `kids` is true; otherwise a node with `/Kids` is refused.
 */
function treePairs(
  resolve: (o: PdfObject | undefined) => PdfObject | PdfStream | undefined,
  node: PdfObject | undefined,
  kids: boolean,
  depth = 0,
  seen = new Set<number>(),
): Pair[] {
  if (depth > MAX_DEPTH) throw new PdfReadError('syntax', 'name tree too deep');
  if (isRef(node)) {
    if (seen.has(node.num)) throw new PdfReadError('syntax', 'name tree loop');
    seen.add(node.num);
  }
  const d = resolve(node);
  if (!isDict(d as PdfObject))
    throw new PdfReadError('syntax', 'name tree node is not a dictionary');
  const entries = (d as PdfDict).entries;
  const out: Pair[] = [];
  if (entries.has('Kids')) {
    if (!kids) throw new Error('attachFile: name tree with /Kids is not supported');
    const k = resolve(entries.get('Kids'));
    if (!Array.isArray(k)) throw new PdfReadError('syntax', 'name tree /Kids is not an array');
    for (const kid of k) out.push(...treePairs(resolve, kid, kids, depth + 1, seen));
  }
  if (entries.has('Names')) {
    const arr = resolve(entries.get('Names'));
    if (!Array.isArray(arr)) throw new PdfReadError('syntax', 'name tree /Names is not an array');
    if (arr.length % 2 !== 0)
      throw new PdfReadError('syntax', 'name tree /Names has an odd length');
    for (let i = 0; i < arr.length; i += 2)
      out.push({ key: keyText(arr[i]), keyObject: arr[i]!, value: arr[i + 1]! });
  }
  return out;
}

/** Adds an associated file in `update`. A name already in the file is refused (nothing is replaced). */
export function attachFile(file: PdfFile, update: Update, a: Attachment): void {
  if (!PRINTABLE.test(a.name)) throw new Error('attachFile: name must be printable ASCII');
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(a.mimeType)) throw new Error('attachFile: bad MIME type');
  const params = dict({
    Size: a.data.length,
    ModDate: a.modified === undefined ? undefined : latin1(a.modified),
  });
  const ef = update.add({
    t: 'stream',
    dict: dict({ Type: name('EmbeddedFile'), Subtype: name(a.mimeType), Params: params }),
    data: a.data,
  });
  const spec = update.add(
    dict({
      Type: name('Filespec'),
      F: latin1(a.name),
      UF: textString(a.name),
      Desc: a.description === undefined ? undefined : textString(a.description),
      AFRelationship: name(a.relationship ?? 'Data'),
      EF: dict({ F: ef, UF: ef }),
    }),
  );

  const root = file.rootRef;
  const catalog = getDict(update, root);
  if (catalog === undefined) throw new PdfReadError('syntax', 'catalog');
  const cat = clone(catalog);

  const resolve = (o: PdfObject | undefined): PdfObject | PdfStream | undefined =>
    isRef(o) ? update.get(o) : o;
  const namesObj = resolve(cat.entries.get('Names'));
  if (namesObj !== undefined && !isDict(namesObj as PdfObject))
    throw new PdfReadError('syntax', '/Names is not a dictionary');
  const namesDict = clone((namesObj as PdfDict | undefined) ?? dict({}));
  const treeObj = resolve(namesDict.entries.get('EmbeddedFiles'));
  if (treeObj !== undefined && !isDict(treeObj as PdfObject))
    throw new PdfReadError('syntax', '/EmbeddedFiles is not a dictionary');
  const tree = clone((treeObj as PdfDict | undefined) ?? dict({}));
  const pairs: Pair[] =
    treeObj === undefined ? [] : treePairs(resolve, namesDict.entries.get('EmbeddedFiles'), false);
  if (pairs.some((p) => p.key === a.name))
    throw new Error(`attachFile: "${a.name}" exists; use a new name`);
  pairs.push({ key: a.name, keyObject: latin1(a.name), value: spec });
  pairs.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  tree.entries.set(
    'Names',
    pairs.flatMap((p) => [p.keyObject, p.value]),
  );
  namesDict.entries.set('EmbeddedFiles', tree);
  cat.entries.set('Names', namesDict);

  // /AF: keep every earlier file, add the new one.
  const oldAf = isRef(cat.entries.get('AF'))
    ? update.get(cat.entries.get('AF') as PdfRef)
    : cat.entries.get('AF');
  const af: PdfObject[] = [];
  if (Array.isArray(oldAf))
    for (const item of oldAf) {
      af.push(item);
    }
  af.push(spec);
  cat.entries.set('AF', af);
  update.set(root, cat);
}

export interface FoundAttachment {
  readonly name: string;
  readonly mimeType: string | undefined;
  readonly relationship: string | undefined;
  /** Decoded bytes; with `unsupportedFilter` the raw stream bytes. */
  readonly data: Uint8Array;
  readonly description?: string;
  /** Set when the stream has a filter other than a single `/FlateDecode`: `data` is then not decoded. */
  readonly unsupportedFilter?: boolean;
  /** The stream's filter names joined by `,` (absent without a filter). */
  readonly filter?: string;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const nameOf = (o: PdfObject | undefined): string | undefined =>
  typeof o === 'object' && o !== null && !Array.isArray(o) && o.t === 'name' ? o.v : undefined;

function filterLabel(filter: PdfObject): string {
  const list = Array.isArray(filter) ? filter : [filter];
  return list.map((f) => nameOf(f) ?? '?').join(',');
}

/** The embedded files of the newest revision (uncompressed or `/FlateDecode`), `/Kids` followed. */
export async function readAttachments(file: PdfFile): Promise<FoundAttachment[]> {
  const names = file.dict(file.catalog.entries.get('Names'));
  const treeRef = names?.entries.get('EmbeddedFiles');
  const out: FoundAttachment[] = [];
  if (treeRef === undefined) return out;
  for (const pair of treePairs((o) => file.resolve(o), treeRef, true)) {
    const key = pair.key;
    const spec = file.dict(pair.value);
    const efRef =
      spec === undefined ? undefined : file.dict(spec.entries.get('EF'))?.entries.get('F');
    const stream = file.resolve(efRef);
    if (spec === undefined || !isStream(stream)) continue;
    const filter = stream.dict.entries.get('Filter');
    let data = stream.data;
    let label: string | undefined;
    let unsupported = false;
    if (filter !== undefined) {
      label = filterLabel(filter);
      if (label === 'FlateDecode') data = await inflate(data);
      else unsupported = true;
    }
    const desc = file.resolve(spec.entries.get('Desc'));
    out.push({
      name: key,
      mimeType: nameOf(stream.dict.entries.get('Subtype')),
      relationship: nameOf(spec.entries.get('AFRelationship')),
      data,
      ...(isStringLike(desc as PdfObject)
        ? { description: decodeText((desc as { bytes: Uint8Array }).bytes) }
        : {}),
      ...(label === undefined ? {} : { filter: label }),
      ...(unsupported ? { unsupportedFilter: true } : {}),
    });
  }
  return out;
}

export interface AttachmentChange {
  readonly name: string;
  readonly kind: 'removed' | 'changed';
  /** The first revision (index) in which the file is missing or different. */
  readonly revision: number;
}

/**
 * Files that an earlier revision had and a later one lost or changed (same name, other bytes). With
 * add-only writing this list is empty; anything in it means someone rewrote history after the fact.
 */
export async function attachmentChanges(pdf: Uint8Array): Promise<AttachmentChange[]> {
  const file = new PdfFile(pdf);
  const seen = new Map<string, string>();
  const out: AttachmentChange[] = [];
  const reported = new Set<string>();
  for (let i = 0; i < file.revisions.length; i++) {
    const now = new Map<string, string>();
    for (const a of await readAttachments(new PdfFile(file.revisionBytes(i))))
      now.set(a.name, attachmentDigest(a));
    for (const [n, digest] of seen) {
      if (reported.has(n)) continue;
      const d = now.get(n);
      if (d === undefined || d !== digest) {
        out.push({ name: n, kind: d === undefined ? 'removed' : 'changed', revision: i });
        reported.add(n);
      }
    }
    for (const [n, d] of now) if (!seen.has(n)) seen.set(n, d);
  }
  return out;
}

/** Digest over data, MIME type, relationship, description and filter (length-prefixed fields). */
function attachmentDigest(a: FoundAttachment): string {
  const enc = new TextEncoder();
  const fields: Uint8Array[] = [
    a.data,
    enc.encode(a.mimeType ?? '\0none'),
    enc.encode(a.relationship ?? '\0none'),
    enc.encode(a.description ?? '\0none'),
    enc.encode(a.filter ?? '\0none'),
  ];
  const buf = new Uint8Array(fields.reduce((n, f) => n + 4 + f.length, 0));
  let at = 0;
  for (const f of fields) {
    new DataView(buf.buffer).setUint32(at, f.length);
    buf.set(f, at + 4);
    at += 4 + f.length;
  }
  return Array.from(sha256Bytes(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}
