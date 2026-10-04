// The TSA formula language (6.9): what a Condition, a While, a Set, a Formula
// and a For's bounds compute — over the node's inputs (IN1 … IN100), the
// TSA's variables ($name) and the call (call.from, call.to, call.did,
// call.direction, call.provider, call.id).
//
//   IN1 == IN2          (IN1 == 0 and IN2 > 2)        contains(IN1, "yes")
//   $attempts + 1       len(digits(IN1)) >= 4          get(IN1, "customer.name")
//
// A hand-written tokenizer, a recursive-descent parser and a tree walker —
// never eval / Function, no regular expressions built from the input, no
// property access but the few named here (no prototype can be reached).
// Bounded: the source length (TSA_LIMITS.formulaLength), the nesting depth,
// the number of AST nodes, and every string a formula builds. Evaluation is
// total: a type mismatch gives null (or false), never an exception.
//
// Types and coercion
//   values are numbers, strings, true / false, null — and the objects / lists
//   an HTTP answer or a function returned (get() reads into them)
//   == != < <= > >=   numeric when both sides look numeric ("007" == 7),
//                     else as text; null equals null and ""
//   + - * / %         numbers; + joins text when a side is text that does not
//                     look numeric ("Code " + IN1); a result that is not a
//                     finite number (1 / 0) is null
//   and or not        (also && || !) on truthiness: false, null, 0, "", "0",
//                     "false" and an empty list are false; they give true / false
//   precedence        or < and < not < comparison < + - < * / % < unary - +

import { TSA_LIMITS } from "./types";

/* ------------------------------------------------------------------ AST */

export const CALL_PROPS = ["from", "to", "did", "direction", "provider", "id"] as const;
export type CallProp = typeof CALL_PROPS[number];

export type FNode =
  | { k: "num"; v: number; pos: number }
  | { k: "str"; v: string; pos: number }
  | { k: "lit"; v: boolean | null; pos: number }
  | { k: "in"; n: number; pos: number }
  | { k: "var"; name: string; pos: number }
  | { k: "call"; prop: CallProp; pos: number }
  | { k: "fn"; name: string; args: FNode[]; pos: number }
  | { k: "un"; op: "-" | "+" | "not"; a: FNode; pos: number }
  | { k: "bin"; op: BinOp; a: FNode; b: FNode; pos: number };

type BinOp = "or" | "and" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "+" | "-" | "*" | "/" | "%";

/** A problem with a formula: what and where (0-based character index). */
export type FormulaError = { message: string; pos: number };

export type ParseResult = { ok: true; ast: FNode } | { ok: false; errors: FormulaError[] };

export const FORMULA_LIMITS = { depth: 48, nodes: 400, string: 16_000, args: 20 } as const;

/** The functions, with how many arguments each takes. */
export const FORMULA_FUNCTIONS: Record<string, { min: number; max: number; help: string }> = {
  len: { min: 1, max: 1, help: "len(x) — characters of a text, items of a list" },
  int: { min: 1, max: 1, help: "int(x) — a whole number (12.7 → 12, \"12abc\" → 12)" },
  num: { min: 1, max: 1, help: "num(x) — a number or null (\"1,5\" → 1.5)" },
  str: { min: 1, max: 1, help: "str(x) — as text" },
  lower: { min: 1, max: 1, help: "lower(x)" },
  upper: { min: 1, max: 1, help: "upper(x)" },
  trim: { min: 1, max: 1, help: "trim(x) — without spaces at the ends" },
  contains: { min: 2, max: 2, help: "contains(text, part) — also an item of a list" },
  startswith: { min: 2, max: 2, help: "startswith(text, prefix)" },
  endswith: { min: 2, max: 2, help: "endswith(text, suffix)" },
  digits: { min: 1, max: 1, help: "digits(x) — only 0-9 (\"+420 603\" → \"420603\")" },
  substr: { min: 2, max: 3, help: "substr(text, start, length?) — start from 0; negative counts from the end" },
  replace: { min: 3, max: 3, help: "replace(text, find, with) — every occurrence, plain text (no patterns)" },
  min: { min: 1, max: FORMULA_LIMITS.args, help: "min(a, b, …)" },
  max: { min: 1, max: FORMULA_LIMITS.args, help: "max(a, b, …)" },
  abs: { min: 1, max: 1, help: "abs(x)" },
  round: { min: 1, max: 2, help: "round(x, places?)" },
  now: { min: 0, max: 0, help: "now() — Unix time in seconds" },
  hour: { min: 0, max: 1, help: "hour(timezone?) — 0-23 (default Europe/Prague, TSA_TIMEZONE)" },
  weekday: { min: 0, max: 1, help: "weekday(timezone?) — 1 Monday … 7 Sunday" },
  random: { min: 0, max: 2, help: "random() 0…1, random(n) 0…n-1, random(a, b) a…b" },
  get: { min: 2, max: 2, help: "get(object, \"a.b.0\") — a value inside an HTTP answer's JSON or a function's result" },
};

