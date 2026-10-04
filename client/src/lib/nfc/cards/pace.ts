// PACE — Password Authenticated Connection Establishment (6.6), ICAO 9303
// Part 11 §4.4 / BSI TR-03110. The holder opens their own document with the
// CAN printed on it (or the MRZ), and the chip and reader agree on session
// keys; every later APDU is wrapped in secure messaging (AES or 3DES). Like
// BAC it is the document's own access control, not a bypass — and many EU ID
// cards offer only PACE.
//
// This module reads what the chip announces (EF.CardAccess → PACEInfo) and
// runs the protocol: generic mapping over ECDH on the standardized curves
// (ec.ts), with 3DES or AES session keys. Read-only, like the rest of the
// MRTD reader. Pinned to the ICAO 9303-11 Appendix G worked example and the
// BSI TR-03110 EAC worked example (test/nfc-pace.test.ts).
//
// The four GENERAL AUTHENTICATE steps (§4.4):
//   1. the chip's nonce s, encrypted with Kπ = KDF(f(π), 3);
//   2. map it: G̃ = s·G + SK_map·PK_map(chip);
//   3. ephemeral ECDH on G̃ → shared secret K (x-coordinate) → KSenc, KSmac;
//   4. exchange tokens MAC(KSmac, 7F49 { OID, the other side's key }).

import type { CardTransport } from "../transport";
import { NfcError } from "../errors";
import { apdu, concat, decodeTlv, describeSw, encodeTlv, findTlv, hex, isOk, splitResponse, swHex, u8, type Response, type Tlv } from "./apdu";
import { fixParity, mrzInformation, type MrzKey } from "./bac";
import { pad, retailMac, tdesCbcDecrypt } from "./des";
import { aesCbcDecrypt, aesCmac } from "./aes";
import { bigIntToBytes, bytesToBigInt, decodePoint, encodePoint, PACE_CURVES, pointAdd, pointMul, randomScalar, type Curve, type Point } from "./ec";
import { aesChannel, bacChannel, type SmChannel } from "./sm";
import { der, INT, kids, OID, oidBytes, oidName, oidText, SET } from "./asn1";

export type PaceInfo = {
  /** The protocol OID, dotted. */
  oid: string;
  /** Its name ("PACE ECDH-GM AES-128"). */
  name: string;
  version: number;
  /** The standardized domain parameters (12 = NIST P-256, 13 = brainpoolP256r1…). */
  parameterId?: number;
  agreement: "DH" | "ECDH";
  mapping: "GM" | "IM" | "CAM";
  cipher: "3DES" | "AES-128" | "AES-192" | "AES-256";
};

export type PacePassword = { kind: "mrz"; key: MrzKey } | { kind: "can"; can: string };

/** The standardized domain parameters (BSI TR-03110 Part 3, Table 4). */
export const PACE_PARAMETERS: Record<number, string> = {
  0: "1024-bit MODP (160-bit subgroup)", 1: "2048-bit MODP (224-bit subgroup)", 2: "2048-bit MODP (256-bit subgroup)",
  8: "NIST P-192", 9: "brainpoolP192r1", 10: "NIST P-224", 11: "brainpoolP224r1", 12: "NIST P-256", 13: "brainpoolP256r1",
  14: "brainpoolP320r1", 15: "NIST P-384", 16: "brainpoolP384r1", 17: "brainpoolP512r1", 18: "NIST P-521",
};

const PACE_PREFIX = "0.4.0.127.0.7.2.2.4.";
const AGREEMENT: Record<string, { agreement: PaceInfo["agreement"]; mapping: PaceInfo["mapping"] }> = {
  "1": { agreement: "DH", mapping: "GM" }, "2": { agreement: "ECDH", mapping: "GM" },
  "3": { agreement: "DH", mapping: "IM" }, "4": { agreement: "ECDH", mapping: "IM" }, "6": { agreement: "ECDH", mapping: "CAM" },
};
const CIPHER: Record<string, PaceInfo["cipher"]> = { "1": "3DES", "2": "AES-128", "3": "AES-192", "4": "AES-256" };

