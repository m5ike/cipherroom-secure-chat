// @vitest-environment node
//
// 3-way merge of layout trees (client/src/lib/layout-merge.ts, 4.13): an
// operator's layout and the app's updated default, both made from the old
// default, combined element by element — and the archive of every default
// the app shipped, which the server merges from.

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { mergeTrees, stableJson } from "../client/src/lib/layout-merge";
import { findNode, sanitizeTree, walkTree, type LNode } from "../client/src/lib/layout-tree";
import { DEFAULT_LAYOUT_REVS, DEFAULT_LAYOUTS, LAYOUT_IDS } from "../client/src/lib/layouts";

const clone = <T,>(v: T): T => structuredClone(v);
const base: LNode = sanitizeTree({
  id: "root", el: "panel", tag: "div", attrs: { class: "box" }, children: [
    { id: "title", el: "heading", tag: "h2", text: "Hello" },
    { id: "row", el: "row", tag: "div", children: [
      { id: "a", el: "button", tag: "button", text: "A", attrs: { type: "button" } },
      { id: "b", el: "button", tag: "button", text: "B" },
      { id: "c", el: "button", tag: "button", text: "C" },
    ] },
    { id: "foot", el: "panel", tag: "footer", children: [{ id: "note", el: "text", text: "note" }] },
  ],
})!;
const ids = (t: LNode) => { const out: string[] = []; walkTree(t, (n) => out.push(n.id)); return out; };
const kidIds = (t: LNode, id: string) => (findNode(t, id)!.children ?? []).map((c) => c.id);
const edit = (t: LNode, f: (x: LNode) => void) => { const x = clone(t); f(x); return sanitizeTree(x)!; };

