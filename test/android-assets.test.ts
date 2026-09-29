// @vitest-environment node
// The Android app's built-in design and icons are generated from the
// server's (script/android-assets.ts): stale copies would make a fresh app
// look different from what the console shows.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { androidAssets } from "../server/android/assets";

describe("android assets", () => {
  for (const [name, content] of Object.entries(androidAssets())) {
    it(`${name} is up to date (npx tsx script/android-assets.ts)`, () => {
      expect(readFileSync(join(__dirname, "..", "android", "app", "src", "main", "assets", "m5", name), "utf8")).toBe(content);
    });
  }
});
