import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile, readdir, writeFile, cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { brotliCompressSync, gzipSync, constants as zlib } from "node:zlib";
import { sandboxBuildOptions } from "../server/functions/sandbox/bundle";

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

/** The Functions sandbox process (4.15): its own bundle, run per function. */
async function buildSandbox() {
  await esbuild(sandboxBuildOptions("dist/sandbox.cjs", true));
}

/**
 * Copies the packages the runtime loads from disk into dist/node_modules
 * (4.15). The installer removes node_modules after the build (dist is meant
 * to be self-contained), and the Docker image copies only dist — so the
 * SQLite driver (storage and the AI journal), Pyodide (Python functions) and
 * the QuickJS WebAssembly (JavaScript functions) must travel inside dist.
 */
async function copyRuntimeDeps() {
  const req = createRequire(join(process.cwd(), "package.json"));
  const out = "dist/node_modules";
  await mkdir(out, { recursive: true });

  const copyPackage = async (name: string, subpaths: string[]) => {
    let base: string;
    try { base = dirname(req.resolve(`${name}/package.json`)); }
    catch { console.warn(`[build] ${name} not installed; skipping (its feature is off at runtime).`); return; }
    const dest = join(out, name);
    await mkdir(dirname(dest), { recursive: true });
    if (subpaths.length === 0) { await cp(base, dest, { recursive: true }); }
    else {
      await mkdir(dest, { recursive: true });
      await cp(join(base, "package.json"), join(dest, "package.json"));
      for (const sub of subpaths) { const from = join(base, sub); if (existsSync(from)) await cp(from, join(dest, sub), { recursive: true }); }
    }
    console.log(`[build] bundled runtime package ${name}`);
  };

  // Pyodide loads its own files (asm, stdlib) relative to the folder.
  await copyPackage("pyodide", []);
  // QuickJS: the glue is bundled into sandbox.cjs; only the .wasm is loaded from disk.
  await copyPackage("@jitl/quickjs-ng-wasmfile-release-sync", ["dist/emscripten-module.wasm"]);
  // The SQLCipher driver: the loader (lib) picks the prebuilt binary for the platform.
  await copyPackage("better-sqlite3-multiple-ciphers", ["lib", "prebuilds", "build"]);
}

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  // Client (dist/public) and server (dist/*.cjs) outputs do not overlap, so
  // the two toolchains can run concurrently.
  console.log("building client + server...");
  await Promise.all([viteBuild(), buildServer(), buildSandbox()]);
  await copyRuntimeDeps();
  await precompress("dist/public/assets");
}

/**
 * Brotli and gzip next to every text asset (server/static.ts serves them
 * when the browser accepts them): compressed once at build time, at the
 * highest level, instead of on every request.
 */
async function precompress(dir: string) {
  let saved = 0;
  for (const name of await readdir(dir)) {
    if (!/\.(js|css|svg|json|txt|html|mjs)$/.test(name)) continue;
    const path = join(dir, name);
    const raw = await readFile(path);
    if (raw.length < 1024) continue;
    const br = brotliCompressSync(raw, { params: { [zlib.BROTLI_PARAM_QUALITY]: 11, [zlib.BROTLI_PARAM_SIZE_HINT]: raw.length } });
    const gz = gzipSync(raw, { level: 9 });
    if (br.length < raw.length) await writeFile(`${path}.br`, br);
    if (gz.length < raw.length) await writeFile(`${path}.gz`, gz);
    saved += raw.length - br.length;
  }
  console.log(`precompressed assets (brotli saves ${(saved / 1024).toFixed(0)} kB per cold load)`);
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
