// @vitest-environment node
// 6.12 (F-24): without WEBAUTHN_ORIGINS a passkey ceremony is accepted only
// from the exact origin of PUBLIC_BASE_URL (else https://<rpId>) — not from
// every subdomain of the rpId, which with PRF could unlock an account's root
// from a subdomain someone else runs. Android app origins work as before;
// localhost stays open for development; WEBAUTHN_ALLOW_SUBDOMAINS=1 brings the
// old rule back.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request } from "express";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "m5origins-"));
const { rpPolicyFor } = await import("../server/accounts/routes");
const { isAllowedOrigin } = await import("../server/accounts/webauthn");

const CERT = "3cf2e0f82f32da5651a0ff17a3d50899fb517d1f30b1bb03ed4e3b5096e61ba1";
const APP = `android:apk-key-hash:${Buffer.from(CERT, "hex").toString("base64url")}`;
const req = (hostname: string) => ({ hostname } as Request);
const KEYS = ["WEBAUTHN_ORIGINS", "WEBAUTHN_RP_ID", "PUBLIC_BASE_URL", "WEBAUTHN_ALLOW_SUBDOMAINS", "ANDROID_DEBUG_CERT_SHA256"];
afterEach(() => { for (const k of KEYS) delete process.env[k]; });

describe("the default origins", () => {
  it("PUBLIC_BASE_URL: exactly its origin", () => {
    process.env.PUBLIC_BASE_URL = "https://chat.example.org/";
    const p = rpPolicyFor(req("chat.example.org"));
    expect(p).toMatchObject({ rpId: "chat.example.org", origins: ["https://chat.example.org"] });
    expect(isAllowedOrigin("https://chat.example.org", p)).toBe(true);
    expect(isAllowedOrigin("https://evil.chat.example.org", p)).toBe(false);
    expect(isAllowedOrigin("https://chat.example.org:8443", p)).toBe(false);
    expect(isAllowedOrigin("http://chat.example.org", p)).toBe(false);
  });

  it("WEBAUTHN_RP_ID wider than the host still accepts only the site's own origin", () => {
    process.env.PUBLIC_BASE_URL = "https://chat.example.org";
    process.env.WEBAUTHN_RP_ID = "example.org";
    const p = rpPolicyFor(req("chat.example.org"));
    expect(isAllowedOrigin("https://chat.example.org", p)).toBe(true);
    expect(isAllowedOrigin("https://example.org", p)).toBe(false);
    expect(isAllowedOrigin("https://blog.example.org", p)).toBe(false);
  });

  it("no PUBLIC_BASE_URL: https on exactly the host", () => {
    const p = rpPolicyFor(req("m5.example.net"));
    expect(p.origins).toEqual([]);
    expect(isAllowedOrigin("https://m5.example.net", p)).toBe(true);
    expect(isAllowedOrigin("https://x.m5.example.net", p)).toBe(false);
  });

  it("WEBAUTHN_ORIGINS is the exact list, as before", () => {
    process.env.PUBLIC_BASE_URL = "https://chat.example.org";
    process.env.WEBAUTHN_ORIGINS = "https://chat.example.org, https://app.chat.example.org";
    const p = rpPolicyFor(req("chat.example.org"));
    expect(isAllowedOrigin("https://app.chat.example.org", p)).toBe(true);
    expect(isAllowedOrigin("https://other.chat.example.org", p)).toBe(false);
  });

  it("WEBAUTHN_ALLOW_SUBDOMAINS=1: every https subdomain of the rpId (the rule before 6.12)", () => {
    process.env.PUBLIC_BASE_URL = "https://chat.example.org";
    process.env.WEBAUTHN_ALLOW_SUBDOMAINS = "1";
    const p = rpPolicyFor(req("chat.example.org"));
    expect(isAllowedOrigin("https://app.chat.example.org", p)).toBe(true);
    expect(isAllowedOrigin("https://chat.example.org.evil.tld", p)).toBe(false);
  });

  it("the Android app's origin works with every rule", () => {
    process.env.ANDROID_DEBUG_CERT_SHA256 = CERT;
    process.env.PUBLIC_BASE_URL = "https://chat.example.org";
    expect(isAllowedOrigin(APP, rpPolicyFor(req("chat.example.org")))).toBe(true);
    process.env.WEBAUTHN_ORIGINS = "https://chat.example.org";
    expect(isAllowedOrigin(APP, rpPolicyFor(req("chat.example.org")))).toBe(true);
    expect(isAllowedOrigin(`${APP}x`, rpPolicyFor(req("chat.example.org")))).toBe(false);
  });

  it("development on localhost: any local port", () => {
    process.env.PUBLIC_BASE_URL = "http://localhost:5000";
    const p = rpPolicyFor(req("localhost"));
    expect(isAllowedOrigin("http://localhost:5000", p)).toBe(true);
    expect(isAllowedOrigin("http://localhost:5173", p)).toBe(true);
    expect(isAllowedOrigin("http://evil.example:5173", p)).toBe(false);
  });
});
