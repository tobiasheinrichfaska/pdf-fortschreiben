/**
 * Embedded files as PDF/A-3 associated files: an `/EmbeddedFile` stream, a `/Filespec` with
 * `/AFRelationship`, an entry in the catalog's `/Names /EmbeddedFiles` tree and in the catalog's `/AF`.
 * **Add only:** a name can be used once; a later state is a new file with a new name, so every earlier
 * state stays readable in the newest revision, and `attachmentChanges` reports a file that a later revision
 * removed or changed.
 */
import { PdfFile, Update } from './document.ts';
import { PdfError, guard, guardAsync, unwrap, type Result } from './errors.ts';
import {
  decodeText,
  dict,
  isDict,
  isName,
  isRef,
  isStringLike,
  latin1,
  name,
  textString,
  type PdfDict,
  type PdfObject,
  type PdfRef,
} from './objects.ts';
import { isStream } from './parse.ts';
import type { PdfStream } from './objects.ts';
import { sha256Bytes, toHex } from './sha256.ts';

export type Relationship = 'Data' | 'Source' | 'Alternative' | 'Supplement' | 'Unspecified';

export interface Attachment {
  /** File name, e.g. `report-2026-11.json`. Printable ASCII only (it is also the tree key). */
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

const keyText = (o: PdfObject | undefined): string => {
  if (!isStringLike(o)) throw new PdfError('syntax', 'name tree key is not a string');
  return decodeText(o.bytes);
};

/** Byte-wise comparison (unsigned, shorter prefix first), the order a PDF name tree requires. */
function compareBytes(x: Uint8Array, y: Uint8Array): number {
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}
interface Pair {
  readonly key: string;
  /** The key's raw bytes (the PDF sort order is the byte order of these). */
  readonly keyBytes: Uint8Array;
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
  if (depth > MAX_DEPTH) throw new PdfError('syntax', 'name tree too deep');
  if (isRef(node)) {
    if (seen.has(node.num)) throw new PdfError('syntax', 'name tree loop');
    seen.add(node.num);
  }
  const d = resolve(node);
  if (!isDict(d as PdfObject)) throw new PdfError('syntax', 'name tree node is not a dictionary');
  const entries = (d as PdfDict).entries;
  const out: Pair[] = [];
  if (entries.has('Kids')) {
    if (!kids)
      throw new PdfError(
        'unsupported-name-tree',
        'attachFile: name tree with /Kids is not supported',
      );
    const k = resolve(entries.get('Kids'));
    if (!Array.isArray(k)) throw new PdfError('syntax', 'name tree /Kids is not an array');
    for (const kid of k) out.push(...treePairs(resolve, kid, kids, depth + 1, seen));
  }
  if (entries.has('Names')) {
    const arr = resolve(entries.get('Names'));
    if (!Array.isArray(arr)) throw new PdfError('syntax', 'name tree /Names is not an array');
    if (arr.length % 2 !== 0) throw new PdfError('syntax', 'name tree /Names has an odd length');
    for (let i = 0; i < arr.length; i += 2)
      out.push({
        key: keyText(arr[i]),
        keyBytes: (arr[i] as { bytes: Uint8Array }).bytes,
        keyObject: arr[i]!,
        value: arr[i + 1]!,
      });
  }
  return out;
}

/**
 * Adds an associated file in `update`. A name already in the file is refused (`name-exists`, nothing is
 * replaced). A failure after the first objects were added leaves them in `update`: discard that update.
 */
export function attachFile(file: PdfFile, update: Update, a: Attachment): Result<void> {
  return guard(() => attach(file, update, a));
}

function attach(file: PdfFile, update: Update, a: Attachment): void {
  if (!PRINTABLE.test(a.name))
    throw new PdfError('bad-name', 'attachFile: name must be printable ASCII');
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(a.mimeType))
    throw new PdfError('bad-mime', 'attachFile: bad MIME type');
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
  if (catalog === undefined) throw new PdfError('syntax', 'catalog');
  const cat = clone(catalog);

