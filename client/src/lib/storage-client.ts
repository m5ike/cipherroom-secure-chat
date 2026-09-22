// Talking to the server-side storage (server/storage/*).
//
// Two kinds of caller, and the module keeps track of which one we are:
//
//   signed in   The account's token plus the database key derived from the
//               passkey. The key opens a SQLCipher database on the server;
//               it is sent once per server process and kept here wrapped
//               with the (non-extractable) vault key, so a reload can send
//               it again without another passkey prompt.
//
//   session     A browser in server-enhanced mode without a passkey. The
//               server hands out a session id; its data lives for a day and
//               goes at once when the user clears everything.
//
// Operations go over the signaling socket when one is available — it is
// already open and costs no round trip — and fall back to REST otherwise.

import { toBase64, fromBase64 } from "./crypto";

export type StorageStatus = {
  available: boolean;
  reason: string | null;
  engine: string;
  caller: "account" | "session" | "none";
  locked?: boolean;
  openDatabases: number;
  stats: { users: number; databases: number; sessions: number; logs: number; transfers: number; bytes: number } | null;
};

export type StoredMessage = {
  id: string;
  room: string;
  createdAt: number;
  senderId?: string;
  senderName?: string;
  mine?: boolean;
  expiresAt?: number;
  payload: unknown;
};

export type StorageSummary = {
  summary: { messages: number; messageBytes: number; rooms: number; keys: number; mailbox: number; events: number };
  rooms: Array<{ room: string; firstSeenAt: number; lastSeenAt: number; messages: number }>;
  mailbox: { pending: number; bytes: number };
};

const SESSION_KEY = "m5cet:storage:session:v1";
const DBKEY_KEY = "m5cet:storage:dbkey:v1";

let token: string | null = null;
let sessionId: string | null = null;
let databaseKey: string | null = null;
let socket: WebSocket | null = null;
let frameCounter = 0;
const pending = new Map<string, { resolve: (data: unknown) => void; reject: (err: Error) => void; timer: number }>();

/* --------------------------------------------------------------- identity */

export function setStorageToken(next: string | null): void {
  token = next;
}

export function storageSessionId(): string | null {
  if (sessionId) return sessionId;
  try { sessionId = sessionStorage.getItem(SESSION_KEY); } catch { sessionId = null; }
  return sessionId;
}

function rememberSession(id: string | null): void {
  sessionId = id;
  try {
    if (id) sessionStorage.setItem(SESSION_KEY, id);
    else sessionStorage.removeItem(SESSION_KEY);
  } catch { /* private mode: this tab only */ }
}

/** Keeps the database key for this tab, wrapped with the vault key so it is
 *  not lying around in clear text. */
export async function rememberDatabaseKey(key: string, wrapWith: CryptoKey | null): Promise<void> {
  databaseKey = key;
  if (!wrapWith) return;
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrapWith, new TextEncoder().encode(key)));
    sessionStorage.setItem(DBKEY_KEY, JSON.stringify({ iv: toBase64(iv), ct: toBase64(ct) }));
  } catch { /* the key simply has to be derived again after a reload */ }
}

export async function recallDatabaseKey(unwrapWith: CryptoKey | null): Promise<string | null> {
  if (databaseKey) return databaseKey;
  if (!unwrapWith) return null;
  try {
    const raw = sessionStorage.getItem(DBKEY_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw) as { iv: string; ct: string };
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(rec.iv) }, unwrapWith, fromBase64(rec.ct));
    databaseKey = new TextDecoder().decode(plain);
    return databaseKey;
  } catch {
    return null;
  }
}

export function forgetDatabaseKey(): void {
  databaseKey = null;
  try { sessionStorage.removeItem(DBKEY_KEY); } catch { /* ignore */ }
}

/* ------------------------------------------------------------- transports */

