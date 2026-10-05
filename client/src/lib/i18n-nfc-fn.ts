// Client strings for m5.nfc in Functions (6.3). Kept in their own file so the
// shared i18n.ts (whose nfc.* keys belong to the NFC workbench) is left alone:
// these are only for the "nfc" run interaction — the short, human wording for an
// NfcResult status when a model's NFC command is surfaced to the person. Nothing
// here holds a card, a key or a PIN.
//
// nfcFnText(lang, key, vars?) mirrors i18n.tf: it fills {placeholders} and falls
// back to English, then to the key itself.

import { dictionary, type Lang } from "./i18n";
import type { NfcResultStatus } from "./nfc/command";
import { isLocale, localeChain } from "./locales";

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

/** 6.13: nine languages — en / cs / de here, the rest from i18n/locales/<lang>/web-nfc-fn.json (lib/i18n-load.ts). */
export const NFC_FN_STRINGS: Record<Lang, Dict> = { cs, en, de, es: {}, it: {}, fr: {}, sk: {}, sl: {}, fi: {} };

/** A lazily loaded language's strings (lib/i18n-load.ts); the built-in ones keep theirs. */
export function registerNfcFnStrings(lang: Lang, texts: Readonly<Dict>): void {
  if (!isLocale(lang) || lang === "cs" || lang === "en" || lang === "de") return;
  for (const [k, v] of Object.entries(texts ?? {})) if (typeof v === "string") NFC_FN_STRINGS[lang][k] = v.normalize("NFC");
}

/** t()/tf() for the NFC-in-Functions strings: fills {placeholders}, falls back along the language's chain (sk → cs → en), then the key. */
export function nfcFnText(lang: Lang, key: string, vars: Record<string, string | number> = {}): string {
  let raw: string | undefined;
  for (const l of localeChain(isLocale(lang) ? lang : "en")) { raw = NFC_FN_STRINGS[l]?.[key] ?? dictionary(l)[key]; if (raw !== undefined) break; }
  return (raw ?? key).replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

/** A human line for an NfcResult status (for a flash or a log). */
export function nfcStatusText(lang: Lang, status: NfcResultStatus, message = ""): string {
  return nfcFnText(lang, `nfcfn.status.${status}`, { message });
}
