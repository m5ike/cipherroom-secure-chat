// REST surface of the storage API (the operations live in api.ts).
//
//   GET    /api/storage/status                what this server offers (no paths or counts)
//   POST   /api/storage/session               start / resume an anonymous store
//   POST   /api/storage/open                  open the account database (key)
//   POST   /api/storage/promote               session data → passkey database
//   GET    /api/storage/summary               sizes, rooms, mailbox
//   GET    /api/storage/kv       ?key=        read one value (or list keys)
//   PUT    /api/storage/kv                    write one value
//   DELETE /api/storage/kv       ?key=        drop one value
//   GET    /api/storage/messages ?room=&since=&afterSeq=&limit=
//                                             read the conversation (a cursor
//                                             returns the oldest rows after it)
//   POST   /api/storage/messages              append / replace messages
//   DELETE /api/storage/messages ?room=       forget a conversation
//   GET    /api/storage/rooms
//   GET    /api/storage/mailbox  ?room=       what waited while away
//   POST   /api/storage/mailbox/take          acknowledge items
//   GET|POST /api/storage/events              the user's own audit trail
//   POST   /api/storage/log                   client log / debug line
//   GET|POST /api/storage/transfers           transfer records
//   DELETE /api/storage                       forget everything of mine
//
//   GET    /api/admin/storage                 index + stats      (admin token)
//   GET    /api/admin/storage/logs            the log table      (admin token)
//
// The body limit is generous (messages arrive in batches) but its own, so a
// storage write cannot eat the public API budget.
//
// A session id travels in the X-M5cet-Session header (or the JSON body) —
// never in the URL, where it would end up in access logs and history.

