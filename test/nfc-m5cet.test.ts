// M5Cet card (6.3): the container built by the visual builder, read back by
// the reader — each record type through buildCard/openRecord, the capacity
// estimate against the real encoding, the NDEF external-record wrapper, and
// the one-time erase-and-rewrite.

import { describe, it, expect } from "vitest";
import {
  buildCard, decodeContainer, openRecord, removeRecord, isM5Card, cardKeys,
  isValidCardPin, M5CARD_EXTERNAL_TYPE, type M5Record,
} from "../client/src/lib/nfc/m5card";
import {
  containerRecord, findContainer, estimateContainerBytes, estimateNdefBytes,
  lockedSummaries,
} from "../client/src/lib/nfc/m5cet-card";
import { encodeNdefMessage, decodeNdefMessage } from "../client/src/lib/nfc/cards/ndef";
import { BUILDABLE_RECORDS, recordSummary } from "../client/src/lib/nfc/records";
import type { RecordData } from "../client/src/lib/nfc/records";

const PIN = "123456";
const ROOT = new Uint8Array(32).fill(7);

// One representative payload per record type.
const SAMPLES: { [K in keyof RecordData]: RecordData[K] } = {
  message: { text: "ahoj", url: "https://m5.cet/x", key: "abc", serverRef: { id: "srv-1", server: "https://m5.cet" } },
  "one-time-message": { text: "burn after reading", file: { name: "n.txt", mime: "text/plain", b64: "aGk=" } },
  "server-room": { server: "https://m5.cet", room: "brno-secure", passphrase: "tajný klíč 🔐", name: "Brno", user: "Michal" },
  wifi: { ssid: "M5cet", password: "hunter2", auth: "WPA", hidden: false },
  "url-login": { url: "https://m5.cet/login", user: "michal", password: "pw", note: "work" },
  contact: { name: "Michal", tel: "+420123", email: "m@x.cz", org: "M5", url: "https://x.cz", note: "hi" },
  "external-key": { label: "ssh", key: "AAAAB3Nza…", algo: "ed25519" },
  "passkey-backup": { account: { id: "u1", username: "michal" }, root: "cm9vdA==", at: 1 },
  "identity-backup": { user: "michal", keys: { sign: "c2ln", enc: "ZW5j" }, at: 2 },
};

describe("M5Cet PIN validation", () => {
  it("accepts 6–18 digits, rejects the rest", () => {
    expect(isValidCardPin("123456")).toBe(true);
    expect(isValidCardPin("123456789012345678")).toBe(true);
    expect(isValidCardPin("12345")).toBe(false);
    expect(isValidCardPin("1234567890123456789")).toBe(false);
    expect(isValidCardPin("12345a")).toBe(false);
  });
});

describe("M5Cet builder → reader roundtrip (external / PIN)", () => {
  it("seals and opens every buildable record type", async () => {
    const keys = cardKeys(PIN, null);
    for (const type of BUILDABLE_RECORDS) {
      const rec: M5Record = { id: 0, type, mode: "external", data: SAMPLES[type] };
      const bytes = await buildCard([rec], keys);
      expect(isM5Card(bytes)).toBe(true);
      const [sealed] = decodeContainer(bytes);
      expect(sealed.type).toBe(type);
      const opened = await openRecord(sealed, keys);
      expect(opened.data).toEqual(SAMPLES[type]);
      // The reader's list summary works from the opened data.
      expect(typeof recordSummary(type, opened.data)).toBe("string");
    }
  });

  it("rejects the wrong PIN", async () => {
    const rec: M5Record = { id: 0, type: "wifi", mode: "external", data: SAMPLES.wifi };
    const bytes = await buildCard([rec], cardKeys(PIN, null));
    const [sealed] = decodeContainer(bytes);
    await expect(openRecord(sealed, cardKeys("999999", null))).rejects.toThrow();
  });
});

