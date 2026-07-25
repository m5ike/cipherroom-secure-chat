// Main HTTP + WebSocket signaling routes for M5cet.
//
// Responsibilities:
//   - WSS /ws         WebRTC signaling broker (join/signal/ping/command-poll/leave)
//   - GET  /api/health             liveness + sanity flags
//   - GET  /api/modules            module manifest (see modules.ts)
//   - GET  /api/push/status        VAPID public key + readiness
//   - POST /api/push/subscribe     register a Web Push endpoint
//   - POST /api/push/test          server-pushed test notification (auth-gated)
//   - GET  /api/events*            opt-in metadata feed (LOG_EVENTS=1)
//   - GET/POST /api/settings/*     device-scoped preferences sync (in-memory)
//   - POST /api/audit/purge        wipe device-scoped server state
//   - POST /api/admin/commands/*   token-protected enqueue + audit (mirrored
//                                  by the standalone admin service in admin.ts)
//
// Security model: the server is a relay. It never sees plaintext message
// bodies or room keys. Persistence defaults to "none". Optional metadata
// logging is gated by LOG_EVENTS and only stores opaque ids + timestamps.

import type { Express, Request, Response } from "express";
import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from "ws";
import { eventStore } from "./events";
import { buildModuleManifest } from "./modules";
import { sendWebPush, isWebPushReady } from "./push";
import {
  adminCommandAudit,
  pushSubscriptions,
  drain as drainQueue,
  type AdminCommand,
} from "./routes-admin-shared";
import { FileProxy, relayProxyFrame } from "./file-proxy";

const fileProxy = new FileProxy();

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
  | { type: "ping"; t: number }
  | { type: "command-poll"; deviceId?: string }
  | { type: "command-ack"; commandId: string; result?: string }
  | { type: "leave" }
  // Server-side proxy mode for file transfer: clients that cannot
  // successfully establish a direct P2P connection can fall back to the
  // signaling WebSocket as a relay. The server never sees the plaintext
  // payload — only AES-GCM ciphertext produced by the room key.
  | { type: "proxy-meta"; transferId: string; iv: string; ciphertext: string }
  | { type: "proxy-chunk"; transferId: string; seq: number; iv: string; ciphertext: string }
  | { type: "proxy-end"; transferId: string }
  | { type: "proxy-cancel"; transferId: string }
  | { type: "proxy-progress"; transferId: string; received: number };

const rooms = new Map<string, Map<string, PeerClient>>();

// pushSubscriptions and admin command queue live in routes-admin-shared.ts
// so that the standalone admin API service can read and enqueue against
// the same in-memory state when it is imported into the same process.

// Per-device server-side preference sync. In-memory only — production deployments
// should mount a real KV / DB through the API surface in docs/api.md.
type DeviceSettings = {
  deviceId: string;
  updatedAt: number;
  payload: Record<string, unknown>;
};
const deviceSettings = new Map<string, DeviceSettings>();
const deviceAuditLog = new Map<string, Array<{ kind: string; at: number; meta?: Record<string, unknown> }>>();

// Analytics consent ledger. Only fields the client explicitly opted into are kept.
type ConsentRecord = { deviceId: string; analyticsConsent: boolean; updatedAt: number };
const consentLedger = new Map<string, ConsentRecord>();

function drainAdminCommands(socket: WebSocket, deviceId: string) {
  const pending = drainQueue(deviceId);
  if (pending.length === 0) return;
  pending.forEach((cmd: AdminCommand) => {
    send(socket, { type: "admin-command", command: cmd });
    adminCommandAudit.push({ ts: Date.now(), kind: "deliver", commandId: cmd.id, deviceId });
  });
  if (adminCommandAudit.length > 1000) adminCommandAudit.splice(0, adminCommandAudit.length - 1000);
}

