// APDU application templates — what an operator loads into
// m5mobile.define.apduTemplates and the NFC tool runs (web and Android).
//
// 6.10: a template is the COMPLETE read of one card type: a list of steps the
// runner executes one after another over ISO-DEP, recording every command and
// response. A step is either a fixed command ({ apdu: "<hex>" }) or a reader
// operation ({ op: … }) whose command depends on what the card answered before
// — the PDOL a GET PROCESSING OPTIONS must fill, the AFL a READ RECORD must
// follow, the AIDs a directory lists. Fixed commands alone cannot read a payment
// card (every card's records differ), and an e-ID / e-passport speaks only
// through secure messaging opened with the holder's key, so its read is one
// operation ("eid-read") whose every command still appears in the transcript.
//
// Before 6.10 an entry was one command or one whole-read op: { label, apdu } /
// { label, op: "emv-read" | "eid-read", args?, aid? }. Both still run (as a
// one-step template); the standard set below replaces them.
//
// Everything is read-only and public / holder data: the runner never verifies a
// PIN (9F17 is read as a counter), never runs GENERATE AC, never writes.
//
// The CONTRACT shared by the web runner (client/src/lib/nfc/template-runner.ts),
// the Android runner (android/…/nfc/TemplateRunner.java), the console's Define
// builder ("Load standard templates") and the Functions bridge (m5.nfc).

export type TemplateStep =
  /** A fixed command (hex). `expect`: status words that count as success ("9000" default; "61xx" / "6Cxx" are followed up automatically). */
  | { apdu: string; label?: string; optional?: boolean; expect?: string[] }
  /** SELECT 2PAY.SYS.DDF01 (contactless directory) → the AIDs it lists. */
  | { op: "select-ppse"; label?: string; optional?: boolean }
  /** SELECT 1PAY.SYS.DDF01 (contact directory) → its SFI, whose records list the AIDs. */
  | { op: "select-pse"; label?: string; optional?: boolean }
  /** SELECT an application: `aid` given, else the current one of a for-each-aid loop. Keeps its FCI (PDOL, label, priority). */
  | { op: "select-aid"; aid?: string; label?: string; optional?: boolean }
  /** GET DATA (80 CA) for each tag — ATC 9F36, last online ATC 9F13, PIN try counter 9F17, log entry 9F4D, log format 9F4F, … Missing tags are not errors. */
  | { op: "get-data"; tags: string[]; label?: string }
  /** The transaction log: 9F4D (SFI, count) + 9F4F (format) → READ RECORD of each entry, decoded by the format. */
  | { op: "read-log"; label?: string }
  /** GET PROCESSING OPTIONS with the PDOL filled with a terminal's neutral defaults (no transaction is made) → AIP + AFL. */
  | { op: "gpo"; label?: string }
  /** READ RECORD of every record the AFL lists. */
  | { op: "read-afl"; label?: string }
  /** READ RECORD over a range of short files / records (a deep scan beyond the AFL); stops a file at its first "not found". */
  | { op: "read-files"; sfi?: [number, number]; records?: [number, number]; label?: string }
  /** Runs `steps` for every AID the directory listed (or `aids`, or the well-known payment AIDs when there was no directory), at most `max`. */
  | { op: "for-each-aid"; steps: TemplateStep[]; aids?: string[]; max?: number; label?: string }
  /** The e-ID / e-passport read: EF.CardAccess → PACE (CAN / MRZ) or BAC → secure messaging → EF.COM, EF.SOD, every readable DG. Asks the holder's key on the device. */
  | { op: "eid-read"; args?: { readPhoto?: boolean; all?: boolean }; label?: string }
  /** The whole EMV reader in one step (6.6) — kept for older templates. */
  | { op: "emv-read"; args?: { aid?: string; deep?: boolean; history?: boolean }; label?: string };

export type ApduTemplate = {
  label: string;
  /** The card type it reads — groups the menu and picks the readable report. */
  card?: "emv" | "emrtd" | "desfire" | "iso7816";
  /** What it does, one line. */
  note?: string;
  /** The application (for display; legacy op templates: the preferred AID). */
  aid?: string;
  /** 6.10: the read, step by step. */
  steps?: TemplateStep[];
  /** Legacy (≤ 6.9): one whole-read op … */
  op?: "emv-read" | "eid-read";
  args?: Record<string, unknown>;
  /** … or one command (hex; several lines = several commands). */
  apdu?: string;
};

