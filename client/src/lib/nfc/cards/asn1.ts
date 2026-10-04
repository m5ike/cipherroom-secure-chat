// Small DER helpers (6.6) for the travel-document security objects — EF.SOD
// (a CMS SignedData), DG14 / EF.CardAccess (SecurityInfos), DG15 (a public
// key) and the document signer's X.509 certificate. Reading only: names,
// dates, OIDs, hashes. Nothing here verifies a signature.

import { decodeTlv, hex, type Tlv } from "./apdu";

export const SEQ = 0x30;
export const SET = 0x31;
export const OID = 0x06;
export const INT = 0x02;
export const OCTETS = 0x04;
export const BITS = 0x03;

/** DER children of a node (an OCTET STRING / BIT STRING holding DER is parsed on demand). */
export function kids(n: Tlv | undefined): Tlv[] {
  if (!n) return [];
  if (n.children) return n.children;
  try { return decodeTlv(n.tag === BITS ? n.value.slice(1) : n.value, { recurse: true }); } catch { return []; }
}

/** Parses DER, tolerating trailing garbage. */
export function der(bytes: Uint8Array): Tlv[] {
  try { return decodeTlv(bytes, { recurse: true }); } catch { return []; }
}

/** An OBJECT IDENTIFIER's value → dotted text. */
export function oidText(v: Uint8Array): string {
  if (!v.length) return "";
  const parts: number[] = [Math.floor(v[0] / 40), v[0] % 40];
  let n = 0;
  for (let i = 1; i < v.length; i++) {
    n = n * 128 + (v[i] & 0x7f);
    if (!(v[i] & 0x80)) { parts.push(n); n = 0; }
  }
  return parts.join(".");
}

