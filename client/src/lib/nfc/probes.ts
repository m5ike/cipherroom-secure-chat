// High-level card operations built on any CardTransport: NDEF read/write
// on Type 2 / Type 4 tags, DESFire/Ultralight GET_VERSION, EMV PPSE,
// MRTD selection, and a Mifare Classic dictionary attack. These raise the
// confidence of detect.ts and drive the workbench's action buttons.

import type { CardTransport, CardIdentity } from "./transport";
import { NfcError } from "./errors";
import {
  apdu, ISO, concat, u8, hex, splitResponse, transmitSmart, expectOk, describeSw,
  decodeTlv, findTlv, formatTlv, type Response,
} from "./cards/apdu";
import {
  decodeNdefMessage, encodeNdefMessage, buildT2TlvArea, extractT2Ndef, parseT4Cc, T4T, T2T,
  type NdefRecord,
} from "./cards/ndef";
import {
  DEFAULT_KEYS, defaultKeyBytes, sectorCount, sectorFirstBlock, blocksInSector, sectorTrailerBlock,
  type MifareType,
} from "./cards/mifare-classic";

/* ---------- GET_VERSION (Type 2 / DESFire) ---------- */

export type UlVersion = { raw: Uint8Array; vendor: number; product: string; storageBytes: number };

const NTAG_STORAGE: Record<number, string> = { 0x0f: "NTAG213", 0x11: "NTAG215", 0x13: "NTAG216" };

/** Ultralight/NTAG native GET_VERSION (0x60) over raw transceive. */
export async function ultralightGetVersion(t: CardTransport): Promise<UlVersion> {
  if (!t.transceiveRaw) throw new NfcError("not-supported-by-transport", "This transport cannot send raw commands");
  const r = await t.transceiveRaw(u8(0x60), { crc: true });
  if (r.length < 8) throw new NfcError("card-error", `GET_VERSION returned ${r.length} bytes`);
  const storage = r[6];
  const product = NTAG_STORAGE[storage] ?? (r[2] === 0x03 ? "Ultralight EV1" : "Ultralight family");
  return { raw: r, vendor: r[1], product, storageBytes: 1 << (storage >> 1) };
}

export type DesfireVersion = { hardware: Uint8Array; software: Uint8Array; uid: Uint8Array; text: string };

/** DESFire GetVersion (0x60) with additional-frame (0xAF) chaining, wrapped in ISO 7816. */
export async function desfireGetVersion(t: CardTransport): Promise<DesfireVersion> {
  const frames: Uint8Array[] = [];
  let r = splitResponse(await t.transmit(apdu(0x90, 0x60, 0x00, 0x00, undefined, 0x00)));
  frames.push(r.data);
  let guard = 0;
  while (r.sw === 0x91af && guard++ < 4) {
    r = splitResponse(await t.transmit(apdu(0x90, 0xaf, 0x00, 0x00, undefined, 0x00)));
    frames.push(r.data);
  }
  if ((r.sw & 0xff00) !== 0x9100) throw new NfcError("card-error", `DESFire GetVersion ${describeSw(r.sw)}`);
  const all = concat(...frames);
  return { hardware: all.slice(0, 7), software: all.slice(7, 14), uid: all.slice(14, 21), text: `DESFire, HW ${hex(all.slice(0, 7))}` };
}

/* ---------- NDEF read: Type 4 ---------- */

export type NdefReadResult = { records: NdefRecord[]; raw: Uint8Array; source: "type2" | "type4" | "identity" };

/** Read the NDEF message from a Type 4 (ISO-DEP) tag: SELECT app, SELECT CC, read CC, SELECT NDEF, read NLEN + body. */
export async function readType4Ndef(t: CardTransport): Promise<NdefReadResult> {
  const send = (a: Uint8Array) => t.transmit(a);
  expectOk(splitResponse(await send(ISO.selectByAid(T4T.AID))), "SELECT NDEF application");
  expectOk(splitResponse(await send(ISO.selectByFid(T4T.CC_FID))), "SELECT CC");
  const cc = await transmitSmart(send, ISO.readBinary(0, 15));
  expectOk(cc, "READ CC");
  const ccInfo = parseT4Cc(cc.data);
  expectOk(splitResponse(await send(ISO.selectByFid(ccInfo.ndefFid))), "SELECT NDEF file");
  const nlenResp = await transmitSmart(send, ISO.readBinary(0, 2));
  expectOk(nlenResp, "READ NLEN");
  const nlen = (nlenResp.data[0] << 8) | nlenResp.data[1];
  if (nlen === 0) return { records: [], raw: new Uint8Array(0), source: "type4" };
  // Read the message in chunks bounded by MaxLe.
  const maxLe = Math.min(0xff, ccInfo.maxLe || 0xff);
  const parts: Uint8Array[] = [];
  let off = 2;
  while (off - 2 < nlen) {
    const want = Math.min(maxLe, nlen - (off - 2));
    const chunk = await transmitSmart(send, ISO.readBinary(off, want));
    expectOk(chunk, "READ NDEF");
    if (chunk.data.length === 0) break;
    parts.push(chunk.data);
    off += chunk.data.length;
  }
  const raw = concat(...parts).slice(0, nlen);
  return { records: decodeNdefMessage(raw), raw, source: "type4" };
}

