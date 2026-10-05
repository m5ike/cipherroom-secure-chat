import { describe, expect, it } from "vitest";
import {
  aesGcmSeal, b64, concat, ecdsaSign, ecdsaVerify, importP256Pkcs8, kdfCk, keyIv, LABEL, MAX_SKIP, pad, RecordingRng, SENDER_KEY_ROTATE,
  SenderKeys4, senderKeyAad, skCertData, systemRng, unb64, utf8, p4Signer, type SenderKeyEnvelope, type SkInner,
} from "../client/src/lib/p4";
import { ROOM, testDevice, type TestDevice } from "./p4-support";

const msg = (id: string, extra: Record<string, unknown> = {}) => ({ id, kind: "text", text: `body of ${id}`, ...extra });

type Member = { device: TestDevice; keys: SenderKeys4 };

async function member(opts: { rng?: RecordingRng; room?: string } = {}): Promise<Member> {
  const device = await testDevice();
  return { device, keys: new SenderKeys4(opts.room ?? ROOM, device.signer, { rng: opts.rng }) };
}

async function room() {
  const [alice, bob, carol] = await Promise.all([member(), member(), member()]);
  await alice.keys.prepare();
  const inner = alice.keys.chainFor("bob");
  expect(await bob.keys.acceptChain("alice", alice.device.pk, inner)).toBe(true);
  expect(await carol.keys.acceptChain("alice", alice.device.pk, alice.keys.chainFor("carol"))).toBe(true);
  return { alice: alice.keys, bob: bob.keys, carol: carol.keys, inner, devices: { alice: alice.device, bob: bob.device, carol: carol.device } };
}

/** What a member who holds the chain could compute without the chain's signing key. */
async function forge(inner: SkInner, id: string, n: number, payload: unknown, signWith?: CryptoKey): Promise<SenderKeyEnvelope> {
  let ck = unb64(inner.chain);
  let mk = new Uint8Array(0);
  for (let i = inner.index; i <= n; i++) ({ mk, ck } = await kdfCk(ck));
  const aad = senderKeyAad(ROOM, id, inner.keyId, n);
  const { key, iv } = await keyIv(mk, LABEL.senderKey);
  const c = await aesGcmSeal(key, iv, aad, pad(utf8(JSON.stringify(payload))));
  const signer = signWith ?? (await systemRng.p256("ecdsa", "forger")).privateKey;
  return { v: 4, id, sk: inner.keyId, n, c: b64(c), s: await ecdsaSign(signer, concat(aad, c)) };
}

