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
//   GET    /api/admin/audit/verify            check the hash chain and signed checkpoints
//   POST   /api/admin/audit/checkpoint        sign the head of the chain now
//   GET    /api/admin/commands                allowlist, pending, delivery audit
//   POST   /api/admin/commands                queue a command for a device
//   GET    /api/admin/push                    push readiness + anonymous subscribers
//   POST   /api/admin/push/test               test push (one id, or everyone)
//   GET    /api/admin/events                  metadata event feed (LOG_EVENTS=1)
//   GET    /api/admin/backups                 backups, schedule, last integrity check
//   POST   /api/admin/backups                 back up now
//   POST   /api/admin/db/integrity            quick_check now
//   POST   /api/admin/db/optimize             ANALYZE-style optimize (+ VACUUM, owner)
//   GET    /api/admin/metrics                 Prometheus text format (also /metrics)
//   GET    /api/admin/alerts                  rules, firing alerts, history
//   PUT    /api/admin/alerts/rules/:id        threshold / enabled
//
// Everything the operator does here is itself written to the audit
// journal (category "admin").

import type { Express, Request, Response } from "express";
import { adminName, requireAdmin, requireAdminToken, type AdminRequest } from "./admin-auth";
import { adminDirectory, isRole } from "./admin-users";
import { rateLimit } from "express-rate-limit";
import { randomBytes } from "node:crypto";
import { challengeOf, rpPolicyFor } from "./accounts/routes";
import { b64urlToBuffer, SUPPORTED_ALGS, verifyAssertion, verifyRegistration, type AssertionResponseJSON, type RegistrationResponseJSON } from "./accounts/webauthn";
import { buildInfo } from "./build-info";
import { audit, type AuditCategory, type AuditLevel } from "./monitor/audit";
import { system } from "./monitor/system";
import { traffic, type TrafficClass } from "./monitor/traffic";
import { usernameOf, type AccountStore } from "./accounts/store";
import type { OfflineQueue } from "./accounts/mailqueue";
import type { StorageService } from "./storage/service";
import type { BackupManager } from "./storage/backup";
import { gauge, renderMetrics, type Metric } from "./monitor/metrics";
import { alerts, type RuleId } from "./monitor/alerts";
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
  /** Backups and integrity checks (storage/backup.ts), when storage runs. */
  backups?: BackupManager | null;
  /** The cluster bus and the other instances (signaling/cluster.ts). */
  cluster?: () => { kind: string; connected?: boolean; published?: number; received?: number; dropped?: number; instances: Array<{ id: string; lastSeen: number; members: number }> };
};

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

const adminActor = adminName;

