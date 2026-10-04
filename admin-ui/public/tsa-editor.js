// M5cet operator console — the TSA editor (6.9): a full-screen visual editor of
// Telephony & SIP Applications. A TSA is a graph of tools (the palette comes
// from GET /admin/telephony/tsa/catalog — server/telephony/tsa/catalog.ts)
// wired port to port (server/telephony/tsa/types.ts):
//
//   flow in      "in" on the node's left (any number of wires arrive)
//   flow out     named outputs along the bottom (next, on_true / on_false,
//                on_success / on_code_error / on_failed, case_<n>…) — ONE wire each
//   data in      on the top edge: IN1 … IN<n> (+ / − on tools with dynamic
//                inputs) and fixed ones (route_audio's KEY) — ONE wire each
//   data out     on the right edge (any number of wires leave)
//
//   top bar      name, description, draft / published state, Save draft,
//                Validate, Publish, Simulate, Export, Undo / Redo
//   palette      the catalog's groups; drag a tool onto the canvas or click it
//   canvas       pan (drag the background, wheel), zoom (Ctrl/⌘ + wheel),
//                Shift+drag selects, drag a port to wire it (or click one
//                port, then another), minimap, arrange
//   inspector    the selected tool's label, note and parameters (per kind,
//                with `when` visibility and help); the TSA's own settings
//   problems     POST …/validate, live and debounced; badges on the nodes
//   simulator    a phone: what the caller hears, a keypad, speech, the trace
//
// Keys: Delete, Ctrl/⌘+Z / Y, C / V (copy / paste), D (duplicate), A (fit),
// arrows (nudge), Ctrl/⌘+S (save), Ctrl/⌘+A (select all), Esc, ? (help).
//
// Same rules as console.js: DOM nodes and textContent, never markup strings.
// Public: window.M5TsaEditor = { open(id, { onClose }) → Promise<editor> }.

