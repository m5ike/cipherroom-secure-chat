/**
 * Appearance + Edit Mode + mobile layout, in a real Chromium against the
 * production bundle (dist/public), network locked to 127.0.0.1.
 *
 *  - Appearance screen: one place for theme / fonts / colours; nothing is
 *    requested from Google before consent.
 *  - Edit Mode: Ctrl + right mouse button picks an element, the inspector
 *    (open Shadow DOM — Playwright selectors pierce it) edits a rule with a
 *    live preview, Save persists it across a reload.
 *  - Phones: iPhone / Android emulation → data-os / data-form, bottom-sheet
 *    dialogs, a long touch press picks an element without "clicking" it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { chromium, devices, Browser, BrowserContext, Page } from "playwright";

const PORT = 5923;
let server: ChildProcessWithoutNullStreams | null = null;
let browser: Browser | null = null;

beforeAll(async () => {
  server = spawn(process.execPath, [
    "-e",
    `
      const path = require('path');
      const express = require('express');
      const app = express();
      const root = path.resolve(process.cwd(), 'dist', 'public');
      app.use(express.static(root));
      app.use('/{*path}', (_req, res) => res.sendFile(path.join(root, 'index.html')));
      app.listen(${PORT}, '127.0.0.1', () => console.log('READY'));
    `,
  ], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: "production" } });
  await new Promise<void>((resolve) => {
    const onData = (chunk: Buffer) => {
      if (chunk.toString("utf8").includes("READY")) { server?.stdout.off("data", onData); resolve(); }
    };
    server!.stdout.on("data", onData);
    setTimeout(() => resolve(), 10_000);
  });
  // PW_CHANNEL=chrome runs against an installed Chrome instead of Playwright's
  // bundled Chromium (handy locally; CI uses the bundled one).
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}) });
}, 30_000);

afterAll(async () => {
  if (browser) await browser.close();
  if (server) { server.kill("SIGTERM"); await new Promise((r) => setTimeout(r, 250)); }
});

async function makeContext(options: Parameters<Browser["newContext"]>[0] = {}): Promise<{ ctx: BrowserContext; page: Page; outbound: string[] }> {
  if (!browser) throw new Error("browser not initialised");
  const ctx = await browser.newContext({ baseURL: `http://127.0.0.1:${PORT}`, permissions: [], ...options });
  const outbound: string[] = [];
  await ctx.route("**/*", (route, req) => {
    if (!req.url().startsWith(`http://127.0.0.1:${PORT}`)) { outbound.push(req.url()); route.abort(); }
    else route.continue();
  });
  const page = await ctx.newPage();
  return { ctx, page, outbound };
}

async function openAppearance(page: Page) {
  await page.click("[data-testid=btn-menu-speeddial]");
  await page.click("[data-testid=speeddial-btn-appearance]");
  await page.waitForSelector("[data-testid=appearance-panel]");
}

describe("Appearance screen", () => {
  it("theme, fonts and colours live on one screen; no Google request without consent", async () => {
    const { ctx, page, outbound } = await makeContext();
    await page.goto("/");
    await page.waitForSelector("[data-testid=button-brand]");
    await openAppearance(page);

    await page.click("[data-testid=theme-paper]");
    expect(await page.getAttribute("html", "data-theme")).toBe("paper");

    await page.click("[data-testid=ap-tab-type]");
    await page.click("[data-testid=font-ui-toggle]");
    await page.fill("[data-testid=font-ui-search]", "mono");
    expect(await page.locator("[data-testid^=font-opt-g-]").count()).toBeGreaterThanOrEqual(8);
    await page.fill("[data-testid=font-ui-search]", "");
    expect(await page.locator("[data-testid^=font-opt-g-]").count()).toBeGreaterThanOrEqual(40);
    expect(outbound.filter((u) => u.includes("fonts.g"))).toEqual([]);

    await page.click("[data-testid=ap-tab-color]");
    await page.fill("[data-testid=color-accent-hex]", "#12ab34");
    await page.press("[data-testid=color-accent-hex]", "Enter");
    const primary = await page.evaluate(() => document.documentElement.style.getPropertyValue("--primary"));
    expect(primary).toMatch(/^13\d 81% 37%$/); // #12ab34 as HSL components

    await page.reload();
    await page.waitForSelector("[data-testid=button-brand]");
    expect(await page.getAttribute("html", "data-theme")).toBe("paper");
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--primary"))).toBe(primary);
    await ctx.close();
  });
});

