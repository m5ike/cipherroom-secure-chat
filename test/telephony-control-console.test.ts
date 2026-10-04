// @vitest-environment node
//
// The control plane's settings and console (6.9): TelPermissions and the
// routing rules — validated and clamped (store.ts), kept in the telephony
// data file next to the SIP trunks (another writer keeps them), re-read when
// the file changes, read leniently when hand-edited; the console endpoints
// (control/routes.ts); and which right each /admin/telephony request needs
// (guard.ts, from the API contract) — through the real consoleGuard.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const dir = mkdtempSync(join(tmpdir(), "m5ctl-"));
Object.assign(process.env, {
  DATA_DIR: dir, TELEPHONY_DATA_FILE: join(dir, "telephony.json"), TELEPHONY_DB_FILE: join(dir, "telephony.db"),
  SIP_TRUNKS: JSON.stringify([{ id: "envtrunk", label: "Env", host: "sip.env.example.com", username: "u", password: "envsecret" }]),
});

const express = (await import("express")).default;
const store = await import("../server/telephony/control/store");
const { DEFAULT_PERMISSIONS } = await import("../server/telephony/control/types");
const { telHooks, telPermissions } = await import("../server/telephony/control/hooks");
const { sipStore } = await import("../server/telephony/sip");
const { registerControlRoutes, telephonyAccess } = await import("../server/telephony/control/routes");
const { telephonyConsoleRight, telephonyEndpoint } = await import("../server/telephony/control/guard");
const { TELEPHONY_API } = await import("../server/telephony/control/api-contract");
const { consoleGuard } = await import("../server/access");
const { clientConfigStore } = await import("../server/client-config");
const { telStore } = await import("../server/telephony/tel-store");

const file = join(dir, "telephony.json");
const readFile = () => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

const goodOutbound = (over: Record<string, unknown> = {}) => ({
  id: "cz", label: "Czech numbers over the trunk", match: { to: ["+420*", "-+420900*"], groups: ["sales"], sources: ["function"], hours: { timezone: "Europe/Prague", days: "mon-fri", from: "08:00", to: "18:00" } },
  service: { kind: "sip", provider: "twilio", trunk: "prague1", callerId: { number: "+420222111000", name: "M5cet \"<Sales>\"", presentation: "allowed" } },
  target: { kind: "pass" }, ...over,
});

let server: Server;
let base = "";
let role = "owner";

beforeAll(async () => {
  sipStore.create({ id: "prague1", label: "Prague", host: "sip.example.com", username: "m5", password: "trunksecret", callerIdNumber: "+420222111000" });
  const app = express();
  app.use(express.json());
  app.use("/admin", (_req, res, next) => { res.locals.adminName = "eva"; res.locals.adminRole = role; next(); });
  app.use("/admin/telephony", consoleGuard("telephony", telephonyConsoleRight));
  registerControlRoutes(app);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  telStore.reset();
  rmSync(dir, { recursive: true, force: true });
});

const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
};

/* ------------------------------------------------------------------ store */

describe("permissions: validated and clamped", () => {
  it("clamps numbers (and says so), keeps what the request leaves out, refuses broken lists", () => {
    const r = store.checkPermissions({ outbound: { maxConcurrentCalls: 5000, callsPerHour: 0, countries: ["cz", "SK", "cz"] }, inroute: { maxTtlSec: 10 } });
    expect(r.problems).toEqual([]);
    expect(r.permissions.outbound).toMatchObject({ maxConcurrentCalls: 1000, callsPerHour: 1, countries: ["CZ", "SK"], blocked: DEFAULT_PERMISSIONS.outbound.blocked, smsPerHour: 60 });
    expect(r.permissions.inroute.maxTtlSec).toBe(60);
    expect(r.notes).toEqual(expect.arrayContaining(["outbound.maxConcurrentCalls: 5000 → 1000 (allowed 1–1000)", "inroute.maxTtlSec: 10 → 60 (allowed 60–604800)"]));
    const bad = store.checkPermissions({ outbound: { countries: ["Czechia"], blocked: ["+1900*", "premium"], maxMinutes: "long" }, tsa: { httpHosts: ["api.example.com", "*.example.org", "http://x"] }, defaults: { inbound: { kind: "pass" }, outbound: { kind: "state", state: "maybe" } } });
    expect(bad.problems.map((p) => p.path)).toEqual(["outbound.countries", "outbound.blocked[1]", "tsa.httpHosts", "outbound.maxMinutes", "defaults.inbound", "defaults.outbound.state"]);
    expect(bad.problems.find((p) => p.path === "defaults.inbound")!.message).toMatch(/outbound calls only/);
  });

  it("saves into the data file next to the trunks; the main service sees it; a trunk save keeps it", () => {
    const r = store.savePermissions({ outbound: { countries: ["CZ"], callsPerHour: 3 }, defaults: { inbound: { kind: "tsa", tsa: "reception" } } }, "eva");
    expect(r.ok).toBe(true);
    const f = readFile();
    expect((f.permissions as { outbound: { countries: string[] } }).outbound.countries).toEqual(["CZ"]);
    expect(f.permissionsMeta).toMatchObject({ updatedBy: "eva" });
    expect((statSync(file).mode & 0o777).toString(8)).toBe("600");
    // The hook every part reads.
    expect(telPermissions().outbound.callsPerHour).toBe(3);
    expect(telHooks.permissions!().defaults.inbound).toEqual({ kind: "tsa", tsa: "reception" });
    // Another writer (the SIP console) rewrites the file: the section stays.
    sipStore.update("prague1", { label: "Prague 1" });
    expect((readFile().permissions as { outbound: { callsPerHour: number } }).outbound.callsPerHour).toBe(3);
    // The stored value is read-only (frozen) for the parts that read it.
    expect(() => { (telPermissions().outbound as { callsPerHour: number }).callsPerHour = 99; }).toThrow();
  });
});

