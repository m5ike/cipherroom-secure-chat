// Test vectors of protocol 4 (docs/protocol-v4.md) for the Android port.
//
//   npx tsx script/gen-p4-vectors.ts   → test/vectors/p4.json
//
// Everything is produced by the web reference implementation
// (client/src/lib/p4/*); test/p4-vectors.test.ts re-checks the committed file
// against the same code, so it cannot drift. Every input is explicit:
// P-256 private keys as PKCS#8 (b64), ML-KEM seeds (64 B, d || z),
// encapsulation messages m (32 B), nonces, ids and chain keys. Random draws
// are recorded per party as a TAPE, in the order the implementation makes
// them (see client/src/lib/p4/rng.ts); a port that replays the tape must
// produce the same hellos (but sig/sig4), KEM messages, keys and frames.
// ECDSA signatures are randomized: they are given for verification only.
// Ed25519 signatures are deterministic and must match.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  b64, b64url, bundleSignedData, buildKemMessage, canonicalEntry, certifyDeviceV2, consistencyProof, createBundle, ecdh,
  ed25519FromSeed, ed25519Sign, entryLeafHash, establishSession, fileAad4, fileKeyBytes, fileKey4, frameIv, H, hex, hkdf,
  helloRef, helloSig4Data, hubKeyPair, hubJoinData, buildHubProof, inclusionProof, importP256Pkcs8, join, joinText, kdfCk, kdfRk,
  kemEncapsWith, kemKeygenFromSeed, kemKid, keyIv, ktUser, LABEL, mbDigest, accDigest, capsDigest, userDigest, sthDigest, accountDigest,
  openKemMessage, pad, paddedLength, pairAad,
  RecordingRng, replayKey, rootSchedule, sealFileBody4, sealMailboxItem, SenderKeys4, senderKeyAad, skCertData, signSth, sthData, treeHash,
  unb64, unpad, buildHello, utf8, type DeviceSigner, type KtEntry, type RatchetFrame, type RatchetInner, type Hash, type Ratchet,
  sha256Hex,
} from "../client/src/lib/p4";
import { sealFrame } from "../client/src/lib/media-frames";

const subtle = globalThis.crypto.subtle;
const OUT = resolve(import.meta.dirname ?? ".", "../test/vectors/p4.json");

const bytes = (n: number, f: (i: number) => number) => new Uint8Array(n).map((_, i) => f(i) & 0xff);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** A device: ECDSA P-256 signing key (exported) and the protocol-3 static ECDH key. */
async function device() {
  const sign = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const dh = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const pk = b64(new Uint8Array(await subtle.exportKey("spki", sign.publicKey)));
  const signer: DeviceSigner = { publicKey: pk, sign: async (data) => b64(new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, sign.privateKey, data))) };
  return {
    signer, pk,
    pkcs8: b64(new Uint8Array(await subtle.exportKey("pkcs8", sign.privateKey))),
    dh: b64(new Uint8Array(await subtle.exportKey("spki", dh.publicKey))),
  };
}

/** Protocol 3's hello signature (sender-keys.ts helloContext), over the readable room name. */
const v3Context = (room: string, from: string, to: string, check: string, dh: string) => utf8(["m5cet/hello/1", room, from, to, check, dh].join("|"));

