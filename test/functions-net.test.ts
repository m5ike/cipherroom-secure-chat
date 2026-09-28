// The SSRF guard for m5.http (server/functions/host-net.ts, 4.15).

import { describe, it, expect } from "vitest";
import { isBlockedIp } from "../server/functions/host-net";

describe("isBlockedIp", () => {
  it("blocks private, loopback, link-local and metadata addresses", () => {
    for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "224.0.0.1", "::1", "::", "fe80::1", "fc00::1", "fd12::1", "::ffff:127.0.0.1", "::ffff:10.1.2.3"]) {
      expect(isBlockedIp(ip)).toBe(true);
    }
  });
  it("allows ordinary public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.66.147.243", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
      expect(isBlockedIp(ip)).toBe(false);
    }
  });
  it("refuses anything that is not an IP literal", () => {
    expect(isBlockedIp("example.com")).toBe(true);
    expect(isBlockedIp("")).toBe(true);
  });
});
