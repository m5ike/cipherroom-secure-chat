// Writes the telephony packages (6.0) as visual flows: for each m5.telephony
// function a package in server/functions/builtins/src/tel-*/ with
//   flow.m5flow.json   the flow — Functions › Builder opens it
//   index.js           what it compiles to (what runs)
//   README.md
// Each flow has the same shape: execute shows a form (its fields checked in
// the browser — required, patterns, ranges — before anything is sent); the
// form function reads the submitted values, wires them to the function's
// parameters, calls it and shows the result; error shows what went wrong.
// Run after changing it: npx tsx script/gen-telephony-flows.ts && npm run gen:builtins

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFlow, parseFlow, type Flow, type FlowEdge, type FlowNode } from "../server/functions/flow";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "server", "functions", "builtins", "src");

const E164 = "^\\+[1-9][0-9]{6,14}$";
const tel = (name: string, label: string, help = "In the international form: +420603123456") =>
  ({ name, type: "tel", label, required: true, pattern: E164, placeholder: "+420603123456", help });

type FormField = Record<string, unknown>;
type TelPackage = {
  name: string; keyword: string; title: string; summary: string; description: string;
  fields: FormField[];
  /** The telephony node, its params, and which form values go to which of its inputs (the rest go as options). */
  node: { type: string; params?: Record<string, unknown>; wires: Record<string, string> };
  /** How the result is shown. */
  show: { kind: "markdown"; template: string; keys: string[] } | { kind: "json"; title: string };
  /**
   * 6.11: the command takes this field's value too ("/hlr +420603123456"): execute checks it
   * (spaces, dashes, dots, brackets and a leading 00 are tidied away) and calls the function at
   * once; without it — the form; with a wrong one — an error and the form, prefilled with it.
   */
  direct?: string;
};

