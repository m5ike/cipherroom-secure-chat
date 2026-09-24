// The menu's template language (4.0) — a small, safe relative of Latte.
// PURE module: the app renders the menu's HTML blocks with it, the server
// renders the console's preview with it.
//
//   {$user.username}                 a variable (always escaped)
//   {$session.room|upper}            with filters: |upper |truncate:12 |date:'H:i' …
//   {=$room.peers + 1}               an expression
//   {if $user.signedIn} … {elseif $session.connected} … {else} … {/if}
//   {ifset $session.room} … {/ifset}
//   {foreach $room.people as $name} {$iterator.counter}. {$name} {/foreach}
//   {foreach $map as $key => $value} … {/foreach}
//   {var $greeting = 'Ahoj'}         a variable of your own
//   {icon shield-check}              an icon from the menu's catalog
//   {_'menu.room'}                   a translated text
//   {* a comment *}                  not shown
//   {l} {r}                          a literal { and }
//
// A "{" followed by a space (or anything that is not a tag) is plain text,
// so CSS and JSON pass through. The result is HTML that goes through
// parseSafeHtml(): only allowed tags, attributes and styles survive, links
// only to https or this site, actions only from the menu's list — an
// operator cannot inject a script into every user's menu.

/* ======================================================================= */
/*  Parsing                                                                */
/* ======================================================================= */

type Expr =
  | { e: "lit"; v: unknown }
  | { e: "var"; name: string; path: Array<string | Expr> }
  | { e: "not"; x: Expr }
  | { e: "neg"; x: Expr }
  | { e: "bin"; op: string; a: Expr; b: Expr };
type Filter = { name: string; args: Expr[] };
type TNode =
  | { t: "text"; v: string }
  | { t: "print"; expr: Expr; filters: Filter[] }
  | { t: "if"; branches: Array<{ cond: Expr | null; body: TNode[] }> }
  | { t: "ifset"; expr: Expr; body: TNode[]; otherwise: TNode[] }
  | { t: "foreach"; list: Expr; key: string | null; item: string; body: TNode[]; otherwise: TNode[] }
  | { t: "var"; name: string; expr: Expr }
  | { t: "icon"; name: string }
  | { t: "tr"; key: string };

export class TemplateError extends Error {
  constructor(message: string, readonly at: number) {
    super(`${message} (at ${at})`);
    this.name = "TemplateError";
  }
}

const TAG_START = /^(?:\$|=|_|\*|\/(?:if|foreach|ifset)\b|(?:if|elseif|else|ifset|foreach|var|icon|t|l|r)\b)/;

/** Splits a template into text and tags ("{…}" that is really a tag). */
function scan(src: string): Array<{ kind: "text"; v: string } | { kind: "tag"; v: string; at: number }> {
  const out: Array<{ kind: "text"; v: string } | { kind: "tag"; v: string; at: number }> = [];
  let text = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "{" && TAG_START.test(src.slice(i + 1, i + 12))) {
      if (src.startsWith("{*", i)) {
        const end = src.indexOf("*}", i + 2);
        if (end < 0) throw new TemplateError("unclosed comment", i);
        i = end + 2;
        continue;
      }
      // Find the closing brace, stepping over quoted strings.
      let j = i + 1;
      let quote = "";
      for (; j < src.length; j++) {
        const c = src[j];
        if (quote) { if (c === "\\") j++; else if (c === quote) quote = ""; }
        else if (c === "'" || c === '"') quote = c;
        else if (c === "}") break;
        else if (c === "\n" && !quote) { j = -1; break; }
      }
      if (j < 0 || j >= src.length) { text += ch; i++; continue; }
      if (text) { out.push({ kind: "text", v: text }); text = ""; }
      out.push({ kind: "tag", v: src.slice(i + 1, j).trim(), at: i });
      i = j + 1;
      continue;
    }
    text += ch;
    i++;
  }
  if (text) out.push({ kind: "text", v: text });
  return out;
}

/* ---------------------------------------------------------- expressions */

type Tok = { k: "num" | "str" | "var" | "id" | "op"; v: string };

function lex(src: string, at: number): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'" || c === '"') {
      let s = "";
      let j = i + 1;
      for (; j < src.length && src[j] !== c; j++) {
        if (src[j] === "\\" && j + 1 < src.length) { j++; s += src[j] === "n" ? "\n" : src[j]; } else s += src[j];
      }
      if (j >= src.length) throw new TemplateError("unclosed string", at);
      toks.push({ k: "str", v: s });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = src.slice(i).match(/^\d+(?:\.\d+)?/)!;
      toks.push({ k: "num", v: m[0] });
      i += m[0].length;
      continue;
    }
    if (c === "$") {
      const m = src.slice(i + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
      if (!m) throw new TemplateError("a variable name is missing after $", at);
      toks.push({ k: "var", v: m[0] });
      i += 1 + m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_-]*/)!;
      toks.push({ k: "id", v: m[0] });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 3);
    const op = ["===", "!=="].includes(two) ? two : ["==", "!=", "<=", ">=", "&&", "||", "=>"].includes(src.slice(i, i + 2)) ? src.slice(i, i + 2) : c;
    if (!"=!<>&|().[],:+-*/%~?".includes(op[0])) throw new TemplateError(`unexpected "${c}"`, at);
    toks.push({ k: "op", v: op });
    i += op.length;
  }
  return toks;
}

