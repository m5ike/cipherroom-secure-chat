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

export function nfcPackages() {
  return PACKAGES.map((p) => {
    const flow = flowOf(p);
    const c = compileFlow(flow);
    const readme = `# ${p.title}\n\n${p.description}\n\nChat: \`/${p.keyword}\` — runs on the device that tapped the card.\n\nBuilt as a flow: open it in Functions › Builder (flow.m5flow.json); index.js is what it compiles to.\n\nNeeds the NFC module (Modules & groups) and a device with a reader — the phone's own NFC (Android Chrome / the Android app) or a USB/BLE reader. The op runs on the caller's device (m5.nfc); the model starts switched off.\n`;
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
