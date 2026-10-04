// AES (FIPS-197) and AES-CMAC (RFC 4493 / NIST SP 800-38B) (6.6) — raw
// blocks for PACE and its secure messaging. Web Crypto's AES-CBC always adds
// PKCS#7 padding and is async; PACE needs single blocks, CBC with an explicit
// IV and no padding, and CMAC — so, like des.ts, this is a small
// self-contained implementation (the Android reader uses javax.crypto).
// Pinned by the FIPS-197 / SP 800-38A / RFC 4493 vectors and cross-checked
// against node:crypto (test/nfc-pace.test.ts).

/* eslint-disable no-bitwise */

const xtime = (b: number) => ((b << 1) ^ (b & 0x80 ? 0x1b : 0)) & 0xff;
const rotl8 = (x: number, s: number) => ((x << s) | (x >> (8 - s))) & 0xff;

/** GF(2^8) multiplication (for the InvMixColumns tables). */
function gmul(a: number, b: number): number {
  let r = 0;
  for (; b; b >>= 1) { if (b & 1) r ^= a; a = xtime(a); }
  return r;
}

// The S-box from multiplicative inverses + the affine map (FIPS-197 §5.1.1),
// built once: p walks the group by ×3 while q walks it by ÷3, so q = p⁻¹.
const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
{
  let p = 1, q = 1;
  do {
    p = (p ^ (p << 1) ^ (p & 0x80 ? 0x1b : 0)) & 0xff;
    q = (q ^ (q << 1)) & 0xff; q = (q ^ (q << 2)) & 0xff; q = (q ^ (q << 4)) & 0xff; if (q & 0x80) q ^= 0x09;
    const s = q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4) ^ 0x63;
    SBOX[p] = s; INV_SBOX[s] = p;
  } while (p !== 1);
  SBOX[0] = 0x63; INV_SBOX[0x63] = 0;
}
const M9 = new Uint8Array(256), M11 = new Uint8Array(256), M13 = new Uint8Array(256), M14 = new Uint8Array(256);
for (let i = 0; i < 256; i++) { M9[i] = gmul(i, 9); M11[i] = gmul(i, 11); M13[i] = gmul(i, 13); M14[i] = gmul(i, 14); }

/** An expanded key: the round count and the round keys, 16 bytes each. */
export type AesKey = { rounds: number; w: Uint8Array };

/** Key expansion (FIPS-197 §5.2) for 16-, 24- or 32-byte keys. */
export function aesKey(key: Uint8Array): AesKey {
  const nk = key.length / 4;
  if (nk !== 4 && nk !== 6 && nk !== 8) throw new Error("AES key must be 16, 24 or 32 bytes");
  const rounds = nk + 6;
  const w = new Uint8Array(16 * (rounds + 1));
  w.set(key);
  let rcon = 1;
  for (let i = nk; i < 4 * (rounds + 1); i++) {
    let t0 = w[4 * i - 4], t1 = w[4 * i - 3], t2 = w[4 * i - 2], t3 = w[4 * i - 1];
    if (i % nk === 0) {
      const t = t0; // RotWord, SubWord, Rcon
      t0 = SBOX[t1] ^ rcon; t1 = SBOX[t2]; t2 = SBOX[t3]; t3 = SBOX[t];
      rcon = xtime(rcon);
    } else if (nk > 6 && i % nk === 4) {
      t0 = SBOX[t0]; t1 = SBOX[t1]; t2 = SBOX[t2]; t3 = SBOX[t3];
    }
    const j = 4 * (i - nk);
    w[4 * i] = w[j] ^ t0; w[4 * i + 1] = w[j + 1] ^ t1; w[4 * i + 2] = w[j + 2] ^ t2; w[4 * i + 3] = w[j + 3] ^ t3;
  }
  return { rounds, w };
}

type KeyLike = Uint8Array | AesKey;
const schedule = (k: KeyLike): AesKey => (k instanceof Uint8Array ? aesKey(k) : k);

// The state is the 16 input bytes in order: byte r + 4c is row r, column c.

function encryptBlock(k: AesKey, input: Uint8Array, off: number, out: Uint8Array, outOff: number): void {
  const s = new Uint8Array(16), t = new Uint8Array(16);
  for (let i = 0; i < 16; i++) s[i] = input[off + i] ^ k.w[i];
  for (let round = 1; round <= k.rounds; round++) {
    // SubBytes + ShiftRows (row r rotates left by r).
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) t[r + 4 * c] = SBOX[s[r + 4 * ((c + r) & 3)]];
    if (round !== k.rounds) {
      // MixColumns: b0 = 2a0 ^ 3a1 ^ a2 ^ a3, …
      for (let c = 0; c < 16; c += 4) {
        const a0 = t[c], a1 = t[c + 1], a2 = t[c + 2], a3 = t[c + 3], x = a0 ^ a1 ^ a2 ^ a3;
        t[c] = a0 ^ x ^ xtime(a0 ^ a1); t[c + 1] = a1 ^ x ^ xtime(a1 ^ a2);
        t[c + 2] = a2 ^ x ^ xtime(a2 ^ a3); t[c + 3] = a3 ^ x ^ xtime(a3 ^ a0);
      }
    }
    for (let i = 0; i < 16; i++) s[i] = t[i] ^ k.w[16 * round + i];
  }
  out.set(s, outOff);
}

