// @vitest-environment node
//
// The APDU template runner (6.10): every standard template of
// m5mobile.define.apduTemplates runs end to end against a simulated card of
// its type (test/helpers/nfc-sims.ts — the same cards the EMV / e-ID readers'
// own tests read), every APDU the card saw is in the transcript, optional
// steps are tolerated, for-each-aid walks the directory (or the well-known
// AIDs), older entries still run — and the four views of a run.

import { describe, it, expect } from "vitest";
import { STANDARD_APDU_TEMPLATES, templateProblems, type ApduTemplate } from "../client/src/lib/nfc/apdu-templates";
import { runTemplate, describeCommand, swMatches, type TemplateRun } from "../client/src/lib/nfc/template-runner";
import { explainSw, ioView, jsonView, rawView, readableHtml, readableText, runFileName, templateView } from "../client/src/lib/nfc/template-views";
import { u8, unhex } from "../client/src/lib/nfc/cards/apdu";
import type { CardTransport } from "../client/src/lib/nfc/transport";
import { bacChip, desfireCard, emvCard, EMV_AID, isoCard, KEY, MRTD_FILES, MRZ, VISA_AID } from "./helpers/nfc-sims";

const std = (label: string): ApduTemplate => {
  const t = STANDARD_APDU_TEMPLATES.find((x) => x.label === label);
  if (!t) throw new Error(`no standard template "${label}"`);
  return t;
};
const commands = (r: TemplateRun) => r.exchanges.map((e) => e.command);

