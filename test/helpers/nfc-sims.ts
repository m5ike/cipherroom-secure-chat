// Simulated cards for the NFC tests — moved here in 6.10 from
// nfc-emv-deep.test.ts and nfc-mrtd-deep.test.ts so the readers' own tests and
// the APDU template runner's (template-runner.test.ts) read the SAME cards:
//
//   emvCard()      a Mastercard that answers only reads (a VERIFY, GENERATE AC
//                  or a write throws): PPSE, the FCI with a PDOL and the log
//                  entry, GET DATA counters, GPO → AFL, records, a file only a
//                  deep read finds, the transaction log. 6.10 options add a
//                  second application (Visa), a contact PSE directory, or none.
//   bacChip()      an e-passport chip written from ICAO 9303-11: BAC, then 3DES
//                  secure messaging (every MAC checked), SELECT / READ BINARY.
//   desfireCard()  a MIFARE DESFire EV1 answering the native commands wrapped
//                  in ISO 7816 (GetVersion's three frames, GetApplicationIDs…).
//   isoCard()      a plain ISO 7816-4 card: MF, EF.DIR with two records, EF.ATR.

import { createHash, randomBytes } from "node:crypto";
import { concat, decodeTlv, encodeTlv, hex, u8, unhex } from "../../client/src/lib/nfc/cards/apdu";
import { bacKeys, deriveKey, type MrzKey } from "../../client/src/lib/nfc/cards/bac";
import { pad, retailMac, tdesCbcDecrypt, tdesCbcEncrypt } from "../../client/src/lib/nfc/cards/des";
import { oidBytes } from "../../client/src/lib/nfc/cards/asn1";
import type { CardTransport } from "../../client/src/lib/nfc/transport";

export const ascii = (s: string) => new TextEncoder().encode(s);
export const T = (tag: number, ...v: Uint8Array[]) => encodeTlv(tag, concat(...v));
const ok = (resp: Uint8Array) => concat(resp, u8(0x90, 0x00));

/* =========================================================== EMV (6.6 deep) */

export const EMV_AID = "A0000000041010";
export const VISA_AID = "A0000000031010";
// The log format: date, time, amount, currency, country, type, merchant (8), ATC.
export const LOG_FORMAT = unhex("9A039F21039F02065F2A029F1A029C019F4E089F3602");
const logRecord = (date: string, time: string, amount: string, merchant: string, atc: number) =>
  concat(unhex(date), unhex(time), unhex(amount), unhex("0203"), unhex("0203"), unhex("00"), ascii(merchant.padEnd(8, " ").slice(0, 8)), u8(atc >> 8, atc & 0xff));

export const LOG = [
  logRecord("250914", "183005", "000000012345", "BILLA", 41),
  logRecord("250912", "091500", "000000000990", "DPP", 40),
  new Uint8Array(LOG_FORMAT.length).fill(0), // an empty slot
];

export type EmvCardOptions = {
  logInFci?: boolean;
  /** 6.10: also a Visa application (its own FCI, no PDOL, GPO format 1, one record in SFI 4). */
  visa?: boolean;
  /** 6.10: answer the contactless directory (default true). */
  ppse?: boolean;
  /** 6.10: answer the contact directory 1PAY.SYS.DDF01 (its records in SFI 1). */
  pse?: boolean;
  /** 6.10: GET PROCESSING OPTIONS is refused (6985). */
  refuseGpo?: boolean;
};

