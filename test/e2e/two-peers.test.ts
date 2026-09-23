/**
 * Two real browsers, one room, the real server.
 *
 * This is the only test that exercises App.tsx end to end: signaling over
 * /ws, the WebRTC mesh, key derivation, the encrypted envelope, and both
 * attachment paths of the composer:
 *
 *   - small file  -> embedded in the chat envelope (<= 512 KiB)
 *   - large file  -> automatically switched to the chunked encrypted transfer
 *
 * The large-file case is a regression test for two bugs that shipped
 * together: the composer rejected anything over 512 kB ("File exceeds inline
 * cap … use chunked transfer") instead of using the chunked path, and the
 * chunked sender called React hooks inside an async handler, which threw as
 * soon as the transfer finished.
 *
 * Needs the production build (`npm run build`) and Playwright's Chromium
 * (`npx playwright install chromium`, or the mcr.microsoft.com/playwright
 * image). Run with `npm run test:e2e`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const PORT = 5918;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOM = `e2e-${randomBytes(4).toString("hex")}`;
// A throwaway value generated for this run; it never leaves the test browsers.
const ROOM_KEY = randomBytes(12).toString("hex");

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
  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      // Host ICE candidates as plain IPs: mDNS names do not resolve inside
      // containers / CI, and both peers live on this machine anyway.
      "--disable-features=WebRtcHideLocalIpsWithMdns",
    ],
  });
}, 60_000);

afterAll(async () => {
  for (const ctx of contexts) await ctx.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  server?.kill("SIGTERM");
});

async function joinRoom(name: string): Promise<{ page: Page; errors: string[] }> {
  if (!browser) throw new Error("browser not initialised");
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 800 } });
  contexts.push(ctx);
  // System notices flash at the top by default (2.11.0); this test is
  // about what the app *says*, so ask for them in the conversation too.
  await ctx.addInitScript(() => {
    try {
      const raw = localStorage.getItem("m5cet:prefs:v2");
      const prefs = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      localStorage.setItem("m5cet:prefs:v2", JSON.stringify({ ...prefs, showSystemInChat: true }));
    } catch { /* private mode */ }
  });

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

// Saves the received attachment the way a user would (clicking the link) and
// hashes it in Node. fetch() on the blob:/data: href is not an option: the
// app's CSP connect-src rightly does not allow those schemes.
async function sha256OfDownload(page: Page, fileName: string): Promise<{ size: number; sha256: string }> {
  const link = page.locator(`a[download="${fileName}"]`).first();
  await link.waitFor({ state: "attached", timeout: 60_000 });
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 30_000 }), link.click()]);
  const path = await download.path();
  const body = await readFile(path);
  return { size: body.byteLength, sha256: createHash("sha256").update(body).digest("hex") };
}

describe("two peers in one room", () => {
  let alice: { page: Page; errors: string[] };
  let bob: { page: Page; errors: string[] };

  it("connects peer to peer", async () => {
    alice = await joinRoom("alice");
    bob = await joinRoom("bob");
    // The header pill reads "<n> P2P · <room>" once a DataChannel is open.
    await expect.poll(async () => alice.page.getByTestId("status-connection").innerText(), { timeout: 45_000 }).toContain("1 P2P");
    await expect.poll(async () => bob.page.getByTestId("status-connection").innerText(), { timeout: 45_000 }).toContain("1 P2P");
  }, 120_000);

  it("delivers an encrypted text message, UTF-8 intact", async () => {
    const text = "ahoj Bobe — příliš žluťoučký kůň 🔐";
    await alice.page.getByTestId("input-message").fill(text);
    await alice.page.getByTestId("button-send").click();
    await expect.poll(async () => bob.page.locator('[data-testid^="message-"]').allInnerTexts(), { timeout: 20_000 })
      .toEqual(expect.arrayContaining([expect.stringContaining(text)]));
    // 3.1: a live room message goes with Alice's sender key (forward
    // secret), not with the room key.
    const received = bob.page.locator('[data-testid^="message-"]', { hasText: "žluťoučký" }).first();
    expect(await received.getAttribute("data-sealed")).toBe("sender-key");
    expect(await alice.page.locator('[data-testid^="message-"]', { hasText: "žluťoučký" }).first().getAttribute("data-sealed")).toBe("sender-key");
  }, 60_000);

  it("only ever links safe schemes in a received message", async () => {
    await alice.page.getByTestId("input-message").fill("javascript:alert(1) and https://ok.example/path");
    await alice.page.getByTestId("button-send").click();
    const bubble = bob.page.locator('[data-testid^="message-"]', { hasText: "ok.example" }).first();
    await bubble.waitFor({ timeout: 20_000 });
    const hrefs = await bubble.locator("a").evaluateAll((els) => els.map((a) => a.getAttribute("href")));
    expect(hrefs).toEqual(["https://ok.example/path"]);
  }, 60_000);

  it("sends a small file inline through the composer", async () => {
    const body = Buffer.from("small attachment ".repeat(500)); // ~8.5 kB
    await alice.page.getByTestId("input-file").setInputFiles({ name: "small.txt", mimeType: "text/plain", buffer: body });
    const got = await sha256OfDownload(bob.page, "small.txt");
    expect(got.size).toBe(body.byteLength);
    expect(got.sha256).toBe(createHash("sha256").update(body).digest("hex"));
  }, 90_000);

  it("switches a large file to the chunked transfer automatically and delivers it intact", async () => {
    const body = randomBytes(1_500_000); // well over the 512 KiB inline cap, ~46 chunks
    await alice.page.getByTestId("input-file").setInputFiles({ name: "big.bin", mimeType: "application/octet-stream", buffer: body });

    const got = await sha256OfDownload(bob.page, "big.bin");
    expect(got.size).toBe(body.byteLength);
    expect(got.sha256).toBe(createHash("sha256").update(body).digest("hex"));

    // The old behaviour: a notice instead of a transfer.
    const notice = await alice.page.getByTestId("text-notice").innerText().catch(() => "");
    expect(notice).not.toMatch(/exceeds inline cap/i);

    // The sender must reach its "completed" bookkeeping without throwing
    // (it used to die on a hook call right after the last chunk).
    await expect.poll(async () => alice.page.locator('[data-testid^="message-"]').allInnerTexts(), { timeout: 20_000 })
      .toEqual(expect.arrayContaining([expect.stringMatching(/Odesláno: big\.bin/)]));
  }, 120_000);

  // Regression: "File transfer failed: Missing chunks at end-of-transfer."
  // A big file arrives as a long burst of frames — enough to expose both the
  // receiver's frame ordering and the sender's backpressure handling, which
  // used to lose chunks silently until the end frame complained.
  it("delivers a 10 MB file without losing a chunk", async () => {
    const body = randomBytes(10 * 1024 * 1024); // ~320 chunks
    await alice.page.getByTestId("input-file").setInputFiles({ name: "burst.bin", mimeType: "application/octet-stream", buffer: body });

    const got = await sha256OfDownload(bob.page, "burst.bin");
    expect(got.size).toBe(body.byteLength);
    expect(got.sha256).toBe(createHash("sha256").update(body).digest("hex"));

    const notices = await bob.page.locator('[data-testid^="message-"]').allInnerTexts();
    expect(notices.join(" ")).not.toMatch(/Missing chunks/i);
  }, 180_000);

  it("raised no uncaught page errors on either side", () => {
    expect(alice.errors).toEqual([]);
    expect(bob.errors).toEqual([]);
  });
});
