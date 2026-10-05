// Golden fixtures for the M5Net tests, made by the SERVER's own code:
//
//   hub-frames.json     client frames run through server/signaling/frames.ts parseFrame
//                       (what the hub reads), frames it refuses, and the frames a live
//                       SignalingHub sends (captured from a real hub over real sockets:
//                       hello, joined, peers, presence, relay, key directory, errors…)
//   device-vectors.json the device API's signed strings and P1363 signatures
//                       (server/mobile/crypto.ts), the signed policy, a release, a push
//                       control message sealed for the interop device key
//   ios-api.json        a device's session through the server's real /api/ios/* routes
//                       (server/ios/routes.ts): info, enroll, check-in with a bundle offer,
//                       a release record and a sealed command, the bundle file, the
//                       signed release, ack and events — requests and answers
//
// Run from the repository root (node_modules of the checkout):
//   npx tsx ios/M5Kit/Tests/M5NetTests/fixtures/generate-fixtures.ts
// The output is committed; the Swift tests never run node.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync, randomBytes, sign as edSign, createPrivateKey } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import type { StoredCredential } from "../../../../../server/accounts/webauthn";

const here = dirname(fileURLToPath(import.meta.url));
const root = joinPath(here, "../../../../..");
// The server's stores and keys go to a throwaway data directory (set before the server modules load),
// and the hub hashes room names with a throwaway storage key — nothing is written into the checkout.
const dataDir = mkdtempSync(joinPath(tmpdir(), "m5net-data-"));
process.env.DATA_DIR = dataDir;
process.env.STORAGE_MASTER_KEY ||= randomBytes(32).toString("hex");
for (const k of ["APNS_KEY_FILE", "APNS_KEY_ID", "APNS_TEAM_ID", "APNS_TOPIC", "APNS_ENV"]) delete process.env[k];

const { AccountStore } = await import("../../../../../server/accounts/store");
const { MemoryQueue } = await import("../../../../../server/accounts/memqueue");
const { SignalingHub } = await import("../../../../../server/signaling/hub");
const { parseFrame, isFrameError } = await import("../../../../../server/signaling/frames");
const { RoomProofs } = await import("../../../../../server/signaling/proof");
const { hashRoom } = await import("../../../../../server/monitor/traffic");
const {
  eciesSeal, enrollSignedString, kidOf, fingerprintOf, newP256, pushSignedString, releaseSignedString, requestSignedString,
  signP1363, signPolicy, spkiOf, verifyP1363,
} = await import("../../../../../server/mobile/crypto");
const { iosReleaseSignedString } = await import("../../../../../server/ios/releases");

/* ---------------------------------------------------------- client frames */

const b64 = (n: number) => randomBytes(n).toString("base64");
const b64url = (n: number) => randomBytes(n).toString("base64url");

function mailboxItem(id: string) {
  return {
    v: 4, kind: "mb", id, to: b64url(8),
    sb: { id: b64url(8), dh: b64(91), kem: b64(1184), exp: 1_900_000_000_000, sig: b64(64) },
    spk: b64(91), sacc: { apk: b64(32), ac: b64(64), cv: 2, exp: 1_900_000_000_000 }, e: b64(91), kct: b64(1088), c: b64(300),
  };
}
const P3 = { iv: "aXYtYmFzZTY0aXYt", ciphertext: "Y2lwaGVydGV4dA==", v: 2, sig: "c2lnbmF0dXJl", kid: "a2lk" };
const item1 = mailboxItem("m-relay-1");
const item2 = mailboxItem("m-relay-1");
const mbSet = { v: 4, kind: "mb-set", id: "m-relay-1", items: [item1, item2] };

