// @vitest-environment node
// The console's Functions endpoints added in 5.1: live runs (answer at once
// with a run id; follow the events over SSE; answer m5.prompt / m5.form from
// the console), the visual builder's compile and save, the run filter and
// the overview's flow flag and 24-hour stats.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FUNCTIONS_DB_FILE = join(mkdtempSync(join(tmpdir(), "m5capi-")), "functions.db");
process.env.FUNCTIONS_WARM = "0";

const { registerFunctionsAdminRoutes } = await import("../server/functions/admin-routes");
const { closeRunner } = await import("../server/functions/runner");
const { FLOW_EXAMPLES } = await import("../server/functions/flow");

let server: Server;
let base = "";
const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
  const res = await fetch(base + path, { method: init.method ?? "GET", headers: { "content-type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  return { status: res.status, json: await res.json() as Record<string, any> };
};

/** Reads an SSE stream until the run's result, answering questions on the way. */
async function follow(runId: string, answer: (it: { id: string; kind: string; spec: any }) => unknown) {
  const res = await fetch(`${base}/admin/functions/runs/${runId}/live`);
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const events: any[] = [];
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "));
      buf = buf.slice(i + 2);
      if (!line) continue;
      const ev = JSON.parse(line.slice(6));
      events.push(ev);
      if (ev.type === "interaction") {
        const r = await call(`/admin/functions/runs/${runId}/answer`, { method: "POST", body: { interaction: ev.interaction.id, value: answer(ev.interaction) } });
        expect(r.status).toBe(200);
      }
    }
  }
  return events;
}

beforeAll(async () => {
  const app = express();
  app.use((_req, res, next) => { res.locals.adminName = "tester"; res.locals.adminRole = "owner"; next(); });
  registerFunctionsAdminRoutes(app);
  server = await new Promise<Server>((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server?.close(); closeRunner(); });

describe("live runs", () => {
  it("answers with a run id, streams the events and takes the console's answers", async () => {
    const code = "export async function execute() {\n  m5.log.info(\"start\");\n  const a = await m5.prompt({ text: \"Colour?\", choices: [\"red\", \"blue\"] });\n  const f = await m5.form({ title: \"More\", fields: [{ name: \"n\", type: \"number\" }] });\n  await m5.caller.send(m5.out.text(\"first\"));\n  return m5.out.text(`${a} ${f.n}`);\n}\n";
    const start = await call("/admin/functions/run", { method: "POST", body: { live: true, adhoc: { lang: "js", files: { "index.js": code }, file: "index.js", fn: "execute" }, inputs: {} } });
    expect(start.status).toBe(200);
    expect(start.json.runId).toMatch(/^run_/);
    const events = await follow(start.json.runId, (it) => (it.kind === "prompt" ? "blue" : { n: 7 }));
    const types = events.map((e) => e.type);
    expect(types).toContain("log");
    expect(types.filter((t) => t === "interaction")).toHaveLength(2);
    expect(types).toContain("output");
    const result = events[events.length - 1];
    expect(result.type).toBe("result");
    expect(result.ok).toBe(true);
    expect(result.run.status).toBe("done");
    expect(result.outputs.map((o: { text: string }) => o.text)).toEqual(["first", "blue 7"]);
  }, 40_000);

  it("replays a finished run to a late follower", async () => {
    const start = await call("/admin/functions/run", { method: "POST", body: { live: true, adhoc: { lang: "js", files: { "index.js": "export const execute = () => m5.out.text(\"hi\");" } } } });
    await new Promise((r) => setTimeout(r, 2500));
    const events = await follow(start.json.runId, () => null);
    expect(events[events.length - 1].type).toBe("result");
    expect(events[events.length - 1].outputs[0].text).toBe("hi");
  }, 30_000);

  it("reports a refused run as a result, and a closed question as 404", async () => {
    const start = await call("/admin/functions/run", { method: "POST", body: { live: true, modelId: "nope" } });
    expect(start.status).toBe(404);
    const bad = await call("/admin/functions/runs/run_nope/answer", { method: "POST", body: { interaction: "x", value: 1 } });
    expect(bad.status).toBe(404);
  });
});

describe("the visual builder", () => {
  it("compiles a flow, and points at the node that is wrong", async () => {
    const ok = await call("/admin/functions/flow/compile", { method: "POST", body: { flow: FLOW_EXAMPLES[0].flow } });
    expect(ok.status).toBe(200);
    expect(ok.json.code).toContain("export async function execute");
    expect(ok.json.inputs[0].name).toBe("name");
    const broken = { ...FLOW_EXAMPLES[0].flow, nodes: [...FLOW_EXAMPLES[0].flow.nodes, { id: "n9", type: "text.case", x: 0, y: 0, params: {}, values: {} }] };
    const bad = await call("/admin/functions/flow/compile", { method: "POST", body: { flow: broken } });
    expect(bad.status).toBe(400);
    expect(bad.json.node).toBe("n9");
  });

  it("saves a flow into a package's draft (flow file + code) and flags it in the overview", async () => {
    const pkg = await call("/admin/functions/packages", { method: "POST", body: { name: "flowpkg", language: "js" } });
    const id = pkg.json.package.id;
    const saved = await call(`/admin/functions/packages/${id}/flow`, { method: "PUT", body: { flow: FLOW_EXAMPLES[0].flow } });
    expect(saved.status).toBe(200);
    expect(Object.keys(saved.json.draft.files)).toEqual(expect.arrayContaining(["flow.m5flow.json", "index.js"]));
    expect(JSON.parse(saved.json.draft.files["flow.m5flow.json"]).format).toBe("m5flow");
    expect(saved.json.draft.files["index.js"]).toContain("m5.out.markdown");
    const wrongLang = await call(`/admin/functions/packages/${id}/flow`, { method: "PUT", body: { flow: { ...FLOW_EXAMPLES[0].flow, lang: "py" } } });
    expect(wrongLang.status).toBe(400);
    const ov = await call("/admin/functions");
    expect(ov.json.packages.find((p: { id: string }) => p.id === id).flow).toBe(true);
    expect(ov.json.stats.runs24h).toBeGreaterThan(0);
  });

  it("filters runs by status", async () => {
    const done = await call("/admin/functions/runs?status=done");
    expect(done.json.runs.length).toBeGreaterThan(0);
    expect(done.json.runs.every((r: { status: string }) => r.status === "done")).toBe(true);
  });
});
