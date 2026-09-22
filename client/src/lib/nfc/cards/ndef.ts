// NDEF (NFC Data Exchange Format) message codec + Type 2 / Type 4 tag
// layouts. Pure functions.
//
// Record header byte: MB ME CF SR IL TNF(3). Short records (SR=1) carry a
// 1-byte payload length, long records 4 bytes big-endian. Chunked records
// (CF=1) are reassembled on parse; the builder never emits chunks.

import { NfcError } from "../errors";
import { concat, u8 } from "./apdu";

const enc = new TextEncoder();
const dec = new TextDecoder();

export const TNF = {
  EMPTY: 0x00,
  WELL_KNOWN: 0x01,
  MIME: 0x02,
  ABSOLUTE_URI: 0x03,
  EXTERNAL: 0x04,
  UNKNOWN: 0x05,
  UNCHANGED: 0x06,
  RESERVED: 0x07,
} as const;
export type Tnf = (typeof TNF)[keyof typeof TNF];

export type NdefRecord = {
  tnf: Tnf;
  /** Record type as bytes (e.g. "T", "U", "Sp", MIME type, external type). */
  type: Uint8Array;
  id?: Uint8Array;
  payload: Uint8Array;
};

/** NFC Forum URI identifier codes (URI RTD, table 3). Index = prefix byte. */
export const URI_PREFIXES: readonly string[] = [
  "", "http://www.", "https://www.", "http://", "https://", "tel:", "mailto:",
  "ftp://anonymous:anonymous@", "ftp://ftp.", "ftps://", "sftp://", "smb://", "nfs://", "ftp://", "dav://",
  "news:", "telnet://", "imap:", "rtsp://", "urn:", "pop:", "sip:", "sips:", "tftp:", "btspp://", "btl2cap://",
  "btgoep://", "tcpobex://", "irdaobex://", "file://", "urn:epc:id:", "urn:epc:tag:", "urn:epc:pat:",
  "urn:epc:raw:", "urn:epc:", "urn:nfc:",
];

/* ---------- builders ---------- */

export function textRecord(text: string, lang = "en", utf16 = false): NdefRecord {
  const langBytes = enc.encode(lang);
  if (langBytes.length > 63) throw new NfcError("invalid-argument", "Language code too long");
  const status = (utf16 ? 0x80 : 0) | langBytes.length;
  const body = utf16 ? utf16beEncode(text) : enc.encode(text);
  return { tnf: TNF.WELL_KNOWN, type: enc.encode("T"), payload: concat(u8(status), langBytes, body) };
}

export function uriRecord(uri: string): NdefRecord {
  let code = 0;
  let rest = uri;
  for (let i = 1; i < URI_PREFIXES.length; i++) {
    const p = URI_PREFIXES[i];
    if (uri.startsWith(p) && p.length > (URI_PREFIXES[code]?.length ?? 0)) { code = i; rest = uri.slice(p.length); }
  }
  return { tnf: TNF.WELL_KNOWN, type: enc.encode("U"), payload: concat(u8(code), enc.encode(rest)) };
}

export function mimeRecord(mime: string, payload: Uint8Array, id?: Uint8Array): NdefRecord {
  return { tnf: TNF.MIME, type: enc.encode(mime), payload, id };
}

export function externalRecord(domainType: string, payload: Uint8Array): NdefRecord {
  return { tnf: TNF.EXTERNAL, type: enc.encode(domainType), payload };
}

export function absoluteUriRecord(uri: string): NdefRecord {
  return { tnf: TNF.ABSOLUTE_URI, type: enc.encode(uri), payload: new Uint8Array(0) };
}

export function emptyRecord(): NdefRecord {
  return { tnf: TNF.EMPTY, type: new Uint8Array(0), payload: new Uint8Array(0) };
}

/** Smart Poster: URI + optional title(s) + optional action (0 = do, 1 = save, 2 = open for editing). */
export function smartPosterRecord(uri: string, titles: Array<{ text: string; lang?: string }> = [], action?: number): NdefRecord {
  const inner: NdefRecord[] = [uriRecord(uri), ...titles.map((t) => textRecord(t.text, t.lang ?? "en"))];
  if (action !== undefined) inner.push({ tnf: TNF.WELL_KNOWN, type: enc.encode("act"), payload: u8(action & 0xff) });
  return { tnf: TNF.WELL_KNOWN, type: enc.encode("Sp"), payload: encodeNdefMessage(inner) };
}

