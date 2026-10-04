// @vitest-environment node
//
// The deep MRTD read (6.6) against a simulated chip that runs BAC and 3DES
// secure messaging the way ICAO 9303-11 specifies — the chip side here is
// written from the spec, independently of the reader: it checks every MAC,
// decrypts every command and answers only SELECT / READ BINARY. The reader
// opens it with the MRZ, reads EF.COM, EF.SOD and every group, checks the
// hashes against EF.SOD and pulls out the images.

import { describe, it, expect } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { concat, decodeTlv, encodeTlv, hex, u8 } from "../client/src/lib/nfc/cards/apdu";
import { bacKeys, deriveKey, type MrzKey } from "../client/src/lib/nfc/cards/bac";
import { pad, retailMac, tdesCbcDecrypt, tdesCbcEncrypt } from "../client/src/lib/nfc/cards/des";
import { oidBytes } from "../client/src/lib/nfc/cards/asn1";
import { aaKeyText, parseDg11, parseDg12, parseSod, readMrtd } from "../client/src/lib/nfc/cards/mrtd";
import { parseSecurityInfos, choosePace } from "../client/src/lib/nfc/cards/pace";
import type { CardTransport } from "../client/src/lib/nfc/transport";

const ascii = (s: string) => new TextEncoder().encode(s);
const T = (tag: number, ...v: Uint8Array[]) => encodeTlv(tag, concat(...v));
const oid = (s: string) => T(0x06, oidBytes(s));
const int = (n: number) => T(0x02, u8(n));
const sha256 = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());

/* ------------------------------------------------------------ the document */

const MRZ = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C<3UTO6908061F9406236ZE184226B<<<<<10";
const KEY: MrzKey = { documentNumber: "L898902C", dateOfBirth: "690806", dateOfExpiry: "940623" };
const JPEG = concat(u8(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10), ascii("JFIF"), new Uint8Array(600).fill(7), u8(0xff, 0xd9));
const SIG = concat(u8(0xff, 0xd8, 0xff, 0xdb), new Uint8Array(80).fill(3), u8(0xff, 0xd9));

const DG1 = T(0x61, T(0x5f1f, ascii(MRZ.replace("\n", ""))));
const DG2 = T(0x75, T(0x7f61, T(0x02, u8(1)), T(0x7f60, T(0xa1, T(0x80, u8(1, 1))), T(0x5f2e, concat(ascii("FAC\0"), new Uint8Array(40), JPEG)))));
const DG7 = T(0x67, T(0x02, u8(1)), T(0x5f43, SIG));
const DG11 = T(0x6b, T(0x5c, u8(0x5f, 0x0e, 0x5f, 0x2b, 0x5f, 0x11, 0x5f, 0x42)), T(0x5f0e, ascii("ERIKSSON<<ANNA<MARIA")), T(0x5f2b, u8(0x19, 0x69, 0x08, 0x06)), T(0x5f11, ascii("ZENITH<UTO")), T(0x5f42, ascii("123<MAPLE<STREET<<ZENITH")), T(0x5f10, ascii("ZE184226B")));
const DG12 = T(0x6c, T(0x5c, u8(0x5f, 0x19, 0x5f, 0x26)), T(0x5f19, ascii("UTOPIA<PASSPORT<OFFICE")), T(0x5f26, u8(0x20, 0x24, 0x01, 0x15)), T(0x5f55, ascii("20240110093000")));
const MODULUS = concat(u8(0x00), new Uint8Array(128).fill(0xa5));
const DG15 = T(0x6f, T(0x30, T(0x30, oid("1.2.840.113549.1.1.1"), u8(0x05, 0x00)), T(0x03, u8(0x00), T(0x30, T(0x02, MODULUS), T(0x02, u8(1, 0, 1))))));
const DG14 = T(0x6e, T(0x31, T(0x30, oid("0.4.0.127.0.7.2.2.3.2.2"), int(1)), T(0x30, oid("0.4.0.127.0.7.2.2.2"), int(1))));
const COM = T(0x60, T(0x5f01, ascii("0107")), T(0x5f36, ascii("040000")), T(0x5c, u8(0x61, 0x75, 0x63, 0x67, 0x6b, 0x6c, 0x6e, 0x6f)));

