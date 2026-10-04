// @vitest-environment node
//
// TSA templates ({IN1}, {$name}, {call.from}) and the graph checks (6.9):
// every rule of validate.ts, and the starter templates against them.

import { describe, it, expect } from "vitest";
import { renderTemplate, spellDigits, templateRefs } from "../server/telephony/tsa/template";
import { validateGraph, validateStructure, hasErrors, parseDays, hostAllowed } from "../server/telephony/tsa/validate";
import { defaultParams } from "../server/telephony/tsa/catalog";
import { TSA_TEMPLATES } from "../server/telephony/tsa/templates";
import type { TsaGraph, TsaNode, TsaNodeType } from "../server/telephony/tsa/types";

describe("templates", () => {
  const scope = { inputs: { IN1: "1234", IN2: 7, IN3: null }, vars: { name: "Eva", n: 2.5 }, call: { from: "+420603123456", did: "+420222" } };

  it("fills inputs, variables and the call; missing values are empty", () => {
    expect(renderTemplate("Your code is {IN1}, {$name}, from {call.from}.", scope)).toBe("Your code is 1234, Eva, from +420603123456.");
    expect(renderTemplate("{IN2}/{IN3}/{IN9}/{$missing}/{call.to}", scope)).toBe("7////");
    expect(renderTemplate("{$n}", scope)).toBe("2.5");
  });

  it("leaves anything else in braces alone", () => {
    expect(renderTemplate("{foo} {IN0} {call.secret} {IN101} {}", scope)).toBe("{foo} {IN0} {call.secret} {IN101} {}");
  });

  it("encodes values (an HTTP URL), never the template itself", () => {
    expect(renderTemplate("https://x.test/?n={call.from}&q={$name}", scope, { encode: encodeURIComponent })).toBe("https://x.test/?n=%2B420603123456&q=Eva");
  });

  it("secrets only where a resolver is given", () => {
    expect(renderTemplate("Bearer {secret:CRM}", scope)).toBe("Bearer ");
    expect(renderTemplate("Bearer {secret:CRM}", scope, { secret: (n) => (n === "CRM" ? "s3cret" : undefined) })).toBe("Bearer s3cret");
  });

  it("is bounded and lists what it reads", () => {
    expect(renderTemplate("{IN1}".repeat(2000), { inputs: { IN1: "x".repeat(100) } }).length).toBe(4000);
    expect(templateRefs("{IN2} {IN1} {$a} {call.did} {secret:K}")).toEqual({ inputs: [1, 2], vars: ["a"], call: ["did"], secrets: ["K"] });
  });

  it("spells digits for TTS", () => {
    expect(spellDigits("Your code is 1234 (room 5).")).toBe("Your code is 1 2 3 4 (room 5).");
    expect(spellDigits("+420603")).toBe("+4 2 0 6 0 3");
  });
});

/* ------------------------------------------------------------- graphs */

let ids = 0;
function node(id: string, type: TsaNodeType, params: Record<string, unknown> = {}, extra: Partial<TsaNode> = {}): TsaNode {
  return { id, type, x: 0, y: 0, ...extra, params: { ...defaultParams(type), ...params } };
}
const flow = (from: string, port: string, to: string) => ({ id: `e${++ids}`, from: { node: from, port }, to: { node: to, port: "in" }, kind: "flow" as const });
const data = (from: string, port: string, to: string, toPort: string) => ({ id: `d${++ids}`, from: { node: from, port }, to: { node: to, port: toPort }, kind: "data" as const });

/** start → tts → hangup, plus what a test adds. */
function base(): TsaGraph {
  return {
    nodes: [node("start", "start"), node("hello", "tts", { text: "Hi" }, { inputs: 0 }), node("end", "hangup")],
    edges: [flow("start", "next", "hello"), flow("hello", "next", "end"), flow("hello", "on_failed", "end")],
  };
}
const msgs = (g: unknown, level?: "error" | "warning") => validateGraph(g).filter((p) => !level || p.level === level).map((p) => p.message);
const has = (g: unknown, re: RegExp, level?: "error" | "warning") => msgs(g, level).some((m) => re.test(m));

