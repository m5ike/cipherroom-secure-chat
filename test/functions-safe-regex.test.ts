// @vitest-environment node
// Patterns from callers that run in the main service (6.7, audit S1, N15).
// The m5adm filter check refused only "(x+)+"-shaped patterns; the audit's
// ((a+))+$ and (a|a)+$ passed it and took 8–14 s on 28 characters (forever
// on the allowed 200), stalling signalling and the API. A model input's
// `pattern` ran unguarded over up to 1 MB. Now a pattern that could backtrack
// runs under a timeout and a per-call budget.

import { describe, it, expect } from "vitest";
import { filterRegex, roomFilters } from "../server/functions/host-adm";
import { isSimplePattern, RegexBudgetError, SafeRegex } from "../server/functions/safe-regex";
import { validateInputs } from "../server/functions/inputs";

const elapsed = (fn: () => void) => { const t = performance.now(); fn(); return performance.now() - t; };

describe("S1 — m5adm filters cannot stall the service", () => {
  it("the audit's patterns finish fast on a 200-character subject (refused as too slow)", () => {
    // The first two are the audit's (they passed the old check); the others
    // are refused up front or guarded — either way they cannot stall.
    for (const p of ["((a+))+$", "(a|a)+$", "/(a|aa)+$/i", "(?:a+){2,}$", "a*a*a*a*a*a*a*a*$", "(\\w+\\s?)+$"]) {
      let re: ReturnType<typeof filterRegex>;
      try { re = filterRegex(p); } catch (err) { expect(p.startsWith("((a+))") || p.startsWith("(a|a)"), p).toBe(false); expect(String(err)).toMatch(/repeat/); continue; }
      const subject = `${"a".repeat(199)}!`;
      let threw: unknown = null;
      const ms = elapsed(() => { try { re.test(subject); } catch (err) { threw = err; } });
      expect(ms, p).toBeLessThan(1000);
      expect(threw, p).toBeInstanceOf(RegexBudgetError);
    }
  });

  it("a slow pattern spends one budget per call, not one per subject", () => {
    const re = filterRegex("(a|a)+$");
    const ms = elapsed(() => {
      for (let i = 0; i < 50; i++) { try { re.test(`${"a".repeat(150 + i)}!`); } catch { /* budget */ } }
    });
    expect(ms).toBeLessThan(1000);
  });

  it("room filters with a backtracking pattern are guarded too", () => {
    const [f] = roomFilters([{ key: "room_label", value: "((a+))+$" }]);
    expect(() => f.re.prime([`${"a".repeat(60)}!`])).toThrow(RegexBudgetError);
  });

  it("ordinary filters still match, natively or guarded", () => {
    expect(filterRegex("/^EVA$/i").test("eva")).toBe(true);
    expect(filterRegex("^EVA$").test("eva")).toBe(false);
    expect(() => filterRegex("(a+)+$")).toThrow(/repeat/);
    // Two quantifiers: guarded, but thousands of names cost one step when primed.
    const re = filterRegex("^ev.*a.*n$");
    const names = Array.from({ length: 20_000 }, (_, i) => (i % 2 ? `eva-${i}-n` : `adam-${i}`));
    re.prime(names);
    expect(names.filter((n) => re.test(n)).length).toBe(10_000);
    expect(filterRegex("(eva|adam)").test("hi adam")).toBe(true);
  });

  it("classifies patterns", () => {
    for (const p of ["^eva", "eva$", "^[a-z]+$", "a.*b", "(eva|adam)", "\\d{4}", "x+?", "[(+*)]+"]) expect(isSimplePattern(p), p).toBe(true);
    for (const p of ["(a+)+", "(a|b)*", "a*b*", "(\\w)\\1", "(?<=a)b", "(?!a)b", "\\k<x>", "a{2,}b+"]) expect(isSimplePattern(p), p).toBe(false);
  });

  it("a simple pattern on a long subject is guarded (quadratic is not linear)", () => {
    const re = new SafeRegex("a*b", "", { maxSubject: Number.POSITIVE_INFINITY, budgetMs: 100, stepMs: 100 });
    const ms = elapsed(() => { try { re.test("a".repeat(1_000_000)); } catch { /* budget */ } });
    expect(ms).toBeLessThan(1000);
  });
});

describe("N15 — an input's pattern is guarded", () => {
  it("a backtracking pattern over a long value fails the input quickly", () => {
    const specs = [{ name: "v", type: "string" as const, pattern: "^(a|a)+$" }];
    let err: unknown = null;
    const ms = elapsed(() => { try { validateInputs(specs as never, { v: `${"a".repeat(5000)}!` }); } catch (e) { err = e; } });
    expect(ms).toBeLessThan(1000);
    expect(String((err as Error)?.message)).toMatch(/pattern/);
  });

  it("an ordinary pattern still accepts and refuses", () => {
    const specs = [{ name: "code", type: "string" as const, pattern: "^[A-Z]{3}-\\d+$" }];
    expect(validateInputs(specs as never, { code: "ABC-12" })).toMatchObject({ code: "ABC-12" });
    expect(() => validateInputs(specs as never, { code: "abc" })).toThrow(/pattern/);
    // The whole value counts, not a prefix.
    expect(() => validateInputs(specs as never, { code: `ABC-${"1".repeat(5000)}x` })).toThrow(/pattern/);
  });
});
