// Writing an M5Cet card (6.3 write-path fix): the pure NDEF encoding the card
// rides (external record + Type 2 TLV + Type 4 file), the MIFARE Classic MAD +
// sector layout, capacity math, and the write routing / typed errors — all
// against fakes, so nothing here needs a real reader or tag.

import { describe, it, expect } from "vitest";
import { hex, unhex } from "../client/src/lib/nfc/cards/apdu";
import {
  externalRecord, encodeNdefMessage, decodeNdefMessage, buildT2TlvArea, extractT2Ndef,
  TNF, T4T, type NdefRecord,
} from "../client/src/lib/nfc/cards/ndef";
import {
  madCrc8, buildMad1, madSectorTrailer, ndefDataSectors, mifareClassicNdefCapacity,
  planMifareClassicNdef, isMifareClassicSak, MAD_NDEF_AID,
  sectorFirstBlock, sectorTrailerBlock, ndefDataTrailer,
} from "../client/src/lib/nfc/cards/mifare-classic";
import { writeMifareClassicNdef } from "../client/src/lib/nfc/cards/tag-io";
import { writeType4Ndef } from "../client/src/lib/nfc/probes";
import { containerRecord, writeM5Card, findContainer } from "../client/src/lib/nfc/m5cet-card";
import {
  buildCard, decodeContainer, cardKeys, isM5Card, M5CARD_EXTERNAL_TYPE, type M5Record,
} from "../client/src/lib/nfc/m5card";
import { NfcError } from "../client/src/lib/nfc/errors";
import type { CardTransport, CardIdentity } from "../client/src/lib/nfc/transport";

const KEY_FF = "FFFFFFFFFFFF";
const PIN = "123456";

/* ---------------------------------------------------- NDEF external record */

describe("M5Cet external record encoding", () => {
  it("wraps the container in a short EXTERNAL record with the right header", () => {
    const rec = containerRecord(Uint8Array.from([1, 2, 3]));
    expect(rec.tnf).toBe(TNF.EXTERNAL);
    const msg = encodeNdefMessage([rec]);
    // flags: MB|ME|SR|EXTERNAL = 0x80|0x40|0x10|0x04 = 0xD4; typeLen 13; payloadLen 3.
    expect(msg[0]).toBe(0xd4);
    expect(msg[1]).toBe(M5CARD_EXTERNAL_TYPE.length);
    expect(msg[2]).toBe(3);
    const type = new TextDecoder().decode(msg.slice(3, 3 + M5CARD_EXTERNAL_TYPE.length));
    expect(type).toBe(M5CARD_EXTERNAL_TYPE);
    expect(Array.from(msg.slice(-3))).toEqual([1, 2, 3]);
    // round-trips
    const [back] = decodeNdefMessage(msg);
    expect(back.tnf).toBe(TNF.EXTERNAL);
    expect(new TextDecoder().decode(back.type)).toBe(M5CARD_EXTERNAL_TYPE);
    expect(Array.from(back.payload)).toEqual([1, 2, 3]);
  });

  it("switches to a 4-byte payload length for large containers", () => {
    const big = new Uint8Array(300).fill(0xab);
    const msg = encodeNdefMessage([externalRecord(M5CARD_EXTERNAL_TYPE, big)]);
    // SR bit clear → flags 0x04|0x80|0x40 = 0xC4, then typeLen, then 4-byte len.
    expect(msg[0]).toBe(0xc4);
    expect(Array.from(msg.slice(2, 6))).toEqual([0x00, 0x00, 0x01, 0x2c]); // 300 big-endian
    expect(decodeNdefMessage(msg)[0].payload.length).toBe(300);
  });
});

/* ------------------------------------------------------------ Type 2 TLV */

describe("Type 2 NDEF TLV framing", () => {
  it("uses a 1-byte length under 255 bytes", () => {
    const ndef = new Uint8Array(10).fill(0x11);
    const area = buildT2TlvArea(ndef);
    expect(area[0]).toBe(0x03); // NDEF TLV tag
    expect(area[1]).toBe(10); // 1-byte length
    expect(area[area.length - 1]).toBe(0xfe); // terminator
    expect(extractT2Ndef(area)!.ndef.length).toBe(10);
  });

  it("uses the 3-byte length form at 255 bytes and up", () => {
    const ndef = new Uint8Array(300).fill(0x22);
    const area = buildT2TlvArea(ndef);
    expect(area[0]).toBe(0x03);
    expect(area[1]).toBe(0xff); // long-form marker
    expect((area[2] << 8) | area[3]).toBe(300);
    expect(area[area.length - 1]).toBe(0xfe);
    expect(extractT2Ndef(area)!.ndef.length).toBe(300);
  });
});