/* ------------------------------------------------------------ tokenizer */

type Tok =
  | { t: "num"; v: number; pos: number }
  | { t: "str"; v: string; pos: number }
  | { t: "id"; v: string; pos: number }
  | { t: "var"; v: string; pos: number }
  | { t: "op"; v: string; pos: number }
  | { t: "eof"; pos: number };

class FormulaSyntaxError extends Error {
  constructor(message: string, readonly pos: number) { super(message); }
}

const isDigit = (c: string) => c >= "0" && c <= "9";
const isIdStart = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
const isIdChar = (c: string) => isIdStart(c) || isDigit(c);
const OPS2 = new Set(["==", "!=", "<=", ">=", "&&", "||"]);
const OPS1 = new Set(["+", "-", "*", "/", "%", "<", ">", "!", "(", ")", ",", "."]);

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    const pos = i;
    if (isDigit(c) || (c === "." && isDigit(src[i + 1] ?? ""))) {
      let j = i;
      while (j < src.length && isDigit(src[j])) j++;
      if (src[j] === "." && isDigit(src[j + 1] ?? "")) { j++; while (j < src.length && isDigit(src[j])) j++; }
      if ((src[j] === "e" || src[j] === "E") && (isDigit(src[j + 1] ?? "") || ((src[j + 1] === "+" || src[j + 1] === "-") && isDigit(src[j + 2] ?? "")))) {
        j += 2;
        while (j < src.length && isDigit(src[j])) j++;
      }
      if (j - i > 64) throw new FormulaSyntaxError("number too long", pos);
      if (isIdStart(src[j] ?? "")) throw new FormulaSyntaxError(`unexpected "${src[j]}" after a number`, j);
      out.push({ t: "num", v: Number(src.slice(i, j)), pos });
      i = j;
      continue;
    }
    if (c === "\"" || c === "'") {
      let j = i + 1;
      let s = "";
      for (;;) {
        if (j >= src.length) throw new FormulaSyntaxError("text without its closing quote", pos);
        const d = src[j];
        if (d === c) { j++; break; }
        if (d === "\\") {
          const e = src[j + 1];
          if (e === undefined) throw new FormulaSyntaxError("text without its closing quote", pos);
          s += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e;
          j += 2;
          continue;
        }
        s += d;
        j++;
      }
      out.push({ t: "str", v: s, pos });
      i = j;
      continue;
    }
    if (c === "$") {
      let j = i + 1;
      if (!isIdStart(src[j] ?? "")) throw new FormulaSyntaxError("a variable is $ and a name ($attempts)", pos);
      while (j < src.length && isIdChar(src[j])) j++;
      if (j - i - 1 > 32) throw new FormulaSyntaxError("variable name too long (32 characters at most)", pos);
      out.push({ t: "var", v: src.slice(i + 1, j), pos });
      i = j;
      continue;
    }
    if (isIdStart(c)) {
      let j = i;
      while (j < src.length && isIdChar(src[j])) j++;
      if (j - i > 32) throw new FormulaSyntaxError("name too long", pos);
      out.push({ t: "id", v: src.slice(i, j), pos });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (OPS2.has(two)) { out.push({ t: "op", v: two, pos }); i += 2; continue; }
    if (c === "=") throw new FormulaSyntaxError("use == to compare (= alone is not an operator)", pos);
    if (c === "&" || c === "|") throw new FormulaSyntaxError(`use ${c}${c} (or the word ${c === "&" ? "and" : "or"})`, pos);
    if (OPS1.has(c)) { out.push({ t: "op", v: c, pos }); i++; continue; }
    throw new FormulaSyntaxError(`unexpected character "${c}"`, pos);
  }
  out.push({ t: "eof", pos: src.length });
  return out;
}

