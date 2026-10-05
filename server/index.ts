// Main M5cet server entry point.
//
// Boots Express, attaches the WebSocket signaling broker (see routes.ts),
// and serves the static client bundle in production / wires the Vite dev
// middleware in development.
//
// Hardening applied at this layer (not in routes.ts):
//   - Cache-Control: no-store on every response so intermediaries cannot
//     cache encrypted payloads or even the HTML shell.
//   - Helmet default headers + a Content-Security-Policy that is strict in
//     production (script-src 'self'; the Vite dev server needs more).
//   - Per-IP rate limiting on the REST API, applied BEFORE the body parsers
//     so a flood of large bodies is refused without being parsed. (WebSocket
//     upgrades never pass through Express: signaling/hub.ts gates them.)
//   - X-Content-Type-Options / Referrer-Policy / Permissions-Policy.
//   - The request log carries method, route, status, time and size — never
//     bodies: responses hold session tokens and ciphertext. Every request
//     also lands in the traffic monitor (monitor/traffic.ts) for the console.
//   - SIGTERM / SIGINT close sockets, flush the account store and the
//     databases before exiting.

import "./env";
import express, { Response, NextFunction } from 'express';
import type { Request } from 'express';
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { requireAdminToken } from "./admin-auth";
import { mountAdminRequestGuards } from "./admin-limits";
import { registerRoutes, signalingHub } from "./routes";
import { clusterBus } from "./cluster/bus";
import { accountStore } from "./accounts/store";
import { storage } from "./storage/service";
import { audit } from "./monitor/audit";
import { system } from "./monitor/system";
import { classifyRoute, traffic, truncateIp } from "./monitor/traffic";
import { serveStatic } from "./static";
import { createServer } from "node:http";
import { applyTrustProxy } from "./trust-proxy";
import { ensureMainGroups } from "./access";
import { accessLog } from "./access-log";
import { apiLimitConfig, hasOwnBucket } from "./api-limit";
import { exactRouting } from "./exact-routing";

// 6.10 (G-02): paths match exactly, as the console guards compare them.
const app = exactRouting(express());
const httpServer = createServer(app);

// Before the limiters: behind nginx the real client is in X-Forwarded-For;
// without this every visitor shares nginx's 127.0.0.1 rate-limit bucket.
const trustProxy = applyTrustProxy(app);

// Rate limiting of the public API, per client address: API_RATE_LIMIT
// requests (default 100) per API_RATE_WINDOW_MIN minutes (default 15) — lenient,
// so it does not throttle legitimate signaling. Routes with a bucket of their
// own (the vault, storage, map tiles, the passkey ceremonies, …) are not
// counted here too (api-limit.ts).
const apiLimit = apiLimitConfig();
for (const p of apiLimit.problems) console.error(`[api-limit] ${p}`);
const apiLimiter = rateLimit({
  windowMs: apiLimit.windowMs,
  limit: apiLimit.limit,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => hasOwnBucket(req.method, req.originalUrl),
  message: { ok: false, message: "Too many requests, please try again later." },
});

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

// Traffic monitor + request log. First, so refused requests count too.
const LOG_HTTP = process.env.LOG_HTTP === "1" || process.env.NODE_ENV !== "production";
let requestSeq = 0;
app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  res.on("finish", () => {
    const durationMs = Date.now() - start;
    const isApi = path.startsWith("/api") || path.startsWith("/wh/");
    const bytes = Number(res.getHeader("content-length") ?? 0) || 0;
    if (isApi) {
      traffic.record({
        channel: "http", direction: "in", cls: classifyRoute(req.method, path),
        // Ids in paths (/api/admin/users/<id>) would make every route unique.
        type: `${req.method} ${path.replace(/\/[A-Za-z0-9_-]{16,}(?=\/|$)/g, "/:id")}`,
        bytes: Number(req.headers["content-length"] ?? 0) + bytes,
        conn: `h-${(requestSeq = (requestSeq + 1) % 1_000_000)}`,
        ip: truncateIp(req.ip), status: res.statusCode, durationMs,
      });
      if (res.statusCode === 429) audit.add({ category: "security", level: "notice", event: "http.rate-limited", ip: truncateIp(req.ip), status: `${req.method} ${path}` });
    }
    if (isApi && (LOG_HTTP || res.statusCode >= 500)) log(`${req.method} ${path} ${res.statusCode} in ${durationMs}ms${bytes ? ` (${bytes} B)` : ""}`);
  });
  next();
});