export function emvCard(opts: EmvCardOptions = {}): { t: CardTransport; seen: string[] } {
  const seen: string[] = [];
  const AID = EMV_AID;
  const fci = T(0x6f, T(0x84, unhex(AID)), T(0xa5, T(0x50, ascii("MASTERCARD")), T(0x9f38, unhex("9F1A02")), ...(opts.logInFci !== false ? [T(0xbf0c, T(0x9f4d, u8(0x0b, 0x03)))] : [])));
  const visaFci = T(0x6f, T(0x84, unhex(VISA_AID)), T(0xa5, T(0x50, ascii("VISA DEBIT"))));
  const entries = [T(0x61, T(0x4f, unhex(AID)), T(0x87, u8(1))), ...(opts.visa ? [T(0x61, T(0x4f, unhex(VISA_AID)), T(0x87, u8(2)))] : [])];
  const ppse = T(0x6f, T(0x84, ascii("2PAY.SYS.DDF01")), T(0xa5, T(0xbf0c, ...entries)));
  const pse = T(0x6f, T(0x84, ascii("1PAY.SYS.DDF01")), T(0xa5, T(0x88, u8(0x01))));
  const pseRecords = entries.map((e) => T(0x70, e));
  const files: Record<string, Uint8Array> = {
    "1:1": T(0x70, T(0x5a, unhex("5413330089020011")), T(0x5f24, unhex("281231")), T(0x5f20, ascii("NOVAK/JAN")), T(0x5f28, unhex("0203"))),
    "2:1": T(0x70, T(0x8c, unhex("9F02069F03069F1A02")), T(0x8e, unhex("000000000000000042031E031F03"))),
    // Not in the AFL — only a deep read finds it.
    "3:1": T(0x70, T(0x9f08, unhex("0002")), T(0x5f30, unhex("0201"))),
    "3:2": T(0x70, T(0x9f42, unhex("0203"))),
  };
  const visaFiles: Record<string, Uint8Array> = { "4:1": T(0x70, T(0x57, unhex("4111111111111111D29122010000000000000F")), T(0x5f20, ascii("NOVAK/JANA"))) };
  let selected = "";
  const t = {
    transmit: async (cmd: Uint8Array) => {
      const a = Array.from(cmd);
      const [cla, ins, p1, p2] = a;
      seen.push(hex(cmd).toUpperCase());
      if (ins === 0x20 || (cla === 0x80 && ins === 0xae) || ins === 0xd6 || ins === 0xdc || ins === 0xe2) throw new Error("the reader must only read");
      if (ins === 0xa4 && p1 === 0x04) {
        const sel = hex(Uint8Array.from(a.slice(5, 5 + a[4]))).toUpperCase();
        if (sel === hex(ascii("2PAY.SYS.DDF01")).toUpperCase()) return opts.ppse === false ? u8(0x6a, 0x82) : ok(ppse);
        if (sel === hex(ascii("1PAY.SYS.DDF01")).toUpperCase()) { if (!opts.pse) return u8(0x6a, 0x82); selected = "PSE"; return ok(pse); }
        if (sel === VISA_AID && opts.visa) { selected = VISA_AID; return ok(visaFci); }
        if (sel === AID) { selected = AID; return ok(fci); }
        return u8(0x6a, 0x82);
      }
      if (cla === 0x80 && ins === 0xca) {
        if (selected === VISA_AID) return u8(0x6a, 0x88);
        const tag = ((p1 << 8) | p2).toString(16).toUpperCase();
        if (tag === "9F4F") return ok(T(0x9f4f, LOG_FORMAT));
        if (tag === "9F36") return ok(T(0x9f36, u8(0x00, 0x2a)));
        if (tag === "9F13") return ok(T(0x9f13, u8(0x00, 0x28)));
        if (tag === "9F17") return ok(T(0x9f17, u8(0x03)));
        if (tag === "9F4D" && opts.logInFci === false) return ok(T(0x9f4d, u8(0x0b, 0x03)));
        return u8(0x6a, 0x88);
      }
      if (cla === 0x80 && ins === 0xa8) {
        if (opts.refuseGpo) return u8(0x69, 0x85);
        if (selected === VISA_AID) return ok(T(0x80, unhex("0080"), unhex("20010100")));
        return ok(T(0x77, T(0x82, unhex("1980")), T(0x94, unhex("0801010010010100"))));
      }
      if (ins === 0xb2) {
        const sfi = p2 >> 3;
        if (selected === "PSE") return sfi === 1 && p1 <= pseRecords.length ? ok(pseRecords[p1 - 1]) : u8(0x6a, 0x83);
        if (selected === VISA_AID) {
          const f = visaFiles[`${sfi}:${p1}`];
          if (f) return ok(f);
          return Object.keys(visaFiles).some((k) => k.startsWith(`${sfi}:`)) ? u8(0x6a, 0x83) : u8(0x6a, 0x82);
        }
        if (sfi === 0x0b) return p1 <= LOG.length ? ok(LOG[p1 - 1]) : u8(0x6a, 0x83);
        const f = files[`${sfi}:${p1}`];
        if (f) return ok(f);
        return Object.keys(files).some((k) => k.startsWith(`${sfi}:`)) ? u8(0x6a, 0x83) : u8(0x6a, 0x82);
      }
      return u8(0x6d, 0x00);
    },
  } as unknown as CardTransport;
  return { t, seen };
}

/* =========================================================== MRTD (6.6 deep) */

export const oid = (s: string) => T(0x06, oidBytes(s));
export const int = (n: number) => T(0x02, u8(n));
export const sha256 = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());

