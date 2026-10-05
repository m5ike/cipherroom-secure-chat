// What a PC/SC ATR says about a card (6.13.1). Shared by the WebUSB CCID
// transport (the reader hands out the ATR after IccPowerOn) and the desktop
// system reader (SCardConnect / SCardStatus).
//
// PC/SC Part 3 builds an ATR for contactless cards:
//   3B 8n 80 01 <n historical bytes> TCK
// For a STORAGE card (MIFARE Classic, Ultralight, ICODE…) the historical
// bytes are fixed:
//   80 4F 0C A0 00 00 03 06 SS C0 C1 00 00 00 00
// with SS = the standard (03 = ISO 14443 A part 3, 0B = ISO 15693 part 3,
// 11 = FeliCa) and C0 C1 = the registered card name (0001 = MIFARE 1K …).
// For an ISO 14443-4 card they are the ATS historical bytes (Type A) or the
// ATQB application data + protocol info + MBLI (Type B, 8 bytes).
// Anything else is a contact card's own ATR (ISO 7816-3).

export type PcscAtrInfo = {
  /** 3B 8n 80 01 …: the reader built it for a contactless card. */
  contactless: boolean;
  /** A PC/SC storage card (no ISO-DEP: the reader's FF xx pseudo-APDUs reach its memory). */
  storage: boolean;
  /** SS of a storage card. */
  standard?: number;
  /** C0 C1 of a storage card. */
  cardName?: number;
  /** SAK / ATQA a storage card's name implies (ISO 14443 A), for the card detection. */
  sak?: number;
  atqa?: Uint8Array;
  /** The historical bytes (T1…Tk). */
  historical: Uint8Array;
  tech: "iso14443a" | "iso14443b" | "felica" | "iso15693" | "unknown";
  /** The card speaks ISO 7816-4 APDUs (ISO-DEP, or any contact card). */
  apdu: boolean;
};

/** PC/SC Part 3 registered card names → the SAK / ATQA such a card answers (ISO 14443 A). */
const STORAGE_NAMES: Record<number, { sak: number; atqa: number; label: string }> = {
  0x0001: { sak: 0x08, atqa: 0x0004, label: "MIFARE Classic 1K" },
  0x0002: { sak: 0x18, atqa: 0x0002, label: "MIFARE Classic 4K" },
  0x0003: { sak: 0x00, atqa: 0x0044, label: "MIFARE Ultralight" },
  0x0026: { sak: 0x09, atqa: 0x0004, label: "MIFARE Mini" },
  0x0036: { sak: 0x08, atqa: 0x0004, label: "MIFARE Plus 2K (SL1)" },
  0x0037: { sak: 0x18, atqa: 0x0002, label: "MIFARE Plus 4K (SL1)" },
  0x003a: { sak: 0x00, atqa: 0x0044, label: "MIFARE Ultralight C" },
  0x003d: { sak: 0x00, atqa: 0x0044, label: "MIFARE Ultralight EV1 / NTAG" },
};

/** The registered name of a storage card, when known ("MIFARE Classic 1K"). */
export function storageCardLabel(cardName: number | undefined): string | undefined {
  return cardName === undefined ? undefined : STORAGE_NAMES[cardName]?.label;
}

/** Splits an ATR into its parts; null when it is not an ATR at all. */
export function parsePcscAtr(atr: Uint8Array | null | undefined): PcscAtrInfo | null {
  if (!atr || atr.length < 2 || (atr[0] !== 0x3b && atr[0] !== 0x3f)) return null;
  // Walk the interface bytes (TA/TB/TC/TD) to find the historical bytes.
  const t0 = atr[1];
  const k = t0 & 0x0f;
  let p = 2;
  let y = t0 >> 4;
  for (;;) {
    let td = -1;
    if (y & 0x1) p++;
    if (y & 0x2) p++;
    if (y & 0x4) p++;
    if (y & 0x8) td = atr[p++];
    if (td < 0 || p > atr.length) break;
    y = td >> 4;
  }
  const historical = atr.slice(Math.min(p, atr.length), Math.min(p + k, atr.length));
  const contactless = atr[0] === 0x3b && (t0 & 0xf0) === 0x80 && atr[2] === 0x80 && atr[3] === 0x01;
  const info: PcscAtrInfo = { contactless, storage: false, historical, tech: "unknown", apdu: true };
  if (!contactless) return info; // a contact card: APDUs, no RF technology
  const h = historical;
  if (h.length >= 11 && h[0] === 0x80 && h[1] === 0x4f && h[2] === 0x0c && h[3] === 0xa0 && h[4] === 0x00 && h[5] === 0x00 && h[6] === 0x03 && h[7] === 0x06) {
    info.storage = true;
    info.apdu = false;
    info.standard = h[8];
    info.cardName = (h[9] << 8) | h[10];
    const ss = h[8];
    info.tech = ss >= 0x01 && ss <= 0x03 ? "iso14443a" : ss >= 0x05 && ss <= 0x07 ? "iso14443b" : ss >= 0x09 && ss <= 0x0c ? "iso15693" : ss === 0x11 ? "felica" : "unknown";
    const known = STORAGE_NAMES[info.cardName];
    if (known && info.tech === "iso14443a") {
      info.sak = known.sak;
      info.atqa = Uint8Array.of(known.atqa & 0xff, (known.atqa >> 8) & 0xff);
    }
    return info;
  }
  // ISO 14443-4: Type B carries exactly 8 bytes (ATQB app data, protocol info, MBLI); else Type A's ATS bytes.
  info.tech = h.length === 8 ? "unknown" : "iso14443a";
  return info;
}
