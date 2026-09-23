// Device identity: who wrote a message, independent of the room key.
//
// Everyone in a room holds the same key, so the key alone cannot tell
// Alice from someone typing "Alice". Each browser profile therefore has an
// ECDSA P-256 key pair: the private key is generated non-extractable and
// kept in IndexedDB (it can sign, it can never be read out, not even by
// this code); the public key travels, signed bodies inside the encrypted
// envelopes (envelope.ts) prove which device wrote them.
//
// Trust on first use: the first verified key seen for a name in a room is
// pinned; a later message under the same name with another key is flagged
// ("identity changed"), as SSH does for hosts. Two people can compare a
// safety number — derived from both public keys — out of band to rule out
// an impostor altogether.
//
// Without IndexedDB (private mode in some browsers) the identity lives for
// this page only; messages are still signed, the pin just cannot outlive
// the tab.

import { fromBase64, toBase64, type Bytes } from "./crypto";

const DB_NAME = "m5cet-identity";
const STORE = "keys";
const KEY_ID = "device";
const ALG = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

export type Identity = {
  /** SPKI, base64. */
  publicKey: string;
  /** Short stable id of the public key (base64url of SHA-256, 16 chars). */
  kid: string;
  /** Grouped hex of the key hash, for people to compare. */
  fingerprint: string;
  persistent: boolean;
  sign(data: Bytes): Promise<string>;
};

type StoredPair = { id: string; privateKey: CryptoKey; publicKey: string; createdAt: number };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: "id" }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = run(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(req ? req.result : undefined); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  });
}

const b64url = (s: string) => s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function keyId(publicKey: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", fromBase64(publicKey)));
  return b64url(toBase64(digest)).slice(0, 16);
}

export async function keyFingerprint(publicKey: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", fromBase64(publicKey)));
  const hexed = Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return hexed.match(/.{4}/g)!.join(" ");
}

async function fromPair(privateKey: CryptoKey, publicKey: string, persistent: boolean): Promise<Identity> {
  return {
    publicKey,
    kid: await keyId(publicKey),
    fingerprint: await keyFingerprint(publicKey),
    persistent,
    async sign(data) {
      return toBase64(new Uint8Array(await crypto.subtle.sign(SIGN, privateKey, data)));
    },
  };
}

async function generate(): Promise<{ privateKey: CryptoKey; publicKey: string }> {
  const pair = await crypto.subtle.generateKey(ALG, false, ["sign", "verify"]) as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: toBase64(spki) };
}

let loading: Promise<Identity> | null = null;

/** This device's identity, created on first use. */
export function loadIdentity(): Promise<Identity> {
  return (loading ??= (async () => {
    try {
      const row = await idb<StoredPair>("readonly", (s) => s.get(KEY_ID));
      if (row?.privateKey && typeof row.publicKey === "string") return fromPair(row.privateKey, row.publicKey, true);
      const fresh = await generate();
      await idb("readwrite", (s) => s.put({ id: KEY_ID, privateKey: fresh.privateKey, publicKey: fresh.publicKey, createdAt: Date.now() } satisfies StoredPair));
      return fromPair(fresh.privateKey, fresh.publicKey, true);
    } catch {
      const fresh = await generate();
      return fromPair(fresh.privateKey, fresh.publicKey, false);
    }
  })());
}

/** Forgets the identity (Clear & Quit). The next load makes a new one. */
export async function forgetIdentity(): Promise<void> {
  loading = null;
  try { await idb("readwrite", (s) => s.delete(KEY_ID)); } catch { /* nothing stored */ }
}

/** Tests: start from nothing without touching IndexedDB. */
export function _resetIdentityForTests(): void {
  loading = null;
}

const verifyKeys = new Map<string, Promise<CryptoKey>>();

export async function verifySignature(publicKey: string, data: Bytes, signature: string): Promise<boolean> {
  let key = verifyKeys.get(publicKey);
  if (!key) {
    key = crypto.subtle.importKey("spki", fromBase64(publicKey), ALG, false, ["verify"]);
    verifyKeys.set(publicKey, key);
    if (verifyKeys.size > 500) verifyKeys.delete(verifyKeys.keys().next().value!);
  }
  try {
    return await crypto.subtle.verify(SIGN, await key, fromBase64(signature), data);
  } catch {
    verifyKeys.delete(publicKey);
    return false;
  }
}

/** Twelve groups of five digits from both public keys, the same on both
 *  sides (the keys are sorted first). Read aloud to rule out an impostor. */
export async function safetyNumber(a: string, b: string): Promise<string> {
  const [first, second] = [a, b].sort();
  const data = new Uint8Array([...fromBase64(first), ...fromBase64(second)]);
  let digest = new Uint8Array(await crypto.subtle.digest("SHA-512", data));
  // A few rounds make a brute-forced lookalike expensive.
  for (let i = 0; i < 1024; i++) digest = new Uint8Array(await crypto.subtle.digest("SHA-512", digest));
  const groups: string[] = [];
  for (let i = 0; i < 12; i++) {
    const n = ((digest[i * 5] << 24) | (digest[i * 5 + 1] << 16) | (digest[i * 5 + 2] << 8) | digest[i * 5 + 3]) >>> 0;
    groups.push(String(n % 100000).padStart(5, "0"));
  }
  return groups.join(" ");
}

/* --------------------------------------------------------------------- pins */

export type PinVerdict = "new" | "match" | "changed";
type PinMap = Record<string, { kid: string; firstSeen: number; lastSeen: number }>;

const PIN_KEY = "m5cet:pins:v1";
const MAX_PINS = 2_000;

/** Trust-on-first-use pins: room + name → the key id first seen for them. */
export function createPinStore(storage: Storage | null = (() => { try { return localStorage; } catch { return null; } })()) {
  let memory: PinMap = {};
  const read = (): PinMap => {
    if (!storage) return memory;
    try { return JSON.parse(storage.getItem(PIN_KEY) || "{}") as PinMap; } catch { return {}; }
  };
  const write = (map: PinMap) => {
    const entries = Object.entries(map);
    if (entries.length > MAX_PINS) {
      entries.sort((x, y) => y[1].lastSeen - x[1].lastSeen);
      map = Object.fromEntries(entries.slice(0, MAX_PINS));
    }
    if (!storage) { memory = map; return; }
    try { storage.setItem(PIN_KEY, JSON.stringify(map)); } catch { memory = map; }
  };
  const slot = (room: string, name: string) => `${room}\u0000${name.trim().toLowerCase()}`;

  return {
    /** Records the key for this name (first time) and says how it compares. */
    check(room: string, name: string, kid: string, now = Date.now()): PinVerdict {
      const map = read();
      const key = slot(room, name);
      const pin = map[key];
      if (!pin) {
        map[key] = { kid, firstSeen: now, lastSeen: now };
        write(map);
        return "new";
      }
      if (pin.kid === kid) {
        pin.lastSeen = now;
        write(map);
        return "match";
      }
      return "changed";
    },
    /** The user accepted the new key (after checking the safety number). */
    accept(room: string, name: string, kid: string, now = Date.now()): void {
      const map = read();
      map[slot(room, name)] = { kid, firstSeen: now, lastSeen: now };
      write(map);
    },
    pinned(room: string, name: string): string | null {
      return read()[slot(room, name)]?.kid ?? null;
    },
    clear(): void {
      memory = {};
      try { storage?.removeItem(PIN_KEY); } catch { /* ignore */ }
    },
  };
}
