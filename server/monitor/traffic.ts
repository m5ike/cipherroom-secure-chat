// What goes over the wire, as the operator sees it.
//
// Every WebSocket frame and every HTTP request passes through here as a
// small metadata record — never content: frame type, class, size,
// direction, which connection, which peer / account, a hash of the room,
// timing and outcome. The server could not read message bodies if it
// wanted to (they are room-key ciphertext), and this module does not try.
//
// It keeps:
//   - a ring buffer of the latest records (the live traffic view),
//   - per-class counters and a per-second series for the last minutes
//     (the rate charts),
//   - a registry of live connections (who is connected, from where, how
//     busy they are),
// and pushes each record to live subscribers (the admin console's stream),
// dropping for a subscriber that cannot keep up rather than growing
// without bound.
//
// Classification is by frame type / route, so the console can answer
// "what is this traffic?" at a glance: signaling, presence, relay, storage,
// file proxy, heartbeat, account, admin, API, static.

import { createHash, randomBytes } from "node:crypto";

export type TrafficChannel = "ws" | "http";
export type TrafficDirection = "in" | "out";
export type TrafficClass =
  | "signaling" | "presence" | "relay" | "storage" | "file-proxy" | "heartbeat"
  | "account" | "admin" | "push" | "api" | "static" | "error" | "other";

export type TrafficRecord = {
  id: number;
  at: number;
  channel: TrafficChannel;
  direction: TrafficDirection;
  cls: TrafficClass;
  /** Frame type ("join", "relay") or "METHOD /route". */
  type: string;
  bytes: number;
  /** Connection id (WebSocket) or request id (HTTP). */
  conn?: string;
  peerId?: string;
  accountId?: string;
  roomHash?: string;
  /** Truncated client address (/24 or /48). */
  ip?: string;
  /** HTTP status, or "ok" / "error" / "dropped" for frames. */
  status?: number | string;
  durationMs?: number;
  /** Who a forwarded / relayed frame went to. */
  target?: string;
  note?: string;
};

export type ConnectionInfo = {
  id: string;
  kind: "ws";
  openedAt: number;
  lastSeenAt: number;
  ip: string;
  client: string;
  peerId?: string;
  accountId?: string;
  roomHash?: string;
  room?: string;
  name?: string;
  framesIn: number;
  framesOut: number;
  bytesIn: number;
  bytesOut: number;
  rttMs?: number;
  protocol?: number;
  away?: boolean;
};

export type ClassCounters = { frames: number; bytesIn: number; bytesOut: number; errors: number };

export type RateSample = { t: number; framesIn: number; framesOut: number; bytesIn: number; bytesOut: number; http: number; errors: number };

type Subscriber = { send: (record: TrafficRecord) => boolean; dropped: number };

const RING_SIZE = 5_000;
const SERIES_SECONDS = 600;

/** Which class a WebSocket frame type belongs to. */
export function classifyFrame(type: string): TrafficClass {
  switch (type) {
    case "join": case "leave": case "signal": case "hello": case "joined":
    case "peer-joined": case "peer-left":
      return "signaling";
    case "presence": case "presence-ack": case "peer-away": case "peer-back": case "peer-gone":
      return "presence";
    case "relay": case "relay-ack": case "relay-deliver": case "relay-status": case "receipt":
      return "relay";
    case "storage": case "storage-result":
      return "storage";
    case "ping": case "pong":
      return "heartbeat";
    case "command-poll": case "command-ack": case "admin-command":
      return "admin";
    case "error":
      return "error";
    default:
      return type.startsWith("proxy-") ? "file-proxy" : "other";
  }
}

/** Which class an HTTP route belongs to. */
export function classifyRoute(method: string, path: string): TrafficClass {
  if (path.startsWith("/api/account")) return "account";
  if (path.startsWith("/api/storage")) return "storage";
  if (path.startsWith("/api/admin") || path.startsWith("/admin")) return "admin";
  if (path.startsWith("/api/push")) return "push";
  if (path.startsWith("/api/")) return "api";
  if (method === "GET") return "static";
  return "other";
}

/** A room name never reaches the monitor in the clear. */
export function hashRoom(room: string | null | undefined): string | undefined {
  if (!room) return undefined;
  return createHash("sha256").update(`m5cet:room:${room}`).digest("hex").slice(0, 16);
}

