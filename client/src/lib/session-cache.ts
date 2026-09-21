// Encrypted, tab-scoped session cache.
//
// Lets a reload (or a crash) bring the user straight back into the room
// without asking for the room key again — and no longer than that:
//
//   lifetime   the ciphertext lives in sessionStorage, which the browser drops
//              when the tab/window closes. It survives reloads only.
//   idle       untouched for SESSION_IDLE_LIMIT_MS (1 h) -> wiped.
//   contents   name, room id, room key (passphrase) and the DESIRED state
//              ("connected" | "disconnected") the app must enforce.
//
// Protection: the record is AES-GCM encrypted with a key generated per tab as
// a NON-EXTRACTABLE CryptoKey and parked in IndexedDB. Script (ours, or an
// injected one) can ask the browser to decrypt with it, but can never read the
// key bytes, and what sits in sessionStorage is ciphertext only.
//
// What this does NOT protect against — be honest about it:
//   - code running inside this origin (XSS, a malicious extension): it can do
//     whatever the app can, including asking for a decrypt;
//   - forensic access to the browser profile on disk, where the engine keeps
//     IndexedDB key material in its own format.
// Before this cache existed the room key was never stored at all; keeping it,
// even encrypted and only per tab, is a deliberate convenience trade-off.

import { toBase64, fromBase64 } from "./crypto";

export type DesiredState = "connected" | "disconnected";

export type SessionData = {
  name: string;
  room: string;
  passphrase: string;
  desired: DesiredState;
};

export const SESSION_IDLE_LIMIT_MS = 60 * 60 * 1000;
const STORAGE_KEY = "m5cet:session:v1";
const DB_NAME = "m5cet-session";
const STORE = "keys";

type StoredRecord = { v: 1; id: string; iv: string; ct: string; touchedAt: number };

/** Where the wrapping key lives. IndexedDB in browsers; injectable for tests. */
export interface KeyVault {
  get(id: string): Promise<CryptoKey | null>;
  put(id: string, key: CryptoKey, touchedAt: number): Promise<void>;
  touch(id: string, touchedAt: number): Promise<void>;
  delete(id: string): Promise<void>;
  purgeOlderThan(cutoff: number): Promise<void>;
  clear(): Promise<void>;
}

/** Keys held in memory only: a reload cannot decrypt, so it simply asks again. */
export function createMemoryVault(): KeyVault {
  const keys = new Map<string, { key: CryptoKey; touchedAt: number }>();
  return {
    async get(id) { return keys.get(id)?.key ?? null; },
    async put(id, key, touchedAt) { keys.set(id, { key, touchedAt }); },
    async touch(id, touchedAt) { const e = keys.get(id); if (e) e.touchedAt = touchedAt; },
    async delete(id) { keys.delete(id); },
    async purgeOlderThan(cutoff) { for (const [id, e] of keys) if (e.touchedAt < cutoff) keys.delete(id); },
    async clear() { keys.clear(); },
  };
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: "id" }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return openDb().then((db) => new Promise<T | undefined>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(req ? req.result : undefined); };
    t.onerror = () => { db.close(); reject(t.error); };
    t.onabort = () => { db.close(); reject(t.error); };
  }));
}

export function createIndexedDbVault(): KeyVault {
  type Row = { id: string; key: CryptoKey; touchedAt: number };
  return {
    async get(id) { return ((await tx<Row>("readonly", (s) => s.get(id))) as Row | undefined)?.key ?? null; },
    async put(id, key, touchedAt) { await tx("readwrite", (s) => s.put({ id, key, touchedAt } satisfies Row)); },
    async touch(id, touchedAt) {
      const row = (await tx<Row>("readonly", (s) => s.get(id))) as Row | undefined;
      if (row) await tx("readwrite", (s) => s.put({ ...row, touchedAt }));
    },
    async delete(id) { await tx("readwrite", (s) => s.delete(id)); },
    async purgeOlderThan(cutoff) {
      const rows = ((await tx<Row[]>("readonly", (s) => s.getAll())) ?? []) as Row[];
      for (const row of rows) if (row.touchedAt < cutoff) await tx("readwrite", (s) => s.delete(row.id));
    },
    async clear() { await tx("readwrite", (s) => s.clear()); },
  };
}

