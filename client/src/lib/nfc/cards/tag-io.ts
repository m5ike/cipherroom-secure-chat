// Memory I/O on the cards the tool supports well over a raw transport:
// Mifare Classic sectors (read / write / dump / restore) with the keys the
// USER holds, Ultralight / NTAG pages + read counter, and the UID / block 0
// of a UID-changeable ("magic") card the user owns.
//
// STANCE (6.3): every operation here works with keys the caller already has
// — a key dictionary the user manages, exactly like MIFARE Classic Tool.
// Nothing here recovers an UNKNOWN key (no nested / darkside / hardnested);
// a sector whose key is not in the dictionary simply stays closed. Changing
// a UID is only meaningful on a "magic" card the user owns, and the caller
// gates it behind an explicit choice.

import type { CardTransport, CardIdentity } from "../transport";
import { NfcError } from "../errors";
import { concat, u8, hex } from "./apdu";
import { encodeNdefMessage, type NdefRecord } from "./ndef";
import {
  sectorCount, sectorFirstBlock, blocksInSector, sectorTrailerBlock, sectorOfBlock,
  isSectorTrailer, defaultKeyBytes, planMifareClassicNdef, type MifareType,
} from "./mifare-classic";

/* ---------------------------------------------------------- Mifare Classic */

export function mifareTypeOf(id: CardIdentity): MifareType {
  return id.sak === 0x18 ? "4k" : id.sak === 0x09 ? "mini" : "1k";
}

function assertRaw(t: CardTransport): asserts t is CardTransport & { transceiveRaw: NonNullable<CardTransport["transceiveRaw"]> } {
  if (!t.transceiveRaw) throw new NfcError("not-supported-by-transport", "This reader cannot exchange raw frames");
}
function assertAuth(t: CardTransport): asserts t is CardTransport & { mifareAuth: NonNullable<CardTransport["mifareAuth"]> } {
  if (!t.mifareAuth) throw new NfcError("not-supported-by-transport", "This reader cannot authenticate Mifare sectors");
}

/** Authenticate a sector with the first key from the list that opens it. */
async function authSectorWith(
  t: CardTransport, sector: number, keys: Uint8Array[], uid: Uint8Array,
): Promise<{ key: Uint8Array; keyType: "A" | "B" } | null> {
  assertAuth(t);
  const trailer = sectorTrailerBlock(sector);
  for (const key of keys) {
    for (const keyType of ["A", "B"] as const) {
      try { if (await t.mifareAuth(trailer, keyType, key, uid)) return { key, keyType }; }
      catch (e) { if (!NfcError.is(e, "auth-failed") && !NfcError.is(e, "card-error")) throw e; }
    }
  }
  return null;
}

/** Read one 16-byte block; the sector must already be authenticated. */
async function readBlockRaw(t: CardTransport, block: number): Promise<Uint8Array> {
  assertRaw(t);
  const r = await t.transceiveRaw(u8(0x30, block), { crc: true });
  if (r.length < 16) throw new NfcError("card-error", `READ block ${block} returned ${r.length} B`);
  return r.slice(0, 16);
}

/** Write one 16-byte block; the sector must already be authenticated. */
async function writeBlockRaw(t: CardTransport, block: number, data: Uint8Array): Promise<void> {
  assertRaw(t);
  if (data.length !== 16) throw new NfcError("invalid-argument", "A Mifare block is 16 bytes");
  await t.transceiveRaw(concat(u8(0xa0, block), data), { crc: true });
}

export type ClassicBlock = { block: number; data?: Uint8Array; trailer: boolean };
export type ClassicSector = { sector: number; keyType?: "A" | "B"; key?: string; blocks: ClassicBlock[] };
export type ClassicDump = { type: MifareType; uid: string; sectors: ClassicSector[]; readableBlocks: number; totalBlocks: number };

/**
 * Read every sector reachable with the given keys (plus the documented
 * defaults, last). Blocks in a sector whose key is unknown are returned with
 * no `data`. Read-only — never writes.
 */