/** What a SecurityInfos (EF.CardAccess, DG14) announces: PACE variants and every protocol, by name. */
export function parseSecurityInfos(bytes: Uint8Array): { pace: PaceInfo[]; protocols: string[] } {
  const top = der(bytes);
  const set = top.find((n) => n.tag === SET) ?? top[0];
  const pace: PaceInfo[] = [];
  const protocols: string[] = [];
  for (const info of kids(set)) {
    const k = kids(info);
    if (!k[0] || k[0].tag !== OID) continue;
    const oid = oidText(k[0].value);
    const name = oidName(oid);
    if (!protocols.includes(name)) protocols.push(name);
    if (!oid.startsWith(PACE_PREFIX)) continue;
    const [kind, suite] = oid.slice(PACE_PREFIX.length).split(".");
    const a = AGREEMENT[kind], c = CIPHER[suite];
    if (!a || !c) continue; // PACE domain parameter info, or something newer
    const version = k[1] && k[1].tag === INT ? k[1].value[k[1].value.length - 1] ?? 0 : 0;
    const param = k[2] && k[2].tag === INT ? k[2].value.reduce((n, b) => n * 256 + b, 0) : undefined;
    pace.push({ oid, name, version, ...(param !== undefined ? { parameterId: param } : {}), ...a, cipher: c });
  }
  return { pace, protocols };
}

/** Whether this reader can run a PACE variant: generic mapping over ECDH on a standardized curve it knows (ec.ts). */
export function paceSupported(info: PaceInfo): boolean {
  return info.mapping === "GM" && info.agreement === "ECDH" && info.parameterId !== undefined && info.parameterId in PACE_CURVES;
}

/** The variant to use: the strongest one this reader runs. */
export function choosePace(infos: PaceInfo[]): PaceInfo | null {
  const ok = infos.filter(paceSupported);
  const rank = (i: PaceInfo) => ["3DES", "AES-128", "AES-192", "AES-256"].indexOf(i.cipher);
  ok.sort((a, b) => rank(b) - rank(a));
  return ok[0] ?? null;
}

/* ------------------------------------------------------------ the keys */

export type PaceCipher = PaceInfo["cipher"];

async function digest(alg: "SHA-1" | "SHA-256", data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(alg, data as unknown as ArrayBuffer));
}

/**
 * f(π), the password's encoding (ICAO 9303-11 Table 14): the CAN as its
 * ISO 8859-1 characters; the MRZ as SHA-1 of its MRZ information (document
 * number, date of birth, date of expiry, each with its check digit) — all 20
 * bytes, unlike BAC's 16-byte seed.
 */
export async function paceSecret(password: PacePassword): Promise<Uint8Array> {
  if (password.kind === "can") return Uint8Array.from(Array.from(password.can, (ch) => ch.charCodeAt(0) & 0xff));
  return digest("SHA-1", new TextEncoder().encode(mrzInformation(password.key)));
}

/**
 * KDF(K, c) = H(K || c) with c a 32-bit big-endian counter (§9.7.1): SHA-1
 * → 16 bytes for 3DES (DES parity set) and AES-128; SHA-256 → 24 / 32 bytes
 * for AES-192 / AES-256. c = 1: KSenc, 2: KSmac, 3: Kπ.
 */
export async function paceKdf(secret: Uint8Array, counter: number, cipher: PaceCipher): Promise<Uint8Array> {
  const input = concat(secret, [counter >>> 24, (counter >> 16) & 0xff, (counter >> 8) & 0xff, counter & 0xff]);
  if (cipher === "3DES") return fixParity((await digest("SHA-1", input)).slice(0, 16));
  if (cipher === "AES-128") return (await digest("SHA-1", input)).slice(0, 16);
  return (await digest("SHA-256", input)).slice(0, cipher === "AES-192" ? 24 : 32);
}

/** Kπ = KDF(f(π), 3): the key the chip's nonce is encrypted with. */
export async function passwordKey(password: PacePassword, cipher: PaceCipher): Promise<Uint8Array> {
  return paceKdf(await paceSecret(password), 3, cipher);
}

