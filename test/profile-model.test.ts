// @vitest-environment node
//
// The profile card (6.7, client/src/lib/profile/model.ts): who sees what.
// "Only me" never appears in a view for anyone else, room members get room
// and public items, the public only public ones; defaults keep everything to
// the owner; whatever a peer or a request hands over is rebuilt from checked
// values; the public nickname pre-fills a room's name field.

import { describe, it, expect } from "vitest";
import {
  cleanImage, cleanValue, emptyCard, fieldHref, isEmptyView, normalizeCard, normalizeShared, prefillNickname, PROFILE_LIMITS,
  profileRev, viewFor, visibleTo, type ProfileCard,
} from "../client/src/lib/profile/model";

const PNG_1PX = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function card(): ProfileCard {
  return normalizeCard({
    nickname: { value: "Alice", audience: "public" },
    about: { value: "Climber, coffee", audience: "room" },
    avatar: { value: PNG_1PX, audience: "room" },
    cover: { value: PNG_1PX, audience: "me" },
    fields: [
      { id: "f1", type: "phone", label: "Mobile", value: "+420 777 123 456", audience: "me" },
      { id: "f2", type: "email", label: "Work", value: "alice@example.com", audience: "room" },
      { id: "f3", type: "url", label: "Blog", value: "https://alice.example", audience: "public" },
      { id: "f4", type: "address", label: "Home", value: "Hlavní 1\nBrno", audience: "me" },
    ],
    updatedAt: 10,
  });
}

describe("audiences", () => {
  it("nest: me sees all, room sees room + public, public sees public", () => {
    expect(visibleTo("me", "me")).toBe(true);
    expect(visibleTo("me", "room")).toBe(false);
    expect(visibleTo("me", "public")).toBe(false);
    expect(visibleTo("room", "room")).toBe(true);
    expect(visibleTo("room", "public")).toBe(false);
    expect(visibleTo("public", "room")).toBe(true);
    expect(visibleTo("public", "public")).toBe(true);
  });

  it("a field marked only-me never appears in the room's or the public's view", () => {
    const c = card();
    const room = JSON.stringify(viewFor(c, "room"));
    const pub = JSON.stringify(viewFor(c, "public"));
    for (const secret of ["+420 777 123 456", "Hlavní 1", "Mobile", "Home"]) {
      expect(room).not.toContain(secret);
      expect(pub).not.toContain(secret);
    }
    // The background is only mine: one image in the room view (the photo), none in public.
    expect(viewFor(c, "room").cover).toBeUndefined();
    expect(viewFor(c, "public").avatar).toBeUndefined();
  });

  it("room members get room and public items; the public only public ones", () => {
    const c = card();
    const room = viewFor(c, "room");
    expect(room.nickname).toBe("Alice");
    expect(room.about).toBe("Climber, coffee");
    expect(room.avatar).toBe(PNG_1PX);
    expect(room.fields.map((f) => f.value)).toEqual(["alice@example.com", "https://alice.example"]);
    const pub = viewFor(c, "public");
    expect(pub).toMatchObject({ nickname: "Alice", fields: [{ type: "url", label: "Blog", value: "https://alice.example" }] });
    expect(pub.about).toBeUndefined();
    // The preview for me shows everything.
    expect(viewFor(c, "me").fields).toHaveLength(4);
    expect(viewFor(c, "me").cover).toBe(PNG_1PX);
  });

  it("views carry no audiences and no field ids", () => {
    const json = JSON.stringify(viewFor(card(), "me"));
    expect(json).not.toContain("audience");
    expect(json).not.toContain("\"id\"");
  });

  it("defaults are private; only the nickname is meant to be public — and an empty one shares nothing", () => {
    const e = emptyCard();
    expect([e.about.audience, e.avatar.audience, e.cover.audience]).toEqual(["me", "me", "me"]);
    expect(e.nickname.audience).toBe("public");
    expect(isEmptyView(viewFor(e, "public"))).toBe(true);
    expect(isEmptyView(viewFor(e, "room"))).toBe(true);
    // A new field without an audience is only mine.
    const c = normalizeCard({ fields: [{ type: "phone", label: "x", value: "+420 600 000 000" }] });
    expect(c.fields[0].audience).toBe("me");
    // Unknown audiences fall back to only me.
    expect(normalizeCard({ about: { value: "x", audience: "everyone" } }).about.audience).toBe("me");
  });

  it("a value that does not check out for its type is not shared", () => {
    const c = normalizeCard({ fields: [
      { type: "email", label: "", value: "not an email", audience: "public" },
      { type: "url", label: "", value: "javascript:alert(1)", audience: "public" },
      { type: "phone", label: "", value: "call me", audience: "public" },
    ] });
    expect(viewFor(c, "public").fields).toEqual([]);
    expect(cleanValue("url", "https://ok.example/x")).toBe("https://ok.example/x");
    expect(cleanValue("birthday", "1990-05-01")).toBe("1990-05-01");
    expect(cleanValue("birthday", "tomorrow")).toBe("");
  });
});

