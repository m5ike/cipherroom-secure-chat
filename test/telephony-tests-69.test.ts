// @vitest-environment node
//
// Telephony › Tests and › Log on the admin service (6.9, control/tests.ts):
// every test without credentials says what is missing; with the providers'
// APIs faked: the provider checks, a signed synthetic webhook delivered to a
// live main service (and found in the log), the route preview (no secret in
// it), a test call over a SIP trunk through the outbound rules, a test SMS,
// voice into a room, the test SIP address at each provider, and the log API.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const dir = mkdtempSync(join(tmpdir(), "m5teltests-"));
Object.assign(process.env, { DATA_DIR: dir, TELEPHONY_DB_FILE: join(dir, "telephony.db"), TELEPHONY_DATA_FILE: join(dir, "telephony.json") });

const PROVIDER_ENV = [
  "PUBLIC_BASE_URL", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM", "TELNYX_API_KEY", "TELNYX_CONNECTION_ID", "TELNYX_FROM", "TELNYX_PUBLIC_KEY",
  "VONAGE_API_KEY", "VONAGE_API_SECRET", "VONAGE_APPLICATION_ID", "VONAGE_JWT_KEY", "VONAGE_PRIVATE_KEY", "VONAGE_PRIVATE_KEY_PATH", "VONAGE_FROM", "VONAGE_SIGNATURE_SECRET",
  "TELEPHONY_DID_POOL", "SIP_TRUNKS", "SMS_PROVIDER", "VOICE_PROVIDER",
];
for (const k of PROVIDER_ENV) delete process.env[k];

const express = (await import("express")).default;
const { registerTelTestRoutes } = await import("../server/telephony/control/tests");
const { registerWebhookRoutes } = await import("../server/telephony/webhooks");
const { registerTelEngineRoutes } = await import("../server/telephony/tel-routes");
const { telHooks } = await import("../server/telephony/control/hooks");
const { DEFAULT_PERMISSIONS } = await import("../server/telephony/control/types");
const { loadTelephonyFile, saveTelephonyFile } = await import("../server/telephony/store");
const { writeLog, logFlushed } = await import("../server/telephony/control/log");
type RouteQuestion = import("../server/telephony/control/types").RouteQuestion;
type RouteDecision = import("../server/telephony/control/types").RouteDecision;

/* --------------------------------------------------------- faked providers */

