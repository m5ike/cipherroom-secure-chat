import { describe, it, expect } from "vitest";
import { sealProfile, openProfile, _deriveKeyForTest } from "../client/src/lib/passkey";
import { ProfileStore, PROFILE_LIMITS } from "../server/passkey";

describe("passkey profile crypto", () => {
  it("seals and opens a profile under the derived key", async () => {
    const secret = new Uint8Array(32).fill(7);
    const key = await _deriveKeyForTest(secret);
    const profile = { name: "Alice", theme: "midnight", messageStyles: { bob: { fontColor: "#fff" } } };
    const ct = await sealProfile(profile, key);
    expect(ct).not.toContain("Alice");
    const back = await openProfile<typeof profile>(ct, key);
    expect(back).toEqual(profile);
  });

  it("fails to open with a different key", async () => {
    const k1 = await _deriveKeyForTest(new Uint8Array(32).fill(1));
    const k2 = await _deriveKeyForTest(new Uint8Array(32).fill(2));
    const ct = await sealProfile({ x: 1 }, k1);
    await expect(openProfile(ct, k2)).rejects.toBeTruthy();
  });
});

describe("ProfileStore", () => {
  const validId = "AbCdEfGhIjKlMnOp_-1234";

  it("stores and retrieves ciphertext by credential id", () => {
    const s = new ProfileStore();
    expect(s.put(validId, "cipher").ok).toBe(true);
    expect(s.get(validId)?.ciphertext).toBe("cipher");
  });

  it("rejects invalid credential ids and ciphertext", () => {
    const s = new ProfileStore();
    expect(s.put("short", "c").ok).toBe(false);
    expect(s.put("bad id with spaces!!", "c").ok).toBe(false);
    expect(s.put(validId, "").ok).toBe(false);
    expect(s.put(validId, "x".repeat(PROFILE_LIMITS.maxCiphertextChars + 1)).ok).toBe(false);
    expect(s.get("nope")).toBeNull();
  });

  it("deletes (locks) a profile", () => {
    const s = new ProfileStore();
    s.put(validId, "cipher");
    expect(s.delete(validId)).toBe(true);
    expect(s.get(validId)).toBeNull();
  });

  it("enforces the profile cap but still allows updates to existing ids", () => {
    const s = new ProfileStore();
    for (let i = 0; i < PROFILE_LIMITS.maxProfiles; i += 1) {
      expect(s.put(`cred${String(i).padStart(16, "0")}`, "c").ok).toBe(true);
    }
    // A brand-new id is refused once full…
    expect(s.put("credOverflow0000_-x", "c").ok).toBe(false);
    // …but updating an existing one still works.
    expect(s.put("cred0000000000000000", "c2").ok).toBe(true);
    expect(s.get("cred0000000000000000")?.ciphertext).toBe("c2");
  });
});