describe("the standard set", () => {
  it("every template is well formed", () => {
    for (const t of STANDARD_APDU_TEMPLATES) expect(templateProblems(t), t.label).toEqual([]);
  });

  it("every EMV scheme template reads its application end to end — or stops cleanly when the card does not have it", async () => {
    for (const t of STANDARD_APDU_TEMPLATES.filter((x) => x.card === "emv" && x.aid)) {
      const { t: card, seen } = emvCard({ visa: true });
      const run = await runTemplate(card, t);
      // Every APDU the card saw is in the transcript, in order.
      expect(commands(run), t.label).toEqual(seen);
      if (t.aid === EMV_AID || t.aid === VISA_AID) {
        expect(run.ok, `${t.label}: ${run.problems.join("; ")}`).toBe(true);
        expect(run.data.emv?.apps.map((a) => a.aid)).toEqual([t.aid]);
        expect(run.data.emv?.aids).toEqual([EMV_AID, VISA_AID]); // the directory, as listed
        // Each stage ran: SELECT, GET DATA, GPO, READ RECORD.
        expect(run.exchanges.map((e) => e.op)).toEqual(expect.arrayContaining(["select-ppse", "select-aid", "get-data", "gpo", "read-afl", "read-files"]));
      } else {
        expect(run.ok).toBe(false);
        expect(run.problems).toHaveLength(1);
        expect(run.problems[0]).toMatch(/6A82 .* is not on this card/);
        // It stopped at the SELECT: no GET PROCESSING OPTIONS was sent.
        expect(seen.some((c) => c.startsWith("80A8"))).toBe(false);
        expect(run.exchanges.at(-1)?.status).toBe("error");
      }
    }
  });

  it("Mastercard: counters, history, records and the deep files, as the 6.6 reader reads them", async () => {
    const run = await runTemplate(emvCard().t, std("Mastercard (credit / debit)"));
    expect(run.ok).toBe(true);
    const app = run.data.emv!.apps[0];
    expect(app.pan).toBe("5413330089020011");
    expect(app.atc).toBe(42);
    expect(app.pinTryCounter).toBe(3);
    expect(app.log).toHaveLength(2);
    expect(app.log![0]).toMatchObject({ amount: "123.45", merchant: "BILLA" });
    expect(app.records!.map((r) => `${r.sfi}:${r.record}${r.log ? "L" : ""}`)).toEqual(["1:1", "2:1", "3:1", "3:2", "11:1L", "11:2L", "11:3L"]);
    expect(run.data.emv!.deep).toBe(true);
    expect(run.data.emv!.apdus).toBe(run.exchanges.length);
    // Missing GET DATA tags are not errors (6A88 is a warning on its exchange, no problem).
    expect(run.exchanges.some((e) => e.op === "get-data" && e.sw === "6A88" && e.status === "warn")).toBe(true);
  });

  it("every application (PPSE → for-each-aid): both applications, each completely", async () => {
    const { t, seen } = emvCard({ visa: true });
    const run = await runTemplate(t, std("Payment card (EMV) — every application"));
    expect(run.ok, run.problems.join("; ")).toBe(true);
    expect(commands(run)).toEqual(seen);
    expect(run.data.emv!.apps.map((a) => [a.scheme, a.panMasked])).toEqual([["Mastercard", "541333••••••0011"], ["Visa", "411111••••••1111"]]);
    // The loop's steps are labelled with their application.
    expect(run.exchanges.some((e) => e.label === `${VISA_AID} · GET PROCESSING OPTIONS (no transaction)`)).toBe(true);
    // 1 + 6 steps for each application — Visa keeps no log, so its read-log has nothing to send.
    expect(new Set(run.exchanges.map((e) => e.step)).size).toBe(1 + 6 + 5);
    expect(run.exchanges.filter((e) => e.op === "read-log" && e.label.startsWith(VISA_AID))).toEqual([]);
  });

  it("every application over the contact directory (PSE → its records → for-each-aid)", async () => {
    const { t, seen } = emvCard({ visa: true, pse: true });
    const run = await runTemplate(t, std("Payment card (EMV, contact / PSE) — every application"));
    expect(run.ok, run.problems.join("; ")).toBe(true);
    expect(commands(run)).toEqual(seen);
    expect(seen.slice(0, 3)).toEqual(["00A404000E315041592E5359532E444446303100", "00B2010C00", "00B2020C00"]);
    expect(run.data.emv!.aids).toEqual([EMV_AID, VISA_AID]);
    expect(run.data.emv!.apps).toHaveLength(2);
  });

  it("e-ID (everything): the key is asked, and every APDU — protected ones included — is recorded with what it read", async () => {
    const chip = bacChip(KEY, MRTD_FILES());
    let asked: unknown = null;
    const run = await runTemplate(chip.transport, std("e-ID / e-passport (PACE or BAC) — everything"), { askEidKey: async (a) => { asked = a; return { mrz: MRZ }; } });
    expect(run.ok, run.problems.join("; ")).toBe(true);
    expect(asked).toEqual({ readPhoto: true, all: true });
    expect(commands(run)).toEqual(chip.log);
    expect(run.data.mrtd?.access).toBe("bac");
    expect(run.data.mrtd?.mrzInfo?.surname).toBe("ERIKSSON");
    expect(run.data.mrtd?.images?.length).toBe(2);
    // After BAC everything is under secure messaging (CLA 0C) — recorded as sent, labelled by phase.
    const afterBac = run.exchanges.filter((e) => /EF\.COM|DG1/.test(e.label));
    expect(afterBac.length).toBeGreaterThan(2);
    expect(afterBac.every((e) => e.command.startsWith("0C"))).toBe(true);
    expect(run.exchanges.some((e) => e.label.endsWith("· BAC (MRZ)") && e.command.startsWith("0084"))).toBe(true);
    expect(describeCommand(afterBac[0].command)).toMatch(/secure messaging/);
  });

  it("e-ID (MRZ data only): EF.COM and DG1, no EF.SOD, no photo", async () => {
    const chip = bacChip(KEY, MRTD_FILES());
    const run = await runTemplate(chip.transport, std("e-ID / e-passport — MRZ data only (fast)"), { askEidKey: async () => ({ key: KEY }) });
    expect(run.ok).toBe(true);
    expect(run.data.mrtd?.images).toBeUndefined();
    expect(chip.selects).toEqual([0x011c, 0x011e, 0x0101]);
    expect(commands(run)).toEqual(chip.log);
  });

  it("e-ID without a key: the step fails and nothing is read", async () => {
    const chip = bacChip(KEY, MRTD_FILES());
    const run = await runTemplate(chip.transport, std("e-ID / e-passport — MRZ data only (fast)"), { askEidKey: async () => null });
    expect(run.ok).toBe(false);
    expect(run.problems[0]).toMatch(/MRZ or the CAN/);
    expect(run.exchanges).toEqual([]);
  });

  it("MIFARE DESFire: GetVersion's three frames and the card facts, decoded", async () => {
    const { t, seen } = desfireCard();
    const run = await runTemplate(t, std("MIFARE DESFire — version, applications, free memory"));
    expect(run.ok, run.problems.join("; ")).toBe(true);
    expect(commands(run)).toEqual(seen);
    expect(run.exchanges.map((e) => e.sw)).toEqual(["91AF", "91AF", "9100", "9100", "9100", "9100"]);
    const d = run.data.generic.desfire!;
    expect(d.hardware).toMatchObject({ vendor: "NXP Semiconductors", type: "MIFARE DESFire", version: "1.0 (EV1)", storage: "8 KB", storageBytes: 8192, protocol: "ISO 14443-2 and -3" });
    expect(d.software?.version).toBe("1.1 (EV1)");
    expect(d.uid).toBe("04A1B2C3D4E5F6");
    expect(d.batch).toBe("BA7C4E5F60");
    expect([d.week, d.year]).toEqual([23, 2019]);
    expect(d.applications).toEqual(["000001", "123456"]);
    expect(d.freeMemory).toBe(4800);
    expect(d.keySettings).toMatchObject({ masterKeyChangeable: true, freeDirectoryList: true, freeCreateDelete: true, configurationChangeable: true, maxKeys: 1, crypto: "DES / 2K3DES" });
  });

  it("ISO 7816: 61xx is followed by GET RESPONSE, 6Cxx is sent again — every APDU of the dance recorded; optional misses tolerated", async () => {
    const { t, seen } = isoCard();
    const run = await runTemplate(t, std("Smart card (ISO 7816-4) — master file, EF.DIR, EF.ATR"));
    expect(run.ok, run.problems.join("; ")).toBe(true);
    expect(commands(run)).toEqual(seen);
    // READ RECORD 2: 61xx → GET RESPONSE.
    const i = run.exchanges.findIndex((e) => e.sw.startsWith("61"));
    expect(run.exchanges[i + 1].command).toBe(`00C00000${run.exchanges[i].sw.slice(2)}`);
    expect(run.exchanges[i].step).toBe(run.exchanges[i + 1].step);
    // READ BINARY: 6C0A → the same command with Le 0A.
    const j = run.exchanges.findIndex((e) => e.sw === "6C0A");
    expect(run.exchanges[j + 1].command).toBe("00B000000A");
    // Records 3 and 4 do not exist: warnings, not problems.
    expect(run.exchanges.filter((e) => e.sw === "6A83").map((e) => e.status)).toEqual(["warn", "warn"]);
    expect(run.data.generic.items.map((x) => x.status)).toEqual(["ok", "ok", "ok", "ok", "warn", "warn", "ok", "ok"]);
  });

  it("an optional step the card refuses is a warning; the run goes on", async () => {
    const { t } = isoCard({ atr: false });
    const run = await runTemplate(t, std("Smart card (ISO 7816-4) — master file, EF.DIR, EF.ATR"));
    expect(run.ok).toBe(true);
    expect(run.exchanges.at(-1)?.status).toBe("warn");
  });
});

