// Re-checks test/vectors/p4.json (script/gen-p4-vectors.ts) against the
// reference implementation, so the vectors the Android port consumes can
// never drift from what the web client does. It replays every party's tape
// the way a port must.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  accDigest, accountDigest, capsDigest, userDigest, sthDigest, b64, buildHello, buildHubProof, buildKemMessage, canonicalEntry, checkBundle, checkReleaseFiles, consistencyProof,
  createBundle, ecdh, ecdsaSign, ecdsaVerify, ed25519FromSeed, ed25519Sign, entryLeafHash, establishSession, fileAad4, fileKey4,
  fileKeyBytes, frameIv, H, hex, helloRef, helloSig4Data, hkdf, hubJoinData, hubKeyPair, importP256Pkcs8, inclusionProof, joinText,
  kdfCk, kdfRk, kemDecaps, kemEncapsWith, kemKeygenFromSeed, kemKid, keyIv, ktUser, LABEL, leafHash, mbDigest, openFileBody4,
  openKemMessage, openMailboxItem, pad, pairAad, parseReleaseManifest, RecordingRng, replayKey, rootSchedule, sealFileBody4,
  sealMailboxItem, SenderKeys4, senderKeyAad, skCertData, sha256Hex, signSth, sthData, TapeRng, treeHash, unb64, unpad, utf8, verifyAccount,
  verifyConsistency, verifyHello, verifyHubProof, verifyInclusion, verifyReleaseSignature, verifySth,
  type DeviceSigner, type HelloV4, type KtEntry, type MailboxBundle, type MailboxItem, type Ratchet, type RatchetFrame,
  type RatchetInner, type TapeEntry, type Hash, type SkInner, type SenderKeyEnvelope, type KemMessage,
} from "../client/src/lib/p4";
import { openFrame, sealFrame } from "../client/src/lib/media-frames";
import { deriveRoomKeys } from "../client/src/lib/envelope";
import { runKdfInline } from "../client/src/lib/kdf";

// The vectors are plain JSON; the test reads them loosely and checks every field it uses.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- (no linter in this repo; kept for editors)
const V: any =JSON.parse(readFileSync(resolve(__dirname, "vectors/p4.json"), "utf8"));
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const bytes = (n: number, f: (i: number) => number) => new Uint8Array(n).map((_, i) => f(i) & 0xff);

async function signerOf(pkcs8: string, pk: string): Promise<DeviceSigner> {
  const pair = await importP256Pkcs8(pkcs8, "ecdsa");
  expect(pair.spki).toBe(pk);
  return { publicKey: pk, sign: (data) => ecdsaSign(pair.privateKey, data) };
}

describe("p4 vectors: primitives", () => {
  it("join, pad, unpad", async () => {
    expect(V.format).toBe("m5cet-p4-vectors/1");
    for (const j of V.join) expect(joinText(...j.parts)).toBe(j.text);
    for (const c of V.pad) {
      const p = pad(bytes(c.len, (i) => i % 251));
      expect(p.length).toBe(c.paddedLength);
      expect(await sha256Hex(p)).toBe(c.sha256);
      if (c.in !== undefined) { expect(b64(bytes(c.len, (i) => i % 251))).toBe(c.in); expect(b64(p)).toBe(c.out); }
    }
    for (const c of V.unpad) {
      if (c.ok) expect(b64(unpad(unb64(c.in)))).toBe(c.out);
      else expect(() => unpad(unb64(c.in))).toThrow();
    }
  });

  it("HKDF, KDF_RK, KDF_CK, keyIv", async () => {
    for (const c of V.hkdf) expect(b64(await hkdf(unb64(c.salt), unb64(c.ikm), c.info, c.length))).toBe(c.okm);
    for (const c of V.kdfRk) {
      const r = await kdfRk(unb64(c.rk), unb64(c.dh), c.kss ? unb64(c.kss) : null);
      expect([b64(r.rk), b64(r.ck)]).toEqual([c.rkOut, c.ck]);
    }
    for (const c of V.kdfCk) {
      const r = await kdfCk(unb64(c.ck));
      expect([b64(r.mk), b64(r.ck)]).toEqual([c.mk, c.next]);
    }
    for (const c of V.keyIv) {
      const r = await keyIv(unb64(c.mk), c.label);
      expect([b64(r.key), b64(r.iv)]).toEqual([c.key, c.iv]);
    }
  });

  it("ML-KEM-768 keygen from seed, encapsulation with m, decapsulation", async () => {
    for (const c of V.mlkem) {
      const { ek, dk } = kemKeygenFromSeed(unb64(c.seed));
      expect(b64(ek)).toBe(c.ek);
      expect(b64(dk)).toBe(c.dk);
      expect(await kemKid(ek)).toBe(c.kid);
      const { ct, ss } = kemEncapsWith(ek, unb64(c.m));
      expect([b64(ct), b64(ss)]).toEqual([c.ct, c.ss]);
      expect(b64(kemDecaps(unb64(c.ct), dk))).toBe(c.ss);
    }
  });
});

