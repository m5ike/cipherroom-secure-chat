// Expressions and text templates of the Android screens (6.0). One small,
// side-effect free language, implemented three times with shared test
// vectors (test/fixtures/android-expr.json): here (validation, previews in
// tests), in the console's preview (admin-ui/public/android-kit.js) and in
// the app (android/…/ui/Expr.java).
//
// Expressions (`if`, `each`, props starting with "="):
//   $path.to.value  $list[0]  'text' "text"  12  1.5  true false null
//   !  -  * / %  + -  < > <= >=  == != (=== !== the same: strict)  &&  ||  a ? b : c  ( )
//   _('i18n.key')   — a translated string
// Templates (text): literal text with {$path}, {$path|filter:arg|filter},
// {_'key'} and {=expression}; "{{" is a literal "{".
// Filters: upper lower trim truncate:n default:'x' count date time datetime size.

export type Scope = Record<string, unknown>;
export type Translate = (key: string) => string;

type Node =
  | { t: "lit"; v: unknown }
  | { t: "var"; name: string }
  | { t: "get"; obj: Node; key: Node }
  | { t: "un"; op: "!" | "-"; a: Node }
  | { t: "bin"; op: string; a: Node; b: Node }
  | { t: "and" | "or"; a: Node; b: Node }
  | { t: "if"; c: Node; a: Node; b: Node }
  | { t: "tr"; key: string };

export const EXPR_MAX = 400;

type Tok = { k: "num" | "str" | "id" | "var" | "op" | "end"; v: string; at: number };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i))!;
      out.push({ k: "num", v: m[0], at: i }); i += m[0].length; continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1; let s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) { s += src[j + 1]; j += 2; continue; }
        s += src[j++];
      }
      if (j >= src.length) throw new Error(`unterminated string at ${i}`);
      out.push({ k: "str", v: s, at: i }); i = j + 1; continue;
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(src.slice(i));
      if (!m) throw new Error(`bad variable at ${i}`);
      out.push({ k: "var", v: m[1], at: i }); i += m[0].length; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ k: "id", v: m[0], at: i }); i += m[0].length; continue;
    }
    const three = src.slice(i, i + 3);
    const two = src.slice(i, i + 2);
    if (three === "===" || three === "!==") { out.push({ k: "op", v: three, at: i }); i += 3; continue; }
    if (["==", "!=", "<=", ">=", "&&", "||"].includes(two)) { out.push({ k: "op", v: two, at: i }); i += 2; continue; }
    if ("!+-*/%<>?:().[],".includes(c)) { out.push({ k: "op", v: c, at: i }); i++; continue; }
    throw new Error(`unexpected "${c}" at ${i}`);
  }
  out.push({ k: "end", v: "", at: src.length });
  return out;
}

