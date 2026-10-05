// Checks a translation against its sources (6.13):
//
//   npx tsx script/i18n-check.ts <lang> [file...]     (default: every i18n/source/*.json)
//
// For i18n/locales/<lang>/<file>.json: every source key present and no extra
// keys; no empty text where the English one is not empty; the same
// {placeholders}, $variables, %s/%d, <tags> and \n count as English; the file
// is valid UTF-8 JSON. Exit 1 with a list of problems, 0 when clean.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const lang = process.argv[2];
if (!lang || !/^[a-z]{2}$/.test(lang)) { console.error("usage: npx tsx script/i18n-check.ts <lang> [file...]"); process.exit(2); }
const files = process.argv.slice(3).length ? process.argv.slice(3) : readdirSync(join(root, "i18n", "source")).filter((f) => f.endsWith(".json"));

const tokens = (s: string): string[] => [
  ...(s.match(/\{[^{}\s]+\}/g) ?? []),
  ...(s.match(/\$[A-Za-z_][\w.]*/g) ?? []),
  ...(s.match(/%[sd]/g) ?? []),
  ...(s.match(/<\/?[a-z][a-z0-9]*\b[^>]*>/gi) ?? []).map((t) => t.replace(/\s.*>$/, ">")),
  ...Array((s.match(/\n/g) ?? []).length).fill("\\n"),
].sort();

let problems = 0;
for (const file of files) {
  const src = JSON.parse(readFileSync(join(root, "i18n", "source", file), "utf8")) as Record<string, { en: string }>;
  const path = join(root, "i18n", "locales", lang, file);
  if (!existsSync(path)) { console.log(`${file}: missing ${path}`); problems++; continue; }
  const raw = readFileSync(path);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  const out = JSON.parse(text) as Record<string, unknown>;
  for (const key of Object.keys(src)) {
    const en = src[key].en;
    const v = out[key];
    if (typeof v !== "string") { console.log(`${file}: ${key}: missing`); problems++; continue; }
    if (en.trim() && !v.trim()) { console.log(`${file}: ${key}: empty`); problems++; continue; }
    const a = tokens(en).join(" "), b = tokens(v).join(" ");
    if (a !== b) { console.log(`${file}: ${key}: tokens differ\n  en: ${a}\n  ${lang}: ${b}`); problems++; }
  }
  for (const key of Object.keys(out)) if (!(key in src)) { console.log(`${file}: ${key}: not in the source`); problems++; }
  const keys = Object.keys(src).length;
  console.log(`${file}: ${keys} keys checked`);
}
console.log(problems ? `${problems} problem(s)` : "clean");
process.exit(problems ? 1 : 0);
