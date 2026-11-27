// The `prepare` step of npm: builds dist/ on a Git install (and after a plain `npm install` in the repo),
// but only when TypeScript can be found. `npm install --omit=dev` has no TypeScript; there the build is
// skipped (one line on stderr, exit 0) instead of failing the whole install. `npm run build` stays the
// strict way (it fails without TypeScript). TypeScript is started with this Node and an absolute path,
// not through PATH.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = new URL('..', import.meta.url);
let tsc;
try {
  tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
} catch {
  console.error('prepare: typescript not installed, skipping build');
  process.exit(0);
}

const steps = [
  [process.execPath, ['scripts/clean-dist.mjs']],
  [process.execPath, [tsc, '-p', 'tsconfig.build.json']],
  [process.execPath, ['scripts/fix-declarations.mjs']],
];
for (const [command, args] of steps) {
  const r = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