class ExprParser {
  private i = 0;
  constructor(private readonly toks: Tok[], private readonly at: number) {}
  get done() { return this.i >= this.toks.length; }
  peek(v?: string) { const t = this.toks[this.i]; return t && (v === undefined || t.v === v) ? t : null; }
  take(v?: string) { const t = this.peek(v); if (t) this.i++; return t; }
  expect(v: string) { if (!this.take(v)) throw new TemplateError(`"${v}" expected`, this.at); }

  expr(): Expr { return this.or(); }
  private or(): Expr { let a = this.and(); while (this.peek("||")) { this.i++; a = { e: "bin", op: "||", a, b: this.and() }; } return a; }
  private and(): Expr { let a = this.cmp(); while (this.peek("&&")) { this.i++; a = { e: "bin", op: "&&", a, b: this.cmp() }; } return a; }
  private cmp(): Expr {
    let a = this.add();
    for (;;) {
      const t = this.toks[this.i];
      if (t?.k === "op" && ["==", "!=", "===", "!==", "<", ">", "<=", ">="].includes(t.v)) { this.i++; a = { e: "bin", op: t.v, a, b: this.add() }; } else return a;
    }
  }
  private add(): Expr {
    let a = this.mul();
    for (;;) {
      const t = this.toks[this.i];
      if (t?.k === "op" && (t.v === "+" || t.v === "-" || t.v === "~")) { this.i++; a = { e: "bin", op: t.v, a, b: this.mul() }; } else return a;
    }
  }
  private mul(): Expr {
    let a = this.unary();
    for (;;) {
      const t = this.toks[this.i];
      if (t?.k === "op" && (t.v === "*" || t.v === "/" || t.v === "%")) { this.i++; a = { e: "bin", op: t.v, a, b: this.unary() }; } else return a;
    }
  }
  private unary(): Expr {
    if (this.take("!")) return { e: "not", x: this.unary() };
    if (this.take("-")) return { e: "neg", x: this.unary() };
    return this.primary();
  }
  primary(): Expr {
    const t = this.toks[this.i++];
    if (!t) throw new TemplateError("an expression is missing", this.at);
    if (t.k === "num") return { e: "lit", v: Number(t.v) };
    if (t.k === "str") return { e: "lit", v: t.v };
    if (t.k === "id") {
      if (t.v === "true") return { e: "lit", v: true };
      if (t.v === "false") return { e: "lit", v: false };
      if (t.v === "null") return { e: "lit", v: null };
      // A bare word is a string (Latte-style: {icon shield}, |date:H:i).
      return { e: "lit", v: t.v };
    }
    if (t.k === "var") {
      const path: Array<string | Expr> = [];
      for (;;) {
        if (this.peek(".") ) {
          this.i++;
          const n = this.toks[this.i++];
          if (!n || (n.k !== "id" && n.k !== "num")) throw new TemplateError("a property name is missing after '.'", this.at);
          path.push(n.v);
        } else if (this.peek("[")) {
          this.i++;
          path.push(this.expr());
          this.expect("]");
        } else break;
      }
      return { e: "var", name: t.v, path };
    }
    if (t.v === "(") { const x = this.expr(); this.expect(")"); return x; }
    throw new TemplateError(`unexpected "${t.v}"`, this.at);
  }
}

/** "expr|filter:arg:arg|filter" */
function parsePrint(src: string, at: number): { expr: Expr; filters: Filter[] } {
  const toks = lex(src, at);
  // Split on a single "|" (not "||").
  const parts: Tok[][] = [[]];
  for (const t of toks) {
    if (t.k === "op" && t.v === "|") parts.push([]);
    else parts[parts.length - 1].push(t);
  }
  const p = new ExprParser(parts[0], at);
  const expr = p.expr();
  if (!p.done) throw new TemplateError("unexpected text after the expression", at);
  const filters: Filter[] = parts.slice(1).map((ft) => {
    const fp = new ExprParser(ft, at);
    const name = fp.take();
    if (!name || name.k !== "id") throw new TemplateError("a filter name is missing after '|'", at);
    const args: Expr[] = [];
    while (fp.take(":")) args.push(fp.primary());
    if (!fp.done) throw new TemplateError(`unexpected text in the filter "${name.v}"`, at);
    return { name: name.v, args };
  });
  return { expr, filters };
}

function parseExpr(src: string, at: number): Expr {
  const p = new ExprParser(lex(src, at), at);
  const e = p.expr();
  if (!p.done) throw new TemplateError("unexpected text after the expression", at);
  return e;
}

const templateCache = new Map<string, TNode[]>();