/* ------------------------------------------------ MIFARE Classic MAD layout */

describe("MIFARE Classic MAD + NDEF layout", () => {
  it("classifies the SAK family", () => {
    expect(isMifareClassicSak(0x08)).toBe(true);
    expect(isMifareClassicSak(0x18)).toBe(true);
    expect(isMifareClassicSak(0x09)).toBe(true);
    expect(isMifareClassicSak(0x00)).toBe(false); // Ultralight / NTAG
    expect(isMifareClassicSak(0x20)).toBe(false); // ISO-DEP
    expect(isMifareClassicSak(undefined)).toBe(false);
  });

  it("stores the NDEF AID (03 E1) and a self-consistent CRC in the MAD", () => {
    const { block1, block2 } = buildMad1([1, 2, 3]);
    // AID entry for sector 1 sits at block1 bytes 2..3.
    expect(Array.from(block1.slice(2, 4))).toEqual([MAD_NDEF_AID[0], MAD_NDEF_AID[1]]);
    expect(hex(block1.slice(2, 4))).toBe("03E1");
    // Unused sectors are zero.
    expect(Array.from(block1.slice(8, 10))).toEqual([0, 0]); // sector 4
    // CRC in byte 0 recomputes from INFO + AID bytes (block1[1..] + block2).
    const area = new Uint8Array(32);
    area.set(block1, 0); area.set(block2, 16);
    expect(madCrc8(area.subarray(1))).toBe(block1[0]);
  });

  it("has a hand-verifiable CRC-8/MAD vector (poly 0x1D, preset 0xC7)", () => {
    // Preset 0xC7 XOR 0x00, then eight rounds → 0x66 (worked out by hand).
    expect(madCrc8(Uint8Array.from([0x00]))).toBe(0x66);
    // Deterministic and byte-ranged for any input.
    const v = madCrc8(Uint8Array.from([0x01, 0x03, 0xe1]));
    expect(v).toBe(madCrc8(Uint8Array.from([0x01, 0x03, 0xe1])));
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(0xff);
  });

  it("the MAD sector trailer carries the public MAD key A and GPB 0xC1", () => {
    const tr = madSectorTrailer();
    expect(hex(tr.slice(0, 6))).toBe("A0A1A2A3A4A5");
    expect(tr[9]).toBe(0xc1);
    expect(hex(tr.slice(10, 16))).toBe(KEY_FF);
  });

  it("plans MAD + TLV + trailers within the tag's capacity", () => {
    const ndef = new Uint8Array(40).fill(0x55);
    const plan = planMifareClassicNdef("1k", ndef);
    expect(plan.capacity).toBe(mifareClassicNdefCapacity("1k")); // 15 sectors * 3 * 16
    expect(plan.capacity).toBe(720);
    // First three writes are the MAD (blocks 1,2) + the MAD trailer (block 3).
    expect(plan.writes.slice(0, 3).map((w) => w.block)).toEqual([1, 2, 3]);
    expect(plan.writes[2].trailer).toBe(true);
    expect(hex(plan.writes[2].data.slice(0, 6))).toBe("A0A1A2A3A4A5");
    // The first data block is sector 1 block 0 and starts the NDEF TLV (0x03).
    const firstData = plan.writes.find((w) => w.block === sectorFirstBlock(1))!;
    expect(firstData.data[0]).toBe(0x03);
    // Each used data sector ends with the NDEF data trailer.
    const trailer1 = plan.writes.find((w) => w.block === sectorTrailerBlock(1))!;
    expect(hex(trailer1.data)).toBe(hex(ndefDataTrailer()));
    // Never touches block 0 (the read-only UID block).
    expect(plan.writes.some((w) => w.block === 0)).toBe(false);
  });

  it("marks only the sectors it actually fills in the MAD", () => {
    // ~120 bytes of TLV spans sectors 1..3 (48 B each) — sector 4 stays unused.
    const plan = planMifareClassicNdef("1k", new Uint8Array(120).fill(0x66));
    const mad1 = plan.writes.find((w) => w.block === 1)!.data;
    expect(hex(mad1.slice(2, 4))).toBe("03E1"); // sector 1 → NDEF
    expect(hex(mad1.slice(8, 10))).toBe("0000"); // sector 4 → unused
  });

  it("rejects a message that does not fit with a too-small error", () => {
    try {
      planMifareClassicNdef("1k", new Uint8Array(720).fill(0x77)); // TLV overhead pushes it over 720
      throw new Error("expected too-small");
    } catch (e) {
      expect(NfcError.is(e, "too-small")).toBe(true);
      expect((e as NfcError).detail).toMatch(/^\d+\/720$/);
    }
  });

  it("Mini has a smaller capacity (sectors 1..4)", () => {
    expect(ndefDataSectors("mini")).toEqual([1, 2, 3, 4]);
    expect(mifareClassicNdefCapacity("mini")).toBe(4 * 3 * 16);
  });
});

