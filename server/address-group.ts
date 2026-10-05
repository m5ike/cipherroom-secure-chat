// What a per-address limit counts by (6.12 review S09).
//
// An IPv4 address is one subscriber (or one NAT); an IPv6 host gets a whole
// /64 — 2^64 addresses it may pick from at will (privacy addresses, or just a
// loop). A cap per FULL IPv6 address therefore never engages: 40 addresses of
// one /64 held every invitation, 4 every file-proxy slot. Every per-address
// cap and limiter of the server counts by `addressGroup()` instead:
//
//   IPv4                     the address itself ("198.51.100.7")
//   IPv4-mapped IPv6         the IPv4 address ("::ffff:198.51.100.7" → "198.51.100.7")
//   IPv6                     its /64 ("2001:db8:1:2::/64"), hex without leading zeros
//   anything else            the trimmed string (an unknown form is its own group)
//
// The HTTP limiters (express-rate-limit 8) already group IPv6 by /56.

import { isIPv4, isIPv6 } from "node:net";

/** The eight 16-bit words of an IPv6 address (an embedded IPv4 tail included), or null. */
function ipv6Words(address: string): number[] | null {
  let s = address;
  const tail: number[] = [];
  const v4 = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (v4) {
    const p = v4[1].split(".").map(Number);
    if (p.some((n) => n > 255)) return null;
    tail.push((p[0] << 8) | p[1], (p[2] << 8) | p[3]);
    s = s.slice(0, -v4[1].length);
    if (s.endsWith(":") && !s.endsWith("::")) s = s.slice(0, -1);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const words = (part: string) => (part ? part.split(":").map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)) : []);
  const head = words(halves[0]);
  const rest = halves.length === 2 ? words(halves[1]) : [];
  const fill = 8 - tail.length - head.length - rest.length;
  if (halves.length === 1 && fill !== 0) return null;
  if (fill < 0) return null;
  const all = [...head, ...Array(halves.length === 2 ? fill : 0).fill(0), ...rest, ...tail];
  return all.length === 8 && all.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? all : null;
}

/** The group a client address counts in for per-address caps (see the header). "" for no address. */
export function addressGroup(ip: string | null | undefined): string {
  let a = String(ip ?? "").trim().toLowerCase();
  if (!a) return "";
  if (a.startsWith("[") && a.endsWith("]")) a = a.slice(1, -1);
  const zone = a.indexOf("%");
  if (zone >= 0) a = a.slice(0, zone);
  const mapped = /^(?:0{0,4}:)*:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped && isIPv4(mapped[1])) return mapped[1];
  if (isIPv4(a)) return a;
  if (!isIPv6(a)) return a.slice(0, 64);
  const words = ipv6Words(a);
  if (!words) return a.slice(0, 64);
  return `${words.slice(0, 4).map((w) => w.toString(16)).join(":")}::/64`;
}

/** Whether two client addresses count as one for per-address caps. */
export function sameAddressGroup(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = addressGroup(a);
  return x !== "" && x === addressGroup(b);
}
