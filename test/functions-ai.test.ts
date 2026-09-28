// @vitest-environment node
// m5.ai (4.15, stage 5): a function reaches the instance's AI layer, as its
// own caller (counted, limited, journaled). A mock provider stands in for a
// real model.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STORAGE_MASTER_KEY = "a".repeat(64);
process.env.FUNCTIONS_DATA_DIR = join(mkdtempSync(join(tmpdir(), "m5ai-")), "functions");
process.env.FUNCTIONS_WARM = "0";

const { defaultAiConfig, saveAiConfig, sealKey } = await import("../server/ai/config");
const { setPluginSwitches } = await import("../server/plugins/settings");
const { runAdhoc, runEvents, answerRun, closeRunner } = await import("../server/functions/runner");
const { functionsStore } = await import("../server/functions/store");
const { mockProvider, json } = await import("./helpers/mock-ai");
type MockProvider = Awaited<ReturnType<typeof mockProvider>>;

let mock: MockProvider;
const caller = { kind: "user" as const, account: "acc1", name: "Mike", groups: ["user"], room: "r1", client: "c1", lang: "cs", tz: "UTC" };

beforeAll(async () => { mock = await mockProvider(); await functionsStore.ready(); });
afterAll(async () => { await mock.close(); closeRunner(); });

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "m5ai-cfg-"));
  process.env.DATA_DIR = dir;
  process.env.PLUGINS_SETTINGS_FILE = join(dir, "plugins.json");
  process.env.AI_DATA_DIR = join(dir, "ai");
  const c = defaultAiConfig();
  saveAiConfig({
    ...c,
    providers: [{
      id: "local", type: "openai-compatible", label: "Local", baseUrl: `${mock.url}/v1`, ...sealKey("local", "sk-1"), enabled: true, groups: ["user"],
      models: [{ id: "m1", label: "Model One", kind: "chat", enabled: true, caps: { stream: true, reasoning: "none", noSampling: false, vision: false, json: false, tools: false }, price: { in: 1, out: 2 }, source: "manual" }],
      source: "console", createdAt: 1, updatedAt: 1, updatedBy: "t",
    }],
    defaults: { ...c.defaults, chat: "local/m1" },
    limits: { ...c.limits, monthlyTokens: 1_000_000 },
  }, "test");
  setPluginSwitches({ ai: true }, "test");
  mock.seen.length = 0;
});

describe("m5.ai.chat", () => {
  it("asks the model and returns the answer", async () => {
    mock.on("POST /v1/chat/completions", (_q, res) => json(res, 200, { model: "m1", choices: [{ message: { content: "Ahoj světe" }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 4 } }));
    const code = "export async function execute({ q }) { const r = await m5.ai.chat({ messages: [{ role:'user', content: q }] }); return m5.out.json({ text: r.text, model: r.model, inTok: r.usage.input }); }";
    const r = await runAdhoc({ lang: "js", files: { "index.js": code }, entry: { file: "index.js", fn: "execute" }, inputs: { q: "Ahoj" } }, caller);
    expect(r.run.status).toBe("done");
    const v = (r.value as { value: { text: string; model: string; inTok: number } }).value;
    expect(v.text).toBe("Ahoj světe");
    expect(v.inTok).toBe(12);
    // The function's call reached the provider.
    expect(mock.seen.some((s) => s.path === "/v1/chat/completions")).toBe(true);
  }, 30_000);

  it("lists the models the caller may use", async () => {
    const code = "export async function execute(){ const ms = await m5.ai.models(); return m5.out.json({ n: ms.length, first: ms[0] && ms[0].ref }); }";
    const r = await runAdhoc({ lang: "js", files: { "index.js": code }, entry: { file: "index.js", fn: "execute" }, inputs: {} }, caller);
    expect((r.value as { value: { n: number; first: string } }).value).toEqual({ n: 1, first: "local/m1" });
  }, 30_000);

  it("runs an agent with two tools and an approval", async () => {
    // The model asks for one tool, then a second (which needs approval), then finishes.
    const script = [
      JSON.stringify({ tool: "add", args: { a: 2, b: 3 } }),
      JSON.stringify({ tool: "mul", args: { a: 5, b: 10 } }),
      JSON.stringify({ final: "the answer is 50" }),
    ];
    let call = 0;
    mock.on("POST /v1/chat/completions", (_q, res) => json(res, 200, { model: "m1", choices: [{ message: { content: script[Math.min(call++, script.length - 1)] }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } }));
    // Auto-approve the one tool that asks.
    const onRun = (ev: { type?: string; runId?: string; interaction?: { id: string } }) => { if (ev.type === "interaction" && ev.runId && ev.interaction) answerRun(ev.runId, ev.interaction.id, "yes"); };
    runEvents.on("run", onRun);
    try {
      const code = `
export async function execute() {
  const steps = [];
  const tools = [
    { name: 'add', description: 'a+b', run: ({a,b}) => a + b },
    { name: 'mul', description: 'a*b', approve: true, run: ({a,b}) => a * b },
  ];
  const r = await m5.ai.agent('compute please', { tools });
  return m5.out.json({ answer: r.answer, tools: r.steps.map(s => s.tool), results: r.steps.map(s => s.result) });
}`;
      const r = await runAdhoc({ lang: "js", files: { "index.js": code }, entry: { file: "index.js", fn: "execute" }, inputs: {}, limits: { wallMs: 15000 } }, caller);
      expect(r.run.status).toBe("done");
      const v = (r.value as { value: { answer: string; tools: string[]; results: number[] } }).value;
      expect(v.answer).toBe("the answer is 50");
      expect(v.tools).toEqual(["add", "mul"]);
      expect(v.results).toEqual([5, 50]);
    } finally {
      runEvents.off("run", onRun);
    }
  }, 30_000);

  it("runs a Python agent with a tool", async () => {
    const script = [JSON.stringify({ tool: "double", args: { n: 21 } }), JSON.stringify({ final: "done: 42" })];
    let call = 0;
    mock.on("POST /v1/chat/completions", (_q, res) => json(res, 200, { model: "m1", choices: [{ message: { content: script[Math.min(call++, script.length - 1)] }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } }));
    const code = [
      "async def execute():",
      "    def double(args): return args['n'] * 2",
      "    tools = [{'name': 'double', 'description': 'n*2', 'run': double}]",
      "    r = await m5.ai.agent('go', tools=tools)",
      "    return m5.out.json({'answer': r['answer'], 'tools': [s['tool'] for s in r['steps']], 'results': [s['result'] for s in r['steps']]})",
    ].join("\n");
    const r = await runAdhoc({ lang: "py", files: { "main.py": code }, entry: { file: "main.py", fn: "execute" }, inputs: {}, limits: { wallMs: 20000 } }, caller);
    expect(r.run.status).toBe("done");
    const v = (r.value as { value: { answer: string; tools: string[]; results: number[] } }).value;
    expect(v.answer).toBe("done: 42");
    expect(v.tools).toEqual(["double"]);
    expect(v.results).toEqual([42]);
  }, 60_000);

  it("surfaces a refusal (AI off) to the function", async () => {
    setPluginSwitches({ ai: false }, "test");
    const code = "export async function execute(){ try { await m5.ai.chat('hi'); return m5.out.text('ok'); } catch (e) { return m5.out.text('refused:' + e.code); } }";
    const r = await runAdhoc({ lang: "js", files: { "index.js": code }, entry: { file: "index.js", fn: "execute" }, inputs: {} }, caller);
    expect((r.value as { text: string }).text).toMatch(/^refused:/);
  }, 30_000);
});
