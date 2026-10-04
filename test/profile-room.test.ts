// @vitest-environment node
//
// Profiles inside a room (6.7, client/src/lib/profile/room.ts): two members
// speak the announce / request / full protocol over a fake pair channel. Only
// the room view travels (never an only-me item), a cached copy is reused, a
// copy is kept under the sender's device key so nobody can plant one for
// someone else, a repeated request gets no second photo, an oversized frame
// is retried without the background, and validatePayload passes the frame
// only to callers that ask for it.

import { describe, it, expect } from "vitest";
import { normalizeCard, viewFor, isEmptyView, type ProfileCard, type SharedProfile } from "../client/src/lib/profile/model";
import { ANSWER_EVERY_MS, ProfileExchange, RoomProfiles, parseProfileFrame, type ProfileFrame } from "../client/src/lib/profile/room";
import { validatePayload } from "../client/src/lib/validate";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const aliceCard = (): ProfileCard => normalizeCard({
  nickname: { value: "Alice", audience: "public" },
  about: { value: "Hi room", audience: "room" },
  avatar: { value: PNG, audience: "room" },
  cover: { value: PNG, audience: "room" },
  fields: [
    { id: "a", type: "phone", label: "Private phone", value: "+420 777 000 111", audience: "me" },
    { id: "b", type: "email", label: "Mail", value: "alice@example.com", audience: "room" },
  ],
});

type Wire = Array<{ from: string; to: string; frame: ProfileFrame }>;

/** Two exchanges joined by a wire that records every frame (as JSON, like the channel). */
function pair(opts: { aliceView: () => SharedProfile | null; fit?: (frame: ProfileFrame) => boolean; now?: () => number }) {
  const wire: Wire = [];
  const nodes: Record<string, ProfileExchange> = {};
  const make = (me: string, view: () => SharedProfile | null) => new ProfileExchange(new RoomProfiles(), {
    myView: view,
    ownerOf: (peer) => `devkey-${peer}`,
    now: opts.now,
    send: async (peer, frame) => {
      if (opts.fit && !opts.fit(frame)) return false;
      const copy = JSON.parse(JSON.stringify(frame)) as Record<string, unknown>;
      wire.push({ from: me, to: peer, frame: copy as ProfileFrame });
      const parsed = parseProfileFrame(copy);
      if (parsed) await nodes[peer].receive(me, parsed);
      return true;
    },
  });
  nodes.alice = make("alice", opts.aliceView);
  nodes.bob = make("bob", () => null);
  return { wire, alice: nodes.alice, bob: nodes.bob };
}

describe("the exchange", () => {
  it("only the room view travels — nothing marked only-me is ever on the wire", async () => {
    const card = aliceCard();
    const { wire, alice, bob } = pair({ aliceView: () => viewFor(card, "room") });
    await bob.hello("alice", ["bin", "profile"]);
    await alice.hello("bob", ["bin", "profile"]);
    const got = bob.profiles.of("alice")!;
    expect(got.nickname).toBe("Alice");
    expect(got.fields).toEqual([{ type: "email", label: "Mail", value: "alice@example.com" }]);
    const all = JSON.stringify(wire);
    expect(all).not.toContain("+420 777 000 111");
    expect(all).not.toContain("Private phone");
    expect(all).not.toContain("audience");
    // announce → request → full
    expect(wire.filter((w) => w.from === "alice").map((w) => (w.frame.profile ? "full" : "announce"))).toEqual(["announce", "full"]);
    expect(wire.find((w) => w.from === "bob" && w.frame.want)).toBeTruthy();
  });

  it("a peer without the capability gets nothing", async () => {
    const { wire, alice } = pair({ aliceView: () => viewFor(aliceCard(), "room") });
    await alice.hello("bob", ["bin", "media"]);
    expect(wire).toEqual([]);
  });

  it("a known version is taken from the cache: the second time costs one small frame", async () => {
    const card = aliceCard();
    const { wire, alice, bob } = pair({ aliceView: () => viewFor(card, "room") });
    await alice.hello("bob", ["profile"]);
    bob.forget("alice");
    expect(bob.profiles.of("alice")).toBeNull();
    wire.length = 0;
    await alice.hello("bob", ["profile"]);
    expect(wire).toHaveLength(1);
    expect(wire[0].frame.profile).toBeUndefined();
    expect(bob.profiles.of("alice")?.nickname).toBe("Alice");
  });

  it("a change is announced to everyone and fetched again; nothing to share clears the copy", async () => {
    let card = aliceCard();
    const { alice, bob } = pair({ aliceView: () => { const v = viewFor(card, "room"); return isEmptyView(v) ? null : v; } });
    await alice.hello("bob", ["profile"]);
    card = normalizeCard({ ...card, about: { value: "New text", audience: "room" } });
    await alice.changed();
    expect(bob.profiles.of("alice")?.about).toBe("New text");
    card = normalizeCard({});
    await alice.changed();
    expect(bob.profiles.of("alice")).toBeNull();
  });

  it("asking twice for the same version within the window gets no second copy", async () => {
    let now = 1_000;
    const card = aliceCard();
    const { wire, alice } = pair({ aliceView: () => viewFor(card, "room"), now: () => now });
    const rev = viewFor(card, "room").rev;
    await alice.receive("bob", { rev, want: true });
    await alice.receive("bob", { rev, want: true });
    expect(wire.filter((w) => w.frame.profile)).toHaveLength(1);
    now += ANSWER_EVERY_MS + 1;
    await alice.receive("bob", { rev, want: true });
    expect(wire.filter((w) => w.frame.profile)).toHaveLength(2);
    // A request for some other version is ignored.
    await alice.receive("bob", { rev: "0000000000000000", want: true });
    expect(wire.filter((w) => w.frame.profile)).toHaveLength(2);
  });

  it("a frame too large for the channel goes again without the background", async () => {
    const card = aliceCard();
    const { bob, alice } = pair({ aliceView: () => viewFor(card, "room"), fit: (f) => !f.profile?.cover });
    await alice.hello("bob", ["profile"]);
    const got = bob.profiles.of("alice")!;
    expect(got.avatar).toBe(PNG);
    expect(got.cover).toBeUndefined();
  });
});

