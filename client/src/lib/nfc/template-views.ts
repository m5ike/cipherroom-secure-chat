// The four views of an APDU template run (6.10) — one PURE module (no DOM),
// shared by the NFC workbench, its Share / Forward / To-myself actions and the
// tests. Android renders the same four, the same text (TemplateViews.java):
//
//   io        every command and its response:
//               → 00A4040007A000000004101000
//               ← 6F1E8407A0000000041010… 9000 (OK)
//             a command the card did not answer: "← (no answer)"
//   raw       the responses only, one per line: "<data hex> <SW>"
//   json      the TemplateExchange[] — { step, label, op, command, response, sw, status, ms }
//             as JSON.stringify(exchanges, null, 2) writes it
//   readable  for people: the EMV / e-ID card report of 6.6 (card-report.ts) and,
//             for any other card, a generic report — each step's answer as
//             BER-TLV with the EMV names, a DESFire's GetVersion decoded, every
//             status word explained (describeSw — Android's StatusWords is its port)
//
// 6.10 (G-19): the answers carry a payment card's number and its tracks — 5A,
// Track 2 (57 / 9F6B), Track 1 (56) and the discretionary data (9F1F, 9F20).
// Every view masks them by default (pan-mask.ts: a PAN keeps its first six and
// last four digits, in BCD and in ASCII hex; track data is "X"); the answers of
// io / raw / json too — the hex stays a string, so the JSON stays valid. With
// `full: true` (the holder asked) the views show the bytes as the card sent them.

import { cardReport, escapeHtml } from "./card-report";
import { decodeTlv, describeSw, hex, unhex, type Tlv } from "./cards/apdu";
import { formatEmvValue, tagHex } from "./cards/emv";
import { emvTagInfo } from "./emv-tags";
import type { TemplateExchange, TemplateView } from "./apdu-templates";
import { describeCommand, type DesfireInfo, type GenericItem, type TemplateRun } from "./template-runner";
import { answerMasks, maskAnswer, maskPans, maskValue, PAN_TAGS, pansInHex, pansOfEmv } from "./pan-mask";
import { G_MORE } from "./template-views-i18n";
import { isLocale, localeChain, type Locale } from "../locales";

/* ------------------------------------------------------------ card numbers */

/** Every card number a run read: its EMV applications', and any in an answer it recorded. */
export function runPans(run: TemplateRun): string[] {
  const out = new Set<string>(pansOfEmv(run.data.emv));
  for (const e of run.exchanges) for (const p of pansInHex(e.response)) out.add(p);
  for (const it of run.data.generic.items) for (const p of pansInHex(it.response)) out.add(p);
  return [...out];
}

/** Whether masking hides anything in this run (the workbench then offers the full data and says it is masked). */
export function runMasks(run: TemplateRun): boolean {
  return runPans(run).length > 0 || run.exchanges.some((e) => answerMasks(e.response));
}

/** The run with the card numbers and track data masked in every recorded answer (the commands carry none). */
export function maskedRun(run: TemplateRun, pans: string[] = runPans(run)): TemplateRun {
  const m = (s: string) => maskAnswer(s, pans);
  return {
    ...run,
    exchanges: run.exchanges.map((e) => ({ ...e, response: m(e.response) })),
    data: { ...run.data, generic: { ...run.data.generic, items: run.data.generic.items.map((it) => ({ ...it, response: m(it.response) })) } },
  };
}

/** 6.13: one of the nine languages (lib/locales.ts); a missing label falls back along the language's chain (sk → cs → en). */
export type ViewLang = Locale;

/* ------------------------------------------------------------ status words */

/** A status word in words — describeSw (ISO 7816-4, DESFire 91xx); "no answer" when the card gave none. */
export function explainSw(sw: string | number): string {
  const n = typeof sw === "number" ? sw : /^[0-9A-Fa-f]{4}$/.test(String(sw)) ? parseInt(String(sw), 16) : NaN;
  return Number.isFinite(n) ? describeSw(n) : "no answer";
}

