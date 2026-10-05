// @vitest-environment node
//
// m5adm (6.0): a function reaches the administration through the main
// service's /api/admin/* with a signed function token — its grant's role and
// areas, never more. Here the whole path runs: the sandbox (JavaScript and
// Python), the host (host-adm.ts), HTTP, the guard (admin-auth.ts) and the
// admin routes, against a service whose live state is faked.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const dir = mkdtempSync(join(tmpdir(), "m5adm-"));
process.env.DATA_DIR = dir;
process.env.FUNCTIONS_DB_FILE = join(dir, "functions.db");
process.env.ADMIN_API_TOKEN = "owner-token-0123456789abcdef";

const express = (await import("express")).default;
const { registerAdminApi } = await import("../server/admin-api");
const { registerAdminClientConfigRoutes } = await import("../server/client-config");
const { functionsStore } = await import("../server/functions/store");
const { runAdhoc, closeRunner, execute } = await import("../server/functions/runner");
const { createPackage, saveDraft, publishDraft, saveModel, PackageError } = await import("../server/functions/packages");
const { mintAdmToken, verifyAdmToken, areaOfPath } = await import("../server/functions/adm-token");
const { ADM_OPERATIONS, filterRegex, roomFilters } = await import("../server/functions/host-adm");
const { ADM_SPEC } = await import("../server/functions/sdk-spec");
const { roomRegistry } = await import("../server/room-registry");
const { hashRoom } = await import("../server/monitor/traffic");

const ALPHA = "aaaaaaaaaaaaaaaa";
const BETA = "bbbbbbbbbbbbbbbb";
const accounts = [
  { id: "acc-eva", username: "eva", credential: { credentialId: "cred-eva-1" }, credentials: [{ credentialId: "cred-eva-2", label: "phone", createdAt: 1, lastUsedAt: 2 }], createdAt: 1, lastLoginAt: 2, push: [], vault: {}, away: false, audit: [] },
  { id: "acc-karel", username: "karel", credential: { credentialId: "cred-karel" }, createdAt: 1, lastLoginAt: 2, push: [], vault: {}, away: false, audit: [] },
];
const notices: Array<{ hash: string; notice: Record<string, unknown>; target?: Record<string, unknown> }> = [];
const disconnects: Array<{ hash: string; reason: string; target?: unknown }> = [];

