// @vitest-environment node
//
// The inroute table (6.9, server/telephony/control/inroute.ts): route codes
// in telephony.db — random codes from crypto that skip the guessable ones,
// unique among live codes (an expired one is taken over), the TTL (default
// 600 s, clamped by the permissions), the per-owner limit, uses and
// maxUses, the sweep, the per-caller failure counter that blocks brute
// force — and the log, which never shows a code in full. The hook
// (telHooks.inroute) is what route_audio and the TSA's Add route code use.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "m5inroute-"));
Object.assign(process.env, { DATA_DIR: dir, TELEPHONY_DATA_FILE: join(dir, "telephony.json"), TELEPHONY_DB_FILE: join(dir, "telephony.db") });

const inroute = await import("../server/telephony/control/inroute");
const { telHooks } = await import("../server/telephony/control/hooks");
const { savePermissions } = await import("../server/telephony/control/store");
const { telStore } = await import("../server/telephony/tel-store");
const { INROUTE_DEFAULT_TTL } = await import("../server/telephony/control/types");

type Logged = { kind: string; level?: string; summary: string; parsed?: unknown };
const logged: Logged[] = [];
const model = (id: string) => ({ kind: "model" as const, id });

beforeAll(async () => {
  await telStore.ready();
  expect(telStore.status().persistent).toBe(true);
  telHooks.log = (e) => logged.push(e as Logged);
});
afterAll(() => {
  telHooks.log = undefined;
  vi.useRealTimers();
  telStore.reset();
  rmSync(dir, { recursive: true, force: true });
});

