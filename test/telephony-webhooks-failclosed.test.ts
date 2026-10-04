// @vitest-environment node
//
// Telephony webhooks fail closed once their verification material is set
// (6.7, F-17). Before: with VONAGE_SIGNATURE_SECRET set, an SMS webhook
// without `sig` was accepted unverified; a Vonage JWT without payload_hash
// verified any body; a JWT without exp / with an old iat stayed valid
// forever. Each provider path is checked here: a missing signature is a 403
// like a wrong one.

import { TELEPHONY_TMP_DIR } from "./helpers/telephony-tmp-env"; // MUST be first: redirects the data file to a temp dir
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createHash, generateKeyPairSync, createHmac, sign } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import { signJwtHS256 } from "../server/telephony/jwt";
import { registerWebhookRoutes, replayKey, resetWebhookReplays, seenBefore, telephonyEvents, twilioSignature, verifyVonageJwtWebhook, vonageLegacySig } from "../server/telephony/webhooks";

void TELEPHONY_TMP_DIR;
const ENV_KEYS = ["PUBLIC_BASE_URL", "TWILIO_AUTH_TOKEN", "TELNYX_PUBLIC_KEY", "VONAGE_SIGNATURE_SECRET", "VONAGE_ALLOW_UNSIGNED_SMS"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } telephonyEvents.clear(); process.env.PUBLIC_BASE_URL = "https://chat.example.org"; });
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

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

