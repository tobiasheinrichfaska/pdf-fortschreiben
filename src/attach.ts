/**
 * Embedded files as PDF/A-3 associated files: an `/EmbeddedFile` stream, a `/Filespec` with
 * `/AFRelationship`, an entry in the catalog's `/Names /EmbeddedFiles` tree and in the catalog's `/AF`.
 * **Add only:** a name can be used once; a later state is a new file with a new name, so every earlier
 * state stays readable in the newest revision, and `attachmentChanges` reports a file that a later revision
 * removed or changed.
 */
import { PdfFile, Update } from './document.ts';
import {
  TextSink,
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
import { PdfReadError, isStream, latin1Text } from './parse.ts';
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

const keyText = (o: PdfObject | undefined): string | undefined =>
  isStringLike(o) ? String.fromCharCode(...o.bytes) : undefined;

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

  const namesDict = clone(getDict(update, cat.entries.get('Names')) ?? dict({}));
  const tree = clone(getDict(update, namesDict.entries.get('EmbeddedFiles')) ?? dict({}));
  if (tree.entries.has('Kids'))
    throw new Error('attachFile: name tree with /Kids is not supported');
  const oldPairs = tree.entries.get('Names');
  const pairs: { key: string; value: PdfObject }[] = [];
  if (Array.isArray(oldPairs))
    for (let i = 0; i + 1 < oldPairs.length; i += 2) {
      const key = keyText(oldPairs[i]);
      if (key === a.name) throw new Error(`attachFile: "${a.name}" exists; use a new name`);
      if (key !== undefined) pairs.push({ key, value: oldPairs[i + 1]! });
    }
  pairs.push({ key: a.name, value: spec });
  pairs.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  tree.entries.set(
    'Names',
    pairs.flatMap((p) => [latin1(p.key), p.value]),
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
  readonly data: Uint8Array;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The embedded files of the newest revision (uncompressed or `/FlateDecode`). */
export async function readAttachments(file: PdfFile): Promise<FoundAttachment[]> {
  const names = file.dict(file.catalog.entries.get('Names'));
  const tree = names === undefined ? undefined : file.dict(names.entries.get('EmbeddedFiles'));
  const pairs = tree?.entries.get('Names');
  const out: FoundAttachment[] = [];
  if (!Array.isArray(pairs)) return out;
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const key = keyText(pairs[i]);
    const spec = file.dict(pairs[i + 1]);
    const efRef =
      spec === undefined ? undefined : file.dict(spec.entries.get('EF'))?.entries.get('F');
    const stream = file.resolve(efRef);
    if (key === undefined || spec === undefined || !isStream(stream)) continue;
    const filter = stream.dict.entries.get('Filter');
    let data = stream.data;
    if (filter !== undefined) {
      const one = Array.isArray(filter) && filter.length === 1 ? filter[0] : filter;
      if (
        typeof one === 'object' &&
        one !== null &&
        !Array.isArray(one) &&
        one.t === 'name' &&
        one.v === 'FlateDecode'
      )
        data = await inflate(data);
      else continue;
    }
    const sub = stream.dict.entries.get('Subtype');
    const rel = spec.entries.get('AFRelationship');
    out.push({
      name: key,
      mimeType:
        typeof sub === 'object' && sub !== null && !Array.isArray(sub) && sub.t === 'name'
          ? sub.v
          : undefined,
      relationship:
        typeof rel === 'object' && rel !== null && !Array.isArray(rel) && rel.t === 'name'
          ? rel.v
          : undefined,
      data,
    });
  }
  return out;
}

export interface AttachmentChange {
  readonly name: string;
  /**
   * `removed`: the name is gone; `changed`: its identity differs (names `/F` `/UF`, the bytes and
   * dictionary of `/EF /F` and `/EF /UF`, MIME type, `/AFRelationship`, membership in the catalog's
   * `/AF`); `duplicate`: the name stands more than once in the name tree.
   */
  readonly kind: 'removed' | 'changed' | 'duplicate';
  /** The first revision (index) in which the file is missing, different or doubled. */
  readonly revision: number;
}

/** A stream as text: its dictionary entries that shape the content, and the SHA-256 of its bytes. */
function streamIdentity(file: PdfFile, o: PdfObject | undefined): string {
  if (o === undefined) return '-';
  const s = file.resolve(o);
  if (!isStream(s)) return 'not-a-stream';
  const sink = new TextSink();
  for (const k of ['Type', 'Subtype', 'Filter', 'DecodeParms', 'Params']) {
    sink.push(`/${k} `);
    const v = s.dict.entries.get(k);
    if (v !== undefined) sink.write(isRef(v) ? (file.resolve(v) as PdfObject) : v);
    sink.push('|');
  }
  return latin1Text(sink.bytes(), 0, sink.size) + hexDigest(s.data);
}

const bytesHex = (o: PdfObject | undefined): string =>
  isStringLike(o) ? Array.from(o.bytes, (b) => b.toString(16).padStart(2, '0')).join('') : '-';

/** For every key of the `/EmbeddedFiles` name tree: the identity of each entry under that key. */
function identities(file: PdfFile): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const names = file.dict(file.catalog.entries.get('Names'));
  const tree = names === undefined ? undefined : file.dict(names.entries.get('EmbeddedFiles'));
  const pairs = file.resolve(tree?.entries.get('Names'));
  if (!Array.isArray(pairs)) return out;
  const afList = file.resolve(file.catalog.entries.get('AF'));
  const inAf = new Set<number>();
  if (Array.isArray(afList)) for (const item of afList) if (isRef(item)) inAf.add(item.num);
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const key = keyText(pairs[i]);
    if (key === undefined) continue;
    const value = pairs[i + 1]!;
    let id: string;
    try {
      const spec = file.dict(value);
      if (spec === undefined) id = 'unreadable';
      else {
        const ef = file.dict(spec.entries.get('EF'));
        const rel = spec.entries.get('AFRelationship');
        id = [
          'F=' + bytesHex(file.resolve(spec.entries.get('F')) as PdfObject),
          'UF=' + bytesHex(file.resolve(spec.entries.get('UF')) as PdfObject),
          'EF/F=' + streamIdentity(file, ef?.entries.get('F')),
          'EF/UF=' + streamIdentity(file, ef?.entries.get('UF')),
          'AFRelationship=' + (isName(rel) ? rel.v : '-'),
          'AF=' + (isRef(value) && inAf.has(value.num) ? 'yes' : 'no'),
        ].join('\n');
      }
    } catch {
      id = 'unreadable';
    }
    const list = out.get(key) ?? [];
    list.push(id);
    out.set(key, list);
  }
  return out;
}

