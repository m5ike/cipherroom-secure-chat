// @vitest-environment node
//
// The control plane at work (6.9): m5.telephony.inroute.* in JavaScript and
// Python (through the sandbox, the "inroute" right, the model's grant), and
// outbound enforcement on every call and SMS — the blocked numbers and
// countries, a rule's state, the per-caller hourly budget, the live-call
// limit, a SIP trunk's dial details and caller ID handed to the provider,
// the longest call, a TSA started when the call is answered (and resumed by
// its digits) or the fallback without the TSA runtime, and the app's own
// POST /api/telephony/call|sms. The providers' REST APIs are faked.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const dir = mkdtempSync(join(tmpdir(), "m5ctlout-"));
Object.assign(process.env, {
  DATA_DIR: dir, FUNCTIONS_DB_FILE: join(dir, "functions.db"), TELEPHONY_DB_FILE: join(dir, "telephony.db"), TELEPHONY_DATA_FILE: join(dir, "telephony.json"),
  PUBLIC_BASE_URL: "https://chat.test", TELEPHONY_FN_RATE: "1000", ENABLE_TELEPHONY: "1",
  TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000001", TWILIO_AUTH_TOKEN: "twilio-test-token", TWILIO_FROM: "+15005550006",
});

const express = (await import("express")).default;
const { functionsStore } = await import("../server/functions/store");
const { runAdhoc, execute, closeRunner } = await import("../server/functions/runner");
const { createPackage, saveDraft, publishDraft, saveModel } = await import("../server/functions/packages");
const { registerTelEngineRoutes } = await import("../server/telephony/tel-routes");
const { registerWebhookRoutes, twilioSignature } = await import("../server/telephony/webhooks");
const { registerTelephonyRoutes } = await import("../server/telephony/routes");
const { telStore } = await import("../server/telephony/tel-store");
const { clientConfigStore } = await import("../server/client-config");
const { adapter } = await import("../server/telephony/providers");
const { sipStore } = await import("../server/telephony/sip");
const { savePermissions, saveRules } = await import("../server/telephony/control/store");
const { liveOutboundCalls } = await import("../server/telephony/control/enforce");
const { telHooks } = await import("../server/telephony/control/hooks");
const { inrouteLookup } = await import("../server/telephony/control/inroute");

/* ------------------------------------------------------------ the fake provider */

type Sent = { url: string; body: string };
const sent: Sent[] = [];
const realFetch = globalThis.fetch;
let callSeq = 0;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);
  const body = init?.body instanceof URLSearchParams ? init.body.toString() : typeof init?.body === "string" ? init.body : "";
  sent.push({ url, body });
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  if (url.endsWith("/Calls.json")) return json({ sid: `CA${++callSeq}`, status: "queued" }, 201);
  if (url.endsWith("/Messages.json")) return json({ sid: "SM1", status: "queued", num_segments: "1" }, 201);
  return json({ message: "not faked" }, 404);
}) as typeof fetch;

let server: Server;
let base = "";
beforeAll(async () => {
  await functionsStore.ready();
  sipStore.create({ id: "prague1", label: "Prague", host: "sip.example.com", port: 5070, username: "m5", authUser: "m5auth", password: "trunk-secret", callerIdName: "Trunk", callerIdNumber: "+420222111999" });
  const app = express();
  const raw = { verify: (req: unknown, _res: unknown, buf: Buffer) => { (req as { rawBody?: Buffer }).rawBody = buf; } };
  app.use(express.urlencoded({ extended: false, ...raw }));
  app.use(express.json(raw));
  registerWebhookRoutes(app);
  registerTelEngineRoutes(app);
  registerTelephonyRoutes(app);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  closeRunner();
  globalThis.fetch = realFetch;
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  telStore.reset();
  rmSync(dir, { recursive: true, force: true });
});

