import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { hasMixedScripts, nameSkeleton, normalizeDisplayName } from "../client/src/lib/names";

// 6.12 (F-22): the web and the Android app (core/Names.java, NamesTest) read the
// same vectors. Normalization, mixed scripts and the confusable pairs must agree;
// the skeletons themselves differ in form (the web's also folds i/l, rn/m, vv/w and
// drops punctuation), so only the decisions they lead to are compared.
const vectors = JSON.parse(readFileSync(resolve(__dirname, "../android/app/src/test/resources/cz/m5cet/app/names-vectors.json"), "utf8")) as {
  names: Array<{ input: string; normalized: string; mixedScript: boolean; note: string }>;
  pairs: Array<{ a: string; b: string; confusable: boolean }>;
};

describe("display names — parity with the Android vectors", () => {
  it.each(vectors.names.map((n) => [n.note, n] as const))("%s", (_note, n) => {
    expect(normalizeDisplayName(n.input)).toBe(n.normalized);
    expect(hasMixedScripts(n.input)).toBe(n.mixedScript);
  });

  it.each(vectors.pairs.map((p) => [`${p.a} / ${p.b}`, p] as const))("pair %s", (_label, p) => {
    const a = normalizeDisplayName(p.a);
    const b = normalizeDisplayName(p.b);
    expect(a !== b && nameSkeleton(a) === nameSkeleton(b)).toBe(p.confusable);
  });
});
