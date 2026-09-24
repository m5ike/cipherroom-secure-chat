// @vitest-environment node
//
// What changed between two layout configurations (client/src/lib/layout-diff.ts,
// 4.13 — the builder's history) and layouts per group / GUI template
// (variants in client/src/lib/layout-config.ts).

import { describe, it, expect } from "vitest";
import { diffLayoutConfigs, diffTrees } from "../client/src/lib/layout-diff";
import { findNode, sanitizeTree, type LNode } from "../client/src/lib/layout-tree";
import { DEFAULT_LAYOUT, layoutTree, layoutVariant, sanitizeLayout, variantMatches, type LayoutConfig } from "../client/src/lib/layout-config";
import { DEFAULT_LAYOUT_REVS, DEFAULT_LAYOUTS } from "../client/src/lib/layouts";

const tree = sanitizeTree({
  id: "r", el: "panel", tag: "div", children: [
    { id: "a", el: "button", tag: "button", text: "A", attrs: { class: "x", type: "button" } },
    { id: "b", el: "text", text: "B" },
    { id: "c", el: "panel", tag: "div", children: [{ id: "c1", el: "text", text: "1" }, { id: "c2", el: "text", text: "2" }] },
    { id: "d", el: "text", text: "D" },
  ],
})!;
const edit = (f: (t: LNode) => void) => { const t = structuredClone(tree); f(t); return sanitizeTree(t)!; };

describe("diffTrees", () => {
  it("lists nothing for the same tree", () => {
    expect(diffTrees(tree, structuredClone(tree))).toEqual([]);
  });

  it("lists changed fields, attributes key by key", () => {
    const b = edit((t) => { const a = findNode(t, "a")!; a.text = "Alpha"; a.attrs = { class: "y", type: "button", title: "t" }; });
    expect(diffTrees(tree, b)).toEqual([{
      id: "a", label: "<button>", kind: "changed", fields: [
        { field: "attrs.class", before: "x", after: "y" },
        { field: "attrs.title", before: undefined, after: "t" },
        { field: "text", before: "A", after: "Alpha" },
      ],
    }]);
  });

  it("lists the outermost of what was added or removed, with a count of what is inside", () => {
    const b = edit((t) => { t.children!.splice(2, 1); t.children!.push({ id: "e", el: "panel", tag: "section", children: [{ id: "e1", el: "text", text: "x" }] }); });
    expect(diffTrees(tree, b)).toEqual([
      { id: "c", label: "<div>", kind: "removed", fields: [], inside: 2 },
      { id: "e", label: "<section>", kind: "added", fields: [], inside: 1 },
    ]);
  });

  it("tells a move from the siblings that only shifted", () => {
    // d to the front: only d moved (a, b, c kept their order).
    const b = edit((t) => { const d = t.children!.pop()!; t.children!.unshift(d); });
    expect(diffTrees(tree, b)).toEqual([{ id: "d", label: "“D”", kind: "moved", fields: [{ field: "position", before: "#4", after: "#1" }] }]);
    // Into another parent.
    const c = edit((t) => { const [a] = t.children!.splice(0, 1); findNode(t, "c")!.children!.push(a); });
    expect(diffTrees(tree, c)).toEqual([{ id: "a", label: "<button>", kind: "moved", fields: [{ field: "position", before: "in r", after: "in c" }] }]);
  });
});

describe("diffLayoutConfigs", () => {
  it("lists layouts, variants, templates and settings that changed", () => {
    const a: LayoutConfig = sanitizeLayout({ blocks: { card: { tree: { id: "k", el: "panel", tag: "div" }, label: "Card" } } });
    const own = structuredClone(DEFAULT_LAYOUTS.chat);
    own.attrs = { ...(own.attrs ?? {}), "data-own": "1" };
    const b: LayoutConfig = sanitizeLayout({
      ...a,
      layouts: { chat: { tree: own, rev: DEFAULT_LAYOUT_REVS.chat } },
      variants: { composer: [{ id: "guests", label: "For guests", groups: ["guest"], themes: [], tree: DEFAULT_LAYOUTS.composer, rev: DEFAULT_LAYOUT_REVS.composer }] },
      blocks: {},
      flags: { ...DEFAULT_LAYOUT.flags, showTime: false },
    });
    const changes = diffLayoutConfigs(a, b);
    expect(changes.map((c) => [c.target, c.kind])).toEqual([
      ["layout:chat", "changed"], ["variant:composer/guests", "added"], ["block:card", "removed"], ["settings", "changed"],
    ]);
    expect(changes[0].nodes).toEqual([{ id: DEFAULT_LAYOUTS.chat.id, label: expect.any(String), kind: "changed", fields: [{ field: "attrs.data-own", before: undefined, after: "1" }] }]);
    expect(changes[3].fields).toEqual([{ field: "flags.showTime", before: true, after: false }]);
    expect(diffLayoutConfigs(b, b)).toEqual([]);
  });
});

describe("layout variants", () => {
  const variant = (id: string, groups: string[], themes: string[], mark: string) => {
    const t = structuredClone(DEFAULT_LAYOUTS.header);
    t.attrs = { ...(t.attrs ?? {}), "data-variant": mark };
    return { id, label: id, groups, themes, tree: t, rev: DEFAULT_LAYOUT_REVS.header };
  };

  it("keeps valid variants, drops the rest", () => {
    const cfg = sanitizeLayout({
      variants: {
        header: [
          variant("admins", ["admins", "Bad Group", "admins"], ["ios", "nope"], "a"),
          variant("admins", ["user"], [], "dup"),
          { ...variant("Bad Id", [], [], "x") },
          { id: "no-tree", groups: ["user"], tree: null },
          variant("off", [], [], "off"),
        ],
        nonsense: [variant("x", ["user"], [], "x")],
      },
    });
    expect(Object.keys(cfg.variants)).toEqual(["header"]);
    expect(cfg.variants.header!.map((v) => v.id)).toEqual(["admins", "off"]);
    expect(cfg.variants.header![0]).toMatchObject({ groups: ["admins"], themes: ["ios"], label: "admins" });
    expect(sanitizeLayout(cfg)).toEqual(cfg);
  });

  it("draws the first variant whose conditions all hold", () => {
    const cfg = sanitizeLayout({
      variants: { header: [variant("guest-ios", ["guest"], ["ios"], "gi"), variant("guests", ["guest"], [], "g"), variant("paper", [], ["paper"], "p"), variant("off", [], [], "off")] },
    });
    const mark = (ctx: Parameters<typeof layoutTree>[2]) => layoutTree(cfg, "header", ctx).attrs?.["data-variant"] ?? "main";
    expect(mark({ groups: ["guest"], theme: "ios" })).toBe("gi");
    expect(mark({ groups: ["guest"], theme: "paper" })).toBe("g");
    expect(mark({ groups: ["user", "admins"], theme: "paper" })).toBe("p");
    expect(mark({ groups: ["user"], theme: "ios" })).toBe("main");
    expect(mark(undefined)).toBe("main");
    expect(layoutVariant(cfg, "header", { groups: ["user"], theme: "ios" })).toBeNull();
    expect(variantMatches({ groups: [], themes: [] }, { groups: ["user"], theme: "ios" })).toBe(false);
    expect(layoutTree(cfg, "chat", { groups: ["guest"] })).toBe(DEFAULT_LAYOUTS.chat);
  });

  it("limits how many there are", () => {
    const many = Array.from({ length: 12 }, (_, i) => variant(`v${i}`, ["user"], [], String(i)));
    expect(sanitizeLayout({ variants: { header: many } }).variants.header!.length).toBe(8);
  });
});
