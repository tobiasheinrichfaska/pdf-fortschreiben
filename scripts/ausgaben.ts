// Writes the files the external validity check feeds to qpdf and veraPDF: a base PDF and the same file after
// each kind of write the library offers. Needs the test PKI of scripts/pki.sh in `<root>/.tmp/pki`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { appendDocTimeStamp, appendRevision, attachFile, type Result } from '../src/index.ts';
import { appendDrawnPages } from '../src/pdflib.ts';
import { makeStamper } from './teststamper.ts';

const need = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.code}: ${r.detail}`);
  return r.value;
};

export interface Ausgabe {
  readonly name: string;
  readonly path: string;
}

/** Writes `base.pdf` and the results into `outDir`; the base comes first in the returned list. */
export async function schreibeAusgaben(root: string, outDir: string): Promise<Ausgabe[]> {
  mkdirSync(outDir, { recursive: true });
  const stamper = makeStamper(outDir, resolve(root, '.tmp', 'pki'));

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText('Seite 1', { x: 50, y: 780, size: 14, font });
  doc.setTitle('Test');
  doc.setCreationDate(new Date('2026-11-01T00:00:00Z'));
  doc.setModificationDate(new Date('2026-11-01T00:00:00Z'));
  const base = await doc.save({ useObjectStreams: false });

  const attach = need(
    appendRevision(base, (f, u) =>
      attachFile(f, u, {
        name: 'monat-2026-11-tag-01.json',
        data: new TextEncoder().encode('{"tag":1}'),
        mimeType: 'application/json',
        modified: 'D:20261101180000Z',
        relationship: 'Data',
      }),
    ),
  );
  const stamp = need(await appendDocTimeStamp(attach, stamper));
  const drawn = need(
    await appendDrawnPages(base, async (d) => {
      const f = await d.embedFont(StandardFonts.Helvetica);
      d.addPage([595, 842]).drawText('Seite 2', { x: 50, y: 780, size: 14, font: f });
    }),
  );

  const files: [string, Uint8Array][] = [
    ['base.pdf', base],
    ['attach.pdf', attach],
    ['stamp.pdf', stamp],
    ['drawn.pdf', drawn],
  ];
  return files.map(([name, bytes]) => {
    const path = resolve(outDir, name);
    writeFileSync(path, bytes);
    return { name, path };
  });
}
