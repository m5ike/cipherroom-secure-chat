// Invite links — the client half. See server/share.ts for the threat model.
//
//   https://host/#j=<id>.<linkKey>        + a separate 12-digit code
//
// Everything after "#" stays in the browser: it is not sent to our server, to
// crawlers, or to the link-preview fetchers of messengers. The payload (room,
// room key, suggested name) is AES-GCM encrypted under
//
//   HKDF( linkKey ‖ serverKey ‖ PBKDF2(code) )
//
// so decrypting needs the link, the server's cooperation (gated by the code,
// 5 wrong tries, X uses) and the code itself. Send the code through a
// different channel than the link.

import { toBase64, fromBase64, type Bytes } from "./crypto";

export const CODE_DIGITS = 12;
const PBKDF2_ITERATIONS = 200_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type SharePayload = { v: 1; room: string; passphrase: string; name: string; createdAt: number };
export type ShareLinkParts = { id: string; linkKey: Bytes };
export type ShareOptions = { maxUses: number; ttlSec: number };
export type CreatedShare = {
  url: string; code: string; id: string; revokeToken: string;
  maxUses: number; maxAttempts: number; expiresAt: number;
};
export type RedeemOutcome =
  | { ok: true; payload: SharePayload; usesLeft: number }
  | { ok: false; reason: "wrong-code" | "burned" | "not-found" | "network" | "corrupt"; attemptsLeft?: number };

// --- encoding ---------------------------------------------------------------

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Bytes {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return fromBase64(padded);
}

const randomBytes = (n: number): Bytes => crypto.getRandomValues(new Uint8Array(n));

// --- the 12-digit code ------------------------------------------------------

/** 12 uniformly random decimal digits (rejection sampling: no modulo bias). */
export function generateCode(): string {
  let out = "";
  while (out.length < CODE_DIGITS) {
    for (const byte of randomBytes(32)) {
      if (byte < 250 && out.length < CODE_DIGITS) out += String(byte % 10);   // 250 = 25 * 10
    }
  }
  return out;
}

/** "123456789012" -> "1234-5678-9012" */
export function formatCode(code: string): string {
  return code.replace(/\D/g, "").slice(0, CODE_DIGITS).replace(/(\d{4})(?=\d)/g, "$1-");
}

/** Accepts any grouping / separators; returns 12 digits or null. */
export function normalizeCode(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  return digits.length === CODE_DIGITS ? digits : null;
}

// --- link <-> parts ---------------------------------------------------------

export function buildShareUrl(origin: string, parts: ShareLinkParts): string {
  return `${origin.replace(/\/+$/, "")}/#j=${parts.id}.${toBase64Url(parts.linkKey)}`;
}

export function parseShareFragment(hash: string): ShareLinkParts | null {
  const m = /^#?j=([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(hash);
  if (!m) return null;
  try {
    const linkKey = fromBase64Url(m[2]);
    return linkKey.byteLength === 32 ? { id: m[1], linkKey } : null;
  } catch { return null; }
}

// --- key derivation ---------------------------------------------------------

async function pbkdf2(code: string, salt: string): Promise<Bytes> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(code), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: encoder.encode(salt), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, material, 256,
  );
  return new Uint8Array(bits);
}

/** What the server checks. A different salt than the encryption branch, so
 *  seeing the proof does not hand the server the code-derived key. */
export async function deriveProof(code: string, id: string): Promise<string> {
  return toBase64Url(await pbkdf2(code, `m5cet:share:v1:proof:${id}`));
}

async function deriveWrapKey(code: string, id: string, linkKey: Bytes, serverKey: Bytes): Promise<CryptoKey> {
  const codeKey = await pbkdf2(code, `m5cet:share:v1:enc:${id}`);
  const ikm = new Uint8Array(linkKey.byteLength + serverKey.byteLength + codeKey.byteLength);
  ikm.set(linkKey, 0); ikm.set(serverKey, linkKey.byteLength); ikm.set(codeKey, linkKey.byteLength + serverKey.byteLength);
  const base = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode(id), info: encoder.encode("m5cet:share:v1:wrap") },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}

export async function sealPayload(code: string, id: string, linkKey: Bytes, serverKey: Bytes, payload: SharePayload): Promise<{ iv: string; ciphertext: string }> {
  const key = await deriveWrapKey(code, id, linkKey, serverKey);
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(id) }, key, encoder.encode(JSON.stringify(payload))));
  return { iv: toBase64Url(iv), ciphertext: toBase64Url(ct) };
}

export async function openPayload(code: string, id: string, linkKey: Bytes, serverKey: Bytes, iv: string, ciphertext: string): Promise<SharePayload> {
  const key = await deriveWrapKey(code, id, linkKey, serverKey);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(iv), additionalData: encoder.encode(id) }, key, fromBase64Url(ciphertext));
  const data = JSON.parse(decoder.decode(plain)) as Partial<SharePayload>;
  if (data.v !== 1 || typeof data.room !== "string" || typeof data.passphrase !== "string" || typeof data.name !== "string") throw new Error("bad payload");
  return { v: 1, room: data.room, passphrase: data.passphrase, name: data.name, createdAt: Number(data.createdAt) || 0 };
}

// --- random guest names -----------------------------------------------------

const ADJECTIVES = ["tichy", "rychly", "modry", "zlaty", "bystry", "klidny", "smely", "jasny", "lesni", "nocni"];
const ANIMALS = ["rys", "sokol", "vlk", "jezek", "kos", "bobr", "jelen", "sova", "lin", "kuna"];

