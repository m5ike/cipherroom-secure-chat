// The storage API over the signaling socket.
//
// The same operations as the REST routes (api.ts), on the connection the
// client already holds: no extra round trip, no new TLS session, and the
// client keeps its place in the room. A frame looks like
//
//   → { type: "storage", id: "42", op: "messages.put", payload: {...},
//       auth?: "<account token>", session?: "<session id>" }
//   ← { type: "storage-result", id: "42", ok: true, data: {...} }
//
// `auth` / `session` may be sent per frame, or once — the socket remembers
// the last identity it was given, so a chatty client does not repeat it.
// Rate limited per socket: storage is cheap, but not free. The socket's
// remote address (given to newStorageSocketState) caps how many new
// sessions it may start, like the REST route does.

import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";
import { apiContext, clientKeyFor, isStorageOp, resolveCaller, runStorageOp, type ApiContext } from "./api";
import { accountStore } from "../accounts/store";
import { holderForToken } from "./keys";
import { storage as defaultStorage, type StorageService } from "./service";

const PER_MINUTE = 600;

export type StorageSocketState = {
  token?: string;
  sessionId?: string;
  /** Who this connection is for the new-session cap (see clientKeyFor). */
  clientKey?: string;
  windowStart: number;
  count: number;
};

export type StorageFrame = {
  type: "storage";
  id?: string;
  op?: string;
  payload?: Record<string, unknown>;
  auth?: string;
  session?: string;
};

export function isStorageFrame(message: { type?: unknown }): message is StorageFrame {
  return message.type === "storage";
}

/** Handles one storage frame and answers on the same socket. */
export function handleStorageFrame(
  socket: WebSocket,
  state: StorageSocketState,
  frame: StorageFrame,
  send: (socket: WebSocket, payload: unknown) => void,
  ctx: ApiContext = apiContext(defaultStorage as StorageService, accountStore),
): void {
  const id = typeof frame.id === "string" ? frame.id.slice(0, 64) : "";
  const reply = (body: Record<string, unknown>) => send(socket, { type: "storage-result", id, ...body });

  const now = Date.now();
  if (now - state.windowStart >= 60_000) { state.windowStart = now; state.count = 0; }
  state.count += 1;
  if (state.count > PER_MINUTE) {
    reply({ ok: false, message: "Too many storage frames; slow down.", code: "rate-limit" });
    return;
  }

  // An identity sent once holds for the rest of the connection.
  if (typeof frame.auth === "string") state.token = frame.auth.slice(0, 200);
  if (typeof frame.session === "string") state.sessionId = frame.session.slice(0, 96);

  if (!isStorageOp(frame.op)) {
    reply({ ok: false, message: `unknown operation ${String(frame.op)}`, code: "unknown-op" });
    return;
  }

  const caller = resolveCaller(ctx, { token: state.token, sessionId: state.sessionId });
  state.clientKey ??= `socket:${randomBytes(9).toString("base64url")}`;
  const meta = { clientKey: state.clientKey, ...(state.token ? { holder: holderForToken(state.token) } : {}) };
  try {
    const result = runStorageOp(ctx, caller, frame.op, frame.payload ?? {}, meta);
    if (result.ok) reply({ ok: true, op: frame.op, data: result.data ?? null });
    else reply({ ok: false, op: frame.op, message: result.error, ...(result.code ? { code: result.code } : {}) });
  } catch (err) {
    ctx.storage.log({ level: "error", source: "server", event: "storage.ws.error", detail: { op: frame.op, error: (err as Error).message } });
    reply({ ok: false, op: frame.op, message: "storage operation failed", code: "error" });
  }
}

/** Per-socket state. Pass the connection's remote address (the proxy-aware
 *  one if there is a proxy) so the new-session cap counts per client; without
 *  it, each socket counts on its own. */
export function newStorageSocketState(remoteAddress?: string | null): StorageSocketState {
  return {
    windowStart: Date.now(),
    count: 0,
    ...(remoteAddress ? { clientKey: clientKeyFor(remoteAddress) } : {}),
  };
}
