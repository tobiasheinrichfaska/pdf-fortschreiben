// Independent checks of the library's output: openssl ts -verify, pdfsig, pyHanko, pikepdf.
// Run from the library directory after scripts/pki.sh.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { appendDocTimeStamp, appendRevision, attachFile, findDocTimeStamps } from '../src/index.ts';

const root = resolve(import.meta.dirname, '..');
const tmp = resolve(root, '.tmp');
const pki = resolve(tmp, 'pki');
mkdirSync(tmp, { recursive: true });
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const te = new TextEncoder();
let n = 0;

const stamper = async (digest: Uint8Array): Promise<Uint8Array> => {
  n++;
  const q = resolve(tmp, `query${n}.tsq`);
  const tok = resolve(tmp, `token${n}.der`);
  const query = execFileSync('openssl', [
    'ts',
    '-query',
    '-digest',
    hex(digest),
    '-sha256',
    '-cert',
    '-no_nonce',
  ]);
  writeFileSync(q, query);
  execFileSync(
    'openssl',
    ['ts', '-reply', '-config', resolve(pki, 'ts.cnf'), '-queryfile', q, '-token_out', '-out', tok],
    { cwd: pki },
  );
  return new Uint8Array(readFileSync(tok));
};

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
doc.addPage([595, 842]).drawText('Seite 1', { x: 50, y: 780, size: 14, font });
doc.setTitle('Test');
doc.setCreationDate(new Date('2026-11-01T00:00:00Z'));
doc.setModificationDate(new Date('2026-11-01T00:00:00Z'));
let pdf: Uint8Array = await doc.save({ useObjectStreams: false });

const att = (s: string, mod: string) => (f: any, u: any) =>
  attachFile(f, u, {
    name: 'zeiterfassung-2026-11.json',
    data: te.encode(s),
    mimeType: 'application/json',
    modified: mod,
    relationship: 'Data',
  });
pdf = appendRevision(pdf, att('{"tag":1}', 'D:20261101180000Z'));
pdf = await appendDocTimeStamp(pdf, stamper);
pdf = appendRevision(pdf, att('{"tag":2}', 'D:20261102180000Z'));
pdf = await appendDocTimeStamp(pdf, stamper);
writeFileSync(resolve(tmp, 'monat.pdf'), pdf);

// Control for pyHanko's modification analysis: attach, stamp, stamp again with NO attachment change.
let ctl: Uint8Array = await doc.save({ useObjectStreams: false });
ctl = appendRevision(ctl, att('{"tag":1}', 'D:20261101180000Z'));
ctl = await appendDocTimeStamp(ctl, stamper);
ctl = await appendDocTimeStamp(ctl, stamper);
writeFileSync(resolve(tmp, 'kontrolle.pdf'), ctl);

const found = findDocTimeStamps(pdf);
console.log(`stamps found: ${found.length}`);
let fail = 0;
found.forEach((f, i) => {
  const tok = resolve(tmp, `found${i + 1}.der`);
  writeFileSync(tok, f.token);
  const r = spawnSync(
    'openssl',
    [
      'ts',
      '-verify',
      '-digest',
      hex(f.digest),
      '-in',
      tok,
      '-token_in',
      '-CAfile',
      resolve(pki, 'root.crt'),
      '-untrusted',
      resolve(pki, 'chain.pem'),
    ],
    { encoding: 'utf8' },
  );
  const out = (r.stdout + r.stderr).trim();
  console.log(
    `[openssl ts -verify] stamp ${i + 1} field="${f.field}" obj=${f.object} rangeOk=${f.rangeOk} rev=${f.revision}: ${out}`,
  );
  if (r.status !== 0 || !out.includes('OK')) fail++;
});
process.exit(fail ? 1 : 0);