describe("routing rules: validated, ordered, persisted", () => {
  it("outbound: priorities are the order; the caller ID name is cleaned; a missing trunk, a bad pattern, a non-E.164 caller ID are refused", () => {
    const ok = store.checkOutbound([goodOutbound(), { label: "Rest", match: { to: ["*"] }, service: { kind: "app", provider: "telnyx" }, target: { kind: "state", state: "congestion" } }]);
    expect(ok.problems).toEqual([]);
    expect(ok.rules.map((r) => [r.id.startsWith("out-") ? "out-…" : r.id, r.priority])).toEqual([["cz", 10], ["out-…", 20]]);
    expect(ok.rules[0].service).toEqual({ kind: "sip", provider: "twilio", trunk: "prague1", callerId: { number: "+420222111000", name: "M5cet Sales", presentation: "allowed" } });
    const bad = store.checkOutbound([
      goodOutbound({ service: { kind: "sip", provider: "twilio", trunk: "nowhere", callerId: { number: "420222", presentation: "hidden" } } }),
      goodOutbound({ id: "cz", match: { to: ["+42*0"], groups: ["Sales Team"], sources: ["fax"] }, service: { kind: "app", provider: "meta" }, target: { kind: "tsa", tsa: "X" } }),
    ]);
    expect(bad.problems.map((p) => p.path)).toEqual([
      "outbound[0].service.trunk", "outbound[0].service.callerId.number", "outbound[0].service.callerId.presentation",
      "outbound[1].match.groups", "outbound[1].match.sources", "outbound[1].id", "outbound[1].match.to[0]",
      "outbound[1].service.provider", "outbound[1].target.tsa",
    ]);
    const msg = (path: string) => bad.problems.find((p) => p.path === path)!.message;
    expect(msg("outbound[0].service.trunk")).toBe("no SIP trunk \"nowhere\" (Telephony › SIP trunks)");
    expect(msg("outbound[0].service.callerId.number")).toMatch(/^an E\.164 number/);
    expect(msg("outbound[1].id")).toBe("the id \"cz\" is used twice");
    expect(msg("outbound[1].match.to[0]")).toMatch(/is neither a number pattern/);
    // An env trunk counts as existing.
    expect(store.checkOutbound([goodOutbound({ service: { kind: "sip", provider: "telnyx", trunk: "envtrunk", callerId: {} } })]).problems).toEqual([]);
  });

  it("inbound: no 'pass', valid windows, call providers only", () => {
    const r = store.checkInbound({ rules: [
      { id: "a", match: { numbers: ["+420222111000"], provider: "vonage", service: "sip" }, target: { kind: "tsa", tsa: "desk" }, record: true },
      { id: "b", match: { hours: { timezone: "Nowhere/City", days: "mon-fri", from: "08:00", to: "17:00" }, provider: "hlrlookups" }, target: { kind: "pass" } },
    ] });
    expect(r.rules[0]).toMatchObject({ id: "a", priority: 10, enabled: true, record: true, match: { from: [], provider: "vonage", service: "sip", hours: null } });
    expect(r.problems.map((p) => p.path)).toEqual(["inbound[1].match.provider", "inbound[1].match.hours", "inbound[1].target"]);
  });

  it("saves each direction alone; a hand-edited broken rule is read switched off (and logged)", () => {
    expect(store.saveRules("outbound", [goodOutbound()], "eva").ok).toBe(true);
    expect(store.saveRules("inbound", [{ id: "desk", match: { numbers: ["+420222111000"] }, target: { kind: "tsa", tsa: "desk" } }], "eva").ok).toBe(true);
    expect(store.getRules().outbound.map((r) => r.id)).toEqual(["cz"]);
    expect(store.getRules().inbound.map((r) => r.id)).toEqual(["desk"]);
    expect(readFile().rules).toMatchObject({ updatedBy: "eva" });

    const logged: Array<{ kind: string; summary: string }> = [];
    telHooks.log = (e) => logged.push(e);
    const f = readFile();
    (f.rules as { inbound: unknown[] }).inbound.push({ id: "typo", match: { numbers: ["oops"] }, target: { kind: "state", state: "busy" } });
    writeFileSync(file, JSON.stringify(f));
    const inbound = store.getRules().inbound;
    expect(inbound.map((r) => [r.id, r.enabled])).toEqual([["desk", true], ["typo", false]]);
    expect(logged.some((e) => e.kind === "config" && /read leniently/.test(e.summary))).toBe(true);
    telHooks.log = undefined;
  });
});