/** Parses a template (cached). Throws TemplateError with the position. */
export function parseTemplate(src: string): TNode[] {
  const cached = templateCache.get(src);
  if (cached) return cached;
  const tokens = scan(src);
  let pos = 0;
  const block = (ends: string[]): { nodes: TNode[]; end: string } => {
    const nodes: TNode[] = [];
    while (pos < tokens.length) {
      const tk = tokens[pos++];
      if (tk.kind === "text") { nodes.push({ t: "text", v: tk.v }); continue; }
      const body = tk.v;
      const word = body.match(/^(\/?[a-z_]+|\$|=)/i)?.[0] ?? "";
      if (ends.includes(word)) return { nodes, end: word === "elseif" || word === "else" ? body : word };
      if (body.startsWith("$")) { nodes.push({ t: "print", ...parsePrint(body, tk.at) }); continue; }
      if (body.startsWith("=")) { nodes.push({ t: "print", ...parsePrint(body.slice(1), tk.at) }); continue; }
      if (body === "l") { nodes.push({ t: "text", v: "{" }); continue; }
      if (body === "r") { nodes.push({ t: "text", v: "}" }); continue; }
      if (body.startsWith("_")) {
        const key = body.slice(1).trim().replace(/^['"]|['"]$/g, "");
        nodes.push({ t: "tr", key });
        continue;
      }
      if (word === "t") { nodes.push({ t: "tr", key: body.slice(1).trim().replace(/^['"]|['"]$/g, "") }); continue; }
      if (word === "icon") {
        const name = body.slice(4).trim().replace(/^['"]|['"]$/g, "");
        if (!/^[a-z0-9-]{1,40}$/.test(name)) throw new TemplateError("{icon name}: a name like shield-check", tk.at);
        nodes.push({ t: "icon", name });
        continue;
      }
      if (word === "var") {
        const m = body.match(/^var\s+\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]+)$/);
        if (!m) throw new TemplateError("{var $name = expression}", tk.at);
        nodes.push({ t: "var", name: m[1], expr: parseExpr(m[2], tk.at) });
        continue;
      }
      if (word === "if") {
        const branches: Array<{ cond: Expr | null; body: TNode[] }> = [];
        let cond: Expr | null = parseExpr(body.slice(2), tk.at);
        for (;;) {
          const r = block(["elseif", "else", "/if"]);
          branches.push({ cond, body: r.nodes });
          if (r.end === "/if") break;
          if (r.end.startsWith("elseif")) { cond = parseExpr(r.end.slice(6), tk.at); continue; }
          if (r.end === "else") { cond = null; const last = block(["/if"]); branches.push({ cond: null, body: last.nodes }); break; }
          throw new TemplateError("{if} without {/if}", tk.at);
        }
        nodes.push({ t: "if", branches });
        continue;
      }
      if (word === "ifset") {
        const expr = parseExpr(body.slice(5), tk.at);
        const r = block(["else", "/ifset"]);
        const otherwise = r.end === "else" ? block(["/ifset"]).nodes : [];
        nodes.push({ t: "ifset", expr, body: r.nodes, otherwise });
        continue;
      }
      if (word === "foreach") {
        const m = body.match(/^foreach\s+([\s\S]+?)\s+as\s+\$([A-Za-z_]\w*)(?:\s*=>\s*\$([A-Za-z_]\w*))?$/);
        if (!m) throw new TemplateError("{foreach $list as $item} or {foreach $map as $key => $value}", tk.at);
        const list = parseExpr(m[1], tk.at);
        const r = block(["else", "/foreach"]);
        const otherwise = r.end === "else" ? block(["/foreach"]).nodes : [];
        nodes.push({ t: "foreach", list, key: m[3] ? m[2] : null, item: m[3] ?? m[2], body: r.nodes, otherwise });
        continue;
      }
      throw new TemplateError(`unknown tag {${body.slice(0, 20)}}`, tk.at);
    }
    if (ends.length) throw new TemplateError(`${ends.join(" or ")} is missing`, src.length);
    return { nodes, end: "" };
  };
  const { nodes } = block([]);
  if (templateCache.size > 300) templateCache.clear();
  templateCache.set(src, nodes);
  return nodes;
}

/* ======================================================================= */
/*  Rendering                                                              */
/* ======================================================================= */

export type TemplateVars = Record<string, unknown>;
export type RenderOptions = {
  /** Translates "{_'key'}". */
  translate?: (key: string) => string;
  /** "cs" | "en" | "de" for dates and durations. */
  lang?: string;
};

const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);
const MAX_OUTPUT = 20_000;
const MAX_LOOPS = 1_000;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function lookup(obj: unknown, key: unknown): unknown {
  if (obj === null || obj === undefined) return undefined;
  const k = typeof key === "number" ? key : String(key);
  if (typeof k === "string" && FORBIDDEN.has(k)) return undefined;
  if (Array.isArray(obj)) return k === "length" ? obj.length : obj[Number(k)];
  if (typeof obj === "string") return k === "length" ? obj.length : undefined;
  if (typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, k)) return (obj as Record<string, unknown>)[k as string];
  return undefined;
}

const truthy = (v: unknown) => (Array.isArray(v) ? v.length > 0 : Boolean(v) && v !== "0");

function toText(v: unknown): string {
  if (v === null || v === undefined || v === false) return "";
  if (v === true) return "1";
  if (Array.isArray(v)) return v.map(toText).join(", ");
  if (typeof v === "object") return "";
  return String(v);
}

function pad(n: number, w = 2) { return String(n).padStart(w, "0"); }

/** PHP / Latte date letters: d j m n Y y H G i s D N. */
export function formatDate(value: unknown, format: string): string {
  const d = value instanceof Date ? value : new Date(typeof value === "number" || typeof value === "string" ? value : NaN);
  if (Number.isNaN(d.getTime())) return "";
  const map: Record<string, string> = {
    d: pad(d.getDate()), j: String(d.getDate()), m: pad(d.getMonth() + 1), n: String(d.getMonth() + 1),
    Y: String(d.getFullYear()), y: pad(d.getFullYear() % 100), H: pad(d.getHours()), G: String(d.getHours()),
    i: pad(d.getMinutes()), s: pad(d.getSeconds()), N: String(d.getDay() || 7), D: ["Ne", "Po", "Út", "St", "Čt", "Pá", "So"][d.getDay()],
  };
  let out = "";
  for (let i = 0; i < format.length; i++) {
    const c = format[i];
    if (c === "\\" && i + 1 < format.length) { out += format[++i]; continue; }
    out += map[c] ?? c;
  }
  return out;
}

const UNITS: Record<string, [string, string, string]> = {
  cs: ["s", "min", "h"], en: ["s", "min", "h"], de: ["s", "Min.", "Std."],
};

function duration(ms: number, lang = "cs"): string {
  const [s, m, h] = UNITS[lang] ?? UNITS.en;
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec} ${s}`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} ${m}`;
  return `${Math.floor(min / 60)} ${h} ${min % 60} ${m}`;
}

function bytes(n: number): string {
  if (!Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

type FilterFn = (v: unknown, args: unknown[], opts: RenderOptions) => unknown;

export const FILTERS: Record<string, FilterFn> = {
  upper: (v) => toText(v).toUpperCase(),
  lower: (v) => toText(v).toLowerCase(),
  capitalize: (v) => toText(v).replace(/(^|\s)(\S)/g, (_m, a: string, b: string) => a + b.toUpperCase()),
  firstUpper: (v) => { const s = toText(v); return s.charAt(0).toUpperCase() + s.slice(1); },
  trim: (v) => toText(v).trim(),
  length: (v) => (Array.isArray(v) ? v.length : v && typeof v === "object" ? Object.keys(v).length : toText(v).length),
  truncate: (v, [n = 20, suffix = "…"]) => { const s = toText(v); const len = Number(n) || 20; return s.length > len ? s.slice(0, Math.max(0, len - 1)) + String(suffix) : s; },
  replace: (v, [search = "", repl = ""]) => toText(v).split(String(search)).join(String(repl)),
  default: (v, [fallback = ""]) => (v === null || v === undefined || v === "" ? fallback : v),
  date: (v, [format = "j. n. Y H:i"]) => formatDate(v, String(format)),
  number: (v, [decimals = 0, point = ",", thousands = " "]) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return "";
    const [int, frac] = n.toFixed(Math.max(0, Math.min(6, Number(decimals) || 0))).split(".");
    return int.replace(/\B(?=(\d{3})+(?!\d))/g, String(thousands)) + (frac ? String(point) + frac : "");
  },
  round: (v, [decimals = 0]) => { const f = 10 ** (Number(decimals) || 0); return Math.round(Number(v) * f) / f; },
  first: (v) => (Array.isArray(v) ? v[0] : toText(v).charAt(0)),
  last: (v) => (Array.isArray(v) ? v[v.length - 1] : toText(v).slice(-1)),
  join: (v, [sep = ", "]) => (Array.isArray(v) ? v.map(toText).join(String(sep)) : toText(v)),
  bytes: (v) => bytes(Number(v)),
  duration: (v, _a, o) => duration(Number(v), o.lang),
  ago: (v, _a, o) => { const t = Number(v); return Number.isFinite(t) && t > 0 ? duration(Date.now() - t, o.lang) : ""; },
  yesno: (v, [yes = "✓", no = "✗"]) => (truthy(v) ? yes : no),
  padLeft: (v, [n = 2, ch = "0"]) => toText(v).padStart(Number(n) || 0, String(ch).charAt(0) || " "),
  escape: (v) => v,
  noescape: (v) => v, // accepted, but the output is escaped anyway
};

export const MAX_TEMPLATE_OUTPUT = MAX_OUTPUT;

/** Renders a template to HTML text (variables escaped). */
export function renderTemplate(src: string, vars: TemplateVars, opts: RenderOptions = {}): string {
  const nodes = parseTemplate(src);
  const scopes: Array<Record<string, unknown>> = [vars];
  let loops = 0;
  let out = "";

  const get = (name: string): unknown => {
    for (let i = scopes.length - 1; i >= 0; i--) if (Object.prototype.hasOwnProperty.call(scopes[i], name)) return scopes[i][name];
    return undefined;
  };
  const evaluate = (e: Expr): unknown => {
    switch (e.e) {
      case "lit": return e.v;
      case "not": return !truthy(evaluate(e.x));
      case "neg": return -Number(evaluate(e.x));
      case "var": {
        if (FORBIDDEN.has(e.name)) return undefined;
        let v = get(e.name);
        for (const p of e.path) v = lookup(v, typeof p === "string" ? p : evaluate(p));
        return v;
      }
      case "bin": {
        if (e.op === "&&") return truthy(evaluate(e.a)) ? evaluate(e.b) : false;
        if (e.op === "||") { const a = evaluate(e.a); return truthy(a) ? a : evaluate(e.b); }
        const a = evaluate(e.a);
        const b = evaluate(e.b);
        switch (e.op) {
          // eslint-disable-next-line eqeqeq
          case "==": return a == b;
          // eslint-disable-next-line eqeqeq
          case "!=": return a != b;
          case "===": return a === b;
          case "!==": return a !== b;
          case "<": return Number(a) < Number(b);
          case ">": return Number(a) > Number(b);
          case "<=": return Number(a) <= Number(b);
          case ">=": return Number(a) >= Number(b);
          case "+": return typeof a === "number" && typeof b === "number" ? a + b : toText(a) + toText(b);
          case "~": return toText(a) + toText(b);
          case "-": return Number(a) - Number(b);
          case "*": return Number(a) * Number(b);
          case "/": return Number(b) === 0 ? 0 : Number(a) / Number(b);
          case "%": return Number(b) === 0 ? 0 : Number(a) % Number(b);
        }
        return undefined;
      }
    }
  };
  const emit = (s: string) => {
    if (out.length < MAX_OUTPUT) out += s.slice(0, MAX_OUTPUT - out.length);
  };
  const run = (list: TNode[]) => {
    for (const n of list) {
      if (out.length >= MAX_OUTPUT) return;
      switch (n.t) {
        case "text": emit(n.v); break;
        case "print": {
          let v = evaluate(n.expr);
          for (const f of n.filters) {
            const fn = FILTERS[f.name];
            if (!fn) throw new TemplateError(`unknown filter |${f.name}`, 0);
            v = fn(v, f.args.map(evaluate), opts);
          }
          emit(escapeHtml(toText(v)));
          break;
        }
        case "tr": emit(escapeHtml(opts.translate ? opts.translate(n.key) : n.key)); break;
        case "icon": emit(`<i data-icon="${escapeHtml(n.name)}"></i>`); break;
        case "var": scopes[scopes.length - 1][n.name] = evaluate(n.expr); break;
        case "if": {
          for (const b of n.branches) if (b.cond === null || truthy(evaluate(b.cond))) { run(b.body); break; }
          break;
        }
        case "ifset": {
          const v = evaluate(n.expr);
          run(v !== undefined && v !== null ? n.body : n.otherwise);
          break;
        }
        case "foreach": {
          const list = evaluate(n.list);
          const entries: Array<[unknown, unknown]> = Array.isArray(list)
            ? list.map((v, i) => [i, v])
            : list && typeof list === "object" ? Object.entries(list as Record<string, unknown>).filter(([k]) => !FORBIDDEN.has(k)) : [];
          if (!entries.length) { run(n.otherwise); break; }
          entries.forEach(([k, v], i) => {
            if (++loops > MAX_LOOPS) return;
            const scope: Record<string, unknown> = {
              [n.item]: v,
              iterator: { counter: i + 1, counter0: i, first: i === 0, last: i === entries.length - 1, odd: i % 2 === 0, even: i % 2 === 1, length: entries.length },
            };
            if (n.key) scope[n.key] = k;
            scopes.push(scope);
            run(n.body);
            scopes.pop();
          });
          break;
        }
      }
    }
  };
  // {var} in the top block must not change the caller's object.
  scopes.push({});
  run(nodes);
  return out;
}

/** A plain-text label with {$variables} (no HTML), "" on an error. */
export function renderText(src: string, vars: TemplateVars, opts: RenderOptions = {}): string {
  if (!src.includes("{")) return src;
  try { return decodeEntities(renderTemplate(src, vars, opts)).replace(/<[^>]*>/g, ""); } catch { return src; }
}

/* ======================================================================= */
/*  Safe HTML                                                              */
/* ======================================================================= */

/** A sanitized element tree: text, or a tag with allowed attributes. */
export type SafeNode = string | { t: string; a: Record<string, string>; c: SafeNode[] };

const ALLOWED_TAGS = new Set([
  "div", "span", "p", "b", "strong", "i", "em", "u", "s", "small", "br", "hr", "code", "kbd", "mark", "sup", "sub",
  "ul", "ol", "li", "a", "img", "h4", "h5", "h6", "time", "abbr", "button", "section", "header", "footer", "figure", "figcaption",
]);
const VOID_TAGS = new Set(["br", "hr", "img"]);
/** Their content goes too. */
const DROP_TAGS = new Set(["script", "style", "iframe", "object", "embed", "template", "noscript", "svg", "math", "textarea", "select", "form", "input", "link", "meta", "base", "frame", "frameset", "audio", "video", "canvas"]);
const GLOBAL_ATTRS = new Set(["class", "style", "title", "role", "aria-label", "aria-hidden", "data-action", "data-icon", "lang", "dir", "id"]);
const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "target", "rel"]),
  img: new Set(["src", "alt", "width", "height"]),
  time: new Set(["datetime"]),
  abbr: new Set(["title"]),
  button: new Set(["type"]),
};
const STYLE_PROPS = new Set([
  "color", "background", "background-color", "font-size", "font-weight", "font-style", "font-family", "text-align", "text-decoration",
  "text-transform", "letter-spacing", "line-height", "margin", "margin-top", "margin-right", "margin-bottom", "margin-left", "padding",
  "padding-top", "padding-right", "padding-bottom", "padding-left", "border", "border-top", "border-bottom", "border-left", "border-right",
  "border-color", "border-width", "border-style", "border-radius", "display", "gap", "align-items", "justify-content", "flex", "flex-wrap",
  "flex-direction", "width", "max-width", "min-width", "height", "max-height", "min-height", "opacity", "white-space", "overflow",
  "text-overflow", "vertical-align", "box-shadow",
]);

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function sanitizeStyleAttr(style: string): string {
  const out: string[] = [];
  for (const decl of style.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const value = decl.slice(i + 1).trim();
    if (!STYLE_PROPS.has(prop) || !value || value.length > 200) continue;
    if (/url\s*\(|expression|javascript:|@import|\\|[<>]|behavior/i.test(value)) continue;
    if (prop === "display" && !/^(inline|inline-block|block|flex|inline-flex|grid|none)$/.test(value)) continue;
    out.push(`${prop}: ${value}`);
  }
  return out.join("; ");
}

/** What a data-action may say: "panel:<panel>", "fn:<fn>[:param]" (checked by the caller's lists). */
export function isSafeAction(value: string, panels: readonly string[], fns: readonly string[]): boolean {
  const [kind, name] = value.split(":");
  return (kind === "panel" && panels.includes(name)) || (kind === "fn" && fns.includes(name));
}

function safeUrl(value: string, forImage: boolean): string | null {
  const v = value.trim();
  if (forImage) return /^\/(?!\/)[^\s]*$/.test(v) || /^data:image\/(png|gif|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(v) ? v : null;
  if (/^https:\/\/[^\s]+$/i.test(v) || /^mailto:[^\s]+$/i.test(v) || /^\/(?!\/)[^\s]*$/.test(v) || /^#[\w-]*$/.test(v)) return v;
  return null;
}

/**
 * Parses (a small, forgiving HTML parser — no DOM needed) and keeps only
 * what is safe: allowed tags and attributes, harmless styles, links to
 * https / mailto / this site, images from this site, and actions from
 * the menu's lists. Everything else is dropped (the text of an unknown
 * inline tag stays; script-like tags go with their content).
 */
export function parseSafeHtml(html: string, allow: { panels: readonly string[]; fns: readonly string[] }): SafeNode[] {
  const root: { t: string; a: Record<string, string>; c: SafeNode[] } = { t: "#root", a: {}, c: [] };
  const stack: Array<typeof root> = [root];
  let dropDepth = 0;
  let dropTag = "";
  let i = 0;
  const top = () => stack[stack.length - 1] ?? root;
  const pushText = (text: string) => {
    if (dropDepth > 0 || !text) return;
    const parent = top();
    const decoded = decodeEntities(text);
    const last = parent.c[parent.c.length - 1];
    if (typeof last === "string") parent.c[parent.c.length - 1] = last + decoded;
    else parent.c.push(decoded);
  };
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) { pushText(html.slice(i)); break; }
    pushText(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) { const end = html.indexOf("-->", lt + 4); i = end < 0 ? html.length : end + 3; continue; }
    const close = html[lt + 1] === "/";
    const m = html.slice(lt).match(close ? /^<\/([a-zA-Z][a-zA-Z0-9]*)\s*>/ : /^<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/);
    if (!m) { pushText("<"); i = lt + 1; continue; }
    i = lt + m[0].length;
    const tag = m[1].toLowerCase();
    if (close) {
      if (dropDepth > 0) { if (tag === dropTag && --dropDepth === 0) dropTag = ""; continue; }
      // Close up to the matching open element (if there is one); the close
      // tag of an element that was not kept is ignored.
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k]?.t === tag) { stack.length = k; break; }
      }
      continue;
    }
    if (dropDepth > 0) { if (tag === dropTag && !VOID_TAGS.has(tag)) dropDepth++; continue; }
    if (DROP_TAGS.has(tag)) { if (!m[3] && !VOID_TAGS.has(tag)) { dropDepth = 1; dropTag = tag; } continue; }
    if (!ALLOWED_TAGS.has(tag)) continue;
    const attrs: Record<string, string> = {};
    const attrRe = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(m[2] ?? ""))) {
      const name = am[1].toLowerCase();
      const value = decodeEntities(am[2] ?? am[3] ?? am[4] ?? "");
      if (name.startsWith("on")) continue;
      if (!GLOBAL_ATTRS.has(name) && !TAG_ATTRS[tag]?.has(name) && !name.startsWith("aria-")) continue;
      if (name === "style") { const st = sanitizeStyleAttr(value); if (st) attrs.style = st; continue; }
      if (name === "href") { const u = safeUrl(value, false); if (u) attrs.href = u; continue; }
      if (name === "src") { const u = safeUrl(value, true); if (u) attrs.src = u; continue; }
      if (name === "data-action") { if (isSafeAction(value, allow.panels, allow.fns)) attrs["data-action"] = value; continue; }
      if (name === "data-icon") { if (/^[a-z0-9-]{1,40}$/.test(value)) attrs["data-icon"] = value; continue; }
      if (name === "target") { if (value === "_blank") attrs.target = "_blank"; continue; }
      if (name === "role") { if (/^(img|note|status|presentation|separator|group)$/.test(value)) attrs.role = value; continue; }
      if (name === "id") { if (/^[a-z][\w-]{0,40}$/i.test(value)) attrs.id = `m-${value}`; continue; }
      if (name === "type") { attrs.type = "button"; continue; }
      attrs[name] = value.slice(0, 300);
    }
    if (tag === "a" && attrs.target === "_blank") attrs.rel = "noopener noreferrer";
    if (tag === "a" && !attrs.href) delete attrs.target;
    if (tag === "button") attrs.type = "button";
    const el = { t: tag, a: attrs, c: [] as SafeNode[] };
    top().c.push(el);
    if (!VOID_TAGS.has(tag) && !m[3]) stack.push(el);
  }
  return root.c;
}

