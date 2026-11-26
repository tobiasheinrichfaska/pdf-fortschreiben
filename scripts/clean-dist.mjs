// Removes dist/ before a build, so that no file of an earlier build (a renamed or deleted module) stays in
// the package. Platform neutral (no rm, no rimraf).
import { rmSync } from 'node:fs';

rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true });
