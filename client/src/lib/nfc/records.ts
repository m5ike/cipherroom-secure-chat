// The shapes of an M5Cet card's records, and what to do once one is opened
// (6.3). Shared by the reader, the M5Cet builder and the Functions object so
// the field names never drift between web and Android.
//
// A record's `data` (the plaintext inside m5card.ts) is one of the shapes
// below, tagged by the record's type. RECORD_META says how to show it and
// what its primary action is:
//   display  show it (in the chat window, or a detail card)
//   save     import it into the app (a contact, a Wi-Fi login, an identity…)
//   run      act on it (join the room, open the URL)
// A one-time record erases itself from the card once it has been shown.

import type { M5RecordType } from "./m5card";

/** A small file carried inside a record (kept small — a tag has little room). */
export type CardFile = { name: string; mime: string; b64: string };

export type PasskeyBackupData = {
  /** The account this backs up (label only; the secret is in `root`/`wrapped`). */
  account: { id: string; username: string };
  /** The account root, or a wrapped form — enough to restore access. */
  root: string;
  at: number;
};

export type IdentityBackupData = {
  user: string;
  /** The user's identity and its signing/encryption keys (base64). */
  keys: Record<string, string>;
  at: number;
};

/** A message shown in the chat window. `serverRef` points at a larger
 *  message kept on the server, opened with `key`. */
export type MessageData = {
  text?: string;
  url?: string;
  file?: CardFile;
  key?: string;
  serverRef?: { id: string; server?: string };
};

export type ServerRoomData = {
  server: string;
  room: string;
  passphrase: string;
  name?: string;
  user?: string;
};

export type ExternalKeyData = { label: string; key: string; algo?: string };

export type ContactData = {
  name: string;
  tel?: string;
  email?: string;
  org?: string;
  url?: string;
  note?: string;
  /** A ready vCard, when the record was made from one. */
  vcard?: string;
};

export type WifiData = { ssid: string; password?: string; auth?: "WPA" | "WEP" | "nopass"; hidden?: boolean };

export type UrlLoginData = { url: string; user: string; password: string; note?: string };

/** The typed `data` for a given record type. */
export type RecordData = {
  "passkey-backup": PasskeyBackupData;
  "identity-backup": IdentityBackupData;
  "one-time-message": MessageData;
  message: MessageData;
  "server-room": ServerRoomData;
  "external-key": ExternalKeyData;
  contact: ContactData;
  wifi: WifiData;
  "url-login": UrlLoginData;
};

export type RecordMeta = {
  /** i18n key of the record's name. */
  label: string;
  /** A lucide icon name (in the app's catalogue). */
  icon: string;
  /** The primary thing to do when it is opened. */
  action: "display" | "save" | "run";
  /** i18n key of the action button. */
  actionLabel: string;
  /** This record is normally written one-time (erased after it is shown). */
  oneTimeDefault?: boolean;
  /** Opening it needs the account (only "internal" makes sense). */
  accountOnly?: boolean;
};

export const RECORD_META: Record<M5RecordType, RecordMeta> = {
  "passkey-backup": { label: "nfc.rec.passkey", icon: "key-round", action: "save", actionLabel: "nfc.rec.restore", accountOnly: true },
  "identity-backup": { label: "nfc.rec.identity", icon: "shield-user", action: "save", actionLabel: "nfc.rec.restore", accountOnly: true },
  "one-time-message": { label: "nfc.rec.onetime", icon: "flame", action: "display", actionLabel: "nfc.rec.show", oneTimeDefault: true },
  message: { label: "nfc.rec.message", icon: "message-square-lock", action: "display", actionLabel: "nfc.rec.show" },
  "server-room": { label: "nfc.rec.serverRoom", icon: "radio", action: "run", actionLabel: "nfc.rec.join" },
  "external-key": { label: "nfc.rec.externalKey", icon: "key", action: "save", actionLabel: "nfc.rec.import" },
  contact: { label: "nfc.rec.contact", icon: "contact-round", action: "save", actionLabel: "nfc.rec.saveContact" },
  wifi: { label: "nfc.rec.wifi", icon: "wifi", action: "save", actionLabel: "nfc.rec.connect" },
  "url-login": { label: "nfc.rec.urlLogin", icon: "log-in", action: "run", actionLabel: "nfc.rec.open" },
};

/** The record types a person builds by hand (the M5Cet builder offers these). */
export const BUILDABLE_RECORDS: M5RecordType[] = [
  "message", "one-time-message", "server-room", "wifi", "url-login", "contact", "external-key", "passkey-backup", "identity-backup",
];

/** A one-line summary of a record for a list (no secrets). */
export function recordSummary(type: M5RecordType, data: unknown): string {
  const d = (data ?? {}) as Record<string, unknown>;
  switch (type) {
    case "wifi": return String(d.ssid ?? "Wi-Fi");
    case "url-login": return String(d.url ?? "");
    case "server-room": return String(d.name ?? d.room ?? "");
    case "contact": return String(d.name ?? "");
    case "external-key": return String(d.label ?? "");
    case "message": case "one-time-message": return d.text ? String(d.text).slice(0, 40) : d.url ? String(d.url) : d.file ? String((d.file as CardFile).name) : "…";
    case "passkey-backup": case "identity-backup": return String((d.account as { username?: string })?.username ?? d.user ?? "");
    default: return "";
  }
}
