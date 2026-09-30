// Client strings for m5.nfc in Functions (6.3). Kept in their own file so the
// shared i18n.ts (whose nfc.* keys belong to the NFC workbench) is left alone:
// these are only for the "nfc" run interaction — the short, human wording for an
// NfcResult status when a model's NFC command is surfaced to the person. Nothing
// here holds a card, a key or a PIN.
//
// nfcFnText(lang, key, vars?) mirrors i18n.tf: it fills {placeholders} and falls
// back to English, then to the key itself.

import type { Lang } from "./i18n";
import type { NfcResultStatus } from "./nfc/command";

type Dict = Record<string, string>;

const cs: Dict = {
  "nfcfn.waiting": "Přiložte kartu k zařízení…",
  "nfcfn.noReader": "Toto zařízení nemá čtečku NFC.",
  "nfcfn.done": "Hotovo.",
  "nfcfn.status.ok": "Hotovo",
  "nfcfn.status.no-card": "Žádná karta",
  "nfcfn.status.timeout": "Karta nebyla přiložena včas",
  "nfcfn.status.unsupported": "Nepodporováno na tomto zařízení",
  "nfcfn.status.denied": "Přístup k NFC odepřen",
  "nfcfn.status.auth-failed": "Ověření karty selhalo",
  "nfcfn.status.error": "Chyba NFC: {message}",
};

const en: Dict = {
  "nfcfn.waiting": "Hold a card to the device…",
  "nfcfn.noReader": "This device has no NFC reader.",
  "nfcfn.done": "Done.",
  "nfcfn.status.ok": "Done",
  "nfcfn.status.no-card": "No card",
  "nfcfn.status.timeout": "No card was presented in time",
  "nfcfn.status.unsupported": "Not supported on this device",
  "nfcfn.status.denied": "NFC access denied",
  "nfcfn.status.auth-failed": "Card authentication failed",
  "nfcfn.status.error": "NFC error: {message}",
};

const de: Dict = {
  "nfcfn.waiting": "Halten Sie eine Karte an das Gerät…",
  "nfcfn.noReader": "Dieses Gerät hat kein NFC-Lesegerät.",
  "nfcfn.done": "Fertig.",
  "nfcfn.status.ok": "Fertig",
  "nfcfn.status.no-card": "Keine Karte",
  "nfcfn.status.timeout": "Es wurde nicht rechtzeitig eine Karte vorgehalten",
  "nfcfn.status.unsupported": "Auf diesem Gerät nicht unterstützt",
  "nfcfn.status.denied": "NFC-Zugriff verweigert",
  "nfcfn.status.auth-failed": "Kartenauthentifizierung fehlgeschlagen",
  "nfcfn.status.error": "NFC-Fehler: {message}",
};

export const NFC_FN_STRINGS: Record<Lang, Dict> = { cs, en, de };

/** t()/tf() for the NFC-in-Functions strings: fills {placeholders}, falls back to en, then the key. */
export function nfcFnText(lang: Lang, key: string, vars: Record<string, string | number> = {}): string {
  const raw = NFC_FN_STRINGS[lang]?.[key] ?? NFC_FN_STRINGS.en[key] ?? key;
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

/** A human line for an NfcResult status (for a flash or a log). */
export function nfcStatusText(lang: Lang, status: NfcResultStatus, message = ""): string {
  return nfcFnText(lang, `nfcfn.status.${status}`, { message });
}
