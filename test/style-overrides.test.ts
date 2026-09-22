// @vitest-environment node
//
// Edit Mode data model: declaration parsing (incl. DevTools-style disabled
// rows), sanitising, selector compilation (state + device scope), one rule
// per (selector, state, scope), class patches, export / import.

import { describe, it, expect } from "vitest";
import {
  baseSelector, buildRuleCss, buildStylesheet, compileSelector, exportOverrides, importOverrides, parseDeclarations,
  patchClass, prettyDeclarations, sanitizeCssText, sanitizeOverrides, sanitizeState, serializeDeclarations,
  splitSelectorList, stateOf, upsertRule, EMPTY_OVERRIDES, LIMITS, type StyleOverrides,
} from "../client/src/lib/style-overrides";

const empty = (): StyleOverrides => ({ ...EMPTY_OVERRIDES, rules: [], classes: [] });

describe("declarations", () => {
  it("parses values with colons, semicolons and parentheses", () => {
    const d = parseDeclarations("color: red; background: url(data:image/png;base64,AAA=) no-repeat; font-family: 'A: B', serif ;");
    expect(d.map((x) => [x.prop, x.value])).toEqual([
      ["color", "red"],
      ["background", "url(data:image/png;base64,AAA=) no-repeat"],
      ["font-family", "'A: B', serif"],
    ]);
  });
  it("reads !important and DevTools-style disabled declarations", () => {
    const d = parseDeclarations("color: red !important;\n/* padding: 4px; */\n/* just a note */\nmargin:0");
    expect(d).toEqual([
      { prop: "color", value: "red", important: true, enabled: true },
      { prop: "padding", value: "4px", important: false, enabled: false },
      { prop: "margin", value: "0", important: false, enabled: true },
    ]);
  });
  it("keeps custom properties' case and drops junk", () => {
    const d = parseDeclarations("--Brand-Color: #fff; 123: x; : nothing; color:");
    expect(d).toEqual([{ prop: "--Brand-Color", value: "#fff", important: false, enabled: true }]);
  });
  it("serialises back (round trip) and pretty-prints CSSOM text", () => {
    const text = "color: red !important;\n/* padding: 4px; */";
    expect(serializeDeclarations(parseDeclarations(text))).toBe(text);
    expect(prettyDeclarations("color: red; margin: 0px;")).toBe("color: red;\nmargin: 0px;");
  });
});

