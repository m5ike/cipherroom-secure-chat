// Writes what the iOS app carries from the server's side (6.14), as
// script/android-assets.ts does for Android, so the two never drift apart:
//   ios/Design/m5/default-design.json   the iOS default design (server/ios/design.ts:
//                                       Android's with the iOS look and the iOS-only items)
//   ios/Design/m5/icons.json            the lucide icons (the same as Android's)
//   ios/Design/m5/themes.json           the templates, the iOS look first (Settings › Appearance)
// The Xcode build phase "Copy design assets" copies them into M5cet.app/m5/ (not
// ios/M5cet/: a synchronized folder would copy the JSON flat into the bundle's root).
// test/ios-assets.test.ts fails when these are stale.
//
//   npx tsx script/ios-assets.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { iosAssets } from "../server/ios/assets";

const dir = resolve(import.meta.dirname, "..", "ios", "Design", "m5");
mkdirSync(dir, { recursive: true });
for (const [name, content] of Object.entries(iosAssets())) {
  writeFileSync(resolve(dir, name), content);
  console.log(`ios asset: ${name} (${Buffer.byteLength(content)} B)`);
}
