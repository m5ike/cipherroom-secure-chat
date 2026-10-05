/**
 * 6.13: the nine languages in a real browser, against the production build
 * (dist/public): the first visit speaks the browser's language and downloads
 * only that language's chunk; the start screen's picker switches the language
 * without a reload (<html lang> follows); the choice survives a reload.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";

const PORT = 5931;
const BASE = `http://127.0.0.1:${PORT}`;
let server: ChildProcessWithoutNullStreams | null = null;
let browser: Browser | null = null;

beforeAll(async () => {
  if (!existsSync("dist/public/index.html")) throw new Error("dist/public missing — run `npm run build` first");
  server = spawn(process.execPath, ["-e", `
    const path = require('path');
    const express = require('express');
    const app = express();
    const root = path.resolve(process.cwd(), 'dist', 'public');
    app.use(express.static(root));
    app.use('/{*path}', (_req, res) => res.sendFile(path.join(root, 'index.html')));
    app.listen(${PORT}, '127.0.0.1', () => console.log('READY'));
  `], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: "production" } });
  await new Promise<void>((resolve) => {
    server!.stdout.on("data", (c: Buffer) => { if (c.toString().includes("READY")) resolve(); });
    setTimeout(resolve, 10_000);
  });
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}) });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  server?.kill("SIGTERM");
});

const LAZY = ["es", "it", "fr", "sk", "sl", "fi"];
const chunkOf = (url: string) => LAZY.find((l) => new RegExp(`/assets/${l}\\.[\\w-]+\\.js$`).test(url));

describe("languages in the browser", () => {
  it("a Slovak browser gets Slovak (only its chunk), switches to Finnish without a reload, and keeps it", async () => {
    const ctx = await browser!.newContext({ baseURL: BASE, locale: "sk-SK" });
    await ctx.route("**/*", (route, req) => (req.url().startsWith(BASE) ? route.continue() : route.abort()));
    const page = await ctx.newPage();
    const chunks: string[] = [];
    page.on("request", (req) => { const l = chunkOf(req.url()); if (l) chunks.push(l); });

    await page.goto("/");
    await page.getByTestId("button-open-join").waitFor();
    expect(await page.getAttribute("html", "lang")).toBe("sk-SK");
    expect(await page.getByTestId("button-open-join").innerText()).toContain("Pripojiť");
    expect(chunks).toEqual(["sk"]);
    const picker = page.getByTestId("start-language");
    expect(await picker.inputValue()).toBe("sk");
    expect(await picker.locator("option").allInnerTexts()).toEqual(["English", "Čeština", "Deutsch", "Español", "Italiano", "Français", "Slovenčina", "Slovenščina", "Suomi"]);

    // At runtime: the Finnish chunk arrives, the screen switches, nothing reloads.
    await page.evaluate(() => { (window as unknown as { __stay: number }).__stay = 42; });
    await picker.selectOption("fi");
    await expect.poll(() => page.getByTestId("button-open-join").innerText()).toContain("Yhdistä");
    expect(await page.getAttribute("html", "lang")).toBe("fi-FI");
    expect(await page.evaluate(() => (window as unknown as { __stay?: number }).__stay)).toBe(42);
    expect(chunks).toEqual(["sk", "fi"]);

    // The choice is the user's now — a reload keeps Finnish although the browser says Slovak.
    await page.reload();
    await page.getByTestId("button-open-join").waitFor();
    expect(await page.getByTestId("button-open-join").innerText()).toContain("Yhdistä");
    expect(await page.getAttribute("html", "lang")).toBe("fi-FI");
    await ctx.close();
  }, 60_000);

  it("a browser in a language M5cet does not speak gets English and no language chunk", async () => {
    const ctx = await browser!.newContext({ baseURL: BASE, locale: "pt-BR" });
    await ctx.route("**/*", (route, req) => (req.url().startsWith(BASE) ? route.continue() : route.abort()));
    const page = await ctx.newPage();
    const chunks: string[] = [];
    page.on("request", (req) => { const l = chunkOf(req.url()); if (l) chunks.push(l); });
    await page.goto("/");
    await page.getByTestId("button-open-join").waitFor();
    expect(await page.getAttribute("html", "lang")).toBe("en-GB");
    expect(await page.getByTestId("button-open-join").innerText()).toContain("Connect");
    expect(chunks).toEqual([]);
    await ctx.close();
  }, 60_000);
});
