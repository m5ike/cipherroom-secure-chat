// EMV reader (6.5) — the public / holder data a contactless terminal reads,
// nothing more. Read-only: PPSE → SELECT AID → GET PROCESSING OPTIONS →
// READ RECORD, then the records' BER-TLV is parsed and the known elements are
// labelled (emv-tags.ts). It never verifies a PIN (9F17 is read as a counter,
// never checked), never runs GENERATE AC for a real transaction, and writes
// nothing. The person is reading their own card — the same bytes a payment
// terminal sees.

import type { CardTransport } from "../transport";
import { apdu, concat, decodeTlv, describeSw, findAllTlv, findTlv, formatTlv, hex, isOk, ISO, splitResponse, transmitSmart, type Response, type Tlv } from "./apdu";
import { CANDIDATE_AIDS, COUNTRY_NUM, CURRENCY_NUM, emvTagInfo, schemeForAid, type EmvFormat } from "../emv-tags";
import type { EmvApp, EmvData, EmvTag } from "../command";

const PPSE = new TextEncoder().encode("2PAY.SYS.DDF01");

const send = (t: CardTransport, cmd: Uint8Array) => transmitSmart((a) => t.transmit(a), cmd);

/** 0x5F24 → "5F24", 0x50 → "50". */
function tagHex(tag: number): string {
  let h = tag.toString(16).toUpperCase();
  if (h.length % 2) h = `0${h}`;
  return h;
}

/** Every primitive (leaf) element in a TLV tree, newest wins on a repeated tag. */
function collectLeaves(nodes: Tlv[], into: Map<string, Uint8Array>): void {
  for (const n of nodes) {
    if (n.constructed && n.children) collectLeaves(n.children, into);
    else into.set(tagHex(n.tag), n.value);
  }
}

/* --------------------------------------------------------------- GPO/PDOL */

// A terminal's default values for the data objects a card asks for in its PDOL.
// They do not complete a transaction; they only let the card return its records.
const PDOL_DEFAULTS: Record<string, number[]> = {
  "9F66": [0x36, 0x00, 0x40, 0x00], // TTQ — contactless qVSDC, reader supports online
  "9F02": [0, 0, 0, 0, 0, 0],       // amount authorised
  "9F03": [0, 0, 0, 0, 0, 0],       // amount other
  "9F1A": [0x02, 0x03],             // terminal country (CZ 203)
  "95": [0, 0, 0, 0, 0],            // TVR
  "5F2A": [0x09, 0x78],             // currency (EUR 978)
  "9A": [0x25, 0x01, 0x01],         // date YYMMDD
  "9C": [0x00],                     // transaction type
  "9F35": [0x22],                   // terminal type
  "9F45": [0, 0],
  "9F4C": [0, 0, 0, 0, 0, 0, 0, 0],
  "9F34": [0, 0, 0],
  "9F21": [0, 0, 0],
  "9F40": [0, 0, 0, 0, 0],
  "9F1E": [0, 0, 0, 0, 0, 0, 0, 0],
};

function pdolValue(tag: string, len: number): Uint8Array {
  const out = new Uint8Array(len);
  if (tag === "9F37") { for (let i = 0; i < len; i++) out[i] = Math.floor(Math.random() * 256); return out; } // unpredictable number
  const dflt = PDOL_DEFAULTS[tag];
  if (dflt) for (let i = 0; i < Math.min(len, dflt.length); i++) out[i] = dflt[i];
  return out;
}

/** Reads a DOL (tag-length list) and concatenates the terminal's values for it. */
function fillDol(dol: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let i = 0;
  while (i < dol.length) {
    let tag = dol[i++];
    if ((tag & 0x1f) === 0x1f) { while (i < dol.length) { const b = dol[i++]; tag = (tag << 8) | b; if (!(b & 0x80)) break; } }
    const len = dol[i++] ?? 0;
    parts.push(pdolValue(tagHex(tag), len));
  }
  return concat(...parts);
}

/* ------------------------------------------------------------- AFL records */

type AflEntry = { sfi: number; first: number; last: number };

function parseAfl(afl: Uint8Array): AflEntry[] {
  const out: AflEntry[] = [];
  for (let i = 0; i + 3 < afl.length; i += 4) out.push({ sfi: afl[i] >> 3, first: afl[i + 1], last: afl[i + 2] });
  return out;
}

async function readRecords(t: CardTransport, entries: AflEntry[], into: Map<string, Uint8Array>, raw: Tlv[]): Promise<void> {
  for (const e of entries) {
    for (let rec = e.first; rec <= e.last && rec > 0; rec++) {
      let r: Response;
      try { r = await send(t, ISO.readRecord(rec, e.sfi)); } catch { continue; }
      if (!isOk(r.sw) || r.data.length === 0) continue;
      const nodes = decodeTlv(r.data, { recurse: true });
      raw.push(...nodes);
      collectLeaves(nodes, into);
    }
  }
}

