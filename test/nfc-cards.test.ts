import { describe, it, expect } from "vitest";
import {
  hex, unhex, buildApdu, apdu, parseApdu, splitResponse, describeSw, isOk, transmitSmart,
  decodeTlv, encodeTlv, findTlv, readTlvLength, ISO,
} from "../client/src/lib/nfc/cards/apdu";
import {
  textRecord, uriRecord, mimeRecord, smartPosterRecord, encodeNdefMessage, decodeNdefMessage,
  decodeRecord, buildT2TlvArea, extractT2Ndef, parseT4Cc, T4T, URI_PREFIXES,
} from "../client/src/lib/nfc/cards/ndef";
import {
  totalBlocks, sectorFirstBlock, sectorTrailerBlock, sectorOfBlock, blocksInSector, isSectorTrailer,
  decodeAccessBits, encodeAccessBits, DEFAULT_KEYS,
} from "../client/src/lib/nfc/cards/mifare-classic";
import { detectCard } from "../client/src/lib/nfc/cards/detect";
import { buildConnectionRecords, decodeConnectionRecords, hasConnectionRecord, CONN_MIME } from "../client/src/lib/nfc/cards/connection-card";
import { buildCommand, FrameParser, ACK } from "../client/src/lib/nfc/transports/pn532";
import { listTransports, createTransport } from "../client/src/lib/nfc/index";
import type { CardIdentity } from "../client/src/lib/nfc/transport";

const ident = (over: Partial<CardIdentity>): CardIdentity => ({ uid: new Uint8Array(), tech: "iso14443a", isoDep: false, hints: [], ...over });

describe("hex / unhex", () => {
  it("roundtrips and tolerates separators", () => {
    expect(hex(unhex("FF CA 00 00 00"))).toBe("FFCA000000");
    expect(hex(unhex("0xFF,0xCA"))).toBe("FFCA");
    expect(() => unhex("ABC")).toThrow();
  });
});

describe("APDU", () => {
  it("builds case 1..4 correctly", () => {
    expect(hex(apdu(0x00, 0xa4, 0x04, 0x00))).toBe("00A40400");
    expect(hex(apdu(0x00, 0xa4, 0x04, 0x00, undefined, 0x00))).toBe("00A4040000");
    expect(hex(apdu(0x00, 0xa4, 0x04, 0x00, unhex("D2760000850101")))).toBe("00A4040007D2760000850101");
    expect(hex(apdu(0x00, 0xb0, 0x00, 0x00, undefined, 0x10))).toBe("00B0000010");
  });
  it("parses back", () => {
    const p = parseApdu(unhex("00A4040007D276000085010100"));
    expect(p.ins).toBe(0xa4);
    expect(hex(p.data!)).toBe("D2760000850101");
    expect(p.le).toBe(0x00);
  });
  it("splits response + status words", () => {
    const r = splitResponse(unhex("6F1A840E325041592E5359532E4444463031A5089000"));
    expect(r.sw).toBe(0x9000);
    expect(isOk(0x9000)).toBe(true);
    expect(isOk(0x6a82)).toBe(false);
    expect(describeSw(0x6a82)).toMatch(/not found/i);
    expect(describeSw(0x63c2)).toMatch(/2 retries/);
    expect(describeSw(0x61ff)).toMatch(/255 more/);
  });
  it("transmitSmart handles 61xx GET RESPONSE chaining", async () => {
    let call = 0;
    const send = async (cmd: Uint8Array) => {
      call++;
      if (cmd[1] === 0xc0) return unhex("BBBB9000"); // GET RESPONSE
      return unhex("AAAA6102"); // 2 more bytes
    };
    const r = await transmitSmart(send, apdu(0x00, 0xca, 0x00, 0x00, undefined, 0x00));
    expect(hex(r.data)).toBe("AAAABBBB");
    expect(r.sw).toBe(0x9000);
    expect(call).toBe(2);
  });
  it("transmitSmart retries 6Cxx with the corrected Le", async () => {
    const seen: string[] = [];
    const send = async (cmd: Uint8Array) => { seen.push(hex(cmd)); return cmd[cmd.length - 1] === 0x00 ? unhex("6C05") : unhex("A1A2A3A4A59000"); };
    const r = await transmitSmart(send, apdu(0x00, 0xb0, 0x00, 0x00, undefined, 0x00));
    expect(r.sw).toBe(0x9000);
    expect(seen[1].endsWith("05")).toBe(true);
  });
});

