// The M5Cet card — the app's own encrypted format on an NFC tag (6.3).
//
// A card holds one or more RECORDS, each encrypted on its own so a card can
// mix things (a Wi-Fi login next to a contact) and a one-time record can be
// erased without touching the rest. The layout is a plain binary container so
// the same bytes ride an NDEF external-type record, a raw memory dump, or a
// file — and so the Android port (nfc/M5Card.java) reads byte-for-byte the
// same thing. Nothing here is web- or NDEF-specific.
//
//   container = "M5CD" | ver(1) | flags(1) | count(1) | record*
//   record    = type(1) | mode(1) | rflags(1) | id(3) | salt(1+n) | iv(1+n)
//               | ct(u16 BE + bytes)            ct = AES-GCM(plaintext)
//               AAD = "M5CD" | ver | type | id
//
// Two ways to get a record's key:
//   external (PIN)     PBKDF2-SHA256(pin, salt, 600k) → AES-GCM-256. A 6–18
//                      digit code, so the card opens on ANY device.
//   internal (passkey) the key comes from the signed-in account's root
//                      (HKDF(root, salt, "m5cet:nfc:card:v1")) — the card
//                      opens only on this user's own devices. The caller
//                      passes that key provider; this module never sees the
//                      account.
//
// A record can be marked one-time (rflags bit 0): after the user has seen it,
// the reader rewrites the card without it (removeRecord + write).

import { toBase64, fromBase64, type Bytes } from "../crypto";

export const M5CARD_MAGIC = "M5CD";
export const M5CARD_VERSION = 1;
/** NDEF external type that carries a container (urn:nfc:ext:m5cet.cz:card). */
export const M5CARD_EXTERNAL_TYPE = "m5cet.cz:card";
export const PBKDF2_ROUNDS = 600_000;

/** What a record holds. The wire value (number) is fixed — never renumber. */
export const M5_RECORD_TYPES = {
  "passkey-backup": 1,
  "identity-backup": 2,
  "one-time-message": 3,
  message: 4,
  "server-room": 5,
  "external-key": 6,
  contact: 7,
  wifi: 8,
  "url-login": 9,
} as const;

export type M5RecordType = keyof typeof M5_RECORD_TYPES;
const TYPE_BY_CODE = new Map<number, M5RecordType>(
  (Object.entries(M5_RECORD_TYPES) as [M5RecordType, number][]).map(([k, v]) => [v, k]),
);

export type M5CardMode = "external" | "internal";
const MODE_CODE: Record<M5CardMode, number> = { external: 0, internal: 1 };

/** One record as the app works with it (plaintext side). `data` is the
 *  record's own JSON shape — see the type guides in nfc/records. */
export type M5Record = {
  id: number;
  type: M5RecordType;
  mode: M5CardMode;
  /** Erase this record from the card once the user has seen it. */
  oneTime?: boolean;
  data: unknown;
};

/** A record still sealed (as read off the card, before the key is known). */
export type SealedRecord = {
  id: number;
  type: M5RecordType;
  mode: M5CardMode;
  oneTime: boolean;
  salt: Bytes;
  iv: Bytes;
  ct: Bytes;
};

/** A key for one record, given its salt. `internal` records call the account. */
export type CardKeyProvider = (mode: M5CardMode, salt: Bytes) => Promise<CryptoKey>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

export function isValidCardPin(pin: string): boolean {
  return /^[0-9]{6,18}$/.test(pin);
}

/** external (PIN) key: PBKDF2-SHA256(pin, salt, 600k) → AES-GCM-256. */
export async function pinCardKey(pin: string, salt: Bytes): Promise<CryptoKey> {
  if (!isValidCardPin(pin)) throw new Error("A card PIN is 6–18 digits.");
  const material = await crypto.subtle.importKey("raw", encoder.encode(pin), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ROUNDS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** internal (passkey) key: HKDF(root, salt, "m5cet:nfc:card:v1") → AES-GCM-256. */
export async function accountCardKey(root: Bytes, salt: Bytes): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", root as BufferSource, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: encoder.encode("m5cet:nfc:card:v1") },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** A key provider that opens external records with `pin` and internal ones
 *  with `root` (the account's, or null when not signed in). */
export function cardKeys(pin: string | null, root: Bytes | null): CardKeyProvider {
  return (mode, salt) => {
    if (mode === "internal") {
      if (!root) throw new Error("This record needs your account (sign in on this device).");
      return accountCardKey(root, salt);
    }
    if (!pin) throw new Error("This record needs a PIN.");
    return pinCardKey(pin, salt);
  };
}

function aad(type: number, id: number): Bytes {
  const b = new Uint8Array(9);
  b.set(ascii(M5CARD_MAGIC), 0);
  b[4] = M5CARD_VERSION;
  b[5] = type;
  b[6] = (id >>> 16) & 0xff;
  b[7] = (id >>> 8) & 0xff;
  b[8] = id & 0xff;
  return b;
}

function randomId(): number {
  const b = crypto.getRandomValues(new Uint8Array(3));
  return (b[0] << 16) | (b[1] << 8) | b[2];
}

/* --------------------------------------------------------------- encrypt */

/** Seals one record: fresh salt and iv, AES-GCM with the record's AAD. */
export async function sealRecord(rec: M5Record, keys: CardKeyProvider): Promise<SealedRecord> {
  const type = M5_RECORD_TYPES[rec.type];
  const id = rec.id || randomId();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keys(rec.mode, salt);
  const plain = encoder.encode(JSON.stringify(rec.data ?? {}));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: aad(type, id) as BufferSource }, key, plain),
  );
  return { id, type: rec.type, mode: rec.mode, oneTime: !!rec.oneTime, salt, iv, ct };
}