/* ---------- encode ---------- */

export function encodeNdefRecord(r: NdefRecord, first: boolean, last: boolean): Uint8Array {
  const sr = r.payload.length < 256;
  const il = r.id !== undefined && r.id.length > 0;
  let flags = (r.tnf & 0x07) | (sr ? 0x10 : 0) | (il ? 0x08 : 0) | (first ? 0x80 : 0) | (last ? 0x40 : 0);
  if (r.tnf === TNF.EMPTY) flags = (flags & 0xf8) | TNF.EMPTY;
  if (r.type.length > 255) throw new NfcError("invalid-argument", "NDEF type longer than 255 bytes");
  const parts: Uint8Array[] = [u8(flags, r.type.length)];
  if (sr) parts.push(u8(r.payload.length));
  else parts.push(u8(r.payload.length >>> 24, (r.payload.length >> 16) & 0xff, (r.payload.length >> 8) & 0xff, r.payload.length & 0xff));
  if (il) parts.push(u8(r.id!.length));
  parts.push(r.type);
  if (il) parts.push(r.id!);
  parts.push(r.payload);
  return concat(...parts);
}

export function encodeNdefMessage(records: NdefRecord[]): Uint8Array {
  if (records.length === 0) return encodeNdefRecord(emptyRecord(), true, true);
  return concat(...records.map((r, i) => encodeNdefRecord(r, i === 0, i === records.length - 1)));
}

/* ---------- decode ---------- */

export type ParsedRecord = NdefRecord & { chunked?: boolean };

/**
 * Parse an NDEF message. Tolerant: stops at the ME flag, reassembles
 * chunked records, throws NfcError("protocol") on truncation.
 */
export function decodeNdefMessage(buf: Uint8Array): NdefRecord[] {
  const out: NdefRecord[] = [];
  let off = 0;
  let chunk: { rec: NdefRecord; parts: Uint8Array[] } | null = null;
  let guard = 0;
  while (off < buf.length && guard++ < 4096) {
    const flags = buf[off++];
    const mb = !!(flags & 0x80);
    const me = !!(flags & 0x40);
    const cf = !!(flags & 0x20);
    const sr = !!(flags & 0x10);
    const il = !!(flags & 0x08);
    const tnf = (flags & 0x07) as Tnf;
    if (out.length === 0 && !chunk && !mb) throw new NfcError("protocol", "NDEF: first record lacks MB flag");
    if (off >= buf.length) throw new NfcError("protocol", "NDEF: truncated header");
    const typeLen = buf[off++];
    let payloadLen: number;
    if (sr) { payloadLen = buf[off++]; }
    else {
      if (off + 4 > buf.length) throw new NfcError("protocol", "NDEF: truncated payload length");
      payloadLen = ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
      off += 4;
    }
    const idLen = il ? buf[off++] : 0;
    if (off + typeLen + idLen + payloadLen > buf.length) throw new NfcError("protocol", "NDEF: record truncated");
    const type = buf.slice(off, off + typeLen); off += typeLen;
    const id = idLen ? buf.slice(off, off + idLen) : undefined; off += idLen;
    const payload = buf.slice(off, off + payloadLen); off += payloadLen;

    if (chunk) {
      if (tnf !== TNF.UNCHANGED) throw new NfcError("protocol", "NDEF: chunk continuation must use TNF UNCHANGED");
      chunk.parts.push(payload);
      if (!cf) { out.push({ ...chunk.rec, payload: concat(...chunk.parts) }); chunk = null; }
    } else if (cf) {
      chunk = { rec: { tnf, type, id, payload: new Uint8Array(0) }, parts: [payload] };
    } else {
      out.push({ tnf, type, id, payload });
    }
    if (me && !chunk) break;
  }
  if (chunk) throw new NfcError("protocol", "NDEF: unterminated chunked record");
  return out;
}

/* ---------- interpretation ---------- */

