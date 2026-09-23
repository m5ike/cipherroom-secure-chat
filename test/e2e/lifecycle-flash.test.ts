/**
 * The page going to the background and coming back, and the notices that
 * replaced system messages in the conversation.
 *
 *   - a system notice flashes at the top and is NOT written into the chat,
 *   - turning the setting on puts it in the conversation as well,
 *   - clicking a flash brings the next one up at once,
 *   - hiding the tab tells the server the user is away (server-enhanced),
 *     and coming back restores the same connected state.
 *
 * Run with `npm run test:e2e` after `npm run build`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const PORT = 5947;
const BASE = `http://localhost:${PORT}`;
const roomFor = (name: string) => `life-${name}-${randomBytes(3).toString("hex")}`;
const ROOM_KEY = randomBytes(12).toString("hex");

let server: ChildProcess | null = null;
let browser: Browser | null = null;
let dataDir = "";
const contexts: BrowserContext[] = [];

async function waitForHealth(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not become healthy");
}

beforeAll(async () => {
  if (!existsSync("dist/index.cjs")) throw new Error("dist/index.cjs missing — run `npm run build` first");
  dataDir = mkdtempSync(join(tmpdir(), "m5cet-e2e-life-"));
  server = spawn(process.execPath, ["dist/index.cjs"], {
    env: { ...process.env, NODE_ENV: "production", PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR: dataDir, WEBAUTHN_RP_ID: "localhost" },
    stdio: "ignore",
  });
  await waitForHealth(15_000);
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-features=WebRtcHideLocalIpsWithMdns"],
    ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
  });
}, 60_000);

afterAll(async () => {
  for (const ctx of contexts) await ctx.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  server?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 250));
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

async function openApp(): Promise<Page> {
  const ctx = await browser!.newContext({ baseURL: BASE, viewport: { width: 1280, height: 900 } });
  contexts.push(ctx);
  const page = await ctx.newPage();
  await page.goto("/");
  return page;
}

async function joinRoom(page: Page, name: string): Promise<string> {
  const room = roomFor(name);
  await page.getByTestId("button-brand").click();
  await page.getByTestId("input-name").fill(name);
  await page.getByTestId("input-room").fill(room);
  await page.getByTestId("input-passphrase").fill(ROOM_KEY);
  await page.getByTestId("button-connect").click();
  await expect.poll(async () => page.getByTestId("status-connection").innerText(), { timeout: 30_000 }).toContain(room);
  return room;
}

/** Emulates what the browser does when the tab goes to the background. */
async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((isHidden) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (isHidden ? "hidden" : "visible") });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => isHidden });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

describe("notices and the page lifecycle", () => {
  it("flashes a system notice at the top instead of writing it into the chat", async () => {
    const page = await openApp();
    await joinRoom(page, "alice");

    // Joining produces notices; they belong at the top, not in the chat.
    await page.getByTestId("flash-message").waitFor({ state: "visible", timeout: 15_000 });
    const flash = await page.getByTestId("flash-message").innerText();
    expect(flash.length).toBeGreaterThan(0);

    const chat = await page.locator('[data-testid^="message-"]').allInnerTexts();
    expect(chat.join(" ")).not.toContain(flash.split("\n")[0]);
  }, 90_000);

  it("closes on a click and shows whatever is queued behind it", async () => {
    const page = await openApp();
    await joinRoom(page, "bob");
    const first = page.getByTestId("flash-message");
    await first.waitFor({ state: "visible", timeout: 15_000 });
    // By identity, not text: a notice queued behind may say the same thing
    // (a second "joined" after a reconnect on a busy machine).
    const before = await first.getAttribute("data-flash-id");
    expect(before).toBeTruthy();

    await first.click();
    // Either the next notice appears, or the layer empties — never the same one.
    await expect.poll(async () => {
      const shown = page.getByTestId("flash-message");
      if (await shown.count() === 0) return "gone";
      // The dismissed one fades out for a moment: look at the one that stays.
      return await shown.last().getAttribute("data-flash-id");
    }, { timeout: 10_000 }).not.toBe(before);
  }, 90_000);

  it("writes notices into the conversation once the setting is on", async () => {
    const page = await openApp();
    await page.evaluate(() => {
      const raw = localStorage.getItem("m5cet:prefs:v2");
      const prefs = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      localStorage.setItem("m5cet:prefs:v2", JSON.stringify({ ...prefs, showSystemInChat: true }));
    });
    await page.reload();
    await joinRoom(page, "carol");

    await expect.poll(async () => page.locator('[data-testid^="message-system"]').count(), { timeout: 20_000 })
      .toBeGreaterThan(0);
  }, 90_000);

  it("keeps the connection through a trip to another tab", async () => {
    const page = await openApp();
    const room = await joinRoom(page, "dana");
    const connected = await page.getByTestId("status-connection").innerText();
    const messagesBefore = await page.locator('[data-testid^="message-"]').count();

    await setHidden(page, true);
    await page.waitForTimeout(2_500); // past the grace period: now suspended
    await setHidden(page, false);

    // Same room, same session: the pill reads exactly as it did, and the
    // conversation was not rebuilt.
    await expect.poll(async () => page.getByTestId("status-connection").innerText(), { timeout: 20_000 })
      .toContain(room);
    expect(await page.getByTestId("status-connection").innerText()).toBe(connected);
    expect(await page.locator('[data-testid^="message-"]').count()).toBeGreaterThanOrEqual(messagesBefore);
    expect(await page.evaluate(() => document.visibilityState)).toBe("visible");
  }, 90_000);
});
