// @vitest-environment node
// Secrets in the checkout stay out of the dev server and the Docker build
// (6.7, F-27). The dev server's fs.deny covered ".env" and ".env.*" only, so
// a hand-made ".env-bak" was served to anyone who could reach the dev server;
// .dockerignore had the same two patterns, so `COPY . .` in the build stage
// copied it into the build cache.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isFileLoadingAllowed, resolveConfig } from "vite";

describe("F-27 — .env* files", () => {
  it("the dev server refuses every .env* and backup file, and still serves the app", async () => {
    const config = await resolveConfig({ configFile: path.resolve("vite.config.ts"), logLevel: "silent" }, "serve");
    const root = path.resolve(".");
    for (const f of [".env", ".env.local", ".env-bak", ".env.production.bak", "client/.env-old", "secrets.bak", "notes~", "server.key", "cert.pem"]) {
      expect(isFileLoadingAllowed(config, path.join(root, f)), f).toBe(false);
    }
    for (const f of ["client/index.html", "client/src/main.tsx", "package.json"]) {
      expect(isFileLoadingAllowed(config, path.join(root, f)), f).toBe(true);
    }
  });

  it(".dockerignore leaves out every .env* but the example", () => {
    const lines = readFileSync(".dockerignore", "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    expect(lines).toContain(".env*");
    expect(lines.indexOf("!.env.example")).toBeGreaterThan(lines.indexOf(".env*"));
    // Docker's patterns are Go filepath.Match globs: ".env*" matches ".env-bak".
    const glob = (p: string) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`);
    expect(glob(".env*").test(".env-bak")).toBe(true);
  });
});
