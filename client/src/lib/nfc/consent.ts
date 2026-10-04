// The holder's consent before a MODEL gets a card's data (6.10, G-17). A
// Functions model may ask this device to read a card (m5.nfc → the "nfc" run
// interaction, App.tsx); the read happens here, and what it found would go to
// the server and the model. Before it does, the holder sees exactly what — and
// for which model — and chooses:
//
//   masked (the default)  the card number masked everywhere (the PAN field
//                         dropped, 5A masked and the track data redacted in the
//                         elements, the records and the transcript); of a
//                         document: the holder's name, nationality, dates and
//                         the document number masked — no MRZ lines, no photo
//                         or images, no DG11 / DG12 / DG13 / DG16 details, no
//                         raw files; raw bytes that hold a card number withheld
//   full                  everything the read found
//   nothing               the model is told the holder did not send it
//
// Pure: App.tsx asks, the result answers the interaction.

import type { NfcResult, MrtdData, EmvData, EmvTag } from "./command";
import { hex } from "./cards/apdu";
import { maskAnswer, maskPanDigits, maskPans, maskValue, pansInHex, pansOfEmv, PAN_TAGS } from "./pan-mask";

/** One line of what would be sent: an i18n key (nfc.consent.*) and its values. */
export type ConsentLine = { key: string; vars?: Record<string, string | number> };

export type NfcConsent = {
  /** The result carries card data a model should not get without the holder's yes. */
  sensitive: boolean;
  /** What goes with "send masked". */
  masked: ConsentLine[];
  /** What "send everything" adds. */
  full: ConsentLine[];
};

const b64Bytes = (b64: string) => Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
function b64ToHex(b64: string): string {
  try { return hex(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))); } catch { return ""; }
}

/** A document number with all but its last three characters hidden. */
export function maskDocNumber(s: string): string {
  return s.length > 3 ? `${"•".repeat(s.length - 3)}${s.slice(-3)}` : s;
}

function emvPans(r: NfcResult): string[] {
  const out = new Set(pansOfEmv(r.emv));
  for (const e of r.transcript ?? []) for (const p of pansInHex(e.response)) out.add(p);
  return [...out];
}

/** What a model's NFC result would send, masked and in full. */
export function nfcConsent(r: NfcResult): NfcConsent {
  const masked: ConsentLine[] = [];
  const full: ConsentLine[] = [];
  const pans = emvPans(r);
  const emv = r.emv;
  if (emv && (emv.apps.length || emv.aids.length)) {
    for (const a of emv.apps) {
      masked.push({ key: "nfc.consent.emvApp", vars: { app: a.scheme || a.label || a.aid, pan: a.panMasked || (a.pan ? maskPanDigits(a.pan, "•") : "—"), expiry: a.expiry || "—" } });
      if (a.cardholder) masked.push({ key: "nfc.consent.cardholder", vars: { name: a.cardholder } });
      if (a.log?.length) masked.push({ key: "nfc.consent.history", vars: { n: a.log.length } });
      if (a.records?.length) masked.push({ key: "nfc.consent.records", vars: { n: a.records.length } });
    }
    if (!emv.apps.length) masked.push({ key: "nfc.consent.aids", vars: { aids: emv.aids.join(", ") } });
    if (pans.length) full.push({ key: "nfc.consent.fullPan", vars: { n: pans.length } });
  }
  const m = r.mrtd;
  if (m && (m.access !== "none" || m.mrzInfo)) {
    const z = m.mrzInfo ?? {};
    masked.push({ key: "nfc.consent.holder", vars: { name: [z.givenNames, z.surname].filter(Boolean).join(" ") || "—", doc: z.documentNumber ? maskDocNumber(z.documentNumber) : "—" } });
    if (z.mrz || z.documentNumber || z.optionalData) full.push({ key: "nfc.consent.mrz" });
    const images = m.images?.length ?? (m.photo ? 1 : 0);
    if (images) full.push({ key: "nfc.consent.images", vars: { n: images } });
    if (m.personal || m.document || m.optional || m.personsToNotify?.length) full.push({ key: "nfc.consent.details" });
    if (m.raw?.length) full.push({ key: "nfc.consent.files", vars: { n: m.raw.length } });
  }
  if (r.transcript?.length) masked.push({ key: pans.length ? "nfc.consent.transcriptMasked" : "nfc.consent.transcript", vars: { n: r.transcript.length } });
  if (r.data) {
    const dataPans = pansInHex(b64ToHex(r.data));
    if (dataPans.length) full.push({ key: "nfc.consent.dataPan", vars: { n: b64Bytes(r.data) } });
    else masked.push({ key: "nfc.consent.data", vars: { n: b64Bytes(r.data) } });
  }
  return { sensitive: masked.length + full.length > 0, masked, full };
}

