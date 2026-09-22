// Mifare Classic geometry, key dictionary and access-bit decoding.
//
// 1K: 16 sectors × 4 blocks (blocks 0..63), 16 bytes each.
// 4K: sectors 0..31 as 1K, then sectors 32..39 with 16 blocks each
//     (blocks 128..255). The last block of every sector is the sector
//     trailer: KeyA(6) | AccessBits(4) | KeyB(6).

import { NfcError } from "../errors";
import { unhex, hex } from "./apdu";

export type MifareType = "1k" | "4k" | "mini";

export function totalBlocks(type: MifareType): number {
  switch (type) {
    case "mini": return 20; // 5 sectors × 4 blocks
    case "1k": return 64;
    case "4k": return 256;
  }
}

export function sectorCount(type: MifareType): number {
  switch (type) {
    case "mini": return 5;
    case "1k": return 16;
    case "4k": return 40;
  }
}

/** Blocks in a sector: 4 for the first 32 sectors, 16 beyond (4K). */
export function blocksInSector(sector: number): number {
  return sector < 32 ? 4 : 16;
}

/** First (absolute) block number of a sector. */
export function sectorFirstBlock(sector: number): number {
  if (sector < 32) return sector * 4;
  return 128 + (sector - 32) * 16;
}

/** Sector trailer (absolute block number) for a sector. */
export function sectorTrailerBlock(sector: number): number {
  return sectorFirstBlock(sector) + blocksInSector(sector) - 1;
}

/** Which sector an absolute block belongs to. */
export function sectorOfBlock(block: number): number {
  if (block < 128) return Math.floor(block / 4);
  return 32 + Math.floor((block - 128) / 16);
}

export function isSectorTrailer(block: number): boolean {
  return block === sectorTrailerBlock(sectorOfBlock(block));
}

/**
 * Well-known / factory default keys, most-common first. Used by the
 * dictionary-attack helper in the workbench. These are all public,
 * widely documented transport keys shipped by tag vendors — not secrets.
 */
export const DEFAULT_KEYS: readonly string[] = [
  "FFFFFFFFFFFF", // factory default
  "A0A1A2A3A4A5", // MAD / NDEF public key A
  "D3F7D3F7D3F7", // NDEF public key B
  "000000000000",
  "B0B1B2B3B4B5",
  "4D3A99C351DD",
  "1A982C7E459A",
  "AABBCCDDEEFF",
  "714C5C886E97",
  "587EE5F9350F",
  "A0478CC39091",
  "533CB6C723F6",
  "8FD0A4F256E9",
];

export function defaultKeyBytes(): Uint8Array[] {
  return DEFAULT_KEYS.map((k) => unhex(k));
}

export function isValidKey(key: Uint8Array): boolean {
  return key.length === 6;
}

export function keyToHex(key: Uint8Array): string {
  if (!isValidKey(key)) throw new NfcError("invalid-argument", "Mifare key must be 6 bytes");
  return hex(key);
}

/* ---------- access bits ---------- */

export type AccessBits = { c1: number; c2: number; c3: number };

/**
 * Decode the 3 access-condition bytes (trailer bytes 6..8) into per-block
 * C1/C2/C3 triplets. Byte layout is the classic inverted/direct scheme;
 * this validates the inverted nibble and throws on corruption.
 */
export function decodeAccessBits(b6: number, b7: number, b8: number): AccessBits[] {
  // Inverted bits are stored in b6 and the low nibble of b7.
  const c1 = (b7 >> 4) & 0x0f;
  const c2 = b8 & 0x0f;
  const c3 = (b8 >> 4) & 0x0f;
  const c1Inv = b6 & 0x0f;
  const c2Inv = (b6 >> 4) & 0x0f;
  const c3Inv = b7 & 0x0f;
  if ((c1 ^ c1Inv) !== 0x0f || (c2 ^ c2Inv) !== 0x0f || (c3 ^ c3Inv) !== 0x0f) {
    throw new NfcError("protocol", "Mifare access bits failed inversion check (corrupt trailer)");
  }
  const out: AccessBits[] = [];
  for (let block = 0; block < 4; block++) {
    out.push({ c1: (c1 >> block) & 1, c2: (c2 >> block) & 1, c3: (c3 >> block) & 1 });
  }
  return out;
}

/** Encode 4 per-block access triplets back into the 3 access bytes + the standard GPB (0x69). */
export function encodeAccessBits(blocks: AccessBits[], gpb = 0x69): Uint8Array {
  if (blocks.length !== 4) throw new NfcError("invalid-argument", "Need 4 access triplets");
  let c1 = 0, c2 = 0, c3 = 0;
  for (let i = 0; i < 4; i++) { c1 |= blocks[i].c1 << i; c2 |= blocks[i].c2 << i; c3 |= blocks[i].c3 << i; }
  const b6 = ((~c2 & 0x0f) << 4) | (~c1 & 0x0f);
  const b7 = (c1 << 4) | (~c3 & 0x0f);
  const b8 = (c3 << 4) | c2;
  return Uint8Array.from([b6 & 0xff, b7 & 0xff, b8 & 0xff, gpb & 0xff]);
}

/** The default NDEF-formatted trailer for a data sector (public keys, GPB 0x40). */
export function ndefDataTrailer(): Uint8Array {
  const keyA = unhex("D3F7D3F7D3F7");
  const access = Uint8Array.from([0x7f, 0x07, 0x88, 0x40]);
  const keyB = unhex("FFFFFFFFFFFF");
  const out = new Uint8Array(16);
  out.set(keyA, 0); out.set(access, 6); out.set(keyB, 10);
  return out;
}

export type SectorTrailer = { keyA: Uint8Array; access: Uint8Array; keyB: Uint8Array; gpb: number };

export function parseTrailer(block: Uint8Array): SectorTrailer {
  if (block.length !== 16) throw new NfcError("invalid-argument", "Trailer must be 16 bytes");
  return { keyA: block.slice(0, 6), access: block.slice(6, 9), keyB: block.slice(10, 16), gpb: block[9] };
}