function name(cn: string) { return T(0x30, T(0x31, T(0x30, oid("2.5.4.6"), T(0x13, ascii("UT")))), T(0x31, T(0x30, oid("2.5.4.3"), T(0x0c, ascii(cn))))); }
function certificate() {
  const tbs = T(0x30, T(0xa0, int(2)), T(0x02, u8(0x12, 0x34)), T(0x30, oid("1.2.840.113549.1.1.11")), name("CSCA Utopia"),
    T(0x30, T(0x17, ascii("240101000000Z")), T(0x17, ascii("340101000000Z"))), name("DS Utopia 1"), T(0x30, T(0x30, oid("1.2.840.113549.1.1.1")), T(0x03, u8(0))));
  return T(0x30, tbs, T(0x30, oid("1.2.840.113549.1.1.11")), T(0x03, u8(0, 1, 2)));
}
function sod(groups: Record<number, Uint8Array>, tamper?: number) {
  const hashes = Object.entries(groups).map(([n, b]) => { const h = sha256(b); if (Number(n) === tamper) h[0] ^= 1; return T(0x30, int(Number(n)), T(0x04, h)); });
  const lds = T(0x30, int(0), T(0x30, oid("2.16.840.1.101.3.4.2.1")), T(0x30, ...hashes));
  const signedData = T(0x30, int(3), T(0x31, T(0x30, oid("2.16.840.1.101.3.4.2.1"))), T(0x30, oid("2.23.136.1.1.1"), T(0xa0, T(0x04, lds))), T(0xa0, certificate()), T(0x31));
  return T(0x77, T(0x30, oid("1.2.840.113549.1.7.2"), T(0xa0, signedData)));
}

/* ------------------------------------------------------------ the chip */

type Chip = { transport: CardTransport; log: string[] };

