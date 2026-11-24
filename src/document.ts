/**
 * An opened PDF (read only) and the incremental writer. Opening reads the chain of `xref` sections from
 * the last `startxref` back over `/Prev`; every section is one revision. Writing appends one revision:
 * new and changed objects, an `xref` section for exactly those, a trailer with `/Prev`, `startxref` and
 * `%%EOF`. The bytes before it are never touched.
 */
import {
  TextSink,
  isDict,
  isName,
  isRef,
  ref,
  type PdfDict,
  type PdfObject,
  type PdfRef,
  type PdfStream,
} from './objects.ts';
import {
  PdfReadError,
  isStream,
  latin1Text,
  lastStartxref,
  readIndirect,
  readRevisionEnd,
  readXrefSection,
  type XrefSection,
} from './parse.ts';

/** The largest `/Size` a file may have (what `PdfFile` accepts and `writeUpdate` may write). */
export const MAX_SIZE = 2147483647;

export interface Revision {
  /** Offset of this revision's `xref` keyword. */
  readonly xrefAt: number;
  /** Offset just after this revision's `%%EOF` (its line end, if any, is not counted). */
  readonly end: number;
  readonly trailer: PdfDict;
}

/** True when the first indirect object after the header is a `/Linearized` dictionary. */
function hasLinearizedDict(bytes: Uint8Array): boolean {
  const head = latin1Text(bytes, 0, Math.min(bytes.length, 1024));
  return /^%PDF-[^\r\n]*(?:[\r\n]+%[^\r\n]*)*[\r\n\s]*\d+\s+\d+\s+obj\s*<<(?:(?!endobj)[^])*?\/Linearized\b/.test(
    head,
  );
}

export class PdfFile {
  readonly bytes: Uint8Array;
  /** Revisions, oldest first. */
  readonly revisions: readonly Revision[];
  private readonly table = new Map<number, { offset: number; gen: number }>();
  private readonly freed = new Map<number, number>();
  private readonly cache = new Map<number, PdfObject | PdfStream>();
  private readonly reading = new Set<number>();

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
    for (const s of sections) {
      const size = s.trailer.entries.get('Size');
      if (typeof size === 'number' && (!Number.isInteger(size) || size < 0 || size > MAX_SIZE))
        throw new PdfReadError('syntax', `trailer /Size ${size} is not a valid object count`);
    }
    for (const s of sections)
      if (s.trailer.entries.has('Encrypt'))
        throw new PdfReadError('encrypted', 'the trailer has /Encrypt');
    this.revisions = sections.map((s) => ({
      xrefAt: s.at,
      end: readRevisionEnd(bytes, s.trailerEnd),
      trailer: s.trailer,
    }));
    // Revisions must be appended one after the other; a linearized file is not (first-page section at the start).
    if (hasLinearizedDict(bytes))
      throw new PdfReadError('linearized', 'the first object is a /Linearized dictionary');
    for (let i = 1; i < this.revisions.length; i++)
      if (
        this.revisions[i]!.end <= this.revisions[i - 1]!.end ||
        this.revisions[i]!.xrefAt <= this.revisions[i - 1]!.xrefAt
      )
        throw new PdfReadError(
          'linearized',
          `revision ${i} (xref ${this.revisions[i]!.xrefAt}) does not lie after revision ${i - 1}`,
        );
    for (const s of sections)
      for (const [num, e] of s.entries) {
        if (e.inUse) {
          this.table.set(num, { offset: e.offset, gen: e.gen });
          this.freed.delete(num);
        } else {
          this.table.delete(num);
          // The generation of a free entry is the one a reuse of the number must carry.
          if (num !== 0) this.freed.set(num, e.gen);
        }
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

  /**
   * The generation of an object in use, or of a freed one (the generation a reuse must carry), or
   * `undefined` when the file has no such object. Object 0 is never reported.
   */
  generation(num: number): number | undefined {
    return this.table.get(num)?.gen ?? this.freed.get(num);
  }

  /** The object a reference points to (in the newest revision). */
  object(r: PdfRef): PdfObject | PdfStream {
    const e = this.table.get(r.num);
    if (e === undefined) throw new PdfReadError('object-missing', `object ${r.num}`);
    if (e.gen !== r.gen)
      throw new PdfReadError(
        'object-mismatch',
        `object ${r.num}: generation ${r.gen} referenced, the file has ${e.gen}`,
      );
    const hit = this.cache.get(r.num);
    if (hit !== undefined) return hit;
    if (this.reading.has(r.num))
      throw new PdfReadError('syntax', `object ${r.num} refers to itself (stream /Length cycle)`);
    this.reading.add(r.num);
    let o: PdfObject | PdfStream;
    try {
      o = readIndirect(
        this.bytes,
        e.offset,
        r.num,
        (len) => {
          const v = isRef(len) ? this.object(len) : len;
          if (typeof v !== 'number') throw new PdfReadError('syntax', `stream length of ${r.num}`);
          return v;
        },
        e.gen,
      );
    } finally {
      this.reading.delete(r.num);
    }
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
    const seen = new Set<number>();
    const walk = (r: PdfObject | undefined, depth: number): void => {
      if (!isRef(r) || depth > 32 || seen.has(r.num)) return;
      seen.add(r.num);
      const d = this.dict(r);
      if (d === undefined) return;
      const kids = this.resolve(d.entries.get('Kids'));
      if (Array.isArray(kids)) kids.forEach((k) => walk(k, depth + 1));
      else {
        const type = d.entries.get('Type');
        if (isName(type, 'Pages'))
          throw new PdfReadError(
            'syntax',
            `page tree node ${r.num} is a /Pages node without /Kids array`,
          );
        out.push(r);
      }
    };
    walk(this.catalog.entries.get('Pages'), 0);
    return out;
  }

  /**
   * This file as it stood at the end of revision `index` (a prefix of the bytes): up to and including the
   * single line end after `%%EOF` (which a time stamp's `/ByteRange` covers), if there is one. It is a prefix
   * of the updated file, not necessarily byte-equal to the original base: it includes that line end, which
   * may be the writer's own lead newline of the next revision.
   */
  revisionBytes(index: number): Uint8Array {
    const r = this.revisions[index];
    if (r === undefined) throw new RangeError(`no revision ${index}`);
    let end = r.end;
    if (this.bytes[end] === 0x0d && this.bytes[end + 1] === 0x0a) end += 2;
    else if (this.bytes[end] === 0x0a || this.bytes[end] === 0x0d) end += 1;
    return this.bytes.subarray(0, end);
  }
}

/** The objects of one new revision. */
export class Update {
  private readonly file: PdfFile;
  private next: number;
  private readonly objs = new Map<number, PdfObject | PdfStream>();
  private readonly gens = new Map<number, number>();