/** Enough of an address to tell networks apart, not enough to find a home. */
export function truncateIp(ip: string | undefined | null): string {
  const raw = String(ip ?? "").replace(/^::ffff:/, "");
  if (!raw) return "";
  if (raw.includes(":")) return `${raw.split(":").slice(0, 3).join(":")}::/48`;
  const parts = raw.split(".");
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0/24` : raw;
}

/** Browser + OS family from a user agent — the "who is this" of a socket. */
export function clientClass(ua: string | undefined | null): string {
  const s = String(ua ?? "");
  if (!s) return "unknown";
  const browser = /Edg\//.test(s) ? "Edge" : /SamsungBrowser/.test(s) ? "Samsung" : /Firefox|FxiOS/.test(s) ? "Firefox"
    : /Chrome|CriOS/.test(s) ? "Chrome" : /Safari/.test(s) ? "Safari" : /node|undici|curl|wget|python|go-http/i.test(s) ? "script" : "other";
  const os = /iPhone|iPad/.test(s) ? "iOS" : /Android/.test(s) ? "Android" : /Mac OS X/.test(s) ? "macOS"
    : /Windows/.test(s) ? "Windows" : /Linux/.test(s) ? "Linux" : "other";
  return `${browser}/${os}`;
}

export class TrafficMonitor {
  private ring: TrafficRecord[] = [];
  private nextId = 1;
  private counters = new Map<TrafficClass, ClassCounters>();
  private series = new Map<number, RateSample>();
  private connections = new Map<string, ConnectionInfo>();
  private subscribers = new Set<Subscriber>();
  private startedAt = Date.now();
  private totals = { framesIn: 0, framesOut: 0, bytesIn: 0, bytesOut: 0, http: 0, errors: 0, connectionsOpened: 0 };

  constructor(private readonly now: () => number = Date.now) {}

  /* ---------------------------------------------------------- recording */

  record(input: Omit<TrafficRecord, "id" | "at"> & { at?: number }): TrafficRecord {
    const at = input.at ?? this.now();
    const record: TrafficRecord = { ...input, id: this.nextId++, at, bytes: Math.max(0, Math.round(input.bytes || 0)) };

    this.ring.push(record);
    if (this.ring.length > RING_SIZE) this.ring.splice(0, this.ring.length - RING_SIZE);

    const counter = this.counters.get(record.cls) ?? { frames: 0, bytesIn: 0, bytesOut: 0, errors: 0 };
    counter.frames += 1;
    if (record.direction === "in") counter.bytesIn += record.bytes; else counter.bytesOut += record.bytes;
    const failed = record.status === "error" || record.status === "dropped" || (typeof record.status === "number" && record.status >= 400);
    if (failed) counter.errors += 1;
    this.counters.set(record.cls, counter);

    const second = Math.floor(at / 1000);
    const sample = this.series.get(second) ?? { t: second * 1000, framesIn: 0, framesOut: 0, bytesIn: 0, bytesOut: 0, http: 0, errors: 0 };
    if (record.channel === "http") { sample.http += 1; this.totals.http += 1; }
    else if (record.direction === "in") { sample.framesIn += 1; this.totals.framesIn += 1; }
    else { sample.framesOut += 1; this.totals.framesOut += 1; }
    if (record.direction === "in") { sample.bytesIn += record.bytes; this.totals.bytesIn += record.bytes; }
    else { sample.bytesOut += record.bytes; this.totals.bytesOut += record.bytes; }
    if (failed) { sample.errors += 1; this.totals.errors += 1; }
    this.series.set(second, sample);
    if (this.series.size > SERIES_SECONDS + 5) {
      const cutoff = second - SERIES_SECONDS;
      for (const key of this.series.keys()) if (key < cutoff) this.series.delete(key);
    }

    if (record.conn) {
      const conn = this.connections.get(record.conn);
      if (conn) {
        conn.lastSeenAt = at;
        if (record.direction === "in") { conn.framesIn += 1; conn.bytesIn += record.bytes; }
        else { conn.framesOut += 1; conn.bytesOut += record.bytes; }
      }
    }

    for (const subscriber of this.subscribers) {
      if (!subscriber.send(record)) subscriber.dropped += 1;
    }
    return record;
  }

  /* -------------------------------------------------------- connections */

  openConnection(info: { ip?: string; userAgent?: string }): ConnectionInfo {
    const id = `c-${randomBytes(6).toString("hex")}`;
    const at = this.now();
    const conn: ConnectionInfo = {
      id,
      kind: "ws",
      openedAt: at,
      lastSeenAt: at,
      ip: truncateIp(info.ip),
      client: clientClass(info.userAgent),
      framesIn: 0,
      framesOut: 0,
      bytesIn: 0,
      bytesOut: 0,
    };
    this.connections.set(id, conn);
    this.totals.connectionsOpened += 1;
    return conn;
  }

  updateConnection(id: string, patch: Partial<Omit<ConnectionInfo, "id" | "kind" | "openedAt">>): void {
    const conn = this.connections.get(id);
    if (!conn) return;
    if (patch.room !== undefined) patch.roomHash = hashRoom(patch.room);
    Object.assign(conn, patch);
  }

  closeConnection(id: string): ConnectionInfo | null {
    const conn = this.connections.get(id) ?? null;
    this.connections.delete(id);
    return conn;
  }

  liveConnections(): ConnectionInfo[] {
    return [...this.connections.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  /* ------------------------------------------------------------ reading */

  /** Newest first, filtered. */
  query(filter: {
    cls?: TrafficClass;
    channel?: TrafficChannel;
    direction?: TrafficDirection;
    conn?: string;
    peerId?: string;
    accountId?: string;
    roomHash?: string;
    type?: string;
    since?: number;
    beforeId?: number;
    errorsOnly?: boolean;
    limit?: number;
  } = {}): TrafficRecord[] {
    const limit = Math.max(1, Math.min(2_000, filter.limit ?? 200));
    const out: TrafficRecord[] = [];
    for (let i = this.ring.length - 1; i >= 0 && out.length < limit; i -= 1) {
      const r = this.ring[i];
      if (filter.beforeId && r.id >= filter.beforeId) continue;
      if (filter.since && r.at < filter.since) break;
      if (filter.cls && r.cls !== filter.cls) continue;
      if (filter.channel && r.channel !== filter.channel) continue;
      if (filter.direction && r.direction !== filter.direction) continue;
      if (filter.conn && r.conn !== filter.conn) continue;
      if (filter.peerId && r.peerId !== filter.peerId && r.target !== filter.peerId) continue;
      if (filter.accountId && r.accountId !== filter.accountId && r.target !== filter.accountId) continue;
      if (filter.roomHash && r.roomHash !== filter.roomHash) continue;
      if (filter.type && r.type !== filter.type) continue;
      if (filter.errorsOnly && !(r.status === "error" || r.status === "dropped" || (typeof r.status === "number" && r.status >= 400))) continue;
      out.push(r);
    }
    return out;
  }

  /** The last `seconds` of per-second samples, oldest first, gaps filled. */
  rates(seconds = 120): RateSample[] {
    const end = Math.floor(this.now() / 1000);
    const start = end - Math.max(1, Math.min(SERIES_SECONDS, seconds)) + 1;
    const out: RateSample[] = [];
    for (let s = start; s <= end; s += 1) {
      out.push(this.series.get(s) ?? { t: s * 1000, framesIn: 0, framesOut: 0, bytesIn: 0, bytesOut: 0, http: 0, errors: 0 });
    }
    return out;
  }

  summary() {
    const classes: Record<string, ClassCounters> = {};
    for (const [cls, counter] of this.counters) classes[cls] = { ...counter };
    const last = this.rates(60);
    const perMinute = last.reduce((acc, s) => ({
      framesIn: acc.framesIn + s.framesIn,
      framesOut: acc.framesOut + s.framesOut,
      bytesIn: acc.bytesIn + s.bytesIn,
      bytesOut: acc.bytesOut + s.bytesOut,
      http: acc.http + s.http,
      errors: acc.errors + s.errors,
    }), { framesIn: 0, framesOut: 0, bytesIn: 0, bytesOut: 0, http: 0, errors: 0 });
    return {
      since: this.startedAt,
      totals: { ...this.totals },
      lastMinute: perMinute,
      classes,
      connections: this.connections.size,
      buffered: this.ring.length,
      subscribers: this.subscribers.size,
    };
  }

  /* -------------------------------------------------------- live stream */

  /** A live subscriber; `send` returns false when it had to drop. */
  subscribe(send: (record: TrafficRecord) => boolean): () => void {
    const subscriber: Subscriber = { send, dropped: 0 };
    this.subscribers.add(subscriber);
    return () => { this.subscribers.delete(subscriber); };
  }

  /** Test seam. */
  reset(): void {
    this.ring = [];
    this.counters.clear();
    this.series.clear();
    this.connections.clear();
    this.subscribers.clear();
    this.nextId = 1;
    this.totals = { framesIn: 0, framesOut: 0, bytesIn: 0, bytesOut: 0, http: 0, errors: 0, connectionsOpened: 0 };
    this.startedAt = this.now();
  }
}

export const traffic = new TrafficMonitor();