type Sent = { url: string; method: string; body: string; headers: Record<string, string> };
const sent: Sent[] = [];
type Reply = { status?: number; json?: unknown };
let replies: Array<[RegExp, Reply | ((s: Sent) => Reply)]> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);
  const s: Sent = { url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "", headers: Object.fromEntries(new Headers(init?.headers).entries()) };
  sent.push(s);
  const hit = replies.find(([re]) => re.test(`${s.method} ${url}`));
  const r = hit ? (typeof hit[1] === "function" ? hit[1](s) : hit[1]) : { status: 404, json: { message: "not faked" } };
  return new Response(r.status === 204 ? null : JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
const form = (s: Sent) => Object.fromEntries(new URLSearchParams(s.body));
const json = (s: Sent) => JSON.parse(s.body) as Record<string, unknown>;

/* ---------------------------------------------------------------- services */

let admin: Server; let main: Server;
let adminBase = ""; let mainBase = "";
let principal: { name: string; role: string } | null = { name: "boss", role: "owner" };
beforeAll(async () => {
  const a = express();
  a.use(express.json());
  a.use((_req, res, next) => { if (principal) { res.locals.adminName = principal.name; res.locals.adminRole = principal.role; } next(); });
  registerTelTestRoutes(a);
  a.put("/admin/telephony/settings", (_req, res) => { res.json({ ok: true }); });
  admin = a.listen(0, "127.0.0.1");
  const m = express();
  const raw = { verify: (req: unknown, _res: unknown, buf: Buffer) => { (req as { rawBody?: Buffer }).rawBody = buf; } };
  m.use(express.urlencoded({ extended: false, ...raw }));
  m.use(express.json(raw));
  registerWebhookRoutes(m);
  registerTelEngineRoutes(m);
  main = m.listen(0, "127.0.0.1");
  await Promise.all([new Promise((r) => admin.once("listening", r)), new Promise((r) => main.once("listening", r))]);
  adminBase = `http://127.0.0.1:${(admin.address() as AddressInfo).port}`;
  mainBase = `http://127.0.0.1:${(main.address() as AddressInfo).port}`;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  for (const k of ["decide", "tsa", "inroute", "permissions"] as const) delete telHooks[k];
  for (const s of [admin, main]) { s.closeAllConnections?.(); await new Promise((r) => s.close(r)); }
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  for (const k of PROVIDER_ENV) delete process.env[k];
  for (const k of ["decide", "tsa", "inroute"] as const) delete telHooks[k];
  telHooks.permissions = () => structuredClone(DEFAULT_PERMISSIONS);
  replies = [];
  sent.length = 0;
  principal = { name: "boss", role: "owner" };
});

async function call(method: string, path: string, body?: unknown) {
  const r = await realFetch(`${adminBase}${path}`, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, json: await r.json() as Record<string, any> };
}
const check = (r: { json: Record<string, any> }, id: string) => (r.json.checks as Array<{ id: string; ok: boolean | null; detail: string }>).find((c) => c.id === id)!;

/* ======================================================== without credentials */

describe("without credentials every test says what is missing", () => {
  it("provider, webhook, route, call, sms, room voice, SIP address", async () => {
    const p = await call("POST", "/admin/telephony/tests/provider", { provider: "twilio" });
    expect(p.json.ok).toBe(false);
    expect(check(p, "base")).toMatchObject({ ok: false, detail: expect.stringContaining("PUBLIC_BASE_URL") });
    expect(check(p, "credentials")).toMatchObject({ ok: false, detail: expect.stringContaining("TWILIO_ACCOUNT_SID") });
    expect(check(p, "account")).toMatchObject({ ok: null, detail: "skipped: set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN" });
    expect(sent).toHaveLength(0);
    expect(check(await call("POST", "/admin/telephony/tests/provider", { provider: "nope" }), "provider").detail).toContain("twilio, telnyx or vonage");

    expect(check(await call("POST", "/admin/telephony/tests/webhook", { provider: "vonage" }), "base")).toMatchObject({ ok: false });
    expect(check(await call("POST", "/admin/telephony/tests/route", { direction: "inbound", from: "+1", to: "+2" }), "rules").detail).toContain("not loaded");
    expect(check(await call("POST", "/admin/telephony/tests/call", { to: "123" }), "to").ok).toBe(false);
    const c = await call("POST", "/admin/telephony/tests/call", { to: "+420777123456" });
    expect(check(c, "rules").ok).toBeNull();
    expect(check(c, "placed")).toMatchObject({ ok: false, detail: expect.stringContaining("no provider is configured for call") });
    expect(check(await call("POST", "/admin/telephony/tests/sms", { to: "+420777123456", text: "x" }), "sent").detail).toContain("no provider is configured for sms");
    expect(check(await call("POST", "/admin/telephony/tests/room-voice", { room: "r3.abc", type: "room" }), "inroute").detail).toContain("not loaded");
    const sip = await call("POST", "/admin/telephony/tests/sip-address", { provider: "telnyx" });
    expect(sip.status).toBe(400);
    expect(sip.json.message).toMatch(/Set TELNYX_API_KEY, TELNYX_CONNECTION_ID, PUBLIC_BASE_URL/);
    const listed = await call("GET", "/admin/telephony/tests/sip-address");
    expect(listed.json).toMatchObject({ ok: true, address: null });
    expect(listed.json.providers.map((x: { id: string; can: boolean }) => [x.id, x.can])).toEqual([["twilio", false], ["telnyx", false], ["vonage", false]]);
  });

  it("the module's permissions refuse a blocked number before anything is dialled", async () => {
    process.env.TWILIO_ACCOUNT_SID = "AC1"; process.env.TWILIO_AUTH_TOKEN = "t";
    const r = await call("POST", "/admin/telephony/tests/call", { to: "+19005550100" });
    expect(check(r, "permissions")).toMatchObject({ ok: false, detail: expect.stringContaining("+1900*") });
    expect(sent).toHaveLength(0);
  });
});

/* ===================================================================== provider */

describe("provider checks against the (faked) APIs", () => {
  it("Twilio: account + balance, numbers and their Voice URLs", async () => {
    Object.assign(process.env, { PUBLIC_BASE_URL: "https://chat.example.org", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tw-secret" });
    replies = [
      [/GET https:\/\/api\.twilio\.com\/2010-04-01\/Accounts\/AC1\.json$/, { json: { friendly_name: "Main", status: "active" } }],
      [/Balance\.json$/, { json: { balance: "12.50", currency: "USD" } }],
      [/IncomingPhoneNumbers\.json/, { json: { incoming_phone_numbers: [{ phone_number: "+15005550006", voice_url: "https://chat.example.org/wh/twilio/voice" }, { phone_number: "+15005550008", voice_url: "https://other.example/x" }] } }],
    ];
    const r = await call("POST", "/admin/telephony/tests/provider", { provider: "twilio" });
    expect(check(r, "account")).toMatchObject({ ok: true, detail: "Main — active, balance 12.50 USD" });
    expect(check(r, "numbers")).toMatchObject({ ok: true, detail: "+15005550006, +15005550008" });
    expect(check(r, "webhooks").detail).toContain("1 of 2 numbers point here");
    expect(check(r, "signature").ok).toBe(true);
    expect(sent.every((s) => s.headers.authorization === `Basic ${Buffer.from("AC1:tw-secret").toString("base64")}`)).toBe(true);
    expect(JSON.stringify(r.json)).not.toContain("tw-secret");
  });

  it("Telnyx: balance, numbers on the application, the application's webhook URL", async () => {
    Object.assign(process.env, { PUBLIC_BASE_URL: "https://chat.example.org", TELNYX_API_KEY: "KEY1", TELNYX_CONNECTION_ID: "app-9" });
    replies = [
      [/GET https:\/\/api\.telnyx\.com\/v2\/balance$/, { json: { data: { balance: "5.00", currency: "USD", available_credit: "5.00" } } }],
      [/phone_numbers/, { json: { data: [{ phone_number: "+15005550007", connection_id: "app-9" }] } }],
      [/call_control_applications\/app-9$/, { json: { data: { webhook_event_url: "https://chat.example.org/wh/telnyx/events", inbound: { sip_subdomain: "m5cet-1" } } } }],
    ];
    const r = await call("POST", "/admin/telephony/tests/provider", { provider: "telnyx" });
    expect(check(r, "account")).toMatchObject({ ok: true });
    expect(check(r, "numbers").detail).toContain("1 on the Call Control application");
    expect(check(r, "webhooks")).toMatchObject({ ok: true, detail: expect.stringContaining("m5cet-1.sip.telnyx.com") });
    expect(check(r, "signature")).toMatchObject({ ok: false, detail: expect.stringContaining("TELNYX_PUBLIC_KEY") });
  });

  it("Vonage: balance, numbers linked to the application, the application's voice webhooks; an API error is reported as the provider says it", async () => {
    Object.assign(process.env, { PUBLIC_BASE_URL: "https://chat.example.org", VONAGE_API_KEY: "vk", VONAGE_API_SECRET: "vs-secret", VONAGE_APPLICATION_ID: "app-v" });
    replies = [
      [/get-balance$/, { json: { value: 3.14, autoReload: false } }],
      [/account\/numbers/, { json: { count: 1, numbers: [{ msisdn: "447700900000", app_id: "app-v" }] } }],
      [/v2\/applications\/app-v$/, { status: 401, json: { title: "Unauthorized", detail: "bad credentials" } }],
    ];
    const r = await call("POST", "/admin/telephony/tests/provider", { provider: "vonage" });
    expect(check(r, "account").detail).toBe("balance 3.14 EUR");
    expect(check(r, "numbers").detail).toContain("+447700900000 — 1 linked to the application");
    expect(check(r, "webhooks")).toMatchObject({ ok: false, detail: "HTTP 401: Unauthorized: bad credentials" });
    expect(sent.every((s) => !s.url.includes("vs-secret"))).toBe(true);
  });
});

/* ===================================================================== webhook */

describe("the webhook test reaches the main service through its public URL", () => {
  it("Twilio: signed, accepted, verified and logged", async () => {
    Object.assign(process.env, { PUBLIC_BASE_URL: mainBase, TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tw-secret" });
    const r = await call("POST", "/admin/telephony/tests/webhook", { provider: "twilio" });
    expect(r.json.ok).toBe(true);
    expect(check(r, "answer")).toMatchObject({ ok: true, detail: "HTTP 200 as expected" });
    expect(check(r, "logged")).toMatchObject({ ok: true, detail: "verified: true" });
    const log = await call("GET", "/admin/telephony/log?kind=webhook&limit=5");
    expect(log.json.entries[0].summary).toMatch(/^\[test\] twilio voice_status/);
  });

  it("Vonage: a signed JWT with payload_hash is verified", async () => {
    Object.assign(process.env, { PUBLIC_BASE_URL: mainBase, VONAGE_SIGNATURE_SECRET: "vsig-secret" });
    const r = await call("POST", "/admin/telephony/tests/webhook", { provider: "vonage" });
    expect(check(r, "answer").ok).toBe(true);
    expect(check(r, "logged").detail).toBe("verified: true");
  });

  it("Telnyx: only Telnyx can sign — with the public key set, the unsigned event must be refused", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
    Object.assign(process.env, { PUBLIC_BASE_URL: mainBase, TELNYX_PUBLIC_KEY: raw });
    const refused = await call("POST", "/admin/telephony/tests/webhook", { provider: "telnyx" });
    expect(check(refused, "answer")).toMatchObject({ label: "Unsigned event refused", ok: true });
    expect(refused.json.ok).toBe(true);
    delete process.env.TELNYX_PUBLIC_KEY;
    const open = await call("POST", "/admin/telephony/tests/webhook", { provider: "telnyx" });
    expect(check(open, "answer").ok).toBe(true);
    expect(check(open, "logged").detail).toBe("verified: false");
  });

  it("a wrong public URL is reported as unreachable", async () => {
    Object.assign(process.env, { PUBLIC_BASE_URL: "http://127.0.0.1:1", TWILIO_AUTH_TOKEN: "x" });
    const r = await call("POST", "/admin/telephony/tests/webhook", { provider: "twilio" });
    expect(check(r, "reachable")).toMatchObject({ ok: false, detail: expect.stringContaining("PUBLIC_BASE_URL") });
  });
});

/* =========================================================== route, call, sms */

const TRUNK_FILE = { id: "prague1", label: "Praha", host: "sip.example.com", port: 5061, username: "u1", authUser: "u1", password: "trunk-pass-9", register: false, didNumbers: [], callerIdName: "M5cet", callerIdNumber: "+420222111000", updatedAt: 1 };

describe("route, call and SMS tests through the rules", () => {
  beforeEach(() => { const { data } = loadTelephonyFile(); saveTelephonyFile({ ...data, trunks: [TRUNK_FILE] }); });

  it("route: the decision, the placement over the trunk and the TSA's first turn rendered — without the trunk password", async () => {
    Object.assign(process.env, { PUBLIC_BASE_URL: "https://chat.example.org" });
    telHooks.decide = async (q: RouteQuestion): Promise<RouteDecision> => ({ direction: q.direction, rule: "out-1", ruleLabel: "via Praha", reasons: [], service: { kind: "sip", provider: "twilio", trunk: "prague1", callerId: { number: "", name: "", presentation: "restricted" } }, target: { kind: "tsa", tsa: "ivr" } });
    telHooks.tsa = {
      start: async (c) => ({ session: { id: "s1", waiting: { node: "d", for: "dial", since: 0 } } as never, actions: [{ dial: { to: "+420777000001", kind: "number", action: `https://chat.example.org/wh/tel/${c.token}/tsa?s=s1&n=d`, trunk: { id: "prague1", host: "sip.example.com:5061", username: "u1", password: "trunk-pass-9", transport: "tls" } } }] }),
      resume: async () => { throw new Error("no"); },
    };
    const r = await call("POST", "/admin/telephony/tests/route", { direction: "outbound", from: "", to: "+420777000001", source: "console" });
    expect(r.json.ok).toBe(true);
    expect(r.json.decision.rule).toBe("out-1");
    expect(r.json.placement).toMatchObject({ provider: "twilio", service: "sip", to: "sip:+420777000001@sip.example.com:5061;transport=tls", from: "+420222111000", presentation: "restricted", trunk: { id: "prague1", hasPassword: true } });
    expect(r.json.rendered.contentType).toBe("text/xml");
    expect(r.json.rendered.body).toContain('<Sip username="u1" password="[redacted]">sip:+420777000001@sip.example.com:5061;transport=tls</Sip>');
    expect(JSON.stringify(r.json)).not.toContain("trunk-pass-9");
    await logFlushed();
    const log = await call("GET", "/admin/telephony/log?kind=test&limit=3");
    expect(log.json.entries[0].summary).toMatch(/^route test \(outbound/);
  });

  it("call: over the rule's SIP trunk with its credentials and caller ID; a refusing rule places nothing", async () => {
    Object.assign(process.env, { PUBLIC_BASE_URL: "https://chat.example.org", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tw-secret" });
    replies = [[/Calls\.json$/, { status: 201, json: { sid: "CA42", status: "queued" } }]];
    telHooks.decide = async (q: RouteQuestion): Promise<RouteDecision> => ({ direction: q.direction, rule: "out-1", ruleLabel: "via Praha", reasons: [], service: { kind: "sip", provider: "twilio", trunk: "prague1", callerId: { number: "", name: "", presentation: "allowed" } }, target: { kind: "pass" } });
    const r = await call("POST", "/admin/telephony/tests/call", { to: "+420777000001", say: "Test" });
    expect(r.json.ok).toBe(true);
    expect(r.json.call).toMatchObject({ provider: "twilio", providerCallId: "CA42", from: "+420222111000" });
    const f = form(sent[0]);
    expect([f.To, f.From, f.SipAuthUsername, f.SipAuthPassword]).toEqual(["sip:+420777000001@sip.example.com:5061;transport=tls", "+420222111000", "u1", "trunk-pass-9"]);
    // The call's own answer webhook says the text (engine.ts).
    expect(f.Url).toMatch(/^https:\/\/chat\.example\.org\/wh\/tel\/[A-Za-z0-9_-]+\/answer$/);
    expect(JSON.stringify(r.json)).not.toContain("trunk-pass-9");

    sent.length = 0;
    telHooks.decide = async (q) => ({ direction: q.direction, rule: "deny", ruleLabel: "no", reasons: [], service: null, target: { kind: "state", state: "rejected" } });
    const refused = await call("POST", "/admin/telephony/tests/call", { to: "+420777000001" });
    expect(check(refused, "rules")).toMatchObject({ ok: false, detail: "refused (rejected) by rule no" });
    expect(sent).toHaveLength(0);
  });

  it("call: a TSA target needs the runtime; with it the call is placed to run the TSA when answered", async () => {
    Object.assign(process.env, { PUBLIC_BASE_URL: "https://chat.example.org", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tw-secret", TWILIO_FROM: "+15005550006" });
    replies = [[/Calls\.json$/, { status: 201, json: { sid: "CA43", status: "queued" } }]];
    telHooks.decide = async (q) => ({ direction: q.direction, rule: null, ruleLabel: "default", reasons: [], service: { kind: "app", provider: "twilio" }, target: { kind: "tsa", tsa: "survey" } });
    expect(check(await call("POST", "/admin/telephony/tests/call", { to: "+420777000001" }), "tsa").ok).toBe(false);
    telHooks.tsa = { start: async () => { throw new Error("x"); }, resume: async () => { throw new Error("x"); } };
    const r = await call("POST", "/admin/telephony/tests/call", { to: "+420777000001" });
    expect(check(r, "placed").detail).toContain("runs TSA survey when answered");
    expect(form(sent[0]).Url).toMatch(/^https:\/\/chat\.example\.org\/wh\/tel\/[A-Za-z0-9_-]+\/answer$/);
  });

  it("sms: a real (faked) SMS through the default provider", async () => {
    Object.assign(process.env, { TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tw-secret", TWILIO_FROM: "+15005550006" });
    replies = [[/Messages\.json$/, { status: 201, json: { sid: "SM9", status: "queued", num_segments: "1" } }]];
    const r = await call("POST", "/admin/telephony/tests/sms", { to: "+420777000001", text: "Ahoj" });
    expect(r.json.ok).toBe(true);
    expect(r.json.message).toMatchObject({ provider: "twilio", providerId: "SM9", status: "queued" });
    expect(form(sent[0])).toMatchObject({ To: "+420777000001", From: "+15005550006", Body: "Ahoj" });
  });
});

/* ================================================================= room voice */

describe("voice into a room", () => {
  it("adds an inroute code and names the numbers that reach a TSA", async () => {
    process.env.TELEPHONY_DID_POOL = "+15005550006, vonage:+447700900000";
    const added: unknown[] = [];
    telHooks.inroute = {
      lookup: async () => null, used: async () => undefined,
      add: async (spec) => { added.push(spec); return { code: "4821", type: spec.type, room: spec.room, user: spec.user ?? "", label: spec.label ?? "", ttlSec: spec.ttl ?? 600, createdAt: 0, expiresAt: 1000, createdBy: spec.createdBy, uses: 0, maxUses: spec.maxUses ?? 0 }; },
    };
    telHooks.decide = async (q) => ({ direction: q.direction, rule: q.to === "+15005550006" ? "in-1" : null, ruleLabel: "Main IVR", reasons: [], service: null, target: q.to === "+15005550006" ? { kind: "tsa", tsa: "route-code" } : { kind: "state", state: "busy" } });
    const r = await call("POST", "/admin/telephony/tests/room-voice", { room: "r3.abc", type: "room", ttl: 900 });
    expect(r.json.ok).toBe(true);
    expect(added[0]).toMatchObject({ type: "room", room: "r3.abc", ttl: 900, createdBy: { kind: "console", id: "boss" } });
    expect(r.json.code).toBe("4821");
    expect(r.json.numbers).toEqual([{ number: "+15005550006", provider: "", via: "TSA route-code (rule Main IVR)" }]);
    expect(r.json.instructions).toContain("Call +15005550006");
    expect(r.json.instructions).toContain("type 4821 and #");
    expect(check(await call("POST", "/admin/telephony/tests/room-voice", { room: "r3.abc", type: "user" }), "user").ok).toBe(false);
  });
});

/* =============================================================== SIP address */

describe("the test SIP address", () => {
  it("Twilio: credential list + credential, a SIP Domain to this server's voice webhook, the mapping; saved without the password; removed again", async () => {
    Object.assign(process.env, { PUBLIC_BASE_URL: "https://chat.example.org", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tw-secret" });
    replies = [
      [/POST .*\/SIP\/CredentialLists\.json$/, { status: 201, json: { sid: "CL1" } }],
      [/POST .*\/SIP\/CredentialLists\/CL1\/Credentials\.json$/, { status: 201, json: { sid: "CR1" } }],
      [/POST .*\/SIP\/Domains\.json$/, (s) => ({ status: 201, json: { sid: "SD1", domain_name: form(s).DomainName } })],
      [/POST .*\/SIP\/Domains\/SD1\/Auth\/Calls\/CredentialListMappings\.json$/, { status: 201, json: { sid: "CL1" } }],
      [/DELETE /, { status: 204 }],
    ];
    const r = await call("POST", "/admin/telephony/tests/sip-address", { provider: "twilio", did: "+000123" });
    expect(r.json.ok).toBe(true);
    expect(sent.map((s) => `${s.method} ${s.url.replace("https://api.twilio.com/2010-04-01/Accounts/AC1", "")}`)).toEqual([
      "POST /SIP/CredentialLists.json", "POST /SIP/CredentialLists/CL1/Credentials.json", "POST /SIP/Domains.json", "POST /SIP/Domains/SD1/Auth/Calls/CredentialListMappings.json",
    ]);
    const cred = form(sent[1]);
    expect(cred.Password).toBe(r.json.password);
    expect(cred.Password).toMatch(/^(?=.*\d)(?=.*[a-z])(?=.*[A-Z]).{12,}$/);
    const domain = form(sent[2]);
    expect(domain).toMatchObject({ VoiceUrl: "https://chat.example.org/wh/twilio/voice", VoiceMethod: "POST", VoiceStatusCallbackUrl: "https://chat.example.org/wh/twilio/voice_status" });
    expect(domain.DomainName).toMatch(/^m5cet-[0-9a-f]{8}\.sip\.twilio\.com$/);
    expect(form(sent[3])).toEqual({ CredentialListSid: "CL1" });
    expect(r.json.address).toMatchObject({ provider: "twilio", did: "+000123", username: cred.Username, enabled: true, setup: { resource: "SD1|CL1", by: "boss" } });
    expect(r.json.address.uri).toMatch(new RegExp(`^sip:test-[0-9a-f]{12}@${domain.DomainName.replace(/\./g, "\\.")}$`));
    const file = readFileSync(join(dir, "telephony.json"), "utf8");
    expect(file).toContain(r.json.address.uri);
    expect(file).not.toContain(r.json.password);
    expect(file).toContain("trunk-pass-9"); // the trunks section is kept

    sent.length = 0;
    const del = await call("DELETE", "/admin/telephony/tests/sip-address");
    expect(del.json.ok).toBe(true);
    expect(sent.map((s) => `${s.method} ${s.url.replace("https://api.twilio.com/2010-04-01/Accounts/AC1", "")}`)).toEqual(["DELETE /SIP/Domains/SD1.json", "DELETE /SIP/CredentialLists/CL1.json"]);
    expect((await call("GET", "/admin/telephony/tests/sip-address")).json.address).toBeNull();
  });

  it("Twilio: a failed step removes what was made", async () => {
    Object.assign(process.env, { PUBLIC_BASE_URL: "https://chat.example.org", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tw-secret" });
    replies = [
      [/POST .*\/SIP\/CredentialLists\.json$/, { status: 201, json: { sid: "CL2" } }],
      [/POST .*\/Credentials\.json$/, { status: 201, json: {} }],
      [/POST .*\/SIP\/Domains\.json$/, { status: 400, json: { code: 21232, message: "Domain name already in use" } }],
      [/DELETE /, { status: 204 }],
    ];
    const r = await call("POST", "/admin/telephony/tests/sip-address", { provider: "twilio" });
    expect(r.status).toBe(400);
    expect(r.json.message).toBe("HTTP 400: Domain name already in use");
    expect(sent.at(-1)).toMatchObject({ method: "DELETE", url: expect.stringContaining("/SIP/CredentialLists/CL2.json") });
    expect(r.json.address).toBeNull();
  });

  it("Telnyx: the Call Control application's SIP subdomain (kept settings), removed again", async () => {
    Object.assign(process.env, { PUBLIC_BASE_URL: "https://chat.example.org", TELNYX_API_KEY: "KEY1", TELNYX_CONNECTION_ID: "app-9" });
    let sub = "";
    replies = [
      [/GET .*call_control_applications\/app-9$/, () => ({ json: { data: { application_name: "M5", webhook_event_url: "https://chat.example.org/wh/telnyx/events", inbound: { channel_limit: 10, sip_subdomain: sub || null } } } })],
      [/PATCH .*call_control_applications\/app-9$/, (s) => { sub = String((json(s).inbound as { sip_subdomain?: string }).sip_subdomain ?? ""); return { json: { data: {} } }; }],
    ];
    const r = await call("POST", "/admin/telephony/tests/sip-address", { provider: "telnyx" });
    expect(r.json.ok).toBe(true);
    expect(r.json.password).toBeUndefined();
    expect(json(sent[1])).toEqual({ application_name: "M5", webhook_event_url: "https://chat.example.org/wh/telnyx/events", inbound: { channel_limit: 10, sip_subdomain: sub, sip_subdomain_receive_settings: "from_anyone" } });
    expect(r.json.address.uri).toBe(`sip:${r.json.address.uri.slice(4).split("@")[0]}@${sub}.sip.telnyx.com`);
    expect(r.json.address.did).toBe("+000100");
    sent.length = 0;
    await call("DELETE", "/admin/telephony/tests/sip-address");
    expect(json(sent[1]).inbound).toEqual({ channel_limit: 10, sip_subdomain: null });
  });

  it("Vonage: a PSIP domain linked to the application with digest auth and the allow list, plus a domain user; rotating removes the old one first", async () => {
    Object.assign(process.env, { PUBLIC_BASE_URL: "https://chat.example.org", VONAGE_API_KEY: "vk", VONAGE_API_SECRET: "vs", VONAGE_APPLICATION_ID: "app-v" });
    replies = [[/POST https:\/\/api\.nexmo\.com\/v1\/psip\/$/, { json: {} }], [/POST .*\/v1\/psip\/[^/]+\/users$/, { json: {} }], [/DELETE /, { status: 204 }]];
    const r = await call("POST", "/admin/telephony/tests/sip-address", { provider: "vonage", acl: ["198.51.100.7", "bad value"], region: "us" });
    expect(r.json.ok).toBe(true);
    const domain = json(sent[0]);
    expect(domain).toMatchObject({ application_id: "app-v", acl: ["198.51.100.7"], digest_auth: true });
    expect(String(domain.name)).toMatch(/^m5cet-[0-9a-f]{8}$/);
    expect(json(sent[1])).toEqual({ key: r.json.address.username, secret: r.json.password });
    expect(r.json.address.uri).toMatch(new RegExp(`@${String(domain.name)}\\.sip-us\\.vonage\\.com$`));
    sent.length = 0;
    const again = await call("POST", "/admin/telephony/tests/sip-address", { provider: "vonage" });
    expect(again.json.ok).toBe(true);
    expect(sent[0]).toMatchObject({ method: "DELETE", url: `https://api.nexmo.com/v1/psip/${String(domain.name)}?cascade=true` });
    await call("DELETE", "/admin/telephony/tests/sip-address");
  });
});

/* ======================================================================== log */

describe("the log API", () => {
  it("lists summaries, gives one entry in full (with the log right), clears; console changes are logged", async () => {
    writeLog({ kind: "call", provider: "twilio", summary: "call placed", callId: "tc_1", parsed: { a: 1 }, raw: { b: 2 } });
    await logFlushed();
    const list = await call("GET", "/admin/telephony/log?callId=tc_1");
    expect(list.json.entries).toHaveLength(1);
    expect(list.json.entries[0]).not.toHaveProperty("parsed");
    const id = list.json.entries[0].id as string;
    // 6.12 (G-07): raw payloads are not kept by default.
    expect((await call("GET", `/admin/telephony/log/${id}`)).json.entry).toMatchObject({ parsed: { a: 1 }, raw: null });
    principal = null;
    expect((await call("GET", `/admin/telephony/log/${id}`)).status).toBe(403);
    principal = { name: "boss", role: "owner" };
    expect((await call("GET", "/admin/telephony/log/nope")).status).toBe(404);

    await call("PUT", "/admin/telephony/settings", { voiceProvider: "twilio", password: "never-logged" });
    await logFlushed();
    const cfg = await call("GET", "/admin/telephony/log?kind=config");
    expect(cfg.json.entries[0].summary).toBe("PUT /admin/telephony/settings → 200 (by boss)");
    const full = await call("GET", `/admin/telephony/log/${cfg.json.entries[0].id}`);
    expect(full.json.entry.parsed).toEqual({ fields: ["voiceProvider", "password"] });
    expect(JSON.stringify(full.json)).not.toContain("never-logged");

    const cleared = await call("DELETE", "/admin/telephony/log");
    expect(cleared.json.removed).toBeGreaterThanOrEqual(2);
    const after = await call("GET", "/admin/telephony/log");
    expect(after.json.entries.map((e: { summary: string }) => e.summary)).toEqual([expect.stringMatching(/^the log was cleared \(\d+ entries\) by boss$/)]);
  });
});
