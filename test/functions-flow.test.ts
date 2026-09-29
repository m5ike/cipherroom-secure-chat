// @vitest-environment node
// The visual builder's flows (server/functions/flow.ts, 5.1): every node
// compiles in both languages, the generated code is valid, branches gate
// what hangs off them, and the examples really run in the sandbox — traced,
// so the builder can show each node's value.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FUNCTIONS_DB_FILE = join(mkdtempSync(join(tmpdir(), "m5flow-")), "functions.db");
process.env.FUNCTIONS_WARM = "0";

const F = await import("../server/functions/flow");
const { runAdhoc, closeRunner } = await import("../server/functions/runner");
const { functionsStore } = await import("../server/functions/store");

const caller = { kind: "console" as const, account: "", name: "tester", groups: [], room: "r", client: "c", lang: "cs", tz: "UTC" };
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...a: string[]) => unknown;

beforeAll(() => functionsStore.ready());
afterAll(() => closeRunner());

/** A flow of one node of each type, its required inputs filled with literals. */
function single(type: string, lang: "js" | "py") {
  const flow = F.emptyFlow(lang);
  const n = F.newNode(flow, type, 0, 0);
  for (const p of F.inputsOf(n)) if (p.required) n.values![p.name] = p.type === "number" ? 1 : p.type === "list" ? "[1,2]" : p.type === "object" ? "{\"a\":1}" : "x";
  flow.nodes.push(n);
  return flow;
}

async function run(flow: ReturnType<typeof F.emptyFlow>, inputs: Record<string, unknown> = {}, trace = false) {
  const c = F.compileFlow(flow, { trace });
  const r = await runAdhoc({ lang: flow.lang, files: { [c.file]: c.code }, entry: { file: c.file, fn: "execute" }, inputs, limits: { wallMs: 25000 } }, caller);
  return { ...r, compiled: c };
}
const texts = (outputs: unknown[]) => outputs.map((o) => { const x = o as { text?: string; value?: unknown }; return x.text ?? JSON.stringify(x.value ?? o); }).join("\n");

describe("flow nodes", () => {
  it("every node compiles to valid JavaScript", () => {
    for (const def of F.NODES) {
      const c = F.compileFlow(single(def.type, "js"));
      const body = c.code.replace(/^export async function/m, "async function");
      expect(() => new AsyncFunction(body), def.type).not.toThrow();
    }
  });

  it("every node compiles to Python", () => {
    for (const def of F.NODES) {
      const c = F.compileFlow(single(def.type, "py"));
      expect(c.code, def.type).toContain("async def execute(**inputs):");
    }
  });

  it("finds problems: missing inputs, two wires into one input, circles", () => {
    const flow = F.emptyFlow("js");
    const a = F.newNode(flow, "text.case", 0, 0); flow.nodes.push(a);
    const b = F.newNode(flow, "text.case", 200, 0); flow.nodes.push(b);
    expect(F.checkFlow(flow).some((i) => i.level === "error" && i.node === a.id)).toBe(true);
    flow.edges.push({ id: "e1", from: { node: a.id, port: "result" }, to: { node: b.id, port: "text" } });
    flow.edges.push({ id: "e2", from: { node: b.id, port: "result" }, to: { node: a.id, port: "text" } });
    expect(() => F.compileFlow(flow)).toThrow(/circle/);
  });

  it("describes the model inputs from Input nodes", () => {
    const f = F.FLOW_EXAMPLES.find((e) => e.id === "branch")!.flow;
    expect(F.flowInputs(f)).toEqual([{ name: "n", type: "number", label: "A number", default: 7 }]);
  });

  it("parseFlow rejects junk and drops dangling wires", () => {
    expect(() => F.parseFlow({ nodes: "x" })).toThrow();
    const f = F.parseFlow({ lang: "py", nodes: [{ id: "n1", type: "flow.value", x: 1, y: 2 }], edges: [{ from: { node: "n1", port: "value" }, to: { node: "zz", port: "a" } }] });
    expect(f.lang).toBe("py");
    expect(f.edges).toHaveLength(0);
  });
});