describe("M5Cet internal (account) records", () => {
  it("seals with the account root and opens with the same root", async () => {
    const rec: M5Record = { id: 0, type: "passkey-backup", mode: "internal", data: SAMPLES["passkey-backup"] };
    const bytes = await buildCard([rec], cardKeys(null, ROOT));
    const [sealed] = decodeContainer(bytes);
    expect(sealed.mode).toBe("internal");
    const opened = await openRecord(sealed, cardKeys(null, ROOT));
    expect(opened.data).toEqual(SAMPLES["passkey-backup"]);
    // A different account root cannot open it.
    await expect(openRecord(sealed, cardKeys(null, new Uint8Array(32).fill(9)))).rejects.toThrow();
  });
});

describe("M5Cet capacity estimate", () => {
  it("matches the real encoded container size", async () => {
    const recs: M5Record[] = [
      { id: 0, type: "wifi", mode: "external", data: SAMPLES.wifi },
      { id: 0, type: "message", mode: "external", data: SAMPLES.message },
    ];
    const bytes = await buildCard(recs, cardKeys(PIN, null));
    expect(estimateContainerBytes(recs)).toBe(bytes.length);
    // The NDEF wrapper adds the external-record header + type.
    const ndef = encodeNdefMessage([containerRecord(bytes)]);
    expect(estimateNdefBytes(bytes.length)).toBe(ndef.length);
  });
});

describe("M5Cet NDEF wrapper + detection", () => {
  it("wraps the container in an external record and finds it back", async () => {
    const rec: M5Record = { id: 0, type: "url-login", mode: "external", data: SAMPLES["url-login"] };
    const bytes = await buildCard([rec], cardKeys(PIN, null));
    const msg = encodeNdefMessage([containerRecord(bytes)]);
    const records = decodeNdefMessage(msg);
    expect(records[0].tnf).toBe(0x04); // external
    const found = findContainer(records);
    expect(found).not.toBeNull();
    expect(isM5Card(found!)).toBe(true);
    const [sealed] = decodeContainer(found!);
    expect(sealed.type).toBe("url-login");
  });

  it("returns null NDEF that is not an M5Cet card", () => {
    const records = decodeNdefMessage(encodeNdefMessage([containerRecord(Uint8Array.from([1, 2, 3]))]));
    // payload 01 02 03 is not a container.
    expect(findContainer(records)).toBeNull();
  });
});

describe("M5Cet one-time removal + rewrite", () => {
  it("drops one record and keeps the rest (the bytes to write back)", async () => {
    const keys = cardKeys(PIN, null);
    const a: M5Record = { id: 0x111111, type: "one-time-message", mode: "external", oneTime: true, data: SAMPLES["one-time-message"] };
    const b: M5Record = { id: 0x222222, type: "wifi", mode: "external", data: SAMPLES.wifi };
    const bytes = await buildCard([a, b], keys);
    expect(decodeContainer(bytes)).toHaveLength(2);
    const next = removeRecord(bytes, 0x111111);
    const left = decodeContainer(next);
    expect(left).toHaveLength(1);
    expect(left[0].id).toBe(0x222222);
    expect(left[0].type).toBe("wifi");
    // The kept record still opens.
    const opened = await openRecord(left[0], keys);
    expect(opened.data).toEqual(SAMPLES.wifi);
  });
});

describe("M5Cet locked summaries (no secrets)", () => {
  it("lists id / type / one-time without opening", async () => {
    const recs: M5Record[] = [
      { id: 0, type: "one-time-message", mode: "external", oneTime: true, data: SAMPLES["one-time-message"] },
      { id: 0, type: "contact", mode: "external", data: SAMPLES.contact },
    ];
    const bytes = await buildCard(recs, cardKeys(PIN, null));
    const summaries = lockedSummaries(decodeContainer(bytes));
    expect(summaries).toHaveLength(2);
    expect(summaries[0].oneTime).toBe(true);
    expect(summaries.map((s) => s.type)).toEqual(["one-time-message", "contact"]);
    // No plaintext leaks: the summary is just the type name.
    expect(summaries[0].summary).toBe("one-time-message");
  });
});

describe("M5Cet external NDEF type", () => {
  it("is the app's own urn:nfc:ext type", () => {
    expect(M5CARD_EXTERNAL_TYPE).toBe("m5cet.cz:card");
  });
});
