// Translation sources (6.13): every user-facing string of the web client and
// of the Android app's default design, as { key: { en, cs, de } }, so that a
// translator (person or tool) can produce i18n/locales/<lang>/<file>.json —
// flat { key: text } — for the other languages (docs/i18n.md).
//
//   npx tsx script/i18n-extract.ts      → i18n/source/*.json
//
// English is the source text; Czech and German are given for context (the
// Czech text is the original in most of the code). Keep {placeholders},
// markup and line breaks exactly as in the source.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { dictionary } from "../client/src/lib/i18n";
import { SYSMSG_I18N } from "../client/src/lib/i18n-sysmsg";
import { NFC_FN_STRINGS } from "../client/src/lib/i18n-nfc-fn";
import { DEFAULT_STRINGS } from "../server/android/design";

type Table = Record<string, string>;
type Source = Record<string, { en: string; cs: string; de: string }>;

function source(en: Table, cs: Table, de: Table): Source {
  const out: Source = {};
  for (const key of Object.keys(en).sort()) out[key] = { en: en[key], cs: cs[key] ?? "", de: de[key] ?? "" };
  return out;
}

const root = resolve(import.meta.dirname, "..");
const dir = join(root, "i18n", "source");
mkdirSync(dir, { recursive: true });
const files: Record<string, Source> = {
  "web.json": source(dictionary("en"), dictionary("cs"), dictionary("de")),
  "web-sysmsg.json": source(SYSMSG_I18N.en as Table, SYSMSG_I18N.cs as Table, SYSMSG_I18N.de as Table),
  "web-nfc-fn.json": source(NFC_FN_STRINGS.en, NFC_FN_STRINGS.cs, NFC_FN_STRINGS.de),
  "android.json": source(DEFAULT_STRINGS.en, DEFAULT_STRINGS.cs, DEFAULT_STRINGS.de),
};
for (const [name, data] of Object.entries(files)) {
  writeFileSync(join(dir, name), JSON.stringify(data, null, 1) + "\n");
  console.log(`${name}: ${Object.keys(data).length} keys`);
}