async function primitives() {
  const joins = [
    { parts: [LABEL.pairAad, "r3.room", "peer-a", "peer-b", 0, 12345] },
    { parts: ["x", "", "-", 0] },
  ].map((j) => ({ ...j, text: joinText(...j.parts) }));

  // The message of length len is the bytes (i % 251) for i < len.
  const padCases = [];
  for (const len of [0, 1, 200, 255, 256, 300, 511, 1023, 65535, 65536, 70000]) {
    const m = bytes(len, (i) => i % 251);
    const p = pad(m);
    if (p.length !== paddedLength(len)) throw new Error("pad");
    padCases.push({ len, paddedLength: p.length, sha256: await sha256Hex(p), ...(len <= 300 ? { in: b64(m), out: b64(p) } : {}) });
  }
  const unpadCases = [
    { in: b64(new Uint8Array([1, 2, 0x80, 0, 0])), ok: true, out: b64(new Uint8Array([1, 2])) },
    { in: b64(new Uint8Array([0x80, 0x80, 0])), ok: true, out: b64(new Uint8Array([0x80])) },
    { in: b64(new Uint8Array([0x80])), ok: true, out: "" },
    { in: b64(new Uint8Array([1, 2, 0, 0])), ok: false },
    { in: b64(new Uint8Array([0, 0, 0])), ok: false },
    { in: "", ok: false },
  ];
  for (const c of unpadCases) {
    let ok = true;
    try { if (b64(unpad(unb64(c.in))) !== (c.out ?? "")) throw new Error("vector"); } catch { ok = false; }
    if (ok !== c.ok) throw new Error("unpad vector");
  }

  const hkdfCases = [];
  for (const [salt, ikm, info, length] of [[bytes(13, (i) => i), bytes(22, () => 0x0b), LABEL.root, 96], [new Uint8Array(32), bytes(32, (i) => i * 3), LABEL.pairKey, 44], [utf8("tx-1"), bytes(32, (i) => 255 - i), LABEL.file, 32]] as const) {
    hkdfCases.push({ salt: b64(salt), ikm: b64(ikm), info, length, okm: b64(await hkdf(salt, ikm, info, length)) });
  }
  const kdfRkCases = [];
  for (const kss of [null, bytes(32, (i) => i + 100)]) {
    const rk = bytes(32, (i) => i * 7);
    const dh = bytes(32, (i) => i * 11);
    const r = await kdfRk(rk, dh, kss);
    kdfRkCases.push({ rk: b64(rk), dh: b64(dh), kss: kss ? b64(kss) : null, rkOut: b64(r.rk), ck: b64(r.ck) });
  }
  const ck = bytes(32, (i) => i * 13);
  const ckOut = await kdfCk(ck);
  const keyIvCases = [];
  for (const label of [LABEL.pairKey, LABEL.senderKey]) {
    const mk = bytes(32, (i) => i * 17);
    const { key, iv } = await keyIv(mk, label);
    keyIvCases.push({ mk: b64(mk), label, key: b64(key), iv: b64(iv) });
  }
  return { join: joins, pad: padCases, padMessage: "bytes (i % 251) for i < len", unpad: unpadCases, hkdf: hkdfCases, kdfRk: kdfRkCases, kdfCk: [{ ck: b64(ck), mk: b64(ckOut.mk), next: b64(ckOut.ck) }], keyIv: keyIvCases };
}

async function mlkem() {
  const out = [];
  for (let c = 0; c < 2; c++) {
    const seed = globalThis.crypto.getRandomValues(new Uint8Array(64));
    const m = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const { ek, dk } = kemKeygenFromSeed(seed);
    const { ct, ss } = kemEncapsWith(ek, m);
    out.push({ seed: b64(seed), ek: b64(ek), dk: b64(dk), kid: await kemKid(ek), m: b64(m), ct: b64(ct), ss: b64(ss) });
  }
  return out;
}

/** Party A's sender-key chain (owner = A's device) and a few room messages. */
async function senderKeys(roomId: string, owner: { peerId: string; pk: string; pkcs8: string }, to: string) {
  const rng = new RecordingRng();
  const alice = new SenderKeys4(roomId, { publicKey: owner.pk }, { rng });
  await alice.prepare(1_800_000_000_000);
  const chain = alice.chainFor(to);
  const messages = [];
  for (let i = 0; i < 4; i++) {
    const payload = { id: `sk-msg-${i}`, kind: "text", text: i === 2 ? "Příliš žluťoučký kůň 🐎" : `room message ${i}`, createdAt: 1_800_000_000_000 + i };
    const envelope = await alice.seal(payload.id, payload);
    messages.push({ payload, json: JSON.stringify(payload), aad: text(senderKeyAad(roomId, payload.id, envelope.sk, envelope.n)), envelope });
  }
  return {
    section: {
      roomId, owner: owner.peerId, ownerPk: owner.pk, ownerDevicePkcs8: owner.pkcs8,
      about: "Tape: sk.keyId, sk.chain, sk.spk (PKCS#8). `cert` is ECDSA by the chain's spk over certSignedData (randomized: verify only). A receiver accepts `chain` from the pair session of `owner` (hello pk = ownerPk) and opens the messages in any order.",
      tape: rng.tape, chain, certSignedData: text(skCertData(roomId, chain.keyId, owner.pk)), messages,
    },
    chain,
  };
}