  const resolve = (o: PdfObject | undefined): PdfObject | PdfStream | undefined =>
    isRef(o) ? update.get(o) : o;
  const namesObj = resolve(cat.entries.get('Names'));
  if (namesObj !== undefined && !isDict(namesObj as PdfObject))
    throw new PdfError('syntax', '/Names is not a dictionary');
  const namesDict = clone((namesObj as PdfDict | undefined) ?? dict({}));
  const treeObj = resolve(namesDict.entries.get('EmbeddedFiles'));
  if (treeObj !== undefined && !isDict(treeObj as PdfObject))
    throw new PdfError('syntax', '/EmbeddedFiles is not a dictionary');
  const tree = clone((treeObj as PdfDict | undefined) ?? dict({}));
  const pairs: Pair[] =
    treeObj === undefined ? [] : treePairs(resolve, namesDict.entries.get('EmbeddedFiles'), false);
  if (pairs.some((p) => p.key === a.name))
    throw new PdfError('name-exists', `attachFile: "${a.name}" exists; use a new name`);
  const newKey = latin1(a.name);
  pairs.push({ key: a.name, keyBytes: newKey.bytes, keyObject: newKey, value: spec });
  pairs.sort((x, y) => compareBytes(x.keyBytes, y.keyBytes));
  // The root's /Limits is optional; the old one would be stale once a key is added.
  tree.entries.delete('Limits');
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
  if (oldAf !== undefined && !Array.isArray(oldAf))
    throw new PdfError(
      'bad-af',
      'attachFile: the catalog /AF is neither an array nor a reference to one',
    );
  const af: PdfObject[] = [];
  if (Array.isArray(oldAf)) for (const item of oldAf) af.push(item);
  af.push(spec);
  cat.entries.set('AF', af);
  update.set(root, cat);
}

export interface FoundAttachment {
  readonly name: string;
  readonly mimeType: string | undefined;
  readonly relationship: string | undefined;
  /**
   * Decoded bytes; with `unsupportedFilter` or `tooLarge` the raw stream bytes. **Read-only:** equal raw
   * streams share one array (also across attachments and revisions when a `StreamCache` is passed), so a
   * change here would show up in other entries.
   */
  readonly data: Readonly<Uint8Array>;
  readonly description?: string;
  /**
   * `'af'` for a file that is listed only in the catalog's `/AF` (not in the `/Names /EmbeddedFiles` tree);
   * absent for a name tree entry.
   */
  readonly source?: 'af';
  /**
   * Set when `data` is not decoded: a filter other than a single `/FlateDecode`, a `/FlateDecode` with a
   * predictor in `/DecodeParms`, or a stream that failed to inflate (then `inflateError` is set too).
   */
  readonly unsupportedFilter?: boolean;
  /** Set (with `unsupportedFilter`) when inflating failed (truncated, corrupt, trailing junk): the message. */
  readonly inflateError?: string;
  /**
   * Set when inflating would exceed `maxInflatedBytes`: reading stopped early, `data` is the raw (still
   * compressed) stream bytes and `filter` is set. `attachmentChanges` still compares such a file.
   */
  readonly tooLarge?: boolean;
  /** The stream's filter names joined by `,` (absent without a filter). */
  readonly filter?: string;
}

/** Default cap for one inflated attachment (decompression bomb guard). */
export const DEFAULT_MAX_INFLATED_BYTES = 256 * 1024 * 1024;

export interface ReadAttachmentsOptions {
  /**
   * Largest inflated size of one attachment (default 256 MiB); a larger one is returned raw with `tooLarge`.
   * A finite integer >= 0 or `Infinity`; anything else is `bad-options`.
   */
  readonly maxInflatedBytes?: number;
}

