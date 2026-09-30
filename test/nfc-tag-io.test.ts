// Memory I/O (tag-io.ts) against a fake transport: Mifare Classic
// dump/read/write with a key dictionary, Ultralight pages + counter, and the
// magic block-0 helpers. No hardware — the fake stands in for the reader.

import { describe, it, expect } from "vitest";
import type { CardTransport, CardIdentity } from "../client/src/lib/nfc/transport";
import { hex, unhex } from "../client/src/lib/nfc/cards/apdu";
import {
  classicDump, classicReadBlock, classicWriteBlock, mifareTypeOf,
  ultralightReadPages, ultralightWritePage, ntagReadCounter, writeUidGen1a, buildBlock0,
} from "../client/src/lib/nfc/cards/tag-io";

const id1k: CardIdentity = { uid: Uint8Array.from([0x04, 0x11, 0x22, 0x33]), sak: 0x08, tech: "iso14443a", isoDep: false, hints: [] };
const KEY_FF = "FFFFFFFFFFFF";

/** A fake 1K card: key A = FF…FF opens every sector; blocks hold their index. */
function mockClassic() {
  const blocks = new Map<number, Uint8Array>();
  for (let b = 0; b < 64; b++) blocks.set(b, new Uint8Array(16).fill(b));
  const raw: string[] = [];
  const t: Partial<CardTransport> = {
    id: "webusb-ccid",
    label: "mock",
    capabilities: { apdu: true, raw: true, mifareAuth: true, ndefOnly: false, emulate: false, write: true },
    async mifareAuth(_block, keyType, key) { return keyType === "A" && hex(key) === KEY_FF; },
    async transceiveRaw(frame) {
      raw.push(hex(frame));
      if (frame[0] === 0x30) return blocks.get(frame[1]) ?? new Uint8Array(16);
      if (frame[0] === 0xa0) { blocks.set(frame[1], frame.slice(2, 18)); return Uint8Array.from([0x0a]); }
      if (frame[0] === 0x40 || frame[0] === 0x43) return Uint8Array.from([0x0a]);
      return new Uint8Array();
    },
  };
  return { t: t as CardTransport, blocks, raw };
}

describe("Mifare Classic I/O", () => {
  it("picks the type from SAK", () => {
    expect(mifareTypeOf(id1k)).toBe("1k");
    expect(mifareTypeOf({ ...id1k, sak: 0x18 })).toBe("4k");
    expect(mifareTypeOf({ ...id1k, sak: 0x09 })).toBe("mini");
  });

  it("dumps every sector reachable with the default key", async () => {
    const { t } = mockClassic();
    const dump = await classicDump(t, id1k, { keys: [] });
    expect(dump.type).toBe("1k");
    expect(dump.totalBlocks).toBe(64);
    expect(dump.readableBlocks).toBe(64);
    expect(dump.sectors).toHaveLength(16);
    expect(dump.sectors[0].key).toBe(KEY_FF);
    expect(hex(dump.sectors[0].blocks[1].data!)).toBe("01".repeat(16));
  });

  it("leaves sectors closed when no key opens them", async () => {
    const { t } = mockClassic();
    // Override auth to reject everything.
    (t as { mifareAuth: CardTransport["mifareAuth"] }).mifareAuth = async () => false;
    const dump = await classicDump(t, id1k, { keys: [unhex("A0A1A2A3A4A5")] });
    expect(dump.readableBlocks).toBe(0);
    expect(dump.sectors.every((s) => s.key === undefined)).toBe(true);
  });

  it("reads and writes a single block with an explicit key", async () => {
    const { t, blocks } = mockClassic();
    const before = await classicReadBlock(t, id1k, 4, unhex(KEY_FF), "A");
    expect(hex(before)).toBe("04".repeat(16));
    const data = new Uint8Array(16).fill(0xab);
    await classicWriteBlock(t, id1k, 4, data, unhex(KEY_FF), "A");
    expect(hex(blocks.get(4)!)).toBe("AB".repeat(16));
  });

  it("refuses to write block 0 (UID block)", async () => {
    const { t } = mockClassic();
    await expect(classicWriteBlock(t, id1k, 0, new Uint8Array(16), unhex(KEY_FF), "A")).rejects.toThrow(/UID/i);
  });
});

describe("magic UID", () => {
  it("gen1a sends the backdoor unlock then writes block 0", async () => {
    const { t, blocks, raw } = mockClassic();
    const block0 = buildBlock0(Uint8Array.from([0xde, 0xad, 0xbe, 0xef]));
    await writeUidGen1a(t, block0);
    expect(raw).toContain("40");
    expect(raw).toContain("43");
    expect(hex(blocks.get(0)!)).toBe(hex(block0));
  });

  it("builds block 0 with a correct BCC for a 4-byte UID", () => {
    const b0 = buildBlock0(Uint8Array.from([0x04, 0x11, 0x22, 0x33]));
    expect(b0[4]).toBe(0x04 ^ 0x11 ^ 0x22 ^ 0x33);
    expect(b0[5]).toBe(0x08); // default SAK
    expect(b0.length).toBe(16);
  });
});

describe("Ultralight / NTAG I/O", () => {
  function mockUl() {
    const pages = new Map<number, Uint8Array>();
    for (let p = 0; p < 40; p++) pages.set(p, Uint8Array.from([p, p, p, p]));
    const t: Partial<CardTransport> = {
      id: "webserial-pn532",
      capabilities: { apdu: true, raw: true, mifareAuth: false, ndefOnly: false, emulate: true, write: true },
      async transceiveRaw(frame) {
        if (frame[0] === 0x30) { const out: number[] = []; for (let i = 0; i < 4; i++) out.push(...(pages.get(frame[1] + i) ?? new Uint8Array(4))); return Uint8Array.from(out); }
        if (frame[0] === 0xa2) { pages.set(frame[1], frame.slice(2, 6)); return Uint8Array.from([0x0a]); }
        if (frame[0] === 0x39) return Uint8Array.from([0x2a, 0x00, 0x00]); // counter = 42
        return new Uint8Array();
      },
    };
    return { t: t as CardTransport, pages };
  }

  it("reads a run of pages (4 per native READ)", async () => {
    const { t } = mockUl();
    const data = await ultralightReadPages(t, 4, 8);
    expect(data.length).toBe(32);
    expect(Array.from(data.slice(0, 4))).toEqual([4, 4, 4, 4]);
  });

  it("writes a 4-byte page and rejects the wrong size", async () => {
    const { t, pages } = mockUl();
    await ultralightWritePage(t, 6, Uint8Array.from([1, 2, 3, 4]));
    expect(Array.from(pages.get(6)!)).toEqual([1, 2, 3, 4]);
    await expect(ultralightWritePage(t, 6, Uint8Array.from([1, 2, 3]))).rejects.toThrow();
  });

  it("reads the NTAG counter", async () => {
    const { t } = mockUl();
    expect(await ntagReadCounter(t)).toBe(42);
  });
});
