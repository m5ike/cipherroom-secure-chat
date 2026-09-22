import { describe, it, expect } from "vitest";
import { sealProfile, openProfile, _deriveKeyForTest } from "../client/src/lib/passkey";

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
