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
//                         keeps it as such), the ML-KEM key encrypted — ONE
//                         ROW PER BUNDLE, so two tabs never overwrite each
//                         other's keys (6.12 review P11).
//   VaultReplayStore      accepted message ids per room (§ 11) — already hashed
//                         by the library, kept encrypted, written in batches;
//                         a write MERGES with what is stored (another tab's
//                         ids are kept), under a Web Lock where the browser
//                         has one, and the tabs tell each other new ids
//                         (BroadcastChannel).
//   LocalKtStore          the key-transparency pin and newest tree head per
//                         server (§ 14) — public data, localStorage.
//   PayloadSealer         a key for this page only: the light-mode outbox keeps
//                         a waiting message's PAYLOAD encrypted under it and
//                         seals it for the recipients only when it goes.
//
// The wrapping key is never replaced because a READ failed (review P12): a
// failed read is retried and then reported (`VaultUnavailable`); only a key
// that is really absent is created — with `add`, which never overwrites one
// another tab created meanwhile. Rows that do not open are left alone.
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
  /** Stores `value` only when `id` holds nothing; false when it already did (never overwrites). */
  add?(id: string, value: unknown): Promise<boolean>;
  /** The ids that start with `prefix`. */
  keys?(prefix: string): Promise<string[]>;
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
    async add(id, value) { if (rows.has(id)) return false; rows.set(id, value); return true; },
    async keys(prefix) { return [...rows.keys()].filter((k) => k.startsWith(prefix)); },
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
  const database = () => (db ??= openDb(name).catch((error) => { db = null; throw error; }));
  const tx = <T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> =>
    database().then((d) => new Promise<T | undefined>((resolve, reject) => {
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
    async add(id, value) {
      try {
        await tx("readwrite", (s) => s.add({ id, value }));
        return true;
      } catch (error) {
        if ((error as DOMException | null)?.name === "ConstraintError") return false;
        throw error;
      }
    },
    async keys(prefix) {
      const all = await tx<IDBValidKey[]>("readonly", (s) => s.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`)));
      return (all ?? []).filter((k): k is string => typeof k === "string");
    },
  };
}

/* --------------------------------------------------------------- vault */

type Sealed = { iv: string; ct: string };
const aad = (name: string) => encoder.encode(`m5cet/p4-store/1|${name}`);

/** The device vault cannot be read now (IndexedDB failed): retry later — nothing was replaced or dropped. */
export class VaultUnavailable extends Error {
  constructor(readonly cause?: unknown) {
    super("the device vault cannot be read now");
    this.name = "VaultUnavailable";
  }
}

const isSecretKey = (v: unknown): v is CryptoKey => Boolean(v) && typeof v === "object" && (v as CryptoKey).type === "secret";
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reads that fail are tried this often (with a short pause) before the vault says it is unavailable. */
const READ_TRIES = 3;

export class LocalVault {
  private key: Promise<CryptoKey> | null = null;

  constructor(readonly backend: KvBackend) {}

  /** A backend read, retried; a lasting failure is VaultUnavailable (never "absent"). */
  private async read(id: string): Promise<unknown> {
    let last: unknown;
    for (let i = 0; i < READ_TRIES; i++) {
      try { return await this.backend.get(id); } catch (error) { last = error; if (i < READ_TRIES - 1) await pause(20 * (i + 1)); }
    }
    throw new VaultUnavailable(last);
  }

  /**
   * The wrapping key (review P12): read (retried); created only when it is
   * really ABSENT, with `add` (never over a key another tab made meanwhile);
   * a read that keeps failing throws — and is tried afresh on the next call.
   */
  private wrapKey(): Promise<CryptoKey> {
    if (this.key) return this.key;
    const loading = (async () => {
      const kept = await this.read("wrap");
      if (isSecretKey(kept)) return kept;
      if (kept !== undefined && kept !== null) throw new VaultUnavailable(new Error("the stored wrapping key is not a key"));
      const fresh = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      if (this.backend.add) {
        if (await this.backend.add("wrap", fresh)) return fresh;
      } else {
        await this.backend.put("wrap", fresh);
      }
      // Another tab of this origin made one at the same moment: the stored key is the one.
      const stored = await this.read("wrap");
      if (isSecretKey(stored)) return stored;
      throw new VaultUnavailable(new Error("the wrapping key could not be stored"));
    })();
    this.key = loading;
    loading.catch(() => { if (this.key === loading) this.key = null; });
    return loading;
  }

  async seal(name: string, value: unknown): Promise<Sealed> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(name) }, await this.wrapKey(), encoder.encode(JSON.stringify(value))));
    return { iv: toBase64(iv), ct: toBase64(ct) };
  }

  /** A sealed row → its value; null when it does not open (another key, damaged). VaultUnavailable when the key cannot be read. */
  async open<T>(name: string, sealed: unknown): Promise<T | null> {
    const s = sealed as Partial<Sealed> | null;
    if (!s || typeof s.iv !== "string" || typeof s.ct !== "string") return null;
    const key = await this.wrapKey();
    try {
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(s.iv), additionalData: aad(name) }, key, fromBase64(s.ct));
      return JSON.parse(decoder.decode(plain)) as T;
    } catch {
      return null;
    }
  }

  /** null: no such row (or it does not open). Throws VaultUnavailable when the vault cannot be read now. */
  async getJson<T>(name: string): Promise<T | null> {
    return this.open<T>(name, await this.read(name));
  }

  async putJson(name: string, value: unknown): Promise<void> {
    await this.backend.put(name, await this.seal(name, value));
  }

  /** A value IndexedDB keeps as it is (a non-extractable CryptoKey stays one). Throws VaultUnavailable. */
  getRaw(name: string): Promise<unknown> { return this.read(name); }
  putRaw(name: string, value: unknown): Promise<void> { return this.backend.put(name, value); }
  delete(name: string): Promise<void> { return this.backend.delete(name).catch(() => undefined); }
  /** Row ids with this prefix (null when the backend cannot list). */
  async keys(prefix: string): Promise<string[] | null> {
    if (!this.backend.keys) return null;
    try { return await this.backend.keys(prefix); } catch (error) { throw new VaultUnavailable(error); }
  }

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
export function _setDeviceVaultForTests(vault: LocalVault | null): void { shared = vault; sharedReplay?.store.close(); sharedReplay = null; }

/* ----------------------------------------------------------- web locks */

type LockManager = { request<T>(name: string, run: () => Promise<T>): Promise<T> };

/** Runs `work` under a Web Lock of this origin when the browser has them (all tabs), else as it is. */
function withLock<T>(name: string, work: () => Promise<T>): Promise<T> {
  const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
  if (!locks || typeof locks.request !== "function") return work();
  return locks.request(name, work);
}

/* ------------------------------------------------------ mailbox bundles */

type BundleRow = { bundle: MailboxBundle; kemDk: string; created: number };

/**
 * § 7.1: own bundles — ONE ROW PER BUNDLE (`<name>:row:<id>`, the ML-KEM key
 * sealed; `<name>:dh:<id>`, the ECDH key as a non-extractable CryptoKey).
 * Another tab's put or remove touches only its own rows (review P11); `all()`
 * lists the rows each time, so a bundle another tab made is seen too. The
 * 6.12 single-list row (`<name>`) is moved to rows once and then removed.
 */
export class VaultBundleStore implements BundleStore {
  private readonly cache = new Map<string, BundleKeys>();
  private migrated: Promise<void> | null = null;

  constructor(private readonly vault: LocalVault, private readonly name = "mailbox") {}

  private rowName = (id: string) => `${this.name}:row:${id}`;
  private dhName = (id: string) => `${this.name}:dh:${id}`;

  private async loadRow(id: string): Promise<BundleKeys | null> {
    const row = await this.vault.getJson<BundleRow>(this.rowName(id));
    if (!row?.bundle || typeof row.kemDk !== "string") return null;
    const dh = await this.vault.getRaw(this.dhName(id));
    if (!dh || typeof dh !== "object" || (dh as CryptoKey).type !== "private") return null;
    return { bundle: row.bundle, dh: dh as CryptoKey, kemDk: fromBase64(row.kemDk), created: row.created };
  }

  private async writeRow(keys: BundleKeys): Promise<void> {
    await this.vault.putRaw(this.dhName(keys.bundle.id), keys.dh);
    await this.vault.putJson(this.rowName(keys.bundle.id), { bundle: keys.bundle, kemDk: toBase64(keys.kemDk), created: keys.created } satisfies BundleRow);
  }

  /** The 6.12 single-list row → one row per bundle (kept rows win), then the list goes. */
  private migrate(): Promise<void> {
    const run = (async () => {
      const legacy = await this.vault.getJson<BundleRow[]>(this.name);
      if (!Array.isArray(legacy)) return;
      await withLock(`m5cet-p4-${this.name}`, async () => {
        for (const row of legacy) {
          if (!row?.bundle?.id || (await this.vault.getJson<BundleRow>(this.rowName(row.bundle.id)))) continue;
          await this.vault.putJson(this.rowName(row.bundle.id), row);
        }
        await this.vault.delete(this.name);
      });
    })();
    this.migrated = run;
    run.catch(() => { if (this.migrated === run) this.migrated = null; });
    return run;
  }

  async all(): Promise<BundleKeys[]> {
    await (this.migrated ?? this.migrate());
    const ids = await this.vault.keys(`${this.name}:row:`);
    if (ids === null) return [...this.cache.values()]; // a backend that cannot list: what this tab knows
    const present = new Set(ids.map((k) => k.slice(`${this.name}:row:`.length)));
    for (const id of [...this.cache.keys()]) if (!present.has(id)) this.cache.delete(id);
    for (const id of present) {
      if (this.cache.has(id)) continue;
      const keys = await this.loadRow(id);
      if (keys) this.cache.set(id, keys);
    }
    return [...this.cache.values()];
  }

  async put(keys: BundleKeys): Promise<void> {
    await (this.migrated ?? this.migrate());
    await this.writeRow(keys);
    this.cache.set(keys.bundle.id, keys);
  }

  async remove(id: string): Promise<void> {
    this.cache.delete(id);
    await this.vault.delete(this.rowName(id));
    await this.vault.delete(this.dhName(id));
  }
}

/* -------------------------------------------------------------- replay */

type ReplayNote = { roomId: string; key: string; at: number };

/**
 * § 11: accepted ids per room, kept encrypted. The ids are the library's
 * hashes already; the room is named by a hash of its blind id. Reads are from
 * memory after the first load; writes go out at most once a second and MERGE
 * with the stored rows (review P11: another tab's ids are not lost), under a
 * Web Lock. With `share`, the tabs tell each other each accepted id
 * (BroadcastChannel), so a message one tab accepted is a replay in the other
 * at once.
 */
export class VaultReplayStore implements ReplayStore {
  private readonly rooms = new Map<string, Promise<Map<string, number>>>();
  private readonly dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly channel: BroadcastChannel | null = null;

  constructor(private readonly vault: LocalVault, private readonly delayMs = 1000, opts: { share?: boolean } = {}) {
    if (opts.share && typeof BroadcastChannel === "function") {
      try {
        const channel = new BroadcastChannel("m5cet-p4-replay");
        channel.onmessage = (e: MessageEvent) => { void this.noted(e.data as ReplayNote); };
        (channel as unknown as { unref?: () => void }).unref?.();
        this.channel = channel;
      } catch { this.channel = null; }
    }
  }

  private async slot(roomId: string): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`m5cet/p4-replay|${roomId}`)));
    return `replay:${toBase64(digest.slice(0, 12)).replace(/[+/=]/g, "")}`;
  }

  private async stored(roomId: string): Promise<Map<string, number>> {
    const rows = await this.vault.getJson<Array<[string, number]>>(await this.slot(roomId));
    return new Map(Array.isArray(rows) ? rows.filter((r) => Array.isArray(r) && typeof r[0] === "string" && typeof r[1] === "number") : []);
  }

  /** The room's ids in memory (loaded once); a failed load is not cached — the next call tries again. */
  private room(roomId: string): Promise<Map<string, number>> {
    let room = this.rooms.get(roomId);
    if (!room) {
      const loading = this.stored(roomId);
      room = loading;
      this.rooms.set(roomId, loading);
      loading.catch(() => { if (this.rooms.get(roomId) === loading) this.rooms.delete(roomId); });
    }
    return room;
  }

  /** Another tab accepted an id: it is a replay here too. */
  private async noted(note: ReplayNote): Promise<void> {
    if (!note || typeof note.roomId !== "string" || typeof note.key !== "string" || typeof note.at !== "number") return;
    const room = this.rooms.get(note.roomId);
    if (!room) return; // not loaded here: the stored rows will have it
    try { const map = await room; if (!map.has(note.key)) map.set(note.key, note.at); } catch { /* not loaded */ }
  }

  async has(roomId: string, key: string): Promise<boolean> { return (await this.room(roomId)).has(key); }

  async add(roomId: string, key: string, at: number): Promise<void> {
    (await this.room(roomId)).set(key, at);
    try { this.channel?.postMessage({ roomId, key, at } satisfies ReplayNote); } catch { /* closed */ }
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

  private writing: Promise<void> = Promise.resolve();

  /**
   * Writes what changed now (a page going away calls it too); resolves once
   * every earlier write is done as well. Read-merge-write under a Web Lock:
   * ids another tab stored meanwhile are kept (and learned here).
   */
  flush(): Promise<void> {
    this.writing = this.writing.then(async () => {
      const rooms = [...this.dirty];
      this.dirty.clear();
      for (const roomId of rooms) {
        try {
          const room = await this.room(roomId);
          const slot = await this.slot(roomId);
          await withLock(`m5cet-p4-${slot}`, async () => {
            const there = await this.stored(roomId);
            for (const [key, at] of there) if (!room.has(key)) room.set(key, at);
            const cutoff = Date.now() - REPLAY.windowMs;
            const rows = [...room.entries()].filter(([, at]) => at >= cutoff).sort((a, b) => a[1] - b[1]).slice(-REPLAY.maxIdsPerRoom);
            await this.vault.putJson(slot, rows);
          });
        } catch {
          this.dirty.add(roomId); // the vault failed: the next flush tries again
        }
      }
    });
    return this.writing;
  }

  size(roomId: string): Promise<number> { return this.room(roomId).then((r) => r.size); }

  /** Stops listening to the other tabs (and the pending timed write; call flush() first to keep it). */
  close(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try { this.channel?.close(); } catch { /* closed */ }
  }
}

let sharedReplay: { store: VaultReplayStore; guard: ReplayGuard } | null = null;

/** This device's replay window — ONE for the room on screen and the background rooms (they write the same rows). */
export function deviceReplay(): { store: VaultReplayStore; guard: ReplayGuard } {
  if (!sharedReplay) {
    const store = new VaultReplayStore(deviceVault(), 1000, { share: true });
    sharedReplay = { store, guard: new ReplayGuard(store) };
  }
  return sharedReplay;
}

/* ------------------------------------------------- key transparency pins */

const KT_KEY = "m5cet:kt:v1";

/** § 14.4: per server origin — the pinned KT key, the newest tree head, an alert, the proofs the server owes. Public data. */
export class LocalKtStore implements KtStore {
  private memory: Record<string, KtOriginState> = {};

  constructor(private readonly storage: Storage | null = (() => { try { return localStorage; } catch { return null; } })()) {}

  private read(): Record<string, KtOriginState> {
    if (!this.storage) return this.memory;
    try { return JSON.parse(this.storage.getItem(KT_KEY) || "{}") as Record<string, KtOriginState>; } catch { return {}; }
  }

  async get(origin: string): Promise<KtOriginState | null> {
    const s = this.read()[origin];
    return s ? { key: s.key ?? null, sth: s.sth ?? null, alert: s.alert ?? null, ...(Array.isArray(s.pending) ? { pending: s.pending } : {}) } : null;
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
