// @vitest-environment node
// 6.11: a run that waits on the host (a slow web server, DNS that does not
// answer) tells its caller so — a `progress` event naming what it waits for,
// after FUNCTIONS_WAIT_NOTICE_MS of waiting and then at most every
// FUNCTIONS_WAIT_EVERY_MS without any other event — so the chat (which gives
// up after 30 s without an event) does not cut off a slow run; a fast call,
// or a run that reports progress itself, gets none. Timings shortened here.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { createSocket, type Socket } from "node:dgram";
import express from "express";
import type { AddressInfo } from "node:net";

const DATA = mkdtempSync(join(tmpdir(), "m5wait-"));
process.env.DATA_DIR = DATA;
process.env.FUNCTIONS_DB_FILE = join(DATA, "functions.db");
process.env.FUNCTIONS_WARM = "0";
process.env.ENABLE_FUNCTIONS = "1";
process.env.FUNCTIONS_HTTP_ALLOW_LOCAL = "1";
process.env.FUNCTIONS_WAIT_NOTICE_MS = "200";
process.env.FUNCTIONS_WAIT_EVERY_MS = "300";

const { functionsStore, fingerprint, newId } = await import("../server/functions/store");
const { runAdhoc, runEvents, closeRunner } = await import("../server/functions/runner");
const { registerFunctionsRoutes } = await import("../server/functions/routes");
const { saveModel } = await import("../server/functions/packages");

const console_ = { kind: "console" as const, account: "", name: "tester", groups: ["owner"], room: null, client: "t", lang: "en", tz: "UTC" };

