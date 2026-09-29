// @vitest-environment node
// Webhooks, logged and replayable (5.2): bodies of every kind become inputs
// (JSON, a form, multipart with a file), secrets are masked in the log, the
// sync / async / auto modes (a status URL, a callback), a run that asks is
// answered through the webhook, and the console replays a call — on the
// published version and on the draft.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const DATA = mkdtempSync(join(tmpdir(), "m5whl-"));
process.env.DATA_DIR = DATA;
process.env.FUNCTIONS_DB_FILE = join(DATA, "functions.db");
process.env.ENABLE_FUNCTIONS = "1";
process.env.FUNCTIONS_WARM = "0";
process.env.FUNCTIONS_HTTP_ALLOW_LOCAL = "1";
process.env.WEBHOOK_AUTO_WAIT_MS = "400";

const { functionsStore, fingerprint } = await import("../server/functions/store");
const { registerFunctionsRoutes } = await import("../server/functions/routes");
const { registerFunctionsAdminRoutes } = await import("../server/functions/admin-routes");
const { closeRunner } = await import("../server/functions/runner");
const { saveModel } = await import("../server/functions/packages");
const W = await import("../server/functions/webhook-log");
const { clientConfigStore } = await import("../server/client-config");

const CODE = `export async function execute(p) {
  if (p.slow) await m5.sleep(Number(p.slow));
  if (p.ask) { const a = await m5.prompt({ text: "Go on?", choices: ["yes", "no"] }); return m5.out.text("answer " + a); }
  return m5.out.json({ name: p.name ?? null, file: p.doc ? p.doc.filename + ":" + p.doc.size : null, method: p._webhook.method, q: p.q ?? null, auth: p._webhook.headers.authorization ?? null });
}`;

let server: Server;
let base = "";
let catcher: Server;
let catchUrl = "";
const caught: unknown[] = [];

