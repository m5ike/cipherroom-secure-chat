// Saved connections of a signed-in user in server-enhanced mode.
//
// A connection is everything needed to join a room again: the room, its
// key, the name to appear under, which signaling server, and how the
// session should behave (history, message lifetime, away relay,
// notifications, reconnecting). Next to each: statistics and a log of what
// happened, kept by this browser.
//
// All of it is sealed with the account's vault key in the browser and stored
// as the vault's "connections" part (account.ts › saveVault): the server
// holds ciphertext and a count. It never sees a room key, a room name or
// who connected where.

import { isChatRetention, type ChatRetention } from "./chat-history";
import { normalizeServerUrl, serverAllowed, type ConnectionsPolicy } from "./client-config";

export type Keepalive = "conservative" | "balanced" | "aggressive";

export type ConnectionProfile = {
  id: string;
  label: string;
  /** #rrggbb tag in the list, "" = none. */
  color: string;
  room: string;
  passphrase: string;
  userName: string;
  /** "" = this server; else a wss:// signaling server (client-config.ts). */
  server: string;
  mode: "light" | "server";
  retention: ChatRetention;
  /** Default lifetime of messages sent in this room (minutes, 0 = off). */
  ttlMinutes: number;
  /** The server keeps messages while I am away (this server only). */
  away: boolean;
  notifications: boolean;
  autoReconnect: boolean;
  keepalive: Keepalive;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
};

export type ConnectionStats = {
  connects: number;
  failures: number;
  reconnects: number;
  totalMs: number;
  longestMs: number;
  lastConnectedAt: number;
  lastDisconnectedAt: number;
  sent: number;
  received: number;
  filesSent: number;
  filesReceived: number;
  bytesSent: number;
  bytesReceived: number;
  peersMax: number;
  errors: number;
};

export const CONNECTION_EVENTS = [
  "created", "edited", "connect", "connected", "disconnected", "reconnect", "failed", "error",
  "peer-joined", "peer-left", "sent", "received", "file-sent", "file-received",
] as const;
export type ConnectionEvent = (typeof CONNECTION_EVENTS)[number];
/** Events too frequent for the log; they only count. */
const COUNT_ONLY: ReadonlySet<ConnectionEvent> = new Set(["sent", "received"]);

export type LogEntry = { at: number; event: ConnectionEvent; detail?: string };

export type ConnectionSettings = {
  defaultId: string | null;
  /** Connect the default connection right after signing in. */
  autoConnect: boolean;
  /** Reconnect by itself when the connection drops (a connection can opt out). */
  autoReconnect: boolean;
  /** Reconnect when the page comes back from the background / the network returns. */
  reconnectOnResume: boolean;
  /** Keep statistics and the log (the operator can also switch them off). */
  collectStats: boolean;
  /** A connection switcher next to the status in the header. */
  quickSwitch: boolean;
  /** Ask before leaving a connected room for another connection. */
  confirmSwitch: boolean;
};

export type ConnectionsState = {
  v: 1;
  profiles: ConnectionProfile[];
  settings: ConnectionSettings;
  stats: Record<string, ConnectionStats>;
  logs: Record<string, LogEntry[]>;
};

export const EMPTY_STATS: ConnectionStats = {
  connects: 0, failures: 0, reconnects: 0, totalMs: 0, longestMs: 0, lastConnectedAt: 0, lastDisconnectedAt: 0,
  sent: 0, received: 0, filesSent: 0, filesReceived: 0, bytesSent: 0, bytesReceived: 0, peersMax: 0, errors: 0,
};

export function defaultSettings(policy?: Pick<ConnectionsPolicy, "autoConnectDefault" | "stats">): ConnectionSettings {
  return {
    defaultId: null,
    autoConnect: policy?.autoConnectDefault ?? true,
    autoReconnect: true,
    reconnectOnResume: true,
    collectStats: policy?.stats ?? true,
    quickSwitch: true,
    confirmSwitch: true,
  };
}

export function emptyState(policy?: Pick<ConnectionsPolicy, "autoConnectDefault" | "stats">): ConnectionsState {
  return { v: 1, profiles: [], settings: defaultSettings(policy), stats: {}, logs: {} };
}

/* ------------------------------------------------------------ validation */

// eslint-disable-next-line no-control-regex
const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "");
const num = (v: unknown, lo: number, hi: number, dflt: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : dflt;
const bool = (v: unknown, dflt: boolean) => (typeof v === "boolean" ? v : dflt);
const COLOR = /^#[0-9a-f]{6}$/i;
const ID = /^cx-[a-z0-9]{6,24}$/;
const KEEPALIVE: readonly Keepalive[] = ["conservative", "balanced", "aggressive"];

/** Room names as the join form accepts them (App.tsx › normalizeRoom). */
export function normalizeRoomName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

export function newConnectionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return `cx-${Array.from(bytes, (b) => (b % 36).toString(36)).join("")}`;
}

