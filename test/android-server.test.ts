// @vitest-environment node
// The Android framework's server side (6.0): the wire formats (ECIES,
// signatures, the M5AB bundle), the expression language, the design, and a
// device's whole life through the HTTP API — enrolment, signed check-ins,
// builds, control messages, events, wipe.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { deflateRawSync as zDeflateRawSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const dir = mkdtempSync(join(tmpdir(), "m5-android-"));
process.env.DATA_DIR = dir;

const crypto = await import("../server/android/crypto");
const expr = await import("../server/android/expr");
const design = await import("../server/android/design");
const bundle = await import("../server/android/bundle");
const apk = await import("../server/android/apk");
const { androidStore } = await import("../server/android/store");
const { setFcmFetch } = await import("../server/android/fcm");
const { forgetAndroidConfig } = await import("../server/android/config");
const vectors = JSON.parse(readFileSync(join(__dirname, "fixtures", "android-expr.json"), "utf8"));

afterAll(() => { androidStore.reset(); rmSync(dir, { recursive: true, force: true }); });

/* ------------------------------------------------------------------ crypto */

describe("wire formats", () => {
  it("ECIES opens only for the device and purpose it was sealed for", () => {
    const dev = crypto.newP256();
    const pub = crypto.spkiOf(dev.publicKey);
    const wire = crypto.eciesSeal(pub, "and_1", "push", Buffer.from("hello"));
    expect(crypto.eciesOpen(dev.privateKey, "and_1", "push", wire).toString()).toBe("hello");
    expect(() => crypto.eciesOpen(dev.privateKey, "and_2", "push", wire)).toThrow();
    expect(() => crypto.eciesOpen(dev.privateKey, "and_1", "bundle|x", wire)).toThrow();
    const other = crypto.newP256();
    expect(() => crypto.eciesOpen(other.privateKey, "and_1", "push", wire)).toThrow();
  });

  it("P1363 signatures are 64 bytes and verify", () => {
    const k = crypto.newP256();
    const sig = crypto.signP1363(k.privateKey, "data");
    expect(Buffer.from(sig, "base64")).toHaveLength(64);
    expect(crypto.verifyP1363(crypto.spkiOf(k.publicKey), "data", sig)).toBe(true);
    expect(crypto.verifyP1363(crypto.spkiOf(k.publicKey), "datA", sig)).toBe(false);
    expect(crypto.kidOf(crypto.spkiOf(k.publicKey))).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });

  it("the container keeps paths and bytes and refuses bad ones", () => {
    const entries: Array<[string, Buffer]> = [["manifest.json", Buffer.from("{}")], ["assets/a.png", randomBytes(300)]];
    expect(crypto.unpackContainer(crypto.packContainer(entries))).toEqual(entries);
    expect(() => crypto.packContainer([["../x", Buffer.alloc(1)]])).toThrow();
    expect(() => crypto.packContainer([["a", Buffer.alloc(1)], ["a", Buffer.alloc(1)]])).toThrow();
    expect(() => crypto.unpackContainer(crypto.packContainer(entries).subarray(0, 20))).toThrow();
  });

  it("a bundle opens for its recipients only, and any change is caught", () => {
    const server = crypto.newP256();
    const signer = { privateKey: server.privateKey, kid: crypto.kidOf(crypto.spkiOf(server.publicKey)) };
    const plain = randomBytes(600_000); // three segments of 256 KiB
    const meta = { id: "bld_t", number: 1, version: "6.0.0-b1", channel: "stable", created: 1, minAppCode: 60000 };
    const { header, body, cek } = crypto.sealBundle(meta, plain, signer);
    expect(header.segments).toBe(3);
    const dev = crypto.newP256();
    const device = { id: "and_x", encKey: crypto.spkiOf(dev.publicKey) };
    const file = crypto.bundleFile({ ...header, recipients: [crypto.wrapBundleKey(cek, header, device)] }, body);
    const opened = crypto.openBundleFile(file, { id: "and_x", privateKey: dev.privateKey }, crypto.spkiOf(server.publicKey));
    expect(opened.plaintext.equals(plain)).toBe(true);

    // Another device: not a recipient.
    const stranger = crypto.newP256();
    expect(() => crypto.openBundleFile(file, { id: "and_y", privateKey: stranger.privateKey }, crypto.spkiOf(server.publicKey))).toThrow(/not encrypted for this device/);
    // A changed header: the signature fails.
    const { header: h } = crypto.parseBundleFile(file);
    const forged = crypto.bundleFile({ ...h, minAppCode: 1 }, body);
    expect(() => crypto.openBundleFile(forged, { id: "and_x", privateKey: dev.privateKey }, crypto.spkiOf(server.publicKey))).toThrow(/signature/);
    // A flipped ciphertext byte: the hash (and the tag) fail.
    const flipped = Buffer.from(file);
    flipped[flipped.length - 100] ^= 1;
    expect(() => crypto.openBundleFile(flipped, { id: "and_x", privateKey: dev.privateKey }, crypto.spkiOf(server.publicKey))).toThrow();
    // Another server key: refused.
    const impostor = crypto.newP256();
    expect(() => crypto.openBundleFile(file, { id: "and_x", privateKey: dev.privateKey }, crypto.spkiOf(impostor.publicKey))).toThrow(/signature/);
  });
});

