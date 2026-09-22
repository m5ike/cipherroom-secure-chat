// Main HTTP + WebSocket signaling routes for M5cet.
//
// Responsibilities:
//   - WSS /ws         WebRTC signaling broker (join/signal/ping/command-poll/leave)
//   - GET  /api/health             liveness + sanity flags
//   - GET  /api/modules            module manifest (see modules.ts)
//   - /api/push/*                  status, subscribe, test (push-routes.ts):
//                                  self-test to the caller's own subscription id;
//                                  broadcast only with the admin token
//   - GET  /api/events*            opt-in metadata feed (LOG_EVENTS=1)
//   - GET/POST /api/settings/*     device-scoped preferences sync (in-memory)
//   - POST /api/audit/purge        wipe device-scoped server state
//   - /api/admin/retention*        retention policy + sweep, admin token
//                                  (retention-routes.ts; a timer also sweeps)
//   - /api/account/*               passkey accounts: sign-in, encrypted vault,
//                                  audit (accounts/routes.ts)
//
// Signed-in users (join with their account token and away: true) stay in a
// room as AWAY when their socket goes; others relay room-key ciphertext to
// the server, which stores it, answers "stored" and wakes them with a push
// (accounts/relay.ts).
//
// Admin commands are enqueued only by the standalone admin service
// (admin.ts, /admin/commands/*); this process delivers them over /ws.
//
// Security model: the server is a relay. It never sees plaintext message
// bodies or room keys. Persistence defaults to "none". Optional metadata
// logging is gated by LOG_EVENTS and only stores opaque ids + timestamps.

import type { Express, Request, Response } from "express";
import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from "ws";
import { eventStore } from "./events";
import { buildModuleManifest } from "./modules";
import {
  adminCommandAudit,
  pushSubscriptions,
  drain as drainQueue,
  type AdminCommand,
} from "./routes-admin-shared";
import { FileProxy, relayProxyFrame } from "./file-proxy";
import { registerRetentionRoutes, startRetentionSchedule } from "./retention-routes";
import { registerPushRoutes } from "./push-routes";
import { consentLedger, deviceAuditLog, deviceSettings } from "./device-state";
import { registerShareRoutes, registerGoodbyeRoute } from "./share";
import { registerPluginRoutes } from "./plugins/routes";
import { accountStore } from "./accounts/store";
import { storage } from "./storage/service";
import { registerStorageRoutes } from "./storage/routes";
import { connectAccountsToStorage, forgetAccount, recordAccount } from "./storage/bridge";
import { handleStorageFrame, isStorageFrame, newStorageSocketState, type StorageFrame, type StorageSocketState } from "./storage/ws";
import { AwayRelay } from "./accounts/relay";
import { registerAccountRoutes } from "./accounts/routes";
import { sendWebPush } from "./push";
import { registerTelephonyRoutes } from "./telephony/routes";
import { registerWebhookRoutes } from "./telephony/webhooks";
import { registerLayoutRoutes } from "./layout";
import { buildInfo } from "./build-info";

const fileProxy = new FileProxy();

type PeerClient = {
  id: string;
  room: string | null;
  name: string;
  joinedAt: number;
  socket: WebSocket;
  /** Signed-in (passkey account) — set by join with a valid token. */
  accountId?: string;
  /** Stay in the room as away when the socket goes (chat kept on the server). */
  awayEnabled?: boolean;
};

