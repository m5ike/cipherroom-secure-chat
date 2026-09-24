// The Layout builder's accessibility checks (client/src/lib/layout-a11y.ts,
// 4.13): the design (names, labels, keyboard, headings, ids) and what the
// preview drew (accessible names, labels, WCAG contrast).

import { describe, it, expect, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { accessibleName, checkDom, checkTree, composite, contrastRatio, parseCssColor } from "../client/src/lib/layout-a11y";
import { renderLayout, setLayoutPreviewMode } from "../client/src/components/LayoutView";
import { sanitizeTree, type LNode } from "../client/src/lib/layout-tree";
import { DEFAULT_LAYOUTS, LAYOUT_IDS } from "../client/src/lib/layouts";

beforeEach(() => { cleanup(); setLayoutPreviewMode(null); });

const rules = (t: LNode) => checkTree(sanitizeTree(t)!).map((i) => `${i.id}:${i.rule}`);

describe("checkTree", () => {
  it("finds what a screen reader or a keyboard user would miss", () => {
    expect(rules({
      id: "r", el: "panel", tag: "div", children: [
        { id: "img", el: "image", attrs: { src: "/a.png" } },
        { id: "icon-btn", el: "button", tag: "button", children: [{ id: "i", el: "icon", props: { icon: "x" } }] },
        { id: "ok-btn", el: "button", tag: "button", attrs: { "aria-label": "Close" }, children: [{ id: "i2", el: "icon", props: { icon: "x" } }] },
        { id: "name", el: "input", attrs: { type: "text", placeholder: "Name" } },
        { id: "lbl", el: "label", attrs: { for: "f-mail" }, text: "Mail" },
        { id: "mail", el: "input", attrs: { type: "email", id: "f-mail" } },
        { id: "wrap", el: "label", children: [{ id: "agree", el: "input", attrs: { type: "checkbox" } }, { id: "t", el: "text", text: "I agree" }] },
        { id: "file", el: "input", attrs: { type: "file", class: "hidden" } },
        { id: "clicky", el: "panel", tag: "div", text: "x", on: { click: { action: "go" } } },
        { id: "clicky-ok", el: "panel", tag: "div", text: "x", attrs: { role: "button", tabindex: "0" }, on: { click: { action: "go" } } },
        { id: "tab", el: "panel", tag: "div", attrs: { tabindex: "3" } },
        { id: "h1", el: "heading", tag: "h1", text: "Title" },
        { id: "h3", el: "heading", tag: "h3", text: "Skipped" },
        { id: "a", el: "link", tag: "a", attrs: { href: "https://x.org", target: "_blank" }, text: "x" },
        { id: "a-ok", el: "link", tag: "a", attrs: { href: "https://x.org", target: "_blank", rel: "noopener" }, text: "x" },
        { id: "a-ok2", el: "link", tag: "a", attrs: { href: "https://x.org", target: "_blank", rel: "noreferrer" }, text: "x" },
        { id: "dup1", el: "panel", tag: "div", attrs: { id: "same" } },
        { id: "dup2", el: "panel", tag: "div", attrs: { id: "same" } },
        { id: "live", el: "button", tag: "button", text: "{$label}" },
      ],
    })).toEqual([
      "img:img-alt", "icon-btn:control-name", "name:field-label", "clicky:click-keyboard", "tab:tabindex-positive",
      "h3:heading-order", "a:blank-noopener", "dup2:duplicate-id",
    ]);
  });

  it("finds nothing to fix in the app's own layouts", () => {
    for (const id of LAYOUT_IDS) {
      const issues = checkTree(DEFAULT_LAYOUTS[id]).filter((i) => i.severity !== "info" && !(id === "message.sys" && i.rule === "click-keyboard"));
      expect(issues, id).toEqual([]);
    }
  });
});

describe("contrast", () => {
  it("reads computed colours and measures WCAG contrast", () => {
    expect(parseCssColor("rgb(255, 0, 0)")).toEqual([255, 0, 0, 1]);
    expect(parseCssColor("rgba(0, 0, 0, 0.5)")).toEqual([0, 0, 0, 0.5]);
    expect(parseCssColor("rgb(0 0 0 / 50%)")).toEqual([0, 0, 0, 0.5]);
    expect(parseCssColor("#fff")).toEqual([255, 255, 255, 1]);
    expect(parseCssColor("color(srgb 1 0 0)")).toEqual([255, 0, 0, 1]);
    expect(parseCssColor("oklch(0.5 0.1 200)")).toBeNull();
    expect(contrastRatio([0, 0, 0, 1], [255, 255, 255, 1])).toBeCloseTo(21, 5);
    expect(contrastRatio([119, 119, 119, 1], [255, 255, 255, 1])).toBeCloseTo(4.48, 2);
    expect(composite([0, 0, 0, 0.5], [255, 255, 255, 1])).toEqual([127.5, 127.5, 127.5, 1]);
  });
});

describe("checkDom", () => {
  it("measures names, labels and the contrast of what was drawn", () => {
    setLayoutPreviewMode({});
    const { container } = render(<>{renderLayout(sanitizeTree({
      id: "r", el: "panel", tag: "div", css: { background: "#ffffff" }, children: [
        { id: "pale", el: "paragraph", tag: "p", css: { color: "#aaaaaa" }, text: "hard to read" },
        { id: "dark", el: "paragraph", tag: "p", css: { color: "#222222" }, text: "easy to read" },
        { id: "big", el: "heading", tag: "h1", css: { color: "#949494", "font-size": "32px" }, text: "large enough" },
        { id: "nameless", el: "button", tag: "button", children: [{ id: "ic", el: "icon", props: { icon: "x" } }] },
        { id: "named", el: "button", tag: "button", attrs: { "aria-label": "Close" }, children: [{ id: "ic2", el: "icon", props: { icon: "x" } }] },
        { id: "field", el: "input", attrs: { type: "text" } },
      ],
    })!, { data: {} })}</>);
    const style = (el: Element) => {
      const s = (el as HTMLElement).style;
      return {
        color: s.color || (el.parentElement ? "" : "rgb(0,0,0)"), backgroundColor: s.backgroundColor || "rgba(0, 0, 0, 0)", backgroundImage: "none",
        fontSize: s.fontSize || "16px", fontWeight: "400", opacity: "1", visibility: "visible", display: "block",
      };
    };
    // Inherit colour as a browser would (happy-dom does not cascade inline styles).
    const cascade = (el: Element) => { let e: Element | null = el; while (e && !(e as HTMLElement).style?.color) e = e.parentElement; return { ...style(el), color: (e as HTMLElement | null)?.style.color || "rgb(0, 0, 0)" }; };
    const issues = checkDom(container, cascade).map((i) => `${i.id}:${i.rule}`);
    expect(issues).toEqual(["nameless:control-name", "field:field-label", "pale:contrast"]);
    expect(accessibleName(container.querySelector('[data-lb-id="named"]')!)).toBe("Close");
  });
});
