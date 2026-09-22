// Standalone admin API service.
//
// Run with:  ADMIN_API_TOKEN=secret ENABLE_ADMIN=1 ADMIN_PORT=5050 \
//            node dist/admin.cjs   (production)
//            tsx server/admin.ts   (development)
//
// All endpoints (except /admin/health) require Bearer auth using
// ADMIN_API_TOKEN. The admin service does NOT have access to peer chat
// content — encryption keys are derived per-room in the browser. It does
// have read-only access to in-memory event metadata, push subscription
// counts, and write access to enqueue allowlisted client commands.

import "./env";
import express, { Request, Response, NextFunction } from "express";
import path from "node:path";
import fs from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eventStore } from "./events";
import { sendWebPush, isWebPushReady } from "./push";
import { registrySnapshot, getAi, getTts, getStt } from "./plugins/registry";
import { pluginLog } from "./plugins/log";
import { base64ToBytes } from "./plugins/types";
import { registerAdminTelephonyRoutes } from "./telephony/routes";
import { registerAdminLayoutRoutes } from "./layout";
import { applyTrustProxy } from "./trust-proxy";
import { buildInfo } from "./build-info";
import {
  ADMIN_COMMAND_ALLOWLIST,
  pushSubscriptions,
  adminCommandAudit,
  enqueue,
  type AdminCommand,
  type AdminCommandKind,
} from "./routes-admin-shared";

const app = express();
// Same proxy trust as the main app, so req.ip is the client and not nginx.
applyTrustProxy(app);
app.use(express.json({ limit: "256kb" }));
app.disable("etag");

// ---- Auth middleware ---------------------------------------------------
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN?.trim() || "";

// Constant-time comparison. Hashing first gives both sides equal length
// (timingSafeEqual requires it) without leaking the token length either.
const sha256 = (value: string) => createHash("sha256").update(value).digest();
const EXPECTED_AUTH_DIGEST = sha256(`Bearer ${ADMIN_API_TOKEN}`);

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!ADMIN_API_TOKEN) {
    return res.status(503).json({ ok: false, message: "ADMIN_API_TOKEN env var is not set." });
  }
  const header = req.header("authorization") || "";
  if (!timingSafeEqual(sha256(header), EXPECTED_AUTH_DIGEST)) {
    return res.status(401).json({ ok: false, message: "Unauthorized." });
  }
  next();
}

app.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

// ---- Public health -----------------------------------------------------
app.get("/admin/health", (_req, res) => {
  res.json({
    ok: true,
    enabled: !!ADMIN_API_TOKEN,
    pushReady: isWebPushReady(),
    eventsBackend: eventStore.backend,
    uptimeSec: Math.round(process.uptime()),
    // dist/public/build.json — npm_package_version only exists under `npm start`,
    // so systemd / Docker (node dist/admin.cjs) always reported "dev".
    version: buildInfo().version,
    build: buildInfo().build,
  });
});

// ---- Authenticated endpoints ------------------------------------------
app.use("/admin", requireAuth);

// Telephony + SIP console (all under /admin, so behind the auth middleware).
registerAdminTelephonyRoutes(app);
// Layout / template builder (persisted, served to clients via /api/layout).
registerAdminLayoutRoutes(app);

app.get("/admin/metrics", (_req, res) => {
  const mem = process.memoryUsage();
  res.json({
    ok: true,
    metrics: {
      uptimeSec: Math.round(process.uptime()),
      rssMb: Math.round(mem.rss / (1024 * 1024)),
      heapUsedMb: Math.round(mem.heapUsed / (1024 * 1024)),
      pushSubscribers: pushSubscriptions.size,
      eventsBackend: eventStore.backend,
    },
  });
});

app.get("/admin/logs/recent", (req, res) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
  res.json({ ok: true, backend: eventStore.backend, events: eventStore.recent(limit) });
});

app.get("/admin/clients", (_req, res) => {
  const subs = Array.from(pushSubscriptions.entries()).map(([id, sub]) => ({
    id,
    endpoint: sub.endpoint.slice(0, 80),
    deviceId: sub.deviceId || null,
    createdAt: sub.createdAt,
  }));
  res.json({ ok: true, subscribers: subs });
});

app.get("/admin/modules", (_req, res) => {
  res.json({
    ok: true,
    moduleAllowlist: ADMIN_COMMAND_ALLOWLIST,
    pushReady: isWebPushReady(),
    eventsBackend: eventStore.backend,
  });
});