export async function classicDump(
  t: CardTransport, id: CardIdentity,
  opts: { keys?: Uint8Array[]; signal?: AbortSignal; onProgress?: (sector: number, total: number) => void } = {},
): Promise<ClassicDump> {
  assertAuth(t); assertRaw(t);
  const type = mifareTypeOf(id);
  const keys = [...(opts.keys ?? []), ...defaultKeyBytes()];
  const total = sectorCount(type);
  const sectors: ClassicSector[] = [];
  let readable = 0; let totalBlocks = 0;
  for (let s = 0; s < total; s++) {
    if (opts.signal?.aborted) throw new NfcError("aborted", "Dump cancelled");
    opts.onProgress?.(s, total);
    const auth = await authSectorWith(t, s, keys, id.uid);
    const first = sectorFirstBlock(s);
    const count = blocksInSector(s);
    const blocks: ClassicBlock[] = [];
    for (let i = 0; i < count; i++) {
      const block = first + i;
      totalBlocks++;
      const trailer = isSectorTrailer(block);
      if (!auth) { blocks.push({ block, trailer }); continue; }
      try { const data = await readBlockRaw(t, block); blocks.push({ block, data, trailer }); readable++; }
      catch { blocks.push({ block, trailer }); }
    }
    sectors.push({ sector: s, keyType: auth?.keyType, key: auth ? hex(auth.key) : undefined, blocks });
  }
  return { type, uid: hex(id.uid), sectors, readableBlocks: readable, totalBlocks };
}

/** Read a single block with an explicit key. */
export async function classicReadBlock(
  t: CardTransport, id: CardIdentity, block: number, key: Uint8Array, keyType: "A" | "B" = "A",
): Promise<Uint8Array> {
  assertAuth(t); assertRaw(t);
  if (!(await t.mifareAuth(sectorTrailerBlock(sectorOfBlock(block)), keyType, key, id.uid))) {
    throw new NfcError("auth-failed", `Key ${keyType} did not open sector ${sectorOfBlock(block)}`);
  }
  return readBlockRaw(t, block);
}

/** Write a single block with an explicit key. Guards block 0 (use writeUid). */
export async function classicWriteBlock(
  t: CardTransport, id: CardIdentity, block: number, data: Uint8Array, key: Uint8Array, keyType: "A" | "B" = "B",
): Promise<void> {
  assertAuth(t); assertRaw(t);
  if (block === 0) throw new NfcError("invalid-argument", "Block 0 is the UID block — use Change UID (magic cards only)");
  if (!(await t.mifareAuth(sectorTrailerBlock(sectorOfBlock(block)), keyType, key, id.uid))) {
    throw new NfcError("auth-failed", `Key ${keyType} did not open sector ${sectorOfBlock(block)}`);
  }
  await writeBlockRaw(t, block, data);
}

/**
 * Write a dump back onto a card whose keys are known. Skips block 0 and any
 * block the dump did not include. `restoreTrailers` also rewrites sector
 * trailers (keys/access) — off by default, since a wrong trailer bricks a
 * sector.
 */
export async function classicRestore(
  t: CardTransport, id: CardIdentity, dump: ClassicDump,
  opts: { keys?: Uint8Array[]; restoreTrailers?: boolean; signal?: AbortSignal; onProgress?: (sector: number, total: number) => void } = {},
): Promise<{ written: number; skipped: number }> {
  assertAuth(t); assertRaw(t);
  const keys = [...(opts.keys ?? []), ...defaultKeyBytes()];
  let written = 0; let skipped = 0;
  for (const sec of dump.sectors) {
    if (opts.signal?.aborted) throw new NfcError("aborted", "Restore cancelled");
    opts.onProgress?.(sec.sector, dump.sectors.length);
    const auth = await authSectorWith(t, sec.sector, keys, id.uid);
    if (!auth) { skipped += sec.blocks.length; continue; }
    for (const b of sec.blocks) {
      if (!b.data || b.block === 0 || (b.trailer && !opts.restoreTrailers)) { skipped++; continue; }
      try { await writeBlockRaw(t, b.block, b.data); written++; } catch { skipped++; }
    }
  }
  return { written, skipped };
}

