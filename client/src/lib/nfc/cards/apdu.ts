// ISO 7816-4 APDU helpers, status-word decoding, BER-TLV codec and hex
// utilities. Pure functions; no transport dependency.

import { NfcError } from "../errors";

/* ---------- hex / bytes ---------- */

export function hex(bytes: ArrayLike<number> | undefined | null, sep = ""): string {
  if (!bytes) return "";
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i++) out.push(bytes[i].toString(16).padStart(2, "0").toUpperCase());
  return out.join(sep);
}

/** Parse "FF CA 00 00 00", "ffca000000", "FF:CA:00" or "0xFF,0xCA". Throws on odd length / bad chars. */
export function unhex(text: string): Uint8Array {
  const clean = text.replace(/0x/gi, "").replace(/[^0-9a-fA-F]/g, "");
  if (clean.length % 2 !== 0) throw new NfcError("invalid-argument", `Odd hex length: ${text}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

export function concat(...parts: ArrayLike<number>[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function bytesEqual(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function u8(...values: number[]): Uint8Array { return Uint8Array.from(values); }

export function asciiOf(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
  return s;
}

/** Classic hexdump: offset | 16 bytes | ascii. */
export function hexdump(bytes: Uint8Array, base = 0, width = 16): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += width) {
    const chunk = bytes.subarray(i, i + width);
    lines.push(`${(base + i).toString(16).padStart(4, "0")}  ${hex(chunk, " ").padEnd(width * 3 - 1)}  ${asciiOf(chunk)}`);
  }
  return lines.join("\n");
}

/* ---------- APDU ---------- */

export type Apdu = {
  cla: number; ins: number; p1: number; p2: number;
  data?: Uint8Array;
  /** Expected length: undefined = no Le, 0 = "256 / as much as possible", 1..255. */
  le?: number;
};

/** Build a short-form case 1..4 APDU. */
export function buildApdu(a: Apdu): Uint8Array {
  const head = u8(a.cla & 0xff, a.ins & 0xff, a.p1 & 0xff, a.p2 & 0xff);
  const data = a.data && a.data.length > 0 ? a.data : undefined;
  if (data && data.length > 255) throw new NfcError("invalid-argument", "Extended-length APDUs are not supported");
  const parts: Uint8Array[] = [head];
  if (data) parts.push(u8(data.length), data);
  if (a.le !== undefined) parts.push(u8(a.le & 0xff));
  return concat(...parts);
}

export function apdu(cla: number, ins: number, p1: number, p2: number, data?: Uint8Array, le?: number): Uint8Array {
  return buildApdu({ cla, ins, p1, p2, data, le });
}

/** Parse a raw command APDU into its fields (short form only). */
export function parseApdu(raw: Uint8Array): Apdu & { lc?: number } {
  if (raw.length < 4) throw new NfcError("invalid-argument", "APDU shorter than 4 bytes");
  const a: Apdu & { lc?: number } = { cla: raw[0], ins: raw[1], p1: raw[2], p2: raw[3] };
  if (raw.length === 4) return a;
  if (raw.length === 5) { a.le = raw[4]; return a; }
  const lc = raw[4];
  if (raw.length === 5 + lc) { a.lc = lc; a.data = raw.slice(5); return a; }
  if (raw.length === 6 + lc) { a.lc = lc; a.data = raw.slice(5, 5 + lc); a.le = raw[5 + lc]; return a; }
  throw new NfcError("invalid-argument", `Inconsistent APDU length (Lc=${lc}, total=${raw.length})`);
}

export type Response = { data: Uint8Array; sw1: number; sw2: number; sw: number };

export function splitResponse(raw: Uint8Array): Response {
  if (raw.length < 2) throw new NfcError("protocol", `Response shorter than SW1SW2 (${raw.length} bytes)`);
  const sw1 = raw[raw.length - 2];
  const sw2 = raw[raw.length - 1];
  return { data: raw.slice(0, raw.length - 2), sw1, sw2, sw: (sw1 << 8) | sw2 };
}

export function swHex(sw: number): string { return sw.toString(16).padStart(4, "0").toUpperCase(); }

/** Human-readable status word (ISO 7816-4 + common proprietary codes). */
export function describeSw(sw: number): string {
  const sw1 = sw >> 8;
  const sw2 = sw & 0xff;
  if (sw === 0x9000) return "OK";
  if (sw1 === 0x61) return `OK, ${sw2} more byte(s) available (GET RESPONSE)`;
  if (sw1 === 0x6c) return `Wrong Le, retry with Le=${sw2}`;
  if (sw1 === 0x63 && (sw2 & 0xf0) === 0xc0) return `Verification failed, ${sw2 & 0x0f} retries left`;
  if (sw1 === 0x62 && sw2 === 0x82) return "End of file reached before Le";
  if (sw1 === 0x63 && sw2 === 0x00) return "Verification failed / no info";
  if (sw1 === 0x91) return `DESFire status ${sw2.toString(16).padStart(2, "0")}${desfireStatus(sw2)}`;
  const table: Record<number, string> = {
    0x6200: "Warning: no information",
    0x6281: "Part of returned data may be corrupted",
    0x6283: "Selected file invalidated",
    0x6300: "Authentication failed",
    0x6581: "Memory failure",
    0x6700: "Wrong length",
    0x6800: "Functions in CLA not supported",
    0x6881: "Logical channel not supported",
    0x6882: "Secure messaging not supported",
    0x6900: "Command not allowed",
    0x6981: "Command incompatible with file structure",
    0x6982: "Security status not satisfied",
    0x6983: "Authentication method blocked",
    0x6984: "Referenced data invalidated",
    0x6985: "Conditions of use not satisfied",
    0x6986: "Command not allowed (no current EF)",
    0x6987: "Expected secure messaging data objects missing",
    0x6988: "Secure messaging data objects incorrect",
    0x6a80: "Incorrect parameters in data field",
    0x6a81: "Function not supported",
    0x6a82: "File or application not found",
    0x6a83: "Record not found",
    0x6a84: "Not enough memory space",
    0x6a86: "Incorrect P1/P2",
    0x6a87: "Lc inconsistent with P1/P2",
    0x6a88: "Referenced data not found",
    0x6b00: "Wrong parameters P1/P2",
    0x6d00: "Instruction not supported",
    0x6e00: "Class not supported",
    0x6f00: "No precise diagnosis / card mute",
  };
  return table[sw] || `Unknown status ${swHex(sw)}`;
}

function desfireStatus(code: number): string {
  const m: Record<number, string> = {
    0x00: " (OPERATION_OK)", 0x0c: " (NO_CHANGES)", 0x0e: " (OUT_OF_EEPROM)", 0x1c: " (ILLEGAL_COMMAND)",
    0x1e: " (INTEGRITY_ERROR)", 0x40: " (NO_SUCH_KEY)", 0x7e: " (LENGTH_ERROR)", 0x9d: " (PERMISSION_DENIED)",
    0x9e: " (PARAMETER_ERROR)", 0xa0: " (APPLICATION_NOT_FOUND)", 0xae: " (AUTHENTICATION_ERROR)",
    0xaf: " (ADDITIONAL_FRAME)", 0xbe: " (BOUNDARY_ERROR)", 0xca: " (COMMAND_ABORTED)", 0xf0: " (FILE_NOT_FOUND)",
  };
  return m[code] ?? "";
}

export function isOk(sw: number): boolean { return sw === 0x9000 || (sw >> 8) === 0x61 || sw === 0x9100; }

/**
 * Transmit with the ISO 7816-4 transport-level dance handled: 61xx → GET
 * RESPONSE, 6Cxx → retry with the suggested Le. `send` is the raw transport
 * function (data + SW).
 */
export async function transmitSmart(send: (apdu: Uint8Array) => Promise<Uint8Array>, cmd: Uint8Array): Promise<Response> {
  let r = splitResponse(await send(cmd));
  if (r.sw1 === 0x6c && cmd.length >= 5) {
    const fixed = cmd.slice();
    fixed[fixed.length - 1] = r.sw2;
    r = splitResponse(await send(fixed));
  }
  const chunks: Uint8Array[] = [r.data];
  let guard = 0;
  while (r.sw1 === 0x61 && guard++ < 64) {
    r = splitResponse(await send(u8(cmd[0] & 0xf0, 0xc0, 0x00, 0x00, r.sw2)));
    chunks.push(r.data);
  }
  const data = concat(...chunks);
  return { data, sw1: r.sw1, sw2: r.sw2, sw: r.sw };
}

/** Throws NfcError("card-error") unless SW is 9000 / 61xx. */
export function expectOk(r: Response, what = "APDU"): Response {
  if (!isOk(r.sw)) throw new NfcError("card-error", `${what}: ${describeSw(r.sw)} (SW=${swHex(r.sw)})`, swHex(r.sw));
  return r;
}

/* ---------- BER-TLV ---------- */

export type Tlv = { tag: number; tagBytes: Uint8Array; length: number; value: Uint8Array; constructed: boolean; children?: Tlv[] };

/** Decode one BER-TLV tag at `off`; returns tag value (as number, multi-byte packed big-endian) and byte length. */
export function readTlvTag(buf: Uint8Array, off: number): { tag: number; size: number } {
  if (off >= buf.length) throw new NfcError("protocol", "TLV: tag beyond buffer");
  let tag = buf[off];
  let size = 1;
  if ((tag & 0x1f) === 0x1f) {
    do {
      if (off + size >= buf.length) throw new NfcError("protocol", "TLV: truncated multi-byte tag");
      tag = (tag << 8) | buf[off + size];
      size++;
    } while (buf[off + size - 1] & 0x80);
  }
  return { tag: tag >>> 0, size };
}

export function readTlvLength(buf: Uint8Array, off: number): { length: number; size: number } {
  if (off >= buf.length) throw new NfcError("protocol", "TLV: length beyond buffer");
  const first = buf[off];
  if (first < 0x80) return { length: first, size: 1 };
  const n = first & 0x7f;
  if (n === 0 || n > 4) throw new NfcError("protocol", `TLV: unsupported length form 0x${first.toString(16)}`);
  if (off + n >= buf.length) throw new NfcError("protocol", "TLV: truncated length");
  let length = 0;
  for (let i = 1; i <= n; i++) length = (length << 8) | buf[off + i];
  return { length: length >>> 0, size: 1 + n };
}

/** Parse a sequence of BER-TLV objects; constructed tags are recursed into `children`. Padding 00/FF bytes are skipped. */
export function decodeTlv(buf: Uint8Array, opts: { recurse?: boolean } = {}): Tlv[] {
  const recurse = opts.recurse ?? true;
  const out: Tlv[] = [];
  let off = 0;
  while (off < buf.length) {
    if (buf[off] === 0x00 || buf[off] === 0xff) { off++; continue; }
    const t = readTlvTag(buf, off);
    const l = readTlvLength(buf, off + t.size);
    const start = off + t.size + l.size;
    if (start + l.length > buf.length) throw new NfcError("protocol", `TLV: value of tag ${t.tag.toString(16)} truncated`);
    const value = buf.slice(start, start + l.length);
    const constructed = (buf[off] & 0x20) !== 0;
    const node: Tlv = { tag: t.tag, tagBytes: buf.slice(off, off + t.size), length: l.length, value, constructed };
    if (constructed && recurse) {
      try { node.children = decodeTlv(value, opts); } catch { node.children = undefined; }
    }
    out.push(node);
    off = start + l.length;
  }
  return out;
}

function encodeTag(tag: number): Uint8Array {
  if (tag <= 0xff) return u8(tag);
  if (tag <= 0xffff) return u8(tag >> 8, tag & 0xff);
  if (tag <= 0xffffff) return u8(tag >> 16, (tag >> 8) & 0xff, tag & 0xff);
  return u8(tag >>> 24, (tag >> 16) & 0xff, (tag >> 8) & 0xff, tag & 0xff);
}

export function encodeTlvLength(length: number): Uint8Array {
  if (length < 0x80) return u8(length);
  if (length <= 0xff) return u8(0x81, length);
  if (length <= 0xffff) return u8(0x82, length >> 8, length & 0xff);
  if (length <= 0xffffff) return u8(0x83, length >> 16, (length >> 8) & 0xff, length & 0xff);
  return u8(0x84, length >>> 24, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff);
}

export function encodeTlv(tag: number, value: Uint8Array | Tlv[]): Uint8Array {
  const v = value instanceof Uint8Array ? value : concat(...value.map((c) => encodeTlv(c.tag, c.children ?? c.value)));
  return concat(encodeTag(tag), encodeTlvLength(v.length), v);
}

/** Depth-first search for a tag. */
export function findTlv(list: Tlv[] | undefined, tag: number): Tlv | undefined {
  if (!list) return undefined;
  for (const n of list) {
    if (n.tag === tag) return n;
    const inner = findTlv(n.children, tag);
    if (inner) return inner;
  }
  return undefined;
}

export function findAllTlv(list: Tlv[] | undefined, tag: number, acc: Tlv[] = []): Tlv[] {
  if (!list) return acc;
  for (const n of list) {
    if (n.tag === tag) acc.push(n);
    findAllTlv(n.children, tag, acc);
  }
  return acc;
}

/** Pretty-print a TLV tree with indentation, for the workbench log. */
export function formatTlv(list: Tlv[], depth = 0): string {
  const pad = "  ".repeat(depth);
  const lines: string[] = [];
  for (const n of list) {
    const tagHex = hex(n.tagBytes);
    if (n.children && n.children.length) {
      lines.push(`${pad}${tagHex} (${n.length})`);
      lines.push(formatTlv(n.children, depth + 1));
    } else {
      const printable = n.value.length && n.value.every((b) => b >= 0x20 && b < 0x7f) ? `  "${asciiOf(n.value)}"` : "";
      lines.push(`${pad}${tagHex} (${n.length}) ${hex(n.value, " ")}${printable}`);
    }
  }
  return lines.join("\n");
}

/* ---------- common ISO 7816 commands ---------- */

export const ISO = {
  selectByAid: (aid: Uint8Array, le: number | undefined = 0) => apdu(0x00, 0xa4, 0x04, 0x00, aid, le),
  selectByFid: (fid: number, p2 = 0x0c) => apdu(0x00, 0xa4, 0x00, p2, u8(fid >> 8, fid & 0xff)),
  readBinary: (offset: number, le: number) => apdu(0x00, 0xb0, (offset >> 8) & 0x7f, offset & 0xff, undefined, le),
  updateBinary: (offset: number, data: Uint8Array) => apdu(0x00, 0xd6, (offset >> 8) & 0x7f, offset & 0xff, data),
  readRecord: (rec: number, sfi: number) => apdu(0x00, 0xb2, rec, (sfi << 3) | 0x04, undefined, 0),
  getResponse: (le: number) => apdu(0x00, 0xc0, 0x00, 0x00, undefined, le),
  getData: (p1: number, p2: number) => apdu(0x00, 0xca, p1, p2, undefined, 0),
} as const;
