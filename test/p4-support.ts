// Shared fixtures for the protocol-4 tests (test/p4-*.test.ts).

import { b64, type DeviceSigner, type HelloAccount, type MailboxBundle, type Rng, PairHandshake, type PairSession } from "../client/src/lib/p4";

const subtle = globalThis.crypto.subtle;

export type TestDevice = { signer: DeviceSigner; pk: string; dh: string; signKey: CryptoKey; signPkcs8: string };

/** A device: an ECDSA P-256 signing key (exportable, for vectors) and a static ECDH key (protocol 3's `dh`). */
export async function testDevice(): Promise<TestDevice> {
  const sign = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const dh = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const pk = b64(new Uint8Array(await subtle.exportKey("spki", sign.publicKey)));
  const signer: DeviceSigner = {
    publicKey: pk,
    async sign(data) { return b64(new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, sign.privateKey, data))); },
  };
  return {
    signer, pk, signKey: sign.privateKey,
    dh: b64(new Uint8Array(await subtle.exportKey("spki", dh.publicKey))),
    signPkcs8: b64(new Uint8Array(await subtle.exportKey("pkcs8", sign.privateKey))),
  };
}

export const ROOM = "r3.QmxpbmRSb29tSWRGb3JUZXN0cw";
export const CHECK = "0123456789abcdef";

export type Side = { device: TestDevice; peerId: string; rng?: Rng; mb?: MailboxBundle | null; acc?: HelloAccount | null };

/** Runs the whole § 2–4 exchange between two sides; returns both sessions and the handshakes. */
export async function pair(a: Side, b: Side, opts: { room?: string; check?: string } = {}): Promise<{ sa: PairSession; sb: PairSession; ha: PairHandshake; hb: PairHandshake }> {
  const roomId = opts.room ?? ROOM;
  const check = opts.check ?? CHECK;
  const start = (self: Side, peer: Side) => PairHandshake.start({
    roomId, check, selfPeerId: self.peerId, peerPeerId: peer.peerId,
    v3: { check, pk: self.device.pk, dh: self.device.dh, sig: "c2lnLXYz", caps: ["bin", "media"] },
    signer: self.device.signer, mb: self.mb ?? null, acc: self.acc ?? null, sth: null, rng: self.rng,
  });
  const ha = await start(a, b);
  const hb = await start(b, a);
  const ra = await ha.acceptHello(hb.hello);
  const rb = await hb.acceptHello(ha.hello);
  if (!ra.verdict.ok || !rb.verdict.ok || !ra.kem || !rb.kem) throw new Error("hello refused");
  if (await ha.acceptKem(rb.kem) !== "ok" || await hb.acceptKem(ra.kem) !== "ok") throw new Error("KEM refused");
  const [sa, sb] = await Promise.all([ha.establish(), hb.establish()]);
  return { sa, sb, ha, hb };
}

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