describe("codes", () => {
  it("guessable codes are recognised", () => {
    for (const c of ["0000", "1111", "123456", "1234", "7890", "9876", "6543", "1212", "121212", "123123", "1987", "2024"]) expect(inroute.trivialCode(c), c).toBe(true);
    for (const c of ["4831", "905217", "70391", "1325", "2468"]) expect(inroute.trivialCode(c), c).toBe(false);
    expect(inroute.maskCode("483920")).toBe("•••••0");
    expect(inroute.maskCode("4831")).toBe("•••1");
  });

  it("a random code: 6 digits by default (or 4–5), never a guessable one; the default TTL is 600 s", async () => {
    const e = await inroute.inrouteAdd({ type: "room", room: "r3.alpha", createdBy: model("m1") });
    expect(e.code).toMatch(/^\d{6}$/);
    expect(inroute.trivialCode(e.code)).toBe(false);
    expect(e).toMatchObject({ type: "room", room: "r3.alpha", user: "", ttlSec: INROUTE_DEFAULT_TTL, uses: 0, maxUses: 0, createdBy: { kind: "model", id: "m1" } });
    expect(e.expiresAt - e.createdAt).toBe(600_000);
    const four = await inroute.inrouteAdd({ type: "room", room: "r3.alpha", digits: 4, createdBy: model("m1") });
    expect(four.code).toMatch(/^\d{4}$/);
    // The hook gives the same entry back.
    expect(await telHooks.inroute!.lookup(e.code)).toEqual(e);
  });

  it("a chosen code must be 4–6 digits and free among live codes", async () => {
    const e = await inroute.inrouteAdd({ code: "48213", type: "user", room: "r3.alpha", user: "Eva", ttl: 120, label: "Eva's line", createdBy: model("m1") });
    expect(e).toMatchObject({ code: "48213", type: "user", user: "Eva", ttlSec: 120, label: "Eva's line" });
    await expect(inroute.inrouteAdd({ code: "48213", type: "room", room: "r3.beta", createdBy: model("m2") })).rejects.toMatchObject({ code: "code-taken" });
    await expect(inroute.inrouteAdd({ code: "123", type: "room", room: "r3.beta", createdBy: model("m2") })).rejects.toMatchObject({ code: "bad-argument" });
    await expect(inroute.inrouteAdd({ code: "12a45", type: "room", room: "r3.beta", createdBy: model("m2") })).rejects.toMatchObject({ code: "bad-argument" });
    await expect(inroute.inrouteAdd({ type: "user", room: "r3.beta", createdBy: model("m2") })).rejects.toMatchObject({ code: "bad-argument", message: expect.stringMatching(/^user:/) });
    await expect(inroute.inrouteAdd({ type: "room", room: "", createdBy: model("m2") })).rejects.toMatchObject({ code: "bad-argument", message: expect.stringMatching(/^room:/) });
    await expect(inroute.inrouteAdd({ type: "everyone" as never, room: "r3.beta", createdBy: model("m2") })).rejects.toMatchObject({ code: "bad-argument" });
  });

  it("the TTL is clamped to 30 s … permissions.inroute.maxTtlSec; an expired code is gone and can be taken again", async () => {
    expect(savePermissions({ inroute: { maxTtlSec: 3600 } }, "test").ok).toBe(true);
    const long = await inroute.inrouteAdd({ type: "room", room: "r3.alpha", ttl: 999_999, createdBy: model("m3") });
    expect(long.ttlSec).toBe(3600);
    const short = await inroute.inrouteAdd({ code: "70391", type: "room", room: "r3.alpha", ttl: 1, createdBy: model("m3") });
    expect(short.ttlSec).toBe(30);
    vi.useFakeTimers({ now: Date.now() + 31_000, toFake: ["Date"] });
    try {
      expect(await inroute.inrouteLookup("70391")).toBeNull();
      const again = await inroute.inrouteAdd({ code: "70391", type: "room", room: "r3.other", createdBy: model("m4") });
      expect(again).toMatchObject({ code: "70391", room: "r3.other", createdBy: { id: "m4" } });
      expect((await inroute.inrouteList({ owner: model("m3") })).map((x) => x.code)).toEqual([long.code]);
    } finally { vi.useRealTimers(); }
  });

  it("uses are counted; a code with maxUses goes when used up", async () => {
    const e = await inroute.inrouteAdd({ type: "room", room: "r3.alpha", maxUses: 2, createdBy: model("m5") });
    await telHooks.inroute!.used(e.code);
    expect((await inroute.inrouteLookup(e.code))!.uses).toBe(1);
    await telHooks.inroute!.used(e.code);
    expect(await inroute.inrouteLookup(e.code)).toBeNull();
    expect(logged.some((l) => l.kind === "inroute" && /used up, removed/.test(l.summary))).toBe(true);
  });

  it("one owner has at most maxActivePerOwner live codes", async () => {
    expect(savePermissions({ inroute: { maxActivePerOwner: 2 } }, "test").ok).toBe(true);
    await inroute.inrouteAdd({ type: "room", room: "r3.a", createdBy: model("busy") });
    await inroute.inrouteAdd({ type: "room", room: "r3.a", createdBy: model("busy") });
    await expect(inroute.inrouteAdd({ type: "room", room: "r3.a", createdBy: model("busy") })).rejects.toMatchObject({ code: "inroute-limit" });
    // Someone else still may.
    await expect(inroute.inrouteAdd({ type: "room", room: "r3.a", createdBy: model("calm") })).resolves.toMatchObject({ type: "room" });
    expect(savePermissions({ inroute: { maxActivePerOwner: 50 } }, "test").ok).toBe(true);
  });

  it("del: a model removes only its own; the console any; list per owner or all", async () => {
    const mine = await inroute.inrouteAdd({ type: "room", room: "r3.a", createdBy: model("owner-a") });
    expect(await inroute.inrouteDel(mine.code, { owner: model("owner-b"), by: "owner-b" })).toBe(false);
    expect(await inroute.inrouteLookup(mine.code)).not.toBeNull();
    expect((await inroute.inrouteList({ owner: model("owner-a") })).map((e) => e.code)).toEqual([mine.code]);
    expect((await inroute.inrouteList()).length).toBeGreaterThan(3);
    expect(await inroute.inrouteDel(mine.code, { owner: model("owner-a"), by: "owner-a" })).toBe(true);
    expect(await inroute.inrouteDel(mine.code, { by: "admin:eva" })).toBe(false);
  });

  it("the sweep drops what has expired", async () => {
    const before = await inroute.inrouteCount();
    await inroute.inrouteAdd({ type: "room", room: "r3.a", ttl: 30, createdBy: model("sweep") });
    expect(await inroute.inrouteCount()).toBe(before + 1);
    expect(await inroute.inrouteSweep(Date.now() + 31_000)).toBeGreaterThanOrEqual(1);
    expect((await inroute.inrouteList({ owner: model("sweep") })).length).toBe(0);
  });

  it("the hook adds as the TSA's Add route code does", async () => {
    const e = await telHooks.inroute!.add({ digits: 5, type: "user", room: "r3.tsa", user: "@alice", ttl: 90, createdBy: { kind: "tsa", id: "reception", run: "s1" } });
    expect(e).toMatchObject({ type: "user", user: "@alice", ttlSec: 90, createdBy: { kind: "tsa", id: "reception", run: "s1" } });
    expect(e.code).toMatch(/^\d{5}$/);
  });
});

