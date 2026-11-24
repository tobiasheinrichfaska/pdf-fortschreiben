/**
 * An opened PDF (read only) and the incremental writer. Opening reads the chain of `xref` sections from
 * the last `startxref` back over `/Prev`; every section is one revision. Writing appends one revision:
 * new and changed objects, an `xref` section for exactly those, a trailer with `/Prev`, `startxref` and
 * `%%EOF`. The bytes before it are never touched.
 */
import {
  TextSink,
  isDict,
  isRef,
  ref,
  type PdfDict,
  type PdfObject,
  type PdfRef,
  type PdfStream,
} from './objects.ts';
import {
  PdfReadError,
  indexOf,
  isStream,
  lastStartxref,
  readIndirect,
  readXrefSection,
  type XrefSection,
} from './parse.ts';

export interface Revision {
  /** Offset of this revision's `xref` keyword. */
  readonly xrefAt: number;
  /** Offset just after this revision's `%%EOF` (its line end, if any, is not counted). */
  readonly end: number;
  readonly trailer: PdfDict;
}

export class PdfFile {
  readonly bytes: Uint8Array;
  /** Revisions, oldest first. */
  readonly revisions: readonly Revision[];
  private readonly table = new Map<number, { offset: number; gen: number }>();
  private readonly cache = new Map<number, PdfObject | PdfStream>();

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    const sections: XrefSection[] = [];
    const seen = new Set<number>();
    let at: number | null = lastStartxref(bytes);
    while (at !== null) {
      if (seen.has(at)) throw new PdfReadError('xref-loop', `xref ${at} twice`);
      seen.add(at);
      const s = readXrefSection(bytes, at);
      sections.push(s);
      const prev = s.trailer.entries.get('Prev');
      at = typeof prev === 'number' ? prev : null;
    }
    sections.reverse();
    this.revisions = sections.map((s) => ({
      xrefAt: s.at,
      end: revisionEnd(bytes, s.at),
      trailer: s.trailer,
    }));
    for (const s of sections)
      for (const [num, e] of s.entries) {
        if (e.inUse) this.table.set(num, { offset: e.offset, gen: e.gen });
        else this.table.delete(num);
      }
  }

  /** The trailer of the newest revision. */
  get trailer(): PdfDict {
    return this.revisions[this.revisions.length - 1]!.trailer;
  }

  /** One more than the highest object number in use (the trailer's `/Size`, or what the table shows). */
  get size(): number {
    const s = this.trailer.entries.get('Size');
    let max = typeof s === 'number' ? s : 0;
    for (const num of this.table.keys()) max = Math.max(max, num + 1);
    return max;
  }

  /** The object a reference points to (in the newest revision). */
  object(r: PdfRef): PdfObject | PdfStream {
    const hit = this.cache.get(r.num);
    if (hit !== undefined) return hit;
    const e = this.table.get(r.num);
    if (e === undefined) throw new PdfReadError('object-missing', `object ${r.num}`);
    const o = readIndirect(this.bytes, e.offset, r.num, (len) => {
      const v = isRef(len) ? this.object(len) : len;
      if (typeof v !== 'number') throw new PdfReadError('syntax', `stream length of ${r.num}`);
      return v;
    });
    this.cache.set(r.num, o);
    return o;
  }

  /** Follows a reference once; direct objects come back as they are. */
  resolve(o: PdfObject | undefined): PdfObject | PdfStream | undefined {
    return isRef(o) ? this.object(o) : o;
  }

  dict(o: PdfObject | undefined): PdfDict | undefined {
    const v = this.resolve(o);
    return isDict(v as PdfObject) ? (v as PdfDict) : undefined;
  }

  get rootRef(): PdfRef {
    const r = this.trailer.entries.get('Root');
    if (!isRef(r)) throw new PdfReadError('syntax', 'trailer without /Root');
    return r;
  }

  get catalog(): PdfDict {
    const c = this.dict(this.rootRef);
    if (c === undefined) throw new PdfReadError('syntax', 'catalog');
    return c;
  }

  /** The page objects in order (follows `/Kids` from the catalog's `/Pages`). */
  pages(): PdfRef[] {
    const out: PdfRef[] = [];
    const walk = (r: PdfObject | undefined, depth: number): void => {
      if (!isRef(r) || depth > 32) return;
      const d = this.dict(r);
      if (d === undefined) return;
      const kids = d.entries.get('Kids');
      if (Array.isArray(kids)) kids.forEach((k) => walk(k, depth + 1));
      else out.push(r);
    };
    walk(this.catalog.entries.get('Pages'), 0);
    return out;
  }

  /** This file as it stood at the end of revision `index` (a prefix of the bytes). */
  revisionBytes(index: number): Uint8Array {
    const r = this.revisions[index];
    if (r === undefined) throw new RangeError(`no revision ${index}`);
    return this.bytes.subarray(0, r.end);
  }
}