/* ---------------------------------------------- Mifare Classic NDEF write */

/** Find the first dictionary key that opens a sector by probing a data read
 *  (non-destructive), preferring the reader's crypto-aware read. */
async function discoverSectorKey(
  t: CardTransport, sector: number, keys: Uint8Array[], uid: Uint8Array,
): Promise<{ key: Uint8Array; keyType: "A" | "B" } | null> {
  if (t.mifareReadBlock) {
    const first = sectorFirstBlock(sector);
    for (const key of keys) {
      for (const keyType of ["A", "B"] as const) {
        try { await t.mifareReadBlock(first, keyType, key, uid); return { key, keyType }; }
        catch (e) { if (!NfcError.is(e, "auth-failed") && !NfcError.is(e, "card-error")) throw e; }
      }
    }
    return null;
  }
  return authSectorWith(t, sector, keys, uid);
}

/**
 * Write an NDEF message onto a MIFARE Classic card as an NFC Forum tag:
 * format the MAD (sector 0) and lay the NDEF TLV across the data sectors,
 * authenticating each sector from the key dictionary (seeded with the public
 * transport / MAD / NDEF keys). Prefers the reader's crypto-aware block write
 * (mifareWriteBlock); falls back to mifareAuth + raw WRITE for readers that
 * keep the Crypto-1 session on their raw channel.
 *
 * The block LAYOUT is pure and unit-tested (planMifareClassicNdef); the
 * authenticated writes here need a real reader/tag to verify end to end.
 * Throws: "too-small" (message does not fit), "no-key" (a sector's key is not
 * in the dictionary, detail = sector), "not-supported-by-transport" (the
 * reader cannot write MIFARE Classic sectors at all).
 */
export async function writeMifareClassicNdef(
  t: CardTransport, id: CardIdentity, records: NdefRecord[],
  opts: { keys?: Uint8Array[]; signal?: AbortSignal } = {},
): Promise<{ written: number }> {
  const canWriteBlock = typeof t.mifareWriteBlock === "function";
  const canRaw = !!(t.mifareAuth && t.transceiveRaw);
  if (!canWriteBlock && !canRaw) {
    throw new NfcError("not-supported-by-transport", "This reader cannot write MIFARE Classic sectors");
  }
  const type = mifareTypeOf(id);
  const plan = planMifareClassicNdef(type, encodeNdefMessage(records)); // throws "too-small"
  const keys = [...(opts.keys ?? []), ...defaultKeyBytes()];

  // Group the plan by sector, preserving order (sector 0 / MAD first).
  const bySector = new Map<number, typeof plan.writes>();
  const order: number[] = [];
  for (const w of plan.writes) {
    const s = sectorOfBlock(w.block);
    if (!bySector.has(s)) { bySector.set(s, []); order.push(s); }
    bySector.get(s)!.push(w);
  }

  let written = 0;
  for (const sector of order) {
    if (opts.signal?.aborted) throw new NfcError("aborted", "Write cancelled");
    const auth = await discoverSectorKey(t, sector, keys, id.uid);
    if (!auth) throw new NfcError("no-key", `No key opens sector ${sector}`, String(sector));
    for (const w of bySector.get(sector)!) {
      if (t.mifareWriteBlock) await t.mifareWriteBlock(w.block, w.data, auth.keyType, auth.key, id.uid);
      else await writeBlockRaw(t, w.block, w.data); // sector stays authenticated from discoverSectorKey
      written++;
    }
  }
  return { written };
}

/* ------------------------------------------------------ Ultralight / NTAG */

/** Read `count` 4-byte pages starting at `from` (native READ returns 4 pages/call). */
export async function ultralightReadPages(t: CardTransport, from: number, count: number): Promise<Uint8Array> {
  assertRaw(t);
  const out: number[] = [];
  for (let page = from; page < from + count; page += 4) {
    const r = await t.transceiveRaw(u8(0x30, page), { crc: true });
    if (r.length < 4) break;
    for (const b of r.slice(0, 16)) out.push(b);
  }
  return Uint8Array.from(out).slice(0, count * 4);
}

