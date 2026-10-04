// Regular expressions from callers, run in the main service (6.7, audit S1/N15).
//
// m5adm filters ("/^eva/i") and the `pattern` of a model's inputs are
// patterns someone else wrote, and they run on the service's own event loop,
// not in the sandbox. A backtracking pattern ((a+)+$, (a|a)+$, a*a*a*a*$…)
// on a short subject takes seconds to forever, and a syntactic blocklist
// never catches them all (the audit bypassed the old one twice).
//
// So a pattern is classified once:
//   - simple — no quantified group, no backreference, no lookaround, at most
//     one quantifier: matching is at worst quadratic in the subject, so it
//     runs natively on subjects up to 1000 characters;
//   - anything else runs through node:vm with a timeout (V8 interrupts a
//     backtracking regex), against a time budget for the whole matcher; when
//     the budget is spent the call fails instead of the service stalling.
// The subject is cut to a fixed length either way.

import vm from "node:vm";

export class RegexBudgetError extends Error {
  readonly code = "regex-timeout";
  constructor() {
    super("a pattern took too long to match (it backtracks); simplify it");
    this.name = "RegexBudgetError";
  }
}

export type SafeRegexOptions = {
  /** Characters of the subject that are matched (default 200). */
  maxSubject?: number;
  /** Total milliseconds the guarded matcher may spend (default 250). */
  budgetMs?: number;
  /** One match at most (default 25 ms). */
  stepMs?: number;
};

/**
 * True when a pattern cannot backtrack badly: no quantifier on a group, no
 * backreference or lookaround, at most one quantifier in all.
 */
export function isSimplePattern(source: string): boolean {
  let quantifiers = 0;
  const isQuant = (i: number) => {
    const c = source[i];
    return c === "*" || c === "+" || c === "?" || (c === "{" && /^\{\d+(,\d*)?\}/.test(source.slice(i)));
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      const n = source[i + 1] ?? "";
      if (/[1-9k]/.test(n)) return false; // a backreference
      i++;
      continue;
    }
    if (c === "[") {
      i++;
      if (source[i] === "^") i++;
      if (source[i] === "]") i++;
      while (i < source.length && source[i] !== "]") { if (source[i] === "\\") i++; i++; }
      continue;
    }
    if (c === "(") {
      if (source[i + 1] === "?" && /^\(\?(=|!|<=|<!)/.test(source.slice(i))) return false; // lookaround
      continue;
    }
    if (c === ")") {
      if (isQuant(i + 1)) return false; // a quantified group
      continue;
    }
    if (isQuant(i)) {
      // "*?", "+?", "??", "{n}?" are one (lazy) quantifier, not two.
      const prev = source[i - 1];
      if (c === "?" && (prev === "(" || prev === "*" || prev === "+" || prev === "?" || prev === "}")) continue;
      quantifiers++;
      if (c === "{") i = source.indexOf("}", i);
    }
  }
  return quantifiers <= 1;
}

/** A simple pattern is at worst quadratic: natively only up to this length. */
const SIMPLE_NATIVE_MAX = 1_000;

const TEST = new vm.Script("re.lastIndex = 0; re.test(s)", { filename: "m5-safe-regex" });
const TEST_ALL = new vm.Script("all.map((x) => { re.lastIndex = 0; return re.test(x); })", { filename: "m5-safe-regex" });

/** A caller's pattern with a bounded cost: `.test()` like a RegExp. */
export class SafeRegex {
  readonly source: string;
  readonly flags: string;
  readonly simple: boolean;
  private readonly re: RegExp;
  private readonly maxSubject: number;
  private readonly stepMs: number;
  private left: number;
  private context: vm.Context | null = null;
  private readonly memo = new Map<string, boolean>();

  /** Throws a SyntaxError like `new RegExp` for an invalid pattern. */
  constructor(source: string, flags = "", opts: SafeRegexOptions = {}) {
    this.re = new RegExp(source, flags.replace(/[gy]/g, ""));
    this.source = source;
    this.flags = this.re.flags;
    this.simple = isSimplePattern(source);
    this.maxSubject = opts.maxSubject ?? 200;
    this.left = opts.budgetMs ?? 250;
    this.stepMs = opts.stepMs ?? 25;
  }

  /**
   * Matches many subjects in one guarded step (one timeout for all of them),
   * so a filter over thousands of names does not pay the guard per name;
   * test() then answers from the results.
   */
  prime(subjects: Iterable<unknown>): void {
    const todo = [...new Set([...subjects].map((x) => String(x ?? "").slice(0, this.maxSubject)))].filter((x) => !this.memo.has(x) && !(this.simple && x.length <= SIMPLE_NATIVE_MAX));
    if (!todo.length) return;
    if (this.left <= 0) throw new RegexBudgetError();
    this.context ??= vm.createContext({ re: this.re, s: "", all: [] as string[] });
    this.context.all = todo;
    const started = performance.now();
    let hits: boolean[];
    try {
      hits = TEST_ALL.runInContext(this.context, { timeout: Math.max(1, Math.ceil(this.left)) }) as boolean[];
    } catch (err) {
      if ((err as { code?: string }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") { this.left = 0; throw new RegexBudgetError(); }
      throw err;
    } finally {
      this.left -= performance.now() - started;
      this.context.all = [];
    }
    todo.forEach((x, i) => this.memo.set(x, Boolean(hits[i])));
  }

  test(subject: unknown): boolean {
    const s = String(subject ?? "").slice(0, this.maxSubject);
    if (this.simple && s.length <= SIMPLE_NATIVE_MAX) { this.re.lastIndex = 0; return this.re.test(s); }
    const known = this.memo.get(s);
    if (known !== undefined) return known;
    if (this.left <= 0) throw new RegexBudgetError();
    this.context ??= vm.createContext({ re: this.re, s: "", all: [] as string[] });
    this.context.s = s;
    const started = performance.now();
    let hit: boolean;
    try {
      hit = Boolean(TEST.runInContext(this.context, { timeout: Math.max(1, Math.min(this.stepMs, Math.ceil(this.left))) }));
    } catch (err) {
      if ((err as { code?: string }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") { this.left = 0; throw new RegexBudgetError(); }
      throw err;
    } finally {
      this.left -= performance.now() - started;
    }
    this.memo.set(s, hit);
    return hit;
  }
}
