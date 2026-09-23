// Renders docs/site/index.html to docs/site/m5cet-dokumentace-<version>.pdf
// with Playwright's Chromium (print styles: no sidebar, a printed table of
// contents, one chapter per page, page numbers in the footer).
//
//   npm run docs:pdf
//
// Needs Playwright's Chromium (`npx playwright install chromium`).

import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const html = join(root, "docs", "site", "index.html");
const out = join(root, "docs", "site", `m5cet-dokumentace-${version}.pdf`);

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage();
  // Light theme for print, whatever the viewer prefers.
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(pathToFileURL(html).href, { waitUntil: "load" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await page.emulateMedia({ media: "print", colorScheme: "light" });
  await page.pdf({
    path: out,
    format: "A4",
    printBackground: true,
    margin: { top: "16mm", bottom: "18mm", left: "14mm", right: "14mm" },
    displayHeaderFooter: true,
    headerTemplate: `<div style="width:100%;font:8px system-ui,sans-serif;color:#6b7690;padding:0 14mm;display:flex;justify-content:space-between"><span>M5cet ${version} — dokumentace</span><span class="date"></span></div>`,
    footerTemplate: `<div style="width:100%;font:8px system-ui,sans-serif;color:#6b7690;text-align:center">strana <span class="pageNumber"></span> / <span class="totalPages"></span></div>`,
  });
  console.log(`wrote ${out}`);
} finally {
  await browser.close();
}
