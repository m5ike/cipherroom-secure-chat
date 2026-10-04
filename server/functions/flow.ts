// The visual builder's flows (5.1): a graph of nodes — inputs, SDK calls,
// logic, text, data, outputs — wired port to port, compiled to an ordinary
// JavaScript or Python package file. The flow itself is kept next to the
// code (flow.m5flow.json) so the builder can open it again; the generated
// file is what runs, so a flow behaves exactly like hand-written code.
//
// This module is pure (no Node APIs): the console bundles it too
// (admin-ui/src/m5-editor.ts), so the canvas previews the same code the
// server saves.
//
//   ordering   nodes run in dependency order; independent ones left to right
//   branches   an If node gates what hangs off its then/else ports — the
//              compiler wraps those nodes in `if (…)`
//   trace      a traced build logs each node's value (and which node failed)
//              so the builder can show results on the canvas
//   functions  (5.3) a flow may hold several functions — execute and the
//              model's other entry points (response, button, form, error,
//              webhook…), each its own graph, all in one generated file

export type FlowLang = "js" | "py";
export type PortType = "any" | "text" | "number" | "boolean" | "json" | "list" | "object" | "bytes" | "output";
/** 5.3: form / button — edited in the console's form and button builders; jscode — browser JavaScript. */
export type FieldType = "string" | "text" | "number" | "boolean" | "enum" | "json" | "code" | "form" | "button" | "jscode";

export type FlowPort = { name: string; label?: string; type: PortType; field?: FieldType; values?: string[]; default?: unknown; required?: boolean; placeholder?: string };
export type FlowOutPort = { name: string; label?: string; type: PortType; branch?: "then" | "else"; js?: (v: string) => string; py?: (v: string) => string };
export type FlowParam = { name: string; label: string; type: FieldType; values?: string[]; default?: unknown; placeholder?: string; help?: string };

export type FlowNode = { id: string; type: string; x: number; y: number; params?: Record<string, unknown>; values?: Record<string, unknown>; label?: string };
export type FlowEdge = { id: string; from: { node: string; port: string }; to: { node: string; port: string } };
export type FlowGraph = { nodes: FlowNode[]; edges: FlowEdge[] };
/** nodes/edges: the execute function; functions (5.3): the other entry points (name → its graph). */
export type Flow = { format: "m5flow"; version: 1; lang: FlowLang; name?: string; summary?: string; nodes: FlowNode[]; edges: FlowEdge[]; functions?: Record<string, FlowGraph> };
/** The function names a flow may hold besides execute (the model's entry points, or any identifier). */
export const FLOW_FUNCTIONS = ["response", "button", "form", "error", "webhook"] as const;
const FN_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;

/** What a node's code template gets: its inputs as expressions, its params as values. */
export type Gen = {
  lang: FlowLang;
  /** Input port → an expression (the wire's source, or the literal typed in). */
  in: Record<string, string>;
  /** Params as stored (strings, numbers, booleans). */
  p: Record<string, unknown>;
  /** A value as a literal of the target language. */
  lit: (v: unknown) => string;
  /** This node's variable. */
  v: string;
  /** Asks for a runtime helper (__str, __get, …) to be emitted. */
  use: (helper: HelperName) => void;
};
type Code = string | { pre: string[]; expr: string };

export type NodeDef = {
  type: string;
  group: string;
  title: string;
  doc: string;
  inputs: FlowPort[] | ((n: FlowNode) => FlowPort[]);
  outputs: FlowOutPort[];
  params?: FlowParam[];
  /** Sends, stores or logs: it runs even when nothing uses its value. */
  effect?: boolean;
  js: (g: Gen) => Code;
  py: (g: Gen) => Code;
};

export const FLOW_FILE = "flow.m5flow.json";
export const INPUT_TYPES = ["string", "text", "integer", "number", "boolean", "enum", "date", "time", "duration", "url", "hostname", "email", "ip", "json", "user", "file"] as const;

/* ============================================================ helpers */

type HelperName = "str" | "get" | "table" | "bytes" | "clean" | "peek" | "num";

const HELPERS_JS: Record<HelperName, string> = {
  str: "const __str = (v) => (v === undefined || v === null ? \"\" : typeof v === \"string\" ? v : typeof v === \"object\" && !(v instanceof Uint8Array) ? JSON.stringify(v, null, 2) : String(v));",
  num: "const __num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };",
  get: "const __get = (o, path) => String(path).split(\".\").filter(Boolean).reduce((a, k) => (a === undefined || a === null ? undefined : a[k]), o);",
  table: "const __table = (rows, cols) => { const list = Array.isArray(rows) ? rows : rows === undefined || rows === null ? [] : [rows]; const columns = cols && cols.length ? cols : list.length && !Array.isArray(list[0]) && typeof list[0] === \"object\" && list[0] !== null ? [...new Set(list.flatMap((r) => Object.keys(r || {})))] : [\"value\"]; return [columns, list.map((r) => (Array.isArray(r) ? r : r !== null && typeof r === \"object\" ? columns.map((c) => r[c]) : [r]))]; };",
  bytes: "const __bytes = (v) => (v instanceof Uint8Array ? v : v && typeof v === \"object\" && v.image instanceof Uint8Array ? v.image : v && typeof v === \"object\" && v.audio instanceof Uint8Array ? v.audio : m5.codec.utf8.encode(typeof v === \"string\" ? v : JSON.stringify(v)));",
  clean: "const __clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== \"\"));",
  peek: "const __peek = (v) => { if (v === undefined || v === null) return null; if (v instanceof Uint8Array) return `<${v.length} bytes>`; if (typeof v === \"string\") return v.length > 400 ? v.slice(0, 400) + \"…\" : v; if (typeof v !== \"object\") return v; let s; try { s = JSON.stringify(v, (k, x) => (x instanceof Uint8Array ? `<${x.length} bytes>` : x)); } catch { s = String(v); } return s.length > 400 ? s.slice(0, 400) + \"…\" : JSON.parse(s); };",
};

const HELPERS_PY: Record<HelperName, string[]> = {
  str: ["def _str(v):", "    if v is None: return \"\"", "    if isinstance(v, str): return v", "    if isinstance(v, (dict, list)): return _json.dumps(v, ensure_ascii=False, indent=2, default=str)", "    if isinstance(v, bool): return \"true\" if v else \"false\"", "    return str(v)"],
  num: ["def _num(v):", "    try: return float(v) if \".\" in str(v) else int(v)", "    except Exception: return 0"],
  get: ["def _get(o, path):", "    for k in [p for p in str(path).split(\".\") if p]:", "        if o is None: return None", "        if isinstance(o, (list, tuple)):", "            try: o = o[int(k)]", "            except Exception: return None", "        elif isinstance(o, dict): o = o.get(k)", "        else: o = getattr(o, k, None)", "    return o"],
  table: ["def _table(rows, cols=None):", "    rows = rows if isinstance(rows, list) else ([] if rows is None else [rows])", "    if not cols:", "        cols = list(dict.fromkeys(k for r in rows if isinstance(r, dict) for k in r)) or [\"value\"]", "    out = [r if isinstance(r, (list, tuple)) else ([r.get(c) for c in cols] if isinstance(r, dict) else [r]) for r in rows]", "    return cols, out"],
  bytes: ["def _bytes(v):", "    if isinstance(v, (bytes, bytearray)): return bytes(v)", "    if isinstance(v, dict):", "        for k in (\"image\", \"audio\"):", "            if isinstance(v.get(k), (bytes, bytearray)): return bytes(v[k])", "    return (v if isinstance(v, str) else _json.dumps(v)).encode(\"utf-8\")"],
  clean: ["def _clean(d):", "    return {k: v for k, v in d.items() if v is not None and v != \"\"}"],
  peek: ["def _peek(v):", "    if v is None: return None", "    if isinstance(v, (bytes, bytearray)): return \"<%d bytes>\" % len(v)", "    if isinstance(v, str): return v if len(v) <= 400 else v[:400] + \"…\"", "    if isinstance(v, (int, float, bool)): return v", "    try: s = _json.dumps(v, ensure_ascii=False, default=lambda x: \"<%d bytes>\" % len(x) if isinstance(x, (bytes, bytearray)) else str(x))", "    except Exception: s = str(v)", "    return _json.loads(s) if len(s) <= 400 else s[:400] + \"…\""],
};

/** A value as a Python literal (JSON, with True/False/None). */
function pyLit(v: unknown): string {
  if (v === undefined || v === null) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "None";
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(pyLit).join(", ")}]`;
  if (typeof v === "object") return `{${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${JSON.stringify(k)}: ${pyLit(x)}`).join(", ")}}`;
  return JSON.stringify(String(v));
}
function jsLit(v: unknown): string {
  if (v === undefined) return "undefined";
  if (typeof v === "number" && !Number.isFinite(v)) return "null";
  return JSON.stringify(v) ?? "undefined";
}

/* ============================================================ the nodes */

const P = (name: string, type: PortType, extra: Partial<FlowPort> = {}): FlowPort => ({ name, type, field: fieldFor(type), ...extra });
function fieldFor(t: PortType): FieldType | undefined {
  return t === "number" ? "number" : t === "boolean" ? "boolean" : t === "json" || t === "list" || t === "object" ? "json" : t === "bytes" || t === "output" ? undefined : "string";
}
const OUT = (name: string, type: PortType, label?: string): FlowOutPort => ({ name, type, label });
const FIELD = (name: string, jsGet: (v: string) => string, pyGet: (v: string) => string, type: PortType, label?: string): FlowOutPort => ({ name, type, label, js: jsGet, py: pyGet });
const prop = (k: string): [(v: string) => string, (v: string) => string] => [(v) => `${v}?.${k}`, (v) => `(${v} or {}).get(${JSON.stringify(k)})`];
const list = (s: unknown) => String(s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const identList = (s: unknown) => list(s).filter((x) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(x));
const placeholders = (tpl: unknown) => [...new Set([...String(tpl ?? "").matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]))];
function indent(code: string, pad: string): string[] { return String(code).replace(/\r/g, "").split("\n").map((l) => (l ? pad + l : l)); }

/** Template text → a concatenation of literal parts and `str(input)`. */
function templateExpr(g: Gen, tpl: string): string {
  const parts: string[] = [];
  let last = 0;
  const re = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  let m: RegExpExecArray | null;
  g.use("str");
  while ((m = re.exec(tpl))) {
    if (m.index > last) parts.push(g.lit(tpl.slice(last, m.index)));
    parts.push(g.lang === "js" ? `__str(${g.in[m[1]]})` : `_str(${g.in[m[1]]})`);
    last = re.lastIndex;
  }
  if (last < tpl.length) parts.push(g.lit(tpl.slice(last)));
  return parts.length ? parts.join(" + ") : g.lit("");
}

/** Where the Remember nodes keep a value (5.3: the processing session's own store and cache). */
const STORE_WHERE = ["session", "cache", "conversation", "conversation cache"];
const storeNs = (w: unknown) => (w === "cache" ? "cache" : w === "conversation" ? "model.session" : w === "conversation cache" ? "model.cache" : "session");
/** A form / button param: an object (the builder stores it as one), or JSON text. */
function objParam(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === "string" && v.trim()) { try { const o = JSON.parse(v); if (o && typeof o === "object" && !Array.isArray(o)) return o as Record<string, unknown>; } catch { /* below */ } throw new FlowError("Not valid JSON for a form or a button."); }
  return {};
}

const COMPARE_OPS = ["==", "!=", "<", "<=", ">", ">=", "contains", "starts with", "ends with", "matches", "is empty", "is not empty"];
const HASH_ALGS = ["sha256", "sha512", "sha1", "md5", "sha3-256", "blake2b512"];
const CODECS = ["base64", "base64url", "base32", "base58", "hex"];

/** 6.0: the room filter keys and every m5adm call a flow may make (host-adm.ts; a test keeps them equal). */
export const ROOM_FILTER_KEYS = ["room_username", "system_username", "system_passkey_id", "system_group", "room_id", "room_label", "room_tag"] as const;
export const ADM_CALLS: string[] = [
  "overview.get", "overview.system", "overview.alerts", "overview.db", "overview.backups", "overview.metrics", "overview.whoami",
  "connections.list", "connections.get", "connections.close", "connections.stats",
  "traffic.list", "traffic.summary", "traffic.rates", "traffic.events", "traffic.watch",
  "modules.list", "modules.get", "modules.set", "modules.enable", "modules.state", "modules.switch",
  "groups.list", "groups.get", "groups.set", "groups.delete", "groups.add_member", "groups.remove_member",
  "users.list", "users.get", "users.signout", "users.delete", "users.passkeys", "users.remove_passkey",
  "passkeys.list", "passkeys.get", "passkeys.delete",
  "queue.list", "queue.stats", "queue.get", "queue.dead", "queue.revive",
  "audit.list", "audit.stats", "audit.verify", "audit.checkpoint", "audit.communication", "audit.add",
  "commands.list", "commands.allowlist", "commands.send",
  "push.status", "push.send",
  "admins.list", "admins.get", "admins.set", "admins.delete",
];
/** 6.6: the card report formats (client/src/lib/nfc/card-report.ts) and the NFC nodes' shared params. */
export const CARD_FORMATS = ["html", "object", "array", "json", "text", "csv"] as const;
const cardFormat = (v: unknown) => ((CARD_FORMATS as readonly string[]).includes(String(v)) ? String(v) : "html");
const CARD_FORMAT: FlowParam = { name: "format", label: "Format", type: "enum", values: [...CARD_FORMATS], default: "html", help: "html — everything formatted for the chat (pictures inline, other data as files); object / array (rows) / json / text / csv for code or files." };
const SEND_TO_CHAT: FlowParam = { name: "send", label: "Show in the chat", type: "boolean", default: true, help: "Shows the report — with its pictures and files — to the caller at once." };
const NFC_READER: FlowParam = { name: "reader", label: "Reader", type: "enum", values: ["", "internal", "usb", "bluetooth", "serial"], default: "" };

