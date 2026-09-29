// The Android screens' expression and template language for the console's
// live preview (6.0) — the same language as server/android/expr.ts and the
// app's Expr.java, checked with the same vectors (test/fixtures/android-expr.json,
// test/android-console.test.ts). No eval, no Function: a small parser.

(function (root) {
  "use strict";

  const MAX = 400;

  function lex(src) {
    const out = [];
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
      if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] || ""))) {
        const m = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i));
        out.push({ k: "num", v: m[0], at: i }); i += m[0].length; continue;
      }
      if (c === "'" || c === '"') {
        let j = i + 1; let s = "";
        while (j < src.length && src[j] !== c) { if (src[j] === "\\" && j + 1 < src.length) { s += src[j + 1]; j += 2; continue; } s += src[j++]; }
        if (j >= src.length) throw new Error(`unterminated string at ${i}`);
        out.push({ k: "str", v: s, at: i }); i = j + 1; continue;
      }
      if (c === "$") {
        const m = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(src.slice(i));
        if (!m) throw new Error(`bad variable at ${i}`);
        out.push({ k: "var", v: m[1], at: i }); i += m[0].length; continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
        out.push({ k: "id", v: m[0], at: i }); i += m[0].length; continue;
      }
      const three = src.slice(i, i + 3), two = src.slice(i, i + 2);
      if (three === "===" || three === "!==") { out.push({ k: "op", v: three, at: i }); i += 3; continue; }
      if (["==", "!=", "<=", ">=", "&&", "||"].includes(two)) { out.push({ k: "op", v: two, at: i }); i += 2; continue; }
      if ("!+-*/%<>?:().[],".includes(c)) { out.push({ k: "op", v: c, at: i }); i++; continue; }
      throw new Error(`unexpected "${c}" at ${i}`);
    }
    out.push({ k: "end", v: "", at: src.length });
    return out;
  }

  const cache = new Map();

  function parse(src) {
    if (cache.has(src)) return cache.get(src);
    if (src.length > MAX) throw new Error(`expression longer than ${MAX} characters`);
    const t = lex(src);
    let p = 0, depth = 0;
    const peek = () => t[p];
    const is = (v) => peek().k === "op" && peek().v === v;
    const expect = (v) => { if (!is(v)) throw new Error(`expected "${v}" at ${peek().at}`); p++; };
    const expr = () => { if (++depth > 40) throw new Error("expression nested too deep"); const n = ternary(); depth--; return n; };
    const ternary = () => { const c = or(); if (is("?")) { p++; const a = expr(); expect(":"); const b = expr(); return { t: "if", c, a, b }; } return c; };
    const or = () => { let a = and(); while (is("||")) { p++; a = { t: "or", a, b: and() }; } return a; };
    const and = () => { let a = eq(); while (is("&&")) { p++; a = { t: "and", a, b: eq() }; } return a; };
    const eq = () => { let a = rel(); while (["==", "!=", "===", "!=="].some(is)) { const op = t[p++].v.slice(0, 2); a = { t: "bin", op, a, b: rel() }; } return a; };
    const rel = () => { let a = add(); while (["<", ">", "<=", ">="].some(is)) { const op = t[p++].v; a = { t: "bin", op, a, b: add() }; } return a; };
    const add = () => { let a = mul(); while (is("+") || is("-")) { const op = t[p++].v; a = { t: "bin", op, a, b: mul() }; } return a; };
    const mul = () => { let a = unary(); while (is("*") || is("/") || is("%")) { const op = t[p++].v; a = { t: "bin", op, a, b: unary() }; } return a; };
    const unary = () => { if (is("!")) { p++; return { t: "un", op: "!", a: unary() }; } if (is("-")) { p++; return { t: "un", op: "-", a: unary() }; } return postfix(); };
    const postfix = () => {
      let n = primary();
      for (;;) {
        if (is(".")) { p++; const id = peek(); if (id.k !== "id") throw new Error(`expected a name after "." at ${id.at}`); p++; n = { t: "get", obj: n, key: { t: "lit", v: id.v } }; }
        else if (is("[")) { p++; const key = expr(); expect("]"); n = { t: "get", obj: n, key }; }
        else return n;
      }
    };
    const primary = () => {
      const k = peek();
      if (k.k === "num") { p++; return { t: "lit", v: Number(k.v) }; }
      if (k.k === "str") { p++; return { t: "lit", v: k.v }; }
      if (k.k === "var") { p++; return { t: "var", name: k.v }; }
      if (k.k === "id") {
        p++;
        if (k.v === "true") return { t: "lit", v: true };
        if (k.v === "false") return { t: "lit", v: false };
        if (k.v === "null") return { t: "lit", v: null };
        if (k.v === "_" && is("(")) { p++; const key = peek(); if (key.k !== "str") throw new Error(`_() needs a quoted key at ${key.at}`); p++; expect(")"); return { t: "tr", key: key.v }; }
        throw new Error(`unknown name "${k.v}" at ${k.at} (variables start with $)`);
      }
      if (is("(")) { p++; const n = expr(); expect(")"); return n; }
      throw new Error(k.k === "end" ? "unexpected end of the expression" : `unexpected "${k.v}" at ${k.at}`);
    };
    const node = expr();
    if (peek().k !== "end") throw new Error(`unexpected "${peek().v}" at ${peek().at}`);
    if (cache.size > 2000) cache.clear();
    cache.set(src, node);
    return node;
  }

  const truthy = (v) => !(v === null || v === undefined || v === false || v === 0 || v === "" || (typeof v === "number" && Number.isNaN(v)));
  const num = (v) => (typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : v === null || v === undefined ? 0 : Number(v));
  const same = (a, b) => (a === undefined ? null : a) === (b === undefined ? null : b);

  function member(obj, key) {
    if (obj === null || obj === undefined) return null;
    if (typeof key === "number" || (typeof key === "string" && /^\d+$/.test(key))) {
      const i = Number(key);
      if (Array.isArray(obj)) return i >= 0 && i < obj.length ? (obj[i] === undefined ? null : obj[i]) : null;
      if (typeof obj === "string") return i >= 0 && i < obj.length ? obj[i] : null;
    }
    if (typeof key !== "string") return null;
    if (key === "length" && (Array.isArray(obj) || typeof obj === "string")) return obj.length;
    if (typeof obj === "object" && !Array.isArray(obj) && Object.prototype.hasOwnProperty.call(obj, key)) return obj[key] === undefined ? null : obj[key];
    return null;
  }

  function toText(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "number") return Number.isFinite(v) ? (Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6)) : "";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return v.map(toText).join(", ");
    return "";
  }

  function evalNode(n, scope, tr) {
    switch (n.t) {
      case "lit": return n.v;
      case "var": return Object.prototype.hasOwnProperty.call(scope, n.name) ? (scope[n.name] === undefined ? null : scope[n.name]) : null;
      case "get": return member(evalNode(n.obj, scope, tr), evalNode(n.key, scope, tr));
      case "tr": return tr(n.key);
      case "un": return n.op === "!" ? !truthy(evalNode(n.a, scope, tr)) : -num(evalNode(n.a, scope, tr));
      case "and": { const a = evalNode(n.a, scope, tr); return truthy(a) ? evalNode(n.b, scope, tr) : a; }
      case "or": { const a = evalNode(n.a, scope, tr); return truthy(a) ? a : evalNode(n.b, scope, tr); }
      case "if": return truthy(evalNode(n.c, scope, tr)) ? evalNode(n.a, scope, tr) : evalNode(n.b, scope, tr);
      case "bin": {
        const a = evalNode(n.a, scope, tr), b = evalNode(n.b, scope, tr);
        switch (n.op) {
          case "==": return same(a, b);
          case "!=": return !same(a, b);
          case "+": return typeof a === "string" || typeof b === "string" ? toText(a) + toText(b) : num(a) + num(b);
          case "-": return num(a) - num(b);
          case "*": return num(a) * num(b);
          case "/": return num(b) === 0 ? null : num(a) / num(b);
          case "%": return num(b) === 0 ? null : num(a) % num(b);
          default: {
            const [x, y] = typeof a === "string" && typeof b === "string" ? [a, b] : [num(a), num(b)];
            return n.op === "<" ? x < y : n.op === ">" ? x > y : n.op === "<=" ? x <= y : x >= y;
          }
        }
      }
    }
    return null;
  }

  const FILTERS = ["upper", "lower", "trim", "truncate", "default", "count", "date", "time", "datetime", "size"];

  function parseFilters(chain) {
    const out = [];
    for (const raw of chain.split("|").slice(1)) {
      const m = /^\s*([a-z]+)(?::\s*(?:'([^']*)'|"([^"]*)"|(-?\d+)))?\s*$/.exec(raw);
      if (!m || !FILTERS.includes(m[1])) throw new Error(`unknown filter "${raw.trim()}"`);
      out.push({ name: m[1], arg: m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : null });
    }
    return out;
  }

  function parseTemplate(src) {
    const key = `t:${src}`;
    if (cache.has(key)) return cache.get(key);
    const parts = [];
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
        parts.push({ expr: parse(body.slice(1)), filters: [] });
      } else if (body.startsWith("$")) {
        const bar = body.indexOf("|");
        const head = (bar < 0 ? body : body.slice(0, bar)).trim();
        if (!/^\$[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*|\.\d+)*$/.test(head)) throw new Error(`bad placeholder "{${body}}"`);
        parts.push({ expr: parse(head.replace(/\.(\d+)/g, "[$1]")), filters: bar < 0 ? [] : parseFilters(body.slice(bar)) });
      } else {
        throw new Error(`bad placeholder "{${body}}" (use {$var}, {_'key'} or {=expression})`);
      }
      i = end + 1;
    }
    if (lit) parts.push({ lit });
    cache.set(key, parts);
    return parts;
  }

  const pad2 = (n) => String(n).padStart(2, "0");

  function applyFilter(v, f) {
    switch (f.name) {
      case "upper": return toText(v).toUpperCase();
      case "lower": return toText(v).toLowerCase();
      case "trim": return toText(v).trim();
      case "truncate": { const n = Math.max(1, Number(f.arg === null ? 40 : f.arg)); const s = toText(v); return s.length > n ? `${s.slice(0, n - 1)}…` : s; }
      case "default": return truthy(v) ? v : (f.arg === null ? "" : f.arg);
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
        if (n < 1024) return `${toText(n)} B`;
        if (n < 1024 * 1024) return `${toText(Math.round(n / 102.4) / 10)} kB`;
        if (n < 1024 * 1024 * 1024) return `${toText(Math.round(n / 104857.6) / 10)} MB`;
        return `${toText(Math.round(n / 107374182.4) / 10)} GB`;
      }
    }
    return v;
  }

  const api = {
    truthy,
    toText,
    eval(src, scope, tr = (k) => k) { return evalNode(parse(src), scope, tr); },
    render(src, scope, tr = (k) => k) {
      if (src === null || src === undefined) return "";
      if (!String(src).includes("{")) return String(src);
      let out = "";
      for (const part of parseTemplate(String(src))) {
        if ("lit" in part) { out += part.lit; continue; }
        let v = evalNode(part.expr, scope, tr);
        for (const f of part.filters) v = applyFilter(v, f);
        out += toText(v);
      }
      return out;
    },
    /** "=expression" → its value, anything else → the rendered template. */
    value(src, scope, tr) { return typeof src === "string" && src.startsWith("=") ? api.eval(src.slice(1), scope, tr) : typeof src === "string" ? api.render(src, scope, tr) : src; },
    check(src) { try { parse(src); return null; } catch (e) { return e.message; } },
    checkTemplate(src) { try { parseTemplate(src); return null; } catch (e) { return e.message; } },
  };

  root.M5AndroidExpr = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
