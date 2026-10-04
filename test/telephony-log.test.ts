// @vitest-environment node
//
// The Telephony & SIP event log (6.9, control/log.ts): secrets never survive
// (auth headers, signatures, tokens, passwords, API keys, JWTs, a call's
// webhook capability), query filters and pagination, retention, keepRaw, and
// the webhook logger on a live express app (a signed Twilio webhook).

import { TELEPHONY_TMP_DIR } from "./helpers/telephony-tmp-env"; // MUST be first
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { redact, redactString, writeLog, queryLog, getLogEntry, clearLog, pruneLog, logFlushed, REDACTED } from "../server/telephony/control/log";
import { telHooks } from "../server/telephony/control/hooks";
import { DEFAULT_PERMISSIONS, type TelPermissions } from "../server/telephony/control/types";
import { registerWebhookRoutes, twilioSignature } from "../server/telephony/webhooks";
import { registerTelEngineRoutes } from "../server/telephony/tel-routes";
import { telStore } from "../server/telephony/tel-store";

let perms: TelPermissions = structuredClone(DEFAULT_PERMISSIONS);
beforeAll(() => { telHooks.permissions = () => perms; });
afterAll(() => { delete telHooks.permissions; });
beforeEach(async () => { perms = structuredClone(DEFAULT_PERMISSIONS); await clearLog(); });

const SECRETS = ["tw-auth-token-123", "Basic dXNlcjpwYXNz", "trunk-pass-9", "vonage-secret-1", "eyJhbGciOiJIUzI1NiJ9.eyJwYXlsb2FkX2hhc2giOiJ4In0.c2lnbmF0dXJl", "KEYsecret-telnyx", "sig-abcdef", "0123456789abcdefghijklmnopqrstuvwxyzAB"];

