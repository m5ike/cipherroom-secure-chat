// "Připojka" — a connection tag. An NDEF MIME record of type
// `application/vnd.m5cet.conn` (optionally followed by a plain URI record as a
// human fallback). What its body holds:
//
//   v2 (6.12, F-12 — written)   "m5cet:nfc:v2:" + JSON, docs/protocol-v4.md § 16
//       invite   an invitation reference (server origin + invite id) and a
//                130-bit secret; the room key stays on the server, sealed, until
//                the invite runs out or is revoked (lib/nfc/tag-v2.ts)
//       offline  the room under Argon2id (64 MiB, 3 passes) of a 20-symbol
//                base32 code that is not on the tag
//   v1 (read only)              "m5cet:nfc:v1:" + base64(salt|iv|AES-GCM(JSON))
//       under a 4–16 digit PIN (PBKDF2 200 000) — guessable offline by anyone
//       who reads the tag once. Still opened (with a "weak tag" warning and an
//       offer to rewrite it as v2); never written any more.

import { decryptFromTag } from "../../nfc";
import { createShare, redeemShare, type CreatedShare } from "../../share-link";
import { NfcError } from "../errors";
import { decodeNdefMessage, decodeRecord, mimeRecord, uriRecord, typeString, type NdefRecord } from "./ndef";
import {
  TAG_V1_PREFIX, TAG_V2_PREFIX, inviteKeys, newInviteTag, openOfflineTag, parseTagV2, sealOfflineTag, serializeTagV2,
  type InviteTag, type KdfParams, type OfflineTag,
} from "../tag-v2";

export const CONN_MIME = "application/vnd.m5cet.conn";

const enc = new TextEncoder();
const dec = new TextDecoder();

export type ConnectionPayload = {
  v: 1 | 2;
  room: string;
  passphrase: string;
  name?: string;
  app?: string;
  /** 6.12: how the tag held it — an invitation, an offline tag, or an old PIN tag (`weak`). */
  kind?: "invite" | "offline" | "legacy";
  /** A v1 tag: its PIN can be guessed offline — offer to rewrite it as v2. */
  weak?: boolean;
};

/** What a tag carries, before anything is opened. */
export type ConnectionTagInfo =
  | { version: 2; kind: "invite"; tag: InviteTag }
  | { version: 2; kind: "offline"; tag: OfflineTag }
  | { version: 1; kind: "legacy"; blob: string };

export type ConnectionTagOptions = {
  /** Optional plaintext URI record appended as a human fallback. */
  fallbackUrl?: string;
  appVersion?: string;
};

function assertSession(p: { room?: string; passphrase?: string }): void {
  if (!p.room || !p.passphrase) throw new NfcError("invalid-argument", "Connection tag needs a room and a passphrase");
}

function recordsFor(body: string, opts: ConnectionTagOptions): NdefRecord[] {
  const records: NdefRecord[] = [mimeRecord(CONN_MIME, enc.encode(body))];
  if (opts.fallbackUrl) records.push(uriRecord(opts.fallbackUrl));
  return records;
}

/**
 * An OFFLINE tag (v2): the room sealed under a fresh 20-symbol code that the
 * caller must show to the writer once — it is not on the tag, and without it
 * the tag cannot be opened. `kdf` only for tests (writers use the room KDF's cost).
 */
export async function buildOfflineConnectionRecords(
  session: { room: string; passphrase: string; name?: string },
  opts: ConnectionTagOptions & { code?: string; kdf?: KdfParams } = {},
): Promise<{ records: NdefRecord[]; code: string; tag: OfflineTag }> {
  assertSession(session);
  const { tag, code } = await sealOfflineTag(
    { room: session.room, passphrase: session.passphrase, ...(session.name ? { name: session.name } : {}), ...(opts.appVersion ? { app: opts.appVersion } : {}) },
    { code: opts.code, kdf: opts.kdf },
  );
  return { records: recordsFor(serializeTagV2(tag), opts), code, tag };
}

/**
 * An INVITATION tag (v2): creates an invite on the server (lib/share-link.ts)
 * whose link key and code come from the tag's secret, and returns the records
 * that hold only the server's origin, the invite id and that secret. The
 * invite's limits are the tag's: `maxUses` (default 10) and `ttlSec` (default
 * and at most 7 days); `invite.revokeToken` ends it early.
 */
export async function buildInviteConnectionRecords(
  session: { room: string; passphrase: string; server?: string },
  opts: ConnectionTagOptions & { origin: string; maxUses?: number; ttlSec?: number; fetcher?: typeof fetch; base?: string },
): Promise<{ records: NdefRecord[]; tag: InviteTag; invite: CreatedShare }> {
  assertSession(session);
  const idBytes = crypto.getRandomValues(new Uint8Array(16));
  let bin = "";
  for (const b of idBytes) bin += String.fromCharCode(b);
  const id = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const tag = newInviteTag(opts.origin, id);
  const { linkKey, code } = await inviteKeys(tag.id, tag.k);
  const invite = await createShare(
    { room: session.room, passphrase: session.passphrase, ...(session.server ? { server: session.server } : {}) },
    { maxUses: opts.maxUses ?? 10, ttlSec: opts.ttlSec ?? 7 * 24 * 3600 },
    { fetcher: opts.fetcher, base: opts.base, origin: tag.o, fixed: { id: tag.id, linkKey, code } },
  );
  return { records: recordsFor(serializeTagV2(tag), opts), tag, invite };
}

