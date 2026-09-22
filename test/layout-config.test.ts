import { describe, it, expect } from "vitest";
import {
  DEFAULT_LAYOUT, LAYOUT_LIMITS, layoutCssVars, renderTemplate, sanitizeLayout, sanitizeStyle, allLayoutVarNames,
} from "../client/src/lib/layout-config";

describe("sanitizeStyle", () => {
  it("keeps hex colours, enum border styles and clamps numbers", () => {
    const s = sanitizeStyle({ bg: "#123", fg: "#abcdef", border: "red", bstyle: "dashed", bwidth: 99, radius: -5, fs: 12, opacity: 0.05, pad: 8, shadow: false });
    expect(s).toEqual({ bg: "#123", fg: "#abcdef", bstyle: "dashed", bwidth: 8, radius: 0, fs: 12, opacity: 0.2, pad: 8, shadow: false });
  });
  it("drops garbage", () => {
    expect(sanitizeStyle({ bg: "url(x)", bstyle: "wavy", fs: "12px", shadow: "yes" })).toEqual({});
    expect(sanitizeStyle(null)).toEqual({});
  });
});

describe("sanitizeLayout", () => {
  it("returns defaults for empty input and never lets markup through templates", () => {
    const l = sanitizeLayout({});
    expect(l.templates).toEqual(DEFAULT_LAYOUT.templates);
    expect(l.flags).toEqual(DEFAULT_LAYOUT.flags);
    expect(l.styles).toEqual({});
    const m = sanitizeLayout({ templates: { systemHeader: "<b>{{appName}}</b> · {{date}}" } });
    expect(m.templates.systemHeader).toBe("<b>{{appName}}</b> · {{date}}"); // control char stripped; text stays text
  });
  it("caps template length, partial count/names, and flag ranges", () => {
    const long = "x".repeat(LAYOUT_LIMITS.maxTemplateChars + 50);
    const partials: Record<string, string> = {};
    for (let i = 0; i < LAYOUT_LIMITS.maxPartials + 5; i += 1) partials[`p${i}`] = "hi";
    partials["bad name!"] = "nope";
    const l = sanitizeLayout({ templates: { incomingMeta: long }, partials, flags: { systemCollapseAfterSec: 99999, systemExpandForSec: 1, showAvatars: "yes" } });
    expect(l.templates.incomingMeta).toHaveLength(LAYOUT_LIMITS.maxTemplateChars);
    expect(Object.keys(l.partials).length).toBeLessThanOrEqual(LAYOUT_LIMITS.maxPartials);
    expect(l.partials["bad name!"]).toBeUndefined();
    expect(l.flags.systemCollapseAfterSec).toBe(3600);
    expect(l.flags.systemExpandForSec).toBe(3);
    expect(l.flags.showAvatars).toBe(true); // non-boolean → default
  });
  it("only accepts known component ids in styles", () => {
    const l = sanitizeLayout({ styles: { in: { bg: "#000" }, bogus: { bg: "#fff" } } });
    expect(Object.keys(l.styles)).toEqual(["in"]);
  });
});

describe("renderTemplate", () => {
  it("fills placeholders, blanks unknown ones, keeps the result as plain text", () => {
    expect(renderTemplate("{{sender}} · {{time}} {{nope}}", { sender: "Alice", time: "10:00" })).toBe("Alice · 10:00 ");
    expect(renderTemplate("<img src=x onerror=1>{{sender}}", { sender: "<b>x</b>" })).toBe("<img src=x onerror=1><b>x</b>"); // caller renders as text
  });
  it("expands named includes, bounded in depth", () => {
    const partials = { head: "[{{appName}}] {{> tail}}", tail: "({{date}})", loop: "a{{> loop}}" };
    expect(renderTemplate("{{> head}} ok", { appName: "M5cet", date: "22. září 2026" }, partials)).toBe("[M5cet] (22. září 2026) ok");
    // a self-including partial expands exactly maxIncludeDepth times, then stops
    expect(renderTemplate("{{> loop}}", {}, partials)).toBe("a".repeat(LAYOUT_LIMITS.maxIncludeDepth));
    expect(renderTemplate("{{> missing}}x", {}, partials)).toBe("x");
  });
});

describe("layoutCssVars", () => {
  it("maps styles to --c-<id>-<prop> with units and shadow keywords", () => {
    const vars = layoutCssVars(sanitizeLayout({ styles: { sys: { bg: "#111111", radius: 12, fs: 13, shadow: false, opacity: 0.8 }, out: { shadow: true } } }));
    expect(vars["--c-sys-bg"]).toBe("#111111");
    expect(vars["--c-sys-radius"]).toBe("12px");
    expect(vars["--c-sys-fs"]).toBe("13px");
    expect(vars["--c-sys-shadow"]).toBe("none");
    expect(vars["--c-sys-opacity"]).toBe("0.8");
    expect(vars["--c-out-shadow"]).toBe("var(--shadow-sm)");
    expect(Object.keys(vars)).toHaveLength(6);
    expect(allLayoutVarNames()).toContain("--c-composer-bg");
  });
});
