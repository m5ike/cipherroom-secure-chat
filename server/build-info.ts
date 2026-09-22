// Version + build id of the deployed client, as written by vite.config.ts to
// dist/public/build.json. Reported by /api/health so an operator can check
// with one curl which commit a server actually runs.

import fs from "node:fs";
import path from "node:path";

export type BuildInfo = { version: string; build: string; builtAt: string };

let cached: BuildInfo | null = null;

function packageVersion(): string {
  try { return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")).version || "0.0.0"; } catch { return "0.0.0"; }
}

export function buildInfo(): BuildInfo {
  if (cached) return cached;
  const candidates = [
    // Production bundle: dist/index.cjs next to dist/public/.
    typeof __dirname !== "undefined" ? path.resolve(__dirname, "public", "build.json") : "",
    path.resolve(process.cwd(), "dist", "public", "build.json"),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<BuildInfo>;
      if (typeof j.build === "string" && j.build) {
        cached = { version: String(j.version ?? packageVersion()), build: j.build, builtAt: String(j.builtAt ?? "") };
        return cached;
      }
    } catch { /* next candidate */ }
  }
  // Dev server (no build.json): do not cache, a build may appear later.
  return { version: packageVersion(), build: "dev", builtAt: "" };
}