type Party = { name: "A" | "B"; peerId: string; dev: Awaited<ReturnType<typeof device>>; rng: RecordingRng };

async function handshakeAndRatchet(roomId: string, roomName: string, check: string) {
  const now = 1_800_000_000_000;
  const d1 = { peerId: "peer-a", dev: await device() };
  const d2 = { peerId: "peer-b", dev: await device() };
  // Role A: the smaller pk|peerId (§ 4).
  const [pa, pb] = `${d1.dev.pk}|${d1.peerId}` < `${d2.dev.pk}|${d2.peerId}` ? [d1, d2] : [d2, d1];
  const A: Party = { name: "A", ...pa, rng: new RecordingRng() };
  const B: Party = { name: "B", ...pb, rng: new RecordingRng() };
  // A's own sender-key chain: A hands it to B in the script below.
  const { section: senderKey, chain: skInner } = await senderKeys(roomId, { peerId: A.peerId, pk: A.dev.pk, pkcs8: A.dev.pkcs8 }, B.peerId);

  // A carries a mailbox bundle, B an account attestation (v2 certificate): both digests get exercised.
  const bundleRng = new RecordingRng();
  const mb = await createBundle(A.dev.signer, now, bundleRng);
  const accountSeed = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const account = await ed25519FromSeed(accountSeed);
  const cert = await certifyDeviceV2(account.privateKey, B.dev.pk, now + 30 * 24 * 3600 * 1000, now);
  const acc = { apk: b64(account.publicKey), ac: cert.sig, cv: 2 as const, exp: cert.exp };

  // 6.12 review P02: sig4 also covers caps (sorted, without duplicates), the user claim and the tree head.
  // A gossips a tree head and claims a (non-ASCII) username; B lists its caps out of order with a duplicate.
  const ktKeys = await ed25519FromSeed(bytes(32, (i) => 0x40 + i));
  const sth = await signSth(ktKeys.privateKey, 5, bytes(32, (i) => i * 7 + 3), 1_800_000_100_000);
  const hello = async (self: Party, peer: Party, extra: { mb: typeof mb.bundle | null; acc: typeof acc | null; caps: string[]; user?: string; sth: typeof sth | null }) => {
    const sig = await self.dev.signer.sign(v3Context(roomName, self.peerId, peer.peerId, check, self.dev.dh));
    return buildHello({ roomId, from: self.peerId, to: peer.peerId, v3: { check, pk: self.dev.pk, dh: self.dev.dh, sig, caps: extra.caps, ...(extra.user ? { user: extra.user } : {}) }, signer: self.dev.signer, mb: extra.mb, acc: extra.acc, sth: extra.sth, rng: self.rng });
  };
  const hA = await hello(A, B, { mb: mb.bundle, acc: null, caps: ["bin", "media"], user: "Žofie", sth });
  const hB = await hello(B, A, { mb: null, acc, caps: ["media", "bin", "x-profile", "media"], sth: null });
  const kemAtoB = await buildKemMessage(hB.hello, A.rng); // A encapsulates to B's k
  const kemBtoA = await buildKemMessage(hA.hello, B.rng);
  const atA = (await openKemMessage(kemBtoA.message, hA))!;
  const atB = (await openKemMessage(kemAtoB.message, hB))!;
  const ssA = b64(kemAtoB.ss);
  const ssB = b64(kemBtoA.ss);
  const sa = await establishSession({ roomId, check, self: { peerId: A.peerId, hello: hA.hello, secrets: hA.secrets }, peer: { peerId: B.peerId, hello: hB.hello }, sent: { ct: kemAtoB.ct, ss: unb64(ssA) }, received: atA, rng: A.rng });
  const sb = await establishSession({ roomId, check, self: { peerId: B.peerId, hello: hB.hello, secrets: hB.secrets }, peer: { peerId: A.peerId, hello: hA.hello }, sent: { ct: kemBtoA.ct, ss: unb64(ssB) }, received: atB, rng: B.rng });
  if (sa.role !== "A" || sb.role !== "B" || b64(sa.th) !== b64(sb.th)) throw new Error("roles / TH");
  const eA = (A.rng.tape[0] as { pkcs8: string }).pkcs8;
  const dh0 = await ecdh((await importP256Pkcs8(eA, "ecdh")).privateKey, hB.hello.e);
  const root = await rootSchedule(sa.th, dh0, unb64(ssA), unb64(ssB));

  const handshake = {
    roomId, roomName, check, now,
    about: "Role A is the party whose pk|peerId is smaller. Each party's tape starts with its hello draws (hello.e, hello.k, hello.n), then hello.kem-m (its KEM message), then the ratchet's init draws, then the ratchet steps of the script. sig (protocol 3, over roomName) and sig4 are ECDSA: verify only. sig4Data ends with capsDigest (caps sorted ordinally, duplicates removed), userDigest (SHA-256 of the UTF-8 user claim, or \"-\") and sthDigest (or \"-\"); `sth` is signed by the key of kt.ktSeed.",
    A: { peerId: A.peerId, devicePkcs8: A.dev.pkcs8, pk: A.dev.pk, dh: A.dev.dh, hello: hA.hello, sig4Data: text(await helloSig4Data(roomId, A.peerId, B.peerId, hA.hello)), mbDigest: await mbDigest(hA.hello.mb), accDigest: await accDigest(hA.hello.acc), capsDigest: await capsDigest(hA.hello.caps), userDigest: await userDigest(hA.hello.user), sthDigest: await sthDigest(hA.hello.sth), helloRef: await helloRef(hA.hello), mailboxBundleTape: bundleRng.tape, mailboxBundleSignedData: text(await bundleSignedData(mb.bundle)) },
    B: { peerId: B.peerId, devicePkcs8: B.dev.pkcs8, pk: B.dev.pk, dh: B.dev.dh, hello: hB.hello, sig4Data: text(await helloSig4Data(roomId, B.peerId, A.peerId, hB.hello)), mbDigest: await mbDigest(hB.hello.mb), accDigest: await accDigest(hB.hello.acc), capsDigest: await capsDigest(hB.hello.caps), userDigest: await userDigest(hB.hello.user), sthDigest: await sthDigest(hB.hello.sth), helloRef: await helloRef(hB.hello), accountSeed: b64(accountSeed), certSignedData: joinText(LABEL.deviceCert, B.dev.pk, cert.exp) },
    kemAtoB: { message: kemAtoB.message, ss: ssA },
    kemBtoA: { message: kemBtoA.message, ss: ssB },
    dh0: b64(dh0), TH: b64(sa.th), RK0: b64(root.rk0), CK_B0: b64(root.ckB0), SID: b64(sa.sid),
  };

  // The scripted conversation.
  const r: Record<"A" | "B", Ratchet> = { A: sa.ratchet, B: sb.ratchet };
  const ids: Record<"A" | "B", string> = { A: A.peerId, B: B.peerId };
  const frames: RatchetFrame[] = [];
  const frameBy: Array<"A" | "B"> = [];
  const script: unknown[] = [];
  const sent: RatchetInner[] = [];
  const send = async (by: "A" | "B", inner: RatchetInner) => {
    const frame = await r[by].encrypt(inner);
    const to = by === "A" ? "B" : "A";
    script.push({ op: "send", by, frame: frames.length, inner, json: JSON.stringify(inner), aad: text(await pairAad(roomId, ids[by], ids[to], sa.th, frame.h)), wire: frame });
    frames.push(frame);
    frameBy.push(by);
    sent.push(inner);
    return frames.length - 1;
  };
  const recv = async (by: "A" | "B", index: number) => {
    const res = await r[by].decrypt(frames[index]);
    if (!res.ok || JSON.stringify(res.inner) !== JSON.stringify(sent[index])) throw new Error(`script: ${by} could not open frame ${index}`);
    script.push({ op: "recv", by, frame: index, inner: res.inner });
  };
  const m = (id: string, body: string): RatchetInner => ({ t: "msg", id, p: { id, kind: "text", text: body, createdAt: now } });
  const b0 = await send("B", m("b0", "B's first chain (CK_B0)"));
  const a0 = await send("A", m("a0", "A's first chain — no KEM ciphertext yet"));
  const a1 = await send("A", skInner);
  await recv("B", a0);                                     // B: new chain → DH + KEM step
  await recv("B", a1);
  await recv("A", b0);                                     // same chain for A (B's CK_B0)
  const b1 = await send("B", m("b1", "Příliš žluťoučký kůň úpěl ďábelské ódy 🐎"));
  const b2 = await send("B", { t: "media", call: "call-7", epoch: 1, key: b64(bytes(32, (i) => i + 1)) });
  const b3 = await send("B", m("b3", "x".repeat(700)));     // pads to 1024
  await recv("A", b1);                                     // A: new chain → step
  await recv("A", b3);                                     // skips b2
  await recv("A", b2);                                     // from the skipped keys
  const a2 = await send("A", { t: "file", transferId: "tx-1", key: b64(bytes(32, (i) => 200 - i)) });
  const b4 = await send("B", m("b4", "sent before B read a2"));
  await recv("B", a2);                                     // B steps
  const b5 = await send("B", { t: "future-kind", x: 1 });   // new chain, pn = 4
  await recv("A", b5);                                     // stores b4's key (old chain), steps
  await recv("A", b4);
  const a3 = await send("A", m("a3", "after A's second step"));
  const a4 = await send("A", m("a4", "same chain"));
  await recv("B", a3);
  await recv("B", a4);
  const b6 = await send("B", m("b6", "B steps again"));
  await recv("A", b6);
  const a5 = await send("A", m("a5", "A steps again"));
  await recv("B", a5);
  const b7 = await send("B", m("b7", "last"));
  await recv("A", b7);
  const steps = (by: "A" | "B") => frames.filter((f, i) => frameBy[i] === by && f.h.kct).length;
  if (frames.length < 12 || steps("A") < 3 || steps("B") < 3) throw new Error("script too short");

  return {
    senderKey,
    handshake: { ...handshake, A: { ...handshake.A, tape: A.rng.tape }, B: { ...handshake.B, tape: B.rng.tape } },
    ratchet: {
      about: "Replay: build both sessions from the handshake (each party's tape drives its draws), then run the script in order. A send must produce exactly `wire` (encrypt the UTF-8 of `json`); a recv must open frame #`frame` to `inner`. Frames with h.kct are DH steps that encapsulated to the peer's announced KEM key.",
      kemSteps: { A: steps("A"), B: steps("B") },
      script,
    },
  };
}