/** Inflates `data`; `undefined` as soon as the output would exceed `max` bytes (the stream is cancelled). */
async function inflate(data: Uint8Array, max: number): Promise<Uint8Array | undefined> {
  const reader = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'))
    .getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * Decoded stream bytes remembered across the revisions of one file, so each distinct stream is inflated and
 * hashed once. A hit needs byte-for-byte equal raw data (no hash collision can hide a change).
 */
export type StreamCache = Map<number, { raw: Uint8Array; data: Uint8Array; inflated: boolean }[]>;

const sameBytes = (x: Uint8Array, y: Uint8Array): boolean => compareBytes(x, y) === 0;

function lookup(raw: Uint8Array, inflated: boolean, cache: StreamCache | undefined) {
  return cache?.get(raw.length)?.find((e) => e.inflated === inflated && sameBytes(e.raw, raw));
}

function remember(
  cache: StreamCache | undefined,
  raw: Uint8Array,
  data: Uint8Array,
  inflated: boolean,
): void {
  if (cache === undefined) return;
  const bucket = cache.get(raw.length);
  if (bucket === undefined) cache.set(raw.length, [{ raw, data, inflated }]);
  else bucket.push({ raw, data, inflated });
}

/** The inflated bytes, or `undefined` when they exceed `max` (an over-size result is not cached). */
async function decoded(
  raw: Uint8Array,
  cache: StreamCache | undefined,
  max: number,
): Promise<Uint8Array | undefined> {
  const hit = lookup(raw, true, cache);
  if (hit !== undefined) return hit.data.length > max ? undefined : hit.data;
  const data = await inflate(raw, max);
  if (data !== undefined) remember(cache, raw, data, true);
  return data;
}

/** The first-seen copy of `raw`, so equal streams share one array (and one hash). */
function shared(raw: Uint8Array, cache: StreamCache | undefined): Uint8Array {
  const hit = lookup(raw, false, cache);
  if (hit !== undefined) return hit.data;
  remember(cache, raw, raw, false);
  return raw;
}

const nameOf = (o: PdfObject | undefined): string | undefined => (isName(o) ? o.v : undefined);

function filterLabel(filter: PdfObject): string {
  const list = Array.isArray(filter) ? filter : [filter];
  return list.map((f) => nameOf(f) ?? '?').join(',');
}

/** True when `/DecodeParms` (or `/DP`) asks for a predictor (> 1) or is not understood: not plain Flate. */
function hasPredictor(file: PdfFile, stream: PdfStream): boolean {
  const raw = stream.dict.entries.get('DecodeParms') ?? stream.dict.entries.get('DP');
  const parms = file.resolve(raw);
  if (parms === undefined || (parms as unknown) === null) return false;
  const list = Array.isArray(parms) ? parms : [parms];
  for (const p of list) {
    const d = file.resolve(p as PdfObject);
    if ((d as unknown) === null || d === undefined) continue;
    if (!isDict(d as PdfObject)) return true;
    const pred = file.resolve((d as PdfDict).entries.get('Predictor'));
    if (pred !== undefined && (pred as unknown) !== 1) return true;
  }
  return false;
}

/**
 * The embedded files of the newest revision (uncompressed or `/FlateDecode`), `/Kids` followed. A
 * `/FlateDecode` stream that inflates beyond `options.maxInflatedBytes` is not decoded: reading stops at the
 * cap and the entry carries the raw bytes with `tooLarge`.
 */
export function readAttachments(
  file: PdfFile,
  cache?: StreamCache,
  options: ReadAttachmentsOptions = {},
): Promise<Result<FoundAttachment[]>> {
  return guardAsync(() => readAll(file, cache, options));
}

async function readAll(
  file: PdfFile,
  cache: StreamCache | undefined,
  options: ReadAttachmentsOptions,
): Promise<FoundAttachment[]> {
  const max: unknown =
    options.maxInflatedBytes === undefined ? DEFAULT_MAX_INFLATED_BYTES : options.maxInflatedBytes;
  if (typeof max !== 'number' || !(max === Infinity || (Number.isInteger(max) && max >= 0)))
    throw new PdfError(
      'bad-options',
      'readAttachments: maxInflatedBytes must be a finite integer >= 0 or Infinity',
    );
  const names = file.dict(file.catalog.entries.get('Names'));
  const treeRef = names?.entries.get('EmbeddedFiles');
  const out: FoundAttachment[] = [];
  const afList = file.resolve(file.catalog.entries.get('AF'));
  const afItems: PdfObject[] = Array.isArray(afList) ? afList : [];
  const afNums = new Set<number>();
  for (const item of afItems) if (isRef(item)) afNums.add(item.num);
  const treeNums = new Set<number>();
  const entries: { key: string; value: PdfObject; source?: 'af' }[] = [];
  if (treeRef !== undefined)
    for (const pair of treePairs((o) => file.resolve(o), treeRef, true)) {
      if (isRef(pair.value)) treeNums.add(pair.value.num);
      entries.push({ key: pair.key, value: pair.value });
    }
  // Filespecs only in /AF (outside the name tree); /FileAttachment annotations are not read.
  for (const item of afItems) {
    if (isRef(item) && treeNums.has(item.num)) continue;
    const sd = file.dict(item);
    if (sd === undefined || !isDict(file.resolve(sd.entries.get('EF')) as PdfObject)) continue;
    const n = fileName(file, sd);
    if (n !== undefined) entries.push({ key: n, value: item, source: 'af' });
  }
  for (const pair of entries) {
    const key = pair.key;
    const spec = file.dict(pair.value);
    const efDict = spec === undefined ? undefined : file.dict(spec.entries.get('EF'));
    const efRef = efDict?.entries.get('F');
    const stream = file.resolve(efRef);
    if (spec === undefined || !isStream(stream)) continue;
    const filter = stream.dict.entries.get('Filter');
    let data: Uint8Array = stream.data;
    let tooLarge = false;
    let label: string | undefined;
    let unsupported = false;
    let inflateError: string | undefined;
    if (filter !== undefined) {
      label = filterLabel(filter);
      if (label === 'FlateDecode' && !hasPredictor(file, stream)) {
        try {
          const d = await decoded(stream.data, cache, max);
          if (d === undefined) tooLarge = true;
          else data = d;
        } catch (e) {
          unsupported = true;
          inflateError = e instanceof Error ? e.message || e.name : String(e);
        }
      } else unsupported = true;
    }
    if (unsupported || tooLarge || filter === undefined) data = shared(stream.data, cache);
    const desc = file.resolve(spec.entries.get('Desc'));
    const found: FoundAttachment = {
      name: key,
      mimeType: nameOf(stream.dict.entries.get('Subtype')),
      relationship: nameOf(spec.entries.get('AFRelationship')),
      data,
      ...(isStringLike(desc as PdfObject)
        ? { description: decodeText((desc as { bytes: Uint8Array }).bytes) }
        : {}),
      ...(pair.source === undefined ? {} : { source: pair.source }),
      ...(label === undefined ? {} : { filter: label }),
      ...(unsupported ? { unsupportedFilter: true } : {}),
      ...(inflateError === undefined ? {} : { inflateError }),
      ...(tooLarge ? { tooLarge: true } : {}),
    };
    extras.set(found, extraFields(file, spec, efDict, stream, pair.value, afNums, afList));
    out.push(found);
  }
  return out;
}

/** Fields that `attachmentChanges` compares besides the public ones (see `extraFields`). */
const extras = new WeakMap<FoundAttachment, string[]>();

/** A scalar PDF value as text for comparing; `\0none` when absent. */
function show(file: PdfFile, o: PdfObject | undefined): string {
  const v = file.resolve(o) as PdfObject | undefined;
  if (v === undefined || (v as unknown) === null) return '\0none';
  if (typeof v === 'number') return `n:${v}`;
  if (isStringLike(v)) return `s:${decodeText(v.bytes)}`;
  const nm = nameOf(v);
  if (nm !== undefined) return `/${nm}`;
  return `x:${typeof v === 'object' && v !== null && !Array.isArray(v) ? v.t : typeof v}`;
}

/** The file name of a Filespec: `/UF`, else `/F` (decoded). */
function fileName(file: PdfFile, spec: PdfDict): string | undefined {
  for (const k of ['UF', 'F']) {
    const v = file.resolve(spec.entries.get(k)) as PdfObject | undefined;
    if (isStringLike(v)) return decodeText(v.bytes);
  }
  return undefined;
}

/**
 * Everything else about an attachment that a later revision could change without touching its bytes:
 * Filespec `/Type`, `/F`, `/UF`; stream `/Type`; `/Params` `/Size` and `/ModDate`; a separate `/EF /UF`
 * stream (data hash, `/Subtype`, filter); membership of the Filespec in the catalog `/AF`; where it was read.
 */
function extraFields(
  file: PdfFile,
  spec: PdfDict,
  ef: PdfDict | undefined,
  stream: PdfStream,
  value: PdfObject,
  afNums: ReadonlySet<number>,
  afList: unknown,
): string[] {
  const params = file.dict(stream.dict.entries.get('Params'));
  const f = ef?.entries.get('F');
  const uf = ef?.entries.get('UF');
  let ufField = '\0none';
  if (uf !== undefined) {
    const same = isRef(uf) && isRef(f as PdfObject) && uf.num === (f as PdfRef).num;
    const us = file.resolve(uf);
    if (same) ufField = '\0same';
    else if (!isStream(us)) ufField = '\0nostream';
    else {
      const h = toHex(sha256Bytes(us.data));
      ufField = [
        h,
        show(file, us.dict.entries.get('Subtype')),
        show(file, us.dict.entries.get('Type')),
        us.dict.entries.has('Filter')
          ? filterLabel(file.resolve(us.dict.entries.get('Filter')) as PdfObject)
          : '\0none',
      ].join('|');
    }
  }
  const member = !Array.isArray(afList)
    ? 'noaf'
    : isRef(value)
      ? afNums.has(value.num)
        ? 'in'
        : 'out'
      : 'direct';
  return [
    show(file, spec.entries.get('Type')),
    show(file, spec.entries.get('F')),
    show(file, spec.entries.get('UF')),
    show(file, stream.dict.entries.get('Type')),
    show(file, params?.entries.get('Size')),
    show(file, params?.entries.get('ModDate')),
    ufField,
    member,
  ];
}

export interface AttachmentChange {
  readonly name: string;
  /**
   * `changed` also covers a name that occurs more than once in one revision's name tree (a second entry
   * could hide a change); it is reported for the first revision that has the duplicate.
   */
  readonly kind: 'removed' | 'changed';
  /** The first revision (index) in which the file is missing or different. */
  readonly revision: number;
}

/**
 * Files that an earlier revision had and a later one lost or changed (same name, other bytes). With
 * add-only writing this list is empty; anything in it means someone rewrote history after the fact.
 */
export function attachmentChanges(pdf: Uint8Array): Promise<Result<AttachmentChange[]>> {
  return guardAsync(() => changes(pdf));
}

async function changes(pdf: Uint8Array): Promise<AttachmentChange[]> {
  const file = unwrap(PdfFile.open(pdf));
  const seen = new Map<string, string>();
  const out: AttachmentChange[] = [];
  const reported = new Set<string>();
  const cache: StreamCache = new Map();
  for (let i = 0; i < file.revisions.length; i++) {
    const now = new Map<string, string>();
    for (const a of unwrap(
      await readAttachments(unwrap(PdfFile.open(file.revisionBytes(i))), cache),
    )) {
      if (now.has(a.name) && !reported.has(a.name)) {
        out.push({ name: a.name, kind: 'changed', revision: i });
        reported.add(a.name);
      }
      if (!now.has(a.name)) now.set(a.name, attachmentDigest(a));
    }
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

const dataHashes = new WeakMap<Uint8Array, Uint8Array>();

/**
 * Digest over data (via its SHA-256), MIME type, relationship, description, filter, source and the `extras`
 * fields (length-prefixed). A malformed name tree key makes `attachmentChanges` fail with `syntax` (fail loud).
 */
function attachmentDigest(a: FoundAttachment): string {
  const enc = new TextEncoder();
  let dataHash = dataHashes.get(a.data);
  if (dataHash === undefined) {
    dataHash = sha256Bytes(a.data);
    dataHashes.set(a.data, dataHash);
  }
  const fields: Uint8Array[] = [
    dataHash,
    enc.encode(a.mimeType ?? '\0none'),
    enc.encode(a.relationship ?? '\0none'),
    enc.encode(a.description ?? '\0none'),
    enc.encode(a.filter ?? '\0none'),
    enc.encode(a.source ?? 'tree'),
    ...(extras.get(a) ?? []).map((x) => enc.encode(x)),
  ];
  const buf = new Uint8Array(fields.reduce((n, f) => n + 4 + f.length, 0));
  let at = 0;
  for (const f of fields) {
    new DataView(buf.buffer).setUint32(at, f.length);
    buf.set(f, at + 4);
    at += 4 + f.length;
  }
  return toHex(sha256Bytes(buf));
}
