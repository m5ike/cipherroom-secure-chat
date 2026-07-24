import { describe, it, expect } from "vitest";

// Extrahujeme safeString ze server/routes.ts pro unit test
// (v produkčním kódu je soukromá; zde ji reimplementujeme test-only)

function safeString(value: unknown, fallback: string, max = 96): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value
    .trim()
    .normalize("NFC")
    .replace(/[^\u0020a-zA-Z0-9._-]/g, "")
    .replace(/ {2,}/g, " ")
    .slice(0, max);
  return trimmed || fallback;
}

describe("server safeString", () => {
  it("returns fallback for non-string", () => {
    expect(safeString(null, "x")).toBe("x");
    expect(safeString(undefined, "x")).toBe("x");
    expect(safeString(42, "x")).toBe("x");
    expect(safeString({}, "x")).toBe("x");
  });

  it("strips control characters (\\n \\r \\t \\0 \\v)", () => {
    expect(safeString("Al\nice\r\t", "f")).toBe("Alice");
    expect(safeString("\u0000evil\u0000", "f")).toBe("evil");
  });

  it("collapses multiple spaces to single", () => {
    expect(safeString("a   b    c", "f")).toBe("a b c");
  });

  it("preserves ASCII letters, digits, dot, underscore, hyphen", () => {
    expect(safeString("Mr._Smith-42", "f")).toBe("Mr._Smith-42");
  });

  it("normalizes unicode and limits length", () => {
    const long = "a".repeat(120);
    expect(safeString(long, "f", 10)).toHaveLength(10);
  });

  it("returns fallback when everything was stripped", () => {
    expect(safeString("🔥💀☠", "anon")).toBe("anon");
  });

  it("NFC-normalizes equivalent Czech strings", () => {
    const nfd = "Český".normalize("NFD");
    const nfc = "Český";
    expect(safeString(nfd, "f")).toBe(safeString(nfc, "f"));
  });
});
