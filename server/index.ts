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

const app = express();
const httpServer = createServer(app);

// Before the limiters: behind nginx the real client is in X-Forwarded-For;
// without this every visitor shares nginx's 127.0.0.1 rate-limit bucket.
const trustProxy = applyTrustProxy(app);

// Rate limiting: 100 requests per 15 minutes per IP for the public API.
// This is intentionally lenient so it does not throttle legitimate signaling.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  // The vault and the storage API have their own, larger buckets (below).
  skip: (req) => req.originalUrl.startsWith("/api/account/vault") || req.originalUrl.startsWith("/api/storage") || req.originalUrl.startsWith("/api/admin"),
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
app.use("/api/account/vault", express.json({ limit: "8mb" }));
// Conversations arrive in batches; this parser has to come before the
// global one to win.
app.use("/api/storage", express.json({ limit: "12mb" }));
// The operator console: a busy operator is not a flood, a wrong token is.
// Refused requests count against a small budget (token guessing), all
// requests against a generous one.
app.use(
  "/api/admin",
  rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false, message: { ok: false, message: "Too many refused admin requests." } }),
  rateLimit({ windowMs: 60 * 1000, limit: 600, standardHeaders: true, legacyHeaders: false, message: { ok: false, message: "Too many admin requests." } }),
);

app.use(
  express.json({
    limit: "256kb",
    // Provider webhooks verify signatures over the exact bytes; nothing
    // else needs a second copy of every body.
    verify: (req, _res, buf) => {
      if (req.url?.startsWith("/wh/")) req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

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
  // reverse proxy sits in front. Default stays 0.0.0.0 (containers, PaaS).
  const host = process.env.HOST?.trim() || "0.0.0.0";
  // No `reusePort`: it throws ENOTSUP on macOS, and sharing the port between
  // processes would split a room's peers across separate in-memory states.
  httpServer.listen(
    {
      port,
      host,
    },
    () => {
      log(`serving on ${host}:${port} (trust proxy: ${JSON.stringify(trustProxy)})`);
      audit.add({ category: "system", level: "notice", event: "server.start", detail: { port, host, node: process.version } });
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