describe("validate: structure", () => {
  it("a clean graph has no problems", () => {
    expect(validateGraph(base())).toEqual([]);
  });

  it("needs nodes and edges, within the limits", () => {
    expect(has(null, /list of nodes/)).toBe(true);
    expect(has({ nodes: Array.from({ length: 301 }, (_, i) => node(`n${i}`, "pause")), edges: [] }, /Too many nodes/)).toBe(true);
  });

  it("exactly one start", () => {
    const g = base(); g.nodes.shift(); g.edges.shift();
    expect(has(g, /needs a Start/, "error")).toBe(true);
    const g2 = base(); g2.nodes.push(node("start2", "start"));
    expect(has(g2, /exactly one Start/, "error")).toBe(true);
  });

  it("ids: valid and unique; tools: known", () => {
    const g = base(); g.nodes.push(node("Bad-Id", "pause"));
    expect(has(g, /not valid/, "error")).toBe(true);
    const g2 = base(); g2.nodes.push(node("hello", "pause"));
    expect(has(g2, /Two nodes have the id "hello"/, "error")).toBe(true);
    const g3 = base(); g3.nodes.push({ ...node("x", "pause"), type: "teleport" as TsaNodeType });
    expect(has(g3, /unknown tool "teleport"/, "error")).toBe(true);
    const g4 = base(); g4.edges.push({ ...flow("hello", "next", "end"), id: g4.edges[0].id });
    expect(has(g4, /Two edges have the id/, "error")).toBe(true);
  });

  it("positions are numbers", () => {
    const g = base(); (g.nodes[1] as unknown as Record<string, unknown>).x = "10";
    expect(has(g, /position/, "error")).toBe(true);
  });

  it("edges reference existing nodes and ports of the right kind", () => {
    const g = base(); g.edges.push(flow("hello", "next", "ghost"));
    expect(has(g, /does not exist/, "error")).toBe(true);
    const g2 = base(); g2.edges.push(flow("hello", "on_true", "end"));
    expect(has(g2, /no control output "on_true"/, "error")).toBe(true);
    const g3 = base(); g3.edges.push({ id: "x1", from: { node: "hello", port: "next" }, to: { node: "end", port: "IN1" }, kind: "flow" });
    expect(has(g3, /control goes into a node's "in"/, "error")).toBe(true);
    const g4 = base(); g4.edges.push(flow("end", "next", "hello"));
    expect(has(g4, /no control output/, "error")).toBe(true);
    const g5 = base(); g5.edges.push(flow("hello", "next", "start"));
    expect(msgs(g5, "error").some((m) => /Start has none|already leads/.test(m))).toBe(true);
    const g6 = base(); g6.nodes.push(node("c", "condition", { formula: "IN1 == 1" }, { inputs: 1 }));
    g6.edges.push(data("hello", "next", "c", "IN1"));
    expect(has(g6, /no data output "next"/, "error")).toBe(true);
    const g7 = base(); g7.nodes.push(node("c", "condition", { formula: "IN1 == 1" }, { inputs: 1 }));
    g7.edges.push(data("start", "from", "c", "IN2"));
    expect(has(g7, /no data input "IN2"/, "error")).toBe(true);
  });

  it("one edge per control output and per data input", () => {
    const g = base(); g.nodes.push(node("p", "pause")); g.edges.push(flow("hello", "next", "p"));
    expect(has(g, /already leads somewhere/, "error")).toBe(true);
    const g2 = base(); g2.nodes.push(node("c", "condition", { formula: "IN1 == 1" }, { inputs: 1 }));
    g2.edges.push(data("start", "from", "c", "IN1"), data("start", "to", "c", "IN1"));
    expect(has(g2, /already has a value connected/, "error")).toBe(true);
  });

  it("dynamic input counts within the tool's bounds", () => {
    const g = base(); g.nodes.push(node("c", "condition", { formula: "true" }, { inputs: 101 }));
    expect(has(g, /takes 0–100 inputs/, "error")).toBe(true);
    const g2 = base(); g2.nodes.push(node("h", "hangup", {}, { inputs: 2 }));
    expect(has(g2, /has no inputs to add/, "error")).toBe(true);
  });

  it("validateStructure alone ignores parameters (an unfinished draft can be saved)", () => {
    const g = base(); (g.nodes[1].params as Record<string, unknown>).text = "";
    expect(hasErrors(validateStructure(g))).toBe(false);
    expect(has(g, /"Text to speak" is required/, "error")).toBe(true);
  });
});

describe("validate: parameters", () => {
  const withNode = (n: TsaNode, edges: ReturnType<typeof flow>[] = []) => {
    const g = base();
    g.nodes.push(n);
    g.edges.push(...edges);
    return g;
  };

  it("required, numbers in range, selects in options, bools, keys", () => {
    expect(has(withNode(node("r", "read_dtmf", { maxDigits: 50 })), /"Max digits" is at most 32/, "error")).toBe(true);
    expect(has(withNode(node("r", "read_dtmf", { maxDigits: "4" })), /must be a number/, "error")).toBe(true);
    expect(has(withNode(node("r", "read_dtmf", { finishOnKey: "5" })), /one of # \* none any/, "error")).toBe(true);
    expect(has(withNode(node("t", "tts", { text: "x", provider: "robot" }, { inputs: 0 })), /"robot" is not one of/, "error")).toBe(true);
    expect(has(withNode(node("t", "tts", { text: "x", bargeIn: "yes" }, { inputs: 0 })), /on or off/, "error")).toBe(true);
    expect(has(withNode(node("s", "sms", { text: "" })), /"Text" is required/, "error")).toBe(true);
  });

  it("a parameter hidden by `when` is not checked", () => {
    // trunk is only required with via = trunk.
    expect(has(withNode(node("d", "dial", { to: "+420603123456", via: "rules" })), /trunk/, "error")).toBe(false);
    expect(has(withNode(node("d", "dial", { to: "+420603123456", via: "trunk" })), /pick the SIP trunk/, "error")).toBe(true);
  });

  it("formulas parse (with the position) and use only the node's inputs", () => {
    expect(has(withNode(node("c", "condition", { formula: "IN1 = 2" }, { inputs: 1 })), /at character 5/, "error")).toBe(true);
    expect(has(withNode(node("c", "condition", { formula: "IN3 > 1" }, { inputs: 2 })), /uses IN3 but the node has 2 inputs/, "error")).toBe(true);
    expect(has(withNode(node("c", "condition", { formula: "IN2 > 1" }, { inputs: 2 })), /IN2 is used but nothing is connected/, "warning")).toBe(true);
  });

  it("digits: the dial-pad charset (placeholders allowed)", () => {
    expect(has(withNode(node("s", "send_dtmf", { digits: "12x#" }, { inputs: 0 })), /only 0-9/, "error")).toBe(true);
    expect(has(withNode(node("s", "send_dtmf", { digits: "1w2#{IN1}" }, { inputs: 1 })), /only 0-9/, "error")).toBe(false);
  });

  it("templates that read inputs the node does not have", () => {
    expect(has(withNode(node("t", "tts", { text: "{IN2}" }, { inputs: 1 })), /\{IN2\} but the node has 1 input/, "warning")).toBe(true);
  });

  it("tool rules: set names, switch cases, opening hours, http, dial, play, room, inroute", () => {
    expect(has(withNode(node("s", "set", { name: "9lives", value: "1" }, { inputs: 0 })), /variable name/, "error")).toBe(true);
    expect(has(withNode(node("w", "switch", { cases: ["1", "1"] })), /listed twice/, "warning")).toBe(true);
    expect(has(withNode(node("h", "time_condition", { timezone: "Mars/Base", days: "someday", from: "8", to: "25:00", closedOn: ["24.12."] })), /not a time zone/, "error")).toBe(true);
    const tc = msgs(withNode(node("h", "time_condition", { days: "mon-xyz", from: "8", to: "25:00", closedOn: ["24.12."] })), "error");
    expect(tc.some((m) => /days/.test(m)) && tc.some((m) => /"From"/.test(m)) && tc.some((m) => /"To"/.test(m)) && tc.some((m) => /not a date/.test(m))).toBe(true);
    expect(has(withNode(node("x", "http", { url: "http://crm.test/a" })), /only https/, "error")).toBe(true);
    expect(has(withNode(node("x", "http", { url: "https://crm.test/a", headers: ["not a header"] })), /Name: value/, "error")).toBe(true);
    expect(validateGraph(withNode(node("x", "http", { url: "https://crm.test/a" })), { httpHosts: [] }).some((p) => /HTTP tool is off/.test(p.message))).toBe(true);
    expect(validateGraph(withNode(node("x", "http", { url: "https://evil.test/a" })), { httpHosts: ["*.crm.test"] }).some((p) => /not among the hosts/.test(p.message))).toBe(true);
    expect(validateGraph(withNode(node("x", "http", { url: "https://api.crm.test/a" })), { httpHosts: ["*.crm.test"] }).some((p) => /not among the hosts/.test(p.message))).toBe(false);
    expect(has(withNode(node("d", "dial", { to: "0603123456" })), /not an E\.164/, "error")).toBe(true);
    expect(has(withNode(node("d", "dial", { kind: "sip", to: "alice" })), /SIP URI/, "error")).toBe(true);
    expect(has(withNode(node("d", "dial", { to: "{IN1}" }, { inputs: 1 })), /E\.164/, "error")).toBe(false);
    expect(has(withNode(node("p", "play", { source: "url", url: "" }, { inputs: 0 })), /URL is required/, "error")).toBe(true);
    expect(has(withNode(node("p", "play", { source: "file", file: "" }, { inputs: 0 })), /uploaded file/, "error")).toBe(true);
    expect(has(withNode(node("m", "room_message", { text: "x", room: "" })), /the room .* is required/, "error")).toBe(true);
    expect(has(withNode(node("i", "inroute_add", { room: "r3.abc", type: "user", user: "" }, { inputs: 0 })), /member to route to/, "error")).toBe(true);
    expect(has(withNode(node("i", "inroute_add", { room: "r3.abc", code: "12" }, { inputs: 0 })), /4–6 digits/, "error")).toBe(true);
  });

  it("6.10 (G-15): an HTTP header with a secret written out is an error — {secret:NAME} is the way", () => {
    const http = (headers: string[]) => withNode(node("x", "http", { url: "https://crm.test/a", headers }));
    for (const h of ["Authorization: Bearer sk_live_51Hx9", "Authorization: Basic dXNlcjpwYXNzd29yZA==", "X-Api-Key: 3f9a8b7c6d5e4f", "Cookie: session=ab12cd34ef56", "X-Custom: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig", "X-Auth-Token: 9c1f0e2d3b4a5968"]) {
      expect(msgs(http([h]), "error"), h).toEqual([expect.stringMatching(/Headers: ".+" holds a secret written out — put it in the server's environment as TSA_SECRET_<NAME> and write \{secret:NAME\}/)]);
    }
    for (const h of ["Authorization: Bearer {secret:CRM}", "Authorization: Basic {secret:BASIC}", "X-Api-Key: {secret:KEY}", "Authorization: Bearer {IN1}", "Content-Type: application/json", "Accept: application/vnd.github+json", "X-Token-Type: bearer-access", "Cookie: lang=cs", "X-Request-Id: {call.id}"]) {
      expect(msgs(http([h]), "error"), h).toEqual([]);
    }
  });

  it("6.10 (G-06): an SMS to the caller's (fakeable) number is a warning only while Countries = * (any)", () => {
    const sms = (to?: string) => withNode(node("s", "sms", { text: "x", ...(to === undefined ? {} : { to }) }, { inputs: 0 }));
    const warn = (g: TsaGraph, countries: string[]) => validateGraph(g, { countries }).filter((p) => p.level === "warning" && /SMS pumping/.test(p.message));
    expect(warn(sms(), ["*"])).toHaveLength(1);
    expect(warn(sms("{call.from}"), ["*"])).toHaveLength(1);
    expect(warn(sms(""), ["*"])).toHaveLength(1);
    expect(warn(sms(), [])).toHaveLength(0);
    expect(warn(sms(), ["CZ"])).toHaveLength(0);
    expect(warn(sms("+420603123456"), ["*"])).toHaveLength(0);
  });
});

describe("validate: the flow", () => {
  it("unreachable nodes", () => {
    const g = base(); g.nodes.push(node("lonely", "pause"));
    expect(has(g, /"lonely" can never run/, "warning")).toBe(true);
  });

  it("dead ends that are not a hang up (one warning per node)", () => {
    const g = base(); g.edges = g.edges.filter((e) => !(e.from.node === "hello" && e.from.port === "on_failed"));
    expect(msgs(g, "warning")).toEqual([expect.stringMatching(/"hello": on_failed leads nowhere/)]);
  });

  it("a dead end inside a loop body goes back to the loop (no warning)", () => {
    const g: TsaGraph = {
      nodes: [node("start", "start"), node("loop", "for", { from: "1", to: "3" }, { inputs: 0 }), node("say", "tts", { text: "{IN1}" }, { inputs: 1 }), node("end", "hangup")],
      edges: [flow("start", "next", "loop"), flow("loop", "body", "say"), flow("loop", "done", "end"), data("loop", "index", "say", "IN1")],
    };
    expect(validateGraph(g)).toEqual([]);
  });

  it("break outside a loop", () => {
    const g = base(); g.nodes.push(node("b", "break")); g.edges = g.edges.filter((e) => e.from.port !== "on_failed"); g.edges.push(flow("hello", "on_failed", "b"));
    expect(has(g, /Break "b" is not inside a loop/, "warning")).toBe(true);
  });

  it("route_audio without its KEY", () => {
    const g = base(); g.nodes.push(node("r", "route_audio")); g.edges = g.edges.filter((e) => e.from.port !== "on_failed"); g.edges.push(flow("hello", "on_failed", "r"));
    expect(has(g, /KEY .* is not connected/, "warning")).toBe(true);
  });

  it("a cycle that never waits for the caller", () => {
    const g: TsaGraph = {
      nodes: [node("start", "start"), node("a", "set", { name: "x", value: "$x + 1" }, { inputs: 0 }), node("b", "condition", { formula: "true" }, { inputs: 0 })],
      edges: [flow("start", "next", "a"), flow("a", "next", "b"), flow("b", "on_true", "a"), flow("b", "on_false", "a")],
    };
    expect(has(g, /form a cycle with nothing that waits/, "warning")).toBe(true);
    // The same cycle through a TTS waits for the caller each round.
    g.nodes.push(node("t", "tts", { text: "again" }, { inputs: 0 }));
    g.edges = [flow("start", "next", "a"), flow("a", "next", "b"), flow("b", "on_true", "t"), flow("b", "on_false", "a"), flow("t", "next", "a"), flow("t", "on_failed", "a")];
    expect(has(g, /form a cycle/, "warning")).toBe(false);
  });

  it("helpers: days and hosts", () => {
    expect([...parseDays("mon-fri")!]).toEqual([1, 2, 3, 4, 5]);
    expect([...parseDays("fri-mon")!].sort()).toEqual([1, 5, 6, 7]);
    expect([...parseDays("mon, wed,fri")!]).toEqual([1, 3, 5]);
    expect(parseDays("weekend")).toBeNull();
    expect(hostAllowed("api.crm.test", ["*.crm.test"])).toBe(true);
    expect(hostAllowed("crm.test", ["*.crm.test"])).toBe(false);
    expect(hostAllowed("evilcrm.test", ["*.crm.test"])).toBe(false);
    expect(hostAllowed("crm.test", ["crm.test"])).toBe(true);
  });
});

describe("the starter templates", () => {
  for (const t of TSA_TEMPLATES) {
    it(`${t.id}: structurally sound, only "fill this in" errors, no warnings`, () => {
      const g = t.graph();
      expect(validateStructure(g)).toEqual([]);
      const problems = validateGraph(g, { httpHosts: [] });
      expect(problems.filter((p) => p.level === "warning")).toEqual([]);
      for (const p of problems) expect(p.message).toMatch(/"To" is required|the room .* is required/);
    });
  }
});
