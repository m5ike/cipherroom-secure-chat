// The storage API, in one place.
//
// Both surfaces — REST (routes.ts below) and WebSocket (ws.ts) — call the
// same operations, so a client can use whichever is cheaper: the socket it
// already holds for signaling, or a plain request.
//
// Who is asking is decided once, here:
//
//   account   Authorization: Bearer <account token>. The database must have
//             been opened with the passkey-derived key first ("open"),
//             otherwise every operation answers `locked` and the client
//             knows to send the key again.
//   session   X-M5cet-Session: <session id> — a browser without a passkey.
//             Its database expires a day after its last use.
//
// Operations never take a database id from the caller: the caller proves
// who they are, and the server looks up which database that is. Log lines
// and transfer records need an identity too (an account, or a session that
// exists), and each caller has an hourly quota for them.

import { accountStore, type AccountStore } from "../accounts/store";
import { storage as defaultStorage, type StorageService } from "./service";
import { RESERVED_KEYS, type UserDatabase } from "./user-store";
import type { LogLevel } from "./global-store";
import {
  DatabaseOpenError, PayloadTooLargeError, QuotaExceededError, ReservedKeyError, SessionLimitError, StorageUnavailableError,
} from "./db";
import { MasterKeyError, sessionRef } from "./keys";

export type Caller =
  | { kind: "account"; accountId: string }
  | { kind: "session"; sessionId: string }
  | { kind: "none" };

export type ApiResult = { ok: true; status?: number; data?: unknown } | { ok: false; status: number; error: string; code?: string };

/** What the transport knows about the caller beyond who they claim to be. */
export type OpMeta = {
  /** Opaque identity of the client (the truncated IP): caps new sessions. */
  clientKey?: string;
  /** Who holds an account key open: the hash of the bearer token. */
  holder?: string;
};

const ok = (data?: unknown): ApiResult => ({ ok: true, data });
const fail = (status: number, error: string, code?: string): ApiResult => ({ ok: false, status, error, ...(code ? { code } : {}) });

/** Every operation the storage API offers, over either transport. */
export const STORAGE_OPS = [
  "status", "session.start", "open", "promote", "summary",
  "kv.get", "kv.put", "kv.delete", "kv.keys",
  "messages.read", "messages.put", "messages.delete", "rooms",
  "mailbox.read", "mailbox.take",
  "events.read", "events.add",
  "log", "transfer.record", "transfers.read",
  "forget",
] as const;

export type StorageOp = typeof STORAGE_OPS[number];

export function isStorageOp(value: unknown): value is StorageOp {
  return typeof value === "string" && (STORAGE_OPS as readonly string[]).includes(value);
}

export type ApiContext = {
  storage: StorageService;
  accounts: AccountStore;
};

export function apiContext(storage: StorageService = defaultStorage, accounts: AccountStore = accountStore): ApiContext {
  return { storage, accounts };
}

/** Resolves a caller from a bearer token and/or a session id. */
export function resolveCaller(ctx: ApiContext, input: { token?: string | null; sessionId?: string | null }): Caller {
  const token = (input.token ?? "").trim();
  if (token) {
    const account = ctx.accounts.resolveToken(token);
    if (account) return { kind: "account", accountId: account.id };
  }
  const sessionId = (input.sessionId ?? "").trim();
  if (sessionId) return { kind: "session", sessionId };
  return { kind: "none" };
}

/**
 * An opaque client identity from an address: an IPv4 address as it is, an
 * IPv6 address cut to its /64 (one household or host usually owns a whole
 * /64, so counting single addresses there would count nothing).
 */
export function clientKeyFor(address: string | null | undefined): string {
  const bare = String(address ?? "").trim().replace(/^::ffff:/i, "").replace(/%.*$/, "");
  if (!bare) return "ip:unknown";
  if (!bare.includes(":")) return `ip:${bare.slice(0, 45)}`;
  const [head, tail] = bare.toLowerCase().split("::", 2);
  const left = head ? head.split(":") : [];
  const right = tail === undefined ? [] : tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `ip6:${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "") || "0").join(":")}::/64`;
}

