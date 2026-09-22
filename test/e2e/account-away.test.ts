/**
 * The signed-in user, end to end, in a real Chromium against the real server.
 *
 *   - register a passkey account (CDP virtual authenticator with PRF),
 *   - the badge appears and the account window shows what the server holds,
 *   - the conversation is sealed into the vault and comes back after a
 *     reload — /signin walks straight back in without a new ceremony,
 *   - while the signed-in user is gone the server takes a message for them
 *     (away relay) and hands it over when they return, and the sender's
 *     message turns "delivered".
 *
 * Needs the production build (`npm run build`) and Playwright's Chromium.
 * Run with `npm run test:e2e`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright";

const PORT = 5931;
// WebAuthn needs a domain, not an IP: "127.0.0.1" is not a valid rpId, while
// http://localhost counts as a secure context. The server still binds to the
// loopback interface only.
const BASE = `http://localhost:${PORT}`;
const ROOM = `acc-${randomBytes(3).toString("hex")}`;
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
  dataDir = mkdtempSync(join(tmpdir(), "m5cet-e2e-accounts-"));
  server = spawn(process.execPath, ["dist/index.cjs"], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(PORT),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      WEBAUTHN_RP_ID: "localhost",
      WEBAUTHN_ORIGINS: BASE,
    },
    stdio: "ignore",
  });
  await waitForHealth(15_000);
  // PW_CHANNEL=chrome runs against an installed Chrome instead of
  // Playwright's bundled Chromium (handy locally; CI uses the bundled one).
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

/** A browser tab with a virtual passkey that supports the PRF extension. */
async function newTab(): Promise<{ page: Page; cdp: CDPSession; authenticatorId: string }> {
  if (!browser) throw new Error("browser not initialised");
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 900 } });
  contexts.push(ctx);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      hasPrf: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { page, cdp, authenticatorId };
}

async function joinRoom(page: Page, name: string): Promise<void> {
  await page.getByTestId("button-brand").click();
  await page.getByTestId("input-name").fill(name);
  await page.getByTestId("input-room").fill(ROOM);
  await page.getByTestId("input-passphrase").fill(ROOM_KEY);
  await page.getByTestId("button-connect").click();
  await expect.poll(async () => page.getByTestId("status-connection").innerText(), { timeout: 30_000 }).toContain(ROOM);
}

/** Opens Connection (where the chat-data choice lives). The default menu is
 *  the speed dial, so the entry sits behind its button. */
async function openConnection(page: Page): Promise<void> {
  const dial = page.getByTestId("btn-menu-speeddial");
  const inDial = await dial.isVisible().catch(() => false);
  if (inDial) await dial.click();
  // The speed dial prefixes its entries: btn-connection → speeddial-btn-connection.
  const entry = page.getByTestId(inDial ? "speeddial-btn-connection" : "btn-connection");
  await entry.waitFor({ state: "visible", timeout: 10_000 });
  await entry.click();
  await page.getByTestId("retention-section").waitFor({ state: "visible", timeout: 10_000 });
}

