// @vitest-environment node
//
// m5.telephony provider adapters (server/telephony/providers/*): every request
// an adapter makes (URL, method, auth header shape, body fields) against a
// stubbed fetch — nothing ever reaches a provider — and the mapping of
// realistic provider answers and webhook bodies into the neutral types.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { verifyJwtRS256 } from "../server/telephony/jwt";
import { TwilioVoiceConnector, installProviderWebhooks } from "../server/telephony/connectors";
import {
  adapters, adapter, providerStatuses, pick,
  TwilioAdapter, TelnyxAdapter, VonageAdapter, HlrLookupsAdapter, MetaAdapter,
  telnyxPendingActions, telnyxWaitsFor, hlrLookupsSignature,
  ProviderError, ProviderNotConfigured, FINAL_CALL_STATUSES,
  type CallAction, type CallStatus,
} from "../server/telephony/providers";

/* ------------------------------------------------------------------ setup */

const ENV_KEYS = [
  "PUBLIC_BASE_URL",
  "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM", "TWILIO_VOICE_URL", "TWILIO_MESSAGING_SERVICE_SID",
  "TWILIO_WHATSAPP_FROM", "TWILIO_MESSENGER_PAGE_ID",
  "TELNYX_API_KEY", "TELNYX_FROM", "TELNYX_CONNECTION_ID", "TELNYX_MESSAGING_PROFILE_ID", "TELNYX_WHATSAPP_FROM",
  "VONAGE_API_KEY", "VONAGE_API_SECRET", "VONAGE_FROM", "VONAGE_APPLICATION_ID", "VONAGE_JWT_KEY",
  "VONAGE_PRIVATE_KEY", "VONAGE_PRIVATE_KEY_PATH", "VONAGE_WHATSAPP_FROM", "VONAGE_VIBER_FROM",
  "VONAGE_MESSENGER_PAGE_ID", "VONAGE_MESSAGES_SANDBOX",
  "HLRLOOKUPS_API_KEY", "HLRLOOKUPS_API_SECRET",
  "META_PAGE_ID", "META_PAGE_TOKEN", "META_GRAPH_VERSION",
];
const saved: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;
beforeEach(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

type Reply = { status?: number; json?: unknown; text?: string };
type Seen = { url: string; method: string; headers: Record<string, string>; body: string; signal: unknown };

/** Stub fetch: records every request, answers with the replies in order (the last one repeats). */
function stubFetch(...replies: Reply[]) {
  const seen: Seen[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body === undefined || init?.body === null ? "" : String(init.body),
      signal: init?.signal,
    });
    const r = replies[Math.min(seen.length - 1, replies.length - 1)] ?? {};
    const status = r.status ?? 200;
    const payload = status === 204 ? null : (r.text ?? JSON.stringify(r.json ?? {}));
    return new Response(payload, { status, headers: { "Content-Type": "application/json" } });
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return { fn, seen };
}

const form = (s: Seen) => new URLSearchParams(s.body);
const json = <T = Record<string, unknown>>(s: Seen) => JSON.parse(s.body) as T;
const b64 = (s: string) => Buffer.from(s).toString("base64");

async function rejectsWith<T extends Error>(p: Promise<unknown>, cls: new (...a: never[]) => T): Promise<T> {
  try { await p; } catch (err) { expect(err).toBeInstanceOf(cls); return err as T; }
  throw new Error("expected a rejection");
}

/** Tag balance + no bare "&": enough to prove the TwiML we emit is well-formed. */
function wellFormedXml(xml: string): boolean {
  const body = xml.replace(/^<\?xml[^>]*\?>/, "");
  if (/&(?!amp;|lt;|gt;|quot;|apos;)/.test(body)) return false;
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z]+)((?:\s+[A-Za-z]+="[^"<]*")*)\s*(\/?)>/g;
  let rest = body;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    rest = rest.replace(m[0], "");
    if (m[4]) continue;
    if (m[1]) { if (stack.pop() !== m[2]) return false; } else stack.push(m[2]);
  }
  return stack.length === 0 && !/[<>]/.test(rest);
}

const E164 = "+420777123456";

/* ================================================================= Twilio */

