// A secure-messaging channel (6.6) — what BAC and PACE both give the MRTD
// reader once the holder's document is open: send a plain APDU, get the plain
// answer back. BAC, and PACE with 3DES, wrap with 3DES + retail MAC (bac.ts);
// PACE with AES wraps with AES-CBC + CMAC (here, ICAO 9303-11 §9.8). The
// reader (mrtd.ts) never cares which. The AES wrapping is pinned to the BSI
// TR-03110 worked example's APDU log (test/nfc-pace.test.ts).

import type { CardTransport } from "../transport";
import { NfcError } from "../errors";
import { concat, encodeTlv, hex, readTlvLength, readTlvTag } from "./apdu";
import { aesCbcDecrypt, aesCbcEncrypt, aesCmac, aesEncryptBlock, aesKey } from "./aes";
import { protectApdu, unprotectResponse, type BacSession } from "./bac";

export type SmReply = { data: Uint8Array; sw: number };

export type SmChannel = {
  /** How the document was opened. */
  kind: "bac" | "pace";
  /** One exchange: protect → transmit → unprotect. */
  send(cmd: Uint8Array): Promise<SmReply>;
};

/** The channel a BAC session gives (3DES secure messaging, ICAO 9303-11 §9.8.6); PACE with 3DES uses it too, its SSC starting at zero. */
export function bacChannel(t: CardTransport, s: BacSession, kind: SmChannel["kind"] = "bac"): SmChannel {
  return {
    kind,
    async send(cmd) { return unprotectResponse(s, await t.transmit(protectApdu(s, cmd))); },
  };
}

/* ------------------------------------------------------------ AES (§9.8.7) */

/** AES session keys and the 16-byte send sequence counter (zero after PACE). */
export type AesSession = { ksenc: Uint8Array; ksmac: Uint8Array; ssc: Uint8Array };

const EMPTY: Uint8Array = new Uint8Array(0);

function incSsc(ssc: Uint8Array): void {
  for (let i = ssc.length - 1; i >= 0; i--) { ssc[i] = (ssc[i] + 1) & 0xff; if (ssc[i] !== 0) break; }
}

/** ISO 9797-1 padding method 2 to the AES block: 80 then 00s. */
function pad16(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + (16 - (data.length % 16)));
  out.set(data);
  out[data.length] = 0x80;
  return out;
}

function unpad16(data: Uint8Array): Uint8Array {
  let i = data.length - 1;
  while (i >= 0 && data[i] === 0x00) i--;
  if (i < 0 || data[i] !== 0x80) throw new NfcError("protocol", "secure messaging: the response padding is wrong");
  return data.slice(0, i);
}

/** A plain command APDU, short or extended: header, data, and the raw Le bytes. */
function parseCommand(a: Uint8Array): { header: Uint8Array; data: Uint8Array; le: Uint8Array | null; extended: boolean } {
  const header = a.slice(0, 4);
  if (a.length < 4) throw new NfcError("invalid-argument", "APDU shorter than 4 bytes");
  if (a.length === 4) return { header, data: EMPTY, le: null, extended: false };
  if (a.length === 5) return { header, data: EMPTY, le: a.slice(4, 5), extended: false };
  if (a[4] === 0x00) { // extended length: 00 Lc1 Lc2 (data) (Le1 Le2), or 00 Le1 Le2
    if (a.length === 7) return { header, data: EMPTY, le: a.slice(5, 7), extended: true };
    const lc = (a[5] << 8) | a[6];
    const rest = a.length - 7 - lc;
    if (lc === 0 || (rest !== 0 && rest !== 2)) throw new NfcError("invalid-argument", "inconsistent extended APDU length");
    return { header, data: a.slice(7, 7 + lc), le: rest ? a.slice(7 + lc) : null, extended: true };
  }
  const lc = a[4];
  const rest = a.length - 5 - lc;
  if (rest !== 0 && rest !== 1) throw new NfcError("invalid-argument", `inconsistent APDU length (Lc=${lc}, total=${a.length})`);
  return { header, data: a.slice(5, 5 + lc), le: rest ? a.slice(5 + lc) : null, extended: false };
}

