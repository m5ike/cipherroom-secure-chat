import { describe, expect, it } from "vitest";
import {
  b64, buildHello, buildKemMessage, establishSession, hB64, kemKeygen, LABEL, MAX_SKIP, openKemMessage, Ratchet, roleOf,
  systemRng, unb64, verifyHello, type RatchetFrame, type RatchetInner, createBundle, MAILBOX_LIFETIME_MS, ecdsaVerify, helloSig4Data, PairHandshake,
  capsDigest, userDigest, sthDigest, ed25519FromSeed, signSth,
} from "../client/src/lib/p4";
import { CHECK, clone, pair, ROOM, testDevice } from "./p4-support";

const text = (from: string, i: number): RatchetInner => ({ t: "msg", id: `${from}-${i}`, p: { id: `${from}-${i}`, text: `message ${i} from ${from} ${"x".repeat(i % 7)}` } });

async function session() {
  const [da, db] = await Promise.all([testDevice(), testDevice()]);
  const { sa, sb } = await pair({ device: da, peerId: "peer-a" }, { device: db, peerId: "peer-b" });
  return { a: sa.ratchet, b: sb.ratchet, sa, sb, da, db };
}

/** `a` is role A, `b` role B (roles follow the device keys, § 4). */
async function oriented() {
  const s = await session();
  return s.sa.role === "A" ? s : { ...s, a: s.b, b: s.a };
}

async function open(r: Ratchet, frame: unknown) {
  const res = await r.decrypt(frame);
  if (!res.ok) throw new Error(`decrypt failed: ${res.error} ${res.message}`);
  return res.inner;
}