describe("for-each-aid, failures, cancel, older entries", () => {
  it("no directory: the well-known AIDs that select are read", async () => {
    const { t, seen } = emvCard({ ppse: false });
    const run = await runTemplate(t, std("Payment card (EMV) — every application"));
    expect(run.ok, run.problems.join("; ")).toBe(true);
    expect(commands(run)).toEqual(seen);
    expect(run.exchanges[0]).toMatchObject({ op: "select-ppse", sw: "6A82", status: "warn" });
    expect(run.data.emv!.apps.map((a) => a.aid)).toEqual([EMV_AID]);
    expect(run.exchanges.some((e) => /find applications/.test(e.label))).toBe(true);
  });

  it("the template's own AIDs, when it lists them", async () => {
    const tpl: ApduTemplate = { label: "Two AIDs", steps: [{ op: "for-each-aid", aids: [VISA_AID, EMV_AID], steps: [{ op: "select-aid" }, { op: "gpo" }, { op: "read-afl" }] }] };
    const run = await runTemplate(emvCard({ ppse: false, visa: true }).t, tpl);
    expect(run.ok).toBe(true);
    expect(run.data.emv!.apps.map((a) => a.aid)).toEqual([VISA_AID, EMV_AID]);
  });

  it("a refused GET PROCESSING OPTIONS is an error, but the files are still read", async () => {
    const run = await runTemplate(emvCard({ refuseGpo: true }).t, std("Mastercard (credit / debit)"));
    expect(run.ok).toBe(false);
    expect(run.problems).toEqual([expect.stringMatching(/GET PROCESSING OPTIONS \(no transaction\): 6985/)]);
    expect(run.data.emv!.apps[0].records!.some((r) => r.sfi === 1)).toBe(true); // read-files found them
  });

  it("a required fixed command that fails ends the run", async () => {
    const tpl: ApduTemplate = { label: "Stop", steps: [{ apdu: "00A4000C023F00" }, { apdu: "00A4020C02DEAD", label: "the missing file" }, { apdu: "00B0000000" }] };
    const { t, seen } = isoCard();
    const run = await runTemplate(t, tpl);
    expect(run.ok).toBe(false);
    expect(run.problems).toEqual(["the missing file: 6A82 File or application not found (expected 9000)"]);
    expect(seen).toHaveLength(2);
  });

  it("expect: the status words that count as success (xx = any byte)", () => {
    expect(swMatches("91AF", ["91AF"])).toBe(true);
    expect(swMatches("6283", ["62xx"])).toBe(true);
    expect(swMatches("9000", ["91xx"])).toBe(false);
  });

  it("cancel stops between two APDUs", async () => {
    const ac = new AbortController();
    // Cancelled as step 3 (GET DATA) starts: it sends nothing.
    const run = await runTemplate(emvCard().t, std("Mastercard (credit / debit)"), { signal: ac.signal, onStep: (p) => { if (p.step === 3) ac.abort(); } });
    expect(run.cancelled).toBe(true);
    expect(run.ok).toBe(false);
    expect(run.problems).toEqual(["cancelled"]);
    expect(run.exchanges.map((e) => e.op)).toEqual(["select-ppse", "select-aid"]);
  });

  it("reports progress as step n of m", async () => {
    const seen: string[] = [];
    await runTemplate(desfireCard().t, std("MIFARE DESFire — version, applications, free memory"), { onStep: (p) => seen.push(`${p.step}/${p.total} ${p.label}`) });
    expect(seen[0]).toBe("1/6 GetVersion — hardware");
    expect(seen.at(-1)).toBe("6/6 GetKeySettings (PICC)");
  });

  it("older entries: an op template (favouring its AID), command lines, an e-ID op", async () => {
    const legacy = await runTemplate(emvCard({ visa: true }).t, { label: "Scan / Read EMV — Visa", op: "emv-read", aid: VISA_AID });
    expect(legacy.ok).toBe(true);
    expect(legacy.data.emv!.apps[0].aid).toBe(VISA_AID);
    expect(legacy.exchanges.every((e) => e.op === "emv-read")).toBe(true);

    const { t, seen } = isoCard();
    const lines = await runTemplate(t, { label: "Two commands", apdu: "00a4000c023f00\n00 A4 02 0C 02 2F 00" });
    expect(lines.ok).toBe(true);
    expect(seen).toEqual(["00A4000C023F00", "00A4020C022F00"]);

    const chip = bacChip(KEY, MRTD_FILES());
    const eid = await runTemplate(chip.transport, { label: "Scan / Read e-passport — no photo", op: "eid-read", args: { readPhoto: false } }, { askEidKey: async () => ({ mrz: MRZ }) });
    expect(eid.ok).toBe(true);
    expect(eid.data.mrtd?.images).toBeUndefined();
  });

  it("refuses a template with problems, and a reader without APDUs", async () => {
    const bad = await runTemplate(isoCard().t, { label: "", steps: [{ op: "select-aid", aid: "XYZ" }] });
    expect(bad.problems).toEqual(["no label", "bad AID XYZ"]);
    expect(bad.exchanges).toEqual([]);
    const noApdu = await runTemplate({ capabilities: { apdu: false }, transmit: async () => u8(0x90, 0) } as unknown as CardTransport, std("Visa (credit / debit)"));
    expect(noApdu.problems[0]).toMatch(/no APDU channel/);
  });
});

