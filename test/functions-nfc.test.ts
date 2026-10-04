// @vitest-environment node
// m5.nfc (6.3): a model drives the caller's NFC hardware two-way. This checks
//  - the SDK surface exists in JavaScript and Python and matches the spec,
//  - the "nfc" interaction round-trip: the sandbox emits an NfcCommand, the
//    (mocked) device answers with an NfcResult, the awaiting call resolves,
//  - the no-raw-key guarantee: a key/PIN in the command never leaves the host,
//    and an executor's stray key never reaches the model,
//  - access-control gating (a person's own NFC access vs a webhook/schedule/API
//    run's model grant),
//  - the Builder nodes generate the right m5.nfc.* calls in JS and Python.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FUNCTIONS_DB_FILE = join(mkdtempSync(join(tmpdir(), "m5nfc-")), "functions.db");
process.env.FUNCTIONS_WARM = "0";

const { runAdhoc, closeRunner, runEvents, answerRun } = await import("../server/functions/runner");
const { functionsStore } = await import("../server/functions/store");
const { SDK_SPEC } = await import("../server/functions/sdk-spec");
const HostNfc = await import("../server/functions/host-nfc");
const F = await import("../server/functions/flow");

const caller = { kind: "console" as const, account: "", name: "tester", groups: [], room: "r", client: "c", lang: "cs", tz: "UTC" };
const model = { id: "__adhoc__", grants: undefined } as unknown as Parameters<typeof HostNfc.nfcAllowed>[0]["model"];

beforeAll(() => functionsStore.ready());
afterAll(() => closeRunner());

/* -------------------------------------------------------- the SDK surface */

describe("m5.nfc SDK surface", () => {
  const OPS = ["reader", "enum", "card", "scan", "read", "write", "emulate", "m5", "emv", "eid"];

  it("the spec has one nfc object with exactly its ops", () => {
    const nfc = SDK_SPEC.find((o) => o.name === "nfc");
    expect(nfc, "an nfc SdkObject").toBeTruthy();
    expect(nfc!.methods.map((m) => m.name).sort()).toEqual([...OPS].sort());
    // Every js/py signature is m5.nfc.<name>… so the spec test's path check finds it.
    for (const m of nfc!.methods) { expect(m.js).toContain(`m5.nfc.${m.name}`); expect(m.py).toContain(`m5.nfc.${m.name}`); }
  });

  it("exists in JavaScript and Python, with m5.nfc.m5 nested", async () => {
    const js = "export async function execute(){ const r = m5.nfc.reader('usb'); return m5.out.json({ ops: [" + OPS.map((o) => `typeof m5.nfc.${o}`).join(", ") + "], scoped: typeof r.scan, m5read: typeof m5.nfc.m5.read }); }";
    const rj = await runAdhoc({ lang: "js", files: { "index.js": js }, entry: { file: "index.js", fn: "execute" }, inputs: {} }, caller);
    expect(rj.run.error).toBeNull();
    const vj = (rj.value as { value: { ops: string[]; scoped: string; m5read: string } }).value;
    expect(vj.ops.every((t) => t === "function" || t === "object")).toBe(true);
    expect(vj.scoped).toBe("function");
    expect(vj.m5read).toBe("function");

    const py = [
      "async def execute(**inputs):",
      "    r = m5.nfc.reader('usb')",
      `    ops = [${OPS.map((o) => `hasattr(m5.nfc, '${o}')`).join(", ")}]`,
      "    return m5.out.json({'ops': ops, 'scoped': hasattr(r, 'scan'), 'm5read': hasattr(m5.nfc.m5, 'read')})",
      "",
    ].join("\n");
    const rp = await runAdhoc({ lang: "py", files: { "index.py": py }, entry: { file: "index.py", fn: "execute" }, inputs: {} }, caller);
    expect(rp.run.error).toBeNull();
    const vp = (rp.value as { value: { ops: boolean[]; scoped: boolean; m5read: boolean } }).value;
    expect(vp.ops.every(Boolean)).toBe(true);
    expect(vp.scoped).toBe(true);
    expect(vp.m5read).toBe(true);
  }, 60_000);
});

