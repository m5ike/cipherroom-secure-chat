// Smoke test of M5cet Desktop against a running M5cet server (a local dev
// server: `PORT=5181 npm run dev` in the repository — never port 5000 on macOS).
//
//   node desktop/scripts/smoke.mjs [--server http://localhost:5181] [--app <path to the packaged executable>]
//
// Without --app it runs the unpackaged app (electron .); with --app the built
// one (e.g. release/mac-universal/M5cet.app/Contents/MacOS/M5cet). The app's
// self-test (M5CET_SMOKE_REPORT, main.ts › selfTest) opens the server, waits
// for the page and reports fixed facts; this script checks them:
//   * the page came from the bundle (requests answered from the app, the
//     version manifest is the bundled build, an unknown /assets file is 404)
//   * the API went to the network (/api/health 200)
//   * the bridge is there and Node is not
// Exit 0 = pass. A packaged release refuses --remote-debugging-port and the
// node inspector (fuses), so Playwright cannot drive it; the self-test needs
// neither.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const server = opt("--server", "http://localhost:5181");
const appPath = opt("--app", "");

const work = mkdtempSync(join(tmpdir(), "m5cet-smoke-"));
const report = join(work, "report.json");
const exe = appPath || createRequire(import.meta.url)("electron");
const exeArgs = appPath ? [] : [desktop];

const env = {
  ...process.env,
  M5CET_USER_DATA: join(work, "user-data"),
  M5CET_SMOKE_REPORT: report,
  M5CET_SMOKE_SERVER: server,
  M5CET_ALLOW_LOOPBACK: "1",
  ELECTRON_RUN_AS_NODE: "",
};

// --arch x86_64 on Apple Silicon: the Intel half of a universal app, under Rosetta.
const arch = opt("--arch", "");
const child = arch && process.platform === "darwin"
  ? spawn("arch", [`-${arch}`, exe, ...exeArgs], { env, stdio: ["ignore", "pipe", "pipe"] })
  : spawn(exe, exeArgs, { env, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
child.stdout.on("data", (d) => { log += d; });
child.stderr.on("data", (d) => { log += d; });
const timer = setTimeout(() => { child.kill("SIGKILL"); }, 90_000);
const code = await new Promise((r) => child.on("exit", r));
clearTimeout(timer);

if (!existsSync(report)) {
  console.error(`no report (exit ${code})\n${log.slice(-3000)}`);
  process.exit(1);
}
const r = JSON.parse(readFileSync(report, "utf8"));
rmSync(work, { recursive: true, force: true });
console.log(JSON.stringify(r, null, 2));

const bundled = JSON.parse(readFileSync(join(desktop, "web-index.json"), "utf8"));
const checks = [
  ["self-test ran", r.ok === true],
  ["page loaded from the server origin", typeof r.url === "string" && r.url.startsWith(server)],
  ["the client rendered", r.page?.root > 0],
  ["requests answered from the bundle", r.stats?.bundled > 0],
  ["the version manifest is the bundled build", r.page?.manifest === bundled.build],
  ["the API went to the network", r.page?.health === 200 && r.stats?.network > 0],
  ["an unknown /assets file is not fetched from the server", r.page?.foreignAsset === 404],
  ["the bridge is exposed", r.page?.bridge === true],
  ["no Node in the page", r.page?.node === false],
  ["notifications go through the app", r.page?.notification === true],
  ["the service worker is the bundled one", r.page?.sw === bundled.build],
  ["the page runs under the server's CSP", typeof r.page?.csp === "string" && r.page.csp.includes("script-src 'self' 'wasm-unsafe-eval'") && r.page.csp.includes("frame-ancestors 'none'")],
  ["the sign-in handoff endpoint answers (400 for an empty request)", r.page?.handoff === 400],
  ...(appPath ? [["every served client file is checked against the signed app.asar header", r.integrityChecked === true]] : []),
  ...(arch ? [[`ran as ${arch}`, r.arch === (arch === "x86_64" ? "x64" : arch)]] : []),
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failed += 1;
}
process.exit(failed ? 1 : 0);
