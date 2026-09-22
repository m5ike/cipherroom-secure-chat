// @vitest-environment node
//
// Telephony: JWT helpers, provider webhook signature verification, persistent
// SIP trunks (+ .env seeding), persisted default-provider choice, the Vonage
// Voice JWT connector (fetch stubbed — never contacts a provider), and the live
// /wh/{provider}/{type} routes on a real express server.

import { TELEPHONY_TMP_DIR } from "./helpers/telephony-tmp-env"; // MUST be first: redirects the data file to a temp dir
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import express from "express";

import { signJwtRS256, signJwtHS256, verifyJwtRS256, verifyJwtHS256, decodeJwtUnsafe } from "../server/telephony/jwt";
import {
  twilioSignature, verifyTwilioSignature, verifyTelnyxSignature, telnyxPublicKeyToPem,
  verifyVonageJwtWebhook, vonageLegacySig, verifyVonageLegacySig, registerWebhookRoutes, telephonyEvents, eventsFilePath,
} from "../server/telephony/webhooks";
import { SipTrunkStore, sipStore } from "../server/telephony/sip";
import { dataFilePath } from "../server/telephony/store";
import { getSettings, setDefaultProviders, getSms, defaultsSource, registrySnapshot } from "../server/telephony/registry";
import { vonageJwt, VonageVoiceConnector, providerWebhookSpecs, installProviderWebhooks } from "../server/telephony/connectors";

const ENV_KEYS = [
  "PUBLIC_BASE_URL", "SMS_PROVIDER", "VOICE_PROVIDER", "SIP_TRUNKS",
  "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM",
  "TELNYX_API_KEY", "TELNYX_PUBLIC_KEY",
  "VONAGE_API_KEY", "VONAGE_API_SECRET", "VONAGE_FROM", "VONAGE_APPLICATION_ID", "VONAGE_JWT_KEY", "VONAGE_SIGNATURE_SECRET",
];
const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

/* --------------------------------------------------------------------- JWT */

describe("jwt helpers", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const priv = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const pub = publicKey.export({ type: "spki", format: "pem" }).toString();

  it("RS256 round-trips and carries iat/exp/jti", () => {
    const token = signJwtRS256({ application_id: "app-1" }, priv, 60);
    expect(decodeJwtUnsafe(token)?.header.alg).toBe("RS256");
    const claims = verifyJwtRS256(token, pub);
    expect(claims?.application_id).toBe("app-1");
    expect(typeof claims?.iat).toBe("number");
    expect(typeof claims?.exp).toBe("number");
    expect(typeof claims?.jti).toBe("string");
  });

  it("RS256 rejects a token signed by another key", () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(verifyJwtRS256(signJwtRS256({ a: 1 }, other), pub)).toBeNull();
  });

  it("HS256 round-trips, rejects a wrong secret and an expired token", () => {
    const token = signJwtHS256({ payload_hash: "abc" }, "s3cret", 60);
    expect(verifyJwtHS256(token, "s3cret")?.payload_hash).toBe("abc");
    expect(verifyJwtHS256(token, "wrong")).toBeNull();
    expect(verifyJwtHS256(signJwtHS256({ x: 1 }, "s3cret", -10), "s3cret")).toBeNull();
    expect(verifyJwtHS256("not.a.jwt", "s3cret")).toBeNull();
  });
});

/* ---------------------------------------------------- signature verifiers */

