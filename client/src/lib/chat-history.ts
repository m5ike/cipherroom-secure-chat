// Chat history: what "keep this conversation" means in each retention mode.
//
//   ephemeral   nothing is kept. A new connection starts with an empty room.
//   session     kept for this browser session: a reload comes back to the
//               same conversation, closing the tab or signing out ends it.
//               Stored encrypted in sessionStorage, the key is a
//               non-extractable CryptoKey in IndexedDB (as session-cache.ts).
//   server      kept in the signed-in user's vault, sealed with the passkey
//               key before upload (account.ts).
//
// In every mode the history is trimmed before it is stored: the on-wire
// ciphertext is dropped (it is reproducible noise), a big attachment becomes
// its name and size, and only the most recent messages survive the byte
// budget. Storing a conversation must never fail because someone sent a
// video.

import { toBase64, fromBase64 } from "./crypto";
import type { ChatMessage } from "./chat-types";

export type ChatRetention = "ephemeral" | "session" | "server";

export const HISTORY_LIMITS = {
  /** Newest messages kept. */
  maxMessages: 500,
  /** An attachment above this (base64 chars ≈ ¾ bytes) is stored as metadata. */
  maxAttachmentChars: 256_000,
  /** Total budget for the serialized history. */
  maxBytes: 4_000_000,
} as const;

export function isChatRetention(value: unknown): value is ChatRetention {
  return value === "ephemeral" || value === "session" || value === "server";
}

/** Strips a message down to what is worth storing. */
function slim(message: ChatMessage): ChatMessage {
  const { cipher: _cipher, ...rest } = message;
  const out: ChatMessage = { ...rest };
  if (out.attachment) {
    const url = out.attachment.dataUrl || "";
    // A blob: URL points at this page's memory — useless once it is gone.
    if (!url.startsWith("data:") || url.length > HISTORY_LIMITS.maxAttachmentChars) {
      out.attachment = { ...out.attachment, dataUrl: "", dropped: true };
    }
  }
  if (out.audit && out.audit.length > 12) out.audit = out.audit.slice(-12);
  return out;
}

/** The history to store: trimmed, newest-first budget, chronological order. */
export function prepareHistory(messages: ChatMessage[]): ChatMessage[] {
  const recent = messages.filter((m) => !m.vanished).slice(-HISTORY_LIMITS.maxMessages).map(slim);
  const kept: ChatMessage[] = [];
  let bytes = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const size = JSON.stringify(recent[i]).length + 1;
    if (bytes + size > HISTORY_LIMITS.maxBytes) break;
    bytes += size;
    kept.push(recent[i]);
  }
  return kept.reverse();
}

export function historyStats(messages: ChatMessage[]): { messages: number; bytes: number; attachments: number } {
  return {
    messages: messages.length,
    bytes: JSON.stringify(messages).length,
    attachments: messages.filter((m) => m.attachment && !m.attachment.dropped).length,
  };
}

/** Messages restored from storage, keeping only ones that still make sense. */
export function sanitizeRestored(value: unknown, myPeerId?: string): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  const now = Date.now();
  return value
    .filter((m): m is ChatMessage => Boolean(m) && typeof m === "object" && typeof (m as ChatMessage).id === "string" && typeof (m as ChatMessage).createdAt === "number")
    .filter((m) => !m.expiresAt || m.expiresAt > now)
    .slice(-HISTORY_LIMITS.maxMessages)
    .map((m) => ({ ...m, mine: myPeerId ? m.senderId === myPeerId : m.mine }));
}

/* ------------------------------------------------- session-scoped storage */

const STORAGE_KEY = "m5cet:history:v1";
const DB_NAME = "m5cet-history";
const STORE = "keys";
const KEY_ID = "session";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Stored = { v: 1; iv: string; ct: string; room: string; savedAt: number };

export type HistoryStore = {
  save(room: string, messages: ChatMessage[]): Promise<void>;
  load(room: string): Promise<ChatMessage[]>;
  clear(): Promise<void>;
};

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

/** Per-session encrypted history. Falls back to doing nothing when the
 *  browser denies storage (private mode) — never throws at the caller. */
export function createHistoryStore(opts: { storage?: Storage; keys?: Map<string, CryptoKey> } = {}): HistoryStore {
  let storage: Storage | null = null;
  try { storage = opts.storage ?? (typeof sessionStorage !== "undefined" ? sessionStorage : null); } catch { storage = null; }
  const memoryKeys = opts.keys ?? null;

  async function key(create: boolean): Promise<CryptoKey | null> {
    if (memoryKeys) {
      const existing = memoryKeys.get(KEY_ID);
      if (existing || !create) return existing ?? null;
      const fresh = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      memoryKeys.set(KEY_ID, fresh);
      return fresh;
    }
    try {
      const row = await tx<{ id: string; key: CryptoKey }>("readonly", (s) => s.get(KEY_ID));
      const found = (row as { key?: CryptoKey } | undefined)?.key ?? null;
      if (found || !create) return found;
      const fresh = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      await tx("readwrite", (s) => s.put({ id: KEY_ID, key: fresh }));
      return fresh;
    } catch { return null; }
  }

  return {
    async save(room, messages) {
      if (!storage) return;
      try {
        const k = await key(true);
        if (!k) return;
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const payload = encoder.encode(JSON.stringify(prepareHistory(messages)));
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, payload));
        const record: Stored = { v: 1, iv: toBase64(iv), ct: toBase64(ct), room, savedAt: Date.now() };
        storage.setItem(STORAGE_KEY, JSON.stringify(record));
      } catch { /* quota or crypto unavailable: the chat simply is not kept */ }
    },

    async load(room) {
      if (!storage) return [];
      try {
        const raw = storage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const record = JSON.parse(raw) as Partial<Stored>;
        if (record.v !== 1 || typeof record.ct !== "string" || typeof record.iv !== "string") return [];
        if (record.room !== room) return [];
        const k = await key(false);
        if (!k) return [];
        const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(record.iv) }, k, fromBase64(record.ct));
        return sanitizeRestored(JSON.parse(decoder.decode(plain)));
      } catch { return []; }
    },

    async clear() {
      try { storage?.removeItem(STORAGE_KEY); } catch { /* ignore */ }
      try {
        if (memoryKeys) memoryKeys.clear();
        else await tx("readwrite", (s) => s.delete(KEY_ID));
      } catch { /* ignore */ }
    },
  };
}