export function parseExpr(src: string): Node {
  if (src.length > EXPR_MAX) throw new Error(`expression longer than ${EXPR_MAX} characters`);
  const toks = lex(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek().k === "op" && peek().v === v;
  const expect = (v: string) => { if (!isOp(v)) throw new Error(`expected "${v}" at ${peek().at}`); p++; };
  let depth = 0;

  const expr = (): Node => {
    if (++depth > 40) throw new Error("expression nested too deep");
    const n = ternary();
    depth--;
    return n;
  };
  const ternary = (): Node => {
    const c = or();
    if (isOp("?")) { p++; const a = expr(); expect(":"); const b = expr(); return { t: "if", c, a, b }; }
    return c;
  };
  const or = (): Node => { let a = and(); while (isOp("||")) { p++; a = { t: "or", a, b: and() }; } return a; };
  const and = (): Node => { let a = eq(); while (isOp("&&")) { p++; a = { t: "and", a, b: eq() }; } return a; };
  const eq = (): Node => {
    let a = rel();
    while (["==", "!=", "===", "!=="].some(isOp)) { const op = toks[p++].v.slice(0, 2); a = { t: "bin", op, a, b: rel() }; }
    return a;
  };
  const rel = (): Node => {
    let a = add();
    while (["<", ">", "<=", ">="].some(isOp)) { const op = toks[p++].v; a = { t: "bin", op, a, b: add() }; }
    return a;
  };
  const add = (): Node => {
    let a = mul();
    while (isOp("+") || isOp("-")) { const op = toks[p++].v; a = { t: "bin", op, a, b: mul() }; }
    return a;
  };
  const mul = (): Node => {
    let a = unary();
    while (isOp("*") || isOp("/") || isOp("%")) { const op = toks[p++].v; a = { t: "bin", op, a, b: unary() }; }
    return a;
  };
  const unary = (): Node => {
    if (isOp("!")) { p++; return { t: "un", op: "!", a: unary() }; }
    if (isOp("-")) { p++; return { t: "un", op: "-", a: unary() }; }
    return postfix();
  };
  const postfix = (): Node => {
    let n = primary();
    for (;;) {
      if (isOp(".")) {
        p++;
        const id = peek();
        if (id.k !== "id") throw new Error(`expected a name after "." at ${id.at}`);
        p++;
        n = { t: "get", obj: n, key: { t: "lit", v: id.v } };
      } else if (isOp("[")) {
        p++;
        const key = expr();
        expect("]");
        n = { t: "get", obj: n, key };
      } else return n;
    }
  };
  const primary = (): Node => {
    const tok = peek();
    if (tok.k === "num") { p++; return { t: "lit", v: Number(tok.v) }; }
    if (tok.k === "str") { p++; return { t: "lit", v: tok.v }; }
    if (tok.k === "var") { p++; return { t: "var", name: tok.v }; }
    if (tok.k === "id") {
      p++;
      if (tok.v === "true") return { t: "lit", v: true };
      if (tok.v === "false") return { t: "lit", v: false };
      if (tok.v === "null") return { t: "lit", v: null };
      if (tok.v === "_" && isOp("(")) {
        p++;
        const key = peek();
        if (key.k !== "str") throw new Error(`_() needs a quoted key at ${key.at}`);
        p++;
        expect(")");
        return { t: "tr", key: key.v };
      }
      throw new Error(`unknown name "${tok.v}" at ${tok.at} (variables start with $)`);
    }
    if (isOp("(")) { p++; const n = expr(); expect(")"); return n; }
    throw new Error(tok.k === "end" ? "unexpected end of the expression" : `unexpected "${tok.v}" at ${tok.at}`);
  };

  const node = expr();
  if (peek().k !== "end") throw new Error(`unexpected "${peek().v}" at ${peek().at}`);
  return node;
}

export const truthy = (v: unknown): boolean => !(v === null || v === undefined || v === false || v === 0 || v === "" || (typeof v === "number" && Number.isNaN(v)));

function member(obj: unknown, key: unknown): unknown {
  if (obj === null || obj === undefined) return null;
  if (typeof key === "number" || (typeof key === "string" && /^\d+$/.test(key))) {
    const i = Number(key);
    if (Array.isArray(obj)) return i >= 0 && i < obj.length ? obj[i] ?? null : null;
    if (typeof obj === "string") return i >= 0 && i < obj.length ? obj[i] : null;
  }
  if (typeof key !== "string") return null;
  if (key === "length" && (Array.isArray(obj) || typeof obj === "string")) return obj.length;
  if (typeof obj === "object" && !Array.isArray(obj) && Object.prototype.hasOwnProperty.call(obj, key)) {
    const v = (obj as Record<string, unknown>)[key];
    return v === undefined ? null : v;
  }
  return null;
}

const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : v === null || v === undefined ? 0 : Number(v));

/** Equality without coercion; numbers compare by value, arrays/objects by identity. */
const same = (a: unknown, b: unknown): boolean => (a ?? null) === (b ?? null);

export function evalNode(n: Node, scope: Scope, tr: Translate = (k) => k): unknown {
  switch (n.t) {
    case "lit": return n.v;
    case "var": return Object.prototype.hasOwnProperty.call(scope, n.name) ? (scope[n.name] ?? null) : null;
    case "get": return member(evalNode(n.obj, scope, tr), evalNode(n.key, scope, tr));
    case "tr": return tr(n.key);
    case "un": return n.op === "!" ? !truthy(evalNode(n.a, scope, tr)) : -num(evalNode(n.a, scope, tr));
    case "and": { const a = evalNode(n.a, scope, tr); return truthy(a) ? evalNode(n.b, scope, tr) : a; }
    case "or": { const a = evalNode(n.a, scope, tr); return truthy(a) ? a : evalNode(n.b, scope, tr); }
    case "if": return truthy(evalNode(n.c, scope, tr)) ? evalNode(n.a, scope, tr) : evalNode(n.b, scope, tr);
    case "bin": {
      const a = evalNode(n.a, scope, tr);
      const b = evalNode(n.b, scope, tr);
      switch (n.op) {
        case "==": return same(a, b);
        case "!=": return !same(a, b);
        case "+": return typeof a === "string" || typeof b === "string" ? toText(a) + toText(b) : num(a) + num(b);
        case "-": return num(a) - num(b);
        case "*": return num(a) * num(b);
        case "/": return num(b) === 0 ? null : num(a) / num(b);
        case "%": return num(b) === 0 ? null : num(a) % num(b);
        case "<": case ">": case "<=": case ">=": {
          const [x, y] = typeof a === "string" && typeof b === "string" ? [a, b] : [num(a), num(b)];
          return n.op === "<" ? x < y : n.op === ">" ? x > y : n.op === "<=" ? x <= y : x >= y;
        }
      }
      return null;
    }
  }
}