/** What the Swift encoder must write for each case: the input as a client sends it, and the hub's reading of it. */
const clientCases: Array<{ name: string; input: Record<string, unknown> }> = [
  { name: "join-proof", input: { type: "join", protocol: 2, room: "r3.Vm9jdG9yUm9vbUlkRm9yUDQ", name: "Alice", peerId: "peer-0a1b2c3d4e5f60718293a4b5", resume: "c2VjcmV0LXJlc3VtZS1zZWNyZXQtMDEyMzQ1Njc4", away: false, features: ["bin"], foreground: true, proof: { pub: "MWd1RyHKkVO1zanLqvF5ebXEWkwWcbAzxvAbteCURv4=", sig: "oV/X3Jvy7rxC3PrKI2CReDlwHWHNpiM7oyrEGumn7cQ1bgu919SSZKnNvk5YPA1yvBXubbiU63KVTvTm7/V6Aw==" } } },
  { name: "join-legacy", input: { type: "join", protocol: 2, room: "plain room", name: "Bob", peerId: "peer-ffeeddccbbaa998877665544", away: false, features: ["bin"], foreground: false } },
  { name: "auth", input: { type: "auth", token: "tok_0123456789abcdef", away: true } },
  { name: "auth-out", input: { type: "auth", token: null, away: false } },
  { name: "leave", input: { type: "leave", away: false } },
  { name: "ping", input: { type: "ping", t: 1_800_000_000_123 } },
  { name: "presence-fg", input: { type: "presence", away: false, foreground: true } },
  { name: "presence-bg", input: { type: "presence", away: false, foreground: false } },
  { name: "signal-sealed", input: { type: "signal", target: "peer-1", payload: { sealed: { v: 2, iv: "aXYtaXYtaXYtaXYt", ciphertext: "Y3QtY3QtY3QtY3Q=" } } } },
  { name: "signal-offer", input: { type: "signal", target: "peer-1", payload: { type: "offer", sdp: "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n" } } },
  { name: "signal-ice", input: { type: "signal", target: "peer-1", payload: { candidate: "candidate:1 1 udp 2122260223 192.168.1.2 50000 typ host", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: "abcd" } } },
  { name: "relay-p3", input: { type: "relay", messageId: "m-relay-1", to: ["ref-a", "ref-b"], envelope: P3, expiresAt: 1_900_000_000_000, mention: ["ref-b"] } },
  { name: "relay-per", input: { type: "relay", messageId: "m-relay-1", to: ["ref-a", "ref-b", "ref-c"], per: { "ref-a": item1, "ref-b": mbSet }, envelope: P3, call: true } },
  { name: "relay-per-only", input: { type: "relay", messageId: "m-relay-1", to: ["ref-a"], per: { "ref-a": item1 } } },
  { name: "relay-ack", input: { type: "relay-ack", ids: ["q-1", "q-2"] } },
  { name: "receipt", input: { type: "receipt", messageIds: ["m-1", "m-2"], state: "read" } },
  { name: "command-poll", input: { type: "command-poll", deviceId: "ios_0123456789" } },
  { name: "command-ack", input: { type: "command-ack", commandId: "cmd-1", result: "done" } },
  { name: "storage", input: { type: "storage", id: "42", op: "messages.put", payload: { a: 1 }, session: "s-1" } },
  { name: "proxy-meta", input: { type: "proxy-meta", transferId: "t-1", iv: "aXYtaXYtaXYtaXYt", ciphertext: "bWV0YQ==", v: 4 } },
  { name: "proxy-chunk", input: { type: "proxy-chunk", transferId: "t-1", seq: 7, iv: "aXYtaXYtaXYtaXYt", ciphertext: "Y2h1bms=", v: 2 } },
  { name: "proxy-end", input: { type: "proxy-end", transferId: "t-1", v: 4, iv: "aXYtaXYtaXYtaXYt", ciphertext: "ZW5k" } },
  { name: "proxy-cancel", input: { type: "proxy-cancel", transferId: "t-1" } },
  { name: "proxy-need", input: { type: "proxy-need", transferId: "t-1", seqs: [1, 2, 5] } },
  { name: "key-bundles", input: { type: "key-bundles", ref: "ref-a" } },
  { name: "kt-lookup", input: { type: "kt-lookup", ref: "ref-a" } },
];