type ClientMessage =
  | { type: "join"; room: string; peerId: string; name?: string; auth?: string; away?: boolean }
  | { type: "signal"; target: string; payload: unknown }
  | { type: "ping"; t: number }
  | { type: "command-poll"; deviceId?: string }
  | { type: "command-ack"; commandId: string; result?: string }
  | { type: "leave"; away?: boolean }
  // Away relay (signed-in users): see accounts/relay.ts.
  | { type: "relay"; messageId: string; to: string[]; envelope: { iv: string; ciphertext: string } }
  | { type: "relay-ack"; ids: string[] }
  // The page was put aside / handed back by the browser: stay in the room,
  // but let the server answer meanwhile (see accounts/relay.ts).
  | { type: "presence"; away: boolean }
  | { type: "receipt"; to: { peerId?: string; accountId?: string }; messageIds: string[]; state: "delivered" | "read" }
  // Server-side storage over this socket (see storage/ws.ts).
  | StorageFrame
  // Server-side proxy mode for file transfer: clients that cannot
  // successfully establish a direct P2P connection can fall back to the
  // signaling WebSocket as a relay. The server never sees the plaintext
  // payload — only AES-GCM ciphertext produced by the room key.
  | { type: "proxy-meta"; transferId: string; iv: string; ciphertext: string }
  | { type: "proxy-chunk"; transferId: string; seq: number; iv: string; ciphertext: string }
  | { type: "proxy-end"; transferId: string }
  | { type: "proxy-cancel"; transferId: string }
  // Receiver → sender: repeat these chunks (see lib/file-transfer.ts).
  | { type: "proxy-need"; transferId: string; seqs: number[] }
  | { type: "proxy-progress"; transferId: string; received: number };

const rooms = new Map<string, Map<string, PeerClient>>();

const relay = new AwayRelay(accountStore, rooms, send, (target, payload) => sendWebPush(target, payload));

// pushSubscriptions and admin command queue live in routes-admin-shared.ts
// so that the standalone admin API service can read and enqueue against
// the same in-memory state when it is imported into the same process.

// Per-device server-side state (settings sync, audit, consent) lives in
// device-state.ts, shared with the retention sweep.

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

/** `wantsAway`: a signed-in client with away enabled stays in the room as
 *  away (socket lost, or Disconnect) instead of leaving. */
function leaveRoom(client: PeerClient, wantsAway = false) {
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
  relay.onLeave(client, roomId, wantsAway);
}

