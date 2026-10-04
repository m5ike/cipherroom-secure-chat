// The inroute table (6.9): route codes. A code (4–6 digits) names where a
// caller's audio goes — the whole room (every member connected with audio)
// or one member — for a while (TTL, default 600 s). A TSA's Route audio
// reads the code the caller typed, looks it up here and, when it is live,
// routes the audio both ways (the media part, telHooks.routeAudio).
//
// Who makes codes: a function (m5.telephony.inroute.add, the "inroute"
// right), a TSA (Add route code) and the console (tests). Where they live:
// telephony.db (tel-store's SQLite, shared by the main and the admin
// service), in a table of their own — the code is the key, so two processes
// cannot hand out the same live code (an expired one is taken over in the
// same statement).
//
// Against guessing: random codes come from crypto.randomInt and skip the
// ones a guesser tries first (0000, 1234, 9876, 1212, 123123, 19xx/20xx);
// a code lives at most permissions.inroute.maxTtlSec; one owner has at most
// maxActivePerOwner live codes; wrong codes are counted per caller number
// and hour (inrouteFailure / inrouteBlocked — route_audio refuses a caller
// past maxFailuresPerCallerPerHour). Every add, removal, use and failure is
// logged (kind "inroute") with the code MASKED ("•••••7"); only the
// console's own table shows codes in full.

import { randomInt } from "node:crypto";
import { DocTable } from "../../storage/doc-table";
import type { SqliteDatabase } from "../../storage/db";
import { telStore } from "../tel-store";
import { INROUTE_CODE, INROUTE_DEFAULT_TTL, type InrouteEntry, type InrouteType } from "./types";
import { telHooks, telLog, telPermissions } from "./hooks";
import { numberDigits } from "./match";
import { hashRoom } from "../../monitor/traffic";

export class InrouteError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "InrouteError"; }
}

type Row = InrouteEntry & { id: string; owner: string };
type FailRow = { id: string; at: number[]; last: number };

export const INROUTE_MIN_TTL = 30;
export const INROUTE_MAX_USES = 10_000;
const HOUR = 3_600_000;

/* ---------------------------------------------------------------- table */

const opened = new WeakSet<SqliteDatabase>();
/** telephony.db with this part's tables (created on first use, additively). */
function db(): SqliteDatabase | null {
  const d = telStore.handle();
  if (d && !opened.has(d)) {
    d.exec(codes.schema());
    d.exec(failures.schema());
    opened.add(d);
  }
  return d;
}

// sort = expiresAt (the sweep drops rows sorted before now); device = the owner.
const codes = new DocTable<Row>("inroute", () => db(), (v) => v.expiresAt, (v) => v.owner);
// One row per caller number: the times of its wrong codes in the last hour.
const failures = new DocTable<FailRow>("inroute_failures", () => db(), (v) => v.last, (v) => v.id);

const str = (v: unknown) => (typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v));
// eslint-disable-next-line no-control-regex
const text = (v: unknown, max: number) => str(v).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
const ownerKey = (by: InrouteEntry["createdBy"]) => `${by.kind}:${by.id}`;
const live = (r: Row | null, now = Date.now()): r is Row => Boolean(r && r.expiresAt > now);

/** The code as the log shows it: only the last digit ("•••••7"). */
export const maskCode = (code: string): string => (code.length > 1 ? "•".repeat(code.length - 1) + code.slice(-1) : "•");

/** What the API returns: the entry without the table's own columns. */
function view(r: Row): InrouteEntry {
  return { code: r.code, type: r.type, room: r.room, user: r.user, label: r.label, ttlSec: r.ttlSec, createdAt: r.createdAt, expiresAt: r.expiresAt, createdBy: { ...r.createdBy }, uses: r.uses, maxUses: r.maxUses };
}

