// Renders docs/security-summary-6.12.html (the ≤ 3-page security summary) to
// docs/security-summary-6.12.pdf with Playwright's Chromium and prints the
// page count — the summary must stay within three A4 pages.
//
//   node scripts/security-summary-pdf.mjs

import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = join(root, "docs", "security-summary-6.12.html");
const out = join(root, "docs", "security-summary-6.12.pdf");

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage();
  await page.emulateMedia({ media: "print", colorScheme: "light" });
  await page.goto(pathToFileURL(html).href, { waitUntil: "load" });
  await page.pdf({
    path: out,
    format: "A4",
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: true,
    headerTemplate: "<span></span>",
    footerTemplate: `<div style="width:100%;font:7px system-ui,sans-serif;color:#6b7690;text-align:center">M5cet 6.12 — bezpečnostní shrnutí · strana <span class="pageNumber"></span> / <span class="totalPages"></span></div>`,
  });
  const pages = (readFileSync(out, "latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  console.log(`wrote ${out} — ${pages} page(s)`);
  if (pages > 3) process.exitCode = 1;
} finally {
  await browser.close();
}