function joinRoom(client: PeerClient, message: Extract<ClientMessage, { type: "join" }>) {
  leaveRoom(client);

  const roomId = safeString(message.room, "default", 64);
  const peerId = safeString(message.peerId, client.id, 64);
  client.id = peerId;
  client.name = safeString(message.name, "Anonymous", 48);
  client.room = roomId;
  const account = message.auth ? accountStore.resolveToken(message.auth) : null;
  client.accountId = account?.id;
  client.awayEnabled = Boolean(account && message.away === true);

  let room = rooms.get(roomId);
  if (!room) {
    room = new Map();
    rooms.set(roomId, room);
  }

  const existingPeers = [...room.values()].map((peer) => ({
    peerId: peer.id,
    name: peer.name,
    joinedAt: peer.joinedAt,
    ...(peer.accountId ? { accountId: peer.accountId } : {}),
  }));

  room.set(client.id, client);

  send(client.socket, {
    type: "joined",
    peerId: client.id,
    room: roomId,
    peers: existingPeers,
    // Signed-in members who are away: messages to them go through the relay.
    away: relay.awayList(roomId).filter((a) => a.accountId !== client.accountId),
    account: account ? { id: account.id, away: client.awayEnabled } : message.auth ? { invalid: true } : null,
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
        ...(client.accountId ? { accountId: client.accountId } : {}),
      });
    }
  });

  // Back from away (peer-back) + everything that waited in the mailbox.
  relay.onJoin(client);

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
  // Invite links (split-key, code-gated) and the Clear & Quit landing page.
  registerShareRoutes(app);
  registerGoodbyeRoute(app);
  // Optional AI + speech modules (gated by ENABLE_AI / ENABLE_SPEECH).
  registerPluginRoutes(app);
  // Server-side storage: one SQLite database for the server, one encrypted
  // SQLCipher database per user or session (storage/*). Boots before the
  // routes so /api/storage/status can answer honestly either way.
  const storageReady = await storage.init();
  if (!storageReady.ok) {
    console.warn(`[storage] running without server-side storage: ${storageReady.reason ?? "unknown reason"}`);
  }
  registerStorageRoutes(app, storage, accountStore);
  // The vault moves into the user's own database, and the global tables
  // learn about the accounts that already exist.
  connectAccountsToStorage(storage, accountStore);

  // Passkey accounts: WebAuthn sign-in, zero-knowledge vault, audit log.
  // Signing out / deleting ends the away status in every room, and closes
  // the user's database so the file is opaque again.
  registerAccountRoutes(app, accountStore, {
    onSignOut: (accountId) => {
      relay.forget(accountId);
      storage.releaseAccount(accountId);
    },
    onAuthenticated: (accountId, event, meta) => {
      const account = accountStore.get(accountId);
      if (account) recordAccount(storage, account, event, meta);
    },
    onDeleted: (accountId) => forgetAccount(storage, accountId),
  });
  // Optional telephony (voice + SMS via Twilio/Telnyx/Vonage, SIP trunk config),
  // gated by ENABLE_TELEPHONY.
  registerTelephonyRoutes(app);
  // Provider webhooks (/wh/{provider}/{type}): signature-verified, always
  // mounted so delivery receipts / inbound SMS / call events can reach us.
  registerWebhookRoutes(app);
  // Admin-edited layout / templates for every client (GET /api/layout).
  registerLayoutRoutes(app);

  app.get("/api/health", (_req, res) => {
    const b = buildInfo();
    res.json({
      ok: true,
      rooms: rooms.size,
      cache: "no-store",
      persistence: "none",
      role: "webrtc-signaling-only",
      // Which client build this server serves (dist/public/build.json).
      version: b.version,
      build: b.build,
      builtAt: b.builtAt,
    });
  });

  app.get("/api/modules", (_req, res) => {
    res.json(buildModuleManifest(eventStore.backend));
  });

  app.get("/api/turn", (_req, res) => {
    const url = process.env.TURN_SERVER_URL?.trim() || "";
    if (!url) {
      // Not an error: most rooms work over STUN. (A 404 here printed a red
      // "Failed to load resource" line in every visitor's console.)
      return res.json({ ok: true, configured: false, iceServers: [] });
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

  // Web Push: status, subscribe, self-test / operator broadcast.
  registerPushRoutes(app);

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

  // ---------- GDPR-friendly data retention ----------
  // Operator routes (admin token) + a periodic sweep of this process's state.
  registerRetentionRoutes(app);
  startRetentionSchedule();

  const wss = new WebSocketServer({
    server: httpServer,
    path: "/ws",
    perMessageDeflate: false,
  });

  wss.on("connection", (socket, request) => {
    // Per-socket storage identity + rate window (storage/ws.ts).
    const storageState: StorageSocketState = newStorageSocketState();
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

        if (isStorageFrame(message)) {
          handleStorageFrame(socket, storageState, message, send);
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
          leaveRoom(client, message.away === true);
          return;
        }

        // ---------- Away relay (signed-in users) ----------
        if (message.type === "relay") {
          void relay.relay(client, message);
          return;
        }
        if (message.type === "relay-ack") {
          relay.ack(client, message.ids);
          return;
        }
        if (message.type === "presence") {
          const away = relay.setPresence(client, message.away === true);
          send(socket, { type: "presence-ack", away });
          // Back at the keyboard: hand over whatever arrived meanwhile.
          if (!away) relay.deliver(client);
          return;
        }
        if (message.type === "receipt") {
          relay.receipt(client, message);
          return;
        }

        // ---------- File transfer proxy mode ----------
        if (
          message.type === "proxy-meta" ||
          message.type === "proxy-chunk" ||
          message.type === "proxy-end" ||
          message.type === "proxy-cancel" ||
          message.type === "proxy-need"
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

    // Losing the socket (tab closed, network gone) is not a goodbye: a
    // signed-in user with away enabled stays reachable through the relay.
    socket.on("close", () => leaveRoom(client, true));
    socket.on("error", () => leaveRoom(client, true));

    send(socket, {
      type: "hello",
      peerId: client.id,
      cache: "no-store",
      ip: request.headers["x-forwarded-for"] ? "proxied" : "direct",
    });
  });

  return httpServer;
}
