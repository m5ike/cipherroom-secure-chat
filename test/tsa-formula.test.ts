// @vitest-environment node
//
// The TSA formula language (6.9): precedence, coercion, the functions, parse
// errors with their positions, and safety — no prototype reachable, bounded.

import { describe, it, expect } from "vitest";
import { evaluate, formulaRefs, getPath, parseFormula, runFormula, textOf, truthy, FORMULA_FUNCTIONS } from "../server/telephony/tsa/formula";
import { TSA_LIMITS } from "../server/telephony/tsa/types";

const ev = (src: string, scope: Parameters<typeof runFormula>[1] = {}) => {
  const r = runFormula(src, scope);
  if (!r.ok) throw new Error(`${src}: ${r.error.message} @${r.error.pos}`);
  return r.value;
};
const err = (src: string) => {
  const r = parseFormula(src);
  if (r.ok) throw new Error(`${src} parsed`);
  return r.errors[0];
};

describe("formula: precedence and operators", () => {
  it("arithmetic binds tighter than comparison, comparison than not, not than and, and than or", () => {
    expect(ev("1 + 2 * 3")).toBe(7);
    expect(ev("(1 + 2) * 3")).toBe(9);
    expect(ev("10 - 4 - 3")).toBe(3);
    expect(ev("2 * 3 % 4")).toBe(2);
    expect(ev("-2 * 3")).toBe(-6);
    expect(ev("- -2")).toBe(2);
    expect(ev("1 + 2 == 3")).toBe(true);
    expect(ev("not 1 == 2")).toBe(true);
    expect(ev("true or false and false")).toBe(true);
    expect(ev("(true or false) and false")).toBe(false);
    expect(ev("1 < 2 && 2 < 3 || false")).toBe(true);
    expect(ev("!(1 == 1)")).toBe(false);
    expect(ev("NOT false AND TRUE")).toBe(true);
  });

  it("the task's examples", () => {
    expect(ev("(IN1 == IN2)", { inputs: { IN1: "5", IN2: 5 } })).toBe(true);
    expect(ev("(IN1 == 0 and IN2 > 2)", { inputs: { IN1: "0", IN2: "3" } })).toBe(true);
    expect(ev("(IN1 == 0 and IN2 > 2)", { inputs: { IN1: "0", IN2: "2" } })).toBe(false);
  });

  it("and / or short-circuit and give booleans", () => {
    expect(ev("0 or \"x\"")).toBe(true);
    expect(ev("\"\" and 1/0")).toBe(false);
  });
});

describe("formula: types and coercion", () => {
  it("compares numerically when both sides look numeric, else as text", () => {
    expect(ev("\"007\" == 7")).toBe(true);
    expect(ev("\"10\" > \"9\"")).toBe(true);
    expect(ev("\"b\" > \"a\"")).toBe(true);
    expect(ev("\"abc\" == \"abc\"")).toBe(true);
    expect(ev("\"abc\" != \"abd\"")).toBe(true);
    expect(ev("\" 2.5 \" == 2.5")).toBe(true);
  });

  it("null equals null and \"\"; an input that never ran is null", () => {
    expect(ev("IN1 == null", { inputs: {} })).toBe(true);
    expect(ev("IN1 == \"\"", { inputs: { IN1: null } })).toBe(true);
    expect(ev("IN3")).toBe(null);
    expect(ev("$nothing")).toBe(null);
  });

  it("+ adds numbers (also numeric text) and joins other text", () => {
    expect(ev("\"5\" + 1")).toBe(6);
    expect(ev("\"Code \" + IN1", { inputs: { IN1: "1234" } })).toBe("Code 1234");
    expect(ev("$a + 1", { vars: { a: 2 } })).toBe(3);
    expect(ev("null + 1")).toBe(1);
  });

  it("a result that is not a finite number is null", () => {
    expect(ev("1 / 0")).toBe(null);
    expect(ev("\"x\" * 2")).toBe(null);
    expect(ev("5 % 0")).toBe(null);
  });

  it("truthiness: 0, \"0\", \"false\", \"\" and null are false", () => {
    for (const v of [0, "0", "false", "", null, undefined, [], false]) expect(truthy(v)).toBe(false);
    for (const v of [1, "1", "yes", true, [0], {}]) expect(truthy(v)).toBe(true);
    expect(ev("not IN1", { inputs: { IN1: "0" } })).toBe(true);
  });

  it("booleans compare with truthiness", () => {
    expect(ev("contains(IN1, \"ano\") == true", { inputs: { IN1: "ano prosím" } })).toBe(true);
  });

  it("text of numbers has no float noise", () => {
    expect(textOf(0.1 + 0.2)).toBe("0.3");
    expect(textOf(null)).toBe("");
    expect(textOf({ a: 1 })).toBe("{\"a\":1}");
  });

  it("the call and variables", () => {
    const call = { from: "+420603123456", to: "+420222", did: "+420222", direction: "inbound", provider: "twilio", id: "tc_1" };
    expect(ev("startswith(call.from, \"+420\")", { call })).toBe(true);
    expect(ev("call.direction == \"inbound\"", { call })).toBe(true);
    expect(ev("$attempts < 3", { vars: { attempts: 2 } })).toBe(true);
  });
});

