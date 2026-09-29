// @vitest-environment node
// Module access (5.2): the rules (default access, group access, the main
// group, grants that give or take parts, wildcards), the server's checks for
// app users and console administrators, the access log (allowed and
// refused), the main groups created when missing, and the module-aware
// filters in Functions, AI and telephony.

import { describe, it, expect, beforeAll } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA = mkdtempSync(join(tmpdir(), "m5acc-"));
process.env.DATA_DIR = DATA;

const M = await import("../client/src/lib/modules");
const { clientConfigStore } = await import("../server/client-config");
const A = await import("../server/access");
const { accessLog } = await import("../server/access-log");

const groups = [
  { id: "support", label: "Support", members: ["alice-1234", "admin:bob"] },
  { id: "dns-team", label: "DNS team", members: ["carol-5678"] },
  { id: "mod-functions", label: "Functions — all", members: ["dave-9999"] },
];

describe("rules", () => {
  it("wildcards: kinds, bare names, negation", () => {
    const r = M.compileRights(["model:dns*", "package:net-?", "*check", "-model:dns-secret"]);
    expect(M.can(r, "model:dns-host")).toBe(true);
    expect(M.can(r, "package:net-1")).toBe(true);
    expect(M.can(r, "package:net-12")).toBe(false);
    expect(M.can(r, "model:webcheck")).toBe(true); // "*check" without kind matches the name
    expect(M.can(r, "model:dns-secret")).toBe(false); // "-" wins
    expect(M.can(r, "model:whois", "package:net-1")).toBe(true); // any candidate
    expect(M.can(r, "model:whois", "model:dns-secret")).toBe(false); // any "-" hit denies
    expect(M.can(M.compileRights(["*"]), "anything")).toBe(true);
    expect(M.restricts(M.compileRights(["call", "number:+420*"]), "number")).toBe(true);
    expect(M.restricts(M.compileRights(["*"]), "number")).toBe(false);
  });

  it("aspects: an action and an item must both be granted when the rights name both", () => {
    const ai = M.compileRights(["chat", "provider:local"]);
    expect(M.permits(ai, ["chat"], ["provider:local", "model:local/llama"])).toBe(true);
    expect(M.permits(ai, ["chat"], ["provider:openai", "model:openai/gpt-5"])).toBe(false); // "chat" alone does not open every provider
    const fn = M.compileRights(["run", "model:dns*"]);
    expect(M.permits(fn, ["run"], ["model:dns", "package:dns"])).toBe(true);
    expect(M.permits(fn, ["run"], ["model:whois", "package:whois"])).toBe(false);
    expect(M.permits(fn, ["edit"], ["model:dns", "package:dns"])).toBe(false); // the action named is "run"
    expect(M.permits(M.compileRights(["package:net*"]), ["run", "edit"], ["model:dns", "package:netkit"])).toBe(true); // no action named: any
    expect(M.permits(M.compileRights(["*check"]), ["run"], ["model:webcheck"])).toBe(true);
    expect(M.permits(M.compileRights(["number:+420*"]), ["sms"], ["number:+420777000111"])).toBe(true);
    expect(M.permits(M.compileRights(["number:+420*"]), ["sms"], ["number:+1900555"])).toBe(false);
    expect(M.permits(M.compileRights(["number:+420*"]), ["settings"])).toBe(false); // names nothing of the console
    expect(M.permits(M.compileRights(["history"]), ["history", "edit"])).toBe(true);
    expect(M.permits(M.compileRights(["*", "-provider:openai"]), ["chat"], ["provider:openai"])).toBe(false);
    expect(M.permits(M.compileRights([]), ["run"])).toBe(false);
  });

  it("changing a tool module's rule or a group with console members takes the owner", () => {
    const prev = { modules: M.sanitizeModules({ functions: { enabled: true, defaultAccess: "deny" }, files: { enabled: true } }, groups), groups };
    const withRule = (id: string, patch: object) => ({ modules: { ...prev.modules, [id]: { ...prev.modules[id]!, ...patch } } });
    expect(M.ruleChangeNeedsOwner(prev, withRule("files", { enabled: false }))).toBeNull(); // an app module: operators
    expect(M.ruleChangeNeedsOwner(prev, withRule("functions", { defaultAccess: "allow" }))).toMatch(/Functions/);
    const members = (id: string, list: string[]) => ({ groups: groups.map((g) => (g.id === id ? { ...g, members: list } : g)) });
    expect(M.ruleChangeNeedsOwner(prev, members("dns-team", ["carol-5678", "frank-1111"]))).toBeNull(); // app users only
    expect(M.ruleChangeNeedsOwner(prev, members("dns-team", ["carol-5678", "admin:eve"]))).toMatch(/dns-team/); // a console member added
    expect(M.ruleChangeNeedsOwner(prev, members("support", ["alice-1234"]))).toMatch(/support/); // …or removed
    expect(M.ruleChangeNeedsOwner(prev, { modules: prev.modules, groups })).toBeNull(); // saved unchanged
  });

  it("decides: off, main group, access groups (allow / deny), default, grants", () => {
    const policy = M.sanitizeModules({
      functions: { enabled: true, defaultAccess: "deny", groupAccess: "allow", groups: ["support"], grants: [{ group: "dns-team", rights: ["model:dns*"] }, { group: "support", rights: ["-model:admin*"] }] },
      ai: { enabled: true, defaultAccess: "allow", groupAccess: "deny", groups: ["support"] },
      telephony: { enabled: false },
    }, groups);
    const f = (g: string[]) => M.decide(policy, "functions", g);
    expect(f(["guest"]).allowed).toBe(false);
    expect(f(["guest"]).reason).toBe("default-deny");
    const alice = f(["user", "support"]);
    expect(alice.reason).toBe("group-allow");
    expect(M.can(alice.rights, "model:whois")).toBe(true);
    expect(M.can(alice.rights, "model:admin-tools")).toBe(false); // taken away
    const carol = f(["user", "dns-team"]);
    expect(carol.allowed).toBe(true);
    expect(carol.reason).toBe("grant");
    expect(M.can(carol.rights, "model:dns")).toBe(true);
    expect(M.can(carol.rights, "model:whois")).toBe(false); // only the part granted
    const dave = f(["user", "mod-functions"]);
    expect(dave.reason).toBe("main-group");
    expect(M.can(dave.rights, "model:admin-tools")).toBe(true);
    expect(M.decide(policy, "ai", ["user", "support"]).allowed).toBe(false); // group access deny
    expect(M.decide(policy, "ai", ["user"]).allowed).toBe(true);
    expect(M.decide(policy, "telephony", ["user", "mod-telephony"]).reason).toBe("off");
    expect(M.decide(policy, "files", ["guest"]).reason).toBe("unlisted");
  });

  it("console administrators' groups and members", () => {
    expect(M.adminGroupsFor(groups, "bob", "operator")).toEqual(["admin", "admin-operator", "support"]);
    const g = M.sanitizeGroups([{ id: "x-team", members: ["admin:alice", "admin:Bad Name", "ok-user"] }, { id: "admin", members: [] }]);
    expect(g).toEqual([{ id: "x-team", label: "x-team", members: ["admin:alice", "ok-user"] }]); // "admin" is built in
  });

  it("the main groups of the tool modules, created when missing", () => {
    const missing = M.missingMainGroups([{ id: "mod-ai", label: "", members: [] }]).map((g) => g.id);
    expect(missing).toEqual(expect.arrayContaining(["mod-functions", "mod-telephony", "mod-layout", "mod-menu", "mod-speech"]));
    expect(missing).not.toContain("mod-ai");
    clientConfigStore.set({ groups });
    expect(A.ensureMainGroups("test")).toBe(true);
    expect(clientConfigStore.get().groups.map((g) => g.id)).toEqual(expect.arrayContaining(["mod-ai", "mod-layout", "mod-functions"]));
    expect(clientConfigStore.get().groups.find((g) => g.id === "mod-functions")!.members).toEqual(["dave-9999"]); // kept
    expect(A.ensureMainGroups("test")).toBe(false);
  });
});

