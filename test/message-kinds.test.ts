import { describe, it, expect } from "vitest";
import {
  sealText, openSealed, generateSealCode, clampVanishSeconds, hasAnyFlag,
  VANISH_MIN_SECONDS, VANISH_MAX_SECONDS,
} from "../client/src/lib/message-kinds";

describe("sealed messages", () => {
  it("round-trips text under the correct code", async () => {
    const { meta, ciphertext } = await sealText("tajná zpráva 🕵️", "ABC123");
    expect(ciphertext).not.toContain("tajná");
    expect(typeof meta.salt).toBe("string");
    expect(typeof meta.iv).toBe("string");
    const opened = await openSealed(ciphertext, meta, "ABC123");
    expect(opened).toBe("tajná zpráva 🕵️");
  });

  it("rejects a wrong code (AES-GCM tag mismatch)", async () => {
    const { meta, ciphertext } = await sealText("hello", "RIGHT1");
    await expect(openSealed(ciphertext, meta, "WRONG1")).rejects.toBeTruthy();
  });

  it("uses a fresh salt/iv each time (different ciphertext for same input)", async () => {
    const a = await sealText("same", "CODE12");
    const b = await sealText("same", "CODE12");
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.meta.iv).not.toBe(b.meta.iv);
  });
});

describe("generateSealCode", () => {
  it("returns the requested length from the safe alphabet only", () => {
    const code = generateSealCode(6);
    expect(code).toHaveLength(6);
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/);
    expect(code).not.toMatch(/[01OIL]/);
  });
  it("defaults to 12 characters in groups of four, without modulo bias", () => {
    const code = generateSealCode();
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
    // Every letter appears: rejection sampling keeps the tail of the
    // alphabet as likely as the head.
    const counts = new Map<string, number>();
    for (let i = 0; i < 400; i++) for (const ch of generateSealCode(12, false)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    expect(counts.size).toBe(31);
  });
  it("opens a v2 code however it is typed", async () => {
    const { meta, ciphertext } = await sealText("hello", "ABCD-EFGH-JKMN", 1000);
    expect(meta).toMatchObject({ v: 2, it: 1000 });
    expect(await openSealed(ciphertext, meta, "abcd efgh jkmn")).toBe("hello");
  });
  it("is non-deterministic across calls", () => {
    const codes = new Set(Array.from({ length: 20 }, () => generateSealCode()));
    expect(codes.size).toBeGreaterThan(1);
  });
});

describe("clampVanishSeconds", () => {
  it("clamps to the [4 s, 2 h] window", () => {
    expect(clampVanishSeconds(1)).toBe(VANISH_MIN_SECONDS);
    expect(clampVanishSeconds(999_999)).toBe(VANISH_MAX_SECONDS);
    expect(clampVanishSeconds(60)).toBe(60);
    expect(clampVanishSeconds(Number.NaN)).toBe(VANISH_MIN_SECONDS);
  });
});

describe("hasAnyFlag", () => {
  it("detects each kind and the empty case", () => {
    expect(hasAnyFlag(undefined)).toBe(false);
    expect(hasAnyFlag({})).toBe(false);
    expect(hasAnyFlag({ tap: true })).toBe(true);
    expect(hasAnyFlag({ vanishSeconds: 10 })).toBe(true);
    expect(hasAnyFlag({ sealed: { salt: "x", iv: "y" } })).toBe(true);
  });
});