/** The log's view: the code masked, the room as its hash (6.10 G-03: never the blind id — the log is read without the "settings" right). */
const logged = (r: Row | InrouteEntry) => ({ code: maskCode(r.code), type: r.type, room: hashRoom(r.room) ?? "", user: r.user, label: r.label, expiresAt: r.expiresAt, createdBy: r.createdBy, uses: r.uses, maxUses: r.maxUses });
/** "room <hash>" / "<member> in room <hash>" for a log line. */
const target = (r: Pick<InrouteEntry, "type" | "room" | "user">) => (r.type === "room" ? `room ${hashRoom(r.room) ?? "?"}` : `${r.user} in room ${hashRoom(r.room) ?? "?"}`);

/**
 * A code a guesser tries first: one digit repeated (0000), a run up or down
 * (1234, 7890, 9876), a repeated pair or triple (1212, 123123), a year (19xx, 20xx).
 */
export function trivialCode(code: string): boolean {
  if (/^(\d)\1+$/.test(code)) return true;
  const d = [...code].map(Number);
  const steps = d.slice(1).map((x, i) => (x - d[i] + 10) % 10);
  if (steps.every((s) => s === 1) || steps.every((s) => s === 9)) return true;
  if (/^(\d\d)\1+$/.test(code) || /^(\d{3})\1$/.test(code)) return true;
  return code.length === 4 && /^(19|20)\d\d$/.test(code);
}

/**
 * Takes the code for this row: a new one, or one whose entry has expired — in
 * one statement, so the admin and the main service never both get it.
 */
function claim(row: Row): boolean {
  const now = Date.now();
  const d = db();
  if (!d) {
    if (live(codes.get(row.id), now)) return false;
    codes.put(row);
    return true;
  }
  const r = d.prepare("INSERT INTO inroute (id, data, sort, device) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, sort = excluded.sort, device = excluded.device WHERE inroute.sort <= ?")
    .run(row.id, JSON.stringify(row), row.expiresAt, row.owner, now) as { changes: number };
  return r.changes > 0;
}

/** Removes an expired entry (not one that was just claimed again). */
function dropExpired(code: string, now = Date.now()): void {
  const d = db();
  if (!d) { if (!live(codes.get(code), now)) codes.delete(code); return; }
  d.prepare("DELETE FROM inroute WHERE id = ? AND sort <= ?").run(code, now);
}

let sweeper: ReturnType<typeof setInterval> | null = null;
function startSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => { void inrouteSweep().catch(() => undefined); }, 60_000);
  sweeper.unref?.();
}

/** Drops expired codes and failure counters older than an hour; how many codes went. */
export async function inrouteSweep(now = Date.now()): Promise<number> {
  await telStore.ready();
  const n = codes.pruneBefore(now + 1);
  failures.pruneBefore(now - HOUR);
  return n;
}

/* ------------------------------------------------------------------ API */

export type InrouteSpec = {
  /** "" / absent = a random free code of `digits` (4–6, default 6). */
  code?: string;
  digits?: number;
  type: InrouteType;
  /** The room's blind id (r3.…). */
  room: string;
  /** type "user": the member's name in the room, or an account ("@alice"). */
  user?: string;
  /** Seconds (default 600), clamped to 30 … permissions.inroute.maxTtlSec. */
  ttl?: number;
  label?: string;
  /** Removed after this many routed calls (0 = until it expires). */
  maxUses?: number;
  createdBy: InrouteEntry["createdBy"];
};