describe("mergeTrees", () => {
  it("keeps what nobody changed; one side's changes pass through", () => {
    expect(mergeTrees(base, base, base)).toEqual({ tree: base, conflicts: [], changed: false });
    const ours = edit(base, (t) => { findNode(t, "title")!.text = "Hi"; });
    expect(mergeTrees(base, ours, base).tree).toEqual(ours);
    const theirs = edit(base, (t) => { findNode(t, "b")!.attrs = { class: "primary" }; });
    const r = mergeTrees(base, base, theirs);
    expect(r.tree).toEqual(theirs);
    expect(r.changed).toBe(true);
  });

  it("combines changes of different fields and of different attributes of one element", () => {
    const ours = edit(base, (t) => { findNode(t, "a")!.attrs!.class = "big"; findNode(t, "title")!.tag = "h1"; });
    const theirs = edit(base, (t) => { findNode(t, "a")!.attrs!["aria-label"] = "Alpha"; findNode(t, "title")!.text = "Welcome"; });
    const r = mergeTrees(base, ours, theirs);
    expect(r.conflicts).toEqual([]);
    expect(findNode(r.tree, "a")!.attrs).toEqual({ type: "button", class: "big", "aria-label": "Alpha" });
    expect(findNode(r.tree, "title")).toMatchObject({ tag: "h1", text: "Welcome" });
  });

  it("keeps the operator's value when both changed the same thing, and reports it", () => {
    const ours = edit(base, (t) => { findNode(t, "title")!.text = "Mine"; findNode(t, "a")!.attrs!.type = "submit"; });
    const theirs = edit(base, (t) => { findNode(t, "title")!.text = "Theirs"; findNode(t, "a")!.attrs!.type = "reset"; });
    const r = mergeTrees(base, ours, theirs);
    expect(findNode(r.tree, "title")!.text).toBe("Mine");
    expect(r.conflicts).toEqual([
      { id: "title", field: "text", kind: "field", ours: "Mine", theirs: "Theirs" },
      { id: "a", field: "attrs.type", kind: "field", ours: "submit", theirs: "reset" },
    ]);
  });

  it("puts what the app added next to the same neighbours, beside what the operator added", () => {
    const ours = edit(base, (t) => { findNode(t, "row")!.children!.unshift({ id: "mine", el: "button", tag: "button", text: "M" }); });
    const theirs = edit(base, (t) => {
      findNode(t, "row")!.children!.splice(2, 0, { id: "new", el: "button", tag: "button", text: "N" });
      t.children!.push({ id: "extra", el: "paragraph", tag: "p", text: "x" });
    });
    const r = mergeTrees(base, ours, theirs);
    expect(r.conflicts).toEqual([]);
    expect(kidIds(r.tree, "row")).toEqual(["mine", "a", "b", "new", "c"]);
    expect(kidIds(r.tree, "root")).toEqual(["title", "row", "foot", "extra"]);
  });

  it("removes what one side removed and the other left alone", () => {
    const ours = edit(base, (t) => { findNode(t, "row")!.children!.splice(0, 1); });
    const theirs = edit(base, (t) => { t.children!.splice(2, 1); });
    const r = mergeTrees(base, ours, theirs);
    expect(r.conflicts).toEqual([]);
    expect(ids(r.tree)).toEqual(["root", "title", "row", "b", "c"]);
  });

  it("a removal against a change: the operator's removal stands, the app's removal of their work does not", () => {
    // The operator removed the footer; the app changed its note → stays removed, reported.
    const ours1 = edit(base, (t) => { t.children!.splice(2, 1); });
    const theirs1 = edit(base, (t) => { findNode(t, "note")!.text = "changed"; findNode(t, "foot")!.children!.push({ id: "more", el: "text", text: "more" }); });
    const r1 = mergeTrees(base, ours1, theirs1);
    expect(findNode(r1.tree, "foot")).toBeNull();
    expect(findNode(r1.tree, "more")).toBeNull();
    expect(r1.conflicts.map((c) => [c.id, c.kind])).toEqual(expect.arrayContaining([["note", "removed-by-you"], ["foot", "removed-by-you"]]));
    // The app removed the footer the operator restyled → kept whole, reported.
    const ours2 = edit(base, (t) => { findNode(t, "foot")!.attrs = { class: "mine" }; });
    const theirs2 = edit(base, (t) => { t.children!.splice(2, 1); });
    const r2 = mergeTrees(base, ours2, theirs2);
    expect(kidIds(r2.tree, "foot")).toEqual(["note"]);
    expect(r2.conflicts).toEqual([{ id: "foot", field: "deleted", kind: "removed-by-app", ours: { el: "panel", tag: "footer", attrs: { class: "mine" } } }]);
  });

  it("keeps moves and reordering of one side", () => {
    // The operator moved the title into the footer; the app changed its text.
    const ours = edit(base, (t) => { const [title] = t.children!.splice(0, 1); findNode(t, "foot")!.children!.push(title); });
    const theirs = edit(base, (t) => { findNode(t, "title")!.text = "New"; });
    const r = mergeTrees(base, ours, theirs);
    expect(kidIds(r.tree, "foot")).toEqual(["note", "title"]);
    expect(findNode(r.tree, "title")!.text).toBe("New");
    // The app reordered the buttons; the operator did not → the app's order.
    const theirs2 = edit(base, (t) => { findNode(t, "row")!.children!.reverse(); });
    const ours2 = edit(base, (t) => { findNode(t, "b")!.text = "Bee"; });
    expect(kidIds(mergeTrees(base, ours2, theirs2).tree, "row")).toEqual(["c", "b", "a"]);
    // Both reordered → the operator's.
    const ours3 = edit(base, (t) => { const r = findNode(t, "row")!; r.children = [r.children![1], r.children![0], r.children![2]]; });
    expect(kidIds(mergeTrees(base, ours3, theirs2).tree, "row")).toEqual(["b", "a", "c"]);
  });

  it("never makes a loop when each side moved one element into the other", () => {
    const loopBase = sanitizeTree({ id: "r", el: "panel", tag: "div", children: [{ id: "x", el: "panel", tag: "div", children: [] }, { id: "y", el: "panel", tag: "div", children: [] }] })!;
    const ours = edit(loopBase, (t) => { const [x] = t.children!.splice(0, 1); t.children![0].children!.push(x); }); // x into y
    const theirs = edit(loopBase, (t) => { const [, y] = t.children!.splice(0, 2); t.children = [{ ...clone(loopBase.children![0]), children: [y] }]; }); // y into x
    const r = mergeTrees(loopBase, ours, theirs);
    expect(ids(r.tree).sort()).toEqual(["r", "x", "y"]);
    expect(stableJson(r.tree)).toBe(stableJson(ours));
    expect(r.conflicts.some((c) => c.kind === "parent")).toBe(true);
  });

  it("follows a renamed outermost element", () => {
    const ours = edit(base, (t) => { t.id = "my-root"; });
    const theirs = edit(base, (t) => { t.children!.push({ id: "extra", el: "paragraph", tag: "p", text: "x" }); });
    const r = mergeTrees(base, ours, theirs);
    expect(r.tree.id).toBe("my-root");
    expect(kidIds(r.tree, "my-root")).toEqual(["title", "row", "foot", "extra"]);
  });

  it("merges every app layout with itself and with one-sided changes", () => {
    for (const id of LAYOUT_IDS) {
      const d = DEFAULT_LAYOUTS[id];
      expect(mergeTrees(d, d, d).tree, id).toEqual(d);
      // A name (a group has no element of its own, so no attributes to change).
      const ours = edit(d, (t) => { t.name = "Mine"; });
      const theirs = edit(d, (t) => { t.children = [...(t.children ?? []), { id: "zz-new", el: "text", text: "new" }]; });
      const r = mergeTrees(d, ours, theirs);
      expect(r.conflicts, id).toEqual([]);
      expect(r.tree.name, id).toBe("Mine");
      expect(r.tree.children!.at(-1)!.id, id).toBe("zz-new");
    }
  });
});

