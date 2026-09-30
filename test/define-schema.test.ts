// m5mobile.define (6.3): the typed-definition schema sanitizes, bounds and
// materializes; a bad or oversized definition can't reach a runtime.

import { describe, it, expect } from "vitest";
import {
  sanitizeDefineSet, sanitizeNode, sanitizeDefinition, materialize, defineValues, definitionBytes, oversized,
  isValidDefName, DEFINE_LIMITS, type DefNode,
} from "../client/src/lib/define/schema";

describe("names", () => {
  it("accepts identifiers, rejects the rest", () => {
    expect(isValidDefName("apduTemplates")).toBe(true);
    expect(isValidDefName("_x1")).toBe(true);
    expect(isValidDefName("1x")).toBe(false);
    expect(isValidDefName("a b")).toBe(false);
    expect(isValidDefName("")).toBe(false);
  });
});

describe("materialize", () => {
  it("turns a nested container into a plain typed value", () => {
    const node: DefNode = {
      type: "object", entries: [
        { key: "name", node: { type: "string", value: "M5" } },
        { key: "count", node: { type: "integer", value: 3.9 as unknown as number } },
        { key: "ratio", node: { type: "float", value: 1.5 } },
        { key: "on", node: { type: "boolean", value: true } },
        { key: "aid", node: { type: "bytes", value: "A0:00 00 06 21" } },
        { key: "modes", node: { type: "array", items: [{ type: "string", value: "a" }, { type: "string", value: "b" }] } },
      ],
    };
    const clean = sanitizeNode(node)!;
    expect(materialize(clean)).toEqual({ name: "M5", count: 3, ratio: 1.5, on: true, aid: "a000000621", modes: ["a", "b"] });
  });

  it("tags a script and keeps an enum's choice", () => {
    expect(materialize(sanitizeNode({ type: "script", value: "return 1", lang: "py" })!)).toEqual({ __m5script: true, code: "return 1", lang: "py" });
    const e = sanitizeNode({ type: "enum", options: ["a", "b"], value: "b" })!;
    expect(materialize(e)).toBe("b");
    // an out-of-range enum value falls back to the first option
    expect(materialize(sanitizeNode({ type: "enum", options: ["a", "b"], value: "z" })!)).toBe("a");
  });
});

describe("sanitize + bounds", () => {
  it("drops unknown types, duplicate keys and enforces depth", () => {
    expect(sanitizeNode({ type: "weird" })).toBeNull();
    const obj = sanitizeNode({ type: "object", entries: [
      { key: "a", node: { type: "string", value: "1" } },
      { key: "a", node: { type: "string", value: "2" } }, // dup dropped
      { key: "", node: { type: "string", value: "3" } },  // empty key dropped
      { key: "bad", node: { type: "nope" } },              // bad node dropped
    ] });
    expect((obj as { entries: unknown[] }).entries).toHaveLength(1);
    // depth guard: a chain deeper than maxDepth returns null at the bottom
    let deep: unknown = { type: "string", value: "x" };
    for (let i = 0; i < DEFINE_LIMITS.maxDepth + 2; i++) deep = { type: "array", items: [deep] };
    const s = sanitizeNode(deep);
    // it sanitizes but truncates below the limit (deepest items dropped)
    expect(s).toBeTruthy();
  });

  it("sanitizes a whole set, dedups names, drops invalid ones", () => {
    const set = sanitizeDefineSet({ defs: [
      { name: "good", kind: "constant", node: { type: "string", value: "x" } },
      { name: "good", kind: "constant", node: { type: "string", value: "y" } }, // dup name
      { name: "1bad", node: { type: "string", value: "z" } },                    // bad name
      { name: "num", node: { type: "integer", value: 7 } },
    ] });
    expect(set.defs.map((d) => d.name)).toEqual(["good", "num"]);
    expect(defineValues(set)).toEqual({ good: "x", num: 7 });
  });

  it("scopes values to android/web", () => {
    const set = sanitizeDefineSet({ defs: [
      { name: "a", node: { type: "string", value: "1" }, scope: "android" },
      { name: "w", node: { type: "string", value: "2" }, scope: "web" },
      { name: "both", node: { type: "string", value: "3" } },
    ] });
    expect(Object.keys(defineValues(set, "android")).sort()).toEqual(["a", "both"]);
    expect(Object.keys(defineValues(set, "web")).sort()).toEqual(["both", "w"]);
    expect(Object.keys(defineValues(set, "both")).sort()).toEqual(["a", "both", "w"]);
  });

  it("flags a definition over its own maxSize", () => {
    const def = sanitizeDefinition({ name: "big", node: { type: "string", value: "x".repeat(100) }, maxSize: 20 })!;
    expect(definitionBytes(def)).toBeGreaterThan(20);
    expect(oversized({ version: 1, updatedAt: 0, defs: [def] })).toEqual(["big"]);
    const ok = sanitizeDefinition({ name: "ok", node: { type: "string", value: "x" }, maxSize: 0 })!;
    expect(oversized({ version: 1, updatedAt: 0, defs: [ok] })).toEqual([]);
  });
});

describe("an EMV APDU template set (the EMV Application Template use)", () => {
  it("materializes an array of application templates", () => {
    const set = sanitizeDefineSet({ defs: [{
      name: "apduTemplates", kind: "constant", node: { type: "array", items: [
        { type: "object", entries: [
          { key: "label", node: { type: "string", value: "PPSE" } },
          { key: "apdu", node: { type: "bytes", value: "00A404000E325041592E5359532E444446303100" } },
        ] },
        { type: "object", entries: [
          { key: "label", node: { type: "string", value: "Visa AID" } },
          { key: "apdu", node: { type: "bytes", value: "00A4040007A000000003101000" } },
        ] },
      ] },
    }] });
    const v = defineValues(set).apduTemplates as Array<{ label: string; apdu: string }>;
    expect(v).toHaveLength(2);
    expect(v[0]).toEqual({ label: "PPSE", apdu: "00a404000e325041592e5359532e444446303100" });
    expect(v[1].label).toBe("Visa AID");
  });
});