export type DecodedRecord =
  | { kind: "text"; text: string; lang: string; encoding: "utf-8" | "utf-16" }
  | { kind: "uri"; uri: string }
  | { kind: "smart-poster"; uri?: string; titles: Array<{ text: string; lang: string }>; action?: number }
  | { kind: "mime"; mime: string; payload: Uint8Array }
  | { kind: "external"; type: string; payload: Uint8Array }
  | { kind: "absolute-uri"; uri: string }
  | { kind: "empty" }
  | { kind: "unknown"; tnf: number; type: string; payload: Uint8Array };

export function typeString(r: NdefRecord): string { return dec.decode(r.type); }

export function decodeRecord(r: NdefRecord): DecodedRecord {
  const t = typeString(r);
  switch (r.tnf) {
    case TNF.EMPTY: return { kind: "empty" };
    case TNF.WELL_KNOWN:
      if (t === "T") {
        if (r.payload.length === 0) return { kind: "text", text: "", lang: "", encoding: "utf-8" };
        const status = r.payload[0];
        const langLen = status & 0x3f;
        const utf16 = !!(status & 0x80);
        const lang = dec.decode(r.payload.subarray(1, 1 + langLen));
        const body = r.payload.subarray(1 + langLen);
        return { kind: "text", text: utf16 ? utf16beDecode(body) : dec.decode(body), lang, encoding: utf16 ? "utf-16" : "utf-8" };
      }
      if (t === "U") {
        const code = r.payload[0] ?? 0;
        return { kind: "uri", uri: (URI_PREFIXES[code] ?? "") + dec.decode(r.payload.subarray(1)) };
      }
      if (t === "Sp") {
        const inner = decodeNdefMessage(r.payload);
        const sp: DecodedRecord = { kind: "smart-poster", titles: [] };
        for (const i of inner) {
          const d = decodeRecord(i);
          if (d.kind === "uri" && sp.uri === undefined) sp.uri = d.uri;
          else if (d.kind === "text") sp.titles.push({ text: d.text, lang: d.lang });
          else if (i.tnf === TNF.WELL_KNOWN && typeString(i) === "act") sp.action = i.payload[0];
        }
        return sp;
      }
      return { kind: "unknown", tnf: r.tnf, type: t, payload: r.payload };
    case TNF.MIME: return { kind: "mime", mime: t, payload: r.payload };
    case TNF.ABSOLUTE_URI: return { kind: "absolute-uri", uri: t };
    case TNF.EXTERNAL: return { kind: "external", type: t, payload: r.payload };
    default: return { kind: "unknown", tnf: r.tnf, type: t, payload: r.payload };
  }
}

export function describeRecord(r: NdefRecord): string {
  const d = decodeRecord(r);
  switch (d.kind) {
    case "text": return `Text [${d.lang || "-"}] ${JSON.stringify(d.text)}`;
    case "uri": return `URI ${d.uri}`;
    case "smart-poster": return `Smart Poster ${d.uri ?? "?"}${d.titles.length ? ` "${d.titles[0].text}"` : ""}`;
    case "mime": return `MIME ${d.mime} (${d.payload.length} B)`;
    case "external": return `External ${d.type} (${d.payload.length} B)`;
    case "absolute-uri": return `Absolute URI ${d.uri}`;
    case "empty": return "Empty record";
    default: return `TNF ${d.tnf} type ${JSON.stringify(d.type)} (${d.payload.length} B)`;
  }
}

/* ---------- Type 2 Tag (Ultralight / NTAG) TLV area ---------- */

export const T2T = {
  TLV_NULL: 0x00,
  TLV_LOCK: 0x01,
  TLV_MEMORY: 0x02,
  TLV_NDEF: 0x03,
  TLV_PROPRIETARY: 0xfd,
  TLV_TERMINATOR: 0xfe,
  /** Capability container lives in page 3 (bytes 12..15). */
  CC_PAGE: 3,
  CC_MAGIC: 0xe1,
  DATA_START_PAGE: 4,
} as const;

export type T2Capability = { magic: number; version: string; dataBytes: number; readOnly: boolean; writeAllowed: boolean };

/** Parse the 4-byte capability container (page 3). */
export function parseT2Cc(cc: Uint8Array): T2Capability | null {
  if (cc.length < 4 || cc[0] !== T2T.CC_MAGIC) return null;
  return {
    magic: cc[0],
    version: `${cc[1] >> 4}.${cc[1] & 0x0f}`,
    dataBytes: cc[2] * 8,
    readOnly: (cc[3] & 0x0f) !== 0,
    writeAllowed: (cc[3] & 0x0f) === 0,
  };
}

