import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { brotliCompressSync, gzipSync, constants as zlib } from "node:zlib";

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
