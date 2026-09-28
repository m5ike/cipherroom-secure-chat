// The cron matcher for scheduled functions (server/functions/cron.ts, 4.15).

import { describe, it, expect } from "vitest";
import { parseCron, cronMatches, cronError } from "../server/functions/cron";

const at = (iso: string) => new Date(iso);

describe("parseCron / cronMatches", () => {
  it("matches a plain expression to the minute (UTC)", () => {
    const c = parseCron("30 14 * * *");
    expect(cronMatches(c, at("2026-09-28T14:30:00Z"), "UTC")).toBe(true);
    expect(cronMatches(c, at("2026-09-28T14:31:00Z"), "UTC")).toBe(false);
    expect(cronMatches(c, at("2026-09-28T13:30:00Z"), "UTC")).toBe(false);
  });
  it("handles */step, ranges and lists", () => {
    expect(cronMatches(parseCron("*/15 * * * *"), at("2026-01-01T00:15:00Z"), "UTC")).toBe(true);
    expect(cronMatches(parseCron("*/15 * * * *"), at("2026-01-01T00:16:00Z"), "UTC")).toBe(false);
    expect(cronMatches(parseCron("0 9-17 * * *"), at("2026-01-01T12:00:00Z"), "UTC")).toBe(true);
    expect(cronMatches(parseCron("0 0 * * 1,3,5"), at("2026-09-28T00:00:00Z"), "UTC")).toBe(true); // Monday
    expect(cronMatches(parseCron("0 0 * * 2"), at("2026-09-28T00:00:00Z"), "UTC")).toBe(false);
  });
  it("understands @shortcuts and named months/days", () => {
    expect(cronMatches(parseCron("@daily"), at("2026-05-05T00:00:00Z"), "UTC")).toBe(true);
    expect(cronMatches(parseCron("0 0 1 jan *"), at("2026-01-01T00:00:00Z"), "UTC")).toBe(true);
    expect(cronMatches(parseCron("0 0 * * sun"), at("2026-09-27T00:00:00Z"), "UTC")).toBe(true); // Sunday
  });
  it("respects the time zone", () => {
    const c = parseCron("0 9 * * *");
    // 09:00 in Prague (UTC+2 in September) is 07:00 UTC.
    expect(cronMatches(c, at("2026-09-28T07:00:00Z"), "Europe/Prague")).toBe(true);
    expect(cronMatches(c, at("2026-09-28T09:00:00Z"), "Europe/Prague")).toBe(false);
  });
  it("reports errors for bad expressions", () => {
    expect(cronError("* * *")).toMatch(/five fields|shortcut/);
    expect(cronError("99 * * * *")).toMatch(/range/);
    expect(cronError("*/0 * * * *")).toMatch(/step/);
    expect(cronError("*/15 * * * *")).toBeNull();
  });
});
