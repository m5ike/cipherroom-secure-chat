// m5adm for functions (6.0), host-side: the administration as an SDK. Every
// call is a request to the main service's /api/admin/* (where the live state
// is — the rooms, the sockets, the relay) with the run's function token
// (adm-token.ts): the console's own routes, guards and audit journal, and
// nothing the owner did not grant — its role and its areas.
//
// The sandbox gets plain data back; the preludes wrap a room into an m5room
// object with its methods (wall_msg, user_msg, user_flash, disconnect,
// block, connect, log…), which come back here as rooms.* calls.
//
// Conventions (the same in JavaScript and Python):
//   list(filter?)   → a list (possibly empty)
//   get(id)         → the object, or null when there is none
//   set(id|null, o) → the id when it was saved, -1 when not (the reason is
//                     logged in the run); null creates where that makes sense
//   delete(id)      → true / false
//   stats()         → an object of numbers

import { currentRoomHash, hashRoom } from "../monitor/traffic";
import { ADM_AREAS, mintAdmToken, type AdmArea, type AdmGrant } from "./adm-token";
import { SafeRegex } from "./safe-regex";

export class AdmCallError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "AdmCallError"; }
}

export type AdmContext = {
  /** null: the model has no access to the administration. */
  grant: AdmGrant | null;
  /** Why there is no grant (shown in the error). */
  why?: string;
  model: string;
  caller: string;
  runId: string;
};

/** Where the main service listens (the admin service reaches it the same way it forwards /api/admin). */
export function mainServiceUrl(): string {
  const explicit = process.env.M5ADM_URL?.trim() || process.env.MAIN_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const host = process.env.HOST?.trim();
  const local = !host || host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  return `http://${local}:${process.env.PORT || 5000}`;
}

/** Calls per run (a loop over rooms must not flood the console's service). */
export const ADM_RUN_CALL_CAP = 2_000;
const calls = new Map<string, number>();
const tokens = new Map<string, { token: string; exp: number }>();

/** A run ended: forget its token and its count. */
export function endAdmRun(runId: string): void { calls.delete(runId); tokens.delete(runId); }

function tokenFor(ctx: AdmContext): string {
  const cached = tokens.get(ctx.runId);
  if (cached && cached.exp - Date.now() > 60_000) return cached.token;
  const ttl = 15 * 60 * 1000;
  const token = mintAdmToken(ctx.grant!, { model: ctx.model, caller: ctx.caller }, ttl);
  tokens.set(ctx.runId, { token, exp: Date.now() + ttl });
  if (tokens.size > 5_000) tokens.delete(tokens.keys().next().value!);
  return token;
}

type Json = Record<string, unknown>;

