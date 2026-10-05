// @vitest-environment node
// 6.12 (F-15, server part): the access log keeps networks, not addresses —
// IPv4 /24, IPv6 /48 — unless ACCESS_LOG_FULL_IP=1; 14 days by default.

import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "m5access-"));
process.env.DATA_DIR = dir;
const { accessLog, accessLogDays, accessLogDir, loggedIp } = await import("../server/access-log");

afterAll(() => { delete process.env.ACCESS_LOG_FULL_IP; delete process.env.ACCESS_LOG_DAYS; rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => { delete process.env.ACCESS_LOG_FULL_IP; });

const entry = (ip: string, subject = "alice") => ({ at: Date.now(), module: "functions", subject, kind: "user" as const, decision: "allow" as const, reason: "group", ip, via: "app" });

describe("access log addresses", () => {
  it("truncates IPv4 to /24 and IPv6 to /48 by default", () => {
    expect(loggedIp("203.0.113.77")).toBe("203.0.113.0/24");
    expect(loggedIp("::ffff:198.51.100.9")).toBe("198.51.100.0/24");
    expect(loggedIp("2001:db8:abcd:12:1:2:3:4")).toBe("2001:db8:abcd::/48");
    expect(loggedIp(undefined)).toBeUndefined();
  });

  it("ACCESS_LOG_FULL_IP=1 keeps the address", () => {
    process.env.ACCESS_LOG_FULL_IP = "1";
    expect(loggedIp("203.0.113.77")).toBe("203.0.113.77");
  });

  it("writes networks to the file and the recent list, and reads old full addresses back as networks", async () => {
    accessLog.record(entry("203.0.113.77", "bob"));
    await accessLog.flush();
    expect(accessLog.latest().at(-1)?.ip).toBe("203.0.113.0/24");
    const file = join(accessLogDir(), `access-${new Date().toISOString().slice(0, 10)}.jsonl`);
    const raw = readFileSync(file, "utf8");
    expect(raw).toContain("203.0.113.0/24");
    expect(raw).not.toContain("203.0.113.77");
    // A line from 6.11 with a full address.
    mkdirSync(accessLogDir(), { recursive: true });
    writeFileSync(file, `${raw}${JSON.stringify(entry("198.51.100.23", "carol"))}\n`);
    const { entries } = await accessLog.query({ subject: "carol" });
    expect(entries[0].ip).toBe("198.51.100.0/24");
  });

  it("keeps 14 days unless ACCESS_LOG_DAYS says otherwise", () => {
    expect(accessLogDays()).toBe(14);
    process.env.ACCESS_LOG_DAYS = "30";
    expect(accessLogDays()).toBe(30);
    delete process.env.ACCESS_LOG_DAYS;
  });
});
