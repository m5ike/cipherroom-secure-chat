// Protocol 4 (6.12) in the web client: what the device keeps between page
// loads, and how.
//
//   LocalVault            an AES-256-GCM key generated NON-EXTRACTABLE and kept
//                         in IndexedDB ("m5cet-p4"): script can ask the browser
//                         to encrypt or decrypt with it, never read it. Every
//                         secret below is stored as its ciphertext (associated
//                         data: the entry's name). Without IndexedDB (private
//                         mode, tests) everything lives in memory for the page.
//   VaultBundleStore      the mailbox bundles' private keys (spec § 7.1): the
//                         ECDH key as a non-extractable CryptoKey (IndexedDB
//                         keeps it as such), the ML-KEM key encrypted.
//   VaultReplayStore      accepted message ids per room (§ 11) — already hashed
//                         by the library, kept encrypted, written in batches.
//   LocalKtStore          the key-transparency pin and newest tree head per
//                         server (§ 14) — public data, localStorage.
//   PayloadSealer         a key for this page only: the light-mode outbox keeps
//                         a waiting message's PAYLOAD encrypted under it and
//                         seals it for the recipients only when it goes.
//
// What this does not protect against is said in session-cache.ts: code
// running in this origin can ask for a decrypt just as the app can.

import { fromBase64, toBase64 } from "./crypto";
import type { BundleKeys, BundleStore, KtOriginState, KtStore, MailboxBundle, ReplayStore } from "./p4";
import { REPLAY, ReplayGuard } from "./p4";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/* ------------------------------------------------------------ backends */

/** Where rows live: IndexedDB in a browser, a Map in tests and private mode. */
export interface KvBackend {
  get(id: string): Promise<unknown>;
  put(id: string, value: unknown): Promise<void>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
  readonly persistent: boolean;
}

export function memoryBackend(): KvBackend {
  const rows = new Map<string, unknown>();
  return {
    persistent: false,
    async get(id) { return rows.get(id); },
    async put(id, value) { rows.set(id, value); },
    async delete(id) { rows.delete(id); },
    async clear() { rows.clear(); },
  };
}

const DB_NAME = "m5cet-p4";
const STORE = "kv";

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: "id" }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function indexedDbBackend(name = DB_NAME): KvBackend {
  let db: Promise<IDBDatabase> | null = null;
  const tx = <T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> =>
    (db ??= openDb(name)).then((d) => new Promise<T | undefined>((resolve, reject) => {
      const t = d.transaction(STORE, mode);
      const req = run(t.objectStore(STORE));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  return {
    persistent: true,
    async get(id) { return ((await tx<{ id: string; value: unknown }>("readonly", (s) => s.get(id))) as { value?: unknown } | undefined)?.value; },
    async put(id, value) { await tx("readwrite", (s) => { s.put({ id, value }); }); },
    async delete(id) { await tx("readwrite", (s) => { s.delete(id); }); },
    async clear() { await tx("readwrite", (s) => { s.clear(); }); },
  };
}

/* --------------------------------------------------------------- vault */

type Sealed = { iv: string; ct: string };
const aad = (name: string) => encoder.encode(`m5cet/p4-store/1|${name}`);

export class LocalVault {
  private key: Promise<CryptoKey> | null = null;

  constructor(readonly backend: KvBackend) {}

  private wrapKey(): Promise<CryptoKey> {
    return (this.key ??= (async () => {
      const kept = await this.backend.get("wrap").catch(() => undefined);
      if (kept && typeof kept === "object" && (kept as CryptoKey).type === "secret") return kept as CryptoKey;
      const fresh = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      await this.backend.put("wrap", fresh).catch(() => undefined);
      return fresh;
    })());
  }

  async seal(name: string, value: unknown): Promise<Sealed> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(name) }, await this.wrapKey(), encoder.encode(JSON.stringify(value))));
    return { iv: toBase64(iv), ct: toBase64(ct) };
  }

  async open<T>(name: string, sealed: unknown): Promise<T | null> {
    const s = sealed as Partial<Sealed> | null;
    if (!s || typeof s.iv !== "string" || typeof s.ct !== "string") return null;
    try {
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(s.iv), additionalData: aad(name) }, await this.wrapKey(), fromBase64(s.ct));
      return JSON.parse(decoder.decode(plain)) as T;
    } catch {
      return null;
    }
  }

  async getJson<T>(name: string): Promise<T | null> {
    return this.open<T>(name, await this.backend.get(name).catch(() => null));
  }

  async putJson(name: string, value: unknown): Promise<void> {
    await this.backend.put(name, await this.seal(name, value));
  }

  /** A value IndexedDB keeps as it is (a non-extractable CryptoKey stays one). */
  getRaw(name: string): Promise<unknown> { return this.backend.get(name).catch(() => undefined); }
  putRaw(name: string, value: unknown): Promise<void> { return this.backend.put(name, value); }
  delete(name: string): Promise<void> { return this.backend.delete(name).catch(() => undefined); }

  /** Clear & Quit: every row, and the wrapping key with them. */
  async clear(): Promise<void> {
    this.key = null;
    await this.backend.clear().catch(() => undefined);
  }
}