export const NODES: NodeDef[] = [
  /* ------------------------------------------------------------ flow */
  { type: "flow.input", group: "Flow", title: "Input", doc: "A value the caller gives (a model input): its name, type and default.",
    inputs: [], outputs: [OUT("value", "any")],
    params: [
      { name: "name", label: "Name", type: "string", default: "text", placeholder: "text", help: "Letters, digits and _ (becomes inputs.<name>)." },
      { name: "type", label: "Type", type: "enum", values: [...INPUT_TYPES], default: "string" },
      { name: "label", label: "Label", type: "string", default: "" },
      { name: "default", label: "Default", type: "string", default: "" },
      { name: "required", label: "Required", type: "boolean", default: false },
      { name: "values", label: "Choices (enum, comma-separated)", type: "string", default: "" },
    ],
    js: (g) => { const d = inputDefault(g.p); return `inputs[${JSON.stringify(inputName(g.p))}]${d === undefined ? "" : ` ?? ${jsLit(d)}`}`; },
    py: (g) => { const d = inputDefault(g.p); return `inputs.get(${JSON.stringify(inputName(g.p))}${d === undefined ? "" : `, ${pyLit(d)}`})`; },
  },
  { type: "flow.value", group: "Flow", title: "Value", doc: "A fixed value: text, number, yes/no or JSON.",
    inputs: [], outputs: [OUT("value", "any")],
    params: [{ name: "kind", label: "Kind", type: "enum", values: ["text", "number", "boolean", "json"], default: "text" }, { name: "value", label: "Value", type: "text", default: "" }],
    js: (g) => g.lit(constValue(g.p)), py: (g) => g.lit(constValue(g.p)),
  },
  { type: "flow.return", group: "Flow", title: "Result", doc: "What the run returns (API and webhook callers get it; chat shows it as the last message).",
    inputs: [P("value", "any", { required: true })], outputs: [], effect: true,
    js: (g) => `(__result = ${g.in.value})`, py: (g) => `_set_result(${g.in.value})`,
  },

  /* ------------------------------------------------------------ logic */
  { type: "logic.if", group: "Logic", title: "If", doc: "Lets the value through “then” when the condition holds, else through “else”. Whatever hangs off a branch runs only on that branch.",
    inputs: [P("condition", "boolean", { required: true }), P("value", "any")], outputs: [{ name: "then", type: "any", branch: "then" }, { name: "else", type: "any", branch: "else" }],
    js: (g) => g.in.value, py: (g) => g.in.value,
  },
  { type: "logic.compare", group: "Logic", title: "Compare", doc: "Compares two values: equal, less, contains, matches (a regular expression), empty…",
    inputs: [P("a", "any"), P("b", "any")], outputs: [OUT("result", "boolean")],
    params: [{ name: "op", label: "Operator", type: "enum", values: COMPARE_OPS, default: "==" }],
    js: (g) => { const a = g.in.a, b = g.in.b; g.use("str"); switch (String(g.p.op)) {
      case "!=": return `${a} != ${b}`; case "<": return `${a} < ${b}`; case "<=": return `${a} <= ${b}`; case ">": return `${a} > ${b}`; case ">=": return `${a} >= ${b}`;
      case "contains": return `(Array.isArray(${a}) ? ${a}.includes(${b}) : __str(${a}).includes(__str(${b})))`;
      case "starts with": return `__str(${a}).startsWith(__str(${b}))`; case "ends with": return `__str(${a}).endsWith(__str(${b}))`;
      case "matches": return `new RegExp(__str(${b})).test(__str(${a}))`;
      case "is empty": return `(${a} === undefined || ${a} === null || ${a} === "" || (Array.isArray(${a}) && !${a}.length))`;
      case "is not empty": return `!(${a} === undefined || ${a} === null || ${a} === "" || (Array.isArray(${a}) && !${a}.length))`;
      default: return `${a} == ${b}`; } },
    py: (g) => { const a = g.in.a, b = g.in.b; g.use("str"); switch (String(g.p.op)) {
      case "!=": return `${a} != ${b}`; case "<": return `${a} < ${b}`; case "<=": return `${a} <= ${b}`; case ">": return `${a} > ${b}`; case ">=": return `${a} >= ${b}`;
      case "contains": return `(${b} in ${a} if isinstance(${a}, (list, tuple, dict)) else _str(${b}) in _str(${a}))`;
      case "starts with": return `_str(${a}).startswith(_str(${b}))`; case "ends with": return `_str(${a}).endswith(_str(${b}))`;
      case "matches": return `_re.search(_str(${b}), _str(${a})) is not None`;
      case "is empty": return `not ${a}`; case "is not empty": return `bool(${a})`;
      default: return `${a} == ${b}`; } },
  },
  { type: "logic.combine", group: "Logic", title: "And / Or / Not", doc: "Combines yes/no values.",
    inputs: [P("a", "boolean"), P("b", "boolean")], outputs: [OUT("result", "boolean")],
    params: [{ name: "op", label: "Operator", type: "enum", values: ["and", "or", "not a", "xor"], default: "and" }],
    js: (g) => ({ and: `Boolean(${g.in.a} && ${g.in.b})`, or: `Boolean(${g.in.a} || ${g.in.b})`, "not a": `!${g.in.a}`, xor: `Boolean(${g.in.a}) !== Boolean(${g.in.b})` } as Record<string, string>)[String(g.p.op)] ?? `Boolean(${g.in.a} && ${g.in.b})`,
    py: (g) => ({ and: `bool(${g.in.a} and ${g.in.b})`, or: `bool(${g.in.a} or ${g.in.b})`, "not a": `not ${g.in.a}`, xor: `bool(${g.in.a}) != bool(${g.in.b})` } as Record<string, string>)[String(g.p.op)] ?? `bool(${g.in.a} and ${g.in.b})`,
  },
  { type: "logic.fallback", group: "Logic", title: "Fallback", doc: "The first value when it is set, else the second.",
    inputs: [P("value", "any"), P("otherwise", "any")], outputs: [OUT("result", "any")],
    js: (g) => `(${g.in.value} ?? ${g.in.otherwise})`, py: (g) => `(${g.in.value} if ${g.in.value} is not None else ${g.in.otherwise})`,
  },

  /* ------------------------------------------------------------ text */
  { type: "text.template", group: "Text", title: "Template", doc: "Text with {placeholders}; each placeholder becomes an input.",
    inputs: (n) => placeholders(n.params?.template ?? "Hello, {name}!").map((name) => P(name, "any")), outputs: [OUT("text", "text")],
    params: [{ name: "template", label: "Template", type: "text", default: "Hello, {name}!", help: "Use {name} for a value from a wire." }],
    js: (g) => templateExpr(g, String(g.p.template ?? "")), py: (g) => templateExpr(g, String(g.p.template ?? "")),
  },
  { type: "text.case", group: "Text", title: "Change text", doc: "Upper/lower case, trim, length, reverse.",
    inputs: [P("text", "text", { required: true })], outputs: [OUT("result", "any")],
    params: [{ name: "mode", label: "Do", type: "enum", values: ["upper", "lower", "capitalize", "trim", "length", "reverse"], default: "upper" }],
    js: (g) => { g.use("str"); const s = `__str(${g.in.text})`; return ({ upper: `${s}.toUpperCase()`, lower: `${s}.toLowerCase()`, capitalize: `${s}.charAt(0).toUpperCase() + ${s}.slice(1)`, trim: `${s}.trim()`, length: `${s}.length`, reverse: `[...${s}].reverse().join("")` } as Record<string, string>)[String(g.p.mode)] ?? s; },
    py: (g) => { g.use("str"); const s = `_str(${g.in.text})`; return ({ upper: `${s}.upper()`, lower: `${s}.lower()`, capitalize: `${s}[:1].upper() + ${s}[1:]`, trim: `${s}.strip()`, length: `len(${s})`, reverse: `${s}[::-1]` } as Record<string, string>)[String(g.p.mode)] ?? s; },
  },
  { type: "text.replace", group: "Text", title: "Replace", doc: "Replaces text (every occurrence); optionally a regular expression.",
    inputs: [P("text", "text", { required: true }), P("find", "text"), P("with", "text", { default: "" })], outputs: [OUT("result", "text")],
    params: [{ name: "regex", label: "Regular expression", type: "boolean", default: false }],
    js: (g) => { g.use("str"); return g.p.regex ? `__str(${g.in.text}).replace(new RegExp(__str(${g.in.find}), "g"), __str(${g.in.with}))` : `__str(${g.in.text}).split(__str(${g.in.find})).join(__str(${g.in.with}))`; },
    py: (g) => { g.use("str"); return g.p.regex ? `_re.sub(_str(${g.in.find}), _str(${g.in.with}), _str(${g.in.text}))` : `_str(${g.in.text}).replace(_str(${g.in.find}), _str(${g.in.with}))`; },
  },
  { type: "text.split", group: "Text", title: "Split", doc: "Splits text into a list.",
    inputs: [P("text", "text", { required: true })], outputs: [OUT("list", "list")],
    params: [{ name: "separator", label: "Separator (\\n for lines)", type: "string", default: "," }, { name: "trim", label: "Trim items, drop empty", type: "boolean", default: true }],
    js: (g) => { g.use("str"); const sep = String(g.p.separator ?? ",").replace(/\\n/g, "\n"); return `__str(${g.in.text}).split(${g.lit(sep)})${g.p.trim === false ? "" : ".map((s) => s.trim()).filter(Boolean)"}`; },
    py: (g) => { g.use("str"); const sep = String(g.p.separator ?? ",").replace(/\\n/g, "\n"); return g.p.trim === false ? `_str(${g.in.text}).split(${g.lit(sep)})` : `[s.strip() for s in _str(${g.in.text}).split(${g.lit(sep)}) if s.strip()]`; },
  },
  { type: "text.join", group: "Text", title: "Join", doc: "Joins a list into text.",
    inputs: [P("list", "list", { required: true })], outputs: [OUT("text", "text")],
    params: [{ name: "separator", label: "Separator (\\n for lines)", type: "string", default: ", " }],
    js: (g) => { g.use("str"); return `(Array.isArray(${g.in.list}) ? ${g.in.list} : [${g.in.list}]).map(__str).join(${g.lit(String(g.p.separator ?? ", ").replace(/\\n/g, "\n"))})`; },
    py: (g) => { g.use("str"); return `${g.lit(String(g.p.separator ?? ", ").replace(/\\n/g, "\n"))}.join(_str(x) for x in (${g.in.list} if isinstance(${g.in.list}, (list, tuple)) else [${g.in.list}]))`; },
  },

  /* ------------------------------------------------------------ data */
  { type: "data.get", group: "Data", title: "Get field", doc: "Reads a field by path: user.name, items.0.title.",
    inputs: [P("object", "object", { required: true })], outputs: [OUT("value", "any")],
    params: [{ name: "path", label: "Path", type: "string", default: "", placeholder: "items.0.title" }],
    js: (g) => { g.use("get"); return `__get(${g.in.object}, ${g.lit(String(g.p.path ?? ""))})`; }, py: (g) => { g.use("get"); return `_get(${g.in.object}, ${g.lit(String(g.p.path ?? ""))})`; },
  },
  { type: "data.object", group: "Data", title: "Make object", doc: "Builds an object from named inputs (the keys, comma-separated).",
    inputs: (n) => identList(n.params?.keys ?? "a, b").map((k) => P(k, "any")), outputs: [OUT("object", "object")],
    params: [{ name: "keys", label: "Keys", type: "string", default: "a, b", placeholder: "name, count" }],
    js: (g) => `{ ${identList(g.p.keys ?? "a, b").map((k) => `${JSON.stringify(k)}: ${g.in[k]}`).join(", ")} }`,
    py: (g) => `{${identList(g.p.keys ?? "a, b").map((k) => `${JSON.stringify(k)}: ${g.in[k]}`).join(", ")}}`,
  },
  { type: "data.list", group: "Data", title: "Make list", doc: "Collects inputs into a list.",
    inputs: (n) => Array.from({ length: Math.max(1, Math.min(8, Number(n.params?.count ?? 2) || 2)) }, (_, i) => P(`item${i + 1}`, "any")), outputs: [OUT("list", "list")],
    params: [{ name: "count", label: "Items", type: "number", default: 2 }],
    js: (g) => `[${Object.keys(g.in).map((k) => g.in[k]).join(", ")}]`, py: (g) => `[${Object.keys(g.in).map((k) => g.in[k]).join(", ")}]`,
  },
  { type: "data.json", group: "Data", title: "JSON ⇄ text", doc: "Parses JSON text, or turns a value into JSON text.",
    inputs: [P("value", "any", { required: true })], outputs: [OUT("result", "any")],
    params: [{ name: "mode", label: "Do", type: "enum", values: ["parse", "stringify", "pretty"], default: "parse" }],
    js: (g) => g.p.mode === "stringify" ? `JSON.stringify(${g.in.value})` : g.p.mode === "pretty" ? `JSON.stringify(${g.in.value}, null, 2)` : `(typeof ${g.in.value} === "string" ? JSON.parse(${g.in.value}) : ${g.in.value})`,
    py: (g) => g.p.mode === "stringify" ? `_json.dumps(${g.in.value}, ensure_ascii=False)` : g.p.mode === "pretty" ? `_json.dumps(${g.in.value}, ensure_ascii=False, indent=2)` : `(_json.loads(${g.in.value}) if isinstance(${g.in.value}, str) else ${g.in.value})`,
  },
  { type: "data.map", group: "Data", title: "Map list", doc: "Turns each item of a list into something else, with an expression over item and i.",
    inputs: [P("list", "list", { required: true })], outputs: [OUT("list", "list")],
    params: [{ name: "expr", label: "Expression (item, i)", type: "code", default: "item", help: "JavaScript or Python, by the flow's language — e.g. item.name / item[\"name\"]." }],
    js: (g) => `(${g.in.list} || []).map((item, i) => (${String(g.p.expr || "item")}))`,
    py: (g) => `[(${String(g.p.expr || "item")}) for i, item in enumerate(${g.in.list} or [])]`,
  },
  { type: "data.filter", group: "Data", title: "Filter list", doc: "Keeps the items for which a condition over item and i holds.",
    inputs: [P("list", "list", { required: true })], outputs: [OUT("list", "list")],
    params: [{ name: "expr", label: "Condition (item, i)", type: "code", default: "item", help: "e.g. item.price > 10 / item[\"price\"] > 10" }],
    js: (g) => `(${g.in.list} || []).filter((item, i) => (${String(g.p.expr || "item")}))`,
    py: (g) => `[item for i, item in enumerate(${g.in.list} or []) if (${String(g.p.expr || "item")})]`,
  },
  { type: "data.sort", group: "Data", title: "Sort / slice", doc: "Sorts a list (optionally by a field) and keeps the first N.",
    inputs: [P("list", "list", { required: true })], outputs: [OUT("list", "list")],
    params: [{ name: "by", label: "By field (empty: the items)", type: "string", default: "" }, { name: "desc", label: "Descending", type: "boolean", default: false }, { name: "limit", label: "Keep first (0: all)", type: "number", default: 0 }],
    js: (g) => { g.use("get"); const by = String(g.p.by ?? ""); const key = by ? `__get(x, ${g.lit(by)})` : "x"; const lim = Number(g.p.limit) || 0; return `[...(${g.in.list} || [])].sort((a, b) => { const ka = ((x) => ${key})(a), kb = ((x) => ${key})(b); return (ka > kb ? 1 : ka < kb ? -1 : 0) * ${g.p.desc ? -1 : 1}; })${lim > 0 ? `.slice(0, ${lim})` : ""}`; },
    py: (g) => { g.use("get"); const by = String(g.p.by ?? ""); const lim = Number(g.p.limit) || 0; return `sorted(${g.in.list} or [], key=lambda x: ${by ? `_get(x, ${g.lit(by)})` : "x"}, reverse=${g.p.desc ? "True" : "False"})${lim > 0 ? `[:${lim}]` : ""}`; },
  },
  { type: "data.count", group: "Data", title: "Count", doc: "How many items (or characters).",
    inputs: [P("value", "any", { required: true })], outputs: [OUT("count", "number")],
    js: (g) => `(${g.in.value} === undefined || ${g.in.value} === null ? 0 : typeof ${g.in.value} === "object" && !Array.isArray(${g.in.value}) ? Object.keys(${g.in.value}).length : ${g.in.value}.length ?? 0)`,
    py: (g) => `(0 if ${g.in.value} is None else len(${g.in.value}))`,
  },

  /* ------------------------------------------------------------ math & code */
  { type: "math.calc", group: "Code", title: "Calculate", doc: "Arithmetic on two numbers.",
    inputs: [P("a", "number", { default: 0 }), P("b", "number", { default: 0 })], outputs: [OUT("result", "number")],
    params: [{ name: "op", label: "Operation", type: "enum", values: ["+", "-", "*", "/", "%", "power", "min", "max", "round a", "random a..b"], default: "+" }],
    js: (g) => { g.use("num"); const a = `__num(${g.in.a})`, b = `__num(${g.in.b})`; return ({ "+": `${a} + ${b}`, "-": `${a} - ${b}`, "*": `${a} * ${b}`, "/": `${a} / ${b}`, "%": `${a} % ${b}`, power: `${a} ** ${b}`, min: `Math.min(${a}, ${b})`, max: `Math.max(${a}, ${b})`, "round a": `Math.round(${a})`, "random a..b": `${a} + Math.floor(Math.random() * (${b} - ${a} + 1))` } as Record<string, string>)[String(g.p.op)] ?? `${a} + ${b}`; },
    py: (g) => { g.use("num"); const a = `_num(${g.in.a})`, b = `_num(${g.in.b})`; return ({ "+": `${a} + ${b}`, "-": `${a} - ${b}`, "*": `${a} * ${b}`, "/": `${a} / ${b}`, "%": `${a} % ${b}`, power: `${a} ** ${b}`, min: `min(${a}, ${b})`, max: `max(${a}, ${b})`, "round a": `round(${a})`, "random a..b": `_random.randint(int(${a}), int(${b}))` } as Record<string, string>)[String(g.p.op)] ?? `${a} + ${b}`; },
  },
  { type: "code.expr", group: "Code", title: "Expression", doc: "One expression in the flow's language over named inputs.",
    inputs: (n) => identList(n.params?.args ?? "a, b").map((k) => P(k, "any")), outputs: [OUT("result", "any")],
    params: [{ name: "args", label: "Inputs", type: "string", default: "a, b" }, { name: "expr", label: "Expression", type: "code", default: "a + b" }],
    js: (g) => { const args = identList(g.p.args ?? "a, b"); return `((${args.join(", ")}) => (${String(g.p.expr || "undefined")}))(${args.map((k) => g.in[k]).join(", ")})`; },
    py: (g) => { const args = identList(g.p.args ?? "a, b"); return `(lambda ${args.join(", ")}: (${String(g.p.expr || "None")}))(${args.map((k) => g.in[k]).join(", ")})`; },
  },
  { type: "code.block", group: "Code", title: "Code", doc: "A block of code over named inputs; `return` gives the result. await works; m5 is there.",
    inputs: (n) => identList(n.params?.args ?? "a").map((k) => P(k, "any")), outputs: [OUT("result", "any")],
    params: [{ name: "args", label: "Inputs", type: "string", default: "a" }, { name: "code", label: "Code", type: "code", default: "return a;" }],
    js: (g) => { const args = identList(g.p.args ?? "a"); return `await (async (${args.join(", ")}) => {\n${indent(String(g.p.code ?? ""), "    ").join("\n")}\n  })(${args.map((k) => g.in[k]).join(", ")})`; },
    py: (g) => { const args = identList(g.p.args ?? "a"); const fn = `_${g.v}_code`; const body = String(g.p.code ?? "").trim() ? indent(String(g.p.code), "    ") : ["    return None"]; return { pre: [`async def ${fn}(${args.join(", ")}):`, ...body], expr: `await ${fn}(${args.map((k) => g.in[k]).join(", ")})` }; },
  },

  /* ------------------------------------------------------------ outputs */
  { type: "out.text", group: "Output", title: "Send text", doc: "Sends plain text to the caller (in chat: a message).",
    inputs: [P("text", "any", { required: true })], outputs: [], effect: true,
    js: (g) => { g.use("str"); return `await m5.caller.send(m5.out.text(__str(${g.in.text})))`; }, py: (g) => { g.use("str"); return `await m5.caller.send(m5.out.text(_str(${g.in.text})))`; },
  },
  { type: "out.markdown", group: "Output", title: "Send Markdown", doc: "Sends formatted text (Markdown).",
    inputs: [P("text", "any", { required: true })], outputs: [], effect: true,
    js: (g) => { g.use("str"); return `await m5.caller.send(m5.out.markdown(__str(${g.in.text})))`; }, py: (g) => { g.use("str"); return `await m5.caller.send(m5.out.markdown(_str(${g.in.text})))`; },
  },
  { type: "out.code", group: "Output", title: "Send code", doc: "Sends a code block.",
    inputs: [P("text", "any", { required: true })], outputs: [], effect: true, params: [{ name: "lang", label: "Language", type: "string", default: "" }],
    js: (g) => { g.use("str"); return `await m5.caller.send(m5.out.code(__str(${g.in.text}), ${g.lit(String(g.p.lang ?? ""))}))`; }, py: (g) => { g.use("str"); return `await m5.caller.send(m5.out.code(_str(${g.in.text}), ${g.lit(String(g.p.lang ?? ""))}))`; },
  },
  { type: "out.json", group: "Output", title: "Send JSON", doc: "Sends a value as JSON.",
    inputs: [P("value", "any", { required: true })], outputs: [], effect: true, params: [{ name: "title", label: "Title", type: "string", default: "" }],
    js: (g) => `await m5.caller.send(m5.out.json(${g.in.value}${g.p.title ? `, { title: ${g.lit(String(g.p.title))} }` : ""}))`,
    py: (g) => `await m5.caller.send(m5.out.json(${g.in.value}${g.p.title ? `, title=${g.lit(String(g.p.title))}` : ""}))`,
  },
  { type: "out.table", group: "Output", title: "Send table", doc: "Sends a table: a list of objects (columns from their keys) or of rows.",
    inputs: [P("rows", "list", { required: true })], outputs: [], effect: true,
    params: [{ name: "columns", label: "Columns (empty: from the data)", type: "string", default: "" }, { name: "title", label: "Title", type: "string", default: "" }],
    js: (g) => { g.use("table"); return `await m5.caller.send(m5.out.table(...__table(${g.in.rows}, ${g.lit(list(g.p.columns))})${g.p.title ? `, { title: ${g.lit(String(g.p.title))} }` : ""}))`; },
    py: (g) => { g.use("table"); return `await m5.caller.send(m5.out.table(*_table(${g.in.rows}, ${g.lit(list(g.p.columns))})${g.p.title ? `, title=${g.lit(String(g.p.title))}` : ""}))`; },
  },
  { type: "out.image", group: "Output", title: "Send image", doc: "Sends an image (bytes, or the result of a QR/bar code node).",
    inputs: [P("image", "bytes", { required: true })], outputs: [], effect: true,
    params: [{ name: "mime", label: "Type", type: "enum", values: ["auto", "image/png", "image/svg+xml", "image/jpeg", "image/webp"], default: "auto" }, { name: "alt", label: "Alt text", type: "string", default: "" }],
    js: (g) => { g.use("bytes"); const mime = g.p.mime && g.p.mime !== "auto" ? g.lit(String(g.p.mime)) : `(${g.in.image}?.mime || "image/png")`; return `await m5.caller.send(m5.out.image(__bytes(${g.in.image}), ${mime}${g.p.alt ? `, { alt: ${g.lit(String(g.p.alt))} }` : ""}))`; },
    py: (g) => { g.use("bytes"); const mime = g.p.mime && g.p.mime !== "auto" ? g.lit(String(g.p.mime)) : `((${g.in.image} or {}).get("mime") if isinstance(${g.in.image}, dict) else None) or "image/png"`; return `await m5.caller.send(m5.out.image(_bytes(${g.in.image}), ${mime}${g.p.alt ? `, alt=${g.lit(String(g.p.alt))}` : ""}))`; },
  },
  { type: "out.file", group: "Output", title: "Send file", doc: "Sends a file to download (audio from speech plays in the console).",
    inputs: [P("data", "bytes", { required: true })], outputs: [], effect: true,
    params: [{ name: "name", label: "File name", type: "string", default: "result.txt" }, { name: "mime", label: "Type (auto: from the data)", type: "string", default: "auto" }],
    js: (g) => { g.use("bytes"); const mime = g.p.mime && g.p.mime !== "auto" ? g.lit(String(g.p.mime)) : `(${g.in.data}?.mime || "application/octet-stream")`; return `await m5.caller.send(m5.out.file(${g.lit(String(g.p.name || "result.bin"))}, __bytes(${g.in.data}), ${mime}))`; },
    py: (g) => { g.use("bytes"); const mime = g.p.mime && g.p.mime !== "auto" ? g.lit(String(g.p.mime)) : `((${g.in.data} or {}).get("mime") if isinstance(${g.in.data}, dict) else None) or "application/octet-stream"`; return `await m5.caller.send(m5.out.file(${g.lit(String(g.p.name || "result.bin"))}, _bytes(${g.in.data}), ${mime}))`; },
  },
  { type: "out.flash", group: "Output", title: "Flash", doc: "A short notice for the caller (info, success, warning, error).",
    inputs: [P("text", "any", { required: true })], outputs: [], effect: true,
    params: [{ name: "level", label: "Level", type: "enum", values: ["info", "success", "warning", "error"], default: "info" }],
    js: (g) => { g.use("str"); return `await m5.caller.flash(__str(${g.in.text}), ${g.lit(String(g.p.level || "info"))})`; }, py: (g) => { g.use("str"); return `await m5.caller.flash(_str(${g.in.text}), ${g.lit(String(g.p.level || "info"))})`; },
  },
  // 5.3: sound, buttons, forms and browser code in the message.
  { type: "out.audio", group: "Output", title: "Play sound", doc: "Sound to play in the chat (e.g. from “Text → speech”).",
    inputs: [P("audio", "bytes", { required: true })], outputs: [], effect: true,
    params: [{ name: "mime", label: "Type (auto: from the data)", type: "string", default: "auto" }, { name: "title", label: "Title", type: "string", default: "" }, { name: "autoplay", label: "Play at once", type: "boolean", default: true }],
    js: (g) => { g.use("bytes"); const mime = g.p.mime && g.p.mime !== "auto" ? g.lit(String(g.p.mime)) : `(${g.in.audio}?.mime || "audio/wav")`; return `await m5.caller.send(m5.out.audio(__bytes(${g.in.audio}), ${mime}, ${g.lit({ ...(g.p.title ? { title: String(g.p.title) } : {}), autoplay: g.p.autoplay !== false })}))`; },
    py: (g) => { g.use("bytes"); const mime = g.p.mime && g.p.mime !== "auto" ? g.lit(String(g.p.mime)) : `((${g.in.audio} or {}).get("mime") if isinstance(${g.in.audio}, dict) else None) or "audio/wav"`; return `await m5.caller.send(m5.out.audio(_bytes(${g.in.audio}), ${mime}${g.p.title ? `, title=${g.lit(String(g.p.title))}` : ""}, autoplay=${g.p.autoplay !== false ? "True" : "False"}))`; },
  },
  { type: "out.button", group: "Output", title: "Button", doc: "A button in the message: a click runs the model's button entry point (the flow's “button” function) with its name and data.",
    // data: typed in as JSON ({"page": 2}), or wired from any node.
    inputs: [P("data", "json", { placeholder: "{\"page\": 2}" })], outputs: [], effect: true,
    params: [{ name: "button", label: "Button", type: "button", default: { name: "more", title: "More", css: "primary" } }],
    js: (g) => `await m5.caller.send(m5.out.button({ ...${g.lit(objParam(g.p.button))}, data: ${g.in.data} }))`,
    py: (g) => `await m5.caller.send(m5.out.button({**${g.lit(objParam(g.p.button))}, "data": ${g.in.data}}))`,
  },
  { type: "out.form", group: "Output", title: "Form", doc: "A form in the message (panels, rows or columns, every field type): sending it runs the model's form entry point (the flow's “form” function) with { name, values }.",
    inputs: [], outputs: [], effect: true,
    params: [{ name: "form", label: "Form", type: "form", default: { name: "contact", title: "Contact", fields: [{ name: "email", type: "email", label: "E-mail", required: true }, { name: "text", type: "textarea", label: "Message" }] } }],
    js: (g) => `await m5.caller.send(m5.out.form(${g.lit(objParam(g.p.form))}))`,
    py: (g) => `await m5.caller.send(m5.out.form(${g.lit(objParam(g.p.form))}))`,
  },
  { type: "out.js", group: "Output", title: "Browser code", doc: "JavaScript for the viewer's browser, in a sandbox (no access to the app): m5.args, m5.root, m5.flash, m5.send → the button function, m5.submit → the form function.",
    inputs: [P("args", "json", { placeholder: "{\"n\": 5}" })], outputs: [], effect: true,
    params: [{ name: "code", label: "Code (JavaScript, in the browser)", type: "jscode", default: "m5.flash(\"Hello from the browser!\", \"success\");" }, { name: "title", label: "Title", type: "string", default: "" }, { name: "height", label: "Height px (0: fits)", type: "number", default: 0 }, { name: "hidden", label: "Hidden (an effect)", type: "boolean", default: false }],
    js: (g) => { const o = { ...(g.p.title ? { title: String(g.p.title) } : {}), ...(Number(g.p.height) > 0 ? { height: Number(g.p.height) } : {}), ...(g.p.hidden ? { hidden: true } : {}) }; return `await m5.caller.send(m5.out.js(${g.lit(String(g.p.code ?? ""))}, ${g.in.args}${Object.keys(o).length ? `, ${g.lit(o)}` : ""}))`; },
    py: (g) => `await m5.caller.send(m5.out.js(${g.lit(String(g.p.code ?? ""))}, ${g.in.args}${g.p.title ? `, title=${g.lit(String(g.p.title))}` : ""}${Number(g.p.height) > 0 ? `, height=${Number(g.p.height)}` : ""}${g.p.hidden ? ", hidden=True" : ""}))`,
  },

  { type: "out.html", group: "Output", title: "Send HTML", doc: "Formatted HTML in the chat: headings, tables, lists, details, figures, links and pictures as data:image URIs. Scripts, styles, forms and handlers are removed (the server and every viewer sanitize it).",
    inputs: [P("html", "text", { required: true, placeholder: "<h3>Hello</h3>" })], outputs: [], effect: true,
    params: [{ name: "title", label: "Title", type: "string", default: "" }],
    js: (g) => { g.use("str"); return `await m5.caller.send(m5.out.html(__str(${g.in.html})${g.p.title ? `, { title: ${g.lit(String(g.p.title))} }` : ""}))`; },
    py: (g) => { g.use("str"); return `await m5.caller.send(m5.out.html(_str(${g.in.html})${g.p.title ? `, title=${g.lit(String(g.p.title))}` : ""}))`; },
  },

  /* ------------------------------------------------------------ entry points (5.3) */
  { type: "flow.event", group: "Flow", title: "Entry point data", doc: "What this function got as an entry point: a reply's text, a button's name and data, a form's values, an error.",
    inputs: [], outputs: [
      FIELD("text", (v) => `${v}.text`, (v) => `${v}.get("text")`, "text", "reply text"),
      FIELD("name", (v) => `${v}.name`, (v) => `${v}.get("name")`, "text", "button / form name"),
      FIELD("data", (v) => `${v}.data`, (v) => `${v}.get("data")`, "any", "button data"),
      FIELD("values", (v) => `${v}.values`, (v) => `${v}.get("values")`, "object", "form values"),
      FIELD("error", (v) => `${v}.error`, (v) => `${v}.get("error")`, "object", "error"),
      FIELD("event", (v) => `${v}.event`, (v) => `${v}.get("event")`, "object"),
      OUT("all", "object", "all inputs"),
    ],
    js: () => "inputs", py: () => "inputs",
  },
  { type: "model.history", group: "Flow", title: "Model session", doc: "m5.model: this call's type, the calls of the processing session (calls[0] is the first — execute or a webhook), the current and the last one.",
    inputs: [], outputs: [
      FIELD("type", (v) => `${v}.type`, (v) => `${v}.type`, "text"),
      FIELD("call", (v) => `${v}.call`, (v) => `${v}.call`, "number"),
      FIELD("first", (v) => `${v}.first`, (v) => `${v}.first`, "object"),
      FIELD("last", (v) => `${v}.last`, (v) => `${v}.last`, "object"),
      FIELD("current", (v) => `${v}.current`, (v) => `${v}.current`, "object"),
      FIELD("calls", (v) => `${v}.calls`, (v) => `${v}.calls`, "list"),
      FIELD("chain", (v) => `${v}.chain`, (v) => `${v}.chain`, "text"),
    ],
    js: () => "m5.model", py: () => "m5.model",
  },

  /* ------------------------------------------------------------ ask */
  { type: "ask.prompt", group: "Ask", title: "Ask the caller", doc: "Asks a question and waits for the answer (choices become buttons).",
    inputs: [P("question", "text", { default: "Continue?" })], outputs: [OUT("answer", "text")],
    params: [{ name: "choices", label: "Choices (comma-separated; empty: free text)", type: "string", default: "yes, no" }],
    js: (g) => { const c = list(g.p.choices); g.use("str"); return `await m5.prompt({ text: __str(${g.in.question})${c.length ? `, choices: ${g.lit(c)}` : ""} })`; },
    py: (g) => { const c = list(g.p.choices); g.use("str"); return `await m5.prompt({"text": _str(${g.in.question})${c.length ? `, "choices": ${g.lit(c)}` : ""}})`; },
  },

  /* ------------------------------------------------------------ store */
  { type: "store.get", group: "Store", title: "Remember: read", doc: "Reads a value kept by an earlier run (session: this caller in this room; cache: shared, with TTL; conversation: this model's processing session only — m5.model.session / cache).",
    inputs: [P("key", "text", { required: true, default: "count" })], outputs: [OUT("value", "any")],
    params: [{ name: "where", label: "Where", type: "enum", values: STORE_WHERE, default: "session" }],
    js: (g) => `await m5.${storeNs(g.p.where)}.get(${g.in.key})`, py: (g) => `await m5.${storeNs(g.p.where)}.get(${g.in.key})`,
  },
  { type: "store.set", group: "Store", title: "Remember: write", doc: "Keeps a value for later runs (optionally for a while: TTL in seconds).",
    inputs: [P("key", "text", { required: true, default: "count" }), P("value", "any")], outputs: [OUT("value", "any")], effect: true,
    params: [{ name: "where", label: "Where", type: "enum", values: STORE_WHERE, default: "session" }, { name: "ttl", label: "TTL seconds (0: keep)", type: "number", default: 0 }],
    js: (g) => { const ns = storeNs(g.p.where); const ttl = Number(g.p.ttl) || 0; return `(await m5.${ns}.set(${g.in.key}, ${g.in.value}${ttl ? `, { ttl: ${ttl} }` : ""}), ${g.in.value})`; },
    py: (g) => { const ns = storeNs(g.p.where); const ttl = Number(g.p.ttl) || 0; return `(await m5.${ns}.set(${g.in.key}, ${g.in.value}${ttl ? `, ttl=${ttl}` : ""}), ${g.in.value})[1]`; },
  },
  { type: "store.incr", group: "Store", title: "Counter", doc: "Adds to a shared counter and gives the new value.",
    inputs: [P("key", "text", { required: true, default: "visits" }), P("by", "number", { default: 1 })], outputs: [OUT("value", "number")], effect: true,
    js: (g) => `await m5.cache.incr(${g.in.key}, ${g.in.by})`, py: (g) => `await m5.cache.incr(${g.in.key}, ${g.in.by})`,
  },

  /* ------------------------------------------------------------ web */
  { type: "http.request", group: "Web", title: "HTTP request", doc: "Calls a URL from the server (public addresses only). JSON answers are parsed.",
    inputs: [P("url", "text", { required: true, placeholder: "https://api.example.com/…" }), P("body", "json")],
    outputs: [FIELD("json", ...prop("json"), "json"), FIELD("text", ...prop("text"), "text"), FIELD("status", ...prop("status"), "number"), FIELD("ok", ...prop("ok"), "boolean"), OUT("response", "object")],
    params: [{ name: "method", label: "Method", type: "enum", values: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"], default: "GET" }, { name: "headers", label: "Headers (JSON)", type: "json", default: "" }],
    js: (g) => { g.use("clean"); const h = parseJsonParam(g.p.headers); return `await m5.http.request(__clean({ method: ${g.lit(String(g.p.method || "GET"))}, url: ${g.in.url}, json: ${g.in.body}${h ? `, headers: ${g.lit(h)}` : ""} }))`; },
    py: (g) => { g.use("clean"); const h = parseJsonParam(g.p.headers); return `await m5.http.request(_clean({"method": ${g.lit(String(g.p.method || "GET"))}, "url": ${g.in.url}, "json": ${g.in.body}${h ? `, "headers": ${g.lit(h)}` : ""}}))`; },
  },
  { type: "dns.resolve", group: "Web", title: "DNS lookup", doc: "Resolves a name: A, AAAA, MX, TXT, NS, CNAME…",
    inputs: [P("name", "text", { required: true, default: "example.com" })], outputs: [OUT("records", "list")],
    params: [{ name: "type", label: "Record", type: "enum", values: ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "CAA", "PTR", "SOA"], default: "A" }],
    js: (g) => `await m5.dns.resolve(${g.in.name}, ${g.lit(String(g.p.type || "A"))})`, py: (g) => `await m5.dns.resolve(${g.in.name}, ${g.lit(String(g.p.type || "A"))})`,
  },

  /* ------------------------------------------------------------ AI & speech */
  { type: "ai.chat", group: "AI & speech", title: "Ask AI", doc: "Asks the instance's AI model (counted against its budget).",
    inputs: [P("prompt", "text", { required: true }), P("system", "text")], outputs: [FIELD("text", ...prop("text"), "text"), OUT("result", "object")],
    params: [{ name: "model", label: "Model (empty: default)", type: "string", default: "" }],
    js: (g) => { g.use("clean"); g.use("str"); return `await m5.ai.chat(__clean({ messages: [{ role: "user", content: __str(${g.in.prompt}) }], system: ${g.in.system}, model: ${g.lit(String(g.p.model ?? ""))} }))`; },
    py: (g) => { g.use("clean"); g.use("str"); return `await m5.ai.chat(_clean({"messages": [{"role": "user", "content": _str(${g.in.prompt})}], "system": ${g.in.system}, "model": ${g.lit(String(g.p.model ?? ""))}}))`; },
  },
  { type: "ai.tts", group: "AI & speech", title: "Text → speech", doc: "Synthesizes speech (the built-in offline voices, or any speech provider).",
    inputs: [P("text", "text", { required: true })], outputs: [FIELD("audio", ...prop("audio"), "bytes"), OUT("result", "object")],
    params: [{ name: "voice", label: "Voice (empty: default)", type: "string", default: "" }, { name: "model", label: "Model (empty: default)", type: "string", default: "" }],
    js: (g) => { g.use("clean"); g.use("str"); return `await m5.ai.tts(__clean({ text: __str(${g.in.text}), voice: ${g.lit(String(g.p.voice ?? ""))}, model: ${g.lit(String(g.p.model ?? ""))} }))`; },
    py: (g) => { g.use("clean"); g.use("str"); return `await m5.ai.tts(**_clean({"text": _str(${g.in.text}), "voice": ${g.lit(String(g.p.voice ?? ""))}, "model": ${g.lit(String(g.p.model ?? ""))}}))`; },
  },
  { type: "ai.stt", group: "AI & speech", title: "Speech → text", doc: "Transcribes audio (WAV works everywhere; the built-in engine is offline).",
    inputs: [P("audio", "bytes", { required: true })], outputs: [FIELD("text", ...prop("text"), "text")],
    params: [{ name: "mime", label: "Audio type", type: "string", default: "audio/wav" }, { name: "language", label: "Language (e.g. cs; empty: detect)", type: "string", default: "" }],
    js: (g) => { g.use("clean"); g.use("bytes"); return `await m5.ai.stt(__clean({ audio: __bytes(${g.in.audio}), mime: ${g.lit(String(g.p.mime || "audio/wav"))}, language: ${g.lit(String(g.p.language ?? ""))} }))`; },
    py: (g) => { g.use("clean"); g.use("bytes"); return `await m5.ai.stt(**_clean({"audio": _bytes(${g.in.audio}), "mime": ${g.lit(String(g.p.mime || "audio/wav"))}, "language": ${g.lit(String(g.p.language ?? ""))}}))`; },
  },

  /* ------------------------------------------------------------ crypto, ids, codes */
  { type: "crypto.hash", group: "Crypto & codes", title: "Hash", doc: "A hash of text or bytes (hex).",
    inputs: [P("data", "text", { required: true })], outputs: [OUT("hash", "text")],
    params: [{ name: "alg", label: "Algorithm", type: "enum", values: HASH_ALGS, default: "sha256" }, { name: "encoding", label: "Encoding", type: "enum", values: ["hex", "base64", "base64url"], default: "hex" }],
    js: (g) => `m5.crypto.hash(${g.lit(String(g.p.alg || "sha256"))}, ${g.in.data}, ${g.lit(String(g.p.encoding || "hex"))})`, py: (g) => `m5.crypto.hash(${g.lit(String(g.p.alg || "sha256"))}, ${g.in.data}, ${g.lit(String(g.p.encoding || "hex"))})`,
  },
  { type: "crypto.hmac", group: "Crypto & codes", title: "HMAC", doc: "A keyed hash (e.g. to sign a webhook).",
    inputs: [P("key", "text", { required: true }), P("data", "text", { required: true })], outputs: [OUT("mac", "text")],
    params: [{ name: "alg", label: "Algorithm", type: "enum", values: ["sha256", "sha512", "sha1"], default: "sha256" }],
    js: (g) => `m5.crypto.hmac(${g.lit(String(g.p.alg || "sha256"))}, ${g.in.key}, ${g.in.data}, "hex")`, py: (g) => `m5.crypto.hmac(${g.lit(String(g.p.alg || "sha256"))}, ${g.in.key}, ${g.in.data}, "hex")`,
  },
  { type: "codec.encode", group: "Crypto & codes", title: "Encode", doc: "Text or bytes → base64, base32, base58, hex.",
    inputs: [P("data", "text", { required: true })], outputs: [OUT("text", "text")],
    params: [{ name: "codec", label: "Codec", type: "enum", values: CODECS, default: "base64" }],
    js: (g) => `m5.codec.${codecName(g.p.codec)}.encode(${g.in.data})`, py: (g) => `m5.codec.${codecName(g.p.codec)}.encode(${g.in.data})`,
  },
  { type: "codec.decode", group: "Crypto & codes", title: "Decode", doc: "base64/32/58/hex → bytes (or text).",
    inputs: [P("text", "text", { required: true })], outputs: [OUT("data", "bytes")],
    params: [{ name: "codec", label: "Codec", type: "enum", values: CODECS, default: "base64" }, { name: "asText", label: "As UTF-8 text", type: "boolean", default: true }],
    js: (g) => g.p.asText === false ? `m5.codec.${codecName(g.p.codec)}.decode(${g.in.text})` : `m5.codec.utf8.decode(m5.codec.${codecName(g.p.codec)}.decode(${g.in.text}))`,
    py: (g) => g.p.asText === false ? `m5.codec.${codecName(g.p.codec)}.decode(${g.in.text})` : `m5.codec.utf8.decode(m5.codec.${codecName(g.p.codec)}.decode(${g.in.text}))`,
  },
  { type: "id.new", group: "Crypto & codes", title: "New id", doc: "A UUID, time-ordered UUIDv7, ULID or short nanoid.",
    inputs: [], outputs: [OUT("id", "text")],
    params: [{ name: "kind", label: "Kind", type: "enum", values: ["uuid", "uuid7", "ulid", "nanoid"], default: "uuid" }],
    js: (g) => `m5.id.${["uuid", "uuid7", "ulid", "nanoid"].includes(String(g.p.kind)) ? g.p.kind : "uuid"}()`, py: (g) => `m5.id.${["uuid", "uuid7", "ulid", "nanoid"].includes(String(g.p.kind)) ? g.p.kind : "uuid"}()`,
  },
  { type: "codes.qr", group: "Crypto & codes", title: "QR code", doc: "Text → a QR code image (connect to “Send image”).",
    inputs: [P("text", "text", { required: true })], outputs: [OUT("image", "bytes")],
    params: [{ name: "format", label: "Format", type: "enum", values: ["svg", "png"], default: "svg" }, { name: "scale", label: "Scale", type: "number", default: 4 }],
    js: (g) => { g.use("str"); return `await m5.codes.qr(__str(${g.in.text}), { format: ${g.lit(String(g.p.format || "svg"))}, scale: ${Number(g.p.scale) || 4} })`; },
    py: (g) => { g.use("str"); return `await m5.codes.qr(_str(${g.in.text}), format=${g.lit(String(g.p.format || "svg"))}, scale=${Number(g.p.scale) || 4})`; },
  },
  { type: "codes.barcode", group: "Crypto & codes", title: "Bar code", doc: "Code128, EAN-13, DataMatrix, PDF417, Aztec… (connect to “Send image”).",
    inputs: [P("text", "text", { required: true })], outputs: [OUT("image", "bytes")],
    params: [{ name: "type", label: "Symbology", type: "enum", values: ["code128", "ean13", "ean8", "upca", "datamatrix", "pdf417", "azteccode", "code39", "itf14"], default: "code128" }, { name: "format", label: "Format", type: "enum", values: ["svg", "png"], default: "svg" }],
    js: (g) => { g.use("str"); return `await m5.codes.barcode(${g.lit(String(g.p.type || "code128"))}, __str(${g.in.text}), { format: ${g.lit(String(g.p.format || "svg"))} })`; },
    py: (g) => { g.use("str"); return `await m5.codes.barcode(${g.lit(String(g.p.type || "code128"))}, _str(${g.in.text}), format=${g.lit(String(g.p.format || "svg"))})`; },
  },

  /* ------------------------------------------------------------ utility */
  { type: "util.log", group: "Utility", title: "Log", doc: "Writes a log line (shown in the run's logs).",
    inputs: [P("value", "any")], outputs: [OUT("value", "any")], effect: true,
    params: [{ name: "message", label: "Message", type: "string", default: "value" }, { name: "level", label: "Level", type: "enum", values: ["debug", "info", "warn", "error"], default: "info" }],
    js: (g) => `(m5.log.${logLevel(g.p.level)}(${g.lit(String(g.p.message ?? "value"))}, { value: ${g.in.value} }), ${g.in.value})`,
    py: (g) => `(m5.log.${logLevel(g.p.level)}(${g.lit(String(g.p.message ?? "value"))}, value=${g.in.value}), ${g.in.value})[1]`,
  },
  { type: "util.now", group: "Utility", title: "Now", doc: "The current time: ISO text, milliseconds, or the caller's local date/time.",
    inputs: [], outputs: [OUT("time", "any")],
    params: [{ name: "format", label: "Format", type: "enum", values: ["iso", "ms", "local"], default: "iso" }],
    js: (g) => g.p.format === "ms" ? "m5.sys.now()" : g.p.format === "local" ? "new Date(m5.sys.now()).toLocaleString(m5.sys.lang || \"en\", { timeZone: m5.sys.tz || \"UTC\" })" : "new Date(m5.sys.now()).toISOString()",
    py: (g) => g.p.format === "ms" ? "m5.sys.now()" : g.p.format === "local" ? "_dt.datetime.fromtimestamp(m5.sys.now() / 1000).strftime(\"%Y-%m-%d %H:%M:%S\")" : "_dt.datetime.fromtimestamp(m5.sys.now() / 1000, _dt.timezone.utc).isoformat()",
  },
  { type: "util.caller", group: "Utility", title: "Caller", doc: "Who runs it: name, language, time zone, room.",
    inputs: [], outputs: [FIELD("name", (v) => `${v}.name`, (v) => `${v}["name"]`, "text"), FIELD("lang", (v) => `${v}.lang`, (v) => `${v}["lang"]`, "text"), FIELD("tz", (v) => `${v}.tz`, (v) => `${v}["tz"]`, "text"), FIELD("room", (v) => `${v}.room`, (v) => `${v}["room"]`, "text")],
    js: () => "({ name: m5.caller.name, lang: m5.sys.lang, tz: m5.sys.tz, room: m5.caller.room })",
    py: () => "{\"name\": m5.caller.name, \"lang\": m5.sys.lang, \"tz\": m5.sys.tz, \"room\": m5.caller.room}",
  },
  { type: "util.sleep", group: "Utility", title: "Wait", doc: "Pauses for a while (counts against the time limit).",
    inputs: [P("value", "any")], outputs: [OUT("value", "any")], effect: true,
    params: [{ name: "ms", label: "Milliseconds", type: "number", default: 500 }],
    js: (g) => `(await m5.sleep(${Math.max(0, Number(g.p.ms) || 0)}), ${g.in.value})`, py: (g) => `(await m5.sleep(${Math.max(0, Number(g.p.ms) || 0)}), ${g.in.value})[1]`,
  },

  /* ------------------------------------------------------------ telephony (6.0, m5.telephony) */
  { type: "tel.call", group: "Telephony", title: "Phone call", doc: "Calls a number (ring timeout in seconds, default 10). Says the text when answered. Handlers name functions of this flow (on_answer, on_hangup, on_busy…) — they run when the provider reports; with “wait” the run waits for the end of the call.",
    inputs: [P("to", "text", { required: true, placeholder: "+420603123456" }), P("text", "text"), P("options", "object")],
    outputs: [OUT("call", "object"), FIELD("id", ...prop("id"), "text"), FIELD("status", ...prop("status"), "text"), FIELD("duration", ...prop("durationSec"), "number")], effect: true,
    params: [
      { name: "from", label: "From (empty: the provider's number)", type: "string", default: "" },
      { name: "timeout", label: "Ring timeout (s)", type: "number", default: 10 },
      { name: "provider", label: "Provider (empty: the default)", type: "enum", values: ["", "twilio", "telnyx", "vonage"], default: "" },
      { name: "wait", label: "Wait for the end of the call", type: "boolean", default: false },
      { name: "on_answer", label: "On answer (function; returns call logic)", type: "string", default: "" },
      { name: "on_hangup", label: "On hang-up (function)", type: "string", default: "" },
      { name: "on_busy", label: "On busy / no answer / failed (function)", type: "string", default: "" },
    ],
    js: (g) => { g.use("clean"); g.use("str"); const busy = String(g.p.on_busy ?? ""); return `await m5.telephony.call({ ...__clean(${g.in.options} || {}), ...__clean({ to: __str(${g.in.to}), say: __str(${g.in.text}), from: ${g.lit(String(g.p.from ?? ""))}, timeout: ${Number(g.p.timeout) || 10}, provider: ${g.lit(String(g.p.provider ?? ""))}, wait: ${g.p.wait ? "true" : "undefined"}, on: __clean({ answer: ${g.lit(String(g.p.on_answer ?? ""))}, hangup: ${g.lit(String(g.p.on_hangup ?? ""))}, busy: ${g.lit(busy)}, noanswer: ${g.lit(busy)}, failed: ${g.lit(busy)} }) }) })`; },
    py: (g) => { g.use("clean"); g.use("str"); const busy = String(g.p.on_busy ?? ""); return `await m5.telephony.call({**_clean(${g.in.options} or {}), **_clean({"to": _str(${g.in.to}), "say": _str(${g.in.text}), "from": ${g.lit(String(g.p.from ?? ""))}, "timeout": ${Number(g.p.timeout) || 10}, "provider": ${g.lit(String(g.p.provider ?? ""))}, "wait": ${g.p.wait ? "True" : "None"}, "on": _clean({"answer": ${g.lit(String(g.p.on_answer ?? ""))}, "hangup": ${g.lit(String(g.p.on_hangup ?? ""))}, "busy": ${g.lit(busy)}, "noanswer": ${g.lit(busy)}, "failed": ${g.lit(busy)}})})})`; },
  },
  { type: "tel.sms", group: "Telephony", title: "SMS", doc: "Sends an SMS; its delivery report updates it (and runs the on-status function).",
    inputs: [P("to", "text", { required: true, placeholder: "+420603123456" }), P("text", "text", { required: true }), P("options", "object")],
    outputs: [OUT("message", "object"), FIELD("id", ...prop("id"), "text"), FIELD("status", ...prop("status"), "text")], effect: true,
    params: [{ name: "from", label: "From (empty: default)", type: "string", default: "" }, { name: "provider", label: "Provider", type: "enum", values: ["", "twilio", "telnyx", "vonage"], default: "" }, { name: "unicode", label: "Unicode (diacritics)", type: "boolean", default: true }, { name: "on_status", label: "On delivery (function)", type: "string", default: "" }],
    js: (g) => { g.use("clean"); g.use("str"); return `await m5.telephony.sms({ ...__clean(${g.in.options} || {}), ...__clean({ to: __str(${g.in.to}), text: __str(${g.in.text}), from: ${g.lit(String(g.p.from ?? ""))}, provider: ${g.lit(String(g.p.provider ?? ""))}, options: { unicode: ${g.p.unicode === false ? "false" : "true"} }, on_status: ${g.lit(String(g.p.on_status ?? ""))} }) })`; },
    py: (g) => { g.use("clean"); g.use("str"); return `await m5.telephony.sms({**_clean(${g.in.options} or {}), **_clean({"to": _str(${g.in.to}), "text": _str(${g.in.text}), "from": ${g.lit(String(g.p.from ?? ""))}, "provider": ${g.lit(String(g.p.provider ?? ""))}, "options": {"unicode": ${g.p.unicode === false ? "False" : "True"}}, "on_status": ${g.lit(String(g.p.on_status ?? ""))}})})`; },
  },
  { type: "tel.message", group: "Telephony", title: "WhatsApp / Viber / Messenger", doc: "A message on a chat channel. WhatsApp outside the 24-hour window needs a template (its name and parameters).",
    inputs: [P("to", "text", { required: true }), P("text", "text"), P("params", "list"), P("options", "object")],
    outputs: [OUT("message", "object"), FIELD("status", ...prop("status"), "text")], effect: true,
    params: [{ name: "channel", label: "Channel", type: "enum", values: ["whatsapp", "viber", "messenger"], default: "whatsapp" }, { name: "template", label: "Template (WhatsApp; empty: text)", type: "string", default: "" }, { name: "language", label: "Template language", type: "string", default: "cs" }, { name: "from", label: "From (empty: default)", type: "string", default: "" }, { name: "provider", label: "Provider", type: "enum", values: ["", "twilio", "telnyx", "vonage", "meta"], default: "" }],
    js: (g) => { g.use("clean"); g.use("str"); const tpl = String(g.p.template ?? ""); return `await m5.telephony.${telChannel(g.p.channel)}({ ...__clean(${g.in.options} || {}), ...__clean({ to: __str(${g.in.to}), text: __str(${g.in.text}), from: ${g.lit(String(g.p.from ?? ""))}, provider: ${g.lit(String(g.p.provider ?? ""))}${tpl ? `, template: { name: ${g.lit(tpl)}, language: ${g.lit(String(g.p.language || "cs"))}, params: Array.isArray(${g.in.params}) ? ${g.in.params}.map(String) : [] }` : ""} }) })`; },
    py: (g) => { g.use("clean"); g.use("str"); const tpl = String(g.p.template ?? ""); return `await m5.telephony.${telChannel(g.p.channel)}({**_clean(${g.in.options} or {}), **_clean({"to": _str(${g.in.to}), "text": _str(${g.in.text}), "from": ${g.lit(String(g.p.from ?? ""))}, "provider": ${g.lit(String(g.p.provider ?? ""))}${tpl ? `, "template": {"name": ${g.lit(tpl)}, "language": ${g.lit(String(g.p.language || "cs"))}, "params": [str(x) for x in (${g.in.params} or [])]}` : ""}})})`; },
  },
  { type: "tel.lookup", group: "Telephony", title: "Number lookup", doc: "Everything about a phone number: country, type, formats, time zones (offline, free) — and carrier, name, porting, roaming, reachability from the configured providers (paid; off: offline only).",
    inputs: [P("number", "text", { required: true, placeholder: "+420603123456" }), P("options", "object")],
    outputs: [OUT("result", "object"), FIELD("summary", ...prop("summary"), "object"), FIELD("country", (v) => `${v}?.summary?.country`, (v) => `((${v} or {}).get("summary") or {}).get("country")`, "any"), FIELD("type", (v) => `${v}?.summary?.type`, (v) => `((${v} or {}).get("summary") or {}).get("type")`, "text"), FIELD("valid", (v) => `${v}?.summary?.valid`, (v) => `((${v} or {}).get("summary") or {}).get("valid")`, "boolean")],
    params: [{ name: "providers", label: "Ask the providers (paid)", type: "boolean", default: true }, { name: "fields", label: "Fields (comma-separated; empty: the usual)", type: "string", default: "" }, { name: "country", label: "Country for national numbers (ISO, e.g. CZ)", type: "string", default: "" }],
    js: (g) => { g.use("clean"); g.use("str"); return `await m5.telephony.lookup(__str(${g.in.number}), { ...__clean(${g.in.options} || {}), ...__clean({ offline: ${g.p.providers === false ? "true" : "undefined"}, fields: ${list(g.p.fields).length ? g.lit(list(g.p.fields)) : "undefined"}, country: ${g.lit(String(g.p.country ?? ""))} }) })`; },
    py: (g) => { g.use("clean"); g.use("str"); return `await m5.telephony.lookup(_str(${g.in.number}), **{**_clean(${g.in.options} or {}), **_clean({"offline": ${g.p.providers === false ? "True" : "None"}, "fields": ${list(g.p.fields).length ? g.lit(list(g.p.fields)) : "None"}, "country": ${g.lit(String(g.p.country ?? ""))}})})`; },
  },
  { type: "tel.hlr", group: "Telephony", title: "HLR", doc: "Asks the number's home network: connected or absent, roaming (country, network), ported, the network.",
    inputs: [P("number", "text", { required: true })],
    outputs: [OUT("result", "object"), FIELD("status", ...prop("status"), "text"), FIELD("roaming", ...prop("roaming"), "any"), FIELD("network", ...prop("network"), "any")],
    params: [{ name: "provider", label: "Provider (empty: the first that can)", type: "enum", values: ["", "hlrlookups", "vonage"], default: "" }],
    js: (g) => { g.use("clean"); g.use("str"); return `await m5.telephony.hlr(__str(${g.in.number}), __clean({ provider: ${g.lit(String(g.p.provider ?? ""))} }))`; },
    py: (g) => { g.use("clean"); g.use("str"); return `await m5.telephony.hlr(_str(${g.in.number}), **_clean({"provider": ${g.lit(String(g.p.provider ?? ""))}}))`; },
  },
  { type: "tel.did", group: "Telephony", title: "Temporary number", doc: "Lends a phone number and a 5-digit code for a member of a room: whoever calls the number and types the code and # is connected with them — audio, or (when they do not take it) speech to text and their written replies to speech.",
    inputs: [P("room", "any", { required: true, field: "string" }), P("member", "text", { required: true }), P("options", "object")],
    outputs: [OUT("session", "object"), FIELD("number", ...prop("number"), "text"), FIELD("code", ...prop("code"), "text"), FIELD("expires", ...prop("expiresAt"), "number")], effect: true,
    params: [{ name: "minutes", label: "Valid for (minutes)", type: "number", default: 10 }, { name: "mode", label: "Mode", type: "enum", values: ["auto", "audio", "text"], default: "auto" }, { name: "language", label: "Language of the prompts", type: "enum", values: ["cs", "en", "de"], default: "cs" }, { name: "number", label: "Number (empty: from the pool)", type: "string", default: "" }],
    js: (g) => { g.use("clean"); g.use("str"); return `await m5.telephony.did.allocate({ ...__clean(${g.in.options} || {}), ...__clean({ room: ${roomIdJs(g.in.room)}, member: __str(${g.in.member}), minutes: ${Math.max(1, Number(g.p.minutes) || 10)}, mode: ${g.lit(String(g.p.mode || "auto"))}, language: ${g.lit(String(g.p.language || "cs"))}, number: ${g.lit(String(g.p.number ?? ""))} }) })`; },
    py: (g) => { g.use("clean"); g.use("str"); return `await m5.telephony.did.allocate({**_clean(${g.in.options} or {}), **_clean({"room": ${roomIdPy(g.in.room)}, "member": _str(${g.in.member}), "minutes": ${Math.max(1, Number(g.p.minutes) || 10)}, "mode": ${g.lit(String(g.p.mode || "auto"))}, "language": ${g.lit(String(g.p.language || "cs"))}, "number": ${g.lit(String(g.p.number ?? ""))}})})`; },
  },
  { type: "tel.action", group: "Telephony", title: "Call logic", doc: "What a call does next — return it from an on_answer / on_digits function: say, play, pause, gather digits (their function), hang up. Chain several with Make list.",
    inputs: [P("text", "text")], outputs: [OUT("action", "object")],
    params: [{ name: "action", label: "Action", type: "enum", values: ["say", "play", "pause", "gather", "hangup"], default: "say" }, { name: "language", label: "Language (say)", type: "string", default: "cs-CZ" }, { name: "digits", label: "Digits (gather)", type: "number", default: 5 }, { name: "fn", label: "Digits go to function (gather)", type: "string", default: "on_digits" }, { name: "seconds", label: "Seconds (pause)", type: "number", default: 1 }],
    js: (g) => { g.use("str"); switch (String(g.p.action || "say")) {
      case "play": return `m5.telephony.actions.play(__str(${g.in.text}))`;
      case "pause": return `m5.telephony.actions.pause(${Number(g.p.seconds) || 1})`;
      case "gather": return `m5.telephony.actions.gather({ digits: ${Number(g.p.digits) || 5}, fn: ${g.lit(String(g.p.fn || "on_digits"))}, prompt: __str(${g.in.text}) || undefined, language: ${g.lit(String(g.p.language || "cs-CZ"))} })`;
      case "hangup": return "m5.telephony.actions.hangup()";
      default: return `m5.telephony.actions.say(__str(${g.in.text}), { language: ${g.lit(String(g.p.language || "cs-CZ"))} })`;
    } },
    py: (g) => { g.use("str"); switch (String(g.p.action || "say")) {
      case "play": return `m5.telephony.actions.play(_str(${g.in.text}))`;
      case "pause": return `m5.telephony.actions.pause(${Number(g.p.seconds) || 1})`;
      case "gather": return `m5.telephony.actions.gather(digits=${Number(g.p.digits) || 5}, fn=${g.lit(String(g.p.fn || "on_digits"))}, prompt=_str(${g.in.text}) or None, language=${g.lit(String(g.p.language || "cs-CZ"))})`;
      case "hangup": return "m5.telephony.actions.hangup()";
      default: return `m5.telephony.actions.say(_str(${g.in.text}), language=${g.lit(String(g.p.language || "cs-CZ"))})`;
    } },
  },

  /* ------------------------------------------------------------ NFC (6.3, m5.nfc) */
  { type: "nfc.scan", group: "NFC", title: "Scan a card", doc: "Waits for a card at the caller's device and reads its public identity and NDEF. The op runs on the caller's phone/reader; a person needs their NFC access, a webhook/schedule run the model's NFC grant.",
    inputs: [], outputs: [OUT("result", "object"), FIELD("status", ...prop("status"), "text"), FIELD("uid", (v) => `${v}?.card?.uid`, (v) => `((${v} or {}).get("card") or {}).get("uid")`, "text"), FIELD("tech", (v) => `${v}?.card?.tech`, (v) => `((${v} or {}).get("card") or {}).get("tech")`, "text"), FIELD("ndef", ...prop("ndef"), "list")], effect: true,
    params: [{ name: "reader", label: "Reader", type: "enum", values: ["", "internal", "usb", "bluetooth", "serial"], default: "" }, { name: "tech", label: "Only this technology (empty: any)", type: "string", default: "" }, { name: "timeout", label: "Wait for a card (s)", type: "number", default: 20 }],
    js: (g) => { g.use("clean"); return `await m5.nfc.scan(__clean({ reader: ${g.lit(String(g.p.reader ?? ""))}, tech: ${g.lit(String(g.p.tech ?? ""))}, timeout: ${Number(g.p.timeout) > 0 ? Number(g.p.timeout) : "undefined"} }))`; },
    py: (g) => { g.use("clean"); return `await m5.nfc.scan(**_clean({"reader": ${g.lit(String(g.p.reader ?? ""))}, "tech": ${g.lit(String(g.p.tech ?? ""))}, "timeout": ${Number(g.p.timeout) > 0 ? Number(g.p.timeout) : "None"}}))`; },
  },
  { type: "nfc.read", group: "NFC", title: "Read a card", doc: "Reads a card: its UID, public data, NDEF, a sector, a page, a file, a dump or the read counter. A protected read names a saved key set with “Secret ref” — a key or PIN is never sent.",
    inputs: [P("secretRef", "text")], outputs: [OUT("result", "object"), FIELD("status", ...prop("status"), "text"), FIELD("uid", (v) => `${v}?.card?.uid`, (v) => `((${v} or {}).get("card") or {}).get("uid")`, "text"), FIELD("ndef", ...prop("ndef"), "list"), FIELD("data", ...prop("data"), "text")], effect: true,
    params: [{ name: "what", label: "Read", type: "enum", values: ["public", "uid", "ndef", "sector", "page", "file", "dump", "counter"], default: "public" }, { name: "reader", label: "Reader", type: "enum", values: ["", "internal", "usb", "bluetooth", "serial"], default: "" }, { name: "tech", label: "Technology (empty: any)", type: "string", default: "" }, { name: "timeout", label: "Wait for a card (s)", type: "number", default: 20 }],
    js: (g) => { g.use("clean"); g.use("str"); return `await m5.nfc.read(__clean({ what: ${g.lit(String(g.p.what || "public"))}, reader: ${g.lit(String(g.p.reader ?? ""))}, tech: ${g.lit(String(g.p.tech ?? ""))}, timeout: ${Number(g.p.timeout) > 0 ? Number(g.p.timeout) : "undefined"}, secretRef: __str(${g.in.secretRef}) || undefined }))`; },
    py: (g) => { g.use("clean"); g.use("str"); return `await m5.nfc.read(**_clean({"what": ${g.lit(String(g.p.what || "public"))}, "reader": ${g.lit(String(g.p.reader ?? ""))}, "tech": ${g.lit(String(g.p.tech ?? ""))}, "timeout": ${Number(g.p.timeout) > 0 ? Number(g.p.timeout) : "None"}, "secretRef": _str(${g.in.secretRef}) or None}))`; },
  },
  { type: "nfc.write", group: "NFC", title: "Write a card", doc: "Writes a card: NDEF records, a block, a page, the UID (a “magic” card), makes the tag read-only, or restores a dump. Keys are named with “Secret ref”, never sent in the clear.",
    inputs: [P("ndef", "json"), P("data", "text"), P("secretRef", "text")], outputs: [OUT("result", "object"), FIELD("status", ...prop("status"), "text"), FIELD("message", ...prop("message"), "text")], effect: true,
    params: [{ name: "what", label: "Write", type: "enum", values: ["ndef", "block", "page", "uid", "lock", "restore"], default: "ndef" }, { name: "reader", label: "Reader", type: "enum", values: ["", "internal", "usb", "bluetooth", "serial"], default: "" }, { name: "tech", label: "Technology (empty: any)", type: "string", default: "" }, { name: "timeout", label: "Wait for a card (s)", type: "number", default: 20 }],
    js: (g) => { g.use("clean"); g.use("str"); return `await m5.nfc.write(__clean({ what: ${g.lit(String(g.p.what || "ndef"))}, reader: ${g.lit(String(g.p.reader ?? ""))}, tech: ${g.lit(String(g.p.tech ?? ""))}, timeout: ${Number(g.p.timeout) > 0 ? Number(g.p.timeout) : "undefined"}, ndef: ${g.in.ndef}, data: __str(${g.in.data}) || undefined, secretRef: __str(${g.in.secretRef}) || undefined }))`; },
    py: (g) => { g.use("clean"); g.use("str"); return `await m5.nfc.write(**_clean({"what": ${g.lit(String(g.p.what || "ndef"))}, "reader": ${g.lit(String(g.p.reader ?? ""))}, "tech": ${g.lit(String(g.p.tech ?? ""))}, "timeout": ${Number(g.p.timeout) > 0 ? Number(g.p.timeout) : "None"}, "ndef": ${g.in.ndef}, "data": _str(${g.in.data}) or None, "secretRef": _str(${g.in.secretRef}) or None}))`; },
  },
  { type: "nfc.m5.read", group: "NFC", title: "M5Cet: open records", doc: "Opens an M5Cet card and lists its records (their type and a summary). Each record opens with its PIN or your account on the device — the plaintext never reaches the model unless it is allowed the content.",
    inputs: [P("secretRef", "text")], outputs: [OUT("result", "object"), FIELD("status", ...prop("status"), "text"), FIELD("records", ...prop("records"), "list"), FIELD("count", (v) => `(${v}?.records ?? []).length`, (v) => `len((${v} or {}).get("records") or [])`, "number")], effect: true,
    params: [{ name: "reader", label: "Reader", type: "enum", values: ["", "internal", "usb", "bluetooth", "serial"], default: "" }, { name: "timeout", label: "Wait for a card (s)", type: "number", default: 20 }],
    js: (g) => { g.use("clean"); g.use("str"); return `await m5.nfc.m5.read(__clean({ reader: ${g.lit(String(g.p.reader ?? ""))}, timeout: ${Number(g.p.timeout) > 0 ? Number(g.p.timeout) : "undefined"}, secretRef: __str(${g.in.secretRef}) || undefined }))`; },
    py: (g) => { g.use("clean"); g.use("str"); return `await m5.nfc.m5.read(**_clean({"reader": ${g.lit(String(g.p.reader ?? ""))}, "timeout": ${Number(g.p.timeout) > 0 ? Number(g.p.timeout) : "None"}, "secretRef": _str(${g.in.secretRef}) or None}))`; },
  },
  { type: "nfc.m5.build", group: "NFC", title: "M5Cet: write records", doc: "Seals a list of records (a message, a Wi-Fi login, a contact, a saved room…) onto an M5Cet card. The device encrypts each record with its PIN or the account before writing.",
    inputs: [P("records", "list", { required: true, default: [] }), P("secretRef", "text")], outputs: [OUT("result", "object"), FIELD("status", ...prop("status"), "text"), FIELD("message", ...prop("message"), "text")], effect: true,
    params: [{ name: "reader", label: "Reader", type: "enum", values: ["", "internal", "usb", "bluetooth", "serial"], default: "" }, { name: "timeout", label: "Wait for a card (s)", type: "number", default: 20 }],
    js: (g) => { g.use("clean"); g.use("str"); return `await m5.nfc.m5.build(${g.in.records}, __clean({ reader: ${g.lit(String(g.p.reader ?? ""))}, timeout: ${Number(g.p.timeout) > 0 ? Number(g.p.timeout) : "undefined"}, secretRef: __str(${g.in.secretRef}) || undefined }))`; },
    py: (g) => { g.use("clean"); g.use("str"); return `await m5.nfc.m5.build(${g.in.records}, **_clean({"reader": ${g.lit(String(g.p.reader ?? ""))}, "timeout": ${Number(g.p.timeout) > 0 ? Number(g.p.timeout) : "None"}, "secretRef": _str(${g.in.secretRef}) or None}))`; },
  },
  { type: "nfc.emulate", group: "NFC", title: "Be a card (HCE)", doc: "Has the caller's device act as a card another reader can tap: an M5Cet card, a connection tag or a plain Type 4 / NDEF tag. Runs until the device stops it.",
    inputs: [P("records", "list"), P("secretRef", "text")], outputs: [OUT("result", "object"), FIELD("status", ...prop("status"), "text"), FIELD("message", ...prop("message"), "text")], effect: true,
    params: [{ name: "tech", label: "Emulate as", type: "enum", values: ["m5cet-card", "connection-tag", "ndef"], default: "m5cet-card" }, { name: "reader", label: "Reader", type: "enum", values: ["", "internal"], default: "" }],
    js: (g) => { g.use("clean"); g.use("str"); return `await m5.nfc.emulate(__clean({ tech: ${g.lit(String(g.p.tech || "m5cet-card"))}, reader: ${g.lit(String(g.p.reader ?? ""))}, records: Array.isArray(${g.in.records}) ? ${g.in.records} : undefined, secretRef: __str(${g.in.secretRef}) || undefined }))`; },
    py: (g) => { g.use("clean"); g.use("str"); return `await m5.nfc.emulate(**_clean({"tech": ${g.lit(String(g.p.tech || "m5cet-card"))}, "reader": ${g.lit(String(g.p.reader ?? ""))}, "records": (${g.in.records} if isinstance(${g.in.records}, list) else None), "secretRef": _str(${g.in.secretRef}) or None}))`; },
  },
  { type: "nfc.enum", group: "NFC", title: "List readers", doc: "Asks the caller's device what it offers now: its NFC readers and the card technologies it can talk to.",
    inputs: [], outputs: [OUT("result", "object"), FIELD("status", ...prop("status"), "text")], effect: true,
    params: [{ name: "reader", label: "Reader (empty: any)", type: "enum", values: ["", "internal", "usb", "bluetooth", "serial"], default: "" }],
    js: (g) => { g.use("clean"); return `await m5.nfc.enum(__clean({ reader: ${g.lit(String(g.p.reader ?? ""))} }))`; },
    py: (g) => { g.use("clean"); return `await m5.nfc.enum(**_clean({"reader": ${g.lit(String(g.p.reader ?? ""))}}))`; },
  },

  // 6.6: any read as a report, and a report shown in the chat.
  { type: "nfc.format", group: "NFC", title: "Card → format", doc: "Formats any NFC read (a scan, an EMV card, an e-ID) as html, object, array (rows), json, text or csv — with the card's pictures and the files to download (base64). Labels in the caller's language.",
    inputs: [P("data", "object", { required: true })], outputs: [FIELD("result", ...prop("value"), "any", "formatted"), FIELD("title", ...prop("title"), "text"), FIELD("summary", ...prop("summary"), "text"), FIELD("images", ...prop("images"), "list"), FIELD("files", ...prop("files"), "list"), OUT("report", "object")],
    params: [CARD_FORMAT, { name: "fullPan", label: "Whole card number (else masked)", type: "boolean", default: false }],
    js: (g) => `m5.nfc.format(${g.in.data}, ${g.lit(cardFormat(g.p.format))}, { fullPan: ${g.p.fullPan === true} })`,
    py: (g) => `m5.nfc.format(${g.in.data}, ${g.lit(cardFormat(g.p.format))}, full_pan=${g.p.fullPan === true ? "True" : "False"})`,
  },
  { type: "nfc.show", group: "NFC", title: "Show card report", doc: "Shows a report from “Card → format” in the chat: the formatted value (HTML, a table, JSON, text or CSV), the pictures, and the files to download.",
    inputs: [P("report", "object", { required: true })], outputs: [], effect: true,
    js: (g) => `await m5.caller.send(m5.nfc.outputs(${g.in.report}))`, py: (g) => `await m5.caller.send(m5.nfc.outputs(${g.in.report}))`,
  },

  /* ------------------------------------------------------------ NFC.EMV (6.6) */
  { type: "nfc.emv.report", group: "NFC.EMV", title: "EMV: read everything", doc: "Waits for a payment card at the caller's device and reads everything a terminal may: every application, every record (deep: every file), the counters and the transaction history — then formats it (html, object, array, json, text, csv) and, with “Show in the chat”, shows it with the history as CSV and the records to download. Read-only: never a PIN, never a payment, never a write.",
    inputs: [], outputs: [FIELD("result", ...prop("result"), "any", "formatted"), FIELD("data", ...prop("data"), "object", "the read"), FIELD("ok", ...prop("ok"), "boolean"), FIELD("status", ...prop("status"), "text"), FIELD("summary", ...prop("summary"), "text"), FIELD("history", ...prop("history"), "list"), FIELD("files", ...prop("files"), "list"), OUT("report", "object")], effect: true,
    params: [CARD_FORMAT, SEND_TO_CHAT, { name: "history", label: "Transaction history", type: "boolean", default: true }, { name: "deep", label: "Every file (deep read)", type: "boolean", default: true }, { name: "fullPan", label: "Whole card number (else masked)", type: "boolean", default: false }, { name: "maxApps", label: "Applications at most", type: "number", default: 8 }, NFC_READER, { name: "timeout", label: "Wait for a card (s)", type: "number", default: 30 }],
    js: (g) => { g.use("clean"); return `await m5.nfc.emv.report(__clean({ format: ${g.lit(cardFormat(g.p.format))}, send: ${g.p.send !== false}, history: ${g.p.history !== false}, deep: ${g.p.deep !== false}, fullPan: ${g.p.fullPan === true}, maxApps: ${Number(g.p.maxApps) > 0 ? Number(g.p.maxApps) : 8}, reader: ${g.lit(String(g.p.reader ?? ""))}, timeout: ${Number(g.p.timeout) > 0 ? Number(g.p.timeout) : "undefined"} }))`; },
    py: (g) => { g.use("clean"); const b = (v: boolean) => (v ? "True" : "False"); return `await m5.nfc.emv.report(**_clean({"format": ${g.lit(cardFormat(g.p.format))}, "send": ${b(g.p.send !== false)}, "history": ${b(g.p.history !== false)}, "deep": ${b(g.p.deep !== false)}, "full_pan": ${b(g.p.fullPan === true)}, "max_apps": ${Number(g.p.maxApps) > 0 ? Number(g.p.maxApps) : 8}, "reader": ${g.lit(String(g.p.reader ?? ""))}, "timeout": ${Number(g.p.timeout) > 0 ? Number(g.p.timeout) : "None"}}))`; },
  },
  { type: "nfc.emv.format", group: "NFC.EMV", title: "EMV → format", doc: "Formats an EMV read (from “EMV: read everything” → data) in another format — the PAN masked unless asked.",
    inputs: [P("data", "object", { required: true })], outputs: [FIELD("result", ...prop("value"), "any", "formatted"), FIELD("files", ...prop("files"), "list"), FIELD("summary", ...prop("summary"), "text"), OUT("report", "object")],
    params: [CARD_FORMAT, { name: "fullPan", label: "Whole card number (else masked)", type: "boolean", default: false }],
    js: (g) => `m5.nfc.emv.format(${g.in.data}, ${g.lit(cardFormat(g.p.format))}, { fullPan: ${g.p.fullPan === true} })`,
    py: (g) => `m5.nfc.emv.format(${g.in.data}, ${g.lit(cardFormat(g.p.format))}, full_pan=${g.p.fullPan === true ? "True" : "False"})`,
  },
  { type: "nfc.emv.history", group: "NFC.EMV", title: "EMV: transaction history", doc: "The transactions an EMV read found in the card's log, newest first: date, time, amount, currency, merchant, type, country, ATC — one row each (wire it to “Send table”).",
    inputs: [P("data", "object", { required: true })], outputs: [OUT("rows", "list"), FIELD("count", (v) => `${v}.length`, (v) => `len(${v})`, "number")],
    js: (g) => `m5.nfc.emv.history(${g.in.data})`, py: (g) => `m5.nfc.emv.history(${g.in.data})`,
  },

  /* ------------------------------------------------------------ NFC.e-ID (6.6) */
  { type: "nfc.eid.report", group: "NFC.e-ID", title: "e-ID: read everything", doc: "Waits for an e-ID card or e-passport at the caller's device, opens it with the CAN printed on it (PACE) or the MRZ (BAC) — the holder's own key — and reads every data group it may: the MRZ, the face, portrait and signature, more personal and document details, the security objects (each group checked against EF.SOD). Formats it (html shows the photo inline; EF.SOD, DG14, DG15 and JPEG 2000 come as files) and, with “Show in the chat”, shows it. Read-only.",
    inputs: [P("can", "text", { placeholder: "123456" }), P("mrz", "text"), P("documentNumber", "text"), P("dateOfBirth", "text", { placeholder: "YYMMDD" }), P("dateOfExpiry", "text", { placeholder: "YYMMDD" })],
    outputs: [FIELD("result", ...prop("result"), "any", "formatted"), FIELD("data", ...prop("data"), "object", "the read"), FIELD("ok", ...prop("ok"), "boolean"), FIELD("status", ...prop("status"), "text"), FIELD("summary", ...prop("summary"), "text"),
      FIELD("holder", (v) => `${v}?.data?.mrtd?.mrzInfo`, (v) => `(((${v} or {}).get("data") or {}).get("mrtd") or {}).get("mrzInfo")`, "object", "holder (DG1)"), FIELD("photo", ...prop("photo"), "bytes"), FIELD("images", ...prop("images"), "list"), FIELD("files", ...prop("files"), "list"), OUT("report", "object")], effect: true,
    params: [CARD_FORMAT, SEND_TO_CHAT, { name: "photo", label: "Pictures (face, signature…)", type: "boolean", default: true }, { name: "all", label: "Every data group", type: "boolean", default: true }, NFC_READER, { name: "timeout", label: "Wait for a card (s)", type: "number", default: 45 }],
    js: (g) => { g.use("clean"); g.use("str"); const s = (k: string) => (g.in[k] === "undefined" ? "undefined" : `__str(${g.in[k]}) || undefined`); return `await m5.nfc.eid.report(__clean({ can: ${s("can")}, mrz: ${s("mrz")}, documentNumber: ${s("documentNumber")}, dateOfBirth: ${s("dateOfBirth")}, dateOfExpiry: ${s("dateOfExpiry")}, format: ${g.lit(cardFormat(g.p.format))}, send: ${g.p.send !== false}, photo: ${g.p.photo !== false}, all: ${g.p.all !== false}, reader: ${g.lit(String(g.p.reader ?? ""))}, timeout: ${Number(g.p.timeout) > 0 ? Number(g.p.timeout) : "undefined"} }))`; },
    py: (g) => { g.use("clean"); g.use("str"); const s = (k: string) => (g.in[k] === "None" ? "None" : `_str(${g.in[k]}) or None`); const b = (v: boolean) => (v ? "True" : "False"); return `await m5.nfc.eid.report(**_clean({"can": ${s("can")}, "mrz": ${s("mrz")}, "document_number": ${s("documentNumber")}, "date_of_birth": ${s("dateOfBirth")}, "date_of_expiry": ${s("dateOfExpiry")}, "format": ${g.lit(cardFormat(g.p.format))}, "send": ${b(g.p.send !== false)}, "photo": ${b(g.p.photo !== false)}, "all": ${b(g.p.all !== false)}, "reader": ${g.lit(String(g.p.reader ?? ""))}, "timeout": ${Number(g.p.timeout) > 0 ? Number(g.p.timeout) : "None"}}))`; },
  },
  { type: "nfc.eid.format", group: "NFC.e-ID", title: "e-ID → format", doc: "Formats an e-ID / e-passport read (from “e-ID: read everything” → data) in another format.",
    inputs: [P("data", "object", { required: true })], outputs: [FIELD("result", ...prop("value"), "any", "formatted"), FIELD("images", ...prop("images"), "list"), FIELD("files", ...prop("files"), "list"), FIELD("summary", ...prop("summary"), "text"), OUT("report", "object")],
    params: [CARD_FORMAT],
    js: (g) => `m5.nfc.eid.format(${g.in.data}, ${g.lit(cardFormat(g.p.format))})`, py: (g) => `m5.nfc.eid.format(${g.in.data}, ${g.lit(cardFormat(g.p.format))})`,
  },
  { type: "nfc.eid.images", group: "NFC.e-ID", title: "e-ID: pictures", doc: "The pictures an e-ID read holds — faces (DG2), portrait (DG5), signature (DG7), document scans (DG11 / DG12) — each { name, mime, image }; “first” is the face, ready for “Send image”.",
    inputs: [P("data", "object", { required: true })], outputs: [OUT("images", "list"), FIELD("first", (v) => `(${v}[0] ?? null)`, (v) => `(${v}[0] if ${v} else None)`, "bytes"), FIELD("count", (v) => `${v}.length`, (v) => `len(${v})`, "number")],
    js: (g) => `m5.nfc.eid.images(${g.in.data})`, py: (g) => `m5.nfc.eid.images(${g.in.data})`,
  },

  /* ------------------------------------------------------------ administration (6.0, m5adm) */
  { type: "adm.rooms.list", group: "Administration", title: "Find rooms", doc: "Rooms whose members match a pattern (preg_match: /^eva/i) — by name in the room, username, passkey id or group; or by the room's id, label or tag. Needs the model's access to the administration (rooms).",
    inputs: [P("value", "text", { default: "/./" }), P("filters", "json")],
    outputs: [OUT("rooms", "list"), FIELD("count", (v) => `${v}.length`, (v) => `len(${v})`, "number"), FIELD("first", (v) => `(${v}[0] ?? null)`, (v) => `(${v}[0] if ${v} else None)`, "object")],
    params: [{ name: "key", label: "Match", type: "enum", values: [...ROOM_FILTER_KEYS], default: "room_username" }, { name: "match", label: "More filters (the filters input)", type: "enum", values: ["all", "any"], default: "all" }],
    js: (g) => `await m5adm.rooms.list([...(Array.isArray(${g.in.filters}) ? ${g.in.filters} : []), ...(${g.in.value} === undefined || ${g.in.value} === null || ${g.in.value} === "" ? [] : [{ key: ${g.lit(String(g.p.key || "room_username"))}, value: String(${g.in.value}) }])], { match: ${g.lit(g.p.match === "any" ? "any" : "all")} })`,
    py: (g) => `await m5adm.rooms.list([*(${g.in.filters} if isinstance(${g.in.filters}, list) else []), *([] if ${g.in.value} in (None, "") else [{"key": ${g.lit(String(g.p.key || "room_username"))}, "value": str(${g.in.value})}])], ${g.lit(g.p.match === "any" ? "any" : "all")})`,
  },
  { type: "adm.rooms.get", group: "Administration", title: "Room", doc: "One room by its id (the 16-character hash the console shows, or the room id itself): who is in it, its record, block, limit, pinned message.",
    inputs: [P("room", "any", { required: true, field: "string" })],
    outputs: [OUT("room", "object"), FIELD("members", (v) => `(${v}?.members ?? [])`, (v) => `((${v} or {}).get("members") or [])`, "list"), FIELD("online", (v) => `Boolean(${v}?.online)`, (v) => `bool((${v} or {}).get("online"))`, "boolean"), FIELD("blocked", (v) => `Boolean(${v}?.blocked)`, (v) => `bool((${v} or {}).get("blocked"))`, "boolean")],
    js: (g) => `await m5adm.rooms.get(${roomIdJs(g.in.room)})`, py: (g) => `await m5adm.rooms.get(${roomIdPy(g.in.room)})`,
  },
  { type: "adm.room.action", group: "Administration", title: "Room action", doc: "Acts on a room (a room from “Find rooms” / “Room”, or its id): a wall message to everyone, a private message or a flash to one member, disconnect, block (for N minutes), unblock, call members back (connect).",
    inputs: [P("room", "any", { required: true, field: "string" }), P("text", "text"), P("member", "text")],
    outputs: [OUT("result", "any")], effect: true,
    params: [
      { name: "action", label: "Action", type: "enum", values: ["wall_msg", "user_msg", "user_flash", "disconnect", "block", "unblock", "connect"], default: "wall_msg" },
      { name: "level", label: "Level (wall, flash)", type: "enum", values: ["info", "success", "warning", "error"], default: "info" },
      { name: "pin", label: "Pin the wall message (also for those who join later)", type: "boolean", default: false },
      { name: "minutes", label: "Block for minutes (0: until unblocked)", type: "number", default: 0 },
    ],
    js: (g) => { g.use("str"); const id = roomIdJs(g.in.room); const lvl = g.lit(String(g.p.level || "info")); switch (String(g.p.action || "wall_msg")) {
      case "user_msg": return `await m5adm.rooms.user_msg(${id}, ${g.in.member}, __str(${g.in.text}))`;
      case "user_flash": return `await m5adm.rooms.user_flash(${id}, ${g.in.member}, __str(${g.in.text}), ${lvl})`;
      case "disconnect": return `await m5adm.rooms.disconnect(${id}, ${g.in.member} || null, __str(${g.in.text}))`;
      case "block": return `await m5adm.rooms.block(${id}, { reason: __str(${g.in.text}), minutes: ${Math.max(0, Number(g.p.minutes) || 0)} })`;
      case "unblock": return `await m5adm.rooms.unblock(${id})`;
      case "connect": return `await m5adm.rooms.connect(${id}, ${g.in.member} || null)`;
      default: return `await m5adm.rooms.wall_msg(${id}, __str(${g.in.text}), { level: ${lvl}${g.p.pin ? ", pin: true" : ""} })`;
    } },
    py: (g) => { g.use("str"); const id = roomIdPy(g.in.room); const lvl = g.lit(String(g.p.level || "info")); switch (String(g.p.action || "wall_msg")) {
      case "user_msg": return `await m5adm.rooms.user_msg(${id}, ${g.in.member}, _str(${g.in.text}))`;
      case "user_flash": return `await m5adm.rooms.user_flash(${id}, ${g.in.member}, _str(${g.in.text}), ${lvl})`;
      case "disconnect": return `await m5adm.rooms.disconnect(${id}, ${g.in.member} or None, _str(${g.in.text}))`;
      case "block": return `await m5adm.rooms.block(${id}, _str(${g.in.text}), ${Math.max(0, Number(g.p.minutes) || 0) || "None"})`;
      case "unblock": return `await m5adm.rooms.unblock(${id})`;
      case "connect": return `await m5adm.rooms.connect(${id}, ${g.in.member} or None)`;
      default: return `await m5adm.rooms.wall_msg(${id}, _str(${g.in.text}), ${lvl}${g.p.pin ? ", True" : ""})`;
    } },
  },
  { type: "adm.rooms.set", group: "Administration", title: "Save room record", doc: "Saves what the operator keeps about a room — label, note, tags, maxMembers, blocked, wall. The room's id when saved, -1 when not (the reason is in the run's log). An empty id with { room } in the record creates one.",
    inputs: [P("room", "any", { field: "string" }), P("record", "object", { required: true, default: { label: "" } })],
    outputs: [OUT("id", "any")], effect: true,
    js: (g) => `await m5adm.rooms.set(${g.in.room} === undefined || ${g.in.room} === null || ${g.in.room} === "" ? null : ${roomIdJs(g.in.room)}, ${g.in.record})`,
    py: (g) => `await m5adm.rooms.set(None if ${g.in.room} in (None, "") else ${roomIdPy(g.in.room)}, ${g.in.record})`,
  },
  { type: "adm.rooms.stats", group: "Administration", title: "Room statistics", doc: "Rooms, members, guests, away, protocols, the busiest rooms, the registry.",
    inputs: [], outputs: [OUT("stats", "object"), FIELD("rooms", ...prop("rooms"), "number"), FIELD("members", ...prop("members"), "number"), FIELD("busiest", ...prop("busiest"), "list")],
    js: () => "await m5adm.rooms.stats()", py: () => "await m5adm.rooms.stats()",
  },
  { type: "adm.call", group: "Administration", title: "Administration call", doc: "Any other part of the administration: overview, connections, live traffic, modules & groups, users & passkeys, the message queue, the audit journal, commands & push, administrators. The arguments are a list (e.g. [\"acc-123\"]). Needs the model's access to that area.",
    inputs: [P("args", "list", { default: [] })], outputs: [OUT("result", "any")], effect: true,
    params: [{ name: "call", label: "Call", type: "enum", values: ADM_CALLS, default: "overview.get" }],
    js: (g) => { const [o, op] = admCall(g.p.call); return `await m5adm.${o}.${op}(...(Array.isArray(${g.in.args}) ? ${g.in.args} : ${g.in.args} === undefined || ${g.in.args} === null ? [] : [${g.in.args}]))`; },
    py: (g) => { const [o, op] = admCall(g.p.call); return `await m5adm.${o}.${op}(*(${g.in.args} if isinstance(${g.in.args}, list) else ([] if ${g.in.args} is None else [${g.in.args}])))`; },
  },
  { type: "adm.audit.add", group: "Administration", title: "Audit line", doc: "Writes a line of your own to the audit journal (fn.<event>, with the model and its caller as the actor).",
    inputs: [P("detail", "any")], outputs: [OUT("entry", "object")], effect: true,
    params: [{ name: "event", label: "Event (a–z, 0–9, . _ -)", type: "string", default: "done" }, { name: "level", label: "Level", type: "enum", values: ["info", "notice", "warn", "error"], default: "info" }],
    js: (g) => `await m5adm.audit.add(${g.lit(String(g.p.event || "done"))}, ${g.in.detail} ?? null, { level: ${g.lit(String(g.p.level || "info"))} })`,
    py: (g) => `await m5adm.audit.add(${g.lit(String(g.p.event || "done"))}, ${g.in.detail}, {"level": ${g.lit(String(g.p.level || "info"))}})`,
  },
];

const telChannel = (v: unknown) => (v === "viber" || v === "messenger" ? v : "whatsapp");
function admCall(v: unknown): [string, string] {
  const s = String(v ?? "");
  if (!ADM_CALLS.includes(s)) throw new FlowError(`Not an administration call: ${s.slice(0, 40)}`);
  const [o, op] = s.split(".");
  return [o, op];
}
/** A room from Find rooms / Room (an object with id), or an id. */
const roomIdJs = (v: string) => `((r) => (r && typeof r === "object" ? r.id : r))(${v})`;
const roomIdPy = (v: string) => `(${v}["id"] if isinstance(${v}, dict) else ${v})`;

export const NODE_BY_TYPE: Record<string, NodeDef> = Object.fromEntries(NODES.map((d) => [d.type, d]));
export const GROUPS = [...new Set(NODES.map((n) => n.group))];

function inputName(p: Record<string, unknown>): string {
  const n = String(p.name ?? "").trim();
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) ? n : "value";
}
function inputDefault(p: Record<string, unknown>): unknown {
  const d = p.default;
  if (d === undefined || d === null || d === "") return undefined;
  const t = String(p.type ?? "string");
  if (t === "integer" || t === "number") { const n = Number(d); return Number.isFinite(n) ? n : undefined; }
  if (t === "boolean") return d === true || d === "true" || d === "1" || d === "yes";
  if (t === "json") { try { return JSON.parse(String(d)); } catch { return String(d); } }
  return String(d);
}
function constValue(p: Record<string, unknown>): unknown {
  const v = p.value;
  switch (String(p.kind ?? "text")) {
    case "number": { const n = Number(v); return Number.isFinite(n) ? n : 0; }
    case "boolean": return v === true || v === "true" || v === "1" || v === "yes";
    case "json": try { return JSON.parse(String(v ?? "null")); } catch { throw new FlowError(`Not valid JSON: ${String(v).slice(0, 60)}`); }
    default: return v === undefined || v === null ? "" : String(v);
  }
}
function parseJsonParam(v: unknown): unknown {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "object") return v;
  try { return JSON.parse(String(v)); } catch { throw new FlowError(`Not valid JSON: ${String(v).slice(0, 60)}`); }
}
const codecName = (c: unknown) => (CODECS.includes(String(c)) ? String(c) : "base64");
const logLevel = (l: unknown) => (["debug", "info", "warn", "error"].includes(String(l)) ? String(l) : "info");