let site: Server;
let siteUrl = "";
let app: Server;
let appUrl = "";
let blackhole: Socket;
beforeAll(async () => {
  await functionsStore.ready();
  site = createServer((req, res) => {
    const reply = () => { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); };
    if (req.url === "/slow") setTimeout(reply, 1300); else reply();
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", () => r()));
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  blackhole = createSocket("udp4");
  await new Promise<void>((r) => blackhole.bind(0, "127.0.0.1", () => r()));
  process.env.FUNCTIONS_DNS_SERVERS = `127.0.0.1:${blackhole.address().port}`;
  // A chat command over the route, to see the events on the wire.
  const now = Date.now();
  const files = { "index.js": `export async function execute() { await m5.http.get(${JSON.stringify(`${siteUrl}/slow`)}); return m5.out.text("done"); }` };
  functionsStore.savePackage({ id: "pkg_w", name: "waiter", language: "js", description: "", draft: null, createdAt: now, updatedAt: now, updatedBy: "op" });
  functionsStore.saveVersion({ packageId: "pkg_w", version: "1.0.0", manifest: { name: "waiter", version: "1.0.0", language: "js", main: "index.js", dependencies: {}, description: "" }, files, fingerprint: fingerprint(files), status: "published", test: null, createdAt: now, createdBy: "op", publishedAt: now });
  saveModel({ id: "w-slow", name: "Slow", keyword: "slow", entry: "waiter@1.0.0:index.js#execute", runtime: "server", enabled: true, executors: { chat: { enabled: true, visibility: "caller" }, console: { enabled: true } } }, "op");
  const ex = express();
  registerFunctionsRoutes(ex);
  await new Promise<void>((r) => { app = ex.listen(0, "127.0.0.1", () => r()); });
  appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(() => { site?.close(); app?.close(); blackhole?.close(); closeRunner(); delete process.env.FUNCTIONS_DNS_SERVERS; });

type Notice = { at: number; p: unknown; text: string; waiting?: { kind: string; pending: number; total: number; ms: number } };
/** Runs code as a console draft and collects its progress events (with the time each came, from the start). */
async function withNotices(code: string): Promise<{ notices: Notice[]; error: unknown }> {
  const runId = newId("run");
  const notices: Notice[] = [];
  const t0 = Date.now();
  const onRun = (ev: Record<string, unknown>) => { if (ev.runId === runId && ev.type === "progress") notices.push({ at: Date.now() - t0, p: ev.p, text: String(ev.text), waiting: ev.waiting as Notice["waiting"] }); };
  runEvents.on("run", onRun);
  try {
    const r = await runAdhoc({ runId, lang: "js", files: { "index.js": code }, entry: { file: "index.js", fn: "execute" }, inputs: {} }, console_);
    return { notices, error: r.run.error };
  } finally { runEvents.off("run", onRun); }
}

describe("waiting on the host is announced", () => {
  it("a slow web server: a notice after the first wait, then one at least every 300 ms, naming it", async () => {
    const { notices, error } = await withNotices(`export async function execute() { const r = await m5.http.get(${JSON.stringify(`${siteUrl}/slow`)}); return r.text; }`);
    expect(error).toBeNull();
    const waits = notices.filter((n) => n.waiting);
    expect(waits.length).toBeGreaterThanOrEqual(3);
    expect(waits.length).toBeLessThanOrEqual(8);
    for (const n of waits) expect(n).toMatchObject({ p: null, text: "Waiting for a web server…", waiting: { kind: "http", pending: 1, total: 1 } });
    expect(waits[0].at).toBeGreaterThanOrEqual(280);
    expect(waits[0].waiting!.ms).toBeGreaterThanOrEqual(200);
    for (let i = 1; i < waits.length; i++) {
      const gap = waits[i].at - waits[i - 1].at;
      expect(gap).toBeGreaterThanOrEqual(280);
      expect(gap).toBeLessThanOrEqual(800); // the check runs every 75 ms; loaded machines are slower
    }
  }, 30_000);

  it("DNS that does not answer: how many lookups still wait, of how many", async () => {
    const { notices } = await withNotices(`export async function execute() {
      m5.run.progress(0.25, "looking up");
      await Promise.all(["a.example", "b.example", "c.example"].map((n) => m5.dns.resolve(n, "A", { timeoutMs: 1000 }).catch(() => null)));
      return null;
    }`);
    const waits = notices.filter((n) => n.waiting);
    expect(notices[0]).toMatchObject({ p: 0.25, text: "looking up" });
    expect(waits.length).toBeGreaterThanOrEqual(2);
    expect(waits[0]).toMatchObject({ p: 0.25, text: "Waiting for DNS answers (3 of 3)…", waiting: { kind: "dns", pending: 3, total: 3 } });
    // The function's own progress counts: the first notice comes 300 ms after it, not sooner.
    expect(waits[0].at - notices[0].at).toBeGreaterThanOrEqual(280);
  }, 30_000);

  it("fast calls: none", async () => {
    const { notices, error } = await withNotices(`export async function execute() { for (let i = 0; i < 5; i++) await m5.http.get(${JSON.stringify(`${siteUrl}/fast`)}); return null; }`);
    expect(error).toBeNull();
    expect(notices).toEqual([]);
  }, 30_000);

  it("a run that reports progress itself while it waits: none", async () => {
    // Its own events every 100 ms; the notice would need 800 ms without one (a margin for a loaded machine).
    process.env.FUNCTIONS_WAIT_EVERY_MS = "800";
    try {
      const { notices } = await withNotices(`export async function execute() {
        const slow = m5.http.get(${JSON.stringify(`${siteUrl}/slow`)});
        let done = false; slow.then(() => { done = true; });
        for (let i = 0; !done && i < 40; i++) { m5.run.progress(i / 40, "still busy"); await m5.sleep(100); }
        await slow;
        return null;
      }`);
      expect(notices.length).toBeGreaterThan(3);
      expect(notices.filter((n) => n.waiting)).toEqual([]);
    } finally { process.env.FUNCTIONS_WAIT_EVERY_MS = "300"; }
  }, 30_000);

  it("on the wire: SSE progress events between start and done", async () => {
    const res = await fetch(`${appUrl}/api/functions/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keyword: "slow", inputs: {}, stream: true }) });
    const evs = (await res.text()).split("\n\n").map((b) => b.trim()).filter((b) => b && !b.startsWith(":")).map((b) => ({ event: /^event: (.*)$/m.exec(b)![1], data: JSON.parse(/^data: (.*)$/m.exec(b)![1]) as Record<string, unknown> }));
    const names = evs.map((e) => e.event);
    expect(names[0]).toBe("start");
    expect(names.at(-1)).toBe("done");
    const progress = evs.filter((e) => e.event === "progress");
    expect(progress.length).toBeGreaterThanOrEqual(3);
    expect(progress[0].data).toMatchObject({ runId: evs[0].data.runId, type: "progress", p: null, text: "Waiting for a web server…", waiting: { kind: "http", pending: 1, total: 1, ms: expect.any(Number) } });
  }, 30_000);
});