describe("p4 sender keys", () => {
  it("seals and opens room messages, in and out of order", async () => {
    const { alice, bob } = await room();
    const envs = [];
    for (let i = 0; i < 6; i++) envs.push(await alice.seal(`m${i}`, msg(`m${i}`)));
    expect(envs.map((e) => e.n)).toEqual([0, 1, 2, 3, 4, 5]);
    for (const i of [0, 4, 1, 5, 3, 2]) expect(await bob.open("alice", envs[i])).toEqual(msg(`m${i}`));
  });

  it("names the owner's device key in each chain's cert, signed by the chain's own spk", async () => {
    const { inner, devices } = await room();
    expect(await ecdsaVerify(inner.spk, skCertData(ROOM, inner.keyId, devices.alice.pk), inner.cert)).toBe(true);
    expect(new TextDecoder().decode(skCertData(ROOM, inner.keyId, devices.alice.pk))).toBe(`${LABEL.skCert}|${ROOM}|${inner.keyId}|${devices.alice.pk}`);
    expect(unb64(inner.cert).length).toBe(64);
    // The device key signs nothing for the chain (deniability): the cert does not verify with it.
    expect(await ecdsaVerify(devices.alice.pk, skCertData(ROOM, inner.keyId, devices.alice.pk), inner.cert)).toBe(false);
  });

  it("refuses a chain with a missing, forged or foreign-room cert", async () => {
    const alice = await member();
    const bob = await member();
    const mallory = await member();
    await alice.keys.prepare();
    const inner = alice.keys.chainFor("bob");
    const { cert: _cert, ...noCert } = inner;
    expect(await bob.keys.acceptChain("alice", alice.device.pk, noCert)).toBe(false);
    expect(await bob.keys.acceptChain("alice", alice.device.pk, { ...inner, cert: "" })).toBe(false);
    // Signed by any key but the chain's spk — Mallory's device key or a fresh key.
    expect(await bob.keys.acceptChain("alice", alice.device.pk, { ...inner, cert: await mallory.device.signer.sign(skCertData(ROOM, inner.keyId, alice.device.pk)) })).toBe(false);
    const fresh = await systemRng.p256("ecdsa", "x");
    expect(await bob.keys.acceptChain("alice", alice.device.pk, { ...inner, cert: await ecdsaSign(fresh.privateKey, skCertData(ROOM, inner.keyId, alice.device.pk)) })).toBe(false);
    // Alice's cert with another spk or key id.
    expect(await bob.keys.acceptChain("alice", alice.device.pk, { ...inner, spk: fresh.spki })).toBe(false);
    expect(await bob.keys.acceptChain("alice", alice.device.pk, { ...inner, keyId: "AAAAAAAAAAAAAAAA" })).toBe(false);
    // Alice's chain made for another room.
    const elsewhere = new SenderKeys4("r3.another-room", alice.device.signer);
    await elsewhere.prepare();
    expect(await bob.keys.acceptChain("alice", alice.device.pk, elsewhere.chainFor("bob"))).toBe(false);
    // Checked against the delivering session's device key.
    expect(await bob.keys.acceptChain("alice", mallory.device.pk, inner)).toBe(false);
    expect(await bob.keys.acceptChain("alice", alice.device.pk, inner)).toBe(true);
  });

  it("refuses another member's chain re-announced as one's own, whichever arrives first", async () => {
    // Mallory first: her copy of Alice's chain names Alice's device, not Mallory's, and she cannot
    // make Alice's spk name her; Alice's own announcement, arriving later, is accepted.
    {
      const alice = await member();
      const bob = await member();
      const mallory = await member();
      await alice.keys.prepare();
      const inner = alice.keys.chainFor("mallory");
      expect(await bob.keys.acceptChain("mallory", mallory.device.pk, inner)).toBe(false);
      for (const signer of [mallory.device.signer, alice.device.signer]) {
        const reCert = { ...inner, cert: await signer.sign(skCertData(ROOM, inner.keyId, mallory.device.pk)) };
        expect(await bob.keys.acceptChain("mallory", mallory.device.pk, reCert)).toBe(false);
      }
      expect(await bob.keys.acceptChain("alice", alice.device.pk, alice.keys.chainFor("bob"))).toBe(true);
      const env = await alice.keys.seal("m0", msg("m0"));
      await expect(bob.keys.open("mallory", env)).rejects.toMatchObject({ code: "no-chain" });
      expect(await bob.keys.open("alice", env)).toEqual(msg("m0"));
    }
    // Alice first: Mallory's later copy is refused as well.
    {
      const { alice, bob, inner } = await room();
      const mallory = await member();
      expect(await bob.acceptChain("mallory", mallory.device.pk, inner)).toBe(false);
      const env = await alice.seal("m0", msg("m0"));
      await expect(bob.open("mallory", env)).rejects.toMatchObject({ code: "no-chain" });
      expect(await bob.open("alice", env)).toEqual(msg("m0"));
    }
  });

  it("refuses a message forged by a member who holds the chain — before moving the chain", async () => {
    const { alice, bob, inner } = await room();
    // Bob holds Alice's chain: he can derive her keys, but not sign as her chain.
    const forged = await forge(inner, "f1", 0, msg("f1"));
    await expect(bob.open("alice", forged)).rejects.toMatchObject({ code: "signature" });
    // A forged high index does not burn keys either.
    const burn = await forge(inner, "f2", 900, msg("f2"));
    await expect(bob.open("alice", burn)).rejects.toMatchObject({ code: "signature" });
    // Alice's genuine first message still opens.
    expect(await bob.open("alice", await alice.seal("m0", msg("m0")))).toEqual(msg("m0"));
  });

  it("verifies the signature over the AAD and the ciphertext", async () => {
    const { alice, bob } = await room();
    const env = await alice.seal("m0", msg("m0"));
    const flipC = unb64(env.c); flipC[0] ^= 1;
    const flipS = unb64(env.s); flipS[5] ^= 1;
    for (const bad of [{ ...env, id: "m1" }, { ...env, n: 1 }, { ...env, c: b64(flipC) }, { ...env, s: b64(flipS) }]) {
      await expect(bob.open("alice", bad)).rejects.toMatchObject({ code: "signature" });
    }
    await expect(bob.open("alice", { ...env, sk: "AAAAAAAAAAAAAAAA" })).rejects.toMatchObject({ code: "no-chain" });
    await expect(bob.open("alice", { ...env, v: 3 })).rejects.toMatchObject({ code: "malformed" });
    expect(await bob.open("alice", env)).toEqual(msg("m0"));
    await expect(bob.open("alice", env)).rejects.toMatchObject({ code: "replay" });
  });

  it("moves the chain only when the message decrypts (a valid signature over garbage changes nothing)", async () => {
    const rng = new RecordingRng();
    const alice = await member({ rng });
    const bob = await member();
    await alice.keys.prepare();
    const inner = alice.keys.chainFor("bob");
    await bob.keys.acceptChain("alice", alice.device.pk, inner);
    const spk = rng.tape.find((t) => t.what === "sk.spk")!;
    const signKey = (await importP256Pkcs8((spk as { pkcs8: string }).pkcs8, "ecdsa")).privateKey;
    const aad = senderKeyAad(ROOM, "g", inner.keyId, 3);
    const c = new Uint8Array(64);
    const garbage: SenderKeyEnvelope = { v: 4, id: "g", sk: inner.keyId, n: 3, c: b64(c), s: await ecdsaSign(signKey, concat(aad, c)) };
    await expect(bob.keys.open("alice", garbage)).rejects.toMatchObject({ code: "aead" });
    expect(await bob.keys.open("alice", await alice.keys.seal("m0", msg("m0")))).toEqual(msg("m0"));
  });

  it("keeps a peer's chain under (peer, keyId): a chain of Mallory's own under Alice's key id changes nothing", async () => {
    const { alice, bob, inner, devices } = await room();
    const rng = new RecordingRng();
    const mallory = await member({ rng });
    await mallory.keys.prepare();
    const own = mallory.keys.chainFor("bob");
    const spk = (await importP256Pkcs8((rng.tape.find((t) => t.what === "sk.spk") as { pkcs8: string }).pkcs8, "ecdsa")).privateKey;
    // Her own spk, Alice's key id, a valid cert naming Mallory: kept apart, under (mallory, keyId).
    const sameId = { ...own, keyId: inner.keyId, cert: await ecdsaSign(spk, skCertData(ROOM, inner.keyId, mallory.device.pk)) };
    expect(await bob.acceptChain("mallory", mallory.device.pk, sameId)).toBe(true);
    const env = await alice.seal("m0", msg("m0"));
    await expect(bob.open("mallory", env)).rejects.toMatchObject({ code: "signature" }); // relayed as hers: refused
    expect(await bob.open("alice", env)).toEqual(msg("m0"));
    // The same device under a new peer id (a reconnect) may re-announce its chain.
    expect(await bob.acceptChain("alice-again", devices.alice.pk, inner)).toBe(true);
  });

  it("skips at most MAX_SKIP message keys", async () => {
    const { alice, bob } = await room();
    const envs: SenderKeyEnvelope[] = [];
    for (let i = 0; i <= MAX_SKIP + 1; i++) envs.push(await alice.seal(`m${i}`, msg(`m${i}`)));
    await expect(bob.open("alice", envs[MAX_SKIP + 1])).rejects.toMatchObject({ code: "skip" });
    expect(await bob.open("alice", envs[MAX_SKIP])).toEqual(msg(`m${MAX_SKIP}`));
    expect(await bob.open("alice", envs[7])).toEqual(msg("m7"));
  });

  it("rotates after SENDER_KEY_ROTATE messages or time, when a member leaves, and on re-hello", async () => {
    const t0 = 1_000_000;
    const alice = (await member()).keys;
    expect(alice.due(t0)).toBe(true);
    expect(await alice.prepare(t0)).toBe(true);
    const first = alice.currentKeyId;
    alice.chainFor("bob");
    for (let i = 0; i < SENDER_KEY_ROTATE.messages - 1; i++) await alice.seal(`m${i}`, msg(`m${i}`));
    expect(await alice.prepare(t0)).toBe(false);
    await alice.seal("last", msg("last"));
    expect(await alice.prepare(t0)).toBe(true);
    expect(alice.currentKeyId).not.toBe(first);
    expect(alice.hasOurChain("bob")).toBe(false);
    expect(await alice.prepare(t0 + SENDER_KEY_ROTATE.ms - 1)).toBe(false);
    expect(await alice.prepare(t0 + SENDER_KEY_ROTATE.ms)).toBe(true);
    // Re-hello: only when that peer held the chain.
    alice.chainFor("bob");
    const k = alice.currentKeyId;
    alice.rehello("carol");
    expect(alice.currentKeyId).toBe(k);
    alice.rehello("bob");
    expect(alice.currentKeyId).toBeNull();
    // A member left.
    await alice.prepare();
    alice.peerLeft("dave");
    expect(alice.currentKeyId).toBeNull();
    await expect(alice.seal("x", msg("x"))).rejects.toMatchObject({ code: "state" });
  });

  it("keeps a peer's newest chain and one older (in-flight messages), forgets the rest", async () => {
    const alice = await member();
    const bob = (await member()).keys;
    const sent: SenderKeyEnvelope[] = [];
    for (let round = 0; round < 3; round++) {
      alice.keys.rotate();
      await alice.keys.prepare();
      await bob.acceptChain("alice", alice.device.pk, alice.keys.chainFor("bob"));
      sent.push(await alice.keys.seal(`r${round}`, msg(`r${round}`)));
    }
    await expect(bob.open("alice", sent[0])).rejects.toMatchObject({ code: "no-chain" });
    expect(await bob.open("alice", sent[1])).toEqual(msg("r1"));
    expect(await bob.open("alice", sent[2])).toEqual(msg("r2"));
    bob.peerLeft("alice");
    await expect(bob.open("alice", sent[2])).rejects.toMatchObject({ code: "no-chain" });
  });

  it("hands out the chain from its current index only", async () => {
    const alice = await member();
    await alice.keys.prepare();
    const early = await alice.keys.seal("m0", msg("m0"));
    const late = (await member()).keys;
    const inner = alice.keys.chainFor("late");
    expect(inner.index).toBe(1);
    await late.acceptChain("alice", alice.device.pk, inner);
    await expect(late.open("alice", early)).rejects.toMatchObject({ code: "replay" });
    expect(await late.open("alice", await alice.keys.seal("m1", msg("m1")))).toEqual(msg("m1"));
  });

  it("checks the payload id and the chain message", async () => {
    const { alice, bob, devices } = await room();
    await expect(alice.seal("a", msg("b"))).rejects.toMatchObject({ code: "id-mismatch" });
    const spk = (await systemRng.p256("ecdsa", "x")).spki;
    const pk = devices.carol.pk;
    expect(await bob.acceptChain("x", pk, { t: "sk", keyId: "short", chain: b64(new Uint8Array(32)), index: 0, spk: "AAAA", cert: "" })).toBe(false);
    expect(await bob.acceptChain("x", pk, { t: "sk", keyId: "AAAAAAAAAAAAAAAA", chain: b64(new Uint8Array(31)), index: 0, spk, cert: "" })).toBe(false);
    expect(await bob.acceptChain("x", pk, { t: "sk", keyId: "AAAAAAAAAAAAAAAA", chain: b64(new Uint8Array(32)), index: -1, spk, cert: "" })).toBe(false);
  });

  it("names the hello's device key as the signer", () => {
    expect(p4Signer("PK")).toEqual({ publicKey: "PK", valid: true });
    expect(p4Signer("PK", { publicKey: "APK", valid: false })).toEqual({ publicKey: "PK", valid: true, account: { publicKey: "APK", valid: false } });
  });
});