/* ============================================================ checking */

export class FlowError extends Error {
  constructor(message: string, readonly node?: string) { super(message); this.name = "FlowError"; }
}

export type FlowIssue = { node?: string; level: "error" | "warning"; message: string; fn?: string };

/** The input ports of a node (some depend on its params). */
export function inputsOf(n: FlowNode): FlowPort[] {
  const def = NODE_BY_TYPE[n.type];
  if (!def) return [];
  return typeof def.inputs === "function" ? def.inputs(n) : def.inputs;
}
export function outputsOf(n: FlowNode): FlowOutPort[] {
  return NODE_BY_TYPE[n.type]?.outputs ?? [];
}
/** Params with their defaults filled in. */
export function paramsOf(n: FlowNode): Record<string, unknown> {
  const def = NODE_BY_TYPE[n.type];
  const out: Record<string, unknown> = {};
  for (const p of def?.params ?? []) out[p.name] = n.params && n.params[p.name] !== undefined ? n.params[p.name] : p.default;
  return out;
}

/** A fresh node of a type at a position, with an id not used in the flow. */
export function newNode(flow: Flow, type: string, x: number, y: number): FlowNode {
  const def = NODE_BY_TYPE[type];
  if (!def) throw new FlowError(`Unknown node type ${type}.`);
  let i = flow.nodes.length + 1;
  const used = new Set(flow.nodes.map((n) => n.id));
  while (used.has(`n${i}`)) i++;
  const params: Record<string, unknown> = {};
  for (const p of def.params ?? []) params[p.name] = p.default;
  if (type === "flow.input") {
    const names = new Set(flow.nodes.filter((n) => n.type === "flow.input").map((n) => String(n.params?.name ?? "")));
    let k = 1; let name = "text";
    while (names.has(name)) name = `text${++k}`;
    params.name = name;
  }
  return { id: `n${i}`, type, x: Math.round(x), y: Math.round(y), params, values: {} };
}

