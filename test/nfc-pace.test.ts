// @vitest-environment node
//
// PACE (6.6): AES + CMAC (cards/aes.ts), the curves (cards/ec.ts), the
// protocol (cards/pace.ts) and AES secure messaging (cards/sm.ts).
//
// Official vectors — test/fixtures/pace-vectors.json, extracted mechanically
// from the documents:
//   - ICAO Doc 9303 Part 11, Appendix G.1: PACE-ECDH-GM-AES-128 on
//     brainpoolP256r1 with the MRZ. Every intermediate value, and every APDU
//     of the exchange replayed byte for byte;
//   - ICAO 9303-11 Appendix I.1 (PACE-CAM, whose nonce mapping, key agreement
//     and tokens are the generic mapping's);
//   - BSI TR-03110 EAC2 Worked Example (its GlobalTester log): the PACE
//     exchange and the 21 AES secure-messaging APDUs that follow it.
// AES against FIPS-197 / SP 800-38A, CMAC against RFC 4493, k·G on all six
// curves against node:crypto. Then a simulated PACE chip — the chip side
// written here from the spec, its symmetric crypto from node:crypto, its
// point arithmetic from ec.ts (checked against node:crypto above) — is read
// end to end with the CAN and with the MRZ.

import { describe, it, expect } from "vitest";
import { createCipheriv, createDecipheriv, createECDH, createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { concat, decodeTlv, encodeTlv, hex, u8 } from "../client/src/lib/nfc/cards/apdu";
import { aesCbcDecrypt, aesCbcEncrypt, aesCmac, aesDecryptBlock, aesEncryptBlock } from "../client/src/lib/nfc/cards/aes";
import { deriveKey, type MrzKey } from "../client/src/lib/nfc/cards/bac";
import { pad, retailMac, tdesCbcDecrypt, tdesCbcEncrypt } from "../client/src/lib/nfc/cards/des";
import { bigIntToBytes, bytesToBigInt, decodePoint, encodePoint, PACE_CURVES, pointAdd, pointMul, randomScalar, type Curve } from "../client/src/lib/nfc/cards/ec";
import { oidBytes } from "../client/src/lib/nfc/cards/asn1";
import {
  authToken, choosePace, decryptNonce, establishPace, mapNonce, paceKdf, paceSecret, paceSupported, parseSecurityInfos, passwordKey,
  type PaceInfo,
} from "../client/src/lib/nfc/cards/pace";
import { protectAesApdu, unprotectAesResponse } from "../client/src/lib/nfc/cards/sm";
import { readMrtd } from "../client/src/lib/nfc/cards/mrtd";
import type { CardTransport } from "../client/src/lib/nfc/transport";

const b = (h: string) => Uint8Array.from(Buffer.from(h.replace(/\s/g, ""), "hex"));
const H = (u: Uint8Array) => hex(u).toUpperCase();
const big = (h: string) => BigInt(`0x${h}`);
const ascii = (s: string) => new TextEncoder().encode(s);
const T = (tag: number, ...v: Uint8Array[]) => encodeTlv(tag, concat(...v));
const oid = (s: string) => T(0x06, oidBytes(s));
const int = (n: number) => T(0x02, u8(n));

/** A worked example: hex values by name, the password, and the recorded APDUs ([command, answer]). */
type Vector = { [value: string]: string } & { mrz?: MrzKey; password?: string; apdus?: [string, string][] };
const V = JSON.parse(readFileSync(join(__dirname, "fixtures", "pace-vectors.json"), "utf8"));
const G1 = V.icaoG as Vector & { mrz: MrzKey; apdus: [string, string][] };
const I1 = V.icaoI as Vector & { mrz: MrzKey; caData: { encrypted: string; decrypted: string } };
/** sm: [plain command, protected command, protected answer, plain answer] as logged. */
const BSI = V.bsi as Vector & { password: string; apdus: [string, string][]; sm: [string, string, string, string][] };

/** The PACEInfo a vector announces, parsed the way EF.CardAccess is. */
const infoOf = (paceInfo: string): PaceInfo => parseSecurityInfos(T(0x31, b(paceInfo))).pace[0];

/* ------------------------------------------------------------ node:crypto references */

const aesName = (key: Uint8Array) => `aes-${key.length * 8}`;
function nodeAes(mode: "ecb" | "cbc", dir: "enc" | "dec", key: Uint8Array, data: Uint8Array, iv: Uint8Array = new Uint8Array(16)): Uint8Array {
  const c = dir === "enc" ? createCipheriv(`${aesName(key)}-${mode}`, key, mode === "ecb" ? null : iv) : createDecipheriv(`${aesName(key)}-${mode}`, key, mode === "ecb" ? null : iv);
  c.setAutoPadding(false);
  return new Uint8Array(Buffer.concat([c.update(data), c.final()]));
}
/** RFC 4493 CMAC over node's AES — the reference the chip uses, independent of aes.ts. */
function nodeCmac(key: Uint8Array, m: Uint8Array): Uint8Array {
  const E = (x: Uint8Array) => nodeAes("ecb", "enc", key, x);
  const dbl = (x: Uint8Array) => { const o = new Uint8Array(16); for (let i = 0; i < 16; i++) o[i] = ((x[i] << 1) | (i < 15 ? x[i + 1] >> 7 : 0)) & 0xff; if (x[0] & 0x80) o[15] ^= 0x87; return o; };
  const k1 = dbl(E(new Uint8Array(16))), k2 = dbl(k1);
  const n = Math.max(1, Math.ceil(m.length / 16)), whole = m.length > 0 && m.length % 16 === 0;
  const last = new Uint8Array(16); last.set(m.subarray((n - 1) * 16)); if (!whole) last[m.length - (n - 1) * 16] = 0x80;
  let x: Uint8Array = new Uint8Array(16);
  for (let i = 0; i < n - 1; i++) x = E(x.map((v, j) => v ^ m[i * 16 + j]));
  return E(x.map((v, j) => v ^ last[j] ^ (whole ? k1 : k2)[j]));
}
const nodeKdf = (k: Uint8Array, c: number, alg: "sha1" | "sha256", len: number) =>
  new Uint8Array(createHash(alg).update(concat(k, u8(0, 0, 0, c))).digest()).slice(0, len);

/* ------------------------------------------------------------ AES + CMAC */

describe("AES (FIPS-197) and AES-CMAC (RFC 4493)", () => {
  const PT = "00112233445566778899AABBCCDDEEFF";
  it("encrypts and decrypts the FIPS-197 Appendix C blocks (128 / 192 / 256)", () => {
    const cases: [string, string][] = [
      ["000102030405060708090A0B0C0D0E0F", "69C4E0D86A7B0430D8CDB78070B4C55A"],
      ["000102030405060708090A0B0C0D0E0F1011121314151617", "DDA97CA4864CDFE06EAF70A0EC0D7191"],
      ["000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F", "8EA2B7CA516745BFEAFC49904B496089"],
    ];
    for (const [key, ct] of cases) {
      expect(H(aesEncryptBlock(b(key), b(PT)))).toBe(ct);
      expect(H(aesDecryptBlock(b(key), b(ct)))).toBe(PT);
    }
    // Appendix B, the cipher example.
    expect(H(aesEncryptBlock(b("2B7E151628AED2A6ABF7158809CF4F3C"), b("3243F6A8885A308D313198A2E0370734")))).toBe("3925841D02DC09FBDC118597196A0B32");
  });

  it("runs CBC as in SP 800-38A F.2.1 / F.2.2", () => {
    const key = b("2B7E151628AED2A6ABF7158809CF4F3C"), iv = b("000102030405060708090A0B0C0D0E0F");
    const pt = b("6BC1BEE22E409F96E93D7E117393172A AE2D8A571E03AC9C9EB76FAC45AF8E51 30C81C46A35CE411E5FBC1191A0A52EF F69F2445DF4F9B17AD2B417BE66C3710");
    const ct = "7649ABAC8119B246CEE98E9B12E9197D5086CB9B507219EE95DB113A917678B273BED6B8E3C1743B7116E69E222295163FF1CAA1681FAC09120ECA307586E1A7";
    expect(H(aesCbcEncrypt(key, pt, iv))).toBe(ct);
    expect(H(aesCbcDecrypt(key, b(ct), iv))).toBe(H(pt));
  });

  it("gives the RFC 4493 CMACs", () => {
    const key = b("2B7E151628AED2A6ABF7158809CF4F3C");
    const m = b("6BC1BEE22E409F96E93D7E117393172A AE2D8A571E03AC9C9EB76FAC45AF8E51 30C81C46A35CE411E5FBC1191A0A52EF F69F2445DF4F9B17AD2B417BE66C3710");
    expect(H(aesCmac(key, m.slice(0, 0)))).toBe("BB1D6929E95937287FA37D129B756746");
    expect(H(aesCmac(key, m.slice(0, 16)))).toBe("070A16B46B4D4144F79BDD9DD04A287C");
    expect(H(aesCmac(key, m.slice(0, 40)))).toBe("DFA66747DE9AE63030CA32611497C827");
    expect(H(aesCmac(key, m))).toBe("51F0BEBF7E3B9D92FC49741779363CFE");
  });

  it("matches node:crypto on random keys, IVs and lengths", () => {
    for (const len of [16, 24, 32]) {
      for (let i = 0; i < 6; i++) {
        const key = new Uint8Array(randomBytes(len)), iv = new Uint8Array(randomBytes(16)), data = new Uint8Array(randomBytes(16 * (1 + i * 3)));
        expect(H(aesEncryptBlock(key, data.subarray(0, 16)))).toBe(H(nodeAes("ecb", "enc", key, data.subarray(0, 16))));
        expect(H(aesCbcEncrypt(key, data, iv))).toBe(H(nodeAes("cbc", "enc", key, data, iv)));
        expect(H(aesCbcDecrypt(key, data, iv))).toBe(H(nodeAes("cbc", "dec", key, data, iv)));
        for (const n of [0, 1, 15, 16, 17, 31, 32, 33, 81]) {
          const m = new Uint8Array(randomBytes(n));
          expect(H(aesCmac(key, m))).toBe(H(nodeCmac(key, m)));
        }
      }
    }
  });
});

/* ------------------------------------------------------------ the curves */

describe("the PACE curves (ec.ts)", () => {
  const ids = [12, 13, 15, 16, 17, 18];
  it("covers exactly the standardized curves 12, 13, 15–18", () => {
    expect(Object.keys(PACE_CURVES).map(Number)).toEqual(ids);
    expect(ids.map((id) => PACE_CURVES[id].name)).toEqual(["NIST P-256", "brainpoolP256r1", "NIST P-384", "brainpoolP384r1", "brainpoolP512r1", "NIST P-521"]);
  });

  for (const id of ids) {
    const c: Curve = PACE_CURVES[id];
    it(`${c.name}: k·G and ECDH equal node:crypto`, () => {
      expect(decodePoint(c, encodePoint(c, c.G))).toEqual(c.G);
      for (const k of [1n, 2n, c.n - 1n, randomScalar(c), randomScalar(c), randomScalar(c)]) {
        const node = createECDH(c.nodeName);
        node.setPrivateKey(Buffer.from(bigIntToBytes(k, Math.ceil(c.n.toString(16).length / 2))));
        expect(H(encodePoint(c, pointMul(c, k)!))).toBe(H(new Uint8Array(node.getPublicKey())));
      }
      // ECDH: our x-coordinate of k1·(k2·G) is node's shared secret.
      const k1 = randomScalar(c), k2 = randomScalar(c);
      const a = createECDH(c.nodeName), bb = createECDH(c.nodeName);
      a.setPrivateKey(Buffer.from(bigIntToBytes(k1, Math.ceil(c.n.toString(16).length / 2))));
      bb.setPrivateKey(Buffer.from(bigIntToBytes(k2, Math.ceil(c.n.toString(16).length / 2))));
      expect(H(bigIntToBytes(pointMul(c, k1, pointMul(c, k2))!.x, c.size))).toBe(H(new Uint8Array(a.computeSecret(bb.getPublicKey()))));
      // Group laws: (k1 + k2)·G = k1·G + k2·G, n·G = O, P + (−P) = O.
      const P1 = pointMul(c, k1)!, P2 = pointMul(c, k2)!;
      expect(pointAdd(c, P1, P2)).toEqual(pointMul(c, k1 + k2));
      expect(pointAdd(c, P1, P1)).toEqual(pointMul(c, 2n * k1));
      expect(pointMul(c, c.n)).toBeNull();
      expect(pointAdd(c, P1, { x: P1.x, y: c.p - P1.y })).toBeNull();
      // Validation: off-curve, wrong length, compressed.
      const enc = encodePoint(c, P1);
      const bad = enc.slice(); bad[bad.length - 1] ^= 1;
      expect(decodePoint(c, bad)).toBeNull();
      expect(decodePoint(c, enc.slice(1))).toBeNull();
      expect(decodePoint(c, concat(u8(0x02), enc.slice(1, 1 + c.size)))).toBeNull();
    });
  }
});

/* ------------------------------------------------------------ KDF and f(π) */

describe("the PACE KDF and password encoding", () => {
  const K = b("0102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F20");
  it("uses SHA-1 for 3DES / AES-128 and SHA-256 for AES-192 / AES-256", async () => {
    expect(H(await paceKdf(K, 1, "AES-128"))).toBe(H(nodeKdf(K, 1, "sha1", 16)));
    expect(H(await paceKdf(K, 2, "AES-192"))).toBe(H(nodeKdf(K, 2, "sha256", 24)));
    expect(H(await paceKdf(K, 3, "AES-256"))).toBe(H(nodeKdf(K, 3, "sha256", 32)));
    // 3DES: the BAC key derivation (pinned to ICAO 9303-11 Appendix D) — SHA-1, 16 bytes, DES parity.
    const seed = b("239AB9CB282DAF66231DC5A4DF6BFBAE");
    expect(H(await paceKdf(seed, 1, "3DES"))).toBe("AB94FDECF2674FDFB9B391F85D7F76F2");
    expect(H(await paceKdf(seed, 2, "3DES"))).toBe(H(await deriveKey(seed, 2)));
    for (const x of await paceKdf(K, 3, "3DES")) { let ones = 0; for (let i = 0; i < 8; i++) ones += (x >> i) & 1; expect(ones % 2).toBe(1); }
  });

  it("encodes the CAN as its characters and the MRZ as SHA-1 of the MRZ information", async () => {
    expect(H(await paceSecret({ kind: "can", can: "123456" }))).toBe(H(ascii("123456")));
    expect(H(await paceSecret({ kind: "mrz", key: G1.mrz }))).toBe(G1.K);
  });
});

/* ------------------------------------------------------------ ICAO 9303-11 Appendix G.1 */

/** A transport that plays the chip's side of a recorded exchange and checks every command. */
function replay(pairs: [string, string][], check: (i: number, cmd: string, want: string) => void = (i, cmd, want) => expect(cmd, `APDU ${i}`).toBe(want)) {
  let i = 0;
  const transport = {
    kind: "usb", label: "replay", connected: true,
    transmit: async (cmd: Uint8Array) => {
      if (i >= pairs.length) throw new Error(`unexpected APDU ${H(cmd)}`);
      const [want, answer] = pairs[i];
      check(i++, H(cmd), want);
      return b(answer);
    },
  } as unknown as CardTransport;
  return { transport, done: () => i === pairs.length };
}

/** Every intermediate value of a worked example, recomputed. */
async function checkVector(v: Vector) {
  const info = v.paceInfo ? infoOf(v.paceInfo) : ({ oid: "0.4.0.127.0.7.2.2.4.2.2", cipher: "AES-128", parameterId: 13 } as PaceInfo);
  const c = PACE_CURVES[info.parameterId!];
  const pw = v.mrz ? { kind: "mrz" as const, key: v.mrz } : { kind: "can" as const, can: v.password! };
  if (v.K) expect(H(await paceSecret(pw))).toBe(v.K);
  const kpi = await passwordKey(pw, info.cipher);
  expect(H(kpi)).toBe(v.kpi);
  expect(H(decryptNonce(info.cipher, kpi, b(v.z)))).toBe(v.s);
  // Mapping.
  expect(H(encodePoint(c, pointMul(c, big(v.skMapPcd))!))).toBe(v.pkMapPcd);
  expect(H(encodePoint(c, pointMul(c, big(v.skMapPicc))!))).toBe(v.pkMapPicc);
  const mapped = mapNonce(c, b(v.s), big(v.skMapPcd), decodePoint(c, b(v.pkMapPicc))!);
  expect(H(encodePoint(c, mapped.H))).toBe(v.H);
  expect(H(encodePoint(c, mapped.G))).toBe(v.G);
  // The chip's side of the mapping gives the same generator.
  expect(mapNonce(c, b(v.s), big(v.skMapPicc), decodePoint(c, b(v.pkMapPcd))!).G).toEqual(mapped.G);
  // Key agreement on G̃.
  expect(H(encodePoint(c, pointMul(c, big(v.skPcd), mapped.G)!))).toBe(v.pkPcd);
  expect(H(encodePoint(c, pointMul(c, big(v.skPicc), mapped.G)!))).toBe(v.pkPicc);
  const k = bigIntToBytes(pointMul(c, big(v.skPcd), decodePoint(c, b(v.pkPicc))!)!.x, c.size);
  expect(H(k)).toBe(v.shared);
  expect(H(bigIntToBytes(pointMul(c, big(v.skPicc), decodePoint(c, b(v.pkPcd))!)!.x, c.size))).toBe(v.shared);
  const ksenc = await paceKdf(k, 1, info.cipher), ksmac = await paceKdf(k, 2, info.cipher);
  expect(H(ksenc)).toBe(v.ksenc);
  expect(H(ksmac)).toBe(v.ksmac);
  // Tokens: ours over the chip's key, the chip's over ours.
  expect(H(authToken(info.cipher, ksmac, info.oid, b(v.pkPicc)))).toBe(v.tPcd);
  expect(H(authToken(info.cipher, ksmac, info.oid, b(v.pkPcd)))).toBe(v.tPicc);
  return { info, ksenc, ksmac };
}

describe("ICAO 9303-11 Appendix G.1 (PACE-ECDH-GM-AES-128, brainpoolP256r1, MRZ)", () => {
  it("reads the PACEInfo", () => {
    const info = infoOf(G1.paceInfo);
    expect(info).toMatchObject({ oid: "0.4.0.127.0.7.2.2.4.2.2", agreement: "ECDH", mapping: "GM", cipher: "AES-128", version: 2, parameterId: 13 });
    expect(paceSupported(info)).toBe(true);
  });

  it("derives every value of the worked example", async () => {
    await checkVector(G1);
  });

  it("sends exactly the example's APDUs and accepts the chip's token", async () => {
    // MSE:Set AT: the example sends 80 + 83; this reader adds the optional 84 (the domain parameter id, 0D).
    const doc = b(G1.apdus[0][0]);
    const mse = H(concat(doc.slice(0, 4), u8(doc[4] + 3), doc.slice(5), u8(0x84, 0x01, 0x0d)));
    const r = replay([[mse, G1.apdus[0][1]], ...G1.apdus.slice(1)]);
    const ch = await establishPace(r.transport, infoOf(G1.paceInfo), { kind: "mrz", key: G1.mrz }, { ephemeral: { map: big(G1.skMapPcd), agreement: big(G1.skPcd) } });
    expect(r.done()).toBe(true);
    expect(ch.kind).toBe("pace");
  });

  it("fails as auth-failed when the chip's token does not verify", async () => {
    const pairs = G1.apdus.map(([c, r]) => [c, r] as [string, string]);
    pairs[0][0] = H(concat(b(pairs[0][0]).slice(0, 4), u8(b(pairs[0][0])[4] + 3), b(pairs[0][0]).slice(5), u8(0x84, 0x01, 0x0d)));
    pairs[4][1] = pairs[4][1].replace("3ABB9674BCE93C08", "3ABB9674BCE93C09");
    await expect(establishPace(replay(pairs).transport, infoOf(G1.paceInfo), { kind: "mrz", key: G1.mrz }, { ephemeral: { map: big(G1.skMapPcd), agreement: big(G1.skPcd) } }))
      .rejects.toMatchObject({ code: "auth-failed" });
  });
});

describe("ICAO 9303-11 Appendix I.1 (PACE-CAM: the generic mapping's computations)", () => {
  it("derives every value of the worked example", async () => {
    const { info, ksenc } = await checkVector(I1);
    expect(info.mapping).toBe("CAM");
    expect(paceSupported(info)).toBe(false);
    // The encrypted chip-authentication data: AES-CBC with IV = E(KSenc, −1), M2-padded.
    const plain = aesCbcDecrypt(ksenc, b(I1.caData.encrypted), aesEncryptBlock(ksenc, new Uint8Array(16).fill(0xff)));
    expect(H(plain)).toBe(`${I1.caData.decrypted}80${"00".repeat(15)}`);
  });
});

/* ------------------------------------------------------------ BSI TR-03110 worked example */

describe("BSI TR-03110 EAC worked example (PACE-ECDH-GM-AES-128, brainpoolP256r1, password 123456)", () => {
  const info = { oid: "0.4.0.127.0.7.2.2.4.2.2", name: "PACE ECDH-GM AES-128", version: 2, parameterId: 13, agreement: "ECDH", mapping: "GM", cipher: "AES-128" } as PaceInfo;

  it("derives every value of the worked example", async () => {
    await checkVector(BSI);
  });

  it("runs the logged PACE exchange, then the 21 logged secure-messaging APDUs through the channel", async () => {
    // The example's MSE:Set AT carries a CHAT and the PIN reference (eID terminal
    // authentication), which this reader does not send — so it is answered, not compared.
    // A PIN and a CAN of the same digits encode the same (f(π) = the characters).
    const sm = BSI.sm.map(([plain, prot, resp]) => [prot, resp] as [string, string]);
    const r = replay([["", "9000"], ...BSI.apdus, ...sm], (i, cmd, want) => { if (i === 0) expect(cmd.startsWith("0022C1A4")).toBe(true); else expect(cmd, `APDU ${i}`).toBe(want); });
    const ch = await establishPace(r.transport, info, { kind: "can", can: BSI.password }, { ephemeral: { map: big(BSI.skMapPcd), agreement: big(BSI.skPcd) } });
    for (const [plain, , , plainResponse] of BSI.sm) {
      const got = await ch.send(b(plain));
      expect(H(concat(got.data, u8(got.sw >> 8, got.sw & 0xff)))).toBe(plainResponse);
    }
    expect(r.done()).toBe(true);
  });

  it("wraps and unwraps each logged APDU on its own (SSC = 2i+1 / 2i+2)", () => {
    BSI.sm.forEach(([plain, prot, resp, plainResponse], i) => {
      const s = { ksenc: b(BSI.ksenc), ksmac: b(BSI.ksmac), ssc: bigIntToBytes(BigInt(2 * i), 16) };
      expect(H(protectAesApdu(s, b(plain)))).toBe(prot);
      const got = unprotectAesResponse(s, b(resp));
      expect(H(concat(got.data, u8(got.sw >> 8, got.sw & 0xff)))).toBe(plainResponse);
    });
  });

  it("rejects a response whose MAC does not verify", () => {
    const [, , resp] = BSI.sm[0];
    const bad = b(resp); bad[bad.length - 3] ^= 1;
    expect(() => unprotectAesResponse({ ksenc: b(BSI.ksenc), ksmac: b(BSI.ksmac), ssc: bigIntToBytes(1n, 16) }, bad)).toThrow(/MAC/);
  });
});

/* ------------------------------------------------------------ a simulated PACE chip */

type Suite = { oid: string; cipher: PaceInfo["cipher"]; param: number };
const SUITES: Record<string, Suite> = {
  "AES-128 / brainpoolP256r1": { oid: "0.4.0.127.0.7.2.2.4.2.2", cipher: "AES-128", param: 13 },
  "AES-256 / brainpoolP384r1": { oid: "0.4.0.127.0.7.2.2.4.2.4", cipher: "AES-256", param: 16 },
  "AES-192 / NIST P-521": { oid: "0.4.0.127.0.7.2.2.4.2.3", cipher: "AES-192", param: 18 },
  "AES-256 / brainpoolP512r1": { oid: "0.4.0.127.0.7.2.2.4.2.4", cipher: "AES-256", param: 17 },
  "3DES / NIST P-256": { oid: "0.4.0.127.0.7.2.2.4.2.1", cipher: "3DES", param: 12 },
};

const MRZ = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C<3UTO6908061F9406236ZE184226B<<<<<10";
const KEY: MrzKey = { documentNumber: "L898902C", dateOfBirth: "690806", dateOfExpiry: "940623" };
const CAN = "123456";
const JPEG = concat(u8(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10), ascii("JFIF"), new Uint8Array(600).fill(7), u8(0xff, 0xd9));
const DG1 = T(0x61, T(0x5f1f, ascii(MRZ.replace("\n", ""))));
const DG2 = T(0x75, T(0x7f61, T(0x02, u8(1)), T(0x7f60, T(0xa1, T(0x80, u8(1, 1))), T(0x5f2e, concat(ascii("FAC\0"), new Uint8Array(40), JPEG)))));
const DG11 = T(0x6b, T(0x5c, u8(0x5f, 0x0e)), T(0x5f0e, ascii("ERIKSSON<<ANNA<MARIA")));
const COM = T(0x60, T(0x5f01, ascii("0108")), T(0x5f36, ascii("040000")), T(0x5c, u8(0x61, 0x75, 0x6b)));
const sha256 = (x: Uint8Array) => new Uint8Array(createHash("sha256").update(x).digest());
function sod(groups: Record<number, Uint8Array>) {
  const hashes = Object.entries(groups).map(([n, v]) => T(0x30, int(Number(n)), T(0x04, sha256(v))));
  const lds = T(0x30, int(0), T(0x30, oid("2.16.840.1.101.3.4.2.1")), T(0x30, ...hashes));
  const signedData = T(0x30, int(3), T(0x31, T(0x30, oid("2.16.840.1.101.3.4.2.1"))), T(0x30, oid("2.23.136.1.1.1"), T(0xa0, T(0x04, lds))), T(0x31));
  return T(0x77, T(0x30, oid("1.2.840.113549.1.7.2"), T(0xa0, signedData)));
}
const FILES: Record<number, Uint8Array> = { 0x011e: COM, 0x011d: sod({ 1: DG1, 2: DG2, 11: DG11 }), 0x0101: DG1, 0x0102: DG2, 0x010b: DG11 };

type ChipOptions = { suite: Suite; reject84?: boolean; badToken?: boolean };

/**
 * A PACE-only chip from the spec (ICAO 9303-11 §4.4, §9.8): EF.CardAccess in
 * the clear, everything else behind PACE (6982 before), no BAC. KDF, nonce
 * encryption, tokens and AES secure messaging use node:crypto; 3DES uses
 * des.ts (pinned to the BAC worked example); points use ec.ts.
 */
function paceChip({ suite, reject84, badToken }: ChipOptions) {
  const log: string[] = [];
  const curve = PACE_CURVES[suite.param];
  const aes = suite.cipher !== "3DES";
  const block = aes ? 16 : 8;
  const cardAccess = T(0x31, T(0x30, oid(suite.oid), int(2), int(suite.param)), T(0x30, oid("0.4.0.127.0.7.2.2.4.4.2"), int(2), int(13)));
  const sw = (n: number) => u8(n >> 8, n & 0xff);
  const inc = (s: Uint8Array) => { for (let i = s.length - 1; i >= 0; i--) { s[i] = (s[i] + 1) & 0xff; if (s[i]) break; } };
  const padB = (d: Uint8Array) => { const o = new Uint8Array(d.length + (block - (d.length % block))); o.set(d); o[d.length] = 0x80; return o; };
  const unpadB = (d: Uint8Array) => { let i = d.length - 1; while (d[i] === 0) i--; if (d[i] !== 0x80) throw new Error("padding"); return d.slice(0, i); };
  const kdf = (k: Uint8Array, c: number) => nodeKdf(k, c, suite.cipher === "3DES" || suite.cipher === "AES-128" ? "sha1" : "sha256", { "3DES": 16, "AES-128": 16, "AES-192": 24, "AES-256": 32 }[suite.cipher]);
  const enc = (k: Uint8Array, d: Uint8Array, iv?: Uint8Array) => (aes ? nodeAes("cbc", "enc", k, d, iv) : tdesCbcEncrypt(k, d));
  const dec = (k: Uint8Array, d: Uint8Array, iv?: Uint8Array) => (aes ? nodeAes("cbc", "dec", k, d, iv) : tdesCbcDecrypt(k, d));
  /** The SM checksum over already padded input (§9.8: the SM layer pads). */
  const mac = (k: Uint8Array, padded: Uint8Array) => (aes ? nodeCmac(k, padded).slice(0, 8) : retailMac(k, padded));
  /** The token: the MAC does its own padding (§4.4.3.4) — CMAC internally, M2 for the retail MAC. */
  const token = (k: Uint8Array, pk: Uint8Array) => { const d = T(0x7f49, oid(suite.oid), T(0x86, pk)); return aes ? nodeCmac(k, d).slice(0, 8) : retailMac(k, pad(d)); };

  let kpi: Uint8Array | null = null, step = 0, s: Uint8Array = new Uint8Array(0);
  let gMapped = curve.G, pkPcd: Uint8Array = new Uint8Array(0), pkPicc: Uint8Array = new Uint8Array(0);
  let session: { ksenc: Uint8Array; ksmac: Uint8Array; ssc: Uint8Array } | null = null;
  let pending: { ksenc: Uint8Array; ksmac: Uint8Array } | null = null;
  let selected: number | null = null, app = false;

  /** SELECT / READ BINARY over the files; only EF.CardAccess before PACE. */
  function run(ins: number, p1: number, p2: number, data: Uint8Array, le: number | null): { data: Uint8Array; sw: number } {
    const none = new Uint8Array(0);
    if (ins === 0xa4 && p1 === 0x04) { app = hex(data).toUpperCase() === "A0000002471001"; return { data: none, sw: app ? 0x9000 : 0x6a82 }; }
    if (ins === 0xa4) {
      const fid = (data[0] << 8) | data[1];
      if (fid === 0x011c) { selected = fid; return { data: none, sw: 0x9000 }; }
      if (!session) return { data: none, sw: 0x6982 };
      if (!app || !(fid in FILES)) return { data: none, sw: 0x6a82 };
      selected = fid; return { data: none, sw: 0x9000 };
    }
    if (ins === 0xb0) {
      const f = selected === 0x011c ? cardAccess : selected !== null && session ? FILES[selected] : undefined;
      if (!f) return { data: none, sw: 0x6982 };
      const off = (p1 << 8) | p2, n = le === 0 || le === null ? 256 : le;
      return { data: f.slice(off, off + n), sw: off + n > f.length ? 0x6282 : 0x9000 };
    }
    return { data: none, sw: 0x6d00 };
  }

  async function plainCommand(a: Uint8Array): Promise<Uint8Array> {
    const [cla, ins, p1, p2] = a;
    const lc = a.length > 5 ? a[4] : 0, data = a.slice(5, 5 + lc);
    const dos = lc && (ins === 0x22 || ins === 0x86) ? decodeTlv(data, { recurse: true }) : [];
    const get = (tag: number) => dos.find((n) => n.tag === tag)?.value ?? (dos[0]?.children ?? []).find((n) => n.tag === tag)?.value;
    if (ins === 0x22 && p1 === 0xc1 && p2 === 0xa4) { // MSE:Set AT
      step = 0; kpi = null;
      if (H(get(0x80) ?? new Uint8Array(0)) !== H(oidBytes(suite.oid))) return sw(0x6a80);
      const p84 = get(0x84);
      if (p84 && (reject84 || p84[0] !== suite.param)) return sw(0x6a80);
      const ref = get(0x83)?.[0];
      const secret = ref === 0x02 ? ascii(CAN) : ref === 0x01 ? new Uint8Array(createHash("sha1").update(ascii("L898902C<369080619406236")).digest()) : null;
      if (!secret) return sw(0x6a88);
      kpi = kdf(secret, 3); step = 1;
      return sw(0x9000);
    }
    if (ins === 0x86) { // GENERAL AUTHENTICATE, chained
      if (!kpi || step < 1) return sw(0x6985);
      if ((cla === 0x10) !== (step < 4)) { step = 0; return sw(0x6883); }
      if (step === 1) {
        s = new Uint8Array(randomBytes(16));
        step = 2;
        return concat(T(0x7c, T(0x80, enc(kpi, s))), sw(0x9000));
      }
      if (step === 2) {
        const pkMapPcd = decodePoint(curve, get(0x81) ?? new Uint8Array(0));
        if (!pkMapPcd) { step = 0; return sw(0x6a80); }
        const sk = randomScalar(curve);
        gMapped = pointAdd(curve, pointMul(curve, bytesToBigInt(s)), pointMul(curve, sk, pkMapPcd))!;
        step = 3;
        return concat(T(0x7c, T(0x82, encodePoint(curve, pointMul(curve, sk)!))), sw(0x9000));
      }
      if (step === 3) {
        pkPcd = get(0x83) ?? new Uint8Array(0);
        const P = decodePoint(curve, pkPcd);
        if (!P) { step = 0; return sw(0x6a80); }
        const sk = randomScalar(curve);
        pkPicc = encodePoint(curve, pointMul(curve, sk, gMapped)!);
        const k = bigIntToBytes(pointMul(curve, sk, P)!.x, curve.size);
        pending = { ksenc: kdf(k, 1), ksmac: kdf(k, 2) };
        step = 4;
        return concat(T(0x7c, T(0x84, pkPicc)), sw(0x9000));
      }
      // Step 4: check the terminal's token over our key, answer with ours over theirs.
      step = 0;
      if (!pending || H(get(0x85) ?? new Uint8Array(0)) !== H(token(pending.ksmac, pkPicc))) return sw(0x6300);
      const t = token(pending.ksmac, pkPcd);
      if (badToken) t[0] ^= 1;
      session = { ...pending, ssc: new Uint8Array(block) };
      return concat(T(0x7c, T(0x86, t)), sw(0x9000));
    }
    if (ins === 0x84) return sw(0x6d00); // no BAC on this chip
    const r = run(ins, p1, p2, data, a.length === 5 ? a[4] : a.length > 5 + lc ? a[5 + lc] : null);
    return concat(r.data, sw(r.sw));
  }

  /** Secure messaging (§9.8): check the MAC, decrypt, run, wrap the answer. */
  function smCommand(a: Uint8Array): Uint8Array {
    const s2 = session!;
    if ((a[0] & 0x0c) !== 0x0c) { session = null; return sw(0x6987); }
    const nodes = decodeTlv(a.slice(5, 5 + a[4]), { recurse: false });
    const do87 = nodes.find((n) => n.tag === 0x87), do97 = nodes.find((n) => n.tag === 0x97), do8e = nodes.find((n) => n.tag === 0x8e);
    inc(s2.ssc);
    const macIn = padB(concat(s2.ssc, padB(a.slice(0, 4)), do87 ? encodeTlv(0x87, do87.value) : new Uint8Array(0), do97 ? encodeTlv(0x97, do97.value) : new Uint8Array(0)));
    if (!do8e || H(mac(s2.ksmac, macIn)) !== H(do8e.value)) { session = null; return sw(0x6988); }
    const iv = () => (aes ? nodeAes("ecb", "enc", s2.ksenc, s2.ssc) : undefined);
    const data = do87 ? unpadB(dec(s2.ksenc, do87.value.slice(1), iv())) : new Uint8Array(0);
    const r = run(a[1], a[2], a[3], data, do97 ? do97.value[0] : null);
    inc(s2.ssc);
    const r87 = r.data.length ? encodeTlv(0x87, concat(u8(0x01), enc(s2.ksenc, padB(r.data), iv()))) : new Uint8Array(0);
    const r99 = encodeTlv(0x99, sw(r.sw));
    return concat(r87, r99, encodeTlv(0x8e, mac(s2.ksmac, padB(concat(s2.ssc, r87, r99)))), sw(0x9000));
  }

  const transmit = async (cmd: Uint8Array): Promise<Uint8Array> => {
    log.push(H(cmd));
    return session ? smCommand(cmd) : plainCommand(cmd);
  };
  return { log, transport: { kind: "usb", label: "sim", connected: true, waitForCard: async () => ({ uid: u8(1, 2, 3, 4) }), transmit } as unknown as CardTransport };
}

describe("a simulated PACE chip", () => {
  for (const [name, suite] of Object.entries(SUITES)) {
    it(`opens with the CAN over ${name} and reads the document`, async () => {
      const chip = paceChip({ suite });
      const d = await readMrtd(chip.transport, { can: CAN });
      expect(d.message).toBeUndefined();
      expect(d.access).toBe("pace");
      expect(d.pace).toMatchObject({ supported: true, used: true, password: "can", parameterId: suite.param });
      expect(d.mrzInfo?.surname).toBe("ERIKSSON");
      expect(d.mrzInfo?.documentNumber).toBe("L898902C");
      expect(d.personal?.fullName).toBe("ERIKSSON, ANNA MARIA");
      expect(d.images?.map((i) => [i.kind, i.mime])).toEqual([["face", "image/jpeg"]]);
      expect(d.security?.passive).toBe("ok");
      expect(d.files?.filter((f) => f.hashOk).map((f) => f.name)).toEqual(["DG1", "DG2", "DG11"]);
      // The protocol as sent: MSE:Set AT with the CAN (83 01 02) and the parameter id, the chained GA, then only SM.
      const param = suite.param.toString(16).toUpperCase().padStart(2, "0");
      expect(chip.log.filter((l) => l.startsWith("0022C1A4"))).toEqual([expect.stringMatching(new RegExp(`830102 8401${param}$`.replace(" ", "")))]);
      const ga = chip.log.filter((l) => /^[01]086/.test(l));
      expect(ga.map((l) => l.slice(0, 2))).toEqual(["10", "10", "10", "00"]);
      const after = chip.log.slice(chip.log.indexOf(ga[3]) + 1);
      expect(after.length).toBeGreaterThan(5);
      expect(after.every((l) => l.startsWith("0C"))).toBe(true);
    });
  }

  it("opens with the MRZ when no CAN is given (83 01 01)", async () => {
    const chip = paceChip({ suite: SUITES["AES-128 / brainpoolP256r1"] });
    const d = await readMrtd(chip.transport, { mrz: MRZ });
    expect(d.access).toBe("pace");
    expect(d.pace?.password).toBe("mrz");
    expect(d.mrzInfo?.surname).toBe("ERIKSSON");
    expect(chip.log.find((l) => l.startsWith("0022C1A4"))).toContain("830101");
  });

  it("says auth-failed for a wrong CAN, and reads nothing", async () => {
    const suite = SUITES["AES-128 / brainpoolP256r1"];
    const info = parseSecurityInfos(T(0x31, T(0x30, oid(suite.oid), int(2), int(suite.param)))).pace[0];
    await expect(establishPace(paceChip({ suite }).transport, info, { kind: "can", can: "654321" })).rejects.toMatchObject({ name: "NfcError", code: "auth-failed" });
    const chip = paceChip({ suite });
    const d = await readMrtd(chip.transport, { can: "654321" });
    expect(d.access).toBe("none");
    expect(d.message).toMatch(/^PACE: the document did not accept the CAN \(SW 6300\)/);
    expect(d.mrzInfo).toBeUndefined();
    expect(chip.log.some((l) => l.startsWith("0C"))).toBe(false);
  });

  it("says auth-failed when the chip's token is wrong", async () => {
    const suite = SUITES["AES-256 / brainpoolP384r1"];
    const info = parseSecurityInfos(T(0x31, T(0x30, oid(suite.oid), int(2), int(suite.param)))).pace[0];
    await expect(establishPace(paceChip({ suite, badToken: true }).transport, info, { kind: "can", can: CAN })).rejects.toMatchObject({ code: "auth-failed" });
  });

  it("asks again without the parameter reference (84) when the chip refuses it", async () => {
    const chip = paceChip({ suite: SUITES["AES-128 / brainpoolP256r1"], reject84: true });
    const d = await readMrtd(chip.transport, { can: CAN });
    expect(d.access).toBe("pace");
    const mse = chip.log.filter((l) => l.startsWith("0022C1A4"));
    expect(mse.length).toBe(2);
    expect(mse[1]).not.toContain("84010D");
  });

  it("refuses the variants it does not run as unsupported", async () => {
    const t = paceChip({ suite: SUITES["AES-128 / brainpoolP256r1"] }).transport;
    const infos = parseSecurityInfos(T(0x31,
      T(0x30, oid("0.4.0.127.0.7.2.2.4.4.2"), int(2), int(13)), // ECDH-IM
      T(0x30, oid("0.4.0.127.0.7.2.2.4.1.2"), int(2), int(0)), // DH-GM
      T(0x30, oid("0.4.0.127.0.7.2.2.4.6.2"), int(2), int(13)), // ECDH-CAM
      T(0x30, oid("0.4.0.127.0.7.2.2.4.2.2"), int(2), int(14)), // brainpoolP320r1
      T(0x30, oid("0.4.0.127.0.7.2.2.4.2.2"), int(2)), // no parameter id
    )).pace;
    expect(infos.length).toBe(5);
    for (const info of infos) {
      expect(paceSupported(info)).toBe(false);
      await expect(establishPace(t, info, { kind: "can", can: CAN })).rejects.toMatchObject({ code: "unsupported" });
    }
    expect(choosePace(infos)).toBeNull();
  });
});
