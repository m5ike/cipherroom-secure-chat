// Apple Push Notification service (6.14) — no SDK: HTTP/2 to
// api.push.apple.com (production) or api.sandbox.push.apple.com (sandbox),
// authenticated with a provider token — a JWT (ES256) signed with the team's
// .p8 key:
//
//   APNS_KEY_FILE   the .p8 key (PKCS#8 PEM, an EC P-256 key) — Certificates,
//                   Identifiers & Profiles › Keys, with "Apple Push Notifications service"
//   APNS_KEY_ID     its 10-character key id
//   APNS_TEAM_ID    the 10-character team id (the JWT's issuer)
//   APNS_TOPIC      the app's bundle id (default cz.m5cet.app); VoIP pushes go to <topic>.voip
//   APNS_ENV        production (default) | sandbox — devices that report their
//                   own environment (a development build: sandbox) are sent to theirs
//
// The token is made once and reused for at most 50 minutes (Apple refuses
// one older than an hour and too-frequent new ones). One HTTP/2 connection per
// host is kept and reused. What a push carries is already encrypted for the
// device and signed (commands.ts) — Apple sees ciphertext, a neutral alert
// text and nothing that names a room (no thread-id, no collapse id from a
// room or a tag). Tokens are never logged whole.
//
// Outcomes: 200 sent; 410 Unregistered and 400 BadDeviceToken /
// DeviceTokenNotForTopic → the token is dead (the caller forgets it); 403
// ExpiredProviderToken / InvalidProviderToken → a new JWT, once; 429 and 5xx
// and a broken connection → retried twice with a growing wait; anything else
// is reported as it is.

import { connect, constants } from "node:http2";
import { createPrivateKey, sign as nodeSign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { iosConfig } from "./config";

export type ApnsEnv = "production" | "sandbox";
export type ApnsPushType = "alert" | "background" | "voip";

export const APNS_HOSTS: Record<ApnsEnv, string> = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};

/** Payload limits (bytes of the JSON): 4 KiB, 5 KiB for VoIP. */
export const APNS_MAX_PAYLOAD: Record<ApnsPushType, number> = { alert: 4096, background: 4096, voip: 5120 };
/** A provider token is reused for at most this long (Apple: between 20 and 60 minutes). */
export const APNS_TOKEN_TTL_MS = 50 * 60 * 1000;

/* ------------------------------------------------------------- transport */

/** The slice of an HTTP/2 client stream used here (tests give a fake one). */
export type ApnsStream = {
  on(event: "response", fn: (headers: Record<string, unknown>) => void): unknown;
  on(event: "data", fn: (chunk: Buffer | string) => void): unknown;
  on(event: "end", fn: () => void): unknown;
  on(event: "error", fn: (err: Error) => void): unknown;
  end(body?: string | Buffer): unknown;
  close?(code?: number): unknown;
};
/** The slice of an HTTP/2 client session used here. */
export type ApnsSession = {
  request(headers: Record<string, string>): ApnsStream;
  on(event: "error" | "goaway" | "close", fn: (...args: unknown[]) => void): unknown;
  close(): unknown;
  readonly closed?: boolean;
  readonly destroyed?: boolean;
  unref?(): unknown;
};

type Transport = {
  connect: (origin: string) => ApnsSession;
  /** Waits between retries (tests: none). */
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  timeoutMs: number;
};

const realTransport = (): Transport => ({
  connect: (origin) => connect(origin) as unknown as ApnsSession,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms).unref?.()),
  now: () => Date.now(),
  timeoutMs: 15_000,
});

let transport: Transport = realTransport();
const sessions = new Map<string, ApnsSession>();
let tokenCache: { jwt: string; madeAt: number; keyId: string; teamId: string } | null = null;

/** Tests: replace the network (and the clock / the waits); null restores the real ones. */
export function setApnsTransport(t: Partial<Transport> | null): void {
  for (const s of sessions.values()) { try { s.close(); } catch { /* gone */ } }
  sessions.clear();
  tokenCache = null;
  keyCache = null;
  transport = t ? { ...realTransport(), ...t } : realTransport();
}

/* -------------------------------------------------------------- settings */

export type ApnsSettings = { keyFile: string; keyId: string; teamId: string; topic: string; env: ApnsEnv };

const KEY_ID_RE = /^[A-Z0-9]{10}$/;