describe("sanitising", () => {
  it("removes remote loads and <style> break-outs, keeps data: URLs", () => {
    const out = sanitizeCssText(`@import url(https://evil.test/x.css);
a { background: url("https://evil.test/p.png"); }
b { background: url(data:image/gif;base64,R0lGOD==); }
</style><script>alert(1)</script>
c { width: expression(alert(1)); behavior: url(x.htc); }`);
    expect(out).not.toMatch(/@import|evil\.test|<\/?style|expression\(/i);
    expect(out).toContain("url(data:image/gif;base64,R0lGOD==)");
  });
  it("accepts only pseudo-class/element states", () => {
    expect(sanitizeState(":hover")).toBe(":hover");
    expect(sanitizeState(":hover::before")).toBe(":hover::before");
    expect(sanitizeState(":nth-child(odd)")).toBe(":nth-child(odd)");
    expect(sanitizeState("{} body")).toBe("");
    expect(sanitizeState(".x")).toBe("");
  });
  it("sanitizeOverrides bounds and cleans stored data", () => {
    const o = sanitizeOverrides({
      rules: [
        { selector: "a{}<b>", state: ":hover", scope: "phone", declarations: "color: red", enabled: true },
        { selector: "", declarations: "x" },
        "junk",
      ],
      classes: [{ selector: ".x", add: ["ok", "bad name", ".dot"], remove: ["ok"] }],
      globalCss: "@import url(x); p { color: blue }",
    });
    expect(o.rules).toHaveLength(1);
    expect(o.rules[0]).toMatchObject({ selector: "ab", state: ":hover", scope: "phone", enabled: true });
    expect(o.classes[0].add).toEqual(["ok", "badname", "dot"]);
    expect(o.classes[0].remove).toEqual([]); // cannot add and remove the same class
    expect(o.globalCss).not.toMatch(/@import/);
    expect(sanitizeOverrides({ rules: Array.from({ length: LIMITS.rules + 50 }, (_, i) => ({ selector: `.c${i}`, declarations: "color:red" })) }).rules).toHaveLength(LIMITS.rules);
  });
});

describe("selectors", () => {
  it("splits lists outside parentheses and separates the state part", () => {
    expect(splitSelectorList(".a, :is(.b, .c) > p,  .d")).toEqual([".a", ":is(.b, .c) > p", ".d"]);
    expect(baseSelector(".btn:hover::before")).toBe(".btn");
    expect(stateOf(".btn:hover::before")).toBe(":hover::before");
    expect(baseSelector(":hover")).toBe("*");
    expect(baseSelector("li:first-child > a:focus-visible")).toBe("li:first-child > a");
  });
  it("compiles state + device scope onto every selector of the list", () => {
    expect(compileSelector({ selector: ".a, .b", state: ":hover", scope: "all" })).toBe(".a:hover,\n.b:hover");
    expect(compileSelector({ selector: ".a", state: "::after", scope: "phone" })).toBe(':root[data-form="phone"] .a::after');
    expect(compileSelector({ selector: ":root .x", state: "", scope: "touch" })).toBe(':root[data-input="touch"] .x');
  });
  it("builds rules with !important when forced, skips disabled / empty ones", () => {
    const base = { id: "r", selector: ".x", state: "", scope: "all" as const, important: false, enabled: true, updatedAt: 0 };
    expect(buildRuleCss({ ...base, declarations: "color: red; /* margin: 0; */" })).toBe(".x {\n  color: red;\n}");
    expect(buildRuleCss({ ...base, declarations: "color: red", important: true })).toBe(".x {\n  color: red !important;\n}");
    expect(buildRuleCss({ ...base, declarations: "color: red", enabled: false })).toBe("");
    expect(buildRuleCss({ ...base, declarations: "/* color: red; */" })).toBe("");
  });
});

describe("upsertRule / patchClass", () => {
  it("keeps one rule per (selector, state, scope); empty declarations delete", () => {
    let o = upsertRule(empty(), { selector: ".x", state: "", scope: "all", declarations: "color: red", important: false, enabled: true });
    o = upsertRule(o, { selector: ".x", state: "", scope: "all", declarations: "color: blue", important: false, enabled: true });
    o = upsertRule(o, { selector: ".x", state: ":hover", scope: "all", declarations: "color: green", important: false, enabled: true });
    expect(o.rules).toHaveLength(2);
    expect(o.rules.find((r) => !r.state)?.declarations).toBe("color: blue");
    o = upsertRule(o, { selector: ".x", state: ":hover", scope: "all", declarations: "", important: false, enabled: true });
    expect(o.rules).toHaveLength(1);
  });
  it("renaming a rule onto an existing key folds the two", () => {
    let o = upsertRule(empty(), { selector: ".a", state: "", scope: "all", declarations: "color: red", important: false, enabled: true });
    o = upsertRule(o, { selector: ".b", state: "", scope: "all", declarations: "color: blue", important: false, enabled: true });
    const idA = o.rules.find((r) => r.selector === ".a")!.id;
    o = upsertRule(o, { id: idA, selector: ".b", state: "", scope: "all", declarations: "color: gold", important: false, enabled: true });
    expect(o.rules).toHaveLength(1);
    expect(o.rules[0]).toMatchObject({ id: idA, selector: ".b", declarations: "color: gold" });
  });
  it("class patches merge per selector and disappear when emptied", () => {
    let o = patchClass(empty(), ".card", "is-hot", "add");
    o = patchClass(o, ".card", "shadow", "remove");
    expect(o.classes).toHaveLength(1);
    expect(o.classes[0]).toMatchObject({ add: ["is-hot"], remove: ["shadow"] });
    o = patchClass(o, ".card", "shadow", "reset");
    o = patchClass(o, ".card", "is-hot", "reset");
    expect(o.classes).toHaveLength(0);
  });
});

describe("stylesheet + export / import", () => {
  it("orders rules, then the custom CSS", () => {
    let o = upsertRule(empty(), { selector: ".x", state: "", scope: "all", declarations: "color: red", important: false, enabled: true });
    o = { ...o, globalCss: "body { margin: 0 }" };
    const css = buildStylesheet(o);
    expect(css.indexOf(".x {")).toBeLessThan(css.indexOf("/* Custom CSS */"));
  });
  it("round-trips and rejects foreign files", () => {
    const o = patchClass(upsertRule(empty(), { selector: ".x", state: ":active", scope: "desktop", declarations: "color: red", important: true, enabled: true }), ".x", "y", "add");
    const back = importOverrides(exportOverrides(o));
    expect(back.rules[0]).toMatchObject({ selector: ".x", state: ":active", scope: "desktop", important: true });
    expect(back.classes[0].add).toEqual(["y"]);
    expect(() => importOverrides("{nope")).toThrow(/JSON/);
    expect(() => importOverrides('{"foo":1}')).toThrow(/rules/);
  });
});