/* ---------- NDEF read: Type 2 ---------- */

/** Read the NDEF area from a Type 2 (Ultralight/NTAG) tag via raw READ (0x30) page reads. */
export async function readType2Ndef(t: CardTransport, maxPages = 45): Promise<NdefReadResult> {
  if (!t.transceiveRaw) throw new NfcError("not-supported-by-transport", "This transport cannot read Type 2 pages");
  const data: number[] = [];
  // READ returns 16 bytes (4 pages) per call.
  for (let page = T2T.DATA_START_PAGE; page < maxPages; page += 4) {
    let resp: Uint8Array;
    try { resp = await t.transceiveRaw(u8(0x30, page), { crc: true }); }
    catch { break; }
    if (resp.length < 4) break;
    for (const b of resp.slice(0, 16)) data.push(b);
  }
  const area = Uint8Array.from(data);
  const found = extractT2Ndef(area);
  if (!found) return { records: [], raw: new Uint8Array(0), source: "type2" };
  return { records: decodeNdefMessage(found.ndef), raw: found.ndef, source: "type2" };
}

/** Read NDEF using whatever the identity supports: Web NFC identity, Type 4, then Type 2. */
export async function readNdefAuto(t: CardTransport, id: CardIdentity): Promise<NdefReadResult> {
  if (id.ndef && id.ndef.length) return { records: id.ndef, raw: encodeNdefMessage(id.ndef), source: "identity" };
  if (id.isoDep || (id.sak !== undefined && (id.sak & 0x20))) {
    try { return await readType4Ndef(t); } catch (e) { if (!NfcError.is(e, "card-error")) throw e; }
  }
  if (t.transceiveRaw) return readType2Ndef(t);
  throw new NfcError("not-supported-by-transport", "No NDEF read path for this card/transport");
}

/* ---------- NDEF write: Type 4 ---------- */

export async function writeType4Ndef(t: CardTransport, records: NdefRecord[]): Promise<void> {
  const send = (a: Uint8Array) => t.transmit(a);
  const msg = encodeNdefMessage(records);
  expectOk(splitResponse(await send(ISO.selectByAid(T4T.AID))), "SELECT NDEF application");
  expectOk(splitResponse(await send(ISO.selectByFid(T4T.CC_FID))), "SELECT CC");
  const cc = await transmitSmart(send, ISO.readBinary(0, 15));
  const ccInfo = parseT4Cc(cc.data);
  if (ccInfo.writeAccess !== 0x00) throw new NfcError("card-error", "NDEF file is write-protected");
  expectOk(splitResponse(await send(ISO.selectByFid(ccInfo.ndefFid))), "SELECT NDEF file");
  // Zero NLEN first, write body, then set NLEN (per the Type 4 spec write flow).
  expectOk(splitResponse(await send(ISO.updateBinary(0, u8(0x00, 0x00)))), "Zero NLEN");
  const maxLc = Math.min(0xf0, ccInfo.maxLc || 0xf0);
  let off = 2;
  for (let i = 0; i < msg.length; i += maxLc) {
    const chunk = msg.slice(i, i + maxLc);
    expectOk(splitResponse(await send(ISO.updateBinary(off, chunk))), "UPDATE NDEF");
    off += chunk.length;
  }
  expectOk(splitResponse(await send(ISO.updateBinary(0, u8(msg.length >> 8, msg.length & 0xff)))), "Set NLEN");
}

/** Write NDEF to a Type 2 tag via raw WRITE (0xA2) page writes (4 bytes/page). */
export async function writeType2Ndef(t: CardTransport, records: NdefRecord[]): Promise<void> {
  if (!t.transceiveRaw) throw new NfcError("not-supported-by-transport", "This transport cannot write Type 2 pages");
  const area = buildT2TlvArea(encodeNdefMessage(records));
  const padded = concat(area, new Uint8Array((4 - (area.length % 4)) % 4));
  let page = T2T.DATA_START_PAGE;
  for (let i = 0; i < padded.length; i += 4, page++) {
    await t.transceiveRaw(concat(u8(0xa2, page), padded.subarray(i, i + 4)), { crc: true });
  }
}

/* ---------- EMV PPSE ---------- */

export type EmvResult = { present: boolean; aids: string[]; label?: string; tree: string };