export type ProfileInput = Partial<Omit<ConnectionProfile, "id" | "createdAt" | "updatedAt" | "lastUsedAt">>;

function sanitizeProfile(raw: unknown): ConnectionProfile | null {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const id = typeof p.id === "string" && ID.test(p.id) ? p.id : null;
  const room = normalizeRoomName(clean(p.room, 64));
  const passphrase = typeof p.passphrase === "string" ? p.passphrase.slice(0, 512) : "";
  if (!id || !room || !passphrase) return null;
  const server = typeof p.server === "string" && p.server ? normalizeServerUrl(p.server) ?? "" : "";
  return {
    id,
    label: clean(p.label, 60) || room,
    color: typeof p.color === "string" && COLOR.test(p.color) ? p.color.toLowerCase() : "",
    room,
    passphrase,
    userName: clean(p.userName, 42),
    server,
    mode: p.mode === "light" ? "light" : "server",
    retention: isChatRetention(p.retention) ? p.retention : "server",
    ttlMinutes: num(p.ttlMinutes, 0, 60 * 24 * 30, 0),
    away: bool(p.away, true) && !server,
    notifications: bool(p.notifications, true),
    autoReconnect: bool(p.autoReconnect, true),
    keepalive: KEEPALIVE.includes(p.keepalive as Keepalive) ? (p.keepalive as Keepalive) : "balanced",
    createdAt: num(p.createdAt, 0, Number.MAX_SAFE_INTEGER, 0),
    updatedAt: num(p.updatedAt, 0, Number.MAX_SAFE_INTEGER, 0),
    lastUsedAt: num(p.lastUsedAt, 0, Number.MAX_SAFE_INTEGER, 0),
  };
}

function sanitizeStats(raw: unknown): ConnectionStats {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out = { ...EMPTY_STATS };
  for (const key of Object.keys(EMPTY_STATS) as Array<keyof ConnectionStats>) out[key] = num(s[key], 0, Number.MAX_SAFE_INTEGER, 0);
  return out;
}

function sanitizeLog(raw: unknown, limit: number): LogEntry[] {
  if (!Array.isArray(raw) || limit <= 0) return [];
  const out: LogEntry[] = [];
  for (const e of raw.slice(-limit)) {
    const entry = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
    if (!(CONNECTION_EVENTS as readonly string[]).includes(entry.event as string)) continue;
    const detail = clean(entry.detail, 160);
    out.push({ at: num(entry.at, 0, Number.MAX_SAFE_INTEGER, 0), event: entry.event as ConnectionEvent, ...(detail ? { detail } : {}) });
  }
  return out;
}

/** Whatever came out of the vault, made safe and bounded by the policy. */
export function sanitizeState(raw: unknown, policy: ConnectionsPolicy): ConnectionsState {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const base = emptyState(policy);
  const profiles: ConnectionProfile[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(r.profiles) ? r.profiles : []) {
    const p = sanitizeProfile(item);
    if (!p || seen.has(p.id) || profiles.length >= policy.maxProfiles) continue;
    seen.add(p.id);
    profiles.push(p);
  }
  const st = (r.settings && typeof r.settings === "object" ? r.settings : {}) as Record<string, unknown>;
  const settings: ConnectionSettings = {
    defaultId: typeof st.defaultId === "string" && seen.has(st.defaultId) ? st.defaultId : null,
    autoConnect: bool(st.autoConnect, base.settings.autoConnect),
    autoReconnect: bool(st.autoReconnect, base.settings.autoReconnect),
    reconnectOnResume: bool(st.reconnectOnResume, base.settings.reconnectOnResume),
    collectStats: bool(st.collectStats, base.settings.collectStats) && policy.stats,
    quickSwitch: bool(st.quickSwitch, base.settings.quickSwitch),
    confirmSwitch: bool(st.confirmSwitch, base.settings.confirmSwitch),
  };
  const stats: Record<string, ConnectionStats> = {};
  const logs: Record<string, LogEntry[]> = {};
  const rawStats = (r.stats && typeof r.stats === "object" ? r.stats : {}) as Record<string, unknown>;
  const rawLogs = (r.logs && typeof r.logs === "object" ? r.logs : {}) as Record<string, unknown>;
  for (const id of seen) {
    if (rawStats[id]) stats[id] = sanitizeStats(rawStats[id]);
    const log = sanitizeLog(rawLogs[id], policy.logLimit);
    if (log.length) logs[id] = log;
  }
  return { v: 1, profiles, settings, stats, logs };
}