const swSpaced = (sw: string) => (sw.length === 4 ? `${sw.slice(0, 2)} ${sw.slice(2)}` : sw || "—");

/* ------------------------------------------------------------ io / raw / json */

const answerOf = (e: TemplateExchange) => [e.response, e.sw].filter(Boolean).join(" ");

/** Every command and its response: "→ 00A4…" then "← 6F2E… 9000 (OK)". */
export function ioView(exchanges: TemplateExchange[]): string {
  const lines: string[] = [];
  for (const e of exchanges) {
    const a = answerOf(e);
    lines.push(`→ ${e.command}`, `← ${a ? `${a} ` : ""}(${explainSw(e.sw)})`);
  }
  return lines.join("\n");
}

/** The responses only, one per line ("6F2E… 9000"; a command without an answer: "(no answer)"). */
export function rawView(exchanges: TemplateExchange[]): string {
  return exchanges.map((e) => answerOf(e) || `(${explainSw(e.sw)})`).join("\n");
}

/** The exchanges as JSON (commands and responses). */
export function jsonView(exchanges: TemplateExchange[]): string {
  return JSON.stringify(exchanges, null, 2);
}

/* ------------------------------------------------------------ the generic report */

const G_EN = {
  steps: "Commands and answers", command: "Command", status: "Status", data: "Data", text: "Text", none: "—", problems: "Problems", ok: "Read completely",
  apdus: "APDUs", desfire: "MIFARE DESFire", vendor: "Vendor", type: "Type", hwVersion: "Hardware version", swVersion: "Software version", storage: "Storage",
  protocol: "Protocol", uid: "UID", batch: "Batch number", produced: "Produced", week: "week", applications: "Applications", noApplications: "none (only the card level)",
  freeMemory: "Free memory", keySettings: "Card master key", masterKeyChangeable: "can be changed", freeDirectoryList: "applications listed without the key",
  freeCreateDelete: "applications created / deleted without the key", configurationChangeable: "settings can be changed", maxKeys: "keys", crypto: "cipher",
  yes: "yes", no: "no", cancelled: "Cancelled", step: "Step", template: "Template", masked: "Card numbers and track data are masked.",
} as const;
type GKey = keyof typeof G_EN;
const G_CS: Partial<Record<GKey, string>> = {
  steps: "Příkazy a odpovědi", command: "Příkaz", status: "Stav", data: "Data", text: "Text", problems: "Problémy", ok: "Přečteno celé", vendor: "Výrobce",
  type: "Typ", hwVersion: "Verze hardwaru", swVersion: "Verze softwaru", storage: "Paměť", protocol: "Protokol", batch: "Číslo šarže", produced: "Vyrobeno",
  week: "týden", applications: "Aplikace", noApplications: "žádné (jen úroveň karty)", freeMemory: "Volná paměť", keySettings: "Hlavní klíč karty",
  masterKeyChangeable: "lze změnit", freeDirectoryList: "aplikace se vypíší bez klíče", freeCreateDelete: "aplikace se vytvoří / smažou bez klíče",
  configurationChangeable: "nastavení lze změnit", maxKeys: "klíčů", crypto: "šifra", yes: "ano", no: "ne", cancelled: "Zrušeno", step: "Krok", template: "Šablona",
  masked: "Čísla karet a data stop jsou zamaskovaná.",
};
const G_DE: Partial<Record<GKey, string>> = {
  steps: "Befehle und Antworten", command: "Befehl", status: "Status", data: "Daten", text: "Text", problems: "Probleme", ok: "Vollständig gelesen", vendor: "Hersteller",
  type: "Typ", hwVersion: "Hardwareversion", swVersion: "Softwareversion", storage: "Speicher", protocol: "Protokoll", batch: "Chargennummer", produced: "Hergestellt",
  week: "Woche", applications: "Anwendungen", noApplications: "keine (nur Kartenebene)", freeMemory: "Freier Speicher", keySettings: "Kartenhauptschlüssel",
  masterKeyChangeable: "änderbar", freeDirectoryList: "Anwendungen ohne Schlüssel auflistbar", freeCreateDelete: "Anwendungen ohne Schlüssel anleg- / löschbar",
  configurationChangeable: "Einstellungen änderbar", maxKeys: "Schlüssel", crypto: "Verfahren", yes: "ja", no: "nein", cancelled: "Abgebrochen", step: "Schritt", template: "Vorlage",
  masked: "Kartennummern und Spurdaten sind maskiert.",
};
const G_LANGS: Partial<Record<Locale, Partial<Record<GKey, string>>>> = { cs: G_CS, de: G_DE, ...G_MORE };
function gLabels(lang?: string): (k: GKey) => string {
  const l = (lang ?? "en").slice(0, 2).toLowerCase();
  const chain = localeChain(isLocale(l) ? l : "en").map((c) => G_LANGS[c] ?? {});
  return (k) => { for (const d of chain) { const v = d[k]; if (v !== undefined) return v; } return G_EN[k]; };
}