const PACKAGES: TelPackage[] = [
  {
    name: "tel-call", keyword: "call", title: "Phone call", summary: "Call a phone number and say something (ring timeout 10 s)",
    description: "A phone call through the operator's provider: says your text when answered, waits for the end and reports how it went.",
    fields: [tel("to", "Number to call"), { name: "text", type: "textarea", label: "What to say", required: true, rows: 3, placeholder: "Dobrý den, …" },
      { name: "timeout", type: "number", label: "Ring for (seconds)", min: 5, max: 60, step: 1, default: 10 },
      { name: "from", type: "tel", label: "From (empty: the provider's number)", pattern: `(${E164})?` }],
    node: { type: "tel.call", params: { wait: true }, wires: { to: "to", text: "text" } },
    show: { kind: "markdown", template: "**Call to {to}** — {status}, {duration} s", keys: ["to", "status", "duration"] },
  },
  {
    name: "tel-sms", keyword: "sms", title: "SMS", summary: "Send an SMS",
    description: "An SMS through the operator's provider; its delivery report comes back to the model.",
    fields: [tel("to", "Recipient"), { name: "text", type: "textarea", label: "Text", required: true, rows: 4, pattern: "^[\\s\\S]{1,1600}$", help: "Up to 1600 characters (about ten SMS)" },
      { name: "from", type: "text", label: "Sender (empty: default)", pattern: "^([+0-9]{3,16}|[A-Za-z0-9 ]{1,11})?$", help: "A number, or up to 11 letters where the country allows it" }],
    node: { type: "tel.sms", wires: { to: "to", text: "text" } },
    show: { kind: "markdown", template: "**SMS to {to}** — {status} ({id})", keys: ["to", "status", "id"] },
  },
  {
    name: "tel-whatsapp", keyword: "whatsapp", title: "WhatsApp", summary: "Send a WhatsApp message (text, or a template)",
    description: "A WhatsApp message: free text within 24 hours of the recipient's last message, otherwise an approved template.",
    fields: [tel("to", "Recipient"), { name: "text", type: "textarea", label: "Text", rows: 3 },
      { name: "template", type: "text", label: "Template (outside the 24-hour window)", pattern: "^[a-z0-9_]{0,512}$|^HX[0-9a-f]{32}$" },
      { name: "language", type: "text", label: "Template language", default: "cs", pattern: "^[a-z]{2}(_[A-Z]{2})?$" }],
    node: { type: "tel.message", params: { channel: "whatsapp" }, wires: { to: "to", text: "text" } },
    show: { kind: "markdown", template: "**WhatsApp to {to}** — {status}", keys: ["to", "status"] },
  },
  {
    name: "tel-viber", keyword: "viber", title: "Viber", summary: "Send a Viber service message",
    description: "A Viber service message (Vonage; the business must be approved by Viber).",
    fields: [tel("to", "Recipient"), { name: "text", type: "textarea", label: "Text", required: true, rows: 3 },
      { name: "category", type: "select", label: "Category", default: "transaction", options: [{ value: "transaction", label: "transaction" }, { value: "promotion", label: "promotion" }] }],
    node: { type: "tel.message", params: { channel: "viber" }, wires: { to: "to", text: "text" } },
    show: { kind: "markdown", template: "**Viber to {to}** — {status}", keys: ["to", "status"] },
  },
  {
    name: "tel-messenger", keyword: "messenger", title: "Messenger", summary: "Send a Facebook Messenger message",
    description: "A Facebook Messenger message to a person who wrote to the page (their page-scoped id).",
    fields: [{ name: "to", type: "text", label: "Recipient (page-scoped id)", required: true, pattern: "^[0-9]{5,32}$" }, { name: "text", type: "textarea", label: "Text", required: true, rows: 3 },
      { name: "tag", type: "select", label: "Outside 24 hours", default: "", options: [{ value: "", label: "—" }, { value: "HUMAN_AGENT", label: "HUMAN_AGENT" }] }],
    node: { type: "tel.message", params: { channel: "messenger" }, wires: { to: "to", text: "text" } },
    show: { kind: "markdown", template: "**Messenger to {to}** — {status}", keys: ["to", "status"] },
  },
  {
    name: "tel-lookup", keyword: "lookup", title: "Number lookup", summary: "Everything about a phone number: country, type, carrier, name, porting, roaming",
    description: "What can be learnt about a phone number: the numbering plan (free) and the configured providers' data — carrier, caller name, porting, roaming, reachability — merged.",
    fields: [{ name: "number", type: "tel", label: "Number", required: true, pattern: "^[+0-9 ()./-]{3,24}$", placeholder: "+420603123456" },
      { name: "country", type: "text", label: "Country for a national number (ISO)", pattern: "^([A-Za-z]{2})?$", placeholder: "CZ" },
      { name: "offline", type: "switch", label: "Only what is free (no providers)" }],
    node: { type: "tel.lookup", wires: { number: "number" } },
    show: { kind: "json", title: "Number" },
  },
  {
    name: "tel-hlr", keyword: "hlr", title: "HLR", summary: "Ask a number's home network: reachable, roaming, ported",
    description: "An HLR query: whether the phone is connected, roaming (where), ported, and its network.",
    fields: [tel("number", "Number")],
    node: { type: "tel.hlr", wires: { number: "number" } },
    show: { kind: "json", title: "HLR" },
    direct: "number",
  },
  {
    name: "tel-did", keyword: "phone-bridge", title: "Phone bridge", summary: "Lend a phone number and a 5-digit code that connect a caller to a room member",
    description: "Lends a phone number (10 minutes by default) with a 5-digit code: whoever calls it and types the code and # is connected with the member — audio in their browser, or speech to text and their written replies spoken back.",
    fields: [{ name: "room", type: "text", label: "Room (its id or hash)", required: true }, { name: "member", type: "text", label: "Member (name or peer id)", required: true },
      { name: "minutes", type: "number", label: "Valid for (minutes)", min: 1, max: 120, default: 10 },
      { name: "mode", type: "select", label: "Mode", default: "auto", options: [{ value: "auto", label: "audio when taken, else text" }, { value: "audio", label: "audio" }, { value: "text", label: "speech ↔ text" }] }],
    node: { type: "tel.did", wires: { room: "room", member: "member" } },
    show: { kind: "markdown", template: "**Call {number}** and type **{code}#** — valid until {expires}", keys: ["number", "code", "expires"] },
  },
];