/* --------------------------------------------------------------- formatting */

function asciiOf(b: Uint8Array): string { return Array.from(b).map((c) => (c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : "")).join("").trim(); }

function formatValue(tag: string, value: Uint8Array, format: EmvFormat): string {
  const h = hex(value).toUpperCase();
  switch (format) {
    case "ans": case "an": return asciiOf(value) || h;
    case "cn": return h.replace(/F+$/i, "");
    case "n": return value.length <= 6 ? String(parseInt(h || "0", 16)) : h;
    case "date": return h.length >= 6 ? `20${h.slice(0, 2)}-${h.slice(2, 4)}-${h.slice(4, 6)}` : h;
    case "month": return h.length >= 4 ? `20${h.slice(0, 2)}-${h.slice(2, 4)}` : h;
    case "country": return COUNTRY_NUM[h.padStart(4, "0")] ?? h;
    case "currency": return CURRENCY_NUM[h.padStart(4, "0")] ?? h;
    default: return h;
  }
}

/** PAN and expiry from Track 2 equivalent (tag 57): digits before "D", then YYMM. */
function fromTrack2(h: string): { pan?: string; expiry?: string } {
  const t2 = h.toUpperCase().replace(/F+$/i, "");
  const sep = t2.indexOf("D");
  if (sep < 0) return {};
  const pan = t2.slice(0, sep);
  const after = t2.slice(sep + 1);
  const expiry = after.length >= 4 ? `20${after.slice(0, 2)}-${after.slice(2, 4)}` : undefined;
  return { pan: /^\d{8,19}$/.test(pan) ? pan : undefined, expiry };
}

function maskPan(pan: string): string {
  return pan.length >= 10 ? `${pan.slice(0, 6)}${"•".repeat(pan.length - 10)}${pan.slice(-4)}` : pan;
}

function num(v: Uint8Array | undefined): number | undefined {
  if (!v || v.length === 0 || v.length > 4) return undefined;
  return parseInt(hex(v) || "0", 16);
}

function buildApp(aid: string, tags: Map<string, Uint8Array>, label?: string): EmvApp {
  const list: EmvTag[] = [];
  for (const [tag, value] of tags) {
    const info = emvTagInfo(tag);
    list.push({ tag, name: info.name, value: formatValue(tag, value, info.format), hex: hex(value).toUpperCase() });
  }
  const app: EmvApp = { aid, tags: list, scheme: schemeForAid(aid) };
  if (label) app.label = label;
  else {
    const lbl = tags.get("50") ?? tags.get("9F12");
    if (lbl) app.label = asciiOf(lbl);
  }
  // PAN: tag 5A, else from Track 2.
  const pan5a = tags.get("5A");
  const t2 = tags.get("57") ?? tags.get("9F6B");
  const fromT2 = t2 ? fromTrack2(hex(t2)) : {};
  const pan = pan5a ? hex(pan5a).toUpperCase().replace(/F+$/i, "") : fromT2.pan;
  if (pan && /^\d{8,19}$/.test(pan)) { app.pan = pan; app.panMasked = maskPan(pan); }
  const exp = tags.get("5F24");
  app.expiry = exp ? formatValue("5F24", exp, "month").replace(/-\d{2}$/, (m) => m) : fromT2.expiry;
  if (app.expiry && app.expiry.length > 7) app.expiry = app.expiry.slice(0, 7);
  const name = tags.get("5F20");
  if (name) app.cardholder = asciiOf(name);
  const eff = tags.get("5F25");
  if (eff) app.effective = formatValue("5F25", eff, "date").slice(0, 7);
  const country = tags.get("5F28");
  if (country) app.issuerCountry = formatValue("5F28", country, "country");
  const seq = tags.get("5F34");
  if (seq) app.panSequence = String(num(seq) ?? "");
  const atc = num(tags.get("9F36"));
  if (atc !== undefined) app.atc = atc;
  const ptc = num(tags.get("9F17"));
  if (ptc !== undefined) app.pinTryCounter = ptc;
  return app;
}

/* ------------------------------------------------------------------ public */

/** Candidate AIDs from the PPSE directory, by priority (tag 87) where present. */
function aidsFromPpse(nodes: Tlv[]): string[] {
  const apps = findAllTlv(nodes, 0x61);
  const found = apps.map((a) => {
    const aid = findTlv(a.children ?? [], 0x4f);
    const prio = findTlv(a.children ?? [], 0x87);
    return aid ? { aid: hex(aid.value).toUpperCase(), prio: prio ? prio.value[0] : 0xff } : null;
  }).filter((x): x is { aid: string; prio: number } => x !== null);
  found.sort((a, b) => a.prio - b.prio);
  return [...new Set(found.map((f) => f.aid))];
}

