// The NFC catalogue (6.3): which card technologies the tool knows and which
// operations each one supports. One source of truth for the workbench (web
// and Android), the M5Cet builder and the Functions `m5.nfc` object, so the
// UI, the models and the docs offer exactly the same set.
//
// It describes only STANDARD operations — reading a card's public identity
// and NDEF, and reading/writing sectors or files with keys the user has
// (a key dictionary is a list the user provides, as MIFARE Classic Tool
// does). Recovering unknown keys (nested/darkside/hardnested) is not here;
// the tool works with cards and keys you hold. EMV and e-ID are PUBLIC data
// only — never the PIN-protected or signing functions.

export type NfcTech =
  | "m5cet-card"
  | "connection-tag"
  | "ndef"
  | "mifare-classic-1k"
  | "mifare-classic-4k"
  | "mifare-classic-mini"
  | "mifare-ultralight"
  | "ntag21x"
  | "mifare-desfire"
  | "iso-dep"
  | "iso14443a"
  | "iso14443b"
  | "iso15693"
  | "felica"
  | "emv"
  | "eid"
  | "unknown";

/** What one operation does and where it applies. */
export type NfcOp = {
  id: string;
  label: string;
  /** read = only reads the card; write = changes it; emulate = the phone acts as the card. */
  kind: "read" | "write" | "emulate" | "convert";
  /** A key, PIN or account is needed. */
  needs?: "pin" | "key" | "account" | "keys-dictionary";
  help: string;
};

/** Operations every activated card offers (public identity, present since -3). */
const COMMON: NfcOp[] = [
  { id: "scan", label: "Scan", kind: "read", help: "Read the UID, the card type and any public record — kept in a scan loop." },
  { id: "read-uid", label: "Read UID", kind: "read", help: "The card's UID / serial as the reader sees it." },
  { id: "read-public", label: "Read public data", kind: "read", help: "The freely readable data: NDEF, the ATS/ATR, version." },
  { id: "raw-apdu", label: "Send APDU", kind: "read", needs: "key", help: "Send a raw ISO 7816 APDU and show the response (advanced)." },
];

const NDEF_OPS: NfcOp[] = [
  { id: "ndef-read", label: "Read NDEF", kind: "read", help: "The NDEF records (text, URI, MIME, external)." },
  { id: "ndef-write", label: "Write NDEF", kind: "write", help: "Write NDEF records (text, URI, MIME…)." },
  { id: "ndef-lock", label: "Make read-only", kind: "write", help: "Lock the tag so its NDEF can no longer be changed (permanent)." },
];

const CLASSIC_OPS: NfcOp[] = [
  { id: "classic-read", label: "Read sectors", kind: "read", needs: "keys-dictionary", help: "Read the blocks whose key A/B you know (or from the key list)." },
  { id: "classic-write", label: "Write block", kind: "write", needs: "key", help: "Write a block with its key." },
  { id: "classic-dump", label: "Dump", kind: "read", needs: "keys-dictionary", help: "Read every sector reachable with the known keys, as a .mfd/.json." },
  { id: "classic-restore", label: "Restore dump", kind: "write", needs: "keys-dictionary", help: "Write a dump back to a card with matching keys." },
];

const UID_WRITE: NfcOp = { id: "write-uid", label: "Change UID", kind: "write", needs: "key", help: "Set the UID and block 0 — only on a UID-changeable (\"magic\") card you own." };

/** Everything about one technology. */
export type TechInfo = {
  tech: NfcTech;
  label: string;
  standard: string;
  /** Bytes of user memory, or "" when it does not apply. */
  memory: string;
  ops: NfcOp[];
};

const T = (tech: NfcTech, label: string, standard: string, memory: string, ops: NfcOp[]): TechInfo => ({
  tech, label, standard, memory, ops: [...COMMON, ...ops],
});