/** s = D(Kπ, z): CBC, zero IV, no padding (z is a whole number of blocks). */
export function decryptNonce(cipher: PaceCipher, kpi: Uint8Array, z: Uint8Array): Uint8Array {
  const block = cipher === "3DES" ? 8 : 16;
  if (!z.length || z.length % block) throw new NfcError("protocol", `the encrypted nonce is ${z.length} bytes, not whole ${block}-byte blocks`);
  return cipher === "3DES" ? tdesCbcDecrypt(kpi, z) : aesCbcDecrypt(kpi, z);
}

/** The generic mapping (§4.4.3.3.1): H = SK_map·PK_map(chip), G̃ = s·G + H. */
export function mapNonce(curve: Curve, s: Uint8Array, skMap: bigint, pkMapChip: Point): { H: Point; G: Point } {
  const H = pointMul(curve, skMap, pkMapChip);
  const G = H && pointAdd(curve, pointMul(curve, bytesToBigInt(s)), H);
  if (!H || !G) throw new NfcError("protocol", "the mapped generator is the point at infinity");
  return { H, G };
}

/**
 * An authentication token (§4.4.3.4): the MAC under KSmac of the public key
 * data object 7F49 { 06 protocol OID, 86 ephemeral public point } — AES-CMAC
 * cut to 8 bytes, or for 3DES the retail MAC over the M2-padded input.
 */
export function authToken(cipher: PaceCipher, ksmac: Uint8Array, oid: string, publicKey: Uint8Array): Uint8Array {
  const data = encodeTlv(0x7f49, concat(encodeTlv(0x06, oidBytes(oid)), encodeTlv(0x86, publicKey)));
  return cipher === "3DES" ? retailMac(ksmac, pad(data)) : aesCmac(ksmac, data).slice(0, 8);
}

/* ------------------------------------------------------------ the protocol */

export type PaceOptions = {
  /** Fixed ephemeral private keys (mapping, key agreement) — only to replay a worked example; random otherwise. */
  ephemeral?: { map: bigint; agreement: bigint };
};

const passwordName = (p: PacePassword) => (p.kind === "can" ? "CAN" : "MRZ");

/** MSE:Set AT accepted: 9000, or 63Cx — a password retry counter some cards report, the protocol still selected. */
const selected = (sw: number) => isOk(sw) || ((sw & 0xfff0) === 0x63c0 && (sw & 0x0f) > 0);

/** The data objects inside a GENERAL AUTHENTICATE answer's 7C. */
function dynamicData(r: Response, step: string): Tlv[] {
  let nodes: Tlv[] = [];
  try { nodes = decodeTlv(r.data, { recurse: true }); } catch { /* below */ }
  const dyn = findTlv(nodes, 0x7c);
  if (!dyn) throw new NfcError("protocol", `${step}: the answer carries no dynamic authentication data (7C)`);
  return dyn.children ?? [];
}

/**
 * Runs PACE with the holder's CAN or MRZ and returns the secure-messaging
 * channel (SSC zero). Throws NfcError("auth-failed") when the chip refuses the
 * password (63xx, or its token does not verify), NfcError("unsupported") for a
 * variant this reader does not run.
 */
