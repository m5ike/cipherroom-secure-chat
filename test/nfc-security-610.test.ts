// 6.10 security review items for the web NFC:
//   G-18  templates and raw APDUs only READ (one allowlist, apdu-templates.ts):
//         templateProblems refuses a write, the runner checks every APDU, the
//         m5.nfc executor's raw-apdu refuses one unless writes are allowed.
//   G-19  card numbers masked in every form — BCD (5A, 57, 9F6B) and ASCII
//         (Track 1: 56, 9F1F) — in the card report and in every view of a
//         template run (io / raw / json / readable) unless the holder asks.
//   G-17  what a model's NFC read found goes to it only with the holder's
//         consent — the prompt names it and the model; masked by default.

import { describe, it, expect, vi } from "vitest";
import { commandProblem, READ_ONLY_COMMANDS, readCommand, readOnlyRefusal, secureChannelCommand, STANDARD_APDU_TEMPLATES, templateProblems } from "../client/src/lib/nfc/apdu-templates";
import { runTemplate } from "../client/src/lib/nfc/template-runner";
import { readableText, runMasks, runPans, templateView } from "../client/src/lib/nfc/template-views";
import { maskAnswer, maskPans, maskPanDigits, maskValue, pansInHex, pansOfEmv } from "../client/src/lib/nfc/pan-mask";
import { cardReport } from "../client/src/lib/nfc/card-report";
import { consentPrompt, maskNfcResult, nfcConsent } from "../client/src/lib/nfc/consent";
import { createWebExecutor } from "../client/src/lib/nfc/web-executor";
import { sanitizeNfcResult } from "../server/functions/host-nfc";
import { concat, hex, u8, unhex } from "../client/src/lib/nfc/cards/apdu";
import type { CardTransport, CardIdentity } from "../client/src/lib/nfc/transport";
import type { NfcResult } from "../client/src/lib/nfc/command";
import { ascii, desfireCard, emvCard, T } from "./helpers/nfc-sims";
import { tf } from "../client/src/lib/i18n";
import { validatePayload } from "../client/src/lib/validate";

const PAN = "5413330089020011";
const TRACK1_PAN = "4111111111111111";
const asciiHex = (s: string) => hex(ascii(s));

/* ------------------------------------------------------------------ G-18 */