/** Dotted text → an OBJECT IDENTIFIER's value bytes. */
export function oidBytes(text: string): Uint8Array {
  const p = text.split(".").map((x) => Number(x));
  const out: number[] = [p[0] * 40 + p[1]];
  for (const n of p.slice(2)) {
    const enc: number[] = [n & 0x7f];
    let v = Math.floor(n / 128);
    while (v > 0) { enc.unshift((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
    out.push(...enc);
  }
  return Uint8Array.from(out);
}

export function intValue(v: Uint8Array): number {
  let n = 0;
  for (const b of v.slice(-6)) n = n * 256 + b;
  return n;
}

/** Well-known OIDs the travel documents use. */
export const OID_NAMES: Record<string, string> = {
  "1.3.14.3.2.26": "SHA-1",
  "2.16.840.1.101.3.4.2.4": "SHA-224",
  "2.16.840.1.101.3.4.2.1": "SHA-256",
  "2.16.840.1.101.3.4.2.2": "SHA-384",
  "2.16.840.1.101.3.4.2.3": "SHA-512",
  "1.2.840.113549.1.1.1": "RSA",
  "1.2.840.10045.2.1": "EC",
  "1.2.840.113549.1.7.2": "CMS signed data",
  "2.23.136.1.1.1": "LDS security object",
  "2.23.136.1.1.5": "Active Authentication",
  "0.4.0.127.0.7.2.2.1.1": "Chip Authentication key (DH)",
  "0.4.0.127.0.7.2.2.1.2": "Chip Authentication key (ECDH)",
  "0.4.0.127.0.7.2.2.2": "Terminal Authentication",
  "0.4.0.127.0.7.2.2.3.1.1": "Chip Authentication (DH, 3DES)",
  "0.4.0.127.0.7.2.2.3.1.2": "Chip Authentication (DH, AES-128)",
  "0.4.0.127.0.7.2.2.3.1.3": "Chip Authentication (DH, AES-192)",
  "0.4.0.127.0.7.2.2.3.1.4": "Chip Authentication (DH, AES-256)",
  "0.4.0.127.0.7.2.2.3.2.1": "Chip Authentication (ECDH, 3DES)",
  "0.4.0.127.0.7.2.2.3.2.2": "Chip Authentication (ECDH, AES-128)",
  "0.4.0.127.0.7.2.2.3.2.3": "Chip Authentication (ECDH, AES-192)",
  "0.4.0.127.0.7.2.2.3.2.4": "Chip Authentication (ECDH, AES-256)",
  "0.4.0.127.0.7.2.2.4.1.1": "PACE DH-GM 3DES",
  "0.4.0.127.0.7.2.2.4.1.2": "PACE DH-GM AES-128",
  "0.4.0.127.0.7.2.2.4.1.3": "PACE DH-GM AES-192",
  "0.4.0.127.0.7.2.2.4.1.4": "PACE DH-GM AES-256",
  "0.4.0.127.0.7.2.2.4.2.1": "PACE ECDH-GM 3DES",
  "0.4.0.127.0.7.2.2.4.2.2": "PACE ECDH-GM AES-128",
  "0.4.0.127.0.7.2.2.4.2.3": "PACE ECDH-GM AES-192",
  "0.4.0.127.0.7.2.2.4.2.4": "PACE ECDH-GM AES-256",
  "0.4.0.127.0.7.2.2.4.3.1": "PACE DH-IM 3DES",
  "0.4.0.127.0.7.2.2.4.3.2": "PACE DH-IM AES-128",
  "0.4.0.127.0.7.2.2.4.3.3": "PACE DH-IM AES-192",
  "0.4.0.127.0.7.2.2.4.3.4": "PACE DH-IM AES-256",
  "0.4.0.127.0.7.2.2.4.4.1": "PACE ECDH-IM 3DES",
  "0.4.0.127.0.7.2.2.4.4.2": "PACE ECDH-IM AES-128",
  "0.4.0.127.0.7.2.2.4.4.3": "PACE ECDH-IM AES-192",
  "0.4.0.127.0.7.2.2.4.4.4": "PACE ECDH-IM AES-256",
  "0.4.0.127.0.7.2.2.4.6.2": "PACE ECDH-CAM AES-128",
  "0.4.0.127.0.7.2.2.4.6.3": "PACE ECDH-CAM AES-192",
  "0.4.0.127.0.7.2.2.4.6.4": "PACE ECDH-CAM AES-256",
  "0.4.0.127.0.7.2.2.5": "Restricted Identification",
  "0.4.0.127.0.7.2.2.6": "Card info",
  "0.4.0.127.0.7.2.2.12": "PACE domain parameters",
  "1.2.840.10045.3.1.7": "NIST P-256",
  "1.3.132.0.34": "NIST P-384",
  "1.3.132.0.35": "NIST P-521",
  "1.3.36.3.3.2.8.1.1.7": "brainpoolP256r1",
  "1.3.36.3.3.2.8.1.1.11": "brainpoolP384r1",
  "1.3.36.3.3.2.8.1.1.13": "brainpoolP512r1",
  "2.5.4.3": "CN", "2.5.4.6": "C", "2.5.4.7": "L", "2.5.4.8": "ST", "2.5.4.10": "O", "2.5.4.11": "OU", "2.5.4.5": "serialNumber",
};

export const oidName = (oid: string) => OID_NAMES[oid] ?? oid;

/** An X.500 Name → "CN=…, O=…, C=…". */
export function nameText(n: Tlv | undefined): string {
  const parts: string[] = [];
  for (const rdn of kids(n)) {
    for (const atv of kids(rdn)) {
      const [type, value] = kids(atv);
      if (!type || !value) continue;
      parts.push(`${oidName(oidText(type.value))}=${new TextDecoder().decode(value.value)}`);
    }
  }
  return parts.join(", ");
}

/** UTCTime / GeneralizedTime → YYYY-MM-DD. */
export function timeText(n: Tlv | undefined): string {
  if (!n) return "";
  const s = new TextDecoder().decode(n.value);
  if (n.tag === 0x17 && /^\d{6}/.test(s)) { const yy = Number(s.slice(0, 2)); return `${yy < 50 ? 2000 + yy : 1900 + yy}-${s.slice(2, 4)}-${s.slice(4, 6)}`; }
  if (/^\d{8}/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s;
}

/** The interesting parts of an X.509 certificate. */
export function certInfo(cert: Tlv | undefined): { subject?: string; issuer?: string; serial?: string; notBefore?: string; notAfter?: string } {
  const tbs = kids(cert)[0];
  if (!tbs) return {};
  let k = kids(tbs);
  if (k[0] && k[0].tag === 0xa0) k = k.slice(1); // [0] version
  const [serial, , issuer, validity, subject] = k;
  const [nb, na] = kids(validity);
  return { serial: serial ? hex(serial.value).toUpperCase() : undefined, issuer: nameText(issuer), subject: nameText(subject), notBefore: timeText(nb), notAfter: timeText(na) };
}
