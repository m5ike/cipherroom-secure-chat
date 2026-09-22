// Autodetect a card type from its CardIdentity (SAK / ATQA / ATS / ATR)
// plus any NDEF already read. Returns a ranked list of candidates, each
// with a confidence and a human-readable reason. No I/O — pure inference
// from the activation data; deeper probes (GET_VERSION, PPSE SELECT) are
// suggested via `probe` hints the workbench can act on.

import type { CardIdentity } from "../transport";
import { hex } from "./apdu";
import { hasConnectionRecord } from "./connection-card";

export type CardType =
  | "mifare-classic-1k"
  | "mifare-classic-4k"
  | "mifare-classic-mini"
  | "mifare-ultralight"
  | "ntag21x"
  | "mifare-desfire"
  | "iso-dep-generic"
  | "emv"
  | "mrtd"
  | "felica"
  | "iso15693"
  | "connection-tag"
  | "unknown";

export type Candidate = {
  type: CardType;
  label: string;
  confidence: number; // 0..1
  reason: string;
  /** Suggested follow-up probe to raise confidence, if any. */
  probe?: "get-version" | "select-ppse" | "select-mrtd" | "read-ndef" | "select-ndef-t4";
};

const LABELS: Record<CardType, string> = {
  "mifare-classic-1k": "Mifare Classic 1K",
  "mifare-classic-4k": "Mifare Classic 4K",
  "mifare-classic-mini": "Mifare Classic Mini",
  "mifare-ultralight": "Mifare Ultralight",
  "ntag21x": "NTAG21x / Ultralight EV1",
  "mifare-desfire": "Mifare DESFire",
  "iso-dep-generic": "ISO-DEP (ISO 14443-4)",
  "emv": "EMV payment card",
  "mrtd": "ICAO MRTD (ePassport)",
  "felica": "FeliCa",
  "iso15693": "ISO 15693 (vicinity)",
  "connection-tag": "M5cet připojka",
  "unknown": "Unknown",
};

function push(list: Candidate[], type: CardType, confidence: number, reason: string, probe?: Candidate["probe"]) {
  list.push({ type, label: LABELS[type], confidence, reason, probe });
}

/**
 * Rank likely card types. Highest confidence first. A "connection-tag"
 * beats everything when the NDEF MIME record is present, because that is
 * exactly what the app cares about.
 */
export function detectCard(id: CardIdentity): Candidate[] {
  const out: Candidate[] = [];

  // 1. NDEF-derived signals (works on Web NFC too, which gives no SAK/ATS).
  if (id.ndef && id.ndef.length) {
    if (hasConnectionRecord(id.ndef)) push(out, "connection-tag", 0.99, "NDEF record application/vnd.m5cet.conn present");
  }

  // 2. FeliCa / 15693 short-circuit by tech.
  if (id.tech === "felica") { push(out, "felica", 0.9, "Type F (FeliCa) responded"); return finish(out); }
  if (id.tech === "iso15693") { push(out, "iso15693", 0.9, "ISO 15693 vicinity card responded"); return finish(out); }

  const sak = id.sak;
  const atqa = id.atqa ? (id.atqa[0] | (id.atqa[1] << 8)) : undefined; // as sent LSB-first
  const ats = id.ats;
  const atr = id.atr;

  // 3. SAK-based Mifare family (ISO 14443-3 Type A).
  if (sak !== undefined) {
    const s = sak & 0xff;
    if (s === 0x08) push(out, "mifare-classic-1k", 0.9, "SAK 08 → Mifare Classic 1K");
    else if (s === 0x18) push(out, "mifare-classic-4k", 0.9, "SAK 18 → Mifare Classic 4K");
    else if (s === 0x09) push(out, "mifare-classic-mini", 0.85, "SAK 09 → Mifare Mini");
    else if (s === 0x00) {
      // Ultralight / NTAG: SAK 00 + ATQA 0044.
      const reason = `SAK 00${atqa !== undefined ? `, ATQA ${hex(id.atqa!)}` : ""} → Ultralight / NTAG family`;
      push(out, "ntag21x", 0.6, reason, "get-version");
      push(out, "mifare-ultralight", 0.5, "SAK 00, no ISO-DEP → Type 2 tag; GET_VERSION distinguishes UL / UL-C / EV1 / NTAG", "get-version");
    } else if (s === 0x20) {
      // ISO-DEP capable. Look at ATS for DESFire, else generic / EMV / MRTD.
      const desfireAts = ats && ats.length >= 5 && ats[0] === 0x75 && ats[1] === 0x77 && ats[2] === 0x81 && ats[3] === 0x02 && ats[4] === 0x80;
      if (desfireAts) push(out, "mifare-desfire", 0.9, `SAK 20 + ATS ${hex(ats!)} → DESFire`, "get-version");
      else {
        push(out, "mifare-desfire", 0.4, "SAK 20 (ISO-DEP); confirm with GetVersion", "get-version");
        push(out, "iso-dep-generic", 0.55, `SAK 20 → ISO 14443-4 card, ATS ${ats ? hex(ats) : "n/a"}`, "select-ppse");
        push(out, "emv", 0.3, "ISO-DEP card may be EMV — try SELECT PPSE (2PAY.SYS.DDF01)", "select-ppse");
        push(out, "mrtd", 0.2, "ISO-DEP card may be an ePassport — try SELECT AID A0000002471001", "select-mrtd");
      }
    } else if (s & 0x20) {
      push(out, "iso-dep-generic", 0.5, `SAK ${hex([s])} has ISO-DEP bit set`, "select-ppse");
    } else {
      push(out, "unknown", 0.3, `SAK ${hex([s])} not in the known table`);
    }
  }

  // 4. ATR-only (contact / CCID without SAK). Historical bytes may hint.
  if (sak === undefined && atr && atr.length) {
    // PC/SC storage-card ATR: 3B 8F 80 01 ... identifies the PICC type in the historical bytes.
    if (atr.length >= 15 && atr[0] === 0x3b && atr[13] !== undefined) {
      const ss = atr[13];
      if (ss === 0x08) push(out, "mifare-classic-1k", 0.75, "PC/SC ATR historical byte 08 → Mifare 1K");
      else if (ss === 0x18) push(out, "mifare-classic-4k", 0.75, "PC/SC ATR historical byte 18 → Mifare 4K");
      else if (ss === 0x00) push(out, "mifare-ultralight", 0.6, "PC/SC ATR historical byte 00 → Ultralight", "get-version");
    }
    if (out.length === 0) push(out, "iso-dep-generic", 0.4, `Contact/CCID ATR ${hex(atr)}`, "select-ppse");
  }

  // 5. ISO-DEP with an ATS but no usable SAK (Web NFC style).
  if (out.length === 0 && id.isoDep) {
    push(out, "iso-dep-generic", 0.5, "Card entered ISO-DEP", "select-ppse");
  }

  if (out.length === 0) push(out, "unknown", 0.2, "No SAK/ATS/ATR/NDEF signals to classify from");
  return finish(out);
}

function finish(list: Candidate[]): Candidate[] {
  return list.sort((a, b) => b.confidence - a.confidence);
}

export function bestCandidate(id: CardIdentity): Candidate {
  return detectCard(id)[0];
}

export { LABELS as CARD_LABELS };