const owner = { kind: "console" as const, account: "", name: "boss", groups: [], room: "r3.boss-room", client: "console", lang: "cs", tz: "UTC", adminRole: "owner" as const };
const run = (code: string, caller: Record<string, unknown> = owner, lang: "js" | "py" = "js") => {
  const file = lang === "py" ? "main.py" : "index.js";
  return runAdhoc({ lang, files: { [file]: code }, entry: { file, fn: "execute" }, inputs: {}, limits: { wallMs: 60_000 } }, caller as never);
};
const valueOf = (r: { values: unknown[]; run: { error: unknown } }) => { const v = r.values[0] as { type: string; value?: unknown; text?: string }; return v?.type === "text" ? v.text : v?.value; };
const tryJs = (body: string) => `export async function execute() { try { ${body} } catch (e) { return { code: e.code, message: e.message }; } }`;

async function twilio(path: string, params: Record<string, string>) {
  const url = new URL(path, "https://chat.test");
  const sig = twilioSignature(`https://chat.test${url.pathname}${url.search}`, params, "twilio-test-token");
  const r = await realFetch(`${base}${url.pathname}${url.search}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig }, body: new URLSearchParams(params) });
  return { status: r.status, text: await r.text() };
}
const pathOf = (u: string) => new URL(u).pathname + new URL(u).search;
const lastCall = () => Object.fromEntries(new URLSearchParams([...sent].reverse().find((s) => s.url.endsWith("/Calls.json"))!.body));

/* ------------------------------------------------------------------ the SDK */

describe("m5.telephony.inroute — JavaScript", () => {
  it("add (a random code for this run's room), list, del — the model's own codes", async () => {
    const r = await run(`export async function execute() {
      const a = await m5.telephony.inroute.add("", "room", 300, { label: "Lobby" });
      const b = await m5.telephony.inroute.add({ code: "52817", type: "user", user: "Eva", ttl: 120, maxUses: 1 });
      const listed = (await m5.telephony.inroute.list()).map((e) => e.code).sort();
      const removed = await m5.telephony.inroute.del(b);
      const again = await m5.telephony.inroute.delete(b.code);
      return { a, b, listed, removed, again, left: (await m5.telephony.inroute.list()).length };
    }`);
    expect(r.run.error).toBeNull();
    const v = valueOf(r) as { a: { code: string; room: string; ttlSec: number; label: string; createdBy: { kind: string; id: string } }; b: { code: string; type: string; user: string; maxUses: number; room: string }; listed: string[]; removed: boolean; again: boolean; left: number };
    expect(v.a).toMatchObject({ room: "r3.boss-room", ttlSec: 300, label: "Lobby", createdBy: { kind: "model", id: "draft:boss" } });
    expect(v.a.code).toMatch(/^\d{6}$/);
    expect(v.b).toMatchObject({ code: "52817", type: "user", user: "Eva", maxUses: 1, room: "r3.boss-room" });
    expect(v.listed).toEqual([v.a.code, "52817"].sort());
    expect([v.removed, v.again, v.left]).toEqual([true, false, 1]);
  }, 60_000);

  it("a user's \"user\" code is for themselves by default; a run without a room must name one; a taken code is refused", async () => {
    const alice = { kind: "user", account: "acc-alice", name: "alice", groups: ["user"], room: null, client: "c1", lang: "cs", tz: "UTC" };
    const noRoom = await run(tryJs(`return await m5.telephony.inroute.add(null, "user");`), alice);
    expect(valueOf(noRoom)).toMatchObject({ code: "bad-argument", message: expect.stringContaining("room") });
    const mine = await run(tryJs(`return await m5.telephony.inroute.add(null, "user", 60, { room: "r3.team" });`), alice);
    expect(valueOf(mine)).toMatchObject({ type: "user", user: "@alice", room: "r3.team", ttlSec: 60, createdBy: { id: "draft:acc-alice" } });
    await run(`export async function execute() { return await m5.telephony.inroute.add("60413", "room"); }`);
    expect(valueOf(await run(tryJs(`return await m5.telephony.inroute.add("60413", "room", 60, { room: "r3.x" });`), alice))).toMatchObject({ code: "code-taken" });
  }, 60_000);

  it("needs the inroute right: a person's (Modules & groups), a webhook run's model grant", async () => {
    const cfg = clientConfigStore.get();
    clientConfigStore.set({ ...cfg, modules: { ...cfg.modules, telephony: { enabled: true, defaultAccess: "deny", groupAccess: "allow", groups: [], grants: [{ group: "guest", rights: ["call"] }], log: "off" } } });
    try {
      const guest = { ...owner, kind: "guest", name: "someone", adminRole: undefined };
      expect(valueOf(await run(tryJs(`return await m5.telephony.inroute.list();`), guest))).toMatchObject({ code: "telephony-denied" });
      const hook = { kind: "webhook" as const, account: "", name: "webhook", groups: [], room: null, client: "webhook", lang: "en", tz: "UTC" };
      const code = `export async function execute() { try { return (await m5.telephony.inroute.add("", "room", 60, { room: "r3.hook" })).room; } catch (e) { return e.code; } }`;
      const model = (name: string, grants?: unknown) => {
        const pkg = createPackage(name, "js", "", "op");
        saveDraft(pkg.id, { "index.js": code }, {}, "op");
        const v = publishDraft(pkg.id, "minor", "op");
        return saveModel({ id: name, name, entry: `${name}@${v.version}:index.js#execute`, enabled: true, ...(grants ? { grants } : {}) } as never, "boss", "owner");
      };
      expect(valueOf(await execute(model("nocodes"), {}, hook, { executor: "webhook", skipValidation: true }))).toBe("telephony-denied");
      expect(valueOf(await execute(model("codes", { telephony: { enabled: true, rights: ["inroute"] } }), {}, hook, { executor: "webhook", skipValidation: true }))).toBe("r3.hook");
    } finally { clientConfigStore.set(cfg); }
  }, 60_000);
});

