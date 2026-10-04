// @vitest-environment node
//
// 6.7 presence: online / away / far away from when a member was last seen
// (client/src/lib/presence.ts, shared by the server and the web; the
// Android app mirrors it), and the server's book of held members
// (server/signaling/presence.ts).

import { describe, it, expect } from "vitest";
import { PRESENCE_AWAY_MS, PRESENCE_ONLINE_MS, agoParts, presenceChangeIn, presenceOf, seenAt } from "../client/src/lib/presence";
import { HELD_LIMITS, HeldBook, maxAwayMs, type HeldMember } from "../server/signaling/presence";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const away = (lastSeen: number) => ({ connected: false, foreground: false, lastSeen });

describe("presenceOf", () => {
  it("is online while connected with the app in the foreground, whenever it was last seen", () => {
    expect(presenceOf({ connected: true, foreground: true, lastSeen: 0 }, NOW)).toBe("online");
    expect(presenceOf({ connected: true, foreground: true, lastSeen: NOW - 10 * 60 * MIN }, NOW)).toBe("online");
  });

  it("is online when last seen at most 5 minutes ago", () => {
    expect(PRESENCE_ONLINE_MS).toBe(5 * MIN);
    expect(presenceOf(away(NOW), NOW)).toBe("online");
    expect(presenceOf(away(NOW - 5 * MIN), NOW)).toBe("online");
    // In the background but still connected: the same rule.
    expect(presenceOf({ connected: true, foreground: false, lastSeen: NOW - 4 * MIN }, NOW)).toBe("online");
  });

  it("is away from just over 5 minutes to an hour", () => {
    expect(presenceOf(away(NOW - 5 * MIN - 1), NOW)).toBe("away");
    expect(presenceOf(away(NOW - 30 * MIN), NOW)).toBe("away");
    expect(PRESENCE_AWAY_MS).toBe(60 * MIN);
    expect(presenceOf(away(NOW - 60 * MIN), NOW)).toBe("away");
  });

  it("is far away after an hour, or when it was never seen", () => {
    expect(presenceOf(away(NOW - 60 * MIN - 1), NOW)).toBe("far");
    expect(presenceOf(away(NOW - 3 * 24 * 60 * MIN), NOW)).toBe("far");
    expect(presenceOf(away(0), NOW)).toBe("far");
  });

  it("says when the colour changes by itself, so a timer can redraw it", () => {
    expect(presenceChangeIn({ connected: true, foreground: true, lastSeen: NOW }, NOW)).toBeNull();
    const inOnline = presenceChangeIn(away(NOW - 2 * MIN), NOW)!;
    expect(presenceOf(away(NOW - 2 * MIN), NOW + inOnline)).toBe("away");
    expect(presenceOf(away(NOW - 2 * MIN), NOW + inOnline - 1)).toBe("online");
    const inAway = presenceChangeIn(away(NOW - 30 * MIN), NOW)!;
    expect(presenceOf(away(NOW - 30 * MIN), NOW + inAway)).toBe("far");
    expect(presenceChangeIn(away(NOW - 2 * 60 * MIN), NOW)).toBeNull();
  });

  it("puts last seen at now while connected in the foreground", () => {
    expect(seenAt({ connected: true, foreground: true, lastSeen: 5 }, NOW)).toBe(NOW);
    expect(seenAt({ connected: true, foreground: false, lastSeen: 5 }, NOW)).toBe(5);
  });

  it("words how long ago in minutes, hours and days", () => {
    expect(agoParts(NOW - 20_000, NOW)).toEqual({ unit: "now", n: 0 });
    expect(agoParts(NOW - 12 * MIN, NOW)).toEqual({ unit: "min", n: 12 });
    expect(agoParts(NOW - 3 * 60 * MIN - 5, NOW)).toEqual({ unit: "h", n: 3 });
    expect(agoParts(NOW - 2 * 24 * 60 * MIN, NOW)).toEqual({ unit: "d", n: 2 });
    expect(agoParts(NOW + 5_000, NOW)).toEqual({ unit: "now", n: 0 });
  });
});

describe("maxAwayMs (PRESENCE_MAX_AWAY_DAYS)", () => {
  const DAY = 24 * 60 * MIN;
  it("is 7 days by default, takes decimals, and 0 means never", () => {
    expect(maxAwayMs({})).toBe(7 * DAY);
    expect(maxAwayMs({ PRESENCE_MAX_AWAY_DAYS: "1.5" })).toBe(1.5 * DAY);
    expect(maxAwayMs({ PRESENCE_MAX_AWAY_DAYS: "0" })).toBe(0);
    expect(maxAwayMs({ PRESENCE_MAX_AWAY_DAYS: "soon" })).toBe(7 * DAY);
    expect(maxAwayMs({ PRESENCE_MAX_AWAY_DAYS: "-2" })).toBe(7 * DAY);
  });
});

describe("HeldBook", () => {
  const member = (peerId: string, since: number, accountId?: string): HeldMember => ({ peerId, name: peerId, joinedAt: since, lastSeen: since, since, ...(accountId ? { accountId } : {}) });

  it("keeps held members per room and hands one back once", () => {
    const book = new HeldBook();
    book.hold("a", member("p1", 1));
    book.hold("b", member("p2", 2, "acc"));
    expect(book.list("a").map((m) => m.peerId)).toEqual(["p1"]);
    expect(book.get("b", "p1")).toBeUndefined();
    expect(book.ofAccount("acc")).toEqual([{ room: "b", member: expect.objectContaining({ peerId: "p2" }) }]);
    expect(book.take("a", "p1")?.peerId).toBe("p1");
    expect(book.take("a", "p1")).toBeNull();
    expect(book.total()).toBe(1);
    expect(book.roomNames()).toEqual(["b"]);
  });

  it("lets members go after the maximum time, and never with 0", () => {
    const book = new HeldBook();
    book.hold("a", member("old", NOW - 10 * MIN));
    book.hold("a", member("new", NOW - MIN));
    expect(book.expire(NOW, 0)).toEqual([]);
    expect(book.expire(NOW, 5 * MIN).map((e) => e.member.peerId)).toEqual(["old"]);
    expect(book.list("a").map((m) => m.peerId)).toEqual(["new"]);
  });

  it("pushes the oldest out when a room is full of held members", () => {
    const book = new HeldBook();
    for (let i = 0; i < HELD_LIMITS.perRoom; i++) expect(book.hold("r", member(`p${i}`, i))).toEqual([]);
    const out = book.hold("r", member("last", NOW));
    expect(out.map((e) => e.member.peerId)).toEqual(["p0"]);
    expect(book.count("r")).toBe(HELD_LIMITS.perRoom);
  });
});
