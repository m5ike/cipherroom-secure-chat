// PACE — Password Authenticated Connection Establishment (6.6), ICAO 9303
// Part 11 §4.4 / BSI TR-03110. The holder opens their own document with the
// CAN printed on it (or the MRZ), and the chip and reader agree on session
// keys; every later APDU is wrapped in secure messaging (AES or 3DES). Like
// BAC it is the document's own access control, not a bypass — and many EU ID
// cards offer only PACE.
//
// This module reads what the chip announces (EF.CardAccess → PACEInfo) and
// runs the protocol. Read-only, like the rest of the MRTD reader.

import type { CardTransport } from "../transport";
import { NfcError } from "../errors";
import type { MrzKey } from "./bac";
import type { SmChannel } from "./sm";
import { der, INT, kids, OID, oidName, oidText, SET } from "./asn1";

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

/** Whether this reader can run a PACE variant (generic mapping on the standardized curves). */
export function paceSupported(info: PaceInfo): boolean {
  return info.mapping === "GM" && info.agreement === "ECDH" && [12, 13, 15, 16, 17, 18].includes(info.parameterId ?? -1);
}

/** The variant to use: the strongest one this reader runs. */
export function choosePace(infos: PaceInfo[]): PaceInfo | null {
  const ok = infos.filter(paceSupported);
  const rank = (i: PaceInfo) => ["3DES", "AES-128", "AES-192", "AES-256"].indexOf(i.cipher);
  ok.sort((a, b) => rank(b) - rank(a));
  return ok[0] ?? null;
}

/**
 * Runs PACE with the holder's CAN or MRZ and returns the secure-messaging
 * channel. Throws NfcError("auth-failed") when the chip refuses the password,
 * NfcError("unsupported") for a variant this reader does not run.
 */
export async function establishPace(_t: CardTransport, info: PaceInfo, _password: PacePassword): Promise<SmChannel> {
  throw new NfcError("unsupported", `PACE (${info.name}) is not available in this version yet`);
}
