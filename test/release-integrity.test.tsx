// 6.12 (F-02 of the security analysis): the web client is delivered by the
// server, and integrity.ts compared it with a manifest from that same server
// (file names only). Now it fetches the release manifest the DEVELOPER signed
// (release-web.json + .sig, docs/protocol-v4.md § 15), hashes the scripts and
// styles it actually loaded, and checks the signature with a pinned release key
// (fixed in the build, or trusted on first use per origin). A mismatch or a
// changed key keeps a red banner up. Honest limit: a first visit has no pin.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import {
  RELEASE_PIN_STORE, _resetReleaseStateForTests, checkRelease, compareRelease, decideRelease, loadReleasePin, parseReleaseManifest, releaseKeyId, runReleaseCheck, saveReleasePin, verifyRelease,
} from "../client/src/lib/integrity";
import { ReleaseBanner, ReleaseStatusCard, releaseAlarm } from "../client/src/components/ReleaseIntegrity";
import type { ReleaseManifest } from "../client/src/lib/p4/contract";

afterEach(() => { cleanup(); _resetReleaseStateForTests(); });

const enc = new TextEncoder();
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const sha = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))), (x) => x.toString(16).padStart(2, "0")).join("");

async function releaseKey() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { pub: b64(raw), sign: async (bytes: Uint8Array) => b64(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, bytes))) };
}

const JS = "console.log('the app')";
const CSS = "body{color:red}";
async function manifestBytes(over: Partial<ReleaseManifest> = {}): Promise<Uint8Array<ArrayBuffer>> {
  const m: ReleaseManifest = {
    format: "m5cet-release/1", name: "m5cet-web", version: "6.12.0", commit: "abc12345", created: "2026-10-05T00:00:00Z",
    files: [{ path: "assets/index.abc.js", size: JS.length, sha256: await sha(JS) }, { path: "assets/index.abc.css", size: CSS.length, sha256: await sha(CSS) }],
    ...over,
  };
  return new Uint8Array(enc.encode(JSON.stringify(m)));
}
const loaded = async () => [{ path: "assets/index.abc.js", sha256: await sha(JS) }, { path: "assets/index.abc.css", sha256: await sha(CSS) }];

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return { get length() { return m.size; }, clear: () => m.clear(), getItem: (k) => m.get(k) ?? null, key: (i) => [...m.keys()][i] ?? null, removeItem: (k) => { m.delete(k); }, setItem: (k, v) => { m.set(k, String(v)); } };
}

describe("the pure parts", () => {
  it("parses only m5cet-release/1 with hex SHA-256; compares loaded files by path and hash", async () => {
    const m = parseReleaseManifest(await manifestBytes())!;
    expect(m.files).toHaveLength(2);
    expect(parseReleaseManifest(enc.encode("{}"))).toBeNull();
    expect(parseReleaseManifest(enc.encode("<!doctype html>"))).toBeNull();
    expect(parseReleaseManifest(await manifestBytes({ files: [{ path: "a", size: 1, sha256: "not-hex" }] }))).toBeNull();
    expect(compareRelease(m, await loaded())).toEqual([]);
    expect(compareRelease(m, [{ path: "/assets/index.abc.js", sha256: "0".repeat(64) }, { path: "assets/evil.js", sha256: "1".repeat(64) }])).toEqual([
      { kind: "changed", path: "assets/index.abc.js", expected: await sha(JS), actual: "0".repeat(64) },
      { kind: "unlisted", path: "assets/evil.js", actual: "1".repeat(64) },
    ]);
  });

  it("verifies Ed25519 over the exact bytes; a key id is the first 8 bytes of its SHA-256", async () => {
    const key = await releaseKey();
    const bytes = await manifestBytes();
    const sig = await key.sign(bytes);
    expect(await verifyRelease(bytes, sig, key.pub)).toBe(true);
    const changed = new Uint8Array(bytes); changed[10] ^= 1;
    expect(await verifyRelease(changed, sig, key.pub)).toBe(false);
    expect(await verifyRelease(bytes, sig, (await releaseKey()).pub)).toBe(false);
    expect(await releaseKeyId(key.pub)).toMatch(/^[0-9A-F]{4}( [0-9A-F]{4}){3}$/);
  });

  it("pins per origin; a key fixed in the build wins", () => {
    const s = memoryStorage();
    expect(loadReleasePin("https://a.example", s, "")).toBeNull();
    saveReleasePin("https://a.example", "KEY-A", s, 5);
    expect(loadReleasePin("https://a.example", s, "")).toEqual({ key: "KEY-A", pinnedAt: 5, source: "first-use" });
    expect(loadReleasePin("https://b.example", s, "")).toBeNull();
    expect(loadReleasePin("https://b.example", s, "BUILD")).toEqual({ key: "BUILD", pinnedAt: 0, source: "build" });
    expect(JSON.parse(s.getItem(RELEASE_PIN_STORE)!)).toHaveProperty(["https://a.example"]);
  });
});