/* --------------------------------------------------------------- parser */

class Parser {
  private i = 0;
  private depth = 0;
  private count = 0;
  constructor(private readonly toks: Tok[]) {}

  private peek(): Tok { return this.toks[this.i]; }
  private next(): Tok { return this.toks[this.i++]; }
  private isOp(v: string): boolean { const t = this.peek(); return t.t === "op" && t.v === v; }
  private isWord(...words: string[]): boolean { const t = this.peek(); return t.t === "id" && words.includes(t.v.toLowerCase()); }
  private node<T extends FNode>(n: T): T {
    if (++this.count > FORMULA_LIMITS.nodes) throw new FormulaSyntaxError(`the formula is too complex (more than ${FORMULA_LIMITS.nodes} parts)`, n.pos);
    return n;
  }
  private enter(pos: number): void {
    if (++this.depth > FORMULA_LIMITS.depth) throw new FormulaSyntaxError(`nested too deeply (${FORMULA_LIMITS.depth} levels at most)`, pos);
  }
  private leave(): void { this.depth--; }

  parse(): FNode {
    if (this.peek().t === "eof") throw new FormulaSyntaxError("the formula is empty", 0);
    const e = this.or();
    const t = this.peek();
    if (t.t !== "eof") throw new FormulaSyntaxError(`unexpected ${describe(t)} — an operator (and, or, ==, +…) is missing?`, t.pos);
    return e;
  }

  private or(): FNode {
    let a = this.and();
    while (this.isOp("||") || this.isWord("or")) {
      const pos = this.next().pos;
      a = this.node({ k: "bin", op: "or", a, b: this.and(), pos });
    }
    return a;
  }

  private and(): FNode {
    let a = this.not();
    while (this.isOp("&&") || this.isWord("and")) {
      const pos = this.next().pos;
      a = this.node({ k: "bin", op: "and", a, b: this.not(), pos });
    }
    return a;
  }

  private not(): FNode {
    if (this.isOp("!") || this.isWord("not")) {
      const pos = this.next().pos;
      this.enter(pos);
      const a = this.not();
      this.leave();
      return this.node({ k: "un", op: "not", a, pos });
    }
    return this.comparison();
  }

  private comparison(): FNode {
    const a = this.additive();
    const t = this.peek();
    if (t.t === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(t.v)) {
      this.next();
      const b = this.additive();
      const u = this.peek();
      if (u.t === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(u.v)) throw new FormulaSyntaxError("comparisons cannot be chained — join them with and", u.pos);
      return this.node({ k: "bin", op: t.v as BinOp, a, b, pos: t.pos });
    }
    return a;
  }

  private additive(): FNode {
    let a = this.multiplicative();
    for (;;) {
      const t = this.peek();
      if (t.t === "op" && (t.v === "+" || t.v === "-")) { this.next(); a = this.node({ k: "bin", op: t.v, a, b: this.multiplicative(), pos: t.pos }); continue; }
      return a;
    }
  }

  private multiplicative(): FNode {
    let a = this.unary();
    for (;;) {
      const t = this.peek();
      if (t.t === "op" && (t.v === "*" || t.v === "/" || t.v === "%")) { this.next(); a = this.node({ k: "bin", op: t.v, a, b: this.unary(), pos: t.pos }); continue; }
      return a;
    }
  }

  private unary(): FNode {
    const t = this.peek();
    if (t.t === "op" && (t.v === "-" || t.v === "+")) {
      this.next();
      this.enter(t.pos);
      const a = this.unary();
      this.leave();
      return this.node({ k: "un", op: t.v, a, pos: t.pos });
    }
    return this.primary();
  }

