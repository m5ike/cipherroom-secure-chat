/**
 * A voice call between two browsers with fake microphones: every audio
 * frame is sealed by the sender's worker (RTCRtpScriptTransform) with the
 * pair's media key for that direction and opened by the other side — the
 * panel says so only when, over the last second, every frame in both
 * directions was sealed and opened and none came through in the clear.
 *
 * Needs the production build (`npm run build`) and Playwright's Chromium.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const PORT = 5927;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOM = `e2e-call-${randomBytes(4).toString("hex")}`;
const ROOM_KEY = randomBytes(12).toString("hex");

let server: ChildProcess | null = null;
let browser: Browser | null = null;
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
  server = spawn(process.execPath, ["dist/index.cjs"], {
    env: { ...process.env, NODE_ENV: "production", PORT: String(PORT), HOST: "127.0.0.1" },
    stdio: "ignore",
  });
  await waitForHealth(15_000);
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-features=WebRtcHideLocalIpsWithMdns", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  });
}, 60_000);

afterAll(async () => {
  for (const ctx of contexts) await ctx.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  server?.kill("SIGTERM");
});

async function joinRoom(name: string): Promise<{ page: Page; errors: string[] }> {
  if (!browser) throw new Error("browser not initialised");
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 800 }, permissions: ["microphone"] });
  contexts.push(ctx);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto("/");
  await page.getByTestId("button-brand").click();
  await page.getByTestId("input-name").fill(name);
  await page.getByTestId("input-room").fill(ROOM);
  await page.getByTestId("input-passphrase").fill(ROOM_KEY);
  await page.getByTestId("button-connect").click();
  return { page, errors };
}

async function openAudio(page: Page): Promise<void> {
  const dial = page.getByTestId("btn-menu-speeddial");
  const inDial = await dial.isVisible().catch(() => false);
  if (inDial) await dial.click();
  const entry = page.getByTestId(inDial ? "speeddial-btn-audio" : "btn-audio");
  await entry.waitFor({ state: "visible", timeout: 10_000 });
  await entry.click();
}

describe("a voice call", () => {
  it("seals every frame end to end with the pair's media keys", async () => {
    const alice = await joinRoom("alice");
    const bob = await joinRoom("bob");
    await expect.poll(async () => alice.page.getByTestId("status-connection").innerText(), { timeout: 45_000 }).toContain("1 P2P");
    await expect.poll(async () => bob.page.getByTestId("status-connection").innerText(), { timeout: 45_000 }).toContain("1 P2P");

    for (const side of [alice, bob]) {
      await openAudio(side.page);
      await side.page.getByTestId("button-audio-join").click();
    }
    for (const side of [alice, bob]) {
      await expect.poll(async () => side.page.getByTestId("media-e2ee").getAttribute("data-state"), { timeout: 30_000 }).toBe("e2ee").catch(async (err) => { throw new Error(`${(err as Error).message} — ${await side.page.getByTestId("media-e2ee").getAttribute("data-detail")}`); });
    }
    expect(alice.errors).toEqual([]);
    expect(bob.errors).toEqual([]);
  }, 120_000);
});