async function mailbox(roomId: string) {
  const now = 1_800_000_000_000;
  const sender = await device();
  const recipient = await device();
  const sTape = new RecordingRng();
  const rTape = new RecordingRng();
  const sb = await createBundle(sender.signer, now, sTape);
  const rb = await createBundle(recipient.signer, now, rTape);
  const sealRng = new RecordingRng();
  const payload = { id: "mb-1", kind: "text", text: "for when you are back", createdAt: now };
  // 6.12 review P13: the sender's account attestation (here v2) is bound by the AAD's saccDigest.
  const accountSeed = bytes(32, (i) => 0x90 + i);
  const account = await ed25519FromSeed(accountSeed);
  const cert = await certifyDeviceV2(account.privateKey, sender.pk, now + 30 * 24 * 3600 * 1000, now);
  const sacc = { apk: b64(account.publicKey), ac: cert.sig, cv: 2 as const, exp: cert.exp };
  const item = await sealMailboxItem({ roomId, id: payload.id, payload, recipient: { pk: recipient.pk, bundle: rb.bundle }, senderPk: sender.pk, sacc, now }, sb, sealRng);
  const eph = sealRng.tape[0] as { spki: string };
  return {
    roomId, now,
    about: "Bundle tapes: mailbox.id, mailbox.dh (PKCS#8), mailbox.kem-seed. Seal tape: mailbox.eph (PKCS#8), mailbox.kem-m. Open `item` with the recipient's bundle keys; re-sealing with the sender's bundle keys, `sacc` and the seal tape gives `item` exactly. The AAD ends with saccDigest (as the hello's accDigest; \"-\" without sacc). The Ed25519 `sacc.ac` is deterministic (account seed accountSeed).",
    sender: { devicePkcs8: sender.pkcs8, pk: sender.pk, bundle: sb.bundle, bundleTape: sTape.tape, accountSeed: b64(accountSeed) },
    recipient: { devicePkcs8: recipient.pkcs8, pk: recipient.pk, bundle: rb.bundle, bundleTape: rTape.tape },
    sealTape: sealRng.tape,
    payload, json: JSON.stringify(payload),
    sacc, saccDigest: await accountDigest(sacc),
    aad: text(join(LABEL.mailbox, roomId, payload.id, sender.pk, sb.bundle.id, rb.bundle.id, eph.spki, b64(await H(unb64(item.kct))), await accountDigest(sacc))),
    item,
  };
}

