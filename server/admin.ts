// Standalone admin API service.
//
// Run with:  ADMIN_API_TOKEN=secret ENABLE_ADMIN=1 ADMIN_PORT=5050 \
//            node dist/admin.cjs   (production)
//            tsx server/admin.ts   (development)
//
// All endpoints (except /admin/health) require Bearer auth using
// ADMIN_API_TOKEN. The admin service does NOT have access to peer chat
// content — encryption keys are derived per-room in the browser.
//
// What lives where:
//   this process   the operator console (admin-ui/public, served at "/"),
//                  the layout builder, telephony / SIP settings and the
//                  AI / speech connectors (/admin/*)
//   main service   everything with live state — sockets, rooms, accounts,
//                  the offline queue, storage, traffic, audit, commands and
//                  push subscriptions (/api/admin/*, admin-api.ts)
// Requests for /api/admin/* that reach this process (development, or a
// setup without nginx) are forwarded to MAIN_URL (default
// http://127.0.0.1:$PORT). The old /admin/commands/*, /admin/clients,
// /admin/test/push, /admin/metrics and /admin/logs/recent endpoints read this
// process's own, empty copies of that state — commands queued there never
// reached a device. They now forward to the main service too.

import "./env";
import express from "express";
import { rateLimit } from "express-rate-limit";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { eventStore } from "./events";
import { isWebPushReady } from "./push";
import { registrySnapshot, getAi, getTts, getStt } from "./plugins/registry";
import { pluginLog } from "./plugins/log";
import { base64ToBytes } from "./plugins/types";
import { registerAdminTelephonyRoutes } from "./telephony/routes";
import { registerAdminLayoutRoutes } from "./layout";
import { distPublicDir } from "./layout-catalog";
import { applyTrustProxy } from "./trust-proxy";
import { buildInfo } from "./build-info";
import { isAuthorizedHeader } from "./admin-auth";
import { createHash } from "node:crypto";
import { ADMIN_COMMAND_ALLOWLIST } from "./routes-admin-shared";

const app = express();
// Same proxy trust as the main app, so req.ip is the client and not nginx.
applyTrustProxy(app);
app.disable("etag");

// ---- The main service ----------------------------------------------------
const MAIN_URL = (process.env.MAIN_URL?.trim() || `http://127.0.0.1:${process.env.PORT || 5000}`).replace(/\/$/, "");

/** Passes a request to the main service and streams the answer back (the
 *  live console feed is Server-Sent Events). The token travels as it came. */
async function forward(req: express.Request, res: express.Response, path: string): Promise<void> {
  const controller = new AbortController();
  // The response's close, not the request's: a request "closes" as soon as
  // its body has been read, which aborted every forwarded POST at once.
  res.on("close", () => { if (!res.writableFinished) controller.abort(); });
  const headers: Record<string, string> = { accept: String(req.headers.accept ?? "application/json") };
  if (req.headers.authorization) headers.authorization = String(req.headers.authorization);
  let body: string | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    headers["content-type"] = "application/json";
    body = JSON.stringify(req.body ?? {});
  }
  try {
    const upstream = await fetch(`${MAIN_URL}${path}`, { method: req.method, headers, body, signal: controller.signal });
    res.status(upstream.status);
    for (const name of ["content-type", "content-disposition", "cache-control"]) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    if (!upstream.body) { res.end(); return; }
    res.flushHeaders?.();
    for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
      if (!res.write(chunk)) await new Promise((r) => res.once("drain", r));
    }
    res.end();
  } catch (err) {
    if (controller.signal.aborted) return;
    if (!res.headersSent) res.status(502).json({ ok: false, message: `The main service is not reachable at ${MAIN_URL} (${(err as Error).message}).` });
    else res.end();
  }
}

app.use("/api/admin/menu-config", express.json({ limit: "1mb" }));
// 4.0.5: the Layout builder saves whole element trees.
app.use("/admin/layout", express.json({ limit: "4mb" }));
app.use(express.json({ limit: "256kb" }));
// The console's API: live state is in the main service.
app.use("/api/admin", (req, res) => { void forward(req, res, req.originalUrl); });

// ---- Auth middleware ---------------------------------------------------
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN?.trim() || "";

// Who is asking: this service's own ADMIN_API_TOKEN (owner), or — for the
// named administrators and passkey sessions the main service manages
// (admin-users.ts) — whatever the main service says about the token.
// Answers are cached for a minute, by token hash.
const whoamiCache = new Map<string, { principal: { name: string; role: "owner" | "operator" | "auditor" } | null; at: number }>();

