// Common transport contract for every reader backend (Web NFC, WebUSB
// CCID, Web Serial PN532, Web Bluetooth PN532).
//
// A transport only moves bytes; card semantics (NDEF, Mifare, DESFire,
// EMV, ...) live in lib/nfc/cards and are transport-agnostic.

import type { NdefRecord } from "./cards/ndef";

export type TransportId = "webnfc" | "webusb-ccid" | "webserial-pn532" | "webbluetooth-pn532";

/** Everything a transport learns about a card at activation time. */
export type CardIdentity = {
  /** Anti-collision UID / serial number (4, 7 or 10 bytes; 8 for Type B PUPI). */
  uid: Uint8Array;
  /** ISO 14443-4 ATS (Type A) or ATTRIB answer (Type B), when the card is ISO-DEP. */
  ats?: Uint8Array;
  /** PC/SC style ATR, when the reader hands one out (CCID). */
  atr?: Uint8Array;
  /** SEL_RES (Type A). */
  sak?: number;
  /** ATQA (Type A), 2 bytes as reported by the PICC (LSB first on the wire). */
  atqa?: Uint8Array;
  /** Which RF technology answered. */
  tech: "iso14443a" | "iso14443b" | "felica" | "iso15693" | "unknown";
  /** True when the card entered ISO-DEP (APDU) mode. */
  isoDep: boolean;
  /** NDEF records already read by the reader (Web NFC delivers them with the tap). */
  ndef?: NdefRecord[];
  /** Free-form hints from the transport (e.g. "ndef-only", "web-nfc"). */
  hints: string[];
};

export type TransportCapabilities = {
  /** ISO 7816-4 APDU exchange with ISO-DEP cards. */
  apdu: boolean;
  /** Raw ISO 14443-3 frames (Mifare Classic / Ultralight native commands). */
  raw: boolean;
  /** Mifare Classic Crypto-1 authentication done by the reader chip. */
  mifareAuth: boolean;
  /** Only NDEF read/write is possible (Web NFC). */
  ndefOnly: boolean;
  /** Can act as a Type 4 tag towards a phone (PN532 only). */
  emulate: boolean;
  /** Can write to tags at all. */
  write: boolean;
};

export type WaitOpts = { timeoutMs?: number; signal?: AbortSignal };
export type RawOpts = { crc?: boolean; timeoutMs?: number };

export interface CardTransport {
  readonly id: TransportId;
  readonly label: string;
  readonly capabilities: TransportCapabilities;
  /** API present in this browser. Never requests permission. */
  isSupported(): boolean;
  /** Requests device permission (opens the browser chooser) and opens the device. */
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** True between a successful connect() and disconnect() / device loss. */
  isConnected(): boolean;
  /** Block until a card is in the field; resolves with its identity. */
  waitForCard(opts?: WaitOpts): Promise<CardIdentity>;
  /** ISO 7816-4 APDU exchange (ISO-DEP cards). Returns data + SW1SW2. */
  transmit(apdu: Uint8Array): Promise<Uint8Array>;
  /** Raw ISO 14443-3 frame exchange, if the reader supports it. */
  transceiveRaw?(frame: Uint8Array, opts?: RawOpts): Promise<Uint8Array>;
  /** Mifare Classic authentication through the reader. */
  mifareAuth?(block: number, keyType: "A" | "B", key: Uint8Array, uid: Uint8Array): Promise<boolean>;
  /** Release the current card (halt) so the next waitForCard sees a fresh activation. */
  releaseCard?(): Promise<void>;
  /** Web NFC only: write NDEF records. Other transports write through card drivers. */
  writeNdef?(records: NdefRecord[], opts?: { signal?: AbortSignal; overwrite?: boolean }): Promise<void>;
  /** PN532 only: act as a Type 4 tag until the signal aborts. */
  emulateNdef?(records: NdefRecord[], opts: { signal: AbortSignal; onEvent?: (e: EmulationEvent) => void }): Promise<void>;
  /** Subscribe to device-loss notifications. Returns an unsubscribe function. */
  onDisconnect(cb: () => void): () => void;
  /** Optional debug tap for the workbench APDU log. */
  onTrace?(cb: (dir: "tx" | "rx", bytes: Uint8Array, note?: string) => void): () => void;
}

export type EmulationEvent =
  | { type: "activated"; initiator?: Uint8Array }
  | { type: "apdu"; command: Uint8Array; response: Uint8Array; note: string }
  | { type: "released" }
  | { type: "error"; message: string };

export { NfcError, type NfcErrorCode } from "./errors";