export function registerAdminApi(app: Express, deps: AdminProviders): void {
  const guard = requireAdminToken();
  const selfGuard = requireAdmin("auditor");
  app.use("/api/admin", (req, res, next) => {
    // Retention and storage have their own guarded routes under the same
    // prefix; everything else in this module goes through the guard here.
    if (req.path.startsWith("/retention") || req.path.startsWith("/storage") || req.path.startsWith("/auth/")) return next();
    // Their own passkeys: any administrator, auditors included.
    if (req.path.startsWith("/me/")) return selfGuard(req, res, next);
    return guard(req, res, next);
  });

  /* ------------------------------------------------ administrators (3.1) */

  const owner = requireAdmin("owner");
  const challenges = new Map<string, { purpose: "admin-register" | "admin-signin"; name?: string; at: number }>();
  const issueChallenge = (purpose: "admin-register" | "admin-signin", name?: string) => {
    const now = Date.now();
    for (const [k, v] of challenges) if (now - v.at > 120_000) challenges.delete(k);
    const c = randomBytes(32).toString("base64url");
    challenges.set(c, { purpose, name, at: now });
    return c;
  };
  const takeChallenge = (clientDataJSON: unknown, purpose: "admin-register" | "admin-signin") => {
    const c = challengeOf(clientDataJSON);
    const v = c ? challenges.get(c) : undefined;
    if (c) challenges.delete(c);
    return v && v.purpose === purpose && Date.now() - v.at <= 120_000 ? { challenge: c, name: v.name } : null;
  };

  app.get("/api/admin/whoami", (req: AdminRequest, res) => res.json({ ok: true, admin: req.admin ?? null }));

  app.get("/api/admin/admins", owner, (_req, res) => res.json({ ok: true, admins: adminDirectory.list() }));

  app.post("/api/admin/admins", owner, (req, res) => {
    const body = (req.body ?? {}) as { name?: unknown; role?: unknown };
    const role = isRole(body.role) ? body.role : "auditor";
    const created = adminDirectory.create(String(body.name ?? "").toLowerCase(), role);
    audit.add({ category: "admin", level: "notice", event: "admin.admins.create", actor: adminActor(req), target: String(body.name ?? ""), status: created.ok ? role : "refused" });
    if (!created.ok) return res.status(400).json({ ok: false, message: created.reason });
    res.json({ ok: true, admins: adminDirectory.list() });
  });

  app.patch("/api/admin/admins/:name", owner, (req, res) => {
    const body = (req.body ?? {}) as { role?: unknown; disabled?: unknown };
    const ok = adminDirectory.update(String(req.params.name), { ...(isRole(body.role) ? { role: body.role } : {}), ...(typeof body.disabled === "boolean" ? { disabled: body.disabled } : {}) });
    audit.add({ category: "admin", level: "notice", event: "admin.admins.update", actor: adminActor(req), target: String(req.params.name), detail: body });
    res.status(ok ? 200 : 404).json({ ok, admins: adminDirectory.list() });
  });

  app.delete("/api/admin/admins/:name", owner, (req, res) => {
    const ok = adminDirectory.remove(String(req.params.name));
    audit.add({ category: "admin", level: "warn", event: "admin.admins.delete", actor: adminActor(req), target: String(req.params.name) });
    res.status(ok ? 200 : 404).json({ ok, admins: adminDirectory.list() });
  });

  app.post("/api/admin/admins/:name/tokens", owner, (req, res) => {
    const token = adminDirectory.issueToken(String(req.params.name), String(((req.body ?? {}) as { label?: unknown }).label ?? ""));
    audit.add({ category: "admin", level: "notice", event: "admin.admins.token", actor: adminActor(req), target: String(req.params.name), status: token ? "issued" : "not-found" });
    if (!token) return res.status(404).json({ ok: false, message: "unknown administrator" });
    res.json({ ok: true, token, admins: adminDirectory.list() });
  });

  app.delete("/api/admin/admins/:name/tokens/:id", owner, (req, res) => {
    const ok = adminDirectory.revokeToken(String(req.params.name), String(req.params.id));
    audit.add({ category: "admin", level: "notice", event: "admin.admins.token-revoked", actor: adminActor(req), target: String(req.params.name) });
    res.status(ok ? 200 : 404).json({ ok, admins: adminDirectory.list() });
  });

  // An administrator registers a passkey for themself (named administrators
  // only — the environment tokens have no record to hold one).
  app.post("/api/admin/me/passkeys/options", (req: AdminRequest, res) => {
    const me = req.admin && adminDirectory.get(req.admin.name);
    if (!me) return res.status(400).json({ ok: false, message: "Create a named administrator first (Administrators → Add), then sign in with its token." });
    const policy = rpPolicyFor(req);
    res.json({
      ok: true,
      publicKey: {
        challenge: issueChallenge("admin-register", me.name),
        rp: { id: policy.rpId, name: "M5cet console" },
        user: { id: Buffer.from(`admin:${me.name}`).toString("base64url"), name: `${me.name} (M5cet admin)`, displayName: me.name },
        pubKeyCredParams: SUPPORTED_ALGS.map((alg) => ({ type: "public-key", alg })),
        authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
        excludeCredentials: me.passkeys.map((p) => ({ type: "public-key", id: p.credentialId })),
        attestation: "none",
        timeout: 60_000,
      },
    });
  });

  app.post("/api/admin/me/passkeys/verify", (req: AdminRequest, res) => {
    const body = (req.body ?? {}) as { credential?: RegistrationResponseJSON; label?: unknown };
    const taken = takeChallenge(body.credential?.response?.clientDataJSON, "admin-register");
    if (!body.credential || !taken || taken.name !== req.admin?.name) return res.status(400).json({ ok: false, message: "Unknown or expired challenge." });
    const r = verifyRegistration({ response: body.credential, expectedChallenge: taken.challenge, policy: rpPolicyFor(req) });
    if (!r.ok) return res.status(400).json({ ok: false, message: `Passkey registration rejected: ${r.error}` });
    const ok = adminDirectory.addPasskey(req.admin!.name, r.credential, String(body.label ?? ""));
    audit.add({ category: "admin", level: "notice", event: "admin.passkey.added", actor: adminActor(req), status: ok ? "ok" : "refused" });
    res.status(ok ? 200 : 409).json({ ok });
  });

  // Signing in to the console with a passkey (no token needed).
  const loginLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { ok: false, message: "Too many sign-in attempts." } });

  app.post("/api/admin/auth/passkey/options", loginLimiter, (req, res) => {
    res.json({ ok: true, publicKey: { challenge: issueChallenge("admin-signin"), rpId: rpPolicyFor(req).rpId, userVerification: "required", timeout: 60_000 } });
  });

  app.post("/api/admin/auth/passkey/verify", loginLimiter, (req, res) => {
    const body = (req.body ?? {}) as { credential?: AssertionResponseJSON };
    const taken = takeChallenge(body.credential?.response?.clientDataJSON, "admin-signin");
    if (!body.credential || !taken) return res.status(400).json({ ok: false, message: "Unknown or expired challenge." });
    let credentialId = "";
    try { credentialId = b64urlToBuffer(body.credential.rawId || body.credential.id).toString("base64url"); } catch { credentialId = ""; }
    const found = credentialId ? adminDirectory.byCredential(credentialId) : null;
    if (!found || found.user.disabled) {
      audit.add({ category: "security", level: "warn", event: "admin.passkey.unknown", ip: String(req.ip ?? "") });
      return res.status(401).json({ ok: false, message: "This passkey belongs to no administrator." });
    }
    const r = verifyAssertion({ response: body.credential, expectedChallenge: taken.challenge, policy: rpPolicyFor(req), stored: found.passkey });
    if (!r.ok) {
      audit.add({ category: "security", level: "warn", event: "admin.passkey.failed", actor: found.user.name, status: r.error.slice(0, 60) });
      return res.status(401).json({ ok: false, message: "Passkey verification failed." });
    }
    const session = adminDirectory.passkeySignIn(credentialId, r.signCount);
    if (!session) return res.status(401).json({ ok: false, message: "Sign-in refused." });
    audit.add({ category: "admin", level: "notice", event: "admin.signin.passkey", actor: `${session.principal.name}@${String(req.ip ?? "")}` });
    res.json({ ok: true, token: session.token, admin: session.principal });
  });

  app.post("/api/admin/auth/signout", (req, res) => {
    adminDirectory.endSession(req.header("authorization"));
    res.json({ ok: true });
  });

  const accountSummaries = () => {
    const queue = deps.queue();
    return deps.accounts.all().map((a) => {
      const db = deps.storage.isAvailable ? deps.storage.global.findDatabase("account", a.id) : null;
      const q = queue?.stats(a.id);
      return {
        id: a.id,
        username: usernameOf(a),
        userName: usernameOf(a),
        keyVerified: Boolean(a.keyVerifier),
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
    const names = new Map(deps.accounts.all().map((a) => [a.id, usernameOf(a)]));
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

  // Tamper evidence (3.1): recompute the hash chain of the persisted
  // journal and check the signed checkpoints.
  app.get("/api/admin/audit/verify", (req, res) => {
    if (!deps.storage.isAvailable) return res.json({ ok: true, available: false });
    const result = deps.storage.global.verifyAudit();
    audit.add({ category: "admin", level: result.ok ? "info" : "error", event: "admin.audit.verify", actor: adminActor(req), status: result.ok ? "intact" : `${result.problems.length} problems` });
    const { ok: intact, ...rest } = result;
    res.json({ ok: true, available: true, intact, ...rest });
  });

  app.post("/api/admin/audit/checkpoint", (req, res) => {
    if (!deps.storage.isAvailable) return res.status(503).json({ ok: false, message: "storage is not running" });
    const checkpoint = deps.storage.global.auditCheckpoint(`manual:${adminActor(req)}`);
    res.json({ ok: true, checkpoint });
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

  /* ------------------------------------------------ backups & integrity */

  app.get("/api/admin/backups", (_req, res) => {
    const b = deps.backups;
    if (!b) return res.json({ ok: true, available: false });
    res.json({ ok: true, available: true, dir: b.dir, scheduled: b.scheduled, intervalHours: b.intervalHours, keep: b.keep, last: b.last, integrity: b.lastIntegrity, backups: b.list() });
  });

  app.post("/api/admin/backups", async (req, res) => {
    if (!deps.backups) return res.status(503).json({ ok: false, message: "storage is not running" });
    audit.add({ category: "admin", level: "notice", event: "admin.backup", actor: adminActor(req) });
    const result = await deps.backups.run(`manual:${adminActor(req)}`);
    res.status(result.ok ? 200 : 500).json(result.ok ? { ...result } : { ok: false, message: result.error });
  });

  app.post("/api/admin/db/integrity", (req, res) => {
    if (!deps.backups) return res.status(503).json({ ok: false, message: "storage is not running" });
    audit.add({ category: "admin", level: "info", event: "admin.integrity", actor: adminActor(req) });
    res.json({ ok: true, integrity: deps.backups.integrity() });
  });

  app.post("/api/admin/db/optimize", (req: AdminRequest, res) => {
    if (!deps.storage.isAvailable) return res.status(503).json({ ok: false, message: "storage is not running" });
    const vacuum = ((req.body ?? {}) as { vacuum?: unknown }).vacuum === true;
    if (vacuum && req.admin?.role !== "owner") return res.status(403).json({ ok: false, message: "VACUUM needs the owner role (it rewrites the whole file)." });
    const result = deps.storage.global.optimize(vacuum);
    audit.add({ category: "admin", level: "notice", event: "admin.db.optimize", actor: adminActor(req), detail: { vacuum, ...result } });
    res.json({ ok: true, ...result });
  });

  /* ------------------------------------------------- metrics & alerts */

  app.get("/api/admin/metrics", (_req, res) => {
    res.type("text/plain; version=0.0.4").send(metricsText(deps));
  });

  app.get("/api/admin/alerts", (_req, res) => {
    res.json({ ok: true, rules: alerts.listRules(), active: alerts.active(), states: alerts.all(), history: alerts.history.slice(0, 100), webhook: Boolean(process.env.ALERT_WEBHOOK_URL?.trim()) });
  });

  app.put("/api/admin/alerts/rules/:id", (req, res) => {
    const body = (req.body ?? {}) as { threshold?: unknown; enabled?: unknown };
    const rule = alerts.setRule(String(req.params.id) as RuleId, {
      ...(typeof body.threshold === "number" ? { threshold: body.threshold } : {}),
      ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
    });
    audit.add({ category: "admin", level: "notice", event: "admin.alerts.rule", actor: adminActor(req), target: String(req.params.id), detail: body });
    res.status(rule ? 200 : 404).json({ ok: Boolean(rule), rule });
  });
}

function clusterMetrics(deps: AdminProviders): Metric[] {
  const c = deps.cluster?.();
  if (!c || c.kind === "local") return [];
  return [
    gauge("m5cet_cluster_connected", "1 while the cluster bus is connected.", c.connected ? 1 : 0, { bus: c.kind }),
    gauge("m5cet_cluster_instances", "Other instances heard from in the last 20 s.", c.instances.length),
    { name: "m5cet_cluster_messages_total", help: "Cluster bus messages.", type: "counter", samples: [
      { labels: { direction: "published" }, value: c.published ?? 0 },
      { labels: { direction: "received" }, value: c.received ?? 0 },
      { labels: { direction: "dropped" }, value: c.dropped ?? 0 },
    ] },
  ];
}

/** Everything the monitors count, as Prometheus metrics. */
export function metricsText(deps: AdminProviders): string {
  const t = traffic.summary();
  const snap = system.snapshot();
  const latest = snap.latest;
  const rooms = deps.rooms();
  const queue = deps.queue();
  const q = queue?.stats();
  const b = buildInfo();
  const auditStats = audit.stats();
  const perClass = (field: "frames" | "bytesIn" | "bytesOut" | "errors") => Object.entries(t.classes).map(([cls, c]) => ({ labels: { class: cls }, value: c[field] }));
  const metrics: Metric[] = [
    gauge("m5cet_build_info", "Version and build of the running server.", 1, { version: b.version, build: b.build }),
    gauge("m5cet_uptime_seconds", "Seconds since the process started.", snap.uptimeSec),
    gauge("m5cet_ws_connections", "Open WebSocket connections.", t.connections),
    gauge("m5cet_rooms", "Open rooms.", rooms.length),
    gauge("m5cet_room_members", "Members connected to a room.", rooms.reduce((n, r) => n + r.peers.length, 0)),
    gauge("m5cet_away_members", "Signed-in members the relay answers for.", rooms.reduce((n, r) => n + r.away.length, 0)),
    gauge("m5cet_accounts", "Passkey accounts.", deps.accounts.size),
    gauge("m5cet_account_sessions", "Valid account sessions.", deps.accounts.sessionCount()),
    { name: "m5cet_frames_total", help: "WebSocket frames and HTTP requests seen, by class.", type: "counter", samples: perClass("frames") },
    { name: "m5cet_bytes_in_total", help: "Bytes received, by class.", type: "counter", samples: perClass("bytesIn") },
    { name: "m5cet_bytes_out_total", help: "Bytes sent, by class.", type: "counter", samples: perClass("bytesOut") },
    { name: "m5cet_errors_total", help: "Failed frames and requests, by class.", type: "counter", samples: perClass("errors") },
    { name: "m5cet_http_requests_total", help: "HTTP API requests.", type: "counter", samples: [{ value: t.totals.http }] },
    { name: "m5cet_connections_opened_total", help: "WebSocket connections opened.", type: "counter", samples: [{ value: t.totals.connectionsOpened }] },
    { name: "m5cet_queue_items", help: "Offline queue items by state.", type: "gauge", samples: q ? [{ labels: { state: "queued" }, value: q.queued }, { labels: { state: "delivering" }, value: q.delivering }, { labels: { state: "dead" }, value: q.dead }] : [] },
    gauge("m5cet_queue_bytes", "Bytes waiting in the offline queue.", q?.bytes ?? 0),
    { name: "m5cet_audit_events_total", help: "Audit journal entries, by category.", type: "counter", samples: Object.entries(auditStats.byCategory).filter(([k]) => !k.includes(".")).map(([category, value]) => ({ labels: { category }, value })) },
    gauge("m5cet_process_resident_memory_bytes", "Resident set size.", snap.memory.rss),
    gauge("m5cet_heap_used_bytes", "V8 heap in use.", snap.memory.heapUsed),
    gauge("m5cet_heap_limit_bytes", "V8 heap limit.", snap.memory.heapLimit),
    gauge("m5cet_event_loop_delay_p99_ms", "Event-loop delay, 99th percentile over the last sample.", latest?.loopP99 ?? 0),
    gauge("m5cet_cpu_percent", "Process CPU, % of one core, over the last sample.", latest?.cpu ?? 0),
    gauge("m5cet_storage_available", "1 when server-side storage runs.", deps.storage.isAvailable ? 1 : 0),
    gauge("m5cet_alerts_firing", "Alert rules currently firing.", alerts.active().length),
    ...clusterMetrics(deps),
  ];
  return renderMetrics(metrics);
}
