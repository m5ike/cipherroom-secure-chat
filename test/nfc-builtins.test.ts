// The NFC command packages (6.3; 6.6 adds /emv, /emv-history and /eid, built
// from the Builder's NFC.EMV / NFC.e-ID tools): each flow compiles to exactly
// the file that runs, the models install switched off, and they work end to
// end against a mocked device — /eid reads at once without a key (the
// caller's device asks the holder for the CAN / MRZ and keeps it).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FUNCTIONS_DB_FILE = join(mkdtempSync(join(tmpdir(), "m5nfcb-")), "functions.db");
process.env.FUNCTIONS_WARM = "0";

const { functionsStore } = await import("../server/functions/store");
const { execute, closeRunner, runEvents, answerRun } = await import("../server/functions/runner");
const { saveModel } = await import("../server/functions/packages");
const { installBuiltin, BUILTINS_ALL } = await import("../server/functions/builtins");
const { endpointOf } = await import("../server/functions/endpoints");
const { parseFlow, compileFlow } = await import("../server/functions/flow");

const owner = { kind: "console" as const, account: "", name: "boss", groups: [], room: null, client: "console", lang: "en", tz: "UTC", adminRole: "owner" as const };

beforeAll(() => functionsStore.ready());
afterAll(() => closeRunner());

function withDevice(answer: (command: { op: string; args?: Record<string, unknown> }) => unknown) {
  const seen: Array<{ op: string; args?: Record<string, unknown> }> = [];
  const onRun = (ev: { type?: string; runId?: string; interaction?: { id: string; kind: string; spec?: { command?: { op: string; args?: Record<string, unknown> } } } }) => {
    if (ev.type === "interaction" && ev.interaction?.kind === "nfc" && ev.runId) {
      const command = ev.interaction.spec?.command ?? { op: "" };
      seen.push(command);
      setTimeout(() => answerRun(ev.runId!, ev.interaction!.id, answer(command)), 10);
    }
  };
  runEvents.on("run", onRun);
  return { seen, off: () => runEvents.off("run", onRun) };
}

const enable = (keyword: string) => { const m = functionsStore.models().find((x) => x.keyword === keyword)!; return saveModel({ id: m.id, enabled: true }, "boss", "owner"); };

