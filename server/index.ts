// Main M5cet server entry point.
//
// Boots Express, attaches the WebSocket signaling broker (see routes.ts),
// and serves the static client bundle in production / wires the Vite dev
// middleware in development.
//
// Hardening applied at this layer (not in routes.ts):
//   - Cache-Control: no-store on every response so intermediaries cannot
//     cache encrypted payloads or even the HTML shell.
//   - Helmet default headers + a strict Content-Security-Policy.
//   - Per-IP rate limiting on REST and WebSocket upgrade endpoints.
//   - X-Content-Type-Options / Referrer-Policy / Permissions-Policy.
//   - express.json verify hook stashes the raw body for any future
//     signature-validation needs (today no endpoint requires it).

import "dotenv/config";
import express, { Response, NextFunction } from 'express';
import type { Request } from 'express';
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "node:http";

const app = express();
const httpServer = createServer(app);

// Rate limiting: 100 requests per 15 minutes per IP for the public API.
// This is intentionally lenient so it does not throttle legitimate signaling.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.ip || req.socket.remoteAddress || "unknown"),
  message: { ok: false, message: "Too many requests, please try again later." },
});

// Stricter rate limit for WebSocket upgrades to mitigate signaling abuse.
const wsUpgradeLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  limit: 30,
  keyGenerator: (req) => String(req.ip || req.socket.remoteAddress || "unknown"),
  skip: (_req) => false,
  standardHeaders: true,
  legacyHeaders: false,
});

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

app.disable("etag");

// Helmet sets a strong baseline of security headers. We then customize CSP
// to allow the WebSocket/WebRTC client (self), inline styles/scripts from the
// Vite build, and OSM tiles for the map preview. unsafe-inline is required by
// the Vite dev server; production builds should ideally use nonces/hashes.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'", "wss:", "ws:", "https://tile.openstreetmap.org"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://api.fontshare.com"],
        imgSrc: ["'self'", "data:", "blob:", "https://tile.openstreetmap.org"],
        fontSrc: ["'self'", "https://api.fontshare.com"],
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
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
  next();
});

app.use("/api", apiLimiter);
app.use("/ws", wsUpgradeLimiter);

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
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
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
    },
  );
})();
