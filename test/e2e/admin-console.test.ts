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
  const env = { ...process.env, NODE_ENV: "production", ADMIN_API_TOKEN: TOKEN, DATA_DIR: dataDir, HOST: "127.0.0.1", ENABLE_AI: "", ENABLE_SPEECH: "" };
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
    await go("plugins");
    await page.click("#btnPlugins");
    await expect.poll(() => page.locator("#pluginOut").innerText()).toMatch(/defaults|enabled/);
    // 4.0.6: the modules are switched here, and the app service sees it (a shared file).
    await expect.poll(() => page.locator("#switch-ai").isChecked()).toBe(false);
    await page.check("#switch-ai");
    await expect.poll(() => page.locator("#pluginSwitches").innerText()).toMatch(/AI module: ON/);
    await expect.poll(async () => (await (await fetch(`${MAIN}/api/ai/status`)).json()).enabled).toBe(true);
    await page.uncheck("#switch-ai");
    await expect.poll(() => page.locator("#pluginSwitches").innerText()).toMatch(/AI module: off/);
    await expect.poll(async () => (await (await fetch(`${MAIN}/api/ai/status`)).json()).enabled).toBe(false);
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

  it("switches modules off, or gives them to groups — members never reach the clients", async () => {
    await go("modules");
    await expect.poll(() => page.locator("[data-module-on]").count()).toBeGreaterThan(8);
    await page.click("#groupAdd");
    await page.fill('[data-group-id="0"]', "staff");
    await page.fill('[data-group-label="0"]', "Staff");
    await page.fill('[data-group-members="0"]', "bystry-sokol-7k3q");
    await page.click("#groupsForm button[type=submit]");
    await expect.poll(() => page.locator("#toasts").innerText()).toMatch(/Groups saved/);
    await page.uncheck('[data-module-on="ai"]');
    await page.check('[data-module-group="telephony"][value="staff"]');
    await page.click("#modulesForm button[type=submit]");
    await expect.poll(() => page.locator("#toasts").innerText()).toMatch(/Modules saved/);
    const cfg = (await (await fetch(`${MAIN}/api/client-config`)).json()).config;
    expect(cfg.modules.ai).toMatchObject({ enabled: false });
    expect(cfg.modules.telephony).toMatchObject({ enabled: true, groups: ["staff"] });
    expect(cfg.groups).toEqual([{ id: "staff", label: "Staff", members: [] }]);
    // The server refuses what a module switched off serves.
    const ai = await fetch(`${MAIN}/api/ai/complete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(ai.status).toBe(403);
    expect((await ai.json()).code).toBe("module-disabled");
    await page.locator("#toasts").evaluate((el) => el.replaceChildren());
    await shot("modules");
  });

  it("builds the menu: drag and drop, styles and states, HTML with variables, help — and the app draws it", async () => {
    await go("menu");
    await expect.poll(() => page.locator("#mbTree .mbt-row[data-id]").count()).toBeGreaterThan(25);
    const topIds = () => page.locator("#mbTree .mbt-area").first().evaluate((area) =>
      Array.from(area.querySelector(".mbt-list")!.children).map((li) => (li as HTMLElement).dataset.id).filter(Boolean));
    // The default is the classic menu.
    expect(await topIds()).toEqual(["user", "quick", "room", "talk", "tools", "app"]);
    expect(await page.locator("#mbPreview .menu-group-label").count()).toBe(4);

    // Drag "Tools" above "Room".
    await page.dragAndDrop('#mbTree .mbt-row[data-id="tools"]', '#mbTree .mbt-row[data-id="room"]', { targetPosition: { x: 60, y: 3 } });
    await expect.poll(topIds).toEqual(["user", "quick", "tools", "room", "talk", "app"]);
    // …and an item into another section, by keyboard: Alt+↑ at the top of "Talk" moves it out, above the section.
    await page.click('#mbTree .mbt-row[data-id="btn-audio"]');
    await page.focus('#mbTree .mbt-row[data-id="btn-audio"]');
    await page.keyboard.press("Alt+ArrowUp");
    await expect.poll(topIds).toEqual(["user", "quick", "tools", "room", "btn-audio", "talk", "app"]);
    await page.click("#mbUndo");
    await expect.poll(topIds).toEqual(["user", "quick", "tools", "room", "talk", "app"]);

    // An HTML block with live variables in "Room", written with the help window.
    await page.click('#mbTree .mbt-row[data-id="room"]');
    await page.click('[data-mb-add="html"]');
    const html = page.locator('[data-prop="html"]');
    await html.fill("<b>{$user.nickname}</b> · {$session.room|upper} ");
    await page.click(".mb-htmltools .btn");
    await expect.poll(() => page.locator("#mbHelp").isVisible()).toBe(true);
    await page.click('#mbHelp [data-help-tab="filters"]');
    await page.fill("#mbHelp input[type=search]", "peers");
    await page.locator("#mbHelp .mb-help__row").first().click();
    await expect.poll(() => html.inputValue()).toMatch(/\{\$session\.peers\|padLeft:2\}|\{\$room\.people\|length\}/);
    await page.click('#mbHelp button[aria-label="Close the help"]');
    await expect.poll(() => page.locator("#mbPreview .menu-html").first().innerText(), { timeout: 5000 }).toMatch(/Alice · TYM-BRNO/);

    // Style and a hover state for "Settings"; a separator in "Talk".
    await page.click('#mbTree .mbt-row[data-id="btn-settings"]');
    await page.click(".mb-style > summary");
    await page.selectOption('[data-prop="style-fontWeight"]', "800");
    await page.fill('[data-prop="style-fontSize"]', "17");
    await page.selectOption('[data-prop="state-hover-background"]', "destructive");
    await page.selectOption('[data-prop="state-hover-color"]', "#");
    const settings = page.locator('#mbPreview [data-mb-id="btn-settings"]');
    await expect.poll(() => settings.evaluate((el) => (el as HTMLElement).style.fontWeight)).toBe("800");
    expect(await settings.getAttribute("class")).toContain("mb-hover-bg");
    await page.selectOption("#mbState", "hover");
    await expect.poll(() => settings.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
    await page.selectOption("#mbState", "");
    await page.click('#mbTree .mbt-row[data-id="talk"]');
    await page.click('[data-mb-add="separator"]');
    await page.selectOption('[data-prop="variant"]', "dashed");

    // The ☰ button: an icon from the picker, and a text.
    await page.click('#mbTree .mbt-row[data-root="trigger"]');
    await page.click('[data-prop="trigger-icon"]');
    await page.fill(".mb-dialog input[type=search]", "rocket");
    await page.click('.mb-dialog [data-icon="rocket"]');
    await page.fill('[data-prop="trigger-text"]', "Menu");
    await page.check('[data-prop="trigger-showtext"]');
    await expect.poll(() => page.locator('#mbPreview [data-mb-id="trigger"]').innerText()).toBe("Menu");
    await expect.poll(() => page.locator("#mbDirty").isVisible()).toBe(true);
    await page.waitForTimeout(300); // the switch's transition
    await shot("menu-builder");

    await page.click("#mbSave");
    await expect.poll(() => page.locator("#toasts").innerText()).toMatch(/Menu saved/);
    const menu = (await (await fetch(`${MAIN}/api/menu-config`)).json()).config;
    expect(menu.items.map((n: { id: string }) => n.id)).toEqual(["user", "quick", "tools", "room", "talk", "app"]);
    expect(menu.trigger).toMatchObject({ icon: "rocket", text: "Menu", showText: true });
    const room = menu.items.find((n: { id: string }) => n.id === "room");
    expect(room.children.at(-1)).toMatchObject({ kind: "html" });
    const app = menu.items.find((n: { id: string }) => n.id === "app");
    const btn = app.children.find((n: { id: string }) => n.id === "btn-settings");
    expect(btn.style).toMatchObject({ fontWeight: "800", fontSize: 17, states: { hover: { background: "destructive" } } });
    expect(btn.style.states.hover.color).toMatch(/^#[0-9a-f]{6}$/i);

    // The app draws the saved menu (a phone: the ☰ panel).
    const appCtx = await browser!.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const app2 = await appCtx.newPage();
    await app2.goto(MAIN);
    await app2.locator('[data-testid="btn-menu-speeddial"]').waitFor();
    await expect.poll(() => app2.locator('[data-testid="btn-menu-speeddial"]').innerText(), { timeout: 10_000 }).toBe("Menu");
    await app2.click('[data-testid="btn-menu-speeddial"]');
    const panel = app2.locator('[data-testid="speeddial-menu"]');
    await panel.waitFor();
    const order = await panel.locator('[data-testid^="speeddial-btn-"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
    expect(order.indexOf("speeddial-btn-speech")).toBeLessThan(order.indexOf("speeddial-btn-room-security"));
    // The modules switched off above: AI for everyone, telephony for all but "staff".
    expect(order).not.toContain("speeddial-btn-ai");
    expect(order).not.toContain("speeddial-btn-phone");
    expect(await panel.locator(".menu-html").count()).toBe(1);
    expect(await panel.locator(".menu-sep--dashed").count()).toBe(1);
    expect(await app2.locator('[data-testid="speeddial-btn-settings"]').evaluate((el) => (el as HTMLElement).style.fontWeight)).toBe("800");
    if (SHOTS) await app2.screenshot({ path: join(SHOTS, "app-menu-built.png") });
    await appCtx.close();

    // Back to the classic menu.
    page.once("dialog", (d) => void d.accept());
    await page.click("#mbReset");
    await page.click("#mbSave");
    await expect.poll(async () => (await (await fetch(`${MAIN}/api/menu-config`)).json()).config.items.map((n: { id: string }) => n.id)).toEqual(["user", "quick", "room", "talk", "tools", "app"]);
    await page.locator("#toasts").evaluate((el) => el.replaceChildren());
    await go("audit");
    await expect.poll(() => page.locator("#auditTable tbody").innerText(), { timeout: 10_000 }).toContain("admin.menu-config");
  });

  it("designs layouts: the palette, suggestions, the app's own preview, templates — and the app draws them", async () => {
    await go("layout");
    await expect.poll(() => page.locator("#lbTabs .lb-tab").count()).toBeGreaterThanOrEqual(9);
    await page.click('#lbTabs [data-layout="composer"]');
    await expect.poll(() => page.locator("#lbTree .mbt-row").count()).toBeGreaterThan(20);
    const frame = page.frameLocator("#lbFrame");
    // The preview is the app itself: its composer, drawn from the layout.
    await expect.poll(() => frame.locator('[data-lb-id="btn-emoji"]').count(), { timeout: 15_000 }).toBe(1);
    expect(await frame.locator('[data-testid="input-message"]').count()).toBe(1);

    // Pick an element in the preview.
    await frame.locator('[data-lb-id="btn-file"]').click({ position: { x: 20, y: 4 } });
    await expect.poll(() => page.locator("#lbTree .mbt-row.is-selected").getAttribute("data-id")).toBe("btn-file");
    const sugg = () => page.locator(".sg-list:not([hidden]) .sg-item .sg-value").allInnerTexts();
    // A class, completed from the classes the app really has.
    const cls = page.locator('[data-prop="attr-class"]');
    await cls.click();
    await cls.press("End");
    await cls.type(" rounded-f");
    await expect.poll(sugg).toContain("rounded-full");
    await page.locator('.sg-list:not([hidden]) .sg-item[data-value="rounded-full"]').click();
    await expect.poll(() => frame.locator('[data-lb-id="btn-file"]').getAttribute("class")).toContain("rounded-full");
    // CSS: property and value suggested.
    await page.click('#lbProps details summary:has-text("CSS")');
    const cssNew = page.locator('[data-prop="css-new"]');
    await cssNew.click();
    await cssNew.type("border-st");
    await expect.poll(sugg).toContain("border-style");
    await page.locator('.sg-list:not([hidden]) .sg-item[data-value="border-style"]').click();
    const cssVal = page.locator('#lbProps [data-prop="css-border-style"]');
    await cssVal.fill("");
    await cssVal.type("dash");
    await expect.poll(sugg).toEqual(["dashed"]);
    await cssVal.press("ArrowDown");
    await cssVal.press("Enter");
    await expect.poll(() => frame.locator('[data-lb-id="btn-file"]').getAttribute("style")).toContain("border-style: dashed");

    // A new button from the palette, with a text and an action.
    await page.dragAndDrop('#lbPalette [data-make="button"]', '#lbTree .mbt-row[data-id="actions"]', { targetPosition: { x: 90, y: 12 } });
    await expect.poll(() => page.locator("#lbTree .mbt-row.is-selected").getAttribute("data-id")).toBe("button");
    const text = page.locator('#lbProps [data-prop="text"]');
    await text.fill("Hi {$ro");
    await expect.poll(sugg).toContain("{$room}");
    await text.press("ArrowDown");
    await text.press("Enter");
    await expect.poll(() => text.inputValue()).toBe("Hi {$room}");
    await page.click('#lbProps details summary:has-text("Logic")');
    const ev = page.locator('[data-prop="on-new"]');
    await ev.click();
    await ev.type("clic");
    await page.locator('.sg-list:not([hidden]) .sg-item[data-value="click"]').click();
    const action = page.locator('[data-prop="on-click"]');
    await action.fill("");
    await action.type("toggleEm");
    await expect.poll(sugg).toEqual(["toggleEmoji"]);
    await action.press("ArrowDown");
    await action.press("Enter");
    const attr = page.locator('[data-prop="attr-new"]');
    await attr.click();
    await attr.type("data-test");
    await page.locator('.sg-list:not([hidden]) .sg-item[data-value="data-testid"]').click();
    await page.locator('#lbProps [data-prop="attr-data-testid"]').fill("lb-hello");
    await expect.poll(() => frame.locator('[data-lb-id="button"]').innerText()).toBe("Hi tym-brno");
    // Try it in the preview: the action runs there too.
    await page.selectOption("#lbMode", "interact");
    await page.waitForTimeout(300);
    await frame.locator('[data-lb-id="button"]').click();
    await expect.poll(() => frame.locator('[data-testid="picker-emoji"]').count()).toBe(1);
    await page.selectOption("#lbMode", "select");

    // A template: the emoji button, reused in the app bar.
    page.once("dialog", (d) => void d.accept("smile-btn"));
    await page.click('#lbTree .mbt-row[data-id="btn-emoji"] .mbt-title');
    await page.click('#lbTree .lb-tool[data-tool="save"]');
    await expect.poll(() => page.locator('#lbPalette [data-make="block:smile-btn"]').count()).toBe(1);
    await page.click('#lbTabs [data-layout="header"]');
    await expect.poll(() => page.locator("#lbTree .mbt-row").count()).toBeGreaterThan(8);
    await page.click('#lbTree .mbt-row[data-id="header"] .mbt-title');
    await page.click('#lbPalette [data-make="block:smile-btn"]');
    await expect.poll(() => frame.locator('header [data-testid="button-emoji"]').count(), { timeout: 10_000 }).toBe(1);
    expect(await page.locator("#lbErrors").isHidden()).toBe(true);
    await shot("layout-builder");

    await page.click("#lbSave");
    await expect.poll(() => page.locator("#toasts").innerText()).toMatch(/Layouts saved/);
    const saved = (await (await fetch(`${MAIN}/api/layout`)).json()).layout;
    expect(Object.keys(saved.layouts).sort()).toEqual(["composer", "header"]);
    expect(Object.keys(saved.blocks)).toEqual(["smile-btn"]);

    // The app draws the saved layouts — and the new button works there.
    const appCtx = await browser!.newContext({ viewport: { width: 1280, height: 900 } });
    const app2 = await appCtx.newPage();
    await app2.goto(MAIN);
    await app2.locator('[data-testid="lb-hello"]').waitFor({ timeout: 15_000 });
    expect((await app2.locator('[data-testid="lb-hello"]').innerText()).trim()).toBe("Hi");
    expect(await app2.locator('[data-testid="button-attach-file"]').getAttribute("class")).toContain("rounded-full");
    expect(await app2.locator('header [data-testid="button-emoji"]').count()).toBe(1);
    await app2.click('[data-testid="lb-hello"]');
    await expect.poll(() => app2.locator('[data-testid="picker-emoji"]').count()).toBe(1);
    if (SHOTS) await app2.screenshot({ path: join(SHOTS, "app-layout-built.png") });
    await appCtx.close();

    // Back to the app's own layouts.
    for (const id of ["composer", "header"]) {
      await page.click(`#lbTabs [data-layout="${id}"]`);
      page.once("dialog", (d) => void d.accept());
      await page.click("#lbReset");
    }
    await page.click("#lbSave");
    await expect.poll(async () => Object.keys((await (await fetch(`${MAIN}/api/layout`)).json()).layout.layouts)).toEqual([]);
    await page.locator("#toasts").evaluate((el) => el.replaceChildren());
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

    // The menu builder shows the menu, and changes nothing.
    await go("menu");
    await expect.poll(() => page.locator("#mbTree .mbt-row[data-id]").count()).toBeGreaterThan(25);
    await expect.poll(() => page.locator("#mbSave").isHidden()).toBe(true);
    await expect.poll(() => page.locator("#mbAdd").isHidden()).toBe(true);
    await expect.poll(() => page.locator('#mbTree .mbt-row[data-id="room"]').getAttribute("draggable")).toBeNull();
    // …the Layout builder too.
    await go("layout");
    await expect.poll(() => page.locator("#lbTree .mbt-row").count()).toBeGreaterThan(8);
    await expect.poll(() => page.locator("#lbSave").isHidden()).toBe(true);
    expect(await page.locator("#lbTree .mbt-row[draggable]").count()).toBe(0);
    expect(await page.locator("#lbPalette .lb-pal[draggable]").count()).toBe(0);
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
