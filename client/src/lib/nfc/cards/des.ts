// DES / 3DES and the ISO 9797-1 retail MAC (6.5) — just enough for e-passport
// BAC and its secure messaging. The Web Crypto API has no DES, so this is a
// small, self-contained implementation; the Android reader uses javax.crypto
// instead. Correctness is pinned by the ICAO 9303 worked example (bac.test.ts).
//
// Scope: reading the holder's own travel document (ISO/IEC 7816 + ICAO 9303).
// BAC is the document's own access control, keyed from the MRZ the holder has.

/* eslint-disable no-bitwise */

const IP = [58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8, 57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7];
const FP = [40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29, 36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25];
const E = [32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17, 16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1];
const P = [16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25];
const PC1 = [57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36, 63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4];
const PC2 = [14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2, 41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32];
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const SBOX = [
  [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8, 4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5, 0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1, 13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9, 10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6, 4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8, 9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6, 1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2, 7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
];

function bitsOf(bytes: Uint8Array): number[] {
  const out: number[] = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) out.push((b >> i) & 1);
  return out;
}
function bytesOf(bits: number[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < out.length; i++) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j]; out[i] = v; }
  return out;
}
const permute = (bits: number[], table: number[]) => table.map((p) => bits[p - 1]);

function keySchedule(key: Uint8Array): number[][] {
  const k = permute(bitsOf(key), PC1);
  let c = k.slice(0, 28), d = k.slice(28);
  const rounds: number[][] = [];
  for (let i = 0; i < 16; i++) {
    c = c.slice(SHIFTS[i]).concat(c.slice(0, SHIFTS[i]));
    d = d.slice(SHIFTS[i]).concat(d.slice(0, SHIFTS[i]));
    rounds.push(permute(c.concat(d), PC2));
  }
  return rounds;
}

function feistel(r: number[], k: number[]): number[] {
  const x = permute(r, E).map((b, i) => b ^ k[i]);
  const out: number[] = [];
  for (let s = 0; s < 8; s++) {
    const chunk = x.slice(s * 6, s * 6 + 6);
    const row = (chunk[0] << 1) | chunk[5];
    const col = (chunk[1] << 3) | (chunk[2] << 2) | (chunk[3] << 1) | chunk[4];
    const v = SBOX[s][row * 16 + col];
    for (let i = 3; i >= 0; i--) out.push((v >> i) & 1);
  }
  return permute(out, P);
}

function desBlock(block: Uint8Array, rounds: number[][], decrypt: boolean): Uint8Array<ArrayBuffer> {
  let bits = permute(bitsOf(block), IP);
  let l = bits.slice(0, 32), r = bits.slice(32);
  for (let i = 0; i < 16; i++) {
    const k = rounds[decrypt ? 15 - i : i];
    const next = l.map((b, j) => b ^ feistel(r, k)[j]);
    l = r; r = next;
  }
  bits = permute(r.concat(l), FP);
  return bytesOf(bits);
}

function xor(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

/** A 3DES-EDE key: 16 bytes (2-key, K1K2K1) or 24 bytes (3-key). */
function keys3(key: Uint8Array): [Uint8Array, Uint8Array, Uint8Array] {
  if (key.length === 16) return [key.slice(0, 8), key.slice(8, 16), key.slice(0, 8)];
  if (key.length === 24) return [key.slice(0, 8), key.slice(8, 16), key.slice(16, 24)];
  if (key.length === 8) return [key, key, key];
  throw new Error("DES key must be 8, 16 or 24 bytes");
}

/** 3DES-CBC over whole blocks (length a multiple of 8), IV default zeros. */
export function tdesCbcEncrypt(key: Uint8Array, data: Uint8Array, iv = new Uint8Array(8)): Uint8Array {
  const [k1, k2, k3] = keys3(key);
  const s1 = keySchedule(k1), s2 = keySchedule(k2), s3 = keySchedule(k3);
  const out = new Uint8Array(data.length);
  let prev = iv;
  for (let i = 0; i < data.length; i += 8) {
    const b = xor(data.slice(i, i + 8), prev);
    const c = desBlock(desBlock(desBlock(b, s1, false), s2, true), s3, false); // E-D-E
    out.set(c, i);
    prev = c;
  }
  return out;
}

export function tdesCbcDecrypt(key: Uint8Array, data: Uint8Array, iv = new Uint8Array(8)): Uint8Array {
  const [k1, k2, k3] = keys3(key);
  const s1 = keySchedule(k1), s2 = keySchedule(k2), s3 = keySchedule(k3);
  const out = new Uint8Array(data.length);
  let prev = iv;
  for (let i = 0; i < data.length; i += 8) {
    const c = data.slice(i, i + 8);
    const b = xor(desBlock(desBlock(desBlock(c, s3, true), s2, false), s1, true), prev); // D-E-D
    out.set(b, i);
    prev = c;
  }
  return out;
}

/** ISO 9797-1 padding, method 2: append 0x80 then 0x00 to the next 8-byte block. */
export function pad(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + (8 - (data.length % 8)));
  out.set(data);
  out[data.length] = 0x80;
  return out;
}

/** Drops ISO 9797-1 method-2 padding (the last 0x80 … 0x00). */
export function unpad(data: Uint8Array): Uint8Array {
  let i = data.length - 1;
  while (i >= 0 && data[i] === 0x00) i--;
  return i >= 0 && data[i] === 0x80 ? data.slice(0, i) : data;
}

/**
 * ISO 9797-1 MAC algorithm 3 (retail MAC) with DES and 2-key 3DES final step —
 * the passport's secure-messaging MAC. The data must already be padded.
 */
export function retailMac(key: Uint8Array, dataPadded: Uint8Array): Uint8Array {
  const k1 = key.slice(0, 8), k2 = key.slice(8, 16);
  const s1 = keySchedule(k1), s2 = keySchedule(k2);
  let y = new Uint8Array(8);
  for (let i = 0; i < dataPadded.length; i += 8) y = desBlock(xor(dataPadded.slice(i, i + 8), y), s1, false);
  return desBlock(desBlock(y, s2, true), s1, false); // E(k1) D(k2) E(k1) y
}

/** A single-block 3DES-EDE encryption (zero IV) — for tests / key checks. */
export function tdesEncryptBlock(key: Uint8Array, block: Uint8Array): Uint8Array {
  return tdesCbcEncrypt(key, block);
}
