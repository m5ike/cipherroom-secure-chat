// Encrypted, tab-scoped session cache.
//
// Lets a reload (or a crash) bring the user straight back into the room
// without asking for the room key again — and no longer than that:
//
//   lifetime   the ciphertext lives in sessionStorage, which the browser drops
//              when the tab/window closes. It survives reloads only.
//   idle       untouched for SESSION_IDLE_LIMIT_MS (1 h) -> wiped.
//   contents   name, room id, room key (passphrase) and the DESIRED state
//              ("connected" | "disconnected") the app must enforce; 6.7: the
//              resume secret, so a reload returns as the same room member.
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
//
// 6.12 (F-26): the idle clock is authenticated. `touchedAt` next to the
// ciphertext only feeds idleMs() now; what decides "idle for an hour" is a
// second small AES-GCM record (`ts`, sealed with the same key, AAD bound to the
// record id) that the app re-seals on activity — editing storage cannot keep a
// session alive past its hour any more. A record of 6.11 (v 1, no `ts`) is
// still read once with its plain clock and rewritten as v 2.

import { toBase64, fromBase64 } from "./crypto";

export type DesiredState = "connected" | "disconnected";

export type SessionData = {
  name: string;
  room: string;
  passphrase: string;
  desired: DesiredState;
  /** A saved connection's other signaling server (wss://); absent = this one. */
  server?: string;
  /** The saved connection the session came from, so its statistics go on. */
  profileId?: string;
  /** 6.7: the peer id and resume secret of the last `joined` — a reload comes back as the same member. */
  resume?: { room: string; peerId: string; secret: string };
};

export const SESSION_IDLE_LIMIT_MS = 60 * 60 * 1000;
const STORAGE_KEY = "m5cet:session:v1";
const DB_NAME = "m5cet-session";
const STORE = "keys";

// `off` is the only field outside the ciphertext that affects behaviour, and
// it can only LOWER the desired state to "disconnected". Forging it cannot
// make the app connect; it exists so that Disconnect takes effect at once.
type StoredRecord = { v: 1 | 2; id: string; iv: string; ct: string; touchedAt: number; off?: boolean; ts?: { iv: string; ct: string } };

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
  /** Synchronously pin the desired state to "disconnected" (see StoredRecord.off). */
  forceDisconnected(): void;
  /** Record user activity; cheap, call it often. */
  touch(): void;
  /** Milliseconds since the last activity, or null without a session. */
  idleMs(): number | null;
  clear(): Promise<void>;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const aad = (id: string) => encoder.encode(`m5cet:session:v1:${id}`);
const tsAad = (id: string) => encoder.encode(`m5cet:session:v2:touched:${id}`);
/** The authenticated idle clock is re-sealed at most this often (it is the hour that counts). */
const TS_RESEAL_MS = 30_000;

async function sealTime(key: CryptoKey, id: string, at: number): Promise<{ iv: string; ct: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: tsAad(id) }, key, encoder.encode(String(at))));
  return { iv: toBase64(iv), ct: toBase64(ct) };
}