describe("flows run in the sandbox", () => {
  it("hello (JavaScript) with a trace of every node", async () => {
    const flow = F.FLOW_EXAMPLES.find((e) => e.id === "hello")!.flow;
    const r = await run(flow, { name: "Ada" }, true);
    expect(r.run.status).toBe("done");
    expect(texts(r.outputs)).toContain("Hello, Ada!");
    const logs = functionsStore.logs(r.run.id);
    const t = F.traceResults(logs);
    expect(t.n1.value).toBe("Ada");
    expect(String(t.n2.value)).toContain("Hello, Ada!");
  }, 40_000);

  it("the same flow in Python", async () => {
    const flow = { ...F.FLOW_EXAMPLES.find((e) => e.id === "hello")!.flow, lang: "py" as const };
    const r = await run(flow, { name: "Grace" }, true);
    expect(r.run.error ?? null).toBeNull();
    expect(r.run.status).toBe("done");
    expect(texts(r.outputs)).toContain("Hello, Grace!");
    expect(F.traceResults(functionsStore.logs(r.run.id)).n1.value).toBe("Grace");
  }, 60_000);

  it("a branch runs only one side (JavaScript and Python)", async () => {
    const base = F.FLOW_EXAMPLES.find((e) => e.id === "branch")!.flow;
    for (const lang of ["js", "py"] as const) {
      const flow = { ...base, lang };
      const big = await run(flow, { n: 42 });
      expect(big.run.status, lang).toBe("done");
      expect(texts(big.outputs), lang).toContain("42 is big.");
      expect(texts(big.outputs), lang).not.toContain("small");
      const small = await run(flow, { n: 3 });
      expect(texts(small.outputs), lang).toContain("3 is small.");
      expect(texts(small.outputs), lang).not.toContain("big");
    }
  }, 90_000);

  it("the QR example sends an image", async () => {
    const r = await run(F.FLOW_EXAMPLES.find((e) => e.id === "qr")!.flow, { text: "hello" });
    expect(r.run.status).toBe("done");
    const img = r.outputs.find((o) => (o as { type: string }).type === "image") as { mime: string; data: string } | undefined;
    expect(img?.mime).toBe("image/svg+xml");
    expect(Buffer.from(img!.data, "base64").toString("utf8")).toContain("<svg");
  }, 40_000);

  it("the counter example (Python) keeps a count and returns it", async () => {
    const flow = F.FLOW_EXAMPLES.find((e) => e.id === "counter")!.flow;
    const a = await run(flow);
    const b = await run(flow);
    expect(b.run.status).toBe("done");
    expect(texts(b.outputs)).toMatch(/Visit number \d+\./);
    const n = (o: unknown[]) => Number(/Visit number (\d+)/.exec(texts(o))![1]);
    expect(n(b.outputs)).toBe(n(a.outputs) + 1);
  }, 60_000);

  it("text, data, math, crypto and code nodes work together (JavaScript and Python)", async () => {
    for (const lang of ["js", "py"] as const) {
      const flow = F.emptyFlow(lang);
      const add = (type: string, params: Record<string, unknown> = {}, values: Record<string, unknown> = {}) => { const n = F.newNode(flow, type, flow.nodes.length * 100, 0); Object.assign(n.params!, params); Object.assign(n.values!, values); flow.nodes.push(n); return n; };
      const wire = (a: { id: string }, ap: string, b: { id: string }, bp: string) => flow.edges.push({ id: `e${flow.edges.length}`, from: { node: a.id, port: ap }, to: { node: b.id, port: bp } });
      const src = add("flow.value", { kind: "json", value: "[{\"name\":\"b\",\"n\":2},{\"name\":\"a\",\"n\":5},{\"name\":\"c\",\"n\":1}]" });
      const sorted = add("data.sort", { by: "n", desc: true, limit: 2 }); wire(src, "value", sorted, "list");
      const names = add("data.map", { expr: lang === "js" ? "item.name" : "item[\"name\"]" }); wire(sorted, "list", names, "list");
      const joined = add("text.join", { separator: "+" }); wire(names, "list", joined, "list");
      const upper = add("text.case", { mode: "upper" }); wire(joined, "text", upper, "text");
      const hash = add("crypto.hash", { alg: "sha256" }, { data: "abc" });
      const calc = add("math.calc", { op: "*" }, { a: 6, b: 7 });
      const code = add("code.block", { args: "x", code: lang === "js" ? "return x * 2;" : "return x * 2" }); wire(calc, "result", code, "x");
      const tpl = add("text.template", { template: "{u}|{h}|{c}" }); wire(upper, "result", tpl, "u"); wire(hash, "hash", tpl, "h"); wire(code, "result", tpl, "c");
      const out = add("out.text"); wire(tpl, "text", out, "text");
      const r = await run(flow);
      expect(r.run.error ?? null, lang).toBeNull();
      expect(texts(r.outputs), lang).toBe("A+B|ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad|84");
    }
  }, 90_000);
});