/* -------------------------------------- MIFARE Classic write, end to end */

const id1k: CardIdentity = { uid: unhex("04112233"), sak: 0x08, tech: "iso14443a", isoDep: false, hints: [] };

/** A fake 1K card. `mode: "raw"` exposes mifareAuth + transceiveRaw (ACR122-
 *  style); `mode: "block"` exposes the crypto-aware block methods (PN532). */
function mockClassic(mode: "raw" | "block") {
  const blocks = new Map<number, Uint8Array>();
  for (let b = 0; b < 64; b++) blocks.set(b, new Uint8Array(16));
  const base: Partial<CardTransport> = {
    id: mode === "raw" ? "webusb-ccid" : "webserial-pn532",
    label: "mock",
    capabilities: { apdu: true, raw: true, mifareAuth: mode === "raw", ndefOnly: false, emulate: false, write: true },
  };
  if (mode === "raw") {
    (base as { mifareAuth: CardTransport["mifareAuth"] }).mifareAuth = async (_b, keyType, key) => keyType === "A" && hex(key) === KEY_FF;
    (base as { transceiveRaw: CardTransport["transceiveRaw"] }).transceiveRaw = async (frame) => {
      if (frame[0] === 0x30) return blocks.get(frame[1]) ?? new Uint8Array(16);
      if (frame[0] === 0xa0) { blocks.set(frame[1], frame.slice(2, 18)); return Uint8Array.from([0x0a]); }
      return new Uint8Array();
    };
  } else {
    (base as { mifareReadBlock: CardTransport["mifareReadBlock"] }).mifareReadBlock = async (block, keyType, key) => {
      if (!(keyType === "A" && hex(key) === KEY_FF)) throw new NfcError("auth-failed", "no");
      return blocks.get(block) ?? new Uint8Array(16);
    };
    (base as { mifareWriteBlock: CardTransport["mifareWriteBlock"] }).mifareWriteBlock = async (block, data, keyType, key) => {
      if (!(keyType === "A" && hex(key) === KEY_FF)) throw new NfcError("auth-failed", "no");
      blocks.set(block, data.slice(0, 16));
    };
  }
  return { t: base as CardTransport, blocks };
}

/** Reassemble the NDEF area from the data blocks of sectors 1.. (skip trailers). */
function readbackTlv(blocks: Map<number, Uint8Array>): Uint8Array {
  const out: number[] = [];
  for (let s = 1; s <= 15; s++) {
    const first = sectorFirstBlock(s);
    for (let i = 0; i < 3; i++) out.push(...(blocks.get(first + i) ?? new Uint8Array(16)));
  }
  return Uint8Array.from(out);
}

describe("writeMifareClassicNdef against a fake card", () => {
  for (const mode of ["raw", "block"] as const) {
    it(`writes MAD + NDEF and reads back the container (${mode} reader)`, async () => {
      const { t, blocks } = mockClassic(mode);
      const rec: M5Record = { id: 0, type: "wifi", mode: "external", data: { ssid: "M5cet", password: "hunter2", auth: "WPA" } };
      const container = await buildCard([rec], cardKeys(PIN, null));
      await writeMifareClassicNdef(t, id1k, [containerRecord(container)]);

      // MAD present in sector 0 with the NDEF AID.
      expect(hex(blocks.get(1)!.slice(2, 4))).toBe("03E1");
      expect(blocks.get(1)![0]).toBe(madCrc8(Uint8Array.from([...blocks.get(1)!.slice(1), ...blocks.get(2)!])));
      // The reassembled NDEF area carries our external record → container.
      const found = extractT2Ndef(readbackTlv(blocks));
      expect(found).not.toBeNull();
      const back = findContainer(decodeNdefMessage(found!.ndef));
      expect(back).not.toBeNull();
      expect(isM5Card(back!)).toBe(true);
      const [sealed] = decodeContainer(back!);
      expect(sealed.type).toBe("wifi");
    });
  }

  it("raises no-key (with the sector) when no dictionary key opens a sector", async () => {
    const { t } = mockClassic("raw");
    (t as { mifareAuth: CardTransport["mifareAuth"] }).mifareAuth = async () => false;
    try {
      await writeMifareClassicNdef(t, id1k, [containerRecord(await buildCard([{ id: 0, type: "wifi", mode: "external", data: { ssid: "x" } }], cardKeys(PIN, null)))]);
      throw new Error("expected no-key");
    } catch (e) {
      expect(NfcError.is(e, "no-key")).toBe(true);
      expect((e as NfcError).detail).toBe("0"); // sector 0 (the MAD) fails first
    }
  });
});

