// @vitest-environment node
// Entry points (5.3): a model's execute, response, button, form, error and
// webhooks (several, each its own URL); m5.model — the processing session with
// its calls, current and last call, its own session and cache; results as a
// list of outputs (each checked on its own, a bad one reported to the error
// entry point); the chat's /api/functions/event.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { Server } from "node:http";

const DATA = mkdtempSync(join(tmpdir(), "m5ep-"));
process.env.DATA_DIR = DATA;
process.env.FUNCTIONS_DB_FILE = join(DATA, "functions.db");
process.env.ENABLE_FUNCTIONS = "1";
process.env.FUNCTIONS_WARM = "0";

const { functionsStore, fingerprint } = await import("../server/functions/store");
const { registerFunctionsRoutes } = await import("../server/functions/routes");
const { execute, runAdhoc, closeRunner, exportedFunctions } = await import("../server/functions/runner");
const { saveModel } = await import("../server/functions/packages");
const { endpointsOf, endpointOf, normalizeEndpoints, argsToInputs, webhookByToken } = await import("../server/functions/endpoints");

const CODE = `
export async function execute(p) {
  await m5.model.session.set("topic", p.topic || "none");
  await m5.model.cache.incr("hits");
  return [
    m5.out.markdown("# Hi " + (p.topic || "")),
    { type: "flash", text: "done", level: "success" },
    m5.out.button({ name: "more", title: "More", data: { n: 1 }, css: "primary", icon: "➕" }),
    m5.out.form({ name: "ask", title: "Ask", panels: [{ title: "You", layout: "columns", columns: 2, fields: [{ name: "email", type: "email", required: true }, { name: "tier", type: "select", options: [{ value: "a", label: "A", icon: "🅰️" }] }] }] }),
    { type: "js", code: "m5.flash('hi from the browser')", args: { a: 1 } },
  ];
}
export async function button({ name, data, event }) {
  return [m5.out.json({
    name, n: data.n, event: event.type, type: m5.model.type, call: m5.model.call,
    first: m5.model.calls[0].type, last: m5.model.last.type, lastResultItems: Array.isArray(m5.model.last.result) ? m5.model.last.result.length : -1,
    topic: await m5.model.session.get("topic"), hits: await m5.model.cache.get("hits"),
  })];
}
export async function form({ name, values, email }) { return m5.out.text("form " + name + " " + values.email + " " + email); }
export async function response({ text, message, host }) { return m5.out.text("reply " + text + " / host=" + host + " / to call " + message.call); }
export async function bad() { return [m5.out.text("fine"), { type: "button", title: "no name" }, { type: "flash", text: "also fine" }]; }
export async function boom() { throw new Error("kaboom"); }
export async function error({ error, failed, source }) { return m5.out.text("sorry: " + error.message + " (" + failed.type + ", " + source + ")"); }
export async function hook(p) { return { got: p.amount, hookName: p._webhook.name, http: m5.model.current.http.method, get: m5.model.current.http.get.q }; }
`;

