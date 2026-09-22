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
//             Its database expires after a day.
//
// Operations never take a database id from the caller: the caller proves
// who they are, and the server looks up which database that is.

import { accountStore, type AccountStore } from "../accounts/store";
import { storage as defaultStorage, type StorageService } from "./service";
import type { UserDatabase } from "./user-store";
import type { LogLevel } from "./global-store";

export type Caller =
  | { kind: "account"; accountId: string }
  | { kind: "session"; sessionId: string }
  | { kind: "none" };

export type ApiResult = { ok: true; status?: number; data?: unknown } | { ok: false; status: number; error: string; code?: string };

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

/** The caller's database, or the reason there is none to work with. */
function database(ctx: ApiContext, caller: Caller): { db: UserDatabase } | { error: ApiResult } {
  if (!ctx.storage.isAvailable) return { error: fail(503, ctx.storage.unavailableReason ?? "storage is not available", "unavailable") };
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

const str = (value: unknown, max = 120): string => String(value ?? "").slice(0, max);
const num = (value: unknown, fallback = 0): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

/**
 * Runs one operation. `payload` is whatever the caller sent — the shapes are
 * checked here so both transports get the same treatment.
 */
export function runStorageOp(ctx: ApiContext, caller: Caller, op: StorageOp, payload: Record<string, unknown> = {}): ApiResult {
  const { storage } = ctx;

  // These work without a database of one's own.
  if (op === "status") {
    return ok({
      ...storage.status(),
      caller: caller.kind,
      ...(caller.kind === "account" ? { locked: storage.account(caller.accountId) === null } : {}),
    });
  }

  if (op === "session.start") {
    if (!storage.isAvailable) return fail(503, storage.unavailableReason ?? "storage is not available", "unavailable");
    if (caller.kind === "account") return fail(400, "a signed-in user already has a database", "signed-in");
    try {
      const handle = storage.startSession(str(payload.sessionId, 96) || undefined);
      return ok(handle);
    } catch (err) {
      return fail(503, (err as Error).message, "unavailable");
    }
  }

  if (op === "open") {
    if (caller.kind !== "account") return fail(401, "only a signed-in user opens a database with a key", "no-account");
    const result = storage.openAccount(caller.accountId, payload.key);
    if (!result.ok) return fail(result.reason.includes("does not open") ? 403 : 400, result.reason, "key");
    storage.log({ level: "info", source: "server", event: "storage.opened", accountId: caller.accountId });
    return ok(result);
  }

  if (op === "promote") {
    if (caller.kind !== "account") return fail(401, "sign in with your passkey first", "no-account");
    const sessionId = str(payload.sessionId, 96);
    const result = storage.promoteSession(sessionId, caller.accountId, payload.key);
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
    const level = str(payload.level, 10) as LogLevel;
    if (!["debug", "info", "warn", "error"].includes(level)) return fail(400, "unknown log level");
    storage.log({
      level,
      source: "client",
      event: str(payload.event, 120) || "client-event",
      accountId: caller.kind === "account" ? caller.accountId : null,
      sessionId: caller.kind === "session" ? caller.sessionId : null,
      detail: payload.detail,
    });
    return ok({ recorded: true });
  }

  if (op === "transfer.record") {
    const id = str(payload.id, 80);
    if (!id) return fail(400, "transfer id required");
    storage.recordTransfer({
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
      detail: payload.detail,
    });
    return ok({ recorded: true });
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
      return ok({ key, value: db.get(key) });
    }
    case "kv.put": {
      const key = str(payload.key);
      if (!key) return fail(400, "key required");
      try {
        db.put(key, payload.value);
      } catch (err) {
        return fail(413, (err as Error).message, "too-large");
      }
      return ok({ key, stored: true });
    }
    case "kv.delete": {
      const key = str(payload.key);
      if (!key) return fail(400, "key required");
      return ok({ key, removed: db.remove(key) });
    }
    case "kv.keys":
      return ok({ keys: db.keys() });

    case "messages.read":
      return ok({
        messages: db.readMessages({
          room: str(payload.room, 64) || undefined,
          since: num(payload.since) || undefined,
          limit: num(payload.limit, 500),
        }),
      });
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
      db.putMessages(messages);
      return ok({ stored: messages.length, summary: db.summary() });
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