export function emptyFlow(lang: FlowLang = "js", name = ""): Flow {
  return { format: "m5flow", version: 1, lang, name, summary: "", nodes: [], edges: [] };
}

/** Normalizes something that claims to be a flow (from a file or the console). */
export function parseFlow(raw: unknown): Flow {
  const o = (typeof raw === "string" ? JSON.parse(raw) : raw) as Partial<Flow> | null;
  if (!o || typeof o !== "object" || !Array.isArray(o.nodes) || !Array.isArray(o.edges)) throw new FlowError("Not a flow (it needs nodes and edges).");
  const lang: FlowLang = o.lang === "py" ? "py" : "js";
  const nodes: FlowNode[] = [];
  const ids = new Set<string>();
  for (const n of o.nodes.slice(0, 500)) {
    if (!n || typeof n !== "object" || typeof n.id !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(n.id) || ids.has(n.id)) throw new FlowError("A node has a missing, bad or repeated id.");
    ids.add(n.id);
    nodes.push({ id: n.id, type: String(n.type), x: Number(n.x) || 0, y: Number(n.y) || 0, params: n.params && typeof n.params === "object" ? { ...n.params } : {}, values: n.values && typeof n.values === "object" ? { ...n.values } : {}, ...(typeof n.label === "string" && n.label ? { label: n.label.slice(0, 80) } : {}) });
  }
  const edges: FlowEdge[] = [];
  for (const e of o.edges.slice(0, 2000)) {
    if (!e || !e.from || !e.to || !ids.has(e.from.node) || !ids.has(e.to.node)) continue;
    edges.push({ id: String(e.id || `e${edges.length + 1}`), from: { node: e.from.node, port: String(e.from.port) }, to: { node: e.to.node, port: String(e.to.port) } });
  }
  const functions: Record<string, FlowGraph> = {};
  if (o.functions && typeof o.functions === "object") {
    for (const [fn, g] of Object.entries(o.functions).slice(0, 12)) {
      if (!FN_NAME_RE.test(fn) || fn === "execute" || !g || typeof g !== "object") continue;
      const sub = parseFlow({ lang, nodes: Array.isArray((g as FlowGraph).nodes) ? (g as FlowGraph).nodes : [], edges: Array.isArray((g as FlowGraph).edges) ? (g as FlowGraph).edges : [] });
      functions[fn] = { nodes: sub.nodes, edges: sub.edges };
    }
  }
  return { format: "m5flow", version: 1, lang, name: typeof o.name === "string" ? o.name.slice(0, 80) : "", summary: typeof o.summary === "string" ? o.summary.slice(0, 300) : "", nodes, edges, ...(Object.keys(functions).length ? { functions } : {}) };
}

