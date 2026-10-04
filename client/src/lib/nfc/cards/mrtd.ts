// MRTD reader (6.5, deep read 6.6) — e-passport / e-ID, ICAO 9303. Opens the
// holder's own document with the key they supply — PACE with the CAN printed
// on it (or the MRZ), else BAC with the MRZ: the document's own access
// control — then reads, over secure messaging, everything a border reader may
// read: EF.COM (the data groups present), EF.SOD (their hashes and the
// document signer), DG1 (the MRZ), DG2 (the face), DG5 / DG7 (portrait,
// signature), DG11 / DG12 (more personal and document details), DG13, DG14
// (security protocols), DG15 (the Active Authentication key), DG16 (persons to
// notify). DG3 / DG4 (fingerprints, iris) need Extended Access Control — a
// government terminal certificate — and are left alone. Read-only: it never
// writes. Each group read is checked against its hash in EF.SOD (passive
// authentication of what was read; the signer is not checked against a CSCA list).

import type { CardTransport } from "../transport";
import { apdu, concat, decodeTlv, findAllTlv, findTlv, hex, isOk, ISO, splitResponse, type Response, type Tlv } from "./apdu";
import { bacKeys, mrzKeyFromMrz, mutualAuthCommand, sessionFromAuth, type MrzKey } from "./bac";
import { bacChannel, type SmChannel } from "./sm";
import { BITS, certInfo, der, kids, OCTETS, OID, oidName, oidText, SEQ } from "./asn1";
import { choosePace, establishPace, parseSecurityInfos, PACE_PARAMETERS, type PaceInfo } from "./pace";
import type { CardFile, MrtdData, MrtdDocument, MrtdFileInfo, MrtdImage, MrtdMrz, MrtdPersonal } from "../command";

const MRTD_AID = Uint8Array.from([0xa0, 0x00, 0x00, 0x02, 0x47, 0x10, 0x01]);
const EF = { cardAccess: 0x011c, com: 0x011e, sod: 0x011d };
const dgFid = (n: number) => 0x0100 + n;

/** EF.COM tag-list byte → data group. */
const DG_TAG: Record<number, number> = { 0x61: 1, 0x75: 2, 0x63: 3, 0x76: 4, 0x65: 5, 0x66: 6, 0x67: 7, 0x68: 8, 0x69: 9, 0x6a: 10, 0x6b: 11, 0x6c: 12, 0x6d: 13, 0x6e: 14, 0x6f: 15, 0x70: 16 };
/** How much of each group to read at most (the face can be large; the rest is small). */
const CAP: Record<number, number> = { 1: 512, 2: 98_304, 5: 98_304, 7: 65_536, 11: 65_536, 12: 131_072, 13: 32_768, 14: 8192, 15: 4096, 16: 16_384 };
/** Groups that hold only pictures. */
const IMAGE_GROUPS = new Set([2, 5, 7]);
/** Fingerprints and iris: Extended Access Control (a terminal certificate), not readable here. */
const EAC_GROUPS = new Set([3, 4]);

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

async function plain(t: CardTransport, cmd: Uint8Array): Promise<Response> {
  return splitResponse(await t.transmit(cmd));
}

const readable = (sw: number) => isOk(sw) || sw === 0x6282; // 6282: end of file before Le

/* ------------------------------------------------------------------ BAC */

async function doBac(t: CardTransport, key: MrzKey): Promise<SmChannel> {
  const { kenc, kmac } = await bacKeys(key);
  const chal = await plain(t, apdu(0x00, 0x84, 0x00, 0x00, undefined, 8)); // GET CHALLENGE
  if (!isOk(chal.sw) || chal.data.length < 8) throw new Error("the document did not answer GET CHALLENGE");
  const rndIcc = chal.data.slice(0, 8);
  const rndIfd = randomBytes(8);
  const kifd = randomBytes(16);
  const cmdData = mutualAuthCommand(kenc, kmac, rndIfd, rndIcc, kifd);
  const auth = await plain(t, apdu(0x00, 0x82, 0x00, 0x00, cmdData, 0x28)); // EXTERNAL AUTHENTICATE
  if (!isOk(auth.sw)) throw new Error("BAC failed — check the document number, date of birth and expiry");
  return bacChannel(t, await sessionFromAuth(kenc, kmac, rndIfd, rndIcc, kifd, auth.data));
}

/* ------------------------------------------------------------ reading files */

