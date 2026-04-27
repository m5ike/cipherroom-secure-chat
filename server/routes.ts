import type { Express } from "express";
import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from "ws";

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
  const room = rooms.get(client.room);
  if (!room) {
    client.room = null;
    return;
  }

  room.delete(client.id);
  Array.from(room.values()).forEach((peer) => {
    send(peer.socket, { type: "peer-left", peerId: client.id });
  });
  if (room.size === 0) {
    rooms.delete(client.room);
  }
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
