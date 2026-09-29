// Interop vectors for the Android app's Java port of the chat protocol and
// the framework's formats (6.0). Everything here is produced by the very
// code the web client and the server run (client/src/lib/*, server/android/*),
// so the Java tests (android/app/src/test/…/InteropTest.java) prove the
// port byte for byte: they open what the web sealed and check what it derived.
//
//   npx tsx script/android-vectors.ts   → test/fixtures/android-interop.json

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { argon2id } from "hash-wasm";
import { deriveRoomKeys, fileKey, fileContext, sealChunk, sealFileBody, sealMessage, sealSignal, context } from "../client/src/lib/envelope";
import { SenderKeyStore } from "../client/src/lib/sender-keys";
import { safetyNumber, keyId, keyFingerprint, type Identity } from "../client/src/lib/identity";
import { normalizeRoom } from "../client/src/lib/app-helpers";
import { fromBase64, toBase64 } from "../client/src/lib/crypto";
import * as acrypto from "../server/android/crypto";
import { compileDesign } from "../server/android/bundle";
import { DEFAULT_DESIGN } from "../server/android/design";

const subtle = globalThis.crypto.subtle;
const b64 = (b: ArrayBuffer | Uint8Array) => toBase64(new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b)));
const hex = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("hex");

/** A web-style identity whose private keys are exported too (the Java side needs them). */
async function identity(): Promise<{ identity: Identity; signPkcs8: string; dhPkcs8: string }> {
  const sign = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const dh = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const publicKey = b64(await subtle.exportKey("spki", sign.publicKey));
  const dhPublicKey = b64(await subtle.exportKey("spki", dh.publicKey));
  const id: Identity = {
    publicKey, dhPublicKey, persistent: false, kid: await keyId(publicKey), fingerprint: await keyFingerprint(publicKey),
    async sign(data) { return b64(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, sign.privateKey, data)); },
    async sharedSecret(peer) {
      const key = await subtle.importKey("spki", fromBase64(peer), { name: "ECDH", namedCurve: "P-256" }, false, []);
      return new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: key }, dh.privateKey, 256));
    },
  };
  return { identity: id, signPkcs8: b64(await subtle.exportKey("pkcs8", sign.privateKey)), dhPkcs8: b64(await subtle.exportKey("pkcs8", dh.privateKey)) };
}

