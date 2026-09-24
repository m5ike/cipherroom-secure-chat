// @vitest-environment node
//
// The Layout builder's element trees (client/src/lib/layout-tree.ts): what
// an operator may store — known elements and tags, safe attributes, URLs and
// CSS, no inline handlers — and the app's own layouts surviving that
// unchanged, with a contract for everything they use.

import { describe, it, expect } from "vitest";
import {
  ELEMENTS, LAYOUT_LIMITS, attrNames, attrValues, countNodes, isSafeCssValue, isSafeUrl, sanitizeTree, treeRev, walkTree, type LNode,
} from "../client/src/lib/layout-tree";
import { DEFAULT_LAYOUT_REVS, DEFAULT_LAYOUTS, LAYOUT_GROUP, LAYOUT_GROUP_LABELS, LAYOUT_IDS, LAYOUT_LABELS } from "../client/src/lib/layouts";
import { PREVIEW_VARIANTS } from "../client/src/lib/layouts/samples";
import { MENU_ICONS } from "../client/src/lib/menu-icons-data";
import { LAYOUT_CONTRACTS } from "../client/src/lib/layouts/contracts";
import { DEFAULT_LAYOUT, layoutBlocks, layoutTree, sanitizeLayout } from "../client/src/lib/layout-config";

describe("sanitizeTree", () => {
  it("keeps known elements, tags and safe attributes; drops handlers, style strings and unknown things", () => {
    const t = sanitizeTree({
      id: "root", el: "panel", tag: "script", attrs: { class: "a b", onclick: "alert(1)", style: "color:red", "data-x": "1", "aria-label": "hi", srcdoc: "x", formaction: "/x" },
      children: [
        { id: "x", el: "iframe" },
        { id: "b", el: "button", attrs: { type: "submit", disabled: "=$n == 0", onmouseover: "x" }, on: { click: { action: "reply", arg: "$id" }, bogus: { action: "x" } } },
        { id: "l", el: "link", attrs: { href: "javascript:alert(1)" } },
        { id: "l2", el: "link", attrs: { href: "=$attachment.dataUrl" } },
        { id: "l3", el: "link", attrs: { href: "https://example.org/a" } },
        { id: "img", el: "image", attrs: { src: "data:image/png;base64,AAAA", alt: "a" } },
        { id: "img2", el: "image", attrs: { src: "data:text/html,<script>" } },
      ],
    })!;
    expect(t.tag).toBe("div");
    expect(t.attrs).toEqual({ class: "a b", "data-x": "1", "aria-label": "hi" });
    expect(t.children!.map((c) => c.id)).toEqual(["b", "l", "l2", "l3", "img", "img2"]);
    const [b, l, l2, l3, img, img2] = t.children!;
    expect(b.attrs).toEqual({ type: "submit", disabled: "=$n == 0" });
    expect(b.on).toEqual({ click: { action: "reply", arg: "$id" } });
    expect(l.attrs).toBeUndefined();
    expect(l2.attrs).toEqual({ href: "=$attachment.dataUrl" });
    expect(l3.attrs).toEqual({ href: "https://example.org/a" });
    expect(img.attrs).toEqual({ src: "data:image/png;base64,AAAA", alt: "a" });
    expect(img2.attrs).toBeUndefined();
  });

  it("keeps CSS without url(), expressions or imports", () => {
    const t = sanitizeTree({
      id: "p", el: "panel",
      css: { display: "flex", background: "url(https://evil/x.png)", color: "expression(alert(1))", "--brand": "#f00", "behavior": "x", gap: "1rem; color: red", "font-size": "{$size}px" },
    })!;
    expect(t.css).toEqual({ display: "flex", "--brand": "#f00", "font-size": "{$size}px" });
    expect(isSafeCssValue("calc(100% - 2rem)")).toBe(true);
    expect(isSafeCssValue("u\\rl(x)")).toBe(false);
  });

  it("gives every node a unique id, and limits size and depth", () => {
    const many = { id: "r", el: "panel", children: Array.from({ length: 50 }, () => ({ id: "same", el: "text", text: "x" })) };
    const t = sanitizeTree(many)!;
    const ids = t.children!.map((c) => c.id);
    expect(new Set(ids).size).toBe(50);
    expect(countNodes(sanitizeTree(many, 10)!)).toBe(10);
    let deep: Record<string, unknown> = { id: "leaf", el: "text", text: "x" };
    for (let i = 0; i < LAYOUT_LIMITS.depth + 5; i++) deep = { id: `d${i}`, el: "panel", children: [deep] };
    let depth = 0;
    walkTree(sanitizeTree(deep)!, () => { depth++; });
    expect(depth).toBeLessThanOrEqual(LAYOUT_LIMITS.depth);
  });

  it("keeps a select's options, element parameters it knows, and loop names", () => {
    const t = sanitizeTree({
      id: "s", el: "select", children: [{ id: "o", el: "option", text: "A" }, { id: "p", el: "paragraph", text: "no" }, { id: "g", el: "group", children: [] }],
    })!;
    expect(t.children!.map((c) => c.el)).toEqual(["option", "group"]);
    const icon = sanitizeTree({ id: "i", el: "icon", props: { icon: "star", evil: "x" }, attrs: { class: "h-4", onclick: "x" } })!;
    expect(icon.props).toEqual({ icon: "star" });
    expect(icon.attrs).toEqual({ class: "h-4" });
    const loop = sanitizeTree({ id: "l", el: "item", each: "$peers", as: "$p!" })!;
    expect(loop.as).toBe("item");
    expect(sanitizeTree({ id: "l", el: "item", each: "$peers", as: "$p" })!.as).toBe("p");
  });

  it("every palette element's preset is valid as it is", () => {
    for (const d of ELEMENTS) {
      const node = { id: "x", el: d.el, ...(d.tag ? { tag: d.tag } : {}), ...(d.preset ?? {}), ...(d.el === "slot" ? { slot: "menu" } : {}), ...(d.el === "block" ? { block: "b" } : {}) };
      expect(sanitizeTree(node), d.el).toEqual(node);
    }
  });

  it("knows safe addresses", () => {
    for (const ok of ["https://x.org", "/path", "./a", "#top", "mailto:a@b.c", "tel:+420", "data:image/png;base64,AA", ""]) expect(isSafeUrl(ok), ok).toBe(true);
    for (const bad of ["javascript:alert(1)", " JaVaScRiPt:alert(1)", "vbscript:x", "http://plain.example", "//evil.example", "data:text/html,x", "file:///etc/passwd"]) expect(isSafeUrl(bad), bad).toBe(false);
    expect(isSafeUrl("data:application/pdf;base64,AA", { data: true })).toBe(true);
    expect(isSafeUrl("data:text/html,x", { data: true })).toBe(false);
    expect(isSafeUrl("blob:https://x/1", { data: true })).toBe(true);
  });

  it("suggests attributes and their values", () => {
    expect(attrNames("input")).toEqual(expect.arrayContaining(["type", "placeholder", "aria-label", "class"]));
    expect(attrValues("input", "type")).toEqual(expect.arrayContaining(["text", "password", "number", "email", "range", "file"]));
    expect(attrValues("button", "type")).toEqual(["button", "submit", "reset"]);
    expect(attrValues("div", "hidden")).toEqual(["=true", "=false"]);
  });
});

