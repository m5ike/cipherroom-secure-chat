// @vitest-environment node
//
// M5cet Desktop (6.13): the packaging is a function of the environment —
// signing and updates come only from environment variables, the fuses are
// the hardened set, the app runs from a verified app.asar, and the macOS
// privacy prompts exist in all nine languages.

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — plain ESM build scripts without type declarations
import { builderConfig, publishConfig, signing } from "../desktop/scripts/builder-config.mjs";
// @ts-expect-error — plain ESM build scripts without type declarations
import { LANGS, USAGE, usageInfo, writeInfoPlistStrings } from "../desktop/scripts/infoplist.mjs";
import { asarHashesFromHeader, asarHeaderLength } from "../desktop/src/asar-integrity";
import { LOCALES } from "../client/src/lib/locales";

describe("desktop build configuration", () => {
  it("unsigned by default: ad-hoc on macOS with the ad-hoc entitlements, no Windows signing, no updates", () => {
    const c = builderConfig({});
    expect(c.mac.identity).toBe("-");
    expect(c.mac.entitlements).toMatch(/entitlements\.mac\.adhoc\.plist$/);
    expect(c.mac.notarize).toBe(false);
    expect(c.win.signExecutable).toBe(false);
    expect(c.publish).toBeNull();
    expect(signing({})).toEqual({ mac: false, notarize: false, win: false, azure: false });
  });

  it("signing and notarization only from the environment", () => {
    const env = { CSC_LINK: "file.p12", CSC_KEY_PASSWORD: "x", APPLE_API_KEY: "k.p8", APPLE_API_KEY_ID: "id", APPLE_API_ISSUER: "iss" };
    const c = builderConfig(env);
    expect(c.mac.identity).toBeUndefined();
    expect(c.mac.entitlements).toMatch(/entitlements\.mac\.plist$/);
    expect(c.mac.notarize).toBe(true);
    expect(c.electronFuses.resetAdHocDarwinSignature).toBe(false);
    const azure = builderConfig({ AZURE_TENANT_ID: "t", AZURE_CLIENT_ID: "c", AZURE_CLIENT_SECRET: "s", M5CET_AZURE_ENDPOINT: "https://weu.codesigning.azure.net", M5CET_AZURE_ACCOUNT: "acc", M5CET_AZURE_PROFILE: "prof" });
    expect(azure.win.azureSignOptions).toMatchObject({ endpoint: "https://weu.codesigning.azure.net", codeSigningAccountName: "acc", certificateProfileName: "prof" });
    expect(azure.win.signExecutable).toBeUndefined();
  });

  it("the release entitlements do not switch off library validation; the ad-hoc ones must", () => {
    const release = readFileSync(join("desktop", "build", "entitlements.mac.plist"), "utf8");
    const adhoc = readFileSync(join("desktop", "build", "entitlements.mac.adhoc.plist"), "utf8");
    const keys = (xml: string) => [...xml.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
    expect(keys(release)).toEqual(["com.apple.security.cs.allow-jit", "com.apple.security.device.camera", "com.apple.security.device.audio-input", "com.apple.security.personal-information.location", "com.apple.security.network.client"]);
    expect(keys(adhoc)).toContain("com.apple.security.cs.disable-library-validation");
    for (const xml of [release, adhoc]) {
      expect(xml).not.toContain("allow-unsigned-executable-memory");
      expect(xml).not.toContain("allow-dyld-environment-variables");
      expect(xml).not.toContain("get-task-allow");
    }
  });

  it("the hardened fuses, the m5cet: scheme, universal macOS ≥ 13, Windows x64 + arm64", () => {
    const c = builderConfig({});
    expect(c.electronFuses).toMatchObject({
      runAsNode: false, enableCookieEncryption: true, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true, onlyLoadAppFromAsar: true, grantFileProtocolExtraPrivileges: false,
    });
    expect(c.asar).toBe(true);
    expect(c.protocols).toEqual([{ name: "M5cet", schemes: ["m5cet"] }]);
    expect(c.mac.minimumSystemVersion).toBe("13.0");
    expect(c.mac.target).toEqual([{ target: "dmg", arch: ["universal"] }, { target: "zip", arch: ["universal"] }]);
    expect(c.win.target).toEqual([{ target: "nsis", arch: ["x64", "arm64"] }, { target: "zip", arch: ["x64", "arm64"] }]);
    expect(c.files).toContain("web/**/*");
  });

  it("updates: a generic https feed or GitHub releases, nothing else", () => {
    expect(publishConfig({ M5CET_UPDATE_URL: "https://updates.example.org/m5cet" })).toEqual([{ provider: "generic", url: "https://updates.example.org/m5cet" }]);
    expect(publishConfig({ M5CET_UPDATE_GITHUB: "owner/repo" })).toMatchObject([{ provider: "github", owner: "owner", repo: "repo" }]);
    expect(() => publishConfig({ M5CET_UPDATE_URL: "http://updates.example.org" })).toThrow();
    expect(() => publishConfig({ M5CET_UPDATE_URL: "https://user:pw@updates.example.org" })).toThrow();
    expect(() => publishConfig({ M5CET_UPDATE_GITHUB: "not a repo" })).toThrow();
  });

  it("macOS privacy prompts in all nine languages", () => {
    expect(LANGS).toEqual([...LOCALES]);
    for (const [key, row] of Object.entries(USAGE as Record<string, Record<string, string>>)) {
      for (const l of LOCALES) expect(row[l], `${key}/${l}`).toMatch(/M5cet/);
    }
    expect(usageInfo()).toMatchObject({ NSCameraUsageDescription: expect.any(String), NSMicrophoneUsageDescription: expect.any(String), NSLocationUsageDescription: expect.any(String), NSBluetoothPeripheralUsageDescription: expect.any(String), NSAudioCaptureUsageDescription: expect.any(String) });
    const dir = mkdtempSync(join(tmpdir(), "m5cet-lproj-"));
    try {
      writeInfoPlistStrings(dir);
      const cs = readFileSync(join(dir, "cs.lproj", "InfoPlist.strings"), "utf8");
      expect(cs).toContain('"NSCameraUsageDescription" = "M5cet používá kameru pro videohovory.";');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("app.asar header hashes", () => {
  const header = {
    files: {
      dist: { files: { "main.cjs": { size: 1, offset: "0", integrity: { algorithm: "SHA256", hash: "a".repeat(64) } } } },
      web: { files: {
        "index.html": { size: 1, offset: "1", integrity: { algorithm: "SHA256", hash: "b".repeat(64) } },
        assets: { files: { "x.js": { size: 1, offset: "2", integrity: { algorithm: "SHA256", hash: "c".repeat(64) } }, "bad.js": { size: 1, offset: "3", integrity: { algorithm: "MD5", hash: "x" } } } },
        "unpacked.bin": { size: 1, unpacked: true, integrity: { algorithm: "SHA256", hash: "d".repeat(64) } },
      } },
      "web-index.json": { size: 1, offset: "4", integrity: { algorithm: "SHA256", hash: "e".repeat(64) } },
    },
  };

  it("collects the SHA-256 of every packed web file and of the index", () => {
    const m = asarHashesFromHeader(JSON.stringify(header));
    expect([...m.entries()].sort()).toEqual([
      ["web-index.json", "e".repeat(64)], ["web/assets/x.js", "c".repeat(64)], ["web/index.html", "b".repeat(64)],
    ]);
  });

  it("reads the pickle prefix and refuses what is not an archive", () => {
    const json = JSON.stringify(header);
    const head = Buffer.alloc(16);
    head.writeUInt32LE(4, 0); head.writeUInt32LE(json.length + 8, 4); head.writeUInt32LE(json.length + 4, 8); head.writeUInt32LE(json.length, 12);
    expect(asarHeaderLength(head)).toBe(json.length);
    expect(() => asarHeaderLength(Buffer.alloc(16))).toThrow();
    expect(() => asarHeaderLength(Buffer.alloc(4))).toThrow();
  });
});
