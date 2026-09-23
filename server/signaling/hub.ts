// The signaling hub: every WebSocket at /ws, protocol version 2.
//
// What a socket goes through, in order:
//
//   upgrade   path /ws only; Origin must be this site (or ALLOWED_ORIGINS);
//             per-address connection gate (opened per minute, open at once,
//             total) — refused with 429/503 before any WebSocket exists
//   hello     the server names the connection and proposes a peer id
//   frames    each one: size cap (ws maxPayload) → parse into an exact shape
//             (frames.ts) → token bucket for its class (limits.ts) → act.
//             Refusals are answered, and a socket that keeps earning them
//             is closed (1008)
//   close     leases on queued messages are released, file transfers it was
//             sending end, and a signed-in member with away enabled stays
//             in the room as away (relay.ts)
//
// Identity rules that changed from version 1:
//   - a peer id already used in the room is not taken over; the joiner gets
//     a fresh one unless it proves it is the same client (the resume secret
//     from its previous `joined`)
//   - members with an account are shown to the room by a room-scoped
//     reference, never by the account id (refs.ts)
//   - a session token can be added or dropped with an `auth` frame without
//     leaving the room, and signing out ends it on open sockets at once
//
// Forwarded frames are rebuilt from validated fields; nothing a client
// sends is spread into what another client receives.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { AccountStore, PushTarget } from "../accounts/store";
import { tokenHash } from "../accounts/store";
import type { OfflineQueue } from "../accounts/mailqueue";
import { FileProxy } from "../file-proxy";
import { adminCommandAudit, drain as drainCommands, type AdminCommand } from "../routes-admin-shared";
import { eventStore } from "../events";
import { audit } from "../monitor/audit";
import { classifyFrame, hashRoom, traffic, truncateIp } from "../monitor/traffic";
import type { StorageFrame, StorageSocketState } from "../storage/ws";
import type { TrustProxyValue } from "../trust-proxy";
import { isBinaryError, parseBinaryChunk, type BinaryProxyChunk } from "./binary";
import type { ClusterBus } from "../cluster/bus";
import { ClusterRooms, type MemberView } from "./cluster";
import { isFrameError, KNOWN_FEATURES, MAX_FRAME_BYTES, parseFrame, PROTOCOL_VERSION, type ClientFrame } from "./frames";
import { ConnectionGate, limitClassOf, LIMITS, PROXY_BYTES, SocketLimiter } from "./limits";
import { accountRef } from "./refs";
import { AwayRelay, type RelayPeer } from "./relay";

export type HubClient = RelayPeer & {
  joinedAt: number;
  ip: string;
  protocol: number;
  limiter: SocketLimiter;
  storage: StorageSocketState;
  tokenHash?: string;
  resumeHash?: string;
  alive: boolean;
  closed: boolean;
  /** Set by command-poll: operator commands for this device come here. */
  deviceId?: string;
  /** Joined with the "bin" feature: gets file chunks as binary messages. */
  binary?: boolean;
};

type PushFn = (target: PushTarget, payload: { title: string; body: string; url: string; tag: string; kind?: string }) => Promise<{ ok: boolean; error?: string }>;

export type HubOptions = {
  accounts: AccountStore;
  queue: () => OfflineQueue | null;
  push?: PushFn;
  storageFrame: (socket: WebSocket, state: StorageSocketState, frame: StorageFrame, send: (socket: WebSocket, payload: unknown) => void) => void;
  /** Per-socket storage state; the address counts toward the session caps. */
  newStorageState: (ip: string) => StorageSocketState;
  trustProxy?: TrustProxyValue;
  /** Extra origins allowed to open /ws (ALLOWED_ORIGINS, comma-separated). */
  allowedOrigins?: string[];
  /** Other instances (REDIS_URL): rooms span them (cluster.ts). */
  cluster?: ClusterBus;
  path?: string;
  heartbeatMs?: number;
  gate?: ConnectionGate;
};

/** Beyond this, a slow receiver gets no more file chunks (it asks again later). */
const PROXY_BACKPRESSURE_BYTES = 8 * 1024 * 1024;
/** Beyond this, a receiver that stopped reading is disconnected. */
const HARD_BACKPRESSURE_BYTES = 32 * 1024 * 1024;
const HEARTBEAT_MS = 30_000;

const sha = (s: string) => createHash("sha256").update(s).digest();
const newId = (bytes: number) => randomBytes(bytes).toString("base64url");