describe("p4 vectors: handshake and ratchet transcript", () => {
  it("rebuilds both hellos, KEM messages and the key schedule, then replays the whole script", async () => {
    const hs = V.handshake;
    const { roomId, check, now } = hs;
    const rng = { A: new TapeRng(hs.A.tape as TapeEntry[]), B: new TapeRng(hs.B.tape as TapeEntry[]) };
    const party = { A: hs.A, B: hs.B };
    const other = { A: "B", B: "A" } as const;
    const built: Record<"A" | "B", Awaited<ReturnType<typeof buildHello>>> = {} as never;
    for (const side of ["A", "B"] as const) {
      const p = party[side];
      const q = party[other[side]];
      const hello = p.hello as HelloV4;
      // The protocol-3 signature (over the readable room name) and sig4 verify.
      expect(await ecdsaVerify(p.pk, utf8(["m5cet/hello/1", hs.roomName, p.peerId, q.peerId, check, p.dh].join("|")), hello.sig)).toBe(true);
      expect(text(await helloSig4Data(roomId, p.peerId, q.peerId, hello))).toBe(p.sig4Data);
      expect(await verifyHello(hello, { roomId, from: p.peerId, to: q.peerId, check, now })).toMatchObject({ ok: true, mailbox: hello.mb });
      expect(await mbDigest(hello.mb)).toBe(p.mbDigest);
      expect(await accDigest(hello.acc)).toBe(p.accDigest);
      // 6.12 review P02: caps, the user claim and the tree head are signed.
      expect(await capsDigest(hello.caps)).toBe(p.capsDigest);
      expect(await userDigest(hello.user)).toBe(p.userDigest);
      expect(await sthDigest(hello.sth)).toBe(p.sthDigest);
      expect(p.sig4Data.endsWith(`|${p.capsDigest}|${p.userDigest}|${p.sthDigest}`)).toBe(true);
      expect(await helloRef(hello)).toBe(p.helloRef);
      // Replaying the tape gives the same hello (but the randomized sig4).
      built[side] = await buildHello({
        roomId, from: p.peerId, to: q.peerId, v3: { check, pk: p.pk, dh: p.dh, sig: hello.sig, caps: hello.caps, ...(typeof hello.user === "string" ? { user: hello.user } : {}) },
        signer: await signerOf(p.devicePkcs8, p.pk), mb: hello.mb, acc: hello.acc, sth: hello.sth, rng: rng[side],
      });
      expect({ ...built[side].hello, sig4: "" }).toEqual({ ...hello, sig4: "" });
      // A changed cap, user or tree head no longer verifies.
      expect((await verifyHello({ ...hello, caps: hello.caps.filter((c) => c !== "media") }, { roomId, from: p.peerId, to: q.peerId, check, now })).ok).toBe(false);
      expect((await verifyHello({ ...hello, user: "mallory" }, { roomId, from: p.peerId, to: q.peerId, check, now })).ok).toBe(false);
      expect((await verifyHello({ ...hello, sth: hello.sth ? null : hs.A.hello.sth }, { roomId, from: p.peerId, to: q.peerId, check, now })).ok).toBe(false);
    }
    // The capsDigest sorts and de-duplicates; the tree head A gossips is signed by the KT key of the kt section.
    expect(await capsDigest(["p4", "media", "bin", "media"])).toBe(await capsDigest(["bin", "media", "p4"]));
    expect(await verifySth(hs.A.hello.sth, V.kt.ktKey)).toBe(true);
    // A's mailbox bundle and B's account certificate.
    const mbHello = hs.A.hello.mb as MailboxBundle;
    const mbRebuilt = await createBundle(await signerOf(hs.A.devicePkcs8, hs.A.pk), now, new TapeRng(hs.A.mailboxBundleTape));
    expect({ ...mbRebuilt.bundle, sig: "" }).toEqual({ ...mbHello, sig: "" });
    expect(await checkBundle(mbHello, hs.A.pk, now)).toBeNull();
    const acc = hs.B.hello.acc;
    expect(b64((await ed25519FromSeed(unb64(hs.B.accountSeed))).publicKey)).toBe(acc.apk);
    expect(joinText(LABEL.deviceCert, hs.B.pk, acc.exp)).toBe(hs.B.certSignedData);
    expect(await verifyAccount(acc, hs.B.pk, now)).toMatchObject({ valid: true, v: 2 });

    // KEM messages: A's (to B's k) first in A's tape after its hello.
    const toB = await buildKemMessage(hs.B.hello, rng.A);
    const toA = await buildKemMessage(hs.A.hello, rng.B);
    expect(toB.message).toEqual(hs.kemAtoB.message);
    expect(toA.message).toEqual(hs.kemBtoA.message);
    expect([b64(toB.ss), b64(toA.ss)]).toEqual([hs.kemAtoB.ss, hs.kemBtoA.ss]);
    const atA = (await openKemMessage(hs.kemBtoA.message as KemMessage, built.A))!;
    const atB = (await openKemMessage(hs.kemAtoB.message as KemMessage, built.B))!;
    expect([b64(atA.ss), b64(atB.ss)]).toEqual([hs.kemBtoA.ss, hs.kemAtoB.ss]);

    // § 4: dh0, TH, RK0, CK_B0, SID.
    const dh0 = await ecdh(built.A.secrets.e.privateKey, hs.B.hello.e);
    expect(b64(dh0)).toBe(hs.dh0);
    expect(b64(await ecdh(built.B.secrets.e.privateKey, hs.A.hello.e))).toBe(hs.dh0);
    const sa = await establishSession({ roomId, check, self: { peerId: hs.A.peerId, hello: built.A.hello, secrets: built.A.secrets }, peer: { peerId: hs.B.peerId, hello: hs.B.hello }, sent: toB, received: atA, rng: rng.A });
    const sb = await establishSession({ roomId, check, self: { peerId: hs.B.peerId, hello: built.B.hello, secrets: built.B.secrets }, peer: { peerId: hs.A.peerId, hello: hs.A.hello }, sent: toA, received: atB, rng: rng.B });
    expect([sa.role, sb.role]).toEqual(["A", "B"]);
    expect([b64(sa.th), b64(sb.th)]).toEqual([hs.TH, hs.TH]);
    expect([b64(sa.sid), b64(sb.sid)]).toEqual([hs.SID, hs.SID]);
    const root = await rootSchedule(unb64(hs.TH), dh0, unb64(hs.kemAtoB.ss), unb64(hs.kemBtoA.ss));
    expect([b64(root.rk0), b64(root.ckB0), b64(root.sid)]).toEqual([hs.RK0, hs.CK_B0, hs.SID]);

    // The script: every send byte for byte, every receive to its inner message.
    const r: Record<"A" | "B", Ratchet> = { A: sa.ratchet, B: sb.ratchet };
    const peerIds = { A: hs.A.peerId, B: hs.B.peerId };
    const wires: RatchetFrame[] = [];
    let kct = 0;
    for (const step of V.ratchet.script) {
      if (step.op === "send") {
        expect(JSON.stringify(step.inner)).toBe(step.json);
        const frame = await r[step.by as "A" | "B"].encrypt(step.inner as RatchetInner);
        expect(frame).toEqual(step.wire);
        expect(text(await pairAad(roomId, peerIds[step.by as "A" | "B"], peerIds[other[step.by as "A" | "B"]], unb64(hs.TH), frame.h))).toBe(step.aad);
        wires[step.frame] = step.wire;
        if (frame.h.kct) kct++;
      } else {
        const res = await r[step.by as "A" | "B"].decrypt(wires[step.frame]);
        expect(res.ok && res.inner).toEqual(step.inner);
      }
    }
    expect(wires.length).toBeGreaterThanOrEqual(12);
    expect(kct).toBe(V.ratchet.kemSteps.A + V.ratchet.kemSteps.B);
    expect(V.ratchet.kemSteps.A).toBeGreaterThanOrEqual(3);
    expect(V.ratchet.kemSteps.B).toBeGreaterThanOrEqual(3);
    expect([rng.A.remaining, rng.B.remaining]).toEqual([0, 0]);
  });
});