let shared: LocalVault | null = null;

/** This device's vault (IndexedDB when the browser has it, memory otherwise). */
export function deviceVault(): LocalVault {
  if (shared) return shared;
  let backend: KvBackend;
  try { backend = typeof indexedDB !== "undefined" && typeof indexedDB.open === "function" ? indexedDbBackend() : memoryBackend(); } catch { backend = memoryBackend(); }
  return (shared = new LocalVault(backend));
}

/** Tests: a fresh vault on a backend of their choice (and a fresh replay window on it). */
export function _setDeviceVaultForTests(vault: LocalVault | null): void { shared = vault; sharedReplay = null; }

/* ------------------------------------------------------ mailbox bundles */

type BundleRow = { bundle: MailboxBundle; kemDk: string; created: number };

/** § 7.1: own bundles; private ECDH keys as CryptoKeys, ML-KEM keys encrypted. Cached after the first read. */
export class VaultBundleStore implements BundleStore {
  private cache: Map<string, BundleKeys> | null = null;
  private loading: Promise<Map<string, BundleKeys>> | null = null;

  constructor(private readonly vault: LocalVault, private readonly name = "mailbox") {}

  private load(): Promise<Map<string, BundleKeys>> {
    if (this.cache) return Promise.resolve(this.cache);
    return (this.loading ??= (async () => {
      const rows = (await this.vault.getJson<BundleRow[]>(this.name)) ?? [];
      const out = new Map<string, BundleKeys>();
      for (const row of rows) {
        const dh = await this.vault.getRaw(`${this.name}:dh:${row.bundle.id}`);
        if (!dh || typeof dh !== "object" || (dh as CryptoKey).type !== "private") continue;
        out.set(row.bundle.id, { bundle: row.bundle, dh: dh as CryptoKey, kemDk: fromBase64(row.kemDk), created: row.created });
      }
      this.cache = out;
      return out;
    })());
  }

  private async save(rows: Map<string, BundleKeys>): Promise<void> {
    const list: BundleRow[] = [...rows.values()].map((k) => ({ bundle: k.bundle, kemDk: toBase64(k.kemDk), created: k.created }));
    await this.vault.putJson(this.name, list);
  }

  async all(): Promise<BundleKeys[]> { return [...(await this.load()).values()]; }

  async put(keys: BundleKeys): Promise<void> {
    const rows = await this.load();
    rows.set(keys.bundle.id, keys);
    await this.vault.putRaw(`${this.name}:dh:${keys.bundle.id}`, keys.dh).catch(() => undefined);
    await this.save(rows);
  }

  async remove(id: string): Promise<void> {
    const rows = await this.load();
    rows.delete(id);
    await this.vault.delete(`${this.name}:dh:${id}`);
    await this.save(rows);
  }
}

/* -------------------------------------------------------------- replay */

/**
 * § 11: accepted ids per room, kept encrypted. The ids are the library's
 * hashes already; the room is named by a hash of its blind id. Reads are from
 * memory after the first load; writes go out at most once a second.
 */
