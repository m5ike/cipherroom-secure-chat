/**
 * Two browsers that cannot reach each other directly — a strict NAT with no
 * TURN server, simulated by allowing only relay ICE candidates with no relay
 * configured — still exchange a file: the chunks travel sealed through the
 * server (proxy transport), as binary frames, paced to stay inside the
 * relay's rate limits.
 *
 * Needs the production build (`npm run build`) and Playwright's Chromium.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const PORT = 5925;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOM = `e2e-relay-${randomBytes(4).toString("hex")}`;
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
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
}, 60_000);

afterAll(async () => {
  for (const ctx of contexts) await ctx.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  server?.kill("SIGTERM");
});

async function joinRoom(name: string): Promise<{ page: Page; errors: string[]; ws: { sentBinary: number; gotBinary: number } }> {
  if (!browser) throw new Error("browser not initialised");
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 800 } });
  contexts.push(ctx);
  await ctx.addInitScript(() => {
    try {
      const raw = localStorage.getItem("m5cet:prefs:v2");
      const prefs = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      localStorage.setItem("m5cet:prefs:v2", JSON.stringify({ ...prefs, showSystemInChat: true }));
    } catch { /* private mode */ }
    // Relay candidates only, and no relay: ICE can never connect.
    const Native = window.RTCPeerConnection;
    const Blocked = function (config?: RTCConfiguration) {
      return new Native({ ...(config ?? {}), iceServers: [], iceTransportPolicy: "relay" });
    } as unknown as typeof RTCPeerConnection;
    Blocked.prototype = Native.prototype;
    Object.defineProperty(Blocked, "generateCertificate", { value: Native.generateCertificate.bind(Native) });
    window.RTCPeerConnection = Blocked;
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  const ws = { sentBinary: 0, gotBinary: 0 };
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("websocket", (socket) => {
    socket.on("framesent", (f) => { if (typeof f.payload !== "string") ws.sentBinary += 1; });
    socket.on("framereceived", (f) => { if (typeof f.payload !== "string") ws.gotBinary += 1; });
  });
  await page.goto("/");
  await page.getByTestId("button-brand").click();
  await page.getByTestId("input-name").fill(name);
  await page.getByTestId("input-room").fill(ROOM);
  await page.getByTestId("input-passphrase").fill(ROOM_KEY);
  await page.getByTestId("button-connect").click();
  return { page, errors, ws };
}

async function sha256OfDownload(page: Page, fileName: string): Promise<{ size: number; sha256: string }> {
  const link = page.locator(`a[download="${fileName}"]`).first();
  await link.waitFor({ state: "attached", timeout: 90_000 });
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 30_000 }), link.click()]);
  const body = await readFile(await download.path());
  return { size: body.byteLength, sha256: createHash("sha256").update(body).digest("hex") };
}

describe("a file between peers without a direct connection", () => {
  it("goes through the encrypted server relay as binary chunks and arrives intact", async () => {
    const alice = await joinRoom("alice");
    const bob = await joinRoom("bob");
    // Both know of each other through the server, but no data channel opens.
    await alice.page.locator('[data-testid^="recip-peer-"]').first().waitFor({ state: "attached", timeout: 30_000 });
    await bob.page.locator('[data-testid^="recip-peer-"]').first().waitFor({ state: "attached", timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 3_000));
    expect(await alice.page.getByTestId("status-connection").innerText()).toContain("0 P2P");

    // ~6 MB: the relay budget is 2 MiB/s with an 8 MiB burst, so an
    // unpaced sender would be refused and kicked.
    const body = randomBytes(6 * 1024 * 1024);
    await alice.page.getByTestId("input-file").setInputFiles({ name: "relayed.bin", mimeType: "application/octet-stream", buffer: body });

    const got = await sha256OfDownload(bob.page, "relayed.bin");
    expect(got.size).toBe(body.byteLength);
    expect(got.sha256).toBe(createHash("sha256").update(body).digest("hex"));

    // Every chunk went up and came down as a binary frame (~190 of them).
    expect(alice.ws.sentBinary).toBeGreaterThan(150);
    expect(bob.ws.gotBinary).toBeGreaterThan(150);
    const said = (await bob.page.locator('[data-testid^="message-"]').allInnerTexts()).join(" ");
    expect(said).not.toMatch(/Missing chunks|rate/i);
    expect(alice.errors).toEqual([]);
    expect(bob.errors).toEqual([]);
  }, 180_000);
});