/** The client's address as the trusted proxies report it. */
export function clientAddress(req: IncomingMessage, trust: TrustProxyValue = "loopback"): string {
  const remote = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  const header = req.headers["x-forwarded-for"];
  const chain = (Array.isArray(header) ? header.join(",") : header ?? "")
    .split(",").map((s) => s.trim().replace(/^::ffff:/, "")).filter(Boolean);
  if (trust === false || trust === 0 || chain.length === 0) return remote;
  if (trust === true) return chain[0];
  if (typeof trust === "number") {
    const all = [...chain, remote];
    return all[Math.max(0, all.length - 1 - trust)];
  }
  // A preset or list ("loopback", "uniquelocal", CIDRs): trust the proxy
  // only when it connected from a local or private address.
  const local = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd][0-9a-f]{2}:|fe80:)/i.test(remote);
  return local ? chain[chain.length - 1] : remote;
}

export function originAllowed(req: IncomingMessage, extra: string[] = []): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // not a browser: nothing ambient to protect
  if (extra.includes(origin) || extra.includes("*")) return true;
  try {
    const host = new URL(origin).host.toLowerCase();
    const forwarded = String(req.headers["x-forwarded-host"] ?? "").split(",")[0].trim().toLowerCase();
    return host === String(req.headers.host ?? "").toLowerCase() || (forwarded !== "" && host === forwarded);
  } catch {
    return false;
  }
}