/** Frames the hub refuses — the Swift validator must refuse them before they go out. */
const invalidCases: Array<{ name: string; input: Record<string, unknown> }> = [
  { name: "join-no-room", input: { type: "join", protocol: 2, room: "   ", name: "x" } },
  { name: "join-bad-proof", input: { type: "join", protocol: 2, room: "r3.x", name: "x", proof: { pub: "not base64!", sig: "x" } } },
  { name: "signal-bad-target", input: { type: "signal", target: "bad target", payload: { candidate: "c" } } },
  { name: "signal-bad-sdp-type", input: { type: "signal", target: "p", payload: { type: "nope", sdp: "x" } } },
  { name: "relay-no-envelope", input: { type: "relay", messageId: "m-1", to: ["ref-a", "ref-b"], per: { "ref-a": P3 } } },
  { name: "relay-bad-envelope-key", input: { type: "relay", messageId: "m-1", to: ["ref-a"], envelope: { iv: "aa", ciphertext: "bb", Bad: "x" } } },
  { name: "relay-empty-to", input: { type: "relay", messageId: "m-1", to: [], envelope: P3 } },
  { name: "receipt-empty", input: { type: "receipt", messageIds: [], state: "read" } },
  { name: "proxy-need-empty", input: { type: "proxy-need", transferId: "t-1", seqs: [] } },
  { name: "key-bundles-bad-ref", input: { type: "key-bundles", ref: "a b" } },
];

const client = clientCases.map(({ name, input }) => {
  const parsed = parseFrame(JSON.stringify(input));
  if (isFrameError(parsed)) throw new Error(`${name}: the hub refuses it: ${parsed.message}`);
  return { name, input, parsed: JSON.parse(JSON.stringify(parsed)) };
});
const invalid = invalidCases.map(({ name, input }) => {
  const parsed = parseFrame(JSON.stringify(input));
  if (!isFrameError(parsed)) throw new Error(`${name}: the hub accepts it`);
  return { name, input, error: parsed.message };
});

/* ----------------------------------------------------- a live hub's frames */

type Frame = Record<string, unknown> & { type: string };