  /** The objects of this update (a read only copy). */
  get objects(): ReadonlyMap<number, PdfObject | PdfStream> {
    return new Map(this.objs);
  }

  /** Generation written for each object (that of the file's xref entry; 0 for new objects). */
  get generations(): ReadonlyMap<number, number> {
    return new Map(this.gens);
  }

  constructor(file: PdfFile) {
    this.file = file;
    this.next = file.size;
  }

  /** Adds a new object and returns its reference. */
  add(o: PdfObject | PdfStream): PdfRef {
    if (this.next + 1 > MAX_SIZE)
      throw new Error(
        `Update.add: /Size would exceed ${MAX_SIZE} (the file has ${this.file.size})`,
      );
    const r = ref(this.next++);
    this.objs.set(r.num, o);
    this.gens.set(r.num, 0);
    return r;
  }

  /** Replaces an existing object in the new revision. */
  set(r: PdfRef, o: PdfObject | PdfStream): void {
    const gen = this.file.generation(r.num) ?? 0;
    if (r.num === 0) throw new Error('object 0 cannot be set');
    if (r.gen !== gen)
      throw new Error(`object ${r.num}: generation ${r.gen} given, the file has ${gen}`);
    if (r.num + 1 > MAX_SIZE)
      throw new Error(`Update.set: object ${r.num} would make /Size exceed ${MAX_SIZE}`);
    this.objs.set(r.num, o);
    this.gens.set(r.num, gen);
    if (r.num >= this.next) this.next = r.num + 1;
  }

  /** The object as this update sees it: changed here, or else from the file. */
  get(r: PdfRef): PdfObject | PdfStream {
    return this.objs.has(r.num) ? this.objs.get(r.num)! : this.file.object(r);
  }

  get size(): number {
    return this.next;
  }
}

const RESERVED_TRAILER = ['Size', 'Prev', 'Root', 'ID', 'Encrypt'];

export interface Written {
  readonly bytes: Uint8Array;
  /** Absolute offsets of every `raw` with an id. */
  readonly marks: ReadonlyMap<string, number>;
}

/**
 * Appends the update as a new revision. `trailerExtra` may set `/Info` and other keys; `/Root`, `/ID` are
 * carried over, `/Size` and `/Prev` are set here, and `/Size`, `/Prev`, `/Root`, `/ID`, `/Encrypt` in
 * `trailerExtra` are refused with an Error. An update without objects is refused.
 */
export function writeUpdate(
  file: PdfFile,
  update: Update,
  trailerExtra: Record<string, PdfObject> = {},
): Written {
  if (update.objects.size === 0) throw new Error('writeUpdate: the update has no objects');
  for (const key of RESERVED_TRAILER)
    if (key in trailerExtra) throw new Error(`writeUpdate: trailerExtra must not set /${key}`);
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
    sink.push(`${num} ${update.generations.get(num) ?? 0} obj\n`);
    if (isStream(o)) {
      const d = { t: 'dict' as const, entries: new Map(o.dict.entries) };
      d.entries.set('Length', o.data.length);
      try {
        sink.write(d);
      } catch (e) {
        throw new Error(`writeUpdate: object ${num}: ${(e as Error).message}`, { cause: e });
      }
      sink.push('\nstream\n');
      // Stream data is binary: appended as it is.
      sink.pushBytes(o.data);
      sink.push('\nendstream');
    } else
      try {
        sink.write(o);
      } catch (e) {
        throw new Error(`writeUpdate: object ${num}: ${(e as Error).message}`, { cause: e });
      }
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
      sink.push(
        `${String(offsets.get(nums[k]!)).padStart(10, '0')} ${String(update.generations.get(nums[k]!) ?? 0).padStart(5, '0')} n\r\n`,
      );
    i = j + 1;
  }
  const prevAt = file.revisions[file.revisions.length - 1]!.xrefAt;
  const trailer = new Map<string, PdfObject>();
  const size = Math.max(update.size, (nums[nums.length - 1] ?? 0) + 1);
  if (size > MAX_SIZE) throw new Error(`writeUpdate: /Size ${size} exceeds ${MAX_SIZE}`);
  trailer.set('Size', size);
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
  const out = new Uint8Array(base.length + sink.size);
  out.set(base, 0);
  sink.writeTo(out, base.length);
  const marks = new Map<string, number>();
  for (const [k, v] of sink.marks) marks.set(k, base.length + v);
  return { bytes: out, marks };
}
