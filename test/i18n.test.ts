// Every string exists in every language, with the same placeholders — a
// key missing in one language falls back to English (or shows the key).
// 6.13: plural forms ("key#one", "key#few"…) are per language — a language
// has the forms its plural rules use; the plain key or the forms count as
// the key being there, and every form keeps the placeholders of English.

import { describe, it, expect } from "vitest";
import { dictionary, tf, type Lang } from "../client/src/lib/i18n";

const LANGS: Lang[] = ["cs", "en", "de"];
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const base = (key: string) => key.replace(/#(zero|one|two|few|many|other)$/, "");
const bases = (l: Lang) => new Set(Object.keys(dictionary(l)).map(base));

describe("translations", () => {
  it("have the same keys in every language", () => {
    const all = new Set(LANGS.flatMap((l) => [...bases(l)]));
    const missing: string[] = [];
    for (const l of LANGS) { const have = bases(l); for (const key of all) if (!have.has(key)) missing.push(`${l}: ${key}`); }
    expect(missing).toEqual([]);
  });

  it("use the same placeholders in every language", () => {
    const en = dictionary("en");
    const wrong: string[] = [];
    for (const l of LANGS) {
      for (const [key, text] of Object.entries(dictionary(l))) {
        const b = base(key);
        const ref = en[key] ?? en[`${b}#other`] ?? en[b];
        if (ref === undefined) { wrong.push(`${l}: ${key} has no English`); continue; }
        const want = placeholders(ref).join(","), got = placeholders(text).join(",");
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