  private primary(): FNode {
    const t = this.next();
    if (t.t === "num") return this.node({ k: "num", v: t.v, pos: t.pos });
    if (t.t === "str") return this.node({ k: "str", v: t.v, pos: t.pos });
    if (t.t === "var") return this.node({ k: "var", name: t.v, pos: t.pos });
    if (t.t === "op" && t.v === "(") {
      this.enter(t.pos);
      const e = this.or();
      this.leave();
      const c = this.next();
      if (!(c.t === "op" && c.v === ")")) throw new FormulaSyntaxError(`missing ")" for the "(" at ${t.pos + 1}`, c.pos);
      return e;
    }
    if (t.t === "id") {
      const word = t.v.toLowerCase();
      if (word === "true" || word === "false") return this.node({ k: "lit", v: word === "true", pos: t.pos });
      if (word === "null") return this.node({ k: "lit", v: null, pos: t.pos });
      if (word === "and" || word === "or" || word === "not") throw new FormulaSyntaxError(`"${t.v}" needs a value ${word === "not" ? "after" : "on both sides of"} it`, t.pos);
      const m = /^in([1-9]\d{0,2})$/i.exec(t.v);
      if (m) {
        const n = Number(m[1]);
        if (n > TSA_LIMITS.dynamicInputs) throw new FormulaSyntaxError(`IN${n}: inputs go up to IN${TSA_LIMITS.dynamicInputs}`, t.pos);
        return this.node({ k: "in", n, pos: t.pos });
      }
      if (word === "call") {
        const dot = this.next();
        if (!(dot.t === "op" && dot.v === ".")) throw new FormulaSyntaxError(`call is used as call.from, call.to, call.did, call.direction, call.provider or call.id`, t.pos);
        const p = this.next();
        if (p.t !== "id" || !(CALL_PROPS as readonly string[]).includes(p.v)) throw new FormulaSyntaxError(`call.${p.t === "id" ? p.v : "?"} — the call has ${CALL_PROPS.join(", ")}`, p.pos);
        return this.node({ k: "call", prop: p.v as CallProp, pos: t.pos });
      }
      if (this.isOp("(")) {
        const def = Object.prototype.hasOwnProperty.call(FORMULA_FUNCTIONS, word) ? FORMULA_FUNCTIONS[word] : undefined;
        if (!def) throw new FormulaSyntaxError(`unknown function "${t.v}" — there are ${Object.keys(FORMULA_FUNCTIONS).join(", ")}`, t.pos);
        this.next();
        this.enter(t.pos);
        const args: FNode[] = [];
        if (!this.isOp(")")) {
          for (;;) {
            args.push(this.or());
            if (args.length > FORMULA_LIMITS.args) throw new FormulaSyntaxError(`too many arguments`, t.pos);
            if (this.isOp(",")) { this.next(); continue; }
            break;
          }
        }
        this.leave();
        const c = this.next();
        if (!(c.t === "op" && c.v === ")")) throw new FormulaSyntaxError(`missing ")" after the arguments of ${word}`, c.pos);
        if (args.length < def.min || args.length > def.max) {
          const want = def.min === def.max ? `${def.min}` : def.max >= FORMULA_LIMITS.args ? `at least ${def.min}` : `${def.min}–${def.max}`;
          throw new FormulaSyntaxError(`${word}() takes ${want} argument${def.max === 1 && def.min === 1 ? "" : "s"}, not ${args.length}`, t.pos);
        }
        return this.node({ k: "fn", name: word, args, pos: t.pos });
      }
      throw new FormulaSyntaxError(`unknown name "${t.v}" — inputs are IN1, IN2…, variables $name, the call call.from…`, t.pos);
    }
    if (t.t === "eof") throw new FormulaSyntaxError("the formula ends too early — a value is missing", t.pos);
    throw new FormulaSyntaxError(`unexpected ${describe(t)}`, t.pos);
  }
}

function describe(t: Tok): string {
  if (t.t === "eof") return "end";
  if (t.t === "num") return `number ${t.v}`;
  if (t.t === "str") return "text";
  if (t.t === "var") return `$${t.v}`;
  return `"${t.v}"`;
}

