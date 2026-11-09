// SHA-256 via WebCrypto (browser and Node 18+) and a small dependency-free MD5 (RFC 1321) so originals can be checked
// against Drive's md5Checksum as well as sha256Checksum. Works on ArrayBuffer / Uint8Array.
export async function sha256Hex(buf) {
  const d = await globalThis.crypto.subtle.digest('SHA-256', buf instanceof ArrayBuffer ? buf : new Uint8Array(buf).buffer);
  return hex(new Uint8Array(d));
}
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const K = new Uint32Array(64).map((_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
const R = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
export function md5Hex(input) {
  const msg = input instanceof Uint8Array ? input : new Uint8Array(input);
  const n = msg.length, padLen = ((n + 8) >>> 6) + 1 << 6;
  const buf = new Uint8Array(padLen); buf.set(msg); buf[n] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(padLen - 8, (n * 8) >>> 0, true); dv.setUint32(padLen - 4, Math.floor(n / 0x20000000), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
      else { F = C ^ (B | ~D); g = (7 * i) & 15; }
      F = (F + A + K[i] + M[g]) >>> 0; A = D; D = C; C = B;
      B = (B + ((F << R[i]) | (F >>> (32 - R[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16), ov = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((v, i) => ov.setUint32(i * 4, v, true));
  return hex(out);
}
export function uuid() {
  if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID().replace(/-/g, '');
  const b = globalThis.crypto.getRandomValues(new Uint8Array(16)); return hex(b);
}
