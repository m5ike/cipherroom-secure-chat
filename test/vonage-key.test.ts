// @vitest-environment node
//
// Vonage Voice key resolution: every way an operator really pastes the
// application private key into .env / systemd / compose either signs a
// verifiable RS256 token, or yields a precise reason that names the variable
// and never echoes key material. Regression for the production error
// "POST /api/telephony/call 502 :: error:1E08010C:DECODER routines::unsupported".

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVonageKey, resolveVonageCredential } from "../server/telephony/vonage-key";
import { vonageJwt, VonageVoiceConnector } from "../server/telephony/connectors";
import { signJwtRS256, verifyJwtRS256 } from "../server/telephony/jwt";
import { TelephonyNotConfiguredError } from "../server/telephony/types";

const KEYS = ["VONAGE_APPLICATION_ID", "VONAGE_JWT_KEY", "VONAGE_PRIVATE_KEY", "VONAGE_PRIVATE_KEY_PATH", "VONAGE_FROM"];
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PKCS8 = rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PKCS1 = rsa.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const PUB = rsa.publicKey.export({ type: "spki", format: "pem" }).toString();
const BODY = PKCS8.split("\n").filter((l) => l && !l.startsWith("-----")).join("");

let dir = "";
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  dir = mkdtempSync(join(tmpdir(), "m5cet-vonage-"));
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(dir, { recursive: true, force: true });
});

function signsWith(value: string): boolean {
  process.env.VONAGE_APPLICATION_ID = "app-1";
  process.env.VONAGE_JWT_KEY = value;
  return verifyJwtRS256(vonageJwt(), PUB)?.application_id === "app-1";
}

describe("accepted VONAGE_JWT_KEY shapes", () => {
  it.each([
    ["multi-line PEM (double-quoted in .env)", PKCS8],
    ["one line with \\n escapes", PKCS8.replace(/\n/g, "\\n")],
    ["double-escaped \\\\n (shell / installer)", PKCS8.replace(/\n/g, "\\\\n")],
    ["CRLF line ends", PKCS8.replace(/\n/g, "\r\n")],
    ["escaped \\r\\n", PKCS8.replace(/\n/g, "\\r\\n")],
    ["flattened to one line with spaces", PKCS8.replace(/\n/g, " ")],
    ["systemd backslash-continuation (no separators at all)", PKCS8.replace(/\n/g, "")],
    ["wrapped in stray quotes", `"${PKCS8.replace(/\n/g, "\\n")}"`],
    ["PKCS#1 'RSA PRIVATE KEY'", PKCS1],
    ["base64 of the whole PEM", Buffer.from(PKCS8).toString("base64")],
    ["bare base64 body (DER)", BODY],
  ])("%s", (_name, value) => {
    expect(signsWith(value)).toBe(true);
  });

  it("a path in VONAGE_JWT_KEY, and VONAGE_PRIVATE_KEY_PATH", () => {
    const file = join(dir, "private.key");
    writeFileSync(file, PKCS8);
    expect(signsWith(file)).toBe(true);
    delete process.env.VONAGE_JWT_KEY;
    process.env.VONAGE_PRIVATE_KEY_PATH = file;
    expect(verifyJwtRS256(vonageJwt(), PUB)?.application_id).toBe("app-1");
    expect(new VonageVoiceConnector().status()).toMatchObject({ configured: true });
  });

  it("a ready-made JWT from the dashboard is used as-is until it expires", () => {
    const token = signJwtRS256({ application_id: "app-1" }, PKCS8, 3600);
    process.env.VONAGE_JWT_KEY = token;
    expect(vonageJwt()).toBe(token);
    const st = new VonageVoiceConnector().status();
    expect(st.configured).toBe(true);
    expect(st.note).toMatch(/pre-generated JWT/);
  });
});