/** Template → safe tree, or a one-line error box for the builder. */
export function renderMenuHtml(src: string, vars: TemplateVars, allow: { panels: readonly string[]; fns: readonly string[] }, opts: RenderOptions = {}): { nodes: SafeNode[]; error: string } {
  try {
    return { nodes: parseSafeHtml(renderTemplate(src, vars, opts), allow), error: "" };
  } catch (err) {
    return { nodes: [], error: (err as Error).message };
  }
}

/* ======================================================================= */
/*  What the builder's help window lists                                    */
/* ======================================================================= */

export const TEMPLATE_VARIABLES: ReadonlyArray<{ path: string; type: string; description: string }> = [
  { path: "$app.name", type: "text", description: "The app's name (M5cet)." },
  { path: "$app.version", type: "text", description: "The version running in the browser." },
  { path: "$app.build", type: "text", description: "The build id." },
  { path: "$app.lang", type: "text", description: "The interface language: cs, en or de." },
  { path: "$app.online", type: "yes/no", description: "The browser is online." },
  { path: "$global.server", type: "text", description: "The server's host name." },
  { path: "$global.time", type: "number", description: "The current time (ms) — use |date:'H:i'." },
  { path: "$now", type: "number", description: "Same as $global.time." },
  { path: "$user.signedIn", type: "yes/no", description: "Signed in with a passkey." },
  { path: "$user.username", type: "text", description: "The account's username (empty when signed out)." },
  { path: "$user.nickname", type: "text", description: "The nickname used in rooms." },
  { path: "$user.avatar", type: "text", description: "The avatar (an emoji or an initial)." },
  { path: "$user.groups", type: "list", description: "The user's groups: guest, user and the operator's own." },
  { path: "$user.keyVerified", type: "yes/no", description: "The account's global key was verified at sign-in." },
  { path: "$session.username", type: "text", description: "Who this session is: the account's username, or (P2P) one made from the nickname." },
  { path: "$session.current_username", type: "text", description: "Same as $session.username." },
  { path: "$session.nickname", type: "text", description: "The nickname in the current room." },
  { path: "$session.connected", type: "yes/no", description: "Connected (or connecting) to a room." },
  { path: "$session.status", type: "text", description: "idle, deriving, connecting, joined or offline." },
  { path: "$session.room", type: "text", description: "The room's name." },
  { path: "$session.mode", type: "text", description: "light or server." },
  { path: "$session.server", type: "text", description: "The signaling server in use (host)." },
  { path: "$session.peers", type: "number", description: "People connected in the room (without you)." },
  { path: "$session.rtt", type: "number", description: "Round-trip time to the server (ms)." },
  { path: "$session.since", type: "number", description: "When this connection began (ms) — use |ago." },
  { path: "$room.name", type: "text", description: "The room's name." },
  { path: "$room.peers", type: "number", description: "People in the room (without you)." },
  { path: "$room.people", type: "list", description: "Their nicknames." },
  { path: "$connection.active", type: "text", description: "The saved connection in use (its name)." },
  { path: "$connection.default", type: "text", description: "The default saved connection (its name)." },
  { path: "$connection.saved", type: "number", description: "How many connections are saved." },
  { path: "$settings.theme", type: "text", description: "The template (ios, windows, nord…)." },
  { path: "$settings.tone", type: "text", description: "light or dark." },
  { path: "$settings.accent", type: "text", description: "The colour variation." },
  { path: "$settings.lang", type: "text", description: "The language." },
  { path: "$settings.notifications", type: "yes/no", description: "Notifications are on." },
  { path: "$settings.editMode", type: "yes/no", description: "Edit Mode is on." },
  { path: "$settings.retention", type: "text", description: "ephemeral, session or server." },
  { path: "$iterator.counter", type: "number", description: "In {foreach}: 1, 2, 3… (also .counter0, .first, .last, .odd, .even, .length)." },
];