/** Hands the module the signaling socket; storage frames then ride on it. */
export function attachStorageSocket(next: WebSocket | null): void {
  socket = next;
  if (!next) return;
  next.addEventListener("message", (event) => {
    let frame: { type?: string; id?: string; ok?: boolean; data?: unknown; message?: string; code?: string };
    try { frame = JSON.parse(String((event as MessageEvent).data)) as typeof frame; } catch { return; }
    if (frame.type !== "storage-result" || !frame.id) return;
    const waiter = pending.get(frame.id);
    if (!waiter) return;
    pending.delete(frame.id);
    window.clearTimeout(waiter.timer);
    if (frame.ok) waiter.resolve(frame.data ?? null);
    else waiter.reject(Object.assign(new Error(frame.message || "storage error"), { code: frame.code }));
  });
}

function socketReady(): boolean {
  return Boolean(socket && socket.readyState === WebSocket.OPEN);
}

function viaSocket(op: string, payload: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = `st-${++frameCounter}`;
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error("storage request timed out"));
    }, 15_000);
    pending.set(id, { resolve, reject, timer });
    socket!.send(JSON.stringify({
      type: "storage",
      id,
      op,
      payload,
      ...(token ? { auth: token } : {}),
      ...(storageSessionId() ? { session: storageSessionId() } : {}),
    }));
  });
}

