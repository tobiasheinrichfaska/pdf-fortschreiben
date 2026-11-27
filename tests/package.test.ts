import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as core from '../src/index.ts';
import * as pdflib from '../src/pdflib.ts';
import { basePdf, fakeStamper, text } from './helpers.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));

interface Pkg {
  version: string;
  main: string;
  types: string;
  exports: Record<string, { types: string; import: string }>;
  files: string[];
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional: boolean }>;
  scripts: Record<string, string>;
}
const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as Pkg;

/** A copy of what `prepare` needs; `withTypescript` links this repository's node_modules into it. */
function project(withTypescript: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'pdf-fortschreiben-prepare-'));
  for (const name of ['scripts', 'src', 'package.json', 'tsconfig.json', 'tsconfig.build.json']) {
    cpSync(join(REPO, name), join(dir, name), { recursive: true });
  }
  if (withTypescript) symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

/** Runs the script with a PATH that has no `tsc`: TypeScript must be found by path, not through PATH. */
function prepare(dir: string) {
  return spawnSync(process.execPath, ['scripts/prepare.mjs'], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: '/nonexistent' },
    timeout: 120_000,
  });
}

describe('package.json', () => {
  it('is version 0.1.0 here and in the lockfile', () => {
    expect(pkg.version).toBe('0.1.0');
    const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8')) as {
      version: string;
      packages: Record<string, { version: string }>;
    };
    expect(lock.version).toBe('0.1.0');
    expect(lock.packages['']?.version).toBe('0.1.0');
  });
  it('exports `.` and `./pdflib` from dist with types, and ships dist and the licence texts', () => {
    expect(pkg.exports).toEqual({
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './pdflib': { types: './dist/pdflib.d.ts', import: './dist/pdflib.js' },
    });
    expect(pkg.main).toBe('./dist/index.js');
    expect(pkg.types).toBe('./dist/index.d.ts');
    for (const name of ['dist', 'README.md', 'LICENSE', 'LICENSE_COMMERCIAL.md']) {
      expect(pkg.files).toContain(name);
    }
  });
  it('keeps pdf-lib an optional peer and builds on `prepare`', () => {
    expect(pkg.peerDependencies['pdf-lib']).toBe('1.17.1');
    expect(pkg.peerDependenciesMeta['pdf-lib']?.optional).toBe(true);
    expect(pkg.scripts.prepare).toBe('node scripts/prepare.mjs');
    expect(pkg.scripts.build).toContain('tsc -p tsconfig.build.json');
  });
  it('dist is not committed (it is ignored)', () => {
    expect(readFileSync(join(REPO, '.gitignore'), 'utf8').split('\n')).toContain('dist');
  });
});

describe('scripts/prepare.mjs (the `prepare` of npm)', () => {
  it('without typescript it skips the build with one line on stderr and exit 0', () => {
    const dir = project(false);
    try {
      const r = prepare(dir);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr.trim()).toBe('prepare: typescript not installed, skipping build');
      expect(existsSync(join(dir, 'dist'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('a broken source fails loudly: exit code not 0 and the compiler error on the output', () => {
    const dir = project(true);
    try {
      appendFileSync(join(dir, 'src', 'index.ts'), "\nexport const broken: number = 'text';\n");
      const r = prepare(dir);
      expect(r.status, r.stderr + r.stdout).not.toBe(0);
      expect(r.stdout + r.stderr).toContain('error TS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the built package (built here by `prepare` in a copy, no tsc on PATH)', () => {
  let dir = '';
  let built: ReturnType<typeof prepare>;
  beforeAll(() => {
    dir = project(true);
    built = prepare(dir);
  }, 120_000);
  afterAll(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  it('builds without error and rewrites the declarations', () => {
    expect(built.status, built.stderr + built.stdout).toBe(0);
    expect(built.stdout).toContain('declarations rewritten');
  });
  it('every path of `exports`, `main` and `types` is a built file', () => {
    const paths = [
      pkg.main,
      pkg.types,
      ...Object.values(pkg.exports).flatMap((e) => [e.types, e.import]),
    ];
    for (const path of paths) expect(existsSync(join(dir, path)), path).toBe(true);
  });
  it('dist has one .js and one .d.ts per source, and no declaration points to a .ts file', () => {
    const sources = readdirSync(join(dir, 'src')).filter((n) => n.endsWith('.ts'));
    for (const source of sources) {
      const base = source.slice(0, -3);
      expect(existsSync(join(dir, 'dist', `${base}.js`)), base).toBe(true);
      const decl = readFileSync(join(dir, 'dist', `${base}.d.ts`), 'utf8');
      expect(decl, base).not.toMatch(/from ['"][^'"]+\.ts['"]/);
      const js = readFileSync(join(dir, 'dist', `${base}.js`), 'utf8');
      expect(js, base).not.toMatch(/from ['"]\.{1,2}\/[^'"]+\.ts['"]/);
    }
  });
  it('dist/index.js loads, has the exports of src/index.ts and continues a PDF', async () => {
    const mod = (await import(pathToFileURL(join(dir, 'dist', 'index.js')).href)) as typeof core;
    expect(Object.keys(mod).sort()).toEqual(Object.keys(core).sort());
    const first = mod.appendRevision(await basePdf(), (file, update) =>
      mod.attachFile(file, update, {
        name: 'stand-01.json',
        data: text('{"a":1}'),
        mimeType: 'application/json',
      }),
    );
    if (!first.ok) throw new Error(first.code);
    const stamped = await mod.appendDocTimeStamp(first.value, fakeStamper());
    if (!stamped.ok) throw new Error(stamped.code);
    const pdf = stamped.value;
    const stamps = mod.findDocTimeStamps(pdf);
    if (!stamps.ok) throw new Error(stamps.code);
    expect(stamps.value).toHaveLength(1);
    expect(stamps.value[0]?.rangeOk).toBe(true);
    expect(await mod.attachmentChanges(pdf)).toEqual({ ok: true, value: [] });
    // a failure comes back as a value from the built package too
    expect(mod.appendRevision(new Uint8Array(10), () => {})).toMatchObject({
      ok: false,
      code: 'no-startxref',
    });
  });
  it('dist/pdflib.js loads (pdf-lib as the peer) and appends a drawn page', async () => {
    const mod = (await import(pathToFileURL(join(dir, 'dist', 'pdflib.js')).href)) as typeof pdflib;
    expect(Object.keys(mod).sort()).toEqual(Object.keys(pdflib).sort());
    const drawn = await mod.appendDrawnPages(await basePdf(), (doc) => {
      doc.addPage([595, 842]);
    });
    if (!drawn.ok) throw new Error(drawn.code);
    const main = (await import(pathToFileURL(join(dir, 'dist', 'index.js')).href)) as typeof core;
    const opened = main.PdfFile.open(drawn.value);
    if (!opened.ok) throw new Error(opened.code);
    expect(opened.value.pages().length).toBe(2);
  });
});