describe("the server's checks and the access log", () => {
  beforeAll(() => {
    clientConfigStore.set({
      groups: [...groups, ...M.missingMainGroups(groups)],
      modules: {
        functions: { enabled: true, defaultAccess: "allow", groups: [], grants: [{ group: "support", rights: ["-model:secret*"] }], log: "all" },
        layout: { enabled: true, defaultAccess: "deny", groups: ["support"], groupAccess: "allow", log: "all" },
        menu: { enabled: true, defaultAccess: "allow", log: "deny" },
      },
    });
  });

  it("checkAccess: allowed and refused, both logged (log: all)", async () => {
    const alice = A.userSubject("alice-1234");
    expect(alice.groups).toEqual(["user", "support"]);
    expect(A.checkAccess("functions", alice, { right: ["model:whois"], path: "t" }).allowed).toBe(true);
    const no = A.checkAccess("functions", alice, { right: ["model:secret-tool"], path: "t" });
    expect(no.allowed).toBe(false);
    expect(no.reason).toBe("right");
    const { entries } = await accessLog.query({ module: "functions", subject: "alice" });
    expect(entries.map((e) => e.decision)).toEqual(["deny", "allow"]);
  });

  it("log: deny keeps only refusals", async () => {
    A.checkAccess("menu", A.adminSubject("zed", "operator"), { path: "t" });
    const { entries } = await accessLog.query({ module: "menu" });
    expect(entries).toHaveLength(0);
  });

  it("consoleGuard: an operator outside the access group is refused, a member passes, an owner always", async () => {
    const app = express();
    app.use((req, res, next) => { res.locals.adminName = String(req.headers["x-who"]); res.locals.adminRole = String(req.headers["x-role"]); next(); });
    app.use("/admin/layout", A.consoleGuard("layout", (req) => (req.method === "GET" ? null : ["edit"])));
    app.all("/admin/layout", (_req, res) => res.json({ ok: true }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/admin/layout`;
    const as = (who: string, role: string, method = "GET") => fetch(url, { method, headers: { "x-who": who, "x-role": role } });
    try {
      expect((await as("carl", "operator")).status).toBe(403);
      expect((await as("bob", "operator")).status).toBe(200); // admin:bob is in "support", the access group
      expect((await as("bob", "operator", "PUT")).status).toBe(200);
      expect((await as("owen", "owner", "PUT")).status).toBe(200); // owners are never locked out
      const { entries } = await accessLog.query({ module: "layout" });
      expect(entries.some((e) => e.subject === "admin:carl" && e.decision === "deny" && e.via === "console")).toBe(true);
      expect(entries.some((e) => e.subject === "admin:owen" && e.reason === "owner")).toBe(true);
    } finally { server.close(); }
  });

  it("the access log is written to a day file", async () => {
    await accessLog.flush();
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(join(DATA, "access")).some((f) => /^access-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))).toBe(true);
  });
});

describe("modules in the services", () => {
  it("AI: a grant takes a provider away, and gives only some models", async () => {
    const { moduleAllows } = await import("../server/ai/service");
    clientConfigStore.set({
      groups,
      modules: { ai: { enabled: true, defaultAccess: "allow", grants: [{ group: "support", rights: ["-provider:openai"] }] }, speech: { enabled: true, defaultAccess: "deny", grants: [{ group: "dns-team", rights: ["model:local/piper-cs*"] }] } },
    });
    const caller = (g: string[]) => ({ source: "app" as const, actor: "x", account: "", groups: g, console: false });
    expect(moduleAllows(caller(["user"]), "chat", "openai", "gpt-x")).toBe(true);
    expect(moduleAllows(caller(["user", "support"]), "chat", "openai", "gpt-x")).toBe(false);
    expect(moduleAllows(caller(["user", "support"]), "chat", "anthropic", "claude")).toBe(true);
    expect(moduleAllows(caller(["user", "dns-team"]), "tts", "local", "piper-cs_CZ-jirka-medium")).toBe(true);
    expect(moduleAllows(caller(["user", "dns-team"]), "tts", "openai", "tts-1")).toBe(false);
    expect(moduleAllows(caller(["user"]), "stt", "local", "whisper-small")).toBe(false); // speech: default deny
    expect(moduleAllows({ ...caller([]), console: true }, "stt", "local", "whisper-small")).toBe(true);
    clientConfigStore.set({ groups, modules: { ai: { enabled: true, defaultAccess: "deny", grants: [{ group: "support", rights: ["chat", "provider:local"] }] } } });
    expect(moduleAllows(caller(["user", "support"]), "chat", "local", "llama")).toBe(true);
    expect(moduleAllows(caller(["user", "support"]), "chat", "openai", "gpt-x")).toBe(false); // chat — but only with the local provider
  });
});
