// The operator console's API — in the main service, because this is where
// the live state is: the rooms, the sockets, the relay, the accounts, the
// storage. (The separate admin process has its own, empty copies of all of
// that; it keeps the tools that do not need live state.)
//
// Every route needs the admin token (admin-auth.ts). The live stream is a
// Server-Sent Events response read with fetch(), so the token travels in a
// header and never in a URL.
//
//   GET    /api/admin/overview                everything at a glance
//   GET    /api/admin/live                    SSE: traffic, audit, ticks
//   GET    /api/admin/traffic                 filtered traffic records
//   GET    /api/admin/traffic/rates           per-second series
//   GET    /api/admin/connections             live sockets
//   POST   /api/admin/connections/:id/close   disconnect one
//   GET    /api/admin/rooms                   rooms, peers, away members
//   GET    /api/admin/users                   accounts with their state
//   GET    /api/admin/users/:id               one account in detail
//   POST   /api/admin/users/:id/signout       revoke every session
//   DELETE /api/admin/users/:id?confirm=ID    delete account and data
//   GET    /api/admin/queue                   offline queue per account
//   GET    /api/admin/queue/dead              dead-letter list
//   POST   /api/admin/queue/:id/revive        put a dead item back
//   GET    /api/admin/system                  memory, heap, loop, host
//   GET    /api/admin/db                      databases: sizes, tables, index
//   GET    /api/admin/audit                   the journal, filtered
//   GET    /api/admin/audit/export            CSV or JSON download
//   PUT    /api/admin/audit/settings          communication auditing on/off
//   GET    /api/admin/commands                allowlist, pending, delivery audit
//   POST   /api/admin/commands                queue a command for a device
//   GET    /api/admin/push                    push readiness + anonymous subscribers
//   POST   /api/admin/push/test               test push (one id, or everyone)
//   GET    /api/admin/events                  metadata event feed (LOG_EVENTS=1)
//
// Everything the operator does here is itself written to the audit
// journal (category "admin").

import type { Express, Request, Response } from "express";
import { requireAdminToken } from "./admin-auth";
import { buildInfo } from "./build-info";
import { audit, type AuditCategory, type AuditLevel } from "./monitor/audit";
import { system } from "./monitor/system";
import { traffic, type TrafficClass } from "./monitor/traffic";
import type { AccountStore } from "./accounts/store";
import type { OfflineQueue } from "./accounts/mailqueue";
import type { StorageService } from "./storage/service";
import { ADMIN_COMMAND_ALLOWLIST, adminCommandAudit, buildCommand, enqueue, pendingCommands, pushSubscriptions } from "./routes-admin-shared";
import { isWebPushReady, sendWebPush } from "./push";
import { eventStore } from "./events";

export type RoomSnapshot = {
  room: string;
  roomHash: string;
  peers: Array<{ peerId: string; name: string; joinedAt: number; accountId?: string; connId?: string; away?: boolean; protocol?: number }>;
  away: Array<{ accountId: string; name: string; since: number }>;
};

export type AdminProviders = {
  rooms: () => RoomSnapshot[];
  closeConnection: (connId: string, reason: string) => boolean;
  accounts: AccountStore;
  storage: StorageService;
  queue: () => OfflineQueue | null;
  /** Anything else worth showing on the overview (push, retention…). */
  health?: () => Record<string, unknown>;
  /** Hands queued commands to the device now, if it is connected. */
  deliverCommands?: (deviceId: string) => number;
};

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

function adminActor(req: Request): string {
  return `admin@${String(req.ip ?? "").replace(/^::ffff:/, "") || "unknown"}`;
}

