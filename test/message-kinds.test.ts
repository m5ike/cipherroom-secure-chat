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