describe("the decision", () => {
  it("first use: a valid signature is trusted and the key pinned; later visits need that key", async () => {
    const key = await releaseKey();
    const manifest = await manifestBytes();
    const signature = await key.sign(manifest);
    const first = await decideRelease({ manifest, signature, servedKey: key.pub, pin: null, assets: await loaded(), now: 7 });
    expect(first.state).toMatchObject({ state: "signed", firstUse: true, keyId: await releaseKeyId(key.pub) });
    expect(first.pinNow).toBe(key.pub);
    const again = await decideRelease({ manifest, signature, servedKey: key.pub, pin: { key: key.pub, pinnedAt: 7, source: "first-use" }, assets: await loaded() });
    expect(again.state).toMatchObject({ state: "signed", firstUse: false });
    expect(again.pinNow).toBeNull();
  });

  it("MODIFIED: a loaded file differs, the signature fails, or a signing origin stops signing", async () => {
    const key = await releaseKey();
    const pin = { key: key.pub, pinnedAt: 1, source: "first-use" as const };
    const manifest = await manifestBytes();
    const signature = await key.sign(manifest);
    const changed = await decideRelease({ manifest, signature, servedKey: key.pub, pin, assets: [{ path: "assets/index.abc.js", sha256: "f".repeat(64) }] });
    expect(changed.state).toMatchObject({ state: "modified", reason: "assets" });
    expect(releaseAlarm(changed.state)).toBe(true);
    const forged = await decideRelease({ manifest: await manifestBytes({ version: "6.12.1" }), signature, servedKey: key.pub, pin, assets: await loaded() });
    expect(forged.state).toMatchObject({ state: "modified", reason: "bad-signature" });
    const stripped = await decideRelease({ manifest, signature: null, servedKey: null, pin, assets: await loaded() });
    expect(stripped.state).toMatchObject({ state: "modified", reason: "unsigned" });
  });

  it("KEY CHANGED: the server presents another key than the pinned one — even with a valid signature by it", async () => {
    const old = await releaseKey();
    const evil = await releaseKey();
    const manifest = await manifestBytes();
    const r = await decideRelease({ manifest, signature: await evil.sign(manifest), servedKey: evil.pub, pin: { key: old.pub, pinnedAt: 1, source: "first-use" }, assets: await loaded() });
    expect(r.state).toMatchObject({ state: "key-changed", pinnedId: await releaseKeyId(old.pub), servedId: await releaseKeyId(evil.pub), served: evil.pub });
    expect(releaseAlarm(r.state)).toBe(true);
  });

  it("unsigned (never signed here) and unavailable are no alarm; an unsigned release still lists what differs", async () => {
    const u = await decideRelease({ manifest: await manifestBytes(), signature: null, servedKey: null, pin: null, assets: [{ path: "assets/x.js", sha256: "a".repeat(64) }] });
    expect(u.state).toMatchObject({ state: "unsigned", mismatches: [{ kind: "unlisted", path: "assets/x.js" }] });
    expect(releaseAlarm(u.state)).toBe(false);
    expect((await decideRelease({ manifest: null, signature: null, servedKey: null, pin: null, assets: [] })).state).toEqual({ state: "unavailable" });
  });
});

describe("checkRelease (fetch, hash, decide, pin)", () => {
  it("pins on a verified first visit, and raises the alarm when the key changes afterwards", async () => {
    const key = await releaseKey();
    const manifest = await manifestBytes();
    const files: Record<string, string> = { "/release-web.json": new TextDecoder().decode(manifest), "/release-web.json.sig": await key.sign(manifest), "/release-signing.pub": key.pub };
    const fetcher = vi.fn(async (url: string) => {
      const path = url.split("?")[0];
      return path in files ? new Response(files[path], { status: 200 }) : new Response("<!doctype html>", { status: 200 });
    }) as unknown as typeof fetch;
    const storage = memoryStorage();
    const first = await checkRelease({ fetcher, storage, origin: "https://chat.example.org", assets: await loaded() });
    expect(first).toMatchObject({ state: "signed", firstUse: true });
    expect(loadReleasePin("https://chat.example.org", storage, "")?.key).toBe(key.pub);
    const evil = await releaseKey();
    files["/release-signing.pub"] = evil.pub;
    files["/release-web.json.sig"] = await evil.sign(manifest);
    expect(await checkRelease({ fetcher, storage, origin: "https://chat.example.org", assets: await loaded() })).toMatchObject({ state: "key-changed" });
    // An SPA fallback (index.html for a missing .sig) is not taken for a signature.
    delete files["/release-web.json.sig"];
    delete files["/release-signing.pub"];
    expect(await checkRelease({ fetcher, storage, origin: "https://other.example", assets: await loaded() })).toMatchObject({ state: "unsigned" });
  });
});

describe("the views", () => {
  it("the security panel's card says what is known; the banner shows only for an alarm", async () => {
    const fetcher = vi.fn(async () => new Response("nope", { status: 404 }));
    vi.stubGlobal("fetch", fetcher);
    try {
      await runReleaseCheck(true);
      const card = render(<ReleaseStatusCard lang="en" />);
      await waitFor(() => expect(card.getByTestId("release-status").getAttribute("data-state")).toBe("unavailable"));
      expect(card.getByTestId("release-status-text").textContent).toMatch(/No release manifest/);
      expect(card.container.textContent).toMatch(/first visit/i);
      const banner = render(<ReleaseBanner lang="en" />);
      expect(banner.queryByTestId("release-banner")).toBeNull();
    } finally { vi.unstubAllGlobals(); }
  });
});
