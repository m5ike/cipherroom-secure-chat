// @vitest-environment node
//
// The deep EMV read (6.6): GET DATA counters, the transaction log decoded by
// the card's own log format (9F4F), the AFL's records and every other short
// file — against a scripted card that answers only reads (a VERIFY or
// GENERATE AC would fail the test). 6.10: the card lives in
// test/helpers/nfc-sims.ts, so the template runner's tests read the same one.

import { describe, it, expect } from "vitest";
import { readEmv, emvSummary, parseLogRecord } from "../client/src/lib/nfc/cards/emv";
import { hex } from "../client/src/lib/nfc/cards/apdu";
import { emvCard as card, LOG, LOG_FORMAT, VISA_AID } from "./helpers/nfc-sims";

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

  it("6.10: reads the application it is asked to favour first", async () => {
    const d = await readEmv(card({ visa: true }).t, { aid: VISA_AID, deep: false });
    expect(d.aids).toEqual([VISA_AID, "A0000000041010"]);
    expect(d.apps.map((a) => a.scheme)).toEqual(["Visa", "Mastercard"]);
    expect(d.apps[0].pan).toBe("4111111111111111");
  });

  it("decodes a log record by its DOL", () => {
    const e = parseLogRecord(LOG[0], [{ tag: "9A", len: 3 }, { tag: "9F21", len: 3 }, { tag: "9F02", len: 6 }, { tag: "5F2A", len: 2 }, { tag: "9F1A", len: 2 }, { tag: "9C", len: 1 }, { tag: "9F4E", len: 8 }, { tag: "9F36", len: 2 }]);
    expect(e).toMatchObject({ date: "2025-09-14", amount: "123.45", currency: "CZK", merchant: "BILLA" });
    expect(e!.raw).toBe(hex(LOG[0]).toUpperCase());
    expect(parseLogRecord(new Uint8Array(10), [{ tag: "9A", len: 3 }])).toBeNull();
  });
});