/** The caller's database, or the reason there is none to work with. */
function database(ctx: ApiContext, caller: Caller): { db: UserDatabase } | { error: ApiResult } {
  if (!ctx.storage.isAvailable) return { error: fail(503, "storage is not available", "unavailable") };
  if (caller.kind === "account") {
    const db = ctx.storage.account(caller.accountId);
    if (!db) return { error: fail(409, "send the database key derived from your passkey first", "locked") };
    return { db };
  }
  if (caller.kind === "session") {
    const db = ctx.storage.openSession(caller.sessionId);
    if (!db) return { error: fail(404, "this session has no storage (it may have expired)", "no-session") };
    return { db };
  }
  return { error: fail(401, "sign in with a passkey, or start a session first", "no-caller") };
}

/** Who may write log lines and transfer records, and their quota key. */
function writer(ctx: ApiContext, caller: Caller): { key: string } | { error: ApiResult } {
  if (!ctx.storage.isAvailable) return { error: fail(503, "storage is not available", "unavailable") };
  if (caller.kind === "account") return { key: `a:${caller.accountId}` };
  if (caller.kind === "session") {
    if (!ctx.storage.sessionExists(caller.sessionId)) return { error: fail(404, "this session has no storage (it may have expired)", "no-session") };
    return { key: `s:${sessionRef(caller.sessionId)}` };
  }
  return { error: fail(401, "sign in with a passkey, or start a session first", "no-caller") };
}

const str = (value: unknown, max = 120): string => String(value ?? "").slice(0, max);
const num = (value: unknown, fallback = 0): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

/** A client-supplied detail, or a marker when it is over the cap. */
function clientDetail(value: unknown, max: number): unknown {
  if (value === undefined) return undefined;
  const json = JSON.stringify(value) ?? "null";
  return json.length <= max ? value : { truncated: true, bytes: json.length };
}

/** Typed storage errors → answers; anything else is the caller's 500. */
function mapError(err: unknown): ApiResult | null {
  if (err instanceof QuotaExceededError) return fail(413, "your storage is full; delete something first", "quota");
  if (err instanceof PayloadTooLargeError) return fail(413, err.message, "too-large");
  if (err instanceof ReservedKeyError) return fail(400, err.message, "reserved");
  if (err instanceof SessionLimitError) {
    return err.scope === "client" ? fail(429, err.message, "rate-limit") : fail(503, err.message, "capacity");
  }
  if (err instanceof DatabaseOpenError) return fail(503, "the database could not be opened right now; try again", "busy");
  if (err instanceof StorageUnavailableError || err instanceof MasterKeyError) return fail(503, "storage is not available", "unavailable");
  return null;
}

/**
 * Runs one operation. `payload` is whatever the caller sent — the shapes are
 * checked here so both transports get the same treatment.
 */
export function runStorageOp(ctx: ApiContext, caller: Caller, op: StorageOp, payload: Record<string, unknown> = {}, meta: OpMeta = {}): ApiResult {
  try {
    return run(ctx, caller, op, payload, meta);
  } catch (err) {
    const mapped = mapError(err);
    if (mapped) return mapped;
    throw err;
  }
}