export const NFC_CATALOG: TechInfo[] = [
  T("m5cet-card", "M5Cet card", "M5Cet encrypted container over NDEF", "tag-dependent", [
    ...NDEF_OPS,
    { id: "m5-read", label: "Open records", kind: "read", needs: "pin", help: "List the card's records and open each with its PIN or your account." },
    { id: "m5-write", label: "Write records", kind: "write", needs: "pin", help: "Build the card's records (the M5Cet builder) and write them." },
    { id: "m5-erase", label: "Erase a record", kind: "write", help: "Remove one record (a one-time record erases itself after it is shown)." },
    { id: "m5-emulate", label: "Be the card", kind: "emulate", help: "The phone answers as a Type 4 tag holding this card (HCE)." },
  ]),
  T("connection-tag", "M5cet connection tag", "NDEF · application/vnd.m5cet.conn", "~250 B", [
    ...NDEF_OPS,
    { id: "conn-read", label: "Open connection", kind: "read", needs: "pin", help: "Open the room + passphrase with the PIN and offer to join." },
    { id: "conn-write", label: "Write connection", kind: "write", needs: "pin", help: "Write the active room onto the tag." },
    { id: "conn-emulate", label: "Be the tag", kind: "emulate", help: "The phone answers as the connection tag (HCE)." },
  ]),
  T("ndef", "NDEF tag", "NFC Forum Type 1–5", "tag-dependent", NDEF_OPS),
  T("mifare-classic-1k", "MIFARE Classic 1K", "ISO 14443-3A · NXP", "1024 B (16 sectors)", [...NDEF_OPS, ...CLASSIC_OPS, UID_WRITE]),
  T("mifare-classic-4k", "MIFARE Classic 4K", "ISO 14443-3A · NXP", "4096 B (40 sectors)", [...NDEF_OPS, ...CLASSIC_OPS, UID_WRITE]),
  T("mifare-classic-mini", "MIFARE Classic Mini", "ISO 14443-3A · NXP", "320 B (5 sectors)", [...NDEF_OPS, ...CLASSIC_OPS, UID_WRITE]),
  T("mifare-ultralight", "MIFARE Ultralight", "ISO 14443-3A · NXP", "64–192 B", [
    ...NDEF_OPS,
    { id: "ul-read", label: "Read pages", kind: "read", help: "Read the 4-byte pages (READ / FAST_READ)." },
    { id: "ul-write", label: "Write page", kind: "write", help: "Write a 4-byte page (WRITE)." },
    { id: "ul-password", label: "Set password", kind: "write", needs: "key", help: "Set the AUTH0 / PWD / PACK protection (Ultralight C / EV1)." },
  ]),
  T("ntag21x", "NTAG 213 / 215 / 216", "ISO 14443-3A · NXP NTAG", "144 / 504 / 888 B", [
    ...NDEF_OPS,
    { id: "ntag-read", label: "Read pages", kind: "read", help: "Read the pages (READ / FAST_READ)." },
    { id: "ntag-write", label: "Write page", kind: "write", help: "Write a page (WRITE)." },
    { id: "ntag-password", label: "Set password", kind: "write", needs: "key", help: "Set PWD / PACK and AUTH0 password protection." },
    { id: "ntag-counter", label: "Read counter", kind: "read", help: "The NFC read counter and the signature (ECC), where enabled." },
  ]),
  T("mifare-desfire", "MIFARE DESFire EV1/2/3", "ISO 14443-4 · NXP", "2–8 KB (applications & files)", [
    ...NDEF_OPS,
    { id: "desfire-apps", label: "List applications", kind: "read", help: "Enumerate the applications (AIDs) and the master info." },
    { id: "desfire-files", label: "List files", kind: "read", needs: "key", help: "The files of an application and their settings." },
    { id: "desfire-read", label: "Read file", kind: "read", needs: "key", help: "Read a data / record file after authenticating (AES/2K3DES)." },
    { id: "desfire-write", label: "Write file", kind: "write", needs: "key", help: "Write a file after authenticating with its key." },
  ]),
  T("iso-dep", "ISO-DEP (ISO 14443-4)", "ISO 14443-4 / ISO 7816", "", [
    { id: "select-aid", label: "Select application", kind: "read", help: "SELECT an AID and talk to it with APDUs." },
    { id: "app-template", label: "Application template", kind: "read", help: "Send a saved APDU application template (the operator's apduTemplates in Android › Define)." },
  ]),
  T("iso14443a", "ISO/IEC 14443 Type A", "ISO 14443-3A", "", []),
  T("iso14443b", "ISO/IEC 14443 Type B", "ISO 14443-3B", "", []),
  T("iso15693", "ISO/IEC 15693 (vicinity)", "ISO 15693 / NFC Type 5", "tag-dependent", [
    { id: "v-read", label: "Read blocks", kind: "read", help: "Read the memory blocks (Get System Info, Read Multiple)." },
    { id: "v-write", label: "Write block", kind: "write", needs: "key", help: "Write a block (and lock it)." },
  ]),
  T("felica", "FeliCa", "JIS X 6319-4 · Sony", "service/block", [
    { id: "felica-systems", label: "Read systems", kind: "read", help: "The system codes, IDm/PMm and the public services." },
    { id: "felica-read", label: "Read service", kind: "read", needs: "key", help: "Read a service's blocks (Read Without Encryption for public ones)." },
  ]),
  T("emv", "EMV payment card", "ISO 14443-4 · EMV", "", [
    { id: "emv-public", label: "Read public data", kind: "read", help: "Only the freely readable data (PPSE, the card's application labels, and where allowed the masked PAN and expiry). No PIN, no signing, no transaction." },
    { id: "app-template", label: "Application template", kind: "read", help: "Send a saved APDU application template (the operator's apduTemplates in Android › Define)." },
  ]),
  T("eid", "Electronic ID / MRTD", "ISO 14443-4 · ICAO 9303 / eIDAS", "", [
    { id: "eid-public", label: "Read public info", kind: "read", help: "The document type and the data the holder unlocks with the CAN/MRZ they type. No cloning, no signing." },
  ]),
  T("unknown", "Unknown card", "—", "", []),
];

const BY_TECH = new Map(NFC_CATALOG.map((t) => [t.tech, t]));

export function techInfo(tech: NfcTech): TechInfo { return BY_TECH.get(tech) ?? BY_TECH.get("unknown")!; }
export function opsFor(tech: NfcTech): NfcOp[] { return techInfo(tech).ops; }
export function supportsOp(tech: NfcTech, opId: string): boolean { return techInfo(tech).ops.some((o) => o.id === opId); }

/** Readers the tool can drive (the "internal / BLE / USB" choice). */
export type ReaderKind = "internal" | "usb" | "bluetooth" | "serial";
export type ReaderInfo = { kind: ReaderKind; label: string; help: string };
export const NFC_READERS: ReaderInfo[] = [
  { kind: "internal", label: "This device", help: "The phone or tablet's own NFC (Android: internal antenna; web: WebNFC in Android Chrome)." },
  { kind: "usb", label: "USB reader", help: "A PC/SC (CCID) reader over USB — e.g. ACR122U, ACR1252 (web: WebUSB; Android: USB host)." },
  { kind: "bluetooth", label: "Bluetooth reader", help: "A BLE reader based on the PN532 or a vendor bridge (web: Web Bluetooth)." },
  { kind: "serial", label: "Serial reader", help: "A PN532 on a USB-serial adapter (web: Web Serial)." },
];
