// Passkey sign-in for M5cet Desktop through the system browser (6.13).
//
// Why: the app is Chromium (Electron). On macOS its platform authenticator is
// Chromium's own Touch ID one — no iCloud Keychain passkeys and no PRF — and
// M5cet needs PRF: the passkey's secret is the account's key. Windows Hello
// in the app has PRF only on current Windows 11. So the app can hand the
// passkey ceremony to the system browser (Safari, Chrome, Edge…), where the
// user's passkeys live, and get the result back — ENCRYPTED to the app:
//
//   app (bundled code)                    server                  browser (server's page)
//   ECDH P-256 key pair (private key       POST /api/desktop-auth/start
//   non-extractable, memory only),         { appKey, pollHash } → { id }
//   poll secret (random, memory only)
//   opens https://<server>/desktop-signin?id=<id>#k=<appKey>  ──────────────►  shows the code from appKey,
//   and shows the same code natively                                            passkey sign-in (PRF),
//                                                                               seals { token, root } to appKey
//                                          POST /:id/complete { sealed }  ◄──   (ephemeral ECDH + HKDF + AES-GCM),
//                                          (stored once, 5 min)                 opens m5cet://auth/callback?id=<id>
//   POST /:id/result { poll } ──────────►  { sealed } once, then deleted
//   opens it with the private key → session token + account root
//
// Nothing secret is ever in a URL: the id is not a secret (it only names the
// request), the app's PUBLIC key travels in the fragment (never sent to a
// server), the result is fetched with a poll secret only the app knows, and
// it is ciphertext for a key only the app has. The server stores ciphertext
// for at most five minutes and hands it out once.
//
// What it does NOT protect against — said plainly: the browser page is web
// code from the server (F-02 as on the web): a malicious server can make that
// page keep the passkey's secret. The handoff keeps the secret off the wire
// and out of URLs, logs and other apps; the app's own code is still the
// signed one. The code shown on both sides stops a sign-in started by someone
// else (a link sent to you) from being completed for THEIR app key.

import { assertPasskey, b64url, fromB64url, openRoot, WRAP_INFO, type SealedRoot, type ServerRequestOptions } from "./passkey";

export const HANDOFF_VERSION = 1;
export const HANDOFF_PATH = "/desktop-signin";
const INFO = "m5cet:desktop-auth:v1";
const enc = new TextEncoder();
const dec = new TextDecoder();

export type SealedHandoff = { epk: string; iv: string; ct: string };

/** What the browser hands to the app. `root` is the account root (b64url, 32 bytes) — the passkey's PRF secret, unwrapped. */
export type HandoffPayload = {
  v: typeof HANDOFF_VERSION;
  token: string;
  accountId: string;
  root: string;
  username: string | null;
  origin: string;
  at: number;
};

export type AppKey = { privateKey: CryptoKey; publicKey: string };

const bytes = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b);

/** The app's ephemeral key pair: P-256, the private half non-extractable. */
export async function createAppKey(): Promise<AppKey> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: b64url(raw) };
}

/** A raw uncompressed P-256 point, base64url (65 bytes → 87 characters). */
export function isAppKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{87}$/.test(value)) return false;
  try { const b = fromB64url(value); return b.length === 65 && b[0] === 0x04; } catch { return false; }
}

/** The code both sides show: 8 digits from SHA-256 of the app's public key, "1234 5678". */
export async function verificationCode(appKey: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(enc.encode(`${INFO}|code|${appKey}`))));
  const n = (((d[0] << 24) >>> 0) + (d[1] << 16) + (d[2] << 8) + d[3]) % 100_000_000;
  const s = n.toString().padStart(8, "0");
  return `${s.slice(0, 4)} ${s.slice(4)}`;
}

function context(id: string, origin: string, epk: string): Uint8Array<ArrayBuffer> {
  return bytes(enc.encode(`${INFO}|${id}|${origin}|${epk}`));
}

async function aesKey(shared: ArrayBuffer, appKey: string, epk: string, id: string, origin: string): Promise<CryptoKey> {
  const salt = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(enc.encode(`${appKey}|${epk}`))));
  const base = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: context(id, origin, epk) }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** Browser side: seals the payload to the app's public key (a fresh ephemeral key for each seal). */
export async function sealForApp(appKey: string, id: string, origin: string, payload: HandoffPayload): Promise<SealedHandoff> {
  if (!isAppKey(appKey)) throw new Error("not an app key");
  const appPub = await crypto.subtle.importKey("raw", bytes(fromB64url(appKey)), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const epk = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey)));
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: appPub }, eph.privateKey, 256);
  const key = await aesKey(shared, appKey, epk, id, origin);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: context(id, origin, epk) }, key, bytes(enc.encode(JSON.stringify(payload)))));
  return { epk, iv: b64url(iv), ct: b64url(ct) };
}