let seq = 0;
const node = (type: string, x: number, y: number, params: Record<string, unknown> = {}, values: Record<string, unknown> = {}): FlowNode => ({ id: `n${++seq}`, type, x, y, params, values });
const edge = (from: FlowNode, fp: string, to: FlowNode, tp: string): FlowEdge => ({ id: `e${++seq}`, from: { node: from.id, port: fp }, to: { node: to.id, port: tp } });

/**
 * 6.11: execute for a command that takes the number itself — the Input, tidied, checked
 * against E.164; If it holds: the function and its result (as the form function shows it);
 * else a Code node answers with the form — prefilled with what was typed, and saying what
 * is wrong (with an error flash) when something was.
 */
function directExecute(p: TelPackage, fieldName: string): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const field = p.fields.find((f) => f.name === fieldName)!;
  const input = node("flow.input", 40, 120, { name: fieldName, type: "string", label: String(field.label ?? fieldName), default: "", required: false, values: "" });
  const typed = node("code.expr", 220, 120, { args: "n", expr: "String(n ?? \"\").trim().slice(0, 40)" }, {});
  typed.label = "What was typed";
  const clean = node("code.expr", 400, 120, { args: "t", expr: "t.replace(/[\\s().\\/-]/g, \"\").replace(/^00(?=[1-9])/, \"+\")" }, {});
  clean.label = "Tidy the number";
  const valid = node("logic.compare", 580, 60, { op: "matches" }, { b: E164 });
  valid.label = "International form?";
  const gate = node("logic.if", 760, 120);
  const call = node(p.node.type, 940, 60, { ...p.node.params });
  const shown = p.show.kind === "json" ? node("out.json", 1120, 60, { title: p.show.title }) : null;
  const form = { name: p.name, title: p.title, text: p.summary, submit: "Send", labels: "top", fields: p.fields };
  const code = [
    `const t = String(typed || "");`,
    `const form = ${JSON.stringify(form)};`,
    `if (t) await m5.caller.send(m5.out.flash(\`“\${t}” is not a phone number in the international form (+420603123456).\`, "error"));`,
    `await m5.caller.send(m5.out.form(t ? { ...form, text: \`“\${t}” is not a phone number in the international form — correct it and send.\`, fields: form.fields.map((f) => (f.name === ${JSON.stringify(fieldName)} ? { ...f, default: t } : f)) } : form));`,
    `return t;`,
  ].join("\n");
  const ask = node("code.block", 940, 240, { args: `${fieldName}, typed`, code });
  ask.label = "The form (prefilled)";
  const nodes = [input, typed, clean, valid, gate, call, ...(shown ? [shown] : []), ask];
  const edges = [
    edge(input, "value", typed, "n"), edge(typed, "result", clean, "t"), edge(clean, "result", valid, "a"),
    edge(valid, "result", gate, "condition"), edge(clean, "result", gate, "value"),
    edge(gate, "then", call, p.node.wires[fieldName] ?? fieldName),
    ...(shown ? [edge(call, "result", shown, "value")] : []),
    edge(gate, "else", ask, fieldName), edge(typed, "result", ask, "typed"),
  ];
  return { nodes, edges };
}