/** A BER-TLV tree as indented lines, each element with its EMV / ISO 7816 name and a readable value. */
export function tlvLines(nodes: Tlv[], depth = 0, redact = false): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    const tag = tagHex(n.tag);
    const info = emvTagInfo(tag);
    const pad = "  ".repeat(depth);
    if (n.constructed && n.children) { out.push(`${pad}${tag} ${info.name}`); out.push(...tlvLines(n.children, depth + 1, redact)); continue; }
    const h = hex(n.value);
    // G-19: the PAN and the track data show only their masked hex.
    if (redact && (PAN_TAGS as readonly string[]).includes(tag)) { out.push(`${pad}${tag} ${info.name}: ${maskValue(tag, h)}`); continue; }
    const value = info.format === "hex" || info.format === "b" ? (printable(n.value) ? `"${text(n.value)}" (${h})` : h) : formatEmvValue(tag, n.value, info.format);
    out.push(`${pad}${tag} ${info.name}: ${value}${value !== h && !value.includes(h) ? `  (${h})` : ""}`);
  }
  return out;
}

const printable = (b: Uint8Array) => b.length > 1 && b.every((c) => c >= 0x20 && c < 0x7f);
const text = (b: Uint8Array) => Array.from(b).map((c) => String.fromCharCode(c)).join("");

/** An answer, decoded: BER-TLV when it is TLV, text when it is text, else hex. */
export function decodeAnswer(dataHex: string, redact = false): { kind: "tlv" | "text" | "hex" | "empty"; lines: string[] } {
  if (!dataHex) return { kind: "empty", lines: [] };
  let bytes: Uint8Array;
  try { bytes = unhex(dataHex); } catch { return { kind: "hex", lines: [dataHex] }; }
  // TLV only when the whole answer parses and starts with a constructed object or a known element.
  try {
    const nodes = decodeTlv(bytes, { recurse: true });
    const first = nodes[0];
    if (first && (first.constructed || !emvTagInfo(tagHex(first.tag)).name.startsWith("Tag "))) return { kind: "tlv", lines: tlvLines(nodes, 0, redact) };
  } catch { /* not TLV */ }
  if (printable(bytes)) return { kind: "text", lines: [`"${text(bytes)}"`] };
  return { kind: "hex", lines: [dataHex.replace(/(.{64})/g, "$1\n").trim()] };
}

type GRow = [string, string];
type GSection = { title: string; rows: GRow[]; pre?: string };

