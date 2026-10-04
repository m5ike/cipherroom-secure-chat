// Checking a TSA graph (6.9) against the palette (catalog.ts): what the editor
// marks while you draw, what a save refuses and what a publish refuses.
//
//   validateStructure(graph)   the shape: limits, ids, known tools, edges
//                              between existing ports of the right kind, one
//                              Start — a graph that fails these cannot be
//                              stored (or run)
//   validateGraph(graph)       the shape plus everything a call depends on:
//                              parameters (required, kinds, ranges, options,
//                              formulas that parse, digits, keys, times),
//                              inputs used but not connected, unreachable
//                              nodes, dead ends, Break outside a loop, cycles
//                              that never wait, Route audio without its KEY
//
// Errors block publishing; warnings are advice. Pure (the HTTP tool's host
// allowlist is passed in).

import { dataInputs, flowOutputs, toolOf, type TsaParamDef, type TsaToolDef } from "./catalog";
import { formulaRefs, parseFormula, validTimezone } from "./formula";
import { hasPlaceholders, templateRefs, withoutPlaceholders } from "./template";
import { NODE_ID, TSA_LIMITS, isTsaNodeType, type TsaEdge, type TsaGraph, type TsaNode, type TsaProblem } from "./types";

/* ----------------------------------------------------------------- index */

export type GraphIndex = {
  nodes: Map<string, TsaNode>;
  /** "node\0port" → the edge leaving that flow output. */
  flowOut: Map<string, TsaEdge>;
  /** "node\0port" → the edge arriving at that data input. */
  dataIn: Map<string, TsaEdge>;
  start: TsaNode | null;
};

const key = (node: string, port: string) => `${node}\0${port}`;

/** Lookups the runtime and the checks share (first edge wins where there are duplicates). */
export function indexGraph(g: TsaGraph): GraphIndex {
  const nodes = new Map<string, TsaNode>();
  for (const n of g.nodes) if (!nodes.has(n.id)) nodes.set(n.id, n);
  const flowOut = new Map<string, TsaEdge>();
  const dataIn = new Map<string, TsaEdge>();
  for (const e of g.edges) {
    if (e.kind === "flow") { if (!flowOut.has(key(e.from.node, e.from.port))) flowOut.set(key(e.from.node, e.from.port), e); }
    else if (!dataIn.has(key(e.to.node, e.to.port))) dataIn.set(key(e.to.node, e.to.port), e);
  }
  return { nodes, flowOut, dataIn, start: g.nodes.find((n) => n.type === "start") ?? null };
}

export const flowTarget = (ix: GraphIndex, node: string, port: string): string | null => ix.flowOut.get(key(node, port))?.to.node ?? null;
export const dataSource = (ix: GraphIndex, node: string, port: string): TsaEdge | null => ix.dataIn.get(key(node, port)) ?? null;

/** How many dynamic inputs a node has (IN1 … IN<n>), clamped to its tool's bounds. */
export function dynamicCount(node: Pick<TsaNode, "type" | "inputs">): number {
  const t = toolOf(node.type);
  if (!t) return 0;
  if (t.dynamicInputs) return Math.max(t.dynamicInputs.min, Math.min(t.dynamicInputs.max, Number.isInteger(node.inputs) ? node.inputs! : t.dynamicInputs.initial));
  // Fixed IN1 (switch, lookup) counts as one.
  return (t.dataIn ?? []).filter((p) => /^IN\d+$/.test(p.port)).length;
}

