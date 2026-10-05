// Writes what the Android app carries from the server's side (6.0), so the
// two never drift apart:
//   android/app/src/main/assets/m5/default-design.json   the design before any bundle
//   android/app/src/main/assets/m5/icons.json            the lucide icons (as in the builders)
//   android/app/src/main/assets/m5/themes.json           the templates (Settings › Appearance)
//   android/app/src/test/resources/cz/m5cet/app/core/locales-vectors.json
//                                                        6.13: the languages' contract and plural
//                                                        rules the JVM tests check Java against
// test/android-assets.test.ts and test/i18n-android-locales.test.ts fail when these are stale.
//
//   npx tsx script/android-assets.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { androidAssets, androidTestVectors } from "../server/android/assets";

const android = resolve(import.meta.dirname, "..", "android", "app", "src");
const targets: Array<[string, Record<string, string>]> = [
  [resolve(android, "main", "assets", "m5"), androidAssets()],
  [resolve(android, "test", "resources", "cz", "m5cet", "app", "core"), androidTestVectors()],
];
for (const [dir, files] of targets) {
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(resolve(dir, name), content);
    console.log(`android asset: ${name} (${Buffer.byteLength(content)} B)`);
  }
}