describe("the cache", () => {
  it("keeps a copy under the sender's device key: another member cannot plant one under someone's version", () => {
    const profiles = new RoomProfiles();
    const real = viewFor(aliceCard(), "room");
    const fake = { ...real, nickname: "Not Alice" };
    // Mallory sends a "full" frame claiming Alice's version.
    profiles.received("mallory", "devkey-mallory", { rev: real.rev, profile: fake });
    // Alice announces that version: it is not taken from Mallory's copy.
    expect(profiles.announced("alice", "devkey-alice", real.rev)).toBe("request");
    expect(profiles.of("alice")).toBeNull();
  });

  it("forgets everything on clear, and drops the oldest past its size", () => {
    const profiles = new RoomProfiles(2);
    const v = viewFor(aliceCard(), "room");
    profiles.received("p1", "k1", { rev: "r1", profile: v });
    profiles.received("p2", "k2", { rev: "r2", profile: v });
    profiles.received("p3", "k3", { rev: "r3", profile: v });
    expect(profiles.announced("p1", "k1", "r1")).toBe("request");
    expect(Object.keys(profiles.snapshot())).toEqual(["p2", "p3"]);
    profiles.clear();
    expect(profiles.snapshot()).toEqual({});
  });
});

describe("the payload", () => {
  const base = { id: "prof-1", createdAt: 1, senderId: "peer-b", senderName: "Bob" };

  it("passes validatePayload only for callers that ask (the relay and background rooms drop it)", () => {
    const p = { ...base, kind: "profile", rev: "abc123" };
    expect(validatePayload(p, { transportSender: "peer-b" })).toBeNull();
    expect(validatePayload(p, { transportSender: "peer-b", profiles: true })).toMatchObject({ kind: "profile", rev: "abc123" });
    // Bound to the peer that delivered it.
    expect(validatePayload(p, { transportSender: "peer-x", profiles: true })).toBeNull();
  });

  it("checks what it carries: a bad rev or a broken profile is no frame", () => {
    expect(parseProfileFrame({ rev: "<script>" })).toBeNull();
    expect(parseProfileFrame({ rev: "abc", profile: { v: 9 } })).toBeNull();
    expect(parseProfileFrame({ rev: "", want: true })).toBeNull();
    expect(parseProfileFrame({ rev: "" })).toEqual({ rev: "" });
    const full = parseProfileFrame({ rev: "abc", profile: { v: 1, nickname: "Bob", avatar: "https://evil.example/x.png", fields: [] } })!;
    expect(full.profile?.nickname).toBe("Bob");
    expect(full.profile?.avatar).toBeUndefined();
  });
});