/** Adds a code; throws InrouteError (bad-argument, code-taken, inroute-limit, busy). */
export async function inrouteAdd(spec: InrouteSpec): Promise<InrouteEntry> {
  await telStore.ready();
  startSweeper();
  const limits = telPermissions().inroute;
  const type = str(spec.type) || "room";
  if (type !== "room" && type !== "user") throw new InrouteError("bad-argument", "type: room (the whole room) or user (one member)");
  const room = str(spec.room);
  if (!room || room.length > 200 || /[\s\u0000-\u001f]/.test(room)) throw new InrouteError("bad-argument", "room: the room's blind id (r3.…) — m5.caller.room in a chat run");
  const user = text(spec.user, 80);
  if (type === "user" && !user) throw new InrouteError("bad-argument", "user: the member's name in the room, or an account (@alice)");
  const ttlIn = spec.ttl === undefined || spec.ttl === null || (spec.ttl as unknown) === "" ? INROUTE_DEFAULT_TTL : Number(spec.ttl);
  if (!Number.isFinite(ttlIn)) throw new InrouteError("bad-argument", "ttl: seconds");
  const ttlSec = Math.max(INROUTE_MIN_TTL, Math.min(limits.maxTtlSec, Math.round(ttlIn)));
  const maxUses = Math.max(0, Math.min(INROUTE_MAX_USES, Math.floor(Number(spec.maxUses) || 0)));
  const createdBy: InrouteEntry["createdBy"] = { kind: spec.createdBy.kind, id: text(spec.createdBy.id, 120) || "?", ...(spec.createdBy.run ? { run: text(spec.createdBy.run, 80) } : {}) };
  const owner = ownerKey(createdBy);

  const now = Date.now();
  const mine = codes.list({ device: owner, limit: 5000, filter: (r) => r.expiresAt > now }).length;
  if (mine >= limits.maxActivePerOwner) throw new InrouteError("inroute-limit", `at most ${limits.maxActivePerOwner} live route codes per owner (Telephony › Permissions) — remove some or let them expire`);

  const make = (code: string): Row => ({
    id: code, code, type, room, user: type === "user" ? user : "", label: text(spec.label, 80), ttlSec,
    createdAt: now, expiresAt: now + ttlSec * 1000, createdBy, uses: 0, maxUses, owner,
  });

  let row: Row | null = null;
  const wanted = str(spec.code);
  if (wanted) {
    if (!INROUTE_CODE.test(wanted)) throw new InrouteError("bad-argument", "code: 4–6 digits (or empty for a random one)");
    const r = make(wanted);
    if (!claim(r)) throw new InrouteError("code-taken", "this route code is in use — choose another, or leave it empty for a random one");
    row = r;
  } else {
    const digits = Math.max(4, Math.min(6, Math.round(Number(spec.digits) || 6)));
    for (let i = 0; i < 100 && !row; i++) {
      const c = String(randomInt(0, 10 ** digits)).padStart(digits, "0");
      if (trivialCode(c)) continue;
      const r = make(c);
      if (claim(r)) row = r;
    }
    if (!row) throw new InrouteError("busy", `no free ${digits}-digit route code — too many are live (use more digits)`);
  }
  telLog({
    kind: "inroute", level: wanted && trivialCode(wanted) ? "warn" : "info",
    summary: `route code ${maskCode(row.code)} added → ${target(row)} for ${ttlSec} s by ${owner}${wanted && trivialCode(wanted) ? " (an easily guessed code)" : ""}`,
    parsed: logged(row),
  });
  return view(row);
}

/** The live entry for a code (route_audio), or null — no such code, expired, or not 4–6 digits. */
export async function inrouteLookup(code: string): Promise<InrouteEntry | null> {
  await telStore.ready();
  const c = str(code);
  if (!INROUTE_CODE.test(c)) return null;
  const row = codes.get(c);
  if (!row) return null;
  if (!live(row)) { dropExpired(c); return null; }
  return view(row);
}

/** Counts a routed call; the entry goes when it reaches maxUses. */
export async function inrouteUsed(code: string): Promise<void> {
  await telStore.ready();
  const c = str(code);
  const row = INROUTE_CODE.test(c) ? codes.get(c) : null;
  if (!live(row)) return;
  row.uses += 1;
  const done = row.maxUses > 0 && row.uses >= row.maxUses;
  if (done) codes.delete(c);
  else codes.put(row);
  telLog({ kind: "inroute", level: "info", summary: `route code ${maskCode(c)} used (${row.uses}${row.maxUses ? `/${row.maxUses}` : ""}) → ${target(row)}${done ? " — used up, removed" : ""}`, parsed: logged(row) });
}