/** The consent question as the app's prompt shows it: the title, what goes (and what "everything" adds), and the choices — masked first. */
export function consentPrompt(c: NfcConsent, model: string, tr: (key: string, vars?: Record<string, string | number>) => string): { title: string; text: string; choices: string[]; pick: (answer: unknown) => "masked" | "full" | null } {
  const line = (l: ConsentLine) => `• ${tr(l.key, l.vars ?? {})}`;
  const choices = [tr("nfc.consent.sendMasked"), ...(c.full.length ? [tr("nfc.consent.sendFull")] : []), tr("nfc.consent.dontSend")];
  const text = [
    tr("nfc.consent.text", { model: model || tr("nfc.consent.aModel") }),
    ...c.masked.map(line),
    ...(c.full.length ? [tr("nfc.consent.fullAdds"), ...c.full.map(line)] : []),
  ].join("\n");
  return { title: tr("nfc.consent.title"), text, choices, pick: (a) => (a === choices[0] ? "masked" : c.full.length && a === choices[1] ? "full" : null) };
}

/** An element as a masked view shows it (as the card report and Android's maskedEmv): PAN and track elements only their masked hex. */
function maskTag(t: EmvTag, pans: string[]): EmvTag {
  if ((PAN_TAGS as readonly string[]).includes(t.tag)) { const m = maskValue(t.tag, t.hex); return { ...t, value: m, hex: m }; }
  return { ...t, value: maskPans(t.value, pans), hex: maskPans(t.hex, pans) };
}

function maskEmv(d: EmvData, pans: string[]): EmvData {
  return {
    ...d,
    apps: d.apps.map((a) => {
      const { pan: _pan, ...rest } = a;
      return {
        ...rest,
        ...(a.pan && !a.panMasked ? { panMasked: maskPanDigits(a.pan, "•") } : {}),
        tags: a.tags.map((t) => maskTag(t, pans)),
        ...(a.getData ? { getData: a.getData.map((t) => maskTag(t, pans)) } : {}),
        ...(a.records ? { records: a.records.map((rec) => ({ ...rec, hex: maskAnswer(rec.hex, pans) })) } : {}),
        ...(a.log ? { log: a.log.map((e) => (e.raw ? { ...e, raw: maskAnswer(e.raw, pans) } : e)) } : {}),
      };
    }),
  };
}

function maskMrtd(d: MrtdData): MrtdData {
  const out: MrtdData = { present: d.present, access: d.access };
  if (d.pace) out.pace = d.pace;
  if (d.dataGroups) out.dataGroups = d.dataGroups;
  if (d.ldsVersion) out.ldsVersion = d.ldsVersion;
  if (d.unicodeVersion) out.unicodeVersion = d.unicodeVersion;
  if (d.mrzInfo) {
    const { mrz: _mrz, optionalData: _opt, documentNumber, ...rest } = d.mrzInfo;
    out.mrzInfo = { ...rest, ...(documentNumber ? { documentNumber: maskDocNumber(documentNumber) } : {}) };
  }
  if (d.files) out.files = d.files;
  if (d.security) out.security = d.security;
  if (d.message) out.message = d.message;
  return out;
}

/** The result as "send masked" sends it. */
export function maskNfcResult(r: NfcResult): NfcResult {
  const pans = emvPans(r);
  const out: NfcResult = { ...r };
  if (r.emv) out.emv = maskEmv(r.emv, pans);
  if (r.mrtd) out.mrtd = maskMrtd(r.mrtd);
  if (r.transcript) out.transcript = r.transcript.map((e) => ({ ...e, response: maskAnswer(e.response, pans) }));
  if (r.data && pansInHex(b64ToHex(r.data)).length) delete out.data;
  if (r.message) {
    let msg = maskPans(r.message, pans);
    const doc = r.mrtd?.mrzInfo?.documentNumber;
    if (doc) msg = msg.split(doc).join(maskDocNumber(doc));
    out.message = msg;
  }
  return out;
}