export const TEMPLATE_FILTERS: ReadonlyArray<{ name: string; args: string; description: string; example: string }> = [
  { name: "upper", args: "", description: "UPPER CASE", example: "{$session.room|upper}" },
  { name: "lower", args: "", description: "lower case", example: "{$user.username|lower}" },
  { name: "capitalize", args: "", description: "Every Word Capitalised", example: "{$user.nickname|capitalize}" },
  { name: "firstUpper", args: "", description: "First letter upper case", example: "{$session.status|firstUpper}" },
  { name: "truncate", args: "length, suffix", description: "Shortens text", example: "{$session.room|truncate:12}" },
  { name: "replace", args: "search, replacement", description: "Replaces text", example: "{$session.room|replace:'-':' '}" },
  { name: "default", args: "value", description: "When empty", example: "{$user.username|default:'host'}" },
  { name: "date", args: "format", description: "A time as d. m. Y H:i (PHP letters)", example: "{$now|date:'H:i'}" },
  { name: "number", args: "decimals, point, thousands", description: "A number, formatted", example: "{$session.rtt|number}" },
  { name: "round", args: "decimals", description: "Rounded", example: "{$session.rtt|round}" },
  { name: "length", args: "", description: "Length of a text or a list", example: "{$room.people|length}" },
  { name: "join", args: "separator", description: "A list as text", example: "{$room.people|join:', '}" },
  { name: "first / last", args: "", description: "First / last item or letter", example: "{$room.people|first}" },
  { name: "bytes", args: "", description: "1536 → 1.5 kB", example: "{$x|bytes}" },
  { name: "duration", args: "", description: "Milliseconds as 5 min / 1 h 5 min", example: "{$x|duration}" },
  { name: "ago", args: "", description: "How long ago a time was", example: "{$session.since|ago}" },
  { name: "yesno", args: "yes, no", description: "A text for yes / no", example: "{$session.connected|yesno:'online':'offline'}" },
  { name: "padLeft", args: "length, char", description: "Pads from the left", example: "{$session.peers|padLeft:2}" },
  { name: "trim", args: "", description: "Without spaces around", example: "{$user.nickname|trim}" },
];

