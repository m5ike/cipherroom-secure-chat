// MRTD reader (6.5) — e-passport / e-ID, ICAO 9303. Opens the holder's own
// document with BAC (keyed from the MRZ or CAN they supply — the document's
// own access control), then reads over secure messaging: EF.COM (which data
// groups are present), DG1 (the MRZ data) and DG2 (the face). Read-only; it
// never writes and only reads the groups a border reader reads.

import type { CardTransport } from "../transport";
import { apdu, concat, decodeTlv, findTlv, hex, isOk, ISO, splitResponse, type Response } from "./apdu";
import { bacKeys, mrzKeyFromMrz, mutualAuthCommand, protectApdu, sessionFromAuth, type BacSession, type MrzKey } from "./bac";
import type { MrtdData, MrtdMrz } from "../command";

const MRTD_AID = Uint8Array.from([0xa0, 0x00, 0x00, 0x02, 0x47, 0x10, 0x01]);
const EF = { com: 0x011e, dg1: 0x0101, dg2: 0x0102, sod: 0x011d };

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

async function plain(t: CardTransport, cmd: Uint8Array): Promise<Response> {
  return splitResponse(await t.transmit(cmd));
}

/** One secure-messaging exchange: protect → transmit → unprotect. */
async function sm(t: CardTransport, s: BacSession, cmd: Uint8Array): Promise<{ data: Uint8Array; sw: number }> {
  const raw = await t.transmit(protectApdu(s, cmd));
  const { unprotectResponse } = await import("./bac");
  return unprotectResponse(s, raw);
}

/* ------------------------------------------------------------------ BAC */

async function doBac(t: CardTransport, key: MrzKey): Promise<BacSession> {
  const { kenc, kmac } = await bacKeys(key);
  const chal = await plain(t, apdu(0x00, 0x84, 0x00, 0x00, undefined, 8)); // GET CHALLENGE
  if (!isOk(chal.sw) || chal.data.length < 8) throw new Error("the document did not answer GET CHALLENGE");
  const rndIcc = chal.data.slice(0, 8);
  const rndIfd = randomBytes(8);
  const kifd = randomBytes(16);
  const cmdData = mutualAuthCommand(kenc, kmac, rndIfd, rndIcc, kifd);
  const auth = await plain(t, apdu(0x00, 0x82, 0x00, 0x00, cmdData, 0x28)); // EXTERNAL AUTHENTICATE
  if (!isOk(auth.sw)) throw new Error("BAC failed — check the passport number, date of birth and expiry");
  return sessionFromAuth(kenc, kmac, rndIfd, rndIcc, kifd, auth.data);
}

/* ------------------------------------------------- read a file over SM */

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