function revisionEnd(bytes: Uint8Array, xrefAt: number): number {
  const eof = indexOf(bytes, '%%EOF', xrefAt);
  return eof < 0 ? bytes.length : eof + 5;
}

/** The objects of one new revision. */
export class Update {
  private readonly file: PdfFile;
  private next: number;
  readonly objects = new Map<number, PdfObject | PdfStream>();

  constructor(file: PdfFile) {
    this.file = file;
    this.next = file.size;
  }

  /** Adds a new object and returns its reference. */
  add(o: PdfObject | PdfStream): PdfRef {
    const r = ref(this.next++);
    this.objects.set(r.num, o);
    return r;
  }

  /** Replaces an existing object in the new revision. */
  set(r: PdfRef, o: PdfObject | PdfStream): void {
    if (r.gen !== 0) throw new Error('only generation 0 is written');
    this.objects.set(r.num, o);
  }

  /** The object as this update sees it: changed here, or else from the file. */
  get(r: PdfRef): PdfObject | PdfStream {
    return this.objects.get(r.num) ?? this.file.object(r);
  }

  get size(): number {
    return this.next;
  }
}

export interface Written {
  readonly bytes: Uint8Array;
  /** Absolute offsets of every `raw` with an id. */
  readonly marks: ReadonlyMap<string, number>;
}

/**
 * Appends the update as a new revision. `trailerExtra` may set `/Info`; `/Root`, `/ID` are carried over,
 * `/Size` and `/Prev` are set here.
 */
export function writeUpdate(
  file: PdfFile,
  update: Update,
  trailerExtra: Record<string, PdfObject> = {},
): Written {
  const base = file.bytes;
  const sink = new TextSink();
  const offsets = new Map<number, number>();
  // A new revision starts on a new line.
  const lead = base.length > 0 && base[base.length - 1] !== 0x0a ? '\n' : '';
  sink.push(lead);
  const nums = [...update.objects.keys()].sort((a, b) => a - b);
  for (const num of nums) {
    const o = update.objects.get(num)!;
    offsets.set(num, base.length + sink.size);
    sink.push(`${num} 0 obj\n`);
    if (isStream(o)) {
      const d = { t: 'dict' as const, entries: new Map(o.dict.entries) };
      d.entries.set('Length', o.data.length);
      sink.write(d);
      sink.push('\nstream\n');
      // Stream data is binary: written as Latin-1 characters, byte for byte.
      let chunk = '';
      for (const c of o.data) chunk += String.fromCharCode(c);
      sink.push(chunk);
      sink.push('\nendstream');
    } else sink.write(o);
    sink.push('\nendobj\n');
  }
  const xrefAt = base.length + sink.size;
  sink.push('xref\n');
  // Subsections of consecutive numbers; object 0 is not repeated in an update.
  let i = 0;
  while (i < nums.length) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j]! + 1) j++;
    sink.push(`${nums[i]} ${j - i + 1}\n`);
    for (let k = i; k <= j; k++)
      sink.push(`${String(offsets.get(nums[k]!)).padStart(10, '0')} 00000 n\r\n`);
    i = j + 1;
  }
  const prevAt = file.revisions[file.revisions.length - 1]!.xrefAt;
  const trailer = new Map<string, PdfObject>();
  trailer.set('Size', update.size);
  trailer.set('Root', file.rootRef);
  const info = trailerExtra['Info'] ?? file.trailer.entries.get('Info');
  if (info !== undefined) trailer.set('Info', info);
  const id = file.trailer.entries.get('ID');
  if (id !== undefined) trailer.set('ID', id);
  trailer.set('Prev', prevAt);
  for (const [k, v] of Object.entries(trailerExtra)) if (k !== 'Info') trailer.set(k, v);
  sink.push('trailer\n');
  sink.write({ t: 'dict', entries: trailer });
  sink.push(`\nstartxref\n${xrefAt}\n%%EOF\n`);
  const tail = sink.bytes();
  const out = new Uint8Array(base.length + tail.length);
  out.set(base, 0);
  out.set(tail, base.length);
  const marks = new Map<string, number>();
  for (const [k, v] of sink.marks) marks.set(k, base.length + v);
  return { bytes: out, marks };
}
