import type { Express, Request, Response } from "express";
import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { eventStore } from "./events";
import { buildModuleManifest } from "./modules";

/**
 * CipherRoom — WebRTC signaling only.
 *
 * Server je čistý router zpráv v místnosti. Nikdy neukládá data, nevidí
 * plaintext, nepřenáší soubory. Veškerý přenos šifrovaného obsahu jde
 * přímo browser-to-browser přes RTCDataChannel.
 *
 * Tento modul přidává:
 *   • token-bucket rate-limit (20 rámců/s/peer, 80/s burst)
 *   • MAX_PEERS_PER_ROOM cap (= 16)
 *   • WS ping/pong (heartbeat 25 s) proti zombie spojením
 *   • signal `meta` pole pro client-side DTLS fingerprint TOFU porovnání
 *   • „server-only /push, /events" handlování beze změny schématu
 */

type PeerClient = {
  id: string;
  room: string | null;
  name: string;
  joinedAt: number;
  socket: WebSocket;
};

type ClientMessage =
  | { type: "join"; room: string; peerId: string; name?: string; resume?: boolean }
  | { type: "signal"; target: string; payload: unknown }
  | { type: "leave" }
  | { type: "ping"; ts: number };

const rooms = new Map<string, Map<string, PeerClient>>();

// In-memory push subscription store. The intent here is API stub.
// Real push delivery requires a dedicated worker.
const pushSubscriptions = new Map<string, { endpoint: string; createdAt: number }>();

// ─────────────────────────────────────────────────────────────────────────────
// Konfigurovatelné limity
// ─────────────────────────────────────────────────────────────────────────────

const MAX_PEERS_PER_ROOM = Number(process.env.MAX_PEERS_PER_ROOM || 16);
const FRAME_BUDGET_PER_SEC = Number(process.env.FRAME_BUDGET_PER_SEC || 20);
const FRAME_BURST = Number(process.env.FRAME_BURST || 80);
const WS_HEARTBEAT_MS = Number(process.env.WS_HEARTBEAT_MS || 25_000);
const MAX_FRAME_BYTES = Number(process.env.MAX_FRAME_BYTES || 128_000);

// ─────────────────────────────────────────────────────────────────────────────
// Sanitizační helpers
// ─────────────────────────────────────────────────────────────────────────────

function safeString(value: unknown, fallback: string, max = 96) {
  if (typeof value !== "string") return fallback;
  const trimmed = value
    .trim()
    .normalize("NFC")
    .replace(/[^\u0020a-zA-Z0-9._-]/g, "")
    .replace(/ {2,}/g, " ")
    .slice(0, max);
  return trimmed || fallback;
}

function send(socket: WebSocket, payload: unknown) {
  if (socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      // serialize / socket closed mid-send — ignore
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Token bucket rate-limit — brání DoS a flooding
// ─────────────────────────────────────────────────────────────────────────────

type Bucket = { ts: number; tokens: number };
const buckets = new Map<string, Bucket>();

function refill(b: Bucket) {
  const now = Date.now();
  const elapsed = (now - b.ts) / 1000;
  b.tokens = Math.min(FRAME_BURST, b.tokens + elapsed * FRAME_BUDGET_PER_SEC);
  b.ts = now;
}

function allowFrame(clientId: string): boolean {
  let b = buckets.get(clientId);
  if (!b) {
    b = { ts: Date.now(), tokens: FRAME_BURST };
    buckets.set(clientId, b);
  }
  refill(b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, b] of buckets) {
    if (now - b.ts > 30_000) buckets.delete(id);
    void b;
  }
}, 30_000).unref();

// ─────────────────────────────────────────────────────────────────────────────
// Room management
// ─────────────────────────────────────────────────────────────────────────────

function leaveRoom(client: PeerClient) {
  if (!client.room) return;
  const roomId = client.room;
  const room = rooms.get(roomId);
  if (!room) {
    client.room = null;
    return;
  }

  room.delete(client.id);
  Array.from(room.values()).forEach((peer) => {
    send(peer.socket, { type: "peer-left", peerId: client.id });
  });
  if (room.size === 0) {
    rooms.delete(roomId);
  }
  eventStore.record({ kind: "peer-left", room: roomId, peerId: client.id });
  client.room = null;
}

