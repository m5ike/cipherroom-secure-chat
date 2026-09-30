// The M5Cet card ON A TAG (6.3): the seam between the transport-agnostic
// container format (m5card.ts) and a real NFC tag.
//
// A card rides an NDEF EXTERNAL record of type `m5cet.cz:card` whose payload
// is the raw container — so the same bytes read on any reader, and a plain
// NDEF browser (Web NFC) writes and reads it like any other record. We also
// accept a container found anywhere in the message (a raw memory dump, a MIME
// body) as a fallback, keyed only on the "M5CD" magic.
//
// This module never holds a key: opening/sealing records takes a
// CardKeyProvider from the caller (cardKeys(pin, root) in m5card.ts).

import type { Bytes } from "../crypto";
import type { CardTransport, CardIdentity } from "./transport";
import { NfcError } from "./errors";
import {
  externalRecord, decodeRecord, TNF, typeString, type NdefRecord,
} from "./cards/ndef";
import { readNdefAuto, writeType2Ndef, writeType4Ndef } from "./probes";
import {
  M5CARD_EXTERNAL_TYPE, M5_RECORD_TYPES, isM5Card, decodeContainer, removeRecord,
  type SealedRecord, type M5Record,
} from "./m5card";

const encoder = new TextEncoder();

export { M5CARD_EXTERNAL_TYPE };

/** Wrap a container's bytes as the NDEF external record a card carries. */
export function containerRecord(container: Bytes): NdefRecord {
  return externalRecord(M5CARD_EXTERNAL_TYPE, container);
}

/** Copy an NDEF payload into an owned ArrayBuffer (the container format's
 *  Bytes = Uint8Array<ArrayBuffer>). */
function ownBytes(u: Uint8Array): Bytes { return Uint8Array.from(u); }

/** Find an M5Cet container in a set of NDEF records (external record first,
 *  then any record whose payload starts with the "M5CD" magic). */
export function findContainer(records: NdefRecord[]): Bytes | null {
  for (const r of records) {
    if (r.tnf === TNF.EXTERNAL && typeString(r) === M5CARD_EXTERNAL_TYPE) {
      const b = ownBytes(r.payload);
      if (isM5Card(b)) return b;
    }
  }
  for (const r of records) {
    const b = ownBytes(r.payload);
    if (isM5Card(b)) return b;
  }
  return null;
}

export type M5CardRead = { container: Bytes; sealed: SealedRecord[]; records: NdefRecord[] };

/** Read the tag's NDEF and, if it carries an M5Cet container, decode its
 *  sealed records (still encrypted). Returns null when the tag is not one. */
export async function readM5Card(t: CardTransport, id: CardIdentity): Promise<M5CardRead | null> {
  const res = await readNdefAuto(t, id);
  const container = findContainer(res.records);
  if (!container) return null;
  return { container, sealed: decodeContainer(container), records: res.records };
}

/** Write a container's bytes to the tag as the M5Cet external record. Chooses
 *  the write path by transport (Web NFC → writeNdef, ISO-DEP → Type 4, else
 *  Type 2 raw). */
export async function writeM5Card(t: CardTransport, id: CardIdentity, container: Bytes, opts: { signal?: AbortSignal } = {}): Promise<void> {
  const records = [containerRecord(container)];
  if (t.id === "webnfc" && t.writeNdef) { await t.writeNdef(records, { overwrite: true, signal: opts.signal }); return; }
  if (id.isoDep || (id.sak !== undefined && (id.sak & 0x20) !== 0)) { await writeType4Ndef(t, records); return; }
  if (t.transceiveRaw) { await writeType2Ndef(t, records); return; }
  throw new NfcError("not-supported-by-transport", "This reader has no NDEF write path for this tag");
}

/**
 * Erase one record and write the card back without it — the one-time flow
 * after a record has been shown. Returns the new container bytes.
 */
export async function eraseRecordAndRewrite(
  t: CardTransport, id: CardIdentity, container: Bytes, recordId: number, opts: { signal?: AbortSignal } = {},
): Promise<Bytes> {
  const next = removeRecord(container, recordId);
  await writeM5Card(t, id, next, opts);
  return next;
}

/* ---------------------------------------------------------- capacity */

// Per-record encoded overhead in encodeContainer():
//   type(1)+mode(1)+rflags(1)+id(3) + saltLen(1)+salt(16) + ivLen(1)+iv(12)
//   + ctLen(2) + ct ; ct = plaintextJSON + AES-GCM tag(16).
const RECORD_FIXED = 1 + 1 + 1 + 3 + (1 + 16) + (1 + 12) + 2; // = 38
const GCM_TAG = 16;
const CONTAINER_HEADER = 4 + 1 + 1 + 1; // magic + ver + flags + count = 7

/** The exact bytes one record adds to the container (matches sealRecord). */
export function estimateRecordBytes(rec: Pick<M5Record, "data">): number {
  const json = encoder.encode(JSON.stringify(rec.data ?? {})).length;
  return RECORD_FIXED + json + GCM_TAG;
}

/** The exact container size a set of records will encode to (matches buildCard). */
export function estimateContainerBytes(records: Array<Pick<M5Record, "data">>): number {
  return CONTAINER_HEADER + records.reduce((n, r) => n + estimateRecordBytes(r), 0);
}

/** The NDEF-message size once the container is wrapped in the external record. */
export function estimateNdefBytes(containerBytes: number): number {
  const payloadLenField = containerBytes < 256 ? 1 : 4;
  return 1 /*flags*/ + 1 /*typeLen*/ + payloadLenField + M5CARD_EXTERNAL_TYPE.length + containerBytes;
}

/** With the Type 2 TLV framing (NDEF TLV header + terminator) added. */
export function estimateType2Bytes(containerBytes: number): number {
  const ndef = estimateNdefBytes(containerBytes);
  return ndef + (ndef < 0xff ? 2 : 4) + 1;
}

/** Rough usable NDEF capacity per technology (bytes). The builder prefers a
 *  measured capacity (CC / GET_VERSION) when the tag gives one; this is the
 *  fallback so it can still warn about oversized cards. */
export const NOMINAL_CAPACITY: Partial<Record<string, number>> = {
  "mifare-ultralight": 48,
  ntag21x: 144,           // NTAG213 floor; 215/216 are larger — measure to raise it
  "mifare-classic-1k": 716,
  "mifare-classic-4k": 3356,
  "mifare-classic-mini": 224,
  ndef: 492,
  "m5cet-card": 492,
};

export function nominalCapacity(tech: string): number | undefined {
  return NOMINAL_CAPACITY[tech];
}

/* ------------------------------------------------------- record summaries */

/** Locked-record view for the m5.nfc executor: no secrets, just id / type /
 *  one-time — enough for a model to reason about a card without opening it. */
export function lockedSummaries(sealed: SealedRecord[]): Array<{ id: number; type: keyof typeof M5_RECORD_TYPES; oneTime: boolean; summary: string }> {
  return sealed.map((r) => ({ id: r.id, type: r.type, oneTime: r.oneTime, summary: r.type }));
}
