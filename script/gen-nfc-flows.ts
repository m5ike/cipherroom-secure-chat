// Writes the NFC example packages (6.3) as visual flows: for a few m5.nfc ops a
// package in server/functions/builtins/src/nfc-*/ with
//   flow.m5flow.json   the flow — Functions › Builder opens it (shows the NFC nodes)
//   index.js           what it compiles to (what runs)
//   README.md
// Each op runs on the CALLER'S device (an "nfc" run interaction), so the models
// install switched OFF — the operator turns one on and the person needs NFC
// access. Run after changing it: npx tsx script/gen-nfc-flows.ts && npm run gen:builtins

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFlow, parseFlow, type Flow, type FlowEdge, type FlowNode } from "../server/functions/flow";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "server", "functions", "builtins", "src");

type NfcPackage = {
  name: string; keyword: string; title: string; summary: string; description: string;
  /** The main NFC node and its params. */
  node: { type: string; params?: Record<string, unknown> };
  /** How the result is shown: json, or a markdown template over the node's field outputs. */
  show: { kind: "json"; title: string } | { kind: "markdown"; template: string; fields: string[] };
  /** 6.6: a flow of its own (the NFC.EMV / NFC.e-ID tools), instead of node + show. */
  build?: () => Flow;
  /** README lines after the description. */
  more?: string;
};

const PACKAGES: NfcPackage[] = [
  {
    name: "nfc-scan", keyword: "nfc-scan", title: "Scan a card", summary: "Read a tapped card's identity and NDEF",
    description: "Waits for a card at your device and reads its public identity (UID, technology, ATQA/SAK/ATR) and any NDEF records — nothing that needs a key.",
    node: { type: "nfc.scan", params: { timeout: 30 } },
    show: { kind: "json", title: "Card" },
  },
  {
    name: "nfc-uid", keyword: "nfc-uid", title: "Card UID", summary: "Read only a card's UID / serial",
    description: "Reads just the UID (serial number) of a tapped card and shows it — the quickest identity check.",
    node: { type: "nfc.read", params: { what: "uid", timeout: 20 } },
    show: { kind: "markdown", template: "**Card** — UID `{uid}` ({status})", fields: ["uid", "status"] },
  },
  {
    name: "nfc-m5", keyword: "nfc-open", title: "Open an M5Cet card", summary: "List the records on an M5Cet card",
    description: "Opens an M5Cet card and lists its records (type and a summary). Each record is opened on the device with its PIN or your account; a secret never reaches the model.",
    node: { type: "nfc.m5.read", params: { timeout: 30 } },
    show: { kind: "json", title: "M5Cet records" },
  },
  // 6.6: the NFC.EMV / NFC.e-ID tools as ready commands.
  {
    name: "nfc-emv", keyword: "emv", title: "Read a payment card (EMV)", summary: "Everything a payment card shows a terminal, with its transaction history",
    description: "Waits for a payment card (Visa, Mastercard, Maestro, Amex…) at your device and reads everything a terminal may read: every application, every record (every file on the card), the counters and the transaction history. It shows it formatted in the chat — the card number masked — with the history as CSV and the raw records to download. Read-only: no PIN, no payment, no write.",
    node: { type: "nfc.emv.report" }, show: { kind: "json", title: "" },
    build: emvFlow,
    more: "Built from the Builder's NFC.EMV tools: “EMV: read everything” (format html, show in the chat) → Result (the one-line summary). Change the format (object, array, json, text, csv) or wire “EMV → format” / “EMV: transaction history” for other views.",
  },
  {
    name: "nfc-emv-history", keyword: "emv-history", title: "Card transaction history", summary: "The transactions a payment card keeps in its log",
    description: "Reads the transaction log of a payment card at your device — the last transactions the card itself remembers: date, time, amount and currency, merchant, type, country — and shows them as a table. Not every card keeps a readable log. Read-only.",
    node: { type: "nfc.emv.report" }, show: { kind: "json", title: "" },
    build: historyFlow,
    more: "Built from the Builder's NFC.EMV tools: “EMV: read everything” (no deep read, nothing shown) → If (read ok) → “EMV: transaction history” → Send table; otherwise a notice says why.",
  },
  {
    name: "nfc-eid", keyword: "eid", title: "Read an e-ID / e-passport", summary: "Every data group of your ID card or passport, with the photo",
    description: "Asks for the CAN printed on your ID card (6 digits) — or the MRZ / document number, date of birth and expiry of a passport — then reads the chip at your device: PACE with the CAN, or BAC with the MRZ (the document's own access control). It shows everything the chip gives a reader: the MRZ data, the photo and signature, more personal and document details, and the security check (every group against EF.SOD); the security objects and JPEG 2000 pictures come as files to download. Your own document, read-only.",
    node: { type: "nfc.eid.report" }, show: { kind: "json", title: "" },
    build: eidFlow,
    more: "Built from the Builder's NFC.e-ID tools: execute shows a form; its form function reads with “e-ID: read everything” (format html, show in the chat) → Result (the one-line summary); the error function flashes what went wrong. The CAN or MRZ goes to your device only for this read.",
  },
];