// Limits first, parsers after: a refused request is never parsed.
app.use("/api", apiLimiter);
// The encrypted vault of a signed-in user (profile + chat history) is far
// larger than a signaling payload, so it gets its own bucket and parser
// (autosave would eat the public API budget); so does the storage API.
app.use(
  "/api/account/vault",
  rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false, message: { ok: false, message: "Too many vault requests." } }),
);
app.use(
  "/api/storage",
  rateLimit({ windowMs: 15 * 60 * 1000, limit: 1_200, standardHeaders: true, legacyHeaders: false, message: { ok: false, message: "Too many storage requests." } }),
);
// 6.0: the Android devices check in, fetch bundles and APKs; many phones can
// share one address (a carrier's NAT), so their bucket is larger. Their
// requests are signed over the exact bytes: the body is read raw here,
// before the global JSON parser, and the routes parse it themselves.
app.use(
  "/api/android",
  rateLimit({ windowMs: 15 * 60 * 1000, limit: 1_500, standardHeaders: true, legacyHeaders: false, message: { ok: false, message: "Too many requests from this network." } }),
  express.raw({ type: () => true, limit: "1mb" }),
);
// 6.7: public profiles — lookups by username, and an owner's PUT with two
// small images (public-profile.ts limits each route further).
app.use(
  "/api/profile",
  rateLimit({ windowMs: 15 * 60 * 1000, limit: 600, standardHeaders: true, legacyHeaders: false, message: { ok: false, message: "Too many profile requests." } }),
  express.json({ limit: "1mb" }),
);
app.use("/api/account/vault", express.json({ limit: "8mb" }));
// Conversations arrive in batches; this parser has to come before the
// global one to win.
app.use("/api/storage", express.json({ limit: "12mb" }));
// The operator console's limits (per token kind; a function's token only
// counts once it verifies), then the large admin bodies (the Android design,
// the menu) — read only for an administrator (admin-limits.ts, 6.7 S4).
mountAdminRequestGuards(app);
// 6.0: an APK release is uploaded as the raw file — only an operator's
// request is read at all (up to 300 MB), and only after the limits above.
app.use("/api/admin/android/releases/upload", requireAdminToken(undefined, "operator"), express.raw({ type: () => true, limit: "300mb" }));

const jsonBody = express.json({
  limit: "256kb",
  // Provider webhooks verify signatures over the exact bytes; nothing
  // else needs a second copy of every body.
  verify: (req, _res, buf) => {
    if (req.url?.startsWith("/wh/")) req.rawBody = buf;
  },
});
const formBody = express.urlencoded({ extended: false });
// 5.2: the Functions webhooks (/hooks/…) read their own raw body — JSON, a
// form, multipart, anything — to log it, parse it and check a signature over
// it; the global parsers must leave it alone (they used to empty it).
const notHooks = (mw: express.RequestHandler): express.RequestHandler => (req, res, next) => (req.path.startsWith("/hooks/") ? next() : mw(req, res, next));
app.use(notHooks(jsonBody));
app.use(notHooks(formBody));

app.disable("etag");