app.post("/admin/commands/enqueue", (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>;
  const kind = String(body.kind || "");
  const deviceId = String(body.deviceId || "");
  if (!(ADMIN_COMMAND_ALLOWLIST as readonly string[]).includes(kind)) {
    return res.status(400).json({ ok: false, message: `Unknown command. Allowed: ${ADMIN_COMMAND_ALLOWLIST.join(", ")}` });
  }
  if (!/^[a-zA-Z0-9_-]{4,64}$/.test(deviceId)) {
    return res.status(400).json({ ok: false, message: "deviceId must be 4-64 [a-zA-Z0-9_-]." });
  }
  // Validate download-file-from-admin payload server-side so the admin cannot
  // force the client to fetch an arbitrary URL without oversight.
  if (kind === "download-file-from-admin") {
    const payload = body.payload && typeof body.payload === "object" ? (body.payload as Record<string, unknown>) : undefined;
    const url = typeof payload?.url === "string" ? payload.url : "";
    const name = typeof payload?.name === "string" ? payload.name : "";
    if (!url || !/^https?:\/\/.{1,512}$/.test(url)) {
      return res.status(400).json({ ok: false, message: "download-file-from-admin requires a valid http(s) URL." });
    }
    if (name.length > 200 || /[\x00-\x1f\\/:*?"<>|]/.test(name)) {
      return res.status(400).json({ ok: false, message: "download-file-from-admin name is invalid." });
    }
  }
  const cmd: AdminCommand = {
    id: `cmd-${(globalThis.crypto as Crypto).randomUUID()}`,
    kind: kind as AdminCommandKind,
    createdAt: Date.now(),
    payload: (body.payload && typeof body.payload === "object" ? (body.payload as Record<string, unknown>) : undefined),
  };
  // Use the shared queue exported from routes-admin-shared; the main app
  // and this admin service share the same module instance when run in
  // the same process. When run standalone, this enqueue still records
  // an audit entry but the consumer is responsible for polling.
  enqueue(deviceId, cmd);
  adminCommandAudit.push({ ts: Date.now(), kind: "enqueue", commandId: cmd.id, deviceId });
  if (adminCommandAudit.length > 1000) adminCommandAudit.splice(0, adminCommandAudit.length - 1000);
  eventStore.record({ kind: "admin-enqueue", meta: { command: kind } });
  res.json({ ok: true, command: cmd });
});

app.get("/admin/commands/audit", (req, res) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
  res.json({ ok: true, audit: adminCommandAudit.slice(-limit) });
});

app.post("/admin/test/push", async (req, res) => {
  if (!isWebPushReady()) return res.status(503).json({ ok: false, message: "VAPID keys not configured." });
  const body = (req.body || {}) as Record<string, unknown>;
  const id = typeof body.id === "string" ? body.id : null;
  const title = typeof body.title === "string" ? body.title.slice(0, 64) : "M5cet · admin";
  const text = typeof body.body === "string" ? body.body.slice(0, 200) : "Admin test push.";
  const targets = id
    ? (pushSubscriptions.has(id) ? [pushSubscriptions.get(id)!] : [])
    : Array.from(pushSubscriptions.values());
  if (targets.length === 0) return res.status(404).json({ ok: false, message: "No subscriptions." });
  const results = [];
  for (const sub of targets) {
    const r = await sendWebPush(sub, { title, body: text });
    results.push({ endpoint: sub.endpoint.slice(0, 80), ok: r.ok, error: r.error });
  }
  res.json({ ok: true, results });
});

// ---- AI / speech plugin console -----------------------------------------
// Snapshot of every connector and its config state (never secrets).
app.get("/admin/plugins", (_req, res) => {
  res.json({ ok: true, ...registrySnapshot() });
});

