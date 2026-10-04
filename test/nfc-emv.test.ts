// @vitest-environment node
//
// The EMV reader (cards/emv.ts) against a scripted card: PPSE → SELECT AID →
// GPO → READ RECORD, then the records are parsed into the holder data a
// terminal reads. Read-only — the fake card has no VERIFY or GENERATE AC and
// the reader never sends one.

import { describe, it, expect } from "vitest";
import { readEmv, emvSummary } from "../client/src/lib/nfc/cards/emv";
import { concat, encodeTlv, hex, u8, unhex, type Tlv } from "../client/src/lib/nfc/cards/apdu";
import type { CardTransport } from "../client/src/lib/nfc/transport";

const ascii = (s: string) => new TextEncoder().encode(s);
const T = (tag: number, value: Uint8Array) => encodeTlv(tag, value);
const ok = (resp: Uint8Array) => concat(resp, u8(0x90, 0x00));

const AID_VISA = "A0000000031010";
const AID_MC = "A0000000041010";

function visaRecord(): Uint8Array {
  return T(0x70, concat(
    T(0x5a, unhex("4111111111111111")),
    T(0x5f24, unhex("291231")),
    T(0x57, unhex("4111111111111111D291220100000000000F")),
    T(0x5f20, ascii("VISA CARDHOLDER")),
    T(0x5f28, unhex("0203")),
    T(0x9f36, unhex("0005")),
    T(0x9f17, unhex("03")),
  ));
}

function ppse(): Uint8Array {
  const app = T(0x61, concat(T(0x4f, unhex(AID_VISA)), T(0x50, ascii("VISA")), T(0x87, u8(0x01))));
  return T(0x6f, concat(T(0x84, ascii("2PAY.SYS.DDF01")), T(0xa5, T(0xbf0c, app))));
}

function aidFci(label: string): Uint8Array {
  return T(0x6f, concat(T(0x84, unhex(AID_VISA)), T(0xa5, concat(T(0x50, ascii(label)), T(0x9f38, unhex("9F66049F02069F3704"))))));
}

function gpo(): Uint8Array {
  return T(0x77, concat(T(0x82, unhex("5C00")), T(0x94, unhex("08010100"))));
}

/** A card that answers only reads; a write/verify would be an unknown INS (6D00). */
function fakeCard(opts: { ppse: boolean; selectable: string[] } = { ppse: true, selectable: [AID_VISA] }): CardTransport {
  const seen: string[] = [];
  const transmit = async (cmd: Uint8Array): Promise<Uint8Array> => {
    const a = Array.from(cmd);
    const ins = a[1], p1 = a[2], p2 = a[3];
    seen.push(hex(cmd).toUpperCase());
    if (ins === 0xa4 && p1 === 0x04) {
      const lc = a[4];
      const sel = hex(Uint8Array.from(a.slice(5, 5 + lc))).toUpperCase();
      if (opts.ppse && sel === hex(ascii("2PAY.SYS.DDF01")).toUpperCase()) return ok(ppse());
      if (opts.selectable.includes(sel)) return ok(aidFci("VISA"));
      return u8(0x6a, 0x82); // file not found
    }
    if (a[0] === 0x80 && ins === 0xa8) return ok(gpo());
    if (ins === 0xb2) return (p1 === 1 && (p2 >> 3) === 1) ? ok(visaRecord()) : u8(0x6a, 0x83);
    if (ins === 0x20 || (a[0] === 0x80 && ins === 0xae)) throw new Error("the reader must never VERIFY a PIN or GENERATE AC");
    return u8(0x6d, 0x00);
  };
  return { transmit, _seen: seen } as unknown as CardTransport;
}

describe("the EMV reader", () => {
  it("reads a Visa card's holder data via PPSE", async () => {
    const d = await readEmv(fakeCard());
    expect(d.aids).toEqual([AID_VISA]);
    expect(d.scheme).toBe("Visa");
    expect(d.apps).toHaveLength(1);
    const app = d.apps[0];
    expect(app.label).toBe("VISA");
    expect(app.pan).toBe("4111111111111111");
    expect(app.panMasked).toBe("411111••••••1111");
    expect(app.expiry).toBe("2029-12");
    expect(app.cardholder).toBe("VISA CARDHOLDER");
    expect(app.issuerCountry).toBe("Czechia");
    expect(app.atc).toBe(5);
    expect(app.pinTryCounter).toBe(3);
    // The PAN is one of the labelled tags.
    expect(app.tags.find((x) => x.tag === "5A")?.name).toContain("PAN");
    expect(emvSummary(d)).toContain("411111••••••1111");
  });

  it("recovers the PAN and expiry from Track 2 when tag 5A is absent", async () => {
    // Build a card whose record has only Track 2 (no 5A / 5F24).
    const rec = T(0x70, T(0x57, unhex("5555555555554444D2512201000000000F")));
    const card = {
      transmit: async (cmd: Uint8Array) => {
        const a = Array.from(cmd); const ins = a[1], p1 = a[2];
        if (ins === 0xa4 && p1 === 0x04) { const lc = a[4]; const sel = hex(Uint8Array.from(a.slice(5, 5 + lc))).toUpperCase(); return sel === hex(ascii("2PAY.SYS.DDF01")).toUpperCase() ? ok(ppse()) : sel === AID_VISA ? ok(aidFci("VISA")) : u8(0x6a, 0x82); }
        if (a[0] === 0x80 && ins === 0xa8) return ok(gpo());
        if (ins === 0xb2) return (a[2] === 1 && (a[3] >> 3) === 1) ? ok(rec) : u8(0x6a, 0x83);
        return u8(0x6d, 0x00);
      },
    } as unknown as CardTransport;
    const d = await readEmv(card);
    expect(d.apps[0].pan).toBe("5555555555554444");
    expect(d.apps[0].expiry).toBe("2025-12");
  });

  it("falls back to the candidate AIDs when there is no PPSE directory", async () => {
    const card = {
      transmit: async (cmd: Uint8Array) => {
        const a = Array.from(cmd); const ins = a[1], p1 = a[2];
        if (ins === 0xa4 && p1 === 0x04) { const lc = a[4]; const sel = hex(Uint8Array.from(a.slice(5, 5 + lc))).toUpperCase(); if (sel === hex(ascii("2PAY.SYS.DDF01")).toUpperCase()) return u8(0x6a, 0x82); return sel === AID_MC ? ok(aidFci("MASTERCARD")) : u8(0x6a, 0x82); }
        if (a[0] === 0x80 && ins === 0xa8) return ok(gpo());
        if (ins === 0xb2) return (a[2] === 1 && (a[3] >> 3) === 1) ? ok(visaRecord()) : u8(0x6a, 0x83);
        return u8(0x6d, 0x00);
      },
    } as unknown as CardTransport;
    const d = await readEmv(card);
    expect(d.aids).toContain(AID_MC);
    expect(d.apps[0].scheme).toBe("Mastercard");
    expect(d.apps[0].label).toBe("MASTERCARD");
  });

  it("returns an empty result for a card with no EMV application", async () => {
    const card = { transmit: async () => u8(0x6a, 0x82) } as unknown as CardTransport;
    const d = await readEmv(card);
    expect(d.apps).toHaveLength(0);
    expect(emvSummary(d)).toContain("No EMV");
  });
});