describe("G-18: read-only", () => {
  it("allows the reads, refuses everything else — and the e-ID channel only to the reader (the list Android has)", () => {
    for (const c of ["00A404000E325041592E5359532E444446303100", "00A4000C023F00", "00B0000000", "00B2010C00", "80CA9F3600", "80A8000002830000", "00C0000010", "80C0000010", "84CA9F3600", "0CB0000000", "9060000000", "90AF000000", "906A000000", "906E000000", "9045000000"]) expect(readOnlyRefusal(c), c).toBeNull();
    const refused: Array<[string, string]> = [
      ["0020008008", "not a read command: 00 20 (VERIFY)"], ["80AE800000", "not a read command: 80 AE (GENERATE AC)"], ["00D6000004DEADBEEF", "not a read command: 00 D6 (UPDATE BINARY)"],
      ["00DC010C04DEADBEEF", "not a read command: 00 DC (UPDATE RECORD)"], ["00DA9F4D02", "not a read command: 00 DA (PUT DATA)"], ["0088000008", "not a read command: 00 88 (INTERNAL AUTHENTICATE)"],
      ["00E2000004DEADBEEF", "not a read command: 00 E2 (APPEND RECORD)"], ["900A000001", "not a read command: 90 0A (Authenticate)"], ["90C4000000", "not a read command: 90 C4 (ChangeKey)"],
      ["FFCA000000", "not a read command: FF CA"], ["FFD6000004", "not a read command: FF D6 (UPDATE BINARY)"], ["0084000008", "not a read command: 00 84 (GET CHALLENGE)"],
      ["00B1000000", "not a read command: 00 B1 (READ BINARY (odd))"], ["00CB3FFF00", "not a read command: 00 CB"],
    ];
    for (const [c, why] of refused) { expect(readOnlyRefusal(c), c).toBe(why); expect(commandProblem(c)).toBe(why); }
    // The document's secure channel: only for the e-ID reader (the runner, inside eid-read).
    for (const c of ["0084000008", "0022C1A40F800A04007F00070202040202830101", "10860000027C0000", "0082000028", "0CB1000000"]) expect(readOnlyRefusal(c, { channel: true }), c).toBeNull();
    expect(readOnlyRefusal("0020008008", { channel: true })).toBe("not a read command: 00 20 (VERIFY)");
    expect(readCommand(0x80, 0xa8) && readCommand(0x8c, 0xca) && !readCommand(0x80, 0xae) && secureChannelCommand(0x10, 0x86) && !secureChannelCommand(0x80, 0x84)).toBe(true);
    expect(READ_ONLY_COMMANDS.desfire).toHaveProperty("60");
  });

  it("templateProblems refuses a template that writes, asks a PIN or makes a cryptogram — older command lines too", () => {
    expect(templateProblems({ label: "PIN", steps: [{ apdu: "00A4040007A000000004101000" }, { apdu: "0020008008241234FFFFFFFFFF" }] })).toEqual(["not a read command: 00 20 (VERIFY)"]);
    expect(templateProblems({ label: "challenge", steps: [{ apdu: "0084000008" }] })).toEqual(["not a read command: 00 84 (GET CHALLENGE)"]);
    expect(templateProblems({ label: "AC", apdu: "80A8000002830000\n80AE80001D0000000000000000000000000000000000000000000000000000000000" })[0]).toMatch(/GENERATE AC/);
    expect(templateProblems({ label: "write", steps: [{ op: "for-each-aid", steps: [{ apdu: "00DC010C04DEADBEEF" }] }] })[0]).toMatch(/UPDATE RECORD/);
    for (const t of STANDARD_APDU_TEMPLATES) expect(templateProblems(t)).toEqual([]);
  });

  it("the runner sends nothing of a template that writes", async () => {
    const { t, seen } = desfireCard();
    const run = await runTemplate(t, { label: "Format", steps: [{ apdu: "9060000000", expect: ["91AF"] }, { apdu: "90FC000000", label: "FormatPICC" }] });
    expect(run.ok).toBe(false);
    expect(run.problems).toEqual(["not a read command: 90 FC (FormatPICC)"]);
    expect(seen).toEqual([]);
  });

  it("m5.nfc raw-apdu: a read goes, a write is denied unless the platform allows writes", async () => {
    const transmit = vi.fn(async () => u8(0x90, 0x00));
    const id: CardIdentity = { uid: u8(1, 2, 3, 4), tech: "iso14443a", isoDep: true, hints: [] };
    const tr = { id: "webusb-ccid", label: "t", capabilities: { apdu: true, raw: false, mifareAuth: false, ndefOnly: false, emulate: false, write: false }, waitForCard: async () => id, transmit } as unknown as CardTransport;
    const exec = createWebExecutor({ getTransport: () => tr });
    expect((await exec({ op: "raw-apdu", tech: "iso-dep", args: { apdu: "00A4040007A000000004101000" } })).status).toBe("ok");
    const verify = await exec({ op: "raw-apdu", tech: "iso-dep", args: { apdu: "0020008008241234FFFFFFFFFF" } });
    expect(verify.status).toBe("denied");
    expect(verify.message).toMatch(/VERIFY/);
    expect(transmit).toHaveBeenCalledTimes(1);
    const writer = createWebExecutor({ getTransport: () => tr, allowWrites: true });
    expect((await writer({ op: "raw-apdu", tech: "iso-dep", args: { apdu: "00D6000004DEADBEEF" } })).status).toBe("ok");
    expect(transmit).toHaveBeenCalledTimes(2);
  });

  it("m5.nfc app-template runs a define's template through the runner (steps + transcript), and refuses a writing one", async () => {
    const { t } = desfireCard();
    const tr = Object.assign(t, { capabilities: { apdu: true }, waitForCard: async () => ({ uid: u8(4, 1, 2, 3, 4, 5, 6), sak: 0x20, tech: "iso14443a", isoDep: true, hints: [] }) }) as CardTransport;
    const exec = createWebExecutor({ getTransport: () => tr, templates: () => STANDARD_APDU_TEMPLATES });
    const ok = await exec({ op: "app-template", args: { label: "MIFARE DESFire — version, applications, free memory" } });
    expect(ok.status).toBe("ok");
    expect(ok.template).toMatchObject({ label: "MIFARE DESFire — version, applications, free memory", ok: true, problems: [], steps: 6 });
    expect(ok.transcript).toHaveLength(6);
    // The server keeps the added fields (public, bounded).
    const kept = sanitizeNfcResult(ok);
    expect(kept.template?.steps).toBe(6);
    expect(kept.transcript?.[0]).toMatchObject({ step: 1, command: "9060000000", sw: "91AF", status: "ok" });
    const bad = await exec({ op: "app-template", args: { template: { label: "w", steps: [{ apdu: "90FC000000" }] } } });
    expect(bad.status).toBe("denied");
    expect(bad.transcript).toEqual([]);
    expect((await exec({ op: "app-template", args: {} })).status).toBe("error");
  });
});