describe("provider webhook signatures", () => {
  it("Twilio: matches the documented reference vector and rejects tampering", () => {
    // From Twilio's "Validating requests" docs.
    const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
    const params = { CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212" };
    const sig = twilioSignature(url, params, "12345");
    expect(sig).toBe("0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
    expect(verifyTwilioSignature(url, params, sig, "12345")).toBe(true);
    expect(verifyTwilioSignature(url, { ...params, Digits: "9999" }, sig, "12345")).toBe(false);
    expect(verifyTwilioSignature(url, params, sig, "other-token")).toBe(false);
    expect(verifyTwilioSignature(url, params, "", "12345")).toBe(false);
  });

  it("Telnyx: verifies an Ed25519 signature over timestamp|body", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const rawPub = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
    expect(telnyxPublicKeyToPem(rawPub)).toContain("BEGIN PUBLIC KEY");
    const body = JSON.stringify({ data: { event_type: "message.sent" } });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = cryptoSign(null, Buffer.from(`${ts}|${body}`), privateKey).toString("base64");
    expect(verifyTelnyxSignature(body, ts, sig, rawPub)).toBe(true);
    expect(verifyTelnyxSignature(body + " ", ts, sig, rawPub)).toBe(false);
    expect(verifyTelnyxSignature(body, String(Number(ts) - 3600), sig, rawPub)).toBe(false); // stale
    expect(verifyTelnyxSignature(body, ts, sig, Buffer.alloc(32).toString("base64"))).toBe(false); // wrong key
  });

  it("Vonage: JWT webhook with payload_hash, and the legacy md5 sig", () => {
    const body = JSON.stringify({ status: "answered", uuid: "u1" });
    const hash = createHash("sha256").update(body).digest("hex");
    const good = `Bearer ${signJwtHS256({ payload_hash: hash, api_key: "k" }, "sig-secret")}`;
    expect(verifyVonageJwtWebhook(good, body, "sig-secret")).toBe(true);
    expect(verifyVonageJwtWebhook(good, body + "x", "sig-secret")).toBe(false); // hash mismatch
    expect(verifyVonageJwtWebhook(good, body, "other")).toBe(false);
    expect(verifyVonageJwtWebhook(undefined, body, "sig-secret")).toBe(false);

    const params: Record<string, string> = { msisdn: "420777123456", to: "420123", text: "hi", timestamp: "1700000000" };
    const sig = vonageLegacySig(params, "sig-secret");
    expect(verifyVonageLegacySig({ ...params, sig }, "sig-secret")).toBe(true);
    expect(verifyVonageLegacySig({ ...params, text: "bye", sig }, "sig-secret")).toBe(false);
  });
});

/* ------------------------------------------- persistent SIP trunks + env */

describe("SipTrunkStore persistence", () => {
  it("survives a restart: a second store instance loads what the first saved", () => {
    const file = dataFilePath();
    const a = new SipTrunkStore();
    a.enablePersistence();
    const created = a.create({ id: "prague1", label: "Prague", host: "sip.example.com", username: "u", password: "s3cret", didNumbers: ["+420123"] });
    expect(created.ok).toBe(true);
    expect(existsSync(file)).toBe(true);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    // the file keeps the password (needed to reach the trunk) — the API never returns it
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as { trunks: Array<{ id: string; password: string }> };
    expect(onDisk.trunks.find((t) => t.id === "prague1")?.password).toBe("s3cret");
    expect(JSON.stringify(a.list())).not.toContain("s3cret");

    const b = new SipTrunkStore(); // "restart"
    b.enablePersistence();
    expect(b.get("prague1")?.label).toBe("Prague");
    expect(b.get("prague1")?.source).toBe("file");
    expect(b.get("prague1")?.hasPassword).toBe(true);

    expect(b.update("prague1", { label: "Praha" }).ok).toBe(true);
    const c = new SipTrunkStore();
    c.enablePersistence();
    expect(c.get("prague1")?.label).toBe("Praha");
    expect(c.get("prague1")?.hasPassword).toBe(true); // empty password on update keeps the stored one

    expect(c.remove("prague1")).toBe(true);
    const d = new SipTrunkStore();
    d.enablePersistence();
    expect(d.get("prague1")).toBeNull();
  });

  it("reloads when another process changed the file (mtime check)", () => {
    const writer = new SipTrunkStore();
    writer.enablePersistence();
    const reader = new SipTrunkStore();
    reader.enablePersistence();
    expect(reader.get("late")).toBeNull();
    expect(writer.create({ id: "late", label: "Late", host: "sip.example.com", username: "u" }).ok).toBe(true);
    expect(reader.get("late")?.label).toBe("Late"); // picked up without a restart
    writer.remove("late");
  });

  it("seeds read-only trunks from SIP_TRUNKS and refuses to edit them", () => {
    const s = new SipTrunkStore();
    const seed = s.seedFromEnv(JSON.stringify([
      { id: "env1", label: "Env trunk", host: "sip.env.example", username: "e", password: "p", didNumbers: ["+420456"], callerIdName: "M5cet", callerIdNumber: "+420456" },
      { label: "broken" }, // invalid → reported, not fatal
    ]));
    expect(seed.loaded).toBe(1);
    expect(seed.errors).toHaveLength(1);
    expect(s.get("env1")?.source).toBe("env");
    expect(s.routeInbound("+420456")).toMatchObject({ trunkId: "env1", source: "env" });
    const upd = s.update("env1", { label: "x" });
    expect(upd.ok).toBe(false);
    if (!upd.ok) expect(upd.message).toMatch(/\.env/);
    expect(s.remove("env1")).toBe("readonly");
    expect(s.seedFromEnv("not json").errors[0]).toMatch(/valid JSON/);
  });
});

/* ------------------------------------------- default provider selection */

describe("default provider selection (admin > env > auto)", () => {
  it("persists the admin choice and resolves in the documented order", () => {
    process.env.TWILIO_ACCOUNT_SID = "AC1"; process.env.TWILIO_AUTH_TOKEN = "t";
    process.env.TELNYX_API_KEY = "k";
    setDefaultProviders({ sms: "" }); // start clean
    expect(getSms()?.id).toBe("twilio"); // auto: first configured
    expect(defaultsSource().sms).toBe("auto");

    process.env.SMS_PROVIDER = "telnyx";
    expect(getSms()?.id).toBe("telnyx");
    expect(defaultsSource().sms).toBe("env");

    const r = setDefaultProviders({ sms: "twilio" });
    expect(r.ok).toBe(true);
    expect(getSettings().smsProvider).toBe("twilio");
    expect(getSms()?.id).toBe("twilio"); // admin beats env
    expect(defaultsSource().sms).toBe("admin");
    expect(registrySnapshot().settings.smsProvider).toBe("twilio");

    expect(setDefaultProviders({ voice: "nope" }).ok).toBe(false);
    setDefaultProviders({ sms: "" });
    expect(defaultsSource().sms).toBe("env");
  });
});

/* -------------------------------------------------- Vonage Voice (JWT) */

describe("Vonage Voice connector", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const priv = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it("mints an RS256 application JWT from VONAGE_APPLICATION_ID + VONAGE_JWT_KEY (\\n-escaped PEM ok)", () => {
    process.env.VONAGE_APPLICATION_ID = "app-42";
    process.env.VONAGE_JWT_KEY = priv.replace(/\n/g, "\\n");
    const claims = verifyJwtRS256(vonageJwt(), pub);
    expect(claims?.application_id).toBe("app-42");
    expect(new VonageVoiceConnector().status().configured).toBe(true);
  });

  it("places a call with a Bearer JWT, digit-only numbers, NCCO without a base URL and answer/event URLs with one", async () => {
    process.env.VONAGE_APPLICATION_ID = "app-42";
    process.env.VONAGE_JWT_KEY = priv;
    process.env.VONAGE_FROM = "+447700900000";
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ uuid: "call-uuid-1", status: "started" }), { status: 201, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const r1 = await new VonageVoiceConnector().placeCall({ to: "+14155550123" });
    expect(r1).toEqual({ id: "call-uuid-1", provider: "vonage" });
    expect(calls[0].url).toBe("https://api.nexmo.com/v1/calls");
    const auth = String((calls[0].init.headers as Record<string, string>).Authorization);
    expect(auth.startsWith("Bearer ")).toBe(true);
    expect(verifyJwtRS256(auth.slice(7), pub)?.application_id).toBe("app-42");
    const body1 = JSON.parse(String(calls[0].init.body)) as { to: Array<{ number: string }>; from: { number: string }; ncco?: unknown[]; answer_url?: string[] };
    expect(body1.to[0].number).toBe("14155550123");
    expect(body1.from.number).toBe("447700900000");
    expect(body1.ncco?.[0]).toMatchObject({ action: "talk" });
    expect(body1.answer_url).toBeUndefined();

    process.env.PUBLIC_BASE_URL = "https://chat.example.org/";
    await new VonageVoiceConnector().placeCall({ to: "+14155550123" });
    const body2 = JSON.parse(String(calls[1].init.body)) as { answer_url?: string[]; event_url?: string[]; ncco?: unknown[] };
    expect(body2.answer_url).toEqual(["https://chat.example.org/wh/vonage/answer"]);
    expect(body2.event_url).toEqual(["https://chat.example.org/wh/vonage/events"]);
    expect(body2.ncco).toBeUndefined();
  });

  it("webhook specs are absolute only with PUBLIC_BASE_URL; install refuses without it", async () => {
    expect(providerWebhookSpecs("vonage").every((s) => s.url === "" && s.path.startsWith("/wh/vonage/"))).toBe(true);
    const r = await installProviderWebhooks("twilio");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/PUBLIC_BASE_URL/);
    process.env.PUBLIC_BASE_URL = "https://chat.example.org";
    expect(providerWebhookSpecs("twilio").find((s) => s.type === "sms_status")?.url).toBe("https://chat.example.org/wh/twilio/sms_status");
  });
});

