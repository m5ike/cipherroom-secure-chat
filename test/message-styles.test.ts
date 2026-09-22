import { describe, it, expect } from "vitest";
import {
  styleKeyFor, sanitizePerUserStyle, sanitizeStyleMap, isEmptyStyle, bubbleStyleFrom, isBorderStyle,
} from "../client/src/lib/message-styles";

describe("styleKeyFor", () => {
  it("prefers a normalised name, falls back to the peer id", () => {
    expect(styleKeyFor("Alice", "peer-1")).toBe("alice");
    expect(styleKeyFor("  BOB  ", "peer-2")).toBe("bob");
    expect(styleKeyFor("", "peer-3")).toBe("peer-3");
  });
});

describe("sanitizePerUserStyle", () => {
  it("keeps valid hex and clamps numeric ranges", () => {
    const s = sanitizePerUserStyle({ fontColor: "#abc", bubbleOpacity: 5, fontScale: 0.1, borderStyle: "dashed" });
    expect(s.fontColor).toBe("#abc");
    expect(s.bubbleOpacity).toBe(1); // clamped to <= 1
    expect(s.fontScale).toBe(0.8); // clamped to >= 0.8
    expect(s.borderStyle).toBe("dashed");
  });
  it("drops invalid colours, fonts and border styles", () => {
    const s = sanitizePerUserStyle({ fontColor: "red", bubbleColor: "#gggggg", fontFamily: "comic", borderStyle: "wavy" });
    expect(s.fontColor).toBeUndefined();
    expect(s.bubbleColor).toBeUndefined();
    expect(s.fontFamily).toBeUndefined();
    expect(s.borderStyle).toBeUndefined();
  });
});

describe("isBorderStyle", () => {
  it("accepts the known set only", () => {
    expect(isBorderStyle("solid")).toBe(true);
    expect(isBorderStyle("dotted")).toBe(true);
    expect(isBorderStyle("groove")).toBe(false);
  });
});

describe("sanitizeStyleMap", () => {
  it("skips empty styles and over-long keys", () => {
    const map = sanitizeStyleMap({
      alice: { fontColor: "#111" },
      bob: { fontColor: "not-a-color" }, // becomes empty → dropped
      [("x".repeat(80))]: { fontColor: "#222" },
    });
    expect(map.alice).toEqual({ fontColor: "#111" });
    expect(map.bob).toBeUndefined();
    expect(Object.keys(map).some((k) => k.length > 64)).toBe(false);
  });
});

describe("bubbleStyleFrom", () => {
  it("returns empty for no style", () => {
    expect(bubbleStyleFrom(undefined)).toEqual({});
  });
  it("maps colours, opacity and border into CSS properties", () => {
    const css = bubbleStyleFrom({ fontColor: "#ffffff", bubbleColor: "#000000", bubbleOpacity: 0.5, borderColor: "#ff0000", borderStyle: "dashed", fontScale: 1.2 });
    expect(css.color).toBe("#ffffff");
    expect(css.background).toBe("rgba(0, 0, 0, 0.5)");
    expect(css.borderStyle).toBe("dashed");
    expect(css.borderColor).toBe("#ff0000");
    expect(css.fontSize).toBe("1.2em");
  });
  it("isEmptyStyle detects the empty object", () => {
    expect(isEmptyStyle({})).toBe(true);
    expect(isEmptyStyle({ fontColor: "#111" })).toBe(false);
  });
});
