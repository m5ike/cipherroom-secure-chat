// Compiles the desktop app into desktop/dist/: the main process, the two
// preloads and the app's own pages (esbuild, from the repository's
// node_modules), and copies the page assets and icons next to them.
//
// Build-time configuration from the environment (see src/config.ts):
//   M5CET_DEFAULT_SERVER   https URL offered on the first start
//   M5CET_UPDATE_URL / M5CET_UPDATE_GITHUB   where updates come from
//   CSC_LINK / WIN_CSC_LINK / AZURE_TENANT_ID…   signing → updates allowed

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
const repo = resolve(desktop, "..");
const out = join(desktop, "dist");
const pkg = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));

export function signingConfigured(env = process.env, platform = process.platform) {
  const mac = Boolean(env.CSC_LINK || env.CSC_NAME);
  const win = Boolean(env.WIN_CSC_LINK || env.CSC_LINK || (env.AZURE_TENANT_ID && env.AZURE_CLIENT_ID && env.AZURE_CLIENT_SECRET));
  return platform === "darwin" ? mac : win;
}

function gitBuild() {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short=8", "HEAD"], { cwd: repo, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return sha || "dev";
  } catch { return "dev"; }
}

function defaultServer() {
  const v = (process.env.M5CET_DEFAULT_SERVER ?? "").trim();
  if (!v) return "";
  let u;
  try { u = new URL(/^[a-z]+:/i.test(v) ? v : `https://${v}`); } catch { throw new Error(`M5CET_DEFAULT_SERVER is not a URL: ${v}`); }
  if (u.protocol !== "https:" || u.username || u.password) throw new Error("M5CET_DEFAULT_SERVER must be an https URL without credentials");
  return u.origin;
}

export async function compile({ target = process.platform } = {}) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "ui"), { recursive: true });
  const updates = Boolean((process.env.M5CET_UPDATE_URL ?? "").trim() || (process.env.M5CET_UPDATE_GITHUB ?? "").trim());
  const define = {
    __M5CET_DEFAULT_SERVER__: JSON.stringify(defaultServer()),
    __M5CET_SIGNED__: JSON.stringify(signingConfigured(process.env, target)),
    __M5CET_UPDATES__: JSON.stringify(updates),
    __M5CET_BUILD__: JSON.stringify(process.env.M5_BUILD_ID?.trim() || gitBuild()),
    __M5CET_APP_ID__: JSON.stringify(pkg.build?.appId ?? "ma.fir.m5cet.desktop"),
    "process.env.NODE_ENV": '"production"',
  };
  const common = { bundle: true, platform: "node", target: "node22", format: "cjs", logLevel: "warning", define, sourcemap: false, minify: false, legalComments: "none" };
  await build({
    ...common,
    entryPoints: { main: join(desktop, "src/main.ts") },
    outdir: out,
    outExtension: { ".js": ".cjs" },
    // electron is the runtime; electron-updater ships in node_modules of the app (its own dependency).
    external: ["electron", "electron-updater", "original-fs"],
  });
  await build({
    ...common,
    entryPoints: { preload: join(desktop, "src/preload.ts"), "ui-preload": join(desktop, "src/ui-preload.ts") },
    outdir: out,
    outExtension: { ".js": ".cjs" },
    // A sandboxed preload can require only "electron" (and a few built-ins): everything else is bundled.
    external: ["electron"],
  });
  await build({
    ...common,
    platform: "browser",
    format: "iife",
    target: "chrome130",
    entryPoints: { welcome: join(desktop, "ui/welcome.ts"), banner: join(desktop, "ui/banner.ts") },
    outdir: join(out, "ui"),
  });
  for (const f of ["welcome.html", "banner.html", "ui.css"]) cpSync(join(desktop, "ui", f), join(out, "ui", f));
  cpSync(join(repo, "client/public/icon-192.svg"), join(out, "ui", "icon.svg"));
  const icons = join(desktop, "build", "icons");
  if (existsSync(icons)) cpSync(icons, join(out, "icons"), { recursive: true });
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await compile();
  console.log(`compiled → ${out}`);
}