/**
 * Files that an earlier revision had and a later one lost or changed (same name, other identity), and
 * names that stand twice in a revision's name tree. With add-only writing this list is empty; anything in
 * it means someone rewrote history after the fact.
 */
export async function attachmentChanges(pdf: Uint8Array): Promise<AttachmentChange[]> {
  const file = new PdfFile(pdf);
  const seen = new Map<string, string>();
  const out: AttachmentChange[] = [];
  const reported = new Set<string>();
  const duplicates = new Set<string>();
  for (let i = 0; i < file.revisions.length; i++) {
    const now = new Map<string, string>();
    for (const [n, list] of identities(new PdfFile(file.revisionBytes(i)))) {
      if (list.length > 1 && !duplicates.has(n)) {
        out.push({ name: n, kind: 'duplicate', revision: i });
        duplicates.add(n);
      }
      now.set(n, list.join('\n--\n'));
    }
    for (const [n, id] of seen) {
      if (reported.has(n)) continue;
      const d = now.get(n);
      if (d === undefined || d !== id) {
        out.push({ name: n, kind: d === undefined ? 'removed' : 'changed', revision: i });
        reported.add(n);
      }
    }
    for (const [n, d] of now) if (!seen.has(n)) seen.set(n, d);
  }
  return out;
}

function hexDigest(data: Uint8Array): string {
  return Array.from(sha256Bytes(data), (b) => b.toString(16).padStart(2, '0')).join('');
}
