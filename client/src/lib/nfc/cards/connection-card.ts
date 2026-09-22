// "Připojka" — a connection tag. An NDEF MIME record of type
// `application/vnd.m5cet.conn` whose body is the PIN-encrypted session
// (room + passphrase + optional name), reusing the existing
// lib/nfc.ts envelope so tags written by either path interoperate.
//
// Layout on the tag (one NDEF message):
//   record 0: MIME application/vnd.m5cet.conn  → encrypted blob (below)
//   record 1: URI  https://<app>/ (optional human fallback, not written here)
//
// The encrypted blob is exactly what lib/nfc.ts encryptForTag() returns:
//   "m5cet:nfc:v1:" + base64(salt|iv|AES-GCM(JSON))
// so decrypting needs the PIN. The JSON is { v, room, passphrase, name?, app? }.

import { encryptForTag, decryptFromTag } from "../../nfc";
import { NfcError } from "../errors";
import { decodeNdefMessage, decodeRecord, mimeRecord, uriRecord, typeString, type NdefRecord } from "./ndef";

export const CONN_MIME = "application/vnd.m5cet.conn";

const enc = new TextEncoder();
const dec = new TextDecoder();

export type ConnectionPayload = {
  v: 1;
  room: string;
  passphrase: string;
  name?: string;
  app?: string;
};

export type ConnectionTagOptions = {
  /** Optional plaintext URI record appended as a human fallback. */
  fallbackUrl?: string;
  appVersion?: string;
};

function assertSession(p: { room?: string; passphrase?: string }): void {
  if (!p.room || !p.passphrase) throw new NfcError("invalid-argument", "Connection tag needs a room and a passphrase");
}

/** Build the NDEF records for a connection tag. `pin` is 4–16 digits (validated by encryptForTag). */
export async function buildConnectionRecords(
  session: { room: string; passphrase: string; name?: string },
  pin: string,
  opts: ConnectionTagOptions = {},
): Promise<NdefRecord[]> {
  assertSession(session);
  const payload: ConnectionPayload = {
    v: 1,
    room: session.room,
    passphrase: session.passphrase,
    ...(session.name ? { name: session.name } : {}),
    ...(opts.appVersion ? { app: opts.appVersion } : {}),
  };
  const blob = await encryptForTag(pin, payload);
  const records: NdefRecord[] = [mimeRecord(CONN_MIME, enc.encode(blob))];
  if (opts.fallbackUrl) records.push(uriRecord(opts.fallbackUrl));
  return records;
}

/** True if this record set carries an M5cet connection payload. */
export function hasConnectionRecord(records: NdefRecord[]): boolean {
  return records.some((r) => typeString(r) === CONN_MIME);
}

/** Extract the raw encrypted blob from a record set, or null. */
export function readConnectionBlob(records: NdefRecord[]): string | null {
  const rec = records.find((r) => typeString(r) === CONN_MIME);
  if (!rec) return null;
  return dec.decode(rec.payload);
}

/** Parse + decrypt a connection tag from its NDEF records using the PIN. */
export async function decodeConnectionRecords(records: NdefRecord[], pin: string): Promise<ConnectionPayload> {
  const blob = readConnectionBlob(records);
  if (!blob) throw new NfcError("card-error", "Tag has no M5cet connection record");
  return decodeConnectionBlob(blob, pin);
}

/** Parse + decrypt directly from the blob string. */
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

/** Convenience: parse raw NDEF message bytes then decrypt. */
export async function decodeConnectionMessage(bytes: Uint8Array, pin: string): Promise<ConnectionPayload> {
  return decodeConnectionRecords(decodeNdefMessage(bytes), pin);
}

/** Summarize a record set for the log without decrypting. */
export function summarizeRecords(records: NdefRecord[]): string {
  return records.map((r) => {
    const d = decodeRecord(r);
    if (d.kind === "mime" && d.mime === CONN_MIME) return "M5cet connection (encrypted)";
    if (d.kind === "uri") return `URI ${d.uri}`;
    if (d.kind === "text") return `Text ${JSON.stringify(d.text)}`;
    return d.kind;
  }).join(", ");
}