const form = (params: Record<string, string>) => new URLSearchParams(params).toString();
const post = (path: string, body: string, headers: Record<string, string>) => fetch(`${base}${path}`, { method: "POST", body, headers });
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** An HS256 JWT with exactly these claims (no iat/exp added). */
const rawJwt = (claims: Record<string, unknown>, secret: string) => {
  const input = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(claims)}`;
  return `${input}.${createHmac("sha256", secret).update(input).digest("base64url")}`;
};

describe("F-17 — a configured provider refuses a request without its signature", () => {
  it("Twilio: no X-Twilio-Signature → 403", async () => {
    process.env.TWILIO_AUTH_TOKEN = "tok";
    const res = await post("/wh/twilio/sms", form({ MessageSid: "SM1", From: "+1", To: "+2", Body: "x" }), { "Content-Type": "application/x-www-form-urlencoded" });
    expect(res.status).toBe(403);
    expect(telephonyEvents.recent(1)).toHaveLength(0);
  });

  it("Telnyx: no signature headers → 403", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    process.env.TELNYX_PUBLIC_KEY = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
    const res = await post("/wh/telnyx/events", JSON.stringify({ data: { event_type: "message.received", payload: {} } }), { "Content-Type": "application/json" });
    expect(res.status).toBe(403);
  });

  it("Vonage SMS: no sig → 403 (was accepted unverified); the opt-out keeps it open", async () => {
    process.env.VONAGE_SIGNATURE_SECRET = "vsecret";
    const params = { msisdn: "447700900000", to: "420123", text: "hi", messageId: "m1" };
    expect((await post("/wh/vonage/sms", form(params), { "Content-Type": "application/x-www-form-urlencoded" })).status).toBe(403);
    expect(telephonyEvents.recent(1)).toHaveLength(0);
    // Signed and recent: accepted.
    const signed = { ...params, timestamp: String(Math.floor(Date.now() / 1000)) };
    const ok = await post("/wh/vonage/sms", form({ ...signed, sig: vonageLegacySig(signed, "vsecret") }), { "Content-Type": "application/x-www-form-urlencoded" });
    expect(ok.status).toBe(200);
    expect(telephonyEvents.recent(1)[0]).toMatchObject({ verified: true });
    // Signed but old: refused.
    const old = { ...params, timestamp: String(Math.floor(Date.now() / 1000) - 3600) };
    expect((await post("/wh/vonage/sms", form({ ...old, sig: vonageLegacySig(old, "vsecret") }), { "Content-Type": "application/x-www-form-urlencoded" })).status).toBe(403);
    process.env.VONAGE_ALLOW_UNSIGNED_SMS = "1";
    expect((await post("/wh/vonage/sms", form(params), { "Content-Type": "application/x-www-form-urlencoded" })).status).toBe(200);
  });

  it("Vonage JWT: no Authorization → 403; a token without payload_hash does not cover a body", async () => {
    process.env.VONAGE_SIGNATURE_SECRET = "vsecret";
    const body = JSON.stringify({ status: "completed", uuid: "u1" });
    expect((await post("/wh/vonage/events", body, { "Content-Type": "application/json" })).status).toBe(403);
    const noHash = signJwtHS256({ api_key: "k" }, "vsecret");
    expect((await post("/wh/vonage/events", body, { "Content-Type": "application/json", Authorization: `Bearer ${noHash}` })).status).toBe(403);
    const good = signJwtHS256({ payload_hash: createHash("sha256").update(body).digest("hex") }, "vsecret");
    expect((await post("/wh/vonage/events", body, { "Content-Type": "application/json", Authorization: `Bearer ${good}` })).status).toBe(200);
  });

  it("Vonage JWT: iat is required and must be recent", () => {
    const body = "";
    const now = Math.floor(Date.now() / 1000);
    expect(verifyVonageJwtWebhook(`Bearer ${rawJwt({ api_key: "k" }, "s")}`, body, "s")).toBe(false);           // no iat, no exp
    expect(verifyVonageJwtWebhook(`Bearer ${rawJwt({ iat: now - 86_400 }, "s")}`, body, "s")).toBe(false);       // a day old
    expect(verifyVonageJwtWebhook(`Bearer ${rawJwt({ iat: now + 3600 }, "s")}`, body, "s")).toBe(false);        // from the future
    expect(verifyVonageJwtWebhook(`Bearer ${rawJwt({ iat: now }, "s")}`, body, "s")).toBe(true);                 // empty body, fresh
  });

  it("without verification material the documented behaviour stays: accepted, marked unverified", async () => {
    const res = await post("/wh/vonage/sms", form({ msisdn: "1", to: "2", text: "x" }), { "Content-Type": "application/x-www-form-urlencoded" });
    expect(res.status).toBe(200);
    expect(telephonyEvents.recent(1)[0]).toMatchObject({ verified: false, enforced: false });
  });
});

describe("6.10 (G-08) — a verified request is taken once; a copy is acknowledged, not processed", () => {
  const telnyxKeys = () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    process.env.TELNYX_PUBLIC_KEY = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
    return (body: string, ts = String(Math.floor(Date.now() / 1000))) => ({
      "Content-Type": "application/json", "telnyx-timestamp": ts,
      "telnyx-signature-ed25519": sign(null, Buffer.from(`${ts}|${body}`), privateKey).toString("base64"),
    });
  };
  beforeEach(() => resetWebhookReplays());

  it("Telnyx: the same signed event again → 200 duplicate, nothing recorded; a retry of the event (new signature, same id) too", async () => {
    const signed = telnyxKeys();
    const body = JSON.stringify({ data: { id: "evt-1", event_type: "message.received", payload: { from: { phone_number: "+15550001" }, to: [{ phone_number: "+15550002" }], text: "hi" } } });
    const h = signed(body);
    const first = await post("/wh/telnyx/events", body, h);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, verified: true });
    expect(telephonyEvents.recent(10)).toHaveLength(1);
    const again = await post("/wh/telnyx/events", body, h);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
    expect(telephonyEvents.recent(10)).toHaveLength(1);
    // The provider's retry is signed anew (another timestamp) — the event id is the same.
    const retry = await post("/wh/telnyx/events", body, signed(body, String(Math.floor(Date.now() / 1000) - 5)));
    expect(await retry.json()).toEqual({ ok: true, duplicate: true });
    // Another event is processed.
    const other = JSON.stringify({ data: { id: "evt-2", event_type: "message.received", payload: {} } });
    expect(await (await post("/wh/telnyx/events", other, signed(other))).json()).toMatchObject({ ok: true, verified: true });
    expect(telephonyEvents.recent(10)).toHaveLength(2);
  });

  it("Vonage: the same JWT again → duplicate (by jti); a new token for the same body is processed; a signed SMS by its sig", async () => {
    process.env.VONAGE_SIGNATURE_SECRET = "vsecret";
    const body = JSON.stringify({ status: "completed", uuid: "u1" });
    const hash = createHash("sha256").update(body).digest("hex");
    const h = { "Content-Type": "application/json", Authorization: `Bearer ${signJwtHS256({ payload_hash: hash }, "vsecret")}` };
    expect(await (await post("/wh/vonage/events", body, h)).json()).toMatchObject({ ok: true, verified: true });
    expect(await (await post("/wh/vonage/events", body, h)).json()).toEqual({ ok: true, duplicate: true });
    const fresh = { ...h, Authorization: `Bearer ${signJwtHS256({ payload_hash: hash }, "vsecret")}` };
    expect(await (await post("/wh/vonage/events", body, fresh)).json()).toMatchObject({ ok: true, verified: true });
    expect(telephonyEvents.recent(10)).toHaveLength(2);
    // A replayed answer webhook gets an empty NCCO, not the logic again.
    const answer = signJwtHS256({}, "vsecret");
    const get = () => fetch(`${base}/wh/vonage/answer?from=447700900000&to=420123&uuid=c1`, { headers: { Authorization: `Bearer ${answer}` } });
    expect(((await (await get()).json()) as unknown[]).length).toBe(1);
    expect(await (await get()).json()).toEqual([]);
    // Legacy signed SMS: the sig covers the timestamp (and the nonce) — the same sig is the same request.
    const sms = { msisdn: "447700900000", to: "420123", text: "hi", messageId: "m9", timestamp: String(Math.floor(Date.now() / 1000)) };
    const f = form({ ...sms, sig: vonageLegacySig(sms, "vsecret") });
    const formH = { "Content-Type": "application/x-www-form-urlencoded" };
    expect(await (await post("/wh/vonage/sms", f, formH)).json()).toMatchObject({ verified: true });
    expect(await (await post("/wh/vonage/sms", f, formH)).json()).toEqual({ ok: true, duplicate: true });
  });

  it("Twilio is not keyed (no time in its signature; two genuine requests can be identical); unverified requests are not remembered", async () => {
    process.env.TWILIO_AUTH_TOKEN = "tok";
    const params = { MessageSid: "SM1", From: "+15550001", To: "+15550002", Body: "1" };
    const headers = { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": twilioSignature("https://chat.example.org/wh/twilio/sms", params, "tok") };
    expect((await post("/wh/twilio/sms", form(params), headers)).status).toBe(200);
    expect((await post("/wh/twilio/sms", form(params), headers)).status).toBe(200);
    expect(telephonyEvents.recent(10)).toHaveLength(2);
    expect(replayKey("twilio", "sms", { headers: {}, body: params, query: {} } as never)).toBeNull();
    delete process.env.TWILIO_AUTH_TOKEN;
    // No verification material: accepted unverified each time (and G-01 keeps such requests away from calls).
    const body = JSON.stringify({ data: { id: "evt-u", event_type: "message.received", payload: {} } });
    expect(await (await post("/wh/telnyx/events", body, { "Content-Type": "application/json" })).json()).toMatchObject({ verified: false });
    expect(await (await post("/wh/telnyx/events", body, { "Content-Type": "application/json" })).json()).toMatchObject({ verified: false });
  });

  it("the memory expires after the window", () => {
    const t0 = 1_000_000;
    expect(seenBefore("k1", t0)).toBe(false);
    expect(seenBefore("k1", t0 + 60_000)).toBe(true);
    expect(seenBefore("k1", t0 + 16 * 60_000)).toBe(false);
  });
});