describe("m5.telephony.inroute — Python", () => {
  it("add with keywords, delete (del is a keyword), list", async () => {
    const r = await run([
      "async def execute(**inputs):",
      "    e = await m5.telephony.inroute.add(None, \"user\", 90, room=\"r3.py\", user=\"@bob\", max_uses=2, label=\"Bob\")",
      "    d = await m5.telephony.inroute.add({\"code\": \"73915\", \"type\": \"room\"})",
      "    codes = sorted(x[\"code\"] for x in await m5.telephony.inroute.list())",
      "    gone = await getattr(m5.telephony.inroute, \"del\")(d)",
      "    gone2 = await m5.telephony.inroute.delete(e[\"code\"])",
      "    return m5.out.json({\"e\": e, \"d\": d, \"codes\": codes, \"gone\": [gone, gone2], \"left\": len(await m5.telephony.inroute.list())})",
    ].join("\n"), owner, "py");
    expect(r.run.error).toBeNull();
    const v = valueOf(r) as { e: { code: string; type: string; user: string; maxUses: number; ttlSec: number; room: string; label: string }; d: { code: string; room: string }; codes: string[]; gone: boolean[]; left: number };
    expect(v.e).toMatchObject({ type: "user", user: "@bob", maxUses: 2, ttlSec: 90, room: "r3.py", label: "Bob" });
    expect(v.d).toMatchObject({ code: "73915", room: "r3.boss-room" });
    expect(v.codes).toEqual(expect.arrayContaining([v.e.code, "73915"]));
    expect(v.gone).toEqual([true, true]);
    expect(await inrouteLookup("73915")).toBeNull();
  }, 120_000);
});

