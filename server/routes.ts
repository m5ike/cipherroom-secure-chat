// Main HTTP + WebSocket signaling routes for M5cet.
//
// Responsibilities:
//   - WSS /ws         WebRTC signaling broker (join/signal/ping/command-poll/leave)
//   - GET  /api/health             liveness + sanity flags
//   - GET  /api/modules            module manifest (see modules.ts)
//   - /api/push/*                  status, subscribe, test (push-routes.ts):
//                                  self-test to the caller's own subscription id;
//                                  broadcast only with the admin token
//   - GET  /api/events*            opt-in metadata feed (LOG_EVENTS=1)
//   - GET/POST /api/settings/*     device-scoped preferences sync (in-memory)
//   - POST /api/audit/purge        wipe device-scoped server state
//   - /api/admin/retention*        retention policy + sweep, admin token
//                                  (retention-routes.ts; a timer also sweeps)
//   - /api/account/*               passkey accounts: sign-in, encrypted vault,
//                                  audit (accounts/routes.ts)
//
// Signed-in users (join with their account token and away: true) stay in a
// room as AWAY when their socket goes; others relay room-key ciphertext to
// the server, which stores it, answers "stored" and wakes them with a push
// (accounts/relay.ts).
//
// Admin commands are enqueued only by the standalone admin service
// (admin.ts, /admin/commands/*); this process delivers them over /ws.
//
// Security model: the server is a relay. It never sees plaintext message
// bodies or room keys. Persistence defaults to "none". Optional metadata
// logging is gated by LOG_EVENTS and only stores opaque ids + timestamps.

import type { Express, Request, Response } from "express";
import type { Server } from 'node:http';
import { eventStore } from "./events";
import { buildModuleManifest } from "./modules";
import { pushSubscriptions } from "./routes-admin-shared";
import { registerRetentionRoutes, startRetentionSchedule } from "./retention-routes";
import { registerPushRoutes } from "./push-routes";
import { consentLedger, deviceAuditLog, deviceSettings } from "./device-state";
import { registerShareRoutes, registerGoodbyeRoute } from "./share";
import { registerAiRoutes } from "./ai/routes";
import { accountStore, accountsDir } from "./accounts/store";
import { storage } from "./storage/service";
import { registerStorageRoutes } from "./storage/routes";
import { connectAccountsToStorage, forgetAccount, recordAccount } from "./storage/bridge";
import { handleStorageFrame, newStorageSocketState } from "./storage/ws";
import type { OfflineQueue } from "./accounts/mailqueue";
import { MemoryQueue } from "./accounts/memqueue";
import { SignalingHub } from "./signaling/hub";
import { PROTOCOL_VERSION } from "./signaling/frames";
import { loadRefSecret } from "./signaling/refs";
import { metricsText, registerAdminApi, type AdminProviders } from "./admin-api";
import { adminDirectory } from "./admin-users";
import { alerts } from "./monitor/alerts";
import { traffic } from "./monitor/traffic";
import { BackupManager } from "./storage/backup";
import { storageDir } from "./storage/keys";
import { requireAdminToken } from "./admin-auth";
import { audit } from "./monitor/audit";
import { system } from "./monitor/system";
import { resolveTrustProxy } from "./trust-proxy";
import { registerAccountRoutes } from "./accounts/routes";
import { sendWebPush } from "./push";
import { registerTelephonyRoutes } from "./telephony/routes";
import { registerWebhookRoutes } from "./telephony/webhooks";
import { registerLayoutRoutes } from "./layout";
import { accountGroups, registerAdminClientConfigRoutes, registerClientConfigRoutes, requireModule } from "./client-config";
import { registerAdminMenuConfigRoutes, registerMenuConfigRoutes } from "./menu-config";
import { buildInfo } from "./build-info";
import { turnAnswer } from "./turn";
import { clusterBus } from "./cluster/bus";
import { createHash, timingSafeEqual } from "node:crypto";
import { safeDeviceId } from "./util";

