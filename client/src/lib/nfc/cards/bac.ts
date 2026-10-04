// BAC — Basic Access Control (6.5), ICAO 9303 Part 11. The holder opens their
// own travel document with the key the MRZ carries (passport number, date of
// birth, date of expiry): a mutual authentication yields session keys, and
// every later APDU is wrapped in secure messaging. This is the document's own
// access mechanism, not a bypass — and it only reads (DG1 the MRZ, DG2 the
// face). Pinned by the ICAO 9303 worked example (test/nfc-bac.test.ts).

import { concat, hex } from "./apdu";
import { pad, retailMac, tdesCbcDecrypt, tdesCbcEncrypt } from "./des";

async function sha1(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-1", data as unknown as ArrayBuffer));
}

const ascii = (s: string) => new TextEncoder().encode(s);

/* ------------------------------------------------------------ the MRZ key */

export type MrzKey = { documentNumber: string; dateOfBirth: string; dateOfExpiry: string };

const CHECK_VALUES: Record<string, number> = {};
for (let i = 0; i <= 9; i++) CHECK_VALUES[String(i)] = i;
for (let i = 0; i < 26; i++) CHECK_VALUES[String.fromCharCode(65 + i)] = 10 + i;
CHECK_VALUES["<"] = 0;

/** ICAO check digit (weights 7,3,1) over A–Z, 0–9 and '<'. */
export function checkDigit(field: string): string {
  const w = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < field.length; i++) sum += (CHECK_VALUES[field[i].toUpperCase()] ?? 0) * w[i % 3];
  return String(sum % 10);
}

/** The MRZ information string the BAC seed is hashed from. */
export function mrzInformation(key: MrzKey): string {
  const doc = key.documentNumber.toUpperCase().replace(/[^A-Z0-9<]/g, "").padEnd(9, "<").slice(0, 9);
  const dob = key.dateOfBirth.replace(/\D/g, "").slice(0, 6);
  const exp = key.dateOfExpiry.replace(/\D/g, "").slice(0, 6);
  return `${doc}${checkDigit(doc)}${dob}${checkDigit(dob)}${exp}${checkDigit(exp)}`;
}

/** Reads the BAC key fields out of a 2- or 3-line MRZ (TD1/TD2/TD3). */
export function mrzKeyFromMrz(mrz: string): MrzKey | null {
  const lines = mrz.toUpperCase().split(/\r?\n/).map((l) => l.replace(/\s/g, "")).filter(Boolean);
  if (lines.length === 2 && lines[0].length >= 36 && lines[1].length >= 36) {
    // TD2 (ID card, 2×36) — doc number at 0..8 of line 2, dob 13..18, expiry 21..26.
    const l2 = lines[1];
    return { documentNumber: l2.slice(0, 9).replace(/</g, ""), dateOfBirth: l2.slice(13, 19), dateOfExpiry: l2.slice(21, 27) };
  }
  if (lines.length === 2 && lines[0].length >= 30) {
    // TD1 (ID card, 3×30 — but sometimes supplied as 2 lines joined); doc number line1 5..13.
    const l1 = lines[0], l2 = lines[1];
    return { documentNumber: l1.slice(5, 14).replace(/</g, ""), dateOfBirth: l2.slice(0, 6), dateOfExpiry: l2.slice(8, 14) };
  }
  if (lines.length === 3 && lines[0].length >= 30) {
    const l1 = lines[0], l2 = lines[1];
    return { documentNumber: l1.slice(5, 14).replace(/</g, ""), dateOfBirth: l2.slice(0, 6), dateOfExpiry: l2.slice(8, 14) };
  }
  if (lines.length >= 2 && lines[1].length >= 28) {
    // TD3 (passport, 2×44): line 2 — doc number 0..8, dob 13..18, expiry 21..26.
    const l2 = lines[1];
    return { documentNumber: l2.slice(0, 9).replace(/</g, ""), dateOfBirth: l2.slice(13, 19), dateOfExpiry: l2.slice(21, 27) };
  }
  return null;
}

/* ------------------------------------------------------------ key derivation */

/** Sets each byte's DES parity bit (odd parity). */
export function fixParity(k: Uint8Array): Uint8Array {
  const out = k.slice();
  for (let i = 0; i < out.length; i++) { let b = out[i] & 0xfe, ones = 0; for (let j = 1; j < 8; j++) ones += (b >> j) & 1; out[i] = b | (ones % 2 === 0 ? 1 : 0); }
  return out;
}

/** Derives one 16-byte 2-key 3DES key from a seed and a counter (1 = enc, 2 = mac). */
export async function deriveKey(seed: Uint8Array, counter: 1 | 2): Promise<Uint8Array> {
  const d = concat(seed, Uint8Array.from([0, 0, 0, counter]));
  const h = await sha1(d);
  return fixParity(concat(h.slice(0, 8), h.slice(8, 16)));
}

/** Kenc and Kmac from the MRZ information (the BAC seed = SHA1(MRZ info)[0:16]). */
export async function bacKeys(key: MrzKey): Promise<{ kenc: Uint8Array; kmac: Uint8Array; seed: Uint8Array }> {
  const seed = (await sha1(ascii(mrzInformation(key)))).slice(0, 16);
  return { kenc: await deriveKey(seed, 1), kmac: await deriveKey(seed, 2), seed };
}

/* ------------------------------------------------- mutual authentication */

