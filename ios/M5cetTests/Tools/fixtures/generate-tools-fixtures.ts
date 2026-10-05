// Golden fixtures for the iOS tools tests (ios/M5cetTests/Tools), made by the
// SERVER's own code — the routes the app's commands engine, AI chat and
// server speech talk to:
//
//   GET  /api/client-config              the composer's triggers and tags
//   GET  /api/functions/commands         the commands a guest may run (check, report, ask, roomy)
//   POST /api/functions/run  (stream)    report: start, progress ×2, done with html (a script and a remote
//                                        picture the server already dropped), markdown, a table and a button;
//                                        check with wrong inputs: the error event with the problems;
//                                        ask: an interaction (m5.prompt), answered through /runs/:id/events
//   POST /api/functions/run  (404)       an unknown command
//   POST /api/functions/event (stream)   a click on report's button in its session
//   GET  /api/ai/status, POST /api/ai/chat (stream)
//                                        a pretend OpenAI-compatible provider on 127.0.0.1 (test/helpers/mock-ai)
//                                        — no real provider is ever called; provider keys are cleared first
//   GET  /api/speech/status              speech off
//
// Run from the repository root (node_modules of the checkout):
//   npx tsx ios/M5cetTests/Tools/fixtures/generate-tools-fixtures.ts
// The output (tools-server-fixtures.json next to this file) is committed; the Swift tests never run node.

import express from "express";
import type { Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// The server's stores go to a throwaway data directory (set before the server modules load).
const DATA = mkdtempSync(join(tmpdir(), "m5tools-fixtures-"));
process.env.DATA_DIR = DATA;
process.env.FUNCTIONS_DB_FILE = join(DATA, "functions.db");
process.env.PLUGINS_SETTINGS_FILE = join(DATA, "plugins.json");
process.env.ENABLE_FUNCTIONS = "1";
process.env.FUNCTIONS_WARM = "0";
process.env.VITEST = "1"; // no built-in packages, no sandbox self-test
process.env.STORAGE_MASTER_KEY ||= "c".repeat(64);
// Never a real provider: their keys out of this process.
for (const k of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OLLAMA_URL", "HF_API_KEY", "ELEVENLABS_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "ENABLE_AI", "ENABLE_SPEECH"]) delete process.env[k];

const { functionsStore, fingerprint } = await import("../../../../server/functions/store");
const { registerFunctionsRoutes } = await import("../../../../server/functions/routes");
const { closeRunner } = await import("../../../../server/functions/runner");
const { saveModel } = await import("../../../../server/functions/packages");
const { registerClientConfigRoutes } = await import("../../../../server/client-config");
const { registerAiRoutes } = await import("../../../../server/ai/routes");
const { registerAiAdminRoutes } = await import("../../../../server/ai/admin-routes");
const { setPluginSwitches } = await import("../../../../server/plugins/settings");
const { mockProvider, openAiStream, sse } = await import("../../../../test/helpers/mock-ai");

const CODE = `
export async function report(p) {
  m5.run.progress(0.3, "Looking up DNS…");
  m5.run.progress(0.7, "Checking TLS…");
  return [
    m5.out.html("<div class='m5h-head'><div class='m5h-title'>" + p.host + "</div><div class='m5h-sub'>Report</div></div>"
      + "<table class='m5h-kv'><tr><th>A</th><td>93.184.216.34</td></tr><tr><th>TLS</th><td><span class='m5h-badge m5h-badge--ok'>valid</span></td></tr></table>"
      + "<script>alert(1)</script><img src='https://evil.example/x.png'><a href='https://example.org/more'>More</a>", { title: "Domain report" }),
    m5.out.markdown("**ok** — see [the docs](https://example.org/docs)"),
    m5.out.table(["Record", "Value"], [["MX", "mail.example.org"], ["TXT", "v=spf1 -all"]], { title: "DNS" }),
    m5.out.button({ name: "again", title: "Again", data: { host: p.host }, css: "primary" }),
  ];
}
export async function again({ name, data }) { return m5.out.text("again " + name + " " + data.host); }
export async function check(p) { return m5.out.text("ok " + p.n); }
export async function ask() { const a = await m5.prompt({ text: "Your name?" }); return m5.out.text("hi " + a); }
export async function roomy() { return m5.out.markdown("Hello **room**"); }
`;

const now = Date.now();
await functionsStore.ready();
const files = { "index.js": CODE };
functionsStore.savePackage({ id: "pkg_tools", name: "tools", language: "js", description: "", draft: null, createdAt: now, updatedAt: now, updatedBy: "op" });
functionsStore.saveVersion({ packageId: "pkg_tools", version: "1.0.0", manifest: { name: "tools", version: "1.0.0", language: "js", main: "index.js", dependencies: {}, description: "" }, files, fingerprint: fingerprint(files), status: "published", test: null, createdAt: now, createdBy: "op", publishedAt: now });
const caller = { chat: { enabled: true, visibility: "caller" as const }, console: { enabled: true } };
saveModel({
  id: "tools-report", name: "Domain report", keyword: "report", entry: "tools@1.0.0:index.js#report", runtime: "server", enabled: true, executors: caller,
  icon: "file-text", usage: "/report example.org", summary: "A domain's DNS and TLS.",
  inputs: [{ name: "host", type: "hostname", label: "Host", required: true }],
  endpoints: [
    { id: "execute", type: "execute", fn: "index.js#report", inputs: [{ name: "host", type: "hostname", required: true }], enabled: true },
    { id: "button", type: "button", fn: "index.js#again", inputs: [], enabled: true },
  ] as never,
}, "op");
saveModel({
  id: "tools-check", name: "Checker", keyword: "check", entry: "tools@1.0.0:index.js#check", runtime: "server", enabled: true, executors: caller, icon: "shield-check",
  inputs: [{ name: "n", type: "integer", label: "Count", required: true, min: 1, max: 10, help: "how many" }],
}, "op");
saveModel({ id: "tools-ask", name: "Asker", keyword: "ask", entry: "tools@1.0.0:index.js#ask", runtime: "server", enabled: true, executors: caller, icon: "🙋" }, "op");
saveModel({ id: "tools-roomy", name: "Roomy", keyword: "roomy", entry: "tools@1.0.0:index.js#roomy", runtime: "server", enabled: true, executors: { chat: { enabled: true, visibility: "room" as const }, console: { enabled: true } } }, "op");