const tokenOf = (id: string) => functionsStore.model(id)!.executors.webhook!.token!;
const hook = (id: string, suffix = "") => `${base}/hooks/m/${id}/${encodeURIComponent(tokenOf(id))}${suffix}`;
const admin = (path: string, init: { method?: string; body?: unknown } = {}) => fetch(`${base}/admin/functions${path}`, { method: init.method ?? "GET", headers: { "content-type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body) }).then((r) => r.json() as Promise<Record<string, any>>);
/** Polls a status URL until `done` says so. */
const poll = async (url: string, done: (j: any) => boolean, ms = 20_000): Promise<any> => {
  const until = Date.now() + ms;
  for (;;) { const j = await (await fetch(url)).json(); if (done(j)) return j; if (Date.now() > until) throw new Error(`timed out: ${JSON.stringify(j)}`); await new Promise((r) => setTimeout(r, 80)); }
};
const waitFor = async <T>(fn: () => T | null | undefined | false, ms = 20_000): Promise<T> => {
  const until = Date.now() + ms;
  for (;;) { const v = fn(); if (v) return v; if (Date.now() > until) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 50)); }
};

beforeAll(async () => {
  await functionsStore.ready();
  const now = Date.now();
  const files = { "index.js": CODE };
  functionsStore.savePackage({ id: "pkg_w", name: "wh", language: "js", description: "", draft: null, createdAt: now, updatedAt: now, updatedBy: "op" });
  functionsStore.saveVersion({ packageId: "pkg_w", version: "1.0.0", manifest: { name: "wh", version: "1.0.0", language: "js", main: "index.js", dependencies: {}, description: "" }, files, fingerprint: fingerprint(files), status: "published", test: null, createdAt: now, createdBy: "op", publishedAt: now });
  // The draft differs (for the replay on the draft).
  const draft = { "index.js": CODE.replace("name: p.name ?? null", "name: 'DRAFT ' + (p.name ?? '')") };
  functionsStore.saveVersion({ packageId: "pkg_w", version: "draft", manifest: { name: "wh", version: "draft", language: "js", main: "index.js", dependencies: {}, description: "" }, files: draft, fingerprint: fingerprint(draft), status: "draft", test: null, createdAt: now, createdBy: "op", publishedAt: null });
  const mk = (id: string, mode: "sync" | "async" | "auto", callback = false) => saveModel({ id, name: id, entry: "wh@1.0.0:index.js#execute", runtime: "server", inputs: [], executors: { chat: { enabled: false, visibility: "room" }, console: { enabled: true }, webhook: { enabled: true, mode, callback }, api: { enabled: true } }, enabled: true }, "op");
  mk("h-sync", "sync"); mk("h-async", "async"); mk("h-auto", "auto", true);
  const app = express();
  app.use((req, res, next) => { res.locals.adminName = "tester"; res.locals.adminRole = String(req.headers["x-role"] || "owner"); next(); });
  registerFunctionsRoutes(app);
  registerFunctionsAdminRoutes(app);
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  catcher = createServer((req, res) => { let b = ""; req.on("data", (d) => { b += d; }); req.on("end", () => { caught.push(JSON.parse(b || "null")); res.end("ok"); }); });
  await new Promise<void>((r) => catcher.listen(0, "127.0.0.1", () => r()));
  catchUrl = `http://127.0.0.1:${(catcher.address() as AddressInfo).port}/cb`;
});
afterAll(() => { server?.close(); catcher?.close(); closeRunner(); });

describe("bodies", () => {
  it("parses JSON, forms, multipart (with a file), text and binary", () => {
    expect(W.parseBody(Buffer.from('{"a":1}'), "application/json")).toEqual({ kind: "json", value: { a: 1 } });
    expect(W.parseBody(Buffer.from("a=1&b=x&b=y"), "application/x-www-form-urlencoded")).toEqual({ kind: "form", value: { a: "1", b: ["x", "y"] } });
    const mp = Buffer.from("--XX\r\nContent-Disposition: form-data; name=\"name\"\r\n\r\nAda\r\n--XX\r\nContent-Disposition: form-data; name=\"doc\"; filename=\"a.txt\"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--XX--\r\n");
    const p = W.parseBody(mp, "multipart/form-data; boundary=XX");
    expect(p.kind).toBe("multipart");
    expect((p.value as any).name).toBe("Ada");
    expect((p.value as any).doc).toMatchObject({ filename: "a.txt", mime: "text/plain", size: 5 });
    expect(W.parseBody(Buffer.from("plain words"), "text/plain")).toEqual({ kind: "text", value: "plain words" });
    expect(W.parseBody(Buffer.from([0, 1, 2, 255]), "application/octet-stream").kind).toBe("binary");
    expect(W.logHeaders({ Authorization: "Bearer secret", "X-Test": "1" })).toEqual({ authorization: "•••• (13 chars)", "x-test": "1" });
  });

  it("maps a body to inputs: flat, {inputs: …}, query parameters underneath", () => {
    const q = { type: "MX", wait: "1", callback: "https://x.test/" };
    expect(W.inputsOf({ kind: "json", value: { name: "a.cz" } }, q)).toEqual({ type: "MX", name: "a.cz" });
    expect(W.inputsOf({ kind: "json", value: { inputs: { name: "b.cz", type: "NS" } } }, q)).toEqual({ type: "NS", name: "b.cz" });
    expect(W.inputsOf({ kind: "form", value: { inputs: "text" } }, {})).toEqual({ inputs: "text" });
    expect(W.inputsOf({ kind: "text", value: "hi" }, {})).toEqual({ body: "hi" });
  });
});

describe("a model webhook", () => {
  it("sync: JSON in, outputs out; the log keeps the call with secrets masked", async () => {
    const res = await fetch(hook("h-sync", "?q=from-query"), { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer top-secret" }, body: JSON.stringify({ name: "Ada" }) });
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r.outputs[0].value).toMatchObject({ name: "Ada", method: "POST", q: "from-query", auth: null }); // no credentials reach the function
    const calls = await admin("/webhooks/calls?model=h-sync");
    expect(calls.calls[0]).toMatchObject({ kind: "model", status: 200, method: "POST" });
    expect(calls.calls[0].path).not.toContain(tokenOf("h-sync"));
    const d = await admin(`/webhooks/calls/${calls.calls[0].id}`);
    expect(d.call.headers.authorization).toMatch(/^••••/);
    expect(d.call.parsed).toEqual({ kind: "json", value: { name: "Ada" } });
    expect(d.variables).toEqual(expect.arrayContaining([expect.objectContaining({ path: "body.name", value: "Ada" }), expect.objectContaining({ path: "query.q", value: "from-query" })]));
    expect(JSON.parse(d.call.responseBody).outputs[0].value.name).toBe("Ada");
  }, 30_000);

  it("a form and multipart with a file become inputs", async () => {
    const form = await (await fetch(hook("h-sync"), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "name=Grace" })).json();
    expect(form.outputs[0].value.name).toBe("Grace");
    const fd = new FormData();
    fd.set("name", "Linus");
    fd.set("doc", new Blob(["12345"], { type: "text/plain" }), "notes.txt");
    const mp = await (await fetch(hook("h-sync"), { method: "POST", body: fd })).json();
    expect(mp.outputs[0].value).toMatchObject({ name: "Linus", file: "notes.txt:5" });
  }, 30_000);

  it("a wrong token is refused — and logged", async () => {
    const res = await fetch(`${base}/hooks/m/h-sync/not-the-token-000000000000`, { method: "POST", body: "{}" });
    expect(res.status).toBe(403);
    const calls = await admin("/webhooks/calls?model=h-sync&status=error");
    expect(calls.calls.some((c: { status: number }) => c.status === 403)).toBe(true);
  });

  it("async: 202 with a status URL; the status gives the outputs", async () => {
    const res = await fetch(hook("h-async"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Async" }) });
    expect(res.status).toBe(202);
    const r = await res.json();
    expect(r.statusUrl).toContain(`/runs/${r.runId}`);
    const last = await poll(`${base}${new URL(r.statusUrl, base).pathname}`, (j) => j.status === "done");
    expect(last.outputs[0].value.name).toBe("Async");
  }, 30_000);

  it("auto: answers in time when quick, else 202 — and calls back", async () => {
    const quick = await fetch(hook("h-auto"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Quick" }) });
    expect(quick.status).toBe(200);
    const slow = await fetch(hook("h-auto", `?callback=${encodeURIComponent(catchUrl)}`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Slow", slow: 1200 }) });
    expect(slow.status).toBe(202);
    const got = await waitFor(() => caught.find((c: any) => c && c.outputs && c.outputs[0]?.value?.name === "Slow") as any);
    expect(got.status).toBe("done");
    // The log keeps the 202 and, later, the run's result and the callback's answer.
    const call = await waitFor(() => functionsStore.webhookCalls({ modelId: "h-auto" }).find((c) => c.status === 202 && c.result));
    expect(call.result).toMatchObject({ status: "done", callback: { url: catchUrl, status: 200 } });
  }, 30_000);

  it("secrets stay out of the log and the stored run: secret headers, the token in the status URL", async () => {
    const r = await (await fetch(hook("h-async"), { method: "POST", headers: { "content-type": "application/json", "x-gitlab-token": "gl-secret-123", "stripe-signature": "t=1,v1=abc" }, body: JSON.stringify({ name: "Sec" }) })).json();
    const call = await waitFor(() => functionsStore.webhookCalls({ modelId: "h-async" }).find((c) => c.runId === r.runId));
    expect(call.headers["x-gitlab-token"]).toMatch(/^••••/);
    expect(call.headers["stripe-signature"]).toMatch(/^••••/);
    expect(call.responseBody).toContain("statusUrl");
    expect(call.responseBody).not.toContain(tokenOf("h-async"));
    const run = await waitFor(() => { const x = functionsStore.run(r.runId); return x && x.status === "done" ? x : null; });
    expect((run.inputs as any)._webhook.headers["x-gitlab-token"]).toMatch(/^••••/); // the function saw it; the record does not keep it
  }, 30_000);

  it("log: meta keeps neither bodies nor outputs", async () => {
    await admin("/webhooks/h-async", { method: "PUT", body: { log: "meta" } });
    const r = await (await fetch(hook("h-async", "?wait=1"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Metadata-only" }) })).json();
    expect(r.outputs[0].value.name).toBe("Metadata-only");
    const call = functionsStore.webhookCalls({ modelId: "h-async" }).find((c) => c.runId === r.runId)!;
    expect(call.body).toBe("");
    expect(call.responseBody).not.toContain("Metadata-only");
    expect(JSON.parse(call.responseBody)).toMatchObject({ ok: true, status: "done" });
    await admin("/webhooks/h-async", { method: "PUT", body: { log: "full" } });
  }, 30_000);

  it("a webhook cannot answer a question of a run it did not start", async () => {
    // A chat user's run of the same model: the webhook's token does not reach it (404, not "question not open").
    const any = functionsStore.runs({ modelId: "h-async", limit: 1 })[0];
    functionsStore.saveRun({ ...any, id: "run_chat_test", executor: "chat", status: "waiting", finishedAt: null });
    const res = await fetch(hook("h-async", "/runs/run_chat_test/answer"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ interaction: "int_x", value: "yes" }) });
    expect(res.status).toBe(404);
    expect((await fetch(hook("h-async", "/runs/run_chat_test"))).status).toBe(404);
  });

  it("the Functions module switched off stops the API as well", async () => {
    const tok = functionsStore.model("h-sync")!.executors.api!.token!;
    const call = () => fetch(`${base}/api/functions/call/h-sync`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify({ name: "API" }) });
    expect((await call()).status).not.toBe(403); // (the test function expects a webhook, so it fails — but it runs)
    clientConfigStore.set({ modules: { functions: { enabled: false } } });
    try { expect((await call()).status).toBe(403); } finally { clientConfigStore.set({}); }
  }, 30_000);

  it("a run that asks is answered through the webhook", async () => {
    const r = await (await fetch(hook("h-async"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ask: true }) })).json();
    const path = new URL(r.statusUrl, base).pathname;
    const st = await poll(`${base}${path}`, (j) => j.questions && j.questions.length > 0);
    expect(st.questions[0].spec.text).toBe("Go on?");
    const ans = await fetch(`${base}${path}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ interaction: st.questions[0].id, value: "yes" }) });
    expect(ans.status).toBe(200);
    const done = await poll(`${base}${path}`, (j) => j.status === "done");
    expect(done.outputs[0].text).toBe("answer yes");
  }, 30_000);
});

describe("the console", () => {
  it("lists the endpoints with their mode and stats", async () => {
    const d = await admin("/webhooks");
    const e = d.endpoints.find((x: { modelId: string }) => x.modelId === "h-auto");
    expect(e).toMatchObject({ enabled: true, mode: "auto", callback: true, log: "full" });
    expect(e.url).toContain(`/hooks/m/h-auto/`);
    expect(e.stats.calls).toBeGreaterThan(0);
  });

  it("changes a webhook: mode, log, a new URL", async () => {
    const before = tokenOf("h-sync");
    const r = await admin("/webhooks/h-sync", { method: "PUT", body: { mode: "auto", log: "meta", rotate: true } });
    expect(r.model.executors.webhook).toMatchObject({ mode: "auto", log: "meta" });
    expect(tokenOf("h-sync")).not.toBe(before);
    await admin("/webhooks/h-sync", { method: "PUT", body: { mode: "sync", log: "full" } });
  });

  it("replays a call on the published version and on the draft", async () => {
    const calls = await admin("/webhooks/calls?model=h-sync&status=ok");
    const src = calls.calls.find((c: { parsed: { kind: string } | null }) => c.parsed?.kind === "json");
    const pub = await admin(`/webhooks/calls/${src.id}/replay`, { method: "POST", body: { target: "published" } });
    const runP = await waitFor(() => { const run = functionsStore.run(pub.runId); return run && run.status !== "running" ? run : null; });
    expect(runP.status).toBe("done");
    expect((runP.outputs[0] as { value: { name: string } }).value.name).toBe("Ada");
    const dr = await admin(`/webhooks/calls/${src.id}/replay`, { method: "POST", body: { target: "draft" } });
    const runD = await waitFor(() => { const run = functionsStore.run(dr.runId); return run && run.status !== "running" ? run : null; });
    expect((runD.outputs[0] as { value: { name: string } }).value.name).toBe("DRAFT Ada");
    const replays = await waitFor(() => { const list = functionsStore.webhookCalls({ kind: "replay" }); return list.length >= 2 && list.every((c) => c.status === 200) ? list : null; });
    expect(replays[0].replayOf).toBe(src.id);
  }, 40_000);

  it("only a model webhook's calls replay; auditors see no tokens", async () => {
    const src = functionsStore.webhookCalls({ modelId: "h-sync" })[0];
    functionsStore.addWebhookCall({ ...src, id: "whc_durable_test", kind: "durable" });
    const res = await fetch(`${base}/admin/functions/webhooks/calls/whc_durable_test/replay`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(409);
    const asAuditor = await (await fetch(`${base}/admin/functions`, { headers: { "x-role": "auditor" } })).json();
    const m = asAuditor.models.find((x: { id: string }) => x.id === "h-sync");
    expect(m.secretsHidden).toBe(true);
    expect(m.executors.webhook.token).toBeUndefined();
    expect(m.executors.api.token).toBeUndefined();
    expect(JSON.stringify(asAuditor)).not.toContain(tokenOf("h-sync"));
    const hooks = await (await fetch(`${base}/admin/functions/webhooks`, { headers: { "x-role": "auditor" } })).json();
    expect(hooks.endpoints.find((e: { modelId: string }) => e.modelId === "h-sync")).toMatchObject({ url: null, hidden: true });
  });

  it("a failed run keeps its error in the log; old calls are pruned with the runs", async () => {
    const refused = functionsStore.webhookCalls({ status: "error" }).find((c) => c.status === 403);
    expect(refused?.error).toBe("Wrong webhook token.");
    expect(functionsStore.webhookCalls({}).length).toBeGreaterThan(0);
    functionsStore.prune(Date.now() + 60_000);
    expect(functionsStore.webhookCalls({})).toHaveLength(0);
  });
});
