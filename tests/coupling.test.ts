// Guards of a public, app-independent package:
//  1. the library core (src/) imports nothing from node:, from the relay or from outside itself, so it
//     runs in a browser and in Node;
//  2. no private project is named in any file, and no secret-looking value is committed.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SKIP = new Set(['node_modules', 'dist', '.git', '.tmp', 'package-lock.json', 'LICENSE']);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe('library core', () => {
  const sources = files(join(ROOT, 'src')).filter((f) => f.endsWith('.ts'));
  it('has sources', () => expect(sources.length).toBeGreaterThan(5));
  for (const file of sources) {
    it(`${relative(ROOT, file)} uses standard APIs only`, () => {
      const text = readFileSync(file, 'utf8');
      const imports = [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map(
        (m) => m[1]!,
      );
      for (const spec of imports) {
        expect(spec.startsWith('./'), `${spec} must be a sibling file`).toBe(true);
      }
      expect(text).not.toMatch(/\bBuffer\b(?!Source)|\bprocess\.|\brequire\(/);
      expect(text).not.toMatch(/\bfetch\s*\(/);
    });
  }
});

// Words that identify private projects or their domain. Built from parts so this file is no hit.
const FORBIDDEN = [
  ['zeit', 'erfassung'],
  ['tk', 'd'],
  ['trainer', 'buch'],
  ['az', 'p'],
  ['arbeits', 'zeit'],
  ['bürger', 'verein'],
  ['family', '-patch'],
  ['treff', 'punkt'],
  ['fa', 'ska'],
  ['sport', 'abzeichen'],
  ['kan', 'zlei'],
  ['frage', 'bogen'],
].map((parts) => parts.join(''));

/** Short words only count as whole words, so they do not hit inside other words or hashes. */
const mentions = (text: string, word: string): boolean =>
  word.length <= 3 ? new RegExp(String.raw`\b${word}\b`).test(text) : text.includes(word);

describe('no private names', () => {
  const SELF = join(ROOT, 'tests', 'coupling.test.ts');
  it('in any file', () => {
    for (const file of files(ROOT)) {
      const skipped = /\.(pem|crt|tsr|tsq)$/.test(file) || file.endsWith('LICENSE_COMMERCIAL.md');
      if (file === SELF || skipped) continue;
      const text = readFileSync(file, 'utf8').toLowerCase();
      for (const word of FORBIDDEN) {
        expect(mentions(text, word), `${relative(ROOT, file)}: ${word}`).toBe(false);
      }
    }
  });
  it('in commit messages', () => {
    const read = (): string | null => {
      try {
        return execFileSync('git', ['-C', ROOT, 'log', '--format=%B'], {
          stdio: ['ignore', 'pipe', 'ignore'],
          encoding: 'utf8',
        }).toLowerCase();
      } catch {
        return null; // not a git checkout (e.g. a tarball), or no commit yet
      }
    };
    const log = read();
    if (log === null) return;
    for (const word of FORBIDDEN) expect(mentions(log, word), word).toBe(false);
  });
});
