// Who gets TURN credentials (6.12, F-28).
//
// /api/turn used to hand credentials to anyone who asked — with TURN_SECRET
// they expire, but an outsider could still fetch fresh ones in a loop and use
// the operator's TURN server as a relay. Now the server answers with TURN
// only to an address that holds a live connection to the signaling hub (a
// WebSocket — what every client that is about to make a call has); anyone
// else gets the STUN servers alone, marked `pending`, with an expiry of "now"
// so the web client asks again before its next peer connection (rtc.ts
// freshRtcConfig), by which time it is connected. Requests are also limited
// per address.
//
//   TURN_REQUIRE_HUB   1 (default) | 0 — 0 restores the old behaviour (e.g.
//                      a cluster where /api/turn and the WebSocket of one
//                      client can land on different instances)
//   TURN_RATE_LIMIT    /api/turn requests per address per 10 minutes (60)
//
// The check uses the hub's live connections as the traffic monitor knows
// them (monitor/traffic.ts) — the signaling code itself is not involved. A
// client whose HTTP request and WebSocket leave from different addresses
// (IPv4 vs IPv6 on a dual-stack network) gets STUN until they match.

import { rateLimit } from "express-rate-limit";
import type { RequestHandler } from "express";
import { traffic } from "./monitor/traffic";
import type { TurnAnswer } from "./turn";

export function turnGateEnabled(): boolean {
  return process.env.TURN_REQUIRE_HUB?.trim() !== "0";
}

/** May this address have TURN credentials: it holds a live hub connection (or the gate is off). */
export function mayGetTurn(ip: string | null | undefined, live: (ip: string | null | undefined) => boolean = (a) => traffic.hasLiveConnectionFrom(a)): boolean {
  return !turnGateEnabled() || live(ip);
}

/** The answer for an address without a hub connection: STUN only, to be fetched again before the next call. */
export function pendingTurnAnswer(full: TurnAnswer, now = Date.now()): TurnAnswer & { pending: true } {
  const stun = full.iceServers.filter((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]).every((u) => /^stuns?:/i.test(u)) && !s.username && !s.credential);
  return { ok: true, configured: full.configured, mode: full.mode, pending: true, iceServers: stun, expiresAt: now, ttlSeconds: 0 };
}

export function turnRateLimit(): number {
  const n = Math.floor(Number(process.env.TURN_RATE_LIMIT));
  return Number.isFinite(n) && n >= 1 && n <= 100_000 ? n : 60;
}

/** Per-address limit on /api/turn (TURN_RATE_LIMIT per 10 minutes). */
export function turnLimiter(): RequestHandler {
  return rateLimit({ windowMs: 10 * 60 * 1000, limit: turnRateLimit(), standardHeaders: true, legacyHeaders: false, message: { ok: false, message: "Too many ICE server requests from this address." } });
}