function desfireRows(d: DesfireInfo, G: (k: GKey) => string): GRow[] {
  const rows: GRow[] = [];
  const hw = d.hardware, sw = d.software;
  if (hw) { rows.push([G("vendor"), hw.vendor], [G("type"), hw.type], [G("hwVersion"), hw.version], [G("storage"), hw.storage], [G("protocol"), hw.protocol]); }
  if (sw) rows.push([G("swVersion"), sw.version]);
  if (d.uid) rows.push([G("uid"), d.uid]);
  if (d.batch) rows.push([G("batch"), d.batch]);
  if (d.year) rows.push([G("produced"), `${d.year}${d.week ? `, ${G("week")} ${d.week}` : ""}`]);
  if (d.applications) rows.push([G("applications"), d.applications.length ? d.applications.join(", ") : G("noApplications")]);
  if (d.freeMemory !== undefined) rows.push([G("freeMemory"), `${d.freeMemory} B`]);
  if (d.keySettings) {
    const k = d.keySettings;
    const yn = (v: boolean) => (v ? G("yes") : G("no"));
    rows.push([G("keySettings"), [`${G("masterKeyChangeable")}: ${yn(k.masterKeyChangeable)}`, `${G("freeDirectoryList")}: ${yn(k.freeDirectoryList)}`, `${G("freeCreateDelete")}: ${yn(k.freeCreateDelete)}`, `${G("configurationChangeable")}: ${yn(k.configurationChangeable)}`, `${k.maxKeys} ${G("maxKeys")}${k.crypto ? `, ${G("crypto")} ${k.crypto}` : ""}`].join("\n")]);
  }
  return rows;
}

const DESFIRE_CMD = /^90(60|AF|6A|6E|45)/i;

/** The generic report: the DESFire facts, then every fixed command's answer decoded (decoded first, then `mask` hides card numbers). */
function genericSections(items: GenericItem[], desfire: DesfireInfo | undefined, G: (k: GKey) => string, mask: (s: string) => string = (s) => s, redact = false): GSection[] {
  const out: GSection[] = [];
  if (desfire) out.push({ title: G("desfire"), rows: desfireRows(desfire, G) });
  for (const it of items) {
    const rows: GRow[] = [[G("command"), mask(`${it.command} — ${describeCommand(it.command)}`)], [G("status"), `${swSpaced(it.sw)} — ${explainSw(it.sw)}`]];
    const dec = desfire && DESFIRE_CMD.test(it.command) ? { kind: it.response ? "hex" as const : "empty" as const, lines: it.response ? [it.response] : [] } : decodeAnswer(it.response, redact);
    const sec: GSection = { title: `${it.step}. ${it.label}`, rows };
    if (dec.kind === "tlv") sec.pre = mask(dec.lines.join("\n"));
    else if (dec.kind === "text") rows.push([G("text"), mask(dec.lines[0])]);
    else if (dec.kind === "hex") rows.push([G("data"), mask(dec.lines.join("\n"))]);
    out.push(sec);
  }
  return out;
}

/** How a run is shown: the language, and whether the holder asked for the whole card number (G-19; masked by default). */
export type ViewOptions = { lang?: string; full?: boolean };

const masker = (run: TemplateRun, full?: boolean): ((s: string) => string) => {
  if (full) return (s) => s;
  const pans = runPans(run);
  return pans.length ? (s) => maskPans(s, pans) : (s) => s;
};

/* ------------------------------------------------------------ readable */

function head(run: TemplateRun, G: (k: GKey) => string, full: boolean): { title: string; status: string } {
  const status = run.cancelled ? G("cancelled") : run.ok ? `✓ ${G("ok")}` : `⚠ ${G("problems")}: ${run.problems.length}`;
  // G-19: the readable view says when it hides something (as Android's does).
  const masked = !full && runMasks(run) ? ` · ${G("masked")}` : "";
  return { title: run.label, status: `${status} · ${run.exchanges.length} ${G("apdus")} · ${(run.ms / 1000).toFixed(1)} s${masked}` };
}

