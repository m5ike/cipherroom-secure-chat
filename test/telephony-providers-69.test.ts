// @vitest-environment node
//
// 6.9 provider adapters: the new and extended call actions (speech gather,
// record options, dial to a number / a SIP URI / over a trunk with caller ID,
// reject, sendDigits), placeCall over a SIP trunk, and the new normalized
// events (speech, recording, dial, sipUri) — exact TwiML, NCCO and Telnyx
// command bodies against a stubbed fetch.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  TwilioAdapter, TelnyxAdapter, VonageAdapter, renderNcco, telnyxCommands, telnyxPendingActions, telnyxWaitsFor, telnyxDialStatus,
  vonageDtmf, sipTarget, sipUser, sipHost, ProviderError, type CallAction,
} from "../server/telephony/providers";

const ENV_KEYS = [
  "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM", "TELNYX_API_KEY", "TELNYX_FROM", "TELNYX_CONNECTION_ID",
  "VONAGE_API_KEY", "VONAGE_API_SECRET", "VONAGE_FROM", "VONAGE_APPLICATION_ID", "VONAGE_JWT_KEY", "VONAGE_PRIVATE_KEY", "VONAGE_PRIVATE_KEY_PATH",
];
const saved: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;
beforeEach(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  globalThis.fetch = realFetch;
});

type Seen = { url: string; method: string; headers: Record<string, string>; body: string };
function stubFetch(json: unknown = {}, status = 200) {
  const seen: Seen[] = [];
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers).entries()), body: init?.body === undefined || init?.body === null ? "" : String(init.body) });
    return new Response(status === 204 ? null : JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return seen;
}
const form = (s: Seen) => Object.fromEntries(new URLSearchParams(s.body));
const json = (s: Seen) => JSON.parse(s.body) as Record<string, unknown>;

const TRUNK = { id: "prague1", host: "sip.example.com", username: "u1", password: "trunk-pass-9", transport: "tls" as const };
const E164 = "+420777123456";

describe("SIP addresses", () => {
  it("builds dial targets and reads URIs", () => {
    expect(sipTarget(E164, "number")).toBe(E164);
    expect(sipTarget(E164, "number", TRUNK)).toBe("sip:+420777123456@sip.example.com;transport=tls");
    expect(sipTarget("alice@pbx.example.com", "sip")).toBe("sip:alice@pbx.example.com");
    expect(sipTarget("sip:bob@x.example.com;transport=tcp", "sip", TRUNK)).toBe("sip:bob@x.example.com;transport=tcp");
    expect(sipTarget("200", "sip", { ...TRUNK, transport: "udp" })).toBe("sip:200@sip.example.com");
    expect(sipUser("sip:test-ab12@m5cet-1.sip.twilio.com;transport=tls")).toBe("test-ab12");
    expect(sipUser("test-ab12")).toBe("test-ab12");
    expect(sipHost("sips:test@M5CET-1.sip.telnyx.com:5061;x=1")).toBe("m5cet-1.sip.telnyx.com");
    expect(sipHost("test")).toBe("");
  });
});

/* ================================================================= Twilio */