/** A handoff that does not open, or opens to something else than expected. */
export class HandoffError extends Error {
  constructor(public readonly code: "format" | "decrypt" | "payload" | "origin" | "expired" | "network" | "cancelled" | "timeout" | "server", message?: string) {
    super(message ?? code);
    this.name = "HandoffError";
  }
}

/** App side: opens the sealed result with the private key and checks it belongs to this request and server. */
export async function openForApp(key: AppKey, id: string, origin: string, sealed: SealedHandoff, now = Date.now(), maxAgeMs = 10 * 60_000): Promise<HandoffPayload> {
  if (!sealed || !isAppKey(sealed.epk) || !/^[A-Za-z0-9_-]{16}$/.test(sealed.iv) || typeof sealed.ct !== "string" || !/^[A-Za-z0-9_-]{24,16384}$/.test(sealed.ct)) {
    throw new HandoffError("format");
  }
  let plain: ArrayBuffer;
  try {
    const epk = await crypto.subtle.importKey("raw", bytes(fromB64url(sealed.epk)), { name: "ECDH", namedCurve: "P-256" }, false, []);
    const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: epk }, key.privateKey, 256);
    const aes = await aesKey(shared, key.publicKey, sealed.epk, id, origin);
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(fromB64url(sealed.iv)), additionalData: context(id, origin, sealed.epk) }, aes, bytes(fromB64url(sealed.ct)));
  } catch {
    throw new HandoffError("decrypt");
  }
  let p: Partial<HandoffPayload>;
  try { p = JSON.parse(dec.decode(plain)) as Partial<HandoffPayload>; } catch { throw new HandoffError("payload"); }
  if (p.v !== HANDOFF_VERSION || typeof p.token !== "string" || !p.token || typeof p.accountId !== "string" || !p.accountId
    || typeof p.root !== "string" || fromB64urlSafe(p.root)?.length !== 32 || typeof p.at !== "number") {
    throw new HandoffError("payload");
  }
  if (p.origin !== origin) throw new HandoffError("origin");
  if (p.at > now + 60_000 || now - p.at > maxAgeMs) throw new HandoffError("expired");
  return { v: HANDOFF_VERSION, token: p.token, accountId: p.accountId, root: p.root, username: typeof p.username === "string" ? p.username : null, origin: p.origin, at: p.at };
}

function fromB64urlSafe(v: string): Uint8Array | null {
  try { return fromB64url(v); } catch { return null; }
}

/** The poll secret and the hash the server keeps of it (SHA-256, b64url). */
export async function createPollSecret(): Promise<{ secret: string; hash: string }> {
  const secret = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const hash = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(enc.encode(secret)))));
  return { secret, hash };
}

/** The browser page's URL: the id in the query, the app's public key in the fragment (never sent to a server). */
export function handoffUrl(origin: string, id: string, appKey: string): string {
  return `${origin}${HANDOFF_PATH}?id=${encodeURIComponent(id)}#k=${appKey}`;
}

