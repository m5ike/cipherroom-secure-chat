// Writes what the Android app carries from the server's side (6.0), so the
// two never drift apart:
//   android/app/src/main/assets/m5/default-design.json   the design before any bundle
//   android/app/src/main/assets/m5/icons.json            the lucide icons (as in the builders)
// test/android-assets.test.ts fails when these are stale.
//
//   npx tsx script/android-assets.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { androidAssets } from "../server/android/assets";

const dir = resolve(import.meta.dirname, "..", "android", "app", "src", "main", "assets", "m5");
mkdirSync(dir, { recursive: true });
for (const [name, content] of Object.entries(androidAssets())) {
  writeFileSync(resolve(dir, name), content);
  console.log(`android asset: ${name} (${content.length} B)`);
}