describe("5.3: several functions in a flow, and the new nodes", () => {
  const N = (id: string, type: string, x: number, params: Record<string, unknown> = {}, values: Record<string, unknown> = {}) => ({ id, type, x, y: 0, params: { ...F.paramsOf({ id, type, x, y: 0 }), ...params }, values });
  const E = (from: string, fp: string, to: string, tp: string) => ({ id: `${from}-${to}`, from: { node: from, port: fp }, to: { node: to, port: tp } });

  it("compiles execute and the entry point functions into one file, with their inputs", () => {
    for (const lang of ["js", "py"] as const) {
      const flow = {
        ...F.emptyFlow(lang, "demo"),
        nodes: [N("n1", "text.template", 0, { template: "Hi" }), N("n2", "out.markdown", 200), N("n3", "out.button", 400, { button: { name: "more", title: "More", css: "primary" } }, { data: "{\"page\":2}" }), N("n4", "out.form", 600), N("n5", "out.js", 800, { code: "m5.flash('x')", hidden: true })],
        edges: [E("n1", "text", "n2", "text")],
        functions: {
          button: { nodes: [N("b1", "flow.event", 0), N("b2", "model.history", 0), N("b3", "text.template", 200, { template: "clicked {name}, call {call}" }), N("b4", "out.text", 400)], edges: [E("b1", "name", "b3", "name"), E("b2", "call", "b3", "call"), E("b3", "text", "b4", "text")] },
          form: { nodes: [N("f0", "flow.input", 0, { name: "email", type: "email", required: true }), N("f1", "flow.event", 0), N("f2", "out.json", 200)], edges: [E("f1", "values", "f2", "value")] },
        },
      };
      const parsed = F.parseFlow(JSON.parse(JSON.stringify(flow)));
      expect(F.flowFunctions(parsed)).toEqual(["execute", "button", "form"]);
      const c = F.compileFlow(parsed);
      expect(c.functions.map((f) => f.name)).toEqual(["execute", "button", "form"]);
      expect(c.functions[2].inputs).toEqual([{ name: "email", type: "email", required: true }]);
      if (lang === "js") {
        expect(c.code).toMatch(/export async function execute\(inputs = \{\}\)/);
        expect(c.code).toMatch(/export async function button\(inputs = \{\}\)/);
        expect(c.code).toMatch(/m5\.out\.button\(\{ \.\.\.\{"name":"more","title":"More","css":"primary"\}, data: \{"page":2\} \}\)/);
        expect(() => new AsyncFunction(c.code.replace(/export /g, ""))).not.toThrow();
      } else {
        expect(c.code).toMatch(/async def button\(\*\*inputs\):/);
        expect(c.code).toMatch(/m5\.out\.js\("m5\.flash\('x'\)", None, hidden=True\)/);
      }
    }
  });

  it("a problem in another function is reported with its name", () => {
    const flow = { ...F.emptyFlow("js"), nodes: [N("n1", "out.text", 0, {}, { text: "hi" })], edges: [], functions: { error: { nodes: [N("e1", "out.text", 0)], edges: [] } } };
    const issues = F.checkFlow(F.parseFlow(flow));
    expect(issues.find((i) => i.fn === "error")).toMatchObject({ level: "error", node: "e1", message: expect.stringMatching(/^error: /) });
    expect(() => F.compileFlow(F.parseFlow(flow))).toThrow(/needs a wire or a value/);
  });

  it("the functions run: a click on the flow's button runs its button function in the same session", async () => {
    const flow = F.parseFlow({
      ...F.emptyFlow("js"), nodes: [N("n1", "out.button", 0, { button: { name: "go", title: "Go" } }, { data: "{\"x\":7}" })], edges: [],
      functions: { button: { nodes: [N("b1", "flow.event", 0), N("b2", "model.history", 0), N("b3", "data.object", 200, { keys: "data, type, first" }), N("b4", "flow.return", 400)], edges: [E("b1", "data", "b3", "data"), E("b2", "type", "b3", "type"), E("b2", "first", "b3", "first"), E("b3", "object", "b4", "value")] } },
    });
    const c = F.compileFlow(flow);
    const files = { [c.file]: c.code };
    const r = await runAdhoc({ lang: "js", files, entry: { file: c.file, fn: "execute" }, inputs: {} }, caller);
    expect(r.outputs[0]).toMatchObject({ type: "button", name: "go", data: { x: 7 } });
    const b = await runAdhoc({ lang: "js", files, entry: { file: c.file, fn: "button" }, inputs: { name: "go", data: { x: 7 }, event: { type: "click" } }, chainId: r.chain }, caller);
    expect(b.run.error).toBeNull();
    expect((b.values[0] as { value: { data: unknown; type: string; first: { type: string } } }).value).toMatchObject({ data: { x: 7 }, type: "button", first: { type: "execute" } });
  }, 60_000);
});