class Client {
  readonly frames: Frame[] = [];
  closeCode = 0;
  private waiters: Array<() => void> = [];
  private constructor(readonly ws: WebSocket) {
    ws.on("message", (data, isBinary) => {
      if (!isBinary) this.frames.push(JSON.parse(data.toString("utf8")) as Frame);
      this.waiters.splice(0).forEach((w) => w());
    });
    ws.on("close", (code) => { this.closeCode = code; this.waiters.splice(0).forEach((w) => w()); });
  }
  static async open(base: string): Promise<Client> {
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws`);
    const c = new Client(ws);
    await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
    return c;
  }
  send(f: Record<string, unknown>) { this.ws.send(JSON.stringify(f)); }
  sendRaw(s: string) { this.ws.send(s); }
  async next(type: string, pred: (f: Frame) => boolean = () => true, timeout = 3000): Promise<Frame> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const f = this.frames.find((x) => x.type === type && pred(x));
      if (f) { this.frames.splice(this.frames.indexOf(f), 1); return f; }
      if (Date.now() > deadline) throw new Error(`no ${type}; have ${this.frames.map((x) => x.type).join(",")}`);
      await new Promise<void>((r) => { const t = setTimeout(r, 50); this.waiters.push(() => { clearTimeout(t); r(); }); });
    }
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
  terminate() { try { this.ws.terminate(); } catch { /* gone */ } }
}

const kt = JSON.parse(readFileSync(joinPath(root, "test/vectors/p4.json"), "utf8")).kt;
const directoryDevice = {
  pk: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEbs44mFwNGodJlmcp5yFkUBHaQ7Ss0ld2OPazSdloBoqvQ6WXOG8DcaSbMSUXBoejs1mXoaEfk1Batrcn1GD7OQ==",
  apk: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=",
  cert: { v: 2, exp: 1_900_000_000_000, sig: b64(64) },
  bundle: { id: "bndl0001", dh: b64(91), kem: b64(1184), exp: 1_900_000_000_000, sig: b64(64) },
};
const ktLookup = { sth: kt.sth[1], entries: [{ entry: kt.entries[0], index: 0, proof: kt.inclusion[0].path }] };

async function captureHub() {
  const dir = mkdtempSync(joinPath(tmpdir(), "m5net-fixtures-"));
  const store = new AccountStore(dir);
  const queue = new MemoryQueue();
  const hub = new SignalingHub({
    accounts: store,
    queue: () => queue,
    storageFrame: (socket, _state, frame, send) => send(socket, { type: "storage-result", id: frame.id, ok: true }),
    newStorageState: () => ({ windowStart: Date.now(), count: 0 }),
    trustProxy: false,
    roomProofs: RoomProofs.inMemory({ required: false, ttlMs: 365 * 86_400_000 }),
    directory: { devices: () => [directoryDevice as never], lookup: async (account) => (account ? ktLookup as never : { sth: kt.sth[1], entries: [] } as never) },
  });
  const server: Server = createServer();
  hub.attach(server);
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const account = (name: string) => {
    const credential: StoredCredential = { credentialId: `cred-${name}-000000000`, publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" }, alg: -7, signCount: 1 };
    const r = store.create(credential, name);
    if (!r.ok) throw new Error(r.reason);
    return { id: r.account.id, token: store.issueToken(r.account.id) };
  };
  const room = `r3.${randomBytes(24).toString("base64url")}`;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pub = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(12).toString("base64");
  const prove = (nonce: string) => ({ pub, sig: edSign(null, Buffer.from(`m5cet/hub-join/4|${room}|${nonce}`, "utf8"), privateKey).toString("base64") });
  const out: Record<string, unknown> = {};
  const alice = account("alice"), bob = account("bob");

  // Alice: hello, join with the proof, joined (proven).
  const a = await Client.open(base);
  const helloA = await a.next("hello");
  out.hello = helloA;
  a.send({ type: "join", protocol: 2, room, name: "Alice", peerId: helloA.peerId, away: false, features: ["bin"], foreground: true, proof: prove(String(helloA.nonce)) });
  out.joinedFirst = await a.next("joined");
  a.send({ type: "auth", token: alice.token, away: true });
  out.authResult = await a.next("auth-result");

  // Bob joins signed in (auth in the join), without a proof: legacy, unproven.
  const b = await Client.open(base);
  const helloB = await b.next("hello");
  b.send({ type: "join", protocol: 2, room, name: "Bob", peerId: helloB.peerId, auth: bob.token, away: true, features: ["bin"], foreground: true });
  out.joinedSecond = await b.next("joined");
  const peerJoined = await a.next("peer-joined");
  out.peerJoined = peerJoined;
  const bobRef = String(peerJoined.account);
  const bobPeer = String(peerJoined.peerId);

  // Keepalive, presence.
  a.send({ type: "ping", t: 1_800_000_000_000 });
  out.pong = await a.next("pong");
  b.send({ type: "presence", away: false, foreground: false });
  out.presenceAck = await b.next("presence-ack");
  out.peerPresence = await a.next("peer-presence");

  // Signals.
  b.send({ type: "signal", target: String(out.joinedFirst && (out.joinedFirst as Frame).peerId), payload: { sealed: { v: 2, iv: "aXYtaXYtaXYtaXYt", ciphertext: "Y3QtY3QtY3QtY3Q=" } } });
  out.signal = await a.next("signal");
  b.send({ type: "signal", target: "peer-nobody", payload: { candidate: "c" } });
  out.signalUndeliverable = await b.next("signal-undeliverable");

  // The key directory and key transparency over the hub (Alice proved).
  a.send({ type: "key-bundles", ref: bobRef });
  out.keyBundles = await a.next("key-bundles");
  a.send({ type: "kt-lookup", ref: bobRef });
  out.ktLookup = await a.next("kt-lookup");
  a.send({ type: "key-bundles", ref: "ref-unknown" });
  out.keyBundlesUnknown = await a.next("key-bundles");

  // Bob goes away (closed app): the relay covers for him; Alice relays, Bob comes back, acknowledges.
  b.send({ type: "presence", away: true, foreground: false });
  await b.next("presence-ack");
  out.peerAway = await a.next("peer-away");
  a.send({ type: "relay", messageId: "m-relay-1", to: [bobRef], per: { [bobRef]: item1 } });
  out.relayStatusStored = await a.next("relay-status");
  b.send({ type: "presence", away: false, foreground: true });
  out.relayDeliver = await b.next("relay-deliver");
  out.peerBack = await a.next("peer-back");
  const items = (out.relayDeliver as { items: Array<{ id: string }> }).items;
  b.send({ type: "relay-ack", ids: items.map((i) => i.id) });
  out.relayStatusDelivered = await a.next("relay-status", (f) => f.state === "delivered");

  // A third client: a foreign proof (refused, legacy allowed), then a legacy join; rate limits; an invalid frame.
  const c = await Client.open(base);
  const helloC = await c.next("hello");
  const other = generateKeyPairSync("ed25519");
  const otherPub = (other.publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(12).toString("base64");
  c.send({ type: "join", protocol: 2, room, name: "Carol", peerId: helloC.peerId, away: false, proof: { pub: otherPub, sig: edSign(null, Buffer.from(`m5cet/hub-join/4|${room}|${helloC.nonce}`), other.privateKey).toString("base64") } });
  out.errorRoomProof = await c.next("error");
  c.send({ type: "join", protocol: 2, room, name: "Carol", peerId: helloC.peerId, away: false });
  out.joinedLegacy = await c.next("joined");
  c.sendRaw("not json");
  out.errorInvalid = await c.next("error");
  for (let i = 0; i < 14; i++) c.send({ type: "presence", away: false, foreground: i % 2 === 0 });
  out.rateLimited = await c.next("rate-limited");

  // The operator: a notice to the room.
  hub.notice(hashRoom(room)!, { kind: "wall", text: "Maintenance at 22:00", level: "warning", from: "operator" });
  out.serverNotice = await c.next("server-notice");

  // Bob's connection drops without a goodbye: held (6.7) — Carol sees it.
  b.terminate();
  out.peerLeftHeld = await c.next("peer-left", (f) => f.held === true);
  // Alice leaves on purpose.
  a.send({ type: "leave", away: false });
  out.peerLeft = await c.next("peer-left", (f) => f.held !== true);

  // The same client again with its resume secret: the old socket is replaced (4001).
  const d1 = await Client.open(base);
  const helloD = await d1.next("hello");
  d1.send({ type: "join", protocol: 2, room: "plain-room", name: "Dan", peerId: "peer-dan-0001", away: false });
  const joinedD = await d1.next("joined");
  const d2 = await Client.open(base);
  await d2.next("hello");
  d2.send({ type: "join", protocol: 2, room: "plain-room", name: "Dan", peerId: "peer-dan-0001", resume: joinedD.resume, away: false });
  out.joinedResumed = await d2.next("joined");
  out.replaced = await d1.next("replaced");
  await new Promise((r) => setTimeout(r, 100));
  out.replacedCloseCode = d1.closeCode;
  void helloD;

  // The operator closes a connection (4003).
  const conn = String((await (async () => { const e = await Client.open(base); const h = await e.next("hello"); (out as Record<string, unknown>).__e = e; return h; })()).connId);
  const e = (out as Record<string, unknown>).__e as Client;
  delete (out as Record<string, unknown>).__e;
  hub.closeConnection(conn, "closed by the operator");
  out.closedByServer = await e.next("closed-by-server");
  await new Promise((r) => setTimeout(r, 100));
  out.closedByServerCloseCode = e.closeCode;

  for (const x of [a, b, c, d1, d2, e]) x.close();
  await hub.shutdown();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
  return { room, bobRef, bobPeer, frames: out };
}

/* ---------------------------------------------------------- device vectors */

function deviceVectors() {
  const interop = JSON.parse(readFileSync(joinPath(root, "test/fixtures/android-interop.json"), "utf8")).android;
  const device = createPrivateKey({ key: Buffer.from(interop.devicePkcs8, "base64"), format: "der", type: "pkcs8" });
  const deviceSpki = interop.devicePublicKey as string;
  const encKey = deviceSpki; // the vector device uses one key for both (Android keeps two)
  const requests = [
    { method: "POST", path: "/api/ios/checkin", time: "1800000000000", nonce: "AAECAwQFBgcICQoLDA0ODw", body: JSON.stringify({ appVersion: "6.14.0", appCode: 61400, locale: "cs" }) },
    { method: "GET", path: "/api/ios/bundles/bld_0001", time: "1800000000001", nonce: "EBESExQVFhcYGRobHB0eHw", body: "" },
    { method: "post", path: "/m5/api/ios/events?x=1", time: "1800000000002", nonce: "ICEiIyQlJicoKSorLC0uLw", body: JSON.stringify({ events: [{ id: "ev0000001", type: "log", at: 1, detail: { text: "Žluťoučký kůň" } }] }) },
  ].map((r) => {
    const body = Buffer.from(r.body, "utf8");
    const string = requestSignedString(r.method, r.path, r.time, r.nonce, body);
    const signature = signP1363(device, string);
    if (!verifyP1363(deviceSpki, string, signature)) throw new Error("request signature");
    return { ...r, bodyB64: body.toString("base64"), string, signature };
  });
  const enrollTime = 1_800_000_000_000;
  const enrollString = enrollSignedString(deviceSpki, encKey, enrollTime);
  const enroll = { signKey: deviceSpki, encKey, time: enrollTime, string: enrollString, proof: signP1363(device, enrollString) };

  const serverKey = newP256();
  const serverSpki = spkiOf(serverKey.publicKey);
  const policyBody = { lock: { pinLength: 6, maxAttempts: 8, wipe: true, screenshots: false, autolockSeconds: 60 }, logs: "errors", rooms: { max: 5 }, location: { track: false } };
  const policy = signPolicy(serverKey.privateKey, "ios_vector0001", policyBody, 1_800_000_000_000);
  const policyOlder = signPolicy(serverKey.privateKey, "ios_vector0001", { ...policyBody, logs: "off" }, 1_799_999_999_000);
  const policyOtherDevice = signPolicy(serverKey.privateKey, "ios_other", policyBody, 1_800_000_000_000);

  const release = { id: "rel_0001", versionCode: 61500, versionName: "6.15.0", packageName: "cz.m5cet.app", apkSha256: "00".repeat(32), certSha256: "11".repeat(32), size: 1234 };
  const releaseString = releaseSignedString(release);
  const releaseAnswer = { ok: true, release: { ...release, minSdk: 26, mandatory: false, notes: "", channel: "stable" }, signed: releaseString, signature: signP1363(serverKey.privateKey, releaseString), kid: kidOf(serverSpki) };
  const iosRelease = { id: "irel_0001", version: "6.15.0", build: 61500, bundleId: "cz.m5cet.app", channel: "stable" as const, store: "appstore" as const, url: "https://apps.apple.com/app/m5cet/id1234567890", minBuild: 61450 };
  const iosReleaseString = iosReleaseSignedString(iosRelease as never);
  const iosReleaseAnswer = { ok: true, release: { ...iosRelease, notes: { en: "Faster", cs: "Rychlejší" }, rollout: 100, mandatory: true }, signed: iosReleaseString, signature: signP1363(serverKey.privateKey, iosReleaseString), kid: kidOf(serverSpki) };

  // A control message sealed for the interop device (eciesSeal) and signed by this server key.
  const content = { id: "msg_0001", kind: "lock", payload: { reason: "lost" }, exp: 0 };
  const wire = eciesSeal(encKey, "ios_vector0001", "push", Buffer.from(JSON.stringify(content), "utf8"));
  const push = { i: "msg_0001", ...wire, s: signP1363(serverKey.privateKey, pushSignedString("ios_vector0001", "msg_0001", wire)) };
  const expired = { id: "msg_0002", kind: "ping", payload: {}, exp: 1_000 };
  const wire2 = eciesSeal(encKey, "ios_vector0001", "push", Buffer.from(JSON.stringify(expired), "utf8"));
  const pushExpired = { i: "msg_0002", ...wire2, s: signP1363(serverKey.privateKey, pushSignedString("ios_vector0001", "msg_0002", wire2)) };

  return {
    devicePkcs8: interop.devicePkcs8, devicePublicKey: deviceSpki, deviceKid: kidOf(deviceSpki), deviceFingerprint: fingerprintOf(deviceSpki),
    requests, enroll,
    server: { publicKey: serverSpki, kid: kidOf(serverSpki), fingerprint: fingerprintOf(serverSpki) },
    deviceId: "ios_vector0001",
    policy, policyOlder, policyOtherDevice,
    releaseAnswer, iosReleaseAnswer,
    push, pushContent: content, pushExpired,
  };
}

/* --------------------------------------------- a device through /api/ios/* */

async function captureIos() {
  const express = (await import("express")).default;
  const { registerIosRoutes } = await import("../../../../../server/ios/routes");
  const { registerIosAdminRoutes } = await import("../../../../../server/ios/admin-routes");
  const app = express();
  app.use(["/api/ios"], express.raw({ type: () => true, limit: "1mb" }));
  app.use(express.json({ limit: "8mb" }));
  app.use((_req, res, next) => { res.locals.adminName = "fixtures"; res.locals.adminRole = "owner"; next(); });
  registerIosAdminRoutes(app);
  registerIosRoutes(app);
  const server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const interop = JSON.parse(readFileSync(joinPath(root, "test/fixtures/android-interop.json"), "utf8")).android;
  const key = createPrivateKey({ key: Buffer.from(interop.devicePkcs8, "base64"), format: "der", type: "pkcs8" });
  const spki = interop.devicePublicKey as string;
  let deviceId = "";
  const json = async (res: Response) => ({ status: res.status, body: await res.json() as Record<string, any> });
  const admin = async (method: string, path: string, body?: unknown) =>
    json(await fetch(`${base}/api/admin/ios${path}`, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined }));
  const signed = async (method: string, path: string, body?: unknown) => {
    const raw = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const time = String(Date.now());
    const nonce = randomBytes(16).toString("base64url");
    const sig = signP1363(key, requestSignedString(method, path, time, nonce, raw));
    return fetch(`${base}${path}`, { method, headers: { "x-m5-device": deviceId, "x-m5-time": time, "x-m5-nonce": nonce, "x-m5-signature": sig, "content-type": "application/json" }, body: method === "GET" ? undefined : raw });
  };

  const info = await json(await fetch(`${base}/api/ios/info`));
  const time = Date.now();
  const enrollRequest = {
    code: "", name: "Test iPhone", model: "iPhone17,1", modelName: "iPhone 17 Pro", idiom: "phone", os: "iOS", osVersion: "26.0",
    appVersion: "6.14.0", appCode: 61400, locale: "cs", signKey: spki, encKey: spki, apnsToken: "c0ffee".repeat(10) + "abcd", apnsEnv: "sandbox",
    time, proof: signP1363(key, enrollSignedString(spki, spki, time)),
  };
  const enroll = await json(await fetch(`${base}/api/ios/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(enrollRequest) }));
  if (enroll.status !== 200) throw new Error(`enroll: ${JSON.stringify(enroll.body)}`);
  deviceId = enroll.body.deviceId;

  // The operator: an iOS build, a release record, a command for this device.
  await admin("PUT", "/config", { appStoreUrl: "https://apps.apple.com/app/m5cet/id1234567890" });
  const build = (await admin("POST", "/builds", { notes: "fixtures", channel: "stable" })).body.build;
  await admin("POST", `/builds/${build.id}/publish`, { notify: false });
  const rel = (await admin("POST", "/releases", { version: "6.15.0", channel: "stable", notes: { en: "Faster", cs: "Rychlejší" }, rollout: 100 })).body.release;
  await admin("POST", `/releases/${rel.id}/publish`, { notify: false });
  const command = (await admin("POST", `/devices/${deviceId}/commands`, { kind: "lock", payload: { reason: "lost" } })).body.command;

  const checkinRequest = {
    appVersion: "6.14.0", appCode: Math.max(61400, build.minAppCode), os: "iOS", osVersion: "26.0", locale: "cs",
    state: { battery: 80, charging: false, network: "wifi", locked: false, rooms: 1, bundle: null, push: "poll", lockMode: "pin", failedAttempts: 0, storage: 1024, permissions: [], policyAt: 0, biometry: "faceID" },
  };
  const checkin = await json(await signed("POST", "/api/ios/checkin", checkinRequest));
  if (checkin.status !== 200) throw new Error(`checkin: ${JSON.stringify(checkin.body)}`);
  const bundleRes = await signed("GET", `/api/ios/bundles/${build.id}`);
  const bundleFile = Buffer.from(await bundleRes.arrayBuffer());
  const release = await json(await signed("GET", `/api/ios/releases/${rel.id}`));
  if (release.body.signed !== iosReleaseSignedString(rel)) throw new Error("release string");
  const ack = await json(await signed("POST", "/api/ios/ack", { id: command.id, ok: true, result: { locked: true }, error: "" }));
  const events = await json(await signed("POST", "/api/ios/events", { events: [{ id: "evfixture01", type: "unlock", at: Date.now(), detail: {} }] }));
  const notify = await json(await signed("POST", "/api/ios/notify", { on: true, token: "not-a-session" }));
  const forged = await json(await fetch(`${base}/api/ios/checkin`, { method: "POST", headers: { "x-m5-device": deviceId, "x-m5-time": String(Date.now()), "x-m5-nonce": randomBytes(16).toString("base64url"), "x-m5-signature": signP1363(newP256().privateKey, "x"), "content-type": "application/json" }, body: "{}" }));

  server.close();
  return {
    devicePkcs8: interop.devicePkcs8, deviceId,
    info: info.body, enrollRequest, enroll: enroll.body,
    checkinRequest, checkin: checkin.body,
    commandId: command.id, buildId: build.id, buildMinAppCode: build.minAppCode,
    bundleFile: bundleFile.toString("base64"), bundleContentType: bundleRes.headers.get("content-type"),
    release: release.body, ack: ack.body, events: events.body, notify: { status: notify.status, body: notify.body }, forged: { status: forged.status, body: forged.body },
  };
}

/* ------------------------------------------------------------------- main */

const live = await captureHub();
const ios = await captureIos();
const generator = "ios/M5Kit/Tests/M5NetTests/fixtures/generate-fixtures.ts";
writeFileSync(joinPath(here, "hub-frames.json"), `${JSON.stringify({ generator, client, invalid, live }, null, 1)}\n`);
writeFileSync(joinPath(here, "device-vectors.json"), `${JSON.stringify({ generator, ...deviceVectors() }, null, 1)}\n`);
writeFileSync(joinPath(here, "ios-api.json"), `${JSON.stringify({ generator, ...ios }, null, 1)}\n`);
rmSync(dataDir, { recursive: true, force: true });
console.log(`hub-frames.json: ${client.length} client frames, ${invalid.length} refused, ${Object.keys(live.frames).length} live frames; device-vectors.json; ios-api.json (bundle ${ios.bundleFile.length} b64 chars)`);
process.exit(0);