/** The id and key of the browser page's URL, or null. */
export function parseHandoffUrl(href: string): { id: string; appKey: string } | null {
  try {
    const u = new URL(href);
    if (u.pathname !== HANDOFF_PATH) return null;
    const id = u.searchParams.get("id") ?? "";
    const k = new URLSearchParams(u.hash.replace(/^#/, "")).get("k") ?? "";
    if (!/^[A-Za-z0-9_-]{22,64}$/.test(id) || !isAppKey(k)) return null;
    return { id, appKey: k };
  } catch { return null; }
}

/* ------------------------------------------------------------ the app's side */

export type HandoffStart = { id: string; expiresAt: number };

type Fetcher = typeof fetch;

async function postJson<T>(fetcher: Fetcher, path: string, body: unknown): Promise<{ status: number; data: T | null }> {
  const res = await fetcher(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  let data: T | null = null;
  try { data = (await res.json()) as T; } catch { data = null; }
  return { status: res.status, data };
}

export type BrowserSignInEnv = {
  origin: string;
  fetcher?: Fetcher;
  /** Opens the page in the system browser and shows the code natively (M5cet Desktop's bridge). */
  open: (url: string, code: string) => Promise<void> | void;
  /** Resolves when the browser says it is done (the m5cet:// callback) — a hint to poll now. */
  wake?: (id: string, poke: () => void) => () => void;
  signal?: AbortSignal;
  pollMs?: number;
  now?: () => number;
};

/**
 * Runs the whole app side: start, open the browser, wait (poll + wake-up),
 * open the result. Resolves with the payload; throws HandoffError.
 */
export async function signInThroughBrowser(env: BrowserSignInEnv): Promise<HandoffPayload> {
  const fetcher = env.fetcher ?? fetch;
  const now = env.now ?? Date.now;
  const key = await createAppKey();
  const poll = await createPollSecret();
  let start: { status: number; data: { id?: string; expiresAt?: number } | null };
  try { start = await postJson(fetcher, "/api/desktop-auth/start", { appKey: key.publicKey, pollHash: poll.hash }); }
  catch { throw new HandoffError("network"); }
  const id = start.data?.id;
  const expiresAt = Number(start.data?.expiresAt) || now() + 5 * 60_000;
  if (start.status !== 201 || typeof id !== "string" || !/^[A-Za-z0-9_-]{22,64}$/.test(id)) throw new HandoffError("server", `start: ${start.status}`);
  const code = await verificationCode(key.publicKey);
  await env.open(handoffUrl(env.origin, id, key.publicKey), code);

  let poke: () => void = () => undefined;
  const stopWake = env.wake?.(id, () => poke());
  try {
    for (;;) {
      if (env.signal?.aborted) {
        await postJson(fetcher, `/api/desktop-auth/${id}/cancel`, { poll: poll.secret }).catch(() => undefined);
        throw new HandoffError("cancelled");
      }
      if (now() > expiresAt) throw new HandoffError("timeout");
      let r: { status: number; data: { state?: string; sealed?: SealedHandoff } | null };
      try { r = await postJson(fetcher, `/api/desktop-auth/${id}/result`, { poll: poll.secret }); }
      catch { r = { status: 0, data: null }; }
      if (r.status === 200 && r.data?.state === "done" && r.data.sealed) {
        return await openForApp(key, id, env.origin, r.data.sealed, now());
      }
      if (r.status === 404 || r.status === 410 || r.status === 403) throw new HandoffError(r.status === 410 ? "timeout" : "server", `result: ${r.status}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, env.pollMs ?? 2000);
        poke = () => { clearTimeout(timer); resolve(); };
        env.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  } finally {
    stopWake?.();
  }
}

/* ---------------------------------------------------------- the browser's side */

export type HandoffInfo = { appKey: string; expiresAt: number; state: "waiting" | "done"; sameNetwork: boolean };

export async function fetchHandoffInfo(id: string, fetcher: Fetcher = fetch): Promise<HandoffInfo | null> {
  try {
    const res = await fetcher(`/api/desktop-auth/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!res.ok) return null;
    const d = (await res.json()) as Partial<HandoffInfo>;
    if (!isAppKey(d.appKey) || (d.state !== "waiting" && d.state !== "done")) return null;
    return { appKey: d.appKey, expiresAt: Number(d.expiresAt) || 0, state: d.state, sameNetwork: d.sameNetwork === true };
  } catch { return null; }
}

/**
 * The browser's sign-in for the app: the passkey ceremony (with PRF) against
 * this server, the account root unwrapped — and nothing kept here: the
 * session token is not adopted by this browser tab, it goes to the app.
 */
export async function browserPasskeySignIn(origin: string, fetcher: Fetcher = fetch): Promise<HandoffPayload> {
  const options = await postJson<{ publicKey?: ServerRequestOptions; message?: string }>(fetcher, "/api/account/signin/options", {});
  if (options.status !== 200 || !options.data?.publicKey) throw Object.assign(new Error(options.data?.message ?? `options: ${options.status}`), { status: options.status });
  const signed = await assertPasskey(options.data.publicKey);
  const verify = await postJson<{ token?: string; account?: { id: string; username?: string | null }; wrapped?: SealedRoot | null; message?: string; code?: string }>(fetcher, "/api/account/signin/verify", { credential: signed.response });
  if (verify.status !== 200 || !verify.data?.token || !verify.data.account) {
    throw Object.assign(new Error(verify.data?.message ?? `verify: ${verify.status}`), { status: verify.status, code: verify.data?.code ?? "" });
  }
  const root = verify.data.wrapped ? await openRoot(verify.data.wrapped, signed.secret, WRAP_INFO.passkey) : signed.secret;
  return {
    v: HANDOFF_VERSION,
    token: verify.data.token,
    accountId: verify.data.account.id,
    root: b64url(root),
    username: verify.data.account.username ?? null,
    origin,
    at: Date.now(),
  };
}

/** Seals and delivers the sign-in result; true when the server stored it. */
export async function completeHandoff(id: string, appKey: string, origin: string, payload: HandoffPayload, fetcher: Fetcher = fetch): Promise<boolean> {
  const sealed = await sealForApp(appKey, id, origin, payload);
  const r = await postJson(fetcher, `/api/desktop-auth/${encodeURIComponent(id)}/complete`, { sealed });
  return r.status === 200;
}

/** The deep link that wakes the app (carries only the id). */
export function appCallbackUrl(id: string): string {
  return `m5cet://auth/callback?id=${encodeURIComponent(id)}`;
}
