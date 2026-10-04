// The standard APDU application templates (6.5) — the ready set an operator
// loads into m5mobile.define.apduTemplates. Two kinds of entry:
//
//   • op templates  run a full, dynamic read (the reader fills PDOL / AFL /
//     BAC itself): { label, op: "emv-read" | "eid-read", args? }.
//   • apdu templates send one SELECT / command for raw exploration in the
//     APDU console: { label, apdu: "<hex>" }.
//
// The NFC workbench's "Application template" dropdown and the m5.nfc bridge use
// the same shape. Everything here is read-only and public/holder data; the
// readers never verify a PIN, never run GENERATE AC for a transaction and
// never write.

export type ApduTemplate = {
  label: string;
  /** A high-level read op (emv-read / eid-read) — the reader drives the whole sequence. */
  op?: "emv-read" | "eid-read";
  /** Or a single APDU to send, hex. */
  apdu?: string;
  /** The AID (hex), for display. */
  aid?: string;
  /** What it does, one line. */
  note?: string;
  /** Default args for an op template (e.g. readPhoto). */
  args?: Record<string, unknown>;
};

const selectAid = (aid: string) => `00A40400${(aid.length / 2).toString(16).padStart(2, "0").toUpperCase()}${aid}00`;

/** 2PAY.SYS.DDF01 (contactless PPSE). */
const PPSE = "00A404000E325041592E5359532E444446303100";
/** 1PAY.SYS.DDF01 (contact PSE). */
const PSE = "00A404000E315041592E5359532E444446303100";

export const STANDARD_APDU_TEMPLATES: ApduTemplate[] = [
  // ---- EMV: the full reads a card reader app offers ----
  { label: "Scan / Read EMV — all", op: "emv-read", note: "PPSE → every application → GPO → records; parse the holder data." },
  { label: "Scan / Read EMV — Visa", op: "emv-read", aid: "A0000000031010", note: "Read and parse, favouring the Visa application." },
  { label: "Scan / Read EMV — Mastercard", op: "emv-read", aid: "A0000000041010", note: "Read and parse, favouring the Mastercard application." },
  { label: "Scan / Read EMV — American Express", op: "emv-read", aid: "A00000002501", note: "Read and parse, favouring the Amex application." },

  // ---- e-ID / e-passport (MRTD): BAC read ----
  { label: "Scan / Read e-passport (BAC)", op: "eid-read", note: "Open with the MRZ (passport no. + DOB + expiry) and read DG1 (MRZ) + DG2 (face)." },
  { label: "Scan / Read e-ID (BAC)", op: "eid-read", note: "Open an e-ID with the MRZ or CAN and read the MRZ data and photo." },
  { label: "Scan / Read e-passport — no photo", op: "eid-read", args: { readPhoto: false }, note: "DG1 (the MRZ data) only — skip the face for a faster read." },

  // ---- Raw selects for the APDU console ----
  { label: "SELECT PPSE (2PAY.SYS.DDF01)", apdu: PPSE, note: "The contactless payment directory." },
  { label: "SELECT PSE (1PAY.SYS.DDF01)", apdu: PSE, note: "The contact payment directory." },
  { label: "SELECT AID — Visa credit/debit", apdu: selectAid("A0000000031010"), aid: "A0000000031010" },
  { label: "SELECT AID — Visa Electron", apdu: selectAid("A0000000032010"), aid: "A0000000032010" },
  { label: "SELECT AID — Mastercard", apdu: selectAid("A0000000041010"), aid: "A0000000041010" },
  { label: "SELECT AID — Maestro", apdu: selectAid("A0000000043060"), aid: "A0000000043060" },
  { label: "SELECT AID — American Express", apdu: selectAid("A00000002501"), aid: "A00000002501" },
  { label: "SELECT AID — JCB", apdu: selectAid("A0000000651010"), aid: "A0000000651010" },
  { label: "SELECT AID — Discover", apdu: selectAid("A0000001523010"), aid: "A0000001523010" },
  { label: "SELECT AID — UnionPay", apdu: selectAid("A000000333010101"), aid: "A000000333010101" },
  { label: "GET PROCESSING OPTIONS (empty PDOL)", apdu: "80A8000002830000", note: "After a SELECT AID whose FCI has no PDOL." },
  { label: "SELECT eMRTD application", apdu: selectAid("A0000002471001"), aid: "A0000002471001", note: "The ICAO 9303 LDS1 application (passport / e-ID)." },
  { label: "GET CHALLENGE (8 bytes)", apdu: "0084000008", note: "First step of BAC — the chip's RND.ICC." },
  { label: "SELECT EF.COM", apdu: "00A4020C02011E", note: "The data-group list (after the chip is opened)." },
  { label: "SELECT EF.DG1 (MRZ)", apdu: "00A4020C020101" },
  { label: "SELECT EF.DG2 (face)", apdu: "00A4020C020102" },
];

/** As plain JSON (what m5mobile.define.apduTemplates stores). */
export function standardTemplatesJson(): ApduTemplate[] {
  return STANDARD_APDU_TEMPLATES.map((t) => ({ ...t }));
}