/** The length of a BER-TLV object from its first bytes (tag + length). */
function derLength(head: Uint8Array): { headerLen: number; total: number } | null {
  if (head.length < 2) return null;
  let i = 1;
  if ((head[0] & 0x1f) === 0x1f) { while (i < head.length && (head[i] & 0x80)) i++; i++; }
  if (i >= head.length) return null;
  let len = head[i++];
  if (len & 0x80) { const n = len & 0x7f; len = 0; for (let j = 0; j < n && i < head.length; j++) len = (len << 8) | head[i++]; }
  return { headerLen: i, total: i + len };
}

type Sender = (cmd: Uint8Array) => Promise<{ data: Uint8Array; sw: number }>;
type FileRead = { bytes: Uint8Array; complete: boolean } | { sw: number };

/** READ BINARY beyond 32 KB: INS B1 with the offset in DO 54, the data in DO 53. */
async function readBinaryAt(send: Sender, offset: number, le: number): Promise<{ data: Uint8Array; sw: number }> {
  if (offset < 0x8000) return send(ISO.readBinary(offset, le));
  const off = Uint8Array.from([0x54, 0x03, (offset >> 16) & 0xff, (offset >> 8) & 0xff, offset & 0xff]);
  const r = await send(apdu(0x00, 0xb1, 0x00, 0x00, off, le));
  const do53 = r.data.length ? findTlv(decodeTlv(r.data, { recurse: false }), 0x53) : undefined;
  return { data: do53 ? do53.value : r.data, sw: r.sw };
}

/** Selects an EF (by file id) and reads all of it, up to `cap` bytes. */
async function readFile(send: Sender, fid: number, cap: number): Promise<FileRead> {
  const sel = await send(apdu(0x00, 0xa4, 0x02, 0x0c, Uint8Array.from([fid >> 8, fid & 0xff])));
  if (!isOk(sel.sw)) return { sw: sel.sw };
  const head = await send(ISO.readBinary(0, 8));
  if (!readable(head.sw) || head.data.length === 0) return { sw: head.sw || 0x6f00 };
  const info = derLength(head.data);
  const want = info ? info.total : head.data.length;
  const total = Math.min(want, cap);
  const chunks: Uint8Array[] = [head.data.slice(0, Math.min(head.data.length, total))];
  let offset = chunks[0].length;
  let guard = 0;
  while (offset < total && guard++ < 1024) {
    const r = await readBinaryAt(send, offset, Math.min(0xe0, total - offset));
    if (!readable(r.sw) || r.data.length === 0) break;
    chunks.push(r.data);
    offset += r.data.length;
  }
  const bytes = concat(...chunks);
  return { bytes, complete: bytes.length >= want };
}

function statusOf(sw: number): MrtdFileInfo["status"] {
  if (sw === 0x6a82 || sw === 0x6a83) return "absent";
  if (sw === 0x6982 || sw === 0x6985 || sw === 0x6986) return "protected";
  return "error";
}

/* ------------------------------------------------------------ parsing */

function datesFromYYMMDD(s: string, future: boolean): string {
  if (!/^\d{6}$/.test(s)) return s;
  const yy = parseInt(s.slice(0, 2), 10);
  const nowYY = new Date().getFullYear() % 100;
  const century = future ? (yy < nowYY + 20 ? 2000 : 1900) : (yy <= nowYY ? 2000 : 1900);
  return `${century + yy}-${s.slice(2, 4)}-${s.slice(4, 6)}`;
}

