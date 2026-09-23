// Production static handler. Serves the Vite-built client from dist/public:
// content-hashed assets cached for a year (precompressed when possible),
// everything else with strict no-cache headers, falling back to index.html so that the
// PWA can hydrate any deep link without server-side routing.

import express from 'express';
import type { Express } from 'express';
import fs from "node:fs";
import path from "node:path";

const NO_STORE = "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0";
/** Content-hashed build output: a new build has new names, so a year is safe. */
const IMMUTABLE = "public, max-age=31536000, immutable";
const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8", ".html": "text/html; charset=utf-8", ".txt": "text/plain; charset=utf-8",
};

/** Hashed assets: Vite writes name.<hash>.ext; workers name-<hash>.js. */
export function isHashedAsset(path: string): boolean {
  return /^\/assets\/[^/]+[.-][A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(path);
}

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  // Precompressed assets (script/build.ts): brotli, else gzip, when accepted.
  app.use("/assets", (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const ext = path.extname(req.path);
    const type = TYPES[ext];
    if (!type || req.path.includes("..")) return next();
    const accepts = String(req.headers["accept-encoding"] ?? "");
    const file = path.join(distPath, "assets", req.path);
    for (const [enc, suffix] of [["br", ".br"], ["gzip", ".gz"]] as const) {
      if (!new RegExp(`\\b${enc}\\b`).test(accepts) || !fs.existsSync(file + suffix)) continue;
      res.setHeader("Content-Type", type);
      res.setHeader("Content-Encoding", enc);
      res.setHeader("Vary", "Accept-Encoding");
      res.setHeader("Cache-Control", isHashedAsset(`/assets${req.path}`) ? IMMUTABLE : NO_STORE);
      return res.sendFile(file + suffix);
    }
    next();
  });

  app.use(
    express.static(distPath, {
      etag: false,
      lastModified: false,
      maxAge: 0,
      setHeaders: (res, filePath) => {
        const rel = "/" + path.relative(distPath, filePath).split(path.sep).join("/");
        if (isHashedAsset(rel)) {
          res.setHeader("Cache-Control", IMMUTABLE);
          return;
        }
        // index.html, the service worker, build.json, the manifest: always fresh.
        res.setHeader("Cache-Control", NO_STORE);
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
        res.setHeader("Surrogate-Control", "no-store");
      },
    }),
  );

  // fall through to index.html if the file doesn't exist
  app.use("/{*path}", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