describe("templateProblems", () => {
  it("says what is wrong with a template", () => {
    expect(templateProblems(null)).toEqual(["not an object"]);
    expect(templateProblems({ label: "x" })).toEqual(["nothing to run: no steps, op or apdu"]);
    expect(templateProblems({ label: "x", steps: [{ apdu: "00A4" }] })).toEqual(["bad command 00A4"]);
    expect(templateProblems({ label: "x", steps: [{ op: "get-data", tags: ["9F3"] }] })).toEqual(["get-data needs 2-byte tags"]);
    const deep = { op: "for-each-aid", steps: [{ op: "for-each-aid", steps: [{ op: "for-each-aid", steps: [{ op: "for-each-aid", steps: [] }] }] }] };
    expect(templateProblems({ label: "x", steps: [deep] })).toEqual(["for-each-aid nested too deep"]);
    expect(templateProblems({ label: "x", apdu: "00A404000E325041592E5359532E444446303100" })).toEqual([]);
  });
});

/* ------------------------------------------------------------------ views */

/** A two-command card: SELECT answers an FCI, READ RECORD "record not found". */
function tinyCard(): CardTransport {
  return { transmit: async (c: Uint8Array) => (c[1] === 0xa4 ? unhex("6F098407A00000000410109000") : unhex("6A83")) } as unknown as CardTransport;
}
async function tinyRun(): Promise<TemplateRun> {
  let tick = 0;
  return runTemplate(tinyCard(), { label: "Tiny", steps: [{ apdu: "00A4040007A000000004101000", label: "Select MC" }, { apdu: "00B2010C00", label: "Record", optional: true }] }, { now: () => tick++ });
}