/** Write one 4-byte page (WRITE, 0xA2). */
export async function ultralightWritePage(t: CardTransport, page: number, data: Uint8Array): Promise<void> {
  assertRaw(t);
  if (data.length !== 4) throw new NfcError("invalid-argument", "An Ultralight/NTAG page is 4 bytes");
  await t.transceiveRaw(concat(u8(0xa2, page), data), { crc: true });
}

/** NTAG21x read counter (READ_CNT 0x39, counter 0x02) — 3 bytes little-endian. */
export async function ntagReadCounter(t: CardTransport): Promise<number> {
  assertRaw(t);
  const r = await t.transceiveRaw(u8(0x39, 0x02), { crc: true });
  if (r.length < 3) throw new NfcError("card-error", "READ_CNT returned too little");
  return r[0] | (r[1] << 8) | (r[2] << 16);
}

/** PWD_AUTH (0x1B) with a 4-byte password → the 2-byte PACK, or throws. */
export async function ultralightPwdAuth(t: CardTransport, pwd: Uint8Array): Promise<Uint8Array> {
  assertRaw(t);
  if (pwd.length !== 4) throw new NfcError("invalid-argument", "An Ultralight/NTAG password is 4 bytes");
  const r = await t.transceiveRaw(concat(u8(0x1b), pwd), { crc: true });
  if (r.length < 2) throw new NfcError("auth-failed", "PWD_AUTH rejected");
  return r.slice(0, 2);
}

/* ------------------------------------------------------------- magic UID */

/**
 * Change the UID / block 0 of a UID-changeable card the user owns.
 *
 *  gen1a  — the "backdoor" magic card: unlock (0x40 then 0x43 in 7-bit /
 *           no-CRC frames), then WRITE block 0 directly.
 *  gen2   — block 0 is writable after a normal key auth, like any block.
 *
 * The card must be one the user owns; a normal card rejects both. Requires a
 * reader with raw-frame access (needs a real reader/tag to verify).
 */
export async function writeUidGen1a(t: CardTransport, block0: Uint8Array): Promise<void> {
  assertRaw(t);
  if (block0.length !== 16) throw new NfcError("invalid-argument", "Block 0 is 16 bytes (UID + BCC + SAK/ATQA + manufacturer)");
  await t.transceiveRaw(u8(0x40), { crc: false });          // unlock 1 (7-bit)
  await t.transceiveRaw(u8(0x43), { crc: false });          // unlock 2
  await t.transceiveRaw(concat(u8(0xa0, 0x00), block0), { crc: true }); // WRITE block 0
}

export async function writeUidGen2(
  t: CardTransport, id: CardIdentity, block0: Uint8Array, key: Uint8Array, keyType: "A" | "B" = "A",
): Promise<void> {
  assertAuth(t); assertRaw(t);
  if (block0.length !== 16) throw new NfcError("invalid-argument", "Block 0 is 16 bytes");
  if (!(await t.mifareAuth(0, keyType, key, id.uid))) throw new NfcError("auth-failed", "Key did not open sector 0");
  await writeBlockRaw(t, 0, block0);
}

/** Build block 0 from a UID: UID | BCC(=xor of UID for 4-byte) | SAK | ATQA | 8 manufacturer bytes. */
export function buildBlock0(uid: Uint8Array, sak = 0x08, atqa: Uint8Array = u8(0x04, 0x00), manufacturer?: Uint8Array): Uint8Array {
  const out = new Uint8Array(16);
  if (uid.length === 4) {
    out.set(uid, 0);
    out[4] = uid[0] ^ uid[1] ^ uid[2] ^ uid[3]; // BCC
    out[5] = sak; out[6] = atqa[0]; out[7] = atqa[1];
    if (manufacturer) out.set(manufacturer.slice(0, 8), 8);
  } else {
    out.set(uid.slice(0, 16), 0); // 7/10-byte: caller supplies the full block layout
  }
  return out;
}