// Real-time test of one connector. Logs to the plugin log (visible on the
// live stream). TTS returns the audio so the admin can play it back.
app.post("/admin/plugins/test", async (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>;
  const kind = String(body.kind || "");
  const id = typeof body.id === "string" ? body.id : undefined;
  const text = typeof body.text === "string" ? body.text : "";
  try {
    if (kind === "ai") {
      const c = getAi(id);
      if (!c) return res.status(404).json({ ok: false, message: "Unknown AI connector." });
      const result = await pluginLog.time("ai", c.id, "admin-test", () => c.complete({ messages: [{ role: "user", content: text || "Reply with a short friendly greeting." }], maxTokens: 96 }));
      return res.json({ ok: true, kind, result });
    }
    if (kind === "tts") {
      const c = getTts(id);
      if (!c) return res.status(404).json({ ok: false, message: "Unknown TTS connector." });
      const result = await pluginLog.time("tts", c.id, "admin-test", () => c.synthesize({ text: text || "This is a M5cet server speech test." }));
      return res.json({ ok: true, kind, result });
    }
    if (kind === "stt") {
      const c = getStt(id);
      if (!c) return res.status(404).json({ ok: false, message: "Unknown STT connector." });
      if (typeof body.audioBase64 !== "string") return res.status(400).json({ ok: false, message: "audioBase64 required for an STT test." });
      const result = await pluginLog.time("stt", c.id, "admin-test", () => c.transcribe({ audio: base64ToBytes(body.audioBase64 as string), mime: typeof body.mime === "string" ? body.mime : "audio/webm" }));
      return res.json({ ok: true, kind, result });
    }
    return res.status(400).json({ ok: false, message: "kind must be ai | tts | stt." });
  } catch (err) {
    res.status(502).json({ ok: false, message: (err as Error).message });
  }
});

// Recent plugin log entries (metadata only).
app.get("/admin/plugins/logs", (req, res) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
  res.json({ ok: true, entries: pluginLog.recent(limit) });
});

// Live plugin log via Server-Sent Events.
app.get("/admin/logs/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Connection", "keep-alive");
  (res as unknown as { flushHeaders?: () => void }).flushHeaders?.();
  for (const entry of pluginLog.recent(50)) res.write(`data: ${JSON.stringify(entry)}\n\n`);
  const onEntry = (entry: unknown) => { try { res.write(`data: ${JSON.stringify(entry)}\n\n`); } catch { /* client gone */ } };
  pluginLog.emitter.on("entry", onEntry);
  const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* ignore */ } }, 25_000);
  req.on("close", () => { clearInterval(ping); pluginLog.emitter.off("entry", onEntry); });
});

// Legacy stub kept for compatibility.
app.get("/admin/plugins/debug", (_req, res) => {
  res.json({ ok: true, plugins: [], notes: "See GET /admin/plugins for the live connector snapshot." });
});

// Static admin GUI: when admin-ui/dist exists, serve it.
function adminUiDir(): string | null {
  // Resolve relative to this file at runtime.
  // Works for both tsx (ESM) and esbuild (CJS) outputs.
  let dir: string;
  try {
    // ESM
    dir = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    dir = __dirname;
  }
  const candidates = [
    path.resolve(dir, "..", "admin-ui", "public"),
    path.resolve(dir, "..", "..", "admin-ui", "public"),
    path.resolve(process.cwd(), "admin-ui", "public"),
    path.resolve(dir, "..", "admin-ui", "dist"),
    path.resolve(dir, "..", "..", "admin-ui", "dist"),
    path.resolve(process.cwd(), "admin-ui", "dist"),
    path.resolve(process.cwd(), "admin-ui"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "index.html"))) return c;
  }
  return null;
}

const uiDir = adminUiDir();
if (uiDir) {
  app.use("/", express.static(uiDir, { maxAge: 0, etag: false }));
  app.get("/", (_req, res) => res.sendFile(path.join(uiDir, "index.html")));
} else {
  app.get("/", (_req, res) => {
    res.type("text/plain").send([
      "M5cet admin API",
      "================",
      "Set ADMIN_API_TOKEN and use Authorization: Bearer <token>.",
      "Endpoints:",
      "  GET  /admin/health",
      "  GET  /admin/metrics",
      "  GET  /admin/logs/recent?limit=N",
      "  GET  /admin/clients",
      "  GET  /admin/modules",
      "  POST /admin/commands/enqueue { kind, deviceId, payload? }",
      "  GET  /admin/commands/audit",
      "  POST /admin/test/push { id?, title?, body? }",
      "  GET  /admin/plugins/debug",
    ].join("\n"));
  });
}

// ---- Boot --------------------------------------------------------------
const port = parseInt(process.env.ADMIN_PORT || "5050", 10);
// Default to localhost so the admin API is not accidentally exposed to the
// public internet. Use a reverse proxy with IP allowlist for remote access.
const host = process.env.ADMIN_BIND || "127.0.0.1";
const enabled = process.env.ENABLE_ADMIN === "1";

if (enabled) {
  app.listen(port, host, () => {
    console.log(`[admin] listening on http://${host}:${port}`);
    if (!ADMIN_API_TOKEN) {
      console.warn("[admin] ADMIN_API_TOKEN is not set — endpoints will return 503 until you set it.");
    }
  });
} else {
  console.log("[admin] disabled (set ENABLE_ADMIN=1 to enable)");
}

export { app as adminApp };
