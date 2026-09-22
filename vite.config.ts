import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import fs from "node:fs";

// Dev-server file serving: allow the repo root — and its real path, so a
// symlinked install (e.g. /opt/m5cet -> /srv/m5cet-2.8) still serves
// node_modules/.vite/deps and client/ — while denying only real secrets.
const repoRoot = path.resolve(import.meta.dirname);
const repoRootReal = (() => { try { return fs.realpathSync(repoRoot); } catch { return repoRoot; } })();

export default defineConfig({
  plugins: [react()],
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
      output: {
        // cache-friendly filenames; subasset names hashed via content.
        assetFileNames: "assets/[name].[hash][extname]",
        chunkFileNames: "assets/[name].[hash].js",
        entryFileNames: "assets/[name].[hash].js",
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