async function main() {
  const out: Record<string, unknown> = {};

  // Argon2id: the RFC 9106 test vector shape (with a secret and data is not
  // exposed by hash-wasm) → plain vectors at small and at the real cost.
  const argon = [];
  for (const [password, salt, m, t, len] of [["password", "somesalt-m5cet", 64, 2, 32], ["heslo místnosti", "m5cet:room:v3:team", 1024, 3, 32], ["x", "m5cet:room:v3:long-salt-for-the-room-name", 65536, 3, 32]] as const) {
    const tag = await argon2id({ password, salt: new TextEncoder().encode(salt), parallelism: 1, iterations: t, memorySize: m, hashLength: len, outputType: "hex" });
    argon.push({ password, salt, m, t, p: 1, len, hex: tag });
  }
  out.argon2id = argon;

  // Room keys at the real cost (Argon2id 64 MiB, 3 passes).
  const room = normalizeRoom("  Tým Alfa / 2026 ");
  const passphrase = "Kůň pěl ódy — ﬁ";
  const keys = await deriveRoomKeys(room, passphrase);
  out.room = {
    input: "  Tým Alfa / 2026 ", room, passphrase, roomId: keys.roomId, check: keys.check,
    message: hex(await keys.derive("message")), signal: hex(await keys.derive("signal")), files: hex(await keys.derive("files")),
  };

  const alice = await identity();
  const bob = await identity();
  out.alice = { publicKey: alice.identity.publicKey, dhPublicKey: alice.identity.dhPublicKey, signPkcs8: alice.signPkcs8, dhPkcs8: alice.dhPkcs8, kid: alice.identity.kid, fingerprint: alice.identity.fingerprint };
  out.bob = { publicKey: bob.identity.publicKey, dhPublicKey: bob.identity.dhPublicKey, signPkcs8: bob.signPkcs8, dhPkcs8: bob.dhPkcs8, kid: bob.identity.kid, fingerprint: bob.identity.fingerprint };
  out.safetyNumber = await safetyNumber(alice.identity.publicKey, bob.identity.publicKey);

  // A room-key message signed by Alice, and an unsigned one.
  const payload = { id: "msg-0123456789abcdef01234567", text: "Ahoj 👋 — příliš žluťoučký kůň", createdAt: 1760000000000, senderId: "p-alice", senderName: "Alice" };
  out.message = { payload, signed: await sealMessage(keys, payload.id, payload, alice.identity), plain: await sealMessage(keys, payload.id, payload) };
  out.signal = { from: "p-alice", to: "p-bob", payload: { type: "offer", sdp: "v=0\r\n" }, sealed: await sealSignal(keys, "p-alice", "p-bob", { type: "offer", sdp: "v=0\r\n" }) };

  // Pairwise channel and sender keys: Alice → Bob.
  const aStore = new SenderKeyStore();
  const bStore = new SenderKeyStore();
  const helloA = await aStore.hello(keys, alice.identity, "p-alice", "p-bob");
  const helloB = await bStore.hello(keys, bob.identity, "p-bob", "p-alice");
  if (await aStore.acceptHello(keys, alice.identity, helloB, "p-bob", "p-alice")) throw new Error("hello B refused");
  if (await bStore.acceptHello(keys, bob.identity, helloA, "p-alice", "p-bob")) throw new Error("hello A refused");
  const senderKey = await aStore.senderKeyFor(keys, "p-alice", "p-bob");
  const live = [];
  for (let i = 0; i < 3; i++) {
    const p = { id: `msg-live-${i}`, text: `live ${i}`, createdAt: 1760000000000 + i, senderId: "p-alice", senderName: "Alice" };
    live.push({ payload: p, envelope: await aStore.sealLive(keys, p.id, p, alice.identity) });
  }
  const priv = { id: "msg-private-0", text: "jen pro Boba", createdAt: 1760000000100, senderId: "p-alice", senderName: "Alice", to: ["Bob"] };
  out.pair = {
    helloA, helloB, senderKey, live,
    private: { payload: priv, envelope: await aStore.sealPrivate(keys, priv.id, priv, "p-alice", "p-bob", alice.identity) },
    // What Bob's side derives, for the Java test to compare.
    pairKey: hex(new Uint8Array(await subtle.exportKey("raw", await (async () => {
      const secret = await bob.identity.sharedSecret(alice.identity.dhPublicKey);
      const base = await subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
      return subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode(keys.room), info: new TextEncoder().encode(`m5cet/pair/1|${[alice.identity.publicKey, bob.identity.publicKey].sort().join("|")}`) }, base, { name: "AES-GCM", length: 256 }, true, ["encrypt"]);
    })()))),
  };

  // A file: meta and one chunk.
  const transferId = "xfer-00000000-0000-4000-8000-000000000001";
  const fk = await fileKey(keys, transferId);
  const chunk = new TextEncoder().encode("chunk data ✓");
  out.file = {
    transferId, chunkPlain: b64(chunk),
    meta: await sealFileBody(fk, fileContext.meta(transferId), { transferId, name: "a.txt", mime: "text/plain", size: chunk.length, totalChunks: 1, chunkSize: 32768, senderId: "p-alice", senderName: "Alice", createdAt: 1760000000000 }, alice.identity),
    chunk: await sealChunk(fk, fileContext.chunk(transferId, 0, 1), chunk),
  };
  out.context = new TextDecoder().decode(context("msg", "team", "id-1"));

  // The Android formats: a device, a bundle for it, a push message.
  const server = acrypto.newP256();
  const device = acrypto.newP256();
  const deviceId = "and_vector0001";
  const signer = { privateKey: server.privateKey, kid: acrypto.kidOf(acrypto.spkiOf(server.publicKey)) };
  const { plaintext } = compileDesign(DEFAULT_DESIGN, { id: "bld_vector", number: 7, version: "6.0.0-b7", channel: "stable", created: 1760000000000, minAppCode: 60000, notes: "vector" });
  const sealed = acrypto.sealBundle({ id: "bld_vector", number: 7, version: "6.0.0-b7", channel: "stable", created: 1760000000000, minAppCode: 60000 }, plaintext, signer, 4096);
  const bundleFile = acrypto.bundleFile({ ...sealed.header, recipients: [acrypto.wrapBundleKey(sealed.cek, sealed.header, { id: deviceId, encKey: acrypto.spkiOf(device.publicKey) })] }, sealed.body);
  const push = acrypto.eciesSeal(acrypto.spkiOf(device.publicKey), deviceId, "push", Buffer.from(JSON.stringify({ id: "cmd_1", kind: "flash", at: 1, exp: 2, payload: { text: "ahoj" } })));
  const pushSig = acrypto.signP1363(server.privateKey, acrypto.pushSignedString(deviceId, "cmd_1", push));
  out.android = {
    serverPublicKey: acrypto.spkiOf(server.publicKey), serverKid: signer.kid,
    deviceId, devicePkcs8: b64(device.privateKey.export({ format: "der", type: "pkcs8" }) as Buffer), devicePublicKey: acrypto.spkiOf(device.publicKey),
    bundle: b64(bundleFile), bundleSegments: sealed.header.segments,
    push: { i: "cmd_1", ...push, s: pushSig },
    requestSigned: acrypto.requestSignedString("POST", "/api/android/checkin", "1760000000000", "abcdefghijklmnop", Buffer.from('{"state":{}}')),
  };

  const file = resolve(import.meta.dirname, "..", "test", "fixtures", "android-interop.json");
  writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
  console.log(`wrote ${file}`);
}

void main();