/** The output views of a run (both platforms, the same names). */
export const TEMPLATE_VIEWS = ["io", "raw", "json", "readable"] as const;
export type TemplateView = typeof TEMPLATE_VIEWS[number];
//   io        every command and its response:  → 00A40400…   ← 6F2E…  90 00 (OK)
//   raw       the responses only (hex + status word), one per line
//   json      [{ step, label, command, response, sw, status, ms, op? }] — commands and responses
//   readable  formatted for people: applications, holder, PAN masked, expiry, counters, the
//             transaction history, the e-ID holder and photo… (the 6.6 card report)
//
// The output can be SHARED (the system share sheet / Web Share / copy), FORWARDED
// (pick a room, then everyone or one member — sent as a message: readable text, or
// the JSON as a file) or kept TO MYSELF (a private note in the current room's
// history, visible only to me and never sent) — three icons above the output.

/** One recorded exchange of a run (what io / raw / json show). */
export type TemplateExchange = {
  step: number;
  label: string;
  /** The reader operation that sent it (select-aid, gpo, read-afl …) or "" for a fixed command. */
  op: string;
  command: string;
  response: string;
  sw: string;
  /** "ok" (expected status), "warn" (an optional step / a tolerated status), "error". */
  status: "ok" | "warn" | "error";
  ms: number;
};

/* ------------------------------------------------------------- the set */

const EMV_COUNTERS = ["9F36", "9F13", "9F17", "9F4D", "9F4F", "9F6E"];

/** One payment application, completely: select it, its counters and log before the transaction starts, then the records a terminal reads. */
const EMV_APP = (aid?: string): TemplateStep[] => [
  { op: "select-aid", ...(aid ? { aid } : {}) },
  { op: "get-data", tags: EMV_COUNTERS, label: "Counters and log format (GET DATA)" },
  { op: "read-log", label: "Transaction history" },
  { op: "gpo", label: "GET PROCESSING OPTIONS (no transaction)" },
  { op: "read-afl", label: "Records the AFL lists" },
  { op: "read-files", sfi: [1, 10], records: [1, 16], label: "Other short files (deep)" },
];

/** A scheme's card: the directory when the card has one (optional — some cards only answer the AID), then the application. */
const SCHEME = (label: string, aid: string, note: string): ApduTemplate => ({
  label, card: "emv", aid, note,
  steps: [{ op: "select-ppse", optional: true }, ...EMV_APP(aid)],
});

