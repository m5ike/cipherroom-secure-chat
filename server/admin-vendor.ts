// The console's bundled scripts (5.1): the code editor (CodeMirror 6 + the m5
// SDK) and the visual builder's compiler, built by esbuild from
// admin-ui/src into admin-ui/public/vendor. The console's CSP allows scripts
// from 'self' only, so nothing comes from a CDN.
//
// `npm run build` writes the bundle (the installer and the Docker image keep
// admin-ui next to dist). In development the admin service rebuilds it when a
// source is newer than the bundle, on the first request for it.

import fs from "node:fs";
import path from "node:path";

export const VENDOR_BUNDLES = [
  { entry: "admin-ui/src/m5-editor.ts", out: "admin-ui/public/vendor/m5-editor.js", sources: ["admin-ui/src/m5-editor.ts", "server/functions/flow.ts"] },
];

/** Builds the console's bundles (esbuild is a build-time dependency). */
export async function buildAdminVendor(root = process.cwd(), minify = true): Promise<void> {
  const { build } = await import("esbuild");
  for (const b of VENDOR_BUNDLES) {
    await build({
      entryPoints: [path.join(root, b.entry)],
      outfile: path.join(root, b.out),
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "es2022",
      minify,
      legalComments: "none",
      logLevel: "warning",
      banner: { js: "/* M5cet console — code editor & visual builder. CodeMirror 6 (MIT, codemirror.net). Built by server/admin-vendor.ts; do not edit. */" },
    });
  }
}

const mtime = (p: string) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };

/** Whether a bundle is missing or older than one of its sources. */
export function vendorStale(root = process.cwd()): boolean {
  return VENDOR_BUNDLES.some((b) => {
    const out = mtime(path.join(root, b.out));
    return !out || b.sources.some((s) => mtime(path.join(root, s)) > out);
  });
}

let pending: Promise<void> | null = null;
/** Development: rebuild once when stale (concurrent requests share the build). */
export function ensureAdminVendor(root = process.cwd()): Promise<void> {
  if (!vendorStale(root)) return Promise.resolve();
  if (!pending) pending = buildAdminVendor(root, false).finally(() => { pending = null; });
  return pending;
}