async function principalFor(authorization: string | undefined): Promise<{ name: string; role: "owner" | "operator" | "auditor" } | null> {
  if (ADMIN_API_TOKEN && isAuthorizedHeader(authorization, ADMIN_API_TOKEN)) return { name: "admin", role: "owner" };
  if (!authorization?.startsWith("Bearer ")) return null;
  const key = createHash("sha256").update(authorization).digest("hex");
  const cached = whoamiCache.get(key);
  if (cached && Date.now() - cached.at < 60_000) return cached.principal;
  let principal: { name: string; role: "owner" | "operator" | "auditor" } | null = null;
  try {
    const r = await fetch(`${MAIN_URL}/api/admin/whoami`, { headers: { authorization } });
    if (r.ok) principal = ((await r.json()) as { admin?: { name: string; role: "owner" | "operator" | "auditor" } }).admin ?? null;
  } catch { principal = null; }
  whoamiCache.set(key, { principal, at: Date.now() });
  if (whoamiCache.size > 1_000) whoamiCache.delete(whoamiCache.keys().next().value!);
  return principal;
}

const RANK = { auditor: 1, operator: 2, owner: 3 } as const;

/** Reading needs an auditor, changing anything an operator. */
const requireAuth: express.RequestHandler = (req, res, next) => {
  void principalFor(req.header("authorization")).then((principal) => {
    if (!principal) {
      if (!ADMIN_API_TOKEN) return res.status(503).json({ ok: false, message: "ADMIN_API_TOKEN env var is not set." });
      res.setHeader("WWW-Authenticate", 'Bearer realm="m5cet-admin"');
      return res.status(401).json({ ok: false, message: "Unauthorized." });
    }
    const needed = req.method === "GET" || req.method === "HEAD" ? "auditor" : "operator";
    if (RANK[principal.role] < RANK[needed]) return res.status(403).json({ ok: false, message: `This needs the ${needed} role; you are ${principal.role}.` });
    next();
  });
};

app.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  // The console runs only its own scripts: no inline script, no eval, no
  // third-party origin. (Inline styles stay for the layout builder.)
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  res.setHeader("X-Frame-Options", "DENY");
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
// A wrong token is what gets counted: 30 refusals per 15 minutes per address.
app.use("/admin", rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false, message: { ok: false, message: "Too many refused admin requests." } }));
app.use("/admin", requireAuth);

// Telephony + SIP console (all under /admin, so behind the auth middleware).
registerAdminTelephonyRoutes(app);
// Layout / template builder (persisted, served to clients via /api/layout).
registerAdminLayoutRoutes(app);

// These used to read this process's own copies of live state. The state is
// in the main service; ask it.
app.get("/admin/metrics", (req, res) => { void forward(req, res, "/api/admin/system"); });
app.get("/admin/logs/recent", (req, res) => { void forward(req, res, `/api/admin/events?limit=${encodeURIComponent(String(req.query.limit ?? 100))}`); });
app.get("/admin/clients", (req, res) => { void forward(req, res, "/api/admin/push"); });
app.post("/admin/test/push", (req, res) => { void forward(req, res, "/api/admin/push/test"); });
app.post("/admin/commands/enqueue", (req, res) => { void forward(req, res, "/api/admin/commands"); });
app.get("/admin/commands/audit", (req, res) => { void forward(req, res, `/api/admin/commands?limit=${encodeURIComponent(String(req.query.limit ?? 100))}`); });
app.get("/admin/modules", (_req, res) => {
  res.json({ ok: true, moduleAllowlist: ADMIN_COMMAND_ALLOWLIST, pushReady: isWebPushReady(), eventsBackend: eventStore.backend, mainUrl: MAIN_URL });
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

// 4.0.5: the Layout builder's preview — the app's own components and CSS
// (dist/public), framed by the console (same origin, so frame-ancestors
// 'self' for this page only). The app's /assets are public files anyway.
const appDist = distPublicDir();
if (appDist) {
  app.get("/layout-preview.html", (_req, res) => {
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.sendFile(path.join(appDist, "layout-preview.html"));
  });
  app.use("/assets", express.static(path.join(appDist, "assets"), { maxAge: 0, etag: true, fallthrough: false }));
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
