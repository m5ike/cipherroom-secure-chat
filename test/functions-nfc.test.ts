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
  const OPS = ["reader", "enum", "card", "scan", "read", "write", "emulate", "m5", "emv", "eid", "format", "outputs", "document"];

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

  it("6.5: m5.nfc.emv.read() sends emv-read and resolves with the parsed EMV data", async () => {
    const dev = withDevice(() => ({ status: "ok", card: { uid: "11", tech: "emv", label: "EMV" }, emv: { scheme: "Visa", aids: ["A0000000031010"], apps: [{ aid: "A0000000031010", label: "VISA", scheme: "Visa", pan: "4111111111111111", panMasked: "411111••••••1111", expiry: "2029-12", tags: [{ tag: "5A", name: "Application PAN", value: "4111111111111111", hex: "4111111111111111" }] }] } }));
    try {
      const files = { "index.js": "export async function execute(){ const r = await m5.nfc.emv.read({ timeout: 5 }); return m5.out.json(r); }" };
      const r = await runAdhoc({ lang: "js", files, entry: { file: "index.js", fn: "execute" }, inputs: {}, limits: { wallMs: 4000 } }, caller);
      expect(r.run.error).toBeNull();
      expect(dev.seen.map((c) => c.op)).toEqual(["emv-read"]);
      const v = (r.value as { value: { emv: { scheme: string; apps: Array<{ panMasked: string }> } } }).value;
      expect(v.emv.scheme).toBe("Visa");
      expect(v.emv.apps[0].panMasked).toBe("411111••••••1111");
    } finally { dev.off(); }
  }, 30_000);

  it("6.5: m5.nfc.eid.read({ fields }) sends mrtd-read with the MRZ key and returns the document data (Python)", async () => {
    const dev = withDevice((c) => {
      // The BAC fields the holder gave travel as args — not a card key.
      expect(c.op).toBe("mrtd-read");
      expect(c.args).toMatchObject({ documentNumber: "L898902C", dateOfBirth: "690806", dateOfExpiry: "940623" });
      return { status: "ok", card: { uid: "22", tech: "eid", label: "MRTD" }, mrtd: { present: true, access: "bac", dataGroups: ["DG1", "DG2"], mrzInfo: { surname: "ERIKSSON", givenNames: "ANNA MARIA", documentNumber: "L898902C" }, photo: "QUJD", photoMime: "image/jpeg" } };
    });
    try {
      const files = { "index.py": "async def execute(**inputs):\n    r = await m5.nfc.eid.read(document_number='L898902C', date_of_birth='690806', date_of_expiry='940623')\n    return m5.out.json(r)\n" };
      const r = await runAdhoc({ lang: "py", files, entry: { file: "index.py", fn: "execute" }, inputs: {}, limits: { wallMs: 4000 } }, caller);
      expect(r.run.error).toBeNull();
      const v = (r.value as { value: { mrtd: { access: string; mrzInfo: { surname: string }; photo: string } } }).value;
      expect(v.mrtd.access).toBe("bac");
      expect(v.mrtd.mrzInfo.surname).toBe("ERIKSSON");
      expect(v.mrtd.photo).toBe("QUJD");
    } finally { dev.off(); }
  }, 30_000);

  it("6.6: m5.nfc.emv.report() reads everything, formats it as HTML and shows it with its files (JS)", async () => {
    const emv = { scheme: "Visa", aids: ["A0000000031010"], deep: true, apps: [{ aid: "A0000000031010", label: "VISA", scheme: "Visa", pan: "4111111111111111", panMasked: "411111••••••1111", expiry: "2029-12", atc: 7, logSfi: 11,
      log: [{ date: "2025-09-14", time: "18:30:05", amount: "123.45", currency: "CZK", merchant: "BILLA", raw: "01" }], tags: [{ tag: "5A", name: "Application PAN", value: "4111111111111111", hex: "4111111111111111" }], records: [{ sfi: 1, record: 1, hex: "5A084111111111111111" }] }] };
    const dev = withDevice(() => ({ status: "ok", card: { uid: "08AABBCC", tech: "emv", label: "EMV" }, emv }));
    try {
      const files = { "index.js": "export async function execute(){ const r = await m5.nfc.emv.report({ format: 'html', send: true, deep: true, history: true, maxApps: 2 }); return m5.out.json({ ok: r.ok, format: r.format, history: r.history.length, files: r.files.map((f) => f.name), summary: r.summary, outputs: r.outputs.length }); }" };
      const r = await runAdhoc({ lang: "js", files, entry: { file: "index.js", fn: "execute" }, inputs: {}, limits: { wallMs: 6000 } }, caller);
      expect(r.run.error).toBeNull();
      expect(dev.seen[0]).toMatchObject({ op: "emv-read", args: { deep: true, history: true, maxApps: 2 } });
      const sent = r.run.outputs as Array<{ type: string; html?: string; name?: string }>;
      expect(sent.map((o) => o.type)).toEqual(["html", "file", "file", "json"]);
      expect(sent[0].html).toContain("m5h-report--emv");
      expect(sent[0].html).toContain("Historie transakcí"); // the caller speaks Czech
      expect(sent[0].html).not.toContain("4111111111111111");
      expect(sent.filter((o) => o.type === "file").map((o) => o.name)).toEqual(["emv-history.csv", "emv-records.txt"]);
      expect((sent[3] as unknown as { value: unknown }).value).toMatchObject({ ok: true, format: "html", history: 1, files: ["emv-history.csv", "emv-records.txt"], outputs: 3 });
    } finally { dev.off(); }
  }, 30_000);

  it("6.6: m5.nfc.eid.report() opens with the CAN and gives CSV + the photo (Python)", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 0xff, 0xd9]).toString("base64");
    const dev = withDevice(() => ({ status: "ok", mrtd: { present: true, access: "pace", mrzInfo: { documentCode: "ID", documentNumber: "AB123", surname: "NOVAK", givenNames: "JAN" }, images: [{ group: "DG2", kind: "face", mime: "image/jpeg", data: jpeg, name: "face.jpg" }], raw: [{ name: "EF.SOD.bin", mime: "application/octet-stream", data: "AAEC" }] } }));
    try {
      const files = { "index.py": "async def execute(**inputs):\n    r = await m5.nfc.eid.report(can='123456', format='csv', send=True, photo=True, all=True)\n    return m5.out.json({'ok': r['ok'], 'photo': r['photo']['mime'], 'size': len(r['photo']['image']), 'csv': r['result'].splitlines()[0]})\n" };
      const r = await runAdhoc({ lang: "py", files, entry: { file: "index.py", fn: "execute" }, inputs: {}, limits: { wallMs: 8000 } }, caller);
      expect(r.run.error).toBeNull();
      expect(dev.seen[0]).toMatchObject({ op: "mrtd-read", args: { can: "123456", readPhoto: true, all: true } });
      const sent = r.run.outputs as Array<{ type: string; name?: string; lang?: string; mime?: string }>;
      expect(sent.map((o) => o.type)).toEqual(["code", "file", "image", "file", "json"]);
      expect(sent[0].lang).toBe("csv");
      expect(sent[1].name).toBe("e-id.csv");
      expect(sent[2].mime).toBe("image/jpeg");
      expect(sent[3].name).toBe("EF.SOD.bin");
      expect((sent[4] as unknown as { value: unknown }).value).toEqual({ ok: true, photo: "image/jpeg", size: 8, csv: "section,field,value" });
    } finally { dev.off(); }
  }, 30_000);

  it("6.6: m5.nfc.format() turns any read into a report, and m5.out.html is sanitized by the host", async () => {
    const files = { "index.js": "export async function execute(){ const rep = m5.nfc.format({ status: 'ok', card: { uid: '04AA', tech: 'ntag21x', label: 'NTAG' } }, 'text'); return [m5.out.text(rep.value.split('\\n')[0]), m5.out.html('<h2 onclick=\"x()\">Hi</h2><script>bad()</script><img src=\"https://evil/x.png\"><a href=\"javascript:alert(1)\">a</a>')]; }" };
    const r = await runAdhoc({ lang: "js", files, entry: { file: "index.js", fn: "execute" }, inputs: {}, limits: { wallMs: 4000 } }, caller);
    expect(r.run.error).toBeNull();
    const outs = r.run.outputs as Array<{ type: string; text?: string; html?: string }>;
    expect(outs[0].text).toBe("NTAG · 04AA");
    expect(outs[1]).toEqual({ type: "html", html: "<h2>Hi</h2><a>a</a>" });
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
    for (const p of F.inputsOf(n)) if (p.required) n.values![p.name] = p.type === "list" ? "[]" : p.type === "json" || p.type === "object" ? "{}" : "x";
    flow.nodes.push(n);
    return F.compileFlow(flow).code;
  };
  const cases: Array<[string, string]> = [
    ["nfc.scan", "m5.nfc.scan("], ["nfc.read", "m5.nfc.read("], ["nfc.write", "m5.nfc.write("],
    ["nfc.m5.read", "m5.nfc.m5.read("], ["nfc.m5.build", "m5.nfc.m5.build("], ["nfc.emulate", "m5.nfc.emulate("], ["nfc.enum", "m5.nfc.enum("],
    // 6.6: the NFC.EMV / NFC.e-ID tools, the report helpers and HTML.
    ["nfc.emv.report", "m5.nfc.emv.report("], ["nfc.emv.format", "m5.nfc.emv.format("], ["nfc.emv.history", "m5.nfc.emv.history("],
    ["nfc.eid.report", "m5.nfc.eid.report("], ["nfc.eid.format", "m5.nfc.eid.format("], ["nfc.eid.images", "m5.nfc.eid.images("],
    ["nfc.format", "m5.nfc.format("], ["nfc.show", "m5.nfc.outputs("], ["out.html", "m5.out.html("],
  ];

  it("each NFC node compiles to its call in JavaScript and Python", () => {
    for (const [type, expected] of cases) {
      expect(single(type, "js"), `${type} js`).toContain(expected);
      expect(single(type, "py"), `${type} py`).toContain(expected);
    }
  });

  it("6.6: the NFC.EMV and NFC.e-ID tools sit in their own palette groups", () => {
    expect(F.GROUPS).toEqual(expect.arrayContaining(["NFC", "NFC.EMV", "NFC.e-ID"]));
    expect(F.NODES.filter((d) => d.group === "NFC.EMV").map((d) => d.type)).toEqual(["nfc.emv.report", "nfc.emv.format", "nfc.emv.history"]);
    expect(F.NODES.filter((d) => d.group === "NFC.e-ID").map((d) => d.type)).toEqual(["nfc.eid.report", "nfc.eid.format", "nfc.eid.images"]);
    expect(F.NODE_BY_TYPE["nfc.emv.report"].params!.find((p) => p.name === "format")!.values).toEqual(["html", "object", "array", "json", "text", "csv"]);
  });

  it("6.6: a flow — e-ID read → its photo → Send image, CSV → Result — runs end to end (Python and JS)", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 0xff, 0xd9]).toString("base64");
    for (const lang of ["py", "js"] as const) {
      const dev = withDevice(() => ({ status: "ok", mrtd: { present: true, access: "bac", mrzInfo: { documentCode: "P", documentNumber: "X1", surname: "DOE", givenNames: "JANE" }, images: [{ group: "DG2", kind: "face", mime: "image/jpeg", data: jpeg, name: "face.jpg" }] } }));
      try {
        const flow = F.emptyFlow(lang);
        const read = F.newNode(flow, "nfc.eid.report", 0, 0);
        read.params = { ...read.params, format: "csv", send: false };
        read.values = { can: "654321" };
        flow.nodes.push(read);
        const img = F.newNode(flow, "out.image", 300, 0); flow.nodes.push(img);
        const ret = F.newNode(flow, "flow.return", 300, 200); flow.nodes.push(ret);
        flow.edges.push({ id: "e1", from: { node: read.id, port: "photo" }, to: { node: img.id, port: "image" } }, { id: "e2", from: { node: read.id, port: "result" }, to: { node: ret.id, port: "value" } });
        const c = F.compileFlow(flow);
        const r = await runAdhoc({ lang, files: { [c.file]: c.code }, entry: { file: c.file, fn: "execute" }, inputs: {}, limits: { wallMs: 8000 } }, caller);
        expect(r.run.error, lang).toBeNull();
        expect(dev.seen[0], lang).toMatchObject({ op: "mrtd-read", args: { can: "654321", readPhoto: true, all: true } });
        const outs = r.run.outputs as Array<{ type: string; mime?: string; data?: string; text?: string }>;
        expect(outs[0], lang).toMatchObject({ type: "image", mime: "image/jpeg", data: jpeg });
        expect(String(outs[1].text), lang).toMatch(/^section,field,value/);
      } finally { dev.off(); }
    }
  }, 40_000);

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
