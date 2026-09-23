/**
 * The operator console in a real browser, against the real services.
 *
 *   main service   dist/index.cjs  — /api/admin/* (live state)
 *   admin service  dist/admin.cjs  — serves the console, /admin/* tools,
 *                                   forwards /api/admin/* to the main one
 *
 * Signs in with a throwaway token, walks every panel, and checks that the
 * page runs under its strict CSP without a single violation or script
 * error, that the live feed connects, that traffic from a real WebSocket
 * shows up, that an operator command is queued and audited, and that the
 * token never reaches local storage.
 *
 * Needs `npm run build` and Playwright's Chromium. Run with `npm run test:e2e`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { chromium, type Browser, type Page } from "playwright";

const MAIN_PORT = 5933;
const ADMIN_PORT = 5934;
const MAIN = `http://127.0.0.1:${MAIN_PORT}`;
const ADMIN = `http://127.0.0.1:${ADMIN_PORT}`;
// Generated for this run; it only ever unlocks these two throwaway processes.
const TOKEN = randomBytes(24).toString("hex");
const SHOTS = process.env.CONSOLE_SCREENSHOTS || "";

let main: ChildProcess | null = null;
let admin: ChildProcess | null = null;
let browser: Browser | null = null;
let page: Page;
const dataDir = mkdtempSync(join(tmpdir(), "m5cet-console-"));
const problems: string[] = [];

async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${url} did not come up`);
}

beforeAll(async () => {
  if (!existsSync("dist/index.cjs") || !existsSync("dist/admin.cjs")) throw new Error("run `npm run build` first");
  const env = { ...process.env, NODE_ENV: "production", ADMIN_API_TOKEN: TOKEN, DATA_DIR: dataDir, HOST: "127.0.0.1" };
  main = spawn(process.execPath, ["dist/index.cjs"], { env: { ...env, PORT: String(MAIN_PORT) }, stdio: "ignore" });
  admin = spawn(process.execPath, ["dist/admin.cjs"], { env: { ...env, ENABLE_ADMIN: "1", ADMIN_PORT: String(ADMIN_PORT), MAIN_URL: MAIN }, stdio: "ignore" });
  await waitFor(`${MAIN}/api/health`, 20_000);
  await waitFor(`${ADMIN}/admin/health`, 20_000);
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await ctx.newPage();
  page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => { if (msg.type() === "error") problems.push(`console: ${msg.text()}`); });
}, 60_000);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
  main?.kill("SIGTERM");
  admin?.kill("SIGTERM");
  rmSync(dataDir, { recursive: true, force: true });
});

async function shot(name: string) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `console-${name}.png`), fullPage: false });
}

async function go(route: string) {
  await page.click(`.nav__item[data-route="${route}"]`);
  await expect.poll(() => page.locator(`[data-panel="${route}"]`).isVisible()).toBe(true);
}

describe("operator console", () => {
  it("is served with a strict policy and refuses a wrong token", async () => {
    const res = await fetch(`${ADMIN}/`);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-eval");
    expect(res.headers.get("x-frame-options")).toBe("DENY");

    await page.goto(`${ADMIN}/`);
    await page.fill("#loginToken", "not-the-token");
    await page.click("#loginForm button[type=submit]");
    await expect.poll(() => page.locator("#loginError").innerText()).toMatch(/refused|sign in/i);
    expect(await page.locator("#shell").isHidden()).toBe(true);
    // The browser logs the refused request itself; that one is expected.
    problems.length = 0;
  });

  it("signs in and shows the overview with a live feed", async () => {
    await page.fill("#loginToken", TOKEN);
    await page.click("#loginForm button[type=submit]");
    await expect.poll(() => page.locator("#shell").isVisible(), { timeout: 10_000 }).toBe(true);
    await expect.poll(() => page.locator("#kpis .kpi").count()).toBeGreaterThanOrEqual(8);
    await expect.poll(() => page.locator("#liveText").innerText(), { timeout: 10_000 }).toBe("live");
    await expect.poll(() => page.locator("#healthChecks .check").count()).toBeGreaterThanOrEqual(4);
    // Memory only: nothing in local storage, the old key is gone too.
    const stored = await page.evaluate(() => JSON.stringify(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])));
    expect(stored).not.toContain(TOKEN);
    await page.waitForTimeout(2500); // a couple of ticks for the charts
    await shot("overview");
  });

  it("shows WebSocket traffic and the connection as it happens", async () => {
    await go("traffic");
    const ws = new WebSocket(`${MAIN.replace("http", "ws")}/ws`);
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ type: "join", protocol: 2, room: "console-room", name: "Tester" }));
    ws.send(JSON.stringify({ type: "ping", t: Date.now() }));
    await expect.poll(() => page.locator("#trafficTable tbody").innerText(), { timeout: 10_000 }).toContain("join");
    await shot("traffic");

    await go("connections");
    await expect.poll(() => page.locator("#connTable tbody").innerText(), { timeout: 10_000 }).toContain("Tester");
    await go("rooms");
    await expect.poll(() => page.locator("#roomCards").innerText()).toContain("Tester");
    // A room is shown by its hash, never by its name.
    expect(await page.locator("#roomCards").innerText()).not.toContain("console-room");
    ws.close();
  });

  it("walks users, queue, storage, system and retention without errors", async () => {
    for (const route of ["users", "queue", "storage", "system", "retention"]) {
      await go(route);
      await page.waitForTimeout(300);
    }
    await expect.poll(() => page.locator("#sysKpis .kpi").count()).toBeGreaterThanOrEqual(5);
    await shot("system");
  });

  it("queues an operator command and records it in the audit journal", async () => {
    await go("commands");
    await expect.poll(() => page.locator("#cmdKindNew option").count()).toBeGreaterThan(3);
    await page.fill("#cmdDevice", "device-console-test");
    await page.selectOption("#cmdKindNew", "refresh-settings");
    await page.click("#cmdForm button[type=submit]");
    await expect.poll(() => page.locator("#cmdResult").innerText()).toMatch(/queued/);
    await expect.poll(() => page.locator("#cmdPending tbody").innerText()).toContain("device-console-test");

    await go("audit");
    await expect.poll(() => page.locator("#auditTable tbody").innerText(), { timeout: 10_000 }).toContain("admin.command");
    await shot("audit");
  });

  it("keeps the ported tools working through the admin service", async () => {
    await go("layout");
    await page.click("#lbLoad");
    await expect.poll(() => page.locator("#lbOut").innerText()).toMatch(/updatedAt|defaults/);
    await go("plugins");
    await page.click("#btnPlugins");
    await expect.poll(() => page.locator("#pluginOut").innerText()).toMatch(/defaults|enabled/);
  });

  it("configures the client addons: saved connections, other servers, GUI templates", async () => {
    await go("client");
    await expect.poll(() => page.locator("#clientUsage .kpi").count()).toBe(3);
    await page.check("#cxCustom");
    await page.fill("#cxMax", "12");
    await page.click("#cxAddServer");
    await page.locator("[data-srv-label]").last().fill("EU");
    await page.locator("[data-srv-url]").last().fill("chat-eu.example.org");
    await page.click("#clientConnections button[type=submit]");
    await expect.poll(() => page.locator("#toasts").innerText()).toMatch(/Saved/);
    // Only iOS and Windows, iOS by default, locked.
    for (const box of await page.locator("[data-theme-pick]").all()) {
      const id = await box.getAttribute("value");
      if ((id === "ios" || id === "windows") !== (await box.isChecked())) await box.click();
    }
    await page.selectOption("#cxDefaultTheme", "ios");
    await page.check("#cxLock");
    await page.click("#clientAppearance button[type=submit]");
    await expect.poll(async () => (await (await fetch(`${MAIN}/api/client-config`)).json()).config.appearance.lockTheme).toBe(true);

    const cfg = (await (await fetch(`${MAIN}/api/client-config`)).json()).config;
    expect(cfg.connections).toMatchObject({ maxProfiles: 12, allowCustomServers: true, servers: [{ label: "EU", url: "wss://chat-eu.example.org" }] });
    expect(cfg.appearance).toMatchObject({ themes: ["ios", "windows"], defaultTheme: "ios", lockTheme: true });
    await page.locator("#toasts").evaluate((el) => el.replaceChildren());
    await shot("client");
    await go("audit");
    await expect.poll(() => page.locator("#auditTable tbody").innerText(), { timeout: 10_000 }).toContain("admin.client-config");
  });

  it("gives an auditor the console to read, and nothing to change", async () => {
    // The owner names an auditor and issues them a token of their own.
    const owner = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
    expect((await fetch(`${MAIN}/api/admin/admins`, { method: "POST", headers: owner, body: JSON.stringify({ name: "eve", role: "auditor" }) })).ok).toBe(true);
    const issued = await (await fetch(`${MAIN}/api/admin/admins/eve/tokens`, { method: "POST", headers: owner, body: JSON.stringify({ label: "e2e" }) })).json() as { token: string };
    expect(issued.token.length).toBeGreaterThanOrEqual(32);

    await page.click("#btnSignOut");
    await page.fill("#loginToken", issued.token);
    await page.click("#loginForm button[type=submit]");
    await expect.poll(() => page.locator("#shell").isVisible(), { timeout: 10_000 }).toBe(true);
    await expect.poll(() => page.locator("#whoami").innerText()).toMatch(/eve.*auditor/);

    // What only an owner may do is not even shown…
    expect(await page.locator('.nav__item[data-route="admins"]').isHidden()).toBe(true);
    // …what an operator may do is shown but disabled…
    await go("commands");
    expect(await page.locator("#cmdForm button[type=submit]").getAttribute("data-disabled-by-role")).not.toBeNull();
    // …and the server refuses it anyway.
    const refused = await fetch(`${MAIN}/api/admin/commands`, {
      method: "POST",
      headers: { Authorization: `Bearer ${issued.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: "device-x", kind: "refresh-settings" }),
    });
    expect(refused.status).toBe(403);

    // Reading is theirs: the journal verifies, and records who looked.
    await go("audit");
    expect(await page.locator("#auditVerify").getAttribute("data-disabled-by-role")).toBeNull();
    await page.click("#auditVerify");
    await expect.poll(() => page.locator("body").innerText(), { timeout: 10_000 }).toMatch(/Journal intact/);
    // The refused request above is the browser's own log line, not a problem.
    problems.splice(0, problems.length, ...problems.filter((p) => !/403/.test(p)));
  });

  it("ran without a CSP violation or a script error", () => {
    expect(problems).toEqual([]);
  });
});