import { safeDeviceId, safeString } from "./util";

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

  app.get("/api/turn", (_req, res) => {
    const url = process.env.TURN_SERVER_URL?.trim() || "";
    if (!url) {
      return res.status(404).json({ ok: false, message: "TURN is not configured." });
    }
    const username = process.env.TURN_USERNAME?.trim() || "";
    const credential = process.env.TURN_CREDENTIAL?.trim() || "";
    if (!username || !credential) {
      return res.status(503).json({ ok: false, message: "TURN credentials are incomplete." });
    }
    res.json({
      ok: true,
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: url, username, credential },
      ],
    });
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
    const keys = (subscription as Record<string, unknown>).keys as Record<string, unknown> | undefined;
    const p256dh = typeof keys?.p256dh === "string" ? String(keys.p256dh).slice(0, 256) : undefined;
    const auth = typeof keys?.auth === "string" ? String(keys.auth).slice(0, 128) : undefined;
    const id = crypto.randomUUID();
    const deviceId = safeDeviceId(body.deviceId) || undefined;
    pushSubscriptions.set(id, {
      endpoint,
      keys: p256dh && auth ? { p256dh, auth } : undefined,
      createdAt: Date.now(),
      deviceId,
    });
    eventStore.record({ kind: "push-subscribe", meta: { count: pushSubscriptions.size } });
    res.json({ ok: true, id });
  });

  // Self-test endpoint: any subscriber can trigger a push to themselves.
  app.post("/api/push/test", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const id = typeof body.id === "string" ? body.id : null;
    if (!isWebPushReady()) {
      return res.status(503).json({ ok: false, message: "Push not configured (set VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY)." });
    }
    const targets = id
      ? (pushSubscriptions.has(id) ? [pushSubscriptions.get(id)!] : [])
      : Array.from(pushSubscriptions.values()).slice(0, 1);
    if (targets.length === 0) return res.status(404).json({ ok: false, message: "No subscriptions yet." });
    const title = typeof body.title === "string" ? body.title.slice(0, 64) : "M5cet · test";
    const text = typeof body.body === "string" ? body.body.slice(0, 200) : "Push test from this device.";
    const results: Array<{ endpoint: string; ok: boolean; error?: string }> = [];
    for (const sub of targets) {
      const r = await sendWebPush(sub, { title, body: text });
      results.push({ endpoint: sub.endpoint.slice(0, 80), ok: r.ok, error: r.error });
    }
    eventStore.record({ kind: "push-test", meta: { count: results.length } });
    res.json({ ok: true, results });
  });

  // ---------- Settings sync (server-enhanced mode) ----------
  app.get("/api/settings", (req: Request, res: Response) => {
    const deviceId = safeDeviceId(req.query.deviceId);
    if (!deviceId) return res.status(400).json({ ok: false, message: "deviceId required." });
    const record = deviceSettings.get(deviceId);
    res.json({ ok: true, deviceId, settings: record?.payload ?? null, updatedAt: record?.updatedAt ?? null });
  });

  app.post("/api/settings", (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const deviceId = safeDeviceId(body.deviceId);
    if (!deviceId) return res.status(400).json({ ok: false, message: "deviceId required." });
    const payload = (body.settings && typeof body.settings === "object" ? body.settings : {}) as Record<string, unknown>;
    deviceSettings.set(deviceId, { deviceId, payload, updatedAt: Date.now() });
    eventStore.record({ kind: "settings-sync", meta: { deviceId } });
    res.json({ ok: true });
  });

  // ---------- Audit purge ----------
  app.post("/api/audit/purge", (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const deviceId = safeDeviceId(body.deviceId);
    if (!deviceId) return res.status(400).json({ ok: false, message: "deviceId required." });
    deviceSettings.delete(deviceId);
    deviceAuditLog.delete(deviceId);
    consentLedger.delete(deviceId);
    Array.from(pushSubscriptions.entries()).forEach(([id, sub]) => {
      if (sub.deviceId === deviceId) pushSubscriptions.delete(id);
    });
    eventStore.record({ kind: "audit-purge", meta: { deviceId } });
    res.json({ ok: true, message: "Server data purged for this device." });
  });

  app.get("/api/audit/log", (req: Request, res: Response) => {
    const deviceId = safeDeviceId(req.query.deviceId);
    if (!deviceId) return res.status(400).json({ ok: false, message: "deviceId required." });
    const entries = deviceAuditLog.get(deviceId) || [];
    res.json({ ok: true, deviceId, entries });
  });

  // ---------- Analytics consent ----------
  app.post("/api/analytics/consent", (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const deviceId = safeDeviceId(body.deviceId);
    if (!deviceId) return res.status(400).json({ ok: false, message: "deviceId required." });
    const opt = body.analyticsConsent === true;
    consentLedger.set(deviceId, { deviceId, analyticsConsent: opt, updatedAt: Date.now() });
    eventStore.record({ kind: "analytics-consent", meta: { deviceId, opt } });
    res.json({ ok: true, analyticsConsent: opt });
  });

  app.get("/api/analytics/consent", (req: Request, res: Response) => {
    const deviceId = safeDeviceId(req.query.deviceId);
    if (!deviceId) return res.status(400).json({ ok: false, message: "deviceId required." });
    res.json({ ok: true, record: consentLedger.get(deviceId) ?? null });
  });

  // ---------- File proxy diagnostics (server-enhanced mode) ----------
  app.get("/api/transfers/stats", (_req, res) => {
    res.json({ ok: true, ...fileProxy.stats() });
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

        if (message.type === "ping") {
          const t = typeof message.t === "number" ? message.t : Date.now();
          send(socket, { type: "pong", t, serverTs: Date.now() });
          return;
        }

        if (message.type === "command-poll") {
          const deviceId = safeDeviceId(message.deviceId);
          if (deviceId) drainAdminCommands(socket, deviceId);
          return;
        }

        if (message.type === "command-ack") {
          adminCommandAudit.push({
            ts: Date.now(),
            kind: "ack",
            commandId: String(message.commandId).slice(0, 64),
            peerId: client.id,
            result: typeof message.result === "string" ? message.result.slice(0, 256) : undefined,
          });
          return;
        }

        if (message.type === "leave") {
          leaveRoom(client);
          return;
        }

        // ---------- File transfer proxy mode ----------
        if (
          message.type === "proxy-meta" ||
          message.type === "proxy-chunk" ||
          message.type === "proxy-end" ||
          message.type === "proxy-cancel"
        ) {
          if (!client.room) return;
          const result = relayProxyFrame(
            fileProxy,
            client.id,
            message,
            (targetPeerId, frame) => {
              const room = rooms.get(client.room!);
              if (!room) return;
              if (targetPeerId === "__broadcast__") {
                room.forEach((peer) => {
                  if (peer.id !== client.id) send(peer.socket, { type: frame.kind, ...frame });
                });
              } else {
                const peer = room.get(targetPeerId);
                if (peer) send(peer.socket, { type: frame.kind, ...frame });
              }
            },
          );
          if (message.type === "proxy-meta") {
            send(socket, {
              type: "proxy-ack",
              transferId: message.transferId,
              transport: "proxy",
              accepted: result.ok,
              reason: result.reason,
            });
          }
          if (message.type === "proxy-end") {
            eventStore.record({ kind: "proxy-end", meta: { transferId: message.transferId, room: client.room } });
          }
          return;
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
