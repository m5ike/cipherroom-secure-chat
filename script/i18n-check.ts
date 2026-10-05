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

// 6.13: plural forms ("key#one", "key#few"…, web-extra.json): a language has the
// forms its plural rules use (Intl.PluralRules) — extra forms are fine, a
// source form is satisfied by the same form or by the plain key, and every
// form keeps the tokens of English ("key#other" when English has no such form).
const FORM = /#(zero|one|two|few|many|other)$/;
const base = (key: string) => key.replace(FORM, "");
const categories = (() => { try { return new Set<string>(new Intl.PluralRules(lang).resolvedOptions().pluralCategories); } catch { return new Set(["one", "other"]); } })();

let problems = 0;
for (const file of files) {
  const src = JSON.parse(readFileSync(join(root, "i18n", "source", file), "utf8")) as Record<string, { en: string }>;
  const path = join(root, "i18n", "locales", lang, file);
  if (!existsSync(path)) { console.log(`${file}: missing ${path}`); problems++; continue; }
  const raw = readFileSync(path);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  const out = JSON.parse(text) as Record<string, unknown>;
  const bases = new Set(Object.keys(src).map(base));
  const enOf = (key: string): string | undefined => src[key]?.en ?? src[`${base(key)}#other`]?.en ?? src[base(key)]?.en;
  for (const key of Object.keys(src)) {
    const form = FORM.exec(key)?.[1];
    if (form && typeof out[key] !== "string" && (!categories.has(form) || typeof out[base(key)] === "string")) continue;
    const en = src[key].en;
    const v = out[key];
    if (typeof v !== "string") { console.log(`${file}: ${key}: missing`); problems++; continue; }
    if (en.trim() && !v.trim()) { console.log(`${file}: ${key}: empty`); problems++; continue; }
    const a = tokens(en).join(" "), b = tokens(v).join(" ");
    if (a !== b) { console.log(`${file}: ${key}: tokens differ\n  en: ${a}\n  ${lang}: ${b}`); problems++; }
  }
  for (const key of Object.keys(out)) {
    if (key in src) continue;
    const form = FORM.exec(key)?.[1];
    if (!form || !bases.has(base(key))) { console.log(`${file}: ${key}: not in the source`); problems++; continue; }
    if (!categories.has(form)) { console.log(`${file}: ${key}: ${lang} has no plural form "${form}"`); problems++; continue; }
    const v = out[key];
    if (typeof v !== "string" || !v.trim()) { console.log(`${file}: ${key}: empty`); problems++; continue; }
    const a = tokens(enOf(key) ?? "").join(" "), b = tokens(v).join(" ");
    if (a !== b) { console.log(`${file}: ${key}: tokens differ\n  en: ${a}\n  ${lang}: ${b}`); problems++; }
  }
  const keys = Object.keys(src).length;
  console.log(`${file}: ${keys} keys checked`);
}
console.log(problems ? `${problems} problem(s)` : "clean");
process.exit(problems ? 1 : 0);
