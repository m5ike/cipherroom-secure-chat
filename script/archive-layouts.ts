// Keeps server/layout-archive.json: every default layout tree the app has
// shipped, by its revision (a fingerprint of the tree). When an update
// changes a default, the server finds the tree an operator's layout was
// designed from here and merges their changes into the new default
// (3-way, client/src/lib/layout-merge.ts).
//
//   npx tsx script/archive-layouts.ts     (test/layout-merge.test.ts fails
//                                          when a current default is missing)

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_LAYOUTS, DEFAULT_LAYOUT_REVS, LAYOUT_IDS } from "../client/src/lib/layouts";

const file = resolve(import.meta.dirname, "..", "server", "layout-archive.json");
const version = (JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string }).version;
let archive: Record<string, { layout: string; version: string; tree: unknown }> = {};
try { archive = JSON.parse(readFileSync(file, "utf8")); } catch { /* a new archive */ }
let added = 0;
for (const id of LAYOUT_IDS) {
  const rev = DEFAULT_LAYOUT_REVS[id];
  if (archive[rev]) continue;
  archive[rev] = { layout: id, version, tree: DEFAULT_LAYOUTS[id] };
  added++;
}
const sorted = Object.fromEntries(Object.entries(archive).sort(([, a], [, b]) => a.layout.localeCompare(b.layout) || a.version.localeCompare(b.version, undefined, { numeric: true })));
writeFileSync(file, `${JSON.stringify(sorted)}\n`);
console.log(`layout archive: ${Object.keys(sorted).length} trees (${added} added) → ${file}`);
