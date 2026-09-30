// The M5Cet card format (6.3): records seal and open, the container round-trips
// byte-for-byte, a one-time record can be removed, a wrong PIN fails cleanly,
// and an unknown record type is skipped rather than breaking the whole card.

import { describe, it, expect } from "vitest";
import {
  buildCard, cardKeys, decodeContainer, encodeContainer, isM5Card, openRecord, removeRecord, sealRecord,
  isValidCardPin, M5_RECORD_TYPES, M5CARD_MAGIC, type M5Record, type SealedRecord,
} from "../client/src/lib/nfc/m5card";
import { NFC_CATALOG, opsFor, supportsOp, techInfo } from "../client/src/lib/nfc/catalog";
import { normalizeCommand } from "../client/src/lib/nfc/command";

const PIN = "135790";
const root = crypto.getRandomValues(new Uint8Array(32)) as Uint8Array<ArrayBuffer>;

describe("card PIN", () => {
  it("is 6–18 digits", () => {
    expect(isValidCardPin("123456")).toBe(true);
    expect(isValidCardPin("123456789012345678")).toBe(true);
    expect(isValidCardPin("12345")).toBe(false);
    expect(isValidCardPin("1234567890123456789")).toBe(false);
    expect(isValidCardPin("12ab56")).toBe(false);
  });
});

describe("records", () => {
  it("seals and opens a PIN record; a wrong PIN fails", async () => {
    const rec: M5Record = { id: 0, type: "wifi", mode: "external", data: { ssid: "Home", password: "s3cret", auth: "WPA" } };
    const sealed = await sealRecord(rec, cardKeys(PIN, null));
    const opened = await openRecord(sealed, cardKeys(PIN, null));
    expect(opened.type).toBe("wifi");
    expect(opened.data).toEqual({ ssid: "Home", password: "s3cret", auth: "WPA" });
    await expect(openRecord(sealed, cardKeys("999999", null))).rejects.toThrow();
  });

  it("seals an account (internal) record that a PIN cannot open", async () => {
    const rec: M5Record = { id: 0, type: "identity-backup", mode: "internal", data: { user: "me" } };
    const sealed = await sealRecord(rec, cardKeys(null, root));
    expect((await openRecord(sealed, cardKeys(null, root))).data).toEqual({ user: "me" });
    await expect(openRecord(sealed, cardKeys(PIN, null))).rejects.toThrow(/account/);
  });

  it("binds the ciphertext to its type and id (AAD)", async () => {
    const sealed = await sealRecord({ id: 0x0a0b0c, type: "message", mode: "external", data: { text: "hi" } }, cardKeys(PIN, null));
    const forged: SealedRecord = { ...sealed, type: "contact" }; // same bytes, different declared type
    await expect(openRecord(forged, cardKeys(PIN, null))).rejects.toThrow();
  });
});

describe("container", () => {
  it("round-trips several records byte-for-byte", async () => {
    const recs: M5Record[] = [
      { id: 0, type: "url-login", mode: "external", data: { url: "https://x", user: "u", password: "p" } },
      { id: 0, type: "one-time-message", mode: "external", oneTime: true, data: { text: "burn after reading" } },
    ];
    const bytes = await buildCard(recs, cardKeys(PIN, null));
    expect(isM5Card(bytes)).toBe(true);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe(M5CARD_MAGIC);
    const sealed = decodeContainer(bytes);
    expect(sealed).toHaveLength(2);
    expect(sealed[1].oneTime).toBe(true);
    expect(encodeContainer(sealed)).toEqual(bytes);
    const opened = await Promise.all(sealed.map((s) => openRecord(s, cardKeys(PIN, null))));
    expect((opened[0].data as { user: string }).user).toBe("u");
    expect((opened[1].data as { text: string }).text).toBe("burn after reading");
  });

  it("removes a one-time record and keeps the rest openable", async () => {
    const recs: M5Record[] = [
      { id: 0, type: "wifi", mode: "external", data: { ssid: "A" } },
      { id: 0, type: "one-time-message", mode: "external", oneTime: true, data: { text: "once" } },
    ];
    const bytes = await buildCard(recs, cardKeys(PIN, null));
    const oneTimeId = decodeContainer(bytes).find((r) => r.oneTime)!.id;
    const after = removeRecord(bytes, oneTimeId);
    const left = decodeContainer(after);
    expect(left).toHaveLength(1);
    expect(left[0].type).toBe("wifi");
    expect((await openRecord(left[0], cardKeys(PIN, null))).data).toEqual({ ssid: "A" });
  });

  it("skips an unknown record type without failing the whole card", () => {
    const known: SealedRecord = { id: 1, type: "wifi", mode: "external", oneTime: false, salt: new Uint8Array(16), iv: new Uint8Array(12), ct: new Uint8Array(20) };
    const oneRecordBytes = encodeContainer([known]); // magic4 ver1 flags1 count1 | record
    const recordBytes = oneRecordBytes.subarray(7); // the single record's bytes
    // A future record of type 99 (unknown): type mode rflags id(3) salt(1+0) iv(1+0) ct(2+0).
    const future = Uint8Array.from([99, 0, 0, 0, 0, 2, 0, 0, 0, 0]);
    const twoRecords = Uint8Array.from([...oneRecordBytes.subarray(0, 7), ...recordBytes, ...future]);
    twoRecords[6] = 2; // count → 2
    const decoded = decodeContainer(twoRecords);
    expect(decoded).toHaveLength(1); // the unknown one is dropped
    expect(decoded[0].type).toBe("wifi");
  });

  it("rejects a foreign blob", () => {
    expect(isM5Card(new Uint8Array([1, 2, 3, 4, 5, 6, 7]))).toBe(false);
    expect(() => decodeContainer(new Uint8Array([1, 2, 3, 4, 5, 6, 7]))).toThrow();
  });
});

describe("catalogue", () => {
  it("covers the card types and offers the right operations", () => {
    const types = new Set(NFC_CATALOG.map((t) => t.tech));
    for (const t of ["m5cet-card", "mifare-classic-1k", "mifare-ultralight", "ntag21x", "mifare-desfire", "ndef", "emv", "eid", "iso15693", "felica"] as const) {
      expect(types.has(t)).toBe(true);
    }
    expect(Object.keys(M5_RECORD_TYPES)).toContain("passkey-backup");
    // Every card can be scanned and its UID read.
    for (const t of NFC_CATALOG) expect(t.ops.some((o) => o.id === "scan")).toBe(true);
    expect(supportsOp("mifare-classic-1k", "write-uid")).toBe(true);
    expect(supportsOp("emv", "write-uid")).toBe(false);
    // EMV and e-ID are public-only: no write, no key op.
    for (const t of ["emv", "eid"] as const) {
      expect(opsFor(t).filter((o) => o.kind === "write")).toHaveLength(0);
    }
    expect(techInfo("m5cet-card").ops.some((o) => o.id === "m5-write")).toBe(true);
  });
});

describe("nfc command", () => {
  it("keeps a valid command and clamps the timeout; never a raw key", () => {
    const c = normalizeCommand({ op: "classic-read", reader: "usb", timeout: 999, args: { sector: 1 }, secretRef: "keyset:default", key: "ffffffffffff" });
    expect(c).toMatchObject({ op: "classic-read", reader: "usb", timeout: 120, secretRef: "keyset:default" });
    expect(c).not.toHaveProperty("key");
    expect(normalizeCommand({ op: "SCAN!" })).toBeNull();
    expect(normalizeCommand({})).toBeNull();
    expect(normalizeCommand({ op: "scan", reader: "moon" }).reader).toBeUndefined();
  });
});
