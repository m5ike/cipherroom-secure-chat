/**
 * Session cache, enforced desired state, invite links and Clear & Quit —
 * in real browsers against the real server. Run with `npm run test:e2e`
 * after `npm run build`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const PORT = 5919;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOM = `e2e-${randomBytes(4).toString("hex")}`;
const ROOM_KEY = randomBytes(12).toString("hex");   // throwaway, generated per run

let server: ChildProcess | null = null;
let browser: Browser | null = null;
const contexts: BrowserContext[] = [];

beforeAll(async () => {
  if (!existsSync("dist/index.cjs")) throw new Error("run `npm run build` first");
  server = spawn(process.execPath, ["dist/index.cjs"], { env: { ...process.env, NODE_ENV: "production", PORT: String(PORT), HOST: "127.0.0.1" }, stdio: "ignore" });
  const deadline = Date.now() + 15_000;
  for (;;) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error("server did not start");
    await new Promise((r) => setTimeout(r, 200));
  }
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-features=WebRtcHideLocalIpsWithMdns"] });
}, 60_000);

afterAll(async () => {
  for (const ctx of contexts) await ctx.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  server?.kill("SIGTERM");
});

async function newPage(): Promise<Page> {
  const ctx = await browser!.newContext({ baseURL: BASE, viewport: { width: 1280, height: 800 } });
  contexts.push(ctx);
  return ctx.newPage();
}

async function join(page: Page, name: string) {
  await page.goto("/");
  await page.getByTestId("button-brand").click();
  await page.getByTestId("input-name").fill(name);
  await page.getByTestId("input-room").fill(ROOM);
  await page.getByTestId("input-passphrase").fill(ROOM_KEY);
  await page.getByTestId("button-connect").click();
}

const pill = (page: Page) => page.getByTestId("status-connection").innerText();
const peers = (page: Page, n: number) => expect.poll(() => pill(page), { timeout: 45_000 }).toContain(`${n} P2P`);

describe("session cache + desired state", () => {
  let alice: Page; let bob: Page;

  it("opens the menu from the three-bars button, with Clear & Quit at the bottom", async () => {
    alice = await newPage();
    await alice.goto("/");
    expect(await alice.getByTestId("main-nav").count()).toBe(0);          // no inline toolbar by default
    await alice.getByTestId("btn-menu-speeddial").click();
    const items = alice.getByTestId("speeddial-menu").locator("button");
    expect(await items.last().getAttribute("data-testid")).toBe("speeddial-clear-quit");
    await alice.keyboard.press("Escape");
  }, 60_000);

  it("stores the session encrypted — nothing readable in sessionStorage", async () => {
    bob = await newPage();
    await join(alice, "alice"); await join(bob, "bob");
    await peers(alice, 1);
    const raw = await alice.evaluate(() => sessionStorage.getItem("m5cet:session:v1") ?? "");
    expect(raw.length).toBeGreaterThan(40);
    for (const secret of [ROOM, ROOM_KEY, "alice"]) expect(raw).not.toContain(secret);
    // …and nowhere else either
    const everything = await alice.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    expect(everything).not.toContain(ROOM_KEY);
  }, 120_000);

  it("reconnects on its own after a reload, without the form", async () => {
    await alice.reload();
    await peers(alice, 1);
    await peers(bob, 1);
  }, 120_000);

  it("Disconnect sets the desired state and a reload respects it", async () => {
    await alice.getByTestId("button-disconnect-bar").click();
    await expect.poll(() => pill(alice), { timeout: 10_000 }).not.toContain("P2P");
    await alice.reload();
    await alice.waitForTimeout(3000);
    expect(await pill(alice)).not.toContain("P2P");
    expect(await alice.getByTestId("button-disconnect-bar").count()).toBe(0);
    // the session is still there: one click reconnects, no key needed
    await alice.getByTestId("button-brand").click();
    await alice.getByTestId("button-connect").click();
    await peers(alice, 1);
  }, 120_000);

  it("keeps trying while 'connected' is desired and logs the attempts", async () => {
    await alice.getByTestId("btn-menu-speeddial").click();
    await alice.getByTestId("speeddial-btn-connection").click();
    expect(await alice.getByTestId("conn-desired").getAttribute("data-desired")).toBe("connected");
    expect(await alice.getByTestId("conn-log").locator("li").count()).toBeGreaterThan(1);
    await alice.keyboard.press("Escape");
  }, 60_000);
});

describe("invite link", () => {
  let host: Page; let url = ""; let code = "";

  it("creates a link + a separate XXXX-XXXX-XXXX code; secrets stay in the fragment", async () => {
    host = contexts[0].pages()[0];
    await host.getByTestId("button-brand").click();
    await host.getByTestId("button-share").click();
    url = await host.getByTestId("share-url").inputValue();
    code = await host.getByTestId("share-code").innerText();
    expect(code).toMatch(/^\d{4}-\d{4}-\d{4}$/);
    const u = new URL(url);
    expect(u.pathname + u.search).toBe("/");                       // all a crawler or preview bot ever requests
    expect(u.hash).toMatch(/^#j=[\w-]{22}\.[\w-]{43}$/);
    expect(url).not.toContain(ROOM); expect(url).not.toContain(code.replace(/-/g, ""));
    // a second link is a different link with a different code
    await host.getByTestId("share-new").click();
    await expect.poll(() => host.getByTestId("share-code").innerText()).not.toBe(code);
    url = await host.getByTestId("share-url").inputValue();
    code = await host.getByTestId("share-code").innerText();
    await host.getByTestId("share-via-qr").click();
    await host.getByTestId("share-qr").waitFor({ timeout: 10_000 });
  }, 120_000);

  it("is not consumed by crawlers / link previews (GET, no code)", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${BASE}/`, { headers: { "User-Agent": "facebookexternalhit/1.1 TelegramBot WhatsApp" } });
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).not.toContain(ROOM);
      expect(res.headers.get("x-robots-tag") ?? "noindex").toContain("noindex");
    }
    expect((await fetch(`${BASE}/api/share/redeem`)).headers.get("content-type") ?? "").not.toContain("json");
  }, 60_000);

  it("scrubs the link from the address bar, rejects a wrong code, accepts the right one", async () => {
    const guest = await newPage();
    await guest.goto(url);
    await guest.getByTestId("form-invite").waitFor({ timeout: 15_000 });
    expect(guest.url()).not.toContain("#j=");
    const wrong = code.startsWith("0000") ? "1111-1111-1111" : "0000-0000-0000";
    await guest.getByTestId("input-invite-code").fill(wrong);
    await guest.getByTestId("button-invite-join").click();
    await expect.poll(() => guest.getByTestId("invite-message").innerText(), { timeout: 30_000 }).toMatch(/4/);   // attempts left
    await guest.getByTestId("input-invite-code").fill(code);
    await guest.getByTestId("button-invite-join").click();
    await expect.poll(() => pill(guest), { timeout: 60_000 }).toContain("P2P");
    // joined under the random name from the link, not an empty one
    const name = await guest.evaluate(() => JSON.parse(localStorage.getItem("m5cet:prefs:v2") || "{}").name as string);
    expect(name).toMatch(/^[a-z]+-[a-z]+-\d{2}$/);
  }, 180_000);

  it("is limited to X connections: the single-use link is dead afterwards", async () => {
    const late = await newPage();
    await late.goto(url);
    await late.getByTestId("input-invite-code").fill(code);
    await late.getByTestId("button-invite-join").click();
    await late.getByTestId("invite-message").waitFor({ timeout: 30_000 });
    expect(await pill(late)).not.toContain("P2P");
    expect(await late.getByTestId("button-invite-join").isDisabled()).toBe(true);
  }, 120_000);
});

describe("Clear & Quit", () => {
  it("wipes storage, sends Clear-Site-Data and leaves no way back", async () => {
    const page = contexts[0].pages()[0];
    await page.keyboard.press("Escape");             // the Room window is still open from the share test
    await page.evaluate(() => { document.cookie = "probe=1; path=/"; localStorage.setItem("probe", "1"); });
    page.once("dialog", (d) => void d.accept());
    const goodbye = page.waitForResponse((r) => r.url().endsWith("/goodbye"), { timeout: 30_000 });
    await page.getByTestId("btn-menu-speeddial").click();
    await page.getByTestId("speeddial-clear-quit").click();
    expect((await goodbye).status()).toBe(200);
    // Chromium consumes Clear-Site-Data before DevTools sees the headers, so
    // the header itself is asserted with a plain request…
    const header = (await fetch(`${BASE}/goodbye`)).headers.get("clear-site-data") ?? "";
    for (const kind of ['"cache"', '"cookies"', '"storage"', '"executionContexts"']) expect(header).toContain(kind);
    // …and the browser is asked for what actually matters: the effect.
    await page.waitForURL(/\/goodbye$/);
    const left = await page.evaluate(async () => ({
      local: localStorage.length, session: sessionStorage.length, cookies: document.cookie,
      dbs: (await indexedDB.databases()).map((d) => d.name),
      caches: (await caches.keys()).length,
      workers: (await navigator.serviceWorker.getRegistrations()).length,
    }));
    expect(left).toEqual({ local: 0, session: 0, cookies: "", dbs: [], caches: 0, workers: 0 });
    // location.replace() took the chat's entry. Only a reload while connected
    // (earlier in this file) leaves an entry below it (4.0: the navigation
    // lock's; history outlives the document) — and going there loads a
    // fresh, empty app: no session, no messages, not connected.
    const back = await page.goBack().catch(() => null);
    if (back) {
      await page.getByTestId("status-connection").waitFor({ timeout: 15_000 });
      expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
      expect(await page.locator('[data-testid^="message-"]').count()).toBe(0);
      expect(await page.getByTestId("status-connection").innerText()).not.toContain(ROOM);
    } else {
      expect(page.url()).toMatch(/\/goodbye$|about:blank/);
    }
  }, 120_000);
});