import express, { type Express, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { requireAdminToken } from "../admin-auth";
import { accountStore, type AccountStore } from "../accounts/store";
import { storage as defaultStorage, type StorageService } from "./service";
import { apiContext, clientKeyFor, isStorageOp, resolveCaller, runStorageOp, type ApiResult, type Caller, type OpMeta } from "./api";
import { holderForToken } from "./keys";

export const SESSION_HEADER = "x-m5cet-session";

function bearer(req: Request): string {
  const header = req.header("authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function sessionOf(req: Request): string {
  const header = req.header(SESSION_HEADER) || "";
  if (header) return header.trim();
  const body = (req.body ?? {}) as { sessionId?: unknown };
  return typeof body.sessionId === "string" ? body.sessionId.trim() : "";
}

/** The caller's client identity (for the new-session cap) and, when signed
 *  in, who holds their key open (the hash of their token). */
function metaOf(req: Request): OpMeta {
  const token = bearer(req);
  return {
    clientKey: clientKeyFor(req.ip ?? req.socket?.remoteAddress ?? ""),
    ...(token ? { holder: holderForToken(token) } : {}),
  };
}

function send(res: Response, result: ApiResult): void {
  if (result.ok) {
    res.json({ ok: true, ...(result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : { data: result.data }) });
    return;
  }
  res.status(result.status).json({ ok: false, message: result.error, ...(result.code ? { code: result.code } : {}) });
}

export function registerStorageRoutes(
  app: Express,
  storage: StorageService = defaultStorage,
  accounts: AccountStore = accountStore,
): void {
  const ctx = apiContext(storage, accounts);
  const caller = (req: Request): Caller => resolveCaller(ctx, { token: bearer(req), sessionId: sessionOf(req) });
  const run = (req: Request, res: Response, op: string, payload: Record<string, unknown>) => {
    if (!isStorageOp(op)) return send(res, { ok: false, status: 400, error: `unknown operation ${op}` });
    try {
      send(res, runStorageOp(ctx, caller(req), op, payload, metaOf(req)));
    } catch (err) {
      storage.log({ level: "error", source: "server", event: "storage.api.error", detail: { op, error: (err as Error).message } });
      send(res, { ok: false, status: 500, error: "storage operation failed" });
    }
  };

  // Its own parser and bucket: a conversation is far bigger than a signaling
  // payload, and autosave must not spend the public API budget.
  app.use("/api/storage", express.json({ limit: "12mb" }));
  app.use("/api/storage", rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 600,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, message: "Too many storage requests." },
  }));

  app.get("/api/storage/status", (req, res) => run(req, res, "status", {}));
  app.post("/api/storage/session", (req, res) => run(req, res, "session.start", { sessionId: sessionOf(req) }));
  app.post("/api/storage/open", (req, res) => run(req, res, "open", (req.body ?? {}) as Record<string, unknown>));
  app.post("/api/storage/promote", (req, res) => run(req, res, "promote", (req.body ?? {}) as Record<string, unknown>));
  app.get("/api/storage/summary", (req, res) => run(req, res, "summary", {}));

  app.get("/api/storage/kv", (req, res) => {
    const key = typeof req.query.key === "string" ? req.query.key : "";
    run(req, res, key ? "kv.get" : "kv.keys", { key });
  });
  app.put("/api/storage/kv", (req, res) => run(req, res, "kv.put", (req.body ?? {}) as Record<string, unknown>));
  app.delete("/api/storage/kv", (req, res) => run(req, res, "kv.delete", { key: typeof req.query.key === "string" ? req.query.key : "" }));

  app.get("/api/storage/messages", (req, res) => run(req, res, "messages.read", {
    room: req.query.room,
    since: Number(req.query.since) || undefined,
    afterSeq: typeof req.query.afterSeq === "string" && req.query.afterSeq !== "" ? Number(req.query.afterSeq) : undefined,
    limit: Number(req.query.limit) || undefined,
  }));
  app.post("/api/storage/messages", (req, res) => run(req, res, "messages.put", (req.body ?? {}) as Record<string, unknown>));
  app.delete("/api/storage/messages", (req, res) => run(req, res, "messages.delete", {
    room: req.query.room,
    before: Number(req.query.before) || undefined,
  }));
  app.get("/api/storage/rooms", (req, res) => run(req, res, "rooms", {}));

  app.get("/api/storage/mailbox", (req, res) => run(req, res, "mailbox.read", { room: req.query.room }));
  app.post("/api/storage/mailbox/take", (req, res) => run(req, res, "mailbox.take", (req.body ?? {}) as Record<string, unknown>));

  app.get("/api/storage/events", (req, res) => run(req, res, "events.read", { limit: Number(req.query.limit) || undefined }));
  app.post("/api/storage/events", (req, res) => run(req, res, "events.add", (req.body ?? {}) as Record<string, unknown>));

  app.post("/api/storage/log", (req, res) => run(req, res, "log", (req.body ?? {}) as Record<string, unknown>));
  app.get("/api/storage/transfers", (req, res) => run(req, res, "transfers.read", {
    since: Number(req.query.since) || undefined,
    limit: Number(req.query.limit) || undefined,
  }));
  app.post("/api/storage/transfers", (req, res) => run(req, res, "transfer.record", (req.body ?? {}) as Record<string, unknown>));

  app.delete("/api/storage", (req, res) => run(req, res, "forget", {}));

  /* ------------------------------------------------------------- operator */

  const operatorOnly = requireAdminToken();

  // The full picture — directory, counts, the index — is for the operator.
  app.get("/api/admin/storage", operatorOnly, (_req, res) => {
    const status = storage.status();
    res.json({
      ok: true,
      ...status,
      databases: status.available ? storage.global.listDatabases(200) : [],
      users: status.available ? storage.global.listUsers(200) : [],
      queue: status.available ? storage.queue()?.stats() ?? null : null,
    });
  });

  app.get("/api/admin/storage/logs", operatorOnly, (req, res) => {
    if (!storage.isAvailable) return res.status(503).json({ ok: false, message: storage.unavailableReason ?? "storage is not available" });
    const level = typeof req.query.level === "string" ? req.query.level : undefined;
    res.json({
      ok: true,
      logs: storage.global.readLogs({
        level: level === "debug" || level === "info" || level === "warn" || level === "error" ? level : undefined,
        accountId: typeof req.query.accountId === "string" ? req.query.accountId : undefined,
        since: Number(req.query.since) || undefined,
        limit: Number(req.query.limit) || 200,
      }),
    });
  });

  app.get("/api/admin/storage/transfers", operatorOnly, (req, res) => {
    if (!storage.isAvailable) return res.status(503).json({ ok: false, message: storage.unavailableReason ?? "storage is not available" });
    res.json({ ok: true, transfers: storage.global.readTransfers({ limit: Number(req.query.limit) || 200 }) });
  });
}