export function registerAdminApi(app: Express, deps: AdminProviders): void {
  const guard = requireAdminToken();
  app.use("/api/admin", (req, res, next) => {
    // Retention and storage have their own guarded routes under the same
    // prefix; everything else in this module goes through the guard here.
    if (req.path.startsWith("/retention") || req.path.startsWith("/storage")) return next();
    return guard(req, res, next);
  });

  const accountSummaries = () => {
    const queue = deps.queue();
    return deps.accounts.all().map((a) => {
      const db = deps.storage.isAvailable ? deps.storage.global.findDatabase("account", a.id) : null;
      const q = queue?.stats(a.id);
      return {
        id: a.id,
        userName: a.userName,
        createdAt: a.createdAt,
        lastLoginAt: a.lastLoginAt,
        loginCount: a.loginCount,
        credentialId: a.credential.credentialId,
        alg: a.credential.alg,
        signCount: a.credential.signCount,
        vault: a.vault,
        away: a.away,
        pushDevices: a.push.length,
        database: db ? { id: db.id, keyMode: db.keyMode, bytes: db.bytes, lastOpenedAt: db.lastOpenedAt, open: deps.storage.account(a.id) !== null } : null,
        queue: q ?? deps.accounts.mailboxStats(a.id),
        sessions: deps.accounts.sessionCount(a.id),
      };
    });
  };

  const overview = () => {
    const rooms = deps.rooms();
    const t = traffic.summary();
    const queue = deps.queue();
    const b = buildInfo();
    return {
      version: b.version,
      build: b.build,
      builtAt: b.builtAt,
      process: system.snapshot(),
      counts: {
        connections: t.connections,
        rooms: rooms.length,
        peers: rooms.reduce((n, r) => n + r.peers.length, 0),
        away: rooms.reduce((n, r) => n + r.away.length, 0),
        accounts: deps.accounts.size,
        activeSessions: deps.accounts.sessionCount(),
      },
      traffic: t,
      queue: queue ? queue.stats() : null,
      storage: deps.storage.status(),
      audit: audit.stats(),
      health: deps.health?.() ?? {},
    };
  };

  /* ------------------------------------------------------------ overview */

  app.get("/api/admin/overview", (_req, res) => res.json({ ok: true, ...overview() }));

  /* --------------------------------------------------------- live stream */

  app.get("/api/admin/live", (req: Request, res: Response) => {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // nginx: do not buffer the stream
    res.flushHeaders?.();

    const wants = new Set(String(req.query.streams ?? "traffic,audit,tick").split(","));
    const write = (event: string, data: unknown): boolean => {
      if (res.writableEnded) return false;
      // Back-pressure: a console that cannot keep up misses records rather
      // than making this process buffer them.
      if (res.writableLength > 1_000_000) return false;
      return res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const offs: Array<() => void> = [];
    if (wants.has("traffic")) {
      // Heartbeats would drown everything else; the tick carries their rate.
      offs.push(traffic.subscribe((r) => (r.cls === "heartbeat" ? true : write("traffic", r))));
    }
    if (wants.has("audit")) offs.push(audit.subscribe((e) => write("audit", e)));
    let tickTimer: ReturnType<typeof setInterval> | null = null;
    if (wants.has("tick")) {
      const tick = () => write("tick", {
        at: Date.now(),
        counts: overview().counts,
        rate: traffic.rates(2).at(-1),
        system: system.snapshot().latest,
      });
      tick();
      tickTimer = setInterval(tick, 2_000);
    }
    const keepAlive = setInterval(() => { if (!res.writableEnded) res.write(": keep-alive\n\n"); }, 15_000);

    audit.add({ category: "admin", level: "info", event: "admin.live.open", actor: adminActor(req) });
    res.on("close", () => {
      offs.forEach((off) => off());
      if (tickTimer) clearInterval(tickTimer);
      clearInterval(keepAlive);
    });
  });

  /* ------------------------------------------------------------- traffic */

  app.get("/api/admin/traffic", (req, res) => {
    res.json({
      ok: true,
      records: traffic.query({
        cls: str(req.query.cls) as TrafficClass | undefined,
        channel: str(req.query.channel) as "ws" | "http" | undefined,
        direction: str(req.query.direction) as "in" | "out" | undefined,
        conn: str(req.query.conn),
        peerId: str(req.query.peer),
        accountId: str(req.query.account),
        roomHash: str(req.query.room),
        type: str(req.query.type),
        since: num(req.query.since),
        beforeId: num(req.query.before),
        errorsOnly: req.query.errors === "1",
        limit: num(req.query.limit),
      }),
      summary: traffic.summary(),
    });
  });

  app.get("/api/admin/traffic/rates", (req, res) => {
    res.json({ ok: true, rates: traffic.rates(num(req.query.seconds) ?? 120) });
  });

  /* --------------------------------------------------------- connections */

  app.get("/api/admin/connections", (_req, res) => res.json({ ok: true, connections: traffic.liveConnections() }));

  app.post("/api/admin/connections/:id/close", (req, res) => {
    const closed = deps.closeConnection(String(req.params.id), "closed by the operator");
    audit.add({ category: "admin", level: "notice", event: "admin.connection.close", actor: adminActor(req), target: String(req.params.id), status: closed ? "ok" : "not-found" });
    res.status(closed ? 200 : 404).json({ ok: closed });
  });

  /* --------------------------------------------------------------- rooms */

  app.get("/api/admin/rooms", (_req, res) => res.json({ ok: true, rooms: deps.rooms() }));

  /* --------------------------------------------------------------- users */

  app.get("/api/admin/users", (_req, res) => res.json({ ok: true, users: accountSummaries() }));

  app.get("/api/admin/users/:id", (req, res) => {
    const id = String(req.params.id);
    const account = deps.accounts.get(id);
    if (!account) return res.status(404).json({ ok: false, message: "unknown account" });
    const queue = deps.queue();
    const passkeys = deps.storage.isAvailable ? deps.storage.global.listPasskeys(id) : [];
    res.json({
      ok: true,
      user: accountSummaries().find((u) => u.id === id),
      passkeys: passkeys.map((p) => ({ credentialId: p.credentialId, alg: p.alg, signCount: p.signCount, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt, label: p.label })),
      audit: account.audit.slice(-200).reverse(),
      queue: queue ? queue.pending(id).map((i) => ({ id: i.id, room: i.room, seq: i.seq, kind: i.kind, messageId: i.messageId, from: i.from.name, state: i.state, attempts: i.attempts, storedAt: i.storedAt, expiresAt: i.expiresAt, bytes: i.bytes })) : [],
      journal: audit.recent({ accountId: id, limit: 200 }),
      traffic: traffic.query({ accountId: id, limit: 200 }),
    });
  });

  app.post("/api/admin/users/:id/signout", (req, res) => {
    const id = String(req.params.id);
    if (!deps.accounts.get(id)) return res.status(404).json({ ok: false, message: "unknown account" });
    deps.accounts.revokeAll(id, "admin");
    deps.storage.releaseAccount(id);
    audit.add({ category: "admin", level: "notice", event: "admin.user.signout", actor: adminActor(req), target: id, accountId: id });
    res.json({ ok: true });
  });

  app.delete("/api/admin/users/:id", (req, res) => {
    const id = String(req.params.id);
    // A typo must not delete the wrong account: the id has to be repeated.
    if (req.query.confirm !== id) return res.status(400).json({ ok: false, message: "repeat the account id in ?confirm= to delete it" });
    if (!deps.accounts.get(id)) return res.status(404).json({ ok: false, message: "unknown account" });
    deps.accounts.deleteAccount(id);
    deps.queue()?.purgeAccount(id);
    deps.storage.forget({ accountId: id });
    if (deps.storage.isAvailable) deps.storage.global.deleteUser(id);
    audit.add({ category: "admin", level: "warn", event: "admin.user.delete", actor: adminActor(req), target: id, accountId: id });
    res.json({ ok: true });
  });

  /* --------------------------------------------------------------- queue */

  app.get("/api/admin/queue", (_req, res) => {
    const queue = deps.queue();
    if (!queue) return res.json({ ok: true, available: false, accounts: [], stats: null });
    const names = new Map(deps.accounts.all().map((a) => [a.id, a.userName]));
    res.json({
      ok: true,
      available: true,
      persistent: queue.persistent,
      stats: queue.stats(),
      accounts: queue.overview().map((o) => ({ ...o, userName: names.get(o.accountId) ?? "" })),
    });
  });

  app.get("/api/admin/queue/dead", (req, res) => {
    const queue = deps.queue();
    res.json({ ok: true, items: queue ? queue.dead(str(req.query.account), num(req.query.limit) ?? 200).map((i) => ({ ...i, envelope: undefined })) : [] });
  });

  app.post("/api/admin/queue/:id/revive", (req, res) => {
    const queue = deps.queue();
    const revived = queue ? queue.revive(String(req.params.id)) : false;
    audit.add({ category: "admin", level: "notice", event: "admin.queue.revive", actor: adminActor(req), target: String(req.params.id), status: revived ? "ok" : "not-found" });
    res.status(revived ? 200 : 404).json({ ok: revived });
  });

  /* -------------------------------------------------------- system & db */

  app.get("/api/admin/system", (_req, res) => res.json({ ok: true, snapshot: system.snapshot(), history: system.history() }));

  app.get("/api/admin/db", (_req, res) => {
    const status = deps.storage.status();
    if (!status.available) return res.json({ ok: true, available: false, reason: status.reason });
    res.json({
      ok: true,
      available: true,
      status,
      global: deps.storage.global.inspect(),
      databases: deps.storage.global.listDatabases(500),
    });
  });

  /* --------------------------------------------------------------- audit */

  const auditFilter = (req: Request) => ({
    category: str(req.query.category) as AuditCategory | undefined,
    minLevel: str(req.query.minLevel) as AuditLevel | undefined,
    actor: str(req.query.actor),
    accountId: str(req.query.account),
    peerId: str(req.query.peer),
    event: str(req.query.event),
    search: str(req.query.q),
    since: num(req.query.since),
    limit: num(req.query.limit),
  });

  app.get("/api/admin/audit", (req, res) => {
    const filter = auditFilter(req);
    // Older than the in-memory ring: ask the database.
    const persisted = deps.storage.isAvailable && req.query.source === "db"
      ? deps.storage.global.readAudit({ ...filter, limit: filter.limit ?? 500 })
      : null;
    res.json({ ok: true, entries: persisted ?? audit.recent(filter), stats: audit.stats(), source: persisted ? "db" : "memory" });
  });

  app.get("/api/admin/audit/export", (req, res) => {
    const entries = audit.recent({ ...auditFilter(req), limit: 2_000 });
    audit.add({ category: "admin", level: "info", event: "admin.audit.export", actor: adminActor(req), detail: { rows: entries.length } });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    if (req.query.format === "csv") {
      const cols = ["id", "at", "category", "level", "event", "actor", "target", "accountId", "peerId", "roomHash", "ip", "bytes", "status", "detail"] as const;
      const cell = (v: unknown) => {
        const s = v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
        // Leading = + - @ would be formulas in a spreadsheet.
        const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
        return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
      };
      const lines = [cols.join(","), ...entries.map((e) => cols.map((c) => cell(c === "at" ? new Date(e.at).toISOString() : e[c])).join(","))];
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="m5cet-audit-${stamp}.csv"`);
      return res.send(lines.join("\n"));
    }
    res.setHeader("Content-Disposition", `attachment; filename="m5cet-audit-${stamp}.json"`);
    res.json({ exportedAt: Date.now(), entries });
  });

  app.put("/api/admin/audit/settings", (req, res) => {
    const body = (req.body ?? {}) as { communication?: unknown };
    if (typeof body.communication === "boolean") audit.setCommunication(body.communication, adminActor(req));
    res.json({ ok: true, communication: audit.communicationEnabled });
  });

  /* ------------------------------------------------------------ commands */

  app.get("/api/admin/commands", (req, res) => {
    const limit = num(req.query.limit) ?? 200;
    res.json({ ok: true, allowlist: ADMIN_COMMAND_ALLOWLIST, pending: pendingCommands(), audit: adminCommandAudit.slice(-limit).reverse() });
  });

  app.post("/api/admin/commands", (req, res) => {
    const built = buildCommand((req.body ?? {}) as Record<string, unknown>);
    if (!built.ok) return res.status(400).json({ ok: false, message: built.message });
    enqueue(built.deviceId, built.command);
    adminCommandAudit.push({ ts: Date.now(), kind: "enqueue", commandId: built.command.id, deviceId: built.deviceId });
    if (adminCommandAudit.length > 1000) adminCommandAudit.splice(0, adminCommandAudit.length - 1000);
    const delivered = deps.deliverCommands?.(built.deviceId) ?? 0;
    audit.add({ category: "admin", level: "notice", event: "admin.command", actor: adminActor(req), target: built.deviceId, status: delivered ? "delivered" : "queued", detail: { kind: built.command.kind } });
    res.json({ ok: true, command: built.command, delivered: delivered > 0 });
  });

  /* ---------------------------------------------------------------- push */

  app.get("/api/admin/push", (_req, res) => {
    res.json({
      ok: true,
      ready: isWebPushReady(),
      subscribers: [...pushSubscriptions.entries()].map(([id, sub]) => {
        let host = "";
        try { host = new URL(sub.endpoint).host; } catch { host = "?"; }
        return { id, host, deviceId: sub.deviceId ?? null, createdAt: sub.createdAt, keys: Boolean(sub.keys?.p256dh && sub.keys?.auth) };
      }),
      accounts: deps.accounts.all().reduce((n, a) => n + a.push.length, 0),
    });
  });

  app.post("/api/admin/push/test", async (req, res) => {
    if (!isWebPushReady()) return res.status(503).json({ ok: false, message: "VAPID keys not configured." });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = typeof body.id === "string" ? body.id : null;
    const title = typeof body.title === "string" ? body.title.slice(0, 64) : "M5cet · admin";
    const text = typeof body.body === "string" ? body.body.slice(0, 200) : "Admin test push.";
    const targets = id ? (pushSubscriptions.has(id) ? [pushSubscriptions.get(id)!] : []) : [...pushSubscriptions.values()];
    if (targets.length === 0) return res.status(404).json({ ok: false, message: "No subscriptions." });
    const results: Array<{ host: string; ok: boolean; error?: string }> = [];
    for (const sub of targets) {
      const r = await sendWebPush(sub, { title, body: text });
      let host = "";
      try { host = new URL(sub.endpoint).host; } catch { host = "?"; }
      results.push({ host, ok: r.ok, ...(r.error ? { error: r.error.slice(0, 200) } : {}) });
    }
    audit.add({ category: "admin", level: "notice", event: "admin.push.test", actor: adminActor(req), status: `${results.filter((r) => r.ok).length}/${results.length}` });
    res.json({ ok: true, results });
  });

  /* -------------------------------------------------------------- events */

  app.get("/api/admin/events", (req, res) => {
    if (!eventStore.isEnabled) return res.json({ ok: true, enabled: false, events: [] });
    res.json({ ok: true, enabled: true, backend: eventStore.backend, events: eventStore.recent(num(req.query.limit) ?? 100) });
  });
}
