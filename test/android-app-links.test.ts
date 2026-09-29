// @vitest-environment node
// 6.1: the Android app signs in with the server's passkeys — the WebAuthn
// origin check accepts exactly the app origins of the known signing
// certificates, and /.well-known/assetlinks.json declares the app.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "m5links-"));

const { isAllowedOrigin } = await import("../server/accounts/webauthn");
const { androidAppOrigins, assetLinks, registerAppLinks } = await import("../server/android/app-links");

const CERT = "3cf2e0f82f32da5651a0ff17a3d50899fb517d1f30b1bb03ed4e3b5096e61ba1";
const ORIGIN = `android:apk-key-hash:${Buffer.from(CERT, "hex").toString("base64url")}`;

describe("Android app origins", () => {
  beforeEach(() => { process.env.ANDROID_DEBUG_CERT_SHA256 = CERT.toUpperCase().match(/../g)!.join(":"); });
  afterEach(() => { delete process.env.ANDROID_DEBUG_CERT_SHA256; });

  it("derives the exact origin of a known certificate", () => {
    expect(androidAppOrigins()).toEqual([ORIGIN]);
  });

  it("accepts that origin and refuses a forged one, with or without WEBAUTHN_ORIGINS", () => {
    const policy = { rpId: "chat.example", appOrigins: androidAppOrigins() };
    expect(isAllowedOrigin(ORIGIN, policy)).toBe(true);
    const forged = `android:apk-key-hash:${Buffer.alloc(32, 7).toString("base64url")}`;
    expect(isAllowedOrigin(forged, policy)).toBe(false);
    expect(isAllowedOrigin(`${ORIGIN}x`, policy)).toBe(false);
    expect(isAllowedOrigin(ORIGIN, { rpId: "chat.example" })).toBe(false);
    expect(isAllowedOrigin(forged, { ...policy, origins: ["https://chat.example"] })).toBe(false);
    expect(isAllowedOrigin(ORIGIN, { ...policy, origins: ["https://chat.example"] })).toBe(true);
    expect(isAllowedOrigin("https://chat.example", { ...policy, origins: ["https://chat.example"] })).toBe(true);
  });

  it("serves assetlinks.json for the app, 404 without a certificate", async () => {
    const app = express();
    registerAppLinks(app);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const res = await fetch(`${base}/.well-known/assetlinks.json`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
      const body = await res.json() as Array<{ relation: string[]; target: { package_name: string; sha256_cert_fingerprints: string[] } }>;
      expect(body[0].relation).toContain("delegate_permission/common.get_login_creds");
      expect(body[0].target.package_name).toBe("cz.m5cet.app");
      expect(body[0].target.sha256_cert_fingerprints).toEqual([CERT.toUpperCase().match(/../g)!.join(":")]);
      delete process.env.ANDROID_DEBUG_CERT_SHA256;
      expect(assetLinks()).toBeNull();
      expect((await fetch(`${base}/.well-known/assetlinks.json`)).status).toBe(404);
    } finally {
      server.close();
    }
  });
});