export async function openRecord(sealed: SealedRecord, keys: CardKeyProvider): Promise<M5Record> {
  const key = await keys(sealed.mode, sealed.salt);
  const type = M5_RECORD_TYPES[sealed.type];
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: sealed.iv as BufferSource, additionalData: aad(type, sealed.id) as BufferSource },
      key,
      sealed.ct as BufferSource,
    );
  } catch {
    throw new Error(sealed.mode === "internal" ? "This card was not written by this account." : "Wrong PIN, or the record is damaged.");
  }
  return { id: sealed.id, type: sealed.type, mode: sealed.mode, oneTime: sealed.oneTime, data: JSON.parse(decoder.decode(plain)) };
}

/* -------------------------------------------------------- container bytes */

class Writer {
  private parts: number[] = [];
  u8(n: number) { this.parts.push(n & 0xff); }
  bytes(b: Bytes) { for (const x of b) this.parts.push(x); }
  lenBytes(b: Bytes) { this.u8(b.length); this.bytes(b); }
  u16(n: number) { this.u8((n >>> 8) & 0xff); this.u8(n & 0xff); }
  done(): Bytes { return Uint8Array.from(this.parts); }
}

class Reader {
  private at = 0;
  constructor(private b: Bytes) {}
  private need(n: number) { if (this.at + n > this.b.length) throw new Error("M5Cet card is truncated."); }
  u8(): number { this.need(1); return this.b[this.at++]; }
  u16(): number { return (this.u8() << 8) | this.u8(); }
  take(n: number): Bytes { this.need(n); const s = this.b.subarray(this.at, this.at + n); this.at += n; return s; }
  lenBytes(): Bytes { return this.take(this.u8()); }
  get remaining(): number { return this.b.length - this.at; }
}

/** The container bytes for a set of sealed records (≤ 64). */
export function encodeContainer(records: SealedRecord[]): Bytes {
  if (records.length > 64) throw new Error("A card holds at most 64 records.");
  const w = new Writer();
  w.bytes(ascii(M5CARD_MAGIC));
  w.u8(M5CARD_VERSION);
  w.u8(0);
  w.u8(records.length);
  for (const r of records) {
    w.u8(M5_RECORD_TYPES[r.type]);
    w.u8(MODE_CODE[r.mode]);
    w.u8(r.oneTime ? 1 : 0);
    w.u8((r.id >>> 16) & 0xff); w.u8((r.id >>> 8) & 0xff); w.u8(r.id & 0xff);
    w.lenBytes(r.salt);
    w.lenBytes(r.iv);
    w.u16(r.ct.length);
    w.bytes(r.ct);
  }
  return w.done();
}

/** Whether a blob looks like an M5Cet container. */
export function isM5Card(bytes: Bytes): boolean {
  return bytes.length >= 7 && String.fromCharCode(...bytes.subarray(0, 4)) === M5CARD_MAGIC;
}

export function decodeContainer(bytes: Bytes): SealedRecord[] {
  const r = new Reader(bytes);
  if (String.fromCharCode(r.u8(), r.u8(), r.u8(), r.u8()) !== M5CARD_MAGIC) throw new Error("Not an M5Cet card.");
  const ver = r.u8();
  if (ver !== M5CARD_VERSION) throw new Error(`M5Cet card version ${ver} is not supported.`);
  r.u8(); // flags
  const count = r.u8();
  const out: SealedRecord[] = [];
  for (let i = 0; i < count; i++) {
    const typeCode = r.u8();
    const type = TYPE_BY_CODE.get(typeCode);
    const modeCode = r.u8();
    const oneTime = r.u8() === 1;
    const id = (r.u8() << 16) | (r.u8() << 8) | r.u8();
    const salt = r.lenBytes();
    const iv = r.lenBytes();
    const ct = r.take(r.u16());
    if (!type || (modeCode !== 0 && modeCode !== 1)) continue; // an unknown record type is skipped, not fatal
    out.push({ id, type, mode: modeCode === 0 ? "external" : "internal", oneTime, salt, iv, ct });
  }
  return out;
}

/** The container with one sealed record removed (a one-time record after it
 *  was shown). The bytes are meant to be written back to the card. */
export function removeRecord(bytes: Bytes, id: number): Bytes {
  return encodeContainer(decodeContainer(bytes).filter((r) => r.id !== id));
}

/* --------------------------------------------------------------- helpers */

/** The container as a base64 string (for an NDEF text/URI fallback or a file). */
export function containerToBase64(bytes: Bytes): string { return toBase64(bytes); }
export function containerFromBase64(text: string): Bytes { return fromBase64(text); }

/** Builds a whole card from plaintext records in one go. */
export async function buildCard(records: M5Record[], keys: CardKeyProvider): Promise<Bytes> {
  const sealed = await Promise.all(records.map((r) => sealRecord(r, keys)));
  return encodeContainer(sealed);
}