let seq = 0;
const node = (type: string, x: number, y: number, params: Record<string, unknown> = {}, values: Record<string, unknown> = {}): FlowNode => ({ id: `n${++seq}`, type, x, y, params, values });
const edge = (from: FlowNode, fp: string, to: FlowNode, tp: string): FlowEdge => ({ id: `e${++seq}`, from: { node: from.id, port: fp }, to: { node: to.id, port: tp } });

function flowOf(p: NfcPackage): Flow {
  seq = 0;
  const op = node(p.node.type, 120, 120, { ...(p.node.params ?? {}) });
  const nodes: FlowNode[] = [op];
  const edges: FlowEdge[] = [];
  // The API / webhook caller gets the whole result back.
  const ret = node("flow.return", 620, 260);
  nodes.push(ret);
  edges.push(edge(op, "result", ret, "value"));
  if (p.show.kind === "json") {
    const j = node("out.json", 460, 100, { title: p.show.title });
    nodes.push(j);
    edges.push(edge(op, "result", j, "value"));
  } else {
    const tpl = node("text.template", 460, 100, { template: p.show.template });
    const md = node("out.markdown", 720, 100);
    nodes.push(tpl, md);
    for (const f of p.show.fields) edges.push(edge(op, f, tpl, f));
    edges.push(edge(tpl, "text", md, "text"));
  }
  return parseFlow({ format: "m5flow", version: 1, lang: "js", name: p.title, summary: p.summary, nodes, edges });
}

/** error: say what went wrong (as the telephony packages do). */
function errorGraph() {
  const ev = node("flow.event", 40, 60);
  const msg = node("data.get", 240, 60, { path: "message" });
  const flash = node("out.flash", 460, 60, { level: "error" });
  return { nodes: [ev, msg, flash], edges: [edge(ev, "error", msg, "object"), edge(msg, "value", flash, "text")] };
}

function emvFlow(): Flow {
  seq = 0;
  const read = node("nfc.emv.report", 120, 120, { format: "html", send: true, history: true, deep: true, fullPan: false, maxApps: 8, timeout: 45 });
  const ret = node("flow.return", 480, 160);
  return parseFlow({ format: "m5flow", version: 1, lang: "js", name: "Read a payment card (EMV)", summary: "Everything a payment card shows a terminal, with its transaction history",
    nodes: [read, ret], edges: [edge(read, "summary", ret, "value")], functions: { error: errorGraph() } });
}