/**
 * Wraps a plain APDU in AES secure messaging: CLA | 0C, the data encrypted
 * (AES-CBC, IV = E(KSenc, SSC)) in DO87 (DO85 for an odd INS), Le in DO97,
 * and DO8E = CMAC(KSmac, SSC || header || DOs) cut to 8 bytes. The SSC is
 * incremented first.
 */
export function protectAesApdu(s: AesSession, cmd: Uint8Array): Uint8Array {
  const { header, data, le, extended } = parseCommand(cmd);
  const head = Uint8Array.from([header[0] | 0x0c, header[1], header[2], header[3]]);
  incSsc(s.ssc);
  let doData = EMPTY;
  if (data.length) {
    const k = aesKey(s.ksenc);
    const enc = aesCbcEncrypt(k, pad16(data), aesEncryptBlock(k, s.ssc));
    doData = head[1] & 1 ? encodeTlv(0x85, enc) : encodeTlv(0x87, concat([0x01], enc));
  }
  const do97 = le ? encodeTlv(0x97, le) : EMPTY;
  const mac = aesCmac(s.ksmac, pad16(concat(s.ssc, pad16(head), doData, do97))).slice(0, 8);
  const body = concat(doData, do97, encodeTlv(0x8e, mac));
  if (extended || body.length > 0xff) return concat(head, [0x00, body.length >> 8, body.length & 0xff], body, [0x00, 0x00]);
  return concat(head, [body.length], body, [0x00]);
}

/**
 * Unwraps an AES secure-messaging response: checks DO8E over SSC and every
 * other data object, decrypts DO87 / DO85 (IV = E(KSenc, SSC)), and returns
 * the plain data with the status word DO99 carries. A bare status word (the
 * chip's answer to a secure-messaging error) comes back as it is.
 */
export function unprotectAesResponse(s: AesSession, resp: Uint8Array): SmReply {
  if (resp.length < 2) throw new NfcError("protocol", `Response shorter than SW1SW2 (${resp.length} bytes)`);
  const outer = (resp[resp.length - 2] << 8) | resp[resp.length - 1];
  const body = resp.subarray(0, resp.length - 2);
  incSsc(s.ssc);
  if (!body.length) return { data: EMPTY, sw: outer };
  const covered: Uint8Array[] = [];
  let mac: Uint8Array | null = null, cryptogram: Uint8Array | null = null, sw: number | null = null;
  for (let i = 0; i < body.length;) {
    const tag = readTlvTag(body, i);
    const len = readTlvLength(body, i + tag.size);
    const start = i + tag.size + len.size, end = start + len.length;
    if (end > body.length) throw new NfcError("protocol", "secure messaging: truncated response");
    const value = body.subarray(start, end);
    if (tag.tag === 0x8e) mac = value;
    else {
      covered.push(body.subarray(i, end));
      if (tag.tag === 0x87) {
        if (value[0] !== 0x01) throw new NfcError("protocol", "secure messaging: unknown padding indicator");
        cryptogram = value.subarray(1);
      } else if (tag.tag === 0x85) cryptogram = value;
      else if (tag.tag === 0x99 && value.length === 2) sw = (value[0] << 8) | value[1];
    }
    i = end;
  }
  if (!mac) throw new NfcError("protocol", "secure messaging: the response carries no MAC");
  const want = aesCmac(s.ksmac, pad16(concat(s.ssc, ...covered))).slice(0, 8);
  if (hex(want) !== hex(mac)) throw new NfcError("protocol", "secure-messaging MAC did not verify");
  let data = EMPTY;
  if (cryptogram && cryptogram.length) {
    const k = aesKey(s.ksenc);
    data = unpad16(aesCbcDecrypt(k, cryptogram, aesEncryptBlock(k, s.ssc)));
  }
  return { data, sw: sw ?? outer };
}

/** The channel PACE with AES gives. */
export function aesChannel(t: CardTransport, s: AesSession): SmChannel {
  return {
    kind: "pace",
    async send(cmd) { return unprotectAesResponse(s, await t.transmit(protectAesApdu(s, cmd))); },
  };
}