/** The readable report as text (Markdown-friendly plain text); card numbers masked unless `full`. */
export function readableText(run: TemplateRun, lang?: string, full = false): string {
  const G = gLabels(lang);
  const h = head(run, G, full);
  const mask = masker(run, full);
  const parts: string[] = [`${h.title}\n${"=".repeat(Math.min(72, Math.max(8, h.title.length)))}`, h.status];
  if (run.note) parts.push(run.note);
  if (run.problems.length) parts.push(`${G("problems")}:\n${run.problems.map((p) => `  • ${mask(p)}`).join("\n")}`);
  if (run.data.emv) parts.push(String(cardReport({ status: "ok", emv: run.data.emv }, "text", { lang, fullPan: full }).value).trimEnd());
  if (run.data.mrtd) parts.push(String(cardReport({ status: "ok", mrtd: run.data.mrtd }, "text", { lang }).value).trimEnd());
  const gs = genericSections(run.data.generic.items, run.data.generic.desfire, G, mask, !full);
  if (gs.length) {
    const lines: string[] = [G("steps"), "-".repeat(G("steps").length)];
    for (const s of gs) {
      lines.push("", s.title);
      const w = Math.min(24, Math.max(0, ...s.rows.map(([f]) => f.length)));
      for (const [f, v] of s.rows) lines.push(`  ${f.padEnd(w)}  ${v.replace(/\n/g, `\n  ${" ".repeat(w + 2)}`)}`);
      if (s.pre) lines.push(s.pre.split("\n").map((l) => `    ${l}`).join("\n"));
    }
    parts.push(lines.join("\n"));
  }
  return `${parts.join("\n\n")}\n`;
}

/** The readable report as an HTML fragment (the chat's m5h-* look; every value escaped); card numbers masked unless `full`. */
export function readableHtml(run: TemplateRun, lang?: string, full = false): string {
  const G = gLabels(lang);
  const e = escapeHtml;
  const h = head(run, G, full);
  const mask = masker(run, full);
  const kv = (rows: GRow[]) => (rows.length ? `<table class="m5h-kv"><tbody>${rows.map(([f, v]) => `<tr><th>${e(f)}</th><td>${e(v).replace(/\n/g, "<br>")}</td></tr>`).join("")}</tbody></table>` : "");
  const parts: string[] = [`<div class="m5h-report m5h-report--template"><div class="m5h-head"><div class="m5h-title">${e(h.title)}</div><div class="m5h-sub">${e(h.status)}</div>${run.note ? `<div class="m5h-sub">${e(run.note)}</div>` : ""}</div>`];
  if (run.problems.length) parts.push(`<section class="m5h-sec"><h4>${e(G("problems"))} <span class="m5h-badge m5h-badge--err">${run.problems.length}</span></h4><ul class="m5h-files">${run.problems.map((p) => `<li>${e(mask(p))}</li>`).join("")}</ul></section>`);
  if (run.data.emv) parts.push(String(cardReport({ status: "ok", emv: run.data.emv }, "html", { lang, attachments: false, fullPan: full }).value));
  if (run.data.mrtd) parts.push(String(cardReport({ status: "ok", mrtd: run.data.mrtd }, "html", { lang, attachments: false }).value));
  const gs = genericSections(run.data.generic.items, run.data.generic.desfire, G, mask, !full);
  for (const s of gs) parts.push(`<section class="m5h-sec"><h4>${e(s.title)}</h4>${kv(s.rows)}${s.pre ? `<pre class="m5h-pre">${e(s.pre)}</pre>` : ""}</section>`);
  parts.push("</div>");
  return parts.join("");
}

/* ------------------------------------------------------------ one call */

/** A run in one of the four views, as text (readable: the plain-text report) — card numbers masked unless `full`. */
export function templateView(run: TemplateRun, view: TemplateView, opts: ViewOptions = {}): string {
  if (view === "readable") return readableText(run, opts.lang, opts.full);
  const ex = opts.full ? run.exchanges : maskedRun(run).exchanges;
  return view === "io" ? ioView(ex) : view === "raw" ? rawView(ex) : jsonView(ex);
}

/** A file name for a run's view: "nfc-visa-credit-debit-20261004-1530.json". */
export function runFileName(run: TemplateRun, view: TemplateView): string {
  const slug = run.label.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "template";
  const d = new Date(run.startedAt);
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  return `nfc-${slug}-${stamp}.${view === "json" ? "json" : "txt"}`;
}

/** The MIME type of a view's file. */
export function viewMime(view: TemplateView): string {
  return view === "json" ? "application/json" : "text/plain";
}