/** A BAC chip from the spec: plain until mutual authentication, then every APDU in SM. */
function bacChip(key: MrzKey, files: Record<number, Uint8Array>, opts: { cardAccess?: Uint8Array } = {}): Chip {
  const log: string[] = [];
  let kenc: Uint8Array, kmac: Uint8Array;
  let rndIcc: Uint8Array | null = null;
  let session: { ksenc: Uint8Array; ksmac: Uint8Array; ssc: Uint8Array } | null = null;
  let selected: number | null = null;
  let appSelected = false;
  const ready = bacKeys(key).then((k) => { kenc = k.kenc; kmac = k.kmac; });
  const inc = (s: Uint8Array) => { for (let i = s.length - 1; i >= 0; i--) { s[i] = (s[i] + 1) & 0xff; if (s[i]) break; } };
  const unpad = (d: Uint8Array) => { let i = d.length - 1; while (i >= 0 && d[i] === 0) i--; return d.slice(0, i); };
  const sw = (n: number) => u8(n >> 8, n & 0xff);

  /** Plain command logic: SELECT / READ BINARY over the files. */
  function run(ins: number, p1: number, p2: number, data: Uint8Array, le: number | null): { data: Uint8Array; sw: number } {
    if (ins === 0xa4 && p1 === 0x04) { appSelected = hex(data).toUpperCase() === "A0000002471001"; return { data: new Uint8Array(0), sw: appSelected ? 0x9000 : 0x6a82 }; }
    if (ins === 0xa4) {
      const fid = (data[0] << 8) | data[1];
      if (fid === 0x011c && opts.cardAccess) { selected = fid; return { data: new Uint8Array(0), sw: 0x9000 }; }
      if (fid === 0x0103 || fid === 0x0104) return { data: new Uint8Array(0), sw: 0x6982 };
      if (!(fid in files)) return { data: new Uint8Array(0), sw: 0x6a82 };
      selected = fid; return { data: new Uint8Array(0), sw: 0x9000 };
    }
    if (ins === 0xb0) {
      const f = selected === 0x011c ? opts.cardAccess! : selected !== null ? files[selected] : undefined;
      if (!f) return { data: new Uint8Array(0), sw: 0x6986 };
      const off = (p1 << 8) | p2;
      const n = le === 0 || le === null ? 256 : le;
      const out = f.slice(off, off + n);
      return { data: out, sw: off + n > f.length ? 0x6282 : 0x9000 };
    }
    return { data: new Uint8Array(0), sw: 0x6d00 };
  }

  const transmit = async (cmd: Uint8Array): Promise<Uint8Array> => {
    await ready;
    const a = cmd;
    log.push(hex(a).toUpperCase());
    if (!session) {
      const [, ins, p1, p2] = a;
      if (ins === 0x84) { rndIcc = randomBytes(8); return concat(rndIcc, sw(0x9000)); }
      if (ins === 0x82) {
        const body = a.slice(5, 5 + a[4]);
        const eifd = body.slice(0, 32), mifd = body.slice(32, 40);
        if (hex(retailMac(kmac, pad(eifd))) !== hex(mifd)) return sw(0x6300);
        const s = tdesCbcDecrypt(kenc, eifd);
        const rndIfd = s.slice(0, 8), kifd = s.slice(16, 32);
        if (hex(s.slice(8, 16)) !== hex(rndIcc!)) return sw(0x6300);
        const kicc = randomBytes(16);
        const eicc = tdesCbcEncrypt(kenc, concat(rndIcc!, rndIfd, kicc));
        const micc = retailMac(kmac, pad(eicc));
        const seed = kifd.map((b, i) => b ^ kicc[i]);
        session = { ksenc: await deriveKey(Uint8Array.from(seed), 1), ksmac: await deriveKey(Uint8Array.from(seed), 2), ssc: concat(rndIcc!.slice(4, 8), rndIfd.slice(4, 8)) };
        return concat(eicc, micc, sw(0x9000));
      }
      const lc = a.length > 5 ? a[4] : 0;
      const r = run(ins, p1, p2, a.slice(5, 5 + lc), a.length === 5 ? a[4] : a.length > 5 + lc ? a[5 + lc] : null);
      return concat(r.data, sw(r.sw));
    }
    // Secure messaging: check the MAC, decrypt, run, wrap the answer.
    const s = session;
    if ((a[0] & 0x0c) !== 0x0c) return sw(0x6987);
    const body = a.slice(5, 5 + a[4]);
    const nodes = decodeTlv(body, { recurse: false });
    const do87 = nodes.find((n) => n.tag === 0x87), do97 = nodes.find((n) => n.tag === 0x97), do8e = nodes.find((n) => n.tag === 0x8e);
    inc(s.ssc);
    const macIn = pad(concat(s.ssc, pad(u8(a[0], a[1], a[2], a[3])), do87 ? encodeTlv(0x87, do87.value) : new Uint8Array(0), do97 ? encodeTlv(0x97, do97.value) : new Uint8Array(0)));
    if (!do8e || hex(retailMac(s.ksmac, macIn)) !== hex(do8e.value)) return sw(0x6988);
    const data = do87 ? unpad(tdesCbcDecrypt(s.ksenc, do87.value.slice(1))) : new Uint8Array(0);
    const r = run(a[1], a[2], a[3], data, do97 ? do97.value[0] : null);
    inc(s.ssc);
    const r87 = r.data.length ? encodeTlv(0x87, concat(u8(0x01), tdesCbcEncrypt(s.ksenc, pad(r.data)))) : new Uint8Array(0);
    const r99 = encodeTlv(0x99, sw(r.sw));
    const mac = retailMac(s.ksmac, pad(concat(s.ssc, r87, r99)));
    return concat(r87, r99, encodeTlv(0x8e, mac), sw(0x9000));
  };
  return {
    log,
    transport: { kind: "usb", label: "sim", connected: true, waitForCard: async () => ({ uid: u8(1, 2, 3, 4) }), transmit } as unknown as CardTransport,
  };
}