async function filesAndMedia() {
  const fk = bytes(32, (i) => i * 5 + 1);
  const transferId = "tx-42";
  const key = await fileKey4(fk, transferId);
  const metaText = JSON.stringify({ name: "report.pdf", size: 12345, mime: "application/pdf" });
  const ivRng = new RecordingRng();
  const meta = await sealFileBody4(key, fileAad4.meta(transferId), metaText, ivRng);
  const files = {
    fk: b64(fk), transferId, fileKey: b64(await fileKeyBytes(fk, transferId)),
    aad: { meta: text(fileAad4.meta(transferId)), chunk: text(fileAad4.chunk(transferId, 3, 10)), end: text(fileAad4.end(transferId)) },
    meta: { text: metaText, iv: meta.iv, ciphertext: meta.ciphertext },
  };
  const mediaKey = bytes(32, (i) => 99 - i);
  const frame = bytes(40, (i) => i);
  const sealed = await sealFrame(await subtle.importKey("raw", mediaKey, "AES-GCM", false, ["encrypt"]), frame.buffer, 1, frameIv(7, 3));
  const media = {
    ivs: [[0, 0], [1, 2], [7, 3], [4294967295, 4294967295]].map(([epoch, counter]) => ({ epoch, counter, iv: hex(frameIv(epoch, counter)) })),
    frame: { key: b64(mediaKey), epoch: 7, counter: 3, clear: 1, in: b64(frame), out: b64(new Uint8Array(sealed)) },
  };
  return { files, media };
}