async function readFile(t: CardTransport, s: BacSession, fid: number, cap = 32768): Promise<Uint8Array> {
  const sel = await sm(t, s, ISO.selectByFid(fid, 0x0c));
  if (!isOk(sel.sw)) throw new Error(`select EF ${fid.toString(16)} failed`);
  const head = await sm(t, s, ISO.readBinary(0, 6));
  if (!isOk(head.sw) || head.data.length === 0) throw new Error(`read EF ${fid.toString(16)} failed`);
  const info = derLength(head.data);
  const total = Math.min(info ? info.total : head.data.length, cap);
  const chunks: Uint8Array[] = [head.data.slice(0, Math.min(head.data.length, total))];
  let offset = chunks[0].length;
  let guard = 0;
  while (offset < total && offset < 0x8000 && guard++ < 512) {
    const want = Math.min(0xe0, total - offset);
    const r = await sm(t, s, ISO.readBinary(offset, want));
    if (!isOk(r.sw) || r.data.length === 0) break;
    chunks.push(r.data);
    offset += r.data.length;
  }
  return concat(...chunks);
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

/** The data groups EF.COM lists in its tag-presence list (5C). */
export function dataGroupsFromCom(com: Uint8Array): string[] {
  const tlv = decodeTlv(com, { recurse: true });
  const list = findTlv(tlv, 0x5c)?.value ?? findTlv(findTlv(tlv, 0x60)?.children ?? [], 0x5c)?.value;
  if (!list) return [];
  const MAP: Record<number, string> = { 0x61: "DG1", 0x75: "DG2", 0x63: "DG3", 0x76: "DG4", 0x65: "DG5", 0x67: "DG7", 0x6b: "DG11", 0x6c: "DG12", 0x6d: "DG13", 0x6f: "DG15" };
  return Array.from(list).map((t) => MAP[t]).filter(Boolean);
}

/** Pulls the face image out of DG2 by its signature (JPEG or JPEG 2000). */
export function faceFromDg2(dg2: Uint8Array): { mime: string; data: Uint8Array } | null {
  for (let i = 0; i + 3 < dg2.length; i++) {
    if (dg2[i] === 0xff && dg2[i + 1] === 0xd8 && dg2[i + 2] === 0xff) return { mime: "image/jpeg", data: dg2.slice(i) };
    if (dg2[i] === 0x00 && dg2[i + 1] === 0x00 && dg2[i + 2] === 0x00 && dg2[i + 3] === 0x0c && dg2[i + 4] === 0x6a && dg2[i + 5] === 0x50) return { mime: "image/jp2", data: dg2.slice(i) };
    if (dg2[i] === 0xff && dg2[i + 1] === 0x4f && dg2[i + 2] === 0xff && dg2[i + 3] === 0x51) return { mime: "image/jp2", data: dg2.slice(i) }; // JPEG2000 codestream
  }
  return null;
}

function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return typeof btoa === "function" ? btoa(s) : Buffer.from(b).toString("base64");
}

/* ------------------------------------------------------------------ public */

export type MrtdOptions = { mrz?: string; key?: MrzKey; can?: string; readPhoto?: boolean };

/**
 * Reads an MRTD (passport / e-ID). The holder supplies the MRZ (or just the
 * three BAC fields). PACE-only documents (no BAC) are reported, not forced.
 */
export async function readMrtd(t: CardTransport, opts: MrtdOptions): Promise<MrtdData> {
  try { await plain(t, ISO.selectByAid(MRTD_AID)); } catch { /* some chips select on first read */ }

  const key = opts.key ?? (opts.mrz ? mrzKeyFromMrz(opts.mrz) : null);
  if (!key) return { present: true, access: "none", message: "Give the MRZ (passport number, date of birth, expiry) to open the chip with BAC." };

  let session: BacSession;
  try { session = await doBac(t, key); }
  catch (e) { return { present: true, access: "none", message: e instanceof Error ? e.message : "BAC failed" }; }

  const out: MrtdData = { present: true, access: "bac" };
  try { out.dataGroups = dataGroupsFromCom(await readFile(t, session, EF.com, 512)); } catch { /* EF.COM optional */ }
  try { const dg1 = await readFile(t, session, EF.dg1, 256); const mrz = mrzFromDg1(dg1); if (mrz) out.mrzInfo = mrz; }
  catch (e) { out.message = e instanceof Error ? e.message : "could not read DG1"; }
  if (opts.readPhoto !== false) {
    try {
      const dg2 = await readFile(t, session, EF.dg2, 40000);
      const face = faceFromDg2(dg2);
      if (face) { out.photo = toBase64(face.data); out.photoMime = face.mime; }
    } catch { /* DG2 optional / larger than we read */ }
  }
  return out;
}

/** A one-line summary for a log / flash. */
export function mrtdSummary(d: MrtdData): string {
  if (!d.mrzInfo) return d.message || (d.present ? "MRTD present" : "no MRTD");
  const m = d.mrzInfo;
  return [[m.givenNames, m.surname].filter(Boolean).join(" "), m.documentNumber, m.nationality, d.photo ? "+ photo" : ""].filter(Boolean).join(" · ");
}
