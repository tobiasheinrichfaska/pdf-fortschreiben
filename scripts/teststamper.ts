// A `Stamper` backed by the test PKI of scripts/pki.sh and `openssl ts -reply` (no network, no real service).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

export function makeStamper(tmp: string, pki: string) {
  let n = 0;
  return async (digest: Uint8Array): Promise<Uint8Array> => {
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
      [
        'ts',
        '-reply',
        '-config',
        resolve(pki, 'ts.cnf'),
        '-queryfile',
        q,
        '-token_out',
        '-out',
        tok,
      ],
      { cwd: pki },
    );
    return new Uint8Array(readFileSync(tok));
  };
}