describe("passkey account and the away relay", () => {
  let alice: { page: Page; cdp: CDPSession; authenticatorId: string };
  let bob: { page: Page; cdp: CDPSession; authenticatorId: string };

  it("registers an account with a passkey and shows the signed-in badge", async () => {
    alice = await newTab();
    await alice.page.goto("/");
    await joinRoom(alice.page, "alice");
    await openConnection(alice.page);

    await alice.page.getByTestId("account-register").click();
    await alice.page.getByTestId("signed-in-badge").waitFor({ state: "visible", timeout: 20_000 });
    expect(await alice.page.getByTestId("signed-in-badge").innerText()).toMatch(/alice/i);

    // The server-side option is now selectable, and it is the one in use.
    const serverChecked = await alice.page.locator('[data-testid="retention-server"] input').isChecked();
    expect(serverChecked).toBe(true);
  }, 120_000);

  it("the account window reports what the server holds", async () => {
    await alice.page.keyboard.press("Escape");
    await alice.page.getByTestId("signed-in-badge").click();
    const panel = alice.page.getByTestId("account-info");
    await panel.waitFor({ state: "visible", timeout: 10_000 });
    const text = await panel.innerText();
    expect(text).toMatch(/ES256|Ed25519|RS256/);
    // The activity log is the server's own record of this account.
    const audit = await alice.page.getByTestId("account-audit").innerText();
    expect(audit.toLowerCase()).toMatch(/účet vytvořen|account created|přihlášení|sign-in/);
    await alice.page.keyboard.press("Escape");
  }, 60_000);

  it("seals the conversation into the vault instead of handing it to the server", async () => {
    // A second participant, so a message can actually travel.
    bob = await newTab();
    await bob.page.goto("/");
    await joinRoom(bob.page, "bob");
    await expect.poll(async () => alice.page.getByTestId("status-connection").innerText(), { timeout: 45_000 }).toContain("1 P2P");

    await alice.page.getByTestId("input-message").fill("poznámka do trezoru");
    await alice.page.getByTestId("button-send").click();
    await expect.poll(async () => bob.page.locator('[data-testid^="message-"]').allInnerTexts(), { timeout: 20_000 })
      .toEqual(expect.arrayContaining([expect.stringContaining("poznámka do trezoru")]));

    await alice.page.getByTestId("signed-in-badge").click();
    await alice.page.getByTestId("account-save").click();
    await expect.poll(
      async () => alice.page.getByTestId("account-info").innerText(),
      { timeout: 20_000 },
    ).toMatch(/Zpráv\s*\n?\s*[1-9]/);

    // What the server keeps is ciphertext: the sentence is not in it.
    const vault = await alice.page.evaluate(async () => {
      const raw = sessionStorage.getItem("m5cet:account:v1");
      const token = raw ? (JSON.parse(raw) as { token: string }).token : "";
      const res = await fetch("/api/account/vault", { headers: { Authorization: `Bearer ${token}` } });
      return await res.text();
    });
    expect(vault).not.toContain("poznámka do trezoru");
    expect(vault.length).toBeGreaterThan(100);
    await alice.page.keyboard.press("Escape");
  }, 180_000);

  it("holds a message while the signed-in user is away, then delivers it", async () => {
    await expect.poll(async () => bob.page.getByTestId("recip-widget").innerText(), { timeout: 30_000 }).toContain("alice");

    // Alice's tab goes away; the server stays in the room for her.
    await alice.page.goto("about:blank");
    await expect.poll(async () => bob.page.getByTestId("recip-widget").innerText(), { timeout: 30_000 }).toMatch(/away/i);

    await bob.page.getByTestId("input-message").fill("zpráva pro nepřítomnou Alici");
    await bob.page.getByTestId("button-send").click();
    // The server answered on her behalf.
    await expect.poll(async () => bob.page.locator('[data-testid^="message-"]').allInnerTexts(), { timeout: 20_000 })
      .toEqual(expect.arrayContaining([expect.stringMatching(/podržel zprávu|holding your message/i)]));

    // She comes back the way the push notification points: /signin. The
    // vault (her own history) and the mailbox both come back with her.
    await alice.page.goto("/signin");
    await alice.page.getByTestId("signed-in-badge").waitFor({ state: "visible", timeout: 30_000 });
    expect(new URL(alice.page.url()).pathname).toBe("/");
    await joinRoom(alice.page, "alice");
    await expect.poll(async () => alice.page.locator('[data-testid^="message-"]').allInnerTexts(), { timeout: 30_000 })
      .toEqual(expect.arrayContaining([
        expect.stringContaining("zpráva pro nepřítomnou Alici"),
        expect.stringContaining("poznámka do trezoru"),
      ]));

    // …and Bob's copy is marked delivered.
    await expect.poll(
      async () => (await bob.page.locator('[data-testid="msg-delivery"]').last().getAttribute("class")) ?? "",
      { timeout: 30_000 },
    ).toMatch(/is-(delivered|read)/);
  }, 240_000);
});