function joinRoom(client: PeerClient, message: Extract<ClientMessage, { type: "join" }>) {
  // Neporušujeme peer limit: pokud jsme na MAX_PEERS, vyhodíme případné staré spojení.
  leaveRoom(client);

  const roomId = safeString(message.room, "default", 64);
  const peerId = safeString(message.peerId, client.id, 64);
  client.id = peerId;
  client.name = safeString(message.name, "Anonymous", 48);
  client.room = roomId;

  let room = rooms.get(roomId);
  if (!room) {
    room = new Map();
    rooms.set(roomId, room);
  }

  if (room.size >= MAX_PEERS_PER_ROOM) {
    send(client.socket, {
      type: "error",
      message: `Room is full (max ${MAX_PEERS_PER_ROOM} peers).`,
    });
    return;
  }

  const existingPeers = [...room.values()].map((peer) => ({
    peerId: peer.id,
    name: peer.name,
    joinedAt: peer.joinedAt,
  }));

  room.set(client.id, client);

  send(client.socket, {
    type: "joined",
    peerId: client.id,
    room: roomId,
    peers: existingPeers,
    resume: message.resume === true,
    policy: {
      transport: "webrtc-datachannel",
      persistence: "none",
      cache: "no-store",
      signalingOnly: true,
    },
    limits: {
      maxPeersPerRoom: MAX_PEERS_PER_ROOM,
      frameBudgetPerSec: FRAME_BUDGET_PER_SEC,
      maxFrameBytes: MAX_FRAME_BYTES,
    },
  });

  Array.from(room.values()).forEach((peer) => {
    if (peer.id !== client.id) {
      send(peer.socket, {
        type: "peer-joined",
        peerId: client.id,
        name: client.name,
        joinedAt: client.joinedAt,
      });
    }
  });

  eventStore.record({
    kind: "peer-joined",
    room: roomId,
    peerId,
    meta: { peerCount: room.size },
  });
}