describe("p4 vectors: sender keys, mailbox, files, media", () => {
  it("sender-key chain (with its cert) and messages", async () => {
    const S = V.senderKey;
    expect([S.owner, S.ownerPk, S.ownerDevicePkcs8]).toEqual([V.handshake.A.peerId, V.handshake.A.pk, V.handshake.A.devicePkcs8]);
    const alice = new SenderKeys4(S.roomId, { publicKey: S.ownerPk }, { rng: new TapeRng(S.tape) });
    await alice.prepare(1_800_000_000_000);
    const chain = alice.chainFor(V.handshake.B.peerId);
    expect({ ...chain, cert: "" }).toEqual({ ...S.chain, cert: "" }); // the cert is ECDSA: randomized
    expect(text(skCertData(S.roomId, S.chain.keyId, S.ownerPk))).toBe(S.certSignedData);
    expect(await ecdsaVerify(S.chain.spk, utf8(S.certSignedData), S.chain.cert)).toBe(true);
    expect(await ecdsaVerify(S.chain.spk, utf8(S.certSignedData), chain.cert)).toBe(true);
    for (const m of S.messages) {
      expect(JSON.stringify(m.payload)).toBe(m.json);
      const env = await alice.seal(m.payload.id, m.payload);
      expect({ ...env, s: "" }).toEqual({ ...m.envelope, s: "" });
      expect(text(senderKeyAad(S.roomId, m.payload.id, env.sk, env.n))).toBe(m.aad);
    }
    const bob = new SenderKeys4(S.roomId, { publicKey: V.handshake.B.pk });
    expect(await bob.acceptChain(S.owner, V.handshake.B.pk, S.chain as SkInner)).toBe(false); // names A's device, not B's
    expect(await bob.acceptChain(S.owner, S.ownerPk, S.chain as SkInner)).toBe(true);
    for (const i of [3, 0, 2, 1]) expect(await bob.open(S.owner, S.messages[i].envelope as SenderKeyEnvelope)).toEqual(S.messages[i].payload);
    // The chain A hands to B in the ratchet script is this one.
    const sent = V.ratchet.script.find((s: { op: string; inner: { t: string } }) => s.op === "send" && s.inner.t === "sk");
    expect(sent.by).toBe("A");
    expect(sent.inner).toEqual(S.chain);
  });

  it("mailbox item: opens with the recipient's bundle keys and re-seals identically", async () => {
    const M = V.mailbox;
    const keysOf = async (side: { devicePkcs8: string; pk: string; bundle: MailboxBundle; bundleTape: TapeEntry[] }) => {
      const rebuilt = await createBundle(await signerOf(side.devicePkcs8, side.pk), M.now, new TapeRng(side.bundleTape));
      expect({ ...rebuilt.bundle, sig: "" }).toEqual({ ...side.bundle, sig: "" });
      expect(await checkBundle(side.bundle, side.pk, M.now)).toBeNull();
      return { ...rebuilt, bundle: side.bundle };
    };
    const rKeys = await keysOf(M.recipient);
    const sKeys = await keysOf(M.sender);
    const item = M.item as MailboxItem;
    const opened = await openMailboxItem(item, M.roomId, rKeys);
    expect(opened.payload).toEqual(M.payload);
    expect(opened.spk).toBe(M.sender.pk);
    // 6.12 review P13: the AAD ends with saccDigest; the attestation is a v2 certificate by the account seed.
    expect(await accountDigest(item.sacc)).toBe(M.saccDigest);
    expect(item.sacc).toEqual(M.sacc);
    expect(b64((await ed25519FromSeed(unb64(M.sender.accountSeed))).publicKey)).toBe(M.sacc.apk);
    expect(await verifyAccount(M.sacc, M.sender.pk, M.now)).toMatchObject({ valid: true, v: 2 });
    expect(opened.sacc).toEqual(M.sacc);
    expect(text(utf8(joinText(LABEL.mailbox, M.roomId, item.id, item.spk, item.sb.id, item.to, item.e, b64(await H(unb64(item.kct))), M.saccDigest)))).toBe(M.aad);
    const again = await sealMailboxItem({ roomId: M.roomId, id: M.payload.id, payload: M.payload, recipient: { pk: M.recipient.pk, bundle: M.recipient.bundle }, senderPk: M.sender.pk, sacc: M.sacc, now: M.now }, sKeys, new TapeRng(M.sealTape));
    expect(again).toEqual(item);
    // A relay that strips or swaps the attestation breaks the item.
    const { sacc: _stripped, ...withoutSacc } = item;
    await expect(openMailboxItem(withoutSacc as MailboxItem, M.roomId, rKeys)).rejects.toMatchObject({ code: "aead" });
    await expect(openMailboxItem({ ...item, sacc: { apk: M.sacc.apk, ac: M.sacc.ac } } as MailboxItem, M.roomId, rKeys)).rejects.toMatchObject({ code: "aead" });
  });

  it("file key, AADs and a meta body; media IVs and a sealed frame", async () => {
    const F = V.files;
    expect(b64(await fileKeyBytes(unb64(F.fk), F.transferId))).toBe(F.fileKey);
    expect([text(fileAad4.meta(F.transferId)), text(fileAad4.chunk(F.transferId, 3, 10)), text(fileAad4.end(F.transferId))]).toEqual([F.aad.meta, F.aad.chunk, F.aad.end]);
    const key = await fileKey4(F.fk, F.transferId);
    expect(await openFileBody4(key, fileAad4.meta(F.transferId), F.meta.iv, F.meta.ciphertext)).toBe(F.meta.text);
    const resealed = await sealFileBody4(key, fileAad4.meta(F.transferId), F.meta.text, new TapeRng([{ what: "file.iv", bytes: F.meta.iv }]));
    expect(resealed).toEqual({ iv: F.meta.iv, ciphertext: F.meta.ciphertext });
    for (const c of V.media.ivs) expect(hex(frameIv(c.epoch, c.counter))).toBe(c.iv);
    const f = V.media.frame;
    const mk = await crypto.subtle.importKey("raw", unb64(f.key), "AES-GCM", false, ["encrypt", "decrypt"]);
    expect(b64(new Uint8Array(await sealFrame(mk, unb64(f.in).buffer, f.clear, frameIv(f.epoch, f.counter))))).toBe(f.out);
    expect(b64(new Uint8Array((await openFrame(mk, unb64(f.out).buffer))!))).toBe(f.in);
  });
});