export async function establishPace(t: CardTransport, info: PaceInfo, password: PacePassword, opts: PaceOptions = {}): Promise<SmChannel> {
  if (!paceSupported(info)) {
    const param = info.parameterId !== undefined ? ` (${PACE_PARAMETERS[info.parameterId] ?? `parameters ${info.parameterId}`})` : "";
    throw new NfcError("unsupported", `${info.name}${param} is not a variant this reader runs — only the generic mapping over ECDH on the standardized curves`);
  }
  const curve = PACE_CURVES[info.parameterId!];
  const { cipher } = info;
  const exchange = async (cmd: Uint8Array): Promise<Response> => splitResponse(await t.transmit(cmd));
  /** One GENERAL AUTHENTICATE of the chain (CLA 10 while more follow). */
  const authenticate = async (dos: Uint8Array, step: string, last = false): Promise<Tlv[]> => {
    const r = await exchange(apdu(last ? 0x00 : 0x10, 0x86, 0x00, 0x00, encodeTlv(0x7c, dos), 0));
    if (!isOk(r.sw)) {
      const refused = last || r.sw >> 8 === 0x63 || r.sw === 0x6983 || r.sw === 0x6984;
      throw new NfcError(refused ? "auth-failed" : "card-error",
        refused ? `the document did not accept the ${passwordName(password)} (SW ${swHex(r.sw)})` : `${step}: ${describeSw(r.sw)} (SW ${swHex(r.sw)})`, swHex(r.sw));
    }
    return dynamicData(r, step);
  };

  // MSE:Set AT — the protocol (80), the password (83: 01 MRZ, 02 CAN) and the
  // domain parameters (84). 84 is optional; a chip that refuses it is asked again without.
  const mse = concat(encodeTlv(0x80, oidBytes(info.oid)), encodeTlv(0x83, u8(password.kind === "mrz" ? 0x01 : 0x02)));
  let set = await exchange(apdu(0x00, 0x22, 0xc1, 0xa4, concat(mse, encodeTlv(0x84, u8(info.parameterId!)))));
  if (!selected(set.sw)) set = await exchange(apdu(0x00, 0x22, 0xc1, 0xa4, mse));
  if (!selected(set.sw)) {
    if (set.sw === 0x6a88) throw new NfcError("unsupported", `the document does not take the ${passwordName(password)} for PACE (SW 6A88)`, "6A88");
    throw new NfcError("card-error", `the document refused ${info.name} — ${describeSw(set.sw)} (SW ${swHex(set.sw)})`, swHex(set.sw));
  }

  // 1. The encrypted nonce.
  const kpi = await passwordKey(password, cipher);
  const z = findTlv(await authenticate(new Uint8Array(0), "encrypted nonce"), 0x80)?.value;
  if (!z) throw new NfcError("protocol", "no encrypted nonce (80) in the answer");
  const s = decryptNonce(cipher, kpi, z);

  // 2. Map the nonce to a new generator.
  const skMap = opts.ephemeral?.map ?? randomScalar(curve);
  const pkMap = pointMul(curve, skMap)!;
  const mapped = findTlv(await authenticate(encodeTlv(0x81, encodePoint(curve, pkMap)), "map nonce"), 0x82)?.value;
  const pkMapChip = mapped ? decodePoint(curve, mapped) : null;
  if (!pkMapChip) throw new NfcError("protocol", "the document's mapping key is not a point of the curve");
  const { G } = mapNonce(curve, s, skMap, pkMapChip);

  // 3. Key agreement on G̃.
  const sk = opts.ephemeral?.agreement ?? randomScalar(curve);
  const pkPcd = encodePoint(curve, pointMul(curve, sk, G)!);
  const pkChipBytes = findTlv(await authenticate(encodeTlv(0x83, pkPcd), "key agreement"), 0x84)?.value;
  const pkChip = pkChipBytes ? decodePoint(curve, pkChipBytes) : null;
  if (!pkChip || !pkChipBytes || hex(pkChipBytes) === hex(pkPcd)) throw new NfcError("protocol", "the document's ephemeral key is invalid");
  const shared = pointMul(curve, sk, pkChip);
  if (!shared) throw new NfcError("protocol", "the shared secret is the point at infinity");
  const k = bigIntToBytes(shared.x, curve.size);
  const ksenc = await paceKdf(k, 1, cipher);
  const ksmac = await paceKdf(k, 2, cipher);

  // 4. Mutual authentication: our token over the chip's key, theirs over ours.
  const answer = await authenticate(encodeTlv(0x85, authToken(cipher, ksmac, info.oid, pkChipBytes)), "mutual authentication", true);
  const tChip = findTlv(answer, 0x86)?.value;
  if (!tChip || hex(tChip) !== hex(authToken(cipher, ksmac, info.oid, pkPcd))) {
    throw new NfcError("auth-failed", "the document's authentication token did not verify");
  }

  // Secure messaging from here, the SSC starting at zero (§9.8.6.3, §9.8.7.3).
  return cipher === "3DES" ? bacChannel(t, { ksenc, ksmac, ssc: new Uint8Array(8) }, "pace") : aesChannel(t, { ksenc, ksmac, ssc: new Uint8Array(16) });
}