// The offline queue for signed-in members who are away: a table in the
// server's SQLite database when storage runs, memory otherwise (lost on a
// restart — /api/account/status says which).
const memoryQueue = new MemoryQueue();
export function offlineQueue(): OfflineQueue {
  return storage.queue() ?? memoryQueue;
}

let hub: SignalingHub | null = null;

/** The running signaling hub (null before registerRoutes). */
export function signalingHub(): SignalingHub | null {
  return hub;
}

/** Moves mailbox files of the first relay version into the queue, once. */
function migrateLegacyMailboxes(queue: OfflineQueue): number {
  let moved = 0;
  for (const account of accountStore.all()) {
    const items = accountStore.mailbox(account.id);
    if (items.length === 0) continue;
    const done: string[] = [];
    for (const item of items) {
      const r = queue.enqueue({
        accountId: account.id, room: item.room, kind: item.kind, messageId: item.messageId, from: item.from,
        ...(item.envelope ? { envelope: item.envelope } : {}), ...(item.status ? { status: item.status } : {}),
      });
      if (r.ok) { done.push(item.id); moved += 1; }
    }
    accountStore.takeMail(account.id, done);
  }
  return moved;
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // 4.0: modules the operator switched off (or keeps from a user's groups)
  // are refused here too — before the routes that serve them.
  const gated: Array<[string, string]> = [
    ["/api/ai/complete", "ai"], ["/api/ai/chat", "ai"], ["/api/speech/tts", "speech"], ["/api/speech/stt", "speech"],
    ["/api/telephony/sms", "telephony"], ["/api/telephony/call", "telephony"],
    ["/api/share/create", "invites"], ["/api/push/subscribe", "notifications"], ["/api/push/test", "notifications"],
    ["/api/account/push", "notifications"],
  ];
  for (const [path, module] of gated) app.use(path, requireModule(module));

  // Invite links (split-key, code-gated) and the Clear & Quit landing page.
  registerShareRoutes(app);
  registerGoodbyeRoute(app);
  // Optional AI + speech modules (4.14: providers, limits and the journal in server/ai).
  registerAiRoutes(app);
  // Server-side storage: one SQLite database for the server, one encrypted
  // SQLCipher database per user or session (storage/*). Boots before the
  // routes so /api/storage/status can answer honestly either way.
  const storageReady = await storage.init();
  if (!storageReady.ok) {
    console.warn(`[storage] running without server-side storage: ${storageReady.reason ?? "unknown reason"}`);
  }
  registerStorageRoutes(app, storage, accountStore);
  // The vault moves into the user's own database, and the global tables
  // learn about the accounts that already exist.
  connectAccountsToStorage(storage, accountStore);

  // Passkeys are bound to a domain. Without WEBAUTHN_RP_ID / PUBLIC_BASE_URL
  // it is taken from each request's Host header, so the same deployment
  // reached under two names would create accounts that work on one only.
  if (process.env.NODE_ENV === "production" && !process.env.WEBAUTHN_RP_ID?.trim() && !process.env.PUBLIC_BASE_URL?.trim()) {
    console.warn("[accounts] WEBAUTHN_RP_ID and PUBLIC_BASE_URL are unset: passkeys follow the Host header. Set one of them.");
    audit.add({ category: "system", level: "warn", event: "config.rp-id-unset" });
  }

  // Room-scoped account references survive restarts (refs.ts).
  loadRefSecret(accountsDir());
  // The audit journal keeps its last entries in memory; with storage, every
  // entry also lands in the global database (never throws).
  if (storageReady.ok) audit.setSink((entry) => storage.appendAudit(entry));
  // Signing out on one device locks the user's database for that device
  // only; the last holder (or "everywhere") locks it for good.
  accountStore.onRevoke((accountId, hash) => storage.releaseAccount(accountId, hash ?? undefined));

  // The offline queue: hand the first version's mailbox files over to it,
  // and let /api/account/me read its numbers.
  const queue = offlineQueue();
  const migrated = migrateLegacyMailboxes(queue);
  if (migrated > 0) audit.add({ category: "system", level: "notice", event: "queue.migrated", detail: { items: migrated } });
  accountStore.setQueueStats((accountId) => {
    const st = offlineQueue().stats(accountId);
    return { pending: st.queued + st.delivering, bytes: st.bytes };
  });
  const queueSweep = setInterval(() => {
    const swept = offlineQueue().sweep();
    if (swept.expired + swept.purged > 0) audit.add({ category: "storage", event: "queue.sweep", detail: swept });
  }, 10 * 60 * 1000);
  queueSweep.unref?.();

  // The signaling hub (signaling/hub.ts): /ws, protocol v2, the away relay.
  hub = new SignalingHub({
    accounts: accountStore,
    queue: offlineQueue,
    push: (target, payload) => sendWebPush(target, payload),
    storageFrame: (socket, state, frame, reply) => handleStorageFrame(socket, state, frame, reply),
    newStorageState: (ip) => newStorageSocketState(ip),
    trustProxy: resolveTrustProxy(process.env.TRUST_PROXY).value,
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean),
    // REDIS_URL: rooms span every instance behind the load balancer.
    cluster: clusterBus(),
  });
  if (hub.cluster) {
    audit.add({ category: "system", level: "notice", event: "cluster.joined", detail: { instance: hub.cluster.instanceId, bus: hub.cluster.bus.kind, signed: hub.cluster.bus.status().signed } });
  }
  const signaling = hub;
  system.start();

  // Passkey accounts: WebAuthn sign-in, zero-knowledge vault, audit log.
  // Signing out / deleting ends the away status in every room, and closes
  // the user's database so the file is opaque again. (Open sockets learn
  // it from the store's revoke event — see SignalingHub.onRevoke.)
  registerAccountRoutes(app, accountStore, {
    groupsFor: accountGroups,
    onSignOut: (accountId) => {
      // (The database lock follows the revoked token — see onRevoke above.)
      signaling.relay.forget(accountId);
    },
    onAuthenticated: (accountId, event, meta) => {
      const account = accountStore.get(accountId);
      if (account) recordAccount(storage, account, event, meta);
      audit.add({ category: "account", event: `account.${event}`, accountId });
    },
    onDeleted: (accountId) => {
      signaling.relay.forget(accountId);
      offlineQueue().purgeAccount(accountId);
      forgetAccount(storage, accountId);
      audit.add({ category: "account", level: "notice", event: "account.deleted", accountId });
    },
  });

  // The operator console's API (/api/admin/*, admin token): live traffic,
  // connections, rooms, users, queue, databases, audit, system.
  // Backups and integrity checks (storage/backup.ts): on a schedule when
  // BACKUP_DIR is set, and whenever the operator asks.
  const backups = storageReady.ok ? new BackupManager(storage, storageDir()) : null;
  backups?.start();

  const adminProviders: AdminProviders = {
    rooms: () => signaling.snapshot(),
    closeConnection: (connId, reason) => signaling.closeConnection(connId, reason),
    accounts: accountStore,
    storage,
    queue: offlineQueue,
    health: () => ({ signaling: signaling.stats(), queuePersistent: offlineQueue().persistent, protocol: PROTOCOL_VERSION }),
    cluster: () => signaling.stats().cluster,
    deliverCommands: (deviceId) => signaling.deliverCommands(deviceId),
    backups,
  };
  registerAdminApi(app, adminProviders);
  // The addons the operator switches on (saved connections, GUI templates).
  registerAdminMenuConfigRoutes(app);
  registerAdminClientConfigRoutes(app, () => {
    const all = accountStore.all();
    const withConnections = all.filter((a) => (a.vault.connections ?? 0) > 0);
    return { accounts: all.length, withConnections: withConnections.length, savedConnections: withConnections.reduce((n, a) => n + (a.vault.connections ?? 0), 0) };
  }, () => buildModuleManifest(eventStore.backend).features);

  // Prometheus: /metrics with METRICS_TOKEN (or any administrator's token).
  app.get("/metrics", (req, res) => {
    const metricsToken = process.env.METRICS_TOKEN?.trim();
    const header = req.header("authorization") ?? "";
    const same = (x: string, y: string) => timingSafeEqual(createHash("sha256").update(x).digest(), createHash("sha256").update(y).digest());
    const ok = (metricsToken && same(header, `Bearer ${metricsToken}`)) || adminDirectory.authenticate(header) !== null;
    if (!ok) return res.status(401).set("WWW-Authenticate", 'Bearer realm="m5cet-metrics"').send("unauthorized\n");
    res.type("text/plain; version=0.0.4").send(metricsText(adminProviders));
  });

  // Alerts: evaluated every 30 s from the monitors (monitor/alerts.ts).
  alerts.start(() => {
    const summary = traffic.summary();
    const snap = system.snapshot();
    return {
      securityWarningsPerMin: 0, // counted from the audit stream by the engine itself
      errorsPerMin: summary.lastMinute.errors,
      loopP99: snap.latest?.loopP99 ?? 0,
      heapRatio: snap.memory.heapLimit ? snap.memory.heapUsed / snap.memory.heapLimit : 0,
      deadLetters: offlineQueue().stats().dead,
    };
  });
  // Optional telephony (voice + SMS via Twilio/Telnyx/Vonage, SIP trunk config),
  // gated by ENABLE_TELEPHONY.
  registerTelephonyRoutes(app);
  // Provider webhooks (/wh/{provider}/{type}): signature-verified, always
  // mounted so delivery receipts / inbound SMS / call events can reach us.
  registerWebhookRoutes(app);
  // Admin-edited layout / templates for every client (GET /api/layout).
  registerLayoutRoutes(app);
  registerClientConfigRoutes(app);
  registerMenuConfigRoutes(app);

  app.get("/api/health", (_req, res) => {
    const b = buildInfo();
    res.json({
      ok: true,
      rooms: signaling.rooms.size,
      protocol: PROTOCOL_VERSION,
      cache: "no-store",
      persistence: "none",
      role: "webrtc-signaling-only",
      cluster: signaling.cluster ? signaling.cluster.bus.kind : "local",
      // Which client build this server serves (dist/public/build.json).
      version: b.version,
      build: b.build,
      builtAt: b.builtAt,
    });
  });

  // The version check's "Fix" (client/src/lib/integrity.ts): the browser
  // drops its HTTP cache for this site, cross-origin fonts included, so the
  // reload that follows fetches every file fresh. Storage the app clears
  // itself (it keeps the device identity).
  app.post("/api/clear-site-data", (_req, res) => {
    res.setHeader("Clear-Site-Data", '"cache"');
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true });
  });

  app.get("/api/modules", (_req, res) => {
    res.json(buildModuleManifest(eventStore.backend));
  });

  // ICE servers (server/turn.ts): short-lived TURN credentials with
  // TURN_SECRET, the old shared ones otherwise.
  app.get("/api/turn", (_req, res) => {
    const answer = turnAnswer();
    if (!answer.ok) return res.status(answer.status).json({ ok: false, message: answer.message });
    res.json(answer);
  });
  if (turnAnswer().ok && (turnAnswer() as { mode?: string }).mode === "static") {
    audit.add({ category: "security", level: "warn", event: "config.turn-static", detail: { hint: "TURN_USERNAME/TURN_CREDENTIAL are shared with every visitor; set TURN_SECRET (coturn use-auth-secret) for short-lived credentials" } });
  }

  app.get("/api/events/recent", requireAdminToken(), (req: Request, res: Response) => {
    if (!eventStore.isEnabled) {
      return res.status(404).json({ ok: false, message: "Event logging is disabled. Set LOG_EVENTS=1." });
    }
    const rawLimit = Number((req.query.limit as string) || 50);
    res.json({ ok: true, backend: eventStore.backend, events: eventStore.recent(rawLimit) });
  });

  app.post("/api/events", (req: Request, res: Response) => {
    if (!eventStore.isEnabled) {
      return res.status(202).json({ ok: true, recorded: false, reason: "Event logging is disabled." });
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const kind = typeof body.kind === "string" ? body.kind : "client-event";
    eventStore.record({
      kind,
      room: typeof body.room === "string" ? body.room : undefined,
      peerId: typeof body.peerId === "string" ? body.peerId : undefined,
      meta: (body.meta && typeof body.meta === "object" ? body.meta : undefined) as Record<string, unknown> | undefined,
    });
    res.json({ ok: true, recorded: true });
  });

  // Web Push: status, subscribe, self-test / operator broadcast.
  registerPushRoutes(app);

  // ---------- Settings sync (server-enhanced mode) ----------
  app.get("/api/settings", (req: Request, res: Response) => {
    const deviceId = safeDeviceId(req.query.deviceId);
    if (!deviceId) return res.status(400).json({ ok: false, message: "deviceId required." });
    const record = deviceSettings.get(deviceId);
    res.json({ ok: true, deviceId, settings: record?.payload ?? null, updatedAt: record?.updatedAt ?? null });
  });

  app.post("/api/settings", (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const deviceId = safeDeviceId(body.deviceId);
    if (!deviceId) return res.status(400).json({ ok: false, message: "deviceId required." });
    const payload = (body.settings && typeof body.settings === "object" ? body.settings : {}) as Record<string, unknown>;
    deviceSettings.set(deviceId, { deviceId, payload, updatedAt: Date.now() });
    eventStore.record({ kind: "settings-sync", meta: { deviceId } });
    res.json({ ok: true });
  });

  // ---------- Audit purge ----------
  app.post("/api/audit/purge", (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const deviceId = safeDeviceId(body.deviceId);
    if (!deviceId) return res.status(400).json({ ok: false, message: "deviceId required." });
    deviceSettings.delete(deviceId);
    deviceAuditLog.delete(deviceId);
    consentLedger.delete(deviceId);
    Array.from(pushSubscriptions.entries()).forEach(([id, sub]) => {
      if (sub.deviceId === deviceId) pushSubscriptions.delete(id);
    });
    eventStore.record({ kind: "audit-purge", meta: { deviceId } });
    res.json({ ok: true, message: "Server data purged for this device." });
  });

  app.get("/api/audit/log", (req: Request, res: Response) => {
    const deviceId = safeDeviceId(req.query.deviceId);
    if (!deviceId) return res.status(400).json({ ok: false, message: "deviceId required." });
    const entries = deviceAuditLog.get(deviceId) || [];
    res.json({ ok: true, deviceId, entries });
  });

  // ---------- Analytics consent ----------
  app.post("/api/analytics/consent", (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const deviceId = safeDeviceId(body.deviceId);
    if (!deviceId) return res.status(400).json({ ok: false, message: "deviceId required." });
    const opt = body.analyticsConsent === true;
    consentLedger.set(deviceId, { deviceId, analyticsConsent: opt, updatedAt: Date.now() });
    eventStore.record({ kind: "analytics-consent", meta: { deviceId, opt } });
    res.json({ ok: true, analyticsConsent: opt });
  });

  app.get("/api/analytics/consent", (req: Request, res: Response) => {
    const deviceId = safeDeviceId(req.query.deviceId);
    if (!deviceId) return res.status(400).json({ ok: false, message: "deviceId required." });
    res.json({ ok: true, record: consentLedger.get(deviceId) ?? null });
  });

  // ---------- File proxy diagnostics (server-enhanced mode) ----------
  app.get("/api/transfers/stats", requireAdminToken(), (_req, res) => {
    const { totalByPeer: _perConnection, ...stats } = signaling.proxy.stats();
    res.json({ ok: true, ...stats });
  });

  // ---------- GDPR-friendly data retention ----------
  // Operator routes (admin token) + a periodic sweep of this process's state.
  registerRetentionRoutes(app);
  startRetentionSchedule();

  signaling.attach(httpServer);

  return httpServer;
}