/** Parses a TD1/TD2/TD3 MRZ string into fields. */
export function parseMrz(mrz: string): MrtdMrz {
  const raw = mrz.replace(/[^A-Z0-9<\n]/gi, "").toUpperCase();
  const out: MrtdMrz = { mrz: raw };
  const names = (field: string) => {
    const [surname = "", given = ""] = field.split("<<");
    return { surname: surname.replace(/</g, " ").trim(), givenNames: given.replace(/</g, " ").trim() };
  };
  // TD3 (passport): 2×44.
  if (raw.length === 88 || raw.replace(/\n/g, "").length === 88) {
    const flat = raw.replace(/\n/g, "");
    const l1 = flat.slice(0, 44), l2 = flat.slice(44, 88);
    out.documentCode = l1.slice(0, 2).replace(/</g, "");
    out.issuer = l1.slice(2, 5).replace(/</g, "");
    Object.assign(out, names(l1.slice(5)));
    out.documentNumber = l2.slice(0, 9).replace(/</g, "");
    out.nationality = l2.slice(10, 13).replace(/</g, "");
    out.dateOfBirth = datesFromYYMMDD(l2.slice(13, 19), false);
    out.sex = l2.slice(20, 21).replace(/</g, "");
    out.dateOfExpiry = datesFromYYMMDD(l2.slice(21, 27), true);
    out.optionalData = l2.slice(28, 42).replace(/<+$/, "").replace(/</g, "");
    return out;
  }
  // TD1 (ID card): 3×30.
  const flat = raw.replace(/\n/g, "");
  if (flat.length === 90) {
    const l1 = flat.slice(0, 30), l2 = flat.slice(30, 60), l3 = flat.slice(60, 90);
    out.documentCode = l1.slice(0, 2).replace(/</g, "");
    out.issuer = l1.slice(2, 5).replace(/</g, "");
    out.documentNumber = l1.slice(5, 14).replace(/</g, "");
    out.optionalData = l1.slice(15, 30).replace(/<+$/, "").replace(/</g, "");
    out.dateOfBirth = datesFromYYMMDD(l2.slice(0, 6), false);
    out.sex = l2.slice(7, 8).replace(/</g, "");
    out.dateOfExpiry = datesFromYYMMDD(l2.slice(8, 14), true);
    out.nationality = l2.slice(15, 18).replace(/</g, "");
    Object.assign(out, names(l3));
    return out;
  }
  // TD2 (ID card): 2×36.
  if (flat.length === 72) {
    const l1 = flat.slice(0, 36), l2 = flat.slice(36, 72);
    out.documentCode = l1.slice(0, 2).replace(/</g, "");
    out.issuer = l1.slice(2, 5).replace(/</g, "");
    Object.assign(out, names(l1.slice(5)));
    out.documentNumber = l2.slice(0, 9).replace(/</g, "");
    out.nationality = l2.slice(10, 13).replace(/</g, "");
    out.dateOfBirth = datesFromYYMMDD(l2.slice(13, 19), false);
    out.sex = l2.slice(20, 21).replace(/</g, "");
    out.dateOfExpiry = datesFromYYMMDD(l2.slice(21, 27), true);
    return out;
  }
  return out;
}

export function mrzFromDg1(dg1: Uint8Array): MrtdMrz | null {
  const tlv = decodeTlv(dg1, { recurse: true });
  const mrz = findTlv(tlv, 0x5f1f) ?? findTlv(findTlv(tlv, 0x61)?.children ?? [], 0x5f1f);
  if (!mrz) return null;
  return parseMrz(new TextDecoder().decode(mrz.value));
}

/** EF.COM: the data groups its tag list (5C) names, and the LDS / Unicode versions. */
export function parseCom(com: Uint8Array): { groups: number[]; lds?: string; unicode?: string } {
  const tlv = decodeTlv(com, { recurse: true });
  const list = findTlv(tlv, 0x5c)?.value;
  const groups = list ? Array.from(list).map((t) => DG_TAG[t]).filter((n): n is number => n !== undefined) : [];
  const ascii = (v?: Uint8Array) => (v ? new TextDecoder().decode(v) : undefined);
  const lds = ascii(findTlv(tlv, 0x5f01)?.value), uni = ascii(findTlv(tlv, 0x5f36)?.value);
  return { groups, ...(lds ? { lds: lds.length === 4 ? `${Number(lds.slice(0, 2))}.${Number(lds.slice(2))}` : lds } : {}), ...(uni ? { unicode: uni.length === 6 ? `${Number(uni.slice(0, 2))}.${Number(uni.slice(2, 4))}.${Number(uni.slice(4))}` : uni } : {}) };
}

/** The data groups EF.COM lists in its tag-presence list (5C). */
export function dataGroupsFromCom(com: Uint8Array): string[] {
  return parseCom(com).groups.map((n) => `DG${n}`);
}

/** An image found by its signature inside a data object (JPEG, JPEG 2000, PNG). */
export function imageIn(bytes: Uint8Array): { mime: string; data: Uint8Array } | null {
  for (let i = 0; i + 5 < bytes.length; i++) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd8 && bytes[i + 2] === 0xff) return { mime: "image/jpeg", data: bytes.slice(i) };
    if (bytes[i] === 0x00 && bytes[i + 1] === 0x00 && bytes[i + 2] === 0x00 && bytes[i + 3] === 0x0c && bytes[i + 4] === 0x6a && bytes[i + 5] === 0x50) return { mime: "image/jp2", data: bytes.slice(i) };
    if (bytes[i] === 0xff && bytes[i + 1] === 0x4f && bytes[i + 2] === 0xff && bytes[i + 3] === 0x51) return { mime: "image/jp2", data: bytes.slice(i) }; // JPEG 2000 codestream
    if (bytes[i] === 0x89 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x4e && bytes[i + 3] === 0x47) return { mime: "image/png", data: bytes.slice(i) };
  }
  return null;
}