export const STANDARD_APDU_TEMPLATES: ApduTemplate[] = [
  {
    label: "Payment card (EMV) — every application", card: "emv",
    note: "PPSE → each application: SELECT, counters, history, GPO, records, other files.",
    steps: [{ op: "select-ppse", optional: true }, { op: "for-each-aid", max: 8, steps: EMV_APP() }],
  },
  {
    label: "Payment card (EMV, contact / PSE) — every application", card: "emv",
    note: "For a USB / contact reader: PSE → each application, as above.",
    steps: [{ op: "select-pse", optional: true }, { op: "for-each-aid", max: 8, steps: EMV_APP() }],
  },
  SCHEME("Visa (credit / debit)", "A0000000031010", "Visa: SELECT, counters, history, GPO, records."),
  SCHEME("Visa Electron", "A0000000032010", "Visa Electron: SELECT, counters, history, GPO, records."),
  SCHEME("V PAY", "A0000000032020", "V PAY: SELECT, counters, history, GPO, records."),
  SCHEME("Mastercard (credit / debit)", "A0000000041010", "Mastercard: SELECT, counters, history, GPO, records."),
  SCHEME("Maestro", "A0000000043060", "Maestro: SELECT, counters, history, GPO, records."),
  SCHEME("American Express", "A00000002501", "Amex: SELECT, counters, history, GPO, records."),
  SCHEME("JCB", "A0000000651010", "JCB: SELECT, counters, history, GPO, records."),
  SCHEME("Discover / Diners", "A0000001523010", "Discover: SELECT, counters, history, GPO, records."),
  SCHEME("UnionPay (debit)", "A000000333010101", "UnionPay debit: SELECT, counters, history, GPO, records."),
  SCHEME("UnionPay (credit)", "A000000333010102", "UnionPay credit: SELECT, counters, history, GPO, records."),
  {
    label: "e-ID / e-passport (PACE or BAC) — everything", card: "emrtd",
    note: "EF.CardAccess → PACE with the CAN (or the MRZ), else BAC → EF.COM, EF.SOD, DG1 (MRZ), DG2 (face), DG7, DG11–DG15 … (the key is asked on the device).",
    steps: [{ op: "eid-read", args: { readPhoto: true, all: true } }],
  },
  {
    label: "e-ID / e-passport — MRZ data only (fast)", card: "emrtd",
    note: "Opens the document and reads EF.COM, EF.SOD and DG1 (the MRZ data) — no photo.",
    steps: [{ op: "eid-read", args: { readPhoto: false, all: false } }],
  },
  {
    label: "MIFARE DESFire — version, applications, free memory", card: "desfire",
    note: "Native DESFire commands wrapped in ISO 7816 (no keys): GetVersion (3 frames), GetApplicationIDs, GetFreeMemory, GetKeySettings of the PICC.",
    steps: [
      { apdu: "9060000000", label: "GetVersion — hardware", expect: ["91AF"] },
      { apdu: "90AF000000", label: "GetVersion — software", expect: ["91AF"] },
      { apdu: "90AF000000", label: "GetVersion — UID, batch, production date", expect: ["9100"] },
      { apdu: "906A000000", label: "GetApplicationIDs", expect: ["9100", "91AF"], optional: true },
      { apdu: "906E000000", label: "GetFreeMemory", expect: ["9100"], optional: true },
      { apdu: "9045000000", label: "GetKeySettings (PICC)", expect: ["9100"], optional: true },
    ],
  },
  {
    label: "Smart card (ISO 7816-4) — master file, EF.DIR, EF.ATR", card: "iso7816",
    note: "Any ISO-DEP card: SELECT MF, the application directory EF.DIR (its records) and EF.ATR — what a generic card publishes.",
    steps: [
      { apdu: "00A4000C023F00", label: "SELECT MF (3F00)", optional: true },
      { apdu: "00A4020C022F00", label: "SELECT EF.DIR (2F00)", optional: true },
      { apdu: "00B2010400", label: "READ RECORD 1 of EF.DIR", optional: true },
      { apdu: "00B2020400", label: "READ RECORD 2 of EF.DIR", optional: true },
      { apdu: "00B2030400", label: "READ RECORD 3 of EF.DIR", optional: true },
      { apdu: "00B2040400", label: "READ RECORD 4 of EF.DIR", optional: true },
      { apdu: "00A4020C022F01", label: "SELECT EF.ATR (2F01)", optional: true },
      { apdu: "00B0000000", label: "READ BINARY EF.ATR", optional: true },
    ],
  },
];

/** As plain JSON (what m5mobile.define.apduTemplates stores). */
export function standardTemplatesJson(): ApduTemplate[] {
  return JSON.parse(JSON.stringify(STANDARD_APDU_TEMPLATES)) as ApduTemplate[];
}

/**
 * The steps a saved template runs — its own, or (an older entry) its one op
 * or its command lines turned into steps. [] when it has nothing runnable.
 */
export function templateSteps(t: ApduTemplate | Record<string, unknown>): TemplateStep[] {
  const x = t as ApduTemplate;
  if (Array.isArray(x.steps) && x.steps.length) return x.steps;
  if (x.op === "emv-read") return [{ op: "emv-read", args: { ...(x.args ?? {}), ...(x.aid ? { aid: x.aid } : {}) } }];
  if (x.op === "eid-read") return [{ op: "eid-read", args: (x.args ?? {}) as { readPhoto?: boolean; all?: boolean } }];
  const raw = String((x as Record<string, unknown>).apdu ?? (x as Record<string, unknown>).apduHex ?? "");
  return raw.split(/\r?\n/).map((l) => l.replace(/[^0-9A-Fa-f]/g, "")).filter((h) => h.length >= 8 && h.length % 2 === 0).map((h) => ({ apdu: h.toUpperCase() }));
}

/* ------------------------------------------------------------ read-only */

