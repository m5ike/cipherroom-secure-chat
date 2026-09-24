// @vitest-environment node
//
// The layout store and the builder's admin routes (server/layout.ts, 4.13):
// every save kept in the history with who saved it and what changed,
// differences and rolling back, operator layouts merged with an updated app
// default (3-way; conflict-free ones served merged at once), the merge the
// builder asks for, and pasted HTML converted to a tree.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { applyUpdates, LayoutStore, registerAdminLayoutRoutes, layoutStore } from "../server/layout";
import { DEFAULT_LAYOUT, sanitizeLayout, type LayoutConfig } from "../client/src/lib/layout-config";
import { findNode, sanitizeTree, treeRev, type LNode } from "../client/src/lib/layout-tree";
import { DEFAULT_LAYOUT_REVS, DEFAULT_LAYOUTS } from "../client/src/lib/layouts";

let dir = "";
const saved = { file: process.env.LAYOUT_DATA_FILE, history: process.env.LAYOUT_HISTORY_FILE };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "m5-layout-"));
  process.env.LAYOUT_DATA_FILE = join(dir, "layout.json");
  delete process.env.LAYOUT_HISTORY_FILE;
});
afterEach(() => {
  if (saved.file === undefined) delete process.env.LAYOUT_DATA_FILE; else process.env.LAYOUT_DATA_FILE = saved.file;
  if (saved.history === undefined) delete process.env.LAYOUT_HISTORY_FILE; else process.env.LAYOUT_HISTORY_FILE = saved.history;
});

const withChat = (mark: string): LayoutConfig => {
  const tree = structuredClone(DEFAULT_LAYOUTS.chat);
  tree.attrs = { ...(tree.attrs ?? {}), "data-mark": mark };
  return sanitizeLayout({ layouts: { chat: { tree, rev: DEFAULT_LAYOUT_REVS.chat } } });
};

describe("LayoutStore history", () => {
  it("keeps every save with who saved it and what changed; the first one keeps the version before too", () => {
    const store = new LayoutStore();
    expect(store.set(withChat("a"), { actor: "ann", action: "save" }).ok).toBe(true);
    expect(store.set(withChat("a"), { actor: "ann", action: "save" }).ok).toBe(true); // nothing changed: not kept
    expect(store.set(withChat("b"), { actor: "bob", action: "save", note: "second" }).ok).toBe(true);
    const list = store.history.list();
    expect(list.map((e) => [e.action, e.actor, e.changed])).toEqual([
      ["save", "bob", ["layout:chat"]],
      ["save", "ann", ["layout:chat"]],
      ["initial", "", []],
    ]);
    expect(list[0].note).toBe("second");
    expect(store.history.get(list[1].id)!.config.layouts.chat!.tree.attrs!["data-mark"]).toBe("a");
    expect(store.history.previous(list[0].id)!.id).toBe(list[1].id);
    const file = join(dir, "layout-history.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8")).entries).toHaveLength(3);
  });

  it("keeps the newest 50", () => {
    const store = new LayoutStore();
    for (let i = 0; i < 55; i++) store.set(withChat(`v${i}`), { actor: "x", action: "save" });
    const list = store.history.list();
    expect(list).toHaveLength(50);
    expect(store.history.get(list[0].id)!.config.layouts.chat!.tree.attrs!["data-mark"]).toBe("v54");
  });
});

describe("app updates merged into operator layouts", () => {
  // The "old default": today's chat without its last element (the update added it).
  const oldDefault: LNode = (() => { const t = structuredClone(DEFAULT_LAYOUTS.chat); t.children = t.children!.slice(0, -1); return sanitizeTree(t)!; })();
  const oldRev = treeRev(oldDefault);
  const baseOf = (id: string, rev: string) => (id === "chat" && rev === oldRev ? oldDefault : null);
  const added = DEFAULT_LAYOUTS.chat.children!.at(-1)!.id;

  it("merges without conflicts: the operator's change and the app's new element, with the new revision", () => {
    const ours = structuredClone(oldDefault);
    ours.attrs = { ...(ours.attrs ?? {}), "data-mine": "1" };
    const stored = sanitizeLayout({ layouts: { chat: { tree: ours, rev: oldRev } } });
    const { layout, updates } = applyUpdates(stored, baseOf);
    expect(updates).toEqual([{ target: "layout:chat", layout: "chat", from: oldRev, to: DEFAULT_LAYOUT_REVS.chat, status: "merged" }]);
    expect(layout.layouts.chat!.rev).toBe(DEFAULT_LAYOUT_REVS.chat);
    expect(layout.layouts.chat!.tree.attrs!["data-mine"]).toBe("1");
    expect(findNode(layout.layouts.chat!.tree, added)).not.toBeNull();
    expect(stored.layouts.chat!.rev).toBe(oldRev); // the stored one is not changed
  });

  it("keeps the operator's layout when both changed the same thing, and says so", () => {
    // The old default had data-x="base" on the outermost element; the update removed it, the operator changed it.
    const base = structuredClone(oldDefault);
    base.attrs = { ...(base.attrs ?? {}), "data-x": "base" };
    const ours = structuredClone(base);
    ours.attrs = { ...(ours.attrs ?? {}), "data-x": "mine" };
    const baseRev = treeRev(sanitizeTree(base)!);
    const stored = sanitizeLayout({ layouts: { chat: { tree: ours, rev: baseRev } } });
    const { layout, updates } = applyUpdates(stored, (_id, rev) => (rev === baseRev ? sanitizeTree(base) : null));
    expect(updates[0].status).toBe("conflicts");
    expect(updates[0].conflicts).toEqual([{ id: ours.id, field: "attrs.data-x", kind: "field", ours: "mine", theirs: undefined }]);
    expect(layout).toBe(stored);
  });

  it("reports a layout whose old default is unknown, and merges variants too", () => {
    const v = { id: "guests", label: "Guests", groups: ["guest"], themes: [], tree: oldDefault, rev: oldRev };
    const stored = sanitizeLayout({ layouts: { chat: { tree: DEFAULT_LAYOUTS.chat, rev: "zzzz" } }, variants: { chat: [v] } });
    const { layout, updates } = applyUpdates(stored, baseOf);
    expect(updates.map((u) => [u.target, u.status])).toEqual([["layout:chat", "unknown-base"], ["variant:chat/guests", "merged"]]);
    expect(findNode(layout.variants.chat![0].tree, added)).not.toBeNull();
    expect(applyUpdates(DEFAULT_LAYOUT).updates).toEqual([]);
  });
});