function decryptBlock(k: AesKey, input: Uint8Array, off: number, out: Uint8Array, outOff: number): void {
  const s = new Uint8Array(16), t = new Uint8Array(16);
  for (let i = 0; i < 16; i++) s[i] = input[off + i] ^ k.w[16 * k.rounds + i];
  for (let round = k.rounds - 1; round >= 0; round--) {
    // InvShiftRows + InvSubBytes, then AddRoundKey.
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) t[r + 4 * c] = INV_SBOX[s[r + 4 * ((c - r + 4) & 3)]] ^ k.w[16 * round + r + 4 * c];
    if (round === 0) { s.set(t); break; }
    // InvMixColumns: b0 = 14a0 ^ 11a1 ^ 13a2 ^ 9a3, …
    for (let c = 0; c < 16; c += 4) {
      const a0 = t[c], a1 = t[c + 1], a2 = t[c + 2], a3 = t[c + 3];
      s[c] = M14[a0] ^ M11[a1] ^ M13[a2] ^ M9[a3];
      s[c + 1] = M9[a0] ^ M14[a1] ^ M11[a2] ^ M13[a3];
      s[c + 2] = M13[a0] ^ M9[a1] ^ M14[a2] ^ M11[a3];
      s[c + 3] = M11[a0] ^ M13[a1] ^ M9[a2] ^ M14[a3];
    }
  }
  out.set(s, outOff);
}

function checkBlocks(data: Uint8Array, iv: Uint8Array): void {
  if (data.length % 16) throw new Error("AES-CBC data must be a whole number of 16-byte blocks");
  if (iv.length !== 16) throw new Error("AES IV must be 16 bytes");
}

/** One block, AES-ECB. */
export function aesEncryptBlock(key: KeyLike, block: Uint8Array): Uint8Array {
  if (block.length !== 16) throw new Error("AES block must be 16 bytes");
  const out = new Uint8Array(16);
  encryptBlock(schedule(key), block, 0, out, 0);
  return out;
}

export function aesDecryptBlock(key: KeyLike, block: Uint8Array): Uint8Array {
  if (block.length !== 16) throw new Error("AES block must be 16 bytes");
  const out = new Uint8Array(16);
  decryptBlock(schedule(key), block, 0, out, 0);
  return out;
}

/** AES-CBC over whole blocks, no padding; IV default zeros. */
export function aesCbcEncrypt(key: KeyLike, data: Uint8Array, iv: Uint8Array = new Uint8Array(16)): Uint8Array {
  checkBlocks(data, iv);
  const k = schedule(key);
  const out = new Uint8Array(data.length);
  const x = new Uint8Array(16);
  let prev: Uint8Array = iv, prevOff = 0;
  for (let i = 0; i < data.length; i += 16) {
    for (let j = 0; j < 16; j++) x[j] = data[i + j] ^ prev[prevOff + j];
    encryptBlock(k, x, 0, out, i);
    prev = out; prevOff = i;
  }
  return out;
}

export function aesCbcDecrypt(key: KeyLike, data: Uint8Array, iv: Uint8Array = new Uint8Array(16)): Uint8Array {
  checkBlocks(data, iv);
  const k = schedule(key);
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 16) {
    decryptBlock(k, data, i, out, i);
    const prev = i ? data.subarray(i - 16, i) : iv;
    for (let j = 0; j < 16; j++) out[i + j] ^= prev[j];
  }
  return out;
}

/** Doubling in GF(2^128) — the CMAC subkey step. */
function dbl(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = ((b[i] << 1) | (i < 15 ? b[i + 1] >> 7 : 0)) & 0xff;
  if (b[0] & 0x80) out[15] ^= 0x87;
  return out;
}

/** AES-CMAC (RFC 4493): the full 16-byte tag (PACE and its SM use the first 8). */
export function aesCmac(key: KeyLike, data: Uint8Array): Uint8Array {
  const k = schedule(key);
  const k1 = dbl(aesEncryptBlock(k, new Uint8Array(16)));
  const k2 = dbl(k1);
  const n = Math.max(1, Math.ceil(data.length / 16));
  const complete = data.length > 0 && data.length % 16 === 0;
  // The last block: XOR K1 when complete, else 10* padding and XOR K2.
  const last = new Uint8Array(16);
  const tail = data.subarray((n - 1) * 16);
  last.set(tail);
  if (!complete) last[tail.length] = 0x80;
  const sub = complete ? k1 : k2;
  for (let j = 0; j < 16; j++) last[j] ^= sub[j];
  const x = new Uint8Array(16);
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < 16; j++) x[j] ^= data[i * 16 + j];
    encryptBlock(k, x, 0, x, 0);
  }
  for (let j = 0; j < 16; j++) x[j] ^= last[j];
  encryptBlock(k, x, 0, x, 0);
  return x;
}