/** Problems a flow has: unknown nodes, dangling wires, missing required inputs, cycles, clashing input names — in each of its functions. */
export function checkFlow(flow: Flow): FlowIssue[] {
  const issues = checkGraph(flow, "execute");
  for (const [fn, graph] of Object.entries(flow.functions ?? {})) {
    if (!FN_NAME_RE.test(fn) || fn === "execute") { issues.push({ fn, level: "error", message: `“${fn}” is not a function name.` }); continue; }
    issues.push(...checkGraph(graph, fn).map((i) => ({ ...i, fn, message: `${fn}: ${i.message}` })));
  }
  return issues;
}

function checkGraph(flow: FlowGraph, fn: string): FlowIssue[] {
  const issues: FlowIssue[] = [];
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const wiredIn = new Set(flow.edges.map((e) => `${e.to.node}:${e.to.port}`));
  const names = new Map<string, string>();
  for (const n of flow.nodes) {
    const def = NODE_BY_TYPE[n.type];
    if (!def) { issues.push({ node: n.id, level: "error", message: `Unknown node “${n.type}”.` }); continue; }
    for (const port of inputsOf(n)) {
      if (!port.required || wiredIn.has(`${n.id}:${port.name}`)) continue;
      const v = n.values?.[port.name];
      if ((v === undefined || v === null || v === "") && port.default === undefined) issues.push({ node: n.id, level: "error", message: `${def.title}: “${port.label || port.name}” needs a wire or a value.` });
    }
    if (n.type === "flow.input") {
      const nm = inputName(paramsOf(n));
      if (names.has(nm)) issues.push({ node: n.id, level: "error", message: `Two inputs are named “${nm}”.` });
      names.set(nm, n.id);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(n.params?.name ?? ""))) issues.push({ node: n.id, level: "warning", message: `The input name “${String(n.params?.name ?? "")}” is not an identifier; it is called “value”.` });
    }
  }
  const seen = new Set<string>();
  for (const e of flow.edges) {
    const from = byId.get(e.from.node), to = byId.get(e.to.node);
    if (!from || !to) continue;
    if (!outputsOf(from).some((p) => p.name === e.from.port)) issues.push({ node: from.id, level: "error", message: `A wire leaves a port “${e.from.port}” that ${NODE_BY_TYPE[from.type]?.title ?? from.type} does not have.` });
    if (!inputsOf(to).some((p) => p.name === e.to.port)) issues.push({ node: to.id, level: "warning", message: `A wire goes to a port “${e.to.port}” that ${NODE_BY_TYPE[to.type]?.title ?? to.type} no longer has (it is ignored).` });
    const k = `${e.to.node}:${e.to.port}`;
    if (seen.has(k)) issues.push({ node: to.id, level: "error", message: `Two wires go into the same input “${e.to.port}”.` });
    seen.add(k);
  }
  try { order(flow); } catch (err) { issues.push({ node: (err as FlowError).node, level: "error", message: (err as Error).message }); }
  if (!flow.nodes.some((n) => NODE_BY_TYPE[n.type]?.effect) && (fn === "execute" || flow.nodes.length)) issues.push({ level: "warning", message: "Nothing sends or returns a result yet — add an Output node (e.g. Send text) or Result." });
  return issues;
}

