/**
 * SHA-256 (FIPS 180-4), synchronous and without dependencies, so that the logic layer can chain hashes
 * without becoming asynchronous. Tested against the NIST vectors and against `node:crypto`.
 */

const K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const H0 = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

/** Message schedule, shared: the functions are synchronous, so no call can interleave. */
const W = new Uint32Array(64);

/** Processes `blocks` full 64-byte blocks of `data` starting at `offset`, in place (no copy). */
function compress(h: Uint32Array, data: Uint8Array, offset: number, blocks: number): void {
  const w = W;
  let h0 = h[0]!;
  let h1 = h[1]!;
  let h2 = h[2]!;
  let h3 = h[3]!;
  let h4 = h[4]!;
  let h5 = h[5]!;
  let h6 = h[6]!;
  let h7 = h[7]!;
  for (let blk = 0, p = offset; blk < blocks; blk += 1, p += 64) {
    for (let i = 0; i < 16; i += 1) {
      const q = p + i * 4;
      w[i] = (data[q]! << 24) | (data[q + 1]! << 16) | (data[q + 2]! << 8) | data[q + 3]!;
    }
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15]!;
      const y = w[i - 2]!;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let hh = h7;
    for (let i = 0; i < 64; i += 1) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (hh + s1 + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) | 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + hh) | 0;
  }
  h[0] = h0;
  h[1] = h1;
  h[2] = h2;
  h[3] = h3;
  h[4] = h4;
  h[5] = h5;
  h[6] = h6;
  h[7] = h7;
}

/** Incremental SHA-256: `update(chunk)` any number of times, then `digest()` once. */
export class Sha256 {
  private readonly h = Uint32Array.from(H0);
  private readonly tail = new Uint8Array(64);
  private tailLength = 0;
  private total = 0;
  private done = false;

  update(chunk: Uint8Array): this {
    if (this.done) throw new Error('Sha256: digest() was already called');
    this.total += chunk.length;
    let pos = 0;
    if (this.tailLength > 0) {
      const take = Math.min(64 - this.tailLength, chunk.length);
      this.tail.set(chunk.subarray(0, take), this.tailLength);
      this.tailLength += take;
      pos = take;
      if (this.tailLength < 64) return this;
      compress(this.h, this.tail, 0, 1);
      this.tailLength = 0;
    }
    const blocks = (chunk.length - pos) >>> 6;
    if (blocks > 0) {
      compress(this.h, chunk, pos, blocks);
      pos += blocks * 64;
    }
    if (pos < chunk.length) {
      this.tail.set(chunk.subarray(pos), 0);
      this.tailLength = chunk.length - pos;
    }
    return this;
  }

  /** The 32-byte digest. The hasher cannot be used afterwards. */
  digest(): Uint8Array {
    if (this.done) throw new Error('Sha256: digest() was already called');
    this.done = true;
    const pad = new Uint8Array(this.tailLength < 56 ? 64 : 128);
    pad.set(this.tail.subarray(0, this.tailLength));
    pad[this.tailLength] = 0x80;
    const view = new DataView(pad.buffer);
    const bitLength = this.total * 8;
    view.setUint32(pad.length - 8, Math.floor(bitLength / 0x100000000));
    view.setUint32(pad.length - 4, bitLength >>> 0);
    compress(this.h, pad, 0, pad.length >>> 6);
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, this.h[i]!);
    return out;
  }
}

/** The SHA-256 digest of the bytes (32 bytes). Full blocks are read in place; only the tail is padded. */
export function sha256Bytes(message: Uint8Array): Uint8Array {
  return new Sha256().update(message).digest();
}

/** Bytes as lower-case hex digits. */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** SHA-256 of a text (UTF-8) as 64 lower-case hex digits. */
export function sha256Hex(text: string): string {
  return toHex(sha256Bytes(new TextEncoder().encode(text)));
}
