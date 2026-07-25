import { describe, expect, it } from "vitest";
import { safeString, safeDeviceId, sanitizeMeta, safeId } from "../server/util";

describe("safeString", () => {
  it("returns the fallback for non-string inputs", () => {
    expect(safeString(undefined, "fallback")).toBe("fallback");
    expect(safeString(null, "fallback")).toBe("fallback");
    expect(safeString(42, "fallback")).toBe("fallback");
  });

  it("keeps printable ASCII alphanumerics, spaces, dots, hyphens, underscores", () => {
    expect(safeString("alfa-bravo_99.x", "fallback")).toBe("alfa-bravo_99.x");
    expect(safeString("Mr Mike 5", "fallback")).toBe("Mr Mike 5");
  });

  it("strips newlines, tabs, and other control characters", () => {
    expect(safeString("alfa\nbravo", "fallback")).toBe("alfabravo");
    expect(safeString("alfa\tbravo", "fallback")).toBe("alfabravo");
    expect(safeString("alfa\x00bravo", "fallback")).toBe("alfabravo");
  });

  it("strips dangerous URL/script characters", () => {
    expect(safeString("name<script>alert(1)</script>", "fallback")).toBe("namescriptalert1script");
    expect(safeString("name; DROP TABLE", "fallback")).toBe("name DROP TABLE");
  });

  it("truncates to max length", () => {
    const long = "a".repeat(200);
    expect(safeString(long, "fallback", 96)).toHaveLength(96);
  });

  it("returns fallback when nothing remains after sanitization", () => {
    expect(safeString("", "default")).toBe("default");
    expect(safeString("   ", "default")).toBe("default");
    expect(safeString("\n\n\n", "default")).toBe("default");
  });
});

describe("safeDeviceId", () => {
  it("accepts alphanumerics, hyphens, and underscores of valid length", () => {
    expect(safeDeviceId("abc-123_DEF")).toBe("abc-123_DEF");
    expect(safeDeviceId("abcd")).toBe("abcd");
  });

  it("rejects strings shorter than 4 chars", () => {
    expect(safeDeviceId("abc")).toBeNull();
    expect(safeDeviceId("")).toBeNull();
  });

  it("rejects strings longer than 64 chars", () => {
    expect(safeDeviceId("a".repeat(65))).toBeNull();
  });

  it("rejects invalid characters", () => {
    expect(safeDeviceId("abc def")).toBeNull();
    expect(safeDeviceId("abc.def")).toBeNull();
    expect(safeDeviceId("abc/def")).toBeNull();
  });

  it("rejects non-string inputs", () => {
    expect(safeDeviceId(null)).toBeNull();
    expect(safeDeviceId(undefined)).toBeNull();
    expect(safeDeviceId(42)).toBeNull();
  });
});

describe("sanitizeMeta", () => {
  it("keeps safe primitive values", () => {
    const r = sanitizeMeta({ count: 5, flag: true, name: "peer-1" });
    expect(r).toEqual({ count: 5, flag: true, name: "peer-1" });
  });

  it("drops values with disallowed keys", () => {
    const r = sanitizeMeta({ "bad key": 1, "ok_key": 2 });
    expect(r).toEqual({ ok_key: 2 });
  });

  it("drops non-finite numbers, nulls, objects", () => {
    const r = sanitizeMeta({ a: NaN, b: Infinity, c: null, d: { nested: 1 }, e: [1, 2] });
    expect(r).toBeUndefined();
  });

  it("truncates long strings and strips disallowed chars", () => {
    const r = sanitizeMeta({ name: "x".repeat(80) + "<script>" });
    expect(r?.name.length).toBe(64);
    expect(r?.name).not.toMatch(/[<>]/);
  });

  it("drops keys longer than 32 chars", () => {
    const r = sanitizeMeta({ ["k".repeat(33)]: 1 });
    expect(r).toBeUndefined();
  });
});

describe("safeId", () => {
  it("returns the sanitized string for valid input", () => {
    expect(safeId("room-1.peer_A")).toBe("room-1.peer_A");
  });

  it("returns undefined for non-string input", () => {
    expect(safeId(null)).toBeUndefined();
    expect(safeId(42)).toBeUndefined();
  });

  it("returns undefined when sanitization results in empty string", () => {
    expect(safeId("")).toBeUndefined();
    expect(safeId("---")).toBeUndefined();
  });

  it("truncates to max length", () => {
    expect(safeId("a".repeat(100))).toHaveLength(64);
  });
});
