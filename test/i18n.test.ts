// Every string exists in every language, with the same placeholders — a
// key missing in one language falls back to English (or shows the key).

import { describe, it, expect } from "vitest";
import { dictionary, tf, type Lang } from "../client/src/lib/i18n";

const LANGS: Lang[] = ["cs", "en", "de"];
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("translations", () => {
  it("have the same keys in every language", () => {
    const all = new Set(LANGS.flatMap((l) => Object.keys(dictionary(l))));
    const missing: string[] = [];
    for (const l of LANGS) for (const key of all) if (!(key in dictionary(l))) missing.push(`${l}: ${key}`);
    expect(missing).toEqual([]);
  });

  it("use the same placeholders in every language", () => {
    const wrong: string[] = [];
    for (const key of Object.keys(dictionary("en"))) {
      const want = placeholders(dictionary("en")[key]).join(",");
      for (const l of LANGS) {
        const got = placeholders(dictionary(l)[key] ?? "").join(",");
        if (got !== want) wrong.push(`${l}: ${key} has {${got}}, en has {${want}}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("fills placeholders and leaves unknown ones visible", () => {
    expect(tf("en", "app.peerEntered", { name: "Alice" })).toBe("Alice entered the room.");
    expect(tf("cs", "app.joined", { room: "brno" })).toContain("{n}");
  });
});
