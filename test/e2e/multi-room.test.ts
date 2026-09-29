/**
 * Several rooms at once (6.0), in two real browsers against the real server.
 *
 * Mike is in "alpha" and keeps "beta" connected in the background (the room
 * bar's +). Eva joins beta and writes: her message reaches Mike's background
 * room over P2P and shows as an unread badge. Switching brings beta on screen
 * with the message; alpha goes to the background. Two regressions are
 * guarded here: the old socket's close after a switch started a reconnect
 * loop that ran into the /ws gate (429), and the room leaving the screen was
 * briefly both on screen and in the hub, which duplicated its chip.
 *
 * Needs the production build (`npm run build`) and Playwright's Chromium.
 * Run with `npm run test:e2e`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const PORT = 5921;
const BASE = `http://127.0.0.1:${PORT}`;
const tag = randomBytes(3).toString("hex");
const ALPHA = `alpha-${tag}`;
const BETA = `beta-${tag}`;
// Throwaway values generated for this run; they never leave the test browsers.
const ALPHA_KEY = randomBytes(12).toString("hex");
const BETA_KEY = randomBytes(12).toString("hex");

let server: ChildProcess | null = null;
let browser: Browser | null = null;
const contexts: BrowserContext[] = [];

async function waitForHealth(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
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
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-features=WebRtcHideLocalIpsWithMdns"] });
}, 60_000);

afterAll(async () => {
  for (const ctx of contexts) await ctx.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  server?.kill("SIGTERM");
});

type Client = { page: Page; errors: string[]; tooMany: string[] };

async function join(name: string, room: string, key: string): Promise<Client> {
  if (!browser) throw new Error("browser not initialised");
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1200, height: 820 } });
  contexts.push(ctx);
  const page = await ctx.newPage();
  const errors: string[] = [];
  const tooMany: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (m) => { if (m.type() === "error" && /same key/i.test(m.text())) errors.push(m.text()); });
  page.on("response", (r) => { if (r.status() === 429) tooMany.push(new URL(r.url()).pathname); });
  await page.goto("/");
  await page.getByTestId("button-brand").click();
  await page.getByTestId("input-name").fill(name);
  await page.getByTestId("input-room").fill(room);
  await page.getByTestId("input-passphrase").fill(key);
  await page.getByTestId("button-connect").click();
  return { page, errors, tooMany };
}

/** Each chip as "<key>[*]": * marks the room on screen. */
const chips = (page: Page) => page.getByTestId("rb-room").evaluateAll((els) =>
  els.map((e) => (e as HTMLElement).dataset.key + (e.classList.contains("is-active") ? "*" : "")));

describe("several rooms at once", () => {
  let mike: Client;
  let eva: Client;

  it("keeps a second room connected in the background", async () => {
    mike = await join("Mike", ALPHA, ALPHA_KEY);
    await expect.poll(() => mike.page.getByTestId("room-bar").count(), { timeout: 30_000 }).toBe(1);
    await mike.page.getByTestId("rb-add").click();
    await mike.page.getByTestId("rb-room-input").fill(BETA);
    await mike.page.getByTestId("rb-key-input").fill(BETA_KEY);
    await mike.page.getByTestId("rb-submit").click();
    await expect.poll(() => chips(mike.page), { timeout: 30_000 }).toEqual([`local|${ALPHA}*`, `local|${BETA}`]);
  }, 60_000);

  it("a message in the background room counts as unread", async () => {
    eva = await join("Eva", BETA, BETA_KEY);
    // Eva's peer in beta is Mike's background room.
    await expect.poll(() => eva.page.getByTestId("status-connection").innerText(), { timeout: 60_000 }).toContain("1 P2P");
    await eva.page.getByTestId("input-message").fill("Ahoj z bety");
    await eva.page.getByTestId("button-send").click();
    await expect.poll(() => mike.page.getByTestId("rb-unread").allInnerTexts(), { timeout: 30_000 }).toEqual([expect.stringContaining("1")]);
  }, 120_000);

  it("switching brings the room on screen with what it collected", async () => {
    await mike.page.locator(`[data-testid=rb-room][data-key='local|${BETA}'] [data-testid=rb-switch]`).click();
    await expect.poll(() => mike.page.locator('[data-testid^="message-"]').allInnerTexts(), { timeout: 45_000 })
      .toEqual(expect.arrayContaining([expect.stringContaining("Ahoj z bety")]));
    await expect.poll(() => mike.page.getByTestId("status-connection").innerText(), { timeout: 45_000 }).toContain(`1 P2P · ${BETA}`);
    await expect.poll(() => chips(mike.page), { timeout: 20_000 }).toEqual([`local|${BETA}*`, `local|${ALPHA}`]);
    // It stays connected: no reconnect loop after the switch.
    await mike.page.waitForTimeout(5_000);
    expect(await mike.page.getByTestId("status-connection").innerText()).toContain(`1 P2P · ${BETA}`);
    expect(mike.tooMany).toEqual([]);
    expect(mike.errors).toEqual([]);
  }, 120_000);

  it("× on the room on screen brings the background one forward", async () => {
    await mike.page.locator(`[data-testid=rb-room][data-key='local|${BETA}'] [data-testid=rb-close]`).click();
    await expect.poll(() => chips(mike.page), { timeout: 30_000 }).toEqual([`local|${ALPHA}*`]);
    await expect.poll(() => mike.page.getByTestId("status-connection").innerText(), { timeout: 30_000 }).toContain(ALPHA);
    expect(mike.tooMany).toEqual([]);
    expect(mike.errors).toEqual([]);
  }, 60_000);
});
