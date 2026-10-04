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

/**
 * 6.6: one entry of a card's transaction log (history), decoded by the card's
 * own log format (9F4F). Known keys: date (YYYY-MM-DD), time (HH:MM:SS),
 * amount / otherAmount (major units, e.g. "12.34"), currency (alpha), country,
 * type (purchase, cash…), merchant, atc, cid; any other element is kept under
 * its tag hex. `raw` is the record as read (hex).
 */
export type EmvLogEntry = Record<string, string>;

/** 6.6: one record as read (SFI / record number) — the raw bytes, hex. */
export type EmvRecord = { sfi: number; record: number; hex: string; log?: boolean };

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
  /** 6.6: the last online ATC register (tag 9F13). */
  lastOnlineAtc?: number;
  /** 6.6: application interchange profile and file locator, hex (from GPO). */
  aip?: string;
  afl?: string;
  /** Decoded transaction log (tags 9F4D / 9F4F), where the card exposes one — newest first. */
  log?: EmvLogEntry[];
  /** 6.6: the log's own format (the 9F4F DOL, hex) and where it lives. */
  logFormat?: string;
  logSfi?: number;
  /** 6.6: what GET DATA answered (counters, log format, balances). */
  getData?: EmvTag[];
  /** 6.6: every record read — the AFL's and, with a deep read, any other file. */
  records?: EmvRecord[];
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
  /** 6.6: how the read went — deep (every file) or the AFL only, with the history. */
  deep?: boolean;
  /** 6.6: how many APDUs the read took. */
  apdus?: number;
};

/** EMV read options (args of the emv-read op). */
export type EmvReadArgs = {
  /** How many applications to open (default 8). */
  maxApps?: number;
  /** Read the transaction log (default true). */
  history?: boolean;
  /** Read every file the card has, not only the AFL's records (default true). */
  deep?: boolean;
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

/** 6.6: DG11 — additional personal details (each where the document has it). */
export type MrtdPersonal = {
  fullName?: string;
  otherNames?: string[];
  personalNumber?: string;
  fullDateOfBirth?: string;
  placeOfBirth?: string;
  address?: string;
  telephone?: string;
  profession?: string;
  title?: string;
  personalSummary?: string;
  otherTravelDocuments?: string[];
  custody?: string;
};

/** 6.6: DG12 — additional document details. */
export type MrtdDocument = {
  issuingAuthority?: string;
  dateOfIssue?: string;
  otherPersons?: string[];
  endorsements?: string;
  taxExit?: string;
  personalizationTime?: string;
  personalizationDevice?: string;
};

/** 6.6: one elementary file of the document and what became of it. */
export type MrtdFileInfo = {
  /** DG1…DG16, COM, SOD, CardAccess. */
  name: string;
  /** File id, hex (0101…). */
  fid: string;
  /** read — protected (EAC: needs a terminal certificate) — absent — error. */
  status: "read" | "protected" | "absent" | "error";
  size?: number;
  /** Its hash matches the one in EF.SOD (passive authentication), when checked. */
  hashOk?: boolean;
  message?: string;
};

/** 6.6: an image the document holds (face, portrait, signature, document scans). */
export type MrtdImage = {
  /** Where it came from: DG2, DG5, DG7, DG11, DG12. */
  group: string;
  kind: "face" | "portrait" | "signature" | "document" | "other";
  mime: string;
  /** base64. */
  data: string;
  name: string;
};

/** 6.6: a binary file for download (EF.SOD, DG14, DG15, raw groups…). */
export type CardFile = { name: string; mime: string; data: string };

/** 6.6: the document's security objects, as read (nothing here is verified against a CSCA list). */
export type MrtdSecurity = {
  /** The hash EF.SOD uses (SHA-256…). */
  hashAlgorithm?: string;
  /** Passive authentication of what was read: every hash matched, one did not, or it could not be checked. */
  passive?: "ok" | "mismatch" | "unchecked";
  /** The document signer certificate (from EF.SOD). */
  signer?: { subject?: string; issuer?: string; serial?: string; notBefore?: string; notAfter?: string };
  /** Security protocols the chip announces (EF.CardAccess, DG14): PACE, Chip / Terminal / Active Authentication. */
  protocols?: string[];
  /** DG15: the Active Authentication key (RSA 1024, EC 256…). */
  activeAuthKey?: string;
};

export type MrtdData = {
  present: boolean;
  /** How the chip was opened: none (just detected), BAC or PACE. */
  access: "none" | "bac" | "pace";
  /** 6.6: PACE as the chip offers it (EF.CardAccess) — and the protocol used. */
  pace?: { supported: boolean; protocol?: string; parameterId?: number; used?: boolean; password?: "mrz" | "can" };
  /** The data groups EF.COM lists (e.g. ["DG1","DG2"]). */
  dataGroups?: string[];
  /** 6.6: LDS / Unicode versions from EF.COM. */
  ldsVersion?: string;
  unicodeVersion?: string;
  /** DG1 fields (the MRZ). */
  mrzInfo?: MrtdMrz;
  /** 6.6: DG11 / DG12 / DG13 / DG16. */
  personal?: MrtdPersonal;
  document?: MrtdDocument;
  optional?: string;
  personsToNotify?: string[];
  /** DG2 face image, base64 — the holder's own document. */
  photo?: string;
  photoMime?: string;
  /** 6.6: every image the document holds (DG2 faces, DG5 portrait, DG7 signature, DG11/DG12 scans). */
  images?: MrtdImage[];
  /** 6.6: every file tried, and how it went. */
  files?: MrtdFileInfo[];
  /** 6.6: the binary files for download (EF.SOD, DG14, DG15, other raw groups, JPEG 2000 images). */
  raw?: CardFile[];
  /** 6.6: EF.SOD, DG14, DG15 and EF.CardAccess, decoded. */
  security?: MrtdSecurity;
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
  /** Read the images (DG2, DG5, DG7, scans) — default true. */
  readPhoto?: boolean;
  /** 6.6: read every data group the document lists, not only DG1 / DG2 (default true). */
  all?: boolean;
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
