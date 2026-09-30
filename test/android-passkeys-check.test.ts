// @vitest-environment node
// 6.4: Passkeys on Android — a certificate trusted in the console counts for
// assetlinks.json and the WebAuthn app origin but never for releases, and
// the self-check tells a blocking proxy, a stale Google cache and an
// unknown phone certificate apart. The internet is a fake fetch here.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "m5passkeys-"));

const { androidConfig, saveAndroidConfig, forgetAndroidConfig } = await import("../server/android/config");
const { androidAppOrigins, androidCertSources, assetLinks } = await import("../server/android/app-links");
const { fingerprintsIn, nginxSnippet, passkeySelfCheck } = await import("../server/android/passkeys-check");

const RELEASE = "a".repeat(64);
const DEBUG = "3cf2e0f82f32da5651a0ff17a3d50899fb517d1f30b1bb03ed4e3b5096e61ba1";
const colons = (hex: string) => hex.toUpperCase().match(/../g)!.join(":");
const statement = (certs: string[]) => [{
  relation: ["delegate_permission/common.get_login_creds", "delegate_permission/common.handle_all_urls"],
  target: { namespace: "android_app", package_name: "cz.m5cet.app", sha256_cert_fingerprints: certs.map(colons) },
}];

type Route = { status: number; type: string; body: string };
function fakeFetch(external: Route, googleCerts: string[] | { error: string }) {
  return (async (url: string | URL) => {
    const u = String(url);
    if (u.startsWith("https://digitalassetlinks.googleapis.com/")) {
      const body = Array.isArray(googleCerts)
        ? { statements: googleCerts.map((c) => ({ target: { androidApp: { packageName: "cz.m5cet.app", certificate: { sha256Fingerprint: colons(c) } } } })) }
        : { errorCode: [googleCerts.error], debugString: "fetch failed" };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(external.body, { status: external.status, headers: { "content-type": external.type } });
  }) as typeof fetch;
}
const device = (cert: string, name = "Galaxy Z Fold6") => ({ certSha256: cert, name, model: "SM-F956B", status: "active", lastSeen: 1_000 }) as never;

beforeEach(() => {
  forgetAndroidConfig();
  saveAndroidConfig({ ...androidConfig(), certSha256: [RELEASE], passkeyCertSha256: [] }, "test");
});
afterEach(() => { delete process.env.ANDROID_DEBUG_CERT_SHA256; });

describe("trusted for passkeys", () => {
  it("adds the certificate to assetlinks.json and the app origins, not to releases", () => {
    saveAndroidConfig({ ...androidConfig(), passkeyCertSha256: [DEBUG] }, "test");
    expect(androidCertSources().get(DEBUG)).toEqual(["trusted"]);
    expect(androidCertSources().get(RELEASE)).toEqual(["release"]);
    expect(androidAppOrigins()).toContain(`android:apk-key-hash:${Buffer.from(DEBUG, "hex").toString("base64url")}`);
    expect(fingerprintsIn(assetLinks(), "cz.m5cet.app").sort()).toEqual([DEBUG, RELEASE].sort());
    expect(androidConfig().certSha256).toEqual([RELEASE]); // the release check is untouched
  });

  it("reads only get_login_creds statements for our package", () => {
    const other = [{ relation: ["delegate_permission/common.handle_all_urls"], target: { namespace: "android_app", package_name: "cz.m5cet.app", sha256_cert_fingerprints: [colons(DEBUG)] } }];
    expect(fingerprintsIn(other, "cz.m5cet.app")).toEqual([]);
    expect(fingerprintsIn(statement([DEBUG]), "com.other")).toEqual([]);
    expect(fingerprintsIn("<html>", "cz.m5cet.app")).toEqual([]);
  });
});

describe("the self-check", () => {
  const run = (external: Route, google: string[] | { error: string }, devices: never[] = []) =>
    passkeySelfCheck({ rpId: "chat.example.org", packageName: "cz.m5cet.app", port: 5000, devices, fetchImpl: fakeFetch(external, google) });

  it("names a proxy that answers 403 with an HTML page", async () => {
    const r = await run({ status: 403, type: "text/html", body: "<html>403 Forbidden</html>" }, { error: "ERROR_CODE_FETCH_ERROR" });
    expect(r.verdict).toBe("blocked");
    expect(r.external).toMatchObject({ status: 403, contentType: "text/html", json: false, fingerprints: [] });
    expect(r.hints[0]).toContain("HTTP 403");
    expect(r.nginx).toContain("location = /.well-known/assetlinks.json");
    expect(r.nginx).toContain("proxy_pass http://127.0.0.1:5000;");
  });

  it("notices an SPA page served as 200", async () => {
    const r = await run({ status: 200, type: "text/html", body: "<!doctype html><div id=root>" }, [RELEASE]);
    expect(r.verdict).toBe("not-json");
  });

  it("waits for Google, then is happy", async () => {
    const good = { status: 200, type: "application/json", body: JSON.stringify(statement([RELEASE])) };
    expect((await run(good, { error: "ERROR_CODE_FETCH_ERROR" })).verdict).toBe("google-stale");
    const ok = await run(good, [RELEASE]);
    expect(ok.verdict).toBe("ok");
    expect(ok.certs).toEqual([{ sha256: RELEASE, sources: ["release"], published: true }]);
    expect(ok.hints).toEqual(["Phones can use this server's passkeys."]);
  });

  it("points at a phone whose certificate the server does not list", async () => {
    const good = { status: 200, type: "application/json", body: JSON.stringify(statement([RELEASE])) };
    const r = await run(good, [RELEASE], [device(DEBUG), device(DEBUG, "Pixel 9"), device(RELEASE, "Work phone")]);
    expect(r.devices.find((d) => d.sha256 === DEBUG)).toMatchObject({ devices: 2, names: ["Galaxy Z Fold6", "Pixel 9"], trusted: false, release: false });
    expect(r.devices.find((d) => d.sha256 === RELEASE)).toMatchObject({ trusted: false, release: true });
    expect(r.hints.some((h) => h.includes("Galaxy Z Fold6, Pixel 9"))).toBe(true);
  });

  it("reports a certificate the public file lacks", async () => {
    saveAndroidConfig({ ...androidConfig(), passkeyCertSha256: [DEBUG] }, "test");
    const stale = { status: 200, type: "application/json", body: JSON.stringify(statement([RELEASE])) };
    const r = await run(stale, [RELEASE]);
    expect(r.verdict).toBe("missing-cert");
    expect(r.certs.find((c) => c.sha256 === DEBUG)).toMatchObject({ sources: ["trusted"], published: false });
  });

  it("does not go out for a local passkey domain", async () => {
    const r = await passkeySelfCheck({ rpId: "localhost", packageName: "cz.m5cet.app", port: 5000, devices: [], fetchImpl: (() => { throw new Error("no network"); }) as never });
    expect(r.verdict).toBe("blocked");
    expect(r.external.error).toContain("local address");
  });

  it("formats the nginx block for another port", () => {
    expect(nginxSnippet(5178)).toContain("127.0.0.1:5178");
  });
});