describe("the Builder's Telephony › inroute.add / inroute.del / inroute.list", () => {
  it("a flow adds a code (JavaScript), lists and removes it (Python)", async () => {
    const F = await import("../server/functions/flow");
    const flowOf = (lang: "js" | "py", type: string, values: Record<string, unknown>, params: Record<string, unknown>, port: string) => {
      const flow = F.emptyFlow(lang);
      const n = F.newNode(flow, type, 0, 0);
      Object.assign(n.values!, values);
      Object.assign(n.params!, params);
      flow.nodes.push(n);
      const out = F.newNode(flow, "out.json", 300, 0);
      flow.nodes.push(out);
      flow.edges.push({ id: "e1", from: { node: n.id, port }, to: { node: out.id, port: "value" } });
      return flow;
    };
    const go = async (flow: ReturnType<typeof flowOf>) => {
      const c = F.compileFlow(flow);
      const r = await runAdhoc({ lang: flow.lang, files: { [c.file]: c.code }, entry: { file: c.file, fn: "execute" }, inputs: {}, limits: { wallMs: 60_000 } }, owner as never);
      expect(r.run.error, c.code).toBeNull();
      return (r.outputs[0] as { value: unknown }).value;
    };
    const entry = await go(flowOf("js", "tel.inroute.add", { code: "38475", room: "r3.flow" }, { type: "room", ttl: 120, label: "Flow", maxUses: 3 }, "entry"));
    expect(entry).toMatchObject({ code: "38475", room: "r3.flow", ttlSec: 120, label: "Flow", maxUses: 3 });
    const random = await go(flowOf("py", "tel.inroute.add", {}, { type: "room", digits: "4" }, "code"));
    expect(random).toMatch(/^\d{4}$/);
    expect(await go(flowOf("py", "tel.inroute.list", {}, {}, "count"))).toBeGreaterThanOrEqual(2);
    expect(await go(flowOf("py", "tel.inroute.del", { code: "38475" }, {}, "removed"))).toBe(true);
    expect(await go(flowOf("js", "tel.inroute.del", { code: String(random) }, {}, "removed"))).toBe(true);
  }, 120_000);
});

describe("the tutorial's route-code lessons", () => {
  it("run and meet their checks (JavaScript and Python)", async () => {
    const { LESSONS } = await import("../server/functions/tutorial");
    for (const id of ["inroute", "inroute-py"]) {
      const l = LESSONS.find((x) => x.id === id)!;
      const r = await run(l.sample, { ...owner, room: null }, l.lang);
      expect(r.run.error, id).toBeNull();
      const text = r.outputs.map((o) => (o as { text?: string; value?: unknown }).text ?? JSON.stringify((o as { value?: unknown }).value ?? "")).join(" ");
      expect(text, id).toContain(l.expect!);
    }
  }, 120_000);
});

/* ------------------------------------------------------------ enforcement */