/* ---------------------------------------------------------------- editing */

export type EditResult = { ok: true; state: ConnectionsState; profile: ConnectionProfile } | { ok: false; error: "room" | "passphrase" | "limit" | "server" | "missing" };

/** Adds a connection (no id) or updates one. */
export function saveProfile(state: ConnectionsState, input: ProfileInput & { id?: string }, policy: ConnectionsPolicy, now = Date.now()): EditResult {
  const room = normalizeRoomName(input.room ?? "");
  if (!room) return { ok: false, error: "room" };
  if (!input.passphrase) return { ok: false, error: "passphrase" };
  const server = input.server ? normalizeServerUrl(input.server) : "";
  if (server === null || !serverAllowed(policy, server)) return { ok: false, error: "server" };
  const existing = input.id ? state.profiles.find((p) => p.id === input.id) : undefined;
  if (input.id && !existing) return { ok: false, error: "missing" };
  if (!existing && state.profiles.length >= policy.maxProfiles) return { ok: false, error: "limit" };
  const draft = sanitizeProfile({
    ...existing,
    ...input,
    id: existing?.id ?? newConnectionId(),
    room,
    server,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastUsedAt: existing?.lastUsedAt ?? 0,
  });
  if (!draft) return { ok: false, error: "room" };
  const profiles = existing ? state.profiles.map((p) => (p.id === draft.id ? draft : p)) : [...state.profiles, draft];
  let next: ConnectionsState = { ...state, profiles };
  next = record(next, draft.id, existing ? "edited" : "created", undefined, policy, now);
  // The first connection becomes the default.
  if (!next.settings.defaultId) next = { ...next, settings: { ...next.settings, defaultId: draft.id } };
  return { ok: true, state: next, profile: draft };
}

export function deleteProfile(state: ConnectionsState, id: string): ConnectionsState {
  const profiles = state.profiles.filter((p) => p.id !== id);
  const stats = { ...state.stats };
  const logs = { ...state.logs };
  delete stats[id];
  delete logs[id];
  const defaultId = state.settings.defaultId === id ? (profiles[0]?.id ?? null) : state.settings.defaultId;
  return { ...state, profiles, stats, logs, settings: { ...state.settings, defaultId } };
}

export function setDefault(state: ConnectionsState, id: string | null): ConnectionsState {
  if (id !== null && !state.profiles.some((p) => p.id === id)) return state;
  return { ...state, settings: { ...state.settings, defaultId: id } };
}

export function updateSettings(state: ConnectionsState, patch: Partial<ConnectionSettings>, policy: ConnectionsPolicy): ConnectionsState {
  const settings = { ...state.settings, ...patch };
  settings.collectStats = settings.collectStats && policy.stats;
  if (settings.defaultId && !state.profiles.some((p) => p.id === settings.defaultId)) settings.defaultId = null;
  return { ...state, settings };
}

export function clearLog(state: ConnectionsState, id: string): ConnectionsState {
  const logs = { ...state.logs };
  delete logs[id];
  const stats = { ...state.stats };
  delete stats[id];
  return { ...state, logs, stats };
}

export function findProfile(state: ConnectionsState, id: string | null | undefined): ConnectionProfile | null {
  return id ? state.profiles.find((p) => p.id === id) ?? null : null;
}

/** The default connection, else the one used last. */
export function startupProfile(state: ConnectionsState): ConnectionProfile | null {
  return findProfile(state, state.settings.defaultId)
    ?? [...state.profiles].sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0]
    ?? null;
}

/* -------------------------------------------------------- stats and logs */

export type RecordExtra = { bytes?: number; peers?: number; durationMs?: number };

