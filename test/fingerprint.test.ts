import { describe, it, expect } from "vitest";
import {
  formatFingerprint,
  sha256Hex,
  compareFingerprint,
  persistFingerprint,
  loadFingerprints,
  dropFingerprint,
} from "../client/src/lib/fingerprint";

describe("formatFingerprint", () => {
  it("formats a 64-char hex digest as colon-separated uppercase pairs", () => {
    const out = formatFingerprint("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");
    expect(out).toBe("00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF");
    expect(out).toHaveLength(95); // 32 pairs * 2 chars + 31 colons
  });
  it("strips garbage chars before formatting", () => {
    const out = formatFingerprint(" 00:11:22:33 ");
    expect(out).toMatch(/^00:11:22:33(:00)*$/i);
  });
  it("returns empty string for empty input", () => {
    expect(formatFingerprint("")).toBe("");
  });
});

describe("sha256Hex", () => {
  it("produces 64-char lowercase hex", async () => {
    const h = await sha256Hex("hello");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // RFC: SHA-256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    expect(h).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });
  it("accepts Uint8Array buffers", async () => {
    const bytes = new Uint8Array([0x00, 0xff, 0x10]);
    const h = await sha256Hex(bytes);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("Fingerprint TOFU persistence", () => {
  it("first-use then match then mismatch", () => {
    const peer = "peer-TEST";
    dropFingerprint(peer);
    const first = compareFingerprint(peer, "abc123");
    expect(first.status).toBe("first-use");
    persistFingerprint(peer, "abc123");
    const second = compareFingerprint(peer, "abc123");
    expect(second.status).toBe("match");
    const third = compareFingerprint(peer, "deadbeef");
    expect(third.status).toBe("mismatch");
    dropFingerprint(peer);
  });

  it("persists to localStorage and reads back", () => {
    const peer = "peer-storage-TEST";
    dropFingerprint(peer);
    persistFingerprint(peer, "deadbeefdeadbeef");
    const stored = loadFingerprints()[peer];
    expect(stored).toBeDefined();
    expect(stored?.digest).toBe("deadbeefdeadbeef");
    dropFingerprint(peer);
  });
});