/* ------------------------------------------------------- write routing */

describe("writeM5Card routing", () => {
  it("MIFARE Classic goes to the MAD writer, never Type 2 pages", async () => {
    const { t, blocks } = mockClassic("raw");
    const container = await buildCard([{ id: 0, type: "wifi", mode: "external", data: { ssid: "x" } }], cardKeys(PIN, null));
    await writeM5Card(t, id1k, container);
    // Sector 0 MAD was written (a Type 2 page write would never touch block 1/2).
    expect(hex(blocks.get(1)!.slice(2, 4))).toBe("03E1");
  });

  it("a reader that can't drive MIFARE Classic fails with a clear typed error", async () => {
    const t = {
      id: "webusb-ccid", label: "weak",
      capabilities: { apdu: true, raw: false, mifareAuth: false, ndefOnly: false, emulate: false, write: true },
    } as unknown as CardTransport;
    const container = await buildCard([{ id: 0, type: "wifi", mode: "external", data: { ssid: "x" } }], cardKeys(PIN, null));
    await expect(writeM5Card(t, id1k, container)).rejects.toMatchObject({ code: "not-supported-by-transport" });
  });

  it("Web NFC writes through the platform NDEF write with the external record", async () => {
    let written: NdefRecord[] | null = null;
    const t = {
      id: "webnfc", label: "webnfc",
      capabilities: { apdu: false, raw: false, mifareAuth: false, ndefOnly: true, emulate: false, write: true },
      async writeNdef(records: NdefRecord[]) { written = records; },
    } as unknown as CardTransport;
    const container = await buildCard([{ id: 0, type: "wifi", mode: "external", data: { ssid: "x" } }], cardKeys(PIN, null));
    const webId: CardIdentity = { uid: new Uint8Array(0), tech: "iso14443a", isoDep: false, hints: [] };
    await writeM5Card(t, webId, container);
    expect(written).not.toBeNull();
    expect(written![0].tnf).toBe(TNF.EXTERNAL);
    expect(new TextDecoder().decode(written![0].type)).toBe(M5CARD_EXTERNAL_TYPE);
  });
});

/* ------------------------------------------------- Type 4 typed errors */

/** A Type 4 transport whose CC is `cc`; SELECTs answer 9000, READ returns the CC. */
function mockType4(cc: Uint8Array): CardTransport {
  return {
    id: "webusb-ccid", label: "t4",
    capabilities: { apdu: true, raw: false, mifareAuth: false, ndefOnly: false, emulate: false, write: true },
    async transmit(apdu: Uint8Array) {
      const ins = apdu[1];
      if (ins === 0xa4) return Uint8Array.from([0x90, 0x00]); // SELECT (AID / file)
      if (ins === 0xb0) return Uint8Array.from([...cc, 0x90, 0x00]); // READ BINARY → CC
      return Uint8Array.from([0x6a, 0x82]);
    },
  } as unknown as CardTransport;
}

describe("Type 4 write typed errors", () => {
  it("surfaces read-only for a write-protected NDEF file", async () => {
    const cc = T4T.ccBytes(0x00ff, 0x00ff, 0x0400, true); // readOnly → writeAccess 0xFF
    await expect(writeType4Ndef(mockType4(cc), [containerRecord(Uint8Array.from([1, 2, 3]))]))
      .rejects.toMatchObject({ code: "read-only" });
  });

  it("surfaces too-small when the message exceeds the NDEF file size", async () => {
    const cc = T4T.ccBytes(0x00ff, 0x00ff, 0x0008, false); // 8-byte NDEF file
    const big = [externalRecord(M5CARD_EXTERNAL_TYPE, new Uint8Array(64).fill(1))];
    await expect(writeType4Ndef(mockType4(cc), big)).rejects.toMatchObject({ code: "too-small" });
  });
});
