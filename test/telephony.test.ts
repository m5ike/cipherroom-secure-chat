import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TelephonyNotConfiguredError, isE164 } from "../server/telephony/types";
import { TwilioSmsConnector, buildVoiceConnectors } from "../server/telephony/connectors";
import { SipTrunkStore, SIP_LIMITS } from "../server/telephony/sip";
import {
  telephonyEnabled, registrySnapshot, getSms, publicStatus,
} from "../server/telephony/registry";

// Every env var any connector or the registry reads. Saved/cleared per test so
// the suite is hermetic and never actually contacts a provider.
const TEL_ENV = [
  "ENABLE_TELEPHONY", "SMS_PROVIDER", "VOICE_PROVIDER", "PUBLIC_BASE_URL",
  "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM", "TWILIO_VOICE_URL",
  "TELNYX_API_KEY", "TELNYX_FROM", "TELNYX_CONNECTION_ID", "TELNYX_MESSAGING_PROFILE_ID",
  "VONAGE_API_KEY", "VONAGE_API_SECRET", "VONAGE_FROM", "VONAGE_APPLICATION_ID",
  "VONAGE_JWT_KEY", "VONAGE_PRIVATE_KEY", "VONAGE_PRIVATE_KEY_PATH",
];

describe("isE164", () => {
  it("accepts well-formed E.164 numbers", () => {
    expect(isE164("+14155550123")).toBe(true);
    expect(isE164("+420123456789")).toBe(true);
    expect(isE164("  +499876543210  ")).toBe(true); // trims
    expect(isE164("+123456789012345")).toBe(true);   // 15 digits, the max
  });
  it("rejects malformed numbers", () => {
    expect(isE164("")).toBe(false);
    expect(isE164("14155550123")).toBe(false);        // no +
    expect(isE164("+0123456789")).toBe(false);        // leading 0
    expect(isE164("+")).toBe(false);
    expect(isE164("+1abc")).toBe(false);
    expect(isE164("+1234567890123456")).toBe(false);  // 16 digits, too long
  });
});

describe("telephony registry gating + status", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of TEL_ENV) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of TEL_ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it("is off and unconfigured by default", () => {
    expect(telephonyEnabled()).toBe(false);
    const snap = registrySnapshot();
    expect(snap.enabled).toBe(false);
    expect(snap.sms.every((c) => !c.configured)).toBe(true);
    expect(snap.voice.every((c) => !c.configured)).toBe(true);
    expect(publicStatus().sms).toHaveLength(0);
    expect(publicStatus().voice).toHaveLength(0);
  });

  it("reports a connector configured once its key is present", () => {
    process.env.TWILIO_ACCOUNT_SID = "ACxxxx";
    process.env.TWILIO_AUTH_TOKEN = "tok";
    const twilio = registrySnapshot().sms.find((c) => c.id === "twilio");
    expect(twilio?.configured).toBe(true);
    expect(getSms()?.id).toBe("twilio"); // default resolves to the configured one
    expect(publicStatus().sms.map((c) => c.id)).toContain("twilio");
  });

  it("honours SMS_PROVIDER for the default when several are configured", () => {
    process.env.TWILIO_ACCOUNT_SID = "ACxxxx";
    process.env.TWILIO_AUTH_TOKEN = "tok";
    process.env.TELNYX_API_KEY = "KEYxxx";
    process.env.SMS_PROVIDER = "telnyx";
    expect(getSms()?.id).toBe("telnyx");
  });

  it("reports Vonage voice unconfigured until VONAGE_APPLICATION_ID + VONAGE_JWT_KEY are set", () => {
    const vonage = buildVoiceConnectors().find((c) => c.id === "vonage");
    expect(vonage?.status().configured).toBe(false);
    expect(vonage?.status().reason).toMatch(/VONAGE_JWT_KEY/);
    process.env.VONAGE_APPLICATION_ID = "app-1234";
    process.env.VONAGE_JWT_KEY = "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----";
    expect(vonage?.status().configured).toBe(true);
  });
});