/**
 * Removes a code. With `owner`, only that owner's (a model removes its own);
 * the console removes any. False when there was none (or not theirs).
 */
export async function inrouteDel(code: string, opts: { owner?: InrouteEntry["createdBy"]; by: string }): Promise<boolean> {
  await telStore.ready();
  const c = str(code);
  if (!INROUTE_CODE.test(c)) return false;
  const row = codes.get(c);
  if (!row || (opts.owner && row.owner !== ownerKey(opts.owner))) return false;
  codes.delete(c);
  if (live(row)) telLog({ kind: "inroute", level: "info", summary: `route code ${maskCode(c)} removed by ${opts.by.slice(0, 80)}`, parsed: logged(row) });
  return live(row);
}

/** The live codes, newest first — one owner's (a model's own), or all (the console). */
export async function inrouteList(opts: { owner?: InrouteEntry["createdBy"]; limit?: number } = {}): Promise<InrouteEntry[]> {
  await telStore.ready();
  const now = Date.now();
  return codes.list({ ...(opts.owner ? { device: ownerKey(opts.owner) } : {}), limit: Math.max(1, Math.min(opts.limit ?? 1000, 5000)), filter: (r) => r.expiresAt > now })
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(view);
}

/** How many codes are live (the console's overview). */
export async function inrouteCount(): Promise<number> {
  await telStore.ready();
  const now = Date.now();
  return codes.count((r) => r.expiresAt > now);
}

/* ------------------------------------------------------------- failures */

/** The bucket of a caller: its number (+digits), its SIP URI, or "anonymous" for a withheld one (they share it). */
const callerKey = (caller: string) => {
  const c = str(caller);
  const digits = numberDigits(c);
  if (digits) return `+${digits}`;
  return /^sips?:[^\s]{1,200}$/i.test(c) ? c.toLowerCase().slice(0, 120) : "anonymous";
};

/**
 * A wrong code from this caller number (route_audio calls it on every
 * on_code_error): counted per hour. Whether the caller is now refused
 * outright (maxFailuresPerCallerPerHour).
 */
export async function inrouteFailure(caller: string, detail: { code?: string; callId?: string; provider?: string } = {}): Promise<{ failures: number; blocked: boolean }> {
  await telStore.ready();
  const key = callerKey(caller);
  const now = Date.now();
  const row = failures.get(key) ?? { id: key, at: [], last: 0 };
  row.at = [...row.at.filter((t) => t > now - HOUR), now].slice(-1000);
  row.last = now;
  failures.put(row);
  const max = telPermissions().inroute.maxFailuresPerCallerPerHour;
  const blocked = row.at.length >= max;
  telLog({
    kind: "inroute", level: blocked ? "warn" : "notice", provider: detail.provider ?? "", callId: detail.callId ?? "",
    summary: `wrong route code${detail.code ? ` ${maskCode(str(detail.code).slice(0, 12))}` : ""} from ${key} (${row.at.length} in the last hour${blocked ? `; refused from now on — at most ${max}` : ""})`,
    parsed: { caller: key, failures: row.at.length, max, blocked },
  });
  return { failures: row.at.length, blocked };
}

/** Is this caller number refused for too many wrong codes in the last hour? */
export async function inrouteBlocked(caller: string): Promise<boolean> {
  await telStore.ready();
  const row = failures.get(callerKey(caller));
  if (!row) return false;
  const now = Date.now();
  return row.at.filter((t) => t > now - HOUR).length >= telPermissions().inroute.maxFailuresPerCallerPerHour;
}

/** Tests: the in-memory rows (the SQLite ones go with the file). */
export function resetInrouteMemory(): void { codes.clearMemory(); failures.clearMemory(); }

// route_audio, Add route code and the console's tests reach the table through the hook.
telHooks.inroute = { lookup: inrouteLookup, used: inrouteUsed, add: (spec) => inrouteAdd(spec) };
