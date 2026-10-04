// @vitest-environment node
//
// Telephony › Overview (6.9, control/overview.ts): the providers and their
// services, the counts, and the warnings an operator should act on.

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "m5teloverview-"));
Object.assign(process.env, { DATA_DIR: dir, TELEPHONY_DB_FILE: join(dir, "telephony.db"), TELEPHONY_DATA_FILE: join(dir, "telephony.json"), TSA_DATA_FILE: join(dir, "telephony-tsa.json") });
for (const k of ["PUBLIC_BASE_URL", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM", "TELNYX_API_KEY", "TELNYX_CONNECTION_ID", "TELNYX_FROM", "TELNYX_PUBLIC_KEY",
  "VONAGE_API_KEY", "VONAGE_API_SECRET", "VONAGE_APPLICATION_ID", "VONAGE_JWT_KEY", "VONAGE_PRIVATE_KEY", "VONAGE_PRIVATE_KEY_PATH", "VONAGE_FROM", "VONAGE_SIGNATURE_SECRET", "SIP_TRUNKS"]) delete process.env[k];

const { telephonyOverview } = await import("../server/telephony/control/overview");
const { saveRules } = await import("../server/telephony/control/store");
const { tsaStore } = await import("../server/telephony/tsa/store");

describe("Telephony › Overview", () => {
  beforeAll(() => { process.env.TWILIO_ACCOUNT_SID = "AC" + "0".repeat(32); process.env.TWILIO_AUTH_TOKEN = "t"; process.env.TWILIO_FROM = "+420600000000"; });

  it("lists the providers, counts what is configured and warns about what is missing", async () => {
    const o = await telephonyOverview();
    const twilio = o.providers.find((p) => p.id === "twilio")!;
    expect(twilio.services.app).toBe(true);
    expect(twilio.services.sip).toBe(false); // no trunk yet
    expect(o.providers.find((p) => p.id === "telnyx")!.services.app).toBe(false);
    expect(o.counts).toMatchObject({ inboundRules: 0, outboundRules: 0, tsa: 0, tsaPublished: 0, liveCalls: 0, inroute: 0 });
    expect(o.publicBaseUrl).toBe("");
    expect(o.warnings.join("\n")).toMatch(/PUBLIC_BASE_URL is not set/);
    expect(o.warnings.join("\n")).toMatch(/No inbound rule is on/);
  });

  it("warns about rules whose TSA is missing or unpublished", async () => {
    process.env.PUBLIC_BASE_URL = "https://chat.example.test";
    const { tsa: draft } = tsaStore.create({ name: "Menu", description: "" }, "test");
    expect(saveRules("inbound", [
      { id: "main", label: "Main line", match: { numbers: ["+420600000000"] }, target: { kind: "tsa", tsa: draft.id } },
      { id: "ghost", label: "Ghost", match: { numbers: ["+420600000001"] }, target: { kind: "tsa", tsa: "nope" } },
    ], "test").ok).toBe(true);
    const o = await telephonyOverview();
    expect(o.counts).toMatchObject({ inboundRules: 2, tsa: 1, tsaPublished: 0 });
    const w = o.warnings.join("\n");
    expect(w).not.toMatch(/PUBLIC_BASE_URL is not set/);
    expect(w).not.toMatch(/No inbound rule is on/);
    expect(w).toMatch(/"Main line" routes to the TSA "Menu", which is not published/);
    expect(w).toMatch(/"Ghost" routes to the TSA "nope", which does not exist/);
  });
});
