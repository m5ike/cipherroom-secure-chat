import { describe, it, expect } from "vitest";
import { formatFullDate, formatTime, formatBytes } from "../client/src/lib/format";

// 2026-09-22 14:05 UTC
const TS = Date.UTC(2026, 8, 22, 14, 5, 0);

describe("formatFullDate", () => {
  it("spells the month out, with day and year (cs)", () => {
    const s = formatFullDate(TS, "cs", "UTC");
    expect(s).toMatch(/22\.\s*září\s*2026/);
    expect(s).toMatch(/14:05/);
  });
  it("spells the month out in English too", () => {
    const s = formatFullDate(TS, "en", "UTC");
    expect(s).toMatch(/22 September 2026/);
    expect(s).toMatch(/14:05/);
  });
  it("respects the timezone", () => {
    expect(formatFullDate(TS, "en", "Europe/Prague")).toMatch(/16:05/);
  });
});

describe("formatTime / formatBytes", () => {
  it("formatTime shows hh:mm:ss", () => {
    expect(formatTime(TS, "en", "UTC")).toMatch(/14:05:00/);
  });
  it("formatBytes picks a unit", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 kB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