/**
 * 6.10 (G-18): a template, a raw APDU of m5.nfc (raw-apdu) and every command
 * the template runner sends only READ — the same list as Android
 * (ApduTemplates.readCommand / secureChannelCommand / commandProblem):
 *   iso      the interindustry class (CLA 00–1F, 40–7F): SELECT A4, READ BINARY B0,
 *            READ RECORD B2, GET DATA CA, GET RESPONSE C0
 *   emv      EMV's proprietary class (CLA 80–8F): GET PROCESSING OPTIONS A8 (a neutral
 *            PDOL, no transaction), GET DATA CA, GET RESPONSE C0 (a GPO answering 61xx)
 *   desfire  CLA 90: GetVersion 60 (+ its frames AF), GetApplicationIDs 6A, GetFreeMemory 6E,
 *            GetKeySettings 45
 *   channel  ONLY inside eid-read — the document's own secure channel (BAC / PACE,
 *            cards/mrtd.ts): GET CHALLENGE 84, EXTERNAL / MUTUAL AUTHENTICATE 82,
 *            MANAGE SECURITY ENVIRONMENT 22, GENERAL AUTHENTICATE 86, READ BINARY B1 (odd INS)
 * Anything else — VERIFY, GENERATE AC, INTERNAL AUTHENTICATE, UPDATE / WRITE / APPEND /
 * ERASE, PUT DATA, CREATE / DELETE / TERMINATE, a DESFire write or key change — is
 * refused: "not a read command: 00 20 (VERIFY)".
 */
export const READ_ONLY_COMMANDS = {
  iso: { A4: "SELECT", B0: "READ BINARY", B2: "READ RECORD", CA: "GET DATA", C0: "GET RESPONSE" },
  emv: { A8: "GET PROCESSING OPTIONS", CA: "GET DATA", C0: "GET RESPONSE" },
  desfire: { "60": "GetVersion", AF: "GetVersion (additional frame)", "6A": "GetApplicationIDs", "6E": "GetFreeMemory", "45": "GetKeySettings" },
  channel: { "84": "GET CHALLENGE", "82": "EXTERNAL AUTHENTICATE", "22": "MANAGE SECURITY ENVIRONMENT", "86": "GENERAL AUTHENTICATE", B1: "READ BINARY (odd)" },
} as const;

/** An interindustry class (ISO 7816-4: logical channels, secure messaging, chaining). */
export const isoClass = (cla: number) => (cla & 0xe0) === 0x00 || (cla & 0xc0) === 0x40;
/** EMV's proprietary class (80 GET PROCESSING OPTIONS, 80 GET DATA). */
export const emvClass = (cla: number) => (cla & 0xf0) === 0x80;

const insHex = (ins: number) => (ins & 0xff).toString(16).padStart(2, "0").toUpperCase();

/** Whether a command only reads (G-18). */
export function readCommand(cla: number, ins: number): boolean {
  const i = insHex(ins);
  if (isoClass(cla)) return i in READ_ONLY_COMMANDS.iso;
  if (emvClass(cla)) return i in READ_ONLY_COMMANDS.emv;
  if (cla === 0x90) return i in READ_ONLY_COMMANDS.desfire;
  return false;
}

/** The e-ID reader's own secure-channel commands — allowed only inside eid-read. */
export function secureChannelCommand(cla: number, ins: number): boolean {
  return isoClass(cla) && insHex(ins) in READ_ONLY_COMMANDS.channel;
}