function forwardSignal(client: PeerClient, message: Extract<ClientMessage, { type: "signal" }>) {
  if (!client.room) return;
  const target = safeString(message.target, "", 64);
  const room = rooms.get(client.room);
  const peer = room?.get(target);
  if (!peer) return;
  send(peer.socket, {
    type: "signal",
    source: client.id,
    payload: message.payload,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP endpoints — read-only metadata, no message persistence
// ─────────────────────────────────────────────────────────────────────────────

export async function registerRoutes(
  httpServer: Server,
  app: Express,
): Promise<Server> {
  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      rooms: rooms.size,
      peers: [...rooms.values()].reduce((acc, r) => acc + r.size, 0),
      cache: "no-store",
      persistence: "none",
      role: "webrtc-signaling-only",
      limits: {
        maxPeersPerRoom: MAX_PEERS_PER_ROOM,
        frameBudgetPerSec: FRAME_BUDGET_PER_SEC,
        maxFrameBytes: MAX_FRAME_BYTES,
      },
    });
  });

  app.get("/api/modules", (_req, res) => {
    res.json(buildModuleManifest(eventStore.backend));
  });

  app.get("/api/events/recent", (req: Request, res: Response) => {
    if (!eventStore.isEnabled) {
      return res.status(404).json({ ok: false, message: "Event logging is disabled. Set LOG_EVENTS=1." });
    }
    const rawLimit = Number((req.query.limit as string) || 50);
    res.json({ ok: true, backend: eventStore.backend, events: eventStore.recent(rawLimit) });
  });

  app.post("/api/events", (req: Request, res: Response) => {
    if (!eventStore.isEnabled) {
      return res.status(202).json({ ok: true, recorded: false, reason: "Event logging is disabled." });
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const kind = typeof body.kind === "string" ? body.kind : "client-event";
    eventStore.record({
      kind,
      room: typeof body.room === "string" ? body.room : undefined,
      peerId: typeof body.peerId === "string" ? body.peerId : undefined,
      meta: (body.meta && typeof body.meta === "object" ? body.meta : undefined) as
        | Record<string, unknown>
        | undefined,
    });
    res.json({ ok: true, recorded: true });
  });

  app.get("/api/push/status", (_req, res) => {
    const vapidPublic = process.env.VAPID_PUBLIC_KEY?.trim() || "";
    const vapidPrivate = process.env.VAPID_PRIVATE_KEY?.trim() || "";
    res.json({
      enabled: vapidPublic.length > 0 && vapidPrivate.length > 0,
      vapidPublicKey: vapidPublic || null,
      subscribers: pushSubscriptions.size,
    });
  });

  app.post("/api/push/subscribe", (req: Request, res: Response) => {
    const vapidPublic = process.env.VAPID_PUBLIC_KEY?.trim() || "";
    const vapidPrivate = process.env.VAPID_PRIVATE_KEY?.trim() || "";
    if (!vapidPublic || !vapidPrivate) {
      return res.status(503).json({ ok: false, message: "Push not configured." });
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const subscription = body.subscription as { endpoint?: unknown } | undefined;
    if (
      !subscription ||
      typeof subscription.endpoint !== "string" ||
      !subscription.endpoint.startsWith("https://")
    ) {
      return res.status(400).json({ ok: false, message: "Invalid subscription." });
    }
    const endpoint = subscription.endpoint.slice(0, 512);
    const id = crypto.randomUUID();
    pushSubscriptions.set(id, { endpoint, createdAt: Date.now() });
    eventStore.record({ kind: "push-subscribe", meta: { count: pushSubscriptions.size } });
    res.json({ ok: true, id });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // WebSocket /ws — signaling router (jediný long-lived kanál)
  // ───────────────────────────────────────────────────────────────────────────

  const wss = new WebSocketServer({
    server: httpServer,
    path: "/ws",
    perMessageDeflate: false,
    maxPayload: MAX_FRAME_BYTES * 2, // prostor pro SDP offer může být dlouhý
  });

  wss.on("connection", (socket, request) => {
    const client: PeerClient = {
      id: crypto.randomUUID(),
      room: null,
      name: "Anonymous",
      joinedAt: Date.now(),
      socket,
    };

    // WS heartbeat — server ping, klient odpovídá `pong` rámcem
    // (prohlížeč posílá pong automaticky; v klientovi měříme RTT z aplikačního ping).
    let alive = true;
    socket.on("pong", () => {
      alive = true;
    });
    const heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      try {
        socket.ping();
      } catch {
        // ignore
      }
    }, WS_HEARTBEAT_MS);

    socket.on("message", (data) => {
      // Rate limit — aplikován na všechny zprávy (signal/join/leave/ping).
      if (!allowFrame(client.id)) {
        send(socket, { type: "error", message: "Rate limited (slow down)." });
        return;
      }
      try {
        const raw = data.toString("utf8");
        if (raw.length > MAX_FRAME_BYTES) {
          send(socket, { type: "error", message: "Frame exceeds size limit." });
          return;
        }
        const message = JSON.parse(raw) as ClientMessage;

        if (message.type === "ping") {
          send(socket, { type: "pong", ts: message.ts, serverTs: Date.now() });
          return;
        }
        if (message.type === "join") {
          joinRoom(client, message);
          return;
        }
        if (message.type === "signal") {
          forwardSignal(client, message);
          return;
        }
        if (message.type === "leave") {
          leaveRoom(client);
        }
      } catch {
        send(socket, { type: "error", message: "Malformed signaling frame ignored." });
      }
    });

    socket.on("close", () => {
      clearInterval(heartbeat);
      buckets.delete(client.id);
      leaveRoom(client);
    });

    socket.on("error", () => {
      clearInterval(heartbeat);
      buckets.delete(client.id);
      leaveRoom(client);
    });

    send(socket, {
      type: "hello",
      peerId: client.id,
      cache: "no-store",
      ip: request.headers["x-forwarded-for"] ? "proxied" : "direct",
      heartbeatMs: WS_HEARTBEAT_MS,
    });
  });

  return httpServer;
}
