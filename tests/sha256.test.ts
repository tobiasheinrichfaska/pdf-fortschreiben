import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Sha256, sha256Bytes, sha256Hex } from '../src/sha256.ts';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const node = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('sha256', () => {
  it('known vectors', () => {
    expect(hex(sha256Bytes(new Uint8Array(0)))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    expect(hex(sha256Bytes(new Uint8Array(1_000_000).fill(0x61)))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });

  it('matches node:crypto for all lengths 0..300', () => {
    const data = randomBytes(300);
    for (let n = 0; n <= 300; n++) {
      const part = data.subarray(0, n);
      expect(hex(sha256Bytes(part))).toBe(node(part));
    }
  });

  it('matches node:crypto for random chunk splits via update()', () => {
    for (let round = 0; round < 50; round++) {
      const data = randomBytes(Math.floor(Math.random() * 1000));
      const hasher = new Sha256();
      let pos = 0;
      while (pos < data.length) {
        const n = Math.floor(Math.random() * 150);
        hasher.update(data.subarray(pos, pos + n));
        pos += n;
      }
      expect(hex(hasher.digest())).toBe(node(data));
    }
  });

  it('handles empty chunks, offsets of subarrays and refuses reuse', () => {
    const data = randomBytes(200);
    const hasher = new Sha256().update(new Uint8Array(0)).update(data.subarray(3, 130));
    hasher.update(new Uint8Array(0)).update(data.subarray(130, 199));
    expect(hex(hasher.digest())).toBe(node(data.subarray(3, 199)));
    expect(() => hasher.digest()).toThrow();
    expect(() => hasher.update(data)).toThrow();
  });

  it('does not modify the input', () => {
    const data = randomBytes(131);
    const copy = data.slice();
    sha256Bytes(data);
    expect(data).toEqual(copy);
  });
});
