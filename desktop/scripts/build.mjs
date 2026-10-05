// Builds M5cet Desktop: the web client → the app → installers.
//
//   npm run desktop:build                  (repository root) this OS's artifacts
//   npm run desktop:build -- --mac         macOS: universal dmg + zip (Intel + Apple Silicon)
//   npm run desktop:build -- --win         Windows: NSIS installers + portable zips (x64, arm64)
//   … --skip-web    use the existing dist/public (no `npm run build`)
//   … --dir         only the unpacked app (fast, for testing)
//
// Signing and notarization come from environment variables only
// (scripts/builder-config.mjs lists them). Without them the build still
// works and says loudly that the result is unsigned.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { builderConfig, publishConfig, signing } from "./builder-config.mjs";
import { compile } from "./compile.mjs";
import { ensurePcscPrebuilds } from "./pcsc-prebuilds.mjs";
import { writeInfoPlistStrings } from "./infoplist.mjs";
import { copyWeb } from "./web.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
const repo = resolve(desktop, "..");
const args = new Set(process.argv.slice(2));
const wantMac = args.has("--mac") || (!args.has("--win") && process.platform === "darwin");
const wantWin = args.has("--win") || (!args.has("--mac") && process.platform === "win32");

if (!existsSync(join(desktop, "node_modules", "electron-builder"))) {
  console.error("desktop/node_modules is missing — run `npm run desktop:install` (npm ci --prefix desktop) first.");
  process.exit(2);
}
if (!args.has("--skip-web")) {
  console.log("› building the web client (npm run build)");
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], { cwd: repo, stdio: "inherit", shell: process.platform === "win32" });
}
const web = copyWeb();
console.log(`› web client ${web.version} (${web.build}): ${web.count} files, ${(web.bytes / 1048576).toFixed(1)} MB${web.signed ? ", release manifest signed" : ""}`);
if (!existsSync(join(desktop, "build", "icon.png"))) {
  console.log("› rendering icons");
  execFileSync(process.execPath, [join(here, "icons.mjs")], { stdio: "inherit" });
}
await compile({ target: wantWin && !wantMac ? "win32" : process.platform });
console.log("› compiled the main process, preloads and app pages");
// 6.13.1: the PC/SC module's binaries for every target (lockfile-pinned, integrity checked).
const prebuilds = ensurePcscPrebuilds([...(wantMac ? ["mac"] : []), ...(wantWin ? ["win"] : [])]);
console.log(`› PC/SC binaries: ${prebuilds.join(", ")}`);

const s = signing();
const warn = (m) => console.warn(`\u001b[33m!! ${m}\u001b[0m`);
if (wantMac && !s.mac) warn("macOS: no CSC_LINK / CSC_NAME — the app gets an AD-HOC signature: it runs on this Mac, Gatekeeper elsewhere refuses it until the user allows it, and it never updates itself.");
if (wantMac && s.mac && !s.notarize) warn("macOS: signed but NOT notarized (no APPLE_ID… / APPLE_API_KEY…) — Gatekeeper will warn.");
if (wantWin && !s.win) warn("Windows: no WIN_CSC_LINK / Azure Trusted Signing — the installer is UNSIGNED: SmartScreen warns and the app never updates itself.");
if (!publishConfig()) warn("no M5CET_UPDATE_URL / M5CET_UPDATE_GITHUB — this build has no update source.");

const lproj = join(desktop, "build", "lproj");
rmSync(lproj, { recursive: true, force: true });
writeInfoPlistStrings(lproj);

const { build } = await import("electron-builder");
const config = builderConfig(process.env, { lprojDir: lproj });
if (args.has("--dir")) {
  config.mac.target = [{ target: "dir", arch: ["universal"] }];
  config.win.target = [{ target: "dir", arch: ["x64"] }];
}
// The targets of each platform come from the configuration ([] = "as configured").
const out = await build({ projectDir: desktop, config, publish: "never", ...(wantMac ? { mac: [] } : {}), ...(wantWin ? { win: [] } : {}) });

console.log("\n› artifacts");
for (const file of out) {
  try { console.log(`  ${(statSync(file).size / 1048576).toFixed(1).padStart(7)} MB  ${file}`); } catch { console.log(`  ${file}`); }
}
const rel = join(desktop, "release");
if (existsSync(rel)) for (const name of readdirSync(rel)) if (/-temp$/.test(name)) rmSync(join(rel, name), { recursive: true, force: true });
