// @vitest-environment node
//
// m5.telephony end to end (6.0): a function places a call or sends an SMS
// (sandbox → host → engine → the provider's REST API, faked here), the
// provider reports to the call's own webhooks (signed like Twilio signs
// them) and the engine answers with call logic, runs the model's handlers,
// or wakes the run that waits — plus permissions, the per-model limit, and
// the audio bridge: a lent number, the access code, the media streams.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";

const dir = mkdtempSync(join(tmpdir(), "m5tel-"));
Object.assign(process.env, {
  DATA_DIR: dir, FUNCTIONS_DB_FILE: join(dir, "functions.db"), TELEPHONY_DB_FILE: join(dir, "telephony.db"),
  PUBLIC_BASE_URL: "https://chat.test", TELEPHONY_FN_RATE: "1000",
  TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000001", TWILIO_AUTH_TOKEN: "twilio-test-token", TWILIO_FROM: "+15005550006",
  TELNYX_API_KEY: "KEY-test", TELNYX_CONNECTION_ID: "conn-1", TELNYX_FROM: "+15005550007",
  TELEPHONY_DID_POOL: "+15005550006",
  // Telnyx / Vonage webhooks are unsigned here (no TELNYX_PUBLIC_KEY / VONAGE_SIGNATURE_SECRET):
  // 6.10 (G-01) lets them drive calls only when the operator allows it.
  TELEPHONY_ALLOW_UNSIGNED: "1",
});

// AI & speech: a transcription and a voice without a real engine.
vi.mock("../server/ai/service", async () => {
  const audio = await import("../server/telephony/audio");
  return {
    stt: vi.fn(async () => ({ text: "ahoj z telefonu", ref: "test" })),
    tts: vi.fn(async () => ({ audio: audio.wavEncode(audio.tone(440, 200, 16_000), 16_000), mime: "audio/wav", ref: "test" })),
    chat: vi.fn(), modelsFor: vi.fn(() => []),
  };
});

const express = (await import("express")).default;
const { functionsStore } = await import("../server/functions/store");
const { runAdhoc, execute, closeRunner } = await import("../server/functions/runner");
const { createPackage, saveDraft, publishDraft, saveModel } = await import("../server/functions/packages");
const { registerTelEngineRoutes } = await import("../server/telephony/tel-routes");
const { attachBridgeMedia, closeBridgeMedia, setBridgeNotifier } = await import("../server/telephony/bridge");
const { registerWebhookRoutes, twilioSignature } = await import("../server/telephony/webhooks");
const { telStore } = await import("../server/telephony/tel-store");
const { clientConfigStore } = await import("../server/client-config");
const audio = await import("../server/telephony/audio");

/* ------------------------------------------------------------ the fake providers */

type Sent = { url: string; method: string; body: string; headers: Record<string, string> };
const sent: Sent[] = [];
const realFetch = globalThis.fetch;
let callSeq = 0;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);
  const body = init?.body instanceof URLSearchParams ? init.body.toString() : typeof init?.body === "string" ? init.body : "";
  sent.push({ url, method: init?.method ?? "GET", body, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  if (url.endsWith("/Calls.json")) return json({ sid: `CA${++callSeq}`, status: "queued" }, 201);
  if (/\/Calls\/CA\d+\.json$/.test(url)) return json({ sid: "CA", status: "in-progress" });
  if (url.endsWith("/Messages.json")) return json({ sid: "SM1", status: "queued", num_segments: "1" }, 201);
  if (url.includes("/IncomingPhoneNumbers.json")) return json({ incoming_phone_numbers: [{ sid: "PN1", phone_number: "+15005550006" }] });
  if (url.includes("/IncomingPhoneNumbers/PN1.json")) return json({ sid: "PN1" });
  if (url.startsWith("https://lookups.twilio.com/v2/PhoneNumbers/")) return json({ phone_number: "+420603123456", country_code: "CZ", national_format: "603 123 456", valid: true, line_type_intelligence: { carrier_name: "T-Mobile Czech Republic", type: "mobile", mobile_country_code: "230", mobile_network_code: "01" }, caller_name: null });
  if (url.startsWith("https://api.telnyx.com/v2/number_lookup/")) return json({ data: { phone_number: "+420603123456", country_code: "CZ", carrier: { name: "T-Mobile CZ", type: "mobile", mobile_country_code: "230", mobile_network_code: "01" }, portability: { ported_status: "N" } } });
  if (url === "https://api.telnyx.com/v2/calls") return json({ data: { call_control_id: "v3:tx-1", call_leg_id: "leg", call_session_id: "s", is_alive: true } });
  if (url.includes("api.telnyx.com/v2/calls/")) return json({ data: { result: "ok" } });
  return json({ message: "not faked" }, 404);
}) as typeof fetch;