describe("outbound calls and SMS go through the permissions and the rules", () => {
  it("blocked numbers and countries are refused before any provider is asked", async () => {
    sent.length = 0;
    expect(valueOf(await run(tryJs(`return await m5.telephony.call({ to: "+19005550100", say: "x" });`)))).toMatchObject({ code: "route-refused", message: expect.stringContaining("+1900*") });
    expect(savePermissions({ outbound: { countries: ["CZ"] } }, "test").ok).toBe(true);
    expect(valueOf(await run(tryJs(`return await m5.telephony.sms({ to: "+4930123456", text: "x" });`)))).toMatchObject({ code: "route-refused", message: expect.stringContaining("only to CZ") });
    expect(sent).toEqual([]);
    expect(savePermissions({ outbound: { countries: [] } }, "test").ok).toBe(true);
  }, 60_000);

  it("a rule's state refuses with the rule's name; a SIP trunk rule hands the provider the trunk and the caller ID; the longest call is the limit", async () => {
    expect(saveRules("outbound", [
      { id: "no-de", label: "No Germany", match: { to: ["+49*"] }, service: { kind: "app", provider: "twilio" }, target: { kind: "state", state: "busy" } },
      { id: "cz", label: "Czech over the trunk", match: { to: ["+420*"] }, service: { kind: "sip", provider: "twilio", trunk: "prague1", callerId: { number: "+420222111000", name: "M5cet", presentation: "allowed" } }, target: { kind: "pass" } },
    ], "test").ok).toBe(true);
    expect(savePermissions({ outbound: { maxMinutes: 5 } }, "test").ok).toBe(true);
    const refused = valueOf(await run(tryJs(`return await m5.telephony.call({ to: "+4930123456", say: "x" });`)));
    expect(refused).toMatchObject({ code: "route-refused", message: "the outbound rule \"No Germany\" refuses it (busy)" });

    const tw = adapter("twilio")!;
    const spy = vi.spyOn(tw, "placeCall");
    try {
      const r = await run(`export async function execute() { const c = await m5.telephony.call({ to: "+420603123456", say: "Ahoj", from: "+15005550006" }); return c; }`);
      expect(r.run.error).toBeNull();
      const input = spy.mock.calls.at(-1)![0];
      expect(input).toMatchObject({
        to: "+420603123456", from: "+420222111000", timeLimit: 300,
        via: { kind: "sip", trunk: { id: "prague1", host: "sip.example.com:5070", username: "m5auth", password: "trunk-secret" }, callerName: "M5cet", presentation: "allowed" },
      });
      const call = telStore.calls.list({ limit: 1 })[0];
      expect(call).toMatchObject({ from: "+420222111000", by: "admin:boss", route: { rule: "cz", service: "sip", target: "pass" }, timeLimitSec: 300 });
      // The trunk's password is never in a log.
      expect(JSON.stringify(telStore.log.list({ limit: 500 }))).not.toContain("trunk-secret");
    } finally { spy.mockRestore(); }
    expect(saveRules("outbound", [], "test").ok).toBe(true);
  }, 60_000);

  it("the hourly budget is per caller; the live-call limit is the module's", async () => {
    expect(savePermissions({ outbound: { callsPerHour: 2, smsPerHour: 1 } }, "test").ok).toBe(true);
    const counter = { ...owner, name: "counter" };
    const three = await run(`export async function execute() { const out = []; for (let i = 0; i < 3; i++) { try { await m5.telephony.call({ to: "+420603000111", say: "x" }); out.push("ok"); } catch (e) { out.push(e.code); } } return out; }`, counter);
    expect(valueOf(three)).toEqual(["ok", "ok", "telephony-limit"]);
    // Someone else has their own budget.
    expect(valueOf(await run(tryJs(`return (await m5.telephony.call({ to: "+420603000111", say: "x" })).status;`), { ...owner, name: "other" }))).toBe("queued");
    const sms = await run(`export async function execute() { const out = []; for (let i = 0; i < 2; i++) { try { await m5.telephony.sms({ to: "+420603000111", text: "x" }); out.push("ok"); } catch (e) { out.push(e.code); } } return out; }`, { ...owner, name: "texter" });
    expect(valueOf(sms)).toEqual(["ok", "telephony-limit"]);
    expect(savePermissions({ outbound: { callsPerHour: 1000, smsPerHour: 1000, maxConcurrentCalls: Math.max(1, await liveOutboundCalls()) } }, "test").ok).toBe(true);
    expect(valueOf(await run(tryJs(`return await m5.telephony.call({ to: "+420603000222", say: "x" });`), { ...owner, name: "late" }))).toMatchObject({ code: "telephony-busy" });
    expect(savePermissions({ outbound: { maxConcurrentCalls: 1000 } }, "test").ok).toBe(true);
  }, 60_000);

  it("6.10 (G-06): a TSA's SMS / Dial go through the same checks as m5.telephony — as tsa:<id>, your own countries when none are set, rules, time limit", async () => {
    const { realDeps } = await import("../server/telephony/tsa/deps");
    const { ownCountries, ownNumbers } = await import("../server/telephony/control/enforce");
    // TWILIO_FROM (+1500…) and the SIP trunk's numbers are yours; the number a call came in on too.
    expect(ownNumbers()).toContain("+15005550006");
    expect(ownCountries()).toContain("US");
    expect(ownCountries(["+420222333444"])).toEqual(expect.arrayContaining(["CZ", "US"]));
    expect(savePermissions({ outbound: { countries: [], callsPerHour: 1000, smsPerHour: 2, maxMinutes: 30 } }, "test").ok).toBe(true);
    const own = ["+420222333444"];
    // Abroad (no countries set): refused for the TSA, while a function may (empty = any for it).
    expect(await realDeps.outbound({ kind: "sms", to: "+2348031234567", tsa: "ivr", provider: "twilio", own, dry: false })).toMatchObject({ ok: false, code: "route-refused", message: expect.stringMatching(/only your own countries/) });
    expect(await realDeps.outbound({ kind: "call", to: "+420603000111", tsa: "ivr", provider: "twilio", own, dry: false, timeLimitSec: 99_999 })).toMatchObject({ ok: true, timeLimitSec: 1800 });
    // A rule that refuses refuses the TSA's transfer too (6.9: the Dial skipped the rules when not routed "through the rules").
    expect(saveRules("outbound", [{ id: "no-cz-mobile", label: "No CZ mobiles", match: { to: ["+420603*"] }, service: { kind: "app", provider: "twilio" }, target: { kind: "state", state: "rejected" } }], "test").ok).toBe(true);
    expect(await realDeps.outbound({ kind: "call", to: "+420603000111", tsa: "ivr", provider: "twilio", own, dry: true })).toMatchObject({ ok: false, message: "the outbound rule \"No CZ mobiles\" refuses it (rejected)" });
    expect(saveRules("outbound", [], "test").ok).toBe(true);
    // The SMS itself goes as "tsa:<id>": its own hourly budget, the countries again.
    sent.length = 0;
    await realDeps.sendSms({ to: "+420603000111", text: "díky", tsa: "ivr", own });
    await realDeps.sendSms({ to: "+420603000112", text: "díky", tsa: "ivr", own });
    await expect(realDeps.sendSms({ to: "+420603000113", text: "díky", tsa: "ivr", own })).rejects.toMatchObject({ code: "telephony-limit" });
    await expect(realDeps.sendSms({ to: "+2348031234567", text: "díky", tsa: "other", own })).rejects.toMatchObject({ code: "route-refused" });
    expect(telStore.messages.list({ limit: 5 }).filter((m) => m.by === "tsa:ivr")).toHaveLength(2);
    // * opens the world, for a TSA too.
    expect(savePermissions({ outbound: { countries: ["*"], smsPerHour: 1000 } }, "test").ok).toBe(true);
    expect(await realDeps.outbound({ kind: "sms", to: "+2348031234567", tsa: "ivr", provider: "twilio", own, dry: true })).toMatchObject({ ok: true });
    expect(savePermissions({ outbound: { countries: [] } }, "test").ok).toBe(true);
  }, 60_000);

  it("a TSA target: the answered call runs the TSA, its digits resume it; without the runtime the call keeps its own logic", async () => {
    expect(saveRules("outbound", [{ id: "survey", label: "Survey", match: { to: ["+420777*"] }, service: { kind: "app", provider: "twilio" }, target: { kind: "tsa", tsa: "survey" } }], "test").ok).toBe(true);
    const started: unknown[] = [];
    const resumed: unknown[] = [];
    telHooks.tsa = {
      // The runtime's own callback URL (/wh/tel/<token>/tsa?s=<session>&n=<node>), driven by control/calls.ts.
      start: async (call, tsaId) => { started.push({ call, tsaId }); return { session: { id: "tsa-s1", status: "waiting" } as never, actions: [{ say: { text: "Rate us 1 to 5" } }, { gather: { action: `https://chat.test/wh/tel/${call.token}/tsa?s=tsa-s1&n=rate`, digits: 1 } }] }; },
      resume: async (session, event) => { resumed.push({ session, event }); return { session: { id: session, status: "ended" } as never, actions: [{ say: { text: "Thank you" } }, { hangup: {} }] }; },
    };
    try {
      sent.length = 0;
      expect((await run(`export async function execute() { return (await m5.telephony.call({ to: "+420777123456", say: "not this" })).id; }`)).run.error).toBeNull();
      const f = lastCall();
      const answer = await twilio(pathOf(f.Url), { CallSid: `CA${callSeq}`, CallStatus: "in-progress" });
      expect(answer.text).toContain("Rate us 1 to 5");
      expect(answer.text).not.toContain("not this");
      expect(started).toEqual([{ call: expect.objectContaining({ direction: "outbound", to: "+420777123456", provider: "twilio" }), tsaId: "survey" }]);
      const action = /action="([^"]+)"/.exec(answer.text)![1].replace(/&amp;/g, "&");
      const next = await twilio(pathOf(action), { CallSid: `CA${callSeq}`, CallStatus: "in-progress", Digits: "5" });
      expect(next.text).toContain("Thank you");
      expect(next.text).toContain("<Hangup");
      expect(resumed).toEqual([{ session: "tsa-s1", event: expect.objectContaining({ kind: "digits", digits: "5" }) }]);
      expect(telStore.calls.list({ limit: 1 })[0].tsa).toMatchObject({ id: "survey", session: "tsa-s1" });
    } finally { telHooks.tsa = undefined; }

    // No TSA runtime in this process: the call says its own text (and the log says why).
    sent.length = 0;
    await run(`export async function execute() { return (await m5.telephony.call({ to: "+420777123457", say: "Fallback text" })).id; }`);
    const answer = await twilio(pathOf(lastCall().Url), { CallSid: `CA${callSeq}`, CallStatus: "in-progress" });
    expect(answer.text).toContain("Fallback text");
    expect(telStore.log.list({ limit: 50 }).some((e) => /TSA runtime is not loaded/.test(e.summary))).toBe(true);
    expect(saveRules("outbound", [], "test").ok).toBe(true);
  }, 60_000);
});

