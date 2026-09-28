// @vitest-environment node
// Schedules, durable on_event and the API token (4.15, stage 4).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { Server } from "node:http";

process.env.FUNCTIONS_DATA_DIR = join(mkdtempSync(join(tmpdir(), "m5sch-")), "functions");
process.env.ENABLE_FUNCTIONS = "1";
process.env.FUNCTIONS_WARM = "0";

const { functionsStore, fingerprint } = await import("../server/functions/store");
const { registerFunctionsRoutes } = await import("../server/functions/routes");
const { execute, triggerDurableWebhook, closeRunner } = await import("../server/functions/runner");
const { runSchedulerPass } = await import("../server/functions/scheduler");
const { saveModel } = await import("../server/functions/packages");

let server: Server;
let base = "";
let apiToken = "";

const FILES = { "index.js": `
export async function execute() {
  const h = await m5.webhook.create({ durable: true });
  await m5.session.set('pending', { ready: true });
  return m5.out.text('waiting');
}
export async function on_event(event) {
  const p = await m5.session.get('pending');
  await m5.session.set('grade', event.body.grade);
  return m5.out.json({ grade: event.body.grade, hadPending: !!p });
}
export async function tick() { return m5.out.text('tick ' + (await m5.cache.incr('ticks'))); }
` };

beforeAll(async () => {
  await functionsStore.ready();
  const now = Date.now();
  functionsStore.savePackage({ id: "pkg_s", name: "sched", language: "js", description: "", draft: null, createdAt: now, updatedAt: now, updatedBy: "op" });
  functionsStore.saveVersion({ packageId: "pkg_s", version: "1.0.0", manifest: { name: "sched", version: "1.0.0", language: "js", main: "index.js", dependencies: {}, description: "" }, files: FILES, fingerprint: fingerprint(FILES), status: "published", test: null, createdAt: now, createdBy: "op", publishedAt: now });
  saveModel({ id: "dur", name: "Durable", entry: "sched@1.0.0:index.js#execute", onEvent: "sched@1.0.0:index.js#on_event", runtime: "server", inputs: [], executors: { chat: { enabled: false, visibility: "room" }, console: { enabled: true } }, enabled: true }, "op");
  const ticker = saveModel({ id: "ticker", name: "Ticker", entry: "sched@1.0.0:index.js#tick", runtime: "server", inputs: [], executors: { chat: { enabled: false, visibility: "room" }, console: { enabled: true }, api: { enabled: true } }, enabled: true }, "op");
  apiToken = ticker.executors.api!.token!;
  const app = express();
  registerFunctionsRoutes(app);
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => { server?.close(); closeRunner(); });

describe("durable on_event", () => {
  it("runs on_event in the saved session when the webhook fires later", async () => {
    const dur = functionsStore.model("dur")!;
    const first = await execute(dur, {}, { kind: "user", account: "a1", name: "Mike", groups: [], room: "r1", client: "c1", lang: "cs", tz: "UTC" }, { executor: "chat" });
    expect(first.run.status).toBe("done");
    const token = readOneWebhookToken();
    expect(token).toBeTruthy();
    const fired = await triggerDurableWebhook(token, { body: { grade: "A+" } });
    expect(fired).toBe(true);
  }, 30_000);
});

function readOneWebhookToken(): string {
  // The durable webhook is persisted; read it back straight from the store's DB.
  const db = require("better-sqlite3-multiple-ciphers");
  const path = process.env.FUNCTIONS_DATA_DIR + "/functions.db";
  const d = new db(path, { readonly: true });
  const row = d.prepare("SELECT token FROM webhooks LIMIT 1").get() as { token: string } | undefined;
  d.close();
  return row?.token ?? "";
}

describe("schedules", () => {
  it("runs a due model on a scheduler pass", async () => {
    functionsStore.saveSchedule({ id: "sch1", modelId: "ticker", cron: "* * * * *", tz: "UTC", inputs: {}, enabled: true, lastRun: null, createdAt: Date.now(), createdBy: "op" });
    await runSchedulerPass(new Date());
    await new Promise((r) => setTimeout(r, 300));
    const runs = functionsStore.runs({ modelId: "ticker" }).filter((r) => r.executor === "schedule");
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe("done");
  }, 30_000);
});

describe("API token", () => {
  it("runs with the right bearer token and refuses a wrong one", async () => {
    const ok = await (await fetch(`${base}/api/functions/call/ticker`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiToken}` }, body: "{}" })).json();
    expect(ok.ok).toBe(true);
    expect(ok.outputs[0].text).toMatch(/^tick /);
    const bad = await fetch(`${base}/api/functions/call/ticker`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer nope" }, body: "{}" });
    expect(bad.status).toBe(401);
  }, 30_000);
});