describe("p4 vectors: hub proof, key transparency, replay, release", () => {
  it("hub proof from the room secret", async () => {
    for (const c of V.hubProof) {
      expect(b64(await hkdf(utf8("m5cet:v2"), unb64(c.roomSecret), LABEL.hubSeed, 32))).toBe(c.seed);
      expect((await hubKeyPair(unb64(c.seed))).pub).toBe(c.pub);
      expect(text(hubJoinData(c.roomId, c.nonce))).toBe(c.signedData);
      expect((await buildHubProof(unb64(c.seed), c.roomId, c.nonce)).sig).toBe(c.sig);
      expect(await verifyHubProof(c.pub, c.sig, c.roomId, c.nonce)).toBe(true);
    }
    // RoomKeys.derive is that HKDF (salt "m5cet:v2") over the room secret.
    const secret = await runKdfInline({ kdf: "pbkdf2", password: "pass", salt: "m5cet:room:v2:team", iterations: 1000 });
    const keys = await deriveRoomKeys("team", "pass", { iterations: 1000 });
    expect(b64(await hkdf(utf8("m5cet:v2"), secret, LABEL.hubSeed, 32))).toBe(b64(await keys.derive(LABEL.hubSeed, 256)));
  });

  it("key-transparency entries, tree, proofs and signed tree heads", async () => {
    const K = V.kt;
    for (const u of K.users) expect(await ktUser(u.name)).toBe(u.u);
    const leaves: Hash[] = [];
    K.entries.forEach((e: KtEntry, i: number) => expect(canonicalEntry(e)).toBe(K.leaves[i]));
    for (const [i, e] of (K.entries as KtEntry[]).entries()) {
      const h = await entryLeafHash(e);
      expect(b64(h)).toBe(K.leafHashes[i]);
      expect(b64(await leafHash(K.leaves[i]))).toBe(K.leafHashes[i]);
      leaves.push(h);
    }
    for (let size = 0; size < K.roots.length; size++) expect(b64(await treeHash(leaves, 0, size))).toBe(K.roots[size]);
    for (const c of K.inclusion) {
      expect((await inclusionProof(leaves, c.index, c.size)).map(b64)).toEqual(c.path);
      expect(await verifyInclusion(leaves[c.index], c.index, c.size, c.path.map((p: string) => unb64(p)), unb64(K.roots[c.size]))).toBe(true);
    }
    for (const c of K.consistency) {
      expect((await consistencyProof(leaves, c.from, c.to)).map(b64)).toEqual(c.proof);
      expect(await verifyConsistency(c.from, c.to, unb64(K.roots[c.from]), unb64(K.roots[c.to]), c.proof.map((p: string) => unb64(p)))).toBe(true);
    }
    const { privateKey, publicKey } = await ed25519FromSeed(unb64(K.ktSeed));
    expect(b64(publicKey)).toBe(K.ktKey);
    for (const s of K.sth) {
      expect(text(sthData(s.size, s.root, s.ts))).toBe(s.signedData);
      const signed = await signSth(privateKey, s.size, unb64(s.root), s.ts);
      expect(signed.sig).toBe(s.sig);
      expect(await verifySth({ size: s.size, root: s.root, ts: s.ts, sig: s.sig }, K.ktKey)).toBe(true);
    }
  });

  it("replay keys and a signed release manifest", async () => {
    for (const c of V.replay) expect(await replayKey(c.roomId, c.id)).toBe(c.key);
    const R = V.release;
    const m = parseReleaseManifest(R.manifest);
    const { privateKey, publicKey } = await ed25519FromSeed(unb64(R.seed));
    expect(b64(publicKey)).toBe(R.publicKey);
    expect(b64(await ed25519Sign(privateKey, utf8(R.manifest)))).toBe(R.sig);
    expect(await verifyReleaseSignature(R.manifest, R.sig, R.publicKey)).toBe(true);
    expect(await checkReleaseFiles(m, async (p) => (p in R.files ? utf8(R.files[p]) : null))).toEqual({ ok: true, missing: [], changed: [] });
  });
});

// Keep the recorder in the public API exercised (the generator uses it).
it("records draws the way the vectors list them", async () => {
  const rec = new RecordingRng();
  rec.bytes(4, "x");
  await rec.p256("ecdsa", "y");
  expect(rec.tape.map((t) => t.what)).toEqual(["x", "y"]);
});