/** One request to /api/admin; `soft404` answers null instead of throwing. */
async function api(ctx: AdmContext, method: string, path: string, body?: unknown, soft404 = false): Promise<Json | null> {
  const n = (calls.get(ctx.runId) ?? 0) + 1;
  if (n > ADM_RUN_CALL_CAP) throw new AdmCallError("adm-limit", `a run may make ${ADM_RUN_CALL_CAP} administration calls`);
  calls.set(ctx.runId, n);
  if (calls.size > 5_000) calls.delete(calls.keys().next().value!);
  let res: Response;
  try {
    res = await fetch(`${mainServiceUrl()}/api/admin${path}`, {
      method,
      headers: { Authorization: `Bearer ${tokenFor(ctx)}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new AdmCallError("adm-unreachable", `the main service is not reachable at ${mainServiceUrl()} (${(err as Error).message})`);
  }
  const type = res.headers.get("content-type") ?? "";
  const data = type.includes("json") ? await res.json().catch(() => ({})) as Json : { text: await res.text() };
  if (res.ok) return data;
  if (res.status === 404 && soft404) return null;
  const message = String(data.message ?? `HTTP ${res.status}`).slice(0, 300);
  throw new AdmCallError(res.status === 403 || res.status === 401 ? "adm-denied" : res.status === 404 ? "adm-not-found" : res.status === 400 ? "bad-argument" : res.status === 429 ? "adm-limit" : "adm-error", message);
}

const strip = (d: Json | null): Json | null => { if (!d) return null; const { ok: _ok, ...rest } = d; return rest; };
const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const qs = (o: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};
const idPart = (v: unknown) => encodeURIComponent(str(v).slice(0, 200));

/* --------------------------------------------------------------- filters */

/**
 * A filter value is a regular expression as PHP's preg_match takes it —
 * "/^eva/i" — or a bare pattern ("^eva", case-sensitive). The subject is
 * cut to 200 characters and patterns with nested quantifiers are refused:
 * a filter can come from a caller's input, and it runs in the service.
 * 6.7 (audit S1): that refusal is only a helpful early error — the old
 * check let ((a+))+$ and (a|a)+$ through. What keeps the service running is
 * SafeRegex: a pattern that could backtrack is matched under a timeout and a
 * time budget per call (safe-regex.ts).
 */
export function filterRegex(value: unknown): SafeRegex {
  const raw = str(value);
  if (raw.length > 300) throw new AdmCallError("bad-argument", "a filter pattern is at most 300 characters");
  const m = /^\/(.*)\/([a-z]*)$/s.exec(raw);
  const body = m ? m[1] : raw;
  const flags = m ? [...new Set(m[2].split("").filter((f) => "imsu".includes(f)))].join("") : "";
  if (/\([^)]*[+*}][^)]*\)\s*[+*{]/.test(body)) throw new AdmCallError("bad-argument", "a filter pattern may not repeat a repeated group (e.g. (a+)+)");
  try { return new SafeRegex(body, flags, { maxSubject: 200 }); } catch (err) { throw new AdmCallError("bad-argument", `a filter pattern: ${(err as Error).message}`); }
}
const test = (re: SafeRegex, s: unknown) => re.test(str(s));
/** Matches all the subjects a filter will see in one guarded step (S1). */
const prime = (re: SafeRegex | null, subjects: unknown[]) => { re?.prime(subjects.map(str)); };

export const ROOM_FILTER_KEYS = ["room_username", "system_username", "system_passkey_id", "system_group", "room_id", "room_label", "room_tag"] as const;
type RoomFilterKey = typeof ROOM_FILTER_KEYS[number];
type RoomFilter = { key: RoomFilterKey; re: SafeRegex };

/** [{ key, value }], [[key, value]], or { key: value } → filters (all must match). */
export function roomFilters(raw: unknown): RoomFilter[] {
  if (raw === undefined || raw === null) return [];
  const pairs: Array<[unknown, unknown]> = Array.isArray(raw)
    ? raw.map((f) => (Array.isArray(f) ? [f[0], f[1]] : f && typeof f === "object" ? [(f as Json).key ?? (f as Json)["filter-key"] ?? (f as Json).filter, (f as Json).value] : [undefined, undefined]))
    : typeof raw === "object" ? Object.entries(raw as Json) : [];
  return pairs.map(([k, v]) => {
    const key = str(k) as RoomFilterKey;
    if (!ROOM_FILTER_KEYS.includes(key)) throw new AdmCallError("bad-argument", `a room filter key is one of ${ROOM_FILTER_KEYS.join(", ")} (got "${str(k).slice(0, 40)}")`);
    return { key, re: filterRegex(v) };
  });
}

type Member = { peerId?: string; name?: string; accountId?: string; username?: string; groups?: string[]; passkeys?: string[]; connId?: string; joinedAt?: number; since?: number; away?: boolean; protocol?: number };
export type RoomView = {
  id: string; online: boolean; recorded: boolean;
  label: string; note: string; tags: string[]; maxMembers: number;
  blocked: unknown; wall: unknown;
  members: Member[]; away: Member[]; count: number; awayCount: number;
  createdAt: number | null; updatedAt: number | null; updatedBy: string;
};

function roomView(snap: Json | null, record: Json | null): RoomView {
  const peers = (snap?.peers as Member[] | undefined) ?? [];
  const away = (snap?.away as Member[] | undefined) ?? [];
  const r = record ?? {};
  return {
    id: str(snap?.roomHash ?? r.id),
    online: Boolean(snap),
    recorded: Boolean(record),
    label: str(r.label), note: str(r.note), tags: Array.isArray(r.tags) ? r.tags.map(str) : [],
    maxMembers: Number(r.maxMembers) || 0,
    blocked: r.blocked ?? null, wall: r.wall ?? null,
    members: peers.map((p) => ({ peerId: p.peerId, name: p.name, accountId: p.accountId ?? "", username: p.username ?? "", groups: p.groups ?? [], passkeys: p.passkeys ?? [], connId: p.connId, joinedAt: p.joinedAt, away: Boolean(p.away), protocol: p.protocol })),
    away: away.map((a) => ({ accountId: a.accountId, name: a.name, since: a.since, username: a.username ?? "", groups: a.groups ?? [], passkeys: a.passkeys ?? [] })),
    count: peers.length, awayCount: away.length,
    createdAt: typeof r.createdAt === "number" ? r.createdAt : null,
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : null,
    updatedBy: str(r.updatedBy),
  };
}

/** What a room filter key looks at in a room. */
function roomSubjects(room: RoomView, key: RoomFilterKey): unknown[] {
  const people = [...room.members, ...room.away];
  switch (key) {
    case "room_id": return [room.id];
    case "room_label": return [room.label];
    case "room_tag": return room.tags;
    case "room_username": return people.map((p) => p.name);
    case "system_username": return people.map((p) => p.username).filter(Boolean);
    case "system_passkey_id": return people.flatMap((p) => p.passkeys ?? []);
    case "system_group": return people.flatMap((p) => p.groups ?? []);
  }
}

function roomMatches(room: RoomView, filters: RoomFilter[], any: boolean): boolean {
  if (!filters.length) return true;
  const people = [...room.members, ...room.away];
  const one = (f: RoomFilter): boolean => {
    switch (f.key) {
      case "room_id": return test(f.re, room.id);
      case "room_label": return test(f.re, room.label);
      case "room_tag": return room.tags.some((t) => test(f.re, t));
      case "room_username": return people.some((p) => test(f.re, p.name));
      case "system_username": return people.some((p) => p.username && test(f.re, p.username));
      case "system_passkey_id": return people.some((p) => (p.passkeys ?? []).some((k) => test(f.re, k)));
      case "system_group": return people.some((p) => (p.groups ?? []).some((g) => test(f.re, g)));
    }
  };
  return any ? filters.some(one) : filters.every(one);
}

/** A room's id: its 16-character hash, or the room id / name itself (hashed as the server does — keyed since 6.12, F-04). */
export function roomIdOf(v: unknown): string {
  const s = str(v).trim();
  if (/^[0-9a-f]{16}$/.test(s)) return currentRoomHash(s);
  if (!s) throw new AdmCallError("bad-argument", "a room id is required");
  return hashRoom(s)!;
}

async function allRooms(ctx: AdmContext): Promise<RoomView[]> {
  const d = await api(ctx, "GET", "/rooms?members=full");
  const open = (d?.rooms as Json[] | undefined) ?? [];
  const seen = new Set<string>();
  const out = open.map((r) => { seen.add(str(r.roomHash)); return roomView(r, (r.record as Json | null) ?? null); });
  for (const rec of (d?.registry as Json[] | undefined) ?? []) if (!seen.has(str(rec.id))) out.push(roomView(null, rec));
  return out;
}

/** "Several" results: { ok, id } / { ok: false, error } — the preludes turn it into id or -1. */
const saved = (id: string) => ({ saved: true, id });
const notSaved = (err: unknown) => ({ saved: false, error: err instanceof Error ? err.message : String(err) });

function memberTarget(v: unknown): Json {
  if (v && typeof v === "object") {
    const o = v as Json;
    return { ...(o.peerId ? { peerId: str(o.peerId) } : {}), ...(o.accountId ? { accountId: str(o.accountId) } : {}), ...(o.name && !o.peerId && !o.accountId ? { name: str(o.name) } : {}) };
  }
  const s = str(v).trim();
  if (!s) throw new AdmCallError("bad-argument", "which member: a peer id, an account id, or a name");
  return s.startsWith("p-") ? { peerId: s } : { name: s };
}

/* ------------------------------------------------------------- the areas */

type Op = (ctx: AdmContext, args: unknown[]) => Promise<unknown>;
const a0 = (args: unknown[]) => (args[0] ?? {}) as Json;

const ROOMS: Record<string, Op> = {
  list: async (ctx, args) => {
    const filters = roomFilters(args[0]);
    const any = (args[1] as Json | undefined)?.match === "any";
    const rooms = await allRooms(ctx);
    for (const f of filters) prime(f.re, rooms.flatMap((r) => roomSubjects(r, f.key)));
    return rooms.filter((r) => roomMatches(r, filters, any));
  },
  get: async (ctx, args) => {
    const id = roomIdOf(args[0]);
    const d = await api(ctx, "GET", "/rooms?members=full");
    const snap = ((d?.rooms as Json[] | undefined) ?? []).find((r) => r.roomHash === id) ?? null;
    const record = (snap?.record as Json | null) ?? ((d?.registry as Json[] | undefined) ?? []).find((r) => r.id === id) ?? null;
    return snap || record ? roomView(snap, record) : null;
  },
  set: async (ctx, args) => {
    try {
      const o = (args[1] ?? {}) as Json;
      const id = args[0] === null || args[0] === undefined || args[0] === "" ? roomIdOf(o.room ?? o.id) : roomIdOf(args[0]);
      const patch: Json = {};
      for (const k of ["label", "note", "tags", "maxMembers", "blocked", "wall"]) if (o[k] !== undefined) patch[k] = o[k];
      await api(ctx, "PUT", `/rooms/registry/${id}`, patch);
      return saved(id);
    } catch (err) { if (err instanceof AdmCallError && err.code === "adm-denied") throw err; return notSaved(err); }
  },
  delete: async (ctx, args) => Boolean(await api(ctx, "DELETE", `/rooms/registry/${roomIdOf(args[0])}`, undefined, true)),
  stats: async (ctx) => {
    const rooms = await allRooms(ctx);
    const online = rooms.filter((r) => r.online);
    const members = online.reduce((n, r) => n + r.count, 0);
    const signedIn = online.reduce((n, r) => n + r.members.filter((m) => m.accountId).length, 0);
    const byProtocol: Record<string, number> = {};
    for (const r of online) for (const m of r.members) byProtocol[String(m.protocol ?? "?")] = (byProtocol[String(m.protocol ?? "?")] ?? 0) + 1;
    return {
      at: Date.now(),
      rooms: online.length, members, signedIn, guests: members - signedIn,
      away: online.reduce((n, r) => n + r.awayCount, 0) + rooms.filter((r) => !r.online).reduce((n, r) => n + r.awayCount, 0),
      byProtocol,
      busiest: [...online].sort((a, b) => b.count - a.count).slice(0, 10).map((r) => ({ id: r.id, label: r.label, members: r.count, away: r.awayCount })),
      registry: { records: rooms.filter((r) => r.recorded).length, blocked: rooms.filter((r) => r.blocked).length, limited: rooms.filter((r) => r.maxMembers > 0).length, pinned: rooms.filter((r) => r.wall).length },
    };
  },
  // The m5room methods.
  wall_msg: async (ctx, args) => Number((await api(ctx, "POST", `/rooms/${roomIdOf(args[0])}/notice`, { kind: "wall", text: str(args[1]), level: str((args[2] as Json | undefined)?.level) || "info", ...((args[2] as Json | undefined)?.pin !== undefined ? { pin: Boolean((args[2] as Json).pin) } : {}), from: str((args[2] as Json | undefined)?.from) || "operator" }))?.delivered ?? 0),
  user_msg: async (ctx, args) => Number((await api(ctx, "POST", `/rooms/${roomIdOf(args[0])}/notice`, { kind: "message", text: str(args[2]), ...memberTarget(args[1]), from: str((args[3] as Json | undefined)?.from) || "operator" }))?.delivered ?? 0) > 0,
  user_flash: async (ctx, args) => Number((await api(ctx, "POST", `/rooms/${roomIdOf(args[0])}/notice`, { kind: "flash", text: str(args[2]), level: str(args[3]) || "info", ...memberTarget(args[1]) }))?.delivered ?? 0) > 0,
  disconnect: async (ctx, args) => Number((await api(ctx, "POST", `/rooms/${roomIdOf(args[0])}/disconnect`, { ...(args[1] !== undefined && args[1] !== null && args[1] !== "" ? memberTarget(args[1]) : {}), reason: str((args[2] as Json | undefined)?.reason ?? args[2]) }))?.disconnected ?? 0),
  block: async (ctx, args) => {
    const o = (args[1] ?? {}) as Json;
    const minutes = Number(o.minutes) || 0;
    const d = await api(ctx, "POST", `/rooms/${roomIdOf(args[0])}/block`, { reason: str(o.reason), until: minutes > 0 ? Date.now() + minutes * 60_000 : typeof o.until === "number" ? o.until : null, kick: o.kick !== false });
    return { blocked: true, disconnected: Number(d?.disconnected ?? 0) };
  },
  unblock: async (ctx, args) => Boolean((await api(ctx, "DELETE", `/rooms/${roomIdOf(args[0])}/block`))?.unblocked),
  connect: async (ctx, args) => {
    const id = roomIdOf(args[0]);
    const o = (args[2] ?? {}) as Json;
    if (o.unblock !== false) await api(ctx, "DELETE", `/rooms/${id}/block`);
    const who = args[1] && typeof args[1] === "object" ? str((args[1] as Json).accountId) : str(args[1]);
    return Number((await api(ctx, "POST", `/rooms/${id}/wake`, who ? { accountId: who } : {}))?.called ?? 0);
  },
  log: async (ctx, args) => {
    const o = (args[1] ?? {}) as Json;
    const d = await api(ctx, "GET", `/rooms/${roomIdOf(args[0])}${qs({ limit: o.limit ?? 200, since: o.since })}`, undefined, true);
    return d ? { traffic: d.traffic ?? [], journal: d.journal ?? [] } : { traffic: [], journal: [] };
  },
};

const OVERVIEW: Record<string, Op> = {
  get: async (ctx) => strip(await api(ctx, "GET", "/overview")),
  system: async (ctx) => strip(await api(ctx, "GET", "/system")),
  alerts: async (ctx) => strip(await api(ctx, "GET", "/alerts")),
  db: async (ctx) => strip(await api(ctx, "GET", "/db")),
  backups: async (ctx) => strip(await api(ctx, "GET", "/backups")),
  metrics: async (ctx) => str((await api(ctx, "GET", "/metrics"))?.text),
  whoami: async (ctx) => (await api(ctx, "GET", "/whoami"))?.admin ?? null,
};

const conns = async (ctx: AdmContext) => ((await api(ctx, "GET", "/connections"))?.connections as Json[] | undefined) ?? [];
const CONNECTIONS: Record<string, Op> = {
  list: async (ctx, args) => {
    const f = a0(args);
    const re = (k: string) => (f[k] !== undefined ? filterRegex(f[k]) : null);
    const [ip, name, peer, account, room] = [re("ip"), re("name"), re("peer"), re("account"), f.room !== undefined ? roomIdOf(f.room) : null];
    const list = await conns(ctx);
    prime(ip, list.map((c) => c.ip)); prime(name, list.map((c) => c.name)); prime(peer, list.map((c) => c.peerId)); prime(account, list.map((c) => c.accountId));
    return list.filter((c) => (!ip || test(ip, c.ip)) && (!name || test(name, c.name)) && (!peer || test(peer, c.peerId)) && (!account || test(account, c.accountId)) && (!room || c.roomHash === room));
  },
  get: async (ctx, args) => (await conns(ctx)).find((c) => c.id === str(args[0])) ?? null,
  close: async (ctx, args) => Boolean(await api(ctx, "POST", `/connections/${idPart(args[0])}/close`, {}, true)),
  stats: async (ctx) => {
    const list = await conns(ctx);
    const rtts = list.map((c) => Number(c.rttMs)).filter((n) => Number.isFinite(n) && n > 0);
    return {
      at: Date.now(), connections: list.length,
      inRooms: list.filter((c) => c.roomHash).length, signedIn: list.filter((c) => c.accountId).length, away: list.filter((c) => c.away).length,
      rttAvgMs: rtts.length ? Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length) : null,
      bytesIn: list.reduce((n, c) => n + (Number(c.bytesIn) || 0), 0), bytesOut: list.reduce((n, c) => n + (Number(c.bytesOut) || 0), 0),
    };
  },
};

const trafficQuery = (f: Json) => qs({ cls: f.cls ?? f.class, channel: f.channel, direction: f.direction, conn: f.conn, peer: f.peer, account: f.account, room: f.room !== undefined ? roomIdOf(f.room) : undefined, type: f.type, since: f.since, before: f.before, errors: f.errors ? "1" : undefined, limit: f.limit });
const TRAFFIC: Record<string, Op> = {
  list: async (ctx, args) => ((await api(ctx, "GET", `/traffic${trafficQuery(a0(args))}`))?.records as unknown[] | undefined) ?? [],
  summary: async (ctx) => (await api(ctx, "GET", "/traffic?limit=1"))?.summary ?? null,
  rates: async (ctx, args) => ((await api(ctx, "GET", `/traffic/rates${qs({ seconds: args[0] ?? 120 })}`))?.rates as unknown[] | undefined) ?? [],
  events: async (ctx, args) => ((await api(ctx, "GET", `/events${qs({ limit: args[0] ?? 100 })}`))?.events as unknown[] | undefined) ?? [],
  // Live: what arrives in the next few seconds (at most 60), newest last.
  watch: async (ctx, args) => {
    const ms = Math.max(500, Math.min(60_000, Number(args[0]) || 5_000));
    const f = (args[1] ?? {}) as Json;
    const since = Date.now();
    await new Promise((r) => setTimeout(r, ms));
    const records = ((await api(ctx, "GET", `/traffic${trafficQuery({ ...f, since, limit: f.limit ?? 1_000 })}`))?.records as Json[] | undefined) ?? [];
    return records.reverse();
  },
};

const config = async (ctx: AdmContext) => (await api(ctx, "GET", "/client-config")) as Json;
const putConfig = (ctx: AdmContext, cfg: Json) => api(ctx, "PUT", "/client-config", { config: cfg });
const MODULES: Record<string, Op> = {
  list: async (ctx) => {
    const d = await config(ctx);
    const rules = ((d.config as Json | undefined)?.modules ?? {}) as Json;
    const catalog = (((d.catalog as Json | undefined)?.modules ?? []) as Json[]);
    return catalog.map((m) => ({ id: m.id, label: m.label, description: m.description, rights: m.rights ?? null, rule: rules[str(m.id)] ?? { enabled: true } }));
  },
  get: async (ctx, args) => (await MODULES.list(ctx, args) as Json[]).find((m) => m.id === str(args[0])) ?? null,
  set: async (ctx, args) => {
    try {
      const id = str(args[0]);
      const d = await config(ctx);
      const cfg = { ...(d.config as Json) };
      if (!(((d.catalog as Json | undefined)?.modules ?? []) as Json[]).some((m) => m.id === id)) throw new AdmCallError("bad-argument", `no module "${id}"`);
      cfg.modules = { ...(cfg.modules as Json), [id]: { ...(((cfg.modules as Json)[id] ?? {}) as Json), ...((args[1] ?? {}) as Json) } };
      await putConfig(ctx, cfg);
      return saved(id);
    } catch (err) { if (err instanceof AdmCallError && err.code === "adm-denied") throw err; return notSaved(err); }
  },
  enable: async (ctx, args) => {
    const r = await MODULES.set(ctx, [args[0], { enabled: args[1] !== false }]) as { saved: boolean; error?: string };
    if (!r.saved) throw new AdmCallError("adm-error", r.error ?? "not saved");
    return true;
  },
  state: async (ctx) => strip(await api(ctx, "GET", "/modules/state")),
  switch: async (ctx, args) => strip(await api(ctx, "PUT", "/modules/switches", { [str(args[0])]: args[1] !== false })),
};

const groupsOf = async (ctx: AdmContext) => { const d = await config(ctx); return { d, groups: (((d.config as Json | undefined)?.groups ?? []) as Json[]) }; };
const GROUPS: Record<string, Op> = {
  list: async (ctx) => {
    const { d, groups } = await groupsOf(ctx);
    const builtin = [...((((d.catalog as Json | undefined)?.builtinGroups) ?? []) as Json[]), ...((((d.catalog as Json | undefined)?.consoleGroups) ?? []) as Json[])].map((g) => ({ ...g, builtin: true, members: [] }));
    return [...builtin, ...groups.map((g) => ({ ...g, builtin: false }))];
  },
  get: async (ctx, args) => (await GROUPS.list(ctx, args) as Json[]).find((g) => g.id === str(args[0])) ?? null,
  set: async (ctx, args) => {
    try {
      const o = (args[1] ?? {}) as Json;
      const id = str(args[0] ?? o.id).trim().toLowerCase();
      if (!/^[a-z][a-z0-9-]{1,31}$/.test(id)) throw new AdmCallError("bad-argument", "a group id: a–z, 0–9 and “-” (2–32)");
      const { d, groups } = await groupsOf(ctx);
      const prev = groups.find((g) => g.id === id);
      const members = Array.isArray(o.members) ? [...new Set(o.members.map(str).filter(Boolean))] : (prev?.members as string[] | undefined) ?? [];
      const next = { id, label: str(o.label ?? prev?.label ?? id), members };
      const cfg = { ...(d.config as Json), groups: prev ? groups.map((g) => (g.id === id ? next : g)) : [...groups, next] };
      await putConfig(ctx, cfg);
      return saved(id);
    } catch (err) { if (err instanceof AdmCallError && err.code === "adm-denied") throw err; return notSaved(err); }
  },
  delete: async (ctx, args) => {
    const { d, groups } = await groupsOf(ctx);
    const id = str(args[0]);
    if (!groups.some((g) => g.id === id)) return false;
    await putConfig(ctx, { ...(d.config as Json), groups: groups.filter((g) => g.id !== id) });
    return true;
  },
  add_member: async (ctx, args) => {
    const g = (await groupsOf(ctx)).groups.find((x) => x.id === str(args[0]));
    if (!g) return false;
    const r = await GROUPS.set(ctx, [g.id, { members: [...((g.members as string[]) ?? []), str(args[1])] }]) as { saved: boolean };
    return r.saved;
  },
  remove_member: async (ctx, args) => {
    const g = (await groupsOf(ctx)).groups.find((x) => x.id === str(args[0]));
    if (!g) return false;
    const r = await GROUPS.set(ctx, [g.id, { members: ((g.members as string[]) ?? []).filter((m) => m !== str(args[1])) }]) as { saved: boolean };
    return r.saved;
  },
};

const usersAll = async (ctx: AdmContext) => ((await api(ctx, "GET", "/users"))?.users as Json[] | undefined) ?? [];
const USERS: Record<string, Op> = {
  list: async (ctx, args) => {
    const f = a0(args);
    const re = (k: string) => (f[k] !== undefined ? filterRegex(f[k]) : null);
    const [username, group, passkey, id] = [re("username"), re("group"), re("passkey"), re("id")];
    const all = await usersAll(ctx);
    prime(username, all.map((u) => u.username)); prime(id, all.map((u) => u.id));
    prime(group, all.flatMap((u) => (u.groups as string[] | undefined) ?? []));
    prime(passkey, all.flatMap((u) => ((u.passkeys as Json[] | undefined) ?? []).map((p) => p.credentialId)));
    return all.filter((u) => (!username || test(username, u.username)) && (!id || test(id, u.id))
      && (!group || ((u.groups as string[] | undefined) ?? []).some((g) => test(group, g)))
      && (!passkey || ((u.passkeys as Json[] | undefined) ?? []).some((p) => test(passkey, p.credentialId))));
  },
  get: async (ctx, args) => strip(await api(ctx, "GET", `/users/${idPart(args[0])}`, undefined, true)),
  signout: async (ctx, args) => Boolean(await api(ctx, "POST", `/users/${idPart(args[0])}/signout`, {}, true)),
  // The id has to be repeated (as in the console): delete(id, id).
  delete: async (ctx, args) => {
    if (str(args[1]) !== str(args[0])) throw new AdmCallError("bad-argument", "repeat the account id to delete it: users.delete(id, id)");
    return Boolean(await api(ctx, "DELETE", `/users/${idPart(args[0])}?confirm=${idPart(args[0])}`, undefined, true));
  },
  passkeys: async (ctx, args) => ((await usersAll(ctx)).find((u) => u.id === str(args[0]))?.passkeys as unknown[] | undefined) ?? [],
  remove_passkey: async (ctx, args) => Boolean(await api(ctx, "DELETE", `/users/${idPart(args[0])}/passkeys/${idPart(args[1])}`, undefined, true)),
};

const PASSKEYS: Record<string, Op> = {
  list: async (ctx, args) => {
    const f = a0(args);
    const re = f.id !== undefined ? filterRegex(f.id) : null;
    const user = f.username !== undefined ? filterRegex(f.username) : null;
    const all = (await usersAll(ctx)).flatMap((u) => ((u.passkeys as Json[] | undefined) ?? []).map((p): Json => ({ ...p, accountId: u.id, username: u.username })));
    prime(re, all.map((p) => p.credentialId)); prime(user, all.map((p) => p.username));
    return all.filter((p) => (!re || test(re, p.credentialId)) && (!user || test(user, p.username)));
  },
  get: async (ctx, args) => (await PASSKEYS.list(ctx, [{}]) as Json[]).find((p) => p.credentialId === str(args[0])) ?? null,
  delete: async (ctx, args) => {
    const p = await PASSKEYS.get(ctx, args) as Json | null;
    return p ? Boolean(await api(ctx, "DELETE", `/users/${idPart(p.accountId)}/passkeys/${idPart(p.credentialId)}`, undefined, true)) : false;
  },
};

const QUEUE: Record<string, Op> = {
  list: async (ctx) => ((await api(ctx, "GET", "/queue"))?.accounts as unknown[] | undefined) ?? [],
  stats: async (ctx) => { const d = await api(ctx, "GET", "/queue"); return { available: Boolean(d?.available), persistent: Boolean(d?.persistent), ...((d?.stats as Json | null) ?? {}) }; },
  get: async (ctx, args) => ((await api(ctx, "GET", `/users/${idPart(args[0])}`, undefined, true))?.queue as unknown[] | undefined) ?? [],
  dead: async (ctx, args) => ((await api(ctx, "GET", `/queue/dead${qs({ account: a0(args).account, limit: a0(args).limit })}`))?.items as unknown[] | undefined) ?? [],
  revive: async (ctx, args) => Boolean(await api(ctx, "POST", `/queue/${idPart(args[0])}/revive`, {}, true)),
};

const AUDIT: Record<string, Op> = {
  list: async (ctx, args) => {
    const f = a0(args);
    return ((await api(ctx, "GET", `/audit${qs({ category: f.category, minLevel: f.minLevel ?? f.level, actor: f.actor, account: f.account, peer: f.peer, event: f.event, q: f.q ?? f.search, since: f.since, limit: f.limit, source: f.source })}`))?.entries as unknown[] | undefined) ?? [];
  },
  stats: async (ctx) => (await api(ctx, "GET", "/audit?limit=1"))?.stats ?? null,
  verify: async (ctx) => strip(await api(ctx, "GET", "/audit/verify")),
  checkpoint: async (ctx) => (await api(ctx, "POST", "/audit/checkpoint", {}))?.checkpoint ?? null,
  communication: async (ctx, args) => Boolean((await api(ctx, "PUT", "/audit/settings", { communication: args[0] !== false }))?.communication),
  add: async (ctx, args) => {
    const o = (args[2] ?? {}) as Json;
    return (await api(ctx, "POST", "/audit/entries", { event: str(args[0]), detail: args[1] ?? null, level: str(o.level) || "info", target: str(o.target) }))?.entry ?? null;
  },
};

const COMMANDS: Record<string, Op> = {
  list: async (ctx) => strip(await api(ctx, "GET", "/commands")),
  allowlist: async (ctx) => ((await api(ctx, "GET", "/commands"))?.allowlist as unknown[] | undefined) ?? [],
  send: async (ctx, args) => strip(await api(ctx, "POST", "/commands", { deviceId: str(args[0]), kind: str(args[1]), ...(args[2] !== undefined ? { payload: args[2] } : {}) })),
};
const PUSH: Record<string, Op> = {
  status: async (ctx) => strip(await api(ctx, "GET", "/push")),
  send: async (ctx, args) => ((await api(ctx, "POST", "/push/test", { ...(args[0] ? { id: str(args[0]) } : {}), title: str(args[1]) || "M5cet", body: str(args[2]) }))?.results as unknown[] | undefined) ?? [],
};

const ADMINS: Record<string, Op> = {
  list: async (ctx) => ((await api(ctx, "GET", "/admins"))?.admins as unknown[] | undefined) ?? [],
  get: async (ctx, args) => (await ADMINS.list(ctx, args) as Json[]).find((a) => a.name === str(args[0])) ?? null,
  set: async (ctx, args) => {
    try {
      const o = (args[1] ?? {}) as Json;
      const name = str(args[0] ?? o.name).trim();
      const exists = args[0] !== null && args[0] !== undefined && Boolean(await ADMINS.get(ctx, [name]));
      if (!exists) await api(ctx, "POST", "/admins", { name: str(o.name ?? name), role: str(o.role) || "auditor" });
      else await api(ctx, "PATCH", `/admins/${idPart(name)}`, { ...(o.role ? { role: str(o.role) } : {}), ...(typeof o.disabled === "boolean" ? { disabled: o.disabled } : {}) });
      return saved(exists ? name : str(o.name ?? name));
    } catch (err) { if (err instanceof AdmCallError && err.code === "adm-denied") throw err; return notSaved(err); }
  },
  delete: async (ctx, args) => Boolean(await api(ctx, "DELETE", `/admins/${idPart(args[0])}`, undefined, true)),
};

/** SDK object → the area its calls need, and its operations. */
const OBJECTS: Record<string, { area: AdmArea; ops: Record<string, Op> }> = {
  overview: { area: "overview", ops: OVERVIEW },
  rooms: { area: "rooms", ops: ROOMS },
  connections: { area: "connections", ops: CONNECTIONS },
  traffic: { area: "traffic", ops: TRAFFIC },
  modules: { area: "modules", ops: MODULES },
  groups: { area: "modules", ops: GROUPS },
  users: { area: "users", ops: USERS },
  passkeys: { area: "users", ops: PASSKEYS },
  queue: { area: "queue", ops: QUEUE },
  audit: { area: "audit", ops: AUDIT },
  commands: { area: "commands", ops: COMMANDS },
  push: { area: "commands", ops: PUSH },
  admins: { area: "admins", ops: ADMINS },
};

/** Every object and operation (the SDK spec and a test check the preludes against it). */
export const ADM_OPERATIONS: Record<string, string[]> = Object.fromEntries(Object.entries(OBJECTS).map(([k, v]) => [k, Object.keys(v.ops)]));

/** One m5adm call: m5adm.<object>.<op>(…args). */
export async function hostAdm(object: string, op: string, args: unknown[], ctx: AdmContext): Promise<unknown> {
  const o = Object.prototype.hasOwnProperty.call(OBJECTS, object) ? OBJECTS[object] : undefined;
  const fn = o && Object.prototype.hasOwnProperty.call(o.ops, op) ? o.ops[op] : undefined;
  if (!o || !fn) throw new AdmCallError("unknown-call", `m5adm: no such call "${object}.${op}"`.slice(0, 80));
  if (!ctx.grant) throw new AdmCallError("adm-denied", ctx.why ?? "this model has no access to the administration (Functions › model › Administration; an owner grants it)");
  if (!ctx.grant.areas.includes(o.area)) throw new AdmCallError("adm-denied", `this model's access to the administration does not include “${o.area}” (it has: ${ctx.grant.areas.join(", ") || "none"})`);
  return fn(ctx, args);
}

/** What a run may do — for m5adm.info() in the sandbox (no call to the service). */
export function admInfo(ctx: AdmContext): { granted: boolean; role: string | null; areas: string[]; all: readonly string[] } {
  return { granted: Boolean(ctx.grant), role: ctx.grant?.role ?? null, areas: ctx.grant?.areas ?? [], all: ADM_AREAS };
}