async function viaRest(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`/api/storage${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(storageSessionId() ? { "X-M5cet-Session": storageSessionId()! } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (!res.ok) throw Object.assign(new Error(String(json.message || `storage error ${res.status}`)), { code: json.code, status: res.status });
  return json;
}

/** One operation, over whichever transport is available. */
async function call(op: string, payload: Record<string, unknown> = {}, rest?: { method: string; path: string; body?: unknown }): Promise<unknown> {
  if (socketReady()) {
    try { return await viaSocket(op, payload); } catch (err) {
      const code = (err as { code?: string }).code;
      // A refusal is an answer; only a broken socket is worth retrying.
      if (code || !rest) throw err;
    }
  }
  if (!rest) throw new Error(`no transport for ${op}`);
  return viaRest(rest.method, rest.path, rest.body);
}

/* ------------------------------------------------------------ operations */

export async function storageStatus(): Promise<StorageStatus | null> {
  try { return await viaRest("GET", "/status") as StorageStatus; } catch { return null; }
}

/** Starts (or resumes) the day-long store of a browser without a passkey. */
export async function startStorageSession(): Promise<{ sessionId: string; expiresAt: number } | null> {
  try {
    const data = await viaRest("POST", "/session", { sessionId: storageSessionId() }) as { sessionId?: string; expiresAt?: number };
    if (!data.sessionId) return null;
    rememberSession(data.sessionId);
    return { sessionId: data.sessionId, expiresAt: Number(data.expiresAt) || 0 };
  } catch {
    return null;
  }
}

/** Opens the signed-in user's database with the passkey-derived key. */
export async function openUserDatabase(key: string): Promise<{ databaseId: string } | null> {
  try {
    const data = await call("open", { key }, { method: "POST", path: "/open", body: { key } }) as { databaseId?: string } | null;
    databaseKey = key;
    return data?.databaseId ? { databaseId: data.databaseId } : { databaseId: "" };
  } catch {
    return null;
  }
}

/** Moves what this browser stored as a session into the account database. */
export async function promoteSessionToAccount(key: string): Promise<{ moved: { messages: number; keys: number } } | null> {
  const session = storageSessionId();
  if (!session) return null;
  try {
    const data = await viaRest("POST", "/promote", { sessionId: session, key }) as { moved?: { messages: number; keys: number } };
    rememberSession(null); // the session store no longer exists
    return { moved: data.moved ?? { messages: 0, keys: 0 } };
  } catch {
    return null;
  }
}

export async function storageSummary(): Promise<StorageSummary | null> {
  try { return await call("summary", {}, { method: "GET", path: "/summary" }) as StorageSummary; } catch { return null; }
}

export async function putValue(key: string, value: unknown): Promise<boolean> {
  try {
    await call("kv.put", { key, value }, { method: "PUT", path: "/kv", body: { key, value } });
    return true;
  } catch { return false; }
}

export async function getValue<T>(key: string): Promise<T | null> {
  try {
    const data = await call("kv.get", { key }, { method: "GET", path: `/kv?key=${encodeURIComponent(key)}` }) as { value?: T };
    return (data?.value ?? null) as T | null;
  } catch { return null; }
}

export async function putMessages(messages: StoredMessage[]): Promise<number> {
  if (messages.length === 0) return 0;
  try {
    const data = await call("messages.put", { messages }, { method: "POST", path: "/messages", body: { messages } }) as { stored?: number };
    return Number(data?.stored ?? 0);
  } catch { return 0; }
}

export async function readMessages(filter: { room?: string; since?: number; limit?: number } = {}): Promise<StoredMessage[]> {
  try {
    const query = new URLSearchParams();
    if (filter.room) query.set("room", filter.room);
    if (filter.since) query.set("since", String(filter.since));
    if (filter.limit) query.set("limit", String(filter.limit));
    const data = await call("messages.read", filter as Record<string, unknown>, { method: "GET", path: `/messages?${query.toString()}` }) as { messages?: StoredMessage[] };
    return data?.messages ?? [];
  } catch { return []; }
}

export async function deleteMessages(room?: string): Promise<number> {
  try {
    const data = await call("messages.delete", { room }, { method: "DELETE", path: room ? `/messages?room=${encodeURIComponent(room)}` : "/messages" }) as { removed?: number };
    return Number(data?.removed ?? 0);
  } catch { return 0; }
}

/** The user's own audit trail, inside their encrypted database. */
export async function addStorageEvent(kind: string, meta?: unknown): Promise<void> {
  try { await call("events.add", { kind, meta }, { method: "POST", path: "/events", body: { kind, meta } }); } catch { /* best effort */ }
}

export async function readStorageEvents(limit = 100): Promise<Array<{ at: number; kind: string; meta?: unknown }>> {
  try {
    const data = await call("events.read", { limit }, { method: "GET", path: `/events?limit=${limit}` }) as { events?: Array<{ at: number; kind: string; meta?: unknown }> };
    return data?.events ?? [];
  } catch { return []; }
}

/** A log / debug line for the operator's table. */
export async function sendLog(level: "debug" | "info" | "warn" | "error", event: string, detail?: unknown): Promise<void> {
  try { await call("log", { level, event, detail }, { method: "POST", path: "/log", body: { level, event, detail } }); } catch { /* never breaks a flow */ }
}

/** One row in the transfer table — what went where, and how it ended. */
export async function recordTransfer(record: {
  id: string;
  direction: "in" | "out";
  transport: "p2p" | "proxy";
  status: "started" | "completed" | "cancelled" | "failed";
  bytes?: number;
  chunks?: number;
  resentChunks?: number;
  roomHash?: string;
  finishedAt?: number;
  detail?: unknown;
}): Promise<void> {
  try { await call("transfer.record", record as unknown as Record<string, unknown>, { method: "POST", path: "/transfers", body: record }); } catch { /* ditto */ }
}

export async function readTransfers(limit = 100): Promise<Array<Record<string, unknown>>> {
  try {
    const data = await call("transfers.read", { limit }, { method: "GET", path: `/transfers?limit=${limit}` }) as { transfers?: Array<Record<string, unknown>> };
    return data?.transfers ?? [];
  } catch { return []; }
}

/** "Clear everything and leave": the server forgets this user or session. */
export async function forgetServerData(): Promise<boolean> {
  try {
    await call("forget", {}, { method: "DELETE", path: "" });
    rememberSession(null);
    forgetDatabaseKey();
    return true;
  } catch {
    return false;
  }
}

/** Test seam. */
export function _resetStorageClientForTests(): void {
  token = null;
  sessionId = null;
  databaseKey = null;
  socket = null;
  pending.clear();
  try { sessionStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(DBKEY_KEY); } catch { /* ignore */ }
}