/* ------------------------------------------------------------------ G-19 */

/** A card with a Track 1 (56, ASCII) and a Track 2 (9F6B, BCD) in one record. */
function trackCard(): CardTransport {
  const rec = T(0x70, T(0x56, ascii(`B${TRACK1_PAN}^NOVAK/JAN^2512101000000000`)), T(0x9f6b, unhex(`${TRACK1_PAN}D2512101000000000F`)), T(0x9f1f, ascii("3030303030")));
  return { transmit: async (c: Uint8Array) => (c[1] === 0xb2 ? concat(rec, u8(0x90, 0)) : u8(0x90, 0)) } as unknown as CardTransport;
}

describe("G-19: card numbers masked in every form", () => {
  it("finds a PAN in 5A, Track 2 (57 / 9F6B) and Track 1 (56), and masks it as digits and as ASCII", () => {
    expect(pansInHex(hex(T(0x70, T(0x5a, unhex(PAN)))))).toEqual([PAN]);
    expect(pansInHex(hex(T(0x70, T(0x56, ascii(`B${TRACK1_PAN}^X/Y^25`)))))).toEqual([TRACK1_PAN]);
    const s = `5A08${PAN} 56..${asciiHex(`B${PAN}^`)} text ${PAN}`;
    const m = maskPans(s, [PAN]);
    expect(m).not.toContain(PAN);
    expect(m).not.toContain(asciiHex(PAN));
    expect(m).toContain(maskPanDigits(PAN));
    // ASCII hex: the kept digits' codes, X for the hidden ones (as Android).
    expect(m).toContain(`${asciiHex("541333")}${"X".repeat(12)}${asciiHex("0011")}`);
  });

  it("redacts the track data as Android does: 57 / 9F6B after the D, the rest of 56, all of 9F1F / 9F20", () => {
    expect(maskValue("5A", `${PAN}`)).toBe("541333XXXXXX0011");
    expect(maskValue("57", `${PAN}D2812201000000000F`)).toBe(`541333XXXXXX0011D${"X".repeat(17)}`);
    expect(maskValue("9F6B", "4111111111111111D25121010000000000F".slice(0, 34))).toMatch(/^411111XXXXXX1111DX+$/);
    const t1 = asciiHex(`B${TRACK1_PAN}^NOVAK/JAN^2512`);
    expect(maskValue("56", t1)).toBe(`${asciiHex("B411111")}${"X".repeat(12)}${asciiHex("1111")}${"X".repeat(t1.length - 2 - 32)}`);
    expect(maskValue("9F1F", "33303330")).toBe("XXXXXXXX");
    expect(maskValue("9F20", "1234")).toBe("XXXX");
    // An answer: TLV-aware, the same length, so the JSON of a transcript stays valid.
    const answer = hex(T(0x70, T(0x57, unhex(`${PAN}D2812201000000000F`)), T(0x5f24, unhex("281231"))));
    const masked = maskAnswer(answer, [PAN]);
    expect(masked.length).toBe(answer.length);
    expect(masked).toContain("5F2403281231"); // the rest is kept
    expect(masked).not.toContain(PAN);
  });

  it("the card report masks a Track 1 card number (its ASCII hex too)", () => {
    const t1 = asciiHex(`B${TRACK1_PAN}^NOVAK/JAN^2512`);
    const d = { aids: ["A0000000031010"], apps: [{ aid: "A0000000031010", tags: [{ tag: "56", name: "Track 1 data", value: t1, hex: t1 }], records: [{ sfi: 1, record: 1, hex: `7020${"56"}1E${t1}` }] }] };
    expect(pansOfEmv(d)).toEqual([TRACK1_PAN]);
    for (const f of ["text", "html", "json", "csv"] as const) {
      const v = String(cardReport({ status: "ok", emv: d }, f).value);
      expect(v, f).not.toContain(asciiHex(TRACK1_PAN));
      expect(v, f).not.toContain(TRACK1_PAN);
    }
  });

  it("a template run's io / raw / json / readable views mask the card number unless the holder asks", async () => {
    const run = await runTemplate(emvCard().t, STANDARD_APDU_TEMPLATES.find((x) => x.label === "Mastercard (credit / debit)")!);
    expect(runPans(run)).toEqual([PAN]);
    for (const v of ["io", "raw", "json", "readable"] as const) {
      expect(templateView(run, v, { lang: "en" }), v).not.toContain(PAN);
      if (v !== "readable") expect(templateView(run, v, { lang: "en", full: true }), v).toContain(PAN);
    }
    expect(templateView(run, "raw")).toContain(maskPanDigits(PAN));
    expect(readableText(run, "en", true)).toContain(PAN);
    // The run itself keeps the bytes as read (the holder's own screen can show them).
    expect(run.exchanges.some((e) => e.response.includes(PAN))).toBe(true);
  });

  it("Track 1 and Track 2 in a fixed command's answer: masked in the transcript and in the decoded report", async () => {
    const run = await runTemplate(trackCard(), { label: "Record", steps: [{ apdu: "00B2010C00" }] });
    expect(runPans(run)).toEqual([TRACK1_PAN]);
    expect(runMasks(run)).toBe(true);
    for (const v of ["io", "raw", "json", "readable"] as const) {
      const s = templateView(run, v, { lang: "en" });
      expect(s, v).not.toContain(TRACK1_PAN);
      expect(s, v).not.toContain(asciiHex(TRACK1_PAN));
      expect(s, v).not.toContain(asciiHex("NOVAK/JAN")); // the rest of Track 1
      expect(s, v).not.toContain(asciiHex("3030303030")); // 9F1F
    }
    expect(() => JSON.parse(templateView(run, "json"))).not.toThrow();
    expect(readableText(run, "en")).toContain("Card numbers and track data are masked.");
    expect(readableText(run, "en", true)).not.toContain("are masked");
  });

  it("only track data, no PAN: still masked, and said so", async () => {
    const rec = T(0x70, T(0x9f20, unhex("1234567890")));
    const card = { transmit: async () => concat(rec, u8(0x90, 0)) } as unknown as CardTransport;
    const run = await runTemplate(card, { label: "Disc", steps: [{ apdu: "00B2010C00" }] });
    expect(runPans(run)).toEqual([]);
    expect(runMasks(run)).toBe(true);
    expect(templateView(run, "raw")).toBe(`70089F2005${"X".repeat(10)} 9000`);
    expect(templateView(run, "raw", { full: true })).toBe("70089F20051234567890 9000");
  });
});

