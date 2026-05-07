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

import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { eventStore } from "./events";
import { sendWebPush, isWebPushReady } from "./push";
import {
  ADMIN_COMMAND_ALLOWLIST,
  pushSubscriptions,
  adminCommandAudit,
  enqueue,
  type AdminCommand,
  type AdminCommandKind,
} from "./routes-admin-shared";

const app = express();
app.use(express.json({ limit: "256kb" }));
app.disable("etag");

// ---- Auth middleware ---------------------------------------------------
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN?.trim() || "";

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!ADMIN_API_TOKEN) {
    return res.status(503).json({ ok: false, message: "ADMIN_API_TOKEN env var is not set." });
  }
  const header = req.header("authorization") || "";
  const expected = `Bearer ${ADMIN_API_TOKEN}`;
  if (header !== expected) return res.status(401).json({ ok: false, message: "Unauthorized." });
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
    version: process.env.npm_package_version || "dev",
  });
});

// ---- Authenticated endpoints ------------------------------------------
app.use("/admin", requireAuth);

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

// Plugin debug endpoint stub. Real plugins should register themselves on
// boot and expose their own /admin/plugins/<id>/... routes.
app.get("/admin/plugins/debug", (_req, res) => {
  res.json({ ok: true, plugins: [], notes: "Register plugins via server-side module registry. See docs/admin.md." });
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
const host = process.env.ADMIN_BIND || "0.0.0.0";
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