describe("Edit Mode", () => {
  it("Ctrl + right click picks an element; an edited rule previews live and survives a reload", async () => {
    const { ctx, page } = await makeContext();
    await page.goto("/");
    await page.waitForSelector("[data-testid=button-brand]");
    await openAppearance(page);
    await page.click("[data-testid=edit-mode-toggle]");
    expect(await page.getAttribute("[data-testid=edit-mode-toggle]", "aria-checked")).toBe("true");
    await page.keyboard.press("Escape");
    await page.waitForSelector("[data-testid=inspector]"); // inside the shadow root

    await page.click("[data-testid=button-open-join]", { button: "right", modifiers: ["Control"] });
    expect(await page.inputValue("[data-testid=ins-selector]")).toBe('[data-testid="button-open-join"]');
    expect(await page.locator("[data-testid=form-join]").count()).toBe(0); // picking is not clicking

    await page.click("[data-testid=ins-raw-toggle]");
    await page.fill("[data-testid=ins-raw]", "background: rgb(255, 0, 128);\nborder-radius: 3px;");
    const live = await page.$eval("[data-testid=button-open-join]", (el) => getComputedStyle(el).backgroundColor);
    expect(live).toBe("rgb(255, 0, 128)");

    await page.click('[data-testid="ins-state-:hover"]');
    await page.fill("[data-testid=ins-raw]", "color: rgb(1, 2, 3);");
    await page.click("[data-testid=ins-save]");

    await page.reload();
    await page.waitForSelector("[data-testid=button-open-join]");
    const after = await page.$eval("[data-testid=button-open-join]", (el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).borderRadius]);
    expect(after).toEqual(["rgb(255, 0, 128)", "3px"]);
    const hoverCss = await page.evaluate(() => document.getElementById("m5-user-styles")?.textContent ?? "");
    expect(hoverCss).toContain('[data-testid="button-open-join"]:hover');

    await page.click("[data-testid=ins-exit]");
    await page.waitForFunction(() => !document.getElementById("m5-inspector-host"));
    await ctx.close();
  });
});

describe("Phones", () => {
  it("iPhone: detected as iOS phone, dialogs are bottom sheets, inputs never trigger zoom", async () => {
    const { ctx, page } = await makeContext({ ...devices["iPhone 13"] });
    await page.goto("/");
    await page.waitForSelector("[data-testid=button-brand]");
    const attrs = await page.evaluate(() => ({ ...document.documentElement.dataset }));
    expect(attrs).toMatchObject({ os: "ios", browser: "safari", engine: "webkit", form: "phone", input: "touch" });
    await openAppearance(page);
    // Measure after the 220 ms slide-in animation, not in the middle of it.
    const sheet = await page.$eval(".modal-shell--center", async (el) => {
      await Promise.all(el.getAnimations().map((a) => a.finished));
      const r = el.getBoundingClientRect();
      return { bottom: Math.round(r.bottom), width: Math.round(r.width), vw: innerWidth, vh: innerHeight };
    });
    expect(sheet.width).toBe(sheet.vw);
    expect(Math.abs(sheet.bottom - sheet.vh)).toBeLessThanOrEqual(1);
    await page.click("[data-testid=ap-tab-color]");
    await page.click("[data-testid=color-mine-toggle]");
    const fontSize = await page.$eval("[data-testid=color-mine-hex]", (el) => getComputedStyle(el).fontSize);
    expect(parseFloat(fontSize)).toBeGreaterThanOrEqual(16);
    await ctx.close();
  });

  it("Android: a long touch press picks the element instead of activating it", async () => {
    const { ctx, page } = await makeContext({ ...devices["Pixel 7"] });
    await page.goto("/");
    await page.waitForSelector("[data-testid=button-brand]");
    expect(await page.getAttribute("html", "data-os")).toBe("android");
    await page.evaluate(() => {
      const prefs = JSON.parse(localStorage.getItem("m5cet:prefs:v2") || "{}");
      localStorage.setItem("m5cet:prefs:v2", JSON.stringify({ ...prefs, editMode: true }));
    });
    await page.reload();
    await page.waitForSelector("[data-testid=inspector]");
    await page.evaluate(async () => {
      const b = document.querySelector("[data-testid=button-open-join]")!;
      const r = b.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, composed: true, pointerType: "touch", pointerId: 3, isPrimary: true, clientX: r.left + 5, clientY: r.top + 5 };
      b.dispatchEvent(new PointerEvent("pointerdown", o));
      await new Promise((res) => setTimeout(res, 700));
      b.dispatchEvent(new PointerEvent("pointerup", o));
      b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(await page.inputValue("[data-testid=ins-selector]")).toBe('[data-testid="button-open-join"]');
    expect(await page.locator("[data-testid=form-join]").count()).toBe(0);
    expect(await page.getAttribute("[data-testid=inspector]", "data-layout")).toBe("sheet");
    await ctx.close();
  });
});
