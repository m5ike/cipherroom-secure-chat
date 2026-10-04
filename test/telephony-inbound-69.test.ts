// @vitest-environment node
//
// 6.9 inbound calls through the rules and calls that run a TSA, end to end on
// a live express app (the main service's /wh routes), with a fake rules part
// (telHooks.decide), a fake TSA runtime (telHooks.tsa) and faked provider
// APIs: the decision paths (state / TSA / a lent bridge DID / no hooks /
// limits / the test SIP address), the TSA callbacks per provider turned into
// TsaEvents, and the Telnyx Call Control flow driven by its webhooks.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const dir = mkdtempSync(join(tmpdir(), "m5tel69-"));
Object.assign(process.env, {
  DATA_DIR: dir, TELEPHONY_DB_FILE: join(dir, "telephony.db"), TELEPHONY_DATA_FILE: join(dir, "telephony.json"),
  PUBLIC_BASE_URL: "https://chat.test",
  TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000001", TWILIO_AUTH_TOKEN: "twilio-test-token", TWILIO_FROM: "+15005550006",
  TELNYX_API_KEY: "KEY-test", TELNYX_CONNECTION_ID: "conn-1", TELNYX_FROM: "+15005550007",
  // Telnyx / Vonage webhooks are unsigned here: 6.10 (G-01) lets them drive calls only when allowed.
  TELEPHONY_ALLOW_UNSIGNED: "1",
});
delete process.env.TELNYX_PUBLIC_KEY;
delete process.env.VONAGE_SIGNATURE_SECRET;
delete process.env.TELEPHONY_DID_POOL;
delete process.env.VONAGE_FROM;

const express = (await import("express")).default;
const { registerWebhookRoutes, twilioSignature } = await import("../server/telephony/webhooks");
const { registerTelEngineRoutes } = await import("../server/telephony/tel-routes");
const { telStore, telId, telToken } = await import("../server/telephony/tel-store");
const { telHooks } = await import("../server/telephony/control/hooks");
const { DEFAULT_PERMISSIONS } = await import("../server/telephony/control/types");
const { tsaEventFromCallback, tsaFixups, previewActions, isTestSipCall, e164 } = await import("../server/telephony/control/calls");
const { loadTelephonyFile, saveTelephonyFile } = await import("../server/telephony/store");
const { queryLog, logFlushed } = await import("../server/telephony/control/log");
type CallAction = import("../server/telephony/providers/types").CallAction;
type TsaEvent = import("../server/telephony/tsa/types").TsaEvent;
type TsaCallRef = import("../server/telephony/control/hooks").TsaCallRef;
type RouteDecision = import("../server/telephony/control/types").RouteDecision;
type RouteQuestion = import("../server/telephony/control/types").RouteQuestion;

/* ------------------------------------------------------- faked provider APIs */

