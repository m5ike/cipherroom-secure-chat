// @vitest-environment node
//
// Card reports (6.6): an EMV / e-ID / plain card read formatted as html,
// object, array, json, text and csv — pictures shown, everything else offered
// as files, the PAN masked unless asked, and card text always escaped.

import { describe, it, expect } from "vitest";
import { cardHistory, cardImages, cardReport, cardReportDocument, CARD_REPORT_FORMATS, type CardRow } from "../client/src/lib/nfc/card-report";
import type { EmvData, MrtdData, NfcResult } from "../client/src/lib/nfc/command";

const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]).toString("base64");
const JP2_B64 = Buffer.from([0, 0, 0, 0x0c, 0x6a, 0x50, 0x20, 0x20]).toString("base64");
const fromB64 = (s: string) => Buffer.from(s, "base64").toString("utf8");

const EMV: EmvData = {
  scheme: "Mastercard", aids: ["A0000000041010"], deep: true, apdus: 57,
  apps: [{
    aid: "A0000000041010", label: "MASTERCARD", scheme: "Mastercard", pan: "5413330089020011", panMasked: "541333••••••0011", expiry: "2028-12",
    cardholder: "<script>alert(1)</script>", issuerCountry: "Czechia", atc: 42, lastOnlineAtc: 40, pinTryCounter: 3, aip: "1980", afl: "08010100", logSfi: 11, logFormat: "9A03",
    log: [{ date: "2025-09-14", time: "18:30:05", amount: "123.45", currency: "CZK", merchant: "BILLA & CO", type: "purchase", atc: "41", raw: "250914" }, { date: "2025-09-12", amount: "9.90", currency: "CZK", merchant: "DPP", raw: "250912" }],
    tags: [{ tag: "5A", name: "Application PAN", value: "5413330089020011", hex: "5413330089020011" }, { tag: "50", name: "Application label", value: "MASTERCARD", hex: "4D415354455243415244" }],
    getData: [{ tag: "9F36", name: "Application transaction counter (ATC)", value: "42", hex: "002A" }],
    records: [{ sfi: 1, record: 1, hex: "70125A085413330089020011" }, { sfi: 11, record: 1, hex: "250914", log: true }],
  }],
};
const EMV_RESULT: NfcResult = { status: "ok", card: { uid: "08A1B2C3", tech: "emv", label: "EMV payment card" }, emv: EMV };

const MRTD: MrtdData = {
  present: true, access: "pace", pace: { supported: true, protocol: "PACE ECDH-GM AES-128", parameterId: 13, used: true, password: "can" },
  dataGroups: ["DG1", "DG2", "DG7", "DG11"], ldsVersion: "1.7",
  mrzInfo: { documentCode: "ID", documentNumber: "L898902C", issuer: "UTO", nationality: "UTO", surname: "ERIKSSON", givenNames: "ANNA MARIA", dateOfBirth: "1969-08-06", sex: "F", dateOfExpiry: "2031-06-23", mrz: "I<UTOL898902C<3<<<<<<<<<<<<<<<6908061F3106236UTO<<<<<<<<<<<0ERIKSSON<<ANNA<MARIA<<<<<<<<<<" },
  personal: { fullName: "ERIKSSON, ANNA MARIA", placeOfBirth: "ZENITH" },
  images: [{ group: "DG2", kind: "face", mime: "image/jpeg", data: JPEG_B64, name: "face.jpg" }, { group: "DG7", kind: "signature", mime: "image/jp2", data: JP2_B64, name: "signature.jp2" }],
  files: [{ name: "DG1", fid: "0101", status: "read", size: 93, hashOk: true }, { name: "DG3", fid: "0103", status: "protected" }],
  raw: [{ name: "EF.SOD.bin", mime: "application/octet-stream", data: "AAEC" }],
  security: { passive: "ok", hashAlgorithm: "SHA-256", signer: { subject: "C=UT, CN=DS", issuer: "C=UT, CN=CSCA", notBefore: "2024-01-01", notAfter: "2034-01-01" }, protocols: ["PACE ECDH-GM AES-128"] },
};