function run(ctx: ApiContext, caller: Caller, op: StorageOp, payload: Record<string, unknown>, meta: OpMeta): ApiResult {
  const { storage } = ctx;

  // These work without a database of one's own.
  if (op === "status") {
    // What a browser needs to decide, nothing more: no paths, no counts.
    // The operator's view is /api/admin/storage.
    return ok({
      available: storage.isAvailable,
      engine: "sqlite+sqlcipher",
      caller: caller.kind,
      ...(caller.kind === "account" ? { locked: storage.account(caller.accountId) === null } : {}),
    });
  }

  if (op === "session.start") {
    if (!storage.isAvailable) return fail(503, "storage is not available", "unavailable");
    if (caller.kind === "account") return fail(400, "a signed-in user already has a database", "signed-in");
    try {
      const handle = storage.startSession(str(payload.sessionId, 96) || undefined, { clientKey: meta.clientKey });
      return ok(handle);
    } catch (err) {
      const mapped = mapError(err);
      if (mapped) return mapped;
      return fail(503, "storage is not available", "unavailable");
    }
  }

  if (op === "open") {
    if (caller.kind !== "account") return fail(401, "only a signed-in user opens a database with a key", "no-account");
    const result = storage.openAccount(caller.accountId, payload.key, meta.holder);
    if (!result.ok) {
      switch (result.code) {
        case "wrong-key": return fail(403, result.reason, "key");
        case "io": return fail(503, result.reason, "busy");
        case "corrupt":
        case "missing": return fail(500, result.reason, "damaged");
        default: return fail(400, result.reason, "key");
      }
    }
    storage.log({ level: "info", source: "server", event: "storage.opened", accountId: caller.accountId });
    return ok(result);
  }

  if (op === "promote") {
    if (caller.kind !== "account") return fail(401, "sign in with your passkey first", "no-account");
    const sessionId = str(payload.sessionId, 96);
    const result = storage.promoteSession(sessionId, caller.accountId, payload.key, meta.holder);
    if (!result.ok) return fail(400, result.reason, "promote");
    return ok(result);
  }

  if (op === "forget") {
    const removed = caller.kind === "account"
      ? storage.forget({ accountId: caller.accountId })
      : caller.kind === "session" ? storage.forget({ sessionId: caller.sessionId })
        : { removed: false };
    return ok(removed);
  }

  if (op === "log") {
    const who = writer(ctx, caller);
    if ("error" in who) return who.error;
    const level = str(payload.level, 10) as LogLevel;
    if (!["debug", "info", "warn", "error"].includes(level)) return fail(400, "unknown log level");
    if (!storage.consume("log", who.key)) return fail(429, "too many log lines; slow down", "rate-limit");
    storage.log({
      level,
      source: "client",
      event: str(payload.event, 120) || "client-event",
      accountId: caller.kind === "account" ? caller.accountId : null,
      sessionId: caller.kind === "session" ? caller.sessionId : null,
      detail: clientDetail(payload.detail, storage.limits.clientDetailBytes),
    });
    return ok({ recorded: true });
  }

  if (op === "transfer.record") {
    const who = writer(ctx, caller);
    if ("error" in who) return who.error;
    const id = str(payload.id, 80);
    if (!id) return fail(400, "transfer id required");
    if (!storage.consume("transfer", who.key)) return fail(429, "too many transfer records; slow down", "rate-limit");
    const recorded = storage.recordTransfer({
      id,
      at: num(payload.at, Date.now()),
      finishedAt: num(payload.finishedAt),
      direction: payload.direction === "in" ? "in" : "out",
      transport: payload.transport === "proxy" ? "proxy" : "p2p",
      status: ["started", "completed", "cancelled", "failed"].includes(str(payload.status, 20)) ? str(payload.status, 20) as "started" : "started",
      accountId: caller.kind === "account" ? caller.accountId : null,
      sessionId: caller.kind === "session" ? caller.sessionId : null,
      roomHash: str(payload.roomHash, 64),
      bytes: num(payload.bytes),
      chunks: num(payload.chunks),
      resentChunks: num(payload.resentChunks),
      detail: clientDetail(payload.detail, storage.limits.clientDetailBytes),
    });
    return ok({ recorded });
  }

  if (op === "transfers.read") {
    if (!storage.isAvailable) return fail(503, "storage is not available", "unavailable");
    if (caller.kind === "none") return fail(401, "who is asking?", "no-caller");
    return ok({
      transfers: storage.global.readTransfers({
        accountId: caller.kind === "account" ? caller.accountId : undefined,
        sessionId: caller.kind === "session" ? caller.sessionId : undefined,
        since: num(payload.since) || undefined,
        limit: num(payload.limit, 100),
      }),
    });
  }

  // Everything below needs the caller's own database.
  const handle = database(ctx, caller);
  if ("error" in handle) return handle.error;
  const db = handle.db;

  switch (op) {
    case "summary":
      return ok({ summary: db.summary(), rooms: db.rooms(), mailbox: db.mailboxStats() });

    case "kv.get": {
      const key = str(payload.key);
      if (!key) return fail(400, "key required");
      return ok({ key, value: RESERVED_KEYS.has(key) ? null : db.get(key) });
    }
    case "kv.put": {
      const key = str(payload.key);
      if (!key) return fail(400, "key required");
      if (RESERVED_KEYS.has(key)) return fail(400, `"${key}" is reserved`, "reserved");
      db.put(key, payload.value);
      return ok({ key, stored: true });
    }
    case "kv.delete": {
      const key = str(payload.key);
      if (!key) return fail(400, "key required");
      if (RESERVED_KEYS.has(key)) return fail(400, `"${key}" is reserved`, "reserved");
      return ok({ key, removed: db.remove(key) });
    }
    case "kv.keys":
      return ok({ keys: db.keys().filter((key) => !RESERVED_KEYS.has(key)) });

    case "messages.read": {
      const afterSeq = typeof payload.afterSeq === "number" && Number.isFinite(payload.afterSeq) && payload.afterSeq >= 0 ? payload.afterSeq : undefined;
      const page = db.readMessagesPage({
        room: str(payload.room, 64) || undefined,
        since: num(payload.since) || undefined,
        afterSeq,
        limit: num(payload.limit, 500),
      });
      return ok({ messages: page.messages, more: page.more, lastSeq: page.lastSeq });
    }
    case "messages.put": {
      const list = Array.isArray(payload.messages) ? payload.messages : [];
      if (list.length === 0) return ok({ stored: 0 });
      if (list.length > 2_000) return fail(413, "too many messages in one call", "too-large");
      const messages = list
        .filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === "object")
        .map((m) => ({
          id: str(m.id, 120),
          room: str(m.room, 64),
          createdAt: num(m.createdAt, Date.now()),
          senderId: str(m.senderId, 64),
          senderName: str(m.senderName, 64),
          mine: m.mine === true,
          expiresAt: num(m.expiresAt),
          payload: m.payload ?? m,
        }))
        .filter((m) => m.id && m.room);
      const result = db.putMessagesDetailed(messages);
      return ok({
        stored: result.stored,
        ...(result.skipped.length ? { skipped: result.skipped, code: "too-large" } : {}),
        // Answered on every autosave: counts without scanning the table.
        summary: db.usage(),
      });
    }
    case "messages.delete":
      return ok({
        removed: db.deleteMessages({
          room: str(payload.room, 64) || undefined,
          before: num(payload.before) || undefined,
        }),
      });
    case "rooms":
      return ok({ rooms: db.rooms() });

    case "mailbox.read":
      return ok({ items: db.mailbox(str(payload.room, 64) || undefined) });
    case "mailbox.take": {
      const ids = Array.isArray(payload.ids) ? payload.ids.filter((x): x is string => typeof x === "string").slice(0, 500) : [];
      return ok({ items: db.takeMail(ids) });
    }

    case "events.read":
      return ok({ events: db.events(num(payload.limit, 100)) });
    case "events.add":
      db.addEvent({ at: Date.now(), kind: str(payload.kind, 60) || "event", meta: payload.meta });
      return ok({ recorded: true });

    default:
      return fail(400, `unknown operation ${op}`);
  }
}