/** The functions a flow holds: execute, then the others (5.3). */
export function flowFunctions(flow: Flow): string[] {
  return ["execute", ...Object.keys(flow.functions ?? {}).filter((f) => FN_NAME_RE.test(f) && f !== "execute")];
}
/** One function's graph (execute: the flow's own nodes and edges). */
export function graphOf(flow: Flow, fn: string): FlowGraph {
  return fn === "execute" ? { nodes: flow.nodes, edges: flow.edges } : flow.functions?.[fn] ?? { nodes: [], edges: [] };
}

/** The model input schema the flow's Input nodes describe. */
export function flowInputs(flow: FlowGraph): Array<{ name: string; type: string; label?: string; required?: boolean; default?: unknown; values?: string[] }> {
  return flow.nodes.filter((n) => n.type === "flow.input").sort((a, b) => a.y - b.y || a.x - b.x).map((n) => {
    const p = paramsOf(n);
    const type = (INPUT_TYPES as readonly string[]).includes(String(p.type)) ? String(p.type) : "string";
    const d = inputDefault(p);
    return { name: inputName(p), type, ...(p.label ? { label: String(p.label) } : {}), ...(p.required ? { required: true } : {}), ...(d !== undefined ? { default: d } : {}), ...(type === "enum" ? { values: list(p.values) } : {}) };
  });
}