/** A tiny deterministic PRNG for interleavings. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

describe("p4 handshake", () => {
  it("gives both sides complementary roles and the same TH and SID", async () => {
    const { sa, sb, da, db } = await session();
    expect(new Set([sa.role, sb.role])).toEqual(new Set(["A", "B"]));
    expect(sa.role).toBe(roleOf({ pk: da.pk, peerId: "peer-a" }, { pk: db.pk, peerId: "peer-b" }));
    expect(b64(sa.th)).toBe(b64(sb.th));
    expect(b64(sa.sid)).toBe(b64(sb.sid));
    expect(sa.sid.length).toBe(32);
  });

  it("verifies a hello and binds it to the room, both peer ids and the key check", async () => {
    const d = await testDevice();
    const { hello } = await buildHello({ roomId: ROOM, from: "p1", to: "p2", v3: { check: CHECK, pk: d.pk, dh: d.dh, sig: "c2ln" }, signer: d.signer, mb: null, acc: null, sth: null });
    expect(hello.caps).toContain("p4");
    expect(hello.v).toBe(4);
    const ctx = { roomId: ROOM, from: "p1", to: "p2", check: CHECK };
    expect((await verifyHello(hello, ctx)).ok).toBe(true);
    expect(await verifyHello(hello, { ...ctx, check: "ffffffffffffffff" })).toEqual({ ok: false, why: "key-mismatch" });
    expect(await verifyHello(hello, { ...ctx, from: "p3" })).toEqual({ ok: false, why: "bad-sig4" });
    expect(await verifyHello(hello, { ...ctx, to: "p3" })).toEqual({ ok: false, why: "bad-sig4" });
    expect(await verifyHello(hello, { ...ctx, roomId: "r3.other" })).toEqual({ ok: false, why: "bad-sig4" });
    expect(await verifyHello({ ...hello, v: 3 }, ctx)).toEqual({ ok: false, why: "not-v4" });
    // Every v4 field is covered by sig4.
    const other = await testDevice();
    const otherE = (await systemRng.p256("ecdh", "x")).spki;
    const otherK = b64(kemKeygen().ek);
    for (const forged of [
      { ...hello, e: otherE }, { ...hello, k: otherK }, { ...hello, n: b64(new Uint8Array(16)) }, { ...hello, dh: other.dh },
      { ...hello, acc: { apk: b64(new Uint8Array(32)), ac: b64(new Uint8Array(64)) } },
    ]) {
      expect((await verifyHello(forged, ctx)).ok).toBe(false);
    }
    // Malformed v4 fields: treated like a bad sig4 (protocol 3 + downgrade rule).
    expect(await verifyHello({ ...hello, k: b64(new Uint8Array(10)) }, ctx)).toEqual({ ok: false, why: "malformed" });
    expect(await verifyHello({ ...hello, mb: undefined }, ctx)).toEqual({ ok: false, why: "malformed" });
  });

  it("checks the hello's mailbox bundle: an expired or foreign-signed one is dropped, the hello stands", async () => {
    const d = await testDevice();
    const now = Date.now();
    const v3 = { check: CHECK, pk: d.pk, dh: d.dh, sig: "c2ln" };
    const ctx = { roomId: ROOM, from: "p1", to: "p2", check: CHECK, now };
    const own = await createBundle(d.signer, now);
    const good = await buildHello({ roomId: ROOM, from: "p1", to: "p2", v3, signer: d.signer, mb: own.bundle, acc: null, sth: null });
    expect(await verifyHello(good.hello, ctx)).toMatchObject({ ok: true, mailbox: own.bundle });
    const later = await verifyHello(good.hello, { ...ctx, now: now + MAILBOX_LIFETIME_MS });
    expect(later).toMatchObject({ ok: true, mailbox: null, mailboxProblem: "expired" });
    const stranger = await testDevice();
    const foreign = await createBundle(stranger.signer, now);
    const bad = await buildHello({ roomId: ROOM, from: "p1", to: "p2", v3, signer: d.signer, mb: foreign.bundle, acc: null, sth: null });
    expect(await verifyHello(bad.hello, ctx)).toMatchObject({ ok: true, mailbox: null, mailboxProblem: "bad-signature" });
  });

  it("ignores a KEM message for another hello, and a tampered KEM ciphertext gives the sides different keys", async () => {
    const [da, db] = await Promise.all([testDevice(), testDevice()]);
    const mk = (d: typeof da, from: string, to: string) => buildHello({ roomId: ROOM, from, to, v3: { check: CHECK, pk: d.pk, dh: d.dh, sig: "c2ln" }, signer: d.signer, mb: null, acc: null, sth: null });
    const A = await mk(da, "pa", "pb");
    const B = await mk(db, "pb", "pa");
    const stale = await mk(db, "pb", "pa");
    const toB = await buildKemMessage(B.hello);
    const toA = await buildKemMessage(A.hello);
    expect(await openKemMessage((await buildKemMessage(stale.hello)).message, B)).toBeNull();
    const ct = unb64(toA.message.ct);
    ct[5] ^= 1;
    const tampered = { ...toA.message, ct: b64(ct) };
    const atA = await openKemMessage(tampered, A);
    const atB = await openKemMessage(toB.message, B);
    const sa = await establishSession({ roomId: ROOM, check: CHECK, self: { peerId: "pa", hello: A.hello, secrets: A.secrets }, peer: { peerId: "pb", hello: B.hello }, sent: toB, received: atA! });
    const sb = await establishSession({ roomId: ROOM, check: CHECK, self: { peerId: "pb", hello: B.hello, secrets: B.secrets }, peer: { peerId: "pa", hello: A.hello }, sent: toA, received: atB! });
    expect(b64(sa.th)).not.toBe(b64(sb.th));
    const res = await sb.ratchet.decrypt(await sa.ratchet.encrypt(text("a", 0)));
    expect(res.ok).toBe(false);
  });

  it("answers the same peer hello twice with the same KEM message (idempotent), another hello with a new one", async () => {
    const [da, db] = await Promise.all([testDevice(), testDevice()]);
    const start = (d: typeof da, self: string, peer: string) => PairHandshake.start({
      roomId: ROOM, check: CHECK, selfPeerId: self, peerPeerId: peer, v3: { check: CHECK, pk: d.pk, dh: d.dh, sig: "c2ln" }, signer: d.signer, mb: null, acc: null, sth: null,
    });
    const ha = await start(da, "pa", "pb");
    const hb = await start(db, "pb", "pa");
    const first = await ha.acceptHello(hb.hello);
    const again = await ha.acceptHello(clone(hb.hello)); // the hello arrived twice
    expect(first.kem).not.toBeNull();
    expect(again.verdict.ok).toBe(true);
    expect(again.kem).toEqual(first.kem);
    // The peer used the FIRST KEM message: the sessions still agree.
    const fromB = await hb.acceptHello(ha.hello);
    expect(await hb.acceptKem(first.kem)).toBe("ok");
    expect(await ha.acceptKem(fromB.kem)).toBe("ok");
    const [sa, sb] = await Promise.all([ha.establish(), hb.establish()]);
    expect(b64(sa.th)).toBe(b64(sb.th));
    expect(await open(sb.ratchet, await sa.ratchet.encrypt(text("a", 1)))).toMatchObject({ t: "msg", id: "a-1" });
    expect(await open(sa.ratchet, await sb.ratchet.encrypt(text("b", 1)))).toMatchObject({ t: "msg", id: "b-1" });
    // A different hello of the peer (it started over) gets a new KEM message.
    const hc = await start(da, "pa", "pb");
    const hb2 = await start(db, "pb", "pa");
    const one = await hc.acceptHello(hb.hello);
    const other = await hc.acceptHello(hb2.hello);
    expect(other.kem).not.toBeNull();
    expect(other.kem!.r).not.toBe(one.kem!.r);
    expect(other.kem!.ct).not.toBe(one.kem!.ct);
  });

  it("signs the hello with the device key over the documented transcript", async () => {
    const d = await testDevice();
    const { hello } = await buildHello({ roomId: ROOM, from: "p1", to: "p2", v3: { check: CHECK, pk: d.pk, dh: d.dh, sig: "c2ln" }, signer: d.signer, mb: null, acc: null, sth: null });
    const kHash = await hB64(unb64(hello.k));
    // 6.12 review P02: capsDigest (only "p4" here), userDigest and sthDigest ("-": none) close the transcript.
    expect(hello.caps).toEqual(["p4"]);
    const capsHash = await hB64(new TextEncoder().encode("p4"));
    const data = new TextEncoder().encode([LABEL.hello, ROOM, "p1", "p2", CHECK, d.pk, d.dh, hello.e, kHash, hello.n, "-", "-", capsHash, "-", "-"].join("|"));
    expect(Buffer.from(await helloSig4Data(ROOM, "p1", "p2", hello)).equals(Buffer.from(data))).toBe(true);
    expect(await ecdsaVerify(d.pk, new Uint8Array(data), hello.sig4)).toBe(true);
  });

  it("signs caps (sorted, without duplicates), the user claim and the tree head (review P02)", async () => {
    const d = await testDevice();
    const kt = await ed25519FromSeed(new Uint8Array(32).fill(0x17));
    const sth = await signSth(kt.privateKey, 4, new Uint8Array(32).fill(2), 9);
    const { hello } = await buildHello({ roomId: ROOM, from: "p1", to: "p2", v3: { check: CHECK, pk: d.pk, dh: d.dh, sig: "c2ln", caps: ["media", "bin", "media"], user: "Žofie" }, signer: d.signer, mb: null, acc: null, sth });
    const ctx = { roomId: ROOM, from: "p1", to: "p2", check: CHECK };
    expect((await verifyHello(hello, ctx)).ok).toBe(true);
    const enc = new TextEncoder();
    expect(await capsDigest(hello.caps)).toBe(await hB64(enc.encode("bin|media|p4")));
    expect(await userDigest(hello.user)).toBe(await hB64(enc.encode("Žofie")));
    expect(await sthDigest(sth)).toBe(await hB64(enc.encode([4, sth.root, 9, sth.sig].join("|"))));
    // Every one of them is bound: removing, adding or changing any fails sig4.
    for (const tampered of [
      { ...hello, caps: ["bin", "p4"] },
      { ...hello, caps: [...hello.caps, "x"] },
      { ...hello, user: "Zofie" },
      { ...hello, user: undefined },
      { ...hello, sth: null },
      { ...hello, sth: { ...sth, ts: 10 } },
    ]) expect(await verifyHello(tampered, ctx)).toMatchObject({ ok: false, why: "bad-sig4" });
    // Reordering or repeating caps keeps the digest (it sorts and de-duplicates).
    expect((await verifyHello({ ...hello, caps: ["p4", "media", "bin", "bin"] }, ctx)).ok).toBe(true);
    // A cap with "|" or a non-string user is malformed.
    expect(await verifyHello({ ...hello, caps: ["a|b"] }, ctx)).toMatchObject({ ok: false, why: "malformed" });
    expect(await verifyHello({ ...hello, user: { name: "x" } }, ctx)).toMatchObject({ ok: false, why: "malformed" });
  });
});

describe("p4 pair ratchet", () => {
  it("both sides send before either receives", async () => {
    const { a, b } = await oriented();
    const fa = [await a.encrypt(text("a", 0)), await a.encrypt(text("a", 1))];
    const fb = [await b.encrypt(text("b", 0)), await b.encrypt(text("b", 1))];
    expect(await open(b, fa[0])).toEqual(text("a", 0));
    expect(await open(a, fb[0])).toEqual(text("b", 0));
    expect(await open(a, fb[1])).toEqual(text("b", 1));
    expect(await open(b, fa[1])).toEqual(text("a", 1));
    // B received A's first chain: its reply starts a new chain with a DH + KEM step.
    const r1 = await b.encrypt(text("b", 2));
    expect(r1.h.n).toBe(0);
    expect(r1.h.kct).toBeDefined();
    expect(await open(a, r1)).toEqual(text("b", 2));
    // B's CK_B0 was already A's receiving chain; B's new chain makes A step now.
    const r2 = await a.encrypt(text("a", 2));
    expect(r2.h.n).toBe(0);
    expect(r2.h.kct).toBeDefined();
    expect(await open(b, r2)).toEqual(text("a", 2));
  });

  it("runs a long randomized conversation; the KEM ratchet steps in both directions", async () => {
    const { a, b } = await session();
    const rand = lcg(42);
    const toB: RatchetFrame[] = [];
    const toA: RatchetFrame[] = [];
    const sentA: RatchetInner[] = [];
    const sentB: RatchetInner[] = [];
    let gotA = 0;
    let gotB = 0;
    let kctA = 0;
    let kctB = 0;
    for (let step = 0; step < 400; step++) {
      const r = rand();
      if (r < 0.25) { const m = text("a", sentA.length); sentA.push(m); toB.push(await a.encrypt(m)); }
      else if (r < 0.5) { const m = text("b", sentB.length); sentB.push(m); toA.push(await b.encrypt(m)); }
      else if (r < 0.75) {
        // B reads a random number of what is pending, in order (the data channel is ordered).
        for (let k = Math.floor(rand() * (toB.length + 1)); k > 0; k--) { const f = toB.shift()!; if (f.h.kct) kctA++; expect(await open(b, f)).toEqual(sentA[gotB++]); }
      } else {
        for (let k = Math.floor(rand() * (toA.length + 1)); k > 0; k--) { const f = toA.shift()!; if (f.h.kct) kctB++; expect(await open(a, f)).toEqual(sentB[gotA++]); }
      }
    }
    while (toB.length) expect(await open(b, toB.shift()!)).toEqual(sentA[gotB++]);
    while (toA.length) expect(await open(a, toA.shift()!)).toEqual(sentB[gotA++]);
    expect(gotA).toBe(sentB.length);
    expect(gotB).toBe(sentA.length);
    expect(kctA).toBeGreaterThanOrEqual(3);
    expect(kctB).toBeGreaterThanOrEqual(3);
    expect(a.info().kemKeys).toBe(3);
    expect(a.info().failures + b.info().failures).toBe(0);
  });

  it("opens messages out of order within a chain and across chains (skipped keys)", async () => {
    // x is role A (its first chain carries no KEM ciphertext), y role B.
    const { a: x, b: y } = await oriented();
    const y0 = await y.encrypt(text("y", 0)); // y's initial chain (CK_B0)
    const xs = [await x.encrypt(text("x", 0)), await x.encrypt(text("x", 1)), await x.encrypt(text("x", 2))];
    expect(await open(y, xs[0])).toEqual(text("x", 0));
    expect(await open(y, xs[2])).toEqual(text("x", 2));
    expect(await open(y, xs[1])).toEqual(text("x", 1));
    const y1 = await y.encrypt(text("y", 1)); // new chain, pn = 1
    const y2 = await y.encrypt(text("y", 2));
    expect(y1.h.pn).toBe(1);
    expect(await open(x, y1)).toEqual(text("y", 1)); // stores y0's key
    expect(x.info().skipped).toBe(1);
    expect(await open(x, y2)).toEqual(text("y", 2));
    expect(await open(x, y0)).toEqual(text("y", 0));
    expect(x.info().skipped).toBe(0);
    expect((await x.decrypt(y0)).ok).toBe(false); // used once
  });

  it("rejects a tampered header field or ciphertext and keeps its state", async () => {
    const { a, b } = await oriented();
    expect(await open(b, await a.encrypt(text("a", 0)))).toEqual(text("a", 0));
    const frame = await b.encrypt(text("b", 0)); // a new chain: dh, pn, n, kid, kct, kek
    expect(frame.h.kid && frame.h.kct && frame.h.kek).toBeTruthy();
    const other = await testDevice();
    const flip = (s: string, at = 10) => { const x = unb64(s); x[at] ^= 0x01; return b64(x); };
    const variants: Array<[string, unknown]> = [
      ["dh", { ...frame, h: { ...frame.h, dh: other.dh } }],
      ["pn", { ...frame, h: { ...frame.h, pn: frame.h.pn + 1 } }],
      ["n", { ...frame, h: { ...frame.h, n: 1 } }],
      ["kct", { ...frame, h: { ...frame.h, kct: flip(frame.h.kct!) } }],
      ["kek", { ...frame, h: { ...frame.h, kek: flip(frame.h.kek!) } }],
      ["no kek", { ...frame, h: { ...frame.h, kek: undefined } }],
      ["c", { ...frame, c: flip(frame.c, 3) }],
      ["c tag", { ...frame, c: flip(frame.c, unb64(frame.c).length - 1) }],
      ["kind", { ...frame, kind: "p3" }],
      ["v", { ...frame, v: 3 }],
      ["n negative", { ...frame, h: { ...frame.h, n: -1 } }],
      ["n fraction", { ...frame, h: { ...frame.h, n: 0.5 } }],
      ["dh garbage", { ...frame, h: { ...frame.h, dh: "AAAA" } }],
      ["kid alone", { ...frame, h: { ...frame.h, kct: undefined } }],
    ];
    for (const [name, forged] of variants) {
      const res = await a.decrypt(JSON.parse(JSON.stringify(forged)));
      expect(res.ok, name).toBe(false);
    }
    expect(await open(a, clone(frame))).toEqual(text("b", 0));
    // And the conversation goes on.
    expect(await open(b, await a.encrypt(text("a", 1)))).toEqual(text("a", 1));
    expect(await open(a, await b.encrypt(text("b", 1)))).toEqual(text("b", 1));
  });

  it("binds every AAD part: room, both peer ids and the transcript", async () => {
    const rk0 = new Uint8Array(32).fill(7);
    const ckB0 = new Uint8Array(32).fill(9);
    const th = new Uint8Array(32).fill(3);
    const bE = await systemRng.p256("ecdh", "e");
    const base = { rk0, ckB0, th, roomId: ROOM, peerE: bE.spki };
    const A = await Ratchet.create({ ...base, role: "A", selfPeerId: "pa", peerPeerId: "pb" });
    const frame = await A.encrypt(text("a", 0));
    const tries = [
      { roomId: "r3.another" }, { selfPeerId: "pc" }, { peerPeerId: "pc" }, { th: new Uint8Array(32).fill(4) },
    ];
    for (const over of tries) {
      const B = await Ratchet.create({ ...base, role: "B", selfPeerId: "pb", peerPeerId: "pa", ownE: bE, ...over });
      expect((await B.decrypt(frame)).ok).toBe(false);
    }
    const B = await Ratchet.create({ ...base, role: "B", selfPeerId: "pb", peerPeerId: "pa", ownE: bE });
    expect(await open(B, frame)).toEqual(text("a", 0));
  });

  it("asks for a reset on the second failure, at once for a KEM ciphertext it cannot decapsulate", async () => {
    const { a, b } = await oriented();
    expect(await open(b, await a.encrypt(text("a", 0)))).toEqual(text("a", 0));
    const frame = await b.encrypt(text("b", 0));
    const first = await a.decrypt({ ...frame, c: b64(new Uint8Array(40)) });
    expect(first).toMatchObject({ ok: false, error: "aead", reset: false });
    const second = await a.decrypt({ ...frame, c: b64(new Uint8Array(40)) });
    expect(second).toMatchObject({ ok: false, error: "aead", reset: true });

    const s2 = await oriented();
    expect(await open(s2.b, await s2.a.encrypt(text("a", 0)))).toEqual(text("a", 0));
    const f2 = await s2.b.encrypt(text("b", 0));
    expect(await s2.a.decrypt({ ...f2, h: { ...f2.h, kid: "AAAAAAAAAAAAAAAA" } })).toMatchObject({ ok: false, error: "kct", reset: true });
    const s3 = await oriented();
    expect(await open(s3.b, await s3.a.encrypt(text("a", 0)))).toEqual(text("a", 0));
    const f3 = await s3.b.encrypt(text("b", 0));
    expect(await s3.a.decrypt({ ...f3, h: { ...f3.h, kct: b64(new Uint8Array(100)) } })).toMatchObject({ ok: false, error: "kct", reset: true });
    // State intact even so: the genuine frame opens.
    expect(await open(s3.a, f3)).toEqual(text("b", 0));
  });

  it("refuses a replayed frame", async () => {
    const { a, b } = await session();
    const f = await a.encrypt(text("a", 0));
    expect(await open(b, f)).toEqual(text("a", 0));
    expect(await b.decrypt(f)).toMatchObject({ ok: false, error: "replay" });
  });

  it("skips at most MAX_SKIP keys per header", async () => {
    const { a, b } = await session();
    const frames: RatchetFrame[] = [];
    for (let i = 0; i <= MAX_SKIP; i++) frames.push(await a.encrypt({ t: "msg", id: `m${i}`, p: { id: `m${i}` } }));
    expect((await open(b, frames[MAX_SKIP])).id).toBe(`m${MAX_SKIP}`); // skips exactly MAX_SKIP
    expect(b.info().skipped).toBe(MAX_SKIP);
    expect((await open(b, frames[5])).id).toBe("m5");
    const more: RatchetFrame[] = [];
    for (let i = 0; i <= MAX_SKIP + 1; i++) more.push(await a.encrypt({ t: "msg", id: `n${i}`, p: { id: `n${i}` } }));
    expect(await b.decrypt(more[MAX_SKIP + 1])).toMatchObject({ ok: false, error: "skip" });
    expect((await open(b, more[0])).id).toBe("n0");
  });

  it("serialises concurrent encrypts and returns unknown inner types", async () => {
    const { a, b } = await session();
    const frames = await Promise.all(Array.from({ length: 12 }, (_, i) => a.encrypt({ t: i % 2 ? "msg" : "future-kind", id: `c${i}`, p: { id: `c${i}` } })));
    expect(frames.map((f) => f.h.n)).toEqual([...Array(12).keys()]);
    for (let i = 0; i < 12; i++) expect((await open(b, frames[i])).t).toBe(i % 2 ? "msg" : "future-kind");
    await expect(a.encrypt([] as unknown as RatchetInner)).rejects.toThrow();
  });

  it("pads every frame to a bucket", async () => {
    const { a } = await session();
    const short = await a.encrypt({ t: "msg", id: "s", p: { id: "s" } });
    const longer = await a.encrypt({ t: "msg", id: "l", p: { id: "l", text: "y".repeat(150) } });
    expect(unb64(short.c).length).toBe(256 + 16);
    expect(unb64(longer.c).length).toBe(256 + 16);
  });

  it("forgets everything on wipe", async () => {
    const { a, b } = await session();
    const f = await a.encrypt(text("a", 0));
    b.wipe();
    expect(await b.decrypt(f)).toMatchObject({ ok: false, error: "state", reset: true });
    await expect(b.encrypt(text("b", 0))).rejects.toThrow();
    expect(b.info().wiped).toBe(true);
  });

  it("keeps working after a reset: a new handshake between the same devices", async () => {
    const [da, db] = await Promise.all([testDevice(), testDevice()]);
    const first = await pair({ device: da, peerId: "pa" }, { device: db, peerId: "pb" });
    first.sa.ratchet.wipe();
    first.sb.ratchet.wipe();
    const second = await pair({ device: da, peerId: "pa" }, { device: db, peerId: "pb" });
    expect(b64(second.sa.th)).not.toBe(b64(first.sa.th));
    expect(await open(second.sb.ratchet, await second.sa.ratchet.encrypt(text("a", 0)))).toEqual(text("a", 0));
  });

  it("does not open a frame of the other direction (reflection)", async () => {
    const { a } = await session();
    const f = await a.encrypt(text("a", 0));
    expect((await a.decrypt(f)).ok).toBe(false);
  });
});