describe("the four views", () => {
  it("io: every command and its response (the same text as Android's TemplateViews)", async () => {
    expect(ioView((await tinyRun()).exchanges)).toBe([
      "→ 00A4040007A000000004101000",
      "← 6F098407A0000000041010 9000 (OK)",
      "→ 00B2010C00",
      "← 6A83 (Record not found)",
    ].join("\n"));
  });

  it("a command the card did not answer: recorded, and shown as (no answer)", async () => {
    const dead = { transmit: async () => { throw new Error("tag was lost"); } } as unknown as CardTransport;
    const run = await runTemplate(dead, { label: "Lost", steps: [{ apdu: "00A4000C023F00" }] });
    expect(run.ok).toBe(false);
    expect(run.exchanges).toEqual([expect.objectContaining({ command: "00A4000C023F00", response: "", sw: "", status: "error" })]);
    expect(ioView(run.exchanges)).toBe("→ 00A4000C023F00\n← (no answer)");
    expect(rawView(run.exchanges)).toBe("(no answer)");
    expect(run.problems[0]).toMatch(/tag was lost/);
  });

  it("raw: the responses only", async () => {
    expect(rawView((await tinyRun()).exchanges)).toBe("6F098407A0000000041010 9000\n6A83");
  });

  it("json: the commands and responses", async () => {
    const run = await tinyRun();
    const expected = [
      { step: 1, label: "Select MC", op: "", command: "00A4040007A000000004101000", response: "6F098407A0000000041010", sw: "9000", status: "ok", ms: 1 },
      { step: 2, label: "Record", op: "", command: "00B2010C00", response: "", sw: "6A83", status: "warn", ms: 1 },
    ];
    expect(jsonView(run.exchanges)).toBe(JSON.stringify(expected, null, 2));
    expect(templateView(run, "json")).toBe(jsonView(run.exchanges));
    expect(runFileName(run, "json")).toMatch(/^nfc-tiny-\d{8}-\d{4}\.json$/);
  });

  it("readable: the card report for a payment card (the number masked)", async () => {
    const run = await runTemplate(emvCard().t, std("Mastercard (credit / debit)"));
    const text = readableText(run, "en");
    expect(text).toContain("Mastercard (credit / debit)");
    expect(text).toContain("✓ Read completely");
    expect(text).toContain("541333••••••0011");
    expect(text).not.toContain("5413330089020011");
    expect(text).toContain("BILLA");
    const html = readableHtml(run, "cs");
    expect(html).toContain("m5h-report");
    expect(html).toContain("Historie transakcí");
    expect(html).not.toContain("<script");
  });

  it("readable: the e-ID holder", async () => {
    const run = await runTemplate(bacChip(KEY, MRTD_FILES()).transport, std("e-ID / e-passport — MRZ data only (fast)"), { askEidKey: async () => ({ mrz: MRZ }) });
    expect(readableText(run, "en")).toMatch(/ERIKSSON/);
  });

  it("readable: a DESFire decoded, an ISO 7816 card's records as named TLV, every status word explained", async () => {
    const df = readableText(await runTemplate(desfireCard().t, std("MIFARE DESFire — version, applications, free memory")), "en");
    expect(df).toContain("NXP Semiconductors");
    expect(df).toContain("1.0 (EV1)");
    expect(df).toContain("8 KB");
    expect(df).toContain("2019, week 23");
    expect(df).toContain("000001, 123456");
    expect(df).toContain("91 AF — DESFire status af (ADDITIONAL_FRAME)");
    const iso = readableText(await runTemplate(isoCard().t, std("Smart card (ISO 7816-4) — master file, EF.DIR, EF.ATR")), "de");
    expect(iso).toContain("61 Application template");
    expect(iso).toContain("50 Application label: ePassport");
    expect(iso).toContain("6A 83 — Record not found");
    expect(iso).toContain("Befehle und Antworten");
  });

  it("explains status words — describeSw, as Android's StatusWords (ISO 7816-4 and DESFire)", () => {
    expect(explainSw("9000")).toBe("OK");
    expect(explainSw("6982")).toBe("Security status not satisfied");
    expect(explainSw("91AE")).toBe("DESFire status ae (AUTHENTICATION_ERROR)");
    expect(explainSw("919D")).toBe("DESFire status 9d (PERMISSION_DENIED)");
    expect(explainSw("")).toBe("no answer");
  });
});