// Helmet sets a strong baseline of security headers. We then customize CSP
// to allow the WebSocket/WebRTC client (self) and OSM tiles for the map
// preview. The production bundle has no inline script and no eval, so its
// script-src is 'self' alone; the Vite dev server injects inline modules
// and needs 'unsafe-inline' / 'unsafe-eval'.
const DEV = process.env.NODE_ENV !== "production";
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'", "wss:", "ws:", "https://tile.openstreetmap.org"],
        // 'wasm-unsafe-eval' lets WebAssembly compile (Argon2id, kdf.ts) —
        // it does not allow eval() or inline script.
        scriptSrc: DEV ? ["'self'", "'unsafe-inline'", "'unsafe-eval'"] : ["'self'", "'wasm-unsafe-eval'"],
        objectSrc: ["'none'"],
        // Google Fonts: only fetched after the user opts in (Appearance → Typography).
        styleSrc: ["'self'", "'unsafe-inline'", "https://api.fontshare.com", "https://fonts.googleapis.com"],
        imgSrc: ["'self'", "data:", "blob:", "https://tile.openstreetmap.org"],
        fontSrc: ["'self'", "https://api.fontshare.com", "https://fonts.gstatic.com"],
        mediaSrc: ["'self'", "blob:"],
        workerSrc: ["'self'"],
        childSrc: ["'none'"],
        // 5.3: only this site's own pages may be framed — /fn-sandbox.html, where a
        // function's browser code runs (sandboxed, opaque origin).
        frameSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: [],
      },
    },
    crossOriginEmbedderPolicy: false, // WebRTC/getUserMedia does not require COEP
  }),
);

app.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  // (self), not (): an empty allowlist disables the feature for this document
  // too — getUserMedia / geolocation then fail without ever prompting, which
  // breaks calls, speech-to-text and location sharing. (self) still blocks
  // every embedded third-party frame, and the browser prompt still applies.
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), geolocation=(self), interest-cohort=()");
  next();
});


export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

(async () => {
  await registerRoutes(httpServer, app);

  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    // Parser errors (400/413) are the client's; their message is safe to
    // return. A 500's message may name internals: log it, answer generically.
    const message = status < 500 ? err.message || "Bad request" : "Internal Server Error";
    if (status >= 500) {
      console.error("Internal Server Error:", err);
      audit.add({ category: "system", level: "error", event: "http.error", status: `${req.method} ${req.path}`, detail: { error: String(err?.message ?? err).slice(0, 300) } });
    }

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ ok: false, message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  // HOST lets a native (non-container) install bind to loopback only when a
  // reverse proxy sits in front. Default stays 0.0.0.0 in production
  // (containers, PaaS). 6.12 (F-27): the development server (Vite serves the
  // repository's sources through it) listens on 127.0.0.1 unless HOST says
  // otherwise — not to the whole network a laptop happens to be on.
  const host = process.env.HOST?.trim() || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
  // No `reusePort`: it throws ENOTSUP on macOS, and sharing the port between
  // processes would split a room's peers across separate in-memory states.
  httpServer.listen(
    {
      port,
      host,
    },
    () => {
      log(`serving on ${host}:${port} (trust proxy: ${JSON.stringify(trustProxy)}; API limit ${apiLimit.limit} / ${apiLimit.windowMin} min per address)`);
      audit.add({ category: "system", level: "notice", event: "server.start", detail: { port, host, node: process.version } });
      // 5.2: the tool modules' main groups (mod-functions, mod-ai, …) exist from the start.
      try { ensureMainGroups("server"); } catch { /* the console creates them on first use */ }
    },
  );
})();

// A deploy or restart: close the sockets (clients reconnect and resume),
// write what is pending, close the databases, then exit.
let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`${signal}: shutting down`);
  audit.add({ category: "system", level: "notice", event: "server.stop", status: signal });
  const force = setTimeout(() => process.exit(1), 8_000);
  force.unref();
  try {
    await signalingHub()?.shutdown("server restarting");
    await clusterBus().close();
    system.stop();
    accountStore.flush();
    await accessLog.flush();
    storage.close();
  } catch (err) {
    console.error("shutdown:", err);
  }
  httpServer.close(() => process.exit(0));
  // Keep-alive connections would hold close() open until they time out.
  httpServer.closeAllConnections?.();
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

// 6.7 (N7): a promise nobody awaited that fails (a timer's database call on a
// full disk, a provider callback) is logged and audited instead of ending the
// process — which would drop every socket and all in-memory state. A thrown
// exception still ends it (its state may be broken).
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error("unhandled rejection:", reason);
  try { audit.add({ category: "system", level: "error", event: "process.unhandled-rejection", detail: { error: message.slice(0, 300) } }); } catch { /* the audit itself failed */ }
});
