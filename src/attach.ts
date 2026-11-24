/**
 * Embedded files as PDF/A-3 associated files: an `/EmbeddedFile` stream, a `/Filespec` with
 * `/AFRelationship`, an entry in the catalog's `/Names /EmbeddedFiles` tree and in the catalog's `/AF`.
 * A file with the same name replaces the entry in the new revision; the earlier revisions keep theirs.
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

/** Adds (or replaces) an associated file in `update`. */
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
      if (key !== undefined && key !== a.name) pairs.push({ key, value: oldPairs[i + 1]! });
    }
  pairs.push({ key: a.name, value: spec });
  pairs.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  tree.entries.set(
    'Names',
    pairs.flatMap((p) => [latin1(p.key), p.value]),
  );
  namesDict.entries.set('EmbeddedFiles', tree);
  cat.entries.set('Names', namesDict);

  // /AF: keep the other files, drop an older one with the same name.
  const oldAf = isRef(cat.entries.get('AF'))
    ? update.get(cat.entries.get('AF') as PdfRef)
    : cat.entries.get('AF');
  const af: PdfObject[] = [];
  if (Array.isArray(oldAf))
    for (const item of oldAf) {
      const s = getDict(update, item);
      if (s !== undefined && keyText(s.entries.get('F')) === a.name) continue;
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