/** Counts an event and (unless it is a per-message one) logs it. */
export function record(
  state: ConnectionsState, id: string, event: ConnectionEvent, detail: string | undefined,
  policy: ConnectionsPolicy, now = Date.now(), extra: RecordExtra = {},
): ConnectionsState {
  const profile = state.profiles.find((p) => p.id === id);
  if (!profile) return state;
  let profiles = state.profiles;
  if (event === "connect") profiles = state.profiles.map((p) => (p.id === id ? { ...p, lastUsedAt: now } : p));
  const lifecycle = event === "created" || event === "edited";
  if (!state.settings.collectStats && !lifecycle) return profiles === state.profiles ? state : { ...state, profiles };

  const s = { ...(state.stats[id] ?? EMPTY_STATS) };
  switch (event) {
    case "connected": s.connects += 1; s.lastConnectedAt = now; if (extra.peers !== undefined) s.peersMax = Math.max(s.peersMax, extra.peers); break;
    case "disconnected":
      s.lastDisconnectedAt = now;
      if (extra.durationMs && extra.durationMs > 0) { s.totalMs += extra.durationMs; s.longestMs = Math.max(s.longestMs, extra.durationMs); }
      break;
    case "reconnect": s.reconnects += 1; break;
    case "failed": s.failures += 1; break;
    case "error": s.errors += 1; break;
    case "peer-joined": if (extra.peers !== undefined) s.peersMax = Math.max(s.peersMax, extra.peers); break;
    case "sent": s.sent += 1; break;
    case "received": s.received += 1; break;
    case "file-sent": s.filesSent += 1; s.bytesSent += Math.max(0, extra.bytes ?? 0); break;
    case "file-received": s.filesReceived += 1; s.bytesReceived += Math.max(0, extra.bytes ?? 0); break;
    default: break;
  }
  const stats = lifecycle ? state.stats : { ...state.stats, [id]: s };
  let logs = state.logs;
  if (!COUNT_ONLY.has(event) && policy.logLimit > 0) {
    const entry: LogEntry = { at: now, event, ...(detail ? { detail: detail.slice(0, 160) } : {}) };
    logs = { ...state.logs, [id]: [...(state.logs[id] ?? []), entry].slice(-policy.logLimit) };
  }
  return { ...state, profiles, stats, logs };
}

/** For the list: "3 h 12 min". */
export function formatDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return ms > 0 ? "< 1 min" : "0 min";
  const h = Math.floor(min / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d} d ${h % 24} h`;
  return h > 0 ? `${h} h ${min % 60} min` : `${min} min`;
}

/* ------------------------------------------------------------- the store */

type Listener = (state: ConnectionsState) => void;

/**
 * The state plus its trip to the vault. Edits are saved at once; counting
 * events (messages, reconnects) wait a little and go together, so a busy
 * room does not mean an upload per message.
 */
export class ConnectionsStore {
  private state: ConnectionsState;
  private listeners = new Set<Listener>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private saving: Promise<void> = Promise.resolve();
  /** When the active connection's session began (not persisted). */
  private sessionStart = new Map<string, number>();

  constructor(
    private readonly persist: (state: ConnectionsState) => Promise<void>,
    private policy: ConnectionsPolicy,
    private readonly delayMs = 8_000,
  ) {
    this.state = emptyState(policy);
  }

  get(): ConnectionsState { return this.state; }
  getPolicy(): ConnectionsPolicy { return this.policy; }
  setPolicy(policy: ConnectionsPolicy): void {
    this.policy = policy;
    this.state = sanitizeState(this.state, policy);
    this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(): void { for (const l of this.listeners) l(this.state); }

  /** Replaces everything (what came out of the vault); nothing is saved. */
  load(raw: unknown): void {
    this.state = sanitizeState(raw, this.policy);
    this.dirty = false;
    this.emit();
  }

  /** Forgets everything (sign-out); nothing is saved. */
  reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.dirty = false;
    this.sessionStart.clear();
    this.state = emptyState(this.policy);
    this.emit();
  }

  update(fn: (state: ConnectionsState) => ConnectionsState, now = false): ConnectionsState {
    const next = fn(this.state);
    if (next === this.state) return next;
    this.state = next;
    this.dirty = true;
    this.emit();
    if (now) void this.flush();
    else this.schedule();
    return next;
  }

  save(input: ProfileInput & { id?: string }): EditResult {
    const result = saveProfile(this.state, input, this.policy);
    if (result.ok) this.update(() => result.state, true);
    return result;
  }

  remove(id: string): void { this.update((s) => deleteProfile(s, id), true); }
  makeDefault(id: string | null): void { this.update((s) => setDefault(s, id), true); }
  settings(patch: Partial<ConnectionSettings>): void { this.update((s) => updateSettings(s, patch, this.policy), true); }
  clearLog(id: string): void { this.update((s) => clearLog(s, id), true); }

  record(id: string | null | undefined, event: ConnectionEvent, detail?: string, extra: RecordExtra = {}): void {
    if (!id) return;
    const now = Date.now();
    if (event === "connected") this.sessionStart.set(id, now);
    if (event === "disconnected") {
      const start = this.sessionStart.get(id);
      if (start === undefined) return; // not connected: nothing ended
      this.sessionStart.delete(id);
      extra = { ...extra, durationMs: now - start };
    }
    this.update((s) => record(s, id, event, detail, this.policy, now, extra), event === "created" || event === "edited");
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.delayMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Saves now if anything changed (also on page hide and sign-out). */
  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.dirty) return this.saving;
    this.dirty = false;
    const snapshot = this.state;
    this.saving = this.saving.then(() => this.persist(snapshot)).catch(() => { this.dirty = true; });
    return this.saving;
  }
}