describe("formula: functions", () => {
  const fixed = { now: () => Date.UTC(2026, 9, 5, 7, 30), random: () => 0.5 }; // Monday 5 Oct 2026 09:30 in Prague

  it("text", () => {
    expect(ev("len(\"žluťoučký\")")).toBe(9);
    expect(ev("lower(\"ABC\") + upper(\"d\")")).toBe("abcD");
    expect(ev("trim(\"  x \")")).toBe("x");
    expect(ev("contains(\"hello\", \"ell\")")).toBe(true);
    expect(ev("startswith(\"hello\", \"he\") and endswith(\"hello\", \"lo\")")).toBe(true);
    expect(ev("digits(\"+420 603-123\")")).toBe("420603123");
    expect(ev("substr(\"abcdef\", 1, 3)")).toBe("bcd");
    expect(ev("substr(\"abcdef\", -2)")).toBe("ef");
    expect(ev("replace(\"a-b-c\", \"-\", \"+\")")).toBe("a+b+c");
    expect(ev("replace(\"abc\", \"\", \"x\")")).toBe("abc");
    expect(ev("str(12) + str(true)")).toBe("12true");
  });

  it("numbers", () => {
    expect(ev("int(12.7)")).toBe(12);
    expect(ev("int(\"12abc\")")).toBe(12);
    expect(ev("int(\"abc\")")).toBe(null);
    expect(ev("num(\"1,5\")")).toBe(1.5);
    expect(ev("num(\"x\")")).toBe(null);
    expect(ev("min(3, 1, 2)")).toBe(1);
    expect(ev("max(\"3\", 10, 2)")).toBe(10);
    expect(ev("abs(-4)")).toBe(4);
    expect(ev("round(2.345, 2)")).toBe(2.35);
    expect(ev("round(2.5)")).toBe(3);
  });

  it("time and chance (with a fixed clock)", () => {
    expect(ev("now()", fixed)).toBe(Math.floor(fixed.now() / 1000));
    expect(ev("hour(\"Europe/Prague\")", fixed)).toBe(9);
    expect(ev("hour(\"UTC\")", fixed)).toBe(7);
    expect(ev("weekday()", fixed)).toBe(1);
    expect(ev("random()", fixed)).toBe(0.5);
    expect(ev("random(10)", fixed)).toBe(5);
    expect(ev("random(1, 3)", fixed)).toBe(2);
  });

  it("get() reads JSON — own properties only", () => {
    const json = { customer: { name: "Eva", tags: ["vip"] } };
    expect(ev("get(IN1, \"customer.name\")", { inputs: { IN1: json } })).toBe("Eva");
    expect(ev("get(IN1, \"customer.tags.0\")", { inputs: { IN1: json } })).toBe("vip");
    expect(ev("get(IN1, \"customer.name\")", { inputs: { IN1: JSON.stringify(json) } })).toBe("Eva");
    expect(ev("get(IN1, \"missing.deeper\")", { inputs: { IN1: json } })).toBe(null);
    expect(ev("len(IN1)", { inputs: { IN1: [1, 2, 3] } })).toBe(3);
    expect(ev("contains(IN1, 2)", { inputs: { IN1: [1, "2", 3] } })).toBe(true);
  });

  it("the help lists every function", () => {
    for (const f of ["len", "int", "num", "str", "lower", "upper", "trim", "contains", "startswith", "endswith", "digits", "substr", "replace", "min", "max", "abs", "round", "now", "hour", "weekday", "random", "get"]) expect(FORMULA_FUNCTIONS[f]).toBeDefined();
  });
});