/** What the environment (and ios.json) say; `problems` when something is missing or wrong. */
export function apnsSettings(env: Record<string, string | undefined> = process.env): { settings: ApnsSettings | null; problems: string[] } {
  const problems: string[] = [];
  const keyFile = env.APNS_KEY_FILE?.trim() ? resolve(env.APNS_KEY_FILE.trim()) : "";
  const keyId = (env.APNS_KEY_ID ?? "").trim();
  const teamId = (env.APNS_TEAM_ID ?? "").trim();
  const c = iosConfig();
  const topic = c.apns.topic || (env.APNS_TOPIC ?? "").trim() || c.bundleId || "cz.m5cet.app";
  const rawEnv = (c.apns.env || (env.APNS_ENV ?? "").trim() || "production").toLowerCase();
  if (!keyFile) problems.push("APNS_KEY_FILE is not set");
  if (!KEY_ID_RE.test(keyId)) problems.push("APNS_KEY_ID must be the 10-character key id");
  if (!KEY_ID_RE.test(teamId)) problems.push("APNS_TEAM_ID must be the 10-character team id");
  if (rawEnv !== "production" && rawEnv !== "sandbox") problems.push(`APNS_ENV must be production or sandbox, not ${rawEnv}`);
  if (problems.length) return { settings: null, problems };
  return { settings: { keyFile, keyId, teamId, topic, env: rawEnv as ApnsEnv }, problems };
}

let keyCache: { file: string; key: KeyObject } | null = null;

function signingKey(file: string): KeyObject {
  if (keyCache && keyCache.file === file) return keyCache.key;
  const key = createPrivateKey(readFileSync(file, "utf8"));
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("the APNs key is not an EC P-256 (.p8) key");
  keyCache = { file, key };
  return key;
}

export type ApnsStatus = { ready: boolean; reason: string; env: ApnsEnv | ""; topic: string; keyId: string; teamId: string };

/** Whether pushes can go out: switched on in ios.json, the key configured and readable. */
export function apnsReady(): ApnsStatus {
  const { settings, problems } = apnsSettings();
  const base = { env: settings?.env ?? "", topic: settings?.topic ?? "", keyId: settings?.keyId ?? "", teamId: settings?.teamId ?? "" } as const;
  if (!iosConfig().apns.enabled) return { ready: false, reason: "APNs is switched off (iOS › Push)", ...base };
  if (!settings) return { ready: false, reason: problems.join("; "), ...base };
  try { signingKey(settings.keyFile); } catch (err) { return { ready: false, reason: `the APNs key cannot be read: ${(err as Error).message}`, ...base }; }
  return { ready: true, reason: "", ...base };
}

/* ------------------------------------------------------------------- JWT */

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** A provider token: {alg: ES256, kid} . {iss: team, iat} — the signature in JOSE form (r‖s, 64 bytes). */
export function apnsJwt(key: KeyObject, keyId: string, teamId: string, iatSeconds: number): string {
  const input = `${b64url(JSON.stringify({ alg: "ES256", kid: keyId }))}.${b64url(JSON.stringify({ iss: teamId, iat: iatSeconds }))}`;
  const sig = nodeSign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
  return `${input}.${b64url(sig)}`;
}

/** The cached token, or a new one when it is older than 50 minutes (or `fresh`). */
function providerToken(s: ApnsSettings, fresh = false): string {
  const now = transport.now();
  if (!fresh && tokenCache && tokenCache.keyId === s.keyId && tokenCache.teamId === s.teamId && now - tokenCache.madeAt < APNS_TOKEN_TTL_MS) return tokenCache.jwt;
  const jwt = apnsJwt(signingKey(s.keyFile), s.keyId, s.teamId, Math.floor(now / 1000));
  tokenCache = { jwt, madeAt: now, keyId: s.keyId, teamId: s.teamId };
  return jwt;
}

/* ------------------------------------------------------------------ send */

/** A device token for a log line: its start and end only. */
export const maskToken = (token: string): string => (token.length > 12 ? `${token.slice(0, 6)}…${token.slice(-4)}` : "…");

export type ApnsRequest = {
  token: string;
  type: ApnsPushType;
  /** 10 at once, 5 when convenient for the battery (background pushes must be 5), 1 lowest. */
  priority: 10 | 5 | 1;
  payload: Record<string, unknown>;
  /** Unix seconds after which APNs stops trying (0 = once, now). */
  expiration?: number;
  /** A newer push with the same id replaces an undelivered one — never a room or a tag (privacy). */
  collapseId?: string;
  /** The device's own environment, else the server's. */
  env?: ApnsEnv | "";
};

export type ApnsResult =
  | { ok: true; status: 200; apnsId: string; attempts: number }
  | { ok: false; status: number; reason: string; error: string; unregistered: boolean; attempts: number };

const DEAD_TOKEN = new Set(["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"]);
const NEW_JWT = new Set(["ExpiredProviderToken", "InvalidProviderToken"]);

function sessionFor(origin: string): ApnsSession {
  const open = sessions.get(origin);
  if (open && !open.closed && !open.destroyed) return open;
  const s = transport.connect(origin);
  const drop = () => { if (sessions.get(origin) === s) sessions.delete(origin); };
  s.on("error", drop);
  s.on("goaway", drop);
  s.on("close", drop);
  s.unref?.();
  sessions.set(origin, s);
  return s;
}

