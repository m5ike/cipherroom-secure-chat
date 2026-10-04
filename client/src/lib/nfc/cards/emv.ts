// EMV reader (6.5, deep read 6.6) — the public / holder data a contactless
// terminal reads, nothing more. Read-only: PPSE → SELECT AID → GET DATA
// (counters, the log format) → the transaction log (history) → GET PROCESSING
// OPTIONS → READ RECORD (the AFL's records, and with a deep read every other
// short file), then the records' BER-TLV is parsed and the known elements are
// labelled (emv-tags.ts). It never verifies a PIN (9F17 is read as a counter,
// never checked), never runs GENERATE AC for a real transaction, and writes
// nothing. The person is reading their own card — the same bytes a payment
// terminal sees.
//
// 6.10: every stage is an exported step (selectPpse, selectPse, selectAid,
// appGetData, appReadLog, appGpo, appReadAfl, appReadFiles, finishApp) and
// readEmv() is built from them; the APDU template runner (template-runner.ts)
// drives the same steps one by one.

import type { CardTransport } from "../transport";
import { apdu, asciiOf as asciiRaw, concat, decodeTlv, findAllTlv, findTlv, formatTlv, hex, isOk, ISO, transmitSmart, type Response, type Tlv } from "./apdu";
import { CANDIDATE_AIDS, COUNTRY_NUM, CURRENCY_NUM, emvTagInfo, schemeForAid, type EmvFormat } from "../emv-tags";
import type { EmvApp, EmvData, EmvLogEntry, EmvReadArgs, EmvRecord, EmvTag } from "../command";

const PPSE = new TextEncoder().encode("2PAY.SYS.DDF01");
const PSE = new TextEncoder().encode("1PAY.SYS.DDF01");
void asciiRaw;

/** 0x5F24 → "5F24", 0x50 → "50". */
export function tagHex(tag: number): string {
  let h = tag.toString(16).toUpperCase();
  if (h.length % 2) h = `0${h}`;
  return h;
}