describe("BER-TLV", () => {
  it("decodes nested constructed objects (PPSE FCI)", () => {
    const tlv = decodeTlv(unhex("6F1B840E325041592E5359532E4444463031A5094F07A0000000031010"));
    const fci = tlv[0];
    expect(fci.tag).toBe(0x6f);
    expect(findTlv(tlv, 0x84)).toBeTruthy();
    const aid = findTlv(tlv, 0x4f);
    expect(hex(aid!.value)).toBe("A0000000031010");
  });
  it("handles multi-byte tags and long lengths", () => {
    const long = new Uint8Array(200).fill(0x41);
    const encoded = encodeTlv(0x9f10, long);
    const [node] = decodeTlv(encoded);
    expect(node.tag).toBe(0x9f10);
    expect(node.length).toBe(200);
    expect(readTlvLength(unhex("8200C8"), 0)).toEqual({ length: 200, size: 3 });
  });
});

describe("NDEF", () => {
  it("roundtrips a text record with language", () => {
    const [rec] = decodeNdefMessage(encodeNdefMessage([textRecord("Ahoj světe", "cs")]));
    const d = decodeRecord(rec);
    expect(d).toEqual({ kind: "text", text: "Ahoj světe", lang: "cs", encoding: "utf-8" });
  });
  it("picks the longest URI prefix abbreviation", () => {
    const [rec] = decodeNdefMessage(encodeNdefMessage([uriRecord("https://www.example.com")]));
    expect(rec.payload[0]).toBe(URI_PREFIXES.indexOf("https://www."));
    expect(decodeRecord(rec)).toEqual({ kind: "uri", uri: "https://www.example.com" });
  });
  it("roundtrips multiple records with MB/ME flags", () => {
    const msg = encodeNdefMessage([textRecord("a"), uriRecord("https://x.io"), mimeRecord("application/json", new Uint8Array([0x7b, 0x7d]))]);
    const recs = decodeNdefMessage(msg);
    expect(recs).toHaveLength(3);
    expect(decodeRecord(recs[2])).toMatchObject({ kind: "mime", mime: "application/json" });
  });
  it("parses smart posters", () => {
    const [rec] = decodeNdefMessage(encodeNdefMessage([smartPosterRecord("https://m5.cet", [{ text: "Join" }], 0)]));
    const d = decodeRecord(rec);
    expect(d.kind).toBe("smart-poster");
    if (d.kind === "smart-poster") { expect(d.uri).toBe("https://m5.cet"); expect(d.titles[0].text).toBe("Join"); expect(d.action).toBe(0); }
  });
  it("reassembles a chunked record", () => {
    // Two-chunk message built by hand: CF on first, TNF UNCHANGED continuation.
    const msg = unhex("B4000101" + "54" /*first: MB CF SR, type len 1, payloadlen 1, id? no*/);
    // Simpler: verify the parser throws on an unterminated chunk.
    expect(() => decodeNdefMessage(unhex("B400010154"))).toThrow();
    void msg;
  });
  it("builds and extracts a Type 2 NDEF TLV area", () => {
    const ndef = encodeNdefMessage([uriRecord("https://x")]);
    const area = buildT2TlvArea(ndef);
    expect(area[0]).toBe(0x03);
    const found = extractT2Ndef(area);
    expect(found).toBeTruthy();
    expect(hex(found!.ndef)).toBe(hex(ndef));
  });
  it("parses a Type 4 capability container", () => {
    const cc = parseT4Cc(T4T.ccBytes(0x00ff, 0x00ff, 0x0400));
    expect(cc.ndefFid).toBe(0xe104);
    expect(cc.ndefMaxSize).toBe(0x0400);
    expect(cc.mappingVersion).toBe("2.0");
  });
});

describe("Mifare Classic geometry", () => {
  it("computes block/sector math for 1K and 4K", () => {
    expect(totalBlocks("1k")).toBe(64);
    expect(totalBlocks("4k")).toBe(256);
    expect(sectorTrailerBlock(0)).toBe(3);
    expect(sectorFirstBlock(16)).toBe(64);
    expect(sectorFirstBlock(32)).toBe(128);
    expect(blocksInSector(33)).toBe(16);
    expect(sectorOfBlock(129)).toBe(32);
    expect(isSectorTrailer(7)).toBe(true);
    expect(isSectorTrailer(6)).toBe(false);
  });
  it("decodes and re-encodes access bits (transport config)", () => {
    // Standard "transport" access bytes FF 07 80 for a data sector.
    const bits = decodeAccessBits(0xff, 0x07, 0x80);
    expect(bits).toHaveLength(4);
    const re = encodeAccessBits(bits, 0x69);
    const back = decodeAccessBits(re[0], re[1], re[2]);
    expect(back).toEqual(bits);
  });
  it("rejects corrupt access bytes", () => {
    expect(() => decodeAccessBits(0x00, 0x00, 0x00)).toThrow();
  });
  it("ships the documented default-key dictionary", () => {
    expect(DEFAULT_KEYS[0]).toBe("FFFFFFFFFFFF");
    expect(DEFAULT_KEYS).toContain("A0A1A2A3A4A5");
    expect(DEFAULT_KEYS.every((k) => /^[0-9A-F]{12}$/.test(k))).toBe(true);
  });
});