describe("the NFC command packages", () => {
  it("install switched off, each flow compiling to exactly the file that runs", () => {
    const names = BUILTINS_ALL.filter((b) => b.name.startsWith("nfc-")).map((b) => b.name);
    expect(names).toEqual(["nfc-scan", "nfc-uid", "nfc-m5", "nfc-emv", "nfc-emv-history", "nfc-eid"]);
    for (const name of names) {
      installBuiltin(name, "boss");
      const pkg = functionsStore.packageByName(name)!;
      const v = functionsStore.versions(pkg.id).find((x) => x.status === "published")!;
      expect(compileFlow(parseFlow(JSON.parse(v.files["flow.m5flow.json"]))).code + "\n", name).toBe(v.files["index.js"]);
      expect(v.files["README.md"], name).toContain("Functions › Builder");
    }
    for (const k of ["emv", "emv-history", "eid"]) expect(functionsStore.models().find((m) => m.keyword === k)?.enabled, k).toBe(false);
    const eid = functionsStore.models().find((m) => m.keyword === "eid")!;
    expect(endpointOf(eid, "error")).toBeTruthy();
  });

  it("/emv reads everything and shows the formatted report with its files", async () => {
    const model = enable("emv");
    const dev = withDevice(() => ({ status: "ok", card: { uid: "08AA", tech: "emv", label: "EMV" }, emv: { scheme: "Mastercard", aids: ["A0000000041010"], apps: [{ aid: "A0000000041010", label: "MASTERCARD", scheme: "Mastercard", pan: "5413330089020011", panMasked: "541333••••••0011", expiry: "2028-12", logSfi: 11, log: [{ date: "2025-09-14", amount: "10.00", currency: "CZK", merchant: "DPP", raw: "00" }], tags: [], records: [{ sfi: 1, record: 1, hex: "70" }] }] } }));
    try {
      const r = await execute(model, {}, owner as never, { executor: "console" });
      expect(r.run.error).toBeNull();
      expect(dev.seen[0]).toMatchObject({ op: "emv-read", args: { history: true, deep: true, maxApps: 8 } });
      expect(r.outputs.map((o) => o.type)).toEqual(["html", "file", "file", "text"]);
      expect((r.outputs[0] as { html: string }).html).toContain("541333••••••0011");
      expect((r.outputs[3] as { text: string }).text).toBe("Mastercard · 541333••••••0011 · 2028-12 · Transaction history: 1");
    } finally { dev.off(); }
  }, 60_000);

  it("/emv-history shows the transactions as a table, or why not", async () => {
    const model = enable("emv-history");
    const dev = withDevice(() => ({ status: "ok", emv: { aids: ["A0000000031010"], apps: [{ aid: "A0000000031010", label: "VISA", scheme: "Visa", log: [{ date: "2025-09-14", time: "10:00:00", amount: "1.50", currency: "EUR", merchant: "CAFE", raw: "00" }, { date: "2025-09-13", amount: "2.00", currency: "EUR", raw: "01" }], tags: [] }] } }));
    try {
      const r = await execute(model, {}, owner as never, { executor: "console" });
      expect(r.run.error).toBeNull();
      expect(dev.seen[0]).toMatchObject({ op: "emv-read", args: { history: true, deep: false } });
      const t = r.outputs[0] as { type: string; columns: string[]; rows: unknown[][]; title: string };
      expect(t.type).toBe("table");
      expect(t.title).toBe("Transaction history");
      expect(t.rows).toEqual([["2025-09-14", "10:00:00", "1.50", "EUR", "CAFE", null, null, null], ["2025-09-13", null, "2.00", "EUR", null, null, null, null]]);
    } finally { dev.off(); }
    const none = withDevice(() => ({ status: "no-card", message: "No card in time." }));
    try {
      const r = await execute(model, {}, owner as never, { executor: "console" });
      expect(r.outputs[0]).toMatchObject({ type: "flash", level: "warning", text: "No card in time." });
    } finally { none.off(); }
  }, 60_000);

  it("/eid reads straight away and sends NO key — the device asks the holder for it", async () => {
    const model = enable("eid");
    expect(endpointOf(model, "form")).toBeFalsy();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 0xff, 0xd9]).toString("base64");
    const dev = withDevice(() => ({ status: "ok", mrtd: { present: true, access: "pace", pace: { supported: true, used: true, password: "can" }, mrzInfo: { documentCode: "ID", documentNumber: "AB1", surname: "NOVAK", givenNames: "JAN" }, images: [{ group: "DG2", kind: "face", mime: "image/jpeg", data: jpeg, name: "face.jpg" }] } }));
    try {
      const done = await execute(model, {}, owner as never, { executor: "console" });
      expect(done.run.error).toBeNull();
      expect(dev.seen[0]).toMatchObject({ op: "mrtd-read", args: { readPhoto: true, all: true } });
      for (const k of ["can", "mrz", "documentNumber", "dateOfBirth", "dateOfExpiry"]) expect(dev.seen[0].args).not.toHaveProperty(k);
      expect(JSON.stringify(done.run.inputs)).not.toMatch(/can|mrz/i);
      const html = (done.outputs[0] as { html: string }).html;
      expect(html).toContain(`data:image/jpeg;base64,${jpeg}`);
      expect(html).toContain("PACE (CAN)");
      expect((done.outputs[done.outputs.length - 1] as { text: string }).text).toBe("ID card · JAN NOVAK · AB1 · Pictures: 1 · PACE");
    } finally { dev.off(); }
  }, 60_000);
});
