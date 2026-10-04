// The NFC command protocol (6.3) — how a Functions model reaches the caller's
// NFC hardware, both ways.
//
// A model calls `await m5.nfc.scan()` (or read/write/emulate/…). The sandbox
// turns that into an NfcCommand and sends it to the caller as a run
// INTERACTION of kind "nfc" — the same live channel the prompt/form
// interactions already use. The caller's NFC bridge (client or Android)
// runs the op on the chosen reader and answers with an NfcResult through the
// run's events endpoint, which resolves the waiting `await`. So the server
// never touches a card itself; it asks the device that has one.
//
// Every op id is one from catalog.ts, so a model can only ask for what a card
// actually supports, and the same names appear in the SDK, the Builder nodes
// and the docs.

import type { NfcTech, ReaderKind } from "./catalog";
import type { M5RecordType } from "./m5card";

export const NFC_INTERACTION = "nfc" as const;

/** What a model asks the caller's device to do. */
export type NfcCommand = {
  /** A catalogue op id (scan, read-uid, ndef-read, classic-read, m5-read, write-uid…). */
  op: string;
  /** Which reader to use; the device's own by default. */
  reader?: ReaderKind;
  /** Narrow to a card technology (else whatever is presented). */
  tech?: NfcTech;
  /** How long to wait for a card, seconds (default 20, max 120). */
  timeout?: number;
  /** Op arguments — never a key or PIN in the clear: see `secretRef`. */
  args?: Record<string, unknown>;
  /**
   * A model must not handle the user's keys. To read/write a protected card,
   * it names a secret the DEVICE holds (a saved key set, the account) rather
   * than sending a key: the bridge resolves it locally and never returns it.
   */
  secretRef?: string;
  /** For an M5Cet op, which record types to open or the records to write. */
  records?: M5RecordType[];
};

export type NfcResultStatus = "ok" | "no-card" | "timeout" | "unsupported" | "denied" | "auth-failed" | "error";

/* --------------------------------------------------- EMV (6.5, read-only) */

/** One parsed EMV data element (its tag, EMV name, printable value and raw hex). */
export type EmvTag = { tag: string; name: string; value: string; hex: string };

/** One application on an EMV card — public / holder data a terminal reads. */
export type EmvApp = {
  /** The AID (hex). */
  aid: string;
  /** Application label / preferred name (tags 50 / 9F12). */
  label?: string;
  /** Visa, Mastercard, Amex, Discover, JCB, UnionPay… from the AID. */
  scheme?: string;
  /** The PAN as read (holder's own card). */
  pan?: string;
  /** The PAN with the middle digits hidden (for display). */
  panMasked?: string;
  /** Expiry as YYYY-MM (tag 5F24). */
  expiry?: string;
  /** Cardholder name (tag 5F20) — absent on most contactless cards. */
  cardholder?: string;
  /** Effective date YYYY-MM (tag 5F25). */
  effective?: string;
  /** Issuer country (ISO-3166 numeric → alpha, tag 5F28). */
  issuerCountry?: string;
  /** PAN sequence number (tag 5F34). */
  panSequence?: string;
  /** Application transaction counter (tag 9F36). */
  atc?: number;
  /** PIN try counter value as read (tag 9F17) — never a PIN, never a verify. */
  pinTryCounter?: number;
  /** Decoded transaction log (tags 9F4D / 9F4F), where the card exposes one. */
  log?: Array<Record<string, string>>;
  /** Every element parsed from this application's records. */
  tags: EmvTag[];
};

export type EmvData = {
  /** The top scheme (from the first AID), for a one-line summary. */
  scheme?: string;
  /** Every AID the card offered (hex). */
  aids: string[];
  /** One entry per application read. */
  apps: EmvApp[];
  /** The PPSE's TLV as a readable tree. */
  tree?: string;
};

/* ------------------------------------------- MRTD / e-ID / e-Passport (6.5) */