describe("rejected values explain themselves (and never echo the key)", () => {
  function reasonFor(value: string): string {
    process.env.VONAGE_APPLICATION_ID = "app-1";
    process.env.VONAGE_JWT_KEY = value;
    const st = new VonageVoiceConnector().status();
    expect(st.configured).toBe(false);
    expect(() => vonageJwt()).toThrow(TelephonyNotConfiguredError);
    expect(st.reason).not.toContain(BODY.slice(10, 40));
    return st.reason ?? "";
  }

  it("multi-line PEM without quotes → only the header line survived the .env parser", () => {
    expect(reasonFor("-----BEGIN PRIVATE KEY-----")).toMatch(/^VONAGE_JWT_KEY holds only the PEM header line.*double quotes.*VONAGE_PRIVATE_KEY_PATH/);
  });
  it("truncated key", () => {
    expect(reasonFor(PKCS8.slice(0, 400))).toMatch(/no END line — the key is truncated/);
  });
  it("damaged key data (the original OpenSSL DECODER failure)", () => {
    // 40 base64 chars cut out of the 3rd body line: the ASN.1 lengths no longer add up.
    const damaged = PKCS8.replace(BODY.slice(130, 170), "");
    expect(damaged).not.toBe(PKCS8);
    expect(reasonFor(damaged)).toMatch(/could not be parsed as a PRIVATE KEY.*damaged/);
  });
  it("the public key instead of the private one", () => {
    expect(reasonFor(PUB)).toMatch(/public key — Vonage needs the application's PRIVATE key/);
  });
  it("an EC key", () => {
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(reasonFor(ec)).toMatch(/is a EC key; Vonage application keys are RSA/);
  });
  it("an encrypted key", () => {
    const enc = rsa.privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "pw" }).toString();
    expect(reasonFor(enc)).toMatch(/passphrase-protected/);
  });
  it("a path that does not exist", () => {
    expect(reasonFor(join(dir, "missing.key"))).toMatch(/cannot be read: ENOENT.*mounted into the container/);
  });
  it("an expired pre-generated JWT", () => {
    const token = signJwtRS256({ application_id: "app-1", exp: Math.floor(Date.now() / 1000) - 60 }, PKCS8);
    expect(reasonFor(token)).toMatch(/pre-generated JWT that expired/);
  });
  it("a JWT for another application", () => {
    const token = signJwtRS256({ application_id: "other-app" }, PKCS8, 3600);
    expect(reasonFor(token)).toMatch(/issued for application other-app, but VONAGE_APPLICATION_ID is app-1/);
  });
  it("random text", () => {
    expect(reasonFor("my-vonage-secret")).toMatch(/neither a PEM private key, a base64-encoded key, a file path nor a JWT \(16 characters\)/);
  });
});

describe("resolution order + app id", () => {
  it("VONAGE_JWT_KEY wins over VONAGE_PRIVATE_KEY and the path", () => {
    process.env.VONAGE_PRIVATE_KEY = "garbage";
    process.env.VONAGE_PRIVATE_KEY_PATH = join(dir, "missing.key");
    process.env.VONAGE_JWT_KEY = PKCS8;
    expect(resolveVonageCredential()).toMatchObject({ kind: "key", source: "VONAGE_JWT_KEY" });
  });
  it("a good key without VONAGE_APPLICATION_ID says exactly that", () => {
    process.env.VONAGE_JWT_KEY = PKCS8;
    expect(new VonageVoiceConnector().status().reason).toMatch(/Set VONAGE_APPLICATION_ID \(the private key itself parses fine\)/);
  });
  it("parseVonageKey is pure (no env access)", () => {
    expect(parseVonageKey(PKCS8).kind).toBe("key");
  });
});

describe("the call path maps a bad key to 503-style NotConfigured, not a 502 OpenSSL error", () => {
  it("placeCall rejects with TelephonyNotConfiguredError before any network request", async () => {
    process.env.VONAGE_APPLICATION_ID = "app-1";
    process.env.VONAGE_FROM = "447700900000";
    process.env.VONAGE_JWT_KEY = "-----BEGIN PRIVATE KEY-----";
    const realFetch = globalThis.fetch;
    let fetched = false;
    globalThis.fetch = (async () => { fetched = true; return new Response("{}"); }) as typeof fetch;
    try {
      await expect(new VonageVoiceConnector().placeCall({ to: "+14155550123" })).rejects.toBeInstanceOf(TelephonyNotConfiguredError);
      expect(fetched).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
