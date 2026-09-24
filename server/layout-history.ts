// The Layout builder's history (4.13): every saved version of the layout
// configuration, who saved it and what it changed — so an operator can see
// the differences and roll back.
//
//   LAYOUT_HISTORY_FILE                      explicit path, or
//   <the layout file's folder>/layout-history.json
//
// The newest 50 versions are kept (and at most ~12 MB of them). Written
// atomically (0600), like the layout file. Only the admin service writes.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { sanitizeLayout, type LayoutConfig } from "../client/src/lib/layout-config";
import { diffLayoutConfigs } from "../client/src/lib/layout-diff";

export type HistoryAction = "initial" | "save" | "reset" | "restore";

export type HistoryEntry = {
  id: string;
  at: number;
  actor: string;
  action: HistoryAction;
  note: string;
  /** What this version changed from the one before: "layout:chat", "variant:chat/vip", "block:card", "settings". */
  changed: string[];
  config: LayoutConfig;
};
export type HistorySummary = Omit<HistoryEntry, "config"> & { size: number };

export const HISTORY_LIMITS = { entries: 50, bytes: 12 * 1024 * 1024 } as const;

export function layoutHistoryPath(layoutFile: string): string {
  const explicit = process.env.LAYOUT_HISTORY_FILE?.trim();
  return explicit ? resolve(explicit) : resolve(dirname(layoutFile), "layout-history.json");
}

export class LayoutHistory {
  constructor(private readonly fileOf: () => string) {}

  private read(): HistoryEntry[] {
    try {
      const raw = JSON.parse(readFileSync(this.fileOf(), "utf8")) as { entries?: unknown };
      if (!Array.isArray(raw.entries)) return [];
      return raw.entries.flatMap((e): HistoryEntry[] => {
        if (!e || typeof e !== "object") return [];
        const r = e as Record<string, unknown>;
        if (typeof r.id !== "string" || typeof r.at !== "number") return [];
        return [{
          id: r.id,
          at: r.at,
          actor: typeof r.actor === "string" ? r.actor.slice(0, 120) : "",
          action: (["initial", "save", "reset", "restore"] as const).find((a) => a === r.action) ?? "save",
          note: typeof r.note === "string" ? r.note.slice(0, 200) : "",
          changed: Array.isArray(r.changed) ? r.changed.filter((c): c is string => typeof c === "string").slice(0, 200) : [],
          config: sanitizeLayout(r.config),
        }];
      });
    } catch {
      return [];
    }
  }

  private write(entries: HistoryEntry[]): void {
    const file = this.fileOf();
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    // The newest versions that fit.
    let kept = entries.slice(-HISTORY_LIMITS.entries);
    let json = JSON.stringify({ version: 1, entries: kept });
    while (kept.length > 1 && json.length > HISTORY_LIMITS.bytes) {
      kept = kept.slice(1);
      json = JSON.stringify({ version: 1, entries: kept });
    }
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, json, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, file);
  }

  /**
   * Adds the version just saved. The very first time, the version before it
   * is added too (so there is something to go back to).
   */
  record(before: LayoutConfig, after: LayoutConfig, meta: { actor: string; action: HistoryAction; note?: string }): HistoryEntry {
    const entries = this.read();
    const now = Date.now();
    const newId = () => `${now.toString(36)}-${randomBytes(3).toString("hex")}`;
    if (!entries.length) {
      entries.push({ id: `${newId()}-0`, at: before.updatedAt || now - 1, actor: "", action: "initial", note: "before the first saved change", changed: [], config: before });
    }
    const previous = entries[entries.length - 1].config;
    const entry: HistoryEntry = {
      id: newId(),
      at: now,
      actor: meta.actor.slice(0, 120),
      action: meta.action,
      note: (meta.note ?? "").slice(0, 200),
      changed: diffLayoutConfigs(previous, after).map((c) => c.target),
      config: after,
    };
    entries.push(entry);
    this.write(entries);
    return entry;
  }

  /** Newest first, without the configurations. */
  list(): HistorySummary[] {
    return this.read().reverse().map(({ config, ...rest }) => ({ ...rest, size: JSON.stringify(config).length }));
  }

  get(id: string): HistoryEntry | null {
    return this.read().find((e) => e.id === id) ?? null;
  }

  /** The version saved before this one. */
  previous(id: string): HistoryEntry | null {
    const entries = this.read();
    const i = entries.findIndex((e) => e.id === id);
    return i > 0 ? entries[i - 1] : null;
  }
}