/* ------------------------------------------------------------------ G-17 */

const tr = (key: string, vars?: Record<string, string | number>) => tf("en", key, vars ?? {});

describe("G-17: a model gets a read only with the holder's consent — masked by default", () => {
  it("names what goes, and what 'everything' adds, and the model", async () => {
    const run = await runTemplate(emvCard().t, STANDARD_APDU_TEMPLATES.find((x) => x.label === "Mastercard (credit / debit)")!);
    const result: NfcResult = { status: "ok", emv: run.data.emv, transcript: run.exchanges, message: "Mastercard" };
    const c = nfcConsent(result);
    expect(c.sensitive).toBe(true);
    const p = consentPrompt(c, "Card reader (/card)", tr);
    expect(p.title).toBe("Send the card's data to the function?");
    expect(p.text).toContain("Card reader (/card) read a card on this device.");
    expect(p.text).toContain("Mastercard: card number 541333••••••0011, expires 2028-12");
    expect(p.text).toContain("the cardholder's name: NOVAK / JAN");
    expect(p.text).toContain("the transaction history (entries: 2)");
    expect(p.text).toContain("the APDU transcript (commands: ");
    expect(p.text).toContain("\"Send everything\" also sends:\n• the full card number and the track data (numbers: 1)");
    expect(p.text).not.toContain(PAN);
    expect(p.choices).toEqual(["Send (masked)", "Send everything", "Don't send"]);
    expect([p.pick("Send (masked)"), p.pick("Send everything"), p.pick("Don't send"), p.pick(null)]).toEqual(["masked", "full", null, null]);
  });

  it("the masked result carries no card number anywhere", async () => {
    const run = await runTemplate(emvCard().t, STANDARD_APDU_TEMPLATES.find((x) => x.label === "Mastercard (credit / debit)")!);
    const masked = maskNfcResult({ status: "ok", emv: run.data.emv, transcript: run.exchanges });
    const json = JSON.stringify(masked);
    expect(json).not.toContain(PAN);
    expect(masked.emv!.apps[0].pan).toBeUndefined();
    expect(masked.emv!.apps[0].panMasked).toBe("541333••••••0011");
    expect(masked.emv!.apps[0].atc).toBe(42);
    expect(masked.transcript).toHaveLength(run.exchanges.length);
  });

  it("an e-ID: no MRZ lines, no photo or files, the document number masked", () => {
    const result: NfcResult = {
      status: "ok", message: "ANNA MARIA ERIKSSON · L898902C · UTO · BAC",
      mrtd: { present: true, access: "bac", mrzInfo: { surname: "ERIKSSON", givenNames: "ANNA MARIA", documentNumber: "L898902C", nationality: "UTO", mrz: "P<UTO…", optionalData: "ZE184226B" }, photo: "AAAA", photoMime: "image/jpeg", images: [{ group: "DG2", kind: "face", mime: "image/jpeg", data: "AAAA", name: "face.jpg" }], raw: [{ name: "DG1.bin", mime: "application/octet-stream", data: "AAAA" }], personal: { address: "123 MAPLE STREET" } },
    };
    const c = nfcConsent(result);
    const p = consentPrompt(c, "", tr);
    expect(p.text).toContain("A function read a card on this device.");
    expect(p.text).toContain("the document holder ANNA MARIA ERIKSSON: nationality, dates of birth and expiry, document number •••••02C");
    expect(p.text).toContain("the photo and the document's pictures (1)");
    const m = maskNfcResult(result);
    const json = JSON.stringify(m);
    for (const secret of ["L898902C", "P<UTO", "ZE184226B", "AAAA", "MAPLE"]) expect(json, secret).not.toContain(secret);
    expect(m.mrtd!.mrzInfo).toMatchObject({ surname: "ERIKSSON", documentNumber: "•••••02C" });
  });

  it("a note to myself (kind \"note\", as on Android) is never accepted from the network", () => {
    const base = { id: "m1", senderId: "peer-1", senderName: "Eve", createdAt: Date.now(), text: "a note" };
    expect(validatePayload({ ...base })).not.toBeNull();
    expect(validatePayload({ ...base, kind: "note" })).toBeNull();
  });

  it("a plain scan (no card data) needs no question", () => {
    expect(nfcConsent({ status: "ok", card: { uid: "04A1B2C3", tech: "ntag21x", label: "NTAG" } }).sensitive).toBe(false);
    expect(nfcConsent({ status: "ok", data: btoa(String.fromCharCode(...unhex(`70125A08${PAN}5F24032812319000`))) }).full[0].key).toBe("nfc.consent.dataPan");
  });
});