async function selectAid(t: CardTransport, aidHex: string): Promise<{ ok: boolean; fci: Tlv[]; label?: string; pdol?: Uint8Array }> {
  const aid = Uint8Array.from((aidHex.match(/../g) ?? []).map((b) => parseInt(b, 16)));
  let r: Response;
  try { r = await send(t, ISO.selectByAid(aid)); } catch { return { ok: false, fci: [] }; }
  if (!isOk(r.sw)) return { ok: false, fci: [] };
  const fci = decodeTlv(r.data, { recurse: true });
  const label = findTlv(fci, 0x50)?.value ?? findTlv(fci, 0x9f12)?.value;
  const pdol = findTlv(fci, 0x9f38)?.value;
  return { ok: true, fci, label: label ? asciiOf(label) : undefined, pdol };
}

async function gpo(t: CardTransport, pdol?: Uint8Array): Promise<{ aip?: Uint8Array; afl?: Uint8Array; extra: Tlv[] }> {
  const data = pdol && pdol.length ? fillDol(pdol) : new Uint8Array(0);
  // Command data is a tag 83 holding the filled PDOL (empty when the card has none).
  const field = concat(Uint8Array.from([0x83, data.length]), data);
  let r: Response;
  try { r = await send(t, apdu(0x80, 0xa8, 0x00, 0x00, field, 0)); } catch { return { extra: [] }; }
  if (!isOk(r.sw)) return { extra: [] };
  const nodes = decodeTlv(r.data, { recurse: true });
  const fmt1 = findTlv(nodes, 0x80); // AIP(2) || AFL(rest)
  if (fmt1) return { aip: fmt1.value.slice(0, 2), afl: fmt1.value.slice(2), extra: nodes };
  const resp = findTlv(nodes, 0x77);
  if (resp) return { aip: findTlv(resp.children ?? [], 0x82)?.value, afl: findTlv(resp.children ?? [], 0x94)?.value, extra: resp.children ?? [] };
  return { extra: nodes };
}

/**
 * Reads an EMV card's applications and their records. `maxApps` caps how many
 * applications are opened (default 4).
 */
export async function readEmv(t: CardTransport, opts: { maxApps?: number } = {}): Promise<EmvData> {
  let ppseTree = "";
  let aids: string[] = [];
  try {
    const r = await send(t, ISO.selectByAid(PPSE));
    if (isOk(r.sw)) { const nodes = decodeTlv(r.data, { recurse: true }); ppseTree = formatTlv(nodes); aids = aidsFromPpse(nodes); }
  } catch { /* no PPSE — fall back to the candidate list */ }
  if (aids.length === 0) {
    // No directory: try the well-known AIDs and keep the ones the card selects.
    for (const c of CANDIDATE_AIDS) {
      const sel = await selectAid(t, c.aid);
      if (sel.ok) aids.push(c.aid);
      if (aids.length >= (opts.maxApps ?? 4)) break;
    }
  }

  const apps: EmvApp[] = [];
  for (const aidHex of aids.slice(0, opts.maxApps ?? 4)) {
    const sel = await selectAid(t, aidHex);
    if (!sel.ok) continue;
    const tags = new Map<string, Uint8Array>();
    const raw: Tlv[] = [];
    collectLeaves(sel.fci, tags);
    const options = await gpo(t, sel.pdol);
    collectLeaves(options.extra, tags);
    if (options.afl && options.afl.length) await readRecords(t, parseAfl(options.afl), tags, raw);
    else {
      // No AFL: a light scan of the first files for the holder records.
      const scan: AflEntry[] = [];
      for (let sfi = 1; sfi <= 4; sfi++) scan.push({ sfi, first: 1, last: 8 });
      await readRecords(t, scan, tags, raw);
    }
    apps.push(buildApp(aidHex, tags, sel.label));
  }

  return { scheme: apps[0]?.scheme ?? (aids[0] ? schemeForAid(aids[0]) : undefined), aids, apps, tree: ppseTree || undefined };
}

/** A one-line summary for a log / flash. */
export function emvSummary(d: EmvData): string {
  if (d.apps.length === 0) return d.aids.length ? `EMV: ${d.aids.length} application(s), no records read` : "No EMV application found";
  const a = d.apps[0];
  const bits = [a.scheme || a.label, a.panMasked, a.expiry].filter(Boolean);
  return bits.join(" · ") || `EMV: ${d.apps.length} application(s)`;
}