function refuse(socket: Duplex, status: number, reason: string): void {
  const text = status === 429 ? "Too Many Requests" : status === 403 ? "Forbidden" : status === 503 ? "Service Unavailable" : "Bad Request";
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(reason)}\r\n\r\n${reason}`);
  } catch { /* already gone */ }
  socket.destroy();
}

export class SignalingHub {
  readonly rooms = new Map<string, Map<string, HubClient>>();
  readonly relay: AwayRelay;
  readonly proxy = new FileProxy();
  readonly gate: ConnectionGate;
  private readonly clients = new Map<string, HubClient>();
  private readonly wss: WebSocketServer;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly unsubscribe: () => void;
  private readonly path: string;
  /** Members on other instances, and the routes to them; null when alone. */
  readonly cluster: ClusterRooms | null;

  constructor(private readonly opts: HubOptions) {
    this.path = opts.path ?? "/ws";
    this.gate = opts.gate ?? new ConnectionGate();
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
    this.relay = new AwayRelay(
      opts.accounts,
      this.rooms as unknown as Map<string, Map<string, RelayPeer>>,
      (socket, payload) => this.send(socket, payload),
      opts.queue,
      opts.push,
    );
    this.relay.restore(opts.accounts.allAway());
    this.unsubscribe = opts.accounts.onRevoke((accountId, hash, reason) => {
      this.onRevoke(accountId, hash, reason);
      this.cluster?.revoke(accountId, hash, reason);
    });
    this.cluster = opts.cluster && opts.cluster.kind !== "local" ? this.joinCluster(opts.cluster) : null;
  }

  /* -------------------------------------------------------------- cluster */

  private joinCluster(bus: ClusterBus): ClusterRooms {
    // Account state is in files every instance reads: see what the others wrote.
    this.opts.accounts.shareDisk();
    const cluster = new ClusterRooms(bus, {
      localRooms: () => [...this.rooms].map(([room, members]) => ({ room, members: [...members.values()].map((m) => this.memberView(m)) })),
      joined: (room, m) => this.broadcast(room, { type: "peer-joined", ...this.publicView(room, m) }),
      updated: (room, m) => this.broadcast(room, { type: "peer-updated", peerId: m.peerId, name: m.name, ...(m.accountId ? this.refFields(room, m.accountId) : { account: null, accountId: null }) }),
      toLocal: (room, payload, except) => {
        for (const peer of this.members(room)) if (peer.id !== except) this.send(peer.socket, payload, peer);
      },
      chunkToLocal: (room, raw, json, except) => {
        for (const peer of this.members(room)) if (peer.id !== except) this.send(peer.socket, peer.binary ? raw : json, peer);
      },
      toLocalPeer: (room, peerId, payload) => {
        const peer = this.rooms.get(room)?.get(peerId);
        return peer ? this.send(peer.socket, payload, peer) : false;
      },
      toTransferSender: (room, transferId, payload) => {
        const key = this.proxy.senderOf(transferId);
        const sender = key ? this.clients.get(key) : undefined;
        if (sender && sender.room === room) this.send(sender.socket, payload, sender);
      },
      evictLocal: (room, peerId) => {
        const holder = this.rooms.get(room)?.get(peerId);
        if (!holder) return;
        this.send(holder.socket, { type: "replaced", reason: "the same client connected again" }, holder);
        this.leaveRoom(holder, false, true);
        try { holder.socket.close(4001, "replaced"); } catch { /* ignore */ }
      },
      revoke: (accountId, hash, reason) => this.onRevoke(accountId, hash, reason as Parameters<SignalingHub["onRevoke"]>[2], true),
      away: (room, accountId, entry) => this.relay.applyRemoteAway(room, accountId, entry),
    });
    this.relay.cluster = {
      broadcast: (room, payload, except) => cluster.broadcast(room, payload, except),
      away: (room, accountId, entry) => cluster.away(room, accountId, entry),
    };
    cluster.start();
    return cluster;
  }

  /** What other instances learn about a member (never leaves the servers). */
  private memberView(peer: HubClient): MemberView {
    return {
      peerId: peer.id, name: peer.name, joinedAt: peer.joinedAt,
      ...(peer.accountId ? { accountId: peer.accountId } : {}),
      ...(peer.resumeHash ? { resumeHash: peer.resumeHash } : {}),
      ...(peer.binary ? { binary: true } : {}),
    };
  }

  /** What a client learns about a member: account ids become room-scoped references. */
  private publicView(room: string, m: MemberView) {
    return { peerId: m.peerId, name: m.name, joinedAt: m.joinedAt, ...(m.accountId ? this.refFields(room, m.accountId) : {}) };
  }

  /** A frame for the room on this instance and on the others. */
  private broadcastAll(room: string, payload: Record<string, unknown>, except?: HubClient): void {
    this.broadcast(room, payload, except);
    this.cluster?.broadcast(room, payload, except?.id);
  }

  /* --------------------------------------------------------------- wiring */

  attach(server: Server): void {
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      let pathname = "";
      try { pathname = new URL(req.url ?? "/", "http://x").pathname; } catch { /* malformed */ }
      if (pathname !== this.path) return; // someone else's (e.g. Vite HMR)
      this.upgrade(req, socket, head);
    });
    this.heartbeat = setInterval(() => this.beat(), this.opts.heartbeatMs ?? HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const ip = clientAddress(req, this.opts.trustProxy);
    if (!originAllowed(req, this.opts.allowedOrigins)) {
      audit.add({ category: "security", level: "warn", event: "ws.origin-refused", ip: truncateIp(ip), detail: { origin: String(req.headers.origin).slice(0, 120) } });
      return refuse(socket, 403, "origin not allowed");
    }
    const refused = this.gate.admit(ip);
    if (refused) {
      audit.add({ category: "network", level: "notice", event: "ws.refused", ip: truncateIp(ip), status: refused });
      return refuse(socket, refused === "server-full" ? 503 : 429, refused);
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.connected(ws, req, ip));
  }

  /** Stops accepting, closes every socket (clients reconnect elsewhere). */
  async shutdown(reason = "server restarting"): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.unsubscribe();
    this.cluster?.stop();
    for (const client of this.clients.values()) {
      try { client.socket.close(1012, reason); } catch { /* ignore */ }
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  /* ----------------------------------------------------------------- send */

  /** Sends a frame; false when it could not (closed, or dropped under load). */
  send(socket: WebSocket, payload: unknown, client?: HubClient): boolean {
    if (socket.readyState !== WebSocket.OPEN) return false;
    const target = client ?? this.bySocket(socket);
    // A Buffer is a binary proxy chunk, the only binary message (binary.ts).
    const type = payload instanceof Buffer ? "proxy-chunk"
      : typeof (payload as { type?: unknown })?.type === "string" ? (payload as { type: string }).type : "unknown";
    if (socket.bufferedAmount > HARD_BACKPRESSURE_BYTES) {
      if (target && !target.closed) {
        audit.add({ category: "network", level: "warn", event: "ws.slow-consumer", peerId: target.id, ip: truncateIp(target.ip), bytes: socket.bufferedAmount });
        socket.terminate();
      }
      return false;
    }
    if (type.startsWith("proxy-") && socket.bufferedAmount > PROXY_BACKPRESSURE_BYTES) {
      traffic.record({ channel: "ws", direction: "out", cls: "file-proxy", type, bytes: 0, conn: target?.connId, peerId: target?.id, status: "dropped", note: "backpressure" });
      return false;
    }
    const data = payload instanceof Buffer ? payload : JSON.stringify(payload);
    socket.send(data, { binary: typeof data !== "string" });
    traffic.record({
      channel: "ws", direction: "out", cls: classifyFrame(type), type, bytes: typeof data === "string" ? Buffer.byteLength(data) : data.length,
      conn: target?.connId, peerId: target?.id, accountId: target?.accountId, roomHash: hashRoom(target?.room),
    });
    return true;
  }

  /** A binary proxy chunk: verbatim to peers that read binary, as JSON to the rest. */
  private sendChunk(peer: HubClient, chunk: BinaryProxyChunk, json: () => Record<string, unknown>): boolean {
    if (peer.binary) return this.send(peer.socket, chunk.raw, peer);
    return this.send(peer.socket, json(), peer);
  }

  private socketIndex = new WeakMap<WebSocket, HubClient>();

  private bySocket(socket: WebSocket): HubClient | undefined {
    return this.socketIndex.get(socket);
  }

  private members(room: string): HubClient[] {
    return [...(this.rooms.get(room)?.values() ?? [])];
  }

  private broadcast(room: string, payload: unknown, except?: HubClient): void {
    for (const peer of this.members(room)) if (peer !== except) this.send(peer.socket, payload, peer);
  }

  private error(client: HubClient, code: string, message: string, extra: Record<string, unknown> = {}): void {
    this.send(client.socket, { type: "error", code, message, ...extra }, client);
  }

  /* ----------------------------------------------------------- connection */

  private connected(socket: WebSocket, req: IncomingMessage, ip: string): void {
    const conn = traffic.openConnection({ ip, userAgent: req.headers["user-agent"] });
    const client: HubClient = {
      id: `p-${newId(12)}`,
      connId: conn.id,
      room: null,
      name: "Anonymous",
      joinedAt: Date.now(),
      socket,
      ip,
      protocol: 1,
      limiter: new SocketLimiter(),
      storage: this.opts.newStorageState(ip),
      alive: true,
      closed: false,
    };
    this.clients.set(client.connId, client);
    this.socketIndex.set(socket, client);

    socket.on("pong", () => { client.alive = true; });
    socket.on("message", (data, isBinary) => {
      if (isBinary) return this.onBinary(client, Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data as ArrayBuffer)]));
      this.onFrame(client, data as Buffer);
    });
    socket.on("close", (code) => this.closed(client, code));
    socket.on("error", () => this.closed(client, 1006));

    this.send(socket, {
      type: "hello",
      protocol: PROTOCOL_VERSION,
      peerId: client.id,
      connId: client.connId,
      serverTime: Date.now(),
      limits: { maxFrameBytes: MAX_FRAME_BYTES, proxy: { bytesPerSec: PROXY_BYTES.refillPerSec, burstBytes: PROXY_BYTES.capacity, framesPerSec: LIMITS.proxy.refillPerSec, burstFrames: LIMITS.proxy.capacity } },
      features: [...KNOWN_FEATURES],
      cache: "no-store",
    }, client);
  }

  private closed(client: HubClient, code: number): void {
    if (client.closed) return;
    client.closed = true;
    this.clients.delete(client.connId);
    this.gate.release(client.ip);
    this.relay.release(client);
    this.endTransfersOf(client);
    // Losing the socket is not a goodbye: a signed-in member with away
    // enabled stays reachable through the relay.
    this.leaveRoom(client, true);
    const info = traffic.closeConnection(client.connId);
    if (code !== 1000 && code !== 1001 && code !== 1005) {
      audit.add({ category: "network", level: "debug", event: "ws.closed", peerId: client.id, ip: truncateIp(client.ip), status: String(code), detail: info ? { frames: info.framesIn + info.framesOut, bytes: info.bytesIn + info.bytesOut } : undefined });
    }
  }

  /** Pings every socket; one that did not answer the last ping is gone. */
  private beat(): void {
    for (const client of this.clients.values()) {
      if (!client.alive) {
        audit.add({ category: "network", level: "debug", event: "ws.heartbeat-timeout", peerId: client.id, ip: truncateIp(client.ip) });
        client.socket.terminate();
        continue;
      }
      client.alive = false;
      try { client.socket.ping(); } catch { /* closing */ }
    }
  }

  /* --------------------------------------------------------------- frames */

  private onFrame(client: HubClient, data: Buffer): void {
    client.alive = true;
    const parsed = parseFrame(data);
    const type = isFrameError(parsed) ? "invalid" : parsed.type;
    traffic.record({
      channel: "ws", direction: "in", cls: isFrameError(parsed) ? "error" : classifyFrame(type), type, bytes: data.length,
      conn: client.connId, peerId: client.id, accountId: client.accountId, roomHash: hashRoom(client.room),
      status: isFrameError(parsed) ? "error" : "ok",
    });
    if (isFrameError(parsed)) {
      client.limiter.allow("other");
      this.error(client, parsed.code, parsed.message);
      if (client.limiter.abusive) this.kick(client, "too many invalid frames");
      return;
    }
    const cls = limitClassOf(parsed.type);
    const bytes = parsed.type === "proxy-chunk" || parsed.type === "proxy-meta" ? parsed.ciphertext.length : 0;
    if (!client.limiter.allow(cls, bytes)) {
      this.send(client.socket, { type: "rate-limited", frame: parsed.type, retryAfterMs: client.limiter.retryAfter(cls) }, client);
      if (client.limiter.abusive) this.kick(client, "rate limits exceeded");
      return;
    }
    try {
      this.dispatch(client, parsed);
    } catch (err) {
      audit.add({ category: "system", level: "error", event: "ws.handler-failed", peerId: client.id, detail: { frame: parsed.type, error: (err as Error).message } });
      this.error(client, "server-error", "the server could not handle this frame");
    }
  }

  /** The only binary message: a file chunk for the proxy (binary.ts). */
  private onBinary(client: HubClient, data: Buffer): void {
    client.alive = true;
    const parsed = parseBinaryChunk(data, MAX_FRAME_BYTES);
    traffic.record({
      channel: "ws", direction: "in", cls: isBinaryError(parsed) ? "error" : "file-proxy", type: isBinaryError(parsed) ? "invalid" : "proxy-chunk", bytes: data.length,
      conn: client.connId, peerId: client.id, accountId: client.accountId, roomHash: hashRoom(client.room),
      status: isBinaryError(parsed) ? "error" : "ok",
    });
    if (isBinaryError(parsed)) {
      client.limiter.allow("other");
      this.error(client, "invalid-frame", parsed.error);
      if (client.limiter.abusive) this.kick(client, "too many invalid frames");
      return;
    }
    // Rate limits count the base64 length, as for the JSON frame.
    if (!client.limiter.allow("proxy", Math.ceil(parsed.ciphertext.length / 3) * 4)) {
      this.send(client.socket, { type: "rate-limited", frame: "proxy-chunk", retryAfterMs: client.limiter.retryAfter("proxy") }, client);
      if (client.limiter.abusive) this.kick(client, "rate limits exceeded");
      return;
    }
    const room = client.room;
    if (!room) return this.error(client, "not-in-room", "join a room first");
    const pushed = this.proxy.pushChunk(client.connId, { transferId: parsed.transferId, seq: parsed.seq, bytes: parsed.ciphertext.length });
    if (!pushed.ok) return this.error(client, "proxy-refused", pushed.reason ?? "refused", { transferId: parsed.transferId });
    let json: Record<string, unknown> | null = null;
    const asJson = () => (json ??= {
      kind: "proxy-chunk", type: "proxy-chunk", transferId: parsed.transferId, transport: "proxy", from: client.id,
      ...(parsed.v ? { v: parsed.v } : {}), seq: parsed.seq, iv: parsed.iv.toString("base64"), ciphertext: parsed.ciphertext.toString("base64"),
    });
    for (const peer of this.members(room)) if (peer !== client) this.sendChunk(peer, parsed, asJson);
    this.cluster?.chunk(room, parsed.raw, asJson(), client.id);
  }

  private kick(client: HubClient, reason: string): void {
    audit.add({ category: "security", level: "warn", event: "ws.kicked", peerId: client.id, accountId: client.accountId, ip: truncateIp(client.ip), status: reason });
    try { client.socket.close(1008, reason); } catch { /* ignore */ }
  }

  private dispatch(client: HubClient, frame: ClientFrame): void {
    switch (frame.type) {
      case "join": return this.join(client, frame);
      case "auth": return this.authenticate(client, frame.token, frame.away);
      case "leave": return this.leaveRoom(client, frame.away);
      case "signal": return this.signal(client, frame);
      case "ping":
        this.send(client.socket, { type: "pong", t: frame.t, serverTs: Date.now() }, client);
        return;
      case "presence": {
        const away = this.relay.setPresence(client, frame.away);
        traffic.updateConnection(client.connId, { away: frame.away });
        this.send(client.socket, { type: "presence-ack", away }, client);
        // Back at the keyboard: hand over whatever arrived meanwhile.
        if (!frame.away) this.relay.deliver(client);
        return;
      }
      case "relay":
        if (!client.room) return this.error(client, "not-in-room", "join a room first");
        void this.relay.relay(client, frame).catch((err) => {
          audit.add({ category: "system", level: "error", event: "relay.failed", peerId: client.id, detail: { error: (err as Error).message } });
        });
        return;
      case "relay-ack":
        this.relay.ack(client, frame.ids);
        return;
      case "receipt":
        this.relay.receipt(client, frame.messageIds, frame.state);
        return;
      case "command-poll":
        client.deviceId = frame.deviceId;
        this.sendCommands(client);
        return;
      case "command-ack":
        adminCommandAudit.push({ ts: Date.now(), kind: "ack", commandId: frame.commandId, peerId: client.id, result: frame.result });
        if (adminCommandAudit.length > 1000) adminCommandAudit.splice(0, adminCommandAudit.length - 1000);
        return;
      case "storage":
        this.opts.storageFrame(client.socket, client.storage, frame, (socket, payload) => { this.send(socket, payload, client); });
        return;
      case "proxy-meta":
      case "proxy-chunk":
      case "proxy-end":
      case "proxy-cancel":
      case "proxy-need":
        return this.proxyFrame(client, frame);
    }
  }

  /* ----------------------------------------------------------------- rooms */

  private join(client: HubClient, frame: Extract<ClientFrame, { type: "join" }>): void {
    this.leaveRoom(client, false);
    client.protocol = frame.protocol;
    client.binary = frame.features?.includes("bin") ?? false;
    client.name = frame.name;

    const room = frame.room;
    let members = this.rooms.get(room);
    if (!members) { members = new Map(); this.rooms.set(room, members); }

    // Keep the requested peer id unless another live socket holds it; the
    // same client coming back (resume secret) takes its place instead.
    const wanted = frame.peerId;
    let peerId = client.id;
    const remoteHolder = wanted ? this.cluster?.member(room, wanted) : undefined;
    if (wanted && remoteHolder && !members.has(wanted)) {
      // Held on another instance: only the same client (resume secret) takes it over.
      const held = Buffer.from(remoteHolder.resumeHash ?? "", "base64url");
      if (frame.resume && held.length === 32 && timingSafeEqual(sha(frame.resume), held)) {
        peerId = wanted;
        this.cluster!.evict(room, wanted);
      } else {
        audit.add({ category: "security", level: "notice", event: "join.peer-id-taken", peerId: wanted, roomHash: hashRoom(room), ip: truncateIp(client.ip) });
      }
    } else if (wanted) {
      const holder = members.get(wanted);
      if (!holder) {
        peerId = wanted;
      } else if (frame.resume && holder.resumeHash && timingSafeEqual(sha(frame.resume), Buffer.from(holder.resumeHash, "base64url"))) {
        peerId = wanted;
        this.send(holder.socket, { type: "replaced", reason: "the same client connected again" }, holder);
        this.leaveRoom(holder, false, true);
        try { holder.socket.close(4001, "replaced"); } catch { /* ignore */ }
      } else {
        audit.add({ category: "security", level: "notice", event: "join.peer-id-taken", peerId: wanted, roomHash: hashRoom(room), ip: truncateIp(client.ip) });
      }
    }
    client.id = peerId;
    const resume = newId(24);
    client.resumeHash = sha(resume).toString("base64url");

    const account = this.resolveAccount(client, frame.auth ?? null, frame.away);
    client.room = room;

    const view = (peer: HubClient) => ({
      peerId: peer.id,
      name: peer.name,
      joinedAt: peer.joinedAt,
      ...(peer.accountId ? this.refFields(room, peer.accountId) : {}),
    });
    const existing = [...members.values()].map(view);
    for (const m of this.cluster?.members(room) ?? []) if (m.peerId !== client.id) existing.push(this.publicView(room, m));
    members.set(client.id, client);
    traffic.updateConnection(client.connId, { peerId: client.id, room, name: client.name, accountId: client.accountId, protocol: client.protocol });

    this.send(client.socket, {
      type: "joined",
      protocol: PROTOCOL_VERSION,
      peerId: client.id,
      room,
      resume,
      peers: existing,
      // Signed-in members who are away: messages to them go through the relay.
      away: this.relay.awayList(room, client.accountId).map((a) => ({ ...a, accountId: a.account })),
      account: account
        ? { ...this.refFields(room, account), away: Boolean(client.awayEnabled) }
        : frame.auth ? { invalid: true } : null,
      policy: { transport: "webrtc-datachannel", persistence: "none", cache: "no-store", signalingOnly: true },
    }, client);

    this.broadcast(room, { type: "peer-joined", ...view(client) }, client);
    this.cluster?.join(room, this.memberView(client));
    this.relay.onJoin(client);

    eventStore.record({ kind: "peer-joined", room, peerId: client.id, meta: { peerCount: members.size } });
    audit.add({ category: "communication", event: "room.join", peerId: client.id, accountId: client.accountId, roomHash: hashRoom(room), ip: truncateIp(client.ip), detail: { members: members.size, protocol: client.protocol } });
  }

  /** `account` and its deprecated alias `accountId` carry the same room-scoped reference. */
  private refFields(room: string, accountId: string): { account: string; accountId: string } {
    const ref = accountRef(room, accountId);
    return { account: ref, accountId: ref };
  }

  /** Binds (or drops) a session token on this socket. Returns the account id. */
  private resolveAccount(client: HubClient, token: string | null, away: boolean): string | null {
    const account = token ? this.opts.accounts.resolveToken(token) : null;
    client.accountId = account?.id;
    client.tokenHash = account && token ? tokenHash(token) : undefined;
    client.awayEnabled = Boolean(account && away);
    if (token && !account) audit.add({ category: "security", level: "notice", event: "auth.invalid-token", peerId: client.id, ip: truncateIp(client.ip) });
    return account?.id ?? null;
  }

  /** Sign in or out without leaving the room. */
  private authenticate(client: HubClient, token: string | null, away: boolean): void {
    const before = client.accountId;
    if (before && client.room) this.relay.release(client);
    const accountId = this.resolveAccount(client, token, away);
    traffic.updateConnection(client.connId, { accountId: client.accountId });
    const room = client.room;
    this.send(client.socket, {
      type: "auth-result",
      ok: Boolean(accountId) || token === null,
      account: accountId && room ? { ...this.refFields(room, accountId), away: Boolean(client.awayEnabled) } : accountId ? { away: Boolean(client.awayEnabled) } : null,
      ...(token && !accountId ? { invalid: true } : {}),
    }, client);
    if (!room || before === accountId) {
      if (room && accountId) this.relay.onJoin(client);
      return;
    }
    this.broadcast(room, { type: "peer-updated", peerId: client.id, name: client.name, ...(accountId ? this.refFields(room, accountId) : { account: null, accountId: null }) }, client);
    this.cluster?.update(room, this.memberView(client));
    if (accountId) this.relay.onJoin(client);
    audit.add({ category: "account", event: accountId ? "auth.bound" : "auth.dropped", peerId: client.id, accountId: accountId ?? before, roomHash: hashRoom(room) });
  }

  /** `wantsAway`: a signed-in member with away enabled stays in the room as
   *  away instead of leaving. `quiet`: the same peer is coming right back. */
  private leaveRoom(client: HubClient, wantsAway: boolean, quiet = false): void {
    const room = client.room;
    if (!room) return;
    const members = this.rooms.get(room);
    if (members?.get(client.id) === client) members.delete(client.id);
    client.room = null;
    if (members && members.size === 0) this.rooms.delete(room);
    if (!quiet) {
      this.broadcast(room, { type: "peer-left", peerId: client.id });
      this.cluster?.leave(room, client.id);
    }
    this.relay.release(client);
    if (!quiet) this.relay.onLeave(client, room, wantsAway);
    traffic.updateConnection(client.connId, { room: undefined, roomHash: undefined });
    eventStore.record({ kind: "peer-left", room, peerId: client.id });
    audit.add({ category: "communication", event: "room.leave", peerId: client.id, accountId: client.accountId, roomHash: hashRoom(room), status: wantsAway ? "away" : "left" });
  }

  private signal(client: HubClient, frame: Extract<ClientFrame, { type: "signal" }>): void {
    if (!client.room) return this.error(client, "not-in-room", "join a room first");
    const peer = this.rooms.get(client.room)?.get(frame.target);
    if (!peer) {
      if (this.cluster?.signal(client.room, frame.target, { type: "signal", source: client.id, payload: frame.payload })) return;
      this.send(client.socket, { type: "signal-undeliverable", target: frame.target }, client);
      return;
    }
    this.send(peer.socket, { type: "signal", source: client.id, payload: frame.payload }, peer);
  }

  /* ------------------------------------------------------------ file proxy */

  private proxyFrame(client: HubClient, frame: Extract<ClientFrame, { type: `proxy-${string}` }>): void {
    const room = client.room;
    if (!room) return this.error(client, "not-in-room", "join a room first");
    const base = { kind: frame.type, type: frame.type, transferId: frame.transferId, transport: "proxy", from: client.id };
    const senderKey = this.proxy.senderOf(frame.transferId);
    const isSender = senderKey === client.connId;

    switch (frame.type) {
      case "proxy-meta": {
        const begun = this.proxy.begin(client.connId, frame, Math.floor((frame.ciphertext.length * 3) / 4));
        if (begun.ok) this.broadcastAll(room, { ...base, ...(frame.v ? { v: frame.v } : {}), iv: frame.iv, ciphertext: frame.ciphertext }, client);
        this.send(client.socket, { type: "proxy-ack", transferId: frame.transferId, transport: "proxy", accepted: begun.ok, ...(begun.reason ? { reason: begun.reason } : {}) }, client);
        return;
      }
      case "proxy-chunk": {
        const pushed = this.proxy.pushChunk(client.connId, frame);
        if (!pushed.ok) return this.error(client, "proxy-refused", pushed.reason ?? "refused", { transferId: frame.transferId });
        this.broadcastAll(room, { ...base, ...(frame.v ? { v: frame.v } : {}), seq: frame.seq, iv: frame.iv, ciphertext: frame.ciphertext }, client);
        return;
      }
      case "proxy-end": {
        const ended = this.proxy.end(client.connId, frame.transferId);
        if (!ended.ok) return this.error(client, "proxy-refused", ended.reason ?? "refused", { transferId: frame.transferId });
        this.broadcastAll(room, { ...base, ...(frame.v ? { v: frame.v } : {}), ...(frame.iv && frame.ciphertext ? { iv: frame.iv, ciphertext: frame.ciphertext } : {}) }, client);
        eventStore.record({ kind: "proxy-end", meta: { transferId: frame.transferId, room } });
        return;
      }
      case "proxy-cancel": {
        if (isSender) {
          this.proxy.cancel(frame.transferId);
          this.broadcastAll(room, base, client);
        } else {
          // A receiver declining: only the sender needs to know.
          const sender = senderKey ? this.clients.get(senderKey) : undefined;
          if (sender && sender.room === room) this.send(sender.socket, base, sender);
          else if (!senderKey) this.cluster?.toSender(room, frame.transferId, base);
        }
        return;
      }
      case "proxy-need": {
        // Receiver → sender only: repeat these chunks.
        const sender = senderKey ? this.clients.get(senderKey) : undefined;
        if (!senderKey) return this.cluster?.toSender(room, frame.transferId, { ...base, seqs: frame.seqs });
        if (!sender || sender.room !== room || isSender) return;
        this.send(sender.socket, { ...base, seqs: frame.seqs }, sender);
        return;
      }
    }
  }

  private endTransfersOf(client: HubClient): void {
    const ids = this.proxy.dropSender(client.connId);
    if (!client.room) return;
    for (const transferId of ids) {
      this.broadcastAll(client.room, { kind: "proxy-cancel", type: "proxy-cancel", transferId, transport: "proxy", from: client.id, reason: "sender disconnected" }, client);
    }
  }

  /* ------------------------------------------------------------ revocation */

  /** `remote`: another instance ended the session; it wrote the audit line. */
  private onRevoke(accountId: string, hash: string | null, reason: string, remote = false): void {
    for (const client of this.clients.values()) {
      if (client.accountId !== accountId) continue;
      if (hash !== null && client.tokenHash !== hash) continue;
      this.relay.release(client);
      client.accountId = undefined;
      client.tokenHash = undefined;
      client.awayEnabled = false;
      traffic.updateConnection(client.connId, { accountId: undefined });
      this.send(client.socket, { type: "account-revoked", reason }, client);
      if (client.room) this.broadcast(client.room, { type: "peer-updated", peerId: client.id, name: client.name, account: null, accountId: null }, client);
    }
    if (hash === null) this.relay.forget(accountId, !remote);
    if (remote) return;
    audit.add({ category: "account", level: "notice", event: "session.revoked", accountId, status: reason, detail: { scope: hash === null ? "all" : "one" } });
  }

  /* ------------------------------------------------------------- operators */

  private sendCommands(client: HubClient): number {
    if (!client.deviceId) return 0;
    const pending = drainCommands(client.deviceId);
    for (const cmd of pending as AdminCommand[]) {
      this.send(client.socket, { type: "admin-command", command: cmd }, client);
      adminCommandAudit.push({ ts: Date.now(), kind: "deliver", commandId: cmd.id, deviceId: client.deviceId, peerId: client.id });
    }
    if (adminCommandAudit.length > 1000) adminCommandAudit.splice(0, adminCommandAudit.length - 1000);
    return pending.length;
  }

  /** An operator queued commands for `deviceId`: hand them over now if that
   *  device is connected (otherwise its next command-poll picks them up). */
  deliverCommands(deviceId: string): number {
    for (const client of this.clients.values()) {
      if (client.deviceId === deviceId) return this.sendCommands(client);
    }
    return 0;
  }

  /** Closes one connection (operator action). */
  closeConnection(connId: string, reason: string): boolean {
    const client = this.clients.get(connId);
    if (!client) return false;
    audit.add({ category: "admin", level: "notice", event: "ws.closed-by-admin", peerId: client.id, accountId: client.accountId, status: reason.slice(0, 80) });
    this.send(client.socket, { type: "closed-by-server", reason: reason.slice(0, 120) }, client);
    try { client.socket.close(4003, reason.slice(0, 100)); } catch { /* ignore */ }
    return true;
  }

  /** What the operator console shows for rooms. Room names are not shown. */
  snapshot() {
    return [...this.rooms.entries()].map(([room, members]) => ({
      room: hashRoom(room) ?? "",
      roomHash: hashRoom(room) ?? "",
      peers: [...members.values()].map((p) => ({
        peerId: p.id, name: p.name, joinedAt: p.joinedAt, connId: p.connId, protocol: p.protocol,
        ...(p.accountId ? { accountId: p.accountId } : {}), away: Boolean(p.suspended),
      })),
      away: this.relay.awayAccounts(room),
    }));
  }

  stats() {
    let members = 0;
    for (const m of this.rooms.values()) members += m.size;
    return {
      connections: this.clients.size, rooms: this.rooms.size, members, gate: this.gate.stats(), relay: this.relay.stats(), proxy: this.proxy.stats(),
      cluster: this.cluster ? { ...this.cluster.bus.status(), instances: this.cluster.instances() } : { kind: "local" as const, instances: [] },
    };
  }
}
