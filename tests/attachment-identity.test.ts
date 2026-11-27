import {
  PdfFile,
  Update,
  appendRevision,
  attachFile,
  attachmentChanges,
  dict,
  latin1,
  name,
  textString,
  type PdfDict,
  type PdfRef,
} from '../src/index.ts';
import { basePdf, text, must } from './helpers.ts';

const day1 = { name: 'monat-tag-1.json', data: text('{"tag":1}'), mimeType: 'application/json' };

async function withDay1(): Promise<Uint8Array> {
  return must(appendRevision(await basePdf(), (f, u) => attachFile(f, u, day1)));
}

/** The Filespec of the first tree entry, its reference and its /EF /F stream reference. */
function firstSpec(f: PdfFile): { specRef: PdfRef; spec: PdfDict; efRef: PdfRef } {
  const tree = f.dict(f.dict(f.catalog.entries.get('Names'))!.entries.get('EmbeddedFiles'))!;
  const pairs = tree.entries.get('Names') as PdfRef[];
  const specRef = pairs[1]!;
  const spec = f.dict(specRef)!;
  const efRef = f.dict(spec.entries.get('EF'))!.entries.get('F') as PdfRef;
  return { specRef, spec, efRef };
}

/** A later revision that rewrites the Filespec of day 1. */
function rewriteSpec(
  pdf: Uint8Array,
  change: (spec: PdfDict, u: Update, efRef: PdfRef, f: PdfFile) => void,
): Uint8Array {
  return must(
    appendRevision(pdf, (f, u) => {
      const { specRef, spec, efRef } = firstSpec(f);
      const copy: PdfDict = { t: 'dict', entries: new Map(spec.entries) };
      change(copy, u, efRef, f);
      u.set(specRef, copy);
    }),
  );
}

const changedAt2 = [{ name: 'monat-tag-1.json', kind: 'changed', revision: 2 }];

describe('attachmentChanges compares the whole identity of a file', () => {
  it('reports a key that stands twice in the name tree (forged first, original second)', async () => {
    const r1 = await withDay1();
    const forged = must(
      appendRevision(r1, (f, u) => {
        const { specRef } = firstSpec(f);
        const ef = u.add({
          t: 'stream',
          dict: dict({ Type: name('EmbeddedFile'), Subtype: name('application/json') }),
          data: text('{"tag":99}'),
        });
        const fake = u.add(
          dict({
            Type: name('Filespec'),
            F: latin1(day1.name),
            UF: textString(day1.name),
            AFRelationship: name('Data'),
            EF: dict({ F: ef, UF: ef }),
          }),
        );
        const cat = { t: 'dict' as const, entries: new Map(f.catalog.entries) };
        cat.entries.set(
          'Names',
          dict({
            EmbeddedFiles: dict({ Names: [latin1(day1.name), fake, latin1(day1.name), specRef] }),
          }),
        );
        u.set(f.rootRef, cat);
      }),
    );
    expect(must(await attachmentChanges(forged))).toContainEqual({
      name: day1.name,
      kind: 'changed', // a name twice in the tree is reported as `changed`
      revision: 2,
    });
  });

  it('reports a changed /UF name', async () => {
    const forged = rewriteSpec(await withDay1(), (s) => {
      s.entries.set('UF', textString('anders.json'));
    });
    expect(must(await attachmentChanges(forged))).toEqual(changedAt2);
  });

  it('reports a changed /F name', async () => {
    const forged = rewriteSpec(await withDay1(), (s) => {
      s.entries.set('F', latin1('anders.json'));
    });
    expect(must(await attachmentChanges(forged))).toEqual(changedAt2);
  });

  it('reports an /EF /UF stream other than /EF /F', async () => {
    const forged = rewriteSpec(await withDay1(), (s, u, efRef) => {
      const other = u.add({
        t: 'stream',
        dict: dict({ Type: name('EmbeddedFile'), Subtype: name('application/json') }),
        data: text('{"tag":99}'),
      });
      s.entries.set('EF', dict({ F: efRef, UF: other }));
    });
    expect(must(await attachmentChanges(forged))).toEqual(changedAt2);
  });

  it('reports a changed MIME type (same bytes)', async () => {
    const forged = rewriteSpec(await withDay1(), (s, u, efRef, f) => {
      const old = f.object(efRef);
      if (old === null || typeof old !== 'object' || !('t' in old) || old.t !== 'stream')
        throw new Error('no stream');
      const other = u.add({
        t: 'stream',
        dict: dict({ Type: name('EmbeddedFile'), Subtype: name('text/plain') }),
        data: old.data,
      });
      s.entries.set('EF', dict({ F: other, UF: other }));
    });
    expect(must(await attachmentChanges(forged))).toEqual(changedAt2);
  });

  it('reports a changed /AFRelationship', async () => {
    const forged = rewriteSpec(await withDay1(), (s) => {
      s.entries.set('AFRelationship', name('Source'));
    });
    expect(must(await attachmentChanges(forged))).toEqual(changedAt2);
  });

  it('reports a file taken out of the catalog /AF', async () => {
    const forged = must(
      appendRevision(await withDay1(), (f, u) => {
        const cat = { t: 'dict' as const, entries: new Map(f.catalog.entries) };
        cat.entries.set('AF', []);
        u.set(f.rootRef, cat);
      }),
    );
    expect(must(await attachmentChanges(forged))).toEqual(changedAt2);
  });

  it('honest add-only revisions report nothing', async () => {
    const r2 = must(
      appendRevision(await withDay1(), (f, u) =>
        attachFile(f, u, { ...day1, name: 'monat-tag-2.json' }),
      ),
    );
    expect(must(await attachmentChanges(r2))).toEqual([]);
  });
});