describe("formula: errors with positions", () => {
  it("names where the problem is", () => {
    expect(err("IN1 = 2")).toMatchObject({ pos: 4 });
    expect(err("IN1 = 2").message).toMatch(/==/);
    expect(err("1 +")).toMatchObject({ pos: 3 });
    expect(err("(1 + 2")).toMatchObject({ pos: 6 });
    expect(err("\"abc")).toMatchObject({ pos: 0 });
    expect(err("foo(1)").message).toMatch(/unknown function/);
    expect(err("foo")).toMatchObject({ pos: 0 });
    expect(err("len(1, 2)").message).toMatch(/takes 1 argument/);
    expect(err("1 < 2 < 3").message).toMatch(/chained/);
    expect(err("1 2")).toMatchObject({ pos: 2 });
    expect(err("call.secret").message).toMatch(/call\.secret/);
    expect(err("IN101").message).toMatch(/IN100/);
    expect(err("a & b").message).toMatch(/&&/);
    expect(err("").message).toMatch(/empty/);
    expect(err("#").message).toMatch(/unexpected character/);
  });

  it("refs: which inputs and variables a formula reads", () => {
    const r = parseFormula("IN2 + $x > IN1 and contains(IN3, $y)");
    expect(r.ok).toBe(true);
    if (r.ok) expect(formulaRefs(r.ast)).toEqual({ inputs: [1, 2, 3], vars: ["x", "y"] });
  });
});

describe("formula: safety", () => {
  it("cannot reach prototypes or constructors", () => {
    expect(ev("get(IN1, \"__proto__\")", { inputs: { IN1: {} } })).toBe(null);
    expect(ev("get(IN1, \"constructor.prototype\")", { inputs: { IN1: {} } })).toBe(null);
    expect(ev("get(IN1, \"toString\")", { inputs: { IN1: {} } })).toBe(null);
    expect(ev("$constructor", { vars: {} })).toBe(null);
    expect(ev("$toString", { vars: {} })).toBe(null);
    expect(err("constructor(1)").message).toMatch(/unknown function/);
    expect(err("toString()").message).toMatch(/unknown function/);
    expect(err("IN1.constructor")).toBeTruthy();
    // A variable named like a prototype member that the TSA did set is just a value.
    expect(ev("$valueOf", { vars: { valueOf: 3 } })).toBe(3);
  });

  it("is bounded: length, depth, size of what it builds", () => {
    expect(err("1+".repeat(600) + "1").message).toMatch(/too long|too complex/);
    expect(err("(".repeat(60) + "1" + ")".repeat(60)).message).toMatch(/nested too deeply/);
    expect(err("-".repeat(80) + "1").message).toMatch(/nested too deeply/);
    expect(err("x".repeat(TSA_LIMITS.formulaLength + 1)).message).toMatch(/too long/);
    const big = "x".repeat(4000);
    const v = ev("IN1 + IN1 + IN1 + IN1 + IN1", { inputs: { IN1: big } }) as string;
    expect(v.length).toBeLessThanOrEqual(16_000);
    const r = ev("replace(IN1, \"x\", IN2)", { inputs: { IN1: big, IN2: big } }) as string;
    expect(r.length).toBeLessThanOrEqual(16_000);
  });

  it("no regular expression is ever built from the formula (patterns are plain text)", () => {
    expect(ev("replace(\"a.b.c\", \".\", \"-\")")).toBe("a-b-c");
    expect(ev("contains(\"(a+)+$\", \"(a+)+\")")).toBe(true);
    const t0 = Date.now();
    ev("contains(IN1, \"aaaaaaaaaaaaaaaaaaaaaaab\")", { inputs: { IN1: "a".repeat(4000) } });
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it("getPath ignores dangerous keys at any depth", () => {
    expect(getPath({ a: { b: 1 } }, "a.b")).toBe(1);
    expect(getPath({ a: {} }, "a.__proto__.polluted")).toBe(null);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("evaluate never throws on odd values", () => {
    const r = parseFormula("IN1 * 2 + len(IN2) - abs(IN3) / int(IN4)");
    expect(r.ok).toBe(true);
    if (r.ok) expect(() => evaluate(r.ast, { inputs: { IN1: { x: 1 }, IN2: Symbol.iterator as unknown, IN3: [], IN4: "z" } })).not.toThrow();
  });
});
