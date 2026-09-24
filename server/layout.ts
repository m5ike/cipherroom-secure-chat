// Layout / template configuration: persisted JSON edited in the admin
// "Layout builder", served to every client at GET /api/layout.
//
//   LAYOUT_DATA_FILE           explicit path, or
//   $DATA_DIR/layout.json      (Docker: the shared m5cet-data volume), or
//   ./.m5cet/layout.json
//
// Validation is the SAME pure module the client uses (sanitizeLayout), so an
// operator can only store hex colours, bounded numbers, short text templates
// and (4.0.5) element trees of the known palette — never markup or script.
// The app and admin are separate processes: the admin writes, the app
// re-reads when the file's mtime changes.
//
// 4.13: an operator's layout designed from an app default that an update
// has since changed is merged with the new default (3-way, layout-merge.ts;
// the old default comes from layout-archive.json by its revision). Without
// conflicts both services serve the merged layout at once; with conflicts
// the operator's stays as it is and the builder offers the merge. Every save
// is kept in the history (layout-history.ts) with who saved it.

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Express, Request, Response } from "express";
import { DEFAULT_LAYOUT, sanitizeLayout, type LayoutConfig } from "../client/src/lib/layout-config";
import { diffLayoutConfigs } from "../client/src/lib/layout-diff";
import { mergeTrees, type MergeConflict } from "../client/src/lib/layout-merge";
import { sanitizeTree, type LNode } from "../client/src/lib/layout-tree";
import { DEFAULT_LAYOUT_REVS, DEFAULT_LAYOUTS, LAYOUT_IDS, isLayoutId, type LayoutId } from "../client/src/lib/layouts";
import { htmlToTree, HTML_IMPORT_MAX } from "../client/src/lib/html-to-tree";
import { layoutCatalog } from "./layout-catalog";
import { LayoutHistory, layoutHistoryPath, type HistoryAction } from "./layout-history";
import archiveJson from "./layout-archive.json";

/** Every default layout the app shipped, by revision (script/archive-layouts.ts). */
const ARCHIVE = archiveJson as unknown as Record<string, { layout: string; version: string; tree: LNode }>;

/** The app default a layout with this revision was designed from, if the archive has it. */
export function archivedDefault(id: LayoutId, rev: string): LNode | null {
  const e = Object.prototype.hasOwnProperty.call(ARCHIVE, rev) ? ARCHIVE[rev] : undefined;
  return e && e.layout === id ? e.tree : null;
}

/** A layout (or a variant) designed from an older app default, and what became of it. */
export type LayoutUpdate = {
  target: string;
  layout: LayoutId;
  variant?: string;
  from: string;
  to: string;
  /** merged: served merged now; conflicts: the operator's kept, the builder offers the merge; unknown-base: the old default is not in the archive. */
  status: "merged" | "conflicts" | "unknown-base";
  conflicts?: MergeConflict[];
};

/** The configuration with every conflict-free merge applied (the stored one is not changed). */
export function applyUpdates(stored: LayoutConfig, baseOf: (id: LayoutId, rev: string) => LNode | null = archivedDefault): { layout: LayoutConfig; updates: LayoutUpdate[] } {
  const updates: LayoutUpdate[] = [];
  let layout = stored;
  const own = () => { if (layout === stored) layout = { ...stored, layouts: { ...stored.layouts }, variants: { ...stored.variants } }; return layout; };
  for (const id of LAYOUT_IDS) {
    const to = DEFAULT_LAYOUT_REVS[id];
    const one = (tree: LNode, from: string, target: string, variant?: string): LNode | null => {
      if (!from || from === to) return null;
      const base = baseOf(id, from);
      if (!base) { updates.push({ target, layout: id, variant, from, to, status: "unknown-base" }); return null; }
      const r = mergeTrees(base, tree, DEFAULT_LAYOUTS[id]);
      if (r.conflicts.length) { updates.push({ target, layout: id, variant, from, to, status: "conflicts", conflicts: r.conflicts }); return null; }
      updates.push({ target, layout: id, variant, from, to, status: "merged" });
      return r.tree;
    };
    const saved = stored.layouts[id];
    if (saved) {
      const merged = one(saved.tree, saved.rev, `layout:${id}`);
      if (merged) own().layouts[id] = { tree: merged, rev: to };
    }
    const list = stored.variants?.[id];
    if (list?.length) {
      let next: typeof list | null = null;
      list.forEach((v, i) => {
        const merged = one(v.tree, v.rev, `variant:${id}/${v.id}`, v.id);
        if (merged) { next = next ?? [...list]; next[i] = { ...v, tree: merged, rev: to }; }
      });
      if (next) own().variants[id] = next;
    }
  }
  return { layout, updates };
}