/** SELECT the Proximity Payment System Environment (2PAY.SYS.DDF01) and list candidate AIDs. */
export async function selectPpse(t: CardTransport): Promise<EmvResult> {
  const ppse = new TextEncoder().encode("2PAY.SYS.DDF01");
  const r = splitResponse(await t.transmit(ISO.selectByAid(ppse)));
  if (r.sw !== 0x9000) return { present: false, aids: [], tree: describeSw(r.sw) };
  const tlv = decodeTlv(r.data);
  const aidNodes = collectAids(tlv);
  const label = findTlv(tlv, 0x50);
  return {
    present: true,
    aids: aidNodes.map((a) => hex(a)),
    label: label ? new TextDecoder().decode(label.value) : undefined,
    tree: formatTlv(tlv),
  };
}

function collectAids(tlv: ReturnType<typeof decodeTlv>): Uint8Array[] {
  const out: Uint8Array[] = [];
  const walk = (nodes: ReturnType<typeof decodeTlv>) => {
    for (const n of nodes) {
      if (n.tag === 0x4f) out.push(n.value);
      if (n.children) walk(n.children);
    }
  };
  walk(tlv);
  return out;
}

/* ---------- MRTD (ePassport) ---------- */

export async function selectMrtd(t: CardTransport): Promise<{ present: boolean; sw: string }> {
  const aid = u8(0xa0, 0x00, 0x00, 0x02, 0x47, 0x10, 0x01);
  const r = splitResponse(await t.transmit(ISO.selectByAid(aid)));
  return { present: r.sw === 0x9000, sw: describeSw(r.sw) };
}

/* ---------- Mifare Classic dictionary attack ---------- */

export type SectorKeyResult = { sector: number; keyA?: string; keyB?: string };
export type DictionaryResult = { type: MifareType; sectors: SectorKeyResult[]; recoveredSectors: number; totalSectors: number };

/**
 * Try the default-key dictionary against every sector (key A then key B),
 * using the transport's reader-side authentication. Reports which keys
 * opened which sectors. Read-only; never writes.
 */
export async function mifareDictionaryAttack(
  t: CardTransport,
  id: CardIdentity,
  opts: { keys?: Uint8Array[]; signal?: AbortSignal; onProgress?: (sector: number, total: number) => void } = {},
): Promise<DictionaryResult> {
  if (!t.mifareAuth) throw new NfcError("not-supported-by-transport", "This transport cannot authenticate Mifare sectors");
  const type: MifareType = id.sak === 0x18 ? "4k" : id.sak === 0x09 ? "mini" : "1k";
  const keys = opts.keys ?? defaultKeyBytes();
  const total = sectorCount(type);
  const sectors: SectorKeyResult[] = [];
  let recovered = 0;
  for (let s = 0; s < total; s++) {
    if (opts.signal?.aborted) throw new NfcError("aborted", "Attack cancelled");
    opts.onProgress?.(s, total);
    const trailer = sectorTrailerBlock(s);
    const res: SectorKeyResult = { sector: s };
    for (const key of keys) {
      if (res.keyA === undefined && await tryAuth(t, trailer, "A", key, id.uid)) res.keyA = hex(key);
      if (res.keyB === undefined && await tryAuth(t, trailer, "B", key, id.uid)) res.keyB = hex(key);
      if (res.keyA && res.keyB) break;
    }
    if (res.keyA || res.keyB) recovered++;
    sectors.push(res);
  }
  return { type, sectors, recoveredSectors: recovered, totalSectors: total };
}

async function tryAuth(t: CardTransport, block: number, keyType: "A" | "B", key: Uint8Array, uid: Uint8Array): Promise<boolean> {
  try { return await t.mifareAuth!(block, keyType, key, uid); }
  catch (e) { if (NfcError.is(e, "auth-failed") || NfcError.is(e, "card-error")) return false; throw e; }
}

export { DEFAULT_KEYS, sectorFirstBlock, blocksInSector };

/* ---------- APDU script runner (workbench console) ---------- */

export type ApduStep = { apdu: Uint8Array; response: Response; ok: boolean; note: string };

/** Run a newline-separated list of hex APDUs, stopping on the first non-9000 unless `continueOnError`. */
export async function runApduScript(
  t: CardTransport,
  apdus: Uint8Array[],
  opts: { continueOnError?: boolean } = {},
): Promise<ApduStep[]> {
  const steps: ApduStep[] = [];
  for (const a of apdus) {
    const response = splitResponse(await t.transmit(a));
    const ok = response.sw === 0x9000 || (response.sw >> 8) === 0x61;
    steps.push({ apdu: a, response, ok, note: describeSw(response.sw) });
    if (!ok && !opts.continueOnError) break;
  }
  return steps;
}