export class VaultReplayStore implements ReplayStore {
  private readonly rooms = new Map<string, Promise<Map<string, number>>>();
  private readonly dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly vault: LocalVault, private readonly delayMs = 1000) {}

  private async slot(roomId: string): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`m5cet/p4-replay|${roomId}`)));
    return `replay:${toBase64(digest.slice(0, 12)).replace(/[+/=]/g, "")}`;
  }

  private room(roomId: string): Promise<Map<string, number>> {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = (async () => {
        const rows = await this.vault.getJson<Array<[string, number]>>(await this.slot(roomId));
        return new Map(Array.isArray(rows) ? rows.filter((r) => Array.isArray(r) && typeof r[0] === "string" && typeof r[1] === "number") : []);
      })();
      this.rooms.set(roomId, room);
    }
    return room;
  }

  async has(roomId: string, key: string): Promise<boolean> { return (await this.room(roomId)).has(key); }

  async add(roomId: string, key: string, at: number): Promise<void> {
    (await this.room(roomId)).set(key, at);
    this.touch(roomId);
  }

  async prune(roomId: string, before: number, max: number): Promise<void> {
    const room = await this.room(roomId);
    for (const [key, at] of room) if (at < before) room.delete(key);
    if (room.size > max) for (const [key] of [...room.entries()].sort((a, b) => a[1] - b[1]).slice(0, room.size - max)) room.delete(key);
    this.touch(roomId);
  }

  private touch(roomId: string): void {
    this.dirty.add(roomId);
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.delayMs);
  }

  /** Writes what changed now (a page going away calls it too). */
  async flush(): Promise<void> {
    const rooms = [...this.dirty];
    this.dirty.clear();
    for (const roomId of rooms) {
      const room = await this.room(roomId);
      await this.vault.putJson(await this.slot(roomId), [...room.entries()].slice(-REPLAY.maxIdsPerRoom)).catch(() => undefined);
    }
  }

  size(roomId: string): Promise<number> { return this.room(roomId).then((r) => r.size); }
}

let sharedReplay: { store: VaultReplayStore; guard: ReplayGuard } | null = null;

/** This device's replay window — ONE for the room on screen and the background rooms (they write the same rows). */
export function deviceReplay(): { store: VaultReplayStore; guard: ReplayGuard } {
  if (!sharedReplay) {
    const store = new VaultReplayStore(deviceVault());
    sharedReplay = { store, guard: new ReplayGuard(store) };
  }
  return sharedReplay;
}

/* ------------------------------------------------- key transparency pins */

const KT_KEY = "m5cet:kt:v1";

/** § 14.4: per server origin — the pinned KT key, the newest tree head, an alert. Public data. */
export class LocalKtStore implements KtStore {
  private memory: Record<string, KtOriginState> = {};

  constructor(private readonly storage: Storage | null = (() => { try { return localStorage; } catch { return null; } })()) {}

  private read(): Record<string, KtOriginState> {
    if (!this.storage) return this.memory;
    try { return JSON.parse(this.storage.getItem(KT_KEY) || "{}") as Record<string, KtOriginState>; } catch { return {}; }
  }

  async get(origin: string): Promise<KtOriginState | null> {
    const s = this.read()[origin];
    return s ? { key: s.key ?? null, sth: s.sth ?? null, alert: s.alert ?? null } : null;
  }

  async set(origin: string, state: KtOriginState): Promise<void> {
    const all = { ...this.read(), [origin]: state };
    if (!this.storage) { this.memory = all; return; }
    try { this.storage.setItem(KT_KEY, JSON.stringify(all)); } catch { this.memory = all; }
  }
}

/* ------------------------------------------------------- outbox payloads */

/** A key for this page only, non-extractable: what waits in the outbox is its ciphertext. */
export class PayloadSealer {
  private key: Promise<CryptoKey> | null = null;
  private keyOf(): Promise<CryptoKey> {
    return (this.key ??= crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]));
  }

  async seal(id: string, payload: unknown): Promise<Sealed> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(`m5cet/outbox|${id}`) }, await this.keyOf(), encoder.encode(JSON.stringify(payload))));
    return { iv: toBase64(iv), ct: toBase64(ct) };
  }

  async open<T>(id: string, sealed: Sealed): Promise<T> {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(sealed.iv), additionalData: encoder.encode(`m5cet/outbox|${id}`) }, await this.keyOf(), fromBase64(sealed.ct));
    return JSON.parse(decoder.decode(plain)) as T;
  }
}

export type SealedPayload = Sealed;