/* ============================================================ compiling */

/** Dependency order; nodes that could run in any order go left to right, then top to bottom. */
function order(flow: FlowGraph): FlowNode[] {
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const indeg = new Map(flow.nodes.map((n) => [n.id, 0]));
  const next = new Map<string, string[]>();
  for (const e of flow.edges) {
    if (!byId.has(e.from.node) || !byId.has(e.to.node)) continue;
    if (e.from.node === e.to.node) throw new FlowError("A node is wired to itself.", e.from.node);
    indeg.set(e.to.node, (indeg.get(e.to.node) ?? 0) + 1);
    next.set(e.from.node, [...(next.get(e.from.node) ?? []), e.to.node]);
  }
  const cmp = (a: FlowNode, b: FlowNode) => a.x - b.x || a.y - b.y || a.id.localeCompare(b.id);
  const ready = flow.nodes.filter((n) => indeg.get(n.id) === 0).sort(cmp);
  const out: FlowNode[] = [];
  while (ready.length) {
    const n = ready.shift()!;
    out.push(n);
    for (const m of next.get(n.id) ?? []) {
      indeg.set(m, (indeg.get(m) ?? 0) - 1);
      if (indeg.get(m) === 0) { ready.push(byId.get(m)!); ready.sort(cmp); }
    }
  }
  if (out.length !== flow.nodes.length) {
    const stuck = flow.nodes.find((n) => !out.includes(n));
    throw new FlowError("The wires go round in a circle; a flow runs one way.", stuck?.id);
  }
  return out;
}