function flowOf(p: TelPackage): Flow {
  seq = 0;
  // execute: the form — or (6.11) the number from the command, checked, else the form.
  const exec = p.direct ? directExecute(p, p.direct) : { nodes: [node("out.form", 80, 120, { form: { name: p.name, title: p.title, text: p.summary, submit: "Send", labels: "top", fields: p.fields } })], edges: [] as FlowEdge[] };
  // form: its values → the telephony node → the result.
  const ev = node("flow.event", 40, 80);
  const call = node(p.node.type, 380, 80, { ...p.node.params });
  const g = { nodes: [ev, call] as FlowNode[], edges: [edge(ev, "values", call, "options")] as FlowEdge[] };
  let y = 40;
  for (const [field, port] of Object.entries(p.node.wires)) {
    const get = node("data.get", 200, (y += 90), { path: field });
    g.nodes.push(get);
    g.edges.push(edge(ev, "values", get, "object"), edge(get, "value", call, port));
  }
  const resultOut = call.type === "tel.did" ? "session" : call.type === "tel.call" ? "call" : call.type === "tel.lookup" || call.type === "tel.hlr" ? "result" : "message";
  if (p.show.kind === "json") {
    const j = node("out.json", 640, 80, { title: p.show.title });
    g.nodes.push(j);
    g.edges.push(edge(call, resultOut, j, "value"));
  } else {
    const tpl = node("text.template", 640, 60, { template: p.show.template });
    const md = node("out.markdown", 880, 60);
    g.nodes.push(tpl, md);
    const from: Record<string, [FlowNode, string]> = {};
    for (const k of p.show.keys) {
      if (k === "to") { const get = node("data.get", 520, 220, { path: "to" }); g.nodes.push(get); g.edges.push(edge(ev, "values", get, "object")); from[k] = [get, "value"]; continue; }
      const path = k === "duration" ? "durationSec" : k === "expires" ? "expiresAt" : k;
      const get = node("data.get", 520, 300 + 60 * p.show.keys.indexOf(k), { path });
      g.nodes.push(get);
      g.edges.push(edge(call, resultOut, get, "object"));
      from[k] = [get, "value"];
    }
    for (const [k, [n, port]] of Object.entries(from)) g.edges.push(edge(n, port, tpl, k));
    g.edges.push(edge(tpl, "text", md, "text"));
  }
  // error: say what went wrong.
  const errEv = node("flow.event", 40, 60);
  const errMsg = node("data.get", 240, 60, { path: "message" });
  const flash = node("out.flash", 460, 60, { level: "error" });
  const errGraph = { nodes: [errEv, errMsg, flash], edges: [edge(errEv, "error", errMsg, "object"), edge(errMsg, "value", flash, "text")] };
  return parseFlow({ format: "m5flow", version: 1, lang: "js", name: p.title, summary: p.summary, nodes: exec.nodes, edges: exec.edges, functions: { form: g, error: errGraph } });
}

export function telephonyPackages() {
  return PACKAGES.map((p) => {
    const flow = flowOf(p);
    const c = compileFlow(flow);
    const chat = p.direct
      ? `Chat: \`/${p.keyword} +420603123456\` — the ${p.title} of that number at once (spaces, dashes and a leading 00 are fine); \`/${p.keyword}\` alone — a form, sending it runs the \`form\` function; a number that is not in the international form — an error and the form, prefilled with what was typed.`
      : `Chat: \`/${p.keyword}\` — a form; sending it runs the \`form\` function.`;
    const readme = `# ${p.title}\n\n${p.description}\n\n${chat}\n\nBuilt as a flow: open it in Functions › Builder (flow.m5flow.json); index.js is what it compiles to.\n\nNeeds the Telephony & SIP module (a provider configured, and your rights: Modules & groups). Its model starts switched off: it costs money.\n`;
    return { ...p, files: { "flow.m5flow.json": `${JSON.stringify(flow, null, 2)}\n`, [c.file]: `${c.code}\n`, "README.md": readme } };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const p of telephonyPackages()) {
    const dir = join(out, p.name);
    mkdirSync(dir, { recursive: true });
    for (const [f, text] of Object.entries(p.files)) writeFileSync(join(dir, f), text);
    console.log(`wrote ${dir}`);
  }
}