describe("admin layout routes", () => {
  let base = "";
  let close: (() => void) | null = null;
  beforeEach(async () => {
    const app = express();
    app.use(express.json({ limit: "4mb" }));
    app.use((_req, res, next) => { res.locals.adminName = "tester"; next(); });
    registerAdminLayoutRoutes(app);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    close = () => server.close();
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => { close?.(); close = null; });
  const call = async (path: string, init?: { method?: string; body?: unknown }) => {
    const r = await fetch(base + path, { method: init?.method ?? "GET", headers: { "Content-Type": "application/json" }, body: init?.body === undefined ? undefined : JSON.stringify(init.body) });
    return { status: r.status, json: await r.json() as Record<string, unknown> };
  };

  it("saves with the actor, lists versions, shows differences and restores", async () => {
    expect((await call("/admin/layout", { method: "PUT", body: { layout: withChat("one") } })).status).toBe(200);
    expect((await call("/admin/layout", { method: "PUT", body: { layout: withChat("two") } })).status).toBe(200);
    const list = (await call("/admin/layout/history")).json.entries as Array<{ id: string; actor: string; action: string }>;
    expect(list.map((e) => [e.action, e.actor])).toEqual([["save", "tester"], ["save", "tester"], ["initial", ""]]);
    const older = list[1].id;
    const vsCurrent = (await call(`/admin/layout/history/${older}/diff`)).json.changes as Array<{ target: string; nodes: Array<{ fields: Array<{ field: string; before: unknown; after: unknown }> }> }>;
    expect(vsCurrent[0].target).toBe("layout:chat");
    expect(vsCurrent[0].nodes[0].fields).toEqual([{ field: "attrs.data-mark", before: "two", after: "one" }]);
    const vsPrevious = (await call(`/admin/layout/history/${older}/diff?against=previous`)).json.changes as Array<{ target: string }>;
    expect(vsPrevious.map((c) => c.target)).toEqual(["layout:chat"]);
    const restored = await call(`/admin/layout/history/${older}/restore`, { method: "POST" });
    expect(restored.status).toBe(200);
    expect(((restored.json.layout as LayoutConfig).layouts.chat!.tree.attrs as Record<string, string>)["data-mark"]).toBe("one");
    const after = (await call("/admin/layout/history")).json.entries as Array<{ action: string; note: string }>;
    expect(after[0].action).toBe("restore");
    expect(after[0].note).toMatch(/the version of .* by tester/);
    expect((await call("/admin/layout/history/nope")).status).toBe(404);
    expect(layoutStore.get().layouts.chat!.tree.attrs!["data-mark"]).toBe("one");
  });

  it("merges on request, and refuses an unknown old default", async () => {
    const same = await call("/admin/layout/merge", { method: "POST", body: { layout: "chat", tree: DEFAULT_LAYOUTS.chat, rev: DEFAULT_LAYOUT_REVS.chat } });
    expect(same.json).toMatchObject({ ok: true, conflicts: [], changed: false });
    const unknown = await call("/admin/layout/merge", { method: "POST", body: { layout: "chat", tree: DEFAULT_LAYOUTS.chat, rev: "zzz" } });
    expect(unknown.status).toBe(409);
    expect((await call("/admin/layout/merge", { method: "POST", body: { layout: "nope", tree: {} } })).status).toBe(400);
  });

  it("converts pasted HTML", async () => {
    const r = await call("/admin/layout/from-html", { method: "POST", body: { html: "<div class=\"a\"><b>x</b><script>1</script></div>" } });
    expect(r.json).toMatchObject({ ok: true, count: 3 });
    expect((r.json.tree as LNode).el).toBe("panel");
    expect(r.json.warnings).toEqual(["<script> removed"]);
    expect((await call("/admin/layout/from-html", { method: "POST", body: { html: " " } })).status).toBe(400);
  });

  it("offers the groups a variant may be for", async () => {
    const r = await call("/admin/layout");
    const groups = (r.json.catalog as { groups: Array<{ id: string }> }).groups.map((g) => g.id);
    expect(groups.slice(0, 2)).toEqual(["guest", "user"]);
    expect(r.json.updates).toEqual([]);
  });
});