const formOf = (s: Sent) => Object.fromEntries(new URLSearchParams(s.body));
const lastTo = (re: RegExp) => [...sent].reverse().find((s) => re.test(s.url));
const until = async <T>(fn: () => T | undefined | null | false, ms = 10_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 40)); }
};

/* ------------------------------------------------------------ the service */

let server: Server;
let base = "";
const frames: Array<{ hash: string; member: unknown; payload: Record<string, unknown> }> = [];

beforeAll(async () => {
  await functionsStore.ready();
  const app = express();
  const raw = { verify: (req: unknown, _res: unknown, buf: Buffer) => { (req as { rawBody?: Buffer }).rawBody = buf; } };
  app.use(express.urlencoded({ extended: false, ...raw }));
  app.use(express.json(raw));
  registerWebhookRoutes(app);
  registerTelEngineRoutes(app);
  setBridgeNotifier((hash, member, payload) => { frames.push({ hash, member, payload }); return 1; });
  server = app.listen(0, "127.0.0.1");
  attachBridgeMedia(server);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  closeRunner();
  closeBridgeMedia();
  globalThis.fetch = realFetch;
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

/** A webhook as Twilio sends it: form-encoded, signed over the public URL. */
async function twilio(path: string, params: Record<string, string>) {
  const url = new URL(path, "https://chat.test");
  const sig = twilioSignature(`https://chat.test${url.pathname}${url.search}`, params, "twilio-test-token");
  const r = await realFetch(`${base}${url.pathname}${url.search}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig }, body: new URLSearchParams(params) });
  return { status: r.status, text: await r.text() };
}
const pathOf = (u: string) => new URL(u).pathname + new URL(u).search;

const owner = { kind: "console" as const, account: "", name: "boss", groups: [], room: null, client: "console", lang: "cs", tz: "UTC", adminRole: "owner" as const };
const draft = (code: string, caller: Record<string, unknown> = owner) => runAdhoc({ lang: "js", files: { "index.js": code }, entry: { file: "index.js", fn: "execute" }, inputs: {}, limits: { wallMs: 60_000 } }, caller as never);
const valueOf = (r: { values: unknown[] }) => { const v = r.values[0] as { type: string; value?: unknown; text?: string }; return v?.type === "text" ? v.text : v?.value; };

function modelWith(name: string, code: string, grants?: unknown) {
  const pkg = createPackage(name, "js", "", "op");
  saveDraft(pkg.id, { "index.js": code }, {}, "op");
  const v = publishDraft(pkg.id, "minor", "op");
  return saveModel({ id: name, name, entry: `${name}@${v.version}:index.js#execute`, enabled: true, ...(grants ? { grants } : {}) } as never, "boss", "owner");
}

/* ------------------------------------------------------------ calls */

describe("a call from a function", () => {
  it("a draft waits for its call: the answer webhook says the text, on_answer steers the live call, the hang-up ends the wait", async () => {
    const run = draft(`export async function execute() {
      const r = await m5.telephony.call({ to: "+420603123456", say: "Dobrý den", on_answer: () => m5.telephony.actions.say("Druhá věta") });
      return { status: r.status, duration: r.durationSec, seen: r.events.map((e) => e.status) };
    }`);
    const placed = await until(() => lastTo(/\/Calls\.json$/));
    const f = formOf(placed);
    expect(f).toMatchObject({ To: "+420603123456", From: "+15005550006", Timeout: "10", Method: "POST" });
    expect(new URLSearchParams(placed.body).getAll("StatusCallbackEvent")).toEqual(["initiated", "ringing", "answered", "completed"]);
    const answer = await twilio(pathOf(f.Url), { CallSid: "CA1", CallStatus: "in-progress", From: "+15005550006", To: "+420603123456", Direction: "outbound-api" });
    expect(answer.text).toContain("<Say");
    expect(answer.text).toContain("Dobrý den");
    await twilio(pathOf(f.StatusCallback), { CallSid: "CA1", CallStatus: "in-progress", CallbackSource: "call-progress-events", SequenceNumber: "2" });
    const steered = await until(() => lastTo(/\/Calls\/CA1\.json$/));
    expect(formOf(steered).Twiml).toContain("Druhá věta");
    await twilio(pathOf(f.StatusCallback), { CallSid: "CA1", CallStatus: "completed", CallbackSource: "call-progress-events", SequenceNumber: "3", CallDuration: "7" });
    const r = await run;
    expect(r.run.error).toBeNull();
    expect(valueOf(r)).toMatchObject({ status: "completed", duration: 7, seen: expect.arrayContaining(["answered", "completed"]) });
  }, 60_000);

  it("a model's handlers run later, when the provider reports (async)", async () => {
    const model = modelWith("callbot", `export async function execute() { const c = await m5.telephony.call({ to: "+420603123456", say: "Ahoj", on_hangup: "on_hangup", on_busy: "on_busy" }); return c.id; }
export async function on_hangup(i) { await m5.cache.set("last", "hangup:" + i.call.status); return null; }
export async function on_busy(i) { await m5.cache.set("last", "busy:" + i.call.to); return null; }`);
    sent.length = 0;
    const r = await execute(model, {}, owner as never, { executor: "console" });
    expect(r.run.error).toBeNull();
    const f = formOf(await until(() => lastTo(/\/Calls\.json$/)));
    await twilio(pathOf(f.StatusCallback), { CallSid: `CA${callSeq}`, CallStatus: "busy", CallbackSource: "call-progress-events", SequenceNumber: "1" });
    expect(await until(() => functionsStore.cacheGet(`model:${model.id}`, "last"))).toBe("busy:+420603123456");
  }, 60_000);

  it("digits go to their function; its answer is the next call logic", async () => {
    const model = modelWith("pinbot", `export async function execute() { const c = await m5.telephony.call({ to: "+420603123456", actions: [m5.telephony.actions.gather({ digits: 4, fn: "on_digits", prompt: "Zadejte PIN" })] }); return c.id; }
export async function on_digits(i) { return m5.telephony.actions.say("Zadali jste " + i.call.lastEvent.digits); }`);
    sent.length = 0;
    await execute(model, {}, owner as never, { executor: "console" });
    const f = formOf(await until(() => lastTo(/\/Calls\.json$/)));
    const answer = await twilio(pathOf(f.Url), { CallSid: `CA${callSeq}`, CallStatus: "in-progress" });
    expect(answer.text).toContain("<Gather");
    const action = /action="([^"]+)"/.exec(answer.text)![1].replace(/&amp;/g, "&");
    expect(action).toMatch(/\/gather\?fn=on_digits$/);
    const next = await twilio(pathOf(action), { CallSid: `CA${callSeq}`, CallStatus: "in-progress", Digits: "4321" });
    expect(next.text).toContain("Zadali jste 4321");
  }, 60_000);

  it("refuses a forged webhook", async () => {
    const call = telStore.calls.list({ limit: 1 })[0];
    const r = await realFetch(`${base}/wh/tel/${call.token}/event`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "forged" }, body: "CallSid=CA1&CallStatus=completed" });
    expect(r.status).toBe(403);
  });

  it("Telnyx: dials with its own webhook, then runs the actions as commands, one step after another", async () => {
    sent.length = 0;
    const run = draft(`export async function execute() {
      const c = await m5.telephony.call({ to: "+420603123456", provider: "telnyx", actions: [m5.telephony.actions.say("Ahoj"), m5.telephony.actions.hangup()] });
      return c.id;
    }`);
    await run;
    const dial = await until(() => lastTo(/api\.telnyx\.com\/v2\/calls$/));
    const d = JSON.parse(dial.body);
    expect(d).toMatchObject({ connection_id: "conn-1", to: "+420603123456", timeout_secs: 10 });
    const hook = pathOf(d.webhook_url);
    const post = (event_type: string, payload: Record<string, unknown> = {}) => realFetch(`${base}${hook}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: { record_type: "event", id: `ev-${event_type}`, event_type, payload: { call_control_id: "v3:tx-1", ...payload } } }) });
    await post("call.answered");
    expect(await until(() => lastTo(/actions\/speak$/))).toBeTruthy();
    expect(sent.some((s) => /actions\/hangup$/.test(s.url))).toBe(false);
    await post("call.speak.ended");
    expect(await until(() => lastTo(/actions\/hangup$/))).toBeTruthy();
  }, 60_000);
});

/* ------------------------------------------------------------ messages */

describe("an SMS from a function", () => {
  it("is sent, and its delivery report updates it", async () => {
    sent.length = 0;
    const r = await draft(`export async function execute() { return await m5.telephony.sms({ to: "+420603123456", text: "Ahoj" }); }`);
    expect(r.run.error).toBeNull();
    const m = valueOf(r) as { id: string; status: string };
    expect(m.status).toBe("queued");
    const f = formOf(lastTo(/\/Messages\.json$/)!);
    expect(f).toMatchObject({ To: "+420603123456", Body: "Ahoj" });
    await twilio(pathOf(f.StatusCallback), { MessageSid: "SM1", MessageStatus: "delivered" });
    expect(await until(() => telStore.messages.get(m.id)?.status === "delivered")).toBe(true);
  }, 60_000);
});

/* ------------------------------------------------------------ who may */

describe("who may use telephony", () => {
  it("a person needs their Telephony & SIP rights; a run nobody started needs the model's grant", async () => {
    const cfg = clientConfigStore.get();
    clientConfigStore.set({ ...cfg, modules: { ...cfg.modules, telephony: { enabled: true, defaultAccess: "deny", groupAccess: "allow", groups: [], grants: [], log: "all" } } });
    const guest = { ...owner, kind: "guest", name: "someone", adminRole: undefined };
    const denied = await draft(`export async function execute() { try { await m5.telephony.sms({ to: "+420603123456", text: "x" }); return "sent"; } catch (e) { return e.code; } }`, guest);
    expect(valueOf(denied)).toBe("telephony-denied");

    const hook = { kind: "webhook" as const, account: "", name: "webhook", groups: [], room: null, client: "webhook", lang: "en", tz: "UTC" };
    const code = `export async function execute(i) { try { await m5.telephony[i.op]({ to: i.to, text: "x", say: "x" }); return "ok"; } catch (e) { return e.code; } }`;
    const bare = modelWith("nogrant", code);
    expect(valueOf(await execute(bare, { op: "sms", to: "+420603123456" }, hook, { executor: "webhook", skipValidation: true }))).toBe("telephony-denied");
    const granted = modelWith("smsonly", code, { telephony: { enabled: true, rights: ["sms", "number:+420*"] } });
    expect(valueOf(await execute(granted, { op: "sms", to: "+420603123456" }, hook, { executor: "webhook", skipValidation: true }))).toBe("ok");
    expect(valueOf(await execute(granted, { op: "sms", to: "+15005550006" }, hook, { executor: "webhook", skipValidation: true }))).toBe("telephony-denied");
    expect(valueOf(await execute(granted, { op: "call", to: "+420603123456" }, hook, { executor: "webhook", skipValidation: true }))).toBe("telephony-denied");
    clientConfigStore.set(cfg);
  }, 60_000);

  it("counts paid operations per model", async () => {
    process.env.TELEPHONY_FN_RATE = "2";
    const r = await draft(`export async function execute() { const out = []; for (let i = 0; i < 3; i++) { try { await m5.telephony.sms({ to: "+420603123456", text: "x" }); out.push("ok"); } catch (e) { out.push(e.code); } } return out; }`, { ...owner, name: "limited" });
    expect(valueOf(r)).toEqual(["ok", "ok", "telephony-limit"]);
    process.env.TELEPHONY_FN_RATE = "1000";
  }, 60_000);
});

/* ------------------------------------------------------------ the audio bridge */

describe("the phone bridge", () => {
  it("lends a number with a code; a wrong code is asked again, the right one connects; speech becomes text, a written reply becomes speech", async () => {
    sent.length = 0;
    const r = await draft(`export async function execute() { return await m5.telephony.did.allocate({ room: "r3.alpha", member: "Eva", minutes: 10, mode: "text" }); }`);
    expect(r.run.error).toBeNull();
    const s = valueOf(r) as { id: string; number: string; code: string; status: string };
    expect(s).toMatchObject({ number: "+15005550006", status: "waiting" });
    expect(s.code).toMatch(/^\d{5}$/);
    // The number now points here.
    expect(formOf(lastTo(/IncomingPhoneNumbers\/PN1\.json$/)!)).toMatchObject({ VoiceUrl: "https://chat.test/wh/tel/in/twilio" });

    const inbound = await twilio("/wh/tel/in/twilio", { CallSid: "CA90", CallStatus: "ringing", From: "+420777000111", To: "+15005550006", Direction: "inbound" });
    expect(inbound.text).toContain("<Gather");
    const gather = pathOf(/action="([^"]+)"/.exec(inbound.text)![1].replace(/&amp;/g, "&"));
    const wrong = await twilio(gather, { CallSid: "CA90", CallStatus: "in-progress", Digits: s.code === "00000" ? "11111" : "00000" });
    expect(wrong.text).toContain("Nesprávný kód");
    const right = await twilio(gather, { CallSid: "CA90", CallStatus: "in-progress", Digits: s.code });
    expect(right.text).toContain("<Stream");
    const stream = /url="(wss:\/\/chat\.test\/media\/tel\/[^"]+)"/.exec(right.text)![1];

    // The provider's media stream (as Twilio sends it).
    const provider = new WebSocket(`${base.replace("http", "ws")}${new URL(stream).pathname}`);
    const out: string[] = [];
    provider.on("message", (d) => out.push(String(d)));
    await new Promise((res) => provider.once("open", res));
    provider.send(JSON.stringify({ event: "connected" }));
    provider.send(JSON.stringify({ event: "start", start: { streamSid: "MZ1", callSid: "CA90" } }));
    const incoming = await until(() => frames.find((f) => f.payload.type === "phone-bridge" && f.payload.event === "incoming"));
    expect(incoming).toMatchObject({ member: { name: "Eva" }, payload: { session: s.id, from: "+420777000111" } });
    // Speech (a tone burst between silences) → an utterance → text for the member.
    const speech = [audio.silence(300, 8000), audio.tone(300, 600, 8000, 0.5), audio.silence(1200, 8000)];
    for (const part of speech) for (let i = 0; i < part.length; i += 160) provider.send(JSON.stringify({ event: "media", streamSid: "MZ1", media: { track: "inbound", payload: Buffer.from(audio.mulawEncode(part.subarray(i, i + 160))).toString("base64") } }));
    const said = await until(() => frames.find((f) => f.payload.type === "server-notice" && f.payload.text === "ahoj z telefonu"));
    expect(said.payload).toMatchObject({ kind: "message", from: expect.stringContaining("☎") });

    // The member writes back: spoken to the caller as µ-law media frames.
    const member = new WebSocket(`${base.replace("http", "ws")}/media/tel/client/${incoming.payload.token}`);
    await new Promise((res) => member.once("open", res));
    member.send(JSON.stringify({ type: "say", text: "Dobrý den, tady Eva" }));
    const media = await until(() => { const m = out.map((x) => JSON.parse(x)).filter((x) => x.event === "media"); return m.length ? m : null; });
    expect(media[0]).toMatchObject({ streamSid: "MZ1" });
    expect(Buffer.from(media[0].media.payload, "base64").length).toBe(160);

    // The caller hangs up.
    provider.send(JSON.stringify({ event: "stop" }));
    await until(() => frames.find((f) => f.payload.type === "phone-bridge" && f.payload.event === "ended"));
    const done = telStore.bridges.get(s.id)!;
    expect(done).toMatchObject({ status: "ended", channel: "text" });
    expect(done.attempts.map((a) => a.ok)).toEqual([false, true]);
    expect(done.stats.heardSegments).toBeGreaterThan(0);
    member.close(); provider.close();
  }, 60_000);

  it("audio: the member's microphone goes to the caller, the caller to the member", async () => {
    const r = await draft(`export async function execute() { return await m5.telephony.did.allocate({ room: "r3.alpha", member: { peerId: "p-eva" }, mode: "audio" }); }`);
    const s = valueOf(r) as { code: string; id: string };
    const inbound = await twilio("/wh/tel/in/twilio", { CallSid: "CA91", CallStatus: "ringing", From: "+420777000222", To: "+15005550006", Direction: "inbound" });
    const gather = pathOf(/action="([^"]+)"/.exec(inbound.text)![1].replace(/&amp;/g, "&"));
    const right = await twilio(gather, { CallSid: "CA91", CallStatus: "in-progress", Digits: s.code });
    const stream = /url="(wss:\/\/chat\.test\/media\/tel\/[^"]+)"/.exec(right.text)![1];
    const provider = new WebSocket(`${base.replace("http", "ws")}${new URL(stream).pathname}`);
    const toCaller: string[] = [];
    provider.on("message", (d) => toCaller.push(String(d)));
    await new Promise((res) => provider.once("open", res));
    provider.send(JSON.stringify({ event: "start", start: { streamSid: "MZ2" } }));
    const incoming = await until(() => frames.find((f) => f.payload.event === "incoming" && f.payload.session === s.id));
    const member = new WebSocket(`${base.replace("http", "ws")}/media/tel/client/${incoming.payload.token}`);
    const toMember: Buffer[] = [];
    member.on("message", (d, bin) => { if (bin) toMember.push(d as Buffer); });
    await new Promise((res) => member.once("open", res));
    member.send(JSON.stringify({ type: "audio" }));
    member.send(audio.pcm16ToLE(audio.tone(500, 100, 16_000)));
    await until(() => toCaller.some((x) => JSON.parse(x).event === "media"));
    const frame = audio.mulawEncode(audio.tone(500, 20, 8000));
    provider.send(JSON.stringify({ event: "media", streamSid: "MZ2", media: { track: "inbound", payload: Buffer.from(frame).toString("base64") } }));
    const heard = await until(() => toMember.length && toMember);
    expect(heard[0].length % 2).toBe(0);
    provider.send(JSON.stringify({ event: "stop" }));
    await until(() => telStore.bridges.get(s.id)?.status === "ended");
    expect(telStore.bridges.get(s.id)!.channel).toBe("audio");
    member.close(); provider.close();
  }, 60_000);
});

/* ------------------------------------------------------------ the packages */

describe("the telephony packages", () => {
  it("install switched off; execute shows a form; the form sends — and each is a flow the builder opens", async () => {
    const { installBuiltin, BUILTINS_ALL } = await import("../server/functions/builtins");
    const { endpointOf, eventInputs } = await import("../server/functions/endpoints");
    const { parseFlow, compileFlow } = await import("../server/functions/flow");
    const names = BUILTINS_ALL.filter((b) => b.name.startsWith("tel-")).map((b) => b.name);
    expect(names).toEqual(["tel-call", "tel-sms", "tel-whatsapp", "tel-viber", "tel-messenger", "tel-lookup", "tel-hlr", "tel-did"]);
    for (const name of names) {
      installBuiltin(name, "boss");
      const pkg = functionsStore.packageByName(name)!;
      const v = functionsStore.versions(pkg.id).find((x) => x.status === "published")!;
      // The flow compiles to exactly the file that runs.
      expect(compileFlow(parseFlow(JSON.parse(v.files["flow.m5flow.json"]))).code + "\n").toBe(v.files["index.js"]);
    }
    const sms = functionsStore.modelByKeyword("sms") ?? functionsStore.models().find((m) => m.keyword === "sms")!;
    expect(sms.enabled).toBe(false);
    const model = saveModel({ id: sms.id, enabled: true }, "boss", "owner");
    const shown = await execute(model, {}, owner as never, { executor: "console" });
    expect(shown.outputs[0]).toMatchObject({ type: "form", name: "tel-sms", fields: expect.arrayContaining([expect.objectContaining({ name: "to", pattern: "^\\+[1-9][0-9]{6,14}$", required: true })]) });
    sent.length = 0;
    const ep = endpointOf(model, "form")!;
    const values = { to: "+420603123456", text: "Z formuláře" };
    const done = await execute(model, eventInputs(ep, values, { name: "tel-sms", values, event: { type: "submit" } }), owner as never, { executor: "console", endpoint: ep, skipValidation: true });
    expect(done.run.error).toBeNull();
    expect(formOf(lastTo(/\/Messages\.json$/)!)).toMatchObject({ To: "+420603123456", Body: "Z formuláře" });
    expect((done.outputs[0] as { text: string }).text).toContain("SMS to +420603123456");
  }, 60_000);
});

describe("the phone bridge on Vonage", () => {
  it("NCCO asks for the code, connects a WebSocket with 16 kHz audio, binary frames both ways", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.VONAGE_APPLICATION_ID = "app-1";
    process.env.VONAGE_JWT_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const r = await draft(`export async function execute() { return await m5.telephony.did.allocate({ room: "r3.beta", member: "Karel", provider: "vonage", number: "+442079460000", mode: "text", language: "en" }); }`);
    expect(r.run.error).toBeNull();
    const s = valueOf(r) as { code: string; id: string; provider: string };
    expect(s.provider).toBe("vonage");
    const post = async (path: string, body: unknown) => { const res = await realFetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return res.json() as Promise<Array<Record<string, unknown>>>; };
    const ncco = await post("/wh/vonage/answer", { uuid: "vu1", conversation_uuid: "c1", from: "420777000333", to: "442079460000", direction: "inbound" });
    const input = ncco.find((a) => a.action === "input") as { eventUrl: string[]; dtmf: { maxDigits: number; submitOnHash: boolean } };
    expect(ncco[0]).toMatchObject({ action: "talk", text: expect.stringContaining("five-digit") });
    expect(input.dtmf).toMatchObject({ maxDigits: 5, submitOnHash: true });
    const next = await post(pathOf(input.eventUrl[0]), { uuid: "vu1", conversation_uuid: "c1", dtmf: { digits: s.code, timed_out: false } });
    const connect = next.find((a) => a.action === "connect") as { endpoint: Array<{ type: string; uri: string; "content-type": string }> };
    expect(connect.endpoint[0]).toMatchObject({ type: "websocket", "content-type": "audio/l16;rate=16000" });
    const provider = new WebSocket(`${base.replace("http", "ws")}${new URL(connect.endpoint[0].uri).pathname}`);
    const binary: Buffer[] = [];
    provider.on("message", (d, isBinary) => { if (isBinary) binary.push(d as Buffer); });
    await new Promise((res) => provider.once("open", res));
    provider.send(JSON.stringify({ event: "websocket:connected", "content-type": "audio/l16;rate=16000" }));
    const incoming = await until(() => frames.find((f) => f.payload.event === "incoming" && f.payload.session === s.id));
    for (const part of [audio.silence(300, 16_000), audio.tone(300, 600, 16_000, 0.5), audio.silence(1200, 16_000)]) for (let i = 0; i < part.length; i += 320) provider.send(audio.pcm16ToLE(part.subarray(i, i + 320)));
    await until(() => frames.find((f) => f.hash === incoming.hash && f.payload.type === "server-notice" && f.payload.from === "☎ +442079460000"));
    const member = new WebSocket(`${base.replace("http", "ws")}/media/tel/client/${incoming.payload.token}`);
    await new Promise((res) => member.once("open", res));
    member.send(JSON.stringify({ type: "say", text: "Hello" }));
    await until(() => binary.length > 3);
    expect(binary[0].length).toBe(640);
    member.send(JSON.stringify({ type: "hangup" }));
    await until(() => telStore.bridges.get(s.id)?.status === "ended");
    member.close(); provider.close();
  }, 60_000);
});

describe("number lookup", () => {
  it("offline: what the numbering plan says, free; with providers: their answers merged", async () => {
    const r = await draft(`export async function execute() {
      const free = await m5.telephony.lookup("603 123 456", { offline: true, country: "CZ" });
      const paid = await m5.telephony.lookup("+420 603 123 456");
      return { number: free.number, country: free.summary.country, type: free.summary.type, zones: free.summary.timeZones, paid: paid.summary, providers: paid.sources.map((s) => s.provider + ":" + s.ok) };
    }`);
    expect(r.run.error).toBeNull();
    const v = valueOf(r) as { number: string; country: { iso2: string }; type: string; zones: string[]; paid: { carrier: { name: string; mcc: string }; valid: boolean }; providers: string[] };
    expect(v.number).toBe("+420603123456");
    expect(v.country.iso2).toBe("CZ");
    expect(v.type).toBe("mobile");
    expect(v.zones).toContain("Europe/Prague");
    expect(v.paid.valid).toBe(true);
    expect(v.paid.carrier.mcc).toBe("230");
    expect(v.providers).toEqual(expect.arrayContaining(["twilio:true", "telnyx:true"]));
  }, 60_000);
});