async function hub(roomId: string) {
  const roomSecret = bytes(32, (i) => i * 9 + 4);
  // RoomKeys.derive(info) = HKDF(salt "m5cet:v2", room secret, info) (envelope.ts).
  const seed = await hkdf(utf8("m5cet:v2"), roomSecret, LABEL.hubSeed, 32);
  const nonce = b64url(bytes(24, (i) => i * 3 + 1));
  const proof = await buildHubProof(seed, roomId, nonce);
  return [{ roomSecret: b64(roomSecret), seed: b64(seed), pub: (await hubKeyPair(seed)).pub, roomId, nonce, signedData: text(hubJoinData(roomId, nonce)), sig: proof.sig }];
}

async function kt() {
  const seed = bytes(32, (i) => 0x40 + i);
  const { privateKey, publicKey } = await ed25519FromSeed(seed);
  const users = [];
  for (const name of ["alice", "bob", "Žofie"]) users.push({ name, u: await ktUser(name) });
  const [ua, ub, uz] = users.map((x) => x.u);
  const apk = b64(bytes(32, (i) => i + 1));
  const apk2 = b64(bytes(32, (i) => i + 2));
  const dpk = b64(bytes(91, (i) => i * 3));
  const entries: KtEntry[] = [
    { t: "acct", u: ua, apk, ts: 1_800_000_000_001 },
    { t: "acct", u: ub, apk: apk2, ts: 1_800_000_000_002 },
    { t: "dev", u: ua, apk, dpk, exp: 1_807_776_000_000, ts: 1_800_000_000_003 },
    { t: "acct", u: uz, apk, ts: 1_800_000_000_004 },
    { t: "rev", u: ua, apk, dpk, ts: 1_800_000_000_005 },
    { t: "dev", u: ub, apk: apk2, dpk, exp: 1_807_776_000_006, ts: 1_800_000_000_006 },
    { t: "acct", u: ua, apk: apk2, ts: 1_800_000_000_007 },
  ];
  const leaves: Hash[] = [];
  for (const e of entries) leaves.push(await entryLeafHash(e));
  const roots = [];
  for (let size = 0; size <= 7; size++) roots.push(b64(await treeHash(leaves, 0, size)));
  const inclusion = [];
  for (const size of [7, 5]) for (let i = 0; i < size; i++) inclusion.push({ index: i, size, path: (await inclusionProof(leaves, i, size)).map(b64) });
  const consistency = [];
  for (const [from, to] of [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7], [6, 7], [3, 5], [2, 4], [0, 7], [7, 7]]) consistency.push({ from, to, proof: (await consistencyProof(leaves, from, to)).map(b64) });
  const sths = [];
  for (const [size, ts] of [[5, 1_800_000_100_000], [7, 1_800_000_200_000]]) {
    const sth = await signSth(privateKey, size, await treeHash(leaves, 0, size), ts);
    sths.push({ ...sth, signedData: text(sthData(sth.size, sth.root, sth.ts)) });
  }
  return { ktSeed: b64(seed), ktKey: b64(publicKey), userLabel: LABEL.ktUser, users, entries, leaves: entries.map(canonicalEntry), leafHashes: leaves.map(b64), roots, inclusion, consistency, sth: sths };
}