describe("EMV reports", () => {
  it("formats every field as HTML for the chat — PAN masked, card text escaped", () => {
    const r = cardReport(EMV_RESULT, "html");
    expect(r.kind).toBe("emv");
    expect(r.mime).toBe("text/html");
    const html = r.value as string;
    expect(html).toContain('class="m5h-report m5h-report--emv"');
    expect(html).toContain("541333••••••0011");
    expect(html).not.toContain("5413330089020011");
    expect(html).toContain("541333XXXXXX0011"); // inside the records' hex too
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("BILLA &amp; CO");
    expect(html).toMatch(/Transaction history — MASTERCARD \(2\)/);
    expect(html).toContain("<details");
    expect(r.title).toBe("Mastercard · 541333••••••0011");
    // The files: the history as CSV and the records as text.
    expect(r.files.map((f) => f.name)).toEqual(["emv-history.csv", "emv-records.txt"]);
    const histCsv = fromB64(r.files[0].data);
    expect(histCsv.split("\r\n")[0]).toBe("application,date,time,amount,currency,merchant,type,country,atc,result,raw");
    expect(histCsv).toContain("MASTERCARD,2025-09-14,18:30:05,123.45,CZK,BILLA & CO,purchase,,41,,250914");
    expect(fromB64(r.files[1].data)).not.toContain("5413330089020011");
  });

  it("shows the whole number when asked", () => {
    const html = cardReport(EMV_RESULT, "html", { fullPan: true }).value as string;
    expect(html).toContain("5413330089020011");
  });

  it("gives an object, rows, JSON, text and CSV", () => {
    const obj = cardReport(EMV_RESULT, "object").value as Record<string, any>;
    expect(obj.type).toBe("emv");
    expect(obj.applications[0].history).toHaveLength(2);
    expect(obj.applications[0].pan).toBe("541333••••••0011");
    expect(obj.card.uid).toBe("08A1B2C3");
    const rows = cardReport(EMV_RESULT, "array").value as CardRow[];
    expect(rows).toContainEqual({ section: "Application — MASTERCARD", field: "Transactions (ATC)", value: "42" });
    expect(rows.some((r) => r.section.startsWith("Transaction history") && r.value.includes("123.45"))).toBe(true);
    const json = JSON.parse(cardReport(EMV_RESULT, "json").value as string);
    expect(json.applications[0].label).toBe("MASTERCARD");
    const text = cardReport(EMV_RESULT, "text").value as string;
    expect(text.split("\n")[0]).toBe("Mastercard · 541333••••••0011");
    expect(text).toMatch(/Date\s+Time\s+Amount/);
    const csv = cardReport(EMV_RESULT, "csv").value as string;
    expect(csv.startsWith("section,field,value\r\n")).toBe(true);
    expect(csv).toContain("123.45 · CZK · BILLA & CO");
  });

  it("knows the formats, and takes a bare EmvData too", () => {
    expect(CARD_REPORT_FORMATS).toEqual(["html", "object", "array", "json", "text", "csv"]);
    expect(cardReport(EMV, "text").kind).toBe("emv");
    expect(cardReport(EMV, "bogus" as never).format).toBe("html");
    expect(cardHistory(EMV_RESULT).map((h) => [h.application, h.amount])).toEqual([["MASTERCARD", "123.45"], ["MASTERCARD", "9.90"]]);
  });

  it("speaks Czech", () => {
    const html = cardReport(EMV_RESULT, "html", { lang: "cs" }).value as string;
    expect(html).toContain("Historie transakcí");
    expect(html).toContain("Číslo karty");
  });
});

describe("e-ID reports", () => {
  it("shows the face inline and offers JPEG 2000 and the security objects as files", () => {
    const r = cardReport({ status: "ok", mrtd: MRTD }, "html");
    expect(r.kind).toBe("mrtd");
    expect(r.title).toBe("ID card · ANNA MARIA ERIKSSON");
    const html = r.value as string;
    expect(html).toContain(`<img src="data:image/jpeg;base64,${JPEG_B64}"`);
    expect(html).not.toContain("data:image/jp2");
    expect(html).toContain("JPEG 2000");
    expect(html).toContain("m5h-badge--ok");
    expect(html).toContain("PACE (CAN)");
    expect(html).toContain("ERIKSSON, ANNA MARIA");
    expect(r.images.map((i) => i.name)).toEqual(["face.jpg"]);
    expect(r.files.map((f) => f.name)).toEqual(["signature.jp2", "EF.SOD.bin"]);
    expect(cardImages({ mrtd: MRTD }).map((i) => i.mime)).toEqual(["image/jpeg", "image/jp2"]);
  });

  it("leaves pictures and files out when asked", () => {
    const r = cardReport(MRTD, "html", { images: false, attachments: false });
    expect(r.images).toEqual([]);
    expect(r.files).toEqual([]);
    expect(r.value as string).not.toContain("<img");
  });

  it("formats the document as text and rows", () => {
    const text = cardReport(MRTD, "text").value as string;
    expect(text).toContain("Document number");
    expect(text).toContain("L898902C");
    const rows = cardReport(MRTD, "array").value as CardRow[];
    expect(rows).toContainEqual({ section: "Holder", field: "Surname", value: "ERIKSSON" });
    expect(rows.find((r) => r.field === "Passive authentication")?.value).toMatch(/^✓/);
  });

  it("writes a standalone HTML document", () => {
    const doc = cardReportDocument({ mrtd: MRTD });
    expect(doc.startsWith("<!doctype html>")).toBe(true);
    expect(doc).toContain("<style>");
    expect(doc).toContain("m5h-report--mrtd");
  });
});

describe("other cards", () => {
  it("reports a plain scan", () => {
    const r = cardReport({ status: "ok", card: { uid: "04A1B2C3D4", tech: "ntag21x", label: "NTAG21x" }, ndef: [{ kind: "uri", data: "https://example.com/?a=1&b=<2>" }], data: "AQID" }, "html");
    expect(r.kind).toBe("card");
    expect(r.title).toBe("NTAG21x · 04A1B2C3D4");
    expect(r.value as string).toContain("https://example.com/?a=1&amp;b=&lt;2&gt;");
    expect(r.files.map((f) => f.name)).toEqual(["card-data.bin"]);
  });
});
