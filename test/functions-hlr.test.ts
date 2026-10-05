// @vitest-environment node
// /hlr (6.11, tel-hlr 1.1.0): "/hlr +420603123456" asks the home network at
// once and shows the result (as the form does); "/hlr" alone answers with the
// form; a number that is not in the international form answers with an error
// and the form, prefilled with what was typed. The provider is stubbed:
// m5.telephony.hlr reaches a fake here.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FUNCTIONS_DB_FILE = join(mkdtempSync(join(tmpdir(), "m5hlr-")), "functions.db");
process.env.FUNCTIONS_WARM = "0";

const asked: Array<{ op: string; args: unknown[] }> = [];
vi.mock("../server/functions/host-telephony", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/functions/host-telephony")>()),
  hostTelephony: vi.fn(async (op: string, args: unknown[]) => {
    asked.push({ op, args });
    if (op === "hlr") return { number: String(args[0]), status: "connected", roaming: { status: "not-roaming" }, ported: false, network: { name: "T-Mobile CZ", mcc: "230", mnc: "01" }, provider: "fake" };
    throw new Error(`unexpected m5.telephony.${op}`);
  }),
}));

const { functionsStore } = await import("../server/functions/store");
const { execute, closeRunner } = await import("../server/functions/runner");
const { saveModel } = await import("../server/functions/packages");
const { installBuiltin, BUILTIN_BY_NAME } = await import("../server/functions/builtins");
const { endpointOf, eventInputs } = await import("../server/functions/endpoints");
const { parseFlow, compileFlow } = await import("../server/functions/flow");
const { commandView } = await import("../server/functions/guide");

const owner = { kind: "console" as const, account: "", name: "boss", groups: [], room: null, client: "console", lang: "en", tz: "UTC", adminRole: "owner" as const };
type Out = { type: string; [k: string]: unknown };

beforeAll(async () => {
  await functionsStore.ready();
  installBuiltin("tel-hlr", "boss");
});
afterAll(() => closeRunner());

const hlr = () => functionsStore.models().find((m) => m.keyword === "hlr")!; // also when switched off
const run = async (inputs: Record<string, unknown>) => { asked.length = 0; const r = await execute(hlr(), inputs, owner, { executor: "console" }); return { r, outs: r.outputs as Out[] }; };

describe("/hlr", () => {
  it("installs switched off, at 1.1.0, with an optional `number` and the phone icon; its flow compiles to the file that runs", () => {
    const m = hlr();
    expect(m.enabled).toBe(false);
    expect(m.entry).toBe("tel-hlr@1.1.0:index.js#execute");
    expect(m.icon).toBe("phone");
    expect(m.usage).toMatch(/^\/hlr \+420603123456 — /);
    expect(m.inputs).toEqual([expect.objectContaining({ name: "number", type: "string", label: "Number" })]);
    expect(m.inputs[0].required).toBeFalsy();
    expect(m.inputs[0].pattern).toBeUndefined(); // the model checks it: a wrong one gets the form back
    expect(endpointOf(m, "execute")!.inputs).toEqual(m.inputs);
    expect(commandView(m, owner).inputs).toEqual([expect.objectContaining({ name: "number", required: false })]);
    const v = functionsStore.versionByName("tel-hlr", BUILTIN_BY_NAME["tel-hlr"].version)!;
    expect(compileFlow(parseFlow(JSON.parse(v.files["flow.m5flow.json"]))).code + "\n").toBe(v.files["index.js"]);
    // Installing again (an update) moves the model it has — switched off, it used to get a second one.
    installBuiltin("tel-hlr", "boss");
    expect(functionsStore.models().filter((x) => x.keyword === "hlr").map((x) => x.id)).toEqual([m.id]);
    saveModel({ id: m.id, enabled: true }, "boss", "owner");
  });

  it("with a number: the HLR at once (spaces, dashes, 00 tidied away)", async () => {
    for (const typed of ["+420603123456", "+420 603 123 456", "00420-603-123-456", "(+420) 603.123.456"]) {
      const { r, outs } = await run({ number: typed });
      expect(r.run.error, typed).toBeNull();
      expect(asked, typed).toEqual([{ op: "hlr", args: ["+420603123456", {}] }]);
      expect(outs, typed).toHaveLength(1);
      expect(outs[0]).toMatchObject({ type: "json", title: "HLR", value: { number: "+420603123456", status: "connected", network: { name: "T-Mobile CZ" } } });
    }
  }, 60_000);

  it("without one: the form (nothing asked)", async () => {
    const { r, outs } = await run({});
    expect(r.run.error).toBeNull();
    expect(asked).toEqual([]);
    expect(outs).toHaveLength(1);
    expect(outs[0]).toMatchObject({ type: "form", name: "tel-hlr", text: "Ask a number's home network: reachable, roaming, ported" });
    const field = (outs[0].fields as Array<Record<string, unknown>>)[0];
    expect(field).toMatchObject({ name: "number", type: "tel", required: true, pattern: "^\\+[1-9][0-9]{6,14}$" });
    expect(field.default).toBeUndefined();
  }, 30_000);

  it("with a wrong one: an error and the form, prefilled with what was typed", async () => {
    for (const typed of ["603 123 456", "+420abc", "12"]) {
      const { r, outs } = await run({ number: typed });
      expect(r.run.error, typed).toBeNull();
      expect(asked, typed).toEqual([]);
      expect(outs.map((o) => o.type), typed).toEqual(["flash", "form"]);
      expect(outs[0]).toMatchObject({ level: "error", text: `“${typed}” is not a phone number in the international form (+420603123456).` });
      expect(outs[1]).toMatchObject({ name: "tel-hlr", text: `“${typed}” is not a phone number in the international form — correct it and send.` });
      expect((outs[1].fields as Array<Record<string, unknown>>)[0]).toMatchObject({ name: "number", default: typed, required: true });
    }
  }, 60_000);

  it("the form, sent: the HLR as before", async () => {
    const m = hlr();
    const ep = endpointOf(m, "form")!;
    const values = { number: "+420603123456" };
    asked.length = 0;
    const r = await execute(m, eventInputs(ep, values, { name: "tel-hlr", values, event: { type: "submit" } }), owner, { executor: "console", endpoint: ep, skipValidation: true });
    expect(r.run.error).toBeNull();
    expect(asked).toEqual([{ op: "hlr", args: ["+420603123456", {}] }]);
    expect(r.outputs[0]).toMatchObject({ type: "json", title: "HLR", value: { status: "connected" } });
  }, 30_000);
});