/** Every primitive (leaf) element in a TLV tree, newest wins on a repeated tag. */
export function collectLeaves(nodes: Tlv[], into: Map<string, Uint8Array>): void {
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

export type AflEntry = { sfi: number; first: number; last: number };

/** A [from, to] range inside [min, max] (the whole span when none is given). */
function clampRange(r: [number, number] | undefined, min: number, max: number): [number, number] {
  if (!Array.isArray(r) || r.length < 2) return [min, max];
  const a = Math.max(min, Math.min(max, Math.trunc(Number(r[0]) || min)));
  const b = Math.max(min, Math.min(max, Math.trunc(Number(r[1]) || max)));
  return a <= b ? [a, b] : [b, a];
}

export function parseAfl(afl: Uint8Array): AflEntry[] {
  const out: AflEntry[] = [];
  for (let i = 0; i + 3 < afl.length; i += 4) out.push({ sfi: afl[i] >> 3, first: afl[i + 1], last: afl[i + 2] });
  return out;
}

type Sender = (cmd: Uint8Array) => Promise<Response>;

/** Reads records, parses their BER-TLV into `into`, and keeps each one raw. */
export async function readRecords(send: Sender, entries: AflEntry[], into: Map<string, Uint8Array>, records: EmvRecord[]): Promise<void> {
  for (const e of entries) {
    for (let rec = e.first; rec <= e.last && rec > 0; rec++) {
      if (records.some((r) => r.sfi === e.sfi && r.record === rec)) continue;
      let r: Response;
      try { r = await send(ISO.readRecord(rec, e.sfi)); } catch { continue; }
      if (!isOk(r.sw) || r.data.length === 0) continue;
      records.push({ sfi: e.sfi, record: rec, hex: hex(r.data).toUpperCase() });
      try { collectLeaves(decodeTlv(r.data, { recurse: true }), into); } catch { /* not TLV */ }
    }
  }
}

/**
 * A deep read (6.6): every short file 1–30, record by record, beyond what the
 * AFL lists — a file that answers no record 1 is skipped at once. READ RECORD
 * only; the transaction log's file is read as the log, not as TLV.
 */
async function scanFiles(send: Sender, into: Map<string, Uint8Array>, records: EmvRecord[], skipSfi: number | undefined, budget: { left: number }, range: { sfi?: [number, number]; records?: [number, number] } = {}): Promise<void> {
  const [sfiFrom, sfiTo] = clampRange(range.sfi, 1, 30);
  const [recFrom, recTo] = clampRange(range.records, 1, 16);
  for (let sfi = sfiFrom; sfi <= sfiTo && budget.left > 0; sfi++) {
    if (sfi === skipSfi) continue;
    for (let rec = recFrom; rec <= recTo && budget.left > 0; rec++) {
      if (records.some((r) => r.sfi === sfi && r.record === rec)) continue;
      budget.left--;
      let r: Response;
      try { r = await send(ISO.readRecord(rec, sfi)); } catch { break; }
      if (!isOk(r.sw) || r.data.length === 0) break;
      records.push({ sfi, record: rec, hex: hex(r.data).toUpperCase() });
      try { collectLeaves(decodeTlv(r.data, { recurse: true }), into); } catch { /* not TLV */ }
    }
  }
}

/* ------------------------------------------------------------- GET DATA */

/** Data objects a terminal may ask for with GET DATA: counters, the log, balances. */
export const GET_DATA_TAGS = ["9F36", "9F13", "9F17", "9F4D", "9F4F", "9F50", "9F51", "9F5D", "9F6D", "9F6E", "9F79", "DF60", "DF61", "DF62"];

/** GET DATA (80 CA) of one tag → its value, or null when the card does not have it. */
export async function getData(send: Sender, tag: string): Promise<Uint8Array | null> {
  const t = parseInt(tag, 16);
  let r: Response;
  try { r = await send(apdu(0x80, 0xca, (t >> 8) & 0xff, t & 0xff, undefined, 0)); } catch { return null; }
  if (!isOk(r.sw) || r.data.length === 0) return null;
  // The answer is the object itself (tag-length-value), or just its value.
  try {
    const nodes = decodeTlv(r.data, { recurse: false });
    const hit = nodes.find((n) => n.tag === t);
    if (hit) return hit.value;
  } catch { /* plain value */ }
  return r.data;
}

/* ------------------------------------------------------------- the log */

/** A DOL (tag-length list) → its entries. */
export function parseDol(dol: Uint8Array): Array<{ tag: string; len: number }> {
  const out: Array<{ tag: string; len: number }> = [];
  let i = 0;
  while (i < dol.length) {
    let tag = dol[i++];
    if ((tag & 0x1f) === 0x1f) { while (i < dol.length) { const b = dol[i++]; tag = (tag << 8) | b; if (!(b & 0x80)) break; } }
    const len = dol[i++] ?? 0;
    out.push({ tag: tagHex(tag), len });
  }
  return out;
}

const TX_TYPE: Record<string, string> = { "00": "purchase", "01": "cash", "09": "purchase with cashback", "20": "refund", "21": "deposit", "30": "balance inquiry", "31": "balance inquiry", "40": "transfer", "50": "payment", "60": "load", "61": "unload" };
const CID: Record<string, string> = { "00": "declined (AAC)", "40": "approved (TC)", "80": "online (ARQC)" };
const CURRENCY_EXP: Record<string, number> = { "0392": 0, "0410": 0, "0704": 0, "0152": 0, "0048": 3, "0414": 3, "0512": 3 };

function amountText(h: string, currency?: string): string {
  const minor = h.replace(/^0+(?=\d)/, "") || "0";
  const exp = CURRENCY_EXP[currency ?? ""] ?? 2;
  if (!/^\d+$/.test(minor)) return h;
  if (exp === 0) return minor;
  const padded = minor.padStart(exp + 1, "0");
  return `${padded.slice(0, -exp)}.${padded.slice(-exp)}`;
}

/** One log record, decoded by the card's log format. Empty slots give null. */
export function parseLogRecord(rec: Uint8Array, dol: Array<{ tag: string; len: number }>): EmvLogEntry | null {
  if (!rec.length || rec.every((b) => b === 0x00) || rec.every((b) => b === 0xff)) return null;
  const e: EmvLogEntry = {};
  let i = 0;
  const currencyField = dol.find((d) => d.tag === "5F2A");
  let currencyCode: string | undefined;
  if (currencyField) {
    let off = 0;
    for (const d of dol) { if (d === currencyField) break; off += d.len; }
    currencyCode = hex(rec.slice(off, off + currencyField.len)).toUpperCase().padStart(4, "0");
  }
  for (const d of dol) {
    const v = rec.slice(i, i + d.len);
    i += d.len;
    const h = hex(v).toUpperCase();
    switch (d.tag) {
      case "9A": e.date = h.length >= 6 ? `20${h.slice(0, 2)}-${h.slice(2, 4)}-${h.slice(4, 6)}` : h; break;
      case "9F21": e.time = h.length >= 6 ? `${h.slice(0, 2)}:${h.slice(2, 4)}:${h.slice(4, 6)}` : h; break;
      case "9F02": e.amount = amountText(h, currencyCode); break;
      case "9F03": e.otherAmount = amountText(h, currencyCode); break;
      case "5F2A": e.currency = CURRENCY_NUM[h.padStart(4, "0")] ?? h; break;
      case "9F1A": e.country = COUNTRY_NUM[h.padStart(4, "0")] ?? h; break;
      case "9C": e.type = TX_TYPE[h] ?? h; break;
      case "9F4E": e.merchant = asciiOf(v); break;
      case "9F36": e.atc = String(parseInt(h || "0", 16)); break;
      case "9F27": e.cid = CID[(h.slice(0, 2) === "" ? "00" : (parseInt(h.slice(0, 2), 16) & 0xc0).toString(16).padStart(2, "0"))] ?? h; break;
      default: e[d.tag] = h;
    }
  }
  e.raw = hex(rec).toUpperCase();
  return e;
}

/** READ RECORD of each log entry (up to `count`, at most 50), decoded by the log format. */
export async function readLog(send: Sender, sfi: number, count: number, dol: Array<{ tag: string; len: number }>, records: EmvRecord[]): Promise<EmvLogEntry[]> {
  const out: EmvLogEntry[] = [];
  for (let rec = 1; rec <= Math.min(count || 30, 50); rec++) {
    let r: Response;
    try { r = await send(ISO.readRecord(rec, sfi)); } catch { break; }
    if (!isOk(r.sw)) break;
    records.push({ sfi, record: rec, hex: hex(r.data).toUpperCase(), log: true });
    const e = dol.length ? parseLogRecord(r.data, dol) : (r.data.length ? { raw: hex(r.data).toUpperCase() } : null);
    if (e) out.push(e);
  }
  return out;
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

/** An element's value as people read it (by its EMV format: text, digits, a date, a country…). */
export { formatValue as formatEmvValue };

export type AppExtras = { aip?: Uint8Array; afl?: Uint8Array; log?: EmvLogEntry[]; logFormat?: Uint8Array; logSfi?: number; getData: Map<string, Uint8Array>; records: EmvRecord[] };

export function buildApp(aid: string, tags: Map<string, Uint8Array>, label: string | undefined, x: AppExtras): EmvApp {
  // GET DATA answers fill in what the records did not carry.
  for (const [tag, value] of x.getData) if (!tags.has(tag)) tags.set(tag, value);
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
  app.expiry = exp ? formatValue("5F24", exp, "month") : fromT2.expiry;
  if (app.expiry && app.expiry.length > 7) app.expiry = app.expiry.slice(0, 7);
  if (!app.expiry) delete app.expiry;
  const name = tags.get("5F20");
  if (name) { const n = asciiOf(name).replace(/\s*\/\s*/g, " / ").trim(); if (n && n !== "/") app.cardholder = n; }
  const eff = tags.get("5F25");
  if (eff) app.effective = formatValue("5F25", eff, "date").slice(0, 7);
  const country = tags.get("5F28");
  if (country) app.issuerCountry = formatValue("5F28", country, "country");
  const seq = tags.get("5F34");
  if (seq) app.panSequence = String(num(seq) ?? "");
  const atc = num(tags.get("9F36"));
  if (atc !== undefined) app.atc = atc;
  const lastOnline = num(tags.get("9F13"));
  if (lastOnline !== undefined) app.lastOnlineAtc = lastOnline;
  const ptc = num(tags.get("9F17"));
  if (ptc !== undefined) app.pinTryCounter = ptc;
  if (x.aip && x.aip.length) app.aip = hex(x.aip).toUpperCase();
  if (x.afl && x.afl.length) app.afl = hex(x.afl).toUpperCase();
  if (x.getData.size) app.getData = [...x.getData].map(([tag, value]) => { const info = emvTagInfo(tag); return { tag, name: info.name, value: formatValue(tag, value, info.format), hex: hex(value).toUpperCase() }; });
  if (x.logFormat && x.logFormat.length) app.logFormat = hex(x.logFormat).toUpperCase();
  if (x.logSfi !== undefined) app.logSfi = x.logSfi;
  if (x.log) app.log = x.log;
  if (x.records.length) app.records = x.records;
  return app;
}

/* ------------------------------------------------------------------ steps */
// 6.10: readEmv() below is built from these steps, and the APDU template runner
// (template-runner.ts) drives the same ones one at a time — a template's
// select-ppse / select-pse / select-aid / get-data / read-log / gpo / read-afl /
// read-files are these functions, so both read a card the same way.

/** Sends one command (61xx / 6Cxx already followed up) and gives the answer. */
export type EmvSender = Sender;

/** Candidate AIDs from a directory (the PPSE's FCI, a PSE record), by priority (tag 87) where present. */
export function aidsFromDirectory(nodes: Tlv[]): string[] {
  const apps = findAllTlv(nodes, 0x61);
  const found = apps.map((a) => {
    const aid = findTlv(a.children ?? [], 0x4f);
    const prio = findTlv(a.children ?? [], 0x87);
    return aid ? { aid: hex(aid.value).toUpperCase(), prio: prio ? prio.value[0] : 0xff } : null;
  }).filter((x): x is { aid: string; prio: number } => x !== null);
  found.sort((a, b) => a.prio - b.prio);
  return [...new Set(found.map((f) => f.aid))];
}

/** A payment directory as read: the AIDs it lists and its TLV as a readable tree. */
export type EmvDirectory = { ok: boolean; sw: number; aids: string[]; tree?: string; sfi?: number };

/** SELECT 2PAY.SYS.DDF01 — the contactless directory; its FCI lists the applications. */
export async function selectPpse(send: Sender): Promise<EmvDirectory> {
  let r: Response;
  try { r = await send(ISO.selectByAid(PPSE)); } catch { return { ok: false, sw: 0x6f00, aids: [] }; }
  if (!isOk(r.sw)) return { ok: false, sw: r.sw, aids: [] };
  try {
    const nodes = decodeTlv(r.data, { recurse: true });
    return { ok: true, sw: r.sw, aids: aidsFromDirectory(nodes), tree: formatTlv(nodes) };
  } catch { return { ok: true, sw: r.sw, aids: [] }; }
}

/**
 * SELECT 1PAY.SYS.DDF01 — the contact directory (a USB / contact reader): its
 * FCI names the directory's short file (tag 88), whose records (70 → 61 → 4F)
 * list the applications — READ RECORD 1, 2 … until the card says "not found".
 */
export async function selectPse(send: Sender): Promise<EmvDirectory> {
  let r: Response;
  try { r = await send(ISO.selectByAid(PSE)); } catch { return { ok: false, sw: 0x6f00, aids: [] }; }
  if (!isOk(r.sw)) return { ok: false, sw: r.sw, aids: [] };
  let fci: Tlv[] = [];
  try { fci = decodeTlv(r.data, { recurse: true }); } catch { /* no FCI */ }
  const sfiTag = findTlv(fci, 0x88)?.value;
  const sfi = sfiTag && sfiTag.length ? (sfiTag[sfiTag.length - 1] & 0x1f) || 1 : 1;
  const trees = fci.length ? [formatTlv(fci)] : [];
  // A directory may also list applications in its FCI (BF0C), as the PPSE does.
  const nodes: Tlv[] = [...fci];
  for (let rec = 1; rec <= 16; rec++) {
    let rr: Response;
    try { rr = await send(ISO.readRecord(rec, sfi)); } catch { break; }
    if (!isOk(rr.sw) || rr.data.length === 0) break;
    try { const n = decodeTlv(rr.data, { recurse: true }); nodes.push(...n); trees.push(formatTlv(n)); } catch { /* not TLV */ }
  }
  return { ok: true, sw: r.sw, aids: aidsFromDirectory(nodes), sfi, ...(trees.length ? { tree: trees.join("\n") } : {}) };
}

/** SELECT an application by AID: its FCI (label, PDOL, the log entry). */
export async function selectAid(send: Sender, aidHex: string): Promise<{ ok: boolean; sw: number; fci: Tlv[]; label?: string; pdol?: Uint8Array }> {
  const aid = Uint8Array.from((aidHex.match(/../g) ?? []).map((b) => parseInt(b, 16)));
  let r: Response;
  try { r = await send(ISO.selectByAid(aid)); } catch { return { ok: false, sw: 0x6f00, fci: [] }; }
  if (!isOk(r.sw)) return { ok: false, sw: r.sw, fci: [] };
  let fci: Tlv[] = [];
  try { fci = decodeTlv(r.data, { recurse: true }); } catch { /* an FCI that is not TLV */ }
  const label = findTlv(fci, 0x50)?.value ?? findTlv(fci, 0x9f12)?.value;
  const pdol = findTlv(fci, 0x9f38)?.value;
  return { ok: true, sw: r.sw, fci, label: label ? asciiOf(label) : undefined, pdol };
}

/** The well-known payment AIDs the card selects (for a card without a directory), at most `max`. */
export async function probeAids(send: Sender, max = 8, candidates: string[] = CANDIDATE_AIDS.map((c) => c.aid)): Promise<string[]> {
  const out: string[] = [];
  for (const aid of candidates) {
    const sel = await selectAid(send, aid);
    if (sel.ok) out.push(aid);
    if (out.length >= max) break;
  }
  return out;
}

async function gpo(send: Sender, pdol?: Uint8Array): Promise<{ sw: number; aip?: Uint8Array; afl?: Uint8Array; extra: Tlv[] }> {
  const data = pdol && pdol.length ? fillDol(pdol) : new Uint8Array(0);
  // Command data is a tag 83 holding the filled PDOL (empty when the card has none).
  const field = concat(Uint8Array.from([0x83, data.length]), data);
  let r: Response;
  try { r = await send(apdu(0x80, 0xa8, 0x00, 0x00, field, 0)); } catch { return { sw: 0x6f00, extra: [] }; }
  if (!isOk(r.sw)) return { sw: r.sw, extra: [] };
  let nodes: Tlv[] = [];
  try { nodes = decodeTlv(r.data, { recurse: true }); } catch { return { sw: r.sw, extra: [] }; }
  const fmt1 = findTlv(nodes, 0x80); // AIP(2) || AFL(rest)
  if (fmt1) return { sw: r.sw, aip: fmt1.value.slice(0, 2), afl: fmt1.value.slice(2), extra: nodes };
  const resp = findTlv(nodes, 0x77);
  if (resp) return { sw: r.sw, aip: findTlv(resp.children ?? [], 0x82)?.value, afl: findTlv(resp.children ?? [], 0x94)?.value, extra: resp.children ?? [] };
  return { sw: r.sw, extra: nodes };
}

/** One application while it is read: what its FCI, GET DATA, the log, GPO and the records gave so far. */
export type EmvAppState = {
  aid: string;
  label?: string;
  pdol?: Uint8Array;
  tags: Map<string, Uint8Array>;
  records: EmvRecord[];
  x: AppExtras;
  /** GET DATA tags already asked (a later step does not ask again). */
  asked: Set<string>;
};

/** Starts an application's read from its SELECT answer. */
export function startApp(aid: string, sel: { fci: Tlv[]; label?: string; pdol?: Uint8Array }): EmvAppState {
  const tags = new Map<string, Uint8Array>();
  collectLeaves(sel.fci, tags);
  const records: EmvRecord[] = [];
  return { aid: aid.toUpperCase(), label: sel.label, pdol: sel.pdol, tags, records, x: { getData: new Map(), records }, asked: new Set() };
}

/** GET DATA (80 CA) of each tag — counters, the log entry and format, balances. A tag the card does not have is no error. */
export async function appGetData(send: Sender, app: EmvAppState, tags: string[] = GET_DATA_TAGS): Promise<void> {
  for (const raw of tags) {
    const tag = raw.toUpperCase();
    app.asked.add(tag);
    const v = await getData(send, tag);
    if (v) app.x.getData.set(tag, v);
  }
}

/**
 * The transaction log: its entry (9F4D: SFI, count) and format (9F4F) — from
 * the FCI or GET DATA; with `ask` the ones not asked yet are fetched first —
 * then READ RECORD of each entry, decoded by the format. No log is no error.
 */
export async function appReadLog(send: Sender, app: EmvAppState, opts: { ask?: boolean } = {}): Promise<void> {
  if (opts.ask) for (const tag of ["9F4D", "9F4F"]) if (!app.tags.has(tag) && !app.x.getData.has(tag) && !app.asked.has(tag)) await appGetData(send, app, [tag]);
  const logEntry = app.tags.get("9F4D") ?? app.x.getData.get("9F4D");
  if (!logEntry || logEntry.length < 2) return;
  const fmt = app.x.getData.get("9F4F") ?? app.tags.get("9F4F");
  app.x.logSfi = logEntry[0];
  if (fmt) app.x.logFormat = fmt;
  app.x.log = await readLog(send, logEntry[0], logEntry[1], fmt ? parseDol(fmt) : [], app.records);
}

/** GET PROCESSING OPTIONS with the PDOL filled with a terminal's neutral defaults → AIP + AFL (no transaction is made). */
export async function appGpo(send: Sender, app: EmvAppState): Promise<{ ok: boolean; sw: number }> {
  const options = await gpo(send, app.pdol);
  collectLeaves(options.extra, app.tags);
  app.x.aip = options.aip; app.x.afl = options.afl;
  return { ok: isOk(options.sw), sw: options.sw };
}

/** READ RECORD of every record the AFL lists. */
export async function appReadAfl(send: Sender, app: EmvAppState): Promise<void> {
  if (app.x.afl && app.x.afl.length) await readRecords(send, parseAfl(app.x.afl), app.tags, app.records);
}

/** READ RECORD over a range of short files beyond the AFL (a deep read; default SFI 1–30, records 1–16); the log's file is left to the log. */
export async function appReadFiles(send: Sender, app: EmvAppState, range: { sfi?: [number, number]; records?: [number, number] } = {}, budget: { left: number } = { left: 240 }): Promise<void> {
  await scanFiles(send, app.tags, app.records, app.x.logSfi, budget, range);
}

/** The application as read: its records in order, every element parsed and labelled. */
export function finishApp(app: EmvAppState): EmvApp {
  app.records.sort((a, b) => a.sfi - b.sfi || a.record - b.record);
  return buildApp(app.aid, new Map(app.tags), app.label, { ...app.x, getData: new Map(app.x.getData) });
}

/* ------------------------------------------------------------------ public */

/**
 * Reads an EMV card's applications and everything they show a terminal:
 * the records, the counters, and the transaction log. `maxApps` caps how many
 * applications are opened (default 8); `history` reads the log (default on);
 * `deep` reads every short file, not only the AFL's (default on); `aid`
 * (6.10) is read first — the application an older template favours.
 */
export async function readEmv(t: CardTransport, opts: EmvReadArgs = {}): Promise<EmvData> {
  let apdus = 0;
  const send: Sender = (cmd) => { apdus++; return transmitSmart((a) => t.transmit(a), cmd); };
  const maxApps = Math.max(1, Math.min(16, opts.maxApps ?? 8));
  const deep = opts.deep !== false;
  const prefer = typeof opts.aid === "string" && /^[0-9A-Fa-f]{10,32}$/.test(opts.aid) ? opts.aid.toUpperCase() : undefined;
  const dir = await selectPpse(send);
  let aids = dir.aids;
  // No directory: try the well-known AIDs and keep the ones the card selects.
  if (aids.length === 0) aids = await probeAids(send, maxApps, prefer ? [prefer, ...CANDIDATE_AIDS.map((c) => c.aid).filter((a) => a !== prefer)] : undefined);
  else if (prefer) aids = [prefer, ...aids.filter((a) => a !== prefer)];

  const apps: EmvApp[] = [];
  const budget = { left: 240 };
  for (const aidHex of aids.slice(0, maxApps)) {
    const sel = await selectAid(send, aidHex);
    if (!sel.ok) continue;
    const app = startApp(aidHex, sel);
    // Before the transaction starts: the counters, and the log the card keeps.
    await appGetData(send, app);
    if (opts.history !== false) await appReadLog(send, app);
    await appGpo(send, app);
    if (app.x.afl && app.x.afl.length) await appReadAfl(send, app);
    else if (!deep) {
      // No AFL: a light scan of the first files for the holder records.
      const scan: AflEntry[] = [];
      for (let sfi = 1; sfi <= 4; sfi++) scan.push({ sfi, first: 1, last: 8 });
      await readRecords(send, scan, app.tags, app.records);
    }
    if (deep) await appReadFiles(send, app, {}, budget);
    apps.push(finishApp(app));
  }

  return { scheme: apps[0]?.scheme ?? (aids[0] ? schemeForAid(aids[0]) : undefined), aids, apps, tree: dir.tree || undefined, deep, apdus };
}

/** A one-line summary for a log / flash. */
export function emvSummary(d: EmvData): string {
  if (d.apps.length === 0) return d.aids.length ? `EMV: ${d.aids.length} application(s), no records read` : "No EMV application found";
  const a = d.apps[0];
  const history = d.apps.reduce((n, x) => n + (x.log?.length ?? 0), 0);
  const bits = [a.scheme || a.label, a.panMasked, a.expiry, history ? `${history} transaction${history > 1 ? "s" : ""}` : ""].filter(Boolean);
  return bits.join(" · ") || `EMV: ${d.apps.length} application(s)`;
}