const varOf = (id: string) => `n_${id.replace(/[^A-Za-z0-9_]/g, "_")}`;

export type CompileOptions = { trace?: boolean; fn?: string };
/** functions (5.3): each function in the file with the inputs its Input nodes describe. */
export type Compiled = { code: string; file: string; issues: FlowIssue[]; inputs: ReturnType<typeof flowInputs>; order: string[]; functions: Array<{ name: string; inputs: ReturnType<typeof flowInputs> }> };

/** Compiles a flow to the source of one module: `execute` runs its main graph, and each of its
 *  other functions (5.3: response, button, form, error, webhook…) runs its own. Throws FlowError on errors. */
export function compileFlow(flow: Flow, opts: CompileOptions = {}): Compiled {
  const issues = checkFlow(flow);
  const errors = issues.filter((i) => i.level === "error");
  if (errors.length) throw Object.assign(new FlowError(errors[0].message, errors[0].node), { fn: errors[0].fn });
  const lang = flow.lang;
  const main = opts.fn && /^[A-Za-z_][A-Za-z0-9_]*$/.test(opts.fn) ? opts.fn : "execute";
  const helpers = new Set<HelperName>();
  if (opts.trace) helpers.add("peek");
  const graphs: Array<[string, FlowGraph]> = [[main, flow], ...Object.entries(flow.functions ?? {}).filter(([fn, g]) => FN_NAME_RE.test(fn) && fn !== main && fn !== "execute" && g.nodes.length)];
  const fns: string[][] = [];
  let mainOrder: string[] = [];
  for (const [fn, graph] of graphs) {
    try {
      const r = compileGraph(graph, fn, lang, opts, helpers);
      fns.push(r.lines);
      if (fn === main) mainOrder = r.order;
    } catch (err) { throw Object.assign(err as Error, { fn }); }
  }

  const head = lang === "js"
    ? ["// Generated by the M5cet visual builder from flow.m5flow.json.", "// Edit the flow in Functions → Builder (changes here are replaced on the next save),", "// or use “Eject to code” there to keep working on this file by hand.", ""]
    : ["# Generated by the M5cet visual builder from flow.m5flow.json.", "# Edit the flow in Functions → Builder (changes here are replaced on the next save),", "# or use “Eject to code” there to keep working on this file by hand.", ""];
  const out: string[] = [...head];
  if (lang === "js") {
    for (const h of ["str", "num", "get", "table", "bytes", "clean", "peek"] as HelperName[]) if (helpers.has(h)) out.push(HELPERS_JS[h]);
    if (opts.trace) {
      out.push("const __trace = (id, v) => m5.log.debug(\"flow:node\", { node: id, value: __peek(v) });");
      out.push("const __fail = (id, e) => { m5.log.error(\"flow:fail\", { node: id, error: String((e && e.message) || e) }); throw e; };");
    }
    if (helpers.size || opts.trace) out.push("");
  } else {
    out.push("import json as _json, re as _re, random as _random, datetime as _dt", "");
    for (const h of ["str", "num", "get", "table", "bytes", "clean", "peek"] as HelperName[]) if (helpers.has(h)) out.push(...HELPERS_PY[h], "");
    if (opts.trace) {
      out.push("def _trace(id, v):", "    m5.log.debug(\"flow:node\", node=id, value=_peek(v))", "");
      out.push("def _fail(id, e):", "    m5.log.error(\"flow:fail\", node=id, error=str(e))", "    raise e", "");
    }
  }
  for (const f of fns) out.push(...f);
  return {
    code: out.join("\n"), file: lang === "py" ? "index.py" : "index.js", issues, inputs: flowInputs(flow), order: mainOrder,
    functions: graphs.map(([name, g]) => ({ name, inputs: flowInputs(g) })),
  };
}

/** One function of the module: its nodes in order, gated by If branches, traced when asked. */
function compileGraph(flow: FlowGraph, fn: string, lang: FlowLang, opts: CompileOptions, helpers: Set<HelperName>): { lines: string[]; order: string[] } {
  const nodes = order(flow);
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, FlowEdge>();
  for (const e of flow.edges) incoming.set(`${e.to.node}:${e.to.port}`, e);

  // Guards: which If branches a node depends on ("n_3_c" or "!n_3_c").
  const guards = new Map<string, Set<string>>();
  const lines: string[] = [];
  const pad = lang === "js" ? "  " : "    ";
  let usesResult = false;
  for (const n of nodes) {
    const def = NODE_BY_TYPE[n.type];
    const v = varOf(n.id);
    const g = new Set<string>();
    const inExpr: Record<string, string> = {};
    for (const port of inputsOf(n)) {
      const e = incoming.get(`${n.id}:${port.name}`);
      if (e) {
        const src = byId.get(e.from.node)!;
        const out = outputsOf(src).find((p) => p.name === e.from.port);
        const sv = varOf(src.id);
        const get = out ? (lang === "js" ? out.js : out.py) : undefined;
        inExpr[port.name] = get ? get(sv) : sv;
        for (const x of guards.get(src.id) ?? []) g.add(x);
        if (out?.branch === "then") g.add(`${sv}_c`);
        if (out?.branch === "else") g.add(`!${sv}_c`);
      } else {
        inExpr[port.name] = literalFor(port, n.values?.[port.name], lang, n.id);
      }
    }
    guards.set(n.id, g);
    const gen: Gen = { lang, in: inExpr, p: paramsOf(n), lit: lang === "js" ? jsLit : pyLit, v, use: (h) => helpers.add(h) };
    let code: Code;
    try { code = lang === "js" ? def.js(gen) : def.py(gen); }
    catch (err) { throw new FlowError((err as Error).message, n.id); }
    const pre = typeof code === "string" ? [] : code.pre;
    const expr = typeof code === "string" ? code : code.expr;
    if (n.type === "flow.return") usesResult = true;

    const title = `${n.id} · ${n.label || def.title}${n.type === "flow.input" ? ` “${inputName(gen.p)}”` : ""}`;
    const cond = [...g].map((x) => (x.startsWith("!") ? (lang === "js" ? `!${x.slice(1)}` : `not ${x.slice(1)}`) : x)).join(lang === "js" ? " && " : " and ");
    const body: string[] = [];
    body.push(...pre);
    body.push(lang === "js" ? `${v} = ${expr};` : `${v} = ${expr}`);
    if (n.type === "logic.if") body.push(lang === "js" ? `${v}_c = Boolean(${inExpr.condition});` : `${v}_c = bool(${inExpr.condition})`);
    if (opts.trace) body.push(lang === "js" ? `__trace(${JSON.stringify(n.id)}, ${v});` : `_trace(${JSON.stringify(n.id)}, ${v})`);

    lines.push(`${pad}${lang === "js" ? "//" : "#"} ${title}`);
    if (lang === "js" && !cond && !opts.trace) {
      // Unconditional, untraced: plain constants read best.
      lines.push(...pre.flatMap((l) => l.split("\n")).map((l) => `${pad}${l}`));
      lines.push(...`const ${v} = ${expr};`.split("\n").map((l) => `${pad}${l}`));
      if (n.type === "logic.if") lines.push(`${pad}const ${v}_c = Boolean(${inExpr.condition});`);
    } else if (lang === "js") {
      lines.push(`${pad}let ${v}${n.type === "logic.if" ? `, ${v}_c = false` : ""};`);
      let inner = body;
      if (opts.trace) inner = ["try {", ...body.map((l) => `  ${l}`), `} catch (e) { __fail(${JSON.stringify(n.id)}, e); }`];
      if (cond) lines.push(`${pad}if (${cond}) {`, ...inner.flatMap((l) => l.split("\n")).map((l) => `${pad}  ${l}`), `${pad}}`);
      else lines.push(...inner.flatMap((l) => l.split("\n")).map((l) => `${pad}${l}`));
    } else if (!cond && !opts.trace) {
      lines.push(...body.flatMap((l) => l.split("\n")).map((l) => `${pad}${l}`));
    } else {
      lines.push(`${pad}${v} = None${n.type === "logic.if" ? `; ${v}_c = False` : ""}`);
      let inner = body;
      if (opts.trace) inner = ["try:", ...body.flatMap((l) => l.split("\n")).map((l) => `    ${l}`), "except Exception as e:", `    _fail(${JSON.stringify(n.id)}, e)`];
      if (cond) lines.push(`${pad}if ${cond}:`, ...inner.flatMap((l) => l.split("\n")).map((l) => `${pad}    ${l}`));
      else lines.push(...inner.flatMap((l) => l.split("\n")).map((l) => `${pad}${l}`));
    }
  }

  const out: string[] = [];
  if (lang === "js") {
    out.push(`export async function ${fn}(inputs = {}) {`);
    if (usesResult) out.push("  let __result = null;");
    out.push(...lines);
    out.push(usesResult ? "  return __result;" : "  return null;", "}", "");
  } else {
    out.push(`async def ${fn}(**inputs):`);
    if (usesResult) out.push("    _result = [None]", "    def _set_result(v):", "        _result[0] = v", "        return v");
    out.push(...lines);
    out.push(usesResult ? "    return _result[0]" : "    return None", "");
  }
  return { lines: out, order: nodes.map((n) => n.id) };
}

/** A port's typed-in value as a literal (or the language's "nothing"). */
function literalFor(port: FlowPort, raw: unknown, lang: FlowLang, node: string): string {
  const lit = lang === "js" ? jsLit : pyLit;
  let v = raw === undefined || raw === "" ? port.default : raw;
  if (v === undefined || v === null) return lang === "js" ? "undefined" : "None";
  if (port.field === "number") { const n = Number(v); v = Number.isFinite(n) ? n : 0; }
  else if (port.field === "boolean") v = v === true || v === "true" || v === "1" || v === "yes";
  else if (port.field === "json" && typeof v === "string") {
    try { v = JSON.parse(v); } catch { throw new FlowError(`“${port.name}” is not valid JSON.`, node); }
  }
  return lit(v);
}

/** Reads the node values a traced run logged: node id → { value } | { error }. */
export function traceResults(logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }>): Record<string, { value?: unknown; error?: string }> {
  const out: Record<string, { value?: unknown; error?: string }> = {};
  for (const l of logs) {
    const f = l.fields ?? {};
    if (l.msg === "flow:node" && typeof f.node === "string") out[f.node] = { value: f.value };
    else if (l.msg === "flow:fail" && typeof f.node === "string") out[f.node] = { ...(out[f.node] ?? {}), error: String(f.error ?? "failed") };
  }
  return out;
}

/* ============================================================ examples */

const N = (id: string, type: string, x: number, y: number, params: Record<string, unknown> = {}, values: Record<string, unknown> = {}): FlowNode => ({ id, type, x, y, params: { ...paramsOf({ id, type, x, y }), ...params }, values });
const E = (from: string, fp: string, to: string, tp: string): FlowEdge => ({ id: `e_${from}_${fp}_${to}_${tp}`, from: { node: from, port: fp }, to: { node: to, port: tp } });

export const FLOW_EXAMPLES: Array<{ id: string; title: string; doc: string; flow: Flow }> = [
  { id: "hello", title: "Hello", doc: "An input, a template and a message.", flow: { format: "m5flow", version: 1, lang: "js", name: "hello", summary: "Greets someone.", nodes: [
    N("n1", "flow.input", 40, 80, { name: "name", label: "Your name", default: "world" }),
    N("n2", "text.template", 320, 80, { template: "# Hello, {name}!\nNice to see you." }),
    N("n3", "out.markdown", 600, 80),
  ], edges: [E("n1", "value", "n2", "name"), E("n2", "text", "n3", "text")] } },
  { id: "qr", title: "QR code", doc: "Text → QR image, sent to the caller.", flow: { format: "m5flow", version: 1, lang: "js", name: "qr", summary: "Makes a QR code.", nodes: [
    N("n1", "flow.input", 40, 80, { name: "text", label: "Text or URL", default: "https://chat.fir.ma", required: true }),
    N("n2", "codes.qr", 320, 80, { scale: 5 }),
    N("n3", "out.image", 600, 80, { alt: "QR code" }),
  ], edges: [E("n1", "value", "n2", "text"), E("n2", "image", "n3", "image")] } },
  { id: "branch", title: "Branch", doc: "Compare a number and answer differently.", flow: { format: "m5flow", version: 1, lang: "js", name: "branch", summary: "Is it big?", nodes: [
    N("n1", "flow.input", 40, 60, { name: "n", type: "number", label: "A number", default: "7" }),
    N("n2", "logic.compare", 300, 60, { op: ">" }, { b: 10 }),
    N("n3", "logic.if", 560, 60),
    N("n4", "text.template", 820, 0, { template: "{n} is big." }),
    N("n5", "text.template", 820, 160, { template: "{n} is small." }),
    N("n6", "out.text", 1080, 0),
    N("n7", "out.text", 1080, 160),
  ], edges: [E("n1", "value", "n2", "a"), E("n2", "result", "n3", "condition"), E("n1", "value", "n3", "value"), E("n3", "then", "n4", "n"), E("n3", "else", "n5", "n"), E("n4", "text", "n6", "text"), E("n5", "text", "n7", "text")] } },
  { id: "http", title: "Fetch JSON", doc: "Calls an API and shows a table of the results.", flow: { format: "m5flow", version: 1, lang: "js", name: "fetch-json", summary: "Fetches JSON and shows it as a table.", nodes: [
    N("n1", "flow.input", 40, 80, { name: "url", type: "url", label: "URL", default: "https://jsonplaceholder.typicode.com/users", required: true }),
    N("n2", "http.request", 320, 80),
    N("n3", "data.sort", 600, 40, { by: "name", limit: 5 }),
    N("n4", "out.table", 880, 40, { columns: "name, email", title: "Users" }),
  ], edges: [E("n1", "value", "n2", "url"), E("n2", "json", "n3", "list"), E("n3", "list", "n4", "rows")] } },
  { id: "speak", title: "Speak", doc: "Text → speech (offline voices), sent as an audio file.", flow: { format: "m5flow", version: 1, lang: "js", name: "speak", summary: "Reads text aloud.", nodes: [
    N("n1", "flow.input", 40, 80, { name: "text", type: "text", label: "Text", default: "Dobrý den!", required: true }),
    N("n2", "ai.tts", 320, 80),
    N("n3", "out.file", 600, 80, { name: "speech.wav" }),
  ], edges: [E("n1", "value", "n2", "text"), E("n2", "result", "n3", "data")] } },
  { id: "ai", title: "AI answer", doc: "Asks the AI and returns its answer.", flow: { format: "m5flow", version: 1, lang: "js", name: "ai-answer", summary: "Answers a question with AI.", nodes: [
    N("n1", "flow.input", 40, 80, { name: "question", type: "text", label: "Question", required: true }),
    N("n2", "ai.chat", 320, 80),
    N("n3", "out.markdown", 600, 80),
  ], edges: [E("n1", "value", "n2", "prompt"), E("n2", "text", "n3", "text")] } },
  { id: "counter", title: "Counter", doc: "Counts visits in the shared cache.", flow: { format: "m5flow", version: 1, lang: "py", name: "counter", summary: "How many times it ran.", nodes: [
    N("n1", "store.incr", 40, 80, {}, { key: "visits", by: 1 }),
    N("n2", "text.template", 320, 80, { template: "Visit number {count}." }),
    N("n3", "out.text", 600, 80),
    N("n4", "flow.return", 600, 200),
  ], edges: [E("n1", "value", "n2", "count"), E("n2", "text", "n3", "text"), E("n1", "value", "n4", "value")] } },
];
