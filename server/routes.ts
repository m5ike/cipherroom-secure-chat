import type { Express, Request, Response } from "express";
import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from "ws";
import { eventStore } from "./events";
import { buildModuleManifest } from "./modules";

type PeerClient = {
  id: string;
  room: string | null;
  name: string;
  joinedAt: number;
  socket: WebSocket;
};

type ClientMessage =
  | { type: "join"; room: string; peerId: string; name?: string }
  | { type: "signal"; target: string; payload: unknown }
  | { type: "leave" };

const rooms = new Map<string, Map<string, PeerClient>>();

// In-memory push subscription store. The intent here is the API stub —
// real push delivery requires a worker that holds the VAPID private key.
const pushSubscriptions = new Map<string, { endpoint: string; createdAt: number }>();

function safeString(value: unknown, fallback: string, max = 96) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().replace(/[^a-zA-Z0-9\s._-]/g, "").slice(0, max);
  return trimmed || fallback;
}

function send(socket: WebSocket, payload: unknown) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

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
    policy: {
      transport: "webrtc-datachannel",
      persistence: "none",
      cache: "no-store",
      signalingOnly: true,
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

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      rooms: rooms.size,
      cache: "no-store",
      persistence: "none",
      role: "webrtc-signaling-only",
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
      meta: (body.meta && typeof body.meta === "object" ? body.meta : undefined) as Record<string, unknown> | undefined,
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
    if (!subscription || typeof subscription.endpoint !== "string" || !subscription.endpoint.startsWith("https://")) {
      return res.status(400).json({ ok: false, message: "Invalid subscription." });
    }
    const endpoint = subscription.endpoint.slice(0, 512);
    const id = crypto.randomUUID();
    pushSubscriptions.set(id, { endpoint, createdAt: Date.now() });
    eventStore.record({ kind: "push-subscribe", meta: { count: pushSubscriptions.size } });
    res.json({ ok: true, id });
  });

  const wss = new WebSocketServer({
    server: httpServer,
    path: "/ws",
    perMessageDeflate: false,
  });

  wss.on("connection", (socket, request) => {
    const client: PeerClient = {
      id: crypto.randomUUID(),
      room: null,
      name: "Anonymous",
      joinedAt: Date.now(),
      socket,
    };

    socket.on("message", (data) => {
      try {
        const raw = data.toString("utf8");
        if (raw.length > 128_000) return;
        const message = JSON.parse(raw) as ClientMessage;

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

    socket.on("close", () => leaveRoom(client));
    socket.on("error", () => leaveRoom(client));

    send(socket, {
      type: "hello",
      peerId: client.id,
      cache: "no-store",
      ip: request.headers["x-forwarded-for"] ? "proxied" : "direct",
    });
  });

  return httpServer;
}