let server: Server;
beforeAll(async () => {
  await functionsStore.ready();
  const app = express();
  app.use(express.json());
  const deps = {
    rooms: () => [
      { room: ALPHA, roomHash: ALPHA, peers: [{ peerId: "p-eva", name: "Eva", joinedAt: 1, connId: "c1", protocol: 2, accountId: "acc-eva" }, { peerId: "p-guest", name: "Host", joinedAt: 2, connId: "c2", protocol: 2 }], away: [] },
      { room: BETA, roomHash: BETA, peers: [{ peerId: "p-karel", name: "Karel", joinedAt: 3, connId: "c3", protocol: 2, accountId: "acc-karel" }], away: [] },
    ],
    closeConnection: () => true,
    queue: () => null,
    accounts: { all: () => accounts, get: (id: string) => accounts.find((a) => a.id === id), size: accounts.length, sessionCount: () => 0, mailboxStats: () => ({}) },
    storage: { isAvailable: false, status: () => ({ available: false }) },
    roomNotice: vi.fn((hash: string, notice: Record<string, unknown>, target?: Record<string, unknown>) => { notices.push({ hash, notice, target }); return target ? 1 : 2; }),
    roomDisconnect: vi.fn((hash: string, reason: string, target?: unknown) => { disconnects.push({ hash, reason, target }); return target ? 1 : 2; }),
    roomWake: vi.fn(async () => 1),
  };
  registerAdminApi(app, deps as never);
  registerAdminClientConfigRoutes(app, () => ({ accounts: 0, withConnections: 0, savedConnections: 0 }));
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  process.env.M5ADM_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  closeRunner();
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const owner = { kind: "console" as const, account: "", name: "boss", groups: [], room: null, client: "console", lang: "en", tz: "UTC", adminRole: "owner" as const };
const js = async (code: string, caller: Record<string, unknown> = owner) => {
  const r = await runAdhoc({ lang: "js", files: { "index.js": code }, entry: { file: "index.js", fn: "execute" }, inputs: {} }, caller as never);
  return r;
};
const valueOf = (r: Awaited<ReturnType<typeof js>>) => { const v = r.values[0] as { type: string; value?: unknown; text?: string }; return v.type === "text" ? v.text : v.value; };

describe("the function token", () => {
  it("carries the grant, expires, and cannot be forged", () => {
    const t = mintAdmToken({ role: "operator", areas: ["rooms", "audit"] }, { model: "cleaner", caller: "Eva" }, 60_000);
    expect(t.length).toBeLessThan(256);
    expect(verifyAdmToken(t)).toMatchObject({ role: "operator", areas: ["rooms", "audit"], model: "cleaner", caller: "Eva" });
    expect(verifyAdmToken(t, Date.now() + 120_000)).toBeNull();
    const [p, s] = t.slice(5).split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), r: 2 })).toString("base64url");
    expect(verifyAdmToken(`m5f1.${forged}.${s}`)).toBeNull();
  });

  it("maps paths to areas; sign-in, own passkeys and the live stream are never a function's", () => {
    expect(areaOfPath("/api/admin/rooms/abc/notice", "POST")).toBe("rooms");
    expect(areaOfPath("/api/admin/client-config", "PUT")).toBe("modules");
    expect(areaOfPath("/api/admin/me/passkeys/options", "POST")).toBeNull();
    expect(areaOfPath("/api/admin/live", "GET")).toBeNull();
    expect(areaOfPath("/api/admin/android/devices", "GET")).toBeNull();
  });

  it("the guard keeps a function to its areas and role", async () => {
    const call = (token: string, method: string, path: string, body?: unknown) => fetch(`${process.env.M5ADM_URL}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const rooms = mintAdmToken({ role: "auditor", areas: ["rooms"] }, { model: "m", caller: "c" }, 60_000);
    expect((await call(rooms, "GET", "/api/admin/rooms")).status).toBe(200);
    expect((await call(rooms, "GET", "/api/admin/users")).status).toBe(403);
    expect((await call(rooms, "POST", `/api/admin/rooms/${ALPHA}/notice`, { kind: "wall", text: "x" })).status).toBe(403); // auditor: read only
    expect((await call(rooms, "POST", "/api/admin/me/passkeys/options", {})).status).toBe(403);
    const who = await (await call(rooms, "GET", "/api/admin/whoami")).json() as { admin: { name: string; via: string } };
    expect(who.admin).toMatchObject({ name: "fn:m/c", via: "function" });
  });
});

describe("m5adm in JavaScript", () => {
  it("lists rooms by member filters (preg_match patterns) and gives m5room objects", async () => {
    const r = await js(`export async function execute() {
      const byName = await m5adm.rooms.list([{ key: "room_username", value: "/^eva$/i" }]);
      const byUser = await m5adm.rooms.list([["system_username", "^karel$"]]);
      const byPasskey = await m5adm.rooms.list({ system_passkey_id: "eva-2" });
      const none = await m5adm.rooms.list([{ key: "room_username", value: "^eva$" }]);
      const any = await m5adm.rooms.list([{ key: "room_username", value: "^Eva$" }, { key: "system_username", value: "^karel$" }], { match: "any" });
      return { byName: byName.map((x) => x.id), user: byUser.map((x) => x.id), pk: byPasskey.map((x) => x.id), none: none.length, any: any.length,
        methods: typeof byName[0].wall_msg + typeof byName[0].userFlash, members: byName[0].members.map((m) => m.username || m.name) };
    }`);
    expect(r.run.error).toBeNull();
    expect(valueOf(r)).toEqual({ byName: [ALPHA], user: [BETA], pk: [ALPHA], none: 0, any: 2, methods: "functionfunction", members: ["eva", "Host"] });
  }, 30_000);

  it("a room's controls: wall message (pinned), a flash to one member, block, connect, disconnect", async () => {
    notices.length = 0; disconnects.length = 0;
    const r = await js(`export async function execute() {
      const room = await m5adm.rooms.get("${ALPHA}");
      const wall = await room.wall_msg("Údržba ve 22:00", { level: "warning", pin: true });
      const flash = await room.user_flash("Eva", "Ahoj", "success");
      const msg = await room.user_msg({ peerId: "p-eva" }, "Soukromá zpráva");
      const block = await room.block({ reason: "maintenance", minutes: 5 });
      await room.refresh();
      const blocked = Boolean(room.blocked);
      const called = await room.connect();
      const out = await room.disconnect("Host", "bye");
      return { wall, flash, msg, block, blocked, called, out, pinned: room.wall && room.wall.text };
    }`);
    expect(r.run.error).toBeNull();
    expect(valueOf(r)).toEqual({ wall: 2, flash: true, msg: true, block: { blocked: true, disconnected: 2 }, blocked: true, called: 1, out: 1, pinned: "Údržba ve 22:00" });
    expect(notices[0]).toMatchObject({ hash: ALPHA, notice: { kind: "wall", text: "Údržba ve 22:00", level: "warning" } });
    expect(notices[1]).toMatchObject({ notice: { kind: "flash", level: "success" }, target: { name: "Eva" } });
    expect(notices[2]).toMatchObject({ notice: { kind: "message" }, target: { peerId: "p-eva" } });
    expect(disconnects.at(-1)).toMatchObject({ hash: ALPHA, reason: "bye", target: { name: "Host" } });
    // connect() opened the room again.
    expect(roomRegistry.get(ALPHA)?.blocked).toBeNull();
  }, 30_000);

  it("set: a record by room id (the id, or -1); stats; audit lines of its own", async () => {
    const r = await js(`export async function execute() {
      const created = await m5adm.rooms.set(null, { room: "alpha", label: "Alpha", tags: ["vip"], maxMembers: 5 });
      const bad = await m5adm.groups.set("X!", { label: "nope" });
      const group = await m5adm.groups.set("staff", { label: "Staff", members: ["eva"] });
      const stats = await m5adm.rooms.stats();
      const note = await m5adm.audit.add("cleanup.done", { rooms: 2 }, { level: "notice" });
      const users = await m5adm.users.list({ passkey: "^cred-eva" });
      return { created, bad, group, rooms: stats.rooms, members: stats.members, guests: stats.guests, event: note.event, actor: note.actor, users: users.map((u) => u.username), groups: users[0].groups };
    }`);
    expect(r.run.error).toBeNull();
    // 6.12 (F-04): keyed with the server secret, as the hub and the console know rooms.
    const hash = hashRoom("alpha")!;
    expect(hash).not.toBe(createHash("sha256").update("m5cet:room:alpha").digest("hex").slice(0, 16));
    expect(valueOf(r)).toMatchObject({ created: hash, bad: -1, group: "staff", rooms: 2, members: 3, guests: 1, event: "fn.cleanup.done", users: ["eva"] });
    expect((valueOf(r) as { groups: string[] }).groups).toContain("staff");
    expect(String((valueOf(r) as { actor: string }).actor)).toMatch(/^fn:console\/boss@/);
    expect(roomRegistry.get(hash)).toMatchObject({ label: "Alpha", tags: ["vip"], maxMembers: 5 });
    expect(r.run.status).toBe("done");
  }, 30_000);

  it("refuses code outside a model when it is not the console's, and says why", async () => {
    const r = await js(`export async function execute() { try { await m5adm.rooms.list(); return "no"; } catch (e) { return e.code + ": " + e.message; } }`, { ...owner, kind: "user", adminRole: undefined });
    expect(valueOf(r)).toMatch(/^adm-denied: code outside a model/);
    const info = await js(`export async function execute() { return await m5adm.info(); }`);
    expect(valueOf(info)).toMatchObject({ granted: true, role: "owner" });
  }, 30_000);
});

describe("m5adm in Python", () => {
  it("the same objects, snake_case, rooms as dicts with methods", async () => {
    const code = [
      "import m5adm as adm",
      "async def execute():",
      "    rooms = await m5adm.rooms.list([{'key': 'system_group', 'value': '^staff$'}])",
      "    room = rooms[0]",
      "    sent = await room.wall_msg('Ahoj z Pythonu')",
      "    saved = await m5adm.rooms.set(room.id, {'note': 'from python'})",
      "    same = adm.rooms is not None and m5.adm is m5adm",
      "    return {'ids': [r['id'] for r in rooms], 'sent': sent, 'saved': saved, 'same': same, 'note': (await m5adm.rooms.get(room.id)).note}",
    ].join("\n");
    const r = await runAdhoc({ lang: "py", files: { "main.py": code }, entry: { file: "main.py", fn: "execute" }, inputs: {} }, owner as never);
    expect(r.run.error).toBeNull();
    expect(valueOf(r)).toEqual({ ids: [ALPHA], sent: 2, saved: ALPHA, same: true, note: "from python" });
  }, 120_000);
});

describe("a model's grant", () => {
  it("only an owner grants the administration; a granted model is the owner's to change (anyone may switch it off)", () => {
    const pkg = createPackage("adm-cleaner", "js", "", "op");
    saveDraft(pkg.id, { "index.js": "export async function execute() { return await m5adm.rooms.stats(); }" }, {}, "op");
    const v = publishDraft(pkg.id, "minor", "op");
    const entry = `adm-cleaner@${v.version}:index.js#execute`;
    const grants = { admin: { enabled: true, role: "operator", areas: ["rooms", "nope"] } };
    expect(() => saveModel({ id: "cleaner", name: "Cleaner", entry, grants } as never, "op", "operator")).toThrow(PackageError);
    const m = saveModel({ id: "cleaner", name: "Cleaner", entry, grants, enabled: true } as never, "boss", "owner");
    expect(m.grants?.admin).toEqual({ enabled: true, role: "operator", areas: ["rooms"] });
    expect(() => saveModel({ id: "cleaner", summary: "changed" }, "op", "operator")).toThrow(/only an owner/);
    expect(saveModel({ id: "cleaner", enabled: false }, "op", "operator").enabled).toBe(false);
  });

  it("a model run acts with its grant: its areas, its role", async () => {
    saveModel({ id: "cleaner", enabled: true }, "boss", "owner");
    const model = functionsStore.model("cleaner")!;
    const user = { kind: "user" as const, account: "acc-eva", name: "Eva", groups: [], room: null, client: "web", lang: "en", tz: "UTC" };
    const ok = await execute(model, {}, user, { executor: "chat" });
    expect(ok.run.error).toBeNull();
    expect((ok.values[0] as { value: { rooms: number } }).value.rooms).toBe(2);

    const pkg = createPackage("adm-snoop", "js", "", "op");
    saveDraft(pkg.id, { "index.js": "export async function execute() { try { await m5adm.users.list(); return 'read'; } catch (e) { return e.code; } }" }, {}, "op");
    const v = publishDraft(pkg.id, "minor", "op");
    const snoop = saveModel({ id: "snoop", name: "Snoop", entry: `adm-snoop@${v.version}:index.js#execute`, enabled: true, grants: { admin: { enabled: true, role: "auditor", areas: ["rooms"] } } } as never, "boss", "owner");
    const denied = await execute(snoop, {}, user, { executor: "chat" });
    expect((denied.values[0] as { text: string }).text).toBe("adm-denied");
  }, 60_000);
});

