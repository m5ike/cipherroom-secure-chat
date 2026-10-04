// @vitest-environment node
//
// The deep EMV read (6.6): GET DATA counters, the transaction log decoded by
// the card's own log format (9F4F), the AFL's records and every other short
// file — against a scripted card that answers only reads (a VERIFY or
// GENERATE AC would fail the test).

import { describe, it, expect } from "vitest";
import { readEmv, emvSummary, parseLogRecord } from "../client/src/lib/nfc/cards/emv";
import { concat, encodeTlv, hex, u8, unhex } from "../client/src/lib/nfc/cards/apdu";
import type { CardTransport } from "../client/src/lib/nfc/transport";

const ascii = (s: string) => new TextEncoder().encode(s);
const T = (tag: number, ...v: Uint8Array[]) => encodeTlv(tag, concat(...v));
const ok = (resp: Uint8Array) => concat(resp, u8(0x90, 0x00));

const AID = "A0000000041010";
// The log format: date, time, amount, currency, country, type, merchant (8), ATC.
const LOG_FORMAT = unhex("9A039F21039F02065F2A029F1A029C019F4E089F3602");
const logRecord = (date: string, time: string, amount: string, merchant: string, atc: number) =>
  concat(unhex(date), unhex(time), unhex(amount), unhex("0203"), unhex("0203"), unhex("00"), ascii(merchant.padEnd(8, " ").slice(0, 8)), u8(atc >> 8, atc & 0xff));

const LOG = [
  logRecord("250914", "183005", "000000012345", "BILLA", 41),
  logRecord("250912", "091500", "000000000990", "DPP", 40),
  new Uint8Array(LOG_FORMAT.length).fill(0), // an empty slot
];

function card(opts: { logInFci?: boolean } = {}): { t: CardTransport; seen: string[] } {
  const seen: string[] = [];
  const fci = T(0x6f, T(0x84, unhex(AID)), T(0xa5, T(0x50, ascii("MASTERCARD")), T(0x9f38, unhex("9F1A02")), ...(opts.logInFci !== false ? [T(0xbf0c, T(0x9f4d, u8(0x0b, 0x03)))] : [])));
  const ppse = T(0x6f, T(0x84, ascii("2PAY.SYS.DDF01")), T(0xa5, T(0xbf0c, T(0x61, T(0x4f, unhex(AID)), T(0x87, u8(1))))));
  const files: Record<string, Uint8Array> = {
    "1:1": T(0x70, T(0x5a, unhex("5413330089020011")), T(0x5f24, unhex("281231")), T(0x5f20, ascii("NOVAK/JAN")), T(0x5f28, unhex("0203"))),
    "2:1": T(0x70, T(0x8c, unhex("9F02069F03069F1A02")), T(0x8e, unhex("000000000000000042031E031F03"))),
    // Not in the AFL — only a deep read finds it.
    "3:1": T(0x70, T(0x9f08, unhex("0002")), T(0x5f30, unhex("0201"))),
    "3:2": T(0x70, T(0x9f42, unhex("0203"))),
  };
  const t = {
    transmit: async (cmd: Uint8Array) => {
      const a = Array.from(cmd);
      const [cla, ins, p1, p2] = a;
      seen.push(hex(cmd).toUpperCase());
      if (ins === 0x20 || (cla === 0x80 && ins === 0xae) || ins === 0xd6 || ins === 0xdc || ins === 0xe2) throw new Error("the reader must only read");
      if (ins === 0xa4 && p1 === 0x04) {
        const sel = hex(Uint8Array.from(a.slice(5, 5 + a[4]))).toUpperCase();
        if (sel === hex(ascii("2PAY.SYS.DDF01")).toUpperCase()) return ok(ppse);
        return sel === AID ? ok(fci) : u8(0x6a, 0x82);
      }
      if (cla === 0x80 && ins === 0xca) {
        const tag = ((p1 << 8) | p2).toString(16).toUpperCase();
        if (tag === "9F4F") return ok(T(0x9f4f, LOG_FORMAT));
        if (tag === "9F36") return ok(T(0x9f36, u8(0x00, 0x2a)));
        if (tag === "9F13") return ok(T(0x9f13, u8(0x00, 0x28)));
        if (tag === "9F17") return ok(T(0x9f17, u8(0x03)));
        if (tag === "9F4D" && opts.logInFci === false) return ok(T(0x9f4d, u8(0x0b, 0x03)));
        return u8(0x6a, 0x88);
      }
      if (cla === 0x80 && ins === 0xa8) return ok(T(0x77, T(0x82, unhex("1980")), T(0x94, unhex("0801010010010100"))));
      if (ins === 0xb2) {
        const sfi = p2 >> 3;
        if (sfi === 0x0b) return p1 <= LOG.length ? ok(LOG[p1 - 1]) : u8(0x6a, 0x83);
        const f = files[`${sfi}:${p1}`];
        if (f) return ok(f);
        return Object.keys(files).some((k) => k.startsWith(`${sfi}:`)) ? u8(0x6a, 0x83) : u8(0x6a, 0x82);
      }
      return u8(0x6d, 0x00);
    },
  } as unknown as CardTransport;
  return { t, seen };
}