function requestOnce(session: ApnsSession, headers: Record<string, string>, body: string): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolvePromise, reject) => {
    let status = 0;
    let respHeaders: Record<string, unknown> = {};
    const chunks: Buffer[] = [];
    let done = false;
    let stream: ApnsStream;
    try { stream = session.request(headers); } catch (err) { reject(err as Error); return; }
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { stream.close?.(constants.NGHTTP2_CANCEL); } catch { /* closed */ }
      reject(new Error("APNs did not answer in time"));
    }, transport.timeoutMs);
    timer.unref?.();
    stream.on("response", (h) => { respHeaders = h; status = Number(h[":status"]) || 0; });
    stream.on("data", (c) => { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); });
    stream.on("end", () => { if (done) return; done = true; clearTimeout(timer); resolvePromise({ status, headers: respHeaders, body: Buffer.concat(chunks).toString("utf8") }); });
    stream.on("error", (err) => { if (done) return; done = true; clearTimeout(timer); reject(err); });
    stream.end(body);
  });
}

/** One push to one device token, retried as the outcome allows. */
export async function apnsSend(req: ApnsRequest): Promise<ApnsResult> {
  const { settings, problems } = apnsSettings();
  if (!settings) return { ok: false, status: 0, reason: "NotConfigured", error: problems.join("; "), unregistered: false, attempts: 0 };
  if (!/^[0-9a-fA-F]{64,200}$/.test(req.token)) return { ok: false, status: 0, reason: "BadDeviceToken", error: "not an APNs device token", unregistered: true, attempts: 0 };
  const body = JSON.stringify(req.payload);
  if (Buffer.byteLength(body) > APNS_MAX_PAYLOAD[req.type]) return { ok: false, status: 0, reason: "PayloadTooLarge", error: `the payload is ${Buffer.byteLength(body)} bytes, APNs takes ${APNS_MAX_PAYLOAD[req.type]}`, unregistered: false, attempts: 0 };
  const env: ApnsEnv = req.env === "production" || req.env === "sandbox" ? req.env : settings.env;
  const origin = APNS_HOSTS[env];
  const topic = req.type === "voip" ? `${settings.topic}.voip` : settings.topic;
  let renew = false;
  let renewed = false;
  let last: ApnsResult = { ok: false, status: 0, reason: "", error: "not sent", unregistered: false, attempts: 0 };
  for (let attempt = 1; attempt <= 3; attempt++) {
    let jwt: string;
    try { jwt = providerToken(settings, renew); renew = false; } catch (err) { return { ok: false, status: 0, reason: "BadKey", error: `the APNs key cannot be used: ${(err as Error).message}`, unregistered: false, attempts: attempt - 1 }; }
    const headers: Record<string, string> = {
      ":method": "POST",
      ":path": `/3/device/${req.token}`,
      authorization: `bearer ${jwt}`,
      "apns-topic": topic,
      "apns-push-type": req.type,
      "apns-priority": String(req.priority),
      "apns-expiration": String(Math.max(0, Math.floor(req.expiration ?? 0))),
      "content-type": "application/json",
    };
    if (req.collapseId) headers["apns-collapse-id"] = req.collapseId.slice(0, 64);
    let res: { status: number; headers: Record<string, unknown>; body: string };
    try {
      res = await requestOnce(sessionFor(origin), headers, body);
    } catch (err) {
      // A broken connection: a new one, after a wait.
      const s = sessions.get(origin);
      if (s) { sessions.delete(origin); try { s.close(); } catch { /* gone */ } }
      last = { ok: false, status: 0, reason: "Network", error: `APNs (${env}) is not reachable: ${(err as Error).message}`, unregistered: false, attempts: attempt };
      if (attempt < 3) { await transport.sleep(250 * 4 ** (attempt - 1)); continue; }
      return last;
    }
    if (res.status === 200) return { ok: true, status: 200, apnsId: String(res.headers["apns-id"] ?? ""), attempts: attempt };
    let reason = "";
    try { reason = String((JSON.parse(res.body) as { reason?: unknown }).reason ?? ""); } catch { /* no body */ }
    last = { ok: false, status: res.status, reason, error: `${res.status} ${reason || "APNs refused the push"} (token ${maskToken(req.token)}, ${env})`, unregistered: res.status === 410 || DEAD_TOKEN.has(reason), attempts: attempt };
    if (last.unregistered) return last;
    if (res.status === 403 && NEW_JWT.has(reason) && !renewed) { renew = true; renewed = true; continue; }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { await transport.sleep(250 * 4 ** (attempt - 1)); continue; }
    return last;
  }
  return last;
}