/* -------------------------------------------------------------- structure */

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const finiteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The shape of a graph: what must hold for it to be stored and run at all. */
export function validateStructure(graph: unknown): TsaProblem[] {
  const out: TsaProblem[] = [];
  const err = (message: string, at: Partial<TsaProblem> = {}) => out.push({ level: "error", message, ...at });
  if (!isObj(graph) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) { err("The graph must have a list of nodes and a list of edges."); return out; }
  const nodes = graph.nodes as unknown[];
  const edges = graph.edges as unknown[];
  if (nodes.length > TSA_LIMITS.nodes) err(`Too many nodes: ${nodes.length} (${TSA_LIMITS.nodes} at most).`);
  if (edges.length > TSA_LIMITS.edges) err(`Too many edges: ${edges.length} (${TSA_LIMITS.edges} at most).`);
  if (out.length) return out;

  const byId = new Map<string, TsaNode>();
  let starts = 0;
  for (const raw of nodes) {
    if (!isObj(raw)) { err("A node is not an object."); continue; }
    const id = raw.id;
    if (typeof id !== "string" || !NODE_ID.test(id)) { err(`Node id "${String(id).slice(0, 40)}" is not valid: a-z first, then a-z, 0-9 or _ (32 characters at most).`); continue; }
    if (byId.has(id)) { err(`Two nodes have the id "${id}".`, { node: id }); continue; }
    if (!isTsaNodeType(raw.type)) { err(`Node "${id}": unknown tool "${String(raw.type).slice(0, 40)}".`, { node: id }); continue; }
    if (!finiteNum(raw.x) || !finiteNum(raw.y)) err(`Node "${id}": its position (x, y) must be numbers.`, { node: id });
    if (raw.w !== undefined && !finiteNum(raw.w)) err(`Node "${id}": its width must be a number.`, { node: id });
    if (raw.label !== undefined && (typeof raw.label !== "string" || raw.label.length > 120)) err(`Node "${id}": the label must be text (120 characters at most).`, { node: id });
    if (raw.note !== undefined && (typeof raw.note !== "string" || raw.note.length > 4000)) err(`Node "${id}": the note must be text (4000 characters at most).`, { node: id });
    if (!isObj(raw.params)) err(`Node "${id}": params must be an object.`, { node: id });
    const tool = toolOf(raw.type)!;
    if (raw.inputs !== undefined) {
      if (!tool.dynamicInputs) { if (raw.inputs !== 0) err(`Node "${id}": ${tool.label} has no inputs to add.`, { node: id }); }
      else if (!Number.isInteger(raw.inputs) || (raw.inputs as number) < tool.dynamicInputs.min || (raw.inputs as number) > tool.dynamicInputs.max) {
        err(`Node "${id}": ${tool.label} takes ${tool.dynamicInputs.min}–${tool.dynamicInputs.max} inputs, not ${String(raw.inputs)}.`, { node: id });
      }
    }
    if (raw.type === "start") { starts++; if (starts > 1) err("A TSA has exactly one Start; remove this one.", { node: id }); }
    byId.set(id, { ...(raw as unknown as TsaNode), params: isObj(raw.params) ? raw.params : {} });
  }
  if (starts === 0) err("A TSA needs a Start (where the call enters).");

  const edgeIds = new Set<string>();
  const usedFlowOut = new Set<string>();
  const usedDataIn = new Set<string>();
  for (const raw of edges) {
    if (!isObj(raw)) { err("An edge is not an object."); continue; }
    const id = typeof raw.id === "string" && raw.id.length >= 1 && raw.id.length <= 64 ? raw.id : null;
    if (!id) { err("An edge has no valid id (1–64 characters)."); continue; }
    if (edgeIds.has(id)) { err(`Two edges have the id "${id}".`, { edge: id }); continue; }
    edgeIds.add(id);
    const from = raw.from, to = raw.to;
    if (!isObj(from) || !isObj(to) || typeof from.node !== "string" || typeof from.port !== "string" || typeof to.node !== "string" || typeof to.port !== "string") { err(`Edge "${id}": from and to must name a node and a port.`, { edge: id }); continue; }
    if (raw.kind !== "flow" && raw.kind !== "data") { err(`Edge "${id}": kind must be "flow" or "data".`, { edge: id }); continue; }
    const a = byId.get(from.node), b = byId.get(to.node);
    if (!a) { err(`Edge "${id}" starts at a node that does not exist ("${from.node.slice(0, 40)}").`, { edge: id }); continue; }
    if (!b) { err(`Edge "${id}" ends at a node that does not exist ("${to.node.slice(0, 40)}").`, { edge: id }); continue; }
    const ta = toolOf(a.type)!, tb = toolOf(b.type)!;
    if (raw.kind === "flow") {
      const outs = flowOutputs(a.type, a.params).map((p) => p.port);
      if (!outs.includes(from.port)) { err(`Edge "${id}": ${ta.label} "${a.id}" has no control output "${from.port}"${outs.length ? ` (it has ${outs.join(", ")})` : ""}.`, { edge: id, node: a.id, port: from.port }); continue; }
      if (to.port !== "in" || !tb.flowIn) { err(`Edge "${id}": control goes into a node's "in"${tb.flowIn ? "" : ` — ${tb.label} has none`}.`, { edge: id, node: b.id, port: to.port }); continue; }
      const k = key(a.id, from.port);
      if (usedFlowOut.has(k)) { err(`"${a.id}".${from.port} already leads somewhere: one edge per control output.`, { edge: id, node: a.id, port: from.port }); continue; }
      usedFlowOut.add(k);
    } else {
      const outs = (ta.dataOut ?? []).map((p) => p.port);
      if (!outs.includes(from.port)) { err(`Edge "${id}": ${ta.label} "${a.id}" has no data output "${from.port}"${outs.length ? ` (it has ${outs.join(", ")})` : ""}.`, { edge: id, node: a.id, port: from.port }); continue; }
      const ins = dataInputs(b.type, b.inputs).map((p) => p.port);
      if (!ins.includes(to.port)) { err(`Edge "${id}": ${tb.label} "${b.id}" has no data input "${to.port}"${ins.length ? ` (it has ${ins.join(", ")})` : ""}.`, { edge: id, node: b.id, port: to.port }); continue; }
      const k = key(b.id, to.port);
      if (usedDataIn.has(k)) { err(`"${b.id}".${to.port} already has a value connected: one edge per data input.`, { edge: id, node: b.id, port: to.port }); continue; }
      usedDataIn.add(k);
    }
  }
  return out;
}