async function openTime(key: CryptoKey, id: string, ts: { iv: string; ct: string }): Promise<number> {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(ts.iv), additionalData: tsAad(id) }, key, fromBase64(ts.ct));
  const at = Number(decoder.decode(plain));
  if (!Number.isFinite(at) || at <= 0) throw new Error("bad time");
  return at;
}

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
  let lastSealedTouch = 0;
  let pendingTouch: Promise<void> | null = null;

  const read = (): StoredRecord | null => {
    try {
      const raw = storage?.getItem(STORAGE_KEY);
      if (!raw) return null;
      const rec = JSON.parse(raw) as Partial<StoredRecord>;
      if ((rec.v !== 1 && rec.v !== 2) || typeof rec.id !== "string" || typeof rec.iv !== "string" || typeof rec.ct !== "string" || typeof rec.touchedAt !== "number") return null;
      if (rec.v === 2 && (!rec.ts || typeof rec.ts.iv !== "string" || typeof rec.ts.ct !== "string")) return null;
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
      // Asking for "connected" lifts the pin right away, before any await…
      if (data.desired === "connected") {
        const cur = read();
        if (cur?.off) { delete cur.off; try { storage.setItem(STORAGE_KEY, JSON.stringify(cur)); } catch { /* ignore */ } }
      }
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
      const at = now();
      const rec: StoredRecord = { v: 2, id, iv: toBase64(iv), ct: toBase64(ct), touchedAt: at, ts: await sealTime(key, id, at) };
      lastSealedTouch = at;
      // …so a pin found here was set by a Disconnect that arrived while we
      // were encrypting. The later click wins over this older snapshot.
      if (data.desired === "disconnected" || read()?.off === true) rec.off = true;
      storage.setItem(STORAGE_KEY, JSON.stringify(rec));
    },

    async load() {
      // Keys whose tab is long gone (closed without Clear & Quit) are useless
      // without their ciphertext; sweep them so they do not pile up.
      await vault.purgeOlderThan(now() - SESSION_IDLE_LIMIT_MS).catch(() => undefined);
      // Activity a moment ago may still be sealing its time.
      if (pendingTouch) await pendingTouch.catch(() => undefined);
      const rec = read();
      if (!rec) return null;
      if (now() - rec.touchedAt > SESSION_IDLE_LIMIT_MS) { await clear(); return null; }
      try {
        const key = await vault.get(rec.id);
        if (!key) throw new Error("no key");
        // 6.12: the authenticated clock decides (a v1 record of 6.11 has only the plain one, once).
        const touched = rec.v === 2 && rec.ts ? await openTime(key, rec.id, rec.ts) : rec.touchedAt;
        if (now() - touched > SESSION_IDLE_LIMIT_MS) throw new Error("idle");
        const plain = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: fromBase64(rec.iv), additionalData: aad(rec.id) }, key, fromBase64(rec.ct),
        );
        const data = JSON.parse(decoder.decode(plain)) as Partial<SessionData>;
        if (typeof data.name !== "string" || typeof data.room !== "string" || typeof data.passphrase !== "string"
          || (data.desired !== "connected" && data.desired !== "disconnected")) throw new Error("bad shape");
        return {
          name: data.name, room: data.room, passphrase: data.passphrase, desired: rec.off ? "disconnected" : data.desired,
          ...(typeof data.server === "string" && data.server ? { server: data.server } : {}),
          ...(typeof data.profileId === "string" && data.profileId ? { profileId: data.profileId } : {}),
          ...(data.resume && typeof data.resume.room === "string" && typeof data.resume.peerId === "string" && typeof data.resume.secret === "string"
            ? { resume: { room: data.resume.room, peerId: data.resume.peerId, secret: data.resume.secret } } : {}),
        };
      } catch {
        await clear();
        return null;
      }
    },

    forceDisconnected() {
      const rec = read();
      if (!rec || !storage) return;
      rec.off = true;
      try { storage.setItem(STORAGE_KEY, JSON.stringify(rec)); } catch { /* ignore */ }
    },

    touch() {
      const rec = read();
      if (!rec || !storage) return;
      const t = now();
      rec.touchedAt = t;
      try { storage.setItem(STORAGE_KEY, JSON.stringify(rec)); } catch { /* ignore */ }
      // The vault copy only feeds the orphan sweep; once a minute is plenty.
      if (t - lastVaultTouch > 60_000) { lastVaultTouch = t; void vault.touch(rec.id, t).catch(() => undefined); }
      // 6.12 (F-26): the authenticated clock, re-sealed now and then (async; load() waits for it).
      if (t - lastSealedTouch >= TS_RESEAL_MS && !pendingTouch) {
        lastSealedTouch = t;
        const id = rec.id;
        pendingTouch = (async () => {
          const key = await vault.get(id);
          if (!key) return;
          const ts = await sealTime(key, id, t);
          const cur = read();
          if (!cur || cur.id !== id) return;
          cur.ts = ts;
          cur.v = 2;
          try { storage!.setItem(STORAGE_KEY, JSON.stringify(cur)); } catch { /* ignore */ }
        })().catch(() => undefined).finally(() => { pendingTouch = null; });
      }
    },

    idleMs() {
      const rec = read();
      return rec ? Math.max(0, now() - rec.touchedAt) : null;
    },

    clear,
  };
}
