// The room registry (6.0): what the operator keeps about a room — a label,
// a note, tags, a member limit, a block, a pinned operator message. Rooms
// themselves stay what they were: they exist while someone is in them, and
// the server knows them only by the hash of their id (monitor/traffic.ts,
// hashRoom) — never by name, never by key. A record is keyed by that hash;
// the signaling hub enforces the block and the limit when someone joins.
//
//   ROOM_REGISTRY_FILE             explicit path, or
//   $DATA_DIR/room-registry.json   (shared by the main and the admin service), or
//   ./.m5cet/room-registry.json
//
// Written by the console and by functions (m5adm.rooms.set) through
// /api/admin/rooms/registry — both audited there.

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type RoomBlock = { reason: string; until: number | null; by: string; at: number };
export type RoomWall = { text: string; level: "info" | "success" | "warning" | "error"; by: string; at: number };

export type RoomRecord = {
  /** The room's hash (16 hex characters), as the console shows it. */
  id: string;
  label: string;
  note: string;
  tags: string[];
  /** 0 = no limit. */
  maxMembers: number;
  blocked: RoomBlock | null;
  /** Shown to everyone who joins (and sent at once to those who are in). */
  wall: RoomWall | null;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
};

export const ROOM_HASH_RE = /^[0-9a-f]{16}$/;
const MAX_RECORDS = 5_000;
const LEVELS = new Set(["info", "success", "warning", "error"]);

const env = (name: string): string => (process.env[name]?.trim() || "");

export function roomRegistryPath(): string {
  const explicit = env("ROOM_REGISTRY_FILE");
  if (explicit) return resolve(explicit);
  const dir = env("DATA_DIR");
  return dir ? resolve(dir, "room-registry.json") : resolve(process.cwd(), ".m5cet", "room-registry.json");
}

function stamp(file: string): string {
  try { const st = statSync(file); return `${st.mtimeMs}:${st.size}:${st.ino}`; } catch { return ""; }
}

const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max) : "");

/** A patch from the console or a function, cleaned; `undefined` fields keep what is there. */
export type RoomPatch = Partial<Pick<RoomRecord, "label" | "note" | "tags" | "maxMembers">> & {
  blocked?: { reason?: string; until?: number | null } | null;
  wall?: { text: string; level?: string } | null;
};

export class RoomRegistry {
  private cache: { records: Map<string, RoomRecord>; stamp: string; file: string } | null = null;

  private load(): Map<string, RoomRecord> {
    const file = roomRegistryPath();
    const now = stamp(file);
    if (this.cache && this.cache.stamp === now && this.cache.file === file) return this.cache.records;
    const records = new Map<string, RoomRecord>();
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as { rooms?: RoomRecord[] };
      for (const r of data.rooms ?? []) if (r && ROOM_HASH_RE.test(r.id)) records.set(r.id, r);
    } catch { /* none yet */ }
    this.cache = { records, stamp: now, file };
    return records;
  }

  private save(records: Map<string, RoomRecord>): void {
    const file = roomRegistryPath();
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, rooms: [...records.values()] }), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, file);
    this.cache = null;
  }

  list(): RoomRecord[] { return [...this.load().values()].sort((a, b) => b.updatedAt - a.updatedAt); }
  get(id: string): RoomRecord | null { return this.load().get(id) ?? null; }

  /** Creates or updates the record of a room; returns it. Throws on a bad id or a full registry. */
  set(id: string, patch: RoomPatch, actor: string, now = Date.now()): RoomRecord {
    if (!ROOM_HASH_RE.test(id)) throw new Error("a room is its 16-character hash (as the console shows it)");
    const records = new Map(this.load());
    const prev = records.get(id);
    if (!prev && records.size >= MAX_RECORDS) throw new Error(`the registry holds ${MAX_RECORDS} rooms at most`);
    const next: RoomRecord = {
      id,
      label: patch.label !== undefined ? text(patch.label, 80) : prev?.label ?? "",
      note: patch.note !== undefined ? text(patch.note, 2000) : prev?.note ?? "",
      tags: patch.tags !== undefined ? [...new Set((Array.isArray(patch.tags) ? patch.tags : []).map((t) => text(t, 32)).filter(Boolean))].slice(0, 20) : prev?.tags ?? [],
      maxMembers: patch.maxMembers !== undefined ? Math.max(0, Math.min(10_000, Math.floor(Number(patch.maxMembers) || 0))) : prev?.maxMembers ?? 0,
      blocked: patch.blocked === undefined ? prev?.blocked ?? null
        : patch.blocked === null ? null
        : { reason: text(patch.blocked.reason, 200), until: typeof patch.blocked.until === "number" && patch.blocked.until > now ? Math.floor(patch.blocked.until) : null, by: actor, at: now },
      wall: patch.wall === undefined ? prev?.wall ?? null
        : patch.wall === null || !text(patch.wall.text, 2000) ? null
        : { text: text(patch.wall.text, 2000), level: (LEVELS.has(String(patch.wall.level)) ? patch.wall.level : "info") as RoomWall["level"], by: actor, at: now },
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      updatedBy: actor,
    };
    records.set(id, next);
    this.save(records);
    return next;
  }

  delete(id: string): boolean {
    const records = new Map(this.load());
    if (!records.delete(id)) return false;
    this.save(records);
    return true;
  }

  /** The block in force for a room (an expired one is not), or null. */
  blockOf(id: string, now = Date.now()): RoomBlock | null {
    const b = this.get(id)?.blocked;
    return b && (b.until === null || b.until > now) ? b : null;
  }
}

export const roomRegistry = new RoomRegistry();