let server: Server;
let base = "";
beforeAll(async () => {
  await functionsStore.ready();
  const now = Date.now();
  const files = { "index.js": CODE };
  functionsStore.savePackage({ id: "pkg_ep", name: "ep", language: "js", description: "", draft: null, createdAt: now, updatedAt: now, updatedBy: "op" });
  functionsStore.saveVersion({ packageId: "pkg_ep", version: "1.0.0", manifest: { name: "ep", version: "1.0.0", language: "js", main: "index.js", dependencies: {}, description: "" }, files, fingerprint: fingerprint(files), status: "published", test: null, createdAt: now, createdBy: "op", publishedAt: now });
  saveModel({
    id: "ep-model", name: "Endpoints", keyword: "ep", entry: "ep@1.0.0:index.js#execute", runtime: "server", enabled: true,
    inputs: [{ name: "topic", type: "string" }],
    executors: { chat: { enabled: true, visibility: "caller" }, console: { enabled: true } },
    endpoints: [
      { id: "execute", type: "execute", fn: "index.js#execute", inputs: [{ name: "topic", type: "string" }], enabled: true },
      { id: "button", type: "button", fn: "index.js#button", inputs: [], enabled: true },
      { id: "form", type: "form", fn: "index.js#form", inputs: [{ name: "email", type: "email", required: true }], enabled: true },
      { id: "response", type: "response", fn: "index.js#response", inputs: [{ name: "host", type: "string" }], enabled: true },
      { id: "error", type: "error", fn: "index.js#error", inputs: [], enabled: true },
      { id: "x", type: "webhook", name: "Payments", fn: "index.js#hook", inputs: [{ name: "amount", type: "number", required: true }], enabled: true, mode: "sync" },
      { id: "y", type: "webhook", name: "Other", fn: "index.js#hook", inputs: [], enabled: true },
    ] as never,
  }, "op");
  const app = express();
  registerFunctionsRoutes(app);
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => { server?.close(); closeRunner(); });

const user = { kind: "user" as const, account: "a1", name: "alice", groups: ["user"], room: "r1", client: "c1", lang: "en", tz: "UTC" };
const model = () => functionsStore.model("ep-model")!;
const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("entry points on a model", () => {
  it("are saved: unique types once, webhooks with their own tokens; execute mirrors entry and inputs", () => {
    const m = model();
    const eps = endpointsOf(m);
    expect(eps.map((e) => e.type)).toEqual(["execute", "button", "form", "response", "error", "webhook", "webhook"]);
    const hooks = eps.filter((e) => e.type === "webhook");
    expect(hooks[0].token).toBeTruthy();
    expect(hooks[1].token).toBeTruthy();
    expect(hooks[0].token).not.toBe(hooks[1].token);
    expect(m.entry).toBe("ep@1.0.0:index.js#execute");
    expect(m.executors.webhook?.token).toBe(hooks[0].token); // the first, for older readers
    expect(webhookByToken(m, hooks[1].token!)?.name).toBe("Other");
    expect(() => normalizeEndpoints([{ type: "button", fn: "index.js#a" }, { type: "button", fn: "index.js#b" }], [])).toThrow(/one button/);
    expect(() => normalizeEndpoints([{ type: "form", fn: "no-hash" }], [])).toThrow(/file#function/);
    // A save that sends the list keeps a webhook's token and secret when the console could not see them.
    const again = saveModel({ id: "ep-model", endpoints: eps.map(({ token: _t, secret: _s, ...e }) => e) as never }, "op");
    expect(endpointsOf(again).filter((e) => e.type === "webhook").map((e) => e.token)).toEqual(hooks.map((h) => h.token));
  });

  it("a model from before 5.3: execute from entry + inputs, its webhook from executors.webhook", () => {
    const old = { entry: "ep@1.0.0:index.js#execute", inputs: [{ name: "q", type: "string" as const }], executors: { chat: { enabled: true, visibility: "room" as const }, console: { enabled: true }, webhook: { enabled: true, token: "tok-old" } } };
    const eps = endpointsOf(old);
    expect(eps[0]).toMatchObject({ type: "execute", fn: "index.js#execute", inputs: [{ name: "q" }] });
    expect(eps[1]).toMatchObject({ type: "webhook", token: "tok-old" });
  });

  it("a reply's text fills the declared inputs like command arguments", () => {
    expect(argsToInputs([{ name: "host", type: "string" }, { name: "type", type: "string" }], "example.com type=MX")).toEqual({ host: "example.com", type: "MX" });
  });

  it("the package's exported functions (the console's picker)", () => {
    expect(exportedFunctions("js", CODE)).toEqual(expect.arrayContaining(["execute", "button", "form", "response", "error", "hook"]));
    expect(exportedFunctions("py", "async def execute(**k):\n    pass\ndef _private():\n    pass\ndef button(name, data=None, **k):\n    pass\n")).toEqual(["execute", "button"]);
  });
});

describe("a list result, m5.model and the events", () => {
  let chain = "";
  it("execute returns a list: every item is an output, the session opens with call 0", async () => {
    const r = await execute(model(), { topic: "dns" }, user, { executor: "chat" });
    expect(r.run.error).toBeNull();
    expect(r.values.map((o) => o.type)).toEqual(["markdown", "flash", "button", "form", "js"]);
    expect(r.values[2]).toMatchObject({ type: "button", name: "more", title: "More", data: { n: 1 }, css: "primary", icon: "➕" });
    expect(r.values[3]).toMatchObject({ type: "form", name: "ask", panels: [{ layout: "columns", columns: 2 }] });
    expect(r.call).toBe(0);
    chain = r.chain;
    const c = functionsStore.chain(chain)!;
    expect(c.calls[0]).toMatchObject({ id: 0, type: "execute", status: "done", err_msg: "", parms: { topic: "dns" } });
    expect(Array.isArray(c.calls[0].result)).toBe(true);
    expect(r.run.chainId).toBe(chain);
  }, 30_000);

  it("a click runs the button entry point in the same session: calls, current, last, its session and cache", async () => {
    const res = await post("/api/functions/event", { keyword: "ep", chain, call: 0, type: "button", name: "more", data: { n: 1 } });
    const d = await res.json();
    expect(res.status).toBe(200);
    expect(d.outputs[0].value).toMatchObject({ name: "more", n: 1, event: "click", type: "button", call: 1, first: "execute", last: "execute", lastResultItems: 5, topic: "dns", hits: 1 });
    expect(d).toMatchObject({ chain, call: 1, events: expect.arrayContaining(["button", "form", "response", "error"]) });
  }, 30_000);

  it("a form: the declared inputs are read from its values and checked", async () => {
    const ok = await (await post("/api/functions/event", { keyword: "ep", chain, type: "form", name: "ask", values: { email: "a@b.cz" } })).json();
    expect(ok.outputs[0].text).toBe("form ask a@b.cz a@b.cz");
    const bad = await post("/api/functions/event", { keyword: "ep", chain, type: "form", name: "ask", values: { email: "nope" } });
    expect(bad.status).toBe(400);
    expect((await bad.json()).message).toMatch(/e-mail/);
  }, 30_000);

  it("a reply calls the response entry point with the text (and the inputs read from it)", async () => {
    const d = await (await post("/api/functions/event", { keyword: "ep", chain, type: "response", text: "example.org", message: { text: "Hi dns" }, call: 0 })).json();
    expect(d.outputs[0].text).toBe("reply example.org / host=example.org / to call 0");
  }, 30_000);

  it("an unknown or expired session is refused (410)", async () => {
    const res = await post("/api/functions/event", { keyword: "ep", chain: "chn_nope", type: "button", name: "x" });
    expect(res.status).toBe(410);
  });

  it("a bad item in a result is left out, logged — and the error entry point answers", async () => {
    const m = model();
    const bad = { id: "execute", type: "execute" as const, fn: "index.js#bad", inputs: [], enabled: true };
    const r = await execute(m, {}, user, { executor: "chat", endpoint: bad });
    expect(r.values.map((o) => o.type)).toEqual(["text", "flash"]);
    expect(r.handled?.outputs[0]).toMatchObject({ type: "text", text: expect.stringMatching(/^sorry: result\[1\]: button: a button needs a name/) });
    const logs = functionsStore.logs(r.run.id).map((l) => l.msg);
    expect(logs.some((m) => /result\[1\] was left out/.test(m))).toBe(true);
    expect(functionsStore.chain(r.chain)!.calls[0].err_msg).toMatch(/result\[1\]/);
  }, 30_000);

  it("a function that throws: the error entry point answers in the same session", async () => {
    const boom = { id: "execute", type: "execute" as const, fn: "index.js#boom", inputs: [], enabled: true };
    const r = await execute(model(), {}, user, { executor: "chat", endpoint: boom });
    expect(r.run.status).toBe("failed");
    expect(r.handled?.outputs[0]).toMatchObject({ text: "sorry: kaboom (execute, server)" });
    const c = functionsStore.chain(r.chain)!;
    expect(c.calls.map((x) => [x.type, x.status])).toEqual([["execute", "failed"], ["error", "done"]]);
    expect(c.calls[0].err_msg).toBe("kaboom");
  }, 30_000);

  it("the browser reports an output it could not show: logged in the run, the error entry point answers", async () => {
    const d = await (await post("/api/functions/event", { keyword: "ep", chain, call: 0, type: "error", error: { type: "RenderError", message: "audio failed" }, output: 2 })).json();
    expect(d.outputs[0].text).toBe("sorry: audio failed (execute, client)");
    const run0 = functionsStore.chain(chain)!.calls[0].run;
    expect(functionsStore.logs(run0).some((l) => /^browser: RenderError: audio failed/.test(l.msg))).toBe(true);
  }, 30_000);
});

describe("webhooks as entry points", () => {
  it("each webhook has its URL and function; declared JSON inputs are checked; m5.model.current.http", async () => {
    const hooks = endpointsOf(model()).filter((e) => e.type === "webhook");
    const url = (i: number, q = "") => `${base}/hooks/m/ep-model/${hooks[i].token}${q}`;
    const ok = await (await fetch(url(0, "?q=1"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amount: "12.5" }) })).json();
    expect(ok.outputs[0].value).toEqual({ got: 12.5, hookName: "Payments", http: "POST", get: "1" });
    const missing = await fetch(url(0), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(missing.status).toBe(400);
    const other = await (await fetch(url(1), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amount: 3 }) })).json();
    expect(other.outputs[0].value.hookName).toBe("Other");
    const chain = functionsStore.chain(other.chain)!;
    expect(chain.calls[0]).toMatchObject({ type: "webhook", http: { method: "POST", url: expect.stringContaining("/hooks/m/ep-model/") } });
    expect(chain.calls[0].http!.url).not.toContain(hooks[1].token!);
    const wrong = await fetch(`${base}/hooks/m/ep-model/not-a-token`, { method: "POST", body: "{}" });
    expect(wrong.status).toBe(403);
  }, 30_000);
});

describe("a draft run (the console) has a session too", () => {
  it("its button function answers a click in the same session", async () => {
    const r = await runAdhoc({ lang: "js", files: { "index.js": CODE }, entry: { file: "index.js", fn: "execute" }, inputs: { topic: "draft" } }, { ...user, kind: "console" });
    expect(r.values.length).toBe(5);
    const r2 = await runAdhoc({ lang: "js", files: { "index.js": CODE }, entry: { file: "index.js", fn: "button" }, inputs: { name: "more", data: { n: 7 }, event: { type: "click" } }, chainId: r.chain }, { ...user, kind: "console" });
    expect((r2.values[0] as { value: { n: number; type: string; last: string; topic: string } }).value).toMatchObject({ n: 7, type: "button", last: "execute", topic: "draft" });
    expect(endpointOf(model(), "form")?.fn).toBe("index.js#form");
  }, 30_000);
});
