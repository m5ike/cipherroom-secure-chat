// The system smart-card reader of M5cet Desktop (6.13.1) — the wire contract
// between the page (transports/desktop-pcsc.ts) and the app (desktop/src/
// pcsc.ts, preload.ts). Pure types and limits, shared by both sides.
//
// The page sees `window.m5desktop.pcsc` only inside the desktop app. Every
// call answers a result object — never a thrown error across the bridge —
// so the stable `code` survives contextBridge and IPC.

/** Which slot of a reader this is (a dual reader like the ACR1281 lists three readers). */
export type PcscSlot = "contact" | "contactless" | "sam" | "unknown";

/** One PC/SC reader as the page sees it. */
export type PcscReader = {
  /** The driver's reader name ("ACS ACR1281 1S Dual Reader(2)"). */
  name: string;
  slot: PcscSlot;
  /** A card is in the reader (or on it). */
  card: boolean;
};

/** Stable error codes (the page maps them to NfcError codes and texts). */
export type PcscErrorCode =
  | "unavailable" // no PC/SC library / service on this computer
  | "denied" // the user did not allow smart-card readers for this server
  | "cancelled" // the user closed the reader chooser
  | "no-reader" // no reader connected (or the named one is gone)
  | "no-card" // the chosen reader holds no card
  | "removed" // the card left during the operation
  | "reset" // another program reset the card
  | "busy" // another program holds the card exclusively
  | "card-error" // the card does not answer / unsupported card
  | "timeout"
  | "too-large" // an APDU over MAX_APDU
  | "bad-request" // malformed arguments
  | "bad-handle" // unknown or closed connection
  | "rate-limited"
  | "not-allowed" // not the server page's main frame
  | "locked" // the screen is locked
  | "failed";

export type PcscFail = { ok: false; code: PcscErrorCode; message: string; reader?: string };
export type PcscResult<T extends object> = ({ ok: true } & T) | PcscFail;

export type PcscListResult = PcscResult<{ readers: PcscReader[] }>;
/** A connection to the card in `reader`. A "no-card" failure names the reader the user picked, to wait on. */
export type PcscConnectResult = PcscResult<{ handle: string; reader: string; slot: PcscSlot; atr: Uint8Array; protocol: string }>;
export type PcscTransmitResult = PcscResult<{ response: Uint8Array }>;
export type PcscDisconnectResult = PcscResult<Record<never, never>>;

/** `window.m5desktop.pcsc` */
export type PcscBridge = {
  listReaders(): Promise<PcscListResult>;
  /** Without a name (or a name the user has not picked on this page) the app asks which reader. */
  connect(reader?: string | null): Promise<PcscConnectResult>;
  transmit(handle: string, apdu: Uint8Array): Promise<PcscTransmitResult>;
  disconnect(handle: string): Promise<PcscDisconnectResult>;
  /** The reader list after every attach / detach / card insert / removal (only once readers are allowed). */
  onChange(cb: (readers: PcscReader[]) => void): () => void;
};

/** Largest command APDU: extended Lc (65 535 data bytes) + header + Le. */
export const PCSC_MAX_APDU = 4 + 3 + 65_535 + 3;
/** Largest response the app accepts: 65 536 data bytes + SW1 SW2. */
export const PCSC_MAX_RESPONSE = 65_536 + 2;
/** A reader name longer than this is refused. */
export const PCSC_MAX_NAME = 200;

/** The slot a reader name means (Windows "… PICC 0", Linux "[… ICC] 00 00", macOS "…(2)" for the ACR1281 family). */
export function slotOfReader(name: string, atr?: Uint8Array | null): PcscSlot {
  if (/\bSAM\b/i.test(name)) return "sam";
  if (/\bPICC\b|contactless|\bCL\b|\bNFC\b|RFID|ACR122|ACR1252|ACR1255|ACR1552|ACR1555|\bPN53\d/i.test(name)) return "contactless";
  if (/\bICC\b|\bcontact\b/i.test(name)) return "contact";
  // The ACR1281 dual readers on macOS: (1) contact, (2) contactless, (3) SAM.
  const dual = /ACR128\d.*\((\d)\)\s*$/i.exec(name);
  if (dual) return dual[1] === "1" ? "contact" : dual[1] === "2" ? "contactless" : dual[1] === "3" ? "sam" : "unknown";
  // A card's ATR built by the reader for a contactless card (PC/SC Part 3: 3B 8n 80 01).
  if (atr && atr.length >= 4 && atr[0] === 0x3b && (atr[1] & 0xf0) === 0x80 && atr[2] === 0x80 && atr[3] === 0x01) return "contactless";
  return "unknown";
}
