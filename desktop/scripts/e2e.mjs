// Interactive end-to-end test of the UNPACKAGED app with Playwright's
// Electron driver (a release build refuses the debugger, see smoke.mjs):
// the server picker, then the page — bundle vs network, the navigation
// guard, new windows, the function sandbox frame.
//
//   PORT=5181 npm run dev            (another terminal; never port 5000 on macOS)
//   node desktop/scripts/e2e.mjs [--server http://localhost:5181]

import { _electron as electron } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
const args = process.argv.slice(2);
const server = args.includes("--server") ? args[args.indexOf("--server") + 1] : "http://localhost:5181";
const work = mkdtempSync(join(tmpdir(), "m5cet-e2e-"));
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`); };

const app = await electron.launch({
  executablePath: createRequire(import.meta.url)("electron"),
  args: [desktop],
  env: { ...process.env, M5CET_USER_DATA: join(work, "user-data"), M5CET_ALLOW_LOOPBACK: "1", ELECTRON_RUN_AS_NODE: "" },
});
try {
  const welcome = await app.firstWindow();
  await welcome.waitForSelector("#server");
  check("the server picker opens first", welcome.url() === "m5cet-app://ui/welcome.html", welcome.url());
  check("the picker is localized", ((await welcome.textContent("#connect")) ?? "").length > 0);
  await welcome.fill("#server", "http://example.org");
  await welcome.click("#connect");
  await welcome.waitForSelector("#error:not([hidden])");
  check("plain http to a remote server is refused", /https/.test((await welcome.textContent("#error")) ?? ""));

  const pagePromise = app.waitForEvent("window", { predicate: (p) => p.url().startsWith(server), timeout: 30_000 });
  await welcome.fill("#server", server);
  await welcome.click("#connect");
  let page = app.windows().find((p) => p.url().startsWith(server));
  page ??= await pagePromise;
  await page.waitForLoadState("load");
  await page.waitForFunction(() => document.getElementById("root")?.childElementCount > 0, null, { timeout: 30_000 });

  const facts = await page.evaluate(async () => ({
    bridge: window.m5desktop?.isDesktop === true,
    scripts: [...document.querySelectorAll("script[src]")].map((s) => new URL(s.src).pathname),
    fileOpen: window.open("file:///etc/passwd") === null,
    blankOpen: window.open("about:blank") === null,
    spa: await fetch("/r/some/deep/path", { headers: { accept: "text/html" } }).then((r) => r.text()).then((t) => /\/assets\/index[.-]/.test(t)),
    api: await fetch("/api/health").then((r) => r.json()).then((j) => j.ok === true, () => false),
    swNotFromServer: await fetch("/sw.js").then((r) => r.text()).then((t) => !t.includes('"m5cet-sw:dev"')),
  }));
  check("the bridge is in the page", facts.bridge);
  check("the page runs the bundled build (no Vite dev entry)", facts.scripts.length > 0 && facts.scripts.every((p) => p.startsWith("/assets/")), facts.scripts.join(","));
  check("window.open of file: is refused", facts.fileOpen);
  check("window.open of about:blank is refused", facts.blankOpen);
  check("deep paths get the bundled single-page app", facts.spa);
  check("the API goes to the server", facts.api);
  check("sw.js is the bundled one, not the server's", facts.swNotFromServer);

  // A navigation to a refused scheme stays where it is.
  const before = page.url();
  await page.evaluate(() => { location.href = "file:///etc/passwd"; }).catch(() => undefined);
  await page.waitForTimeout(800);
  check("navigation to file: is blocked", page.url() === before, page.url());

  // The function sandbox: a network document, allowed only because the server sandboxes it.
  const frameOk = await page.evaluate(() => new Promise((resolve) => {
    const f = document.createElement("iframe");
    f.setAttribute("sandbox", "allow-scripts");
    f.src = "/fn-sandbox.html";
    f.onload = () => resolve(true);
    f.onerror = () => resolve(false);
    document.body.append(f);
    setTimeout(() => resolve(false), 8000);
  }));
  check("the sandboxed function frame loads from the server", frameOk);
} catch (err) {
  check("e2e ran", false, String(err?.stack ?? err));
} finally {
  await app.close().catch(() => undefined);
  rmSync(work, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