export const MRZ = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C<3UTO6908061F9406236ZE184226B<<<<<10";
export const KEY: MrzKey = { documentNumber: "L898902C", dateOfBirth: "690806", dateOfExpiry: "940623" };
const JPEG = concat(u8(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10), ascii("JFIF"), new Uint8Array(600).fill(7), u8(0xff, 0xd9));
const SIG = concat(u8(0xff, 0xd8, 0xff, 0xdb), new Uint8Array(80).fill(3), u8(0xff, 0xd9));

export const DG1 = T(0x61, T(0x5f1f, ascii(MRZ.replace("\n", ""))));
export const DG2 = T(0x75, T(0x7f61, T(0x02, u8(1)), T(0x7f60, T(0xa1, T(0x80, u8(1, 1))), T(0x5f2e, concat(ascii("FAC\0"), new Uint8Array(40), JPEG)))));
export const DG7 = T(0x67, T(0x02, u8(1)), T(0x5f43, SIG));
export const DG11 = T(0x6b, T(0x5c, u8(0x5f, 0x0e, 0x5f, 0x2b, 0x5f, 0x11, 0x5f, 0x42)), T(0x5f0e, ascii("ERIKSSON<<ANNA<MARIA")), T(0x5f2b, u8(0x19, 0x69, 0x08, 0x06)), T(0x5f11, ascii("ZENITH<UTO")), T(0x5f42, ascii("123<MAPLE<STREET<<ZENITH")), T(0x5f10, ascii("ZE184226B")));
export const DG12 = T(0x6c, T(0x5c, u8(0x5f, 0x19, 0x5f, 0x26)), T(0x5f19, ascii("UTOPIA<PASSPORT<OFFICE")), T(0x5f26, u8(0x20, 0x24, 0x01, 0x15)), T(0x5f55, ascii("20240110093000")));
const MODULUS = concat(u8(0x00), new Uint8Array(128).fill(0xa5));
export const DG15 = T(0x6f, T(0x30, T(0x30, oid("1.2.840.113549.1.1.1"), u8(0x05, 0x00)), T(0x03, u8(0x00), T(0x30, T(0x02, MODULUS), T(0x02, u8(1, 0, 1))))));
export const DG14 = T(0x6e, T(0x31, T(0x30, oid("0.4.0.127.0.7.2.2.3.2.2"), int(1)), T(0x30, oid("0.4.0.127.0.7.2.2.2"), int(1))));
export const COM = T(0x60, T(0x5f01, ascii("0107")), T(0x5f36, ascii("040000")), T(0x5c, u8(0x61, 0x75, 0x63, 0x67, 0x6b, 0x6c, 0x6e, 0x6f)));

function name(cn: string) { return T(0x30, T(0x31, T(0x30, oid("2.5.4.6"), T(0x13, ascii("UT")))), T(0x31, T(0x30, oid("2.5.4.3"), T(0x0c, ascii(cn))))); }
function certificate() {
  const tbs = T(0x30, T(0xa0, int(2)), T(0x02, u8(0x12, 0x34)), T(0x30, oid("1.2.840.113549.1.1.11")), name("CSCA Utopia"),
    T(0x30, T(0x17, ascii("240101000000Z")), T(0x17, ascii("340101000000Z"))), name("DS Utopia 1"), T(0x30, T(0x30, oid("1.2.840.113549.1.1.1")), T(0x03, u8(0))));
  return T(0x30, tbs, T(0x30, oid("1.2.840.113549.1.1.11")), T(0x03, u8(0, 1, 2)));
}
export function sod(groups: Record<number, Uint8Array>, tamper?: number) {
  const hashes = Object.entries(groups).map(([n, b]) => { const h = sha256(b); if (Number(n) === tamper) h[0] ^= 1; return T(0x30, int(Number(n)), T(0x04, h)); });
  const lds = T(0x30, int(0), T(0x30, oid("2.16.840.1.101.3.4.2.1")), T(0x30, ...hashes));
  const signedData = T(0x30, int(3), T(0x31, T(0x30, oid("2.16.840.1.101.3.4.2.1"))), T(0x30, oid("2.23.136.1.1.1"), T(0xa0, T(0x04, lds))), T(0xa0, certificate()), T(0x31));
  return T(0x77, T(0x30, oid("1.2.840.113549.1.7.2"), T(0xa0, signedData)));
}

export type Chip = { transport: CardTransport; log: string[]; selects: number[] };

/** A BAC chip from the spec: plain until mutual authentication, then every APDU in SM. */
export function bacChip(key: MrzKey, files: Record<number, Uint8Array>, opts: { cardAccess?: Uint8Array } = {}): Chip {
  const log: string[] = [];
  const selects: number[] = []; // file ids selected, as the chip decrypted them
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
      selects.push(fid);
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
    selects,
    transport: { kind: "usb", label: "sim", connected: true, waitForCard: async () => ({ uid: u8(1, 2, 3, 4) }), transmit } as unknown as CardTransport,
  };
}