/* -------------------------------------------------------------- console */

describe("the console endpoints", () => {
  it("permissions: GET with the module's access per group; PUT clamps or refuses with every problem", async () => {
    const cfg = clientConfigStore.get();
    clientConfigStore.set({ ...cfg, groups: [...cfg.groups, { id: "callers", label: "Callers", members: ["alice"] }], modules: { ...cfg.modules, telephony: { enabled: true, defaultAccess: "deny", groupAccess: "allow", groups: ["callers"], grants: [{ group: "callers", rights: ["call", "-number:+1900*"] }, { group: "admin-operator", rights: ["settings", "test"] }], log: "off" } } });
    const g = await call("GET", "/admin/telephony/permissions");
    expect(g.status).toBe(200);
    expect(g.body.access).toEqual([
      { group: "mod-telephony", allow: ["*"], deny: [] },
      { group: "callers", allow: ["*", "call"], deny: ["number:+1900*"] },
      { group: "admin-operator", allow: ["settings", "test"], deny: [] },
    ]);
    expect((g.body.bounds as Record<string, number[]>)["outbound.maxMinutes"]).toEqual([1, 1440]);
    const put = await call("PUT", "/admin/telephony/permissions", { permissions: { outbound: { maxMinutes: 100000 } } });
    expect(put.status).toBe(200);
    expect((put.body.permissions as { outbound: { maxMinutes: number } }).outbound.maxMinutes).toBe(1440);
    expect(put.body.notes).toEqual(["outbound.maxMinutes: 100000 → 1440 (allowed 1–1440)"]);
    const bad = await call("PUT", "/admin/telephony/permissions", { outbound: { blocked: ["nope"] } });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ ok: false, problems: [{ path: "outbound.blocked[0]" }] });
  });

  it("rules: GET lists them with the trunks (no secrets); PUT replaces; POST /rules/test explains — over a draft too", async () => {
    const g = await call("GET", "/admin/telephony/rules");
    expect((g.body.outbound as Array<{ id: string }>).map((r) => r.id)).toEqual(["cz"]);
    expect(JSON.stringify(g.body)).not.toMatch(/trunksecret|envsecret/);
    expect((g.body.trunks as Array<{ id: string }>).map((t) => t.id).sort()).toEqual(["envtrunk", "prague1"]);
    const refused = await call("PUT", "/admin/telephony/rules/inbound", { rules: [{ id: "x", target: { kind: "pass" } }] });
    expect(refused.status).toBe(400);
    const saved = await call("PUT", "/admin/telephony/rules/inbound", { rules: [{ id: "vip", label: "VIP", match: { from: ["+420777*"] }, target: { kind: "tsa", tsa: "vip-line" } }, { id: "desk", match: { numbers: ["+420222111000"] }, target: { kind: "tsa", tsa: "desk" } }] });
    expect(saved.status).toBe(200);
    expect((saved.body.rules as Array<{ id: string; priority: number }>).map((r) => `${r.id}@${r.priority}`)).toEqual(["vip@10", "desk@20"]);

    const t = await call("POST", "/admin/telephony/rules/test", { direction: "inbound", from: "+420608000000", to: "+420222111000" });
    expect(t.body).toMatchObject({ ok: true, rule: "desk", target: { kind: "tsa", tsa: "desk" }, draft: false });
    expect(t.body.reasons).toEqual(['#10 "VIP" — skipped: the caller +420608000000 is not in [+420777*]', '#20 "desk" — matched → TSA desk']);
    const draft = await call("POST", "/admin/telephony/rules/test", { question: { direction: "inbound", from: "+420608000000", to: "+420222111000" }, draft: { inbound: [] } });
    expect(draft.body).toMatchObject({ rule: null, target: { kind: "tsa", tsa: "reception" }, draft: true });
    expect((await call("POST", "/admin/telephony/rules/test", { direction: "sideways" })).status).toBe(400);
  });

  it("inroute: the console adds (a random code or its own), lists in full, refuses a taken one, removes", async () => {
    const a = await call("POST", "/admin/telephony/inroute", { type: "room", room: "r3.console-room", ttl: 120, label: "Test" });
    expect(a.status).toBe(200);
    const code = (a.body.entry as { code: string }).code;
    expect(code).toMatch(/^\d{6}$/);
    expect(a.body.entry).toMatchObject({ type: "room", room: "r3.console-room", ttlSec: 120, createdBy: { kind: "console", id: "eva" } });
    expect((await call("POST", "/admin/telephony/inroute", { code, type: "room", room: "r3.other" })).status).toBe(409);
    expect((await call("POST", "/admin/telephony/inroute", { code: "12", type: "room", room: "r3.other" })).status).toBe(400);
    const list = await call("GET", "/admin/telephony/inroute");
    expect((list.body.entries as Array<{ code: string }>).map((e) => e.code)).toContain(code);
    expect(list.body.limits).toMatchObject({ maxTtlSec: expect.any(Number) });
    expect((await call("DELETE", `/admin/telephony/inroute/${code}`)).status).toBe(200);
    expect((await call("DELETE", `/admin/telephony/inroute/${code}`)).status).toBe(404);
  });

  it("the module's access per group reads 'everyone' when no rule exists", () => {
    const cfg = clientConfigStore.get();
    const { telephony: _t, ...rest } = cfg.modules;
    clientConfigStore.set({ ...cfg, modules: rest });
    expect(telephonyAccess()).toEqual([{ group: "*", allow: ["*"], deny: [] }]);
    clientConfigStore.set(cfg);
  });
});

