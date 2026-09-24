/**
 * Losing the passkey is not losing the account: a recovery code made on
 * one device signs in on another that has never seen the account — a new
 * passkey is registered there and the account key comes back, opened from
 * what the code sealed. Virtual authenticators (CDP) stand in for the
 * passkeys; each browser context has its own, like two phones.
 *
 * Needs the production build (`npm run build`) and Playwright's Chromium.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const PORT = 5935;
const BASE = `http://localhost:${PORT}`;
const ROOM = `rec-${randomBytes(3).toString("hex")}`;
const ROOM_KEY = randomBytes(12).toString("hex");

let server: ChildProcess | null = null;
let browser: Browser | null = null;
let dataDir = "";
const contexts: BrowserContext[] = [];

beforeAll(async () => {
  if (!existsSync("dist/index.cjs")) throw new Error("dist/index.cjs missing — run `npm run build` first");
  dataDir = mkdtempSync(join(tmpdir(), "m5cet-e2e-recovery-"));
  server = spawn(process.execPath, ["dist/index.cjs"], {
    env: { ...process.env, NODE_ENV: "production", PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR: dataDir, WEBAUTHN_RP_ID: "localhost", WEBAUTHN_ORIGINS: BASE },
    stdio: "ignore",
  });
  const deadline = Date.now() + 15_000;
  for (;;) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("server did not become healthy");
    await new Promise((r) => setTimeout(r, 200));
  }
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
}, 60_000);

afterAll(async () => {
  for (const ctx of contexts) await ctx.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  server?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 250));
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

/** A device: its own browser context with its own passkey authenticator. */
async function device(): Promise<{ page: Page; errors: string[] }> {
  const ctx = await browser!.newContext({ baseURL: BASE, viewport: { width: 1280, height: 900 } });
  contexts.push(ctx);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, hasPrf: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  await page.goto("/");
  await page.getByTestId("button-brand").click();
  await page.getByTestId("input-name").fill("alice");
  await page.getByTestId("input-room").fill(ROOM);
  await page.getByTestId("input-passphrase").fill(ROOM_KEY);
  await page.getByTestId("button-connect").click();
  await expect.poll(async () => page.getByTestId("status-connection").innerText(), { timeout: 30_000 }).toContain(ROOM);
  return { page, errors };
}

async function openConnection(page: Page): Promise<void> {
  const dial = page.getByTestId("btn-menu-speeddial");
  const inDial = await dial.isVisible().catch(() => false);
  if (inDial) await dial.click();
  await page.getByTestId(inDial ? "speeddial-btn-connection" : "btn-connection").click();
  await page.getByTestId("retention-section").waitFor({ state: "visible", timeout: 10_000 });
}

describe("account recovery", () => {
  let code = "";
  let username = "";

  it("makes a recovery code on the first device", async () => {
    const first = await device();
    await openConnection(first.page);
    await first.page.getByTestId("account-register").click();
    await first.page.getByTestId("signed-in-badge").waitFor({ state: "visible", timeout: 20_000 });
    // 4.0: the server named the account; the recovery code is made here, in
    // the Connection window (the only place for passkeys).
    username = (await first.page.getByTestId("account-username").innerText()).trim();
    expect(username).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{4,6}$/);
    await first.page.getByTestId("recovery-create").click();
    code = (await first.page.getByTestId("recovery-code").innerText({ timeout: 20_000 })).trim();
    // 26 Crockford base32 characters (130 bits), shown in groups.
    expect(code.replace(/[\s-]/g, "")).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(first.errors).toEqual([]);
  }, 120_000);

  it("signs in on a new device with the code and a new passkey there", async () => {
    const second = await device();
    await openConnection(second.page);
    await second.page.getByTestId("recover-open").click();
    await second.page.getByTestId("recover-code").fill(code.toLowerCase()); // typed any which way
    await second.page.locator('[data-testid="recover-form"] button[type=submit]').click();
    await second.page.getByTestId("signed-in-badge").waitFor({ state: "visible", timeout: 20_000 });
    // The same account — the same username — on the new device.
    expect(await second.page.getByTestId("signed-in-badge").innerText()).toContain(username);
    // Both passkeys now open the account; the account key is the same one.
    await expect.poll(() => second.page.getByTestId("passkey-row").count(), { timeout: 10_000 }).toBe(2);
    await second.page.keyboard.press("Escape");

    await second.page.getByTestId("signed-in-badge").click();
    await expect.poll(() => second.page.getByTestId("session-row").count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    expect(second.errors).toEqual([]);
  }, 120_000);

  it("does not accept a wrong code", async () => {
    const third = await device();
    await openConnection(third.page);
    await third.page.getByTestId("recover-open").click();
    await third.page.getByTestId("recover-code").fill("0".repeat(26));
    await third.page.locator('[data-testid="recover-form"] button[type=submit]').click();
    await third.page.getByTestId("signin-error").waitFor({ state: "visible", timeout: 15_000 });
    expect(await third.page.getByTestId("signed-in-badge").count()).toBe(0);
  }, 120_000);
});