/** The $roots, actions, slots and refs a tree uses. */
function uses(tree: LNode) {
  const vars = new Set<string>();
  const loopVars = new Set<string>(["iterator", "arg"]);
  const actions = new Set<string>();
  const slots = new Set<string>();
  const refs = new Set<string>();
  const scan = (s?: string) => { for (const m of (s ?? "").matchAll(/\$([A-Za-z_]\w*)/g)) vars.add(m[1]); };
  walkTree(tree, (n) => {
    if (n.as) loopVars.add(n.as);
    for (const v of [n.text, n.if, n.each, n.key, n.arg, n.styleBind, ...Object.values(n.attrs ?? {}), ...Object.values(n.props ?? {}), ...Object.values(n.css ?? {})]) scan(v);
    for (const b of Object.values(n.on ?? {})) { actions.add(b!.action); scan(b!.arg); }
    if (n.slot) slots.add(n.slot);
    if (n.ref) refs.add(n.ref);
  });
  for (const l of loopVars) vars.delete(l);
  return { vars, actions, slots, refs };
}

describe("the app's own layouts", () => {
  it("survive the sanitizer unchanged (an operator can save them as they are)", () => {
    for (const id of LAYOUT_IDS) expect(sanitizeTree(DEFAULT_LAYOUTS[id]), id).toEqual(DEFAULT_LAYOUTS[id]);
  });

  it("use only what their contract offers", () => {
    for (const id of LAYOUT_IDS) {
      const c = LAYOUT_CONTRACTS[id];
      const u = uses(DEFAULT_LAYOUTS[id]);
      const roots = new Set(c.vars.map((v) => v.path.replace(/^\$/, "").split(".")[0]));
      for (const v of u.vars) expect(roots.has(v), `${id}: $${v}`).toBe(true);
      for (const a of u.actions) expect(c.actions.map((x) => x.name), `${id}: action ${a}`).toContain(a);
      for (const s of u.slots) expect(c.slots.map((x) => x.name), `${id}: slot ${s}`).toContain(s);
      for (const r of u.refs) expect(c.refs.map((x) => x.name), `${id}: ref ${r}`).toContain(r);
    }
  });

  it("draw only icons of the catalog (script/gen-menu-icons.mjs reads them from the trees)", () => {
    for (const id of LAYOUT_IDS) {
      walkTree(DEFAULT_LAYOUTS[id], (n) => {
        const name = n.el === "icon" ? n.props?.icon : undefined;
        if (typeof name !== "string") return;
        const names = name.replace(/\{[^}]*\}/g, " ").trim().split(/\s+/).filter(Boolean);
        for (const x of names) expect(MENU_ICONS[x], `${id}: ${n.id} draws "${x}"`).toBeDefined();
      });
    }
  });

  it("each have a name, a section of the builder and situations to preview", () => {
    for (const id of LAYOUT_IDS) {
      expect(LAYOUT_LABELS[id], id).toBeTruthy();
      expect(Object.keys(LAYOUT_GROUP_LABELS), id).toContain(LAYOUT_GROUP[id]);
      expect(PREVIEW_VARIANTS[id]?.length, id).toBeGreaterThan(0);
      expect(new Set(PREVIEW_VARIANTS[id].map((v) => v.id)).size, id).toBe(PREVIEW_VARIANTS[id].length);
    }
  });

  it("have stable, distinct revisions", () => {
    expect(new Set(Object.values(DEFAULT_LAYOUT_REVS)).size).toBe(LAYOUT_IDS.length);
    expect(treeRev(DEFAULT_LAYOUTS.chat)).toBe(DEFAULT_LAYOUT_REVS.chat);
    const changed = structuredClone(DEFAULT_LAYOUTS.chat);
    changed.children![0].id = "other";
    expect(treeRev(changed)).not.toBe(DEFAULT_LAYOUT_REVS.chat);
  });
});

describe("the layout config's layouts and templates", () => {
  it("keeps valid layouts and templates, drops the rest", () => {
    const cfg = sanitizeLayout({
      layouts: {
        composer: { tree: { id: "k", el: "form", children: [{ id: "t", el: "text", text: "Hi" }] }, rev: "abc" },
        nonsense: { tree: { id: "x", el: "panel" } },
        chat: { tree: { el: "unknown" } },
      },
      blocks: {
        "good-one": { tree: { id: "b", el: "button", text: "Go" }, label: "Go button" },
        "Bad Name": { tree: { id: "b", el: "button" } },
        empty: { tree: null },
      },
    });
    expect(Object.keys(cfg.layouts)).toEqual(["composer"]);
    expect(cfg.layouts.composer!.rev).toBe("abc");
    expect(Object.keys(cfg.blocks)).toEqual(["good-one"]);
    expect(layoutTree(cfg, "composer").children![0].text).toBe("Hi");
    expect(layoutTree(cfg, "chat")).toBe(DEFAULT_LAYOUTS.chat);
    expect(layoutBlocks(cfg)["good-one"].text).toBe("Go");
    expect(sanitizeLayout(DEFAULT_LAYOUT)).toEqual(DEFAULT_LAYOUT);
  });
});