export type SessionCache = {
  save(data: SessionData): Promise<void>;
  /** null when there is nothing, it expired, or it cannot be decrypted (then it is wiped). */
  load(): Promise<SessionData | null>;
  /** Record user activity; cheap, call it often. */
  touch(): void;
  /** Milliseconds since the last activity, or null without a session. */
  idleMs(): number | null;
  clear(): Promise<void>;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const aad = (id: string) => encoder.encode(`m5cet:session:v1:${id}`);

function randomId(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(16))).replace(/[+/=]/g, "");
}

export function createSessionCache(opts: { vault?: KeyVault; storage?: Storage; now?: () => number } = {}): SessionCache {
  const now = opts.now ?? Date.now;
  let storage: Storage | null = null;
  try { storage = opts.storage ?? (typeof sessionStorage !== "undefined" ? sessionStorage : null); } catch { storage = null; }
  let vault: KeyVault;
  try { vault = opts.vault ?? (typeof indexedDB !== "undefined" ? createIndexedDbVault() : createMemoryVault()); } catch { vault = createMemoryVault(); }
  let lastVaultTouch = 0;

  const read = (): StoredRecord | null => {
    try {
      const raw = storage?.getItem(STORAGE_KEY);
      if (!raw) return null;
      const rec = JSON.parse(raw) as Partial<StoredRecord>;
      if (rec.v !== 1 || typeof rec.id !== "string" || typeof rec.iv !== "string" || typeof rec.ct !== "string" || typeof rec.touchedAt !== "number") return null;
      return rec as StoredRecord;
    } catch { return null; }
  };

  const clear = async () => {
    const rec = read();
    try { storage?.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    if (rec) await vault.delete(rec.id).catch(() => undefined);
  };

  return {
    async save(data) {
      if (!storage) return;
      // Reuse this tab's key; mint one on first save.
      let id = read()?.id ?? "";
      let key = id ? await vault.get(id).catch(() => null) : null;
      if (!key) {
        id = randomId();
        key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
        await vault.put(id, key, now());
      }
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad(id) }, key, encoder.encode(JSON.stringify(data)),
      ));
      const rec: StoredRecord = { v: 1, id, iv: toBase64(iv), ct: toBase64(ct), touchedAt: now() };
      storage.setItem(STORAGE_KEY, JSON.stringify(rec));
    },

    async load() {
      // Keys whose tab is long gone (closed without Clear & Quit) are useless
      // without their ciphertext; sweep them so they do not pile up.
      await vault.purgeOlderThan(now() - SESSION_IDLE_LIMIT_MS).catch(() => undefined);
      const rec = read();
      if (!rec) return null;
      if (now() - rec.touchedAt > SESSION_IDLE_LIMIT_MS) { await clear(); return null; }
      try {
        const key = await vault.get(rec.id);
        if (!key) throw new Error("no key");
        const plain = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: fromBase64(rec.iv), additionalData: aad(rec.id) }, key, fromBase64(rec.ct),
        );
        const data = JSON.parse(decoder.decode(plain)) as Partial<SessionData>;
        if (typeof data.name !== "string" || typeof data.room !== "string" || typeof data.passphrase !== "string"
          || (data.desired !== "connected" && data.desired !== "disconnected")) throw new Error("bad shape");
        return { name: data.name, room: data.room, passphrase: data.passphrase, desired: data.desired };
      } catch {
        await clear();
        return null;
      }
    },

    touch() {
      const rec = read();
      if (!rec || !storage) return;
      const t = now();
      rec.touchedAt = t;
      try { storage.setItem(STORAGE_KEY, JSON.stringify(rec)); } catch { /* ignore */ }
      // The vault copy only feeds the orphan sweep; once a minute is plenty.
      if (t - lastVaultTouch > 60_000) { lastVaultTouch = t; void vault.touch(rec.id, t).catch(() => undefined); }
    },

    idleMs() {
      const rec = read();
      return rec ? Math.max(0, now() - rec.touchedAt) : null;
    },

    clear,
  };
}