describe("mergeTrees on the app's layouts with generated edits", () => {
  let seed = 7;
  const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  it("keeps every change of both sides when they touch different elements", () => {
    for (let round = 0; round < 40; round++) {
      for (const id of LAYOUT_IDS) {
        const d = DEFAULT_LAYOUTS[id];
        const all = ids(d);
        const mark = (t: LNode, who: string, pickIds: string[]) => edit(t, (x) => { walkTree(x, (n) => { if (pickIds.includes(n.id) && n.el !== "text" && n.el !== "group") n.name = `${who}-${n.id}`; }); });
        const shuffled = [...all].sort(() => rnd() - 0.5);
        const mine = shuffled.slice(0, 4);
        const theirsIds = shuffled.slice(4, 8);
        let ours = mark(d, "o", mine);
        let theirs = mark(d, "t", theirsIds);
        // The app adds an element into a random container; the operator one into another.
        const containers = all.filter((x) => findNode(d, x)!.children !== undefined && findNode(d, x)!.el !== "select");
        const tc = containers[Math.floor(rnd() * containers.length)];
        const oc = containers[Math.floor(rnd() * containers.length)];
        theirs = edit(theirs, (x) => { findNode(x, tc)!.children!.splice(Math.floor(rnd() * 3), 0, { id: "zz-app", el: "text", text: "app" }); });
        ours = edit(ours, (x) => { findNode(x, oc)!.children!.push({ id: "zz-mine", el: "text", text: "mine" }); });
        const r = mergeTrees(d, ours, theirs);
        expect(r.conflicts, id).toEqual([]);
        for (const m of mine) { const n = findNode(r.tree, m)!; if (n.el !== "text" && n.el !== "group") expect(n.name, `${id} ${m}`).toBe(`o-${m}`); }
        for (const m of theirsIds) { const n = findNode(r.tree, m)!; if (n.el !== "text" && n.el !== "group") expect(n.name, `${id} ${m}`).toBe(`t-${m}`); }
        expect(kidIds(r.tree, tc), id).toContain("zz-app");
        expect(kidIds(r.tree, oc), id).toContain("zz-mine");
        expect(ids(r.tree).length, id).toBe(all.length + 2);
        expect(sanitizeTree(r.tree), id).toEqual(r.tree);
      }
    }
  });
});

describe("the archive of the app's default layouts", () => {
  const archive = JSON.parse(readFileSync(new URL("../server/layout-archive.json", import.meta.url), "utf8")) as Record<string, { layout: string; version: string; tree: LNode }>;
  it("has every current default (run: npx tsx script/archive-layouts.ts)", () => {
    for (const id of LAYOUT_IDS) {
      const entry = archive[DEFAULT_LAYOUT_REVS[id]];
      expect(entry, `${id} ${DEFAULT_LAYOUT_REVS[id]}`).toBeDefined();
      expect(entry.layout).toBe(id);
      expect(entry.tree).toEqual(DEFAULT_LAYOUTS[id]);
    }
  });
});
