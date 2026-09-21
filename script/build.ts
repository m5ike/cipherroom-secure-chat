import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile } from "node:fs/promises";

// Server deps to bundle to reduce openat(2) syscalls, which helps cold start
// times. Keep this list in sync with package.json dependencies actually used
// by the server. Do not add packages that are not declared dependencies.
const allowlist = [
  "express",
  "express-rate-limit",
  "helmet",
  "web-push",
  "ws",
];

async function buildServer() {
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  // optionalDependencies must stay external too: native addons such as
  // `bufferutil` locate their .node binary relative to __dirname, which a
  // bundle breaks. External, ws uses it when built and falls back when not.
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
    ...Object.keys(pkg.optionalDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  // One invocation for both services: shared modules (express, ws, ...) are
  // parsed once instead of once per bundle.
  await esbuild({
    entryPoints: { index: "server/index.ts", admin: "server/admin.ts" },
    platform: "node",
    target: "node22",
    bundle: true,
    format: "cjs",
    outdir: "dist",
    outExtension: { ".js": ".cjs" },
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info",
  });
}

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  // Client (dist/public) and server (dist/*.cjs) outputs do not overlap, so
  // the two toolchains can run concurrently.
  console.log("building client + server...");
  await Promise.all([viteBuild(), buildServer()]);
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