/** The holder-readable fields of DG1 (the MRZ), parsed. */
export type MrtdMrz = {
  documentCode?: string;
  documentNumber?: string;
  issuer?: string;
  nationality?: string;
  surname?: string;
  givenNames?: string;
  dateOfBirth?: string;
  sex?: string;
  dateOfExpiry?: string;
  optionalData?: string;
  /** The raw MRZ lines, joined by "\n". */
  mrz?: string;
};

export type MrtdData = {
  present: boolean;
  /** How the chip was opened: none (just detected), BAC or PACE. */
  access: "none" | "bac" | "pace";
  /** The data groups EF.COM lists (e.g. ["DG1","DG2"]). */
  dataGroups?: string[];
  /** DG1 fields (the MRZ). */
  mrzInfo?: MrtdMrz;
  /** DG2 face image, base64 — the holder's own document. */
  photo?: string;
  photoMime?: string;
  message?: string;
};

/** The BAC key material the holder supplies (from the MRZ), or a CAN for PACE. */
export type MrtdAccessArgs = {
  /** The whole MRZ (2 or 3 lines) — the BAC key is derived from it. */
  mrz?: string;
  /** Or just the three fields the BAC key needs. */
  documentNumber?: string;
  /** YYMMDD. */
  dateOfBirth?: string;
  /** YYMMDD. */
  dateOfExpiry?: string;
  /** A 6-digit Card Access Number (PACE), for cards that require it. */
  can?: string;
};

/** What the device answers. Never carries a key or a card PIN. */
export type NfcResult = {
  status: NfcResultStatus;
  /** The card as seen: uid, technology, ATQA/SAK/ATS/ATR, memory. */
  card?: {
    uid: string;
    tech: NfcTech;
    label: string;
    atqa?: string;
    sak?: string;
    ats?: string;
    atr?: string;
    memory?: string;
  };
  /** Public NDEF records, decoded (text/URI/MIME/external). */
  ndef?: Array<{ kind: string; type?: string; text?: string; lang?: string; data?: string }>;
  /** Raw read data, base64 (a dump, a block, an APDU response). */
  data?: string;
  /** M5Cet records opened for the model (public fields only unless the model
   *  is allowed the content; secrets stay on the device by default). */
  records?: Array<{ id: number; type: M5RecordType; oneTime: boolean; summary: string }>;
  /** 6.5: a full EMV read — the public / holder data a terminal reads. */
  emv?: EmvData;
  /** 6.5: a full MRTD read (e-ID / e-Passport), opened with the holder's MRZ or CAN. */
  mrtd?: MrtdData;
  /** Human message for a non-ok status. */
  message?: string;
};

const OK_TIMEOUT = { min: 1, max: 120, def: 20 };

export function normalizeCommand(raw: unknown): NfcCommand | null {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const op = typeof r.op === "string" && /^[a-z][a-z0-9-]{1,32}$/.test(r.op) ? r.op : null;
  if (!op) return null;
  const reader = ["internal", "usb", "bluetooth", "serial"].includes(r.reader as string) ? (r.reader as ReaderKind) : undefined;
  const timeout = typeof r.timeout === "number" && Number.isFinite(r.timeout)
    ? Math.max(OK_TIMEOUT.min, Math.min(OK_TIMEOUT.max, Math.round(r.timeout))) : undefined;
  const cmd: NfcCommand = { op };
  if (reader) cmd.reader = reader;
  if (typeof r.tech === "string") cmd.tech = r.tech as NfcTech;
  if (timeout) cmd.timeout = timeout;
  if (r.args && typeof r.args === "object") cmd.args = r.args as Record<string, unknown>;
  if (typeof r.secretRef === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(r.secretRef)) cmd.secretRef = r.secretRef;
  if (Array.isArray(r.records)) cmd.records = r.records.filter((x): x is M5RecordType => typeof x === "string") as M5RecordType[];
  return cmd;
}