/* ------------------------------------------------------------- parameters */

const KEYS = ["#", "*", "none", "any"];
const DIGITS = /^[0-9*#A-Dw]*$/;
const TIME = /^([01]?\d|2[0-3]):[0-5]\d$/;
const DATE = /^(\d{4}-)?(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const VAR_NAME = /^\$?[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const DAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** "mon-fri", "sat", "mon,wed,fri", "fri-mon" → weekdays 1 (Mon) … 7 (Sun); null when it does not parse. */
export function parseDays(spec: string): Set<number> | null {
  const out = new Set<number>();
  const s = spec.trim().toLowerCase();
  if (!s) return null;
  for (const part of s.split(/\s*,\s*/)) {
    const m = /^([a-z]{3})(?:\s*-\s*([a-z]{3}))?$/.exec(part);
    if (!m) return null;
    const a = DAY_NAMES.indexOf(m[1]), b = m[2] ? DAY_NAMES.indexOf(m[2]) : a;
    if (a < 0 || b < 0) return null;
    for (let i = a; ; i = (i + 1) % 7) { out.add(i + 1); if (i === b) break; }
  }
  return out;
}

/** Is a parameter shown / in force, given its `when`? */
export function paramActive(def: TsaParamDef, params: Record<string, unknown>, tool: TsaToolDef): boolean {
  if (!def.when) return true;
  for (const [k, want] of Object.entries(def.when)) {
    const cur = params[k] !== undefined ? params[k] : tool.params.find((p) => p.key === k)?.default;
    if (Array.isArray(want) ? !want.includes(cur) : cur !== want) return false;
  }
  return true;
}

const empty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.every((x) => String(x ?? "").trim() === ""));

/** A host the HTTP tool may reach: "api.example.com" exactly, "*.example.com" any subdomain. */
export function hostAllowed(host: string, allow: string[]): boolean {
  const h = host.toLowerCase();
  return allow.some((p) => {
    const a = String(p).trim().toLowerCase();
    if (!a) return false;
    if (a.startsWith("*.")) return h.endsWith(a.slice(1)) && h.length > a.length - 1;
    return h === a;
  });
}

function checkParams(node: TsaNode, tool: TsaToolDef, ix: GraphIndex, opts: ValidateOptions, out: TsaProblem[]): void {
  const p = node.params ?? {};
  const add = (level: TsaProblem["level"], message: string) => out.push({ level, message: `${node.label || tool.label} "${node.id}": ${message}`, node: node.id });
  const count = dynamicCount(node);
  const usedInputs = new Set<number>();
  const notePlaceholders = (label: string, v: string, allowSecrets: boolean) => {
    const r = templateRefs(v);
    for (const n of r.inputs) {
      if (n > count) add("warning", `${label} uses {IN${n}} but the node has ${count} input${count === 1 ? "" : "s"} — it is always empty.`);
      else usedInputs.add(n);
    }
    if (r.secrets.length && !allowSecrets) add("warning", `${label}: {secret:…} is only filled in in HTTP headers.`);
  };

  for (const def of tool.params) {
    const active = paramActive(def, p, tool);
    const v = p[def.key] !== undefined ? p[def.key] : def.default;
    if (!active) continue;
    if (def.required && empty(v)) { add("error", `"${def.label}" is required.`); continue; }
    if (v === undefined || v === null || v === "") continue;
    switch (def.kind) {
      case "number": {
        if (typeof v !== "number" || !Number.isFinite(v)) { add("error", `"${def.label}" must be a number.`); break; }
        if (def.min !== undefined && v < def.min) add("error", `"${def.label}" is at least ${def.min}.`);
        if (def.max !== undefined && v > def.max) add("error", `"${def.label}" is at most ${def.max}.`);
        break;
      }
      case "bool": if (typeof v !== "boolean") add("error", `"${def.label}" must be on or off.`); break;
      case "select": if (!def.options?.some((o) => o.value === v)) add("error", `"${def.label}": "${String(v).slice(0, 40)}" is not one of ${def.options?.map((o) => o.value || "(empty)").join(", ")}.`); break;
      case "key": if (!KEYS.includes(String(v))) add("error", `"${def.label}" is one of # * none any.`); break;
      case "digits": {
        if (typeof v !== "string") { add("error", `"${def.label}" must be text.`); break; }
        if (!DIGITS.test(withoutPlaceholders(v).replace(/\s+/g, ""))) add("error", `"${def.label}": only 0-9 * # A-D and w (a pause), or {IN1}.`);
        notePlaceholders(def.label, v, false);
        break;
      }
      case "formula": {
        if (typeof v !== "string") { add("error", `"${def.label}" must be a formula.`); break; }
        const r = parseFormula(v);
        if (!r.ok) { for (const e of r.errors) add("error", `"${def.label}": ${e.message} (at character ${e.pos + 1}).`); break; }
        for (const n of formulaRefs(r.ast).inputs) {
          if (n > count) add("error", `"${def.label}" uses IN${n} but the node has ${count} input${count === 1 ? "" : "s"}.`);
          else usedInputs.add(n);
        }
        break;
      }
      case "list": {
        if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) { add("error", `"${def.label}" must be a list of texts.`); break; }
        if (v.length > 100) add("error", `"${def.label}": 100 lines at most.`);
        if (v.some((x) => (x as string).length > 500)) add("error", `"${def.label}": a line is longer than 500 characters.`);
        for (const line of v as string[]) notePlaceholders(def.label, line, node.type === "http" && def.key === "headers");
        break;
      }
      case "text": case "textarea": {
        if (typeof v !== "string") { add("error", `"${def.label}" must be text.`); break; }
        if (v.length > TSA_LIMITS.textLength) add("error", `"${def.label}" is longer than ${TSA_LIMITS.textLength} characters.`);
        notePlaceholders(def.label, v, false);
        break;
      }
      default: // voice, tsa, trunk, model: an id
        if (typeof v !== "string" || v.length > 200) add("error", `"${def.label}" must be an id (text).`);
    }
  }

  // Tool-specific rules.
  const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : String(tool.params.find((d) => d.key === k)?.default ?? ""));
  switch (node.type) {
    case "switch": {
      const cases = Array.isArray(p.cases) ? (p.cases as unknown[]).map((c) => String(c).trim()).filter(Boolean) : [];
      const seen = new Set<string>();
      for (const c of cases) { const k = c.toLowerCase(); if (seen.has(k)) add("warning", `the case "${c}" is listed twice — only the first can match.`); seen.add(k); }
      if (!dataSource(ix, node.id, "IN1")) add("warning", "IN1 (the value to compare) is not connected.");
      break;
    }
    case "set": if (typeof p.name === "string" && p.name && !VAR_NAME.test(p.name)) add("error", `the variable name "${p.name.slice(0, 40)}" must be a letter or _ then letters, digits or _ (32 at most).`); break;
    case "for": if (typeof p.step === "string" && /^\s*[+-]?0+(\.0*)?\s*$/.test(p.step)) add("warning", "a step of 0 never moves — the loop stops at its round limit."); break;
    case "time_condition": {
      if (!validTimezone(str("timezone"))) add("error", `"${str("timezone").slice(0, 40)}" is not a time zone (Europe/Prague, UTC…).`);
      if (!parseDays(str("days"))) add("error", `days "${str("days").slice(0, 40)}": mon-fri, sat, sun or a list like mon,wed,fri.`);
      if (!TIME.test(str("from"))) add("error", `"From" is a time like 08:00.`);
      if (!TIME.test(str("to")) && str("to") !== "24:00") add("error", `"To" is a time like 17:00 (or 24:00).`);
      if (Array.isArray(p.closedOn)) for (const d of p.closedOn as unknown[]) if (String(d).trim() && !DATE.test(String(d).trim())) add("error", `"${String(d).slice(0, 20)}" is not a date (2026-12-24, or 12-25 for every year).`);
      break;
    }
    case "http": {
      const url = str("url");
      if (url) {
        const lit = withoutPlaceholders(url);
        if (/^http:\/\//i.test(lit)) add("error", "only https:// addresses.");
        else if (!/^https:\/\//i.test(url)) add(hasPlaceholders(url) && url.startsWith("{") ? "warning" : "error", url.startsWith("{") ? "the URL must turn out to be https://… when it runs." : "the URL must start with https://.");
        else if (opts.httpHosts) {
          const host = /^https:\/\/([^/:?#{}]+)/i.exec(url)?.[1];
          if (opts.httpHosts.length === 0) add("warning", "the HTTP tool is off: no host is allowed (Telephony › Permissions › TSA).");
          else if (host && !hostAllowed(host, opts.httpHosts)) add("warning", `${host} is not among the hosts the permissions allow — the request will be refused.`);
        }
      }
      if (Array.isArray(p.headers)) for (const h of p.headers as unknown[]) if (String(h).trim() && !/^[A-Za-z0-9-]{1,64}\s*:/.test(String(h))) add("error", `header "${String(h).slice(0, 40)}" is not "Name: value".`);
      break;
    }
    case "dial": {
      const to = str("to").trim();
      if (to && !hasPlaceholders(to)) {
        if (str("kind") === "sip" ? !/^sip:[^\s@]+@[^\s@]+$/i.test(to) : !/^\+[1-9]\d{6,14}$/.test(to)) add("error", str("kind") === "sip" ? `"${to.slice(0, 40)}" is not a SIP URI (sip:user@host).` : `"${to.slice(0, 40)}" is not an E.164 number (+420…).`);
      }
      if (str("via") === "trunk" && !str("trunk")) add("error", "pick the SIP trunk to dial through.");
      break;
    }
    case "play": {
      const source = str("source");
      if (source === "file") { if (!str("file")) add("error", "pick the uploaded file to play."); }
      else {
        const url = str("url");
        if (!url) add("error", source === "stream" ? "the stream's URL is required." : "the URL is required.");
        else if (/^http:\/\//i.test(withoutPlaceholders(url))) add("error", "only https:// addresses (the provider fetches it).");
        else if (!/^https:\/\//i.test(url) && !url.startsWith("{")) add("error", "the URL must start with https://.");
      }
      break;
    }
    case "room_message": {
      if (str("target") === "room" && !str("room").trim()) add("error", "the room (its blind id, r3.…) is required.");
      if (str("target") === "inroute" && !dataSource(ix, node.id, "IN1")) add("warning", "IN1 (the inroute code) is not connected.");
      break;
    }
    case "inroute_add": {
      if (str("type") === "user" && !str("user").trim()) add("error", "the member to route to is required.");
      const code = str("code").trim();
      if (code && !hasPlaceholders(code) && !/^\d{4,6}$/.test(code)) add("error", "a code is 4–6 digits (or empty for a random one).");
      break;
    }
    case "route_audio": if (!dataSource(ix, node.id, "KEY")) add("warning", "KEY (the route code) is not connected — every call ends in on_code_error."); break;
    case "lookup": break;
  }

  for (const n of usedInputs) if (!dataSource(ix, node.id, `IN${n}`)) add("warning", `IN${n} is used but nothing is connected to it (it is empty).`);
}

/* ------------------------------------------------------------- the flow */

/** Tools that hand the call to the caller / provider (a cycle through one of them is not a runaway). */
const WAITS = new Set(["tts", "play", "pause", "send_dtmf", "read_dtmf", "record", "stt", "dial", "route_audio"]);

function reach(from: string[], ix: GraphIndex, stopAt?: string): Set<string> {
  const seen = new Set<string>();
  const queue = [...from];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id) || id === stopAt) continue;
    const n = ix.nodes.get(id);
    if (!n) continue;
    seen.add(id);
    for (const port of flowOutputs(n.type, n.params)) {
      const t = flowTarget(ix, id, port.port);
      if (t && !seen.has(t)) queue.push(t);
    }
  }
  return seen;
}

export type ValidateOptions = {
  /** The HTTP tool's allowlist (telPermissions().tsa.httpHosts); undefined: not checked. */
  httpHosts?: string[];
};

/** Everything: the shape, the parameters and the flow. */
export function validateGraph(graph: unknown, opts: ValidateOptions = {}): TsaProblem[] {
  const out = validateStructure(graph);
  if (!isObj(graph) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || graph.nodes.length > TSA_LIMITS.nodes || graph.edges.length > TSA_LIMITS.edges) return out;
  const g = graph as unknown as TsaGraph;
  const valid = g.nodes.filter((n) => n && typeof n === "object" && typeof n.id === "string" && NODE_ID.test(n.id) && isTsaNodeType(n.type));
  const ix = indexGraph({ nodes: valid.map((n) => ({ ...n, params: n.params && typeof n.params === "object" ? n.params : {} })), edges: g.edges.filter((e) => e && typeof e === "object" && e.from && e.to) });

  for (const n of ix.nodes.values()) checkParams(n, toolOf(n.type)!, ix, opts, out);

  if (!ix.start) return out;
  const reachable = reach([ix.start.id], ix);
  for (const n of ix.nodes.values()) {
    if (!reachable.has(n.id)) out.push({ level: "warning", message: `${n.label || toolOf(n.type)!.label} "${n.id}" can never run (no path from Start).`, node: n.id });
  }

  // Loop bodies: a path that ends there goes back to its loop.
  const inLoop = new Set<string>();
  for (const n of ix.nodes.values()) {
    if (n.type !== "for" && n.type !== "while") continue;
    const body = flowTarget(ix, n.id, "body");
    if (body) for (const id of reach([body], ix, n.id)) inLoop.add(id);
  }

  for (const id of reachable) {
    const n = ix.nodes.get(id)!;
    const tool = toolOf(n.type)!;
    if (n.type === "break") {
      if (!inLoop.has(id)) out.push({ level: "warning", message: `Break "${id}" is not inside a loop's body — the flow ends there.`, node: id });
      continue;
    }
    if (n.type === "hangup" || inLoop.has(id)) continue;
    const open = flowOutputs(n.type, n.params).map((p) => p.port).filter((port) => !flowTarget(ix, id, port));
    if (open.length) out.push({ level: "warning", message: `${n.label || tool.label} "${id}": ${open.join(", ")} lead${open.length === 1 ? "s" : ""} nowhere — the call hangs up there.`, node: id, port: open[0] });
  }

  // Cycles with nothing that waits: they run into the step limit.
  const reachOf = new Map<string, Set<string>>();
  for (const id of reachable) {
    const n = ix.nodes.get(id)!;
    const next = flowOutputs(n.type, n.params).map((p) => flowTarget(ix, id, p.port)).filter((t): t is string => Boolean(t));
    reachOf.set(id, reach(next, ix));
  }
  const reported = new Set<string>();
  for (const id of reachable) {
    if (reported.has(id) || !reachOf.get(id)!.has(id)) continue;
    const scc = [...reachable].filter((v) => reachOf.get(id)!.has(v) && reachOf.get(v)!.has(id));
    scc.forEach((v) => reported.add(v));
    if (!scc.some((v) => WAITS.has(ix.nodes.get(v)!.type))) {
      out.push({ level: "warning", message: `${scc.map((v) => `"${v}"`).join(" → ")} form a cycle with nothing that waits for the caller — it stops at the step limit (${TSA_LIMITS.stepsPerTurn} steps) and ends the call.`, node: scc[0] });
    }
  }
  return out;
}

export const hasErrors = (problems: TsaProblem[]): boolean => problems.some((p) => p.level === "error");