describe("the app's POST /api/telephony/call|sms", () => {
  const post = async (path: string, body: unknown) => { const r = await realFetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() as Record<string, unknown> }; };

  it("6.10 (G-04): without a rule for the module (\"on for everyone\") nobody may call or text through the app", async () => {
    const cfg = clientConfigStore.get();
    const { telephony: _t, ...rest } = cfg.modules;
    clientConfigStore.set({ ...cfg, modules: rest });
    try {
      expect(await post("/api/telephony/call", { to: "+420603999111" })).toMatchObject({ status: 403, body: { code: "module-denied" } });
      expect(await post("/api/telephony/sms", { to: "+420603999111", text: "x" })).toMatchObject({ status: 403, body: { code: "module-denied" } });
      expect(telStore.calls.list({ limit: 1000, filter: (c) => c.to === "+420603999111" })).toEqual([]);
    } finally { clientConfigStore.set(cfg); }
  });

  it("refuses a blocked number and a rule's state; a SIP trunk rule places the call through the engine", async () => {
    // 6.10 (G-04): the operator's rule lets guests (the app sends no account token) call and text.
    const cfg = clientConfigStore.get();
    clientConfigStore.set({ ...cfg, modules: { ...cfg.modules, telephony: { enabled: true, defaultAccess: "deny", groupAccess: "allow", groups: [], grants: [{ group: "guest", rights: ["call", "sms"] }], log: "off" } } });
    try {
    expect(await post("/api/telephony/call", { to: "+19005550100" })).toMatchObject({ status: 403, body: { code: "route-refused" } });
    expect(saveRules("outbound", [
      { id: "closed", label: "Closed", match: { to: ["+4930*"] }, service: { kind: "app", provider: "twilio" }, target: { kind: "state", state: "congestion" } },
      { id: "trunk", label: "Trunk", match: { to: ["+420*"] }, service: { kind: "sip", provider: "twilio", trunk: "prague1", callerId: { number: "", name: "", presentation: "restricted" } }, target: { kind: "pass" } },
    ], "test").ok).toBe(true);
    expect(await post("/api/telephony/sms", { to: "+19005550100", text: "x" })).toMatchObject({ status: 403, body: { code: "route-refused" } });
    expect(await post("/api/telephony/call", { to: "+4930123456" })).toMatchObject({ status: 403, body: { code: "route-refused", message: expect.stringContaining("Closed") } });
    const viaTrunk = await post("/api/telephony/call", { to: "+420603123456" });
    expect(viaTrunk).toMatchObject({ status: 200, body: { ok: true, trunk: "prague1", provider: "twilio" } });
    // The trunk's own caller ID when the rule leaves it empty.
    expect(telStore.calls.get(String(viaTrunk.body.id))).toMatchObject({ from: "+420222111999", by: expect.stringMatching(/^ip:/), route: { rule: "trunk", service: "sip" } });
    expect(saveRules("outbound", [], "test").ok).toBe(true);
    } finally { clientConfigStore.set(cfg); }
  }, 60_000);
});
