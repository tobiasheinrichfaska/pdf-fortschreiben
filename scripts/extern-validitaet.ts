// External validity check: `qpdf --check` on every output, veraPDF (PDF/A-3b) as a differential check against
// the base. qpdf and veraPDF run as separate programs only; they are not dependencies of the package.
// Run from the library directory after scripts/pki.sh (`npm run extern:validitaet`).
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { schreibeAusgaben } from './ausgaben.ts';
import { newFailures, parseFailedRules } from './verapdf.ts';

const root = resolve(import.meta.dirname, '..');
const outDir = resolve(root, '.tmp', 'extern');

const verapdf = process.env['VERAPDF'] ?? 'verapdf';
for (const [tool, args] of [
  ['openssl', ['version']],
  ['qpdf', ['--version']],
  [verapdf, ['--version']],
] as const) {
  const r = spawnSync(tool, args, { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    console.error(
      `MISSING TOOL: "${tool}" cannot be run - external validity check NOT done (not a pass).`,
    );
    process.exit(2);
  }
}

const files = await schreibeAusgaben(root, outDir);
let fail = 0;

for (const f of files) {
  const r = spawnSync('qpdf', ['--check', f.path], { encoding: 'utf8' });
  const ok = r.status === 0;
  console.log(`[qpdf --check] ${f.name}: ${ok ? 'OK' : `FAILED (exit ${r.status})`}`);
  if (!ok) {
    console.log((r.stdout + r.stderr).trim());
    fail++;
  }
}

const rules = new Map<string, ReturnType<typeof parseFailedRules>>();
for (const f of files) {
  // veraPDF exits non-zero for a non-compliant file, so only the report decides, never the exit code.
  const r = spawnSync(verapdf, ['--flavour', '3b', '--format', 'mrr', f.path], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  try {
    rules.set(f.name, parseFailedRules(r.stdout));
  } catch (e) {
    console.log(`[veraPDF] ${f.name}: FAILED ${(e as Error).message}\n${r.stderr.trim()}`);
    fail++;
  }
}

const base = rules.get('base.pdf');
if (base) {
  console.log(
    `[veraPDF] base.pdf: ${base.size} failed rules (accepted: pdf-lib's base is not PDF/A)`,
  );
  for (const f of files.slice(1)) {
    const result = rules.get(f.name);
    if (!result) continue;
    const added = newFailures(base, result);
    console.log(
      `[veraPDF] ${f.name}: ${result.size} failed rules, ${added.length} new against the base`,
    );
    for (const a of added) console.log(`  NEW ${a.id}: ${a.description}`);
    if (added.length) fail++;
  }
}

console.log(fail ? `external validity check FAILED (${fail})` : 'external validity check passed');
process.exit(fail ? 1 : 0);