type Sent = { url: string; method: string; body: string };
const sent: Sent[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);
  sent.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "" });
  return new Response(JSON.stringify({ data: { result: "ok" } }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
const telnyxCmds = () => sent.filter((s) => s.url.startsWith("https://api.telnyx.com/v2/calls/")).map((s) => ({ cmd: s.url.split("/actions/")[1], body: s.body ? JSON.parse(s.body) as Record<string, unknown> : {} }));

/* ----------------------------------------------------- the fake rules + TSA */

let routes: Record<string, RouteDecision["target"]> = {};
const decide = vi.fn(async (q: RouteQuestion): Promise<RouteDecision> => {
  const target = routes[q.to] ?? { kind: "state", state: "busy" };
  return { direction: q.direction, rule: routes[q.to] ? `r-${q.to}` : null, ruleLabel: routes[q.to] ? "test rule" : "default", service: null, target, reasons: [] };
});

/** What the fake runtime answers: per session, a script of turns (the first for start, then one per event). */
type Script = (call: TsaCallRef, s: string, ev: TsaEvent | null, step: number) => CallAction[];
let script: Script = () => [{ hangup: {} }];
const sessions = new Map<string, { call: TsaCallRef; step: number }>();
let nextSession = 0;
const turnOf = (id: string, call: TsaCallRef, actions: CallAction[]) => ({
  session: { id, tsaId: "ivr", tsaVersion: 1, callId: call.id, provider: call.provider, direction: call.direction, call: { id: call.id, from: call.from, to: call.to, did: call.did, direction: call.direction, provider: call.provider }, vars: {}, values: {}, at: "n", waiting: null, loops: [], steps: 1, status: actions.some((a) => "hangup" in a) ? "ended" as const : "waiting" as const, startedAt: 0, updatedAt: 0, endedAt: null, trace: [] },
  actions,
});
const tsa = {
  start: vi.fn(async (call: TsaCallRef, _tsaId: string) => {
    const id = `ses${++nextSession}`;
    sessions.set(id, { call, step: 0 });
    return turnOf(id, call, script(call, id, null, 0));
  }),
  resume: vi.fn(async (s: string, ev: TsaEvent) => {
    const st = sessions.get(s)!;
    st.step += 1;
    return turnOf(s, st.call, script(st.call, s, ev, st.step));
  }),
};
const u = (call: { token: string }, s: string, n: string, extra = "") => `https://chat.test/wh/tel/${call.token}/tsa?s=${s}&n=${n}${extra}`;

/* ------------------------------------------------------------ the service */

let server: Server;
let base = "";
beforeAll(async () => {
  const app = express();
  const raw = { verify: (req: unknown, _res: unknown, buf: Buffer) => { (req as { rawBody?: Buffer }).rawBody = buf; } };
  app.use(express.urlencoded({ extended: false, ...raw }));
  app.use(express.json(raw));
  registerWebhookRoutes(app);
  registerTelEngineRoutes(app);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  for (const k of ["decide", "tsa", "permissions"] as const) delete telHooks[k];
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

let perms = structuredClone(DEFAULT_PERMISSIONS);
beforeEach(() => {
  perms = structuredClone(DEFAULT_PERMISSIONS);
  perms.inbound = { maxConcurrentCalls: 1000, perCallerPerHour: 1000 };
  telHooks.permissions = () => perms;
  telHooks.decide = decide;
  telHooks.tsa = tsa;
  routes = {};
  decide.mockClear(); tsa.start.mockClear(); tsa.resume.mockClear();
  sent.length = 0;
});

/** A webhook as Twilio sends it: form-encoded, signed over the public URL (query included). */
async function twilio(pathOrUrl: string, params: Record<string, string>) {
  const url = new URL(pathOrUrl, "https://chat.test");
  const sig = twilioSignature(`https://chat.test${url.pathname}${url.search}`, params, "twilio-test-token");
  const r = await realFetch(`${base}${url.pathname}${url.search}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig }, body: new URLSearchParams(params) });
  return { status: r.status, text: await r.text() };
}
async function post(pathOrUrl: string, body: unknown) {
  const url = new URL(pathOrUrl, "https://chat.test");
  const r = await realFetch(`${base}${url.pathname}${url.search}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text, json: text ? JSON.parse(text) as unknown : null };
}
const telnyx = (event_type: string, payload: Record<string, unknown>) => ({ data: { record_type: "event", event_type, id: `${event_type}-${Math.random().toString(36).slice(2)}`, occurred_at: new Date().toISOString(), payload } });
let callSeq = 0;
const cid = (p: string) => `${p}${++callSeq}${Date.now().toString(36)}`;

/* ================================================================ decisions */

describe("inbound calls through the rules", () => {
  it("without the rules part, Twilio's voice webhook answers as before (the greeting)", async () => {
    delete telHooks.decide;
    const r = await twilio("/wh/twilio/voice", { CallSid: cid("CA"), From: "+420777000001", To: "+15005550006", Direction: "inbound", CallStatus: "ringing" });
    expect(r.text).toContain("<Say>");
    expect(decide).not.toHaveBeenCalled();
  });

  it("a state (busy): Twilio <Reject>, the call recorded as busy, the decision logged", async () => {
    const sid = cid("CA");
    const r = await twilio("/wh/twilio/voice", { CallSid: sid, From: "+420777000002", To: "+15005550006", Direction: "inbound", CallStatus: "ringing" });
    expect(r.text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="busy"/></Response>');
    expect(decide).toHaveBeenCalledWith({ direction: "inbound", from: "+420777000002", to: "+15005550006", provider: "twilio", service: "app" });
    const call = telStore.callByProviderId("twilio", sid);
    expect(call).toMatchObject({ direction: "inbound", status: "busy", from: "+420777000002" });
    await logFlushed();
    const [route] = (await queryLog({ kind: "route", callId: call!.id })).entries;
    expect(route.summary).toContain("busy");
  });

  it("states per provider: hangup → <Hangup/>, rejected → <Reject reason=\"rejected\"/>; Vonage ends the NCCO; Telnyx sends reject / hangup", async () => {
    routes["+15005550010"] = { kind: "state", state: "hangup" };
    routes["+15005550011"] = { kind: "state", state: "rejected" };
    expect((await twilio("/wh/twilio/voice", { CallSid: cid("CA"), From: "+420777000003", To: "+15005550010", Direction: "inbound" })).text).toContain("<Response><Hangup/></Response>");
    expect((await twilio("/wh/twilio/voice", { CallSid: cid("CA"), From: "+420777000003", To: "+15005550011", Direction: "inbound" })).text).toContain('<Reject reason="rejected"/>');
    const v = await post("/wh/vonage/answer", { uuid: cid("vu"), conversation_uuid: "c", from: "420777000004", to: "15005550012" });
    expect(v.json).toEqual([]);
    expect(decide).toHaveBeenLastCalledWith(expect.objectContaining({ from: "+420777000004", to: "+15005550012", provider: "vonage" }));
    const id = cid("v3:");
    await post("/wh/telnyx/events", telnyx("call.initiated", { call_control_id: id, direction: "incoming", from: "+420777000005", to: "+15005550013", state: "parked" }));
    expect(telnyxCmds()).toEqual([{ cmd: "reject", body: { cause: "USER_BUSY", client_state: expect.any(String) } }]);
  });

  it("a number lent by the audio bridge keeps the bridge (the rules are not asked)", async () => {
    const now = Date.now();
    telStore.bridges.put({ id: telId("tb"), clientToken: telToken(), mediaToken: telToken(), number: "+15005550099", provider: "twilio", code: "54321", roomHash: "0123456789abcdef", member: { name: "Eva" }, label: "", mode: "auto", language: "en", voice: "", status: "waiting", createdAt: now, expiresAt: now + 600_000, connectedAt: null, endedAt: null, maxCallSec: 600, attempts: [], callId: "", caller: "t", owner: null, channel: "", stats: { heardSegments: 0, spokenReplies: 0, audioInSec: 0, audioOutSec: 0 }, bought: false, numberId: "" });
    const r = await twilio("/wh/twilio/voice", { CallSid: cid("CA"), From: "+420777000006", To: "+15005550099", Direction: "inbound" });
    expect(r.text).toContain("five-digit access code");
    expect(decide).not.toHaveBeenCalled();
  });

  it("limits: a caller over permissions.inbound.perCallerPerHour gets busy without the rules being asked", async () => {
    routes["+15005550020"] = { kind: "tsa", tsa: "ivr" };
    script = () => [{ say: { text: "Hi" } }, { hangup: {} }];
    perms.inbound.perCallerPerHour = 2;
    for (let i = 0; i < 2; i++) expect((await twilio("/wh/twilio/voice", { CallSid: cid("CA"), From: "+420777000007", To: "+15005550020", Direction: "inbound" })).text).toContain("<Say>Hi</Say>");
    decide.mockClear();
    const r = await twilio("/wh/twilio/voice", { CallSid: cid("CA"), From: "+420777000007", To: "+15005550020", Direction: "inbound" });
    expect(r.text).toContain('<Reject reason="busy"/>');
    expect(decide).not.toHaveBeenCalled();
  });

  it("a call to the test SIP address routes as its test DID over the service sip", async () => {
    const { data } = loadTelephonyFile();
    saveTelephonyFile({ ...data, testSip: { provider: "twilio", uri: "sip:test-abc123@m5cet-1.sip.twilio.com", did: "+000100", setup: { resource: "SD1|CL1", at: 1, by: "t" }, username: "m5test", enabled: true } });
    routes["+000100"] = { kind: "state", state: "busy" };
    await twilio("/wh/twilio/voice", { CallSid: cid("CA"), From: "sip:alice@10.0.0.1", To: "sip:test-abc123@m5cet-1.sip.twilio.com;transport=tls", Direction: "inbound", SipDomain: "m5cet-1.sip.twilio.com" });
    expect(decide).toHaveBeenCalledWith({ direction: "inbound", from: "sip:alice@10.0.0.1", to: "+000100", provider: "twilio", service: "sip" });
    // Another user at that domain is a SIP call too, routed by its URI.
    await twilio("/wh/twilio/voice", { CallSid: cid("CA"), From: "sip:alice@10.0.0.1", To: "sip:other@m5cet-1.sip.twilio.com", Direction: "inbound" });
    expect(decide).toHaveBeenLastCalledWith(expect.objectContaining({ to: "sip:other@m5cet-1.sip.twilio.com", service: "sip" }));
    saveTelephonyFile({ ...loadTelephonyFile().data, testSip: null });
  });

  it("a TSA without its runtime: answered as before", async () => {
    delete telHooks.tsa;
    routes["+15005550006"] = { kind: "tsa", tsa: "ivr" };
    const r = await twilio("/wh/twilio/voice", { CallSid: cid("CA"), From: "+420777000008", To: "+15005550006", Direction: "inbound" });
    expect(r.text).toContain("<Say>");
  });

  it("an outbound call answered at the voice URL is not routed as inbound", async () => {
    await twilio("/wh/twilio/voice", { CallSid: cid("CA"), From: "+15005550006", To: "+420777000009", Direction: "outbound-api", CallStatus: "in-progress" });
    expect(decide).not.toHaveBeenCalled();
  });
});

/* ====================================================== 6.10 G-01: unsigned */

describe("6.10 (G-01): an unsigned call webhook never reaches the rules, a TSA or the bridge", () => {
  beforeEach(() => { delete process.env.TELEPHONY_ALLOW_UNSIGNED; });
  afterAll(() => { process.env.TELEPHONY_ALLOW_UNSIGNED = "1"; });

  it("a forged Vonage answer and a forged Telnyx call.initiated (no webhook key) start nothing", async () => {
    routes["+15005550030"] = { kind: "tsa", tsa: "ivr" };
    script = () => [{ gather: { action: "x", input: ["dtmf"], digits: 6 } }];
    const v = await post("/wh/vonage/answer", { uuid: cid("vu"), conversation_uuid: "c", from: "420777000031", to: "15005550030" });
    expect(v.status).toBe(200);
    // The pre-6.9 greeting, no NCCO with a TSA callback (that would hand the forger the call's capability).
    expect(v.text).not.toContain("/wh/tel/");
    await post("/wh/telnyx/events", telnyx("call.initiated", { call_control_id: cid("v3:"), direction: "incoming", from: "+420777000032", to: "+15005550030", state: "parked" }));
    await post("/wh/tel/in/vonage", { uuid: cid("vu"), conversation_uuid: "c", from: "420777000033", to: "15005550030" });
    expect(decide).not.toHaveBeenCalled();
    expect(tsa.start).not.toHaveBeenCalled();
    expect(telnyxCmds()).toEqual([]);
    await logFlushed();
    const { entries } = await queryLog({ kind: "webhook", provider: "vonage" });
    expect(entries.some((e) => /unsigned call webhook ignored \(set VONAGE_SIGNATURE_SECRET\)/.test(e.summary))).toBe(true);
  });

  it("a signed Twilio webhook still goes through the rules; TELEPHONY_ALLOW_UNSIGNED=1 lets unsigned ones in", async () => {
    routes["+15005550031"] = { kind: "state", state: "busy" };
    expect((await twilio("/wh/twilio/voice", { CallSid: cid("CA"), From: "+420777000034", To: "+15005550031", Direction: "inbound" })).text).toContain('<Reject reason="busy"/>');
    expect(decide).toHaveBeenCalledTimes(1);
    process.env.TELEPHONY_ALLOW_UNSIGNED = "1";
    await post("/wh/vonage/answer", { uuid: cid("vu"), conversation_uuid: "c", from: "420777000035", to: "15005550031" });
    expect(decide).toHaveBeenCalledTimes(2);
  });
});

/* ================================================================== Twilio */

describe("Twilio TSA calls", () => {
  it("first turn with a timeout redirect; digits, a timeout, a dial and a recording resume the session; the hangup status ends it", async () => {
    routes["+15005550006"] = { kind: "tsa", tsa: "ivr" };
    script = (call, s, ev, step) => {
      if (step === 0) return [{ say: { text: "Hello" } }, { gather: { action: u(call, s, "menu"), digits: 1, timeout: 5 } }];
      if (ev?.kind === "digits" && !ev.timedOut) return [{ dial: { to: "+420777999000", kind: "number", action: u(call, s, "dial"), callerId: "+15005550006" } }];
      if (ev?.kind === "dial") return [{ record: { action: u(call, s, "rec"), maxSeconds: 30, finishOnKey: "#" } }];
      return [{ say: { text: "Bye" } }, { redirect: { url: u(call, s, "bye", "&e=played") } }];
    };
    const sid = cid("CA");
    const first = await twilio("/wh/twilio/voice", { CallSid: sid, From: "+420777000010", To: "+15005550006", Direction: "inbound", CallStatus: "ringing" });
    const call = telStore.callByProviderId("twilio", sid)!;
    expect(call.tsa).toMatchObject({ id: "ivr", did: "+15005550006", service: "app", status: "running" });
    const s = call.tsa!.session;
    expect(tsa.start).toHaveBeenCalledWith({ id: call.id, token: call.token, provider: "twilio", direction: "inbound", from: "+420777000010", to: "+15005550006", did: "+15005550006" }, "ivr");
    const menu = u(call, s, "menu").replace(/&/g, "&amp;");
    expect(first.text).toBe(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>Hello</Say><Gather input="dtmf" action="${menu}" method="POST" timeout="5"></Gather><Redirect method="POST">${menu}&amp;timeout=digits</Redirect></Response>`);

    const timeout = await twilio(`${u(call, s, "menu")}&timeout=digits`, { CallSid: sid, CallStatus: "in-progress" });
    expect(tsa.resume).toHaveBeenLastCalledWith(s, { kind: "digits", digits: "", timedOut: true });
    expect(timeout.text).toContain("<Say>Bye</Say>");

    const pressed = await twilio(u(call, s, "menu"), { CallSid: sid, CallStatus: "in-progress", Digits: "1", FinishedOnKey: "" });
    expect(tsa.resume).toHaveBeenLastCalledWith(s, { kind: "digits", digits: "1" });
    expect(pressed.text).toContain('<Dial action="');
    expect(pressed.text).toContain('callerId="+15005550006"><Number>+420777999000</Number></Dial>');

    const dialed = await twilio(u(call, s, "dial"), { CallSid: sid, DialCallStatus: "completed", DialCallDuration: "33" });
    expect(tsa.resume).toHaveBeenLastCalledWith(s, { kind: "dial", status: "answered", durationSec: 33 });
    expect(dialed.text).toContain(`&amp;timeout=recording</Redirect>`);

    await twilio(u(call, s, "rec"), { CallSid: sid, RecordingUrl: "https://api.twilio.com/rec/RE1", RecordingSid: "RE1", RecordingDuration: "4", Digits: "#" });
    expect(tsa.resume).toHaveBeenLastCalledWith(s, { kind: "recording", url: "https://api.twilio.com/rec/RE1", id: "RE1", durationSec: 4, digit: "#" });

    const played = await twilio(`${u(call, s, "bye")}&e=played`, { CallSid: sid });
    expect(tsa.resume).toHaveBeenLastCalledWith(s, { kind: "played" });
    expect(played.status).toBe(200);

    expect((await twilio("/wh/tel/" + call.token + "/tsa?s=other&n=x", { CallSid: sid, Digits: "1" })).status).toBe(404);

    await twilio("/wh/twilio/voice_status", { CallSid: sid, CallStatus: "completed", CallDuration: "61", CallbackSource: "call-progress-events", Direction: "inbound" });
    expect(tsa.resume).toHaveBeenLastCalledWith(s, { kind: "hangup", cause: "completed" });
    expect(telStore.calls.get(call.id)).toMatchObject({ status: "completed", durationSec: 61, tsa: { status: "ended" } });
    await logFlushed();
    expect((await queryLog({ kind: "tsa", callId: call.id })).entries.length).toBeGreaterThanOrEqual(6);
  });

  it("an outbound call that runs a TSA: its answer webhook starts the flow, its final status ends it", async () => {
    const { placeCall } = await import("../server/telephony/engine");
    script = (call, s, _ev, step) => (step === 0 ? [{ gather: { action: u(call, s, "q"), input: ["speech"], language: "cs-CZ" } }] : [{ hangup: {} }]);
    const call = await placeCall({ to: "+420777000050", provider: "twilio", owner: null, tsa: { id: "survey", rule: "out-1" } });
    expect(call.tsa).toMatchObject({ id: "survey", rule: "out-1", status: "pending" });
    expect(new URLSearchParams(sent.at(-1)!.body).get("Url")).toBe(`https://chat.test/wh/tel/${call.token}/answer`);
    const answered = await twilio(`/wh/tel/${call.token}/answer`, { CallSid: "CA-out-1", CallStatus: "in-progress", Direction: "outbound-api" });
    const s = telStore.calls.get(call.id)!.tsa!.session;
    expect(tsa.start).toHaveBeenLastCalledWith(expect.objectContaining({ id: call.id, direction: "outbound", to: "+420777000050" }), "survey");
    expect(answered.text).toContain('<Gather input="speech"');
    expect(answered.text).toContain("timeout=speech</Redirect>");
    await twilio(`/wh/tel/${call.token}/event`, { CallSid: "CA-out-1", CallStatus: "completed", CallDuration: "9", CallbackSource: "call-progress-events" });
    expect(tsa.resume).toHaveBeenLastCalledWith(s, { kind: "hangup", cause: "completed" });
  });

  it("a TSA that starts with a refusal refuses unanswered; later it hangs up", () => {
    expect(tsaFixups("twilio", [{ reject: { reason: "busy" } }], false)).toEqual([{ reject: { reason: "busy" } }]);
    expect(tsaFixups("twilio", [{ say: { text: "x" } }, { reject: { reason: "busy" } }], false)).toEqual([{ say: { text: "x" } }, { hangup: {} }]);
    expect(tsaFixups("twilio", [{ reject: { reason: "busy" } }], true)).toEqual([{ hangup: {} }]);
    expect(tsaFixups("twilio", [{ gather: { action: "https://x/tsa?s=1", input: ["speech"] } }], true)[1]).toEqual({ redirect: { url: "https://x/tsa?s=1&timeout=speech" } });
    expect(tsaFixups("vonage", [{ reject: { reason: "busy" } }], true)).toEqual([{ reject: { reason: "busy" } }]);
  });
});

/* ================================================================== Vonage */

describe("Vonage TSA calls", () => {
  it("answer → NCCO; input (digits, speech), connect failures, the connected leg's end and a played notify resume the session", async () => {
    routes["+447700900001"] = { kind: "tsa", tsa: "ivr" };
    script = (call, s, ev, step) => {
      if (step === 0) return [{ say: { text: "Ahoj" } }, { gather: { action: u(call, s, "menu"), input: ["dtmf", "speech"], digits: 1 } }];
      if (ev?.kind === "digits" || ev?.kind === "speech") return [{ dial: { to: "+420777999001", kind: "number", action: u(call, s, "dial") } }];
      return [{ say: { text: "Konec" } }, { redirect: { url: u(call, s, "end", "&e=played") } }];
    };
    const uuid = cid("vu");
    const first = await post("/wh/vonage/answer", { uuid, conversation_uuid: "CON-1", from: "420777000020", to: "447700900001" });
    const call = telStore.callByProviderId("vonage", uuid)!;
    const s = call.tsa!.session;
    expect(first.json).toEqual([
      { action: "talk", text: "Ahoj", bargeIn: true },
      { action: "input", type: ["dtmf", "speech"], dtmf: { maxDigits: 1, submitOnHash: true }, speech: {}, eventUrl: [u(call, s, "menu")], eventMethod: "POST" },
    ]);
    const dtmf = await post(u(call, s, "menu"), { uuid, dtmf: { digits: "2", timed_out: false }, speech: { timeout_reason: "start_timeout" } });
    expect(tsa.resume).toHaveBeenLastCalledWith(s, { kind: "digits", digits: "2" });
    expect((dtmf.json as Array<{ action: string }>).map((a) => a.action)).toEqual(["connect", "notify"]);
    await post(u(call, s, "menu"), { uuid, speech: { results: [{ text: "prodej", confidence: 0.77 }] } });
    expect(tsa.resume).toHaveBeenLastCalledWith(s, { kind: "speech", text: "prodej", confidence: 0.77 });

    const busy = await post(u(call, s, "dial"), { uuid: "b-leg", status: "busy" });
    expect(tsa.resume).toHaveBeenLastCalledWith(s, { kind: "dial", status: "busy" });
    expect(busy.json).toEqual([{ action: "talk", text: "Konec" }, { action: "notify", payload: { m5: "redirect" }, eventUrl: [u(call, s, "end", "&e=played")], eventMethod: "POST" }]);

    const calls = tsa.resume.mock.calls.length;
    const answered = await post(u(call, s, "dial"), { uuid: "b-leg", status: "answered" });
    expect(answered.status).toBe(204);
    await post(u(call, s, "dial"), { uuid: "b-leg", status: "completed", duration: "17" });
    expect(tsa.resume.mock.calls.length).toBe(calls);
    await post(u(call, s, "dial"), { m5: "dial-ended" });
    expect(tsa.resume).toHaveBeenLastCalledWith(s, { kind: "dial", status: "answered", durationSec: 17 });

    await post(`${u(call, s, "end")}&e=played`, { m5: "redirect" });
    expect(tsa.resume).toHaveBeenLastCalledWith(s, { kind: "played" });

    await post("/wh/vonage/events", { uuid, conversation_uuid: "CON-1", status: "completed", duration: "40", direction: "inbound", timestamp: new Date().toISOString() });
    expect(tsa.resume).toHaveBeenLastCalledWith(s, { kind: "hangup", cause: "completed" });
  });
});

/* ================================================================== Telnyx */

describe("Telnyx TSA calls (Call Control)", () => {
  it("answers, runs each turn as commands and resumes on speak / gather / recording / the dialled leg; the hangup ends it", async () => {
    routes["+15005550007"] = { kind: "tsa", tsa: "ivr" };
    script = (call, s, ev, step) => {
      if (step === 0) return [{ say: { text: "Dobrý den", language: "cs-CZ" } }, { redirect: { url: u(call, s, "hello", "&e=played") } }];
      if (ev?.kind === "played") return [{ gather: { action: u(call, s, "menu"), digits: 1, timeout: 5 } }];
      if (ev?.kind === "digits") return [{ sendDigits: { digits: "9" } }, { record: { action: u(call, s, "rec"), finishOnKey: "#", maxSeconds: 60 } }];
      if (ev?.kind === "recording") return [{ dial: { to: "+420777999002", kind: "number", action: u(call, s, "dial"), callerId: "+15005550007" } }];
      return [{ hangup: {} }];
    };
    const id = cid("v3:");
    await post("/wh/telnyx/events", telnyx("call.initiated", { call_control_id: id, direction: "incoming", from: "+420777000030", to: "+15005550007", state: "parked" }));
    const call = telStore.callByProviderId("telnyx", id)!;
    const s = call.tsa!.session;
    expect(telnyxCmds().map((c) => c.cmd)).toEqual(["answer"]);

    await post("/wh/telnyx/events", telnyx("call.answered", { call_control_id: id, direction: "incoming" }));
    expect(telnyxCmds().map((c) => c.cmd)).toEqual(["answer", "speak"]);
    expect(telnyxCmds()[1].body).toMatchObject({ payload: "Dobrý den", language: "cs-CZ" });
    expect(telStore.calls.get(call.id)!.tsa!.wait).toMatchObject({ event: "call.speak.ended", kind: "continue" });

    await post("/wh/telnyx/events", telnyx("call.speak.ended", { call_control_id: id, status: "completed" }));
    expect(tsa.resume).toHaveBeenLastCalledWith(s, { kind: "played" });
    expect(telnyxCmds().at(-1)).toMatchObject({ cmd: "gather", body: { minimum_digits: 1, maximum_digits: 1, terminating_digit: "#", timeout_millis: 5000 } });

    await post("/wh/telnyx/events", telnyx("call.gather.ended", { call_control_id: id, digits: "3", status: "valid" }));
    expect(tsa.resume).toHaveBeenLastCalledWith(s, { kind: "digits", digits: "3" });
    expect(telnyxCmds().slice(-2).map((c) => c.cmd)).toEqual(["send_dtmf", "record_start"]);

    await post("/wh/telnyx/events", telnyx("call.dtmf.received", { call_control_id: id, digit: "#" }));
    expect(telnyxCmds().at(-1)?.cmd).toBe("record_stop");
    await post("/wh/telnyx/events", telnyx("call.recording.saved", { call_control_id: id, recording_urls: { mp3: "https://s3/r.mp3" }, recording_started_at: "2026-10-04T10:00:00Z", recording_ended_at: "2026-10-04T10:00:06Z" }));
    expect(tsa.resume).toHaveBeenLastCalledWith(s, { kind: "recording", url: "https://s3/r.mp3", durationSec: 6, digit: "#" });
    expect(telnyxCmds().at(-1)).toMatchObject({ cmd: "transfer", body: { to: "+420777999002", from: "+15005550007", webhook_url: u(call, s, "dial"), park_after_unbridge: "self" } });

    // The dialled leg reports to the dial's TSA URL.
    await post(u(call, s, "dial"), telnyx("call.initiated", { call_control_id: "v3:b-leg", direction: "outgoing" }));
    await post(u(call, s, "dial"), telnyx("call.answered", { call_control_id: "v3:b-leg" }));
    expect(tsa.resume).toHaveBeenLastCalledWith(s, expect.objectContaining({ kind: "recording" }));
    await post(u(call, s, "dial"), telnyx("call.hangup", { call_control_id: "v3:b-leg", hangup_cause: "normal_clearing" }));
    expect(tsa.resume).toHaveBeenLastCalledWith(s, { kind: "dial", status: "answered", durationSec: 0 });
    expect(telnyxCmds().at(-1)?.cmd).toBe("hangup");
    expect(telStore.calls.get(call.id)!.status).not.toBe("completed");

    // The flow ended itself (its hangup): the call's end is recorded, the session is not resumed again.
    const resumed = tsa.resume.mock.calls.length;
    await post("/wh/telnyx/events", telnyx("call.hangup", { call_control_id: id, hangup_cause: "normal_clearing" }));
    expect(tsa.resume.mock.calls.length).toBe(resumed);
    expect(telStore.calls.get(call.id)).toMatchObject({ status: "completed", tsa: { status: "ended" } });
  });

  it("a flow that ends with a goodbye still says it, then hangs up", async () => {
    routes["+15005550014"] = { kind: "tsa", tsa: "ivr" };
    script = () => [{ say: { text: "Na shledanou" } }, { hangup: {} }];
    const id = cid("v3:");
    await post("/wh/telnyx/events", telnyx("call.initiated", { call_control_id: id, direction: "incoming", from: "+420777000033", to: "+15005550014" }));
    await post("/wh/telnyx/events", telnyx("call.answered", { call_control_id: id }));
    expect(telnyxCmds().map((c) => c.cmd)).toEqual(["answer", "speak"]);
    await post("/wh/telnyx/events", telnyx("call.speak.ended", { call_control_id: id }));
    expect(telnyxCmds().map((c) => c.cmd)).toEqual(["answer", "speak", "hangup"]);
    expect(tsa.resume).not.toHaveBeenCalled();
  });

  it("a caller who hangs up while the flow waits ends the session with { kind: \"hangup\" }", async () => {
    routes["+15005550009"] = { kind: "tsa", tsa: "ivr" };
    script = (call, s, _ev, step) => (step === 0 ? [{ gather: { action: u(call, s, "menu"), digits: 4 } }] : [{ hangup: {} }]);
    const id = cid("v3:");
    await post("/wh/telnyx/events", telnyx("call.initiated", { call_control_id: id, direction: "incoming", from: "+420777000032", to: "+15005550009" }));
    const call = telStore.callByProviderId("telnyx", id)!;
    await post("/wh/telnyx/events", telnyx("call.answered", { call_control_id: id }));
    await post("/wh/telnyx/events", telnyx("call.hangup", { call_control_id: id, hangup_cause: "normal_clearing" }));
    expect(tsa.resume).toHaveBeenLastCalledWith(call.tsa!.session, { kind: "hangup", cause: "normal_clearing" });
    expect(telStore.calls.get(call.id)).toMatchObject({ status: "completed", tsa: { status: "ended" } });
  });

  it("a speech gather: the prompt, a transcription and a timer gather; the first final transcript resumes with speech", async () => {
    routes["+15005550008"] = { kind: "tsa", tsa: "ivr" };
    script = (call, s, ev, step) => (step === 0 ? [{ gather: { action: u(call, s, "ask"), input: ["speech"], prompt: "Řekněte", language: "cs-CZ", timeout: 4, speechTimeout: 1 } }] : [{ hangup: {} }]);
    const id = cid("v3:");
    await post("/wh/telnyx/events", telnyx("call.initiated", { call_control_id: id, direction: "incoming", from: "+420777000031", to: "+15005550008" }));
    const call = telStore.callByProviderId("telnyx", id)!;
    await post("/wh/telnyx/events", telnyx("call.answered", { call_control_id: id }));
    expect(telnyxCmds().map((c) => c.cmd)).toEqual(["answer", "speak", "transcription_start", "gather"]);
    expect(telnyxCmds()[2].body).toMatchObject({ language: "cs", transcription_tracks: "inbound" });
    expect(telnyxCmds()[3].body).toMatchObject({ maximum_digits: 1, timeout_millis: 10_000 });
    await post("/wh/telnyx/events", telnyx("call.transcription", { call_control_id: id, transcription_data: { transcript: "pod", is_final: false } }));
    expect(tsa.resume).not.toHaveBeenCalled();
    await post("/wh/telnyx/events", telnyx("call.transcription", { call_control_id: id, transcription_data: { transcript: "podpora", confidence: 0.9, is_final: true } }));
    expect(tsa.resume).toHaveBeenLastCalledWith(call.tsa!.session, { kind: "speech", text: "podpora", confidence: 0.9 });
    expect(telnyxCmds().slice(-3).map((c) => c.cmd)).toEqual(["transcription_stop", "gather_stop", "hangup"]);
    await post("/wh/telnyx/events", telnyx("call.gather.ended", { call_control_id: id, status: "cancelled" }));
    expect(tsa.resume).toHaveBeenCalledTimes(1);
  });
});

/* ======================================================= callback parsing */

describe("TSA callbacks → TsaEvent", () => {
  it("Twilio", () => {
    expect(tsaEventFromCallback("twilio", { Digits: "12#", FinishedOnKey: "#" }, {})).toEqual({ kind: "digits", digits: "12#", finishedBy: "#" });
    expect(tsaEventFromCallback("twilio", { SpeechResult: "ano", Confidence: "0.5" }, {})).toEqual({ kind: "speech", text: "ano", confidence: 0.5 });
    expect(tsaEventFromCallback("twilio", {}, { timeout: "speech" })).toEqual({ kind: "speech", text: "", timedOut: true });
    expect(tsaEventFromCallback("twilio", {}, { timeout: "recording" })).toEqual({ kind: "recording", url: "", durationSec: 0, timedOut: true });
    expect(tsaEventFromCallback("twilio", { DialCallStatus: "no-answer" }, {})).toEqual({ kind: "dial", status: "no-answer" });
    expect(tsaEventFromCallback("twilio", { RecordingUrl: "https://r", RecordingDuration: "5", Digits: "hangup" }, {})).toEqual({ kind: "recording", url: "https://r", durationSec: 5 });
    expect(tsaEventFromCallback("twilio", { CallStatus: "completed" }, {})).toEqual({ kind: "hangup", cause: "completed" });
    expect(tsaEventFromCallback("twilio", {}, { e: "played" })).toEqual({ kind: "played" });
    expect(tsaEventFromCallback("twilio", { CallStatus: "in-progress" }, {})).toBeNull();
  });
  it("Vonage", () => {
    expect(tsaEventFromCallback("vonage", { dtmf: { digits: "", timed_out: true }, speech: { timeout_reason: "start_timeout" } }, {})).toEqual({ kind: "digits", digits: "", timedOut: true });
    expect(tsaEventFromCallback("vonage", { speech: { timeout_reason: "start_timeout" } }, {})).toEqual({ kind: "speech", text: "", timedOut: true });
    expect(tsaEventFromCallback("vonage", { recording_url: "https://v/r", recording_uuid: "r1", start_time: "2026-10-04T10:00:00Z", end_time: "2026-10-04T10:00:03Z" }, {})).toEqual({ kind: "recording", url: "https://v/r", id: "r1", durationSec: 3 });
    for (const [st, d] of [["timeout", "no-answer"], ["unanswered", "no-answer"], ["rejected", "failed"], ["failed", "failed"], ["cancelled", "canceled"]]) expect(tsaEventFromCallback("vonage", { status: st }, {})).toEqual({ kind: "dial", status: d });
    expect(tsaEventFromCallback("vonage", { status: "ringing" }, {})).toBeNull();
    expect(tsaEventFromCallback("vonage", { recording_url: "https://v/r" }, { x: "dialrec" })).toBeNull();
    expect(tsaEventFromCallback("vonage", { m5: "redirect" }, {})).toEqual({ kind: "played" });
  });
  it("helpers: numbers, the test SIP match, previews without secrets", () => {
    expect([e164("vonage", "420777000000"), e164("twilio", "+1555"), e164("telnyx", "sip:a@b")]).toEqual(["+420777000000", "+1555", "sip:a@b"]);
    const addr = { provider: "telnyx" as const, uri: "sip:test-zz@m5cet-9.sip.telnyx.com", did: "+000100", setup: { resource: "", at: 0, by: "" }, username: "", enabled: true };
    expect(isTestSipCall("sip:TEST-zz@m5cet-9.sip.telnyx.com", addr)).toBe(true);
    expect(isTestSipCall("test-zz", addr)).toBe(true);
    expect(isTestSipCall("sip:test-zz@elsewhere.example.com", addr)).toBe(false);
    expect(isTestSipCall("sip:test-zz@m5cet-9.sip.telnyx.com", { ...addr, enabled: false })).toBe(false);
    const dial: CallAction = { dial: { to: "+420777000001", kind: "number", action: "https://x/d", trunk: { id: "t", host: "sip.example.com", username: "u", password: "trunk-pass-9" } } };
    for (const p of ["twilio", "vonage", "telnyx"]) expect(previewActions(p, [dial]).body).not.toContain("trunk-pass-9");
    expect(previewActions("telnyx", [{ say: { text: "x" } }]).body).toContain('"cmd": "answer"');
  });
});