const FILES = (tamper?: number) => {
  const groups = { 1: DG1, 2: DG2, 7: DG7, 11: DG11, 12: DG12, 14: DG14, 15: DG15 };
  return { 0x011e: COM, 0x011d: sod(groups, tamper), 0x0101: DG1, 0x0102: DG2, 0x0107: DG7, 0x010b: DG11, 0x010c: DG12, 0x010e: DG14, 0x010f: DG15 } as Record<number, Uint8Array>;
};

/* ------------------------------------------------------------ tests */

describe("the deep MRTD read (BAC chip)", () => {
  it("opens the document with the MRZ and reads every group it may", async () => {
    const chip = bacChip(KEY, FILES());
    const d = await readMrtd(chip.transport, { mrz: MRZ });
    expect(d.access).toBe("bac");
    expect(d.pace).toEqual({ supported: false });
    expect(d.dataGroups).toEqual(["DG1", "DG2", "DG3", "DG7", "DG11", "DG12", "DG14", "DG15"]);
    expect(d.ldsVersion).toBe("1.7");
    expect(d.unicodeVersion).toBe("4.0.0");
    expect(d.mrzInfo?.surname).toBe("ERIKSSON");
    expect(d.mrzInfo?.documentNumber).toBe("L898902C");
    expect(d.personal?.fullName).toBe("ERIKSSON, ANNA MARIA");
    expect(d.personal?.fullDateOfBirth).toBe("1969-08-06");
    expect(d.personal?.placeOfBirth).toBe("ZENITH UTO");
    expect(d.personal?.address).toBe("123 MAPLE STREET, ZENITH");
    expect(d.personal?.personalNumber).toBe("ZE184226B");
    expect(d.document?.issuingAuthority).toBe("UTOPIA PASSPORT OFFICE");
    expect(d.document?.dateOfIssue).toBe("2024-01-15");
    expect(d.document?.personalizationTime).toBe("2024-01-10 09:30:00");
    // Fingerprints are EAC — never tried.
    expect(d.files?.find((f) => f.name === "DG3")?.status).toBe("protected");
    expect(chip.log.some((l) => /^0CA4020C.*0103/.test(l))).toBe(false);
    // Images: the face and the signature, as JPEG.
    expect(d.images?.map((i) => [i.kind, i.group, i.mime, i.name])).toEqual([["face", "DG2", "image/jpeg", "face.jpg"], ["signature", "DG7", "image/jpeg", "signature.jpg"]]);
    expect(d.photoMime).toBe("image/jpeg");
    expect(Buffer.from(d.photo!, "base64").subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    // Security: passive authentication, the signer, the protocols, the AA key.
    expect(d.security?.hashAlgorithm).toBe("SHA-256");
    expect(d.security?.passive).toBe("ok");
    expect(d.files?.filter((f) => f.hashOk === true).map((f) => f.name)).toEqual(["DG1", "DG2", "DG7", "DG11", "DG12", "DG14", "DG15"]);
    expect(d.security?.signer?.subject).toBe("C=UT, CN=DS Utopia 1");
    expect(d.security?.signer?.issuer).toBe("C=UT, CN=CSCA Utopia");
    expect(d.security?.signer?.notAfter).toBe("2034-01-01");
    expect(d.security?.protocols).toEqual(expect.arrayContaining(["Chip Authentication (ECDH, AES-128)", "Terminal Authentication", "Active Authentication"]));
    expect(d.security?.activeAuthKey).toBe("RSA 1024");
    // Downloads: the security objects and raw groups.
    expect(d.raw?.map((f) => f.name)).toEqual(expect.arrayContaining(["EF.COM.bin", "EF.SOD.bin", "document-signer.cer", "DG1.bin", "DG11.bin", "DG12.bin", "DG14.bin", "DG15.bin"]));
    expect(d.message).toBeUndefined();
  });

  it("flags a group whose hash does not match EF.SOD", async () => {
    const d = await readMrtd(bacChip(KEY, FILES(11)).transport, { mrz: MRZ });
    expect(d.security?.passive).toBe("mismatch");
    expect(d.files?.find((f) => f.name === "DG11")?.hashOk).toBe(false);
    expect(d.files?.find((f) => f.name === "DG1")?.hashOk).toBe(true);
  });

  it("reads only DG1 / DG2 when asked, and no images when images are off", async () => {
    const chip = bacChip(KEY, FILES());
    const d = await readMrtd(chip.transport, { key: KEY, all: false, readPhoto: false });
    expect(d.mrzInfo?.surname).toBe("ERIKSSON");
    expect(d.images).toBeUndefined();
    expect(d.personal).toBeUndefined();
    expect(d.files?.find((f) => f.name === "DG2")?.message).toBe("not read (images off)");
  });

  it("says what went wrong with a wrong MRZ, and reads nothing", async () => {
    const d = await readMrtd(bacChip(KEY, FILES()).transport, { key: { ...KEY, dateOfBirth: "690807" } });
    expect(d.access).toBe("none");
    expect(d.message).toMatch(/BAC/);
    expect(d.mrzInfo).toBeUndefined();
  });

  it("asks for the MRZ or the CAN when given neither", async () => {
    const d = await readMrtd(bacChip(KEY, FILES()).transport, {});
    expect(d.access).toBe("none");
    expect(d.message).toMatch(/MRZ.*CAN/);
  });

  it("sees PACE in EF.CardAccess and falls back to BAC when it cannot run it", async () => {
    const cardAccess = T(0x31, T(0x30, oid("0.4.0.127.0.7.2.2.4.2.2"), int(2), int(13)));
    const d = await readMrtd(bacChip(KEY, FILES(), { cardAccess }).transport, { mrz: MRZ });
    expect(d.pace?.supported).toBe(true);
    expect(d.pace?.protocol).toBe("PACE ECDH-GM AES-128");
    expect(d.pace?.parameterId).toBe(13);
    expect(d.access).toBe("bac");
    expect(d.mrzInfo?.surname).toBe("ERIKSSON");
  });
});

describe("the security objects", () => {
  it("parses EF.CardAccess / SecurityInfos", () => {
    const s = parseSecurityInfos(T(0x31, T(0x30, oid("0.4.0.127.0.7.2.2.4.2.4"), int(2), int(13)), T(0x30, oid("0.4.0.127.0.7.2.2.4.1.2"), int(2), int(0))));
    expect(s.pace.map((p) => [p.cipher, p.agreement, p.mapping, p.parameterId])).toEqual([["AES-256", "ECDH", "GM", 13], ["AES-128", "DH", "GM", 0]]);
    expect(choosePace(s.pace)?.cipher).toBe("AES-256");
  });

  it("reads EF.SOD", () => {
    const s = parseSod(sod({ 1: DG1, 2: DG2 }));
    expect(s.hashAlgorithm).toBe("SHA-256");
    expect(hex(s.hashes.get(1)!)).toBe(hex(sha256(DG1)));
    expect(s.signer?.serial).toBe("1234");
    expect(s.certificate?.[0]).toBe(0x30);
  });

  it("names the Active Authentication key", () => {
    expect(aaKeyText(decodeTlv(DG15, { recurse: false })[0].value)).toBe("RSA 1024");
    expect(aaKeyText(T(0x30, T(0x30, oid("1.2.840.10045.2.1"), oid("1.3.36.3.3.2.8.1.1.7")), T(0x03, u8(0, 4), new Uint8Array(64))))).toBe("EC brainpoolP256r1 (256 bit)");
  });

  it("parses DG11 and DG12 alone", () => {
    expect(parseDg11(DG11).fullName).toBe("ERIKSSON, ANNA MARIA");
    expect(parseDg12(DG12).issuingAuthority).toBe("UTOPIA PASSPORT OFFICE");
  });
});