describe("what others hand over", () => {
  it("is rebuilt from checked values: unknown keys, scripts in URLs and foreign images are dropped", () => {
    const v = normalizeShared({
      v: 1, nickname: "  Bob‮  ", about: "hi", avatar: "https://tracker.example/pixel.png", cover: "data:image/svg+xml;base64,PHN2Zz4=",
      fields: [{ type: "url", label: "x", value: "javascript:alert(1)" }, { type: "email", label: "Mail", value: "bob@example.org" }, { type: "evil", label: "?", value: "free text" }],
      audience: "public", secret: "leak", updatedAt: 5,
    })!;
    expect(v.nickname).toBe("Bob");
    expect(v.avatar).toBeUndefined();
    expect(v.cover).toBeUndefined();
    expect(v.fields).toEqual([{ type: "email", label: "Mail", value: "bob@example.org" }, { type: "other", label: "?", value: "free text" }]);
    expect(JSON.stringify(v)).not.toContain("leak");
    expect(normalizeShared({ v: 2 })).toBeNull();
    expect(normalizeShared("x")).toBeNull();
  });

  it("caps sizes: long texts are cut, too many fields stop at the limit, an oversized image is refused", () => {
    const v = normalizeShared({
      v: 1, nickname: "n".repeat(200), about: "a".repeat(5_000),
      fields: Array.from({ length: 40 }, (_, i) => ({ type: "other", label: `l${i}`, value: "v" })),
    })!;
    expect(v.nickname).toHaveLength(PROFILE_LIMITS.nicknameChars);
    expect(v.about).toHaveLength(PROFILE_LIMITS.aboutChars);
    expect(v.fields).toHaveLength(PROFILE_LIMITS.fields);
    const big = `data:image/jpeg;base64,${"A".repeat(Math.ceil((PROFILE_LIMITS.avatarBytes + 10) * 4 / 3))}`;
    expect(cleanImage(big, PROFILE_LIMITS.avatarBytes)).toBe("");
    expect(cleanImage(PNG_1PX, PROFILE_LIMITS.avatarBytes)).toBe(PNG_1PX);
  });

  it("an absurdly large object is not a profile", () => {
    expect(normalizeShared({ v: 1, about: "x", pad: "y".repeat(400_000) })).toBeNull();
  });
});

describe("versions", () => {
  it("rev follows the content, not the save time", () => {
    const a = viewFor(card(), "room");
    const b = viewFor({ ...card(), updatedAt: 999 }, "room");
    expect(a.rev).toBe(b.rev);
    expect(a.rev).toMatch(/^[0-9a-f]{16}$/);
    const changed = viewFor({ ...card(), about: { value: "Climber", audience: "room" } }, "room");
    expect(changed.rev).not.toBe(a.rev);
    // The audience matters only through what it shows.
    expect(viewFor(card(), "public").rev).not.toBe(a.rev);
    expect(profileRev("")).toHaveLength(16);
  });

  it("a received view gets the same rev as the sender's (same content)", () => {
    const sent = viewFor(card(), "room");
    expect(normalizeShared(JSON.parse(JSON.stringify(sent)))!.rev).toBe(sent.rev);
  });
});

describe("the public nickname pre-fills a room's name", () => {
  it("when set; else the field keeps what it had", () => {
    const c = card();
    expect(prefillNickname(c, "peer-1234")).toBe("Alice");
    expect(prefillNickname(emptyCard(), "peer-1234")).toBe("peer-1234");
    expect(prefillNickname(null, "Bob")).toBe("Bob");
  });

  it("a name already typed for this room wins (the user can still change it)", () => {
    expect(prefillNickname(card(), "Al the climber", true)).toBe("Al the climber");
    expect(prefillNickname(card(), "   ", true)).toBe("Alice");
  });

  it("works whatever the nickname's audience (it is my own field)", () => {
    const c = normalizeCard({ nickname: { value: "Private Al", audience: "me" } });
    expect(prefillNickname(c, "x")).toBe("Private Al");
    expect(viewFor(c, "room").nickname).toBeUndefined();
  });
});

describe("links", () => {
  it("open only mailto:, tel: and http(s)", () => {
    expect(fieldHref("email", "a@b.cz")).toBe("mailto:a@b.cz");
    expect(fieldHref("phone", "+420 777 123 456")).toBe("tel:+420777123456");
    expect(fieldHref("url", "https://x.example")).toBe("https://x.example");
    expect(fieldHref("social", "@alice")).toBeNull();
    expect(fieldHref("url", "javascript:alert(1)")).toBeNull();
    expect(fieldHref("other", "https://x.example")).toBeNull();
  });
});