/** Build the TLV area for a Type 2 tag: NDEF TLV + terminator. Callers prepend the CC when formatting a blank tag. */
export function buildT2TlvArea(ndef: Uint8Array): Uint8Array {
  const len = ndef.length < 0xff ? u8(ndef.length) : u8(0xff, ndef.length >> 8, ndef.length & 0xff);
  return concat(u8(T2T.TLV_NDEF), len, ndef, u8(T2T.TLV_TERMINATOR));
}

/** Locate the NDEF TLV inside a Type 2 data area (bytes from page 4 on). Returns the NDEF message bytes or null. */
export function extractT2Ndef(area: Uint8Array): { ndef: Uint8Array; offset: number; length: number } | null {
  let off = 0;
  while (off < area.length) {
    const t = area[off];
    if (t === T2T.TLV_NULL) { off++; continue; }
    if (t === T2T.TLV_TERMINATOR) return null;
    if (off + 1 >= area.length) return null;
    let len = area[off + 1];
    let hdr = 2;
    if (len === 0xff) {
      if (off + 3 >= area.length) return null;
      len = (area[off + 2] << 8) | area[off + 3];
      hdr = 4;
    }
    if (t === T2T.TLV_NDEF) {
      const start = off + hdr;
      return { ndef: area.slice(start, Math.min(area.length, start + len)), offset: start, length: len };
    }
    off += hdr + len;
  }
  return null;
}

/* ---------- Type 4 Tag (ISO-DEP) file layout ---------- */

export const T4T = {
  AID: u8(0xd2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01),
  CC_FID: 0xe103,
  NDEF_FID: 0xe104,
  /** Mapping version 2.0 CC (15 bytes). */
  ccBytes(maxLe = 0x00ff, maxLc = 0x00ff, ndefFileSize = 0x0400, readOnly = false): Uint8Array {
    return u8(
      0x00, 0x0f, // CCLEN
      0x20, // mapping version 2.0
      maxLe >> 8, maxLe & 0xff,
      maxLc >> 8, maxLc & 0xff,
      0x04, 0x06, // NDEF file control TLV
      0xe1, 0x04, // NDEF file id
      ndefFileSize >> 8, ndefFileSize & 0xff,
      0x00, // read access: free
      readOnly ? 0xff : 0x00, // write access
    );
  },
} as const;

export type T4Capability = { ccLen: number; mappingVersion: string; maxLe: number; maxLc: number; ndefFid: number; ndefMaxSize: number; readAccess: number; writeAccess: number };

export function parseT4Cc(cc: Uint8Array): T4Capability {
  if (cc.length < 15) throw new NfcError("protocol", `Type 4 CC too short (${cc.length} B)`);
  if (cc[7] !== 0x04) throw new NfcError("protocol", "Type 4 CC lacks NDEF File Control TLV");
  return {
    ccLen: (cc[0] << 8) | cc[1],
    mappingVersion: `${cc[2] >> 4}.${cc[2] & 0x0f}`,
    maxLe: (cc[3] << 8) | cc[4],
    maxLc: (cc[5] << 8) | cc[6],
    ndefFid: (cc[9] << 8) | cc[10],
    ndefMaxSize: (cc[11] << 8) | cc[12],
    readAccess: cc[13],
    writeAccess: cc[14],
  };
}

/** NDEF file body = 2-byte big-endian NLEN + message. */
export function buildT4NdefFile(ndef: Uint8Array): Uint8Array {
  return concat(u8(ndef.length >> 8, ndef.length & 0xff), ndef);
}

/* ---------- utf-16 helpers ---------- */

function utf16beEncode(s: string): Uint8Array {
  const out = new Uint8Array(2 + s.length * 2);
  out[0] = 0xfe; out[1] = 0xff; // BOM
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); out[2 + i * 2] = c >> 8; out[3 + i * 2] = c & 0xff; }
  return out;
}

function utf16beDecode(b: Uint8Array): string {
  let le = false;
  let off = 0;
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) { le = true; off = 2; }
  else if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) off = 2;
  let s = "";
  for (let i = off; i + 1 < b.length; i += 2) s += String.fromCharCode(le ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]);
  return s;
}