/* -------------------------------------------------------------- expressions */

describe("the expression language (shared vectors)", () => {
  const tr = (k: string) => vectors.strings[k] ?? k;
  for (const c of vectors.expressions) {
    it(`${c.src}`, () => { expect(expr.evalExpr(c.src, vectors.scope, tr)).toEqual(c.value); });
  }
  for (const c of vectors.templates) {
    it(`template ${c.src}`, () => { expect(expr.renderTemplate(c.src, vectors.scope, tr)).toBe(c.text); });
  }
  it("refuses what is not valid", () => {
    for (const src of vectors.invalid.expressions) expect(expr.checkExpr(src), src).not.toBeNull();
    for (const src of vectors.invalid.templates) expect(expr.checkTemplate(src), src).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ design */

describe("the design", () => {
  it("the default design is valid and has every screen, string and menu", () => {
    const clean = design.sanitizeDesign(design.DEFAULT_DESIGN);
    expect(Object.keys(clean.screens).sort()).toEqual([...design.SCREEN_IDS].sort());
    for (const lang of design.LANGS) expect(Object.keys(clean.strings[lang]).sort()).toEqual(Object.keys(design.DEFAULT_STRINGS.en).sort());
    expect(clean.menus.main.length).toBeGreaterThan(0);
  });

  it("every translation key a default screen uses exists", () => {
    const used = new Set<string>();
    const walk = (v: unknown) => {
      if (typeof v === "string") for (const m of v.matchAll(/_\(?['"]([a-zA-Z0-9_.-]+)['"]/g)) used.add(m[1]);
      else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x);
    };
    walk(design.DEFAULT_SCREENS);
    walk(design.DEFAULT_MENUS);
    for (const key of used) expect(design.DEFAULT_STRINGS.en[key], key).toBeTypeOf("string");
  });

  it("refuses unknown elements, icons, actions and bad expressions", () => {
    const bad = structuredClone(design.DEFAULT_DESIGN) as typeof design.DEFAULT_DESIGN;
    bad.screens.splash = { id: "root", el: "column", children: [
      { id: "a", el: "marquee" },
      { id: "b", el: "icon", props: { icon: "no-such-icon" } },
      { id: "c", el: "button", text: "x", on: { click: { action: "rm -rf" } } },
      { id: "d", el: "text", text: "{$x|nope}" },
      { id: "e", el: "text", if: "1 +", text: "y" },
    ] };
    try { design.sanitizeDesign(bad); expect.fail("should throw"); } catch (err) {
      const problems = (err as InstanceType<typeof design.DesignError>).problems.join("\n");
      expect(problems).toMatch(/unknown element "marquee"/);
      expect(problems).toMatch(/unknown icon "no-such-icon"/);
      expect(problems).toMatch(/unknown action "rm -rf"/);
      expect(problems).toMatch(/unknown filter/);
      expect(problems).toMatch(/if:/);
    }
  });

  it("a build carries the design and reads back to the same design", () => {
    const { plaintext, manifest } = bundle.compileDesign(design.DEFAULT_DESIGN, { id: "bld_c", number: 1, version: "6.0.0-b1", channel: "stable", created: 1, minAppCode: 60000, notes: "" });
    const content = bundle.readContent(plaintext);
    expect(content.manifest.screens).toEqual(manifest.screens);
    const back = bundle.designOfContent(content.files);
    expect(design.designRev(back)).toBe(design.designRev(design.sanitizeDesign(design.DEFAULT_DESIGN)));
  });
});

/* --------------------------------------------------------------------- APK */

/** A minimal APK: a ZIP with a binary AndroidManifest.xml and a v2 signing block. */
function fakeApk(pkg: string, versionCode: number, versionName: string, cert: Buffer): Buffer {
  const strings = ["manifest", "package", "versionCode", "versionName", "uses-sdk", "minSdkVersion", pkg, versionName];
  const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
  const strData = Buffer.concat(strings.map((s) => Buffer.concat([u16(s.length), Buffer.from(s, "utf16le"), u16(0)])));
  let off = 0;
  const offsets = strings.map((s) => { const o = off; off += 2 + s.length * 2 + 2; return o; });
  const poolHeader = 28;
  const pool = Buffer.concat([u16(0x0001), u16(poolHeader), u32(poolHeader + strings.length * 4 + strData.length), u32(strings.length), u32(0), u32(0), u32(poolHeader + strings.length * 4), u32(0), ...offsets.map(u32), strData]);
  const attr = (name: number, raw: number, type: number, data: number) => Buffer.concat([u32(0xffffffff), u32(name), u32(raw), u16(8), Buffer.from([0, type]), u32(data)]);
  const element = (name: number, attrs: Buffer[]) => {
    const body = Buffer.concat([u32(0xffffffff), u32(name), u16(20), u16(20), u16(attrs.length), u16(0), u16(0), u16(0), ...attrs]);
    return Buffer.concat([u16(0x0102), u16(16), u32(16 + body.length), u32(1), u32(0xffffffff), body]);
  };
  const manifestEl = element(0, [attr(1, 6, 0x03, 6), attr(2, 0xffffffff, 0x10, versionCode), attr(3, 7, 0x03, 7)]);
  const sdkEl = element(4, [attr(5, 0xffffffff, 0x10, 29)]);
  const chunks = Buffer.concat([pool, manifestEl, sdkEl]);
  const axml = Buffer.concat([u16(0x0003), u16(8), u32(8 + chunks.length), chunks]);

  const name = Buffer.from("AndroidManifest.xml");
  const data = zDeflateRawSync(axml);
  const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(8), u32(0), u32(0), u32(data.length), u32(axml.length), u16(name.length), u16(0), name, data]);
  const lp = (b: Buffer) => Buffer.concat([u32(b.length), b]);
  const signedData = Buffer.concat([lp(Buffer.alloc(0)), lp(lp(cert))]);
  const signer = lp(Buffer.concat([lp(signedData)]));
  const v2 = lp(signer);
  const pair = Buffer.concat([Buffer.from(new BigUint64Array([BigInt(4 + v2.length)]).buffer), u32(0x7109871a), v2]);
  const blockSize = 8 + pair.length + 8 + 16 - 8;
  const block = Buffer.concat([Buffer.from(new BigUint64Array([BigInt(blockSize)]).buffer), pair, Buffer.from(new BigUint64Array([BigInt(blockSize)]).buffer), Buffer.from("APK Sig Block 42")]);
  const cdOffset = local.length + block.length;
  const central = Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(8), u32(0), u32(0), u32(data.length), u32(axml.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(0), name]);
  const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(1), u16(1), u32(central.length), u32(cdOffset), u16(0)]);
  return Buffer.concat([local, block, central, eocd]);
}

describe("APK reading", () => {
  it("reads package, version and the signing certificate", () => {
    const cert = randomBytes(700);
    const info = apk.readApk(fakeApk("cz.m5cet.app", 60001, "6.0.1", cert));
    expect(info).toMatchObject({ packageName: "cz.m5cet.app", versionCode: 60001, versionName: "6.0.1", minSdk: 29 });
    expect(info.certSha256).toBe(createHash("sha256").update(cert).digest("hex"));
  });
  it("refuses a file that is no signed APK", () => {
    expect(() => apk.readApk(Buffer.from("not a zip at all, sorry"))).toThrow();
  });
});

/* ---------------------------------------------------------------- the API */

describe("a device's life through the API", () => {
  let server: Server;
  let base = "";
  const dev = { sign: crypto.newP256(), enc: crypto.newP256(), id: "" };
  let serverKey = "";

  beforeAll(async () => {
    const express = (await import("express")).default;
    const { registerAndroidRoutes } = await import("../server/android/routes");
    const { registerAndroidAdminRoutes } = await import("../server/android/admin-routes");
    const app = express();
    app.use("/api/android", express.raw({ type: () => true, limit: "1mb" }));
    app.use("/api/admin/android/releases/upload", express.raw({ type: () => true, limit: "20mb" }));
    app.use(express.json({ limit: "8mb" }));
    app.use((req, res, next) => { res.locals.adminName = "tester"; res.locals.adminRole = "owner"; next(); });
    registerAndroidAdminRoutes(app);
    registerAndroidRoutes(app);
    server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => { server?.close(); setFcmFetch(null); });

  const admin = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}/api/admin/android${path}`, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() as Record<string, any> };
  };

  const signed = async (method: string, path: string, body?: unknown, opts: { time?: number; nonce?: string } = {}) => {
    const raw = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const time = String(opts.time ?? Date.now());
    const nonce = opts.nonce ?? randomBytes(16).toString("base64url");
    const sig = crypto.signP1363(dev.sign.privateKey, crypto.requestSignedString(method, path, time, nonce, raw));
    const res = await fetch(`${base}${path}`, { method, headers: { "x-m5-device": dev.id, "x-m5-time": time, "x-m5-nonce": nonce, "x-m5-signature": sig, "content-type": "application/json" }, body: method === "GET" ? undefined : raw });
    return res;
  };

  it("tells a new device the server key", async () => {
    const res = await fetch(`${base}/api/android/info`);
    const info = await res.json() as Record<string, any>;
    expect(info.server.kid).toHaveLength(16);
    serverKey = info.server.publicKey;
    expect(info.enrollment).toBe("open");
  });

  it("enrols only with a valid proof, and with a code when codes are required", async () => {
    const signKey = crypto.spkiOf(dev.sign.publicKey);
    const encKey = crypto.spkiOf(dev.enc.publicKey);
    const time = Date.now();
    const bad = await fetch(`${base}/api/android/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signKey, encKey, time, proof: crypto.signP1363(crypto.newP256().privateKey, crypto.enrollSignedString(signKey, encKey, time)) }) });
    expect(bad.status).toBe(400);

    await admin("PUT", "/config", { enrollment: "code" });
    const created = await admin("POST", "/codes", { label: "test", uses: 1, days: 1 });
    expect(created.json.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const withCode = async (code: string) => {
      const t = Date.now();
      const res = await fetch(`${base}/api/android/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "Test phone", model: "Pixel", sdk: 36, appVersion: "6.0.0", appCode: 60000, signKey, encKey, time: t, proof: crypto.signP1363(dev.sign.privateKey, crypto.enrollSignedString(signKey, encKey, t)) }) });
      return { status: res.status, json: await res.json() as Record<string, any> };
    };
    expect((await withCode("AAAA-BBBB-CCCC")).status).toBe(403);
    const ok = await withCode(created.json.code.toLowerCase());
    expect(ok.status).toBe(200);
    dev.id = ok.json.deviceId;
    expect(dev.id).toMatch(/^and_/);
    expect(ok.json.policy.lock.maxAttempts).toBeGreaterThan(0);
    await admin("PUT", "/config", { enrollment: "open" });
  });

  it("refuses unsigned, forged, stale and replayed requests", async () => {
    expect((await fetch(`${base}/api/android/checkin`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await signed("POST", "/api/android/checkin", {}, { time: Date.now() - 10 * 60 * 1000 })).status).toBe(401);
    const nonce = randomBytes(16).toString("base64url");
    expect((await signed("POST", "/api/android/checkin", { state: {} }, { nonce })).status).toBe(200);
    expect((await signed("POST", "/api/android/checkin", { state: {} }, { nonce })).status).toBe(401);
    const time = String(Date.now());
    const n2 = randomBytes(16).toString("base64url");
    const sig = crypto.signP1363(dev.sign.privateKey, crypto.requestSignedString("POST", "/api/android/checkin", time, n2, Buffer.from("{}")));
    const tampered = await fetch(`${base}/api/android/checkin`, { method: "POST", headers: { "x-m5-device": dev.id, "x-m5-time": time, "x-m5-nonce": n2, "x-m5-signature": sig }, body: '{"state":{}}' });
    expect(tampered.status).toBe(401);
  });

  it("gets a published build, encrypted for it, and opens it", async () => {
    const created = await admin("POST", "/builds", { notes: "first", channel: "stable" });
    expect(created.status).toBe(200);
    const id = created.json.build.id;
    expect((await admin("POST", `/builds/${id}/publish`, { notify: false })).json.build.status).toBe("published");
    const check = await (await signed("POST", "/api/android/checkin", { appCode: 60000, state: { battery: 80 } })).json() as Record<string, any>;
    expect(check.bundle.id).toBe(id);
    const file = Buffer.from(await (await signed("GET", `/api/android/bundles/${id}`)).arrayBuffer());
    const opened = crypto.openBundleFile(file, { id: dev.id, privateKey: dev.enc.privateKey }, serverKey);
    const content = bundle.readContent(opened.plaintext);
    expect(content.manifest.screens).toContain("room");
    expect(JSON.parse(content.files.get("screens/lock.json")!.toString()).el).toBe("column");
    // The console can look inside, and a deploy file carries every active device.
    expect((await admin("GET", `/builds/${id}/content`)).json.manifest.id).toBe(id);
    const deploy = await fetch(`${base}/api/admin/android/builds/${id}/deploy?devices=all`);
    expect(crypto.parseBundleFile(Buffer.from(await deploy.arrayBuffer())).header.recipients.map((r) => r.device)).toContain(dev.id);
  });

  it("delivers a signed, encrypted control message on check-in, and takes the answer", async () => {
    const sent = await admin("POST", `/devices/${dev.id}/commands`, { kind: "flash", payload: { text: "Hi there", level: "success", evil: "<x>" } });
    expect(sent.json.via).toBe("poll");
    const check = await (await signed("POST", "/api/android/checkin", { state: {} })).json() as Record<string, any>;
    const wire = check.commands.find((c: { i: string }) => c.i === sent.json.command.id);
    expect(crypto.verifyP1363(serverKey, crypto.pushSignedString(dev.id, wire.i, wire), wire.s)).toBe(true);
    const content = JSON.parse(crypto.eciesOpen(dev.enc.privateKey, dev.id, "push", wire).toString());
    expect(content).toMatchObject({ kind: "flash", payload: { text: "Hi there", level: "success" } });
    expect(content.payload.evil).toBeUndefined();
    const ack = await (await signed("POST", "/api/android/ack", { id: wire.i, ok: true, result: { shown: true } })).json() as Record<string, any>;
    expect(ack.status).toBe("done");
  });

  it("sends over FCM when it is set up", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const sa = { type: "service_account", project_id: "m5-test", client_email: "fcm@m5-test.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }), token_uri: "https://oauth2.example/token" };
    const calls: Array<{ url: string; body: string }> = [];
    setFcmFetch((async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      if (String(url).includes("oauth2")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      return new Response(JSON.stringify({ name: "projects/m5-test/messages/1" }), { status: 200 });
    }) as typeof fetch);
    const cfg = await admin("PUT", "/config", { fcm: { enabled: true, serviceAccount: JSON.stringify(sa), client: { apiKey: "AIzaSyTEST_KEY_1234567890abcdefghi", appId: "1:1234567890:android:abcdef123456", senderId: "1234567890", projectId: "m5-test" } } });
    expect(cfg.json.fcm.ready).toBe(true);
    expect(JSON.stringify(cfg.json.config)).not.toContain("PRIVATE KEY");
    // The device reports its FCM token.
    await signed("POST", "/api/android/checkin", { fcmToken: "fcm-token-1", state: {} });
    const sent = await admin("POST", `/devices/${dev.id}/commands`, { kind: "ping" });
    expect(sent.json.via).toBe("fcm");
    const msg = JSON.parse(calls.find((c) => c.url.includes("messages:send"))!.body).message;
    expect(msg.token).toBe("fcm-token-1");
    expect(msg.android.priority).toBe("NORMAL");
    expect(msg.data.m5).toBe("1");
    expect(Object.keys(msg.data).sort()).toEqual(["ct", "e", "i", "iv", "m5", "s"]);
    const flash = await admin("POST", `/devices/${dev.id}/commands`, { kind: "flash", payload: { text: "x" } });
    expect(flash.json.via).toBe("fcm");
    expect(JSON.parse(calls.filter((c) => c.url.includes("messages:send")).pop()!.body).message.android.priority).toBe("HIGH");
    await admin("PUT", "/config", { fcm: { enabled: false } });
    forgetAndroidConfig();
  });

  it("uploads, signs and offers an APK release", async () => {
    const cert = randomBytes(500);
    const apkFile = fakeApk("cz.m5cet.app", 60001, "6.0.1", cert);
    const up = await fetch(`${base}/api/admin/android/releases/upload?channel=stable&notes=fixes`, { method: "POST", headers: { "content-type": "application/vnd.android.package-archive" }, body: apkFile });
    const rel = (await up.json() as Record<string, any>).release;
    expect(rel.versionCode).toBe(60001);
    expect(crypto.verifyP1363(serverKey, crypto.releaseSignedString(rel), rel.signature)).toBe(true);
    // Another certificate is refused once the first one is learned.
    const other = await fetch(`${base}/api/admin/android/releases/upload`, { method: "POST", body: fakeApk("cz.m5cet.app", 60002, "6.0.2", randomBytes(500)) });
    expect(other.status).toBe(400);
    await admin("POST", `/releases/${rel.id}/publish`, { notify: false });
    const check = await (await signed("POST", "/api/android/checkin", { appCode: 60000, state: {} })).json() as Record<string, any>;
    expect(check.release.id).toBe(rel.id);
    const got = Buffer.from(await (await signed("GET", `/api/android/releases/${rel.id}/apk`)).arrayBuffer());
    expect(createHash("sha256").update(got).digest("hex")).toBe(rel.apkSha256);
  });

  it("6.1: keeps positions for tracking (policy, spacing, ranges) and shows them to the console", async () => {
    const now = Date.now();
    const res = await signed("POST", "/api/android/location", { points: [
      { lat: 50.08, lon: 14.42, acc: 12, at: now - 60_000 },
      { lat: 50.081, lon: 14.421, acc: 10, at: now - 55_000 }, // closer than minSeconds (15 s) to the first
      { lat: 50.09, lon: 14.43, acc: 8, at: now - 30_000, speed: 1.4, heading: 90 },
      { lat: 95, lon: 14, at: now }, // out of range
    ] });
    expect((await res.json() as Record<string, any>).stored).toBe(2);
    const track = (await admin("GET", `/devices/${dev.id}/locations`)).json;
    expect(track.points.map((p: { lat: number }) => p.lat)).toEqual([50.09, 50.08]);
    expect(track.points[0]).toMatchObject({ speed: 1.4, heading: 90 });
    // The operator can switch it off: then nothing is kept.
    const cfg = (await admin("GET", "")).json.config;
    await admin("PUT", "/config", { policy: { ...cfg.policy, location: { track: false, days: 30, minSeconds: 15 } } });
    expect((await signed("POST", "/api/android/location", { points: [{ lat: 1, lon: 1, at: Date.now() }] })).status).toBe(403);
    await admin("PUT", "/config", { policy: { ...cfg.policy, location: { track: true, days: 30, minSeconds: 15 } } });
    expect((await admin("DELETE", `/devices/${dev.id}/locations`)).json.deleted).toBe(2);
  });

  it("records events; a wipe (even signed long ago) retires the device", async () => {
    const res = await signed("POST", "/api/android/events", { events: [{ id: "evt-00000001", type: "unlock-failed", at: Date.now(), detail: { attempts: 3 } }, { id: "evt-00000001", type: "unlock-failed" }] });
    expect((await res.json() as Record<string, any>).stored).toBe(1);
    const late = await signed("POST", "/api/android/events", { events: [{ id: "evt-wipe-0001", type: "wipe", at: Date.now() - 86_400_000, detail: { reason: "attempts" } }] }, { time: Date.now() - 2 * 86_400_000 });
    expect(late.status).toBe(200);
    const d = (await admin("GET", `/devices/${dev.id}`)).json;
    expect(d.device.status).toBe("wiped");
    expect(d.events.map((e: { type: string }) => e.type)).toContain("wipe");
    expect(d.device.signKey).toBeUndefined();
    expect((await signed("POST", "/api/android/checkin", { state: {} })).status).toBe(403);
  });

  it("the design API validates what it saves", async () => {
    const d = (await admin("GET", "/design")).json.design;
    d.screens.splash.children.push({ id: "bad", el: "icon", props: { icon: "nope" } });
    const res = await admin("PUT", "/design", { design: d });
    expect(res.status).toBe(400);
    expect(res.json.problems.join()).toMatch(/unknown icon/);
    const cat = (await admin("GET", "/catalog")).json.catalog;
    expect(cat.screens.map((s: { id: string }) => s.id)).toContain("rooms.item");
    expect(Object.keys(cat.icons).length).toBeGreaterThan(100);
  });
});

