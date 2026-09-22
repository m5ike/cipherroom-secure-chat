// Layout / template configuration: persisted JSON edited in the admin
// "Layout builder", served to every client at GET /api/layout.
//
//   LAYOUT_DATA_FILE           explicit path, or
//   $DATA_DIR/layout.json      (Docker: the shared m5cet-data volume), or
//   ./.m5cet/layout.json
//
// Validation is the SAME pure module the client uses (sanitizeLayout), so an
// operator can only store hex colours, bounded numbers and short text
// templates — never markup. The app and admin are separate processes: the
// admin writes, the app re-reads when the file's mtime changes.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Express, Request, Response } from "express";
import { DEFAULT_LAYOUT, sanitizeLayout, type LayoutConfig } from "../client/src/lib/layout-config";

const env = (name: string): string => (process.env[name]?.trim() || "");

export function layoutFilePath(): string {
  const explicit = env("LAYOUT_DATA_FILE");
  if (explicit) return resolve(explicit);
  const dir = env("DATA_DIR");
  return dir ? resolve(dir, "layout.json") : resolve(process.cwd(), ".m5cet", "layout.json");
}

/** Content signature ("" when missing) — mtime alone misses same-tick writes. */
function fileSig(): string {
  try { return createHash("sha1").update(readFileSync(layoutFilePath())).digest("hex"); } catch { return ""; }
}

export class LayoutStore {
  private cache: { layout: LayoutConfig; sig: string; file: string } | null = null;
  private lastSaveError = "";

  /** Current layout (defaults when nothing is stored); reloads on file change. */
  get(): LayoutConfig {
    const file = layoutFilePath();
    const sig = fileSig();
    if (this.cache && this.cache.sig === sig && this.cache.file === file) return this.cache.layout;
    let layout = DEFAULT_LAYOUT;
    try { layout = sanitizeLayout(JSON.parse(readFileSync(file, "utf8"))); } catch { /* missing or corrupt → defaults */ }
    this.cache = { layout, sig, file };
    return layout;
  }

  set(raw: unknown): { ok: true; layout: LayoutConfig } | { ok: false; message: string } {
    const layout = { ...sanitizeLayout(raw), updatedAt: Date.now() };
    const file = layoutFilePath();
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(layout, null, 2), { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, file);
      this.lastSaveError = "";
      this.cache = null;
      return { ok: true, layout };
    } catch (err) {
      this.lastSaveError = `cannot write ${file}: ${(err as Error).message}`;
      return { ok: false, message: this.lastSaveError };
    }
  }

  reset(): { ok: true; layout: LayoutConfig } | { ok: false; message: string } {
    return this.set(DEFAULT_LAYOUT);
  }

  get saveError(): string { return this.lastSaveError; }
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

/** Admin (mount AFTER auth): read / save / reset the layout. */
export function registerAdminLayoutRoutes(app: Express): void {
  app.get("/admin/layout", (_req, res) => {
    res.json({ ok: true, layout: layoutStore.get(), defaults: DEFAULT_LAYOUT, file: layoutStore.file, lastSaveError: layoutStore.saveError });
  });
  app.put("/admin/layout", (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const r = layoutStore.set(body.layout ?? body);
    if (!r.ok) return res.status(500).json({ ok: false, message: r.message });
    res.json({ ok: true, layout: r.layout });
  });
  app.post("/admin/layout/reset", (_req, res) => {
    const r = layoutStore.reset();
    if (!r.ok) return res.status(500).json({ ok: false, message: r.message });
    res.json({ ok: true, layout: r.layout });
  });
}
