// @vitest-environment node
// 6.11: m5.dns.resolve has a time limit — against a name server that never
// answers (a UDP socket here that swallows every query) a lookup fails with
// code "timeout" in its limit instead of holding the run; netkit turns that
// into "no answer in time", and /mail (with no answers at all) still finishes
// well inside the chat's 30 s, saying what did not answer.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSocket, type Socket } from "node:dgram";

const DATA = mkdtempSync(join(tmpdir(), "m5dns-"));
process.env.DATA_DIR = DATA;
process.env.FUNCTIONS_DB_FILE = join(DATA, "functions.db");
process.env.FUNCTIONS_WARM = "0";

const { functionsStore } = await import("../server/functions/store");
const { execute, runAdhoc, closeRunner } = await import("../server/functions/runner");
const { dnsResolve, dnsTimeout, NetError } = await import("../server/functions/host-net");
const { installBuiltin } = await import("../server/functions/builtins");
const { SOURCES } = await import("../server/functions/builtins/sources");

const console_ = { kind: "console" as const, account: "", name: "tester", groups: ["owner"], room: null, client: "t", lang: "en", tz: "UTC" };

let blackhole: Socket;
let queries = 0;
beforeAll(async () => {
  await functionsStore.ready();
  blackhole = createSocket("udp4");
  blackhole.on("message", () => { queries++; }); // never answers
  await new Promise<void>((r) => blackhole.bind(0, "127.0.0.1", () => r()));
  process.env.FUNCTIONS_DNS_SERVERS = `127.0.0.1:${blackhole.address().port}`;
});
afterAll(() => { blackhole?.close(); closeRunner(); delete process.env.FUNCTIONS_DNS_SERVERS; });

describe("m5.dns.resolve with a time limit", () => {
  it("the limit: 4 s by default, FUNCTIONS_DNS_TIMEOUT_MS, a call's own within 250 ms – 15 s", () => {
    expect(dnsTimeout()).toBe(4000);
    expect(dnsTimeout(10)).toBe(250);
    expect(dnsTimeout(1500)).toBe(1500);
    expect(dnsTimeout(999_999)).toBe(15_000);
    process.env.FUNCTIONS_DNS_TIMEOUT_MS = "2500";
    try { expect(dnsTimeout()).toBe(2500); expect(dnsTimeout("x")).toBe(2500); } finally { delete process.env.FUNCTIONS_DNS_TIMEOUT_MS; }
  });

  it("a server that never answers: code timeout, in the limit", async () => {
    const t0 = Date.now();
    const err = await dnsResolve("example.com", "A", { timeoutMs: 300 }).then(() => null, (e) => e);
    const ms = Date.now() - t0;
    expect(err).toBeInstanceOf(NetError);
    expect(err).toMatchObject({ code: "timeout", message: "no answer in time: example.com A (300 ms)" });
    expect(ms).toBeLessThan(1500);
    expect(queries).toBeGreaterThan(0); // it did ask the (silent) server
  });

  it("in a function: an M5Error with code timeout it can catch", async () => {
    const code = `export async function execute() {
      const t0 = Date.now();
      try { await m5.dns.resolve("example.com", "TXT", { timeoutMs: 300 }); return { answered: true }; }
      catch (e) { return { code: e.code, message: e.message, ms: Date.now() - t0 }; }
    }`;
    const r = await runAdhoc({ lang: "js", files: { "index.js": code }, entry: { file: "index.js", fn: "execute" }, inputs: {} }, console_);
    expect(r.run.error).toBeNull();
    const v = (r.values[0] as { value: { code: string; message: string; ms: number } }).value;
    expect(v).toMatchObject({ code: "timeout", message: "no answer in time: example.com TXT (300 ms)" });
    expect(v.ms).toBeLessThan(1500);
  }, 30_000);
});

describe("e-mail checks within a budget", () => {
  it("netkit.mailInfo: nothing answers — everything is 'no answer in time', within the budget", async () => {
    const code = `import { mailInfo, lookup } from "pkg:netkit";
    export async function execute() {
      const one = await lookup("example.com", "MX", 300);
      const t0 = Date.now();
      const m = await mailInfo("example.com", { budgetMs: 1500 });
      return { one, ms: Date.now() - t0, late: m.late, timeouts: m.timeouts, score: m.score, advice: m.advice };
    }`;
    const r = await runAdhoc({ lang: "js", files: { "index.js": code }, deps: { netkit: { version: "1.4.0", main: "index.js", files: SOURCES.netkit } }, entry: { file: "index.js", fn: "execute" }, inputs: {} }, console_);
    expect(r.run.error).toBeNull();
    const v = (r.values[0] as { value: { one: unknown; ms: number; late: string[]; timeouts: Record<string, boolean>; score: number; advice: string[] } }).value;
    expect(v.one).toEqual({ ok: false, records: [], error: "no answer in time", timeout: true });
    expect(v.ms).toBeLessThan(4000);
    expect(v.late).toEqual(expect.arrayContaining(["MX", "SPF (TXT)", "DMARC", "MTA-STS", "TLS-RPT", "BIMI", expect.stringMatching(/^DKIM \((\d+) of \1 selectors\)$/)]));
    expect(v.timeouts).toEqual({ mx: true, spf: true, dmarc: true, dkim: true, mtaSts: true, tlsRpt: true, bimi: true });
    // Not "you have no SPF record" — the DNS did not say.
    expect(v.score).toBe(0);
    expect(v.advice).toEqual(expect.arrayContaining(["MX: the DNS gave no answer in time — check again later.", "SPF: the DNS gave no answer in time — check again later."]));
    expect(v.advice.join(" ")).not.toMatch(/No SPF record|No DMARC record|No MX record/);
  }, 30_000);

  it("/mail example.com with a silent DNS finishes well under 30 s and says what did not answer", async () => {
    installBuiltin("mail", "test");
    const m = functionsStore.models().find((x) => x.keyword === "mail")!;
    const t0 = Date.now();
    const r = await execute(m, { domain: "example.com" }, console_, { executor: "console", test: true });
    const ms = Date.now() - t0;
    expect(r.run.status).toBe("done");
    expect(ms).toBeLessThan(15_000);
    const text = r.outputs.map((o) => (o as { text?: string }).text ?? "").join("\n");
    expect(text).toMatch(/## ✉️ E-mail — example\.com/);
    expect(text).toMatch(/⏱ no answer in time \(MX\)/);
    expect(text).toMatch(/\| SPF \| ⏱ no answer in time \|/);
    expect(text).toMatch(/⏱ no answer in time: MX, SPF \(TXT\), DMARC/);
    expect(r.outputs).toEqual(expect.arrayContaining([expect.objectContaining({ type: "flash", level: "warning", text: "example.com: some checks got no answer in time" })]));
  }, 30_000);
});