describe("the deep EMV read", () => {
  it("reads the history, the counters and every file", async () => {
    const { t, seen } = card();
    const d = await readEmv(t);
    expect(d.deep).toBe(true);
    const app = d.apps[0];
    expect(app.scheme).toBe("Mastercard");
    expect(app.pan).toBe("5413330089020011");
    expect(app.cardholder).toBe("NOVAK / JAN");
    expect(app.atc).toBe(42);
    expect(app.lastOnlineAtc).toBe(40);
    expect(app.pinTryCounter).toBe(3);
    expect(app.aip).toBe("1980");
    expect(app.afl).toBe("0801010010010100");
    // The history, decoded by the card's log format; the empty slot is skipped.
    expect(app.logSfi).toBe(11);
    expect(app.logFormat).toBe(hex(LOG_FORMAT).toUpperCase());
    expect(app.log).toHaveLength(2);
    expect(app.log![0]).toMatchObject({ date: "2025-09-14", time: "18:30:05", amount: "123.45", currency: "CZK", country: "Czechia", type: "purchase", merchant: "BILLA", atc: "41" });
    expect(app.log![1]).toMatchObject({ amount: "9.90", merchant: "DPP" });
    // Every record, including the file only a deep read finds (SFI 3) and the log's raw records.
    expect(app.records!.map((r) => `${r.sfi}:${r.record}${r.log ? "L" : ""}`)).toEqual(["1:1", "2:1", "3:1", "3:2", "11:1L", "11:2L", "11:3L"]);
    expect(app.tags.find((x) => x.tag === "9F08")?.hex).toBe("0002");
    // GET DATA answers are kept.
    expect(app.getData!.map((g) => g.tag)).toEqual(["9F36", "9F13", "9F17", "9F4F"]);
    // The log is read before GPO (outside a transaction).
    const firstLog = seen.findIndex((s) => s.startsWith("00B2015C")), gpo = seen.findIndex((s) => s.startsWith("80A8"));
    expect(firstLog).toBeGreaterThan(-1);
    expect(firstLog).toBeLessThan(gpo);
    expect(d.apdus).toBeGreaterThan(10);
    expect(emvSummary(d)).toContain("2 transactions");
  });

  it("finds the log entry by GET DATA when the FCI does not carry it", async () => {
    const d = await readEmv(card({ logInFci: false }).t);
    expect(d.apps[0].log).toHaveLength(2);
  });

  it("reads only the AFL and no history when asked", async () => {
    const { t, seen } = card();
    const d = await readEmv(t, { deep: false, history: false });
    expect(d.apps[0].log).toBeUndefined();
    expect(d.apps[0].records!.map((r) => `${r.sfi}:${r.record}`)).toEqual(["1:1", "2:1"]);
    expect(seen.some((s) => s.startsWith("00B2011C"))).toBe(false); // SFI 3 never read
  });

  it("decodes a log record by its DOL", () => {
    const e = parseLogRecord(LOG[0], [{ tag: "9A", len: 3 }, { tag: "9F21", len: 3 }, { tag: "9F02", len: 6 }, { tag: "5F2A", len: 2 }, { tag: "9F1A", len: 2 }, { tag: "9C", len: 1 }, { tag: "9F4E", len: 8 }, { tag: "9F36", len: 2 }]);
    expect(e).toMatchObject({ date: "2025-09-14", amount: "123.45", currency: "CZK", merchant: "BILLA" });
    expect(e!.raw).toBe(hex(LOG[0]).toUpperCase());
    expect(parseLogRecord(new Uint8Array(10), [{ tag: "9A", len: 3 }])).toBeNull();
  });
});
