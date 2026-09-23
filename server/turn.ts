// ICE servers for browsers: STUN, and TURN when the operator runs one.
//
// Static TURN credentials (TURN_USERNAME / TURN_CREDENTIAL) are handed to
// every visitor and never change — anyone can copy them and use the TURN
// server as an open relay for their own traffic. With TURN_SECRET (coturn:
// `use-auth-secret` + `static-auth-secret=<the same value>`) each visitor
// gets credentials of its own that expire (the "TURN REST API" scheme):
//
//   username   = "<unix expiry>:<random>"
//   credential = base64(HMAC-SHA1(TURN_SECRET, username))
//
// coturn recomputes the HMAC and refuses the username once the expiry has
// passed, so nothing needs to be shared between the two services but the
// secret.

import { createHmac, randomBytes } from "node:crypto";

export type TurnAnswer = {
  ok: true;
  configured: boolean;
  /** "ephemeral" (TURN_SECRET), "static" (shared credentials) or "none". */
  mode: "ephemeral" | "static" | "none";
  iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }>;
  /** When these credentials stop working (ms since epoch), for the client to refresh. */
  expiresAt?: number;
  ttlSeconds?: number;
};

const env = (name: string) => process.env[name]?.trim() || "";

function list(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

export function turnTtlSeconds(): number {
  const n = Number(env("TURN_TTL_SECONDS"));
  return Number.isFinite(n) && n >= 60 && n <= 86_400 ? Math.floor(n) : 3_600;
}

/** Credentials valid until `now + ttl`, bound to nothing but the secret. */
export function ephemeralCredentials(secret: string, now = Date.now(), ttlSeconds = turnTtlSeconds()): { username: string; credential: string; expiresAt: number } {
  const expiry = Math.floor(now / 1000) + ttlSeconds;
  const username = `${expiry}:${randomBytes(9).toString("base64url")}`;
  const credential = createHmac("sha1", secret).update(username).digest("base64");
  return { username, credential, expiresAt: expiry * 1000 };
}

export function turnAnswer(now = Date.now()): TurnAnswer | { ok: false; status: number; message: string } {
  const stun = list(env("STUN_URLS") || "stun:stun.l.google.com:19302");
  const turn = list(env("TURN_SERVER_URL"));
  const stunServers = stun.length ? [{ urls: stun }] : [];
  if (turn.length === 0) {
    // Not an error: most rooms work over STUN. (A 404 here printed a red
    // "Failed to load resource" line in every visitor's console.)
    return { ok: true, configured: false, mode: "none", iceServers: stunServers };
  }
  const secret = env("TURN_SECRET");
  if (secret) {
    const ttlSeconds = turnTtlSeconds();
    const creds = ephemeralCredentials(secret, now, ttlSeconds);
    return {
      ok: true, configured: true, mode: "ephemeral", ttlSeconds, expiresAt: creds.expiresAt,
      iceServers: [...stunServers, { urls: turn, username: creds.username, credential: creds.credential }],
    };
  }
  const username = env("TURN_USERNAME");
  const credential = env("TURN_CREDENTIAL");
  if (!username || !credential) return { ok: false, status: 503, message: "TURN credentials are incomplete (set TURN_SECRET, or TURN_USERNAME and TURN_CREDENTIAL)." };
  return { ok: true, configured: true, mode: "static", iceServers: [...stunServers, { urls: turn, username, credential }] };
}