function historyFlow(): Flow {
  seq = 0;
  const read = node("nfc.emv.report", 80, 120, { format: "object", send: false, history: true, deep: false, fullPan: false, maxApps: 8, timeout: 45 });
  const ok = node("logic.if", 380, 120);
  const hist = node("nfc.emv.history", 660, 60);
  const table = node("out.table", 920, 60, { columns: "date, time, amount, currency, merchant, type, country, atc", title: "Transaction history" });
  const why = node("data.get", 660, 260, { path: "message" });
  const flash = node("out.flash", 920, 260, { level: "warning" });
  const ret = node("flow.return", 380, 360);
  return parseFlow({ format: "m5flow", version: 1, lang: "js", name: "Card transaction history", summary: "The transactions a payment card keeps in its log",
    nodes: [read, ok, hist, table, why, flash, ret],
    edges: [edge(read, "ok", ok, "condition"), edge(read, "data", ok, "value"), edge(ok, "then", hist, "data"), edge(hist, "rows", table, "rows"),
      edge(ok, "else", why, "object"), edge(why, "value", flash, "text"), edge(read, "summary", ret, "value")],
    functions: { error: errorGraph() } });
}

/** The e-ID form: the CAN, or the MRZ / the three BAC fields. */
export const EID_FORM_FIELDS = [
  { name: "can", type: "text", label: "CAN — the 6 digits printed on the card", pattern: "^[0-9]{6}$", placeholder: "123456", help: "On an EU ID card: the 6-digit number on the front. Passports: leave it empty and give the MRZ or the three fields below." },
  { name: "mrz", type: "textarea", label: "or the MRZ (the 2–3 lines at the bottom of the data page)", rows: 3 },
  { name: "documentNumber", type: "text", label: "or the document number", placeholder: "L898902C" },
  { name: "dateOfBirth", type: "text", label: "Date of birth (YYMMDD)", pattern: "^[0-9]{6}$", placeholder: "690806" },
  { name: "dateOfExpiry", type: "text", label: "Date of expiry (YYMMDD)", pattern: "^[0-9]{6}$", placeholder: "940623" },
];

function eidFlow(): Flow {
  seq = 0;
  // execute: the form.
  const form = node("out.form", 80, 120, { form: { name: "nfc-eid", title: "Read an e-ID / e-passport", text: "Your own document: the CAN opens an ID card (PACE), the MRZ a passport (BAC). Then hold it to your phone or reader.", submit: "Read", labels: "top", fields: EID_FORM_FIELDS } });
  // form: its values → e-ID: read everything → the summary.
  const ev = node("flow.event", 40, 80);
  const read = node("nfc.eid.report", 460, 120, { format: "html", send: true, photo: true, all: true, timeout: 60 });
  const ret = node("flow.return", 760, 200);
  const g = { nodes: [ev, read, ret] as FlowNode[], edges: [edge(read, "summary", ret, "value")] as FlowEdge[] };
  let y = 0;
  for (const f of ["can", "mrz", "documentNumber", "dateOfBirth", "dateOfExpiry"]) {
    const get = node("data.get", 240, (y += 80), { path: f });
    g.nodes.push(get);
    g.edges.push(edge(ev, "values", get, "object"), edge(get, "value", read, f));
  }
  return parseFlow({ format: "m5flow", version: 1, lang: "js", name: "Read an e-ID / e-passport", summary: "Every data group of your ID card or passport, with the photo", nodes: [form], edges: [], functions: { form: g, error: errorGraph() } });
}

export function nfcPackages() {
  return PACKAGES.map((p) => {
    const flow = p.build ? p.build() : flowOf(p);
    const c = compileFlow(flow);
    const readme = `# ${p.title}\n\n${p.description}\n\nChat: \`/${p.keyword}\` — runs on the device that tapped the card.\n\nBuilt as a flow: open it in Functions › Builder (flow.m5flow.json); index.js is what it compiles to.${p.more ? ` ${p.more}` : ""}\n\nNeeds the NFC module (Modules & groups) and a device with a reader — the phone's own NFC (Android Chrome / the Android app) or a USB/BLE reader. The op runs on the caller's device (m5.nfc); the model starts switched off.\n`;
    return { ...p, files: { "flow.m5flow.json": `${JSON.stringify(flow, null, 2)}\n`, [c.file]: `${c.code}\n`, "README.md": readme } };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const p of nfcPackages()) {
    const dir = join(out, p.name);
    mkdirSync(dir, { recursive: true });
    for (const [f, text] of Object.entries(p.files)) writeFileSync(join(dir, f), text);
    console.log(`wrote ${dir}`);
  }
}