(() => {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const GRID = 10;
  const LS_DRAFT = "m5cet:tsa-draft:";
  const LS_CLIP = "m5cet:tsa-clipboard";
  /** Timings (tests shorten them). */
  const CFG = { validateDelay: 450, autosaveDelay: 600 };
  const NODE_ID = /^[a-z][a-z0-9_]{0,31}$/;
  const DEFAULT_LIMITS = { nodes: 300, edges: 900, dynamicInputs: 100, textLength: 4000, formulaLength: 1000 };

  /* ================================================================ DOM */

  const C = () => window.M5Console || {};

  /** Builds an element (the console's h(): attributes, on* listeners, children). */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") el.className = value;
      else if (key === "text") el.textContent = value;
      else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
      else if (key === "dataset") Object.assign(el.dataset, value);
      else if (key === "style" && typeof value === "object") Object.assign(el.style, value);
      else el.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of children.flat(Infinity)) {
      if (child === undefined || child === null || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }
  /** An SVG element. */
  function s(tag, attrs, ...children) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null && v !== false) el.setAttribute(k, String(v));
    for (const c of children.flat(Infinity)) if (c) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
  }
  const clear = (el) => { while (el && el.firstChild) el.firstChild.remove(); return el; };
  function icon(name, cls = "ico") {
    if (window.M5TsaIcons) return window.M5TsaIcons.svg(name, cls);
    if (C().icon) return C().icon(name, cls);
    return h("span", { class: cls, "aria-hidden": "true" });
  }
  const toast = (message, tone) => { const c = C(); if (c.toast) c.toast(message, tone); };
  const api = (path, opts) => {
    const c = C();
    if (!c.api) return Promise.reject(new Error("The console is not signed in."));
    return c.api(path, opts);
  };
  const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const snapTo = (v) => Math.round(v / GRID) * GRID;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;
  const isTyping = (t) => Boolean(t && (t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable || (t.tagName === "INPUT" && !["checkbox", "radio", "button", "range"].includes(t.type))));
  const enc = encodeURIComponent;
  const pad2 = (n) => String(n).padStart(2, "0");
  const clock = (t) => { const d = new Date(t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
  const when = (t) => { if (!t) return "—"; const d = new Date(t); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
  const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
  const lsDel = (k) => { try { localStorage.removeItem(k); } catch { /* storage blocked */ } };

  /* ============================================================== model */
  // The catalog's helpers (catalog.ts: flowOutputs, dataInputs, defaultParams)
  // over the palette the API answered — the editor never hard-codes a tool.

  let TOOLS = new Map();
  let LIMITS = { ...DEFAULT_LIMITS };

  const toolOf = (type) => TOOLS.get(type);
  function flowOutputs(n) {
    const t = toolOf(n.type);
    if (!t) return [];
    if (!t.dynamicFlowOut) return t.flowOut || [];
    const raw = n.params ? n.params[t.dynamicFlowOut.param] : undefined;
    const cases = Array.isArray(raw) ? raw.map(String).filter((c) => c.trim() !== "") : [];
    return [...cases.map((c, i) => ({ port: `${t.dynamicFlowOut.prefix}${i + 1}`, label: c })), ...(t.dynamicFlowOut.plus || [])];
  }
  function inputCount(n) {
    const t = toolOf(n.type);
    const d = t && t.dynamicInputs;
    if (!d) return 0;
    const v = typeof n.inputs === "number" ? n.inputs : d.initial;
    return clamp(Math.round(v), d.min, Math.min(d.max, LIMITS.dynamicInputs || 100));
  }
  function dataInputs(n) {
    const t = toolOf(n.type);
    if (!t) return [];
    const dyn = Array.from({ length: inputCount(n) }, (_, i) => ({ port: `IN${i + 1}`, label: `IN${i + 1}`, dynamic: true }));
    return [...dyn, ...(t.dataIn || [])];
  }
  const dataOutputs = (n) => ((toolOf(n.type) || {}).dataOut || []);
  const hasFlowIn = (n) => Boolean((toolOf(n.type) || {}).flowIn);
  function defaultParams(type) {
    const out = {};
    for (const p of (toolOf(type) || {}).params || []) if (p.default !== undefined) out[p.key] = clone(p.default);
    return out;
  }
  function paramVal(n, p) {
    const v = n.params ? n.params[p.key] : undefined;
    return v === undefined ? p.default : v;
  }
  /** A parameter's `when`: shown only while the other parameters have those values. */
  function paramVisible(n, p) {
    if (!p.when) return true;
    const t = toolOf(n.type);
    for (const [k, want] of Object.entries(p.when)) {
      const def = t && (t.params || []).find((x) => x.key === k);
      const v = def ? paramVal(n, def) : (n.params || {})[k];
      if (Array.isArray(want) ? !want.some((w) => w === v) : want !== v) return false;
    }
    return true;
  }
  /** What a port is on a node: fin (flow in), fout, din (data in), dout — or null. */
  function portKind(n, port) {
    if (!n) return null;
    if (port === "in" && hasFlowIn(n)) return "fin";
    if (flowOutputs(n).some((p) => p.port === port)) return "fout";
    if (dataInputs(n).some((p) => p.port === port)) return "din";
    if (dataOutputs(n).some((p) => p.port === port)) return "dout";
    return null;
  }
  const isOut = (k) => k === "fout" || k === "dout";
  const KIND_WORD = { fin: "flow input", fout: "flow output", din: "data input", dout: "data output" };

  /** Can `a` be wired to `b` (either order)? { ok, kind, from, to, replaces } or { ok: false, reason }. */
  function checkConnect(g, a, b) {
    const na = g.nodes.find((n) => n.id === a.node), nb = g.nodes.find((n) => n.id === b.node);
    if (!na || !nb) return { ok: false, reason: "That node is gone." };
    let ka = portKind(na, a.port), kb = portKind(nb, b.port);
    if (!ka || !kb) return { ok: false, reason: "That port is gone." };
    let from = { node: a.node, port: a.port }, to = { node: b.node, port: b.port };
    if (!isOut(ka) && isOut(kb)) { [from, to] = [to, from]; [ka, kb] = [kb, ka]; }
    if (isOut(ka) && isOut(kb)) return { ok: false, reason: "Two outputs cannot be wired together — wire an output to an input." };
    if (!isOut(ka) && !isOut(kb)) return { ok: false, reason: "Two inputs cannot be wired together — wire an output to an input." };
    const same = (e) => e.from.node === from.node && e.from.port === from.port && e.to.node === to.node && e.to.port === to.port;
    if (ka === "fout" && kb === "fin") {
      if (g.edges.some(same)) return { ok: false, reason: "These ports are already wired.", same: true };
      const replaces = g.edges.filter((e) => e.kind === "flow" && e.from.node === from.node && e.from.port === from.port);
      if (g.edges.length - replaces.length >= LIMITS.edges) return { ok: false, reason: `A TSA has at most ${LIMITS.edges} wires.` };
      return { ok: true, kind: "flow", from, to, replaces };
    }
    if (ka === "dout" && kb === "din") {
      if (from.node === to.node) return { ok: false, reason: "A tool cannot feed its own input." };
      if (g.edges.some(same)) return { ok: false, reason: "These ports are already wired.", same: true };
      const replaces = g.edges.filter((e) => e.to.node === to.node && e.to.port === to.port);
      if (g.edges.length - replaces.length >= LIMITS.edges) return { ok: false, reason: `A TSA has at most ${LIMITS.edges} wires.` };
      return { ok: true, kind: "data", from, to, replaces };
    }
    if (ka === "fout") return { ok: false, reason: `A flow output (${from.port}) leads to the next tool's flow input “in” on its left — not to the ${KIND_WORD[kb]} ${to.port}.` };
    return { ok: false, reason: `A data output (${from.port}) feeds a data input on a tool's top edge (IN1…, KEY) — not the ${KIND_WORD[kb]} “${to.port}”.` };
  }

  /** The graph exactly as the contract stores it (types.ts TsaGraph) — no editor state. */
  function serializeGraph(g) {
    return {
      nodes: g.nodes.map((n) => {
        const t = toolOf(n.type);
        const o = { id: n.id, type: n.type, x: Math.round(Number(n.x) || 0), y: Math.round(Number(n.y) || 0) };
        if (typeof n.w === "number" && n.w > 0) o.w = Math.round(n.w);
        if (typeof n.label === "string" && n.label.trim()) o.label = n.label.trim();
        if (typeof n.note === "string" && n.note.trim()) o.note = n.note;
        if (t ? t.dynamicInputs : typeof n.inputs === "number") o.inputs = t ? inputCount(n) : n.inputs;
        const params = {};
        for (const [k, v] of Object.entries(n.params || {})) if (v !== undefined) params[k] = clone(v);
        o.params = params;
        return o;
      }),
      edges: g.edges.map((e) => ({ id: e.id, from: { node: e.from.node, port: e.from.port }, to: { node: e.to.node, port: e.to.port }, kind: e.kind })),
    };
  }

  /* ========================================================== geometry */
  // Every size and port position is computed (not measured), so wires, hit
  // tests, the minimap and fit work the same in a test DOM without layout.

  const HEAD = 34, SUB = 22, TOPZ = 20, ROW = 18, BOTZ = 22, PADB = 8;
  function geo(n) {
    const t = toolOf(n.type) || {};
    const shape = t.shape || "box";
    const ins = dataInputs(n), outs = flowOutputs(n), douts = dataOutputs(n);
    const base = shape === "wide" ? 380 : shape === "pill" ? 180 : 230;
    const longOut = outs.reduce((m, p) => Math.max(m, String(p.label || p.port).length), 0);
    const slot = clamp(longOut * 6.4 + 22, 56, 130);
    const longDout = douts.reduce((m, p) => Math.max(m, String(p.label || p.port).length), 0);
    const need = Math.max(ins.length * 38 + 30, outs.length * slot + 16, longDout * 6.4 + 120);
    let w = Math.max(base, need);
    if (typeof n.w === "number" && n.w > 0 && shape === "wide") w = Math.max(need, n.w);
    w = Math.ceil(w / GRID) * GRID;
    const top = ins.length ? TOPZ : 0;
    const hh = top + HEAD + SUB + douts.length * ROW + (outs.length ? BOTZ : 0) + PADB;
    const ports = {
      fin: t.flowIn ? { port: "in", label: "in", x: 0, y: top + HEAD / 2 } : null,
      din: ins.map((p, i) => ({ ...p, x: Math.round((w * (i + 1)) / (ins.length + 1)), y: 0 })),
      fout: outs.map((p, j) => ({ ...p, x: Math.round((w * (j + 1)) / (outs.length + 1)), y: hh })),
      dout: douts.map((p, k) => ({ ...p, x: w, y: top + HEAD + SUB + ROW / 2 + k * ROW })),
    };
    return { w, h: hh, shape, top, ports };
  }
  function portPos(n, port) {
    const g = geo(n);
    const kind = portKind(n, port);
    if (kind === "fin") return { x: n.x, y: n.y + g.ports.fin.y, kind };
    const list = kind ? g.ports[kind] : [];
    const p = list.find((x) => x.port === port);
    return p ? { x: n.x + p.x, y: n.y + p.y, kind } : null;
  }
  /** A wire's path: flow leaves downward and enters from the left; data leaves right and enters from above. */
  function wirePath(a, b, kind) {
    if (kind === "flow") {
      const dy = Math.max(36, Math.abs(b.y - a.y) * 0.5), dx = Math.max(36, Math.abs(b.x - a.x) * 0.4);
      return `M ${a.x} ${a.y} C ${a.x} ${a.y + dy}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
    }
    const dx = Math.max(36, Math.abs(b.x - a.x) * 0.45), dy = Math.max(36, Math.abs(b.y - a.y) * 0.5);
    return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x} ${b.y - dy}, ${b.x} ${b.y}`;
  }
  /** Flow outputs' colours: success-like, warning-like, failure. */
  function portTone(port) {
    if (/^(on_true|on_success|on_answered|body)$/.test(port)) return "ok";
    if (/^(on_failed)$/.test(port)) return "err";
    if (/^(on_false|on_timeout|on_busy|on_no_answer|on_code_error)$/.test(port)) return "warn";
    return "flow";
  }

  /** One line under a node's header: what its parameters say. */
  function subtitle(n) {
    const p = (k) => { const def = ((toolOf(n.type) || {}).params || []).find((x) => x.key === k); return def ? paramVal(n, def) : (n.params || {})[k]; };
    const str = (v) => (v === undefined || v === null ? "" : Array.isArray(v) ? v.join(", ") : String(v));
    const one = (v) => str(v).replace(/\s*\n\s*/g, " ⏎ ");
    switch (n.type) {
      case "start": return `${p("answer") === false ? "early media" : "answer"} · ${str(p("language"))}`;
      case "hangup": return `as ${str(p("as")) || "hangup"}`;
      case "dial": return `${one(p("to")) || "?"} · via ${str(p("via"))}${p("via") === "trunk" && p("trunk") ? " " + str(p("trunk")) : ""}`;
      case "pause": return `${str(p("seconds"))} s`;
      case "send_dtmf": return `${one(p("digits")) || "?"} · ${str(p("type"))}`;
      case "tts": return `“${one(p("text"))}”`;
      case "play": return `${str(p("source"))}: ${one(p("source") === "file" ? p("file") : p("url")) || "?"}`;
      case "record": return `max ${str(p("maxSeconds"))} s · ends ${str(p("finishOnKey"))}${p("transcribe") ? " · transcribe" : ""}`;
      case "stt": return `${str(p("provider"))} · ${str(p("language")) || "start's language"}`;
      case "route_audio": return `KEY → inroute${p("consume") ? " · one use" : ""}`;
      case "read_dtmf": return `max ${str(p("maxDigits"))} · ${str(p("finishOnKey"))} ends · ${str(p("timeout"))} s`;
      case "condition": case "while": case "formula": return one(p("formula"));
      case "switch": return `${str(p("match"))}: ${one(p("cases"))}`;
      case "for": return `${one(p("from"))} … ${one(p("to"))} step ${one(p("step"))}`;
      case "set": return `$${str(p("name")) || "?"} = ${one(p("value"))}`;
      case "text": return `“${one(p("template"))}”`;
      case "time_condition": return `${str(p("days"))} ${str(p("from"))}–${str(p("to"))}`;
      case "sms": return `→ ${one(p("to"))}: ${one(p("text"))}`;
      case "room_message": return one(p("text"));
      case "http": return `${str(p("method"))} ${one(p("url"))}`;
      case "function": return str(p("model")) || "(no model)";
      case "inroute_add": return `${str(p("type"))} ${str(p("room")) || "?"}`;
      case "log": return `${str(p("level"))}: ${one(p("text"))}`;
      default: {
        const t = toolOf(n.type);
        const first = t && (t.params || []).find((x) => ["text", "select", "formula", "textarea"].includes(x.kind));
        return first ? one(paramVal(n, first)) : "";
      }
    }
  }

  /** Quick checks while typing (the server's /validate has the last word). */
  function checkFormula(src, n, required) {
    const text = String(src ?? "");
    if (!text.trim()) return required ? { level: "error", message: "Required." } : null;
    if (text.length > (LIMITS.formulaLength || 1000)) return { level: "error", message: `Longer than ${LIMITS.formulaLength} characters.` };
    let depth = 0, q = null;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === "\\") { i++; continue; } if (c === q) q = null; continue; }
      if (c === '"' || c === "'") q = c;
      else if (c === "(") depth++;
      else if (c === ")") { depth--; if (depth < 0) return { level: "error", message: "A “)” without its “(”." }; }
    }
    if (q) return { level: "error", message: "A text in quotes is not closed." };
    if (depth > 0) return { level: "error", message: `${plural(depth, "“(”")} not closed.` };
    const bad = refsOutside(text, n, /\bIN(\d{1,3})\b/g);
    if (bad) return { level: "warning", message: bad };
    const bare = text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "");
    if (/(^|[^=!<>])=($|[^=])/.test(bare)) return { level: "warning", message: "Use == to compare — a single = is not an operator here." };
    return null;
  }
  function checkTemplate(src, n) {
    const text = String(src ?? "");
    if (text.length > (LIMITS.textLength || 4000)) return { level: "error", message: `Longer than ${LIMITS.textLength} characters.` };
    const bad = refsOutside(text, n, /\{IN(\d{1,3})\}/g);
    return bad ? { level: "warning", message: bad } : null;
  }
  function refsOutside(text, n, re) {
    const have = new Set(dataInputs(n).map((p) => p.port));
    for (const m of text.matchAll(re)) {
      if (!have.has(`IN${m[1]}`)) {
        const dyn = inputCount(n);
        return `IN${m[1]} is not an input of this tool — ${dyn ? `it has IN1${dyn > 1 ? ` … IN${dyn}` : ""}` : "it has no IN inputs"}${toolOf(n.type) && toolOf(n.type).dynamicInputs ? " (add more with +)" : ""}.`;
      }
    }
    return null;
  }

  /* ============================================================== state */

  /** The open editor (one at a time), or null. */
  let S = null;
  /** Copied tools (also kept in local storage, so they paste into another TSA). */
  let clipboard = null;

  const byId = (id) => S.graph.nodes.find((n) => n.id === id);
  const nodeMap = () => new Map(S.graph.nodes.map((n) => [n.id, n]));
  const edgeInto = (node, port) => S.graph.edges.find((e) => e.to.node === node && e.to.port === port);
  const edgeFrom = (node, port) => S.graph.edges.find((e) => e.from.node === node && e.from.port === port);
  const titleOf = (n) => (n ? n.label || (toolOf(n.type) ? toolOf(n.type).label : n.type) : "?");
  const describeEdge = (e) => `${e.from.node}.${e.from.port} → ${e.to.node}.${e.to.port}`;

  /** May the signed-in administrator do this (Modules & groups › Telephony & SIP rights)? */
  function may(right) {
    const c = C();
    if (c.can && !c.can("operator")) return false;
    const acc = c.moduleAccess ? c.moduleAccess("telephony") : null;
    if (!acc) return true;
    if (!acc.allowed) return false;
    if (!acc.rights) return true;
    return acc.rights.some((r) => r === "*" || r === right);
  }

  function newNodeId(type) {
    let base = String(type).toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 26);
    if (!NODE_ID.test(base)) base = "n";
    const used = new Set(S.graph.nodes.map((n) => n.id));
    if (base === "start" && !used.has("start")) return "start";
    for (let k = 1; ; k++) if (!used.has(`${base}_${k}`)) return `${base}_${k}`;
  }
  function newEdgeId() {
    let max = 0;
    for (const e of S.graph.edges) { const m = /^e(\d+)$/.exec(e.id); if (m) max = Math.max(max, Number(m[1])); }
    const used = new Set(S.graph.edges.map((e) => e.id));
    let k = max + 1;
    while (used.has(`e${k}`)) k++;
    return `e${k}`;
  }

  /* ============================================================ history */

  const stateJson = () => JSON.stringify({ g: S.graph, name: S.name, description: S.description, tags: S.tags });
  const currentJson = () => JSON.stringify({ name: S.name, description: S.description, tags: S.tags, graph: serializeGraph(S.graph) });
  const isDirty = () => Boolean(S) && currentJson() !== S.savedJson;

  /** One undo step — a tag merges the steps of one gesture (typing into one field, a burst of nudges). */
  function snapshot(tag) {
    const now = Date.now();
    if (tag && tag === S.histTag && (tag !== "nudge" || now - S.histAt < 1500)) { S.histAt = now; return; }
    S.histTag = tag || null;
    S.histAt = now;
    S.undo.push(stateJson());
    if (S.undo.length > 200) S.undo.shift();
    S.redo = [];
  }
  function restoreState(json) {
    const o = JSON.parse(json);
    S.graph = o.g; S.name = o.name; S.description = o.description; S.tags = o.tags;
    for (const id of [...S.sel.nodes]) if (!byId(id)) S.sel.nodes.delete(id);
    if (S.sel.edge && !S.graph.edges.some((e) => e.id === S.sel.edge)) S.sel.edge = null;
    S.histTag = null;
    drawTop(); drawAll(); drawSide(); changed();
  }
  function undo() { if (!S.undo.length) return false; S.redo.push(stateJson()); restoreState(S.undo.pop()); return true; }
  function redo() { if (!S.redo.length) return false; S.undo.push(stateJson()); restoreState(S.redo.pop()); return true; }

  /* ======================================================= open / close */

  async function open(id, opts = {}) {
    if (S && !(await closeEditor())) return null;
    const root = h("div", { class: "tsa", role: "dialog", "aria-modal": "true", "aria-label": "TSA editor", "data-testid": "tsa-editor" },
      h("div", { class: "tsa-loading", role: "status" }, h("span", { class: "tsa-spin", "aria-hidden": "true" }), "Loading the TSA…"));
    document.body.append(root);
    document.documentElement.classList.add("tsa-open");
    let cat, tsa;
    try {
      const [c, t] = await Promise.all([api("/admin/telephony/tsa/catalog"), api(`/admin/telephony/tsa/${enc(id)}`)]);
      cat = c;
      tsa = t && t.tsa ? t.tsa : t;
      if (!cat || !Array.isArray(cat.tools)) throw new Error("The palette (GET /admin/telephony/tsa/catalog) did not load.");
      if (!tsa || !tsa.graph) throw new Error(`There is no TSA “${id}”.`);
    } catch (err) {
      clear(root);
      const done = () => { root.remove(); document.documentElement.classList.remove("tsa-open"); if (opts.onClose) opts.onClose({ id, saved: false, published: false, error: err.message }); };
      root.append(h("div", { class: "tsa-fail", role: "alert" }, icon("circle-alert", "ico tsa-fail__ico"), h("strong", {}, "The editor cannot open"), h("p", { class: "muted" }, err.message),
        h("button", { class: "btn", type: "button", onclick: done }, "Close")));
      return null;
    }
    TOOLS = new Map(cat.tools.map((t) => [t.type, t]));
    LIMITS = { ...DEFAULT_LIMITS, ...(cat.limits || {}) };
    const graph = clone(tsa.graph);
    graph.nodes = (graph.nodes || []).map((n) => ({ ...n, params: n.params && typeof n.params === "object" ? n.params : {} }));
    graph.edges = graph.edges || [];
    S = {
      id: tsa.id || id, tsa, opts, root,
      catalog: cat, groups: Array.isArray(cat.groups) ? cat.groups : [],
      name: tsa.name || "", description: tsa.description || "", tags: Array.isArray(tsa.tags) ? [...tsa.tags] : [],
      graph, savedJson: "", undo: [], redo: [], histTag: null, histAt: 0,
      sel: { nodes: new Set(), edge: null },
      cam: { x: 80, y: 60, z: 1 },
      problems: [], probSource: "", probNote: "", checking: false, probOpen: false, vSeq: 0,
      pending: null, wire: null, mode: "pan", minimap: true, side: "inspect", space: false,
      showPalette: true, showSide: !(window.innerWidth && window.innerWidth <= 860),
      timers: {}, lookups: {}, saved: false, published: false, saving: false,
      ro: !may("tsa"), canTest: may("test"),
      sim: newSim(),
      els: { nodes: new Map() },
      listeners: [],
    };
    S.savedJson = currentJson();
    build(root);
    offerLocalCopy();
    requestAnimationFrame(() => { if (S) fit(); });
    validateNow();
    return handle();
  }

  /** Closes the editor — asking first when the draft has unsaved changes. Resolves false when the operator stays. */
  async function closeEditor(force) {
    if (!S) return true;
    if (!force && isDirty()) {
      const v = await dialog({
        title: "Unsaved changes",
        body: [h("p", {}, `“${S.name || S.id}” has changes that are not saved to the server.`), h("p", { class: "muted small" }, "A local copy stays in this browser either way, and the editor offers it the next time.")],
        buttons: [{ label: "Keep editing", value: "stay" }, { label: "Discard", value: "discard", tone: "danger" }, { label: "Save draft", value: "save", tone: "primary", disabled: S.ro }],
        cancel: "stay",
      });
      if (!S) return true;
      if (v === "stay") return false;
      if (v === "save" && !(await saveDraft())) return false;
      if (v === "discard") lsDel(LS_DRAFT + S.id);
    }
    const st = S;
    stopSim();
    for (const t of Object.values(st.timers)) clearTimeout(t);
    for (const [target, type, fn, o] of st.listeners) target.removeEventListener(type, fn, o);
    if (st.resizeObs) st.resizeObs.disconnect();
    st.root.remove();
    document.documentElement.classList.remove("tsa-open");
    S = null;
    if (st.opts.onClose) { try { st.opts.onClose({ id: st.id, saved: st.saved, published: st.published, tsa: st.tsa }); } catch (err) { console.error(err); } }
    return true;
  }

  function listen(target, type, fn, o) { target.addEventListener(type, fn, o); S.listeners.push([target, type, fn, o]); }

  /* ============================================================ dialogs */

  /** A small modal inside the editor; resolves to the chosen button's value (Esc: `cancel`). */
  function dialog({ title, body, buttons, cancel = null, wide = false }) {
    return new Promise((resolve) => {
      const host = (S && S.root) || document.body;
      const prev = document.activeElement;
      const done = (v) => { overlay.remove(); if (S) S.dialog = null; if (prev && prev.focus && prev.isConnected) prev.focus({ preventScroll: true }); resolve(v); };
      const btns = (buttons || [{ label: "OK", value: true, tone: "primary" }]).map((b) => h("button", { type: "button", class: `btn${b.tone ? " btn--" + b.tone : ""}`, disabled: b.disabled || undefined, "data-value": String(b.value), onclick: () => done(b.value) }, b.label));
      const box = h("div", { class: `tsa-dlg${wide ? " tsa-dlg--wide" : ""}`, role: "alertdialog", "aria-modal": "true", "aria-label": title },
        h("div", { class: "tsa-dlg__head" }, h("strong", {}, title), h("button", { type: "button", class: "btn btn--ghost btn--sm tsa-icon-btn", "aria-label": "Close", onclick: () => done(cancel) }, icon("x"))),
        h("div", { class: "tsa-dlg__body" }, body), h("div", { class: "tsa-dlg__foot" }, btns));
      const overlay = h("div", { class: "tsa-dlg-wrap", "data-testid": "tsa-dialog", onclick: (e) => { if (e.target === overlay) done(cancel); } }, box);
      overlay.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(cancel); }
        else if (e.key === "Tab") { const f = [...box.querySelectorAll("button:not([disabled]), input, select, textarea")]; if (!f.length) return; const i = f.indexOf(document.activeElement); if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); } }
        e.stopPropagation();
      });
      host.append(overlay);
      if (S) S.dialog = overlay;
      const first = btns.filter((b) => !b.disabled).pop();
      if (first) first.focus();
    });
  }

  /* ============================================================= layout */

  function build(root) {
    clear(root);
    root.setAttribute("aria-label", `TSA editor — ${S.name || S.id}`);
    const top = h("header", { class: "tsa-top" });
    const banners = h("div", { class: "tsa-banners" });
    const palette = h("aside", { class: "tsa-pal", "aria-label": "Tools" });
    const stage = h("div", { class: "tsa-stage", tabindex: "0", role: "application", "aria-roledescription": "call flow canvas", "aria-label": "Canvas. Drag a tool here; drag from a port to wire it. Press ? for the shortcuts.", "data-testid": "tsa-stage" });
    const world = h("div", { class: "tsa-world" });
    const marker = (id, cls) => s("marker", { id, viewBox: "0 0 10 10", refX: "8.5", refY: "5", markerWidth: "9", markerHeight: "9", markerUnits: "userSpaceOnUse", orient: "auto" }, s("path", { d: "M0,1 L9,5 L0,9 z", class: cls }));
    const svg = s("svg", { class: "tsa-wires", "aria-hidden": "true" },
      s("defs", {}, marker("tsa-arrow-flow", "tsa-arrow tsa-tone--flow"), marker("tsa-arrow-ok", "tsa-arrow tsa-tone--ok"), marker("tsa-arrow-warn", "tsa-arrow tsa-tone--warn"), marker("tsa-arrow-err", "tsa-arrow tsa-tone--err"), marker("tsa-arrow-data", "tsa-arrow tsa-tone--data")));
    const gWires = s("g", { transform: "translate(10000 10000)" });
    svg.append(gWires);
    world.append(svg);
    const hint = h("div", { class: "tsa-hint", role: "status", "aria-live": "polite", hidden: true });
    const empty = h("div", { class: "tsa-empty" }, icon("workflow", "ico tsa-empty__ico"), h("strong", {}, "An empty TSA"), h("span", {}, "Drag a tool from the left — every call starts at Start."));
    const zoomPct = h("button", { type: "button", class: "btn btn--xs tsa-zoom__pct", "data-tip": "100 % (0)", "aria-label": "Reset the zoom", onclick: () => zoomTo(1) }, "100%");
    const modeBtn = h("button", { type: "button", class: "btn btn--xs tsa-icon-btn", "data-testid": "tsa-mode", onclick: () => { S.mode = S.mode === "pan" ? "select" : "pan"; drawModeBtn(); } });
    const mapBtn = h("button", { type: "button", class: "btn btn--xs tsa-icon-btn", "data-tip": "Minimap", "aria-label": "Show or hide the minimap", "aria-pressed": "true", onclick: () => { S.minimap = !S.minimap; mapBtn.setAttribute("aria-pressed", String(S.minimap)); drawMinimap(); } }, icon("map"));
    const zoom = h("div", { class: "tsa-zoom", role: "toolbar", "aria-label": "View" },
      modeBtn,
      h("span", { class: "tsa-zoom__sep" }),
      h("button", { type: "button", class: "btn btn--xs tsa-icon-btn", "data-tip": "Zoom out (−)", "aria-label": "Zoom out", onclick: () => zoomBy(1 / 1.2) }, icon("zoom-out")),
      zoomPct,
      h("button", { type: "button", class: "btn btn--xs tsa-icon-btn", "data-tip": "Zoom in (+)", "aria-label": "Zoom in", onclick: () => zoomBy(1.2) }, icon("zoom-in")),
      h("button", { type: "button", class: "btn btn--xs tsa-icon-btn", "data-tip": "Fit everything (A)", "aria-label": "Fit everything", onclick: () => fit() }, icon("scan")),
      h("button", { type: "button", class: "btn btn--xs tsa-icon-btn", "data-tip": "Arrange the flow top to bottom", "aria-label": "Arrange", "data-testid": "tsa-arrange", onclick: () => arrange() }, icon("network")),
      mapBtn);
    const minimap = s("svg", { class: "tsa-minimap", role: "img", "aria-label": "Minimap — click to move the view" });
    const marquee = h("div", { class: "tsa-marquee", hidden: true });
    stage.append(world, empty, hint, zoom, minimap, marquee);
    const probs = h("section", { class: "tsa-probs", "aria-label": "Problems", "data-testid": "tsa-problems" });
    const center = h("div", { class: "tsa-center" }, stage, probs);
    const side = h("aside", { class: "tsa-side", "aria-label": "Inspector and simulator" });
    const body = h("div", { class: "tsa-body" }, palette, center, side);
    root.append(top, banners, body);
    body.classList.toggle("no-side", !S.showSide);
    Object.assign(S.els, { root, top, banners, palette, stage, world, svg, gWires, hint, empty, zoomPct, modeBtn, minimap, marquee, probs, side, body, center });
    S.els.nodes = new Map();
    drawTop(); drawPalette(); drawModeBtn(); applyCam(); drawAll(); drawSide(); drawProblems();
    wireEvents();
    if (S.ro) banner("ro", "eye", "Read-only: your rights do not include saving TSAs (Telephony & SIP › tsa). You can still look around and simulate.", []);
    stage.focus({ preventScroll: true });
  }

  function drawModeBtn() {
    const b = S.els.modeBtn;
    clear(b);
    b.append(icon(S.mode === "pan" ? "hand" : "mouse-pointer-2"));
    b.dataset.tip = S.mode === "pan" ? "Dragging the background pans (Shift+drag selects) — click to switch" : "Dragging the background selects (Space+drag pans) — click to switch";
    b.setAttribute("aria-label", S.mode === "pan" ? "Background drag: pan" : "Background drag: select");
    S.els.stage.classList.toggle("is-select-mode", S.mode === "select");
  }

  /** A notice under the top bar (one per key). */
  function banner(key, ic, text, actions, tone = "info") {
    const box = S.els.banners;
    const old = box.querySelector(`[data-banner="${key}"]`);
    if (old) old.remove();
    if (!text) return;
    box.append(h("div", { class: `tsa-banner tsa-banner--${tone}`, "data-banner": key, role: "status" }, icon(ic), h("span", { class: "tsa-banner__text" }, text), ...actions));
  }

  /* ------------------------------------------------------------ top bar */

  function drawTop() {
    const top = S.els.top;
    clear(top);
    const I = (n) => icon(n);
    const name = h("input", { class: "input tsa-top__name", value: S.name, placeholder: "TSA name", "aria-label": "TSA name", spellcheck: "false", "data-testid": "tsa-name", maxlength: "120" });
    name.addEventListener("input", () => { snapshot("name"); S.name = name.value; changed(); });
    name.addEventListener("blur", () => { S.histTag = null; });
    const desc = h("input", { class: "input tsa-top__desc", value: S.description, placeholder: "What it does (shown in the TSA list)", "aria-label": "Description", "data-testid": "tsa-desc", maxlength: "500" });
    desc.addEventListener("input", () => { snapshot("desc"); S.description = desc.value; changed(); });
    desc.addEventListener("blur", () => { S.histTag = null; });
    const btn = (ic, label, tip, onclick, extra = {}) => h("button", { type: "button", class: `btn btn--sm${extra.primary ? " btn--primary" : ""}${label ? "" : " tsa-icon-btn"}`, "data-tip": tip, "aria-label": label || tip, onclick, ...extra.attrs }, I(ic), label ? h("span", { class: "tsa-top__lbl" }, label) : null);
    top.append(
      h("button", { type: "button", class: "btn btn--sm btn--ghost tsa-icon-btn", "data-tip": "Close the editor (asks about unsaved changes)", "aria-label": "Close the editor", "data-testid": "tsa-close", onclick: () => closeEditor() }, I("arrow-left")),
      h("span", { class: "tsa-top__logo", "aria-hidden": "true" }, I("workflow")),
      h("div", { class: "tsa-top__titles" }, h("div", { class: "tsa-top__row" }, name, h("code", { class: "tsa-top__id", title: "The TSA's id" }, S.id)), desc),
      h("div", { class: "tsa-top__state", "data-testid": "tsa-state", "aria-live": "polite" }),
      h("span", { class: "tsa-grow" }),
      h("div", { class: "tsa-top__group", role: "group", "aria-label": "History" },
        btn("undo-2", "", "Undo (Ctrl/⌘+Z)", () => undo(), { attrs: { "data-testid": "tsa-undo" } }),
        btn("redo-2", "", "Redo (Ctrl/⌘+Y)", () => redo(), { attrs: { "data-testid": "tsa-redo" } })),
      h("div", { class: "tsa-top__group", role: "group", "aria-label": "Draft" },
        btn("save", "Save draft", "Save the draft to the server (Ctrl/⌘+S)", () => saveDraft(), { attrs: { "data-testid": "tsa-save", disabled: S.ro || undefined } }),
        btn("shield-check", "Validate", "Check the whole TSA now", () => { S.probOpen = true; validateNow(); }, { attrs: { "data-testid": "tsa-validate" } }),
        btn("cloud-upload", "Publish", "Publish the draft — calls run it from then on", () => publish(), { primary: true, attrs: { "data-testid": "tsa-publish", disabled: S.ro || undefined } })),
      h("div", { class: "tsa-top__group", role: "group", "aria-label": "Run" },
        btn("phone-call", "Simulate", "Call the TSA in the browser — no provider, no cost", () => showSide("sim"), { attrs: { "data-testid": "tsa-simulate" } }),
        btn("download", "", "Export the saved TSA as a JSON file", () => exportJson(), { attrs: { "data-testid": "tsa-export" } })),
      h("div", { class: "tsa-top__group tsa-top__group--panels", role: "group", "aria-label": "Panels" },
        btn("layers", "", "Show or hide the palette", () => { S.showPalette = !S.showPalette; S.els.body.classList.toggle("no-pal", !S.showPalette); requestAnimationFrame(drawWires); }),
        btn("panel-right", "", "Show or hide the inspector", () => { S.showSide = !S.showSide; S.els.body.classList.toggle("no-side", !S.showSide); requestAnimationFrame(drawWires); }),
        btn("circle-help", "", "Keyboard shortcuts (?)", () => shortcuts())),
    );
    drawTopState();
  }

  /** The draft / published badges and the buttons that depend on them. */
  function drawTopState() {
    if (!S || !S.els.top) return;
    const box = S.els.top.querySelector(".tsa-top__state");
    if (!box) return;
    clear(box);
    const dirty = isDirty();
    const pub = S.tsa.published;
    const draftGraph = JSON.stringify(serializeGraph(S.graph));
    const differs = pub && pub.graph ? draftGraph !== JSON.stringify(serializeGraph({ nodes: clone(pub.graph.nodes || []), edges: clone(pub.graph.edges || []) })) : true;
    box.append(
      h("span", { class: `tsa-chip ${dirty ? "tsa-chip--warn" : "tsa-chip--ok"}`, "data-testid": "tsa-dirty", title: dirty ? "Changes not saved to the server yet (a local copy is kept)" : `Saved ${when(S.tsa.updatedAt)}${S.tsa.updatedBy ? " by " + S.tsa.updatedBy : ""}` }, h("span", { class: "tsa-chip__dot" }), S.saving ? "Saving…" : dirty ? "Unsaved draft" : "Draft saved"),
      pub
        ? h("span", { class: `tsa-chip ${differs ? "tsa-chip--info" : "tsa-chip--ok"}`, title: `Published ${when(pub.at)}${pub.by ? " by " + pub.by : ""}` }, `Published v${pub.version}`, differs ? h("span", { class: "tsa-chip__sub" }, " · draft differs") : null)
        : h("span", { class: "tsa-chip tsa-chip--muted", title: "Calls do not run a TSA before it is published" }, "Not published"));
    const undoB = S.els.top.querySelector('[data-testid="tsa-undo"]'), redoB = S.els.top.querySelector('[data-testid="tsa-redo"]');
    if (undoB) undoB.disabled = !S.undo.length;
    if (redoB) redoB.disabled = !S.redo.length;
    const save = S.els.top.querySelector('[data-testid="tsa-save"]');
    if (save) { save.classList.toggle("is-dirty", dirty); save.disabled = S.ro || S.saving; }
  }

  /* ------------------------------------------------------------ palette */

  function drawPalette() {
    const p = S.els.palette;
    clear(p);
    const search = h("input", { class: "input input--sm tsa-pal__search", type: "search", placeholder: "Find a tool…", "aria-label": "Find a tool", "data-testid": "tsa-pal-search" });
    const list = h("div", { class: "tsa-pal__list" });
    const tip = h("div", { class: "tsa-pal__tip", hidden: true, role: "tooltip", id: "tsaPalTip" });
    const groups = [...S.groups];
    for (const t of TOOLS.values()) if (!groups.some((g) => g.id === t.group)) groups.push({ id: t.group, label: t.group });
    const draw = () => {
      clear(list);
      const q = search.value.trim().toLowerCase();
      for (const g of groups) {
        const items = [...TOOLS.values()].filter((t) => t.group === g.id && (!q || `${t.label} ${t.type} ${t.summary} ${t.help}`.toLowerCase().includes(q)));
        if (!items.length) continue;
        const sec = h("details", { class: "tsa-pal__group", open: true }, h("summary", {}, icon("chevron-down", "ico tsa-pal__chev"), g.label, h("span", { class: "tsa-pal__count" }, String(items.length))));
        for (const t of items) {
          const item = h("div", { class: `tsa-pal__item tsa-acc--${t.accent}`, tabindex: "0", role: "button", "data-type": t.type, "data-testid": `tsa-pal-${t.type}`, "aria-label": `${t.label}: ${t.summary} — Enter adds it`, "aria-describedby": "tsaPalTip" },
            h("span", { class: "tsa-pal__icon" }, icon(t.icon)),
            h("span", { class: "tsa-pal__text" }, h("span", { class: "tsa-pal__label" }, t.label), h("span", { class: "tsa-pal__sum" }, t.summary)));
          item.addEventListener("pointerdown", (e) => paletteDrag(e, t.type));
          item.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); addAtCenter(t.type); } });
          item.addEventListener("pointerenter", () => showPalTip(tip, item, t));
          item.addEventListener("focus", () => showPalTip(tip, item, t));
          item.addEventListener("pointerleave", () => { tip.hidden = true; });
          item.addEventListener("blur", () => { tip.hidden = true; });
          sec.append(item);
        }
        list.append(sec);
      }
      if (!list.firstChild) list.append(h("p", { class: "muted small tsa-pal__none" }, "No tool matches."));
    };
    search.addEventListener("input", draw);
    search.addEventListener("keydown", (e) => { if (e.key === "Enter") { const first = list.querySelector(".tsa-pal__item"); if (first) addAtCenter(first.dataset.type); } });
    draw();
    p.append(h("div", { class: "tsa-pal__head" }, h("strong", {}, "Tools"), h("span", { class: "muted small" }, "drag or click")), search, list, tip);
  }

  function showPalTip(tip, item, t) {
    clear(tip);
    const ports = [];
    if (t.flowIn) ports.push("flow in");
    const outs = t.dynamicFlowOut ? `one output per ${t.dynamicFlowOut.param.replace(/s$/, "")} + ${(t.dynamicFlowOut.plus || []).map((p) => p.port).join(", ")}` : (t.flowOut || []).map((p) => p.port).join(", ");
    tip.append(
      h("div", { class: "tsa-pal__tiphead" }, h("span", { class: `tsa-pal__icon tsa-acc--${t.accent}` }, icon(t.icon)), h("strong", {}, t.label), h("code", {}, t.type)),
      h("p", {}, t.help || t.summary),
      h("dl", { class: "tsa-pal__ports" },
        outs ? [h("dt", {}, "Flow out"), h("dd", {}, outs)] : null,
        t.dynamicInputs ? [h("dt", {}, "Inputs"), h("dd", {}, `IN1 … IN<n> (${t.dynamicInputs.min}–${t.dynamicInputs.max}, starts with ${t.dynamicInputs.initial})`)] : null,
        (t.dataIn || []).length ? [h("dt", {}, "Data in"), h("dd", {}, t.dataIn.map((p) => p.port).join(", "))] : null,
        (t.dataOut || []).length ? [h("dt", {}, "Data out"), h("dd", {}, t.dataOut.map((p) => p.port).join(", "))] : null));
    tip.hidden = false;
    const r = item.getBoundingClientRect(), pr = S.els.palette.getBoundingClientRect();
    tip.style.top = `${Math.max(8, r.top - pr.top)}px`;
  }

  function paletteDrag(e, type) {
    if (e.button !== 0) return;
    const sx = e.clientX, sy = e.clientY;
    let ghost = null;
    const t = toolOf(type);
    const move = (ev) => {
      if (!ghost && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 5) {
        ghost = h("div", { class: `tsa-ghost tsa-acc--${t.accent}` }, icon(t.icon), t.label);
        document.body.append(ghost);
        S.els.stage.classList.add("is-drop");
      }
      if (ghost) { ghost.style.left = `${ev.clientX + 10}px`; ghost.style.top = `${ev.clientY + 10}px`; }
    };
    const up = (ev) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!S) { if (ghost) ghost.remove(); return; }
      S.els.stage.classList.remove("is-drop");
      if (!ghost) { addAtCenter(type); return; }
      ghost.remove();
      const r = S.els.stage.getBoundingClientRect();
      if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) return;
      const w = toWorld(ev.clientX, ev.clientY);
      const g = geo({ id: "x", type, x: 0, y: 0, params: defaultParams(type), inputs: t.dynamicInputs ? t.dynamicInputs.initial : undefined });
      addNode(type, w.x - g.w / 2, w.y - 20);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function addAtCenter(type) {
    const { w: sw, h: sh } = stageSize();
    const c = { x: (sw / 2 - S.cam.x) / S.cam.z, y: (sh / 2 - S.cam.y) / S.cam.z };
    const t = toolOf(type);
    const g = geo({ id: "x", type, x: 0, y: 0, params: defaultParams(type), inputs: t && t.dynamicInputs ? t.dynamicInputs.initial : undefined });
    let x = snapTo(c.x - g.w / 2), y = snapTo(c.y - g.h / 2);
    while (S.graph.nodes.some((n) => Math.abs(n.x - x) < 20 && Math.abs(n.y - y) < 20)) { x += 30; y += 30; }
    return addNode(type, x, y);
  }

  /* ============================================================= camera */

  function stageSize() {
    const r = S.els.stage.getBoundingClientRect();
    return { w: r.width || 1000, h: r.height || 640, left: r.left, top: r.top };
  }
  function toWorld(clientX, clientY) {
    const r = S.els.stage.getBoundingClientRect();
    return { x: (clientX - r.left - S.cam.x) / S.cam.z, y: (clientY - r.top - S.cam.y) / S.cam.z };
  }
  function applyCam() {
    const { x, y, z } = S.cam;
    S.els.world.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
    let step = 20;
    while (step * z < 12) step *= 5;
    const gs = step * z;
    S.els.stage.style.backgroundSize = `${gs}px ${gs}px, ${gs * 5}px ${gs * 5}px, ${gs * 5}px ${gs * 5}px`;
    S.els.stage.style.backgroundPosition = `${x}px ${y}px, ${x}px ${y}px, ${x}px ${y}px`;
    S.els.zoomPct.textContent = `${Math.round(z * 100)}%`;
    drawMinimap();
  }
  function zoomBy(f, clientX, clientY) {
    const r = S.els.stage.getBoundingClientRect();
    const { w, h: hh } = stageSize();
    const px = clientX === undefined ? w / 2 : clientX - r.left, py = clientY === undefined ? hh / 2 : clientY - r.top;
    const wx = (px - S.cam.x) / S.cam.z, wy = (py - S.cam.y) / S.cam.z;
    S.cam.z = clamp(S.cam.z * f, 0.2, 2.5);
    S.cam.x = px - wx * S.cam.z;
    S.cam.y = py - wy * S.cam.z;
    applyCam();
  }
  const zoomTo = (z) => zoomBy(z / S.cam.z);
  function bounds(nodes) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) { const g = geo(n); x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y - 26); x1 = Math.max(x1, n.x + g.w + 60); y1 = Math.max(y1, n.y + g.h + 20); }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  function fit(nodes) {
    if (!S) return;
    const list = nodes || S.graph.nodes;
    if (!list.length) { applyCam(); return; }
    const b = bounds(list);
    const { w, h: hh } = stageSize();
    const z = clamp(Math.min((w - 80) / Math.max(1, b.w), (hh - 80) / Math.max(1, b.h)), 0.25, 1.2);
    S.cam = { z, x: (w - b.w * z) / 2 - b.x * z, y: (hh - b.h * z) / 2 - b.y * z };
    applyCam();
  }
  function centerOn(x, y) {
    const { w, h: hh } = stageSize();
    S.cam.x = w / 2 - x * S.cam.z;
    S.cam.y = hh / 2 - y * S.cam.z;
    applyCam();
  }
  function centerOnNode(id) {
    const n = byId(id);
    if (!n) return;
    const g = geo(n);
    centerOn(n.x + g.w / 2, n.y + g.h / 2);
  }

  /* ============================================================ drawing */

  function drawAll() {
    drawNodes();
    drawWires();
    drawMinimap();
    S.els.empty.hidden = S.graph.nodes.length > 0;
  }

  function problemsByNode() {
    const m = new Map();
    for (const p of S.problems) {
      if (!p.node) continue;
      const o = m.get(p.node) || { error: 0, warning: 0, list: [], ports: new Set() };
      if (p.level === "error") o.error++; else o.warning++;
      o.list.push(p);
      if (p.port) o.ports.add(p.port);
      m.set(p.node, o);
    }
    return m;
  }
  function wiredPorts() {
    const set = new Set();
    for (const e of S.graph.edges) { set.add(`${e.from.node}\u0000o\u0000${e.from.port}`); set.add(`${e.to.node}\u0000i\u0000${e.to.port}`); }
    return set;
  }

  function drawNodes() {
    for (const el of S.els.nodes.values()) el.remove();
    S.els.nodes.clear();
    const probs = problemsByNode();
    const wired = wiredPorts();
    for (const n of S.graph.nodes) {
      const el = nodeEl(n, probs.get(n.id), wired);
      S.els.nodes.set(n.id, el);
      S.els.world.append(el);
    }
    S.els.empty.hidden = S.graph.nodes.length > 0;
  }
  function redrawNode(n) {
    const old = S.els.nodes.get(n.id);
    const el = nodeEl(n, problemsByNode().get(n.id), wiredPorts());
    S.els.nodes.set(n.id, el);
    if (old) old.replaceWith(el); else S.els.world.append(el);
  }

  const MONO_SUB = new Set(["condition", "while", "formula", "set", "for", "send_dtmf", "switch"]);
  function nodeEl(n, prob, wired) {
    const t = toolOf(n.type);
    const g = geo(n);
    const title = titleOf(n);
    const cls = ["tsa-node", `tsa-shape--${g.shape}`, `tsa-acc--${t ? t.accent : "danger"}`];
    if (!t) cls.push("tsa-node--unknown");
    if (S.sel.nodes.has(n.id)) cls.push("is-sel");
    if (prob && prob.error) cls.push("is-err"); else if (prob && prob.warning) cls.push("is-warn");
    if (S.sim.at === n.id) cls.push("is-sim-run");
    else if (S.sim.visited.has(n.id)) cls.push("is-sim-visited");
    const el = h("div", {
      class: cls.join(" "), "data-id": n.id, "data-type": n.type, tabindex: "0", role: "group",
      "aria-label": `${title} (${t ? t.label : `unknown tool ${n.type}`}, ${n.id})${prob ? ` — ${plural(prob.error, "error")}, ${plural(prob.warning, "warning")}` : ""}`,
      style: { left: `${n.x}px`, top: `${n.y}px`, width: `${g.w}px`, height: `${g.h}px` },
    });
    const sub = subtitle(n);
    const head = h("div", { class: "tsa-node__head" },
      h("span", { class: "tsa-node__icon", "aria-hidden": "true" }, icon(t ? t.icon : "circle-alert")),
      h("span", { class: "tsa-node__title", title: `${title} · ${n.id}` }, title),
      n.note ? h("span", { class: "tsa-node__note", title: n.note }, icon("info")) : null,
      h("span", { class: "tsa-node__type" }, n.type));
    el.append(h("div", { class: "tsa-node__body", style: { top: `${g.top}px` } }, head,
      h("div", { class: `tsa-node__sub${MONO_SUB.has(n.type) ? " is-mono" : ""}`, title: sub }, sub || " ")));
    const isW = (side, port) => wired.has(`${n.id}\u0000${side}\u0000${port}`);
    const bad = (port) => Boolean(prob && prob.ports.has(port));
    if (g.ports.fin) el.append(portEl(n, "fin", g.ports.fin, isW("i", "in"), "", bad("in")));
    for (const p of g.ports.din) el.append(portEl(n, "din", p, isW("i", p.port), p.label || p.port, bad(p.port)));
    for (const p of g.ports.fout) el.append(portEl(n, "fout", p, isW("o", p.port), p.label || p.port, bad(p.port)));
    for (const p of g.ports.dout) el.append(portEl(n, "dout", p, isW("o", p.port), p.label || p.port, bad(p.port)));
    if (t && t.dynamicInputs) {
      const cnt = inputCount(n), d = t.dynamicInputs;
      el.append(h("div", { class: "tsa-node__pm", role: "group", "aria-label": `Inputs of ${title}` },
        h("button", { type: "button", class: "tsa-pm", "data-act": "in-minus", "data-testid": "tsa-in-minus", "aria-label": cnt ? `Remove input IN${cnt}` : "No input to remove", title: cnt ? `Remove IN${cnt}` : "", disabled: cnt <= d.min || undefined }, icon("minus")),
        h("span", { class: "tsa-pm__n", "aria-hidden": "true" }, `IN ${cnt}`),
        h("button", { type: "button", class: "tsa-pm", "data-act": "in-plus", "data-testid": "tsa-in-plus", "aria-label": `Add input IN${cnt + 1}`, title: `Add IN${cnt + 1}`, disabled: cnt >= Math.min(d.max, LIMITS.dynamicInputs || 100) || undefined }, icon("plus"))));
    }
    if (prob) el.append(h("span", { class: `tsa-node__badge tsa-node__badge--${prob.error ? "err" : "warn"}`, title: prob.list.map((p) => `${p.level}: ${p.message}`).join("\n"), "data-testid": "tsa-node-badge" }, icon(prob.error ? "circle-x" : "triangle-alert"), String(prob.error || prob.warning)));
    if (g.shape === "wide") el.append(h("div", { class: "tsa-node__resize", title: "Drag to change the width", "aria-hidden": "true" }));
    return el;
  }

  const WHERE = { fin: "flow input", fout: "flow output", din: "data input", dout: "data output" };
  function portEl(n, kind, p, isWired, label, bad) {
    const live = S.pending || S.wire;
    const target = Boolean(live && live.targets.has(`${n.id}\u0000${p.port}`));
    const origin = Boolean(live && live.origin.node === n.id && live.origin.port === p.port);
    const tone = kind === "fout" ? ` tsa-tone--${portTone(p.port)}` : "";
    const named = p.label && p.label !== p.port ? `${p.port} (${p.label})` : p.port;
    return h("div", {
      class: `tsa-port tsa-port--${kind}${tone}${isWired ? " is-wired" : ""}${bad ? " is-bad" : ""}${target ? " is-target" : ""}${origin ? " is-origin" : ""}`,
      "data-port": p.port, "data-kind": kind, role: "button",
      tabindex: S.sel.nodes.has(n.id) || target ? "0" : "-1",
      "aria-label": `${named} — ${WHERE[kind]} of ${titleOf(n)} (${n.id})${isWired ? ", wired" : ""}${target ? ", can be wired here" : ""}`,
      title: `${named} · ${WHERE[kind]}${p.help ? ` — ${p.help}` : ""}`,
      style: { left: `${p.x}px`, top: `${p.y}px` },
    }, h("span", { class: "tsa-port__dot" }), label ? h("span", { class: "tsa-port__label" }, label) : null);
  }
  function portElOf(nodeId, port) {
    const el = S.els.nodes.get(nodeId);
    if (!el) return null;
    return [...el.querySelectorAll(".tsa-port")].find((x) => x.dataset.port === port) || null;
  }

  let wiresQueued = false;
  function drawWiresSoon() {
    if (wiresQueued) return;
    wiresQueued = true;
    requestAnimationFrame(() => { wiresQueued = false; if (S) drawWires(); });
  }
  function drawWires() {
    const g = S.els.gWires;
    clear(g);
    const nodes = nodeMap();
    const badEdges = new Set(S.problems.filter((p) => p.edge).map((p) => p.edge));
    for (const e of S.graph.edges) {
      const a = nodes.get(e.from.node), b = nodes.get(e.to.node);
      if (!a || !b) continue;
      const pa = portPos(a, e.from.port), pb = portPos(b, e.to.port);
      if (!pa || !pb) continue;
      const d = wirePath(pa, pb, e.kind);
      const tone = e.kind === "flow" ? portTone(e.from.port) : "data";
      const cls = ["tsa-wire", `tsa-wire--${e.kind === "flow" ? "flow" : "data"}`, `tsa-tone--${tone}`];
      if (S.sel.edge === e.id) cls.push("is-sel");
      if (badEdges.has(e.id)) cls.push("is-bad");
      if (S.sim.edges.has(`${e.from.node}\u0000${e.from.port}`)) cls.push("is-sim");
      if (S.sel.nodes.has(e.from.node) || S.sel.nodes.has(e.to.node)) cls.push("is-near");
      g.append(
        s("path", { d, class: cls.join(" "), "marker-end": `url(#tsa-arrow-${tone})`, "data-edge": e.id }),
        s("path", { d, class: "tsa-wire-hit", "data-edge": e.id }, s("title", {}, `${e.kind} wire ${describeEdge(e)}`)));
    }
    if (S.wire && S.wire.path) g.append(S.wire.path);
  }

  function drawMinimap() {
    if (!S || !S.els.minimap) return;
    const mm = S.els.minimap;
    clear(mm);
    const { w: sw, h: sh } = stageSize();
    // Only where it does not cover the work: a canvas of at least 640 × 420.
    const on = S.minimap && S.graph.nodes.length > 0 && sw >= 640 && sh >= 420;
    mm.style.display = on ? "" : "none";
    if (!on) return;
    const W = 168, H = 108;
    const b = bounds(S.graph.nodes);
    const view = { x: -S.cam.x / S.cam.z, y: -S.cam.y / S.cam.z, w: sw / S.cam.z, h: sh / S.cam.z };
    const x0 = Math.min(b.x, view.x), y0 = Math.min(b.y, view.y), x1 = Math.max(b.x + b.w, view.x + view.w), y1 = Math.max(b.y + b.h, view.y + view.h);
    const k = Math.min(W / Math.max(1, x1 - x0), H / Math.max(1, y1 - y0));
    const ox = (W - (x1 - x0) * k) / 2 - x0 * k, oy = (H - (y1 - y0) * k) / 2 - y0 * k;
    mm.setAttribute("viewBox", `0 0 ${W} ${H}`);
    mm.setAttribute("width", String(W));
    mm.setAttribute("height", String(H));
    for (const n of S.graph.nodes) {
      const g = geo(n);
      const t = toolOf(n.type);
      mm.append(s("rect", { x: (n.x * k + ox).toFixed(1), y: (n.y * k + oy).toFixed(1), width: Math.max(2, g.w * k).toFixed(1), height: Math.max(2, g.h * k).toFixed(1), rx: 1.5, class: `tsa-mm__node tsa-acc--${t ? t.accent : "danger"}${S.sel.nodes.has(n.id) ? " is-sel" : ""}${S.sim.at === n.id ? " is-run" : ""}` }));
    }
    mm.append(s("rect", { x: (view.x * k + ox).toFixed(1), y: (view.y * k + oy).toFixed(1), width: (view.w * k).toFixed(1), height: (view.h * k).toFixed(1), class: "tsa-mm__view" }));
    S.mm = { k, ox, oy };
  }
  function onMinimapDown(e) {
    if (e.button !== 0 || !S.mm) return;
    e.preventDefault();
    e.stopPropagation();
    const go = (ev) => {
      const r = S.els.minimap.getBoundingClientRect();
      const mx = ((ev.clientX - r.left) / (r.width || 168)) * 168, my = ((ev.clientY - r.top) / (r.height || 108)) * 108;
      const { k, ox, oy } = S.mm;
      centerOn((mx - ox) / k, (my - oy) / k);
    };
    go(e);
    const up = () => { window.removeEventListener("pointermove", go); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", go);
    window.addEventListener("pointerup", up);
  }

  function showHint(text, tone) {
    const el = S.els.hint;
    clear(el);
    el.className = `tsa-hint${tone ? " tsa-hint--" + tone : ""}`;
    el.append(text);
    el.hidden = false;
  }
  function hideHint() { if (S && S.els.hint) S.els.hint.hidden = true; }

  /* ========================================================== selection */

  function selectOnly(id, redraw = true) {
    S.sel = { nodes: new Set(id ? [id] : []), edge: null };
    if (redraw) { drawNodes(); drawWires(); drawMinimap(); drawSide(); }
  }
  function selectNodes(ids) {
    S.sel = { nodes: new Set(ids.filter((id) => byId(id))), edge: null };
    drawNodes(); drawWires(); drawMinimap(); drawSide();
  }
  function selectEdge(id) {
    S.sel = { nodes: new Set(), edge: id };
    drawNodes(); drawWires(); drawSide();
  }
  function toggleSel(id) {
    if (S.sel.nodes.has(id)) S.sel.nodes.delete(id); else S.sel.nodes.add(id);
    S.sel.edge = null;
    drawNodes(); drawWires(); drawMinimap(); drawSide();
  }
  function clearSelection() {
    if (!S.sel.nodes.size && !S.sel.edge) return;
    S.sel = { nodes: new Set(), edge: null };
    drawNodes(); drawWires(); drawMinimap(); drawSide();
  }
  function selectAll() { selectNodes(S.graph.nodes.map((n) => n.id)); }

  /* ============================================================= events */

  function wireEvents() {
    const st = S.els.stage;
    st.addEventListener("pointerdown", onStageDown);
    st.addEventListener("click", onStageClick);
    st.addEventListener("dblclick", onStageDbl);
    st.addEventListener("wheel", onWheel, { passive: false });
    S.els.minimap.addEventListener("pointerdown", onMinimapDown);
    S.els.root.addEventListener("keydown", onKey);
    listen(window, "keyup", (e) => { if (e.key === " " && S) { S.space = false; S.els.stage.classList.remove("is-space"); } });
    listen(window, "beforeunload", (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ""; } });
    if (typeof ResizeObserver === "function") { S.resizeObs = new ResizeObserver(() => { if (S) drawMinimap(); }); S.resizeObs.observe(st); }
  }

  function onStageDown(e) {
    if (S.dialog) return;
    const tgt = e.target;
    if (!tgt || !tgt.closest) return;
    if (tgt.closest(".tsa-zoom, .tsa-minimap, .tsa-quick, .tsa-hint")) return;
    if (e.button === 1 || (e.button === 0 && S.space)) { e.preventDefault(); startPan(e); return; }
    if (e.button !== 0) return;
    if (tgt.closest("button")) return;
    S.els.stage.focus({ preventScroll: true });
    closeQuick();
    const nodeEl = tgt.closest(".tsa-node");
    const port = tgt.closest(".tsa-port");
    if (nodeEl && tgt.closest(".tsa-node__resize")) { startResize(e, nodeEl.dataset.id); return; }
    if (nodeEl && port) { portDown(e, nodeEl.dataset.id, port.dataset.port); return; }
    if (S.pending) cancelPending();
    if (nodeEl) { nodeDown(e, nodeEl.dataset.id); return; }
    const hit = tgt.closest(".tsa-wire-hit");
    if (hit) { selectEdge(hit.getAttribute("data-edge")); return; }
    if (S.mode === "select" ? !e.altKey : e.shiftKey) { startMarquee(e); return; }
    startPan(e);
  }

  function onStageClick(e) {
    const b = e.target.closest && e.target.closest("[data-act]");
    if (!b) return;
    const nodeEl = b.closest(".tsa-node");
    const n = nodeEl && byId(nodeEl.dataset.id);
    if (!n) return;
    e.stopPropagation();
    if (b.dataset.act === "in-plus") setInputs(n, inputCount(n) + 1);
    else if (b.dataset.act === "in-minus") setInputs(n, inputCount(n) - 1);
  }

  function onStageDbl(e) {
    if (!e.target.closest || e.target.closest(".tsa-node, .tsa-zoom, .tsa-minimap, .tsa-quick")) return;
    quickAdd(e.clientX, e.clientY, toWorld(e.clientX, e.clientY), null);
  }

  function onWheel(e) {
    if (e.target.closest && e.target.closest(".tsa-quick")) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) zoomBy(Math.exp(-e.deltaY * 0.0022), e.clientX, e.clientY);
    else { S.cam.x -= e.deltaX; S.cam.y -= e.deltaY; applyCam(); }
  }

  /** Pointer helper: window-level move / up for one gesture. */
  function track(onMove, onUp) {
    const move = (ev) => onMove(ev);
    const up = (ev) => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up); onUp(ev); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  function startPan(e) {
    const sx = e.clientX, sy = e.clientY, cx = S.cam.x, cy = S.cam.y;
    let moved = false;
    S.els.stage.classList.add("is-panning");
    track((ev) => {
      if (!S) return;
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 3) moved = true;
      S.cam.x = cx + ev.clientX - sx;
      S.cam.y = cy + ev.clientY - sy;
      applyCam();
    }, () => {
      if (!S) return;
      S.els.stage.classList.remove("is-panning");
      if (!moved) clearSelection();
    });
  }

  function nodeDown(e, id) {
    if (e.shiftKey || e.metaKey || e.ctrlKey) { toggleSel(id); return; }
    const wasSel = S.sel.nodes.has(id);
    if (!wasSel) selectOnly(id);
    const start = new Map([...S.sel.nodes].map((i) => { const n = byId(i); return [i, { x: n.x, y: n.y }]; }));
    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    track((ev) => {
      if (!S) return;
      const dx = (ev.clientX - sx) / S.cam.z, dy = (ev.clientY - sy) / S.cam.z;
      if (!moved && Math.hypot(dx, dy) * S.cam.z < 3) return;
      if (!moved) { moved = true; snapshot(); S.els.stage.classList.add("is-moving"); }
      for (const [i, p] of start) {
        const n = byId(i);
        if (!n) continue;
        n.x = ev.altKey ? Math.round(p.x + dx) : snapTo(p.x + dx);
        n.y = ev.altKey ? Math.round(p.y + dy) : snapTo(p.y + dy);
        const el = S.els.nodes.get(i);
        if (el) { el.style.left = `${n.x}px`; el.style.top = `${n.y}px`; }
      }
      drawWiresSoon();
    }, () => {
      if (!S) return;
      S.els.stage.classList.remove("is-moving");
      if (moved) { drawWires(); changed(); }
      else if (wasSel && S.sel.nodes.size > 1) selectOnly(id);
    });
  }

  function startMarquee(e) {
    const r = S.els.stage.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const base = e.shiftKey ? new Set(S.sel.nodes) : new Set();
    const mq = S.els.marquee;
    let moved = false;
    track((ev) => {
      if (!S) return;
      const x = ev.clientX - r.left, y = ev.clientY - r.top;
      if (!moved && Math.hypot(x - sx, y - sy) < 4) return;
      moved = true;
      const x0 = Math.min(sx, x), y0 = Math.min(sy, y), x1 = Math.max(sx, x), y1 = Math.max(sy, y);
      mq.hidden = false;
      Object.assign(mq.style, { left: `${x0}px`, top: `${y0}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
      const w0 = { x: (x0 - S.cam.x) / S.cam.z, y: (y0 - S.cam.y) / S.cam.z }, w1 = { x: (x1 - S.cam.x) / S.cam.z, y: (y1 - S.cam.y) / S.cam.z };
      const sel = new Set(base);
      for (const n of S.graph.nodes) { const g = geo(n); if (n.x < w1.x && n.x + g.w > w0.x && n.y < w1.y && n.y + g.h > w0.y) sel.add(n.id); }
      S.sel = { nodes: sel, edge: null };
      for (const [id, el] of S.els.nodes) el.classList.toggle("is-sel", sel.has(id));
    }, () => {
      if (!S) return;
      mq.hidden = true;
      if (!moved) { clearSelection(); return; }
      drawNodes(); drawWires(); drawMinimap(); drawSide();
    });
  }

  function startResize(e, id) {
    e.preventDefault();
    e.stopPropagation();
    const n = byId(id);
    if (!n) return;
    const w0 = geo(n).w, sx = e.clientX;
    let moved = false;
    track((ev) => {
      if (!S) return;
      const dx = (ev.clientX - sx) / S.cam.z;
      if (!moved && Math.abs(dx) < 3) return;
      if (!moved) { moved = true; snapshot(); }
      n.w = Math.max(160, snapTo(w0 + dx));
      n.w = geo(n).w;
      redrawNode(n);
      drawWiresSoon();
    }, () => {
      if (!S || !moved) return;
      drawWires(); changed();
      if (S.sel.nodes.has(n.id)) drawSide();
    });
  }

  /* -------------------------------------------------------------- wiring */

  function originOf(nodeId, port) {
    const n = byId(nodeId);
    const kind = portKind(n, port);
    return kind ? { node: nodeId, port, kind } : null;
  }
  /** Every port a wire from `origin` may end on ("node\0port"). */
  function targetsFor(origin) {
    const set = new Set();
    for (const n of S.graph.nodes) {
      const g = geo(n);
      const cands = origin.kind === "fout" ? (g.ports.fin ? ["in"] : [])
        : origin.kind === "fin" ? g.ports.fout.map((p) => p.port)
          : origin.kind === "dout" ? g.ports.din.map((p) => p.port)
            : g.ports.dout.map((p) => p.port);
      for (const port of cands) if (checkConnect(S.graph, origin, { node: n.id, port }).ok) set.add(`${n.id}\u0000${port}`);
    }
    return set;
  }
  function nearestTarget(w, targets, radius) {
    let best = null;
    for (const key of targets) {
      const [node, port] = key.split("\u0000");
      const p = portPos(byId(node), port);
      if (!p) continue;
      const d = Math.hypot(p.x - w.x, p.y - w.y);
      if (d <= radius && (!best || d < best.d)) best = { node, port, pos: p, d };
    }
    return best;
  }
  const portName = (o) => `${titleOf(byId(o.node))} · ${o.port}`;

  function portDown(e, nodeId, port) {
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX, sy = e.clientY;
    let drag = false;
    track((ev) => {
      if (!S) return;
      if (!drag && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 4) drag = beginWire(nodeId, port);
      if (drag) moveWire(ev);
    }, (ev) => {
      if (!S) return;
      if (drag) endWire(ev); else portClick(nodeId, port);
    });
  }

  function beginWire(nodeId, port) {
    let origin = originOf(nodeId, port);
    if (!origin) return false;
    S.pending = null;
    let picked = null;
    // A wired data input or flow output holds one wire: grabbing it picks that wire up.
    if (origin.kind === "din") {
      const ex = edgeInto(nodeId, port);
      if (ex) { snapshot(); picked = ex; S.graph.edges = S.graph.edges.filter((x) => x !== ex); origin = { node: ex.from.node, port: ex.from.port, kind: "dout" }; }
    } else if (origin.kind === "fout") {
      const ex = edgeFrom(nodeId, port);
      if (ex) { snapshot(); picked = ex; S.graph.edges = S.graph.edges.filter((x) => x !== ex); }
    }
    const flowish = origin.kind === "fout" || origin.kind === "fin";
    S.wire = { origin, picked, targets: targetsFor(origin), path: s("path", { class: `tsa-wire tsa-wire--${flowish ? "flow" : "data"} tsa-wire--temp` }), hover: null };
    S.els.stage.classList.add("is-wiring");
    drawNodes(); drawWires();
    showHint(S.wire.targets.size ? `Drop on a highlighted port — ${S.wire.targets.size} fit. Drop on the canvas to add a tool there.` : "No port fits this wire. Drop on the canvas to add a tool.");
    return true;
  }

  function moveWire(ev) {
    const wr = S.wire;
    const w = toWorld(ev.clientX, ev.clientY);
    const hit = nearestTarget(w, wr.targets, 26 / S.cam.z);
    const key = hit ? `${hit.node}\u0000${hit.port}` : null;
    if (key !== wr.hover) {
      if (wr.hover) { const [a, b] = wr.hover.split("\u0000"); const el = portElOf(a, b); if (el) el.classList.remove("is-hover"); }
      if (hit) { const el = portElOf(hit.node, hit.port); if (el) el.classList.add("is-hover"); }
      wr.hover = key;
    }
    const o = portPos(byId(wr.origin.node), wr.origin.port);
    if (!o) return;
    const end = hit ? hit.pos : w;
    const flowish = wr.origin.kind === "fout" || wr.origin.kind === "fin";
    const [a, b] = isOut(wr.origin.kind) ? [o, end] : [end, o];
    wr.path.setAttribute("d", wirePath(a, b, flowish ? "flow" : "data"));
  }

  function endWire(ev) {
    const wr = S.wire;
    S.wire = null;
    S.els.stage.classList.remove("is-wiring");
    hideHint();
    const w = toWorld(ev.clientX, ev.clientY);
    const hit = nearestTarget(w, wr.targets, 26 / S.cam.z);
    if (hit) { connect(wr.origin, { node: hit.node, port: hit.port }, { history: !wr.picked }); return; }
    drawNodes(); drawWires();
    if (wr.picked) { changed(); drawSide(); toast(`Wire removed: ${describeEdge(wr.picked)} (Ctrl/⌘+Z brings it back).`); return; }
    const r = S.els.stage.getBoundingClientRect();
    const inside = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
    if (inside && !nodeAt(w)) quickAdd(ev.clientX, ev.clientY, w, wr.origin);
  }

  function nodeAt(w) {
    for (let i = S.graph.nodes.length - 1; i >= 0; i--) {
      const n = S.graph.nodes[i], g = geo(n);
      if (w.x >= n.x && w.x <= n.x + g.w && w.y >= n.y && w.y <= n.y + g.h) return n;
    }
    return null;
  }

  /** Click-to-connect (and Enter on a focused port): pick one port, then the other. */
  function portClick(nodeId, port) {
    const here = originOf(nodeId, port);
    if (!here) return;
    if (S.pending) {
      const p = S.pending;
      cancelPending(false);
      if (p.origin.node === nodeId && p.origin.port === port) { drawNodes(); refocusPort(nodeId, port); return; }
      const r = connect(p.origin, here);
      refocusPort(nodeId, port);
      return r;
    }
    S.pending = { origin: here, targets: targetsFor(here) };
    S.els.stage.classList.add("is-wiring");
    drawNodes();
    showHint(`${portName(here)} picked — click (or Enter on) the port to wire it to; ${S.pending.targets.size} fit. Esc cancels.`);
    refocusPort(nodeId, port);
  }
  function refocusPort(nodeId, port) { const el = portElOf(nodeId, port); if (el) { el.setAttribute("tabindex", "0"); el.focus({ preventScroll: true }); } }
  function cancelPending(redraw = true) {
    const had = S.pending || S.wire;
    S.pending = null;
    S.wire = null;
    S.els.stage.classList.remove("is-wiring");
    hideHint();
    if (redraw && had) { drawNodes(); drawWires(); }
  }

  /* ----------------------------------------------------------- quick add */

  function quickAdd(clientX, clientY, w, origin) {
    closeQuick();
    const r = S.els.stage.getBoundingClientRect();
    const box = h("div", { class: "tsa-quick", role: "dialog", "aria-label": origin ? "Add a tool wired to this port" : "Add a tool", style: { left: `${clamp(clientX - r.left, 8, Math.max(8, (r.width || 1000) - 290))}px`, top: `${clamp(clientY - r.top, 8, Math.max(8, (r.height || 640) - 330))}px` } });
    const input = h("input", { class: "input input--sm", placeholder: origin ? `Wire ${origin.port} to a new…` : "Add a tool…", "aria-label": "Find a tool" });
    const list = h("div", { class: "tsa-quick__list", role: "listbox" });
    let items = [], idx = 0;
    const fits = (t) => {
      if (t.type === "start" && S.graph.nodes.some((n) => n.type === "start")) return false;
      if (!origin) return true;
      const probe = { id: "probe", type: t.type, x: 0, y: 0, params: defaultParams(t.type), inputs: t.dynamicInputs ? Math.max(1, t.dynamicInputs.initial) : undefined };
      if (origin.kind === "fout") return Boolean(t.flowIn);
      if (origin.kind === "fin") return flowOutputs(probe).length > 0;
      if (origin.kind === "dout") return dataInputs(probe).length > 0;
      return dataOutputs(probe).length > 0;
    };
    const pick = (type) => { closeQuick(); addNode(type, w.x - 20, w.y - 10, { connectFrom: origin }); };
    const draw = () => {
      clear(list);
      const q = input.value.trim().toLowerCase();
      items = [...TOOLS.values()].filter((t) => fits(t) && (!q || `${t.label} ${t.type} ${t.summary} ${t.group}`.toLowerCase().includes(q))).slice(0, 14);
      idx = clamp(idx, 0, Math.max(0, items.length - 1));
      items.forEach((t, i) => list.append(h("button", { type: "button", role: "option", "aria-selected": String(i === idx), class: `tsa-quick__item tsa-acc--${t.accent}${i === idx ? " is-on" : ""}`, title: t.summary, onclick: () => pick(t.type) },
        h("span", { class: "tsa-pal__icon" }, icon(t.icon)), h("span", { class: "tsa-quick__label" }, t.label), h("span", { class: "muted small" }, t.group))));
      if (!items.length) list.append(h("p", { class: "muted small" }, "No tool fits."));
    };
    input.addEventListener("input", () => { idx = 0; draw(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); idx = Math.min(items.length - 1, idx + 1); draw(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); idx = Math.max(0, idx - 1); draw(); }
      else if (e.key === "Enter") { e.preventDefault(); if (items[idx]) pick(items[idx].type); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeQuick(); S.els.stage.focus(); }
    });
    box.append(input, list);
    S.els.stage.append(box);
    S.quick = box;
    draw();
    input.focus();
  }
  function closeQuick() { if (S && S.quick) { S.quick.remove(); S.quick = null; } }

  /* ============================================================ editing */

  function addNode(type, x, y, opts = {}) {
    const t = toolOf(type);
    if (!t) { toast(`There is no tool “${type}”.`, "err"); return null; }
    if (S.graph.nodes.length >= LIMITS.nodes) { toast(`A TSA has at most ${LIMITS.nodes} tools.`, "err"); return null; }
    if (type === "start" && S.graph.nodes.some((n) => n.type === "start")) { toast("A TSA has exactly one Start.", "err"); return null; }
    if (opts.history !== false) snapshot();
    const n = { id: newNodeId(type), type, x: snapTo(x), y: snapTo(y), params: defaultParams(type) };
    if (t.dynamicInputs) n.inputs = t.dynamicInputs.initial;
    S.graph.nodes.push(n);
    if (opts.connectFrom) autoConnect(opts.connectFrom, n);
    S.sel = { nodes: new Set([n.id]), edge: null };
    drawAll(); drawSide(); changed();
    return n;
  }

  /** Wires a new node to the port a wire was dropped from. */
  function autoConnect(origin, n) {
    let target = null;
    const t = toolOf(n.type);
    if (origin.kind === "fout" && hasFlowIn(n)) target = "in";
    else if (origin.kind === "fin") target = (flowOutputs(n)[0] || {}).port;
    else if (origin.kind === "dout") {
      if (t.dynamicInputs && inputCount(n) === 0 && t.dynamicInputs.max > 0) n.inputs = 1;
      target = (dataInputs(n)[0] || {}).port;
    } else if (origin.kind === "din") target = (dataOutputs(n)[0] || {}).port;
    if (!target) return;
    const r = checkConnect(S.graph, origin, { node: n.id, port: target });
    if (r.ok) applyConnect(r);
  }

  function applyConnect(r) {
    const gone = new Set(r.replaces.map((e) => e.id));
    S.graph.edges = S.graph.edges.filter((e) => !gone.has(e.id));
    const e = { id: newEdgeId(), from: { ...r.from }, to: { ...r.to }, kind: r.kind };
    S.graph.edges.push(e);
    r.edge = e;
    return e;
  }

  /** Wires two ports (either order). Refuses what the contract forbids; a full flow output / data input swaps its wire. */
  function connect(a, b, opts = {}) {
    const r = checkConnect(S.graph, a, b);
    if (!r.ok) {
      if (!opts.quiet) { toast(r.reason, r.same ? undefined : "err"); showHint(r.reason, "err"); setTimeoutS("hint", hideHint, 3500); }
      drawNodes(); drawWires();
      return r;
    }
    if (opts.history !== false) snapshot();
    applyConnect(r);
    if (r.replaces.length && !opts.quiet) toast(`Swapped: ${describeEdge(r.replaces[0])} was replaced — one wire per ${r.kind === "flow" ? "flow output" : "data input"} (Ctrl/⌘+Z undoes).`);
    drawNodes(); drawWires(); drawSide(); changed();
    return r;
  }

  function setTimeoutS(key, fn, ms) { if (!S) return; clearTimeout(S.timers[key]); S.timers[key] = setTimeout(() => { if (S) fn(); }, ms); }

  function setInputs(n, count) {
    const t = toolOf(n.type);
    if (!t || !t.dynamicInputs) return false;
    const d = t.dynamicInputs;
    const c = clamp(Math.round(count), d.min, Math.min(d.max, LIMITS.dynamicInputs || 100));
    if (c === inputCount(n) && n.inputs === c) return false;
    snapshot();
    const dropped = S.graph.edges.filter((e) => e.to.node === n.id && /^IN\d+$/.test(e.to.port) && Number(e.to.port.slice(2)) > c && !(t.dataIn || []).some((p) => p.port === e.to.port));
    if (dropped.length) S.graph.edges = S.graph.edges.filter((e) => !dropped.includes(e));
    n.inputs = c;
    if (dropped.length) toast(`Removed the wire into ${dropped.map((e) => e.to.port).join(", ")}.`);
    drawNodes(); drawWires(); drawSide(); changed();
    return true;
  }

  function removeSelection() {
    if (S.sel.edge) {
      snapshot();
      S.graph.edges = S.graph.edges.filter((e) => e.id !== S.sel.edge);
      S.sel.edge = null;
      drawNodes(); drawWires(); drawSide(); changed();
      return true;
    }
    if (!S.sel.nodes.size) return false;
    snapshot();
    const ids = S.sel.nodes;
    S.graph.nodes = S.graph.nodes.filter((n) => !ids.has(n.id));
    S.graph.edges = S.graph.edges.filter((e) => !ids.has(e.from.node) && !ids.has(e.to.node));
    S.sel = { nodes: new Set(), edge: null };
    drawAll(); drawSide(); changed();
    return true;
  }

  function copySelection() {
    if (!S.sel.nodes.size) return false;
    const ids = S.sel.nodes;
    clipboard = { nodes: S.graph.nodes.filter((n) => ids.has(n.id)).map(clone), edges: S.graph.edges.filter((e) => ids.has(e.from.node) && ids.has(e.to.node)).map(clone) };
    S.pastes = 0;
    lsSet(LS_CLIP, clipboard);
    toast(`Copied ${plural(clipboard.nodes.length, "tool")}.`);
    return true;
  }

  /** Pastes tools (new ids, wires between them kept) — returns the new ids. */
  function paste(src, offset) {
    const from = src || clipboard || lsGet(LS_CLIP);
    if (!from || !Array.isArray(from.nodes) || !from.nodes.length) { toast("Nothing to paste — copy tools first (C)."); return []; }
    if (!offset) S.pastes = (S.pastes || 0) + 1;
    const dx = offset ? offset.x : 40 * S.pastes, dy = offset ? offset.y : 40 * S.pastes;
    snapshot();
    const map = new Map();
    const added = [];
    let skipped = 0;
    for (const n of from.nodes) {
      if (!TOOLS.has(n.type) || (n.type === "start" && S.graph.nodes.some((x) => x.type === "start"))) { skipped++; continue; }
      if (S.graph.nodes.length >= LIMITS.nodes) { skipped++; continue; }
      const c = clone(n);
      c.id = newNodeId(n.type);
      c.x = snapTo(n.x + dx);
      c.y = snapTo(n.y + dy);
      c.params = c.params || {};
      map.set(n.id, c.id);
      S.graph.nodes.push(c);
      added.push(c.id);
    }
    for (const e of from.edges || []) {
      if (!map.has(e.from.node) || !map.has(e.to.node)) continue;
      const r = checkConnect(S.graph, { node: map.get(e.from.node), port: e.from.port }, { node: map.get(e.to.node), port: e.to.port });
      if (r.ok) applyConnect(r);
    }
    S.sel = { nodes: new Set(added), edge: null };
    drawAll(); drawSide(); changed();
    if (skipped) toast(`${plural(skipped, "tool")} not pasted (a second Start, an unknown tool or the limit).`);
    return added;
  }
  function duplicateSelection() {
    if (!S.sel.nodes.size) return [];
    const ids = S.sel.nodes;
    return paste({ nodes: S.graph.nodes.filter((n) => ids.has(n.id)), edges: S.graph.edges.filter((e) => ids.has(e.from.node) && ids.has(e.to.node)) }, { x: 40, y: 40 });
  }

  function nudge(dx, dy) {
    if (!S.sel.nodes.size) return;
    snapshot("nudge");
    for (const id of S.sel.nodes) {
      const n = byId(id);
      n.x += dx; n.y += dy;
      const el = S.els.nodes.get(id);
      if (el) { el.style.left = `${n.x}px`; el.style.top = `${n.y}px`; }
    }
    drawWires(); changed();
  }

  /** Renames a node (its wires follow). */
  function renameNode(n, id) {
    id = String(id || "").trim();
    if (id === n.id) return true;
    if (!NODE_ID.test(id)) { toast("An id is a lowercase letter, then letters, digits or _ (at most 32).", "err"); return false; }
    if (byId(id)) { toast(`“${id}” is taken.`, "err"); return false; }
    snapshot();
    for (const e of S.graph.edges) { if (e.from.node === n.id) e.from.node = id; if (e.to.node === n.id) e.to.node = id; }
    if (S.sel.nodes.delete(n.id)) S.sel.nodes.add(id);
    n.id = id;
    drawAll(); drawSide(); changed();
    return true;
  }

  /** Top to bottom by the flow (Start first), left to right inside a row. */
  function arrange() {
    if (!S.graph.nodes.length) return;
    snapshot();
    const nodes = S.graph.nodes;
    const flow = S.graph.edges.filter((e) => e.kind === "flow");
    const incoming = new Set(flow.map((e) => e.to.node));
    const depth = new Map();
    const roots = [...nodes.filter((n) => n.type === "start"), ...nodes.filter((n) => n.type !== "start" && !incoming.has(n.id))];
    if (!roots.length) roots.push(nodes[0]);
    const queue = [];
    for (const r of roots) if (!depth.has(r.id)) { depth.set(r.id, 0); queue.push(r.id); }
    while (queue.length) {
      const id = queue.shift();
      for (const e of flow) if (e.from.node === id && !depth.has(e.to.node)) { depth.set(e.to.node, depth.get(id) + 1); queue.push(e.to.node); }
    }
    let max = Math.max(0, ...depth.values());
    for (const n of nodes) if (!depth.has(n.id)) depth.set(n.id, ++max);
    const rows = new Map();
    for (const n of nodes) { const d = depth.get(n.id); if (!rows.has(d)) rows.set(d, []); rows.get(d).push(n); }
    const xOf = new Map();
    let y = 40;
    for (const d of [...rows.keys()].sort((a, b) => a - b)) {
      const row = rows.get(d);
      const bary = (n) => { const ps = flow.filter((e) => e.to.node === n.id && xOf.has(e.from.node)).map((e) => xOf.get(e.from.node)); return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : Infinity; };
      row.sort((a, b) => bary(a) - bary(b) || a.x - b.x);
      const widths = row.map((n) => geo(n).w);
      const total = widths.reduce((a, b) => a + b, 0) + (row.length - 1) * 70;
      let x = snapTo(-total / 2);
      let tallest = 0;
      row.forEach((n, i) => { n.x = x; n.y = y; xOf.set(n.id, x + widths[i] / 2); x = snapTo(x + widths[i] + 70); tallest = Math.max(tallest, geo(n).h); });
      y = snapTo(y + tallest + 90);
    }
    drawAll(); changed(); fit();
  }

  /* ----------------------------------------------------------- keyboard */

  function onKey(e) {
    if (!S || S.dialog) return;
    const k = e.key || "";
    const lk = k.length === 1 ? k.toLowerCase() : k;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && lk === "s") { e.preventDefault(); saveDraft(); return; }
    if (k === "Escape") {
      if (S.quick) { e.preventDefault(); closeQuick(); S.els.stage.focus(); return; }
      if (S.pending || S.wire) { e.preventDefault(); cancelPending(); return; }
      if (isTyping(e.target)) { e.target.blur(); S.els.stage.focus({ preventScroll: true }); return; }
      if (S.sel.nodes.size || S.sel.edge) { e.preventDefault(); clearSelection(); }
      return;
    }
    if (isTyping(e.target)) return;
    if (!mod && !e.altKey && /^[0-9*#]$/.test(k) && simListening()) { e.preventDefault(); simPress(k); return; }
    const port = e.target.closest && e.target.closest(".tsa-port");
    if (port && (k === "Enter" || k === " ")) { e.preventDefault(); const ne = port.closest(".tsa-node"); portClick(ne.dataset.id, port.dataset.port); return; }
    const nodeFocus = e.target.closest && e.target.closest(".tsa-node");
    if (nodeFocus && (k === "Enter" || k === " ")) { e.preventDefault(); const id = nodeFocus.dataset.id; selectOnly(id); const el = S.els.nodes.get(id); if (el) el.focus({ preventScroll: true }); return; }
    if (e.target.closest && e.target.closest("button, a, summary, [role=button]") && (k === "Enter" || k === " ")) return;
    if (k === "Delete" || k === "Backspace") { if (S.sel.nodes.size || S.sel.edge) { e.preventDefault(); removeSelection(); } return; }
    if (mod && lk === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && lk === "y") { e.preventDefault(); redo(); return; }
    if (mod && lk === "a") { e.preventDefault(); selectAll(); return; }
    if (mod && lk === "x") { e.preventDefault(); if (copySelection()) removeSelection(); return; }
    if (e.altKey) return;
    if (lk === "c") { if (copySelection()) e.preventDefault(); return; }
    if (lk === "v") { e.preventDefault(); paste(); return; }
    if (lk === "d") { e.preventDefault(); duplicateSelection(); return; }
    if (mod) return;
    if (lk === "a") { e.preventDefault(); fit(); return; }
    if (k === "+" || k === "=") { e.preventDefault(); zoomBy(1.2); return; }
    if (k === "-" || k === "_") { e.preventDefault(); zoomBy(1 / 1.2); return; }
    if (k === "0") { e.preventDefault(); zoomTo(1); return; }
    if (k === "?") { e.preventDefault(); shortcuts(); return; }
    if (k === " " && !e.repeat) { S.space = true; S.els.stage.classList.add("is-space"); if (e.target === S.els.stage) e.preventDefault(); return; }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[k]) {
      e.preventDefault();
      const [x, y] = arrows[k];
      if (S.sel.nodes.size) { const step = e.shiftKey ? GRID * 5 : GRID; nudge(x * step, y * step); }
      else { S.cam.x -= x * 60; S.cam.y -= y * 60; applyCam(); }
    }
  }

  function shortcuts() {
    const rows = [
      ["Delete / Backspace", "remove the selected tools or wire"], ["Ctrl/⌘ + Z, Ctrl/⌘ + Y", "undo, redo (also Ctrl/⌘ + Shift + Z)"],
      ["C, V", "copy, paste (works across TSAs in this browser)"], ["D", "duplicate the selection"], ["Ctrl/⌘ + X", "cut"],
      ["A", "fit everything"], ["Ctrl/⌘ + A", "select all"], ["Arrows", "nudge the selection by 10 px (Shift: 50 px); with nothing selected, pan"],
      ["+ / − / 0", "zoom in, out, 100 %"], ["Ctrl/⌘ + wheel", "zoom at the pointer (wheel alone pans)"], ["Space + drag", "pan"],
      ["Shift + drag", "select with a rectangle (or switch the background drag in the corner)"], ["Shift / Ctrl / ⌘ + click", "add to or remove from the selection"],
      ["Enter on a port", "pick it, then Enter on another port to wire them"], ["Esc", "cancel a wire, close the tool search, clear the selection"],
      ["Ctrl/⌘ + S", "save the draft"], ["0–9 * #", "dial in the simulator while it waits for digits"], ["Double-click the canvas", "add a tool there"],
    ];
    void dialog({ title: "Keyboard shortcuts", wide: true, body: h("table", { class: "tsa-keys" }, h("tbody", {}, rows.map(([a, b]) => h("tr", {}, h("th", {}, h("kbd", {}, a)), h("td", {}, b))))), buttons: [{ label: "Close", value: true, tone: "primary" }], cancel: true });
  }

  /* ========================================================= side panel */

  function showSide(tab) {
    S.side = tab;
    if (!S.showSide) { S.showSide = true; S.els.body.classList.remove("no-side"); }
    drawSide();
  }

  function drawSide() {
    if (!S) return;
    const side = S.els.side;
    clear(side);
    S.formulaRefresh = new Map();
    S.refreshOutputs = null;
    const tabs = h("div", { class: "tsa-tabs", role: "tablist", "aria-label": "Side panel" });
    for (const [id, label, ic] of [["inspect", "Inspector", "sliders-horizontal"], ["sim", "Simulator", "phone-call"]]) {
      const on = S.side === id;
      tabs.append(h("button", { type: "button", role: "tab", class: `tsa-tab${on ? " is-on" : ""}`, "aria-selected": String(on), "data-testid": `tsa-tab-${id}`, onclick: () => { S.side = id; drawSide(); } },
        icon(ic), label, id === "sim" && S.sim.session && !S.sim.ended ? h("span", { class: "tsa-live-dot", "aria-label": "a call is running" }) : null));
    }
    const body = h("div", { class: "tsa-side__body", role: "tabpanel" });
    side.append(tabs, body);
    if (S.side === "sim") { drawSim(body); return; }
    const one = S.sel.nodes.size === 1 ? byId([...S.sel.nodes][0]) : null;
    if (S.sel.edge) edgeInspector(body);
    else if (S.sel.nodes.size > 1) multiInspector(body);
    else if (one) nodeInspector(body, one);
    else tsaInspector(body);
  }

  /** Re-draws the side panel without losing the field being typed in. */
  function drawSideKeepingFocus() {
    const a = document.activeElement;
    const key = a && S.els.side.contains(a) ? a.getAttribute("data-focus-key") : null;
    const range = key && typeof a.selectionStart === "number" ? [a.selectionStart, a.selectionEnd] : null;
    drawSide();
    if (!key) return;
    const el = [...S.els.side.querySelectorAll("[data-focus-key]")].find((x) => x.getAttribute("data-focus-key") === key);
    if (!el) return;
    el.focus({ preventScroll: true });
    if (range && el.setSelectionRange) { try { el.setSelectionRange(range[0], range[1]); } catch { /* not a text field */ } }
  }

  const sec = (title, ...children) => h("section", { class: "tsa-sec" }, h("h3", { class: "tsa-sec__h" }, title), ...children);
  const field = (label, control, help, extra) => h("div", { class: "tsa-f" }, h("label", { class: "tsa-f__label", for: control.id || undefined }, label), control, extra || null, help ? h("div", { class: "tsa-f__help" }, help) : null);

  function sideHead(ic, accent, title, sub, extra) {
    return h("div", { class: `tsa-insp__head tsa-acc--${accent}` }, h("span", { class: "tsa-insp__icon" }, icon(ic)), h("div", { class: "tsa-insp__titles" }, h("strong", {}, title), sub ? h("span", { class: "muted small" }, sub) : null), extra || null);
  }

  function problemList(list) {
    if (!list.length) return null;
    return h("ul", { class: "tsa-insp__probs" }, list.map((p) => h("li", { class: `tsa-prob-line tsa-prob-line--${p.level}` }, icon(p.level === "error" ? "circle-x" : "triangle-alert"), h("span", {}, p.port ? h("code", {}, p.port) : null, p.port ? " " : null, p.message))));
  }

  /* -------------------------------------------------------- the TSA */

  function tsaInspector(body) {
    const t = S.tsa;
    const name = h("input", { class: "input input--sm", id: "tsaInspName", value: S.name, "data-focus-key": "tsa:name", maxlength: "120" });
    name.addEventListener("input", () => { snapshot("name"); S.name = name.value; const top = S.els.top.querySelector('[data-testid="tsa-name"]'); if (top) top.value = S.name; changed(); });
    const desc = h("textarea", { class: "input input--sm", id: "tsaInspDesc", rows: "3", "data-focus-key": "tsa:desc", maxlength: "500" });
    desc.value = S.description;
    desc.addEventListener("input", () => { snapshot("desc"); S.description = desc.value; const top = S.els.top.querySelector('[data-testid="tsa-desc"]'); if (top) top.value = S.description; changed(); });
    const tags = h("input", { class: "input input--sm", id: "tsaInspTags", value: S.tags.join(", "), placeholder: "ivr, support, after-hours", "data-focus-key": "tsa:tags" });
    tags.addEventListener("input", () => { snapshot("tags"); S.tags = tags.value.split(",").map((x) => x.trim()).filter(Boolean); changed(); });
    for (const el of [name, desc, tags]) el.addEventListener("blur", () => { S.histTag = null; });
    const errs = S.problems.filter((p) => p.level === "error").length, warns = S.problems.length - errs;
    const pub = t.published;
    body.append(
      sideHead("workflow", "primary", S.name || S.id, `TSA · ${S.id}`),
      sec("Application", field("Name", name), field("Description", desc), field("Tags", tags, "Comma separated — for finding it in the list.")),
      sec("State",
        h("dl", { class: "tsa-dl" },
          h("dt", {}, "Draft"), h("dd", {}, isDirty() ? "unsaved changes" : `saved ${when(t.updatedAt)}${t.updatedBy ? ` by ${t.updatedBy}` : ""}`),
          h("dt", {}, "Published"), h("dd", {}, pub ? `version ${pub.version} · ${when(pub.at)}${pub.by ? ` by ${pub.by}` : ""}` : "never — calls cannot run it yet"),
          h("dt", {}, "Tools"), h("dd", {}, `${S.graph.nodes.length} / ${LIMITS.nodes}`),
          h("dt", {}, "Wires"), h("dd", {}, `${S.graph.edges.length} / ${LIMITS.edges}`),
          h("dt", {}, "Problems"), h("dd", {}, errs || warns ? `${plural(errs, "error")}, ${plural(warns, "warning")}` : "none"))),
      sec("How to",
        h("ul", { class: "tsa-help" },
          h("li", {}, "Drag a tool from the left onto the canvas, or click it (Enter) to add it in the middle."),
          h("li", {}, "Control flows from an output on a tool's bottom edge to the next tool's ", h("strong", {}, "in"), " on its left — one wire per output."),
          h("li", {}, "Values flow from a data output (right edge) to an input on the top edge — IN1, IN2… or KEY. A Condition's formula and a TTS's text use them as IN1… / {IN1}."),
          h("li", {}, "+ / − above a tool adds or removes inputs. Drag a wired input to move its wire; drop it on the canvas to remove it."),
          h("li", {}, "Problems are checked as you edit; Publish needs none. Simulate calls the draft in the browser."))),
      h("button", { type: "button", class: "btn btn--sm", onclick: () => shortcuts() }, icon("keyboard"), "Keyboard shortcuts"));
  }

  /* -------------------------------------------------------- a node */

  function nodeInspector(body, n) {
    const t = toolOf(n.type);
    const probs = S.problems.filter((p) => p.node === n.id);
    body.append(sideHead(t ? t.icon : "circle-alert", t ? t.accent : "danger", t ? t.label : `Unknown tool ${n.type}`, `${n.type} · ${n.id}`,
      h("button", { type: "button", class: "btn btn--xs btn--ghost tsa-icon-btn", "data-tip": "Show it on the canvas", "aria-label": "Show it on the canvas", onclick: () => centerOnNode(n.id) }, icon("locate-fixed"))));
    if (!t) { body.append(h("p", { class: "err small" }, "This tool is not in the server's palette — an older or newer TSA. It is kept as it is; remove or replace it.")); }
    if (t && t.help) body.append(h("details", { class: "tsa-about" }, h("summary", {}, "About this tool"), h("p", {}, t.help)));
    if (probs.length) body.append(problemList(probs));

    const label = h("input", { class: "input input--sm", id: "tsaNodeLabel", value: n.label || "", placeholder: t ? t.label : n.type, "data-focus-key": "node:label", "data-testid": "tsa-node-label", maxlength: "80" });
    label.addEventListener("input", () => { snapshot(`label:${n.id}`); n.label = label.value; if (!n.label) delete n.label; redrawNode(n); drawWires(); changed(); });
    const nid = h("input", { class: "input input--sm mono", id: "tsaNodeId", value: n.id, "data-focus-key": "node:id", spellcheck: "false", maxlength: "32" });
    nid.addEventListener("change", () => { if (!renameNode(n, nid.value)) nid.value = n.id; });
    const note = h("textarea", { class: "input input--sm", id: "tsaNodeNote", rows: "2", placeholder: "For the next person who edits this (never runs).", "data-focus-key": "node:note", maxlength: "2000" });
    note.value = n.note || "";
    note.addEventListener("input", () => { snapshot(`note:${n.id}`); n.note = note.value; if (!n.note) delete n.note; redrawNode(n); changed(); });
    for (const el of [label, note]) el.addEventListener("blur", () => { S.histTag = null; });
    body.append(sec("Tool", field("Label on the canvas", label), field("Id", nid, "Used by the log and the trace. Wires follow a rename."), field("Note", note)));

    // inputs
    const ins = dataInputs(n);
    if (t && (t.dynamicInputs || ins.length)) {
      const box = sec("Data inputs");
      if (t.dynamicInputs) {
        const d = t.dynamicInputs, cnt = inputCount(n), max = Math.min(d.max, LIMITS.dynamicInputs || 100);
        box.append(h("div", { class: "tsa-count", role: "group", "aria-label": "Number of IN inputs" },
          h("button", { type: "button", class: "btn btn--xs tsa-icon-btn", "aria-label": "One input less", "data-testid": "tsa-insp-in-minus", disabled: cnt <= d.min || undefined, onclick: () => setInputs(n, cnt - 1) }, icon("minus")),
          h("strong", { class: "tsa-count__n", "data-testid": "tsa-insp-in-count" }, String(cnt)),
          h("button", { type: "button", class: "btn btn--xs tsa-icon-btn", "aria-label": "One input more", "data-testid": "tsa-insp-in-plus", disabled: cnt >= max || undefined, onclick: () => setInputs(n, cnt + 1) }, icon("plus")),
          h("span", { class: "muted small" }, `IN inputs (${d.min}–${max})`)));
      }
      const list = h("ul", { class: "tsa-ports" });
      for (const p of ins) {
        const e = edgeInto(n.id, p.port);
        const src = e && byId(e.from.node);
        list.append(h("li", { class: "tsa-ports__row" },
          h("code", { class: "tsa-ports__name tsa-ports__name--data" }, p.port),
          e ? h("button", { type: "button", class: "tsa-link", onclick: () => { selectOnly(e.from.node); centerOnNode(e.from.node); } }, `← ${titleOf(src)} · ${e.from.port}`) : h("span", { class: "muted small" }, p.help || "not wired"),
          h("span", { class: "tsa-grow" }),
          e ? h("button", { type: "button", class: "btn btn--xs btn--ghost tsa-icon-btn", "aria-label": `Remove the wire into ${p.port}`, "data-tip": "Remove the wire", onclick: () => { snapshot(); S.graph.edges = S.graph.edges.filter((x) => x !== e); drawNodes(); drawWires(); drawSide(); changed(); } }, icon("x"))
            : h("button", { type: "button", class: "btn btn--xs", "data-tip": "Pick this input, then a data output on the canvas", onclick: () => { portClick(n.id, p.port); } }, "Wire…")));
      }
      if (ins.length) box.append(list);
      body.append(box);
    }

    // parameters
    const params = (t && t.params) || [];
    if (params.length) {
      const box = sec("Settings");
      let hidden = 0;
      for (const p of params) { if (paramVisible(n, p)) box.append(paramField(n, p)); else hidden++; }
      if (hidden) box.append(h("p", { class: "muted small" }, `${plural(hidden, "more setting")} appear${hidden === 1 ? "s" : ""} with other choices above.`));
      body.append(box);
    }

    // outputs
    const outBox = sec("Outputs");
    fillOutputs(outBox, n);
    body.append(outBox);
    S.refreshOutputs = () => { clear(outBox); outBox.append(h("h3", { class: "tsa-sec__h" }, "Outputs")); fillOutputs(outBox, n); };

    body.append(h("div", { class: "tsa-actions" },
      h("button", { type: "button", class: "btn btn--sm", onclick: () => duplicateSelection() }, icon("copy"), "Duplicate"),
      h("button", { type: "button", class: "btn btn--sm btn--danger", "data-testid": "tsa-node-delete", onclick: () => removeSelection() }, icon("trash-2"), "Delete")));
  }

  function fillOutputs(box, n) {
    const outs = flowOutputs(n), douts = dataOutputs(n);
    if (!outs.length && !douts.length && !hasFlowIn(n)) { box.append(h("p", { class: "muted small" }, "No outputs.")); return; }
    if (!outs.length && !douts.length) { box.append(h("p", { class: "muted small" }, "The flow ends here.")); return; }
    const list = h("ul", { class: "tsa-ports" });
    for (const p of outs) {
      const e = edgeFrom(n.id, p.port);
      const dst = e && byId(e.to.node);
      list.append(h("li", { class: "tsa-ports__row" },
        h("code", { class: `tsa-ports__name tsa-tone--${portTone(p.port)}`, title: p.help || "" }, p.port), p.label && p.label !== p.port ? h("span", { class: "muted small" }, `“${p.label}”`) : null,
        e ? h("button", { type: "button", class: "tsa-link", onclick: () => { selectOnly(e.to.node); centerOnNode(e.to.node); } }, `→ ${titleOf(dst)}`) : h("span", { class: "muted small" }, "not wired — the path ends here"),
        h("span", { class: "tsa-grow" }),
        h("button", { type: "button", class: "btn btn--xs", "data-tip": "Pick this output, then a tool's “in” on the canvas", onclick: () => portClick(n.id, p.port) }, e ? "Rewire…" : "Wire…")));
    }
    for (const p of douts) {
      const cnt = S.graph.edges.filter((e) => e.from.node === n.id && e.from.port === p.port).length;
      list.append(h("li", { class: "tsa-ports__row" }, h("code", { class: "tsa-ports__name tsa-ports__name--data" }, p.port), h("span", { class: "muted small" }, cnt ? `→ ${plural(cnt, "input")}` : "data, not used"), h("span", { class: "tsa-grow" }),
        h("button", { type: "button", class: "btn btn--xs", "data-tip": "Pick this data output, then an input on the canvas", onclick: () => portClick(n.id, p.port) }, "Wire…")));
    }
    box.append(list);
  }

  /* -------------------------------------------------------- parameters */

  const KEY_OPTIONS = [{ value: "#", label: "# (hash)" }, { value: "*", label: "* (star)" }, { value: "none", label: "none — the count or the timeout ends it" }, { value: "any", label: "any key" }];
  const TELEPHONY_VOICES = ["woman", "man", "alice", "Polly.Joanna-Neural", "Polly.Matthew-Neural", "Polly.Amy-Neural", "Polly.Vicki-Neural", "Google.cs-CZ-Standard-A", "Google.cs-CZ-Wavenet-A", "Google.sk-SK-Standard-A", "Google.en-US-Neural2-F", "Google.de-DE-Neural2-B"];
  const FORMULA_FNS = ["len", "int", "num", "str", "lower", "upper", "trim", "contains", "startswith", "endswith", "digits", "substr", "replace", "min", "max", "abs", "round", "now", "hour", "weekday", "random", "get"];

  function setParam(n, key, value, opts = {}) {
    const t = toolOf(n.type);
    snapshot(opts.tag === null ? undefined : opts.tag || `p:${n.id}:${key}`);
    const oldRows = opts.oldRows || (Array.isArray(n.params[key]) ? [...n.params[key]] : []);
    if (value === undefined) delete n.params[key]; else n.params[key] = value;
    if (t && t.dynamicFlowOut && t.dynamicFlowOut.param === key) {
      remapCaseEdges(n, oldRows, opts.newRows || (Array.isArray(value) ? value : []), opts.rowMap);
      if (S.refreshOutputs) S.refreshOutputs();
    }
    redrawNode(n);
    drawWires();
    changed();
    const drives = t && (t.params || []).some((p) => p.when && Object.prototype.hasOwnProperty.call(p.when, key));
    if (drives || opts.redraw) drawSideKeepingFocus();
  }

  /** A Switch's case outputs follow their rows: renamed rows keep their wires, removed rows drop them, moved rows take them along. */
  function remapCaseEdges(n, oldRows, newRows, rowMap) {
    const t = toolOf(n.type);
    const prefix = t.dynamicFlowOut.prefix;
    const numbering = (rows) => { const m = new Map(); let k = 0; (rows || []).forEach((v, i) => { if (String(v).trim() !== "") m.set(i, ++k); }); return m; };
    const before = numbering(oldRows), after = numbering(newRows);
    const portMap = new Map();
    for (const [row, k] of before) {
      const nr = rowMap ? rowMap[row] : row;
      portMap.set(`${prefix}${k}`, nr !== undefined && nr >= 0 && after.has(nr) ? `${prefix}${after.get(nr)}` : null);
    }
    const out = [];
    for (const e of S.graph.edges) {
      if (e.from.node === n.id && portMap.has(e.from.port)) {
        const np = portMap.get(e.from.port);
        if (np) out.push({ ...e, from: { node: e.from.node, port: np } });
      } else out.push(e);
    }
    S.graph.edges = out;
  }

  function feedbackEl() { return h("div", { class: "tsa-f__fb", role: "status", "aria-live": "polite" }); }
  function setFeedback(el, items) {
    clear(el);
    const list = items.filter(Boolean);
    el.hidden = !list.length;
    for (const it of list) el.append(h("div", { class: `tsa-fb tsa-fb--${it.level}` }, icon(it.level === "error" ? "circle-x" : it.level === "ok" ? "circle-check" : "triangle-alert"), h("span", {}, it.message)));
  }
  /** The server's problems for one parameter (by port or by its key / label in the message). */
  function serverFeedback(n, p) {
    return S.problems.filter((x) => x.node === n.id && (x.port === p.key || new RegExp(`\\b${p.key}\\b`, "i").test(x.message) || (p.label && x.message.toLowerCase().includes(p.label.toLowerCase())))).map((x) => ({ level: x.level === "error" ? "error" : "warning", message: x.message }));
  }

  function chip(text, title, onclick) { return h("button", { type: "button", class: "tsa-ref", title, onclick }, text); }
  function insertAtCaret(el, text) {
    const a = el.selectionStart ?? el.value.length, b = el.selectionEnd ?? a;
    el.value = el.value.slice(0, a) + text + el.value.slice(b);
    el.focus();
    try { el.setSelectionRange(a + text.length, a + text.length); } catch { /* not a text field */ }
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  /** {IN1}… / IN1… / $vars / call.* buttons that insert into a field. */
  function refChips(n, el, style) {
    const box = h("div", { class: "tsa-refs", "aria-label": "Insert" });
    const cnt = dataInputs(n).filter((p) => p.dynamic).length;
    const shown = Math.min(cnt, 10);
    for (let i = 1; i <= shown; i++) box.append(chip(style === "template" ? `{IN${i}}` : `IN${i}`, `Input IN${i}`, () => insertAtCaret(el, style === "template" ? `{IN${i}}` : `IN${i}`)));
    if (cnt > shown) box.append(h("span", { class: "muted small" }, `… IN${cnt}`));
    for (const p of dataInputs(n).filter((x) => !x.dynamic)) box.append(chip(style === "template" ? `{${p.port}}` : p.port, p.help || p.port, () => insertAtCaret(el, style === "template" ? `{${p.port}}` : p.port)));
    const vars = [...new Set(S.graph.nodes.filter((x) => x.type === "set" && x.params && x.params.name).map((x) => String(x.params.name)))].slice(0, 8);
    for (const v of vars) box.append(chip(style === "template" ? `{$${v}}` : `$${v}`, `The variable $${v}`, () => insertAtCaret(el, style === "template" ? `{$${v}}` : `$${v}`)));
    for (const c of ["call.from", "call.to", "call.did"]) box.append(chip(style === "template" ? `{${c}}` : c, "The call", () => insertAtCaret(el, style === "template" ? `{${c}}` : c)));
    if (!cnt && t0(n).dynamicInputs) box.prepend(h("span", { class: "muted small" }, "No inputs yet — add IN1 with + ."));
    return box;
  }
  const t0 = (n) => toolOf(n.type) || {};

  function paramField(n, p) {
    const v = paramVal(n, p);
    const id = `tsaP_${p.key}`;
    const base = { id, "data-focus-key": `p:${p.key}`, "data-testid": `tsa-param-${p.key}`, "aria-describedby": p.help ? `${id}_help` : undefined };
    const help = p.help ? h("div", { class: "tsa-f__help", id: `${id}_help` }, p.help) : null;
    const lbl = h("label", { class: "tsa-f__label", for: id }, p.label, p.required ? h("span", { class: "tsa-req", title: "required" }, " *") : null);
    const wrap = (...kids) => h("div", { class: `tsa-f tsa-f--${p.kind}`, "data-param": p.key }, ...kids);
    const fb = feedbackEl();
    const blur = (el) => el.addEventListener("blur", () => { S.histTag = null; });

    switch (p.kind) {
      case "bool": {
        const cb = h("input", { type: "checkbox", ...base, checked: v === true || undefined });
        cb.addEventListener("change", () => setParam(n, p.key, cb.checked, { tag: null }));
        return wrap(h("label", { class: "switch tsa-switch" }, cb, h("span", {}, p.label)), help);
      }
      case "select": case "key": {
        const opts = p.kind === "key" ? KEY_OPTIONS : p.options || [];
        const sel = h("select", { class: "input input--sm", ...base });
        for (const o of opts) sel.append(h("option", { value: o.value, selected: String(v ?? "") === o.value || undefined }, o.label));
        if (v !== undefined && v !== null && !opts.some((o) => o.value === String(v))) sel.append(h("option", { value: String(v), selected: true }, `${v} (not in the list)`));
        sel.addEventListener("change", () => setParam(n, p.key, sel.value, { tag: null }));
        return wrap(lbl, sel, help);
      }
      case "number": {
        const step = p.step ?? (Number.isInteger(p.min ?? 0) && Number.isInteger(p.default ?? 0) ? 1 : "any");
        const inp = h("input", { class: "input input--sm", type: "number", inputmode: "decimal", min: p.min, max: p.max, step, value: v ?? "", placeholder: p.default !== undefined ? String(p.default) : "", ...base });
        const bounds = p.min !== undefined || p.max !== undefined ? h("span", { class: "tsa-f__bounds" }, `${p.min ?? "−∞"} – ${p.max ?? "∞"}${p.default !== undefined ? ` · default ${p.default}` : ""}`) : null;
        const check = () => {
          if (inp.value === "") return { ok: true, value: undefined };
          const num = Number(inp.value);
          if (!Number.isFinite(num)) return { ok: false, message: "Not a number." };
          if ((p.min !== undefined && num < p.min) || (p.max !== undefined && num > p.max)) return { ok: false, message: `Between ${p.min ?? "−∞"} and ${p.max ?? "∞"}.`, value: clamp(num, p.min ?? -Infinity, p.max ?? Infinity) };
          return { ok: true, value: num };
        };
        inp.addEventListener("input", () => {
          const r = check();
          inp.classList.toggle("is-invalid", !r.ok);
          setFeedback(fb, r.ok ? serverFeedback(n, p) : [{ level: "error", message: r.message }]);
          if (r.ok) setParam(n, p.key, r.value);
        });
        inp.addEventListener("change", () => {
          const r = check();
          if (!r.ok && r.value !== undefined) { inp.value = String(r.value); inp.classList.remove("is-invalid"); setFeedback(fb, []); setParam(n, p.key, r.value); }
          S.histTag = null;
        });
        setFeedback(fb, serverFeedback(n, p));
        return wrap(lbl, h("div", { class: "tsa-f__row" }, inp, bounds), fb, help);
      }
      case "textarea": {
        const ta = h("textarea", { class: "input input--sm tsa-ta", rows: String(Math.min(8, Math.max(3, String(v ?? "").split("\n").length + 1))), placeholder: p.placeholder || "", ...base });
        ta.value = v ?? "";
        const count = h("span", { class: "tsa-f__bounds" });
        const refresh = () => { count.textContent = `${ta.value.length} / ${LIMITS.textLength}`; setFeedback(fb, [checkTemplate(ta.value, n), ...serverFeedback(n, p)]); };
        ta.addEventListener("input", () => { setParam(n, p.key, ta.value); refresh(); });
        blur(ta);
        refresh();
        return wrap(lbl, ta, h("div", { class: "tsa-f__row" }, refChips(n, ta, "template"), count), fb, help);
      }
      case "formula": {
        const inp = h("input", { class: "input input--sm mono tsa-formula", spellcheck: "false", autocomplete: "off", value: v ?? "", placeholder: p.placeholder || "", ...base });
        const refresh = () => {
          const local = checkFormula(inp.value, n, p.required);
          const server = serverFeedback(n, p);
          inp.classList.toggle("is-invalid", Boolean((local && local.level === "error") || server.some((x) => x.level === "error")));
          setFeedback(fb, local || server.length ? [local, ...server] : inp.value.trim() ? [{ level: "ok", message: S.checking ? "Checking…" : "Looks right." }] : []);
        };
        inp.addEventListener("input", () => { setParam(n, p.key, inp.value); refresh(); });
        blur(inp);
        refresh();
        S.formulaRefresh.set(`${n.id}:${p.key}`, refresh);
        const fns = h("details", { class: "tsa-fns" }, h("summary", {}, "Functions"), h("div", { class: "tsa-refs" }, FORMULA_FNS.map((f) => chip(`${f}()`, `Insert ${f}(`, () => insertAtCaret(inp, `${f}(`)))),
          h("p", { class: "muted small" }, "Operators: == != < <= > >= + - * / % and or not; texts in \"quotes\"."));
        return wrap(lbl, inp, refChips(n, inp, "formula"), fb, fns, help);
      }
      case "digits": {
        const inp = h("input", { class: "input input--sm mono", spellcheck: "false", value: v ?? "", placeholder: p.placeholder || "", ...base });
        const refresh = () => {
          const ok = /^(?:[0-9*#A-Da-dwW]|\{[^{}]*\})*$/.test(inp.value);
          inp.classList.toggle("is-invalid", !ok);
          setFeedback(fb, [ok ? checkTemplate(inp.value, n) : { level: "error", message: "Dial-pad characters only: 0–9 * # A–D, w (half a second's pause) — or {IN1}." }, ...serverFeedback(n, p)]);
        };
        inp.addEventListener("input", () => { setParam(n, p.key, inp.value); refresh(); });
        blur(inp);
        refresh();
        return wrap(lbl, inp, refChips(n, inp, "template"), fb, help);
      }
      case "list": {
        const rows = Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? v.split("\n") : [];
        return wrap(lbl, listEditor(n, p, rows, base), fb, help);
      }
      case "voice": {
        const listId = `${id}_list`;
        const inp = h("input", { class: "input input--sm", list: listId, value: v ?? "", placeholder: "(the provider's default for the language)", ...base });
        const dl = h("datalist", { id: listId });
        const provider = (n.params || {}).provider ?? (((t0(n).params || []).find((x) => x.key === "provider") || {}).default);
        const note = h("div", { class: "tsa-f__help" });
        if (provider === "ai") {
          note.textContent = "Loading the voices of AI & speech…";
          lookup("voices").then((list) => {
            if (!list) { note.textContent = "The AI & speech voices are not available — type a voice name."; return; }
            for (const o of list) dl.append(h("option", { value: o.value, label: o.label }));
            note.textContent = list.length ? `${plural(list.length, "voice")} of AI & speech (Text to speech models) — or type another.` : "AI & speech has no voices listed — type one.";
          });
        } else {
          for (const vv of TELEPHONY_VOICES) dl.append(h("option", { value: vv }));
          note.textContent = "The call provider's voices (Twilio / Telnyx names; woman / man work everywhere).";
        }
        inp.addEventListener("input", () => setParam(n, p.key, inp.value || undefined));
        blur(inp);
        return wrap(lbl, inp, dl, note, help);
      }
      case "tsa": case "trunk": case "model": {
        const sel = h("select", { class: "input input--sm", ...base, disabled: true }, h("option", { value: v ?? "" }, v ? `${v} (loading…)` : "loading…"));
        const box = h("div", { class: "tsa-f__async" }, sel);
        const what = { tsa: "TSA", trunk: "SIP trunk", model: "Functions model" }[p.kind];
        lookup(p.kind).then((list) => {
          if (!S || !box.isConnected) return;
          if (!list) {
            const inp = h("input", { class: "input input--sm mono", value: v ?? "", placeholder: `the ${what}'s id`, ...base });
            inp.addEventListener("input", () => setParam(n, p.key, inp.value || undefined));
            blur(inp);
            clear(box); box.append(inp, h("div", { class: "tsa-f__help" }, `The list of ${what}s is not available — type the id.`));
            return;
          }
          clear(sel);
          sel.disabled = false;
          sel.append(h("option", { value: "" }, `(choose a ${what})`));
          for (const o of list) sel.append(h("option", { value: o.value, selected: o.value === v || undefined }, o.label));
          if (v && !list.some((o) => o.value === v)) sel.append(h("option", { value: v, selected: true }, `${v} (not found)`));
          if (!list.length) box.append(h("div", { class: "tsa-f__help" }, `No ${what} exists yet.`));
        });
        sel.addEventListener("change", () => setParam(n, p.key, sel.value || undefined, { tag: null }));
        return wrap(lbl, box, help);
      }
      default: {
        const inp = h("input", { class: "input input--sm", value: v ?? "", placeholder: p.placeholder || "", ...base });
        const templ = /\{IN|\{\$|\{call\./.test(`${p.placeholder || ""} ${p.help || ""}`) || ["to", "url", "code", "room", "text"].includes(p.key);
        const refresh = () => setFeedback(fb, [templ ? checkTemplate(inp.value, n) : null, ...serverFeedback(n, p), p.required && !inp.value.trim() ? { level: "error", message: "Required." } : null]);
        inp.addEventListener("input", () => { setParam(n, p.key, inp.value); refresh(); });
        blur(inp);
        refresh();
        return wrap(lbl, inp, templ ? refChips(n, inp, "template") : null, fb, help);
      }
    }
  }

  /** One string per row: add, edit, move, remove (a Switch's rows are its case outputs). */
  function listEditor(n, p, initial, base) {
    let rows = [...initial];
    /** The rows as the graph has them — a row emptied while retyping it is not committed (its wire stays) until the field is left. */
    let committed = [...initial];
    const box = h("div", { class: "tsa-list", "data-testid": base["data-testid"], role: "group", "aria-label": p.label });
    const commit = (_old, map) => {
      const value = rows.filter((r) => r.trim() !== "");
      setParam(n, p.key, value, { oldRows: committed, newRows: [...rows], rowMap: map });
      committed = [...rows];
    };
    const draw = (focus) => {
      clear(box);
      rows.forEach((val, i) => {
        const inp = h("input", { class: "input input--sm", value: val, "aria-label": `${p.label} ${i + 1}`, "data-focus-key": `p:${p.key}:${i}`, "data-row": String(i) });
        inp.addEventListener("input", () => { rows[i] = inp.value; if (inp.value.trim() === "" && String(committed[i] ?? "").trim() !== "") return; commit(null, null); });
        inp.addEventListener("blur", () => { if (S && rows[i] !== committed[i] && box.isConnected) commit(null, null); if (S) S.histTag = null; });
        inp.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); add(i + 1); }
          else if (e.key === "Backspace" && inp.value === "" && rows.length) { e.preventDefault(); remove(i, Math.max(0, i - 1)); }
        });
        const move = (d) => {
          const j = i + d;
          if (j < 0 || j >= rows.length) return;
          const old = [...rows];
          [rows[i], rows[j]] = [rows[j], rows[i]];
          const map = old.map((_, k) => (k === i ? j : k === j ? i : k));
          S.histTag = null; commit(old, map); draw(j);
        };
        box.append(h("div", { class: "tsa-list__row" },
          h("span", { class: "tsa-list__n", "aria-hidden": "true" }, String(i + 1)), inp,
          h("button", { type: "button", class: "btn btn--xs btn--ghost tsa-icon-btn", "aria-label": `Move ${i + 1} up`, disabled: i === 0 || undefined, onclick: () => move(-1) }, icon("chevron-down", "ico tsa-rot180")),
          h("button", { type: "button", class: "btn btn--xs btn--ghost tsa-icon-btn", "aria-label": `Move ${i + 1} down`, disabled: i === rows.length - 1 || undefined, onclick: () => move(1) }, icon("chevron-down")),
          h("button", { type: "button", class: "btn btn--xs btn--ghost tsa-icon-btn", "aria-label": `Remove ${i + 1}`, onclick: () => remove(i, i) }, icon("x"))));
      });
      box.append(h("button", { type: "button", class: "btn btn--xs tsa-list__add", "data-testid": `${base["data-testid"]}-add`, onclick: () => add(rows.length) }, icon("plus"), "Add"));
      if (focus !== undefined) { const el = box.querySelector(`[data-row="${focus}"]`); if (el) el.focus(); }
    };
    const add = (at) => { const old = [...rows]; rows.splice(at, 0, ""); const map = old.map((_, k) => (k < at ? k : k + 1)); S.histTag = null; commit(old, map); draw(at); };
    const remove = (i, focus) => { const old = [...rows]; rows.splice(i, 1); const map = old.map((_, k) => (k < i ? k : k === i ? -1 : k - 1)); S.histTag = null; commit(old, map); draw(rows.length ? Math.min(focus, rows.length - 1) : undefined); };
    draw();
    return box;
  }

  /** Lists for the pickers (each asked once per editor). */
  function lookup(kind) {
    if (S.lookups[kind]) return S.lookups[kind];
    const p = (async () => {
      try {
        if (kind === "tsa") {
          const r = await api("/admin/telephony/tsa");
          const list = Array.isArray(r) ? r : r.tsa || r.items || r.list || r.tsas || [];
          return list.map((x) => ({ value: x.id, label: `${x.name || x.id} (${x.id})${x.id === S.id ? " — this TSA" : ""}${x.published === false ? " · not published" : ""}` }));
        }
        if (kind === "trunk") {
          const r = await api("/admin/telephony/sip/trunks");
          return (r.trunks || []).map((x) => ({ value: x.id, label: `${x.label || x.id} — ${x.host || "?"}${x.port ? `:${x.port}` : ""}` }));
        }
        if (kind === "model") {
          const r = await api("/admin/functions");
          return (r.models || []).map((m) => ({ value: m.id, label: `${m.name || m.id}${m.enabled === false ? " (off)" : ""}` }));
        }
        if (kind === "voices") {
          const r = await api("/admin/ai");
          const out = [];
          const seen = new Set();
          if (r.defaults && r.defaults.voice) { out.push({ value: r.defaults.voice, label: "the console's default voice" }); seen.add(r.defaults.voice); }
          for (const pr of r.providers || []) for (const m of pr.models || []) {
            if (m.kind !== "tts") continue;
            for (const vo of m.voices || []) {
              const val = typeof vo === "string" ? vo : vo && (vo.id || vo.name);
              if (!val || seen.has(val)) continue;
              seen.add(val);
              out.push({ value: val, label: `${pr.label || pr.id} · ${m.label || m.id}` });
            }
          }
          return out;
        }
      } catch { return null; }
      return null;
    })();
    S.lookups[kind] = p;
    return p;
  }

  /* -------------------------------------------------------- wires, many */

  function edgeInspector(body) {
    const e = S.graph.edges.find((x) => x.id === S.sel.edge);
    if (!e) { tsaInspector(body); return; }
    const a = byId(e.from.node), b = byId(e.to.node);
    const flow = e.kind === "flow";
    body.append(sideHead(flow ? "workflow" : "variable", flow ? "primary" : "info", flow ? "Flow wire" : "Data wire", e.id),
      problemList(S.problems.filter((p) => p.edge === e.id)) || "",
      sec("Connects",
        h("dl", { class: "tsa-dl" },
          h("dt", {}, "From"), h("dd", {}, h("button", { type: "button", class: "tsa-link", onclick: () => { selectOnly(e.from.node); centerOnNode(e.from.node); } }, titleOf(a)), " · ", h("code", { class: flow ? `tsa-tone--${portTone(e.from.port)}` : "" }, e.from.port)),
          h("dt", {}, "To"), h("dd", {}, h("button", { type: "button", class: "tsa-link", onclick: () => { selectOnly(e.to.node); centerOnNode(e.to.node); } }, titleOf(b)), " · ", h("code", {}, e.to.port))),
        h("p", { class: "muted small" }, flow ? `When ${titleOf(a)} leaves through ${e.from.port}, ${titleOf(b)} runs next.` : `${titleOf(b)} reads ${e.to.port} as the ${e.from.port} that ${titleOf(a)} produced last (empty while it has not run).`)),
      h("div", { class: "tsa-actions" }, h("button", { type: "button", class: "btn btn--sm btn--danger", "data-testid": "tsa-edge-delete", onclick: () => removeSelection() }, icon("trash-2"), "Delete wire")));
  }

  function multiInspector(body) {
    const nodes = S.graph.nodes.filter((n) => S.sel.nodes.has(n.id));
    const align = (key) => { snapshot(); const v = Math.min(...nodes.map((n) => n[key])); for (const n of nodes) n[key] = v; drawAll(); changed(); };
    body.append(sideHead("layers", "primary", `${nodes.length} tools selected`, "Shift / Ctrl / ⌘ + click adds or removes"),
      h("ul", { class: "tsa-ports" }, nodes.map((n) => h("li", { class: "tsa-ports__row" }, h("span", { class: `tsa-pal__icon tsa-acc--${t0(n).accent || "danger"}` }, icon(t0(n).icon || "circle-alert")), h("button", { type: "button", class: "tsa-link", onclick: () => selectOnly(n.id) }, titleOf(n)), h("code", { class: "muted small" }, n.id)))),
      h("div", { class: "tsa-actions" },
        h("button", { type: "button", class: "btn btn--sm", onclick: () => align("x") }, "Align left"),
        h("button", { type: "button", class: "btn btn--sm", onclick: () => align("y") }, "Align top"),
        h("button", { type: "button", class: "btn btn--sm", onclick: () => duplicateSelection() }, icon("copy"), "Duplicate"),
        h("button", { type: "button", class: "btn btn--sm", onclick: () => copySelection() }, "Copy"),
        h("button", { type: "button", class: "btn btn--sm btn--danger", onclick: () => removeSelection() }, icon("trash-2"), "Delete")));
  }

  /* ================================================== changes & problems */

  /** After every edit: state badges, live validation, the local copy, the minimap. */
  function changed() {
    if (!S) return;
    drawTopState();
    S.checking = true;
    setTimeoutS("validate", validateNow, CFG.validateDelay);
    setTimeoutS("autosave", autosave, CFG.autosaveDelay);
    drawMinimap();
  }

  /** POST …/validate with the draft on the canvas (the browser's own checks when the server cannot answer). */
  async function validateNow() {
    if (!S) return;
    const st = S;
    clearTimeout(st.timers.validate);
    const seq = ++st.vSeq;
    st.checking = true;
    drawProblems();
    let problems, source = "server", note = "";
    try {
      const r = await api(`/admin/telephony/tsa/${enc(st.id)}/validate`, { method: "POST", body: { graph: serializeGraph(st.graph) } });
      problems = Array.isArray(r && r.problems) ? r.problems : [];
    } catch (err) {
      problems = localProblems(st.graph);
      source = "local";
      note = err.message;
    }
    if (S !== st || seq !== st.vSeq) return;
    setProblems(problems, source, note);
  }

  function setProblems(list, source, note) {
    S.problems = (list || []).filter((p) => p && p.message).map((p) => ({ level: p.level === "warning" ? "warning" : "error", message: String(p.message), node: p.node || undefined, edge: p.edge || undefined, port: p.port || undefined }));
    S.probSource = source;
    S.probNote = note || "";
    S.checking = false;
    drawNodes();
    drawWires();
    drawProblems();
    drawTopState();
    const a = document.activeElement;
    if (S.side === "inspect" && !(a && S.els.side.contains(a))) drawSide();
    else if (S.formulaRefresh) for (const f of S.formulaRefresh.values()) { try { f(); } catch { /* the field is gone */ } }
  }

  /** What the browser can tell without the server (shown when /validate is not reachable). */
  function localProblems(g) {
    const out = [];
    const starts = g.nodes.filter((n) => n.type === "start");
    if (!starts.length) out.push({ level: "error", message: "There is no Start — every call enters a TSA at its Start." });
    for (const n of starts.slice(1)) out.push({ level: "error", node: n.id, message: "A second Start — a TSA has exactly one." });
    if (g.nodes.length > LIMITS.nodes) out.push({ level: "error", message: `More than ${LIMITS.nodes} tools.` });
    if (g.edges.length > LIMITS.edges) out.push({ level: "error", message: `More than ${LIMITS.edges} wires.` });
    const reached = new Set(g.edges.filter((e) => e.kind === "flow").map((e) => e.to.node));
    for (const n of g.nodes) {
      const t = toolOf(n.type);
      if (!t) { out.push({ level: "error", node: n.id, message: `Unknown tool “${n.type}”.` }); continue; }
      for (const p of t.params || []) {
        if (!paramVisible(n, p)) continue;
        const v = paramVal(n, p);
        const empty = v === undefined || v === null || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && !v.length);
        if (p.required && empty) { out.push({ level: "error", node: n.id, port: p.key, message: `${p.label} is required.` }); continue; }
        if (p.kind === "formula" && !empty) { const c = checkFormula(v, n, p.required); if (c) out.push({ level: c.level, node: n.id, port: p.key, message: `${p.label}: ${c.message}` }); }
        if (p.kind === "number" && typeof v === "number" && ((p.min !== undefined && v < p.min) || (p.max !== undefined && v > p.max))) out.push({ level: "error", node: n.id, port: p.key, message: `${p.label} is out of ${p.min}–${p.max}.` });
      }
      for (const p of t.dataIn || []) if (n.type === "route_audio" && !g.edges.some((e) => e.to.node === n.id && e.to.port === p.port)) out.push({ level: "error", node: n.id, port: p.port, message: `${p.port} is not wired — ${p.help || "it needs a value"}` });
      if (t.flowIn && !reached.has(n.id)) out.push({ level: "warning", node: n.id, port: "in", message: "Nothing leads here — it never runs." });
    }
    const nodes = new Map(g.nodes.map((n) => [n.id, n]));
    for (const e of g.edges) {
      const a = nodes.get(e.from.node), b = nodes.get(e.to.node);
      if (!a || !b || !portKind(a, e.from.port) || !portKind(b, e.to.port)) out.push({ level: "error", edge: e.id, message: `The wire ${describeEdge(e)} ends on a port that is gone.` });
    }
    return out;
  }

  function drawProblems() {
    if (!S) return;
    const box = S.els.probs;
    clear(box);
    const errs = S.problems.filter((p) => p.level === "error"), warns = S.problems.filter((p) => p.level !== "error");
    const open = S.probOpen && S.problems.length > 0;
    box.classList.toggle("is-open", open);
    box.append(h("button", { type: "button", class: "tsa-probs__head", "aria-expanded": String(open), "data-testid": "tsa-problems-head", onclick: () => { S.probOpen = !S.probOpen; drawProblems(); } },
      icon(open ? "chevron-down" : "chevron-right"), h("strong", {}, "Problems"),
      errs.length ? h("span", { class: "tsa-chip tsa-chip--err", "data-testid": "tsa-errors" }, icon("circle-x"), plural(errs.length, "error")) : null,
      warns.length ? h("span", { class: "tsa-chip tsa-chip--warn", "data-testid": "tsa-warnings" }, icon("triangle-alert"), plural(warns.length, "warning")) : null,
      !S.problems.length && !S.checking ? h("span", { class: "tsa-chip tsa-chip--ok" }, icon("circle-check"), "No problems") : null,
      h("span", { class: "tsa-grow" }),
      S.checking ? h("span", { class: "muted small tsa-probs__src" }, h("span", { class: "tsa-spin", "aria-hidden": "true" }), "checking…")
        : h("span", { class: "muted small tsa-probs__src", title: S.probNote }, S.probSource === "local" ? "checked in the browser — the server's check did not answer" : S.probSource ? "checked by the server" : "")));
    if (!open) return;
    const list = h("ul", { class: "tsa-probs__list" });
    for (const p of [...errs, ...warns]) {
      const n = p.node && byId(p.node);
      list.append(h("li", {}, h("button", { type: "button", class: `tsa-prob tsa-prob--${p.level}`, "data-testid": "tsa-problem", onclick: () => focusProblem(p) },
        icon(p.level === "error" ? "circle-x" : "triangle-alert"),
        h("span", { class: "tsa-prob__msg" }, p.message),
        n ? h("span", { class: "tsa-prob__where" }, titleOf(n), p.port ? ` · ${p.port}` : "") : p.edge ? h("span", { class: "tsa-prob__where" }, `wire ${p.edge}`) : null)));
    }
    box.append(list);
  }

  function focusProblem(p) {
    S.side = "inspect";
    if (p.node && byId(p.node)) {
      selectOnly(p.node);
      centerOnNode(p.node);
      const el = S.els.nodes.get(p.node);
      if (el) el.focus({ preventScroll: true });
      const f = p.port && [...S.els.side.querySelectorAll("[data-param]")].find((x) => x.dataset.param === p.port);
      if (f) { const inp = f.querySelector("input, textarea, select"); if (inp) inp.focus({ preventScroll: true }); }
    } else if (p.edge) {
      const e = S.graph.edges.find((x) => x.id === p.edge);
      if (!e) { drawSide(); return; }
      selectEdge(e.id);
      const a = portPos(byId(e.from.node), e.from.port), b = portPos(byId(e.to.node), e.to.port);
      if (a && b) centerOn((a.x + b.x) / 2, (a.y + b.y) / 2);
    } else drawSide();
  }

  /* ===================================================== save / publish */

  async function saveDraft() {
    if (!S) return false;
    if (S.ro) { toast("Your rights do not include saving TSAs (Telephony & SIP › tsa).", "err"); return false; }
    if (S.saving) return false;
    const st = S;
    st.saving = true;
    drawTopState();
    const body = { name: st.name.trim() || st.id, description: st.description, graph: serializeGraph(st.graph), tags: st.tags };
    const sent = currentJson();
    try {
      const r = await api(`/admin/telephony/tsa/${enc(st.id)}`, { method: "PUT", body });
      if (S !== st) return true;
      if (r && r.tsa) st.tsa = r.tsa; else st.tsa = { ...st.tsa, name: body.name, description: body.description, graph: body.graph, tags: body.tags, updatedAt: Date.now() };
      st.savedJson = sent;
      st.saved = true;
      lsDel(LS_DRAFT + st.id);
      banner("local", "", "");
      const warns = r && Array.isArray(r.problems) ? r.problems.filter((p) => p.level === "warning").length : 0;
      if (r && Array.isArray(r.problems)) setProblems(r.problems, "server");
      toast(warns ? `Draft saved — ${plural(warns, "warning")}.` : "Draft saved.", "ok");
      return true;
    } catch (err) {
      if (S !== st) return false;
      toast(`Not saved: ${err.message}`, "err");
      st.probOpen = true;
      void validateNow();
      return false;
    } finally {
      if (S === st) { st.saving = false; drawTopState(); }
    }
  }

  async function publish() {
    if (!S) return false;
    if (S.ro) { toast("Your rights do not include publishing TSAs (Telephony & SIP › tsa).", "err"); return false; }
    const st = S;
    if (isDirty() && !(await saveDraft())) return false;
    await validateNow();
    if (S !== st) return false;
    const errs = st.problems.filter((p) => p.level === "error");
    if (errs.length) { st.probOpen = true; drawProblems(); toast(`Publishing needs a TSA without errors — ${plural(errs.length, "error")} left.`, "err"); return false; }
    const next = (Number(st.tsa.version) || 0) + 1;
    const warns = st.problems.length;
    const ok = await dialog({
      title: `Publish version ${next}?`,
      body: [h("p", {}, `Calls routed to “${st.name || st.id}” run version ${next} from now on.`), warns ? h("p", { class: "muted small" }, `${plural(warns, "warning")} — publishing is allowed, but look at them first.`) : null, st.tsa.published ? h("p", { class: "muted small" }, `Version ${st.tsa.published.version} stays in the history.`) : null],
      buttons: [{ label: "Cancel", value: false }, { label: `Publish v${next}`, value: true, tone: "primary" }],
      cancel: false,
    });
    if (!ok || S !== st) return false;
    try {
      const r = await api(`/admin/telephony/tsa/${enc(st.id)}/publish`, { method: "POST", body: {} });
      if (S !== st) return true;
      if (r && r.tsa) st.tsa = r.tsa;
      else { const v = (r && Number(r.version)) || next; st.tsa = { ...st.tsa, version: v, published: { version: v, graph: serializeGraph(st.graph), at: Date.now(), by: "" } }; }
      st.published = true;
      drawTopState();
      if (st.side === "inspect" && !st.sel.nodes.size && !st.sel.edge) drawSide();
      toast(`Published version ${st.tsa.published ? st.tsa.published.version : next}.`, "ok");
      return true;
    } catch (err) {
      if (S !== st) return false;
      toast(`Not published: ${err.message}`, "err");
      st.probOpen = true;
      void validateNow();
      return false;
    }
  }

  async function exportJson() {
    if (!S) return;
    const st = S;
    if (isDirty()) toast("The export is the draft saved on the server — your unsaved changes are not in it.");
    let text = "", name = `${st.id}.tsa.json`;
    try {
      const raw = C().raw;
      if (raw) {
        const res = await raw(`/admin/telephony/tsa/${enc(st.id)}/export`);
        if (!res.ok) { let m = `HTTP ${res.status}`; try { const j = await res.json(); m = j.message || m; } catch { /* not JSON */ } throw new Error(m); }
        text = await res.text();
        const cd = res.headers && res.headers.get ? res.headers.get("content-disposition") || "" : "";
        const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
        if (m) name = decodeURIComponent(m[1]);
      } else {
        const r = await api(`/admin/telephony/tsa/${enc(st.id)}/export`);
        text = JSON.stringify(r && r.tsa ? r.tsa : r, null, 2);
      }
    } catch (err) { toast(`Export failed: ${err.message}`, "err"); return; }
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const a = h("a", { href: url, download: name, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(`Exported ${name}.`, "ok");
  }

  /* ======================================================== local copy */

  function autosave() {
    if (!S) return;
    const key = LS_DRAFT + S.id;
    if (!isDirty()) { lsDel(key); return; }
    lsSet(key, { at: Date.now(), base: S.tsa.updatedAt || 0, name: S.name, description: S.description, tags: S.tags, graph: serializeGraph(S.graph) });
  }

  function offerLocalCopy() {
    const key = LS_DRAFT + S.id;
    const c = lsGet(key);
    if (!c || !c.graph || !Array.isArray(c.graph.nodes) || !Array.isArray(c.graph.edges)) return;
    const theirs = JSON.stringify({ name: c.name || "", description: c.description || "", tags: Array.isArray(c.tags) ? c.tags : [], graph: c.graph });
    if (theirs === S.savedJson) { lsDel(key); return; }
    const stale = (S.tsa.updatedAt || 0) > (c.base || 0);
    banner("local", "history", `This browser kept unsaved changes from ${when(c.at)}${stale ? " — the server's draft has changed since" : ""}.`, [
      h("button", { type: "button", class: "btn btn--xs btn--primary", "data-testid": "tsa-restore", onclick: () => {
        snapshot();
        S.name = c.name || ""; S.description = c.description || ""; S.tags = Array.isArray(c.tags) ? c.tags : [];
        S.graph = { nodes: clone(c.graph.nodes).map((n) => ({ ...n, params: n.params || {} })), edges: clone(c.graph.edges) };
        S.sel = { nodes: new Set(), edge: null };
        banner("local", "", "");
        drawTop(); drawAll(); drawSide(); changed(); fit();
        toast("Restored the local copy — save the draft to keep it.");
      } }, "Restore"),
      h("button", { type: "button", class: "btn btn--xs", onclick: () => { lsDel(key); banner("local", "", ""); } }, "Discard"),
    ], stale ? "warn" : "info");
  }

  /* ========================================================= simulator */
  // POST /admin/telephony/sim runs the saved draft as an inbound call; each
  // answer is a SimTurn — what the caller hears (spoken here with the
  // browser's speech synthesis unless an audio data: URL came along) and what
  // the TSA waits for; the keypad, the "say" box, the microphone and the
  // outcome buttons answer with POST …/sim/:session/event (a TsaEvent).

  function newSim() {
    return {
      session: null, status: "idle", at: null, waiting: null, ended: null, busy: false, error: "",
      hears: [], trace: [], traceFull: [], visited: new Set(), edges: new Set(), digits: "", say: "",
      from: "+420600000001", to: "+420200000000", muted: false, realTimeouts: false,
      playing: false, nowPlaying: -1, playToken: 0, recording: null, countdown: null, countdownEnd: 0,
    };
  }

  const AUDIO = { ctx: null, current: null, resolve: null, token: 0 };
  function audioCtx() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!AUDIO.ctx) { try { AUDIO.ctx = new AC(); } catch { return null; } }
    if (AUDIO.ctx.state === "suspended" && AUDIO.ctx.resume) AUDIO.ctx.resume().catch(() => undefined);
    return AUDIO.ctx;
  }
  function tone(freqs, ms, vol = 0.08) {
    const ac = audioCtx();
    if (!ac) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        const g = ac.createGain();
        g.gain.value = vol;
        g.connect(ac.destination);
        const osc = freqs.map((f) => { const o = ac.createOscillator(); o.frequency.value = f; o.connect(g); o.start(); return o; });
        setTimeout(() => { for (const o of osc) { try { o.stop(); } catch { /* stopped */ } } try { g.disconnect(); } catch { /* gone */ } resolve(); }, ms);
      } catch { resolve(); }
    });
  }
  const DTMF = { 1: [697, 1209], 2: [697, 1336], 3: [697, 1477], 4: [770, 1209], 5: [770, 1336], 6: [770, 1477], 7: [852, 1209], 8: [852, 1336], 9: [852, 1477], "*": [941, 1209], 0: [941, 1336], "#": [941, 1477] };

  function stopAudio() {
    AUDIO.token++;
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch { /* none */ }
    if (AUDIO.current) { try { AUDIO.current.pause(); } catch { /* gone */ } AUDIO.current = null; }
    if (AUDIO.resolve) { const r = AUDIO.resolve; AUDIO.resolve = null; r(); }
    if (S) { S.sim.playing = false; markHearing(-1); }
  }
  function speak(text, lang) {
    return new Promise((resolve) => {
      const synth = window.speechSynthesis;
      if (!synth || typeof window.SpeechSynthesisUtterance !== "function" || !String(text).trim()) { resolve(); return; }
      let done = false;
      const fin = () => { if (done) return; done = true; clearTimeout(timer); if (AUDIO.resolve === fin) AUDIO.resolve = null; resolve(); };
      const u = new window.SpeechSynthesisUtterance(String(text));
      if (lang) u.lang = lang;
      u.onend = fin;
      u.onerror = fin;
      const timer = setTimeout(fin, 2500 + String(text).length * 110);
      AUDIO.resolve = fin;
      try { synth.speak(u); } catch { fin(); }
    });
  }
  function playUrl(src) {
    return new Promise((resolve) => {
      let a;
      try { a = new window.Audio(src); } catch { resolve(); return; }
      let done = false;
      const fin = () => { if (done) return; done = true; clearTimeout(timer); if (AUDIO.current === a) AUDIO.current = null; if (AUDIO.resolve === fin) AUDIO.resolve = null; resolve(); };
      a.onended = fin;
      a.onerror = () => { simNote(`The browser cannot play ${String(src).startsWith("data:") ? "this audio" : src} (the console's CSP allows only its own and data: audio).`); fin(); };
      const timer = setTimeout(fin, 10 * 60 * 1000);
      AUDIO.current = a;
      AUDIO.resolve = fin;
      try { const p = a.play(); if (p && p.catch) p.catch(() => fin()); } catch { fin(); }
    });
  }
  async function playItem(it) {
    const loops = clamp(Number(it.loop) || 1, 1, 10);
    for (let k = 0; k < loops; k++) {
      if (it.audio) await playUrl(it.audio);
      else if (it.kind === "say") await speak(it.text || "", it.language);
      else if (it.kind === "play" && it.url) await playUrl(it.url);
      else if (it.kind === "beep") await tone([1000], 320, 0.08);
      else if (it.kind === "tone") await tone([425], 700, 0.06);
    }
  }
  async function playAll(items, first, sim, token) {
    const mine = ++AUDIO.token;
    sim.playing = items.length > 0;
    for (let i = 0; i < items.length; i++) {
      if (!S || S.sim !== sim || token !== sim.playToken || mine !== AUDIO.token) return;
      if (sim.muted) continue;
      markHearing(first + i);
      await playItem(items[i]);
    }
    if (S && S.sim === sim && mine === AUDIO.token) { sim.playing = false; markHearing(-1); }
  }
  function markHearing(idx) {
    if (!S) return;
    S.sim.nowPlaying = idx;
    const box = S.els.side && S.els.side.querySelector(".tsa-phone__hears");
    if (!box) return;
    for (const el of box.querySelectorAll("[data-idx]")) el.classList.toggle("is-now", Number(el.dataset.idx) === idx);
  }
  function simNote(text) {
    if (!S) return;
    S.sim.trace.push({ at: Date.now(), text, warn: true });
    drawSideSim();
  }

  /* ---- microphone → 16 kHz mono WAV (a data: URL) ---- */

  async function startMic(maxSeconds) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    const AC = window.AudioContext || window.webkitAudioContext;
    const ac = new AC();
    const src = ac.createMediaStreamSource(stream);
    const proc = ac.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    src.connect(proc);
    proc.connect(ac.destination);
    const rate = ac.sampleRate;
    let stopped = null;
    const rec = {
      started: Date.now(),
      stop() {
        if (stopped) return stopped;
        stopped = (async () => {
          clearTimeout(rec.limit);
          try { proc.disconnect(); src.disconnect(); } catch { /* gone */ }
          for (const tr of stream.getTracks()) tr.stop();
          try { await ac.close(); } catch { /* closed */ }
          const len = chunks.reduce((a, c) => a + c.length, 0);
          const pcm = new Float32Array(len);
          let o = 0;
          for (const c of chunks) { pcm.set(c, o); o += c.length; }
          const out = resample(pcm, rate, 16000);
          return { dataUrl: wavDataUrl(out, 16000), seconds: out.length / 16000 };
        })();
        return stopped;
      },
    };
    rec.limit = setTimeout(() => { if (S && S.sim.recording === rec) toggleMic(); }, clamp(maxSeconds || 30, 1, 120) * 1000);
    return rec;
  }
  function resample(pcm, from, to) {
    if (from === to) return pcm;
    const ratio = from / to;
    const n = Math.floor(pcm.length / ratio);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * ratio), b = Math.min(pcm.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      for (let j = a; j < b; j++) sum += pcm[j];
      out[i] = b > a ? sum / (b - a) : pcm[a] || 0;
    }
    return out;
  }
  function wavDataUrl(samples, rate) {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const v = new DataView(buf);
    const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
    str(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE"); str(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.round(clamp(samples[i], -1, 1) * 0x7fff), true);
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return `data:audio/wav;base64,${btoa(bin)}`;
  }
  /** A short test tone as a WAV (for a recording / speech without a microphone). */
  function toneWav(sec = 1.2, freq = 440) {
    const rate = 16000, n = Math.round(rate * sec);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = 0.3 * Math.sin((2 * Math.PI * freq * i) / rate) * Math.min(1, i / 800, (n - i) / 800);
    return { dataUrl: wavDataUrl(out, rate), seconds: sec };
  }

  /* ---- the call ---- */

  const simLive = () => Boolean(S && S.sim.session && !S.sim.ended);
  const simListening = () => Boolean(S && S.side === "sim" && simLive() && S.sim.waiting && (S.sim.waiting.for === "digits" || S.sim.waiting.for === "recording"));

  async function startSim() {
    if (!S) return false;
    if (!S.canTest) { toast("Your rights do not include the simulator (Telephony & SIP › test).", "err"); return false; }
    if (simLive()) await hangupSim();
    if (isDirty()) {
      if (S.ro) { toast("The simulator runs the draft saved on the server — your changes cannot be saved.", "err"); return false; }
      if (!(await saveDraft())) return false;
    }
    if (!S) return false;
    const old = S.sim;
    stopAudio();
    stopMic();
    stopCountdown();
    const sim = { ...newSim(), from: old.from, to: old.to, muted: old.muted, realTimeouts: old.realTimeouts, status: "starting", busy: true };
    S.sim = sim;
    sim.trace.push({ at: Date.now(), text: `calling ${sim.to} from ${sim.from} (the saved draft)`, caller: true });
    drawNodes(); drawWires(); drawSideSim();
    try {
      const r = await api("/admin/telephony/sim", { method: "POST", body: { tsa: S.id, draft: true, from: sim.from, to: sim.to } });
      if (!S || S.sim !== sim) return false;
      const turn = r && r.turn ? r.turn : r;
      sim.session = (r && typeof r.session === "string" ? r.session : null) || (turn && turn.session) || null;
      await handleTurn(turn, sim);
      return true;
    } catch (err) {
      if (!S || S.sim !== sim) return false;
      sim.busy = false;
      sim.status = "idle";
      sim.error = err.message;
      sim.trace.push({ at: Date.now(), text: `the simulator did not start: ${err.message}`, err: true });
      drawSideSim();
      toast(`Simulator: ${err.message}`, "err");
      return false;
    }
  }

  async function handleTurn(turn, sim) {
    if (!S || S.sim !== sim || !turn || typeof turn !== "object") { if (sim) sim.busy = false; return; }
    sim.busy = false;
    if (turn.session) sim.session = turn.session;
    sim.status = turn.status || sim.status;
    sim.waiting = turn.waiting || null;
    sim.at = turn.at || (turn.waiting && turn.waiting.node) || null;
    sim.ended = turn.ended || (turn.status === "ended" || turn.status === "failed" ? { how: turn.status } : null);
    sim.digits = "";
    for (const st of turn.steps || []) sim.trace.push({ at: Date.now(), text: String(st) });
    const first = sim.hears.length;
    const items = Array.isArray(turn.play) ? turn.play : [];
    for (const p of items) sim.hears.push({ ...p, at: Date.now() });
    if (sim.ended) { sim.trace.push({ at: Date.now(), text: `call ended — ${sim.ended.how}${sim.ended.cause ? ` (${sim.ended.cause})` : ""}`, end: true }); sim.at = null; }
    if (sim.at) sim.visited.add(sim.at);
    drawNodes(); drawWires(); drawMinimap(); drawSideSim();
    if (sim.at && S.side === "sim") revealNode(sim.at);
    void refreshTrace(sim);
    const token = ++sim.playToken;
    await playAll(items, first, sim, token);
    if (!S || S.sim !== sim || token !== sim.playToken) return;
    if (sim.waiting && sim.waiting.for === "played" && !sim.ended) { await sendEvent({ kind: "played" }); return; }
    startCountdown();
  }

  /** Keeps the running node in view (without moving a view the operator is looking at elsewhere too much). */
  function revealNode(id) {
    const n = byId(id);
    if (!n) return;
    const g = geo(n);
    const { w, h: hh } = stageSize();
    const sx = n.x * S.cam.z + S.cam.x, sy = n.y * S.cam.z + S.cam.y;
    if (sx < 0 || sy < 0 || sx + g.w * S.cam.z > w || sy + g.h * S.cam.z > hh) centerOnNode(id);
  }

  async function refreshTrace(sim) {
    if (!sim.session) return;
    try {
      const r = await api(`/admin/telephony/sim/${enc(sim.session)}`);
      if (!S || S.sim !== sim) return;
      const ses = r && r.session && typeof r.session === "object" ? r.session : r;
      const trace = ses && Array.isArray(ses.trace) ? ses.trace : [];
      for (const t of trace) { if (t.node) sim.visited.add(t.node); if (t.node && t.port) sim.edges.add(`${t.node}\u0000${t.port}`); }
      sim.traceFull = trace;
      drawNodes(); drawWires();
      if (S.side === "sim") drawSideSim();
    } catch { /* the turn's own steps are shown */ }
  }

  function describeEvent(ev) {
    switch (ev.kind) {
      case "digits": return ev.timedOut ? `no more keys (timeout)${ev.digits ? ` after ${ev.digits}` : ""}` : `pressed ${ev.digits || "(nothing)"}${ev.finishedBy ? ` then ${ev.finishedBy}` : ""}`;
      case "speech": return ev.timedOut ? "said nothing (timeout)" : ev.audio ? `spoke (${ev.durationSec || "?"} s of audio)${ev.text ? ` “${ev.text}”` : ""}` : `said “${ev.text}”`;
      case "recording": return ev.timedOut ? "stayed silent (timeout)" : `recorded ${ev.durationSec || 0} s${ev.digit ? `, ended with ${ev.digit}` : ""}`;
      case "dial": return `the dialled side: ${ev.status}`;
      case "route": return ev.ok ? "the audio was routed" : `routing failed (${ev.reason})`;
      case "hangup": return "hung up";
      case "played": return "(playback finished)";
      default: return ev.kind;
    }
  }

  async function sendEvent(ev) {
    if (!S) return false;
    const sim = S.sim;
    if (!sim.session || sim.ended) return false;
    if (sim.busy && ev.kind !== "hangup") return false;
    stopCountdown();
    sim.busy = true;
    sim.trace.push({ at: Date.now(), text: `caller: ${describeEvent(ev)}`, caller: true });
    drawSideSim();
    try {
      const r = await api(`/admin/telephony/sim/${enc(sim.session)}/event`, { method: "POST", body: ev });
      if (!S || S.sim !== sim) return false;
      await handleTurn(r && r.turn ? r.turn : r, sim);
      return true;
    } catch (err) {
      if (!S || S.sim !== sim) return false;
      sim.busy = false;
      sim.error = err.message;
      sim.trace.push({ at: Date.now(), text: `error: ${err.message}`, err: true });
      drawSideSim();
      return false;
    }
  }

  async function hangupSim() {
    if (!S) return;
    stopAudio();
    stopMic();
    if (simLive()) { S.sim.busy = false; await sendEvent({ kind: "hangup", cause: "caller" }); }
    if (S && S.sim.session && !S.sim.ended) { S.sim.ended = { how: "hangup", cause: "caller" }; S.sim.at = null; drawNodes(); drawSideSim(); }
  }

  /** On close: silence, and tell the server the caller is gone. */
  function stopSim() {
    if (!S) return;
    stopAudio();
    stopMic();
    stopCountdown();
    if (simLive()) api(`/admin/telephony/sim/${enc(S.sim.session)}/event`, { method: "POST", body: { kind: "hangup", cause: "editor closed" } }).catch(() => undefined);
  }

  function simPress(key) {
    if (!S) return;
    const sim = S.sim;
    if (!sim.muted && DTMF[key]) void tone(DTMF[key], 140, 0.05);
    const btn = S.els.side && [...S.els.side.querySelectorAll(".tsa-key")].find((b) => b.dataset.key === key);
    if (btn) { btn.classList.add("is-down"); setTimeout(() => btn.classList.remove("is-down"), 140); }
    if (!simLive()) return;
    const w = sim.waiting;
    if (!w) { simNote(`${key} — the TSA is not reading keys right now.`); return; }
    if (w.for === "recording") {
      const fin = w.finishOnKey || "#";
      if (fin !== "none" && (fin === "any" || fin === key)) void finishRecording(key);
      return;
    }
    if (w.for !== "digits") { simNote(`${key} — the TSA waits for ${w.for}, not for keys.`); return; }
    stopAudio();
    const fin = w.finishOnKey || "#";
    if (fin === "any") { void sendEvent({ kind: "digits", digits: sim.digits + key, finishedBy: key }); return; }
    if (fin !== "none" && key === fin) { void sendEvent({ kind: "digits", digits: sim.digits, finishedBy: key }); return; }
    sim.digits += key;
    const shown = S.els.side && S.els.side.querySelector(".tsa-phone__digits");
    if (shown) shown.textContent = sim.digits;
    if (sim.digits.length >= (Number(w.maxDigits) || 1)) { void sendEvent({ kind: "digits", digits: sim.digits }); return; }
    startCountdown();
  }

  function sayText(text) {
    if (!S || !simLive()) return false;
    const w = S.sim.waiting;
    const t = String(text || "").trim();
    if (!t) return false;
    if (!w || w.for !== "speech") { simNote(`“${t}” — the TSA is not listening for speech right now.`); return false; }
    stopAudio();
    S.sim.say = "";
    void sendEvent({ kind: "speech", text: t, confidence: 1 });
    return true;
  }

  async function toggleMic() {
    if (!S) return;
    const sim = S.sim;
    if (sim.recording) {
      const rec = sim.recording;
      sim.recording = null;
      drawSideSim();
      const out = await rec.stop();
      if (S && S.sim === sim) deliverAudio(out);
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast("This browser cannot record here (no microphone access).", "err"); return; }
    try {
      stopAudio();
      const w = sim.waiting;
      sim.recording = await startMic((w && w.maxSeconds) || 30);
      drawSideSim();
    } catch (err) { toast(`The microphone is not available: ${err.message}`, "err"); }
  }
  function stopMic() { if (S && S.sim.recording) { const rec = S.sim.recording; S.sim.recording = null; void rec.stop(); } }
  async function finishRecording(key) {
    const sim = S.sim;
    if (sim.recording) { const rec = sim.recording; sim.recording = null; const out = await rec.stop(); if (S && S.sim === sim) deliverAudio(out, key); return; }
    void sendEvent({ kind: "recording", url: "", durationSec: 0, digit: key });
  }
  function deliverAudio(out, digit) {
    const w = S.sim.waiting;
    const sec = Math.round(out.seconds * 10) / 10;
    if (!w || !simLive()) { simNote("The recording was not sent — the TSA is not listening."); return; }
    if (w.for === "speech") void sendEvent({ kind: "speech", text: (S.sim.say || "").trim(), audio: out.dataUrl, durationSec: sec });
    else if (w.for === "recording") void sendEvent({ kind: "recording", url: out.dataUrl, durationSec: sec, ...(digit ? { digit } : {}) });
    else simNote(`The recording was not sent — the TSA waits for ${w.for}.`);
  }

  function startCountdown() {
    stopCountdown();
    if (!S || !S.sim.realTimeouts || !simLive()) return;
    const w = S.sim.waiting;
    if (!w || !w.timeoutSec || !["digits", "speech", "recording"].includes(w.for)) return;
    const sim = S.sim;
    sim.countdownEnd = Date.now() + w.timeoutSec * 1000;
    sim.countdown = setInterval(() => {
      if (!S || S.sim !== sim) { clearInterval(sim.countdown); return; }
      const left = Math.max(0, sim.countdownEnd - Date.now());
      const el = S.els.side && S.els.side.querySelector(".tsa-phone__count");
      if (el) el.textContent = `${Math.ceil(left / 1000)} s`;
      if (left <= 0) { stopCountdown(); timeoutEvent(); }
    }, 250);
  }
  function stopCountdown() { if (S && S.sim.countdown) { clearInterval(S.sim.countdown); S.sim.countdown = null; } }
  function timeoutEvent() {
    const w = S && S.sim.waiting;
    if (!w) return;
    if (w.for === "digits") void sendEvent({ kind: "digits", digits: S.sim.digits, timedOut: true });
    else if (w.for === "speech") void sendEvent({ kind: "speech", text: "", timedOut: true });
    else if (w.for === "recording") void sendEvent({ kind: "recording", url: "", durationSec: 0, timedOut: true });
  }

  /* ---- the panel ---- */

  function drawSideSim() { if (S && S.side === "sim") drawSideKeepingFocus(); }

  function simStatus(sim) {
    if (sim.status === "starting") return ["busy", "Calling…"];
    if (sim.ended) return ["ended", `Ended — ${sim.ended.how}${sim.ended.cause ? ` (${sim.ended.cause})` : ""}`];
    if (!sim.session) return ["idle", "Ready — press Call to run the saved draft"];
    if (sim.busy) return ["busy", "…"];
    const w = sim.waiting;
    const at = w && byId(w.node) ? ` at ${titleOf(byId(w.node))}` : "";
    if (!w) return ["live", "Connected"];
    switch (w.for) {
      case "digits": return ["wait", `Waiting for ${w.maxDigits ? `up to ${plural(Number(w.maxDigits), "digit")}` : "digits"}${w.finishOnKey && w.finishOnKey !== "none" ? ` · ${w.finishOnKey === "any" ? "any key" : w.finishOnKey} ends` : ""}${w.timeoutSec ? ` · ${w.timeoutSec} s` : ""}${at}`];
      case "speech": return ["wait", `Listening — type what the caller says or use the microphone${at}`];
      case "recording": return ["wait", `Recording — use the microphone${w.finishOnKey && w.finishOnKey !== "none" ? `, ${w.finishOnKey} ends` : ""}${w.maxSeconds ? ` · up to ${w.maxSeconds} s` : ""}${at}`];
      case "dial": return ["wait", `Dialling${at} — how does the other side answer?`];
      case "route": return ["wait", `Routing the audio${at} — what happens?`];
      case "played": return ["live", `Playing${at}…`];
      default: return ["wait", `Waiting for ${w.for}${at}`];
    }
  }

  function drawSim(body) {
    const sim = S.sim;
    const live = simLive();
    if (!S.canTest) body.append(h("div", { class: "tsa-banner tsa-banner--warn" }, icon("lock"), h("span", {}, "Your rights do not include the simulator (Telephony & SIP › test).")));
    const from = h("input", { class: "input input--sm mono", id: "tsaSimFrom", value: sim.from, "data-focus-key": "sim:from", "data-testid": "tsa-sim-from", disabled: live || undefined });
    from.addEventListener("input", () => { sim.from = from.value; });
    const to = h("input", { class: "input input--sm mono", id: "tsaSimTo", value: sim.to, "data-focus-key": "sim:to", "data-testid": "tsa-sim-to", disabled: live || undefined });
    to.addEventListener("input", () => { sim.to = to.value; });
    const call = live
      ? h("button", { type: "button", class: "btn btn--sm btn--danger tsa-sim__call", "data-testid": "tsa-sim-hangup", onclick: () => hangupSim() }, icon("phone-off"), "Hang up")
      : h("button", { type: "button", class: "btn btn--sm btn--primary tsa-sim__call", "data-testid": "tsa-sim-start", disabled: sim.busy || !S.canTest || undefined, onclick: () => startSim() }, icon("phone-call"), sim.ended || sim.session ? "Call again" : "Call");
    const mute = h("button", { type: "button", class: "btn btn--xs tsa-icon-btn", "aria-pressed": String(sim.muted), "data-tip": sim.muted ? "Sound off — click to hear the call" : "Sound on — click to mute", "aria-label": "Mute the simulator", onclick: () => { sim.muted = !sim.muted; if (sim.muted) stopAudio(); drawSideSim(); } }, icon(sim.muted ? "volume-x" : "volume-2"));
    const rt = h("input", { type: "checkbox", checked: sim.realTimeouts || undefined, "data-testid": "tsa-sim-timeouts" });
    rt.addEventListener("change", () => { sim.realTimeouts = rt.checked; if (rt.checked) startCountdown(); else stopCountdown(); drawSideSim(); });
    body.append(h("div", { class: "tsa-sim__bar" },
      h("div", { class: "tsa-sim__nums" }, field("From (caller)", from), field("To (DID)", to)),
      h("div", { class: "tsa-sim__ctl" }, call, mute, h("label", { class: "switch tsa-switch small", "data-tip": "Count the TSA's timeouts down and send them like a silent caller" }, rt, h("span", {}, "real timeouts")))));

    // the phone
    const [tone, status] = simStatus(sim);
    const phone = h("div", { class: `tsa-phone tsa-phone--${tone}`, "data-testid": "tsa-sim-phone" });
    phone.append(h("div", { class: "tsa-phone__status", "data-testid": "tsa-sim-status", role: "status", "aria-live": "polite" }, h("span", { class: "tsa-phone__dot", "aria-hidden": "true" }), h("span", {}, status),
      sim.countdown ? h("span", { class: "tsa-phone__count" }, `${Math.max(0, Math.ceil((sim.countdownEnd - Date.now()) / 1000))} s`) : null));
    const hears = h("div", { class: "tsa-phone__hears", "data-testid": "tsa-sim-hears", "aria-label": "What the caller hears", role: "log" });
    const from0 = Math.max(0, sim.hears.length - 40);
    sim.hears.slice(from0).forEach((it, i) => {
      const idx = from0 + i;
      const ic = it.kind === "say" ? "volume-2" : it.kind === "play" ? "play" : "radio";
      const text = it.kind === "say" ? it.text || "" : it.kind === "play" ? it.url || "(audio)" : it.kind === "beep" ? "beep" : "tone";
      hears.append(h("div", { class: `tsa-bubble tsa-bubble--${it.kind}${idx === sim.nowPlaying ? " is-now" : ""}`, "data-idx": String(idx) },
        icon(ic), h("span", { class: "tsa-bubble__text" }, text), it.language ? h("span", { class: "tsa-bubble__meta" }, it.language) : null, it.loop > 1 ? h("span", { class: "tsa-bubble__meta" }, `×${it.loop}`) : null,
        it.kind === "say" || it.audio || it.url ? h("button", { type: "button", class: "btn btn--xs btn--ghost tsa-icon-btn", "aria-label": "Play again", onclick: () => { stopAudio(); void playItem(it); } }, icon("play")) : null));
    });
    if (!sim.hears.length) hears.append(h("p", { class: "muted small tsa-phone__none" }, sim.session ? "Silence so far." : "What the caller hears appears here — and is spoken aloud."));
    phone.append(hears);

    // what the TSA waits for → the matching controls
    const w = live ? sim.waiting : null;
    const acts = h("div", { class: "tsa-phone__acts" });
    const act = (label, ev, tone2) => h("button", { type: "button", class: `btn btn--xs${tone2 ? " btn--" + tone2 : ""}`, disabled: sim.busy || undefined, onclick: () => sendEvent(ev) }, label);
    if (w) {
      if (w.for === "digits") acts.append(act("Timeout (no key)", { kind: "digits", digits: sim.digits, timedOut: true }));
      else if (w.for === "speech") acts.append(act("Silence (timeout)", { kind: "speech", text: "", timedOut: true }));
      else if (w.for === "recording") acts.append(act("Silence (timeout)", { kind: "recording", url: "", durationSec: 0, timedOut: true }));
      else if (w.for === "dial") for (const st of ["answered", "busy", "no-answer", "failed"]) acts.append(act(st, { kind: "dial", status: st, durationSec: st === "answered" ? 20 : 0 }, st === "answered" ? "primary" : undefined));
      else if (w.for === "route") acts.append(act("Routed", { kind: "route", ok: true }, "primary"), act("Wrong code", { kind: "route", ok: false, reason: "code" }), act("Cannot route", { kind: "route", ok: false, reason: "failed" }));
      else acts.append(act("Continue", { kind: w.for }));
    }
    if (acts.firstChild) phone.append(acts);
    phone.append(h("div", { class: "tsa-phone__digits", "aria-label": "Keys typed", "data-testid": "tsa-sim-digits" }, sim.digits));

    const pad = h("div", { class: "tsa-keypad", role: "group", "aria-label": "Dial pad" });
    const LET = { 2: "ABC", 3: "DEF", 4: "GHI", 5: "JKL", 6: "MNO", 7: "PQRS", 8: "TUV", 9: "WXYZ", 0: "+" };
    for (const k of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"]) {
      pad.append(h("button", { type: "button", class: "tsa-key", "data-key": k, "data-testid": `tsa-key-${k === "*" ? "star" : k === "#" ? "hash" : k}`, "aria-label": `Key ${k}`, disabled: !live || undefined, onclick: () => simPress(k) },
        h("span", { class: "tsa-key__d" }, k), h("span", { class: "tsa-key__l" }, LET[k] || "")));
    }
    phone.append(pad);

    const say = h("input", { class: "input input--sm", id: "tsaSimSay", value: sim.say, placeholder: w && w.for === "speech" ? "What the caller says…" : "Say something (when the TSA listens)", "aria-label": "What the caller says", "data-focus-key": "sim:say", "data-testid": "tsa-sim-say", disabled: !live || undefined });
    say.addEventListener("input", () => { sim.say = say.value; });
    say.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); sayText(say.value); } });
    const recOn = Boolean(sim.recording);
    const canAudio = live && w && (w.for === "speech" || w.for === "recording");
    phone.append(h("div", { class: "tsa-phone__say" }, say,
      h("button", { type: "button", class: "btn btn--sm tsa-icon-btn", "aria-label": "Send what the caller says", "data-testid": "tsa-sim-say-send", disabled: !live || undefined, onclick: () => sayText(say.value) }, icon("send")),
      h("button", { type: "button", class: `btn btn--sm tsa-icon-btn${recOn ? " is-rec" : ""}`, "aria-pressed": String(recOn), "aria-label": recOn ? "Stop recording and send" : "Record from the microphone", "data-tip": recOn ? "Stop and send" : "Speak into the microphone (sent as a WAV)", disabled: !(canAudio || recOn) || undefined, onclick: () => toggleMic() }, icon(recOn ? "square" : "mic")),
      h("button", { type: "button", class: "btn btn--sm tsa-icon-btn", "aria-label": "Send a test tone as the audio", "data-tip": "No microphone? Send a 1-second test tone", disabled: !canAudio || recOn || undefined, onclick: () => deliverAudio(toneWav(1.2)) }, icon("audio-lines"))));
    if (recOn) phone.append(h("div", { class: "tsa-phone__rec", role: "status" }, h("span", { class: "tsa-rec-dot" }), "Recording… press ■ to send"));
    body.append(phone);

    // the trace
    const steps = h("ol", { class: "tsa-trace", "data-testid": "tsa-sim-trace" });
    for (const t of sim.trace.slice(-200)) steps.append(h("li", { class: t.caller ? "is-caller" : t.err ? "is-err" : t.warn ? "is-warn" : t.end ? "is-end" : "" }, h("time", {}, clock(t.at)), h("span", {}, t.text)));
    body.append(h("details", { class: "tsa-sim__sec", open: true }, h("summary", {}, `Trace (${sim.trace.length})`), steps.firstChild ? steps : h("p", { class: "muted small" }, "Each step of the call appears here.")));
    if (sim.traceFull.length) {
      const full = h("ol", { class: "tsa-trace tsa-trace--full" });
      for (const t of sim.traceFull.slice(-200)) {
        const n = byId(t.node);
        full.append(h("li", { class: t.level === "error" ? "is-err" : t.level === "warn" ? "is-warn" : "" }, h("time", {}, clock(t.at)),
          h("button", { type: "button", class: "tsa-link", onclick: () => { selectOnly(t.node, false); drawNodes(); drawWires(); centerOnNode(t.node); } }, n ? titleOf(n) : t.node),
          t.port ? h("code", { class: `tsa-tone--${portTone(t.port)}` }, ` → ${t.port}`) : null, t.note ? h("span", { class: "muted" }, ` ${t.note}`) : null));
      }
      body.append(h("details", { class: "tsa-sim__sec" }, h("summary", {}, `Session trace (${sim.traceFull.length})`), full));
    }
    body.append(h("p", { class: "muted small" }, "The simulator runs the draft saved on the server as an inbound call — no provider, no cost. Keys 0–9 * # on the keyboard dial while it waits for digits."));
    requestAnimationFrame(() => { hears.scrollTop = hears.scrollHeight; steps.scrollTop = steps.scrollHeight; });
  }

  /* ============================================================ public */

  function handle() {
    const st = S;
    const live = () => S === st && S !== null;
    const node = (id) => (live() ? byId(id) : null);
    return {
      id: st.id,
      /** The draft on the canvas, exactly as the contract stores it. */
      graph: () => (live() ? serializeGraph(S.graph) : null),
      isDirty: () => live() && isDirty(),
      addNode: (type, x = 0, y = 0) => (live() ? addNode(type, x, y) : null),
      connect: (from, to) => (live() ? connect(from, to) : { ok: false, reason: "The editor is closed." }),
      setInputs: (id, n) => (node(id) ? setInputs(node(id), n) : false),
      setParam: (id, key, value) => { if (node(id)) setParam(node(id), key, value, { tag: null, redraw: true }); },
      select: (ids) => { if (live()) selectNodes([].concat(ids || [])); },
      selection: () => (live() ? { nodes: [...S.sel.nodes], edge: S.sel.edge } : null),
      undo: () => (live() ? undo() : false),
      redo: () => (live() ? redo() : false),
      save: () => (live() ? saveDraft() : Promise.resolve(false)),
      publish: () => (live() ? publish() : Promise.resolve(false)),
      validate: () => (live() ? validateNow() : Promise.resolve()),
      problems: () => (live() ? clone(S.problems) : []),
      simulate: () => { if (!live()) return Promise.resolve(false); showSide("sim"); return startSim(); },
      sim: () => (live() ? { session: S.sim.session, status: S.sim.status, at: S.sim.at, waiting: S.sim.waiting, ended: S.sim.ended, visited: [...S.sim.visited], hears: clone(S.sim.hears) } : null),
      press: (key) => { if (live()) simPress(String(key)); },
      say: (text) => (live() ? sayText(text) : false),
      fit: () => { if (live()) fit(); },
      close: (force) => (live() ? closeEditor(force) : Promise.resolve(true)),
    };
  }

  window.M5TsaEditor = {
    /** Opens the editor over the console for the TSA `id`; onClose({ id, saved, published, tsa }) when it closes. */
    open,
    /** The open editor's handle, or null. */
    current: () => (S ? handle() : null),
    close: (force) => closeEditor(force),
    config: CFG,
  };
})();
