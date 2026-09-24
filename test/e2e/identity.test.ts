/**
 * 4.0 in a real browser, against two real servers:
 *
 *   /signup   a new account: the server names it (a unique username), the
 *             passkey stores it, and it is signed in and active at once
 *   /signin   back in with the passkey, in checked steps (passkey known →
 *             global key → database → vault → server, version, settings)
 *   unknown   a passkey another server knows: an error that recommends
 *             registering — and the server's audit says so
 *   gating    Server-enhanced without a sign-in: nothing to connect, only
 *             the way to the Connection window
 *   leaving   connected to a room, back / reload ask to disconnect first
 *   versions  a browser running another build than the server deploys gets
 *             the window with the list and "Fix", which reloads fresh
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

const A = "http://localhost:5961";
const B = "http://localhost:5962";
const ADMIN = randomBytes(24).toString("hex");
const ROOM = `id-${randomBytes(3).toString("hex")}`;
const ROOM_KEY = randomBytes(12).toString("hex");

const servers: ChildProcess[] = [];
const dirs: string[] = [];
let browser: Browser | null = null;
const contexts: BrowserContext[] = [];

async function start(base: string): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "m5cet-e2e-id-"));
  dirs.push(dataDir);
  const port = new URL(base).port;
  servers.push(spawn(process.execPath, ["dist/index.cjs"], {
    env: { ...process.env, NODE_ENV: "production", PORT: port, HOST: "127.0.0.1", DATA_DIR: dataDir, WEBAUTHN_RP_ID: "localhost", WEBAUTHN_ORIGINS: base, ADMIN_API_TOKEN: ADMIN },
    stdio: "ignore",
  }));
  const deadline = Date.now() + 15_000;
  for (;;) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server ${base} did not become healthy`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

beforeAll(async () => {
  if (!existsSync("dist/index.cjs")) throw new Error("dist/index.cjs missing — run `npm run build` first");
  await Promise.all([start(A), start(B)]);
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-features=WebRtcHideLocalIpsWithMdns"] });
}, 60_000);

afterAll(async () => {
  for (const ctx of contexts) await ctx.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  for (const s of servers) s.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 250));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function tab(withPasskey: boolean): Promise<{ page: Page; errors: string[] }> {
  const ctx = await browser!.newContext({ viewport: { width: 1280, height: 900 } });
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
  return { page, errors };
}

async function accountAudit(base: string): Promise<Array<{ event: string; accountId?: string; level: string }>> {
  const r = await fetch(`${base}/api/admin/audit?category=account&limit=200`, { headers: { authorization: `Bearer ${ADMIN}` } });
  return ((await r.json()) as { entries: Array<{ event: string; accountId?: string; level: string }> }).entries;
}

describe("usernames, /signup and /signin", () => {
  let alice: { page: Page; errors: string[] };
  let username = "";

  it("/signup creates the account, names it, and signs it in at once", async () => {
    alice = await tab(true);
    await alice.page.goto(`${A}/signup`);
    await alice.page.getByTestId("signin-done").waitFor({ timeout: 30_000 });
    // The path is scrubbed; the Connection window shows the result.
    expect(new URL(alice.page.url()).pathname).toBe("/");
    username = (await alice.page.getByTestId("account-username").innerText()).trim();
    expect(username).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{4,6}$/);
    expect(await alice.page.getByTestId("signin-done").innerText()).toContain(username);
    expect(await alice.page.locator('[data-testid="signin-steps"] [data-state="fail"]').count()).toBe(0);
    for (const step of ["passkey", "key", "database", "vault", "server", "version", "settings"]) {
      expect(await alice.page.locator(`[data-testid="signin-steps"] [data-step="${step}"]`).getAttribute("data-state")).toMatch(/ok|warn/);
    }
    expect(await alice.page.getByTestId("signed-in-badge").innerText()).toContain(username);
    // Everything is on the operator's audit, under the username.
    const events = await accountAudit(A);
    expect(events.find((e) => e.event === "account.register")?.accountId).toBe(username);
    expect(events.some((e) => e.event === "account.client.signin-complete" && e.accountId === username)).toBe(true);
  }, 120_000);

  it("/signin brings the same account back with the same passkey, key checked", async () => {
    // A new tab of the same browser: no session of its own.
    await alice.page.evaluate(() => sessionStorage.clear());
    await alice.page.goto(`${A}/signin`);
    await alice.page.getByTestId("signin-done").waitFor({ timeout: 30_000 });
    expect((await alice.page.getByTestId("account-username").innerText()).trim()).toBe(username);
    expect(await alice.page.locator('[data-testid="signin-steps"] [data-step="key"]').getAttribute("data-state")).toBe("ok");
    const events = await accountAudit(A);
    expect(events.some((e) => e.event === "account.signin.unlocked" && e.accountId === username)).toBe(true);
    expect(alice.errors).toEqual([]);
  }, 120_000);

  it("a passkey the server does not know: an error that recommends registering, and a log line", async () => {
    await alice.page.goto(`${B}/signin`);
    const error = alice.page.getByTestId("signin-error");
    await error.waitFor({ timeout: 30_000 });
    expect(await error.getAttribute("data-code")).toBe("unknown-passkey");
    expect(await alice.page.getByTestId("signin-error-register").isVisible()).toBe(true);
    expect(await alice.page.getByTestId("signed-in-badge").count()).toBe(0);
    const events = await accountAudit(B);
    expect(events.some((e) => e.event === "account.signin.unknown-passkey" && e.level === "warn")).toBe(true);
  }, 120_000);
});

describe("Server-enhanced needs a passkey sign-in", () => {
  it("signed out: the Server tab has nothing to connect, only the way to sign in", async () => {
    const { page } = await tab(false);
    await page.goto(A);
    await page.getByTestId("button-brand").click();
    await page.getByTestId("room-tab-server").click();
    await page.getByTestId("room-need").waitFor();
    expect(await page.getByTestId("room-manual-fields").count()).toBe(0);
    expect(await page.getByTestId("button-connect").isDisabled()).toBe(true);
    await page.getByTestId("room-need-open").click();
    await page.getByTestId("account-access").waitFor();
    // …where the server's chat history is locked too.
    expect(await page.locator('[data-testid="retention-server"] input').isDisabled()).toBe(true);
  }, 60_000);
});

describe("leaving a connected room", () => {
  it("back and reload ask to disconnect first; after disconnecting nothing asks", async () => {
    const { page } = await tab(false);
    await page.goto(A);
    await page.getByTestId("button-brand").click();
    await page.getByTestId("input-name").fill("carol");
    await page.getByTestId("input-room").fill(ROOM);
    await page.getByTestId("input-passphrase").fill(ROOM_KEY);
    await page.getByTestId("button-connect").click();
    await expect.poll(async () => page.getByTestId("status-connection").innerText(), { timeout: 30_000 }).toContain(ROOM);

    // The Back button (the browser's history) is caught…
    await page.goBack();
    await page.getByTestId("nav-guard").waitFor({ timeout: 10_000 });
    expect(await page.getByTestId("nav-guard-text").innerText()).toBe("Prosím nejprve se odpojte z místnosti.");
    expect(await page.getByTestId("status-connection").innerText()).toContain(ROOM);
    await page.getByTestId("nav-guard-stay").click();

    // …and so are the reload keys.
    await page.keyboard.press("F5");
    await page.getByTestId("nav-guard").waitFor({ timeout: 10_000 });
    await page.getByTestId("nav-guard-disconnect").click();
    await expect.poll(async () => page.getByTestId("status-connection").innerText(), { timeout: 15_000 }).not.toContain(ROOM);
    await page.keyboard.press("F5").catch(() => undefined);
    await page.waitForLoadState("load");
    expect(await page.getByTestId("nav-guard").count()).toBe(0);
  }, 90_000);
});

describe("the version check", () => {
  it("lists what differs from the deploy and fixes it by loading everything fresh", async () => {
    const { page } = await tab(false);
    const real = await (await fetch(`${A}/version-manifest.json`)).json() as { build: string; libraries: Record<string, string> };
    // The server "deploys" another build with another React.
    await page.route("**/version-manifest.json*", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ...real, build: "zz-newer-build", libraries: { ...real.libraries, react: "99.0.0" } }),
    }));
    await page.goto(A);
    await page.evaluate(() => {
      localStorage.setItem("m5cet:probe", "stale");
      const prefs = JSON.parse(localStorage.getItem("m5cet:prefs:v2") ?? "{}") as Record<string, unknown>;
      localStorage.setItem("m5cet:prefs:v2", JSON.stringify({ ...prefs, theme: "nord", themeSet: true, name: "carol" }));
    });
    const modal = page.getByTestId("integrity-modal");
    await modal.waitFor({ timeout: 20_000 });
    const rows = await page.locator('[data-testid="integrity-list"] tbody tr').evaluateAll((trs) => trs.map((tr) => `${tr.getAttribute("data-kind")}:${tr.textContent}`));
    expect(rows.some((r) => r.startsWith("build:") && r.includes("zz-newer-build"))).toBe(true);
    expect(rows.some((r) => r.startsWith("lib:") && r.includes("react") && r.includes("99.0.0"))).toBe(true);

    // The server is right again; "Fix" wipes this app's data and reloads.
    await page.unroute("**/version-manifest.json*");
    expect(await page.getByTestId("integrity-keep").isChecked()).toBe(true);
    await Promise.all([page.waitForURL((u) => !u.searchParams.has("refresh") && u.pathname === "/", { timeout: 30_000 }), page.getByTestId("integrity-fix").click()]);
    await page.waitForLoadState("load");
    await page.waitForTimeout(3500); // past the first check after start
    const after = await page.evaluate(() => ({ probe: localStorage.getItem("m5cet:probe"), prefs: JSON.parse(localStorage.getItem("m5cet:prefs:v2") ?? "{}") as Record<string, unknown> }));
    expect(after.probe).toBeNull();
    // The look stays (the checkbox), the rest is gone — the nickname too
    // (a fresh app picks a default one).
    expect(after.prefs.theme).toBe("nord");
    expect(after.prefs.name).not.toBe("carol");
    expect(await page.getByTestId("integrity-modal").count()).toBe(0);
  }, 90_000);
});