/** True if this record set carries an M5cet connection payload. */
export function hasConnectionRecord(records: NdefRecord[]): boolean {
  return records.some((r) => typeString(r) === CONN_MIME);
}

/** Extract the raw body from a record set, or null. */
export function readConnectionBlob(records: NdefRecord[]): string | null {
  const rec = records.find((r) => typeString(r) === CONN_MIME);
  if (!rec) return null;
  return dec.decode(rec.payload);
}

/** What the tag carries (v2 invite / v2 offline / v1 PIN tag), or null when it is no connection tag. */
export function inspectConnectionBlob(blob: string): ConnectionTagInfo | null {
  const body = blob.trim();
  if (body.startsWith(TAG_V2_PREFIX)) {
    const tag = parseTagV2(body);
    return tag.t === "inv" ? { version: 2, kind: "invite", tag } : { version: 2, kind: "offline", tag };
  }
  if (body.startsWith(TAG_V1_PREFIX)) return { version: 1, kind: "legacy", blob: body };
  return null;
}

export function inspectConnectionRecords(records: NdefRecord[]): ConnectionTagInfo | null {
  const blob = readConnectionBlob(records);
  return blob ? inspectConnectionBlob(blob) : null;
}

export type OpenInput = {
  /** An offline tag's code (20 base32 symbols, any grouping). */
  code?: string;
  /** A v1 tag's PIN. */
  pin?: string;
  /** This page's origin (default location.origin): an invitation of another server is not redeemed from here. */
  origin?: string;
  /** Where the invitation's server is reached (default: this origin, relative). */
  base?: string;
  fetcher?: typeof fetch;
};

/** Opens what the tag carries: an invitation (no input), an offline tag (`code`), a v1 tag (`pin`). */
export async function openConnectionTag(info: ConnectionTagInfo, input: OpenInput = {}): Promise<ConnectionPayload> {
  if (info.kind === "legacy") {
    if (!input.pin) throw new NfcError("invalid-argument", "a v1 tag needs its PIN");
    return { ...(await decodeConnectionBlob(info.blob, input.pin)), kind: "legacy", weak: true };
  }
  if (info.kind === "offline") {
    if (!input.code) throw new NfcError("invalid-argument", "an offline tag needs its code");
    const room = await openOfflineTag(info.tag, input.code);
    return { v: 2, ...room, kind: "offline" };
  }
  const here = input.origin ?? (typeof location !== "undefined" ? location.origin : "");
  if (input.base === undefined && info.tag.o !== here) throw new NfcError("card-error", "the invitation belongs to another server", info.tag.o);
  const { linkKey, code } = await inviteKeys(info.tag.id, info.tag.k);
  const out = await redeemShare({ id: info.tag.id, linkKey }, code, { fetcher: input.fetcher, base: input.base });
  if (!out.ok) throw new NfcError(out.reason === "network" ? "timeout" : "card-error", `the invitation cannot be used (${out.reason})`, out.reason);
  return { v: 2, room: out.payload.room, passphrase: out.payload.passphrase, kind: "invite" };
}

/**
 * Parse + open a connection tag from its NDEF records. `secret` is what the
 * tag needs: a v1 tag's PIN or an offline tag's code (an invitation needs none).
 */
export async function decodeConnectionRecords(records: NdefRecord[], secret = "", env: Omit<OpenInput, "code" | "pin"> = {}): Promise<ConnectionPayload> {
  const info = inspectConnectionRecords(records);
  if (!info) throw new NfcError("card-error", "Tag has no M5cet connection record");
  return openConnectionTag(info, { ...env, code: secret, pin: secret });
}

/** A v1 body ("m5cet:nfc:v1:…") opened with its PIN — read only (6.12 never writes v1). */
export async function decodeConnectionBlob(blob: string, pin: string): Promise<ConnectionPayload> {
  const obj = (await decryptFromTag(pin, blob)) as Partial<ConnectionPayload>;
  if (!obj || typeof obj.room !== "string" || typeof obj.passphrase !== "string") {
    throw new NfcError("card-error", "Decrypted payload is not a connection card");
  }
  return {
    v: 1,
    room: obj.room,
    passphrase: obj.passphrase,
    ...(typeof obj.name === "string" ? { name: obj.name } : {}),
    ...(typeof obj.app === "string" ? { app: obj.app } : {}),
  };
}

/** Convenience: parse raw NDEF message bytes then open. */
export async function decodeConnectionMessage(bytes: Uint8Array, secret: string): Promise<ConnectionPayload> {
  return decodeConnectionRecords(decodeNdefMessage(bytes), secret);
}

/** Summarize a record set for the log without decrypting. */
export function summarizeRecords(records: NdefRecord[]): string {
  return records.map((r) => {
    const d = decodeRecord(r);
    if (d.kind === "mime" && d.mime === CONN_MIME) {
      let info: ConnectionTagInfo | null = null;
      try { info = inspectConnectionBlob(dec.decode(r.payload)); } catch { /* malformed */ }
      return info?.kind === "invite" ? "M5cet connection (v2 invitation)" : info?.kind === "offline" ? "M5cet connection (v2, code)" : info?.kind === "legacy" ? "M5cet connection (v1 PIN — weak)" : "M5cet connection (unreadable)";
    }
    if (d.kind === "uri") return `URI ${d.uri}`;
    if (d.kind === "text") return `Text ${JSON.stringify(d.text)}`;
    return d.kind;
  }).join(", ");
}
