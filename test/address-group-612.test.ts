// @vitest-environment node
// 6.12 review S09: per-address caps count an IPv6 client by its /64.

import { describe, it, expect } from "vitest";
import { addressGroup, sameAddressGroup } from "../server/address-group";
import { clientKeyFor } from "../server/storage/api";
import { ConnectionGate } from "../server/signaling/limits";

describe("addressGroup", () => {
  it("IPv4 as it is, IPv4-mapped as IPv4, IPv6 by its /64", () => {
    expect(addressGroup("198.51.100.7")).toBe("198.51.100.7");
    expect(addressGroup("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(addressGroup("0:0:0:0:0:ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(addressGroup("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(addressGroup("2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(addressGroup("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(addressGroup("[2001:db8::1]")).toBe("2001:db8:0:0::/64");
    expect(addressGroup("64:ff9b::1.2.3.4")).toBe("64:ff9b:0:0::/64");
    expect(addressGroup("1:2:3:4:5:6:1.2.3.4")).toBe("1:2:3:4::/64");
    expect(addressGroup("::1")).toBe("0:0:0:0::/64");
    expect(addressGroup("")).toBe("");
    expect(addressGroup(undefined)).toBe("");
    expect(addressGroup("unknown")).toBe("unknown");
  });

  it("one /64 is one group, the next /64 another", () => {
    expect(sameAddressGroup("2001:db8:aa:bb::1", "2001:db8:aa:bb:ffff:ffff:ffff:ffff")).toBe(true);
    expect(sameAddressGroup("2001:db8:aa:bb::1", "2001:db8:aa:bc::1")).toBe(false);
    expect(sameAddressGroup("", "")).toBe(false);
  });

  it("the storage API's client key agrees with it", () => {
    expect(clientKeyFor("2001:db8:1:2::1")).toBe(`ip6:${addressGroup("2001:db8:1:2::1")}`);
    expect(clientKeyFor("::ffff:198.51.100.7")).toBe("ip:198.51.100.7");
  });
});

describe("the hub's connection gate counts a /64 once", () => {
  it("connections open at once and per minute", () => {
    const gate = new ConnectionGate({ perMinute: 100, concurrentPerClient: 3, concurrentTotal: 100 });
    for (let i = 1; i <= 3; i += 1) expect(gate.admit(`2001:db8:5:6::${i}`)).toBeNull();
    expect(gate.admit("2001:db8:5:6::99")).toBe("too-many-connections");
    expect(gate.admit("2001:db8:5:7::1")).toBeNull();
    gate.release("2001:db8:5:6::1");
    expect(gate.admit("2001:db8:5:6::abcd")).toBeNull();
    const perMinute = new ConnectionGate({ perMinute: 2, concurrentPerClient: 100, concurrentTotal: 100 });
    expect(perMinute.admit("2001:db8::1")).toBeNull();
    expect(perMinute.admit("2001:db8::2")).toBeNull();
    expect(perMinute.admit("2001:db8::3")).toBe("rate-limited");
  });
});