describe("Twilio 6.9", () => {
  const tw = new TwilioAdapter();
  beforeEach(() => { process.env.TWILIO_ACCOUNT_SID = "AC01"; process.env.TWILIO_AUTH_TOKEN = "tw-secret"; process.env.TWILIO_FROM = "+15005550006"; });

  it("gather with speech: input, speechTimeout (auto by default), language and hints on <Gather>", () => {
    const both = tw.renderActions([{ gather: { action: "https://x.test/tsa?s=1&n=a", prompt: "Say or type", input: ["speech", "dtmf"], speechTimeout: 2, hints: ["sales, team", "support"], language: "cs-CZ", timeout: 5 } }]).body;
    expect(both).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Gather input="dtmf speech" action="https://x.test/tsa?s=1&amp;n=a" method="POST" timeout="5" speechTimeout="2" language="cs-CZ" hints="sales  team,support"><Say language="cs-CZ">Say or type</Say></Gather></Response>');
    const speech = tw.renderActions([{ gather: { action: "https://a", input: ["speech"] } }]).body;
    expect(speech).toContain('<Gather input="speech" action="https://a" method="POST" speechTimeout="auto">');
  });

  it("record: silence timeout (0 = off), finish keys (any = every key), trim, transcribe", () => {
    const out = tw.renderActions([{ record: { action: "https://r", maxSeconds: 120, beep: true, silenceSeconds: 0, finishOnKey: "any", trim: false, transcribe: true } }]).body;
    expect(out).toContain('<Record action="https://r" method="POST" maxLength="120" playBeep="true" timeout="0" finishOnKey="1234567890*#" trim="do-not-trim" transcribe="true"/>');
    expect(tw.renderActions([{ record: { action: "https://r", finishOnKey: "*#", trim: true, silenceSeconds: 3 } }]).body).toContain('<Record action="https://r" method="POST" timeout="3" finishOnKey="*#" trim="trim-silence"/>');
    expect(tw.renderActions([{ record: { action: "https://r", finishOnKey: "" } }]).body).toContain('<Record action="https://r" method="POST"/>');
  });

  it("dial: a <Number> with callerId / record / timeout; a SIP URI; a number over a trunk with digest credentials; withheld towards SIP", () => {
    const num = tw.renderActions([{ dial: { to: E164, kind: "number", action: "https://x/tsa?s=1&n=d", callerId: "+15005550006", timeout: 20, record: true } }]).body;
    expect(num).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Dial action="https://x/tsa?s=1&amp;n=d" method="POST" timeout="20" callerId="+15005550006" record="record-from-answer"><Number>+420777123456</Number></Dial></Response>');
    const sip = tw.renderActions([{ dial: { to: "alice@pbx.example.com", kind: "sip", action: "https://x/d", presentation: "restricted" } }]).body;
    expect(sip).toContain('<Dial action="https://x/d" method="POST" callerId="anonymous"><Sip>sip:alice@pbx.example.com</Sip></Dial>');
    const trunk = tw.renderActions([{ dial: { to: E164, kind: "number", action: "https://x/d", callerId: "+420222111000", trunk: TRUNK, timeout: 2 } }]).body;
    expect(trunk).toContain('<Dial action="https://x/d" method="POST" timeout="5" callerId="+420222111000"><Sip username="u1" password="trunk-pass-9">sip:+420777123456@sip.example.com;transport=tls</Sip></Dial>');
    // 6.10 (G-06): the longest bridged call (Twilio's own default is 4 hours).
    expect(tw.renderActions([{ dial: { to: E164, kind: "number", action: "https://x/d", timeLimit: 1800 } }]).body).toContain('<Dial action="https://x/d" method="POST" timeLimit="1800"><Number>');
    expect(tw.renderActions([{ dial: { to: E164, kind: "number", action: "https://x/d", timeLimit: 99_999 } }]).body).toContain('timeLimit="14400"');
  });

  it("reject (busy / rejected; congestion plays busy) and sendDigits as <Play digits>", () => {
    expect(tw.renderActions([{ reject: { reason: "rejected" } }]).body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="rejected"/></Response>');
    expect(tw.renderActions([{ reject: { reason: "busy" } }]).body).toContain('<Reject reason="busy"/>');
    expect(tw.renderActions([{ reject: { reason: "congestion" } }]).body).toContain('<Reject reason="busy"/>');
    expect(tw.renderActions([{ sendDigits: { digits: "1w2W#x" } }]).body).toContain('<Play digits="1w2W#"/>');
  });

  it("places a call over a SIP trunk: To sip:…@trunk, SipAuthUsername / SipAuthPassword, From anonymous when withheld", async () => {
    const seen = stubFetch({ sid: "CA9", status: "queued" });
    await tw.placeCall({ to: E164, from: "+420222111000", timeout: 20, eventUrl: "https://e", answerUrl: "https://a", via: { kind: "sip", trunk: TRUNK, callerName: "M5cet" } });
    const f = form(seen[0]);
    expect([f.To, f.From, f.SipAuthUsername, f.SipAuthPassword, f.Url]).toEqual(["sip:+420777123456@sip.example.com;transport=tls", "+420222111000", "u1", "trunk-pass-9", "https://a"]);
    await tw.placeCall({ to: E164, from: "+420222111000", timeout: 20, eventUrl: "https://e", answerUrl: "https://a", via: { kind: "sip", trunk: { id: "t", host: "h.example.com" }, presentation: "restricted" } });
    const g = form(seen[1]);
    expect([g.To, g.From, g.SipAuthUsername]).toEqual(["sip:+420777123456@h.example.com", "anonymous", undefined]);
  });

  it("parses speech, recording, dial outcome and SIP domain calls", () => {
    const [sp] = tw.parseCallEvent({ CallSid: "CA1", CallStatus: "in-progress", SpeechResult: "obchod", Confidence: "0.91" }, {});
    expect(sp).toMatchObject({ kind: "speech", speech: "obchod", confidence: 0.91, status: "answered" });
    const [rec] = tw.parseCallEvent({ CallSid: "CA1", RecordingUrl: "https://api.twilio.com/rec/RE1", RecordingDuration: "7", RecordingSid: "RE1", Digits: "#" }, {});
    expect(rec).toMatchObject({ kind: "recording", recordingUrl: "https://api.twilio.com/rec/RE1", recordingSec: 7, digits: "#" });
    const [hung] = tw.parseCallEvent({ CallSid: "CA1", RecordingUrl: "https://r", RecordingDuration: "3", Digits: "hangup" }, {});
    expect(hung).toMatchObject({ kind: "recording", cause: "hangup" });
    expect(hung.digits).toBeUndefined();
    for (const [s, d] of [["completed", "answered"], ["busy", "busy"], ["no-answer", "no-answer"], ["failed", "failed"], ["canceled", "canceled"]]) {
      const [dial] = tw.parseCallEvent({ CallSid: "CA1", DialCallStatus: s, DialCallDuration: "12", DialSipResponseCode: "486" }, {});
      expect(dial).toMatchObject({ kind: "dial", dialStatus: d, durationSec: 12, sipCode: "486" });
    }
    const [sipCall] = tw.parseCallEvent({ CallSid: "CA2", CallStatus: "ringing", Direction: "inbound", From: "sip:alice@1.2.3.4", To: "sip:test-ab12@m5cet-1.sip.twilio.com", SipDomain: "m5cet-1.sip.twilio.com" }, {});
    expect(sipCall).toMatchObject({ kind: "answer", sipUri: "sip:test-ab12@m5cet-1.sip.twilio.com", direction: "inbound" });
  });
});

/* ================================================================= Vonage */

describe("Vonage 6.9", () => {
  const vg = new VonageAdapter();

  it("input with speech: type, speech settings (language, context, endOnSilence, startTimeout), dtmf only when asked", () => {
    expect(renderNcco([{ gather: { action: "https://x/tsa?s=1", input: ["speech"], language: "cs-CZ", hints: ["ano", "ne"], speechTimeout: 1.5, timeout: 8 } }])).toEqual([
      { action: "input", type: ["speech"], speech: { language: "cs-CZ", context: ["ano", "ne"], endOnSilence: 1.5, startTimeout: 8 }, eventUrl: ["https://x/tsa?s=1"], eventMethod: "POST" },
    ]);
    expect(renderNcco([{ gather: { action: "https://a", input: ["dtmf", "speech"], digits: 4, finishOnKey: "", timeout: 6 } }])).toEqual([
      { action: "input", type: ["dtmf", "speech"], dtmf: { maxDigits: 4, submitOnHash: false, timeOut: 6 }, speech: { startTimeout: 6 }, eventUrl: ["https://a"], eventMethod: "POST" },
    ]);
  });

  it("record options: one end key, silence 3–10 s (0 = off), transcription to the same URL", () => {
    expect(renderNcco([{ record: { action: "https://x/tsa?s=1&n=r", finishOnKey: "*", silenceSeconds: 20, maxSeconds: 90, beep: true, transcribe: true, language: "cs-CZ" } }])).toEqual([
      { action: "record", eventUrl: ["https://x/tsa?s=1&n=r"], eventMethod: "POST", beepStart: true, endOnKey: "*", endOnSilence: 10, timeOut: 90, transcription: { language: "cs-CZ", eventUrl: ["https://x/tsa?s=1&n=r&x=transcript"], eventMethod: "POST" } },
    ]);
    expect(renderNcco([{ record: { action: "https://r", finishOnKey: "", silenceSeconds: 0 } }])).toEqual([
      { action: "record", eventUrl: ["https://r"], eventMethod: "POST", beepStart: true, timeOut: 7200 },
    ]);
    expect(renderNcco([{ record: { action: "https://r", finishOnKey: "any", silenceSeconds: 2 } }])[0]).toMatchObject({ endOnKey: "#", endOnSilence: 3 });
  });

  it("dial → connect (synchronous, eventUrl) + notify when it ends; phone / sip / trunk endpoints; record as a background record", () => {
    expect(renderNcco([{ dial: { to: E164, kind: "number", action: "https://x/tsa?s=1&n=d", callerId: "+447700900000", timeout: 25 } }, { say: { text: "never" } }])).toEqual([
      { action: "connect", endpoint: [{ type: "phone", number: "420777123456" }], from: "447700900000", timeout: 25, eventType: "synchronous", eventUrl: ["https://x/tsa?s=1&n=d"], eventMethod: "POST" },
      { action: "notify", payload: { m5: "dial-ended" }, eventUrl: ["https://x/tsa?s=1&n=d"], eventMethod: "POST" },
    ]);
    const viaTrunk = renderNcco([{ dial: { to: E164, kind: "number", action: "https://x/d", trunk: TRUNK, presentation: "restricted", record: true } }]);
    expect(viaTrunk[0]).toEqual({ action: "record", eventUrl: ["https://x/d?x=dialrec"], eventMethod: "POST", split: "conversation", channels: 2 });
    expect(viaTrunk[1]).toMatchObject({ action: "connect", endpoint: [{ type: "sip", uri: "sip:+420777123456@sip.example.com;transport=tls" }], from: "anonymous" });
    expect(JSON.stringify(viaTrunk)).not.toContain("trunk-pass-9");
    // 6.10 (G-06): the longest bridged call → connect's `limit` (at most 7200 s at Vonage).
    expect(renderNcco([{ dial: { to: E164, kind: "number", action: "https://x/d", timeLimit: 1800 } }])[0]).toMatchObject({ action: "connect", limit: 1800 });
    expect(renderNcco([{ dial: { to: E164, kind: "number", action: "https://x/d", timeLimit: 14_400 } }])[0]).toMatchObject({ limit: 7200 });
  });

  it("reject ends the NCCO (it cannot refuse); sendDigits is left out; a redirect becomes a notify only when asked", () => {
    expect(renderNcco([{ reject: { reason: "busy" } }, { say: { text: "x" } }])).toEqual([]);
    expect(renderNcco([{ say: { text: "a" } }, { sendDigits: { digits: "12" } }, { say: { text: "b" } }])).toEqual([{ action: "talk", text: "a" }, { action: "talk", text: "b" }]);
    expect(renderNcco([{ say: { text: "Hi" } }, { redirect: { url: "https://x/tsa?s=1&e=played" } }], { redirectAsNotify: true })).toEqual([
      { action: "talk", text: "Hi" },
      { action: "notify", payload: { m5: "redirect" }, eventUrl: ["https://x/tsa?s=1&e=played"], eventMethod: "POST" },
    ]);
    expect(() => renderNcco([{ redirect: { url: "https://r" } }])).toThrow(ProviderError);
  });

  it("DTMF: w → p, and executeActions sends tones through PUT /v1/calls/{uuid}/dtmf before the transfer", async () => {
    expect(vonageDtmf("1w2W#*x")).toBe("1p2pp#*");
    const { privateKey } = await import("node:crypto").then((c) => c.generateKeyPairSync("rsa", { modulusLength: 2048 }));
    process.env.VONAGE_APPLICATION_ID = "app-1";
    process.env.VONAGE_JWT_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const seen = stubFetch({}, 204);
    await vg.executeActions("u-1", [{ sendDigits: { digits: "12w3" } }, { say: { text: "Done" } }]);
    expect(seen[0].method).toBe("PUT");
    expect(seen[0].url).toBe("https://api.nexmo.com/v1/calls/u-1/dtmf");
    expect(json(seen[0])).toEqual({ digits: "12p3" });
    expect(json(seen[1])).toEqual({ action: "transfer", destination: { type: "ncco", ncco: [{ action: "talk", text: "Done" }] } });
    await vg.executeActions("u-1", [{ sendDigits: { digits: "9" } }]);
    expect(seen).toHaveLength(3);
    await expect(vg.sendDtmf("u-1", "xyz")).rejects.toBeInstanceOf(ProviderError);
  });

  it("places a call over a SIP trunk: a sip endpoint (no credentials go to Vonage)", async () => {
    const { privateKey } = await import("node:crypto").then((c) => c.generateKeyPairSync("rsa", { modulusLength: 2048 }));
    process.env.VONAGE_APPLICATION_ID = "app-1";
    process.env.VONAGE_JWT_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const seen = stubFetch({ uuid: "u-9", status: "started" });
    await vg.placeCall({ to: E164, from: "+447700900000", timeout: 20, eventUrl: "https://e", answerUrl: "https://a", via: { kind: "sip", trunk: TRUNK } });
    const b = json(seen[0]);
    expect(b.to).toEqual([{ type: "sip", uri: "sip:+420777123456@sip.example.com;transport=tls" }]);
    expect(b.from).toEqual({ type: "phone", number: "447700900000" });
    expect(seen[0].body).not.toContain("trunk-pass-9");
  });

  it("parses speech results, a speech timeout, recordings and SIP calls", () => {
    const [sp] = vg.parseCallEvent({ uuid: "u-1", speech: { results: [{ text: "ano", confidence: "0.8" }, { text: "no" }], timeout_reason: "end_on_silence_timeout" }, dtmf: { digits: "", timed_out: false } }, {});
    expect(sp).toMatchObject({ kind: "speech", speech: "ano", confidence: 0.8 });
    const [none] = vg.parseCallEvent({ uuid: "u-1", speech: { timeout_reason: "start_timeout" } }, {});
    expect(none).toMatchObject({ kind: "speech", speech: "", cause: "start_timeout" });
    const [typed] = vg.parseCallEvent({ uuid: "u-1", speech: { timeout_reason: "start_timeout" }, dtmf: { digits: "42", timed_out: false } }, {});
    expect(typed).toMatchObject({ kind: "gather", digits: "42" });
    const [rec] = vg.parseCallEvent({ uuid: "u-1", recording_url: "https://api.nexmo.com/v1/files/abc", recording_uuid: "r-1", start_time: "2026-10-04T10:00:00.000Z", end_time: "2026-10-04T10:00:09.000Z", size: 1234 }, {});
    expect(rec).toMatchObject({ kind: "recording", recordingUrl: "https://api.nexmo.com/v1/files/abc", recordingSec: 9, eventId: "u-1:rec:r-1" });
    const [sip] = vg.parseCallEvent({ uuid: "u-2", from: "alice", to: "sip:test-ab12@m5cet-1.sip-eu.vonage.com", endpoint_type: "sip" }, {});
    expect(sip).toMatchObject({ kind: "answer", sipUri: "sip:test-ab12@m5cet-1.sip-eu.vonage.com" });
  });
});

/* ================================================================= Telnyx */

describe("Telnyx 6.9", () => {
  const tx = new TelnyxAdapter();
  beforeEach(() => { process.env.TELNYX_API_KEY = "KEY-tx"; process.env.TELNYX_CONNECTION_ID = "conn-1"; process.env.TELNYX_FROM = "+15005550007"; });

  it("commands: transcription for speech, send_dtmf, reject causes, transfer with trunk credentials / caller ID / privacy, record options", () => {
    const cmds = telnyxCommands([
      { gather: { action: "https://x/tsa", input: ["speech"], language: "cs-CZ" } },
      { sendDigits: { digits: "1w2#", toneMs: 900 } },
      { reject: { reason: "busy" } }, { reject: { reason: "rejected" } }, { reject: { reason: "congestion" } },
      { dial: { to: E164, kind: "number", action: "https://x/tsa?s=1&n=d", callerId: "+420222111000", callerName: "M5cet <Desk>", presentation: "restricted", timeout: 2, record: true, trunk: TRUNK } },
      { dial: { to: E164, kind: "number", action: "https://x/d" } },
      { record: { action: "https://r", maxSeconds: 30, beep: false, silenceSeconds: 0, trim: true, transcribe: true, language: "cs" } },
    ], "c1");
    const cs = Buffer.from("c1").toString("base64");
    expect(cmds[0]).toEqual({ cmd: "transcription_start", body: { language: "cs", interim_results: false, transcription_tracks: "inbound", client_state: cs } });
    expect(cmds[1]).toEqual({ cmd: "send_dtmf", body: { digits: "1w2#", duration_millis: 500, client_state: cs } });
    expect(cmds.slice(2, 5).map((c) => c.body.cause)).toEqual(["USER_BUSY", "CALL_REJECTED", "TEMPORARILY_UNAVAILABLE"]);
    expect(cmds[5]).toEqual({ cmd: "transfer", body: {
      to: "sip:+420777123456@sip.example.com;transport=tls", from: "+420222111000", from_display_name: "M5cet Desk", privacy: "id", timeout_secs: 5,
      sip_auth_username: "u1", sip_auth_password: "trunk-pass-9", sip_transport_protocol: "TLS", record: "record-from-answer",
      webhook_url: "https://x/tsa?s=1&n=d", webhook_url_method: "POST", park_after_unbridge: "self", client_state: cs,
    } });
    expect(cmds[6]).toEqual({ cmd: "transfer", body: { to: E164, webhook_url: "https://x/d", webhook_url_method: "POST", park_after_unbridge: "self", client_state: cs } });
    // 6.10 (G-06): the longest bridged call → time_limit_secs (Telnyx: 30 … 14 400).
    expect(telnyxCommands([{ dial: { to: E164, kind: "number", action: "https://x/d", timeLimit: 1800 } }])[0].body).toMatchObject({ time_limit_secs: 1800 });
    expect(telnyxCommands([{ dial: { to: E164, kind: "number", action: "https://x/d", timeLimit: 5 } }])[0].body).toMatchObject({ time_limit_secs: 30 });
    expect(cmds[7]).toEqual({ cmd: "record_start", body: { format: "mp3", channels: "single", play_beep: false, max_length: 30, timeout_secs: 0, trim: "trim-silence", transcription: true, transcription_language: "cs", client_state: cs } });
  });

  it("waits: a speech-only gather for call.transcription, a dial for the other leg's hangup; reject ends the plan", () => {
    const speech: CallAction = { gather: { action: "https://a", input: ["speech"] } };
    const both: CallAction = { gather: { action: "https://a", input: ["dtmf", "speech"] } };
    const dial: CallAction = { dial: { to: E164, kind: "number", action: "https://d" } };
    expect([speech, both, dial, { sendDigits: { digits: "1" } } as CallAction].map(telnyxWaitsFor)).toEqual(["call.transcription", "call.gather.ended", "call.hangup", null]);
    expect(telnyxPendingActions([{ say: { text: "x" } }, { reject: { reason: "busy" } }])).toEqual([[{ say: { text: "x" } }], [{ reject: { reason: "busy" } }]]);
    expect(telnyxPendingActions([{ reject: { reason: "busy" } }, { say: { text: "x" } }])).toEqual([[{ reject: { reason: "busy" } }], []]);
    expect([telnyxDialStatus("normal_clearing", true), telnyxDialStatus("user_busy", false), telnyxDialStatus("timeout", false), telnyxDialStatus("call_rejected", false), telnyxDialStatus("originator_cancel", false)])
      .toEqual(["answered", "busy", "no-answer", "failed", "canceled"]);
  });

  it("reject, send_dtmf and raw commands go to /calls/{id}/actions/…", async () => {
    const seen = stubFetch({ data: { result: "ok" } });
    await tx.reject("v3:in", "busy", { clientState: "c1" });
    expect(seen[0].url).toBe("https://api.telnyx.com/v2/calls/v3%3Ain/actions/reject");
    expect(json(seen[0])).toEqual({ cause: "USER_BUSY", client_state: Buffer.from("c1").toString("base64") });
    await tx.sendDtmf("v3:in", "12#");
    expect(seen[1].url).toMatch(/\/actions\/send_dtmf$/);
    expect(json(seen[1])).toEqual({ digits: "12#" });
    await tx.sendCommand("v3:in", "record_stop");
    expect(seen[2].url).toMatch(/\/actions\/record_stop$/);
    await expect(tx.sendCommand("v3:in", "../calls")).rejects.toBeInstanceOf(ProviderError);
    await expect(tx.sendDtmf("v3:in", "xyz")).rejects.toBeInstanceOf(ProviderError);
  });

  it("places a call over a SIP trunk: sip to, digest credentials, display name, privacy, transport", async () => {
    const seen = stubFetch({ data: { call_control_id: "v3:out" } });
    await tx.placeCall({ to: E164, from: "+420222111000", timeout: 20, eventUrl: "https://e", via: { kind: "sip", trunk: TRUNK, callerName: "M5cet", presentation: "restricted" } });
    expect(json(seen[0])).toMatchObject({
      connection_id: "conn-1", to: "sip:+420777123456@sip.example.com;transport=tls", from: "+420222111000", from_display_name: "M5cet", privacy: "id",
      sip_auth_username: "u1", sip_auth_password: "trunk-pass-9", sip_transport_protocol: "TLS",
    });
  });

  it("parses call.transcription (final / interim), call.recording.saved, call.bridged and a SIP subdomain call", () => {
    const env = (event_type: string, payload: Record<string, unknown>) => ({ data: { event_type, id: `ev-${event_type}`, payload: { call_control_id: "v3:a", ...payload } } });
    expect(tx.parseCallEvent(env("call.transcription", { transcription_data: { transcript: "dobrý den", confidence: 0.93, is_final: true } }))[0]).toMatchObject({ kind: "speech", speech: "dobrý den", confidence: 0.93 });
    expect(tx.parseCallEvent(env("call.transcription", { transcription_data: { transcript: "dob", is_final: false } }))[0]).toMatchObject({ kind: "speech", cause: "interim" });
    expect(tx.parseCallEvent(env("call.recording.saved", { recording_urls: { mp3: "https://s3/rec.mp3", wav: "https://s3/rec.wav" }, recording_started_at: "2026-10-04T10:00:00Z", recording_ended_at: "2026-10-04T10:00:12Z" }))[0])
      .toMatchObject({ kind: "recording", recordingUrl: "https://s3/rec.mp3", recordingSec: 12 });
    expect(tx.parseCallEvent(env("call.bridged", {}))[0]).toMatchObject({ kind: "dial", dialStatus: "answered" });
    expect(tx.parseCallEvent(env("call.initiated", { direction: "incoming", from: "sip:alice@1.2.3.4", to: "sip:test-ab12@m5cet-1.sip.telnyx.com" }))[0])
      .toMatchObject({ kind: "answer", direction: "inbound", sipUri: "sip:test-ab12@m5cet-1.sip.telnyx.com" });
  });
});