/** Parses a formula; errors carry the character position (0-based). */
export function parseFormula(src: string): ParseResult {
  if (typeof src !== "string") return { ok: false, errors: [{ message: "the formula must be text", pos: 0 }] };
  if (src.length > TSA_LIMITS.formulaLength) return { ok: false, errors: [{ message: `the formula is too long (${TSA_LIMITS.formulaLength} characters at most)`, pos: TSA_LIMITS.formulaLength }] };
  try {
    return { ok: true, ast: new Parser(tokenize(src)).parse() };
  } catch (err) {
    if (err instanceof FormulaSyntaxError) return { ok: false, errors: [{ message: err.message, pos: err.pos }] };
    return { ok: false, errors: [{ message: (err as Error).message || "cannot parse", pos: 0 }] };
  }
}

/** What a formula reads: input numbers and variable names (the validator checks them against the node). */
export function formulaRefs(ast: FNode): { inputs: number[]; vars: string[] } {
  const inputs = new Set<number>();
  const vars = new Set<string>();
  const walk = (n: FNode): void => {
    switch (n.k) {
      case "in": inputs.add(n.n); return;
      case "var": vars.add(n.name); return;
      case "fn": n.args.forEach(walk); return;
      case "un": walk(n.a); return;
      case "bin": walk(n.a); walk(n.b); return;
      default: return;
    }
  };
  walk(ast);
  return { inputs: [...inputs].sort((a, b) => a - b), vars: [...vars] };
}

/* -------------------------------------------------------------- values */

export type FormulaScope = {
  /** "IN1" → value. */
  inputs?: Record<string, unknown>;
  /** "attempts" → value ($attempts). */
  vars?: Record<string, unknown>;
  call?: Partial<Record<CallProp, string>>;
  /** Milliseconds (tests fix the clock). */
  now?: () => number;
  /** 0 ≤ x < 1. */
  random?: () => number;
  timezone?: string;
};

const NUM_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const own = (o: unknown, k: string): boolean => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

const nullish = (v: unknown): v is null | undefined => v === null || v === undefined;

/** Does the value look like a number (a number, or a text that is one: "007", " 2.5 ")? */
export function looksNumeric(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string") { const s = v.trim(); return s.length > 0 && s.length <= 64 && NUM_RE.test(s); }
  return false;
}

function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (nullish(v)) return 0;
  if (typeof v === "string" && looksNumeric(v)) return Number(v.trim());
  return NaN;
}

const finite = (n: number): number | null => (Number.isFinite(n) ? n : null);

const cap = (s: string): string => (s.length > FORMULA_LIMITS.string ? s.slice(0, FORMULA_LIMITS.string) : s);

/** A value as text: numbers without float noise, objects as JSON, null as "". */
export function textOf(v: unknown): string {
  if (nullish(v)) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "";
    return Number.isInteger(v) ? String(v) : String(Number.parseFloat(v.toPrecision(12)));
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  try { return cap(JSON.stringify(v) ?? ""); } catch { return ""; }
}

/** false, null, 0, "", "0", "false" and an empty list are false. */
export function truthy(v: unknown): boolean {
  if (nullish(v)) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "string") {
    const s = v.trim();
    if (!s || s.toLowerCase() === "false") return false;
    if (looksNumeric(s)) return Number(s) !== 0;
    return true;
  }
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

export function formulaEquals(a: unknown, b: unknown): boolean {
  if (nullish(a) || nullish(b)) return (nullish(a) && nullish(b)) || (nullish(a) && b === "") || (nullish(b) && a === "");
  if (looksNumeric(a) && looksNumeric(b)) return toNum(a) === toNum(b);
  if (typeof a === "boolean" && typeof b === "boolean") return a === b;
  if (typeof a === "boolean") return a === truthy(b);
  if (typeof b === "boolean") return b === truthy(a);
  if (typeof a === "object" || typeof b === "object") return textOf(a) === textOf(b);
  return textOf(a) === textOf(b);
}