export const TEMPLATE_MACROS: ReadonlyArray<{ syntax: string; description: string }> = [
  { syntax: "{$variable}  {$a.b[0]}", description: "Prints a value, escaped." },
  { syntax: "{=expression}", description: "Prints an expression: {=$room.peers + 1}, {='Room ' ~ $session.room}." },
  { syntax: "{if cond}…{elseif cond}…{else}…{/if}", description: "Conditions with == != === < > <= >= && || ! and ( )." },
  { syntax: "{ifset $x}…{else}…{/ifset}", description: "When a value exists." },
  { syntax: "{foreach $list as $item}…{else}…{/foreach}", description: "Repeats; {else} when the list is empty. $iterator.counter, .first, .last…" },
  { syntax: "{foreach $map as $key => $value}…{/foreach}", description: "Over an object's keys and values." },
  { syntax: "{var $name = expression}", description: "A variable of your own." },
  { syntax: "{icon shield-check}", description: "An icon from the menu's catalog (the same names as in the icon picker)." },
  { syntax: "{_'menu.room'}", description: "A translated text (the app's own keys)." },
  { syntax: "{* comment *}", description: "Not shown." },
  { syntax: "{l} {r}", description: "A literal { and }. A { followed by a space is plain text anyway." },
  { syntax: "data-action=\"panel:settings\"", description: "On any element: opens a panel (the same list as the item actions)." },
  { syntax: "data-action=\"fn:toggleTone\"", description: "On any element: runs a function (openRoom, signIn, toggleEditMode, toggleTone, …)." },
];