async function release() {
  const seed = bytes(32, (i) => 0x70 ^ i);
  const { privateKey, publicKey } = await ed25519FromSeed(seed);
  const files = { "dist/public/index.html": "<!doctype html>\n", "package.json": "{\"name\":\"m5cet\"}\n" };
  const manifest = {
    format: "m5cet-release/1", name: "m5cet", version: "6.12.0", commit: "0000000", created: "2026-10-05T00:00:00.000Z",
    files: await Promise.all(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)).map(async ([path, body]) => ({ path, size: utf8(body).length, sha256: await sha256Hex(utf8(body)) }))),
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  return { seed: b64(seed), publicKey: b64(publicKey), manifest: manifestText, files, sig: b64(await ed25519Sign(privateKey, utf8(manifestText))) };
}

async function main() {
  const roomId = "r3.Vm9jdG9yUm9vbUlkRm9yUDQ";
  const check = "5a17c0de5a17c0de";
  const { handshake, ratchet, senderKey } = await handshakeAndRatchet(roomId, "team-alpha", check);
  const { files, media } = await filesAndMedia();
  const out = {
    format: "m5cet-p4-vectors/1",
    spec: "docs/protocol-v4.md",
    generator: "script/gen-p4-vectors.ts",
    encoding: "b64 = standard base64 with padding; b64url = URL alphabet without padding; hex lowercase; *Data / aad / text fields are the UTF-8 strings that are hashed, signed or used as associated data.",
    tapes: "A tape lists one party's random draws in order: {what, bytes} (b64) or {what, p256: ecdh|ecdsa, pkcs8, spki}. Replay it in the same order; `what` names the draw.",
    ...(await primitives()),
    mlkem: await mlkem(),
    handshake,
    ratchet,
    senderKey,
    mailbox: await mailbox(roomId),
    files,
    media,
    hubProof: await hub(roomId),
    kt: await kt(),
    replay: await Promise.all([[roomId, "msg-1"], [roomId, "a-much-longer-message-id-0123456789"], ["r3.other", "msg-1"]].map(async ([room, id]) => ({ roomId: room, id, key: await replayKey(room, id) }))),
    release: await release(),
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
  console.log(`wrote ${OUT}`);
}

await main();