describe("the SDK and its description agree", () => {
  it("every host operation is described, and every described one exists", () => {
    const described = Object.fromEntries(ADM_SPEC.filter((o) => o.name !== "info").map((o) => [o.name, o.methods.map((m) => m.name)]));
    for (const [obj, ops] of Object.entries(ADM_OPERATIONS)) for (const op of ops) expect(described[obj] ?? [], `${obj}.${op}`).toContain(op);
    for (const [obj, ops] of Object.entries(described)) for (const op of ops) expect(ADM_OPERATIONS[obj] ?? [], `${obj}.${op}`).toContain(op);
  });

  it("filters: preg_match patterns, and no nested quantifiers", () => {
    expect(filterRegex("/^EVA$/i").test("eva")).toBe(true);
    expect(filterRegex("^EVA$").test("eva")).toBe(false);
    expect(() => filterRegex("(a+)+$")).toThrow(/repeat/);
    expect(() => roomFilters([{ key: "password", value: "x" }])).toThrow(/room filter key/);
  });
});

const F = await import("../server/functions/flow");
const { ROOM_FILTER_KEYS: hostKeys } = await import("../server/functions/host-adm");

describe("the builder's Administration nodes", () => {
  const N = (id: string, type: string, x: number, params: Record<string, unknown> = {}, values: Record<string, unknown> = {}) => ({ id, type, x, y: 0, params, values });
  const E = (from: string, fp: string, to: string, tp: string) => ({ id: `${from}-${to}-${tp}`, from: { node: from, port: fp }, to: { node: to, port: tp } });

  it("list the same calls and filter keys as the host", () => {
    const fromHost = Object.entries(ADM_OPERATIONS).filter(([o]) => o !== "rooms").flatMap(([o, ops]) => ops.map((op) => `${o}.${op}`)).sort();
    expect([...F.ADM_CALLS].sort()).toEqual(fromHost);
    expect([...F.ROOM_FILTER_KEYS]).toEqual([...hostKeys]);
  });

  for (const lang of ["js", "py"] as const) {
    it(`a flow finds rooms, writes to their wall and counts them (${lang})`, async () => {
      notices.length = 0;
      const flow = F.parseFlow({
        ...F.emptyFlow(lang),
        nodes: [
          N("find", "adm.rooms.list", 0, { key: "system_username", match: "all" }, { value: "^karel$" }),
          N("wall", "adm.room.action", 200, { action: "wall_msg", level: "warning" }, { text: `Hello from a ${lang} flow` }),
          N("stats", "adm.rooms.stats", 0),
          N("obj", "data.object", 400, { keys: "count, sent, rooms" }),
          N("ret", "flow.return", 600),
        ],
        edges: [E("find", "first", "wall", "room"), E("find", "count", "obj", "count"), E("wall", "result", "obj", "sent"), E("stats", "rooms", "obj", "rooms"), E("obj", "object", "ret", "value")],
      });
      const c = F.compileFlow(flow);
      const r = await runAdhoc({ lang, files: { [c.file]: c.code }, entry: { file: c.file, fn: "execute" }, inputs: {} }, owner as never);
      expect(r.run.error).toBeNull();
      expect(valueOf(r)).toEqual({ count: 1, sent: 2, rooms: 2 });
      expect(notices.at(-1)).toMatchObject({ hash: BETA, notice: { kind: "wall", text: `Hello from a ${lang} flow`, level: "warning" } });
    }, 120_000);
  }
});