describe("redaction", () => {
  it("removes every secret: keys, auth schemes, JWTs, query secrets, SIP passwords, webhook capabilities", () => {
    const dirty = {
      headers: { authorization: "Basic dXNlcjpwYXNz", "x-twilio-signature": "sig-abcdef", "telnyx-signature-ed25519": "abc", "content-type": "application/json" },
      body: {
        AccountSid: "AC123", CallToken: "tw-auth-token-123", api_secret: "vonage-secret-1", api_key: "vkey", sig: "sig-abcdef",
        nested: [{ password: "trunk-pass-9", SipAuthPassword: "trunk-pass-9", note: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJwYXlsb2FkX2hhc2giOiJ4In0.c2lnbmF0dXJl" }],
        url: "https://rest.nexmo.com/sms/json?api_key=k&api_secret=vonage-secret-1&to=420",
        sip: "sip:u1:trunk-pass-9@sip.example.com",
        hook: "https://chat.test/wh/tel/0123456789abcdefghijklmnopqrstuvwxyzAB/tsa?s=1",
        auth: "KEYsecret-telnyx",
      },
      Digits: "1234", From: "+420777123456",
    };
    const clean = redact(dirty) as Record<string, any>;
    const text = JSON.stringify(clean);
    for (const s of SECRETS) expect(text).not.toContain(s);
    expect(clean.headers.authorization).toBe(REDACTED);
    expect(clean.headers["content-type"]).toBe("application/json");
    expect(clean.body.AccountSid).toBe("AC123");
    expect(clean.body.nested[0].password).toBe(REDACTED);
    expect(clean.body.url).toBe(`https://rest.nexmo.com/sms/json?api_key=${REDACTED}&api_secret=${REDACTED}&to=420`);
    expect(clean.body.sip).toBe(`sip:u1:${REDACTED}@sip.example.com`);
    expect(clean.body.hook).toBe("https://chat.test/wh/tel/012345…/tsa?s=1");
    expect(clean.Digits).toBe("1234");
    expect(redactString("Bearer abc.def.ghi-123456 and /wh/tel/in/twilio")).toBe(`Bearer ${REDACTED} and /wh/tel/in/twilio`);
  });

  it("writeLog stores no secret in summary, parsed, raw or the http path", async () => {
    const e = writeLog({
      kind: "webhook", summary: "got Bearer eyJhbGciOiJIUzI1NiJ9.eyJwYXlsb2FkX2hhc2giOiJ4In0.c2lnbmF0dXJl on /wh/tel/0123456789abcdefghijklmnopqrstuvwxyzAB/tsa",
      http: { method: "POST", path: "/wh/tel/0123456789abcdefghijklmnopqrstuvwxyzAB/tsa", status: 200, ms: 3.4 },
      parsed: { trunk: { password: "trunk-pass-9" } }, raw: { token: "tw-auth-token-123", Authorization: "Basic dXNlcjpwYXNz" },
    });
    await logFlushed();
    const stored = await getLogEntry(e.id);
    const text = JSON.stringify(stored);
    for (const s of SECRETS) expect(text).not.toContain(s);
    expect(stored?.http).toEqual({ method: "POST", path: "/wh/tel/012345…/tsa", status: 200, ms: 3 });
  });

  it("keepRaw: false keeps the parsed data and drops the raw payload", async () => {
    perms.log.keepRaw = false;
    const e = writeLog({ kind: "webhook", summary: "x", parsed: { a: 1 }, raw: { b: 2 } });
    await logFlushed();
    expect(await getLogEntry(e.id)).toMatchObject({ parsed: { a: 1 }, raw: null });
  });
});

describe("query, pagination, retention", () => {
  it("filters by kind, provider, level (at least), call and text; pages newest first", async () => {
    for (let i = 0; i < 7; i++) writeLog({ kind: i % 2 ? "call" : "webhook", provider: i < 4 ? "twilio" : "vonage", level: i === 5 ? "error" : "info", summary: `entry ${i}`, callId: i === 3 ? "tc_three" : "" });
    await logFlushed();
    const all = await queryLog({ limit: 3 });
    expect(all.entries.map((e) => e.summary)).toEqual(["entry 6", "entry 5", "entry 4"]);
    expect(all.next).not.toBeNull();
    expect(all.entries[0]).not.toHaveProperty("parsed");
    expect(all.entries[0]).not.toHaveProperty("raw");
    const page2 = await queryLog({ limit: 3, before: all.next! });
    expect(page2.entries.map((e) => e.summary)).toEqual(["entry 3", "entry 2", "entry 1"]);
    const page3 = await queryLog({ limit: 3, before: page2.next! });
    expect(page3.entries.map((e) => e.summary)).toEqual(["entry 0"]);
    expect(page3.next).toBeNull();
    expect((await queryLog({ kind: "call" })).entries.map((e) => e.summary)).toEqual(["entry 5", "entry 3", "entry 1"]);
    expect((await queryLog({ provider: "vonage" })).entries).toHaveLength(3);
    expect((await queryLog({ level: "warn" })).entries.map((e) => e.summary)).toEqual(["entry 5"]);
    expect((await queryLog({ callId: "tc_three" })).entries.map((e) => e.summary)).toEqual(["entry 3"]);
    expect((await queryLog({ q: "ENTRY 2" })).entries.map((e) => e.summary)).toEqual(["entry 2"]);
  });

  it("drops entries older than permissions.log.days", async () => {
    const old = writeLog({ kind: "call", summary: "old", at: Date.now() - 3 * 86_400_000 });
    const fresh = writeLog({ kind: "call", summary: "fresh" });
    await logFlushed();
    perms.log.days = 2;
    expect(pruneLog()).toBe(1);
    expect(await getLogEntry(old.id)).toBeNull();
    expect(await getLogEntry(fresh.id)).not.toBeNull();
  });

  it("clears everything", async () => {
    writeLog({ kind: "call", summary: "a" });
    writeLog({ kind: "call", summary: "b" });
    expect(await clearLog()).toBeGreaterThanOrEqual(2);
    expect((await queryLog({})).entries).toEqual([]);
  });

  it("mirrors the older per-call log (calls placed, SMS sent)", async () => {
    telStore.record({ kind: "sms", level: "info", ref: "tm_1", provider: "twilio", summary: "sms to +420777123456: queued", detail: { parts: 1 } });
    await logFlushed();
    const [e] = (await queryLog({ callId: "tm_1" })).entries;
    expect(e).toMatchObject({ kind: "sms", provider: "twilio", summary: "sms to +420777123456: queued" });
  });
});

describe("the webhook log on a live app", () => {
  let server: Server;
  let base = "";
  beforeAll(async () => {
    process.env.PUBLIC_BASE_URL = "https://chat.test";
    process.env.TWILIO_AUTH_TOKEN = "tw-auth-token-123";
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
    delete process.env.PUBLIC_BASE_URL;
    delete process.env.TWILIO_AUTH_TOKEN;
    await new Promise((r) => server.close(r));
    expect(TELEPHONY_TMP_DIR).toBeTruthy();
  });

  it("logs a signed Twilio status webhook: verified, method / path / status / ms, the parsed event, the raw payload without the signature", async () => {
    const params = { CallSid: "CA77", CallStatus: "completed", CallDuration: "12", From: "+420777123456", To: "+15005550006", Direction: "outbound-api", CallbackSource: "call-progress-events", CallToken: "tw-auth-token-123" };
    const sig = twilioSignature("https://chat.test/wh/twilio/voice_status", params, "tw-auth-token-123");
    const r = await fetch(`${base}/wh/twilio/voice_status`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig }, body: new URLSearchParams(params) });
    expect(r.status).toBe(200);
    await new Promise((res) => setTimeout(res, 50));
    await logFlushed();
    const [row] = (await queryLog({ kind: "webhook", q: "CA77" })).entries;
    expect(row).toMatchObject({ provider: "twilio", verified: true, level: "info", callId: "CA77", http: { method: "POST", path: "/wh/twilio/voice_status", status: 200 } });
    expect(row.summary).toContain("twilio voice_status: completed from +420777123456 to +15005550006 → 200 (verified)");
    const full = await getLogEntry(row.id);
    expect((full?.parsed as { events: Array<Record<string, unknown>> }).events[0]).toMatchObject({ kind: "status", status: "completed", durationSec: 12 });
    const text = JSON.stringify(full);
    expect(text).not.toContain(sig);
    expect(text).not.toContain("tw-auth-token-123");
    expect((full?.raw as { body: Record<string, string> }).body.CallSid).toBe("CA77");
  });

  it("logs a refused (unsigned) webhook as a warning and a call's capability masked", async () => {
    const r = await fetch(`${base}/wh/twilio/voice`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ CallSid: "CA78", From: "+1", To: "+2" }) });
    expect(r.status).toBe(403);
    const t = await fetch(`${base}/wh/tel/0123456789abcdefghijklmnopqrstuvwxyzAB/answer`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "CallSid=CA79" });
    expect(t.status).toBe(404);
    await new Promise((res) => setTimeout(res, 50));
    await logFlushed();
    const rows = (await queryLog({ kind: "webhook" })).entries;
    expect(rows.find((e) => e.callId === "CA78")).toMatchObject({ level: "warn", verified: false, http: { status: 403 } });
    const masked = rows.find((e) => e.http?.path.startsWith("/wh/tel/"));
    expect(masked?.http?.path).toBe("/wh/tel/012345…/answer");
  });
});