/* ------------------------------------------------------------------ guard */

describe("which right a console request needs", () => {
  const right = (method: string, path: string) => telephonyConsoleRight({ method, path: path.replace("/admin/telephony", "") || "/", baseUrl: "/admin/telephony" });

  it("every endpoint of the contract maps to its own right", () => {
    for (const ep of TELEPHONY_API) {
      const path = ep.path.replace(/:(\w+)/g, "x1");
      expect(telephonyEndpoint(ep.method, path)?.path, `${ep.method} ${ep.path}`).toBe(ep.path);
      expect(right(ep.method, path), `${ep.method} ${ep.path}`).toEqual(ep.right ? [[ep.right]] : null);
    }
  });

  it("reading needs the module, changes their part; a literal path beats a :param; unknown paths keep the old rule", () => {
    expect(right("GET", "/admin/telephony/rules")).toBeNull();
    expect(right("HEAD", "/admin/telephony/permissions")).toBeNull();
    expect(right("GET", "/admin/telephony/log/tl_123")).toEqual([["log"]]);
    expect(right("PUT", "/admin/telephony/rules/outbound")).toEqual([["routing"]]);
    expect(right("PUT", "/admin/telephony/rules/outbound/")).toEqual([["routing"]]);
    expect(right("POST", "/admin/telephony/tsa/import")).toEqual([["tsa"]]);
    expect(right("GET", "/admin/telephony/tsa/catalog")).toBeNull();
    expect(right("POST", "/admin/telephony/tsa/ivr/publish")).toEqual([["tsa"]]);
    expect(right("POST", "/admin/telephony/sim/s1/event")).toEqual([["test"]]);
    expect(right("POST", "/admin/telephony/tests/call")).toEqual([["test"]]);
    expect(right("POST", "/admin/telephony/rules/test")).toBeNull();
    // Older endpoints, not in the contract.
    expect(right("POST", "/admin/telephony/test")).toEqual([["test", "settings"]]);
    expect(right("PUT", "/admin/telephony/sip/trunks")).toEqual([["settings"]]);
    expect(right("GET", "/admin/telephony/events")).toBeNull();
    expect(right("DELETE", "/admin/telephony/events")).toEqual([["settings"]]);
  });

  it("through consoleGuard: an operator with settings + test may change permissions, not the routing", async () => {
    role = "operator";
    try {
      expect((await call("GET", "/admin/telephony/rules")).status).toBe(200);
      expect((await call("PUT", "/admin/telephony/permissions", { log: { days: 14 } })).status).toBe(200);
      const denied = await call("PUT", "/admin/telephony/rules/outbound", { rules: [] });
      expect(denied.status).toBe(403);
      expect(denied.body).toMatchObject({ code: "module-denied" });
      expect(String(denied.body.message)).toContain("routing");
    } finally { role = "owner"; }
  });
});