const env = (name: string): string => (process.env[name]?.trim() || "");

export function layoutFilePath(): string {
  const explicit = env("LAYOUT_DATA_FILE");
  if (explicit) return resolve(explicit);
  const dir = env("DATA_DIR");
  return dir ? resolve(dir, "layout.json") : resolve(process.cwd(), ".m5cet", "layout.json");
}

/** mtime, size and inode ("" when missing). Saves are atomic renames, so a
 *  write always shows as a new inode — no need to hash the file on every
 *  GET /api/layout, as this used to. */
function fileSig(): string {
  try { const st = statSync(layoutFilePath()); return `${st.mtimeMs}:${st.size}:${st.ino}`; } catch { return ""; }
}

export type SaveMeta = { actor: string; action: HistoryAction; note?: string };

export class LayoutStore {
  private cache: { layout: LayoutConfig; updates: LayoutUpdate[]; sig: string; file: string } | null = null;
  private lastSaveError = "";
  private lastHistoryError = "";
  readonly history = new LayoutHistory(() => layoutHistoryPath(layoutFilePath()));

  private load() {
    const file = layoutFilePath();
    const sig = fileSig();
    if (this.cache && this.cache.sig === sig && this.cache.file === file) return this.cache;
    let stored = DEFAULT_LAYOUT;
    try { stored = sanitizeLayout(JSON.parse(readFileSync(file, "utf8"))); } catch { /* missing or corrupt → defaults */ }
    const { layout, updates } = applyUpdates(stored);
    this.cache = { layout, updates, sig, file };
    return this.cache;
  }

  /** Current layout (defaults when nothing is stored, app updates merged in); reloads on file change. */
  get(): LayoutConfig {
    return this.load().layout;
  }

  /** Layouts designed from an older app default: merged, or waiting for the operator. */
  updates(): LayoutUpdate[] {
    return this.load().updates;
  }

  set(raw: unknown, meta: SaveMeta = { actor: "", action: "save" }): { ok: true; layout: LayoutConfig } | { ok: false; message: string } {
    const before = this.get();
    const layout = { ...sanitizeLayout(raw), updatedAt: Date.now() };
    const file = layoutFilePath();
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(layout, null, 2), { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, file);
      this.lastSaveError = "";
      this.cache = null;
    } catch (err) {
      this.lastSaveError = `cannot write ${file}: ${(err as Error).message}`;
      return { ok: false, message: this.lastSaveError };
    }
    // The history never stops a save.
    try {
      if (meta.action !== "save" || diffLayoutConfigs(before, layout).length) this.history.record(before, layout, meta);
      this.lastHistoryError = "";
    } catch (err) {
      this.lastHistoryError = `history: ${(err as Error).message}`;
    }
    return { ok: true, layout };
  }

  reset(meta: Omit<SaveMeta, "action"> = { actor: "" }): { ok: true; layout: LayoutConfig } | { ok: false; message: string } {
    return this.set(DEFAULT_LAYOUT, { ...meta, action: "reset" });
  }

  get saveError(): string { return this.lastSaveError; }
  get historyError(): string { return this.lastHistoryError; }
  get file(): string { return layoutFilePath(); }
}

export const layoutStore = new LayoutStore();

/** Public: every client reads its layout here (no secrets, no auth). */
export function registerLayoutRoutes(app: Express): void {
  app.get("/api/layout", (_req, res) => {
    const layout = layoutStore.get();
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, layout });
  });
}

const actorOf = (res: Response) => String(res.locals.adminName ?? "admin");