/* ------------------------------------------------- the interaction round-trip */

/** Answers the next "nfc" interaction of a run as a mocked device would. */
function withDevice(answer: (command: { op: string; args?: Record<string, unknown> }) => unknown): { seen: Array<{ op: string; args?: Record<string, unknown> }>; off: () => void } {
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

describe("the nfc interaction round-trip", () => {
  it("sends an NfcCommand to the device and resolves with its NfcResult (JS)", async () => {
    const dev = withDevice(() => ({ status: "ok", card: { uid: "04A1B2C3", tech: "ntag21x", label: "NTAG 215" }, ndef: [{ kind: "text", text: "hi" }] }));
    try {
      const files = { "index.js": "export async function execute(){ const r = await m5.nfc.scan({ timeout: 5 }); return m5.out.json(r); }" };
      const r = await runAdhoc({ lang: "js", files, entry: { file: "index.js", fn: "execute" }, inputs: {}, limits: { wallMs: 4000 } }, caller);
      expect(r.run.error).toBeNull();
      expect(dev.seen.map((c) => c.op)).toEqual(["scan"]);
      expect((r.value as { value: { status: string; card: { uid: string } } }).value).toMatchObject({ status: "ok", card: { uid: "04A1B2C3", tech: "ntag21x" } });
    } finally { dev.off(); }
  }, 30_000);

  it("works from Python too", async () => {
    const dev = withDevice(() => ({ status: "no-card" }));
    try {
      const files = { "index.py": "async def execute(**inputs):\n    r = await m5.nfc.read(what='uid', timeout=3)\n    return m5.out.json(r)\n" };
      const r = await runAdhoc({ lang: "py", files, entry: { file: "index.py", fn: "execute" }, inputs: {}, limits: { wallMs: 4000 } }, caller);
      expect(r.run.error).toBeNull();
      expect(dev.seen.map((c) => c.op)).toEqual(["read-uid"]);
      expect((r.value as { value: { status: string } }).value.status).toBe("no-card");
    } finally { dev.off(); }
  }, 30_000);

  it("never sends a raw key/PIN in the command, and never returns one", async () => {
    // The device is asked to authenticate a MIFARE sector; the model wrongly puts a
    // key and pin in args, and the executor wrongly tries to return them.
    const dev = withDevice((c) => {
      // The command that reached the "device" must carry no raw key/PIN.
      expect(c.args && "keyA" in c.args).toBeFalsy();
      expect(c.args && "pin" in c.args).toBeFalsy();
      return { status: "ok", card: { uid: "01", tech: "mifare-classic-1k", label: "1K", key: "FFFFFFFFFFFF" }, data: "AAAA", secret: "leaked", records: [{ id: 1, type: "wifi", oneTime: false, summary: "home", key: "nope" }] };
    });
    try {
      const files = { "index.js": "export async function execute(){ const r = await m5.nfc.read({ what: 'sector', secretRef: 'saved-keys', args: { keyA: 'FFFFFFFFFFFF', pin: '123456', sector: 1 } }); return m5.out.json(r); }" };
      const r = await runAdhoc({ lang: "js", files, entry: { file: "index.js", fn: "execute" }, inputs: {}, limits: { wallMs: 4000 } }, caller);
      expect(r.run.error).toBeNull();
      const cmd = dev.seen[0];
      expect(cmd.op).toBe("classic-read");
      expect(cmd.args).toBeTruthy();
      expect("keyA" in (cmd.args ?? {})).toBe(false);
      expect("pin" in (cmd.args ?? {})).toBe(false);
      expect((cmd.args ?? {}).sector).toBe(1);
      const value = (r.value as { value: Record<string, unknown> }).value;
      // The result the model got is whitelisted: no stray secret, no key on the card/record.
      expect("secret" in value).toBe(false);
      expect("key" in (value.card as Record<string, unknown>)).toBe(false);
      expect("key" in ((value.records as Record<string, unknown>[])[0])).toBe(false);
      expect(value.data).toBe("AAAA"); // a public dump is allowed
    } finally { dev.off(); }
  }, 30_000);
});

/* ------------------------------------------------------ command / result guards */

describe("no raw key/PIN (unit)", () => {
  it("strips secret-named args but keeps secretRef and record payloads", () => {
    const cmd = HostNfc.sanitizeNfcCommand({ op: "classic-write", secretRef: "keyset-a", args: { keyA: "FF", keyB: "FF", pin: "1234", password: "x", block: 4, records: [{ type: "wifi", data: { ssid: "n", password: "p" } }] } });
    expect(cmd.op).toBe("classic-write");
    expect(cmd.secretRef).toBe("keyset-a");
    expect(cmd.args && Object.keys(cmd.args).sort()).toEqual(["block", "records"]);
    // A record payload the model builds is content, not a card credential — it stays.
    expect((cmd.args!.records as Array<{ data: { password: string } }>)[0].data.password).toBe("p");
  });

  it("refuses a command with no valid op", () => {
    expect(() => HostNfc.sanitizeNfcCommand({})).toThrow();
    expect(() => HostNfc.sanitizeNfcCommand({ op: "../etc" })).toThrow();
  });

  it("whitelists the result to public fields", () => {
    const res = HostNfc.sanitizeNfcResult({ status: "ok", card: { uid: "1", tech: "ndef", label: "L", key: "secret", extra: 1 }, data: "ZZ", secret: "leak", token: "leak", records: [{ id: 2, type: "contact", oneTime: true, summary: "Eva", pin: "9" }], ndef: [{ kind: "uri", data: "https://x", password: "y" }] });
    expect(res).toEqual({
      status: "ok",
      card: { uid: "1", tech: "ndef", label: "L" },
      data: "ZZ",
      records: [{ id: 2, type: "contact", oneTime: true, summary: "Eva" }],
      ndef: [{ kind: "uri", data: "https://x" }],
    });
  });

  it("an unknown status becomes error", () => {
    expect(HostNfc.sanitizeNfcResult({ status: "totally-made-up" }).status).toBe("error");
  });

  it("6.5: whitelists EMV read data (holder fields) and caps/keeps the tags", () => {
    const res = HostNfc.sanitizeNfcResult({
      status: "ok",
      emv: {
        scheme: "Visa", aids: ["A0000000031010", 42], tree: "x".repeat(5000),
        apps: [{ aid: "a0000000031010", label: "VISA", scheme: "Visa", pan: "4111111111111111", panMasked: "411111••••••1111", expiry: "2029-12", atc: 5, pinTryCounter: 3, secretKey: "leak", tags: [{ tag: "5A", name: "Application PAN", value: "4111111111111111", hex: "4111111111111111", junk: 1 }] }],
      },
    });
    expect(res.emv!.scheme).toBe("Visa");
    expect(res.emv!.aids).toEqual(["A0000000031010"]); // non-strings dropped, upper-cased
    expect(res.emv!.tree!.length).toBe(4000); // capped
    const app = res.emv!.apps[0];
    expect(app.aid).toBe("A0000000031010");
    expect(app.pan).toBe("4111111111111111");
    expect(app.atc).toBe(5);
    expect(app.pinTryCounter).toBe(3);
    expect((app as Record<string, unknown>).secretKey).toBeUndefined(); // unknown field dropped
    expect(app.tags[0]).toEqual({ tag: "5A", name: "Application PAN", value: "4111111111111111", hex: "4111111111111111" });
  });

  it("6.5: whitelists MRTD read data and caps an oversize photo", () => {
    const ok = HostNfc.sanitizeNfcResult({
      status: "ok",
      mrtd: { present: true, access: "bac", dataGroups: ["DG1", "DG2"], mrzInfo: { surname: "ERIKSSON", givenNames: "ANNA MARIA", documentNumber: "L898902C", secret: "x" }, photo: "QUJD", photoMime: "image/jpeg" },
    });
    expect(ok.mrtd!.access).toBe("bac");
    expect(ok.mrtd!.mrzInfo).toEqual({ surname: "ERIKSSON", givenNames: "ANNA MARIA", documentNumber: "L898902C" });
    expect(ok.mrtd!.photo).toBe("QUJD");
    // A photo above the cap (400 kB base64) is dropped, the rest stays.
    const big = HostNfc.sanitizeNfcResult({ status: "ok", mrtd: { present: true, access: "bac", photo: "A".repeat(500_000), photoMime: "image/jpeg" } });
    expect(big.mrtd!.photo).toBeUndefined();
    expect(big.mrtd!.access).toBe("bac");
  });
});

/* --------------------------------------------------------------- gating */

describe("access-control gating", () => {
  const ctx = (kind: string, grant?: boolean) => ({
    model: (grant === undefined ? model : { id: "m1", grants: { nfc: { enabled: grant } } } as unknown as typeof model),
    caller: { ...caller, kind } as unknown as typeof caller,
    runId: "run_1",
  });

  it("a person's run is allowed (NFC module unlisted → available)", () => {
    for (const kind of ["console", "user", "guest"]) expect(() => HostNfc.nfcAllowed(ctx(kind)), kind).not.toThrow();
  });

  it("a webhook / schedule / API run needs the model's NFC grant", () => {
    for (const kind of ["webhook", "schedule", "api"]) {
      expect(() => HostNfc.nfcAllowed(ctx(kind, false)), `${kind} without grant`).toThrow(/NFC/i);
      expect(() => HostNfc.nfcAllowed(ctx(kind)), `${kind} no grant object`).toThrow();
      expect(() => HostNfc.nfcAllowed(ctx(kind, true)), `${kind} with grant`).not.toThrow();
    }
  });
});

/* ------------------------------------------------------- Builder node codegen */

describe("Builder nodes generate m5.nfc.* calls", () => {
  const single = (type: string, lang: "js" | "py") => {
    const flow = F.emptyFlow(lang);
    const n = F.newNode(flow, type, 0, 0);
    for (const p of F.inputsOf(n)) if (p.required) n.values![p.name] = p.type === "list" ? "[]" : p.type === "json" ? "{}" : "x";
    flow.nodes.push(n);
    return F.compileFlow(flow).code;
  };
  const cases: Array<[string, string]> = [
    ["nfc.scan", "m5.nfc.scan("], ["nfc.read", "m5.nfc.read("], ["nfc.write", "m5.nfc.write("],
    ["nfc.m5.read", "m5.nfc.m5.read("], ["nfc.m5.build", "m5.nfc.m5.build("], ["nfc.emulate", "m5.nfc.emulate("], ["nfc.enum", "m5.nfc.enum("],
  ];

  it("each NFC node compiles to its call in JavaScript and Python", () => {
    for (const [type, expected] of cases) {
      expect(single(type, "js"), `${type} js`).toContain(expected);
      expect(single(type, "py"), `${type} py`).toContain(expected);
    }
  });

  it("read/write map the chosen op and never emit a raw key field", () => {
    const flow = F.emptyFlow("js");
    const n = F.newNode(flow, "nfc.read", 0, 0);
    n.params = { ...n.params, what: "sector" };
    flow.nodes.push(n);
    const code = F.compileFlow(flow).code;
    expect(code).toContain('what: "sector"');
    expect(code).toContain("secretRef");
    expect(code).not.toMatch(/\bkeyA\b/);
  });
});