describe("brute force", () => {
  it("wrong codes are counted per caller number and hour; past the limit the caller is refused", async () => {
    expect(savePermissions({ inroute: { maxFailuresPerCallerPerHour: 3 } }, "test").ok).toBe(true);
    expect(await inroute.inrouteBlocked("+420603123456")).toBe(false);
    expect(await inroute.inrouteFailure("+420 603 123 456", { code: "11111" })).toEqual({ failures: 1, blocked: false });
    await inroute.inrouteFailure("+420603123456");
    expect(await inroute.inrouteFailure("00420603123456", { callId: "tc_1" })).toEqual({ failures: 3, blocked: true });
    expect(await inroute.inrouteBlocked("+420603123456")).toBe(true);
    expect(await inroute.inrouteBlocked("+420603999999")).toBe(false);
    // An hour later the counter is clean again.
    vi.useFakeTimers({ now: Date.now() + 3_600_001, toFake: ["Date"] });
    try { expect(await inroute.inrouteBlocked("+420603123456")).toBe(false); } finally { vi.useRealTimers(); }
    // Withheld callers share one bucket.
    await inroute.inrouteFailure("");
    expect((await inroute.inrouteFailure("anonymous")).failures).toBe(2);
  });
});

describe("the log", () => {
  it("logs every add, use, removal and failure — with the code masked", async () => {
    const e = await inroute.inrouteAdd({ code: "905217", type: "room", room: "r3.log", createdBy: model("logger") });
    await inroute.inrouteUsed(e.code);
    await inroute.inrouteDel(e.code, { by: "admin:eva" });
    await inroute.inrouteFailure("+15550100", { code: "905218" });
    const mine = logged.filter((l) => l.kind === "inroute");
    expect(mine.length).toBeGreaterThanOrEqual(4);
    const text = JSON.stringify(mine);
    expect(text).not.toMatch(/905217|905218|48213|70391/);
    expect(text).toContain("•••••7");
    expect(mine.some((l) => /route code •••••7 added → room r3\.log/.test(l.summary))).toBe(true);
    expect(mine.some((l) => /removed by admin:eva/.test(l.summary))).toBe(true);
    expect(mine.some((l) => /wrong route code •••••8 from \+15550100/.test(l.summary))).toBe(true);
    // A chosen guessable code is allowed, and logged as a warning.
    await inroute.inrouteAdd({ code: "4444", type: "room", room: "r3.log", createdBy: model("logger") });
    expect(logged.at(-1)).toMatchObject({ level: "warn", summary: expect.stringContaining("easily guessed") });
  });
});
