// The holder's document key, asked ON THE DEVICE (6.6). A model may ask the
// caller's device to read an e-ID / e-passport (eid-read / mrtd-read) without
// giving the key — the CAN printed on the card, or the MRZ. Then the device
// asks the holder for it locally and uses it only for this read: it never goes
// to the server (whose run history keeps a run's inputs) and never comes back
// in the result. The Android app follows the same rules.

import type { NfcCommand } from "./command";

const EID_OPS = new Set(["eid-read", "mrtd-read"]);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** An e-ID read whose command carries no key: the device must ask for one. */
export function needsDocumentKey(command: NfcCommand): boolean {
  if (!EID_OPS.has(command.op)) return false;
  const a = command.args ?? {};
  if (str(a.mrz) || str(a.can)) return false;
  return !(str(a.documentNumber) && str(a.dateOfBirth) && str(a.dateOfExpiry));
}

/** What the holder typed, valid enough to try: a 6-digit CAN, an MRZ, or the three BAC fields. */
export function documentKeyValid(values: Record<string, unknown>): boolean {
  if (/^\d{6}$/.test(str(values.can))) return true;
  if (str(values.mrz).replace(/\s/g, "").length >= 60) return true;
  return Boolean(str(values.documentNumber)) && /^\d{6}$/.test(str(values.dateOfBirth)) && /^\d{6}$/.test(str(values.dateOfExpiry));
}

/** The command with the holder's key added (only the fields they filled). */
export function withDocumentKey(command: NfcCommand, values: Record<string, unknown>): NfcCommand {
  const args: Record<string, unknown> = { ...(command.args ?? {}) };
  for (const k of ["can", "mrz", "documentNumber", "dateOfBirth", "dateOfExpiry"]) {
    const v = str(values[k]);
    if (v) args[k] = k === "documentNumber" ? v.toUpperCase() : v;
  }
  return { ...command, args };
}

/** The local form's fields (labels by i18n key). */
export const DOCUMENT_KEY_FIELDS = [
  { name: "can", labelKey: "nfc.eid.can", placeholder: "123456" },
  { name: "mrz", labelKey: "nfc.eid.mrz", placeholder: "P<UTO…" },
  { name: "documentNumber", labelKey: "nfc.eid.docNumber", placeholder: "L898902C3" },
  { name: "dateOfBirth", labelKey: "nfc.eid.dob", placeholder: "YYMMDD" },
  { name: "dateOfExpiry", labelKey: "nfc.eid.expiry", placeholder: "YYMMDD" },
] as const;