function compare(a: unknown, b: unknown): number {
  if (looksNumeric(a) && looksNumeric(b)) { const x = toNum(a), y = toNum(b); return x < y ? -1 : x > y ? 1 : 0; }
  const x = textOf(a), y = textOf(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

const codePoints = (s: string): string[] => Array.from(s);

/** A path inside a JSON value: "a.b.0.c" — own properties only, never __proto__ / constructor / prototype. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  if (typeof cur === "string") {
    const t = cur.trim();
    if ((t.startsWith("{") || t.startsWith("[")) && t.length <= 1_000_000) { try { cur = JSON.parse(t); } catch { return null; } }
  }
  const parts = String(path).split(".").filter((p) => p !== "");
  if (parts.length > 32) return null;
  for (const p of parts) {
    if (FORBIDDEN_KEYS.has(p)) return null;
    if (Array.isArray(cur)) {
      if (!/^\d{1,9}$/.test(p)) return null;
      cur = cur[Number(p)];
    } else if (cur !== null && typeof cur === "object") {
      if (!own(cur, p)) return null;
      cur = (cur as Record<string, unknown>)[p];
    } else return null;
    if (cur === undefined) return null;
  }
  return cur === undefined ? null : cur;
}

export const DEFAULT_TIMEZONE = (): string => process.env.TSA_TIMEZONE?.trim() || "Europe/Prague";

/** Is this an IANA time zone the runtime knows? */
export function validTimezone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/** The wall clock in a time zone: weekday 1 (Mon) … 7 (Sun), hour, minute, date parts. */
export function clockIn(ms: number, tz: string): { weekday: number; hour: number; minute: number; year: number; month: number; day: number } {
  const zone = validTimezone(tz) ? tz : DEFAULT_TIMEZONE();
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday")) + 1;
  return { weekday: wd || 1, hour: Number(get("hour")) % 24, minute: Number(get("minute")), year: Number(get("year")), month: Number(get("month")), day: Number(get("day")) };
}

/* ------------------------------------------------------------ evaluator */

function callFn(name: string, args: unknown[], scope: FormulaScope): unknown {
  const s = (i: number) => textOf(args[i]);
  switch (name) {
    case "len": {
      const v = args[0];
      if (Array.isArray(v)) return v.length;
      if (v !== null && typeof v === "object") return Object.keys(v).length;
      return codePoints(textOf(v)).length;
    }
    case "int": {
      const v = args[0];
      if (looksNumeric(v) || typeof v === "boolean" || nullish(v)) return finite(Math.trunc(toNum(v)));
      const n = Number.parseInt(textOf(v).trim(), 10);
      return Number.isFinite(n) ? n : null;
    }
    case "num": {
      const v = args[0];
      if (typeof v === "number") return finite(v);
      if (typeof v === "boolean") return v ? 1 : 0;
      const t = textOf(v).trim();
      if (looksNumeric(t)) return Number(t);
      const comma = t.replace(",", ".");
      if (!t.includes(".") && looksNumeric(comma)) return Number(comma);
      return null;
    }
    case "str": return textOf(args[0]);
    case "lower": return s(0).toLowerCase();
    case "upper": return s(0).toUpperCase();
    case "trim": return s(0).trim();
    case "contains": {
      const hay = args[0];
      if (Array.isArray(hay)) return hay.some((x) => formulaEquals(x, args[1]));
      return s(0).includes(s(1));
    }
    case "startswith": return s(0).startsWith(s(1));
    case "endswith": return s(0).endsWith(s(1));
    case "digits": return s(0).replace(/[^0-9]/g, "");
    case "substr": {
      const cps = codePoints(s(0));
      let start = Math.trunc(toNum(args[1]));
      if (!Number.isFinite(start)) start = 0;
      if (start < 0) start = Math.max(0, cps.length + start);
      const len = args.length > 2 ? Math.trunc(toNum(args[2])) : cps.length;
      if (!Number.isFinite(len) || len <= 0) return "";
      return cps.slice(start, start + len).join("");
    }
    case "replace": {
      const text = s(0), find = s(1), repl = s(2);
      if (!find) return text;
      return cap(text.split(find).join(repl));
    }
    case "min": case "max": {
      const flat = args.flatMap((a) => (Array.isArray(a) ? a.slice(0, 1000) : [a])).filter((a) => !nullish(a));
      if (!flat.length) return null;
      let best = flat[0];
      for (const v of flat.slice(1)) {
        const c = compare(v, best);
        if ((name === "min" && c < 0) || (name === "max" && c > 0)) best = v;
      }
      return looksNumeric(best) ? toNum(best) : best;
    }
    case "abs": return finite(Math.abs(toNum(args[0])));
    case "round": {
      const places = args.length > 1 ? Math.max(0, Math.min(10, Math.trunc(toNum(args[1])) || 0)) : 0;
      const f = 10 ** places;
      return finite(Math.round(toNum(args[0]) * f) / f);
    }
    case "now": return Math.floor((scope.now ?? Date.now)() / 1000);
    case "hour": return clockIn((scope.now ?? Date.now)(), args.length ? s(0) : scope.timezone ?? DEFAULT_TIMEZONE()).hour;
    case "weekday": return clockIn((scope.now ?? Date.now)(), args.length ? s(0) : scope.timezone ?? DEFAULT_TIMEZONE()).weekday;
    case "random": {
      const r = (scope.random ?? Math.random)();
      if (args.length === 0) return r;
      if (args.length === 1) { const n = Math.trunc(toNum(args[0])); return n > 0 ? Math.floor(r * n) : 0; }
      const a = Math.trunc(toNum(args[0])), b = Math.trunc(toNum(args[1]));
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      const lo = Math.min(a, b), hi = Math.max(a, b);
      return lo + Math.floor(r * (hi - lo + 1));
    }
    case "get": return getPath(args[0], s(1));
    default: return null;
  }
}

/** Evaluates a parsed formula. Never throws for the values it meets. */
export function evaluate(ast: FNode, scope: FormulaScope = {}): unknown {
  switch (ast.k) {
    case "num": return ast.v;
    case "str": return ast.v;
    case "lit": return ast.v;
    case "in": { const key = `IN${ast.n}`; const v = own(scope.inputs, key) ? scope.inputs![key] : undefined; return v === undefined ? null : v; }
    case "var": { const v = own(scope.vars, ast.name) ? scope.vars![ast.name] : undefined; return v === undefined ? null : v; }
    case "call": { const v = own(scope.call, ast.prop) ? scope.call![ast.prop] : undefined; return v ?? ""; }
    case "fn": return callFn(ast.name, ast.args.map((a) => evaluate(a, scope)), scope);
    case "un": {
      const a = evaluate(ast.a, scope);
      if (ast.op === "not") return !truthy(a);
      const n = toNum(a);
      return finite(ast.op === "-" ? -n : n);
    }
    case "bin": {
      if (ast.op === "and") return truthy(evaluate(ast.a, scope)) ? truthy(evaluate(ast.b, scope)) : false;
      if (ast.op === "or") return truthy(evaluate(ast.a, scope)) ? true : truthy(evaluate(ast.b, scope));
      const a = evaluate(ast.a, scope);
      const b = evaluate(ast.b, scope);
      switch (ast.op) {
        case "==": return formulaEquals(a, b);
        case "!=": return !formulaEquals(a, b);
        case "<": return compare(a, b) < 0;
        case "<=": return compare(a, b) <= 0;
        case ">": return compare(a, b) > 0;
        case ">=": return compare(a, b) >= 0;
        case "+": {
          const textual = (v: unknown) => (typeof v === "string" && !looksNumeric(v)) || (v !== null && typeof v === "object");
          if (textual(a) || textual(b)) return cap(textOf(a) + textOf(b));
          return finite(toNum(a) + toNum(b));
        }
        case "-": return finite(toNum(a) - toNum(b));
        case "*": return finite(toNum(a) * toNum(b));
        case "/": return finite(toNum(a) / toNum(b));
        case "%": return finite(toNum(a) % toNum(b));
      }
      return null;
    }
  }
}

/* -------------------------------------------------------------- helpers */

const cache = new Map<string, ParseResult>();

/** Parses (cached) and evaluates: the value, or the parse error. */
export function runFormula(src: string, scope: FormulaScope = {}): { ok: true; value: unknown } | { ok: false; error: FormulaError } {
  let parsed = cache.get(src);
  if (!parsed) {
    parsed = parseFormula(src);
    if (cache.size >= 500) cache.delete(cache.keys().next().value as string);
    cache.set(src, parsed);
  }
  if (!parsed.ok) return { ok: false, error: parsed.errors[0] };
  return { ok: true, value: evaluate(parsed.ast, scope) };
}