/** Pulls the face image out of DG2 by its signature (JPEG or JPEG 2000). */
export function faceFromDg2(dg2: Uint8Array): { mime: string; data: Uint8Array } | null {
  const all = facesFromDg2(dg2);
  return all[0] ?? imageIn(dg2);
}

/** Every face in DG2 (each biometric data block, 5F2E / 7F2E). */
export function facesFromDg2(dg2: Uint8Array): Array<{ mime: string; data: Uint8Array }> {
  let nodes: Tlv[] = [];
  try { nodes = decodeTlv(dg2, { recurse: true }); } catch { /* not TLV: below */ }
  const blocks = [...findAllTlv(nodes, 0x5f2e), ...findAllTlv(nodes, 0x7f2e)];
  const out = blocks.map((b) => imageIn(b.value)).filter((x): x is { mime: string; data: Uint8Array } => x !== null);
  if (!out.length) { const one = imageIn(dg2); if (one) out.push(one); }
  return out;
}

const utf8 = (v: Uint8Array) => {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(v).trim(); }
  catch { return Array.from(v).map((c) => String.fromCharCode(c)).join("").trim(); }
};
const mrzText = (s: string) => s.replace(/<<+/g, ", ").replace(/</g, " ").replace(/\s+/g, " ").trim();
/** A date that may be BCD (YYYYMMDD in 4 bytes) or ASCII digits. */
function dateField(v: Uint8Array): string {
  const s = v.length === 4 || v.length === 7 ? hex(v) : utf8(v);
  if (/^\d{14}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}`;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s;
}

type Found = { images: MrtdImage[] };
const extOf = (mime: string) => (mime === "image/jpeg" ? "jpg" : mime === "image/jp2" ? "jp2" : mime === "image/png" ? "png" : "bin");

function pushImage(found: Found, group: number, kind: MrtdImage["kind"], bytes: Uint8Array, label: string): void {
  const img = imageIn(bytes);
  if (!img) return;
  const n = found.images.filter((i) => i.kind === kind).length;
  found.images.push({ group: `DG${group}`, kind, mime: img.mime, data: toBase64(img.data), name: `${label}${n ? `-${n + 1}` : ""}.${extOf(img.mime)}` });
}

/** DG11: additional personal details. */
export function parseDg11(dg: Uint8Array, found?: Found): MrtdPersonal {
  const t = decodeTlv(dg, { recurse: true });
  const out: MrtdPersonal = {};
  const v = (tag: number) => findTlv(t, tag)?.value;
  const s = (tag: number) => { const x = v(tag); return x && x.length ? utf8(x) : undefined; };
  const full = s(0x5f0e); if (full) out.fullName = mrzText(full);
  const others = findAllTlv(t, 0x5f0f).map((n) => mrzText(utf8(n.value))).filter(Boolean); if (others.length) out.otherNames = others;
  const pn = s(0x5f10); if (pn) out.personalNumber = pn.replace(/</g, "");
  const dob = v(0x5f2b); if (dob && dob.length) out.fullDateOfBirth = dateField(dob);
  const pob = s(0x5f11); if (pob) out.placeOfBirth = mrzText(pob);
  const addr = s(0x5f42); if (addr) out.address = mrzText(addr);
  const tel = s(0x5f12); if (tel) out.telephone = tel;
  const prof = s(0x5f13); if (prof) out.profession = mrzText(prof);
  const title = s(0x5f14); if (title) out.title = mrzText(title);
  const sum = s(0x5f15); if (sum) out.personalSummary = mrzText(sum);
  const td = s(0x5f17); if (td) out.otherTravelDocuments = td.split("<").filter(Boolean);
  const cust = s(0x5f18); if (cust) out.custody = mrzText(cust);
  const proof = v(0x5f16); if (proof && found) pushImage(found, 11, "document", proof, "proof-of-citizenship");
  return out;
}

/** DG12: additional document details. */
export function parseDg12(dg: Uint8Array, found?: Found): MrtdDocument {
  const t = decodeTlv(dg, { recurse: true });
  const out: MrtdDocument = {};
  const v = (tag: number) => findTlv(t, tag)?.value;
  const s = (tag: number) => { const x = v(tag); return x && x.length ? utf8(x) : undefined; };
  const auth = s(0x5f19); if (auth) out.issuingAuthority = mrzText(auth);
  const doi = v(0x5f26); if (doi && doi.length) out.dateOfIssue = dateField(doi);
  const persons = findAllTlv(t, 0x5f1a).map((n) => mrzText(utf8(n.value))).filter(Boolean); if (persons.length) out.otherPersons = persons;
  const end = s(0x5f1b); if (end) out.endorsements = end;
  const tax = s(0x5f1c); if (tax) out.taxExit = tax;
  const pt = v(0x5f55); if (pt && pt.length) out.personalizationTime = dateField(pt);
  const pd = s(0x5f56); if (pd) out.personalizationDevice = pd;
  if (found) {
    const front = v(0x5f1d); if (front) pushImage(found, 12, "document", front, "document-front");
    const rear = v(0x5f1e); if (rear) pushImage(found, 12, "document", rear, "document-rear");
  }
  return out;
}

/** DG16: persons to notify. */
export function parseDg16(dg: Uint8Array): string[] {
  const t = decodeTlv(dg, { recurse: true });
  const out: string[] = [];
  for (const p of [...findAllTlv(t, 0xa1), ...findAllTlv(t, 0xa2), ...findAllTlv(t, 0xa3)]) {
    const c = p.children ?? [];
    const g = (tag: number) => { const x = findTlv(c, tag)?.value; return x && x.length ? utf8(x) : ""; };
    const line = [mrzText(g(0x5f51)), g(0x5f52), mrzText(g(0x5f53))].filter(Boolean).join(" · ");
    if (line) out.push(line);
  }
  return out;
}

/** DG13 (optional, country-defined): readable text when it is text, else hex. */
function optionalText(dg: Uint8Array): string {
  const t = decodeTlv(dg, { recurse: false });
  const body = t[0]?.value ?? dg;
  const printable = body.filter((b) => b >= 0x20 && b < 0x7f).length;
  return (printable > body.length * 0.85 ? utf8(body) : hex(body).toUpperCase()).slice(0, 4000);
}

/** DG15: the Active Authentication public key — its algorithm and size. */
export function aaKeyText(dg: Uint8Array): string {
  const t = der(dg);
  const spki = t[0] && t[0].tag !== SEQ ? kids(t[0])[0] : t[0];
  const [alg, key] = kids(spki);
  const [algOid, params] = kids(alg);
  if (!algOid || algOid.tag !== OID) return "";
  const name = oidName(oidText(algOid.value));
  if (name === "RSA" && key && key.tag === BITS) {
    const [mod] = kids(kids(key)[0]); // BIT STRING { RSAPublicKey { modulus, exponent } }
    if (mod) { let len = mod.value.length; if (mod.value[0] === 0) len--; return `RSA ${len * 8}`; }
    return "RSA";
  }
  if (name === "EC") {
    const curve = params && params.tag === OID ? oidName(oidText(params.value)) : "explicit parameters";
    const bits = key && key.tag === BITS ? Math.round(((key.value.length - 2) / 2) * 8) : 0;
    return `EC ${curve}${bits ? ` (${bits} bit)` : ""}`;
  }
  return name;
}

/** EF.SOD: the hash algorithm, each group's hash, and the document signer certificate. */
export function parseSod(sod: Uint8Array): { hashAlgorithm?: string; hashes: Map<number, Uint8Array>; signer?: ReturnType<typeof certInfo>; certificate?: Uint8Array } {
  const hashes = new Map<number, Uint8Array>();
  const top = der(sod);
  const ci = top[0] && top[0].tag === 0x77 ? kids(top[0])[0] : top[0]; // ContentInfo
  const signedData = kids(kids(ci)[1])[0];
  const sd = kids(signedData);
  const encap = sd.find((n, i) => i > 1 && n.tag === SEQ);
  let hashAlgorithm: string | undefined;
  const eContent = kids(kids(encap)[1])[0];
  if (eContent && eContent.tag === OCTETS) {
    const lds = kids(der(eContent.value)[0]);
    const algId = lds.find((n) => n.tag === SEQ);
    const algOid = kids(algId)[0];
    if (algOid && algOid.tag === OID) hashAlgorithm = oidName(oidText(algOid.value));
    const list = lds.filter((n) => n.tag === SEQ)[1];
    for (const item of kids(list)) {
      const [num, value] = kids(item);
      if (num && value) hashes.set(num.value[num.value.length - 1], value.value);
    }
  }
  const certs = sd.find((n) => n.tag === 0xa0);
  const cert = kids(certs)[0];
  if (!cert) return { hashAlgorithm, hashes };
  // The certificate's own bytes (header + value), for the download.
  const encLen = cert.length < 0x80 ? 1 : cert.length < 0x100 ? 2 : cert.length < 0x10000 ? 3 : 4;
  const head = Uint8Array.from([0x30, ...(encLen === 1 ? [cert.length] : encLen === 2 ? [0x81, cert.length] : encLen === 3 ? [0x82, cert.length >> 8, cert.length & 0xff] : [0x83, cert.length >> 16, (cert.length >> 8) & 0xff, cert.length & 0xff])]);
  return { hashAlgorithm, hashes, signer: certInfo(cert), certificate: concat(head, cert.value) };
}

const HASH: Record<string, string> = { "SHA-1": "SHA-1", "SHA-256": "SHA-256", "SHA-384": "SHA-384", "SHA-512": "SHA-512" };
async function digest(alg: string, data: Uint8Array): Promise<Uint8Array | null> {
  const name = HASH[alg];
  if (!name) return null;
  return new Uint8Array(await crypto.subtle.digest(name, data as unknown as ArrayBuffer));
}

function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return typeof btoa === "function" ? btoa(s) : Buffer.from(b).toString("base64");
}

const raw = (name: string, bytes: Uint8Array, mime = "application/octet-stream"): CardFile => ({ name, mime, data: toBase64(bytes) });
const fidHex = (fid: number) => fid.toString(16).padStart(4, "0").toUpperCase();

/* ------------------------------------------------------------------ public */

export type MrtdOptions = {
  mrz?: string;
  key?: MrzKey;
  can?: string;
  /** Read the images (DG2, DG5, DG7, scans in DG11 / DG12) — default true. */
  readPhoto?: boolean;
  /** Read every group the document lists, not only DG1 / DG2 — default true. */
  all?: boolean;
  /**
   * 6.10: told what the read does next ("EF.CardAccess", "PACE", "BAC", "EF.COM",
   * "EF.SOD", "DG1"…) — the template runner labels each APDU of its transcript
   * with it (under secure messaging the command bytes alone say nothing).
   */
  onPhase?: (phase: string) => void;
};

/**
 * Reads an MRTD (passport / e-ID). The holder supplies the MRZ (or just the
 * three BAC fields) or the CAN. PACE is used when the chip offers it, BAC
 * otherwise; nothing is forced.
 */
export async function readMrtd(t: CardTransport, opts: MrtdOptions): Promise<MrtdData> {
  const out: MrtdData = { present: true, access: "none" };
  const files: MrtdFileInfo[] = [];
  const rawFiles: CardFile[] = [];
  const found: Found = { images: [] };
  const protocols: string[] = [];
  const plainSend: Sender = async (cmd) => { const r = await plain(t, cmd); return { data: r.data, sw: r.sw }; };
  const phase = (p: string) => { try { opts.onPhase?.(p); } catch { /* a listener's problem is not the read's */ } };

  // EF.CardAccess sits in the master file, readable without a key: it says whether the chip runs PACE.
  let paceInfos: PaceInfo[] = [];
  phase("EF.CardAccess");
  try {
    const ca = await readFile(plainSend, EF.cardAccess, 2048);
    if ("bytes" in ca) {
      const sec = parseSecurityInfos(ca.bytes);
      paceInfos = sec.pace;
      protocols.push(...sec.protocols);
      files.push({ name: "CardAccess", fid: fidHex(EF.cardAccess), status: "read", size: ca.bytes.length });
      rawFiles.push(raw("EF.CardAccess.bin", ca.bytes));
    }
  } catch { /* an older chip: no EF.CardAccess */ }
  const pace = choosePace(paceInfos);
  if (paceInfos.length) out.pace = { supported: true, protocol: (pace ?? paceInfos[0]).name, ...((pace ?? paceInfos[0]).parameterId !== undefined ? { parameterId: (pace ?? paceInfos[0]).parameterId } : {}) };
  else out.pace = { supported: false };

  const key = opts.key ?? (opts.mrz ? mrzKeyFromMrz(opts.mrz) : null);
  const can = typeof opts.can === "string" && /^\d{6}$/.test(opts.can.trim()) ? opts.can.trim() : undefined;
  if (!key && !can) return { ...out, ...(protocols.length ? { security: { protocols } } : {}), files, message: "Give the MRZ (document number, date of birth, expiry) or the CAN printed on the document to open the chip." };

  // Open the document: PACE when the chip offers it, else BAC.
  let ch: SmChannel | null = null;
  const failures: string[] = [];
  if (pace) {
    phase(`PACE (${can ? "CAN" : "MRZ"})`);
    try {
      ch = await establishPace(t, pace, can ? { kind: "can", can } : { kind: "mrz", key: key! });
      const sel = await ch.send(apdu(0x00, 0xa4, 0x04, 0x0c, MRTD_AID));
      if (!isOk(sel.sw)) throw new Error("the eMRTD application did not open after PACE");
      out.access = "pace";
      out.pace = { ...out.pace!, used: true, password: can ? "can" : "mrz" };
    } catch (e) { ch = null; failures.push(`PACE: ${e instanceof Error ? e.message : String(e)}`); }
  } else if (paceInfos.length) {
    failures.push(`PACE: ${paceInfos.map((p) => `${p.name}${p.parameterId !== undefined ? ` (${PACE_PARAMETERS[p.parameterId] ?? p.parameterId})` : ""}`).join(", ")} — not a variant this reader runs`);
  }
  if (!ch && key) {
    phase("BAC (MRZ)");
    try {
      try { await plain(t, ISO.selectByAid(MRTD_AID)); } catch { /* some chips select on first read */ }
      ch = await doBac(t, key);
      out.access = "bac";
    } catch (e) { failures.push(`BAC: ${e instanceof Error ? e.message : String(e)}`); }
  }
  if (!ch) {
    const hint = !key && can && !pace ? " — this document needs the MRZ (BAC)" : "";
    return { ...out, ...(protocols.length ? { security: { protocols } } : {}), files, message: `${failures.join("; ") || "the document could not be opened"}${hint}` };
  }
  const send: Sender = (cmd) => ch!.send(cmd);

  // EF.COM — which groups are there.
  let groups: number[] = [];
  phase("EF.COM");
  const com = await readFile(send, EF.com, 1024).catch(() => ({ sw: 0x6f00 }) as FileRead);
  if ("bytes" in com) {
    const c = parseCom(com.bytes);
    groups = c.groups;
    if (c.lds) out.ldsVersion = c.lds;
    if (c.unicode) out.unicodeVersion = c.unicode;
    files.push({ name: "COM", fid: fidHex(EF.com), status: "read", size: com.bytes.length });
    rawFiles.push(raw("EF.COM.bin", com.bytes));
  } else files.push({ name: "COM", fid: fidHex(EF.com), status: statusOf(com.sw) });
  if (!groups.length) groups = opts.all === false ? [1, 2] : [1, 2, 5, 7, 11, 12, 13, 14, 15, 16];
  out.dataGroups = groups.map((n) => `DG${n}`);

  // EF.SOD — the hashes every group is checked against, and the signer.
  let sod: ReturnType<typeof parseSod> | null = null;
  if (opts.all !== false) {
    phase("EF.SOD");
    const s = await readFile(send, EF.sod, 32_768).catch(() => ({ sw: 0x6f00 }) as FileRead);
    if ("bytes" in s) {
      try { sod = parseSod(s.bytes); } catch { sod = null; }
      files.push({ name: "SOD", fid: fidHex(EF.sod), status: "read", size: s.bytes.length });
      rawFiles.push(raw("EF.SOD.bin", s.bytes));
      if (sod?.certificate) rawFiles.push(raw("document-signer.cer", sod.certificate, "application/pkix-cert"));
    } else files.push({ name: "SOD", fid: fidHex(EF.sod), status: statusOf(s.sw) });
  }

  let checked = 0, mismatched = 0;
  for (const n of [...groups].sort((a, b) => a - b)) {
    const name = `DG${n}`, fid = fidHex(dgFid(n));
    if (EAC_GROUPS.has(n)) { files.push({ name, fid, status: "protected", message: "Extended Access Control (a government terminal certificate)" }); continue; }
    if (opts.all === false && n > 2) continue;
    if (opts.readPhoto === false && IMAGE_GROUPS.has(n)) { files.push({ name, fid, status: "absent", message: "not read (images off)" }); continue; }
    let r: FileRead;
    phase(name);
    try { r = await readFile(send, dgFid(n), CAP[n] ?? 32_768); }
    catch (e) { files.push({ name, fid, status: "error", message: e instanceof Error ? e.message : String(e) }); continue; }
    if (!("bytes" in r)) { files.push({ name, fid, status: statusOf(r.sw) }); continue; }
    const info: MrtdFileInfo = { name, fid, status: "read", size: r.bytes.length };
    if (!r.complete) info.message = "truncated";
    // Passive authentication of what was read: the group's hash against EF.SOD.
    const want = sod?.hashes.get(n);
    if (want && sod?.hashAlgorithm && r.complete) {
      const got = await digest(sod.hashAlgorithm, r.bytes);
      if (got) { info.hashOk = hex(got) === hex(want); checked++; if (!info.hashOk) mismatched++; }
    }
    files.push(info);
    try {
      switch (n) {
        case 1: { const m = mrzFromDg1(r.bytes); if (m) out.mrzInfo = m; rawFiles.push(raw("DG1.bin", r.bytes)); break; }
        case 2: facesFromDg2(r.bytes).forEach((f, i) => found.images.push({ group: "DG2", kind: "face", mime: f.mime, data: toBase64(f.data), name: `face${i ? `-${i + 1}` : ""}.${extOf(f.mime)}` })); break;
        case 5: { const t5 = decodeTlv(r.bytes, { recurse: true }); for (const p of findAllTlv(t5, 0x5f40)) pushImage(found, 5, "portrait", p.value, "portrait"); break; }
        case 7: { const t7 = decodeTlv(r.bytes, { recurse: true }); for (const p of findAllTlv(t7, 0x5f43)) pushImage(found, 7, "signature", p.value, "signature"); break; }
        case 11: { const p = parseDg11(r.bytes, opts.readPhoto === false ? undefined : found); if (Object.keys(p).length) out.personal = p; rawFiles.push(raw("DG11.bin", r.bytes)); break; }
        case 12: { const d = parseDg12(r.bytes, opts.readPhoto === false ? undefined : found); if (Object.keys(d).length) out.document = d; rawFiles.push(raw("DG12.bin", r.bytes)); break; }
        case 13: out.optional = optionalText(r.bytes); rawFiles.push(raw("DG13.bin", r.bytes)); break;
        case 14: { const body = decodeTlv(r.bytes, { recurse: false })[0]?.value ?? r.bytes; for (const p of parseSecurityInfos(body).protocols) if (!protocols.includes(p)) protocols.push(p); rawFiles.push(raw("DG14.bin", r.bytes)); break; }
        case 15: { const body = decodeTlv(r.bytes, { recurse: false })[0]?.value ?? r.bytes; const k = aaKeyText(body); out.security = { ...(out.security ?? {}), ...(k ? { activeAuthKey: k } : {}) }; if (!protocols.includes("Active Authentication")) protocols.push("Active Authentication"); rawFiles.push(raw("DG15.bin", r.bytes)); break; }
        case 16: { const p = parseDg16(r.bytes); if (p.length) out.personsToNotify = p; rawFiles.push(raw("DG16.bin", r.bytes)); break; }
        default: rawFiles.push(raw(`${name}.bin`, r.bytes));
      }
    } catch (e) { info.message = `could not parse: ${e instanceof Error ? e.message : String(e)}`; rawFiles.push(raw(`${name}.bin`, r.bytes)); }
  }

  const security = { ...(out.security ?? {}) };
  if (sod?.hashAlgorithm) security.hashAlgorithm = sod.hashAlgorithm;
  if (sod?.signer && (sod.signer.subject || sod.signer.issuer)) security.signer = sod.signer;
  security.passive = !sod || !checked ? "unchecked" : mismatched ? "mismatch" : "ok";
  if (protocols.length) security.protocols = protocols;
  out.security = security;
  if (found.images.length) {
    out.images = found.images;
    const face = found.images.find((i) => i.kind === "face");
    if (face) { out.photo = face.data; out.photoMime = face.mime; }
  }
  out.files = files;
  if (rawFiles.length) out.raw = rawFiles;
  if (failures.length) out.message = failures.join("; ");
  return out;
}

/** A one-line summary for a log / flash. */
export function mrtdSummary(d: MrtdData): string {
  if (!d.mrzInfo) return d.message || (d.present ? "MRTD present" : "no MRTD");
  const m = d.mrzInfo;
  const imgs = d.images?.length ?? (d.photo ? 1 : 0);
  return [[m.givenNames, m.surname].filter(Boolean).join(" "), m.documentNumber, m.nationality, d.access !== "none" ? d.access.toUpperCase() : "", imgs ? `${imgs} image${imgs > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ");
}