describe("connector refuses to run unconfigured", () => {
  it("Twilio SMS throws TelephonyNotConfiguredError without a key", async () => {
    const savedSid = process.env.TWILIO_ACCOUNT_SID;
    const savedTok = process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    try {
      await expect(new TwilioSmsConnector().sendSms({ to: "+14155550123", text: "hi" }))
        .rejects.toBeInstanceOf(TelephonyNotConfiguredError);
    } finally {
      if (savedSid === undefined) delete process.env.TWILIO_ACCOUNT_SID; else process.env.TWILIO_ACCOUNT_SID = savedSid;
      if (savedTok === undefined) delete process.env.TWILIO_AUTH_TOKEN; else process.env.TWILIO_AUTH_TOKEN = savedTok;
    }
  });

  it("Vonage voice throws TelephonyNotConfiguredError when invoked without app id / JWT key", async () => {
    const keys = ["VONAGE_APPLICATION_ID", "VONAGE_JWT_KEY", "VONAGE_PRIVATE_KEY", "VONAGE_PRIVATE_KEY_PATH"];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    keys.forEach((k) => delete process.env[k]);
    process.env.VONAGE_FROM = "447700900000";
    try {
      const vonage = buildVoiceConnectors().find((c) => c.id === "vonage");
      await expect(vonage!.placeCall({ to: "+14155550123" })).rejects.toBeInstanceOf(TelephonyNotConfiguredError);
    } finally {
      delete process.env.VONAGE_FROM;
      keys.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
    }
  });
});

describe("SipTrunkStore", () => {
  it("CRUD, redaction (password never leaves the store) and routing", () => {
    const store = new SipTrunkStore();
    const created = store.create({ label: "Primary", host: "sip.example.com", username: "user1", password: "s3cret", didNumbers: ["+14155550123"] });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.trunk.id;

    // redaction: no password anywhere, only the hasPassword flag
    expect((created.trunk as Record<string, unknown>).password).toBeUndefined();
    expect(created.trunk.hasPassword).toBe(true);
    expect(JSON.stringify(store.list())).not.toContain("s3cret");
    expect(JSON.stringify(store.get(id))).not.toContain("s3cret");
    expect(store.get(id)?.port).toBe(5060); // default port

    // update keeps redaction even when a new password is set
    const upd = store.update(id, { label: "Renamed", password: "newpass" });
    expect(upd.ok).toBe(true);
    expect(store.get(id)?.label).toBe("Renamed");
    expect(JSON.stringify(store.list())).not.toContain("newpass");

    // inbound routing by DID
    expect(store.routeInbound("+14155550123")?.trunkId).toBe(id);
    expect(store.routeInbound("+19998887777")).toBeNull();

    // delete
    expect(store.remove(id)).toBe(true);
    expect(store.get(id)).toBeNull();
    expect(store.remove(id)).toBe(false);
  });

  it("rejects invalid input and enforces the cap", () => {
    const store = new SipTrunkStore();
    expect(store.create({ label: "", host: "sip.example.com", username: "u" }).ok).toBe(false);
    expect(store.create({ label: "L", host: "", username: "u" }).ok).toBe(false);
    expect(store.create({ label: "L", host: "sip.example.com", username: "" }).ok).toBe(false);
    expect(store.create({ label: "L", host: "sip.example.com", username: "u", port: 70000 }).ok).toBe(false);

    for (let i = 0; i < SIP_LIMITS.maxTrunks; i += 1) {
      expect(store.create({ label: `T${i}`, host: "sip.example.com", username: "u" }).ok).toBe(true);
    }
    expect(store.size).toBe(SIP_LIMITS.maxTrunks);
    const overflow = store.create({ label: "over", host: "sip.example.com", username: "u" });
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.message).toMatch(/full/);
  });
});