export function evalExpr(src: string, scope: Scope, tr?: Translate): unknown {
  return evalNode(parseExpr(src), scope, tr);
}

/** How a value reads in text: integers without ".0", no "null". */
export function toText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? (Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6)) : "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(toText).join(", ");
  return "";
}

/* --------------------------------------------------------------- templates */

type Filter = { name: string; arg: string | null };
type Part = { lit: string } | { expr: Node; filters: Filter[] };

export const FILTERS = ["upper", "lower", "trim", "truncate", "default", "count", "date", "time", "datetime", "size"] as const;

function parseFilters(chain: string): Filter[] {
  const out: Filter[] = [];
  for (const raw of chain.split("|").slice(1)) {
    const m = /^\s*([a-z]+)(?::\s*(?:'([^']*)'|"([^"]*)"|(-?\d+)))?\s*$/.exec(raw);
    if (!m || !(FILTERS as readonly string[]).includes(m[1])) throw new Error(`unknown filter "${raw.trim()}"`);
    out.push({ name: m[1], arg: m[2] ?? m[3] ?? m[4] ?? null });
  }
  return out;
}

export function parseTemplate(src: string): Part[] {
  const parts: Part[] = [];
  let lit = "";
  let i = 0;
  while (i < src.length) {
    if (src[i] === "{" && src[i + 1] === "{") { lit += "{"; i += 2; continue; }
    if (src[i] !== "{") { lit += src[i++]; continue; }
    const end = src.indexOf("}", i);
    if (end < 0) throw new Error(`unclosed "{" at ${i}`);
    const body = src.slice(i + 1, end).trim();
    if (lit) { parts.push({ lit }); lit = ""; }
    if (body.startsWith("_'") || body.startsWith('_"')) {
      const q = body[1];
      const close = body.indexOf(q, 2);
      if (close < 0) throw new Error(`unclosed translation at ${i}`);
      parts.push({ expr: { t: "tr", key: body.slice(2, close) }, filters: parseFilters(body.slice(close + 1)) });
    } else if (body.startsWith("=")) {
      parts.push({ expr: parseExpr(body.slice(1)), filters: [] });
    } else if (body.startsWith("$")) {
      const bar = body.indexOf("|");
      const head = bar < 0 ? body : body.slice(0, bar);
      if (!/^\$[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*|\.\d+)*$/.test(head.trim())) throw new Error(`bad placeholder "{${body}}"`);
      parts.push({ expr: parseExpr(head.trim().replace(/\.(\d+)/g, "[$1]")), filters: bar < 0 ? [] : parseFilters(body.slice(bar)) });
    } else {
      throw new Error(`bad placeholder "{${body}}" (use {$var}, {_'key'} or {=expression})`);
    }
    i = end + 1;
  }
  if (lit) parts.push({ lit });
  return parts;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

function applyFilter(v: unknown, f: Filter): unknown {
  switch (f.name) {
    case "upper": return toText(v).toUpperCase();
    case "lower": return toText(v).toLowerCase();
    case "trim": return toText(v).trim();
    case "truncate": { const n = Math.max(1, Number(f.arg ?? 40)); const s = toText(v); return s.length > n ? `${s.slice(0, n - 1)}…` : s; }
    case "default": return truthy(v) ? v : (f.arg ?? "");
    case "count": return Array.isArray(v) ? v.length : typeof v === "string" ? v.length : 0;
    case "date": case "time": case "datetime": {
      if (typeof v !== "number" || !Number.isFinite(v)) return "";
      const d = new Date(v);
      const date = `${d.getDate()}. ${d.getMonth() + 1}. ${d.getFullYear()}`;
      const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
      return f.name === "date" ? date : f.name === "time" ? time : `${date} ${time}`;
    }
    case "size": {
      const n = num(v);
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${Math.round(n / 102.4) / 10} kB`;
      if (n < 1024 * 1024 * 1024) return `${Math.round(n / 104857.6) / 10} MB`;
      return `${Math.round(n / 107374182.4) / 10} GB`;
    }
  }
  return v;
}

export function renderParts(parts: Part[], scope: Scope, tr: Translate = (k) => k): string {
  let out = "";
  for (const part of parts) {
    if ("lit" in part) { out += part.lit; continue; }
    let v = evalNode(part.expr, scope, tr);
    for (const f of part.filters) v = applyFilter(v, f);
    out += toText(v);
  }
  return out;
}

export function renderTemplate(src: string, scope: Scope, tr?: Translate): string {
  return renderParts(parseTemplate(src), scope, tr);
}

/** Null when the source is valid; otherwise why not. */
export function checkExpr(src: string): string | null {
  try { parseExpr(src); return null; } catch (err) { return (err as Error).message; }
}
export function checkTemplate(src: string): string | null {
  try { parseTemplate(src); return null; } catch (err) { return (err as Error).message; }
}
