/**
 * Saved connections of a signed-in user in server-enhanced mode: create one
 * (room, key, name), connect with it, count what happens in it, reconnect
 * by itself after the page comes back — and the server keeps only a sealed
 * block and a count, never the room key or the room name.
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

const PORT = 5937;
const BASE = `http://localhost:${PORT}`;
const ROOM = `cx-${randomBytes(3).toString("hex")}`;
const ROOM_KEY = `key-${randomBytes(8).toString("hex")}`;
const ROOM2 = `cx2-${randomBytes(3).toString("hex")}`;

let server: ChildProcess | null = null;
let browser: Browser | null = null;
let dataDir = "";
const contexts: BrowserContext[] = [];

beforeAll(async () => {
  if (!existsSync("dist/index.cjs")) throw new Error("dist/index.cjs missing — run `npm run build` first");
  dataDir = mkdtempSync(join(tmpdir(), "m5cet-e2e-cx-"));
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
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-features=WebRtcHideLocalIpsWithMdns"] });
}, 60_000);

afterAll(async () => {
  for (const ctx of contexts) await ctx.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  server?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 250));
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

async function tab(withPasskey: boolean): Promise<{ page: Page; errors: string[] }> {
  const ctx = await browser!.newContext({ baseURL: BASE, viewport: { width: 1280, height: 900 } });
  contexts.push(ctx);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  if (withPasskey) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("WebAuthn.enable", { enableUI: false });
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, hasPrf: true, isUserVerified: true, automaticPresenceSimulation: true },
    });
  }
  await page.goto("/");
  return { page, errors };
}

async function openMenuEntry(page: Page, testId: string): Promise<void> {
  const dial = page.getByTestId("btn-menu-speeddial");
  const inDial = await dial.isVisible().catch(() => false);
  if (inDial) await dial.click();
  await page.getByTestId(inDial ? `speeddial-${testId}` : testId).click();
}

describe("saved connections", () => {
  let alice: { page: Page; errors: string[] };

  it("are offered only to a signed-in user in server-enhanced mode", async () => {
    alice = await tab(true);
    await openMenuEntry(alice.page, "btn-connections");
    await alice.page.getByTestId("connections-need").waitFor({ timeout: 10_000 });
    // 4.0: signed out there is only the way to the Connection window — the
    // one place to sign in; an account switches Server-enhanced on.
    expect(await alice.page.getByTestId("cx-enable-server").count()).toBe(0);
    await alice.page.getByTestId("cx-need-open").click();
    await alice.page.getByTestId("account-register").click();
    await alice.page.getByTestId("signin-done").waitFor({ timeout: 20_000 });
    expect(await alice.page.locator('[data-testid="signin-steps"] [data-state="fail"]').count()).toBe(0);
    await alice.page.getByTestId("signed-in-badge").waitFor({ state: "visible", timeout: 20_000 });
    await alice.page.keyboard.press("Escape");
    await openMenuEntry(alice.page, "btn-connections");
    await alice.page.getByTestId("cx-empty").waitFor({ timeout: 15_000 });
  }, 120_000);

  it("saves a connection and connects with it", async () => {
    await alice.page.getByTestId("cx-add").click();
    await alice.page.getByTestId("cx-f-label").fill("Tým Brno");
    await alice.page.getByTestId("cx-f-room").fill(ROOM);
    await alice.page.getByTestId("cx-f-name").fill("alice");
    await alice.page.getByTestId("cx-f-key").fill(ROOM_KEY);
    await alice.page.getByTestId("cx-f-save-connect").click();
    await expect.poll(async () => alice.page.getByTestId("status-connection").innerText(), { timeout: 30_000 }).toContain(ROOM);
    // The header switcher shows the connection in use.
    await expect.poll(async () => alice.page.getByTestId("cx-switcher-select").inputValue()).toMatch(/^cx-/);
  }, 120_000);

  it("counts messages and people in the connection's statistics and log", async () => {
    // Bob joins the same room by hand (no account).
    const bob = await tab(false);
    await bob.page.getByTestId("button-brand").click();
    await bob.page.getByTestId("input-name").fill("bob");
    await bob.page.getByTestId("input-room").fill(ROOM);
    await bob.page.getByTestId("input-passphrase").fill(ROOM_KEY);
    await bob.page.getByTestId("button-connect").click();
    await expect.poll(async () => alice.page.getByTestId("status-connection").innerText(), { timeout: 45_000 }).toContain("1 P2P");

    await alice.page.getByTestId("input-message").fill("ahoj z uloženého připojení");
    await alice.page.getByTestId("button-send").click();
    await expect.poll(async () => bob.page.locator('[data-testid^="message-"]').allInnerTexts(), { timeout: 20_000 })
      .toEqual(expect.arrayContaining([expect.stringContaining("ahoj z uloženého připojení")]));

    await openMenuEntry(alice.page, "btn-connections");
    await alice.page.getByTestId("cx-details").click();
    const stats = alice.page.getByTestId("cx-stats");
    await expect.poll(async () => stats.innerText()).toMatch(/1 \/ 0/); // messages sent / received
    await expect.poll(async () => alice.page.getByTestId("cx-log").innerText()).toMatch(/připojeno|connected/i);
    expect(bob.errors).toEqual([]);
  }, 120_000);

  it("keeps only a sealed block on the server", async () => {
    // Statistics wait a few seconds before they travel; editing saves at once.
    await alice.page.keyboard.press("Escape");
    const vault = await alice.page.evaluate(async () => {
      const raw = sessionStorage.getItem("m5cet:account:v1");
      const token = raw ? (JSON.parse(raw) as { token: string }).token : "";
      const res = await fetch("/api/account/vault", { headers: { Authorization: `Bearer ${token}` } });
      return await res.json() as { connections?: { ct: string } | null };
    });
    expect(vault.connections?.ct.length).toBeGreaterThan(50);
    const text = JSON.stringify(vault);
    expect(text).not.toContain(ROOM);
    expect(text).not.toContain(ROOM_KEY);
    expect(text).not.toContain("Tým Brno");
  }, 60_000);

  it("connects the default connection by itself when the page comes back signed in", async () => {
    // Leave on purpose, then reload: the session cache says "disconnected",
    // the saved connection says "connect after sign-in".
    await openMenuEntry(alice.page, "btn-connections");
    await alice.page.getByTestId("cx-disconnect").click();
    await expect.poll(async () => alice.page.getByTestId("status-connection").innerText(), { timeout: 15_000 }).not.toContain(ROOM);
    await alice.page.reload();
    await expect.poll(async () => alice.page.getByTestId("status-connection").innerText(), { timeout: 45_000 }).toContain(ROOM);
  }, 120_000);

  it("the Room window lists them on Server-enhanced; while connected the others wait", async () => {
    const page = alice.page;
    await page.getByTestId("button-brand").click();
    await page.getByTestId("room-dialog").waitFor();
    // A saved connection is in use: the window opens on Server-enhanced, locked.
    expect(await page.getByTestId("room-tab-server").getAttribute("aria-selected")).toBe("true");
    expect(await page.getByTestId("room-tab-light").isDisabled()).toBe(true);
    const first = page.locator('[data-testid="room-item"]', { hasText: "Tým Brno" });
    expect(await first.getAttribute("aria-checked")).toBe("true");
    await first.getByTestId("room-item-live").waitFor();
    // No connect / edit / delete on the rows.
    expect(await first.locator("button").count()).toBe(0);

    // The gear opens My connections above the window; a second one is added there.
    await page.getByTestId("room-manage").click();
    await page.getByTestId("cx-add").click();
    await page.getByTestId("cx-f-label").fill("Druhá");
    await page.getByTestId("cx-f-room").fill(ROOM2);
    await page.getByTestId("cx-f-name").fill("alice");
    await page.getByTestId("cx-f-generate").click();
    await page.getByTestId("cx-f-save").click();
    await page.getByTestId("cx-list").waitFor();
    await page.keyboard.press("Escape"); // only My connections closes
    await page.getByTestId("room-list").waitFor();
    const second = page.locator('[data-testid="room-item"]', { hasText: "Druhá" });
    expect(await second.isDisabled()).toBe(true);

    // Disconnect frees the choice; the second one connects with the same button.
    await page.getByTestId("button-disconnect").click();
    await expect.poll(async () => second.isDisabled()).toBe(false);
    await second.click();
    expect(await second.getAttribute("aria-checked")).toBe("true");
    await page.getByTestId("button-connect").click();
    await expect.poll(async () => page.getByTestId("status-connection").innerText(), { timeout: 45_000 }).toContain(ROOM2);
  }, 120_000);

  it("shares a saved connection: an invitation a guest joins with the code", async () => {
    const page = alice.page;
    await openMenuEntry(page, "btn-connections");
    await page.locator('[data-testid="cx-item"]', { hasText: "Tým Brno" }).getByTestId("cx-share").click();
    const dialog = page.getByTestId("share-connection-dialog");
    await dialog.waitFor();
    await page.getByTestId("sc-uses-2").click();
    await page.getByTestId("sc-guest").fill("host-karel");
    await page.getByTestId("sc-create").click();
    const url = await page.getByTestId("share-url").inputValue();
    const code = (await page.getByTestId("share-code").innerText()).replace(/\D/g, "");
    expect(url).toMatch(/#j=/);
    expect(code).toHaveLength(12);
    // The link and the code carry nothing readable.
    expect(url).not.toContain(ROOM);
    await page.keyboard.press("Escape"); // the share window closes, My connections stays
    await page.getByTestId("cx-list").waitFor();
    await page.keyboard.press("Escape");

    // A guest without an account opens the link and types the code.
    const guest = await tab(false);
    // A fresh load: the app reads an invitation from the address once, at start.
    await guest.page.goto("about:blank");
    await guest.page.goto(url);
    await guest.page.getByTestId("input-invite-code").fill(code);
    await guest.page.getByTestId("button-invite-join").click();
    await expect.poll(async () => guest.page.getByTestId("status-connection").innerText(), { timeout: 45_000 }).toContain(ROOM);
    expect(guest.errors).toEqual([]);
    expect(alice.errors).toEqual([]);
  }, 120_000);
});