/** Admin (mount AFTER auth): read / save / reset the layout, its history, merges and HTML import. */
export function registerAdminLayoutRoutes(app: Express): void {
  app.get("/admin/layout", (_req, res) => {
    res.json({
      ok: true, layout: layoutStore.get(), defaults: DEFAULT_LAYOUT, file: layoutStore.file, lastSaveError: layoutStore.saveError,
      historyError: layoutStore.historyError, updates: layoutStore.updates(), catalog: layoutCatalog(),
    });
  });
  app.put("/admin/layout", (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const r = layoutStore.set(body.layout ?? body, { actor: actorOf(res), action: "save", note: typeof body.note === "string" ? body.note : "" });
    if (!r.ok) return res.status(500).json({ ok: false, message: r.message });
    res.json({ ok: true, layout: layoutStore.get(), updates: layoutStore.updates() });
  });
  app.post("/admin/layout/reset", (_req, res) => {
    const r = layoutStore.reset({ actor: actorOf(res) });
    if (!r.ok) return res.status(500).json({ ok: false, message: r.message });
    res.json({ ok: true, layout: layoutStore.get(), updates: layoutStore.updates() });
  });

  // 4.13 — the history: every saved version, what it changed, rolling back.
  app.get("/admin/layout/history", (_req, res) => {
    res.json({ ok: true, entries: layoutStore.history.list(), file: layoutHistoryPath(layoutStore.file) });
  });
  app.get("/admin/layout/history/:id", (req, res) => {
    const entry = layoutStore.history.get(String(req.params.id));
    if (!entry) return res.status(404).json({ ok: false, message: "No such version." });
    res.json({ ok: true, entry });
  });
  // against=current (default): what restoring it would change; against=previous: what that save changed.
  app.get("/admin/layout/history/:id/diff", (req, res) => {
    const id = String(req.params.id);
    const entry = layoutStore.history.get(id);
    if (!entry) return res.status(404).json({ ok: false, message: "No such version." });
    const against = req.query.against === "previous" ? "previous" : "current";
    const changes = against === "previous"
      ? diffLayoutConfigs(layoutStore.history.previous(id)?.config ?? DEFAULT_LAYOUT, entry.config)
      : diffLayoutConfigs(layoutStore.get(), entry.config);
    res.json({ ok: true, against, changes });
  });
  app.post("/admin/layout/history/:id/restore", (req, res) => {
    const entry = layoutStore.history.get(String(req.params.id));
    if (!entry) return res.status(404).json({ ok: false, message: "No such version." });
    const r = layoutStore.set(entry.config, { actor: actorOf(res), action: "restore", note: `the version of ${new Date(entry.at).toISOString()}${entry.actor ? ` by ${entry.actor}` : ""}` });
    if (!r.ok) return res.status(500).json({ ok: false, message: r.message });
    res.json({ ok: true, layout: layoutStore.get(), updates: layoutStore.updates() });
  });

  // 4.13 — merge an operator's layout (or variant) with the app's current default.
  app.post("/admin/layout/merge", (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const id = body.layout;
    if (!isLayoutId(id)) return res.status(400).json({ ok: false, message: "Unknown layout." });
    const ours = sanitizeTree(body.tree);
    if (!ours) return res.status(400).json({ ok: false, message: "No tree to merge." });
    const rev = typeof body.rev === "string" ? body.rev : "";
    if (rev === DEFAULT_LAYOUT_REVS[id]) return res.json({ ok: true, tree: ours, conflicts: [], rev, changed: false });
    const base = archivedDefault(id, rev);
    if (!base) return res.status(409).json({ ok: false, message: "The app's layout this one was designed from is not in the archive (a development build?). Keep yours, or start again from the app's current one." });
    const r = mergeTrees(base, ours, DEFAULT_LAYOUTS[id]);
    res.json({ ok: true, tree: r.tree, conflicts: r.conflicts, changed: r.changed, rev: DEFAULT_LAYOUT_REVS[id], theirs: DEFAULT_LAYOUTS[id] });
  });

  // 4.13 — pasted HTML → a tree of the palette (not saved: the builder inserts it).
  app.post("/admin/layout/from-html", (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const html = typeof body.html === "string" ? body.html : "";
    if (!html.trim()) return res.status(400).json({ ok: false, message: "Paste some HTML." });
    if (html.length > HTML_IMPORT_MAX) return res.status(413).json({ ok: false, message: `The HTML is longer than ${HTML_IMPORT_MAX} characters.` });
    const r = htmlToTree(html);
    res.json({ ok: true, ...r });
  });
}