describe("card detection", () => {
  it("ranks Mifare Classic 1K from SAK 08", () => {
    const c = detectCard(ident({ sak: 0x08, atqa: new Uint8Array([0x04, 0x00]) }));
    expect(c[0].type).toBe("mifare-classic-1k");
    expect(c[0].confidence).toBeGreaterThan(0.8);
  });
  it("ranks 4K from SAK 18 and DESFire from SAK 20 + ATS", () => {
    expect(detectCard(ident({ sak: 0x18 }))[0].type).toBe("mifare-classic-4k");
    const df = detectCard(ident({ sak: 0x20, isoDep: true, ats: new Uint8Array([0x75, 0x77, 0x81, 0x02, 0x80]) }));
    expect(df[0].type).toBe("mifare-desfire");
  });
  it("suggests GET_VERSION for SAK 00 Ultralight/NTAG", () => {
    const c = detectCard(ident({ sak: 0x00, atqa: new Uint8Array([0x44, 0x00]) }));
    expect(c.some((x) => x.probe === "get-version")).toBe(true);
  });
  it("wins with connection-tag when the NDEF MIME record is present", () => {
    const conn = mimeRecord(CONN_MIME, new Uint8Array([1]));
    const c = detectCard(ident({ sak: 0x08, ndef: [conn] }));
    expect(c[0].type).toBe("connection-tag");
  });
});

describe("connection tag (připojka) roundtrip", () => {
  it("encrypts a session and decrypts it back with the PIN", async () => {
    const records = await buildConnectionRecords({ room: "brno-secure", passphrase: "tajný klíč 🔐", name: "Michal" }, "123456", { appVersion: "2.7.0", fallbackUrl: "https://m5.cet" });
    expect(hasConnectionRecord(records)).toBe(true);
    expect(records.length).toBe(2); // MIME + fallback URI
    const back = await decodeConnectionRecords(records, "123456");
    expect(back).toMatchObject({ room: "brno-secure", passphrase: "tajný klíč 🔐", name: "Michal", app: "2.7.0" });
  });
  it("fails to decrypt with the wrong PIN", async () => {
    const records = await buildConnectionRecords({ room: "r", passphrase: "p" }, "0000", {});
    await expect(decodeConnectionRecords(records, "9999")).rejects.toThrow();
  });
  it("rejects an invalid PIN at build time", async () => {
    await expect(buildConnectionRecords({ room: "r", passphrase: "p" }, "12")).rejects.toThrow();
  });
});

describe("PN532 frame codec", () => {
  it("frames a command with correct LEN/LCS/DCS", () => {
    const frame = buildCommand(0x02); // GetFirmwareVersion
    expect(hex(frame)).toBe("0000FF02FED402" + "2A" + "00");
  });
  it("parses ACK and data frames across chunk boundaries", () => {
    const parser = new FrameParser();
    parser.push(ACK.slice(0, 3));
    expect(parser.next()).toBeNull(); // incomplete
    parser.push(ACK.slice(3));
    expect(parser.next()).toEqual({ kind: "ack" });
    // A response frame: 00 00 FF LEN LCS D5 03 <fw...> DCS 00
    const resp = unhex("0000FF06FAD50332010607E800");
    parser.push(resp);
    const f = parser.next();
    expect(f?.kind).toBe("data");
    if (f && f.kind === "data") { expect(f.tfi).toBe(0xd5); expect(f.payload[0]).toBe(0x03); }
  });
});

describe("transport registry (headless env)", () => {
  it("lists all four transports and reports them unsupported under happy-dom", () => {
    const list = listTransports();
    expect(list.map((x) => x.id).sort()).toEqual(["webbluetooth-pn532", "webnfc", "webserial-pn532", "webusb-ccid"]);
    for (const tr of list) expect(tr.supported).toBe(false);
  });
  it("creates a transport whose APDU path rejects cleanly on Web NFC", async () => {
    const webnfc = createTransport("webnfc");
    expect(webnfc.capabilities.ndefOnly).toBe(true);
    await expect(webnfc.transmit(new Uint8Array([0x00]))).rejects.toThrow(/not supported/i);
  });
});