const mock = await mockProvider();
mock.on("POST /v1/chat/completions", (_q, res) => sse(res, openAiStream("Ahoj! **Jak** mohu pomoci?", { model: "m1" })));

const app = express();
app.use("/admin", (_req, res, next) => { res.locals.adminName = "olga"; res.locals.adminRole = "owner"; next(); });
app.use(express.json());
registerClientConfigRoutes(app);
registerFunctionsRoutes(app);
registerAiRoutes(app);
registerAiAdminRoutes(app);
const server: Server = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

type Captured = { path: string; request: unknown; status: number; contentType: string; body: string };
const call = async (method: string, path: string, body?: unknown): Promise<Captured> => {
  const r = await fetch(base + path, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { path, request: body ?? null, status: r.status, contentType: r.headers.get("content-type") ?? "", body: await r.text() };
};
const origin = { room: null, client: "ios-device-1", lang: "en", tz: "Europe/Prague" };

const out: Record<string, unknown> = { generatedBy: "ios/M5cetTests/Tools/fixtures/generate-tools-fixtures.ts", server: "server/functions/routes.ts, server/ai/routes.ts, server/client-config.ts" };
out.clientConfig = await call("GET", "/api/client-config");
out.commands = await call("GET", "/api/functions/commands");
const report = await call("POST", "/api/functions/run", { keyword: "report", model: "tools-report", inputs: { host: "example.org" }, ...origin, stream: true });
out.runReport = report;
out.runBadInput = await call("POST", "/api/functions/run", { keyword: "check", model: "tools-check", inputs: { n: "40" }, ...origin, stream: true });
out.runUnknown = await call("POST", "/api/functions/run", { keyword: "nope", inputs: {}, ...origin, stream: true });

// The click on report's button, in its session (chain and call from the done event).
const done = report.body.split("\n\n").find((b) => b.startsWith("event: done"))!;
const d = JSON.parse(done.split("\n").find((l) => l.startsWith("data: "))!.slice(6)) as { chain: string; call: number };
out.eventButton = await call("POST", "/api/functions/event", { model: "tools-report", keyword: "report", chain: d.chain, call: d.call, ...origin, type: "button", name: "again", data: { host: "example.org" }, stream: true });

// A question: the stream until the interaction, the answer, the rest.
{
  const r = await fetch(base + "/api/functions/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keyword: "ask", model: "tools-ask", inputs: {}, ...origin, stream: true }) });
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  let answered: Captured | null = null;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    text += dec.decode(value, { stream: true });
    const block = text.split("\n\n").find((b) => b.startsWith("event: interaction"));
    if (block && !answered) {
      const i = JSON.parse(block.split("\n").find((l) => l.startsWith("data: "))!.slice(6)) as { runId: string; id: string };
      answered = await call("POST", `/api/functions/runs/${encodeURIComponent(i.runId)}/events`, { interactionId: i.id, value: "Alice" });
    }
  }
  out.runAsk = { status: r.status, contentType: r.headers.get("content-type") ?? "", body: text, answer: answered };
}

// AI: off, then a pretend provider for everyone (guests too), a budget, a streamed answer.
out.aiStatusOff = await call("GET", "/api/ai/status");
setPluginSwitches({ ai: true }, "fixtures");
await call("POST", "/admin/ai/providers", { type: "openai-compatible", label: "Local AI", baseUrl: `${mock.url}/v1`, key: "sk-fixture", groups: ["guest", "user"], model: "m1" });
await call("PUT", "/admin/ai/limits", { monthlyTokens: 100000 });
out.aiStatus = await call("GET", "/api/ai/status");
out.aiChat = await call("POST", "/api/ai/chat", { model: "local-ai/m1", reasoning: "off", messages: [{ role: "user", content: "Ahoj?" }], stream: true });
out.speechStatus = await call("GET", "/api/speech/status");

// The keep-alive pings are timing; the fixtures keep the events only (pings are tested on their own).
for (const v of Object.values(out)) {
  if (v && typeof v === "object" && "body" in (v as Captured)) (v as Captured).body = (v as Captured).body.replace(/: ping\n\n/g, "");
}

writeFileSync(join(here, "tools-server-fixtures.json"), JSON.stringify(out, null, 2) + "\n");
server.closeAllConnections?.();
server.close();
await mock.close();
closeRunner();
rmSync(DATA, { recursive: true, force: true });
console.log("wrote", join(here, "tools-server-fixtures.json"));
process.exit(0);