/** e.g. "bystry-sokol-42" — fits the server's name charset [a-zA-Z0-9 ._-]. */
export function randomGuestName(): string {
  const [a, b, c] = randomBytes(3);
  return `${ADJECTIVES[a % ADJECTIVES.length]}-${ANIMALS[b % ANIMALS.length]}-${String(c % 100).padStart(2, "0")}`;
}

// --- server round trips -----------------------------------------------------

type Fetcher = typeof fetch;

export async function createShare(
  input: { room: string; passphrase: string; name?: string }, options: ShareOptions,
  env: { origin?: string; fetcher?: Fetcher } = {},
): Promise<CreatedShare> {
  const fetcher = env.fetcher ?? fetch;
  const id = toBase64Url(randomBytes(16));
  const linkKey = randomBytes(32);
  const serverKey = randomBytes(32);
  const revokeToken = toBase64Url(randomBytes(32));
  const code = generateCode();
  const payload: SharePayload = { v: 1, room: input.room, passphrase: input.passphrase, name: input.name || randomGuestName(), createdAt: Date.now() };
  const sealed = await sealPayload(code, id, linkKey, serverKey, payload);
  const res = await fetcher("/api/share/create", {
    method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
    body: JSON.stringify({
      id, proof: await deriveProof(code, id), revokeToken, serverKey: toBase64Url(serverKey),
      iv: sealed.iv, ciphertext: sealed.ciphertext, maxUses: options.maxUses, ttlSec: options.ttlSec,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string; expiresAt?: number; maxUses?: number; maxAttempts?: number };
  if (!res.ok || !body.ok) throw new Error(body.reason || `HTTP ${res.status}`);
  const origin = env.origin ?? (typeof location !== "undefined" ? location.origin : "");
  return {
    url: buildShareUrl(origin, { id, linkKey }), code, id, revokeToken,
    maxUses: body.maxUses ?? options.maxUses, maxAttempts: body.maxAttempts ?? 5, expiresAt: body.expiresAt ?? 0,
  };
}

export async function redeemShare(parts: ShareLinkParts, codeInput: string, env: { fetcher?: Fetcher } = {}): Promise<RedeemOutcome> {
  const code = normalizeCode(codeInput);
  if (!code) return { ok: false, reason: "wrong-code" };
  const fetcher = env.fetcher ?? fetch;
  let res: Response;
  try {
    res = await fetcher("/api/share/redeem", {
      method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
      body: JSON.stringify({ id: parts.id, proof: await deriveProof(code, parts.id) }),
    });
  } catch { return { ok: false, reason: "network" }; }
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean; reason?: "wrong-code" | "burned" | "not-found"; attemptsLeft?: number;
    serverKey?: string; iv?: string; ciphertext?: string; usesLeft?: number;
  };
  if (!res.ok || !body.ok || !body.serverKey || !body.iv || !body.ciphertext) {
    return { ok: false, reason: body.reason ?? (res.status === 429 ? "network" : "not-found"), attemptsLeft: body.attemptsLeft };
  }
  try {
    const payload = await openPayload(code, parts.id, parts.linkKey, fromBase64Url(body.serverKey), body.iv, body.ciphertext);
    return { ok: true, payload, usesLeft: body.usesLeft ?? 0 };
  } catch { return { ok: false, reason: "corrupt" }; }
}

export async function revokeShare(id: string, revokeToken: string, env: { fetcher?: Fetcher } = {}): Promise<boolean> {
  try {
    const res = await (env.fetcher ?? fetch)("/api/share/revoke", {
      method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
      body: JSON.stringify({ id, revokeToken }),
    });
    return Boolean(((await res.json().catch(() => ({}))) as { ok?: boolean }).ok);
  } catch { return false; }
}

// --- share targets ----------------------------------------------------------

export type ShareTarget = {
  id: "whatsapp" | "telegram" | "viber" | "signal" | "messenger" | "imessage" | "sms" | "email" | "native" | "copy" | "qr";
  label: string;
  /** Deep link to open; absent for actions handled in the UI (native share, copy, QR). */
  href?: string;
};

/**
 * Only the LINK goes through these channels — never the code. Signal has no
 * URL scheme for prefilled text, so it (and "more…") use the system share
 * sheet where available and fall back to copying.
 */
export function shareTargets(url: string, text: string): ShareTarget[] {
  const message = `${text} ${url}`;
  const e = encodeURIComponent;
  return [
    { id: "whatsapp", label: "WhatsApp", href: `https://wa.me/?text=${e(message)}` },
    { id: "telegram", label: "Telegram", href: `https://t.me/share/url?url=${e(url)}&text=${e(text)}` },
    { id: "viber", label: "Viber", href: `viber://forward?text=${e(message)}` },
    { id: "signal", label: "Signal" },
    { id: "messenger", label: "Messenger", href: `fb-messenger://share/?link=${e(url)}` },
    { id: "imessage", label: "iMessage", href: `sms:&body=${e(message)}` },
    { id: "sms", label: "SMS", href: `sms:?&body=${e(message)}` },
    { id: "email", label: "E-mail", href: `mailto:?subject=${e(text)}&body=${e(message)}` },
    { id: "qr", label: "QR" },
    { id: "copy", label: "Copy" },
    { id: "native", label: "…" },
  ];
}