/* -------------------------------------------------- live webhook routes */

describe("/wh/{provider}/{type} routes", () => {
  let base = "";
  let server: ReturnType<express.Express["listen"]>;

  beforeAll(async () => {
    const app = express();
    app.use(express.json({ verify: (req, _res, buf) => { (req as express.Request & { rawBody?: Buffer }).rawBody = buf; } }));
    app.use(express.urlencoded({ extended: false }));
    registerWebhookRoutes(app);
    await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  beforeEach(() => { telephonyEvents.clear(); process.env.PUBLIC_BASE_URL = "https://chat.example.org"; });

  const form = (params: Record<string, string>) => new URLSearchParams(params).toString();

  it("Twilio: accepts a correctly signed status callback and records a verified event", async () => {
    process.env.TWILIO_AUTH_TOKEN = "tok123";
    const params = { MessageSid: "SM1", MessageStatus: "delivered", To: "+420123456789" };
    const sig = twilioSignature("https://chat.example.org/wh/twilio/sms_status", params, "tok123");
    const res = await fetch(`${base}/wh/twilio/sms_status`, {
      method: "POST", body: form(params),
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": sig },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    const ev = telephonyEvents.recent(1)[0];
    expect(ev).toMatchObject({ provider: "twilio", type: "sms_status", status: "delivered", providerId: "SM1", verified: true, enforced: true });
  });

  it("Twilio: rejects a bad signature (403) when the auth token is configured", async () => {
    process.env.TWILIO_AUTH_TOKEN = "tok123";
    const res = await fetch(`${base}/wh/twilio/sms_status`, {
      method: "POST", body: form({ MessageSid: "SM2", MessageStatus: "failed" }),
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": "nope" },
    });
    expect(res.status).toBe(403);
    expect(telephonyEvents.recent(1)).toHaveLength(0);
  });

  it("Twilio: without verification material the event is accepted but marked unverified", async () => {
    const res = await fetch(`${base}/wh/twilio/sms_status`, {
      method: "POST", body: form({ MessageSid: "SM3", MessageStatus: "sent" }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(200);
    expect(telephonyEvents.recent(1)[0]).toMatchObject({ verified: false, enforced: false, status: "sent" });
  });

  it("Twilio: the voice answer webhook returns TwiML, and inbound SMS routes to the owning SIP trunk", async () => {
    process.env.TWILIO_AUTH_TOKEN = "tok123";
    const voice = { CallSid: "CA1", From: "+15551234567", To: "+420123", CallStatus: "ringing" };
    const r1 = await fetch(`${base}/wh/twilio/voice`, {
      method: "POST", body: form(voice),
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": twilioSignature("https://chat.example.org/wh/twilio/voice", voice, "tok123") },
    });
    expect(r1.status).toBe(200);
    expect(await r1.text()).toMatch(/<Response><Say>.*<\/Say><\/Response>/);

    expect(sipStore.create({ id: "wh-trunk", label: "WH", host: "sip.example.com", username: "u", didNumbers: ["+420123"] }).ok).toBe(true);
    try {
      const sms = { MessageSid: "SM9", From: "+15551234567", To: "+420123", Body: "hello" };
      const r2 = await fetch(`${base}/wh/twilio/sms`, {
        method: "POST", body: form(sms),
        headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": twilioSignature("https://chat.example.org/wh/twilio/sms", sms, "tok123") },
      });
      expect(r2.status).toBe(200);
      const ev = telephonyEvents.recent(1)[0];
      expect(ev).toMatchObject({ direction: "inbound", text: "hello", verified: true });
      expect(ev.route?.trunkId).toBe("wh-trunk");
    } finally {
      sipStore.remove("wh-trunk");
    }
  });

  it("Telnyx: verifies the Ed25519 signature and rejects a tampered body", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    process.env.TELNYX_PUBLIC_KEY = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
    const body = JSON.stringify({ data: { event_type: "message.received", payload: { id: "m1", from: { phone_number: "+15551234567" }, to: [{ phone_number: "+420123" }], text: "hi there" } } });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = cryptoSign(null, Buffer.from(`${ts}|${body}`), privateKey).toString("base64");
    const ok = await fetch(`${base}/wh/telnyx/events`, { method: "POST", body, headers: { "Content-Type": "application/json", "telnyx-timestamp": ts, "telnyx-signature-ed25519": sig } });
    expect(ok.status).toBe(200);
    expect(telephonyEvents.recent(1)[0]).toMatchObject({ provider: "telnyx", direction: "inbound", from: "+15551234567", to: "+420123", text: "hi there", verified: true });

    const tampered = body.replace("hi there", "hi THERE");
    const bad = await fetch(`${base}/wh/telnyx/events`, { method: "POST", body: tampered, headers: { "Content-Type": "application/json", "telnyx-timestamp": ts, "telnyx-signature-ed25519": sig } });
    expect(bad.status).toBe(403);
  });

  it("Vonage: answer webhook returns an NCCO; a signed event is verified; a bad JWT is rejected", async () => {
    const ans = await fetch(`${base}/wh/vonage/answer?from=447700900000&to=420123&uuid=u1`);
    expect(ans.status).toBe(200);
    const ncco = await ans.json() as Array<{ action: string; text: string }>;
    expect(ncco[0].action).toBe("talk");
    expect(telephonyEvents.recent(1)[0]).toMatchObject({ provider: "vonage", type: "answer", direction: "answer", from: "447700900000" });

    process.env.VONAGE_SIGNATURE_SECRET = "vsecret";
    const body = JSON.stringify({ status: "completed", uuid: "u1", from: "447700900000", to: "420123" });
    const jwt = signJwtHS256({ payload_hash: createHash("sha256").update(body).digest("hex") }, "vsecret");
    const ok = await fetch(`${base}/wh/vonage/events`, { method: "POST", body, headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` } });
    expect(ok.status).toBe(200);
    expect(telephonyEvents.recent(1)[0]).toMatchObject({ type: "events", status: "completed", providerId: "u1", verified: true });

    const bad = await fetch(`${base}/wh/vonage/events`, { method: "POST", body, headers: { "Content-Type": "application/json", Authorization: "Bearer garbage" } });
    expect(bad.status).toBe(403);
  });

  it("events are shared through a file so the ADMIN process sees what the APP received", async () => {
    // The webhook lands in this (app-like) process; a different process reads the same file.
    await fetch(`${base}/wh/twilio/voice_status`, {
      method: "POST", body: form({ CallSid: "CA-shared", CallStatus: "completed" }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    const file = eventsFilePath();
    expect(file.startsWith(TELEPHONY_TMP_DIR)).toBe(true);
    expect(existsSync(file)).toBe(true);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as Array<{ providerId?: string; status?: string }>;
    expect(onDisk.some((e) => e.providerId === "CA-shared" && e.status === "completed")).toBe(true);
    expect(telephonyEvents.recent(5).map((e) => e.providerId)).toContain("CA-shared");

    telephonyEvents.clear(); // an admin "Clear" must stick across processes too
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([]);
    expect(telephonyEvents.recent(5)).toHaveLength(0);
  });

  it("unknown provider or webhook type → 404", async () => {
    expect((await fetch(`${base}/wh/acme/events`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${base}/wh/twilio/nope`, { method: "POST" })).status).toBe(404);
  });
});