describe("Twilio adapter", () => {
  const tw = new TwilioAdapter();
  const AUTH = `Basic ${b64("AC0123456789abcdef:twilio-secret-token")}`;
  beforeEach(() => {
    process.env.TWILIO_ACCOUNT_SID = "AC0123456789abcdef";
    process.env.TWILIO_AUTH_TOKEN = "twilio-secret-token";
  });

  it("places a call: Basic auth, inline TwiML, the four StatusCallbackEvent fields repeated", async () => {
    const { seen } = stubFetch({ status: 201, json: { sid: "CA1", status: "queued", direction: "outbound-api" } });
    const r = await tw.placeCall({
      to: E164, from: "+15005550006", timeout: 10, timeLimit: 600,
      actions: [{ say: { text: "Hi" } }], eventUrl: "https://chat.example.org/wh/twilio/voice_status?cid=1",
      machineDetection: true, clientState: "ignored",
    });
    expect(r).toMatchObject({ id: "CA1", provider: "twilio", status: "queued" });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC0123456789abcdef/Calls.json");
    expect(seen[0].method).toBe("POST");
    expect(seen[0].headers.authorization).toBe(AUTH);
    expect(seen[0].headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(seen[0].signal).toBeInstanceOf(AbortSignal);
    const f = form(seen[0]);
    expect(f.get("To")).toBe(E164);
    expect(f.get("From")).toBe("+15005550006");
    expect(f.get("Timeout")).toBe("10");
    expect(f.get("TimeLimit")).toBe("600");
    expect(f.get("Twiml")).toBe("<Response><Say>Hi</Say></Response>");
    expect(f.get("Url")).toBeNull();
    expect(f.get("StatusCallback")).toBe("https://chat.example.org/wh/twilio/voice_status?cid=1");
    expect(f.get("StatusCallbackMethod")).toBe("POST");
    expect(f.getAll("StatusCallbackEvent")).toEqual(["initiated", "ringing", "answered", "completed"]);
    expect(f.get("MachineDetection")).toBe("Enable");
    expect(seen[0].body).not.toContain("twilio-secret-token");
  });

  it("places a call with an answer URL (Url + POST, no Twiml), raw.twiml wins over actions, TWILIO_FROM fallback", async () => {
    process.env.TWILIO_FROM = "+15005550006";
    const { seen } = stubFetch({ status: 201, json: { sid: "CA2", status: "queued" } });
    await tw.placeCall({ to: E164, from: "", timeout: 900, answerUrl: "https://chat.example.org/wh/twilio/voice", eventUrl: "https://e" });
    const f = form(seen[0]);
    expect(f.get("Url")).toBe("https://chat.example.org/wh/twilio/voice");
    expect(f.get("Method")).toBe("POST");
    expect(f.get("Twiml")).toBeNull();
    expect(f.get("From")).toBe("+15005550006");
    expect(f.get("Timeout")).toBe("600"); // clamped to Twilio's maximum
    await tw.placeCall({ to: E164, from: "+1", timeout: 5, actions: [{ hangup: {} }], raw: { twiml: "<Response><Reject/></Response>" }, eventUrl: "https://e" });
    expect(form(seen[1]).get("Twiml")).toBe("<Response><Reject/></Response>");
  });

  it("refuses bad input before any network call", async () => {
    const { fn } = stubFetch({ json: {} });
    const e1 = await rejectsWith(tw.placeCall({ to: "777123456", from: "+1", timeout: 10, answerUrl: "https://a", eventUrl: "https://e" }), ProviderError);
    expect(e1.status).toBe(400);
    expect(e1.message).toMatch(/E\.164/);
    const e2 = await rejectsWith(tw.placeCall({ to: E164, from: "+1", timeout: 10, eventUrl: "https://e" }), ProviderError);
    expect(e2.message).toMatch(/answerUrl, actions or raw\.twiml/);
    const long = Array.from({ length: 200 }, () => ({ say: { text: "a fairly long sentence" } }) as CallAction);
    const e3 = await rejectsWith(tw.placeCall({ to: E164, from: "+1", timeout: 10, actions: long, eventUrl: "https://e" }), ProviderError);
    expect(e3.message).toMatch(/4000/);
    expect(fn).not.toHaveBeenCalled();
  });

  it("renders every action as well-formed, escaped TwiML", () => {
    const out = tw.renderActions([
      { say: { text: `Tom & "Jerry" <3`, voice: "Polly.Joanna-Neural", language: "en-US", loop: 2 } },
      { play: { url: "https://x.test/a.mp3?x=1&y=2" } },
      { pause: { seconds: 2 } },
      { gather: { action: "https://x.test/pin?cid=1&s=2", prompt: "Enter the code, then #", digits: 5, finishOnKey: "#", timeout: 10 } },
      { stream: { url: "wss://h.test/media/twilio?session=abc", params: { room: "r<1>" } } },
      { record: { action: "https://x.test/rec", maxSeconds: 30, beep: false } },
      { redirect: { url: "https://x.test/next?a=1&b=2" } },
      { hangup: {} },
    ]);
    expect(out.contentType).toBe("text/xml");
    expect(out.body).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response>'
      + '<Say voice="Polly.Joanna-Neural" language="en-US" loop="2">Tom &amp; &quot;Jerry&quot; &lt;3</Say>'
      + "<Play>https://x.test/a.mp3?x=1&amp;y=2</Play>"
      + '<Pause length="2"/>'
      + '<Gather input="dtmf" action="https://x.test/pin?cid=1&amp;s=2" method="POST" timeout="10" finishOnKey="#"><Say>Enter the code, then #</Say></Gather>'
      + '<Connect><Stream url="wss://h.test/media/twilio"><Parameter name="session" value="abc"/><Parameter name="room" value="r&lt;1&gt;"/></Stream></Connect>'
      + '<Record action="https://x.test/rec" method="POST" maxLength="30" playBeep="false"/>'
      + '<Redirect method="POST">https://x.test/next?a=1&amp;b=2</Redirect>'
      + "<Hangup/></Response>",
    );
    expect(wellFormedXml(out.body)).toBe(true);
  });

  it("gather: no numDigits with a finish key (the length is checked on our side); numDigits when the key is disabled", () => {
    const hash = tw.renderActions([{ gather: { action: "https://a", digits: 5, finishOnKey: "#" } }]).body;
    expect(hash).not.toContain("numDigits");
    const dflt = tw.renderActions([{ gather: { action: "https://a", digits: 5 } }]).body;
    expect(dflt).not.toContain("numDigits");
    const fixed = tw.renderActions([{ gather: { action: "https://a", digits: 4, finishOnKey: "" } }]).body;
    expect(fixed).toContain('finishOnKey="" numDigits="4"');
    expect(tw.renderActions([{ say: { text: "x", voice: "female" } }]).body).toContain('voice="woman"');
  });

  it("executeActions updates the live call's Twiml; hangup sets Status=completed", async () => {
    const { seen } = stubFetch({ json: { sid: "CA1", status: "in-progress" } });
    await tw.executeActions("CA1", [{ say: { text: "Bye" } }, { hangup: {} }]);
    expect(seen[0].url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC0123456789abcdef/Calls/CA1.json");
    expect(form(seen[0]).get("Twiml")).toBe("<Response><Say>Bye</Say><Hangup/></Response>");
    await tw.hangup("CA1");
    expect(seen[1].method).toBe("POST");
    expect(form(seen[1]).get("Status")).toBe("completed");
  });

  it("maps StatusCallback CallStatus values", () => {
    const table: Array<[string, CallStatus]> = [
      ["queued", "queued"], ["initiated", "initiated"], ["ringing", "ringing"], ["in-progress", "answered"],
      ["completed", "completed"], ["busy", "busy"], ["no-answer", "no-answer"], ["failed", "failed"], ["canceled", "canceled"],
    ];
    for (const [CallStatus, status] of table) {
      const [ev] = tw.parseCallEvent({
        CallSid: "CA1", AccountSid: "AC0123456789abcdef", From: "+15005550006", To: E164, CallStatus,
        Direction: "outbound-api", Timestamp: "Tue, 29 Sep 2026 10:00:00 +0000", SequenceNumber: "3", CallbackSource: "call-progress-events",
      }, {});
      expect(ev).toMatchObject({ provider: "twilio", callId: "CA1", status, kind: "status", direction: "outbound", eventId: "CA1:3" });
    }
    const [done] = tw.parseCallEvent("CallSid=CA1&CallStatus=completed&CallDuration=42&SipResponseCode=200&CallbackSource=call-progress-events&Direction=outbound-api", {});
    expect(done).toMatchObject({ status: "completed", durationSec: 42, sipCode: "200" });
  });

  it("tells gather, machine and answer webhooks apart", () => {
    const [g] = tw.parseCallEvent({ CallSid: "CA1", CallStatus: "in-progress", Digits: "12345", Direction: "inbound" }, {});
    expect(g).toMatchObject({ kind: "gather", digits: "12345", status: "answered", direction: "inbound" });
    const [m] = tw.parseCallEvent({ CallSid: "CA1", CallStatus: "in-progress", AnsweredBy: "machine_end_beep" }, {});
    expect(m).toMatchObject({ kind: "machine", status: "machine", cause: "machine_end_beep" });
    const [a] = tw.parseCallEvent({ CallSid: "CA9", CallStatus: "ringing", Direction: "inbound", From: "+15005550006", To: "+15005550007" }, {});
    expect(a).toMatchObject({ kind: "answer", status: "ringing", from: "+15005550006", to: "+15005550007" });
    expect(tw.parseCallEvent({ Foo: "bar" }, {})).toEqual([]);
  });

  it("sends SMS (From, StatusCallback, ValidityPeriod) and maps the answer", async () => {
    process.env.TWILIO_FROM = "+15005550006";
    const { seen } = stubFetch({ status: 201, json: { sid: "SM1", status: "queued", num_segments: "2", price: null, direction: "outbound-api" } });
    const r = await tw.sendSms({ to: E164, text: "Ahoj", options: { statusUrl: "https://e/sms", ttl: 600 } });
    expect(r).toMatchObject({ id: "SM1", provider: "twilio", status: "queued", parts: 2 });
    expect(r.price).toBeUndefined();
    expect(seen[0].url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC0123456789abcdef/Messages.json");
    const f = form(seen[0]);
    expect([f.get("To"), f.get("From"), f.get("Body"), f.get("StatusCallback"), f.get("ValidityPeriod")]).toEqual([E164, "+15005550006", "Ahoj", "https://e/sms", "600"]);
    expect(f.get("MessagingServiceSid")).toBeNull();
  });

  it("sends SMS through a Messaging Service (scheduling needs one)", async () => {
    process.env.TWILIO_FROM = "+15005550006";
    process.env.TWILIO_MESSAGING_SERVICE_SID = "MG1";
    const { seen } = stubFetch({ status: 201, json: { sid: "SM2", status: "scheduled" } });
    await tw.sendSms({ to: E164, text: "later", options: { sendAt: "2026-10-01T10:00:00Z" } });
    const f = form(seen[0]);
    expect(f.get("MessagingServiceSid")).toBe("MG1");
    expect(f.get("From")).toBeNull();
    expect([f.get("SendAt"), f.get("ScheduleType")]).toEqual(["2026-10-01T10:00:00Z", "fixed"]);
    delete process.env.TWILIO_MESSAGING_SERVICE_SID;
    await expect(tw.sendSms({ to: E164, text: "x", options: { sendAt: "2026-10-01T10:00:00Z" } })).rejects.toMatchObject({ status: 400 });
  });

  it("turns a Twilio error into ProviderError (status, code, message cut to 300 chars)", async () => {
    process.env.TWILIO_FROM = "+15005550006";
    stubFetch({ status: 400, json: { code: 21211, message: "The 'To' number +15005550001 is not a valid phone number.", more_info: "https://www.twilio.com/docs/errors/21211", status: 400 } });
    const e = await rejectsWith(tw.sendSms({ to: "+15005550001", text: "x" }), ProviderError);
    expect([e.provider, e.status, e.code]).toEqual(["twilio", 400, "21211"]);
    expect(e.message).toMatch(/not a valid phone number/);
    stubFetch({ status: 500, text: "x".repeat(2000) });
    const long = await rejectsWith(tw.sendSms({ to: E164, text: "x" }), ProviderError);
    expect(long.status).toBe(500);
    expect(long.message.length).toBeLessThanOrEqual(300);
    expect(long.message).not.toContain("twilio-secret-token");
  });

  it("looks a number up (Lookup v2 Fields) and maps line type, carrier, caller name, line status, SIM swap", async () => {
    const { seen } = stubFetch({ json: {
      calling_country_code: "1", country_code: "US", phone_number: "+14155550123", national_format: "(415) 555-0123", valid: true, validation_errors: [],
      caller_name: { caller_name: "SMITH,JOHN", caller_type: "CONSUMER", error_code: null },
      line_type_intelligence: { carrier_name: "T-Mobile USA, Inc.", error_code: null, mobile_country_code: "310", mobile_network_code: "160", type: "nonFixedVoip" },
      line_status: { status: "reachable", error_code: null },
      sim_swap: { last_sim_swap: { last_sim_swapped_date: "2026-08-01T00:00:00Z", swapped_period: "PT48H", swapped_in_period: true }, carrier_name: "T-Mobile", mobile_country_code: "310", mobile_network_code: "160", error_code: null },
    } });
    const r = await tw.lookup("+14155550123", ["carrier", "line_type", "caller_name", "line_status", "sim_swap", "portability"]);
    expect(seen[0].method).toBe("GET");
    expect(seen[0].url).toBe("https://lookups.twilio.com/v2/PhoneNumbers/%2B14155550123?Fields=line_type_intelligence,caller_name,line_status,sim_swap");
    expect(seen[0].headers.authorization).toBe(AUTH);
    expect(r).toMatchObject({
      number: "+14155550123", provider: "twilio", valid: true, national: "(415) 555-0123",
      country: { code: "US", prefix: "+1" }, type: "voip",
      carrier: { name: "T-Mobile USA, Inc.", mcc: "310", mnc: "160", type: "voip" },
      callerName: "SMITH,JOHN", callerType: "consumer", reachable: "reachable",
      simSwap: { at: "2026-08-01T00:00:00Z", period: "PT48H" },
    });
    expect(r.ported).toBeUndefined(); // Twilio has no portability
  });

  it("sends WhatsApp: whatsapp: addresses, Content Template (HX…) with ContentVariables, else Body / MediaUrl", async () => {
    process.env.TWILIO_WHATSAPP_FROM = "+14155238886";
    const { seen } = stubFetch({ status: 201, json: { sid: "SM9", status: "queued" } });
    const r = await tw.sendChat({ channel: "whatsapp", to: E164, template: { name: "HXb5b62575e6e4ff6129ad7c8efe1f983e", language: "cs", params: ["Jan", "12345"] }, statusUrl: "https://e/wa" });
    expect(r).toMatchObject({ id: "SM9", provider: "twilio", channel: "whatsapp", status: "queued" });
    let f = form(seen[0]);
    expect(f.get("From")).toBe("whatsapp:+14155238886");
    expect(f.get("To")).toBe(`whatsapp:${E164}`);
    expect(f.get("ContentSid")).toBe("HXb5b62575e6e4ff6129ad7c8efe1f983e");
    expect(JSON.parse(f.get("ContentVariables") ?? "")).toEqual({ 1: "Jan", 2: "12345" });
    expect(f.get("Body")).toBeNull();
    expect(f.get("StatusCallback")).toBe("https://e/wa");
    await tw.sendChat({ channel: "whatsapp", to: E164, text: "Ahoj", media: { url: "https://x.test/a.jpg", type: "image" } });
    f = form(seen[1]);
    expect([f.get("Body"), f.get("MediaUrl"), f.get("ContentSid")]).toEqual(["Ahoj", "https://x.test/a.jpg", null]);
    await expect(tw.sendChat({ channel: "whatsapp", to: E164, template: { name: "order_update", language: "en" } })).rejects.toMatchObject({ status: 400 });
  });

  it("sends Messenger (beta, messenger:<page>) and refuses Viber", async () => {
    process.env.TWILIO_MESSENGER_PAGE_ID = "1076543210";
    const { seen } = stubFetch({ status: 201, json: { sid: "SM7", status: "queued" } });
    await tw.sendChat({ channel: "messenger", to: "4567890123456", text: "Hi" });
    expect(form(seen[0]).get("From")).toBe("messenger:1076543210");
    expect(form(seen[0]).get("To")).toBe("messenger:4567890123456");
    await expect(tw.sendChat({ channel: "viber", to: E164, text: "x" })).rejects.toMatchObject({ status: 400 });
  });

  it("searches, buys, assigns (by number) and releases numbers", async () => {
    const { seen } = stubFetch(
      { json: { available_phone_numbers: [{ phone_number: "+14155550100", friendly_name: "(415) 555-0100", iso_country: "US", region: "CA", locality: "San Francisco", capabilities: { voice: true, SMS: true, MMS: false, fax: false } }] } },
      { status: 201, json: { sid: "PN0123456789abcdef0123456789abcdef", phone_number: "+15005550006" } },
      { json: { incoming_phone_numbers: [{ sid: "PN0123456789abcdef0123456789abcdef", phone_number: "+15005550006" }] } },
      { json: { sid: "PN0123456789abcdef0123456789abcdef" } },
      { status: 204 },
    );
    const found = await tw.searchNumbers({ country: "us", type: "local", voice: true, sms: true, contains: "555", limit: 2 });
    expect(seen[0].url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC0123456789abcdef/AvailablePhoneNumbers/US/Local.json?VoiceEnabled=true&SmsEnabled=true&Contains=555&PageSize=2");
    expect(found).toEqual([expect.objectContaining({ number: "+14155550100", country: "US", region: "CA", locality: "San Francisco", capabilities: ["voice", "sms"] })]);

    const owned = await tw.buyNumber("+15005550006", { country: "US", voiceUrl: "https://chat.example.org/wh/twilio/voice" });
    expect(owned).toMatchObject({ id: "PN0123456789abcdef0123456789abcdef", number: "+15005550006", provider: "twilio" });
    expect(seen[1].url).toMatch(/\/IncomingPhoneNumbers\.json$/);
    expect(Object.fromEntries(form(seen[1]))).toEqual({ PhoneNumber: "+15005550006", VoiceUrl: "https://chat.example.org/wh/twilio/voice", VoiceMethod: "POST" });

    await tw.assignNumber("+15005550006", { voiceUrl: "https://chat.example.org/wh/twilio/voice" });
    expect(seen[2].method).toBe("GET");
    expect(seen[2].url).toMatch(/\/IncomingPhoneNumbers\.json\?PhoneNumber=%2B15005550006$/);
    expect(seen[3].url).toMatch(/\/IncomingPhoneNumbers\/PN0123456789abcdef0123456789abcdef\.json$/);
    expect(form(seen[3]).get("VoiceUrl")).toBe("https://chat.example.org/wh/twilio/voice");

    await tw.releaseNumber("PN0123456789abcdef0123456789abcdef");
    expect(seen[4].method).toBe("DELETE");
    expect(seen[4].url).toMatch(/\/IncomingPhoneNumbers\/PN0123456789abcdef0123456789abcdef\.json$/);
    await expect(tw.assignNumber("+15005550006", {})).rejects.toMatchObject({ status: 400 });
  });

  it("reports status and refuses to run unconfigured, naming the variables", async () => {
    let st = tw.status();
    expect(st.configured).toEqual(["call", "sms", "lookup", "numbers", "media"]);
    expect(st.reason).toMatch(/TWILIO_WHATSAPP_FROM \(whatsapp\)/);
    expect(JSON.stringify(st)).not.toContain("twilio-secret-token");
    expect(tw.media).toEqual({ transport: "json-mulaw", codec: "PCMU", rate: 8000 });
    delete process.env.TWILIO_AUTH_TOKEN;
    st = tw.status();
    expect(st.configured).toEqual([]);
    expect(st.needs.call).toEqual(["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM"]);
    const { fn } = stubFetch({ json: {} });
    const e = await rejectsWith(tw.sendSms({ to: E164, text: "x" }), ProviderNotConfigured);
    expect([e.provider, e.capability]).toEqual(["twilio", "sms"]);
    expect(e.message).toMatch(/TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN/);
    expect(fn).not.toHaveBeenCalled();
  });
});

/* ================================================================== Telnyx */

describe("Telnyx adapter", () => {
  const tx = new TelnyxAdapter();
  beforeEach(() => {
    process.env.TELNYX_API_KEY = "KEYtelnyx-secret";
    process.env.TELNYX_CONNECTION_ID = "1684641123236054244";
  });

  const envelope = (event_type: string, payload: Record<string, unknown>, id = "0ccc7b54-4df3-4bca-a65a-3da1ecc777f0") => ({
    data: { record_type: "event", event_type, id, occurred_at: "2026-09-29T10:00:00.000000Z", payload: { call_control_id: "v3:abc", call_leg_id: "leg-1", call_session_id: "sess-1", connection_id: "1684641123236054244", ...payload } },
    meta: { attempt: 1, delivered_to: "https://chat.example.org/wh/telnyx/events" },
  });

  it("dials: Bearer key, connection_id, timeout_secs clamped to 5, base64 client_state, AMD", async () => {
    const { seen } = stubFetch({ json: { data: { call_control_id: "v3:abc", call_leg_id: "leg-1", call_session_id: "sess-1", is_alive: false, record_type: "call" } } });
    const r = await tx.placeCall({
      to: E164, from: "+15550001111", timeout: 3, timeLimit: 600, eventUrl: "https://chat.example.org/wh/telnyx/events",
      clientState: '{"call":"c1"}', machineDetection: true, actions: [{ say: { text: "later" } }],
    });
    expect(r).toMatchObject({ id: "v3:abc", provider: "telnyx", status: "initiated" });
    expect(seen[0].url).toBe("https://api.telnyx.com/v2/calls");
    expect(seen[0].method).toBe("POST");
    expect(seen[0].headers.authorization).toBe("Bearer KEYtelnyx-secret");
    expect(json(seen[0])).toEqual({
      connection_id: "1684641123236054244", to: E164, from: "+15550001111",
      timeout_secs: 5, time_limit_secs: 600,
      webhook_url: "https://chat.example.org/wh/telnyx/events", webhook_url_method: "POST",
      client_state: b64('{"call":"c1"}'), answering_machine_detection: "detect",
    });
    await tx.placeCall({ to: E164, from: "+15550001111", timeout: 700, eventUrl: "https://e" });
    expect(json(seen[1]).timeout_secs).toBe(600);
    await expect(tx.placeCall({ to: E164, from: "+1", timeout: 10, eventUrl: "https://e", raw: { texml: "<Response/>" } })).rejects.toMatchObject({ status: 400 });
  });

  it("splits actions at the first one that waits for the caller", () => {
    const say: CallAction = { say: { text: "Hi" } };
    const gather: CallAction = { gather: { action: "https://a", digits: 5 } };
    const stream: CallAction = { stream: { url: "wss://h/media" } };
    const hangup: CallAction = { hangup: {} };
    const redirect: CallAction = { redirect: { url: "https://r" } };
    expect(telnyxPendingActions([say, gather, stream, hangup])).toEqual([[say], [gather, stream, hangup]]);
    expect(telnyxPendingActions([gather, stream, hangup])).toEqual([[gather], [stream, hangup]]);
    expect(telnyxPendingActions([stream, hangup])).toEqual([[stream], [hangup]]);
    expect(telnyxPendingActions([hangup, say])).toEqual([[hangup], []]);
    expect(telnyxPendingActions([redirect])).toEqual([[redirect], []]);
    expect(telnyxPendingActions([])).toEqual([[], []]);
    expect([say, { pause: { seconds: 1 } }, { play: { url: "u" } }, gather, stream, { record: { action: "r" } }, hangup].map((a) => telnyxWaitsFor(a as CallAction)))
      .toEqual(["call.speak.ended", "call.speak.ended", "call.playback.ended", "call.gather.ended", "streaming.stopped", "call.recording.saved", null]);
  });

  it("executeActions sends only the commands up to the first waiting one", async () => {
    const { seen } = stubFetch({ json: { data: { result: "ok" } } });
    await tx.executeActions("v3:abc", [
      { gather: { action: "https://a", prompt: "Enter the 5-digit code, then #", digits: 5, finishOnKey: "#", timeout: 10 } },
      { say: { text: "not yet" } },
    ], { clientState: "s1" });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://api.telnyx.com/v2/calls/v3%3Aabc/actions/gather_using_speak");
    expect(json(seen[0])).toEqual({
      payload: "Enter the 5-digit code, then #", payload_type: "text", voice: "female", language: "en-US", service_level: "basic",
      minimum_digits: 5, maximum_digits: 5, terminating_digit: "#", timeout_millis: 10000, client_state: b64("s1"),
    });

    await tx.executeActions("v3:abc", [{ say: { text: "Hallo", voice: "Polly.Marlene", language: "de-DE", loop: 2 } }, { hangup: {} }]);
    expect(seen).toHaveLength(2);
    expect(seen[1].url).toMatch(/\/actions\/speak$/);
    expect(json(seen[1])).toEqual({ payload: "Hallo", payload_type: "text", voice: "AWS.Polly.Marlene", language: "de-DE", loop: 2 });

    await tx.executeActions("v3:abc", [{ stream: { url: "wss://h.test/media/telnyx", params: { session: "abc" } } }, { hangup: {} }]);
    expect(seen).toHaveLength(3);
    expect(seen[2].url).toMatch(/\/actions\/streaming_start$/);
    expect(json(seen[2])).toEqual({
      stream_url: "wss://h.test/media/telnyx", stream_track: "inbound_track", stream_bidirectional_mode: "rtp",
      stream_bidirectional_codec: "PCMU", stream_bidirectional_target_legs: "opposite", custom_parameters: [{ name: "session", value: "abc" }],
    });

    await tx.executeActions("v3:abc", [{ play: { url: "https://x.test/a.mp3" } }]);
    expect(seen[3].url).toMatch(/\/actions\/playback_start$/);
    expect(json(seen[3])).toEqual({ audio_url: "https://x.test/a.mp3" });

    await tx.executeActions("v3:abc", [{ gather: { action: "https://a", finishOnKey: "*" } }]);
    expect(seen[4].url).toMatch(/\/actions\/gather$/);
    expect(json(seen[4])).toEqual({ terminating_digit: "*" });

    await tx.executeActions("v3:abc", [{ pause: { seconds: 12 } }]);
    expect(seen[5].url).toMatch(/\/actions\/speak$/);
    expect(json(seen[5])).toMatchObject({ payload: '<speak><break time="10s"/><break time="2s"/></speak>', payload_type: "ssml" });

    await tx.executeActions("v3:abc", [{ record: { action: "https://r", maxSeconds: 60, beep: true } }]);
    expect(seen[6].url).toMatch(/\/actions\/record_start$/);
    expect(json(seen[6])).toMatchObject({ format: "mp3", channels: "single", play_beep: true, max_length: 60 });

    await tx.executeActions("v3:abc", [{ hangup: {} }]);
    expect(seen[7].url).toBe("https://api.telnyx.com/v2/calls/v3%3Aabc/actions/hangup");
    expect(json(seen[7])).toEqual({});

    // Everything is checked before anything is sent.
    await expect(tx.executeActions("v3:abc", [{ say: { text: "x" } }, { redirect: { url: "https://r" } }])).rejects.toMatchObject({ status: 400 });
    expect(seen).toHaveLength(8);
  });

  it("answers an inbound call and hangs up", async () => {
    const { seen } = stubFetch({ json: { data: { result: "ok" } } });
    await tx.answer("v3:in", { clientState: "pin" });
    expect(seen[0].url).toBe("https://api.telnyx.com/v2/calls/v3%3Ain/actions/answer");
    expect(json(seen[0])).toEqual({ client_state: b64("pin") });
    await tx.hangup("v3:in");
    expect(seen[1].url).toBe("https://api.telnyx.com/v2/calls/v3%3Ain/actions/hangup");
  });

  it("maps call.hangup hangup_cause to the call status", () => {
    const table: Array<[string, CallStatus]> = [
      ["normal_clearing", "completed"], ["time_limit", "completed"], ["user_busy", "busy"], ["timeout", "no-answer"],
      ["no_answer", "no-answer"], ["originator_cancel", "canceled"], ["call_rejected", "failed"], ["not_found", "failed"], ["unspecified", "failed"],
    ];
    for (const [hangup_cause, status] of table) {
      const [ev] = tx.parseCallEvent(envelope("call.hangup", { hangup_cause, hangup_source: "callee", sip_hangup_cause: "486", from: "+15550001111", to: E164, state: "hangup" }));
      expect(ev).toMatchObject({ provider: "telnyx", callId: "v3:abc", kind: "status", status, cause: hangup_cause, sipCode: "486" });
      expect(FINAL_CALL_STATUSES).toContain(ev.status);
    }
    expect(tx.parseCallEvent(envelope("call.hangup", { hangup_cause: "something_new", sip_hangup_cause: "503" }))[0].status).toBe("failed");
  });

  it("maps the other call events (client_state decoded, eventId = data.id)", () => {
    const cs = b64('{"call":"c1"}');
    const [init] = tx.parseCallEvent(envelope("call.initiated", { direction: "incoming", from: "+15550001111", to: E164, state: "parked", client_state: cs }, "evt-1"));
    expect(init).toMatchObject({ kind: "answer", status: "initiated", direction: "inbound", from: "+15550001111", to: E164, clientState: '{"call":"c1"}', eventId: "evt-1" });
    expect(tx.parseCallEvent(envelope("call.initiated", { direction: "outgoing" }))[0]).toMatchObject({ kind: "status", status: "initiated", direction: "outbound" });
    expect(tx.parseCallEvent(envelope("call.answered", { state: "answered" }))[0]).toMatchObject({ kind: "status", status: "answered" });
    expect(tx.parseCallEvent(envelope("call.gather.ended", { digits: "12345", status: "valid" }))[0]).toMatchObject({ kind: "gather", digits: "12345", cause: "valid", status: null });
    expect(tx.parseCallEvent(envelope("call.dtmf.received", { digit: "5" }))[0]).toMatchObject({ kind: "dtmf", digits: "5" });
    expect(tx.parseCallEvent(envelope("call.speak.ended", { status: "completed" }))[0]).toMatchObject({ kind: "speak-ended" });
    expect(tx.parseCallEvent(envelope("call.playback.ended", { status: "completed" }))[0]).toMatchObject({ kind: "playback-ended" });
    expect(tx.parseCallEvent(envelope("call.machine.detection.ended", { result: "machine" }))[0]).toMatchObject({ kind: "machine", status: "machine" });
    expect(tx.parseCallEvent(envelope("call.machine.detection.ended", { result: "human" }))[0]).toMatchObject({ kind: "machine", status: null, cause: "human" });
    expect(tx.parseCallEvent(envelope("streaming.failed", { failure_reason: "connection_failed", stream_id: "s1" }))[0]).toMatchObject({ kind: "stream", cause: "connection_failed" });
    expect(tx.parseCallEvent(envelope("streaming.started", { stream_id: "s1" }))[0]).toMatchObject({ kind: "stream", cause: "started" });
    expect(tx.parseCallEvent(JSON.stringify(envelope("call.answered", {})))[0].status).toBe("answered");
    expect(tx.parseCallEvent({ data: { event_type: "message.sent", payload: { id: "m1" } } })).toEqual([]);
  });

  it("sends SMS and maps the answer; needs a sender or a messaging profile", async () => {
    process.env.TELNYX_FROM = "+15550001111";
    const { seen } = stubFetch({ json: { data: {
      record_type: "message", direction: "outbound", id: "40385f64-5717-4562-b3fc-2c963f66afa6", type: "SMS",
      to: [{ phone_number: E164, status: "queued", carrier: "T-Mobile", line_type: "Wireless" }], parts: 1,
      cost: { amount: "0.0051", currency: "USD" }, encoding: "UCS-2",
    } } });
    const r = await tx.sendSms({ to: E164, text: "Příliš žluťoučký", options: { unicode: true, statusUrl: "https://e/sms", messagingProfileId: "prof-1" } });
    expect(r).toMatchObject({ id: "40385f64-5717-4562-b3fc-2c963f66afa6", provider: "telnyx", status: "queued", parts: 1, price: "0.0051 USD" });
    expect(seen[0].url).toBe("https://api.telnyx.com/v2/messages");
    expect(json(seen[0])).toEqual({ to: E164, text: "Příliš žluťoučký", from: "+15550001111", messaging_profile_id: "prof-1", encoding: "ucs2", webhook_url: "https://e/sms" });
    delete process.env.TELNYX_FROM;
    const e = await rejectsWith(tx.sendSms({ to: E164, text: "x" }), ProviderNotConfigured);
    expect(e.message).toMatch(/TELNYX_FROM or TELNYX_MESSAGING_PROFILE_ID/);
  });

  it("looks a number up (type=carrier&type=caller-name) and maps portability and region", async () => {
    const { seen } = stubFetch({ json: { data: {
      record_type: "number_lookup", country_code: "US", national_format: "(312) 555-0123", phone_number: "+13125550123", fraud: null,
      carrier: { name: "T-MOBILE USA, INC.", type: "mobile", mobile_country_code: "310", mobile_network_code: "260", error_code: null, normalized_carrier: "T-Mobile" },
      caller_name: { caller_name: "JOHN SMITH", error_code: null },
      portability: { lrn: "3125550000", ported_status: "Y", ported_date: "2020-01-01", ocn: "6529", line_type: "wireless", spid: "6529", spid_carrier_name: "T-Mobile", city: "CHICAGO", state: "IL" },
    } } });
    const r = await tx.lookup("+13125550123", ["carrier", "caller_name", "portability"]);
    expect(seen[0].method).toBe("GET");
    expect(seen[0].url).toBe("https://api.telnyx.com/v2/number_lookup/%2B13125550123?type=carrier&type=caller-name");
    expect(r).toMatchObject({
      number: "+13125550123", provider: "telnyx", national: "(312) 555-0123", country: { code: "US" }, type: "mobile",
      carrier: { name: "T-MOBILE USA, INC.", mcc: "310", mnc: "260", type: "mobile" },
      callerName: "JOHN SMITH", ported: true, region: { city: "CHICAGO", state: "IL" },
    });
    const { seen: s2 } = stubFetch({ json: { data: { phone_number: "+13125550123", carrier: { type: "fixed line" } } } });
    expect((await tx.lookup("+13125550123", ["line_type"])).type).toBe("landline");
    expect(s2[0].url).toMatch(/\?type=carrier$/);
  });

  it("sends WhatsApp in the Meta Cloud API shape (text, template, document)", async () => {
    process.env.TELNYX_WHATSAPP_FROM = "+15550002222";
    const { seen } = stubFetch({ json: { data: { id: "wamid-1", record_type: "message", type: "WHATSAPP" } } });
    const r = await tx.sendChat({ channel: "whatsapp", to: E164, text: "Ahoj" });
    expect(r).toMatchObject({ id: "wamid-1", provider: "telnyx", channel: "whatsapp" });
    expect(seen[0].url).toBe("https://api.telnyx.com/v2/messages/whatsapp");
    expect(json(seen[0])).toEqual({ from: "+15550002222", to: E164, whatsapp_message: { type: "text", text: { body: "Ahoj" } } });
    await tx.sendChat({ channel: "whatsapp", to: E164, template: { name: "pin_code", language: "en_US", params: ["12345"] } });
    expect(json(seen[1]).whatsapp_message).toEqual({
      type: "template",
      template: { name: "pin_code", language: { policy: "deterministic", code: "en_US" }, components: [{ type: "body", parameters: [{ type: "text", text: "12345" }] }] },
    });
    await tx.sendChat({ channel: "whatsapp", to: E164, text: "Invoice", media: { url: "https://x.test/i.pdf", type: "file" } });
    expect(json(seen[2]).whatsapp_message).toEqual({ type: "document", document: { link: "https://x.test/i.pdf", caption: "Invoice" } });
    await expect(tx.sendChat({ channel: "viber", to: E164, text: "x" })).rejects.toMatchObject({ status: 400 });
  });

  it("searches, orders, assigns (by number) and releases numbers", async () => {
    process.env.TELNYX_MESSAGING_PROFILE_ID = "prof-1";
    const { seen } = stubFetch(
      { json: { data: [{ record_type: "available_phone_number", phone_number: "+420800123456", best_effort: false, reservable: true,
        region_information: [{ region_type: "country_code", region_name: "CZ" }, { region_type: "location", region_name: "Praha" }],
        cost_information: { upfront_cost: "1.00", monthly_cost: "2.00", currency: "USD" }, features: [{ name: "voice" }, { name: "sms" }] }],
        meta: { total_results: 1 } } },
      { json: { data: { id: "ord-1", status: "pending", phone_numbers: [{ phone_number: "+420800123456", status: "pending" }] } } },
      { json: { data: [{ id: "1293384261075731499", phone_number: "+420800123456" }] } },
      { json: { data: { id: "1293384261075731499", connection_id: "1684641123236054244" } } },
      { json: { data: { id: "1293384261075731499", status: "deleted" } } },
    );
    const found = await tx.searchNumbers({ country: "cz", type: "tollfree", voice: true, sms: true, contains: "800", limit: 3 });
    const u = new URL(seen[0].url);
    expect(u.origin + u.pathname).toBe("https://api.telnyx.com/v2/available_phone_numbers");
    expect(u.searchParams.get("filter[country_code]")).toBe("CZ");
    expect(u.searchParams.get("filter[phone_number_type]")).toBe("toll_free");
    expect(u.searchParams.getAll("filter[features][]")).toEqual(["voice", "sms"]);
    expect(u.searchParams.get("filter[phone_number][contains]")).toBe("800");
    expect(u.searchParams.get("filter[limit]")).toBe("3");
    expect(found).toEqual([expect.objectContaining({ number: "+420800123456", country: "CZ", locality: "Praha", capabilities: ["voice", "sms"], cost: "2.00 USD/month" })]);

    const owned = await tx.buyNumber("+420800123456");
    expect(owned).toMatchObject({ id: "+420800123456", number: "+420800123456", provider: "telnyx" });
    expect(seen[1].url).toBe("https://api.telnyx.com/v2/number_orders");
    expect(json(seen[1])).toEqual({ phone_numbers: [{ phone_number: "+420800123456" }], connection_id: "1684641123236054244", messaging_profile_id: "prof-1" });

    await tx.assignNumber("+420800123456");
    expect(seen[2].method).toBe("GET");
    expect(new URL(seen[2].url).searchParams.get("filter[phone_number]")).toBe("420800123456");
    expect(seen[3].method).toBe("PATCH");
    expect(seen[3].url).toBe("https://api.telnyx.com/v2/phone_numbers/1293384261075731499");
    expect(json(seen[3])).toEqual({ connection_id: "1684641123236054244" });

    await tx.releaseNumber("1293384261075731499");
    expect(seen[4].method).toBe("DELETE");
    expect(seen[4].url).toBe("https://api.telnyx.com/v2/phone_numbers/1293384261075731499");
  });

  it("turns Telnyx errors[] into ProviderError; refuses to run unconfigured", async () => {
    stubFetch({ status: 422, json: { errors: [{ code: "10015", title: "Invalid value for connection_id", detail: "The connection does not exist.", source: { pointer: "/connection_id" } }] } });
    const e = await rejectsWith(tx.placeCall({ to: E164, from: "+15550001111", timeout: 10, eventUrl: "https://e" }), ProviderError);
    expect([e.provider, e.status, e.code]).toEqual(["telnyx", 422, "10015"]);
    expect(e.message).toBe("Telnyx 422: Invalid value for connection_id: The connection does not exist.");
    delete process.env.TELNYX_CONNECTION_ID;
    expect(tx.status().configured).toEqual(["sms", "lookup", "numbers"]);
    const nc = await rejectsWith(tx.placeCall({ to: E164, from: "+1555", timeout: 10, eventUrl: "https://e" }), ProviderNotConfigured);
    expect(nc.capability).toBe("call");
    expect(nc.message).toMatch(/TELNYX_CONNECTION_ID/);
    expect(tx.media).toEqual({ transport: "json-rtp", codec: "PCMU", rate: 8000 });
  });
});

/* ================================================================== Vonage */

describe("Vonage adapter", () => {
  const vg = new VonageAdapter();
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const priv = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
  const BASIC = `Basic ${b64("vkey1:vonage-secret")}`;
  beforeEach(() => {
    process.env.VONAGE_APPLICATION_ID = "app-42";
    process.env.VONAGE_JWT_KEY = priv;
    process.env.VONAGE_FROM = "+447700900000";
    process.env.VONAGE_API_KEY = "vkey1";
    process.env.VONAGE_API_SECRET = "vonage-secret";
  });
  const bearerOk = (s: Seen) => {
    expect(s.headers.authorization?.startsWith("Bearer ")).toBe(true);
    expect(verifyJwtRS256(s.headers.authorization.slice(7), pub)?.application_id).toBe("app-42");
  };

  it("places a call: application JWT, digits-only numbers, ringing_timer, length_timer, NCCO, event_url, AMD", async () => {
    const { seen } = stubFetch({ status: 201, json: { uuid: "u-1", status: "started", direction: "outbound", conversation_uuid: "CON-1" } });
    const r = await vg.placeCall({
      to: E164, from: "", timeout: 10, timeLimit: 600, eventUrl: "https://chat.example.org/wh/vonage/events",
      actions: [{ say: { text: "Hello" } }], machineDetection: true,
    });
    expect(r).toMatchObject({ id: "u-1", provider: "vonage", status: "initiated" });
    expect(seen[0].url).toBe("https://api.nexmo.com/v1/calls");
    expect(seen[0].method).toBe("POST");
    bearerOk(seen[0]);
    expect(json(seen[0])).toEqual({
      to: [{ type: "phone", number: "420777123456" }], from: { type: "phone", number: "447700900000" },
      ringing_timer: 10, length_timer: 600, event_url: ["https://chat.example.org/wh/vonage/events"], event_method: "POST",
      ncco: [{ action: "talk", text: "Hello" }], machine_detection: "continue",
    });
    await vg.placeCall({ to: E164, from: "+447700900009", timeout: 300, eventUrl: "https://e", answerUrl: "https://chat.example.org/wh/vonage/answer" });
    const b = json(seen[1]);
    expect(b.ringing_timer).toBe(120);
    expect(b.answer_url).toEqual(["https://chat.example.org/wh/vonage/answer"]);
    expect(b.answer_method).toBe("POST");
    expect(b.ncco).toBeUndefined();
    await vg.placeCall({ to: E164, from: "+1", timeout: 5, eventUrl: "https://e", raw: { ncco: [{ action: "talk", text: "raw" }] }, actions: [{ hangup: {} }] });
    expect(json(seen[2]).ncco).toEqual([{ action: "talk", text: "raw" }]);
  });

  it("renders every action as an NCCO (bargeIn before input, websocket connect, record; hangup ends it)", () => {
    const out = vg.renderActions([
      { say: { text: "Enter the code", language: "en-GB" } },
      { gather: { action: "https://x.test/pin", digits: 5, finishOnKey: "#", timeout: 10 } },
      { play: { url: "https://x.test/a.mp3", loop: 2 } },
      { pause: { seconds: 2 } },
      { stream: { url: "wss://h.test/media/vonage", params: { session: "abc" } } },
      { record: { action: "https://x.test/rec", maxSeconds: 60, beep: false } },
      { hangup: {} },
      { say: { text: "never spoken" } },
    ]);
    expect(out.contentType).toBe("application/json");
    expect(JSON.parse(out.body)).toEqual([
      { action: "talk", text: "Enter the code", language: "en-GB", bargeIn: true },
      { action: "input", type: ["dtmf"], dtmf: { maxDigits: 5, submitOnHash: true, timeOut: 10 }, eventUrl: ["https://x.test/pin"], eventMethod: "POST" },
      { action: "stream", streamUrl: ["https://x.test/a.mp3"], loop: 2 },
      { action: "talk", text: '<speak><break time="2s"/></speak>' },
      { action: "connect", endpoint: [{ type: "websocket", uri: "wss://h.test/media/vonage", "content-type": "audio/l16;rate=16000", headers: { session: "abc" } }] },
      { action: "record", eventUrl: ["https://x.test/rec"], eventMethod: "POST", beepStart: false, endOnKey: "#", endOnSilence: 5, timeOut: 60 },
    ]);
    const prompt = JSON.parse(vg.renderActions([{ gather: { action: "https://a", prompt: "PIN?", finishOnKey: "" } }]).body);
    expect(prompt).toEqual([
      { action: "talk", text: "PIN?", bargeIn: true },
      { action: "input", type: ["dtmf"], dtmf: { maxDigits: 20, submitOnHash: false }, eventUrl: ["https://a"], eventMethod: "POST" },
    ]);
    expect(JSON.parse(vg.renderActions([{ stream: { url: "wss://h", rate: 8000 } }]).body)[0].endpoint[0]["content-type"]).toBe("audio/l16;rate=8000");
    expect(() => vg.renderActions([{ redirect: { url: "https://r" } }])).toThrow(ProviderError);
  });

  it("executeActions transfers the call to a new NCCO (or to a URL); an empty NCCO hangs up", async () => {
    const { seen } = stubFetch({ status: 204 });
    await vg.executeActions("u-1", [{ say: { text: "Bye" } }, { hangup: {} }]);
    expect(seen[0].method).toBe("PUT");
    expect(seen[0].url).toBe("https://api.nexmo.com/v1/calls/u-1");
    bearerOk(seen[0]);
    expect(json(seen[0])).toEqual({ action: "transfer", destination: { type: "ncco", ncco: [{ action: "talk", text: "Bye" }] } });
    await vg.executeActions("u-1", [{ redirect: { url: "https://chat.example.org/next" } }]);
    expect(json(seen[1])).toEqual({ action: "transfer", destination: { type: "ncco", url: ["https://chat.example.org/next"] } });
    await vg.executeActions("u-1", [{ hangup: {} }]);
    expect(json(seen[2])).toEqual({ action: "hangup" });
    await vg.hangup("u-1");
    expect(json(seen[3])).toEqual({ action: "hangup" });
  });

  it("maps voice event statuses", () => {
    const table: Array<[string, CallStatus]> = [
      ["started", "initiated"], ["ringing", "ringing"], ["answered", "answered"], ["completed", "completed"], ["busy", "busy"],
      ["cancelled", "canceled"], ["unanswered", "no-answer"], ["timeout", "no-answer"], ["rejected", "failed"], ["failed", "failed"],
    ];
    for (const [status, mapped] of table) {
      const [ev] = vg.parseCallEvent({ from: "447700900000", to: "420777123456", uuid: "u-1", conversation_uuid: "CON-1", status, direction: "outbound", timestamp: "2026-09-29T10:00:00.000Z" }, {});
      expect(ev).toMatchObject({ provider: "vonage", callId: "u-1", status: mapped, kind: "status", direction: "outbound", eventId: `u-1:${status}:2026-09-29T10:00:00.000Z` });
    }
    const [done] = vg.parseCallEvent({ uuid: "u-1", status: "completed", duration: "42", start_time: "…", end_time: "…", rate: "0.01", price: "0.007", network: "23003" }, {});
    expect(done.durationSec).toBe(42);
    const [rej] = vg.parseCallEvent({ uuid: "u-1", status: "rejected", detail: "declined", sip_code: 603 }, {});
    expect(rej).toMatchObject({ status: "failed", cause: "declined", sipCode: "603" });
    const [m] = vg.parseCallEvent({ call_uuid: "u-1", status: "machine", sub_state: "beep_start" }, {});
    expect(m).toMatchObject({ callId: "u-1", kind: "machine", status: "machine" });
    expect(vg.parseCallEvent({ call_uuid: "u-1", status: "human" }, {})[0]).toMatchObject({ kind: "machine", status: null, cause: "human" });
  });

  it("maps input (dtmf), answer and GET-query webhooks", () => {
    const [g] = vg.parseCallEvent({ uuid: "u-1", conversation_uuid: "CON-1", dtmf: { digits: "12345", timed_out: false }, from: "447700900000", to: "420777123456" }, {});
    expect(g).toMatchObject({ kind: "gather", digits: "12345" });
    expect(vg.parseCallEvent({ uuid: "u-1", dtmf: { digits: "", timed_out: true } }, {})[0]).toMatchObject({ kind: "gather", digits: "", cause: "timeout" });
    const [a] = vg.parseCallEvent({ uuid: "u-2", conversation_uuid: "CON-2", from: "447700900000", to: "420777123456", region_url: "https://api-eu-3.vonage.com" }, {});
    expect(a).toMatchObject({ kind: "answer", callId: "u-2", status: null });
    expect(vg.parseCallEvent(undefined, { uuid: "u-3", from: "447700900000", to: "420777123456" })[0]).toMatchObject({ kind: "answer", callId: "u-3" });
    expect(vg.parseCallEvent({}, {})).toEqual([]);
  });

  it("sends SMS (SMS API form: unicode, ttl in ms, callback, client-ref) and maps a non-zero status to ProviderError", async () => {
    process.env.VONAGE_FROM = "M5cet";
    const { seen } = stubFetch(
      { json: { "message-count": "1", messages: [{ to: "420777123456", "message-id": "0A0000001234", status: "0", "remaining-balance": "3.14", "message-price": "0.0333", network: "23003" }] } },
      { json: { "message-count": "1", messages: [{ to: "420777123456", status: "0", "message-id": "0A0000001235" }] } },
      { json: { "message-count": "1", messages: [{ to: "420777123456", status: "29", "error-text": "Non-Whitelisted Destination" }] } },
    );
    const r = await vg.sendSms({ to: E164, text: "Příliš žluťoučký", options: { ttl: 60, statusUrl: "https://e/sms", clientRef: "ref-1" } });
    expect(r).toMatchObject({ id: "0A0000001234", provider: "vonage", status: "submitted", parts: 1, price: "0.0333 EUR" });
    expect(seen[0].url).toBe("https://rest.nexmo.com/sms/json");
    expect(Object.fromEntries(form(seen[0]))).toEqual({
      api_key: "vkey1", api_secret: "vonage-secret", from: "M5cet", to: "420777123456", text: "Příliš žluťoučký",
      type: "unicode", ttl: "60000", callback: "https://e/sms", "status-report-req": "1", "client-ref": "ref-1",
    });
    expect(seen[0].url).not.toContain("vonage-secret");
    await vg.sendSms({ to: E164, text: "plain ascii", options: { ttl: 5 } });
    expect(form(seen[1]).get("type")).toBeNull();
    expect(form(seen[1]).get("ttl")).toBe("20000"); // Vonage minimum
    const e = await rejectsWith(vg.sendSms({ to: E164, text: "x" }), ProviderError);
    expect([e.status, e.code]).toEqual([400, "29"]);
    expect(e.message).toMatch(/Non-Whitelisted Destination/);
    expect(e.message).not.toContain("vonage-secret");
  });

  it("looks up with Number Insight standard (Basic auth, cnam) and maps carrier, ported, caller name", async () => {
    const { seen } = stubFetch({ json: {
      status: 0, status_message: "Success", request_id: "aaaaaaaa-bbbb-cccc-dddd-0123456789ab", international_format_number: "14155550123",
      national_format_number: "(415) 555-0123", country_code: "US", country_code_iso3: "USA", country_name: "United States of America", country_prefix: "1",
      request_price: "0.00500000", remaining_balance: "1.23",
      current_carrier: { network_code: "310160", name: "T-Mobile USA, Inc.", country: "US", network_type: "mobile" },
      original_carrier: { network_code: "310260", name: "T-Mobile", country: "US", network_type: "mobile" },
      ported: "ported", caller_name: "JOHN SMITH", caller_type: "consumer", first_name: "John", last_name: "Smith",
    } });
    const r = await vg.lookup("+14155550123", ["carrier", "caller_name"]);
    expect(seen[0].method).toBe("GET");
    expect(seen[0].url).toBe("https://api.nexmo.com/ni/standard/json?number=14155550123&cnam=true");
    expect(seen[0].headers.authorization).toBe(BASIC);
    expect(seen[0].url).not.toContain("vonage-secret");
    expect(r).toMatchObject({
      number: "+14155550123", provider: "vonage", national: "(415) 555-0123",
      country: { code: "US", name: "United States of America", prefix: "+1" }, type: "mobile",
      carrier: { name: "T-Mobile USA, Inc.", mcc: "310", mnc: "160", type: "mobile" },
      callerName: "JOHN SMITH", callerType: "consumer", ported: true,
    });
    stubFetch({ json: { status: 0, international_format_number: "14155550123", country_code: "US" } });
    await vg.lookup("+14155550123", []);
    const { seen: s3 } = stubFetch({ json: { status: 0, international_format_number: "14155550123", valid_number: "valid", reachable: "reachable", roaming: { status: "not_roaming" } } });
    const adv = await vg.lookup("+14155550123", ["line_status"]);
    expect(s3[0].url).toBe("https://api.nexmo.com/ni/advanced/json?number=14155550123");
    expect(adv).toMatchObject({ valid: true, reachable: "reachable", roaming: { status: "not_roaming" } });
  });

  it("maps Number Insight advanced to an HLR result", async () => {
    const adv = {
      status: 0, status_message: "Success", international_format_number: "447700900000", national_format_number: "07700 900000",
      country_code: "GB", country_name: "United Kingdom", country_prefix: "44", request_price: "0.03000000",
      current_carrier: { network_code: "23420", name: "Hutchison 3G Ltd", country: "GB", network_type: "mobile" },
      original_carrier: { network_code: "23410", name: "Telefonica UK Limited", country: "GB", network_type: "mobile" },
      valid_number: "valid", reachable: "reachable", ported: "ported",
      roaming: { status: "roaming", roaming_country_code: "US", roaming_network_code: "310260", roaming_network_name: "T-Mobile US" },
      lookup_outcome: 0, lookup_outcome_message: "Success",
    };
    const { seen } = stubFetch({ json: adv });
    const h = await vg.hlr("+447700900000");
    expect(seen[0].url).toBe("https://api.nexmo.com/ni/advanced/json?number=447700900000");
    expect(h).toEqual({
      number: "+447700900000", provider: "vonage", status: "connected", valid: true, reachable: "reachable",
      network: { name: "Hutchison 3G Ltd", mcc: "234", mnc: "20", country: "GB" },
      original: { name: "Telefonica UK Limited", country: "GB" }, ported: true,
      roaming: { status: "roaming", country: "US", network: "T-Mobile US" }, cost: "0.03000000 EUR", raw: adv,
    });
    stubFetch({ json: { ...adv, reachable: "absent", roaming: "unknown" } });
    expect((await vg.hlr("+447700900000")).status).toBe("absent");
    stubFetch({ json: { ...adv, reachable: "bad_number", valid_number: "not_valid" } });
    expect(await vg.hlr("+447700900000")).toMatchObject({ status: "invalid", valid: false });
    stubFetch({ json: { ...adv, reachable: "unknown", valid_number: "unknown" } });
    expect((await vg.hlr("+447700900000")).status).toBe("undetermined");
    stubFetch({ json: { status: 4, status_message: "Invalid credentials" } });
    const e = await rejectsWith(vg.hlr("+447700900000"), ProviderError);
    expect([e.status, e.code]).toEqual([401, "4"]);
  });

  it("sends WhatsApp through the Messages API (Bearer JWT; text and Meta-native template); sandbox host", async () => {
    process.env.VONAGE_WHATSAPP_FROM = "+447700900001";
    const { seen } = stubFetch({ status: 202, json: { message_uuid: "aaaaaaaa-bbbb-cccc-dddd-0123456789ab" } });
    const r = await vg.sendChat({ channel: "whatsapp", to: E164, text: "Ahoj", clientRef: "c-1", statusUrl: "https://e/msg" });
    expect(r).toMatchObject({ id: "aaaaaaaa-bbbb-cccc-dddd-0123456789ab", provider: "vonage", channel: "whatsapp", status: "submitted" });
    expect(seen[0].url).toBe("https://api.nexmo.com/v1/messages");
    bearerOk(seen[0]);
    expect(json(seen[0])).toEqual({ to: "420777123456", from: "447700900001", channel: "whatsapp", message_type: "text", text: "Ahoj", client_ref: "c-1", webhook_url: "https://e/msg" });
    await vg.sendChat({ channel: "whatsapp", to: E164, template: { name: "pin_code", language: "en_GB", params: ["12345"] } });
    expect(json(seen[1])).toMatchObject({
      message_type: "custom",
      custom: { type: "template", template: { name: "pin_code", language: { policy: "deterministic", code: "en_GB" }, components: [{ type: "body", parameters: [{ type: "text", text: "12345" }] }] } },
    });
    await vg.sendChat({ channel: "whatsapp", to: E164, text: "Photo", media: { url: "https://x.test/p.jpg", type: "image" } });
    expect(json(seen[2])).toMatchObject({ message_type: "image", image: { url: "https://x.test/p.jpg", caption: "Photo" } });
    process.env.VONAGE_MESSAGES_SANDBOX = "1";
    await vg.sendChat({ channel: "whatsapp", to: E164, text: "sandbox" });
    expect(seen[3].url).toBe("https://messages-sandbox.nexmo.com/v1/messages");
  });

  it("sends Viber (viber_service + category) and Messenger (messenger.category / tag)", async () => {
    process.env.VONAGE_VIBER_FROM = "16273";
    process.env.VONAGE_MESSENGER_PAGE_ID = "107654321098765";
    const { seen } = stubFetch({ status: 202, json: { message_uuid: "m-1" } });
    const v = await vg.sendChat({ channel: "viber", to: "+447700900002", text: "Your code is 12345", category: "transaction" });
    expect(v.channel).toBe("viber");
    expect(json(seen[0])).toEqual({ to: "447700900002", from: "16273", channel: "viber_service", message_type: "text", text: "Your code is 12345", viber_service: { category: "transaction" } });
    await vg.sendChat({ channel: "messenger", to: "4567890123456", text: "An agent will reply", category: "MESSAGE_TAG", tag: "HUMAN_AGENT" });
    expect(json(seen[1])).toEqual({ to: "4567890123456", from: "107654321098765", channel: "messenger", message_type: "text", text: "An agent will reply", messenger: { category: "message_tag", tag: "HUMAN_AGENT" } });
    await vg.sendChat({ channel: "messenger", to: "4567890123456", text: "ignored caption", media: { url: "https://x.test/p.jpg", type: "image" } });
    expect(json(seen[2])).toMatchObject({ message_type: "image", image: { url: "https://x.test/p.jpg" } });
    expect(json<{ image: Record<string, unknown> }>(seen[2]).image.caption).toBeUndefined();
    await expect(vg.sendChat({ channel: "viber", to: "447700900002", text: "x" })).rejects.toMatchObject({ status: 400 });
  });

  it("searches, buys (and links to the application), assigns and releases numbers with Basic auth", async () => {
    const ok = { json: { "error-code": "200", "error-code-label": "success" } };
    const { seen } = stubFetch(
      { json: { count: 1, numbers: [{ country: "CZ", msisdn: "420777000111", type: "mobile-lvn", cost: "1.25", features: ["VOICE", "SMS"] }] } },
      ok, ok, ok, ok,
      { json: { "error-code": "420", "error-code-label": "method failed" } },
    );
    const found = await vg.searchNumbers({ country: "CZ", type: "mobile", voice: true, sms: true, contains: "777", limit: 5 });
    expect(seen[0].method).toBe("GET");
    expect(seen[0].url).toBe("https://rest.nexmo.com/number/search?country=CZ&type=mobile-lvn&features=SMS%2CVOICE&pattern=777&search_pattern=1&size=5");
    expect(seen[0].headers.authorization).toBe(BASIC);
    expect(found).toEqual([expect.objectContaining({ number: "+420777000111", country: "CZ", capabilities: ["voice", "sms"], cost: "1.25 EUR/month" })]);

    const owned = await vg.buyNumber("+420777000111", { country: "CZ", voiceUrl: "https://chat.example.org/wh/vonage/answer" });
    expect(owned).toMatchObject({ id: "420777000111", number: "+420777000111", provider: "vonage" });
    expect(seen[1].url).toBe("https://rest.nexmo.com/number/buy");
    expect(Object.fromEntries(form(seen[1]))).toEqual({ country: "CZ", msisdn: "420777000111" });
    expect(seen[2].url).toBe("https://rest.nexmo.com/number/update");
    expect(Object.fromEntries(form(seen[2]))).toEqual({ country: "CZ", msisdn: "420777000111", app_id: "app-42" });

    await vg.assignNumber("420777000111", { country: "cz" });
    expect(Object.fromEntries(form(seen[3]))).toEqual({ country: "CZ", msisdn: "420777000111", app_id: "app-42" });
    await vg.releaseNumber("+420777000111", { country: "CZ" });
    expect(seen[4].url).toBe("https://rest.nexmo.com/number/cancel");
    expect(seen[4].headers.authorization).toBe(BASIC);
    const e = await rejectsWith(vg.releaseNumber("+420777000111", { country: "CZ" }), ProviderError);
    expect([e.status, e.code]).toEqual([420, "420"]);
    await expect(vg.assignNumber("+420777000111", {})).rejects.toMatchObject({ status: 400 });
  });

  it("reports status, refuses to run unconfigured and explains a rejected token", async () => {
    expect(vg.status().configured).toEqual(["call", "sms", "lookup", "hlr", "numbers", "media"]);
    expect(vg.media).toEqual({ transport: "binary-l16", codec: "L16", rate: 16000 });
    stubFetch({ status: 401, json: { type: "https://developer.nexmo.com/api-errors#unauthorized", title: "Unauthorized", detail: "You did not provide correct credentials." } });
    const e401 = await rejectsWith(vg.placeCall({ to: E164, from: "+1", timeout: 10, eventUrl: "https://e", answerUrl: "https://a" }), ProviderError);
    expect(e401.status).toBe(401);
    expect(e401.message).toMatch(/VONAGE_APPLICATION_ID/);
    expect(e401.message.length).toBeLessThanOrEqual(300);

    delete process.env.VONAGE_JWT_KEY;
    delete process.env.VONAGE_API_SECRET;
    const st = vg.status();
    expect(st.configured).toEqual([]);
    expect(st.reason).toMatch(/VONAGE_JWT_KEY/);
    const { fn } = stubFetch({ json: {} });
    const nc = await rejectsWith(vg.placeCall({ to: E164, from: "+1", timeout: 10, eventUrl: "https://e", answerUrl: "https://a" }), ProviderNotConfigured);
    expect([nc.provider, nc.capability]).toEqual(["vonage", "call"]);
    expect(nc.message).toMatch(/VONAGE_JWT_KEY/);
    const ns = await rejectsWith(vg.sendSms({ to: E164, text: "x" }), ProviderNotConfigured);
    expect(ns.message).toMatch(/VONAGE_API_KEY and VONAGE_API_SECRET/);
    expect(fn).not.toHaveBeenCalled();
  });
});

/* ============================================================ HLR-Lookups */

describe("HLR-Lookups.com adapter", () => {
  const NOW = 1_790_000_000_000; // ms → X-Digest-Timestamp 1790000000
  const hl = new HlrLookupsAdapter(() => NOW);
  const answer = {
    id: "f94ef092cb53", msisdn: "+491788735000", connectivity_status: "CONNECTED", mccmnc: "26203", mcc: "262", mnc: "03",
    imsi: "26203XXXXXXXXXX", msin: "XXXXXXXXXX", msc: "491770190000",
    original_network_name: "Telefónica O2 Germany", original_country_name: "Germany", original_country_code: "DE", original_country_prefix: "+49",
    is_ported: true, ported_network_name: "Vodafone", ported_country_name: "Germany", ported_country_code: "DE", ported_country_prefix: "+49",
    is_roaming: true, roaming_network_name: "Swisscom", roaming_country_name: "Switzerland", roaming_country_code: "CH", roaming_country_prefix: "+41",
    cost: "0.0100", timestamp: "2026-09-29T10:00:00+00:00", storage: "SDK-TEST", route: "IP1", processing_status: "COMPLETED",
    error_code: null, error_description: null, data_source: "LIVE_HLR", routing_instruction: "STATIC:IP1",
  };
  beforeEach(() => {
    process.env.HLRLOOKUPS_API_KEY = "hlr-key";
    process.env.HLRLOOKUPS_API_SECRET = "hlr-secret-value";
  });

  it("signs the request (X-Digest-*: HMAC-SHA256 of path + timestamp + method + body, hex)", async () => {
    const { seen } = stubFetch({ json: answer });
    await hl.hlr("+491788735000");
    expect(seen[0].url).toBe("https://www.hlr-lookups.com/api/v2/hlr-lookup");
    expect(seen[0].method).toBe("POST");
    expect(seen[0].body).toBe('{"msisdn":"+491788735000"}');
    expect(seen[0].headers["x-digest-key"]).toBe("hlr-key");
    expect(seen[0].headers["x-digest-timestamp"]).toBe("1790000000");
    expect(seen[0].headers["x-digest-signature"]).toBe("997fc8db45a0ac1c0e8ecc70bb2de21de9967b3c3c8ae50803aece5962aec6c8");
    expect(hlrLookupsSignature("/hlr-lookup", 1790000000, "POST", '{"msisdn":"+491788735000"}', "hlr-secret-value"))
      .toBe("997fc8db45a0ac1c0e8ecc70bb2de21de9967b3c3c8ae50803aece5962aec6c8");
    expect(JSON.stringify(seen)).not.toContain("hlr-secret-value");
  });

  it("uses the real clock by default (fake Date)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    const { seen } = stubFetch({ json: answer });
    await new HlrLookupsAdapter().hlr("+491788735000");
    expect(seen[0].headers["x-digest-timestamp"]).toBe("1790000000");
    expect(seen[0].headers["x-digest-signature"]).toBe("997fc8db45a0ac1c0e8ecc70bb2de21de9967b3c3c8ae50803aece5962aec6c8");
  });

  it("maps connectivity, networks, porting, roaming, IMSI and cost", async () => {
    stubFetch({ json: answer });
    const h = await hl.hlr("+491788735000");
    expect(h).toEqual({
      number: "+491788735000", provider: "hlrlookups", status: "connected", valid: true, reachable: "CONNECTED",
      network: { name: "Vodafone", mcc: "262", mnc: "03", country: "DE" },
      original: { name: "Telefónica O2 Germany", country: "DE" }, ported: true,
      roaming: { status: "roaming", country: "CH", network: "Swisscom" }, imsi: "26203XXXXXXXXXX", cost: "0.0100 EUR", raw: answer,
    });
    stubFetch({ json: { ...answer, connectivity_status: "ABSENT", is_roaming: false, is_ported: false } });
    const absent = await hl.hlr("+491788735000");
    expect(absent).toMatchObject({ status: "absent", ported: false, roaming: { status: "not_roaming" }, network: { name: "Telefónica O2 Germany" } });
    stubFetch({ json: { ...answer, connectivity_status: "INVALID_MSISDN", is_roaming: null, is_ported: null } });
    expect(await hl.hlr("+491788735000")).toMatchObject({ status: "invalid", valid: false, roaming: null, ported: null });
    stubFetch({ json: { ...answer, connectivity_status: "UNDETERMINED" } });
    expect(await hl.hlr("+491788735000")).toMatchObject({ status: "undetermined", valid: null });
  });

  it("errors: provider error, bad number, not configured", async () => {
    stubFetch({ status: 401, json: { success: false, errors: [{ code: 1000, message: "Invalid digest signature" }] } });
    const e = await rejectsWith(hl.hlr("+491788735000"), ProviderError);
    expect([e.provider, e.status, e.code, e.message]).toEqual(["hlrlookups", 401, "1000", "HLR-Lookups 401: Invalid digest signature"]);
    const { fn } = stubFetch({ json: answer });
    await expect(hl.hlr("0049178")).rejects.toMatchObject({ status: 400 });
    delete process.env.HLRLOOKUPS_API_SECRET;
    const nc = await rejectsWith(hl.hlr("+491788735000"), ProviderNotConfigured);
    expect(nc.message).toMatch(/HLRLOOKUPS_API_KEY and HLRLOOKUPS_API_SECRET/);
    expect(hl.status()).toMatchObject({ capabilities: ["hlr"], configured: [], needs: { hlr: ["HLRLOOKUPS_API_KEY", "HLRLOOKUPS_API_SECRET"] } });
    expect(fn).not.toHaveBeenCalled();
  });
});

/* =================================================================== Meta */

describe("Meta (Messenger) adapter", () => {
  const meta = new MetaAdapter();
  beforeEach(() => {
    process.env.META_PAGE_ID = "1234567890";
    process.env.META_PAGE_TOKEN = "EAAG-page-token-secret";
  });

  it("sends through the Graph Send API with the page token as a Bearer header (never in the URL)", async () => {
    const { seen } = stubFetch({ json: { recipient_id: "4567890123456", message_id: "m_AG5Hz2Uq7tuwNEhXfYYKj8mJEM" } });
    const r = await meta.sendChat({ channel: "messenger", to: "4567890123456", text: "Ahoj" });
    expect(r).toEqual({ id: "m_AG5Hz2Uq7tuwNEhXfYYKj8mJEM", provider: "meta", channel: "messenger", status: "sent", raw: { recipient_id: "4567890123456", message_id: "m_AG5Hz2Uq7tuwNEhXfYYKj8mJEM" } });
    expect(seen[0].url).toBe("https://graph.facebook.com/v26.0/1234567890/messages");
    expect(seen[0].url).not.toContain("access_token");
    expect(seen[0].headers.authorization).toBe("Bearer EAAG-page-token-secret");
    expect(json(seen[0])).toEqual({ recipient: { id: "4567890123456" }, messaging_type: "RESPONSE", message: { text: "Ahoj" } });

    process.env.META_GRAPH_VERSION = "v27.0";
    await meta.sendChat({ channel: "messenger", to: "4567890123456", text: "An agent", tag: "HUMAN_AGENT" });
    expect(seen[1].url).toBe("https://graph.facebook.com/v27.0/1234567890/messages");
    expect(json(seen[1])).toEqual({ recipient: { id: "4567890123456" }, messaging_type: "MESSAGE_TAG", message: { text: "An agent" }, tag: "HUMAN_AGENT" });

    await meta.sendChat({ channel: "messenger", to: "4567890123456", media: { url: "https://x.test/p.jpg", type: "image" }, category: "UPDATE" });
    expect(json(seen[2])).toEqual({ recipient: { id: "4567890123456" }, messaging_type: "UPDATE", message: { attachment: { type: "image", payload: { url: "https://x.test/p.jpg", is_reusable: false } } } });
  });

  it("maps Graph errors; refuses other channels, bad categories and a missing token", async () => {
    stubFetch({ status: 400, json: { error: { message: "(#100) Tag CONFIRMED_EVENT_UPDATE is no longer supported", type: "OAuthException", code: 100, fbtrace_id: "Abc" } } });
    const e = await rejectsWith(meta.sendChat({ channel: "messenger", to: "1", text: "x", category: "MESSAGE_TAG", tag: "CONFIRMED_EVENT_UPDATE" }), ProviderError);
    expect([e.provider, e.status, e.code]).toEqual(["meta", 400, "100"]);
    expect(e.message).toMatch(/no longer supported/);
    expect(e.message).not.toContain("EAAG-page-token-secret");
    const { fn } = stubFetch({ json: {} });
    await expect(meta.sendChat({ channel: "whatsapp", to: E164, text: "x" })).rejects.toMatchObject({ status: 400 });
    await expect(meta.sendChat({ channel: "messenger", to: "1", text: "x", category: "PROMO" })).rejects.toMatchObject({ status: 400 });
    await expect(meta.sendChat({ channel: "messenger", to: "1", text: "x", category: "MESSAGE_TAG" })).rejects.toMatchObject({ status: 400 });
    delete process.env.META_PAGE_TOKEN;
    const nc = await rejectsWith(meta.sendChat({ channel: "messenger", to: "1", text: "x" }), ProviderNotConfigured);
    expect(nc.message).toMatch(/META_PAGE_TOKEN/);
    expect(meta.status()).toMatchObject({ capabilities: ["messenger"], configured: [] });
    expect(fn).not.toHaveBeenCalled();
  });
});

/* =============================================================== registry */

describe("provider registry", () => {
  it("lists the adapters in order and finds them by id", () => {
    expect(adapters().map((a) => a.id)).toEqual(["twilio", "telnyx", "vonage", "hlrlookups", "meta"]);
    expect(adapter("vonage")?.label).toBe("Vonage");
    expect(adapter("nope")).toBeUndefined();
    expect(adapters().map((a) => a.channels ?? [])).toEqual([["whatsapp", "messenger"], ["whatsapp"], ["whatsapp", "viber", "messenger"], [], ["messenger"]]);
  });

  it("reports every status with env names only, never values", () => {
    expect(providerStatuses().map((s) => [s.id, s.configured])).toEqual([["twilio", []], ["telnyx", []], ["vonage", []], ["hlrlookups", []], ["meta", []]]);
    process.env.TWILIO_ACCOUNT_SID = "AC0123456789abcdef";
    process.env.TWILIO_AUTH_TOKEN = "super-secret-token";
    process.env.META_PAGE_TOKEN = "EAAG-another-secret";
    const text = JSON.stringify(providerStatuses());
    expect(text).not.toContain("super-secret-token");
    expect(text).not.toContain("EAAG-another-secret");
    expect(text).toContain("TWILIO_AUTH_TOKEN");
  });

  it("pick(): the preferred adapter when configured for the capability, else the first configured one, else undefined", () => {
    expect(pick("sms")).toBeUndefined();
    process.env.TELNYX_API_KEY = "k";
    expect(pick("sms")?.id).toBe("telnyx");
    process.env.TWILIO_ACCOUNT_SID = "AC0123456789abcdef";
    process.env.TWILIO_AUTH_TOKEN = "t";
    expect(pick("sms")?.id).toBe("twilio");
    expect(pick("sms", "telnyx")?.id).toBe("telnyx");
    expect(pick("sms", "vonage")?.id).toBe("twilio"); // preferred but not configured
    expect(pick("sms", "meta")?.id).toBe("twilio");   // preferred but without the capability
    expect(pick("call")?.id).toBe("twilio");
    expect(pick("call", "telnyx")?.id).toBe("twilio"); // Telnyx call needs TELNYX_CONNECTION_ID
    expect(pick("hlr")).toBeUndefined();
    process.env.HLRLOOKUPS_API_KEY = "k";
    process.env.HLRLOOKUPS_API_SECRET = "s";
    expect(pick("hlr")?.id).toBe("hlrlookups");
    process.env.VONAGE_API_KEY = "k";
    process.env.VONAGE_API_SECRET = "s";
    expect(pick("hlr")?.id).toBe("vonage");
    expect(pick("hlr", "hlrlookups")?.id).toBe("hlrlookups");
    expect(pick("messenger")).toBeUndefined();
    process.env.META_PAGE_ID = "1";
    process.env.META_PAGE_TOKEN = "t";
    expect(pick("messenger")?.id).toBe("meta");
    expect(pick("viber")).toBeUndefined();
  });
});

/* ======================================================= connectors fixes */

describe("connectors.ts fixes from the API research", () => {
  it("Twilio test call sends StatusCallbackEvent as a repeated form field", async () => {
    process.env.TWILIO_ACCOUNT_SID = "AC0123456789abcdef";
    process.env.TWILIO_AUTH_TOKEN = "t";
    process.env.TWILIO_FROM = "+15005550006";
    process.env.PUBLIC_BASE_URL = "https://chat.example.org";
    const { seen } = stubFetch({ status: 201, json: { sid: "CA1" } });
    const r = await new TwilioVoiceConnector().placeCall({ to: E164 });
    expect(r).toEqual({ id: "CA1", provider: "twilio" });
    const f = form(seen[0]);
    expect(f.getAll("StatusCallbackEvent")).toEqual(["initiated", "ringing", "answered", "completed"]);
    expect(f.get("StatusCallback")).toBe("https://chat.example.org/wh/twilio/voice_status");
    expect(f.get("Url")).toBe("https://chat.example.org/wh/twilio/voice");
  });

  it("Vonage webhook install turns on signed callbacks for the voice capability", async () => {
    process.env.PUBLIC_BASE_URL = "https://chat.example.org";
    process.env.VONAGE_APPLICATION_ID = "app-42";
    process.env.VONAGE_API_KEY = "k";
    process.env.VONAGE_API_SECRET = "s";
    const { seen } = stubFetch(
      { json: { id: "app-42", name: "M5", capabilities: { voice: { webhooks: {}, region: "eu-west" } } } },
      { json: { id: "app-42" } },
    );
    const r = await installProviderWebhooks("vonage");
    expect(r.ok).toBe(true);
    expect(seen[1].method).toBe("PUT");
    const voice = json<{ capabilities: { voice: Record<string, unknown> } }>(seen[1]).capabilities.voice;
    expect(voice.signed_callbacks).toBe(true);
    expect(voice.region).toBe("eu-west");
    expect(voice.webhooks).toMatchObject({ answer_url: { address: "https://chat.example.org/wh/vonage/answer" } });
  });
});