/** The EXTERNAL AUTHENTICATE command data (Eifd || Mifd) for a mutual auth. */
export function mutualAuthCommand(kenc: Uint8Array, kmac: Uint8Array, rndIfd: Uint8Array, rndIcc: Uint8Array, kifd: Uint8Array): Uint8Array {
  const s = concat(rndIfd, rndIcc, kifd);
  const eifd = tdesCbcEncrypt(kenc, s);
  const mifd = retailMac(kmac, pad(eifd));
  return concat(eifd, mifd);
}

export type BacSession = { ksenc: Uint8Array; ksmac: Uint8Array; ssc: Uint8Array };

/** Verifies the chip's answer and derives the session keys + the SSC. */
export async function sessionFromAuth(
  kenc: Uint8Array, kmac: Uint8Array, rndIfd: Uint8Array, rndIcc: Uint8Array, kifd: Uint8Array, response: Uint8Array,
): Promise<BacSession> {
  if (response.length < 40) throw new Error("mutual authenticate answer too short");
  const eicc = response.slice(0, 32), micc = response.slice(32, 40);
  if (hex(retailMac(kmac, pad(eicc))) !== hex(micc)) throw new Error("the document's MAC did not verify (wrong MRZ?)");
  const r = tdesCbcDecrypt(kenc, eicc);
  const rndIfdBack = r.slice(8, 16), kicc = r.slice(16, 32);
  if (hex(rndIfdBack) !== hex(rndIfd)) throw new Error("the document did not echo our nonce (wrong MRZ?)");
  const seed = kifd.map((b, i) => b ^ kicc[i]) as unknown as Uint8Array;
  const ksenc = await deriveKey(Uint8Array.from(seed), 1);
  const ksmac = await deriveKey(Uint8Array.from(seed), 2);
  const ssc = concat(rndIcc.slice(4, 8), rndIfd.slice(4, 8));
  return { ksenc, ksmac, ssc };
}

/* --------------------------------------------------------- secure messaging */

function incSsc(ssc: Uint8Array): void {
  for (let i = ssc.length - 1; i >= 0; i--) { ssc[i] = (ssc[i] + 1) & 0xff; if (ssc[i] !== 0) break; }
}
const len1 = (n: number) => Uint8Array.from(n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff]);

/** Wraps a plain [CLA INS P1 P2 (Lc data)(Le)] APDU in secure messaging. */
export function protectApdu(s: BacSession, apduBytes: Uint8Array): Uint8Array {
  const cla = apduBytes[0] | 0x0c, ins = apduBytes[1], p1 = apduBytes[2], p2 = apduBytes[3];
  // Split the body into command data and Le (the reader only sends short APDUs here).
  let data: Uint8Array = new Uint8Array(0), le: number | null = null;
  if (apduBytes.length === 5) le = apduBytes[4];
  else if (apduBytes.length > 5) { const lc = apduBytes[4]; data = apduBytes.slice(5, 5 + lc); if (apduBytes.length > 5 + lc) le = apduBytes[5 + lc]; }
  incSsc(s.ssc);
  const header = pad(Uint8Array.from([cla, ins, p1, p2]));
  let do87: Uint8Array = new Uint8Array(0), do97: Uint8Array = new Uint8Array(0);
  if (data.length) { const enc = tdesCbcEncrypt(s.ksenc, pad(data)); const body = concat(Uint8Array.from([0x01]), enc); do87 = concat(Uint8Array.from([0x87]), len1(body.length), body); }
  if (le !== null) do97 = Uint8Array.from([0x97, 0x01, le]);
  const n = pad(concat(s.ssc, header, do87, do97));
  const cc = retailMac(s.ksmac, n);
  const do8e = concat(Uint8Array.from([0x8e, 0x08]), cc);
  const body = concat(do87, do97, do8e);
  return concat(Uint8Array.from([cla, ins, p1, p2]), len1(body.length), body, Uint8Array.from([0x00]));
}

/** Unwraps a secure-messaging response → the plaintext data and the real SW. */
export function unprotectResponse(s: BacSession, resp: Uint8Array): { data: Uint8Array; sw: number } {
  const sw = (resp[resp.length - 2] << 8) | resp[resp.length - 1];
  const body = resp.slice(0, resp.length - 2);
  incSsc(s.ssc);
  let i = 0;
  let do87: Uint8Array = new Uint8Array(0), do99: Uint8Array = new Uint8Array(0), do8e: Uint8Array = new Uint8Array(0), encData: Uint8Array = new Uint8Array(0);
  const readLen = (): number => { let L = body[i++]; if (L === 0x81) L = body[i++]; else if (L === 0x82) { L = (body[i++] << 8) | body[i++]; } return L; };
  while (i < body.length) {
    const tag = body[i++];
    const L = readLen();
    const v = body.slice(i, i + L); i += L;
    if (tag === 0x87) { do87 = concat(Uint8Array.from([0x87]), len1(L), v); encData = v.slice(1); }
    else if (tag === 0x99) do99 = concat(Uint8Array.from([0x99]), len1(L), v);
    else if (tag === 0x8e) do8e = v;
  }
  const n = pad(concat(s.ssc, do87, do99));
  if (do8e.length && hex(retailMac(s.ksmac, n)) !== hex(do8e)) throw new Error("secure-messaging MAC did not verify");
  if (encData.length === 0) return { data: new Uint8Array(0), sw };
  const dec = tdesCbcDecrypt(s.ksenc, encData);
  return { data: unpadLocal(dec), sw };
}

function unpadLocal(d: Uint8Array): Uint8Array {
  let i = d.length - 1;
  while (i >= 0 && d[i] === 0x00) i--;
  return i >= 0 && d[i] === 0x80 ? d.slice(0, i) : d;
}