const INS_NAMES: Record<number, string> = {
  0x20: "VERIFY", 0x21: "VERIFY", 0x24: "CHANGE REFERENCE DATA", 0x2c: "RESET RETRY COUNTER", 0xae: "GENERATE AC",
  0xd6: "UPDATE BINARY", 0xd7: "UPDATE BINARY", 0xdc: "UPDATE RECORD", 0xdd: "UPDATE RECORD", 0xe2: "APPEND RECORD",
  0xda: "PUT DATA", 0xdb: "PUT DATA", 0xd0: "WRITE BINARY", 0xd1: "WRITE BINARY", 0xd2: "WRITE RECORD", 0xe0: "CREATE FILE",
  0xe4: "DELETE FILE", 0x0e: "ERASE BINARY", 0x0f: "ERASE BINARY", 0x44: "ACTIVATE FILE", 0x04: "DEACTIVATE FILE",
  0xe6: "TERMINATE DF", 0xe8: "TERMINATE CARD", 0x88: "INTERNAL AUTHENTICATE", 0x84: "GET CHALLENGE", 0x82: "EXTERNAL AUTHENTICATE",
  0x86: "GENERAL AUTHENTICATE", 0x22: "MANAGE SECURITY ENVIRONMENT", 0x2a: "PERFORM SECURITY OPERATION", 0x1e: "APPLICATION BLOCK",
  0x18: "APPLICATION UNBLOCK", 0x16: "CARD BLOCK", 0xb1: "READ BINARY (odd)",
};
const DESFIRE_NAMES: Record<number, string> = {
  0xfc: "FormatPICC", 0xda: "DeleteApplication", 0xca: "CreateApplication", 0x3d: "WriteData", 0x3b: "WriteRecord",
  0xc4: "ChangeKey", 0x54: "ChangeKeySettings", 0x0a: "Authenticate", 0x1a: "AuthenticateISO", 0xaa: "AuthenticateAES",
  0xdf: "DeleteFile", 0x5f: "ChangeFileSettings", 0x0c: "Credit", 0xdc: "Debit", 0xc7: "CommitTransaction", 0x5c: "SetConfiguration",
};

/** Why a template's fixed command may not run (G-18), or null when it only reads: "not a read command: 00 20 (VERIFY)". */
export function commandProblem(hex: string): string | null {
  const h = String(hex ?? "").replace(/\s/g, "").toUpperCase();
  if (h.length < 4 || !/^[0-9A-F]+$/.test(h)) return `not a read command: ${h}`;
  const cla = parseInt(h.slice(0, 2), 16), ins = parseInt(h.slice(2, 4), 16);
  if (readCommand(cla, ins)) return null;
  const name = cla === 0x90 ? DESFIRE_NAMES[ins] : INS_NAMES[ins];
  return `not a read command: ${h.slice(0, 2)} ${h.slice(2, 4)}${name ? ` (${name})` : ""}`;
}

/**
 * Why a command may not go to the card, or null: a read — or, with `channel`
 * (the runner, inside eid-read only), the document's secure-channel commands.
 */
export function readOnlyRefusal(apdu: string | ArrayLike<number>, opts: { channel?: boolean } = {}): string | null {
  const h = typeof apdu === "string" ? apdu.replace(/\s/g, "").toUpperCase() : Array.from(apdu, (b) => insHex(b)).join("");
  if (h.length < 8) return "not a command";
  if (opts.channel && /^[0-9A-F]{4}/.test(h) && secureChannelCommand(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16))) return null;
  return commandProblem(h);
}

/** Problems of one template (the Define builder and the runners say them before running). */
export function templateProblems(t: unknown): string[] {
  const out: string[] = [];
  if (!t || typeof t !== "object") return ["not an object"];
  const x = t as Record<string, unknown>;
  if (typeof x.label !== "string" || !x.label.trim()) out.push("no label");
  const steps = templateSteps(x);
  if (!steps.length) out.push("nothing to run: no steps, op or apdu");
  const walk = (list: TemplateStep[], depth: number) => {
    if (depth > 2) { out.push("for-each-aid nested too deep"); return; }
    for (const s of list) {
      if ("apdu" in s) {
        const h = String(s.apdu).replace(/\s/g, "");
        if (!/^[0-9A-Fa-f]{8,522}$/.test(h) || h.length % 2) { out.push(`bad command ${String(s.apdu).slice(0, 20)}`); continue; }
        // G-18: a template only reads.
        const refused = commandProblem(h);
        if (refused) out.push(refused);
        continue;
      }
      if (s.op === "select-aid" && s.aid !== undefined && !/^[0-9A-Fa-f]{10,32}$/.test(s.aid)) out.push(`bad AID ${s.aid}`);
      if (s.op === "get-data" && (!Array.isArray(s.tags) || !s.tags.every((g) => /^[0-9A-Fa-f]{4}$/.test(g)))) out.push("get-data needs 2-byte tags");
      if (s.op === "for-each-aid") walk(Array.isArray(s.steps) ? s.steps : [], depth + 1);
    }
  };
  walk(steps, 0);
  return out;
}
