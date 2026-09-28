// @vitest-environment node
// Webhooks (4.15, stage 4): a model reachable by an inbound HTTP webhook, and
// a run that waits on m5.webhook.create() / wait().

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { Server } from "node:http";

process.env.FUNCTIONS_DB_FILE = join(mkdtempSync(join(tmpdir(), "m5hook-")), "functions.db");
process.env.ENABLE_FUNCTIONS = "1";
process.env.FUNCTIONS_WARM = "0";

const { functionsStore, fingerprint } = await import("../server/functions/store");
const { registerFunctionsRoutes } = await import("../server/functions/routes");
const { runAdhoc, runEvents, deliverWebhook, closeRunner } = await import("../server/functions/runner");
const { saveModel } = await import("../server/functions/packages");

let server: Server;
let base = "";

beforeAll(async () => {
  await functionsStore.ready();
  const now = Date.now();
  const files = { "index.js": "export async function execute(p){ return m5.out.json({ upper: String(p.name||'').toUpperCase() }); }" };
  functionsStore.savePackage({ id: "pkg_h", name: "hooks", language: "js", description: "", draft: null, createdAt: now, updatedAt: now, updatedBy: "op" });
  functionsStore.saveVersion({ packageId: "pkg_h", version: "1.0.0", manifest: { name: "hooks", version: "1.0.0", language: "js", main: "index.js", dependencies: {}, description: "" }, files, fingerprint: fingerprint(files), status: "published", test: null, createdAt: now, createdBy: "op", publishedAt: now });
  saveModel({ id: "hookmodel", name: "Hook", entry: "hooks@1.0.0:index.js#execute", runtime: "server", inputs: [], executors: { chat: { enabled: false, visibility: "room" }, console: { enabled: true }, webhook: { enabled: true } }, enabled: true }, "op");
  const app = express();
  registerFunctionsRoutes(app);
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => { server?.close(); closeRunner(); });

const token = () => functionsStore.model("hookmodel")!.executors.webhook!.token!;

describe("model webhook", () => {
  it("mints a token and runs the model with the payload", async () => {
    expect(token()).toBeTruthy();
    const r = await (await fetch(`${base}/hooks/m/hookmodel/${encodeURIComponent(token())}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "mike" }) })).json();
    expect(r.ok).toBe(true);
    expect(r.outputs[0].value.upper).toBe("MIKE");
  }, 30_000);

  it("refuses a wrong token", async () => {
    const res = await fetch(`${base}/hooks/m/hookmodel/not-the-token-000000000`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(403);
  });
});

describe("in-run webhook", () => {
  it("waits on a created webhook and continues when it fires", async () => {
    const onRun = (ev: { type?: string; fields?: { token?: string } }) => {
      if (ev.type === "log" && ev.fields?.token) setTimeout(() => deliverWebhook(ev.fields!.token!, { body: { grade: "A+" } }), 40);
    };
    runEvents.on("run", onRun);
    try {
      const files = { "index.js": "export async function execute(){ const h = await m5.webhook.create(); m5.log.info('hook', { token: h.token }); const e = await m5.webhook.wait(h, { timeoutMs: 4000 }); return m5.out.json(e.body); }" };
      const run = await runAdhoc({ lang: "js", files, entry: { file: "index.js", fn: "execute" }, inputs: {}, limits: { wallMs: 6000 } }, { kind: "console", account: "", name: "t", groups: [], room: null, client: "c", lang: "cs", tz: "UTC" });
      expect(run.run.status).toBe("done");
      expect((run.value as { value: { grade: string } }).value).toEqual({ grade: "A+" });
    } finally {
      runEvents.off("run", onRun);
    }
  }, 30_000);
});