export const MRTD_FILES = (tamper?: number) => {
  const groups = { 1: DG1, 2: DG2, 7: DG7, 11: DG11, 12: DG12, 14: DG14, 15: DG15 };
  return { 0x011e: COM, 0x011d: sod(groups, tamper), 0x0101: DG1, 0x0102: DG2, 0x0107: DG7, 0x010b: DG11, 0x010c: DG12, 0x010e: DG14, 0x010f: DG15 } as Record<number, Uint8Array>;
};

/* =========================================================== DESFire (6.10) */

/** GetVersion of a DESFire EV1 8 KB: hardware, software, then UID + batch + week 23 of 2019. */
export const DESFIRE_VERSION = {
  hw: unhex("04010101001A05"),
  sw: unhex("04010101011A05"),
  rest: unhex("04A1B2C3D4E5F6" + "BA7C4E5F60" + "2319"),
};

export function desfireCard(): { t: CardTransport; seen: string[] } {
  const seen: string[] = [];
  let frame = 0;
  const t = {
    transmit: async (cmd: Uint8Array) => {
      seen.push(hex(cmd));
      const [cla, ins] = cmd;
      if (cla !== 0x90) return u8(0x6e, 0x00);
      if (ins === 0x60) { frame = 1; return concat(DESFIRE_VERSION.hw, u8(0x91, 0xaf)); }
      if (ins === 0xaf && frame === 1) { frame = 2; return concat(DESFIRE_VERSION.sw, u8(0x91, 0xaf)); }
      if (ins === 0xaf && frame === 2) { frame = 0; return concat(DESFIRE_VERSION.rest, u8(0x91, 0x00)); }
      if (ins === 0x6a) return concat(unhex("010000" + "563412"), u8(0x91, 0x00)); // apps 000001 and 123456
      if (ins === 0x6e) return concat(unhex("C01200"), u8(0x91, 0x00)); // 0x0012C0 = 4800 bytes
      if (ins === 0x45) return concat(unhex("0F01"), u8(0x91, 0x00));
      return u8(0x91, 0x1c);
    },
  } as unknown as CardTransport;
  return { t, seen };
}

/* =========================================================== ISO 7816 (6.10) */

/** EF.DIR's records: two applications (an eMRTD-like and a PKI one), with labels. */
export const EF_DIR = [
  T(0x61, T(0x4f, unhex("A0000002471001")), T(0x50, ascii("ePassport"))),
  T(0x61, T(0x4f, unhex("E828BD080F")), T(0x50, ascii("PKI"))),
];

export function isoCard(opts: { atr?: boolean } = {}): { t: CardTransport; seen: string[] } {
  const seen: string[] = [];
  let ef = 0;
  let pending: Uint8Array | null = null;
  const t = {
    transmit: async (cmd: Uint8Array) => {
      seen.push(hex(cmd));
      const [, ins, p1, p2] = cmd;
      if (ins === 0xc0 && pending) { const d = pending; pending = null; return ok(d); }
      if (ins === 0xa4) {
        const fid = cmd.length >= 7 ? (cmd[5] << 8) | cmd[6] : 0;
        if (fid === 0x3f00 || fid === 0x2f00) { ef = fid; return u8(0x90, 0x00); }
        if (fid === 0x2f01 && opts.atr !== false) { ef = fid; return u8(0x90, 0x00); }
        return u8(0x6a, 0x82);
      }
      // Record 2 comes the T=0 way: "61xx, ask GET RESPONSE".
      if (ins === 0xb2 && ef === 0x2f00 && p1 === 2 && (p2 & 0x07) === 0x04) { pending = EF_DIR[1]; return u8(0x61, EF_DIR[1].length); }
      if (ins === 0xb2 && ef === 0x2f00) return p1 >= 1 && p1 <= EF_DIR.length && (p2 & 0x07) === 0x04 ? ok(EF_DIR[p1 - 1]) : u8(0x6a, 0x83);
      if (ins === 0xb0 && ef === 0x2f01) {
        // Le 0 the first time → "wrong Le, 6C0A", then the 10 bytes.
        const data = T(0x43, ascii("M5TEST01"));
        return cmd[4] === data.length ? ok(data) : u8(0x6c, data.length);
      }
      return u8(0x69, 0x86);
    },
  } as unknown as CardTransport;
  return { t, seen };
}
