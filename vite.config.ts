import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import fs from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

// Dev-server file serving: allow the repo root — and its real path, so a
// symlinked install (e.g. /opt/m5cet -> /srv/m5cet-2.8) still serves
// node_modules/.vite/deps and client/ — while denying only real secrets.
const repoRoot = path.resolve(import.meta.dirname);
const repoRootReal = (() => { try { return fs.realpathSync(repoRoot); } catch { return repoRoot; } })();

// Build identity: the app shows "M5cet <version> · <build>" and compares
// itself against dist/public/build.json to offer a reload after a deploy.
// build = git commit (+ "-dirty" for uncommitted changes), M5_BUILD_ID if
// set (CI / Docker without .git), else a timestamp id. The dev server is "dev".
const appVersion: string = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version || "0.0.0"; } catch { return "0.0.0"; }
})();

function gitBuildId(): string {
  try {
    const opts = { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"] };
    const sha = execSync("git rev-parse --short=8 HEAD", opts).toString().trim();
    const dirty = execSync("git status --porcelain --untracked-files=no", opts).toString().trim() !== "";
    return sha ? `${sha}${dirty ? "-dirty" : ""}` : "";
  } catch {
    return "";
  }
}

// The libraries the browser runs, with the versions this build bundles
// (4.0: the client compares them with what the server deploys).
const CLIENT_LIBS = ["react", "react-dom", "lucide-react", "hash-wasm", "uqr"];
const clientLibs: Record<string, string> = Object.fromEntries(CLIENT_LIBS.map((name) => {
  try { return [name, JSON.parse(fs.readFileSync(path.join(repoRoot, "node_modules", name, "package.json"), "utf8")).version as string]; } catch { return [name, "?"]; }
}));
/** The signaling protocol this client speaks (server/signaling › PROTOCOL). */
const PROTOCOL = 2;

function buildInfo(): Plugin {
  let build = "dev";
  let builtAt = "";
  let outDir = "";
  return {
    name: "m5cet-build-info",
    config(_config, env) {
      if (env.command === "build") {
        build = process.env.M5_BUILD_ID?.trim() || gitBuildId() || `t${Date.now().toString(36)}`;
        builtAt = new Date().toISOString();
      }
      return {
        define: {
          __APP_VERSION__: JSON.stringify(appVersion),
          __APP_BUILD__: JSON.stringify(build),
          __APP_BUILT_AT__: JSON.stringify(builtAt),
          __APP_LIBS__: JSON.stringify(clientLibs),
          __APP_PROTOCOL__: String(PROTOCOL),
        },
      };
    },
    configResolved(config) {
      outDir = config.build.outDir;
    },
    generateBundle(_options, bundle) {
      if (build === "dev") return;
      this.emitFile({
        type: "asset",
        fileName: "build.json",
        source: `${JSON.stringify({ app: "m5cet", version: appVersion, build, builtAt }, null, 2)}\n`,
      });
      // What this deploy consists of: every script, style and asset with its
      // SHA-256, the bundled libraries, the protocol and the service worker.
      // A browser still running an older copy (a stale cache, an old tab)
      // finds out by comparing (client/src/lib/integrity.ts).
      const assets = Object.values(bundle)
        .map((item) => {
          const body = item.type === "chunk" ? item.code : item.source;
          return { file: item.fileName, bytes: Buffer.byteLength(body), sha256: createHash("sha256").update(body).digest("base64url") };
        })
        .filter((a) => a.file.startsWith("assets/"))
        .sort((a, b) => a.file.localeCompare(b.file));
      this.emitFile({
        type: "asset",
        fileName: "version-manifest.json",
        source: `${JSON.stringify({ app: "m5cet", version: appVersion, build, builtAt, protocol: PROTOCOL, serviceWorker: build, libraries: clientLibs, assets }, null, 2)}\n`,
      });
    },
    writeBundle() {
      if (build === "dev" || !outDir) return;
      // The service worker says which build it came with (sw.js › SW_BUILD).
      const sw = path.join(outDir, "sw.js");
      try { fs.writeFileSync(sw, fs.readFileSync(sw, "utf8").replace('"m5cet-sw:dev"', JSON.stringify(`m5cet-sw:${build}`))); } catch { /* no worker */ }
    },
  };
}

export default defineConfig({
  plugins: [react(), buildInfo()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  base: "./",
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    // Modern build target — browsers support baseline 2022+.
    target: "es2022",
    cssCodeSplit: true,
    reportCompressedSize: true,
    sourcemap: false,
    // Vite 8 default (oxc): measurably smaller output than esbuild here.
    minify: true,
    rollupOptions: {
      // The app, and (4.0.5) the console Layout builder's preview page.
      input: {
        index: path.resolve(import.meta.dirname, "client", "index.html"),
        "layout-preview": path.resolve(import.meta.dirname, "client", "layout-preview.html"),
      },
      output: {
        // cache-friendly filenames; subasset names hashed via content.
        assetFileNames: "assets/[name].[hash][extname]",
        chunkFileNames: "assets/[name].[hash].js",
        entryFileNames: "assets/[name].[hash].js",
        // React in a chunk of its own: it changes far less often than the
        // app, so a deploy leaves it cached in every browser.
        codeSplitting: {
          groups: [{ name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ }],
        },
      },
    },
  },
  server: {
    fs: {
      strict: true,
      allow: Array.from(new Set([repoRoot, repoRootReal])),
      // Only genuine secrets/state — a blanket "**/.*" would also hit
      // node_modules/.vite (the optimized-deps cache) once these rules apply.
      deny: [".env", ".env.*", "**/.git/**", "**/.m5cet/**", "*.key", "*.pem"],
    },
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  },
  preview: {
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
    },
  },
});