export const TEMPLATE_EXAMPLES: ReadonlyArray<{ title: string; html: string }> = [
  { title: "Who and where", html: "<div style=\"padding:6px 12px\">{if $user.signedIn}<b>{$user.username}</b>{else}{$session.username|default:'Host'}{/if}{ifset $session.room} · <span style=\"opacity:.7\">{$session.room}</span>{/ifset}</div>" },
  { title: "Room status", html: "<div style=\"display:flex;gap:6px;align-items:center;padding:4px 12px\">{icon radio} {if $session.connected}{$room.peers} {_'menu.peers'}{else}offline{/if}</div>" },
  { title: "A button that opens a panel", html: "<button data-action=\"panel:settings\" style=\"margin:4px 12px;padding:4px 10px;border-radius:8px\">{icon settings} {_'menu.settings'}</button>" },
  { title: "Clock", html: "<div style=\"text-align:right;padding:2px 12px;font-size:11px;opacity:.6\">{$now|date:'H:i'}</div>" },
  { title: "People in the room", html: "<ul style=\"margin:0 12px;padding-left:16px\">{foreach $room.people as $name}<li>{$name}</li>{else}<li>—</li>{/foreach}</ul>" },
];

/** Stand-in values for the builder's preview. */
export function sampleTemplateVars(now = Date.now()): TemplateVars {
  return {
    app: { name: "M5cet", version: "4.0.0", build: "preview", lang: "cs", online: true },
    global: { server: "chat.example.org", time: now },
    now,
    user: { signedIn: true, username: "bystry-sokol-7k3q", nickname: "Alice", avatar: "A", groups: ["user"], keyVerified: true },
    session: { username: "bystry-sokol-7k3q", current_username: "bystry-sokol-7k3q", nickname: "Alice", connected: true, status: "joined", room: "tym-brno", mode: "server", server: "chat.example.org", peers: 2, rtt: 42, since: now - 12 * 60_000 },
    room: { name: "tym-brno", peers: 2, people: ["Bob", "Carol"] },
    connection: { active: "Tým Brno", default: "Tým Brno", saved: 3 },
    settings: { theme: "ios", tone: "light", accent: "default", lang: "cs", notifications: true, editMode: false, retention: "server" },
  };
}
