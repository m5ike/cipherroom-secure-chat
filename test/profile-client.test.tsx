// The profile card in the browser (6.7, client/src/lib/profile/client.ts and
// its editor / views): what actually leaves the tab. Saving puts ONLY the
// public items on /api/profile and the whole card into the vault — sealed,
// so nothing marked "only me" is ever readable outside this device. The
// editor's audience switches decide the preview of each audience; another
// member's profile shows what they share, and their public one on request,
// marked verified only when the signing account matches.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

const session = vi.hoisted(() => ({ key: null as CryptoKey | null, token: "tok-abcdefghijklmnopqrstuvwxyz" as string | null }));
vi.mock("../client/src/lib/account", () => ({
  accountToken: () => session.token,
  vaultKey: () => session.key,
}));

import { openProfile, sealProfile } from "../client/src/lib/passkey";
import { _setCardForTests, currentCard, fetchPublicProfile, loadCard, myRoomView, saveCard } from "../client/src/lib/profile/client";
import { normalizeCard, type ProfileCard } from "../client/src/lib/profile/model";
import { ProfileEditor } from "../client/src/components/ProfileEditor";
import { PeerProfile } from "../client/src/components/PeerProfile";
import { UserInfoView, type UserInfo } from "../client/src/components/UserInfoModal";
import { PeerList } from "../client/src/components/CallPanels";

type Call = { url: string; method: string; body: string; auth: string | null };
let calls: Call[] = [];
let replies: Record<string, (c: Call) => Response> = {};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(async () => {
  session.key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  session.token = "tok-abcdefghijklmnopqrstuvwxyz";
  calls = [];
  replies = {};
  _setCardForTests(null);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const c: Call = { url: String(url), method: init.method ?? "GET", body: String(init.body ?? ""), auth: headers.Authorization ?? null };
    calls.push(c);
    const reply = replies[`${c.method} ${c.url}`];
    return reply ? reply(c) : json({ ok: true, account: {} });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const CARD = (): ProfileCard => normalizeCard({
  nickname: { value: "Alice", audience: "public" },
  about: { value: "Only my friends in rooms", audience: "room" },
  fields: [
    { id: "f1", type: "phone", label: "Private", value: "+420 777 000 111", audience: "me" },
    { id: "f2", type: "url", label: "Blog", value: "https://alice.example", audience: "public" },
  ],
});

describe("saving the card", () => {
  it("only public items go to /api/profile; the vault gets the whole card sealed; only-me never leaves readable", async () => {
    const r = await saveCard(CARD(), 1234);
    expect(r.public).toBe("published");
    const pub = calls.find((c) => c.method === "PUT" && c.url === "/api/profile")!;
    expect(pub.auth).toBe("Bearer tok-abcdefghijklmnopqrstuvwxyz");
    const sent = JSON.parse(pub.body).profile;
    expect(sent).toMatchObject({ v: 1, nickname: "Alice", fields: [{ type: "url", label: "Blog", value: "https://alice.example" }] });
    expect(sent.about).toBeUndefined();
    const vault = calls.find((c) => c.method === "PUT" && c.url === "/api/account/vault")!;
    for (const c of calls) {
      expect(c.body).not.toContain("+420 777 000 111");
      expect(c.body).not.toContain("Only my friends");
    }
    // The vault's card opens with the key — and holds everything, with the audiences.
    const opened = await openProfile<ProfileCard>(JSON.parse(vault.body).card, session.key!);
    expect(opened.fields.map((f) => [f.value, f.audience])).toEqual([["+420 777 000 111", "me"], ["https://alice.example", "public"]]);
    expect(opened.published).toBe(true);
    expect(opened.updatedAt).toBe(1234);
    expect(currentCard()?.published).toBe(true);
  });

  it("withdraws the public copy once nothing is public any more — and only then", async () => {
    const card = normalizeCard({ ...CARD(), nickname: { value: "Alice", audience: "room" }, fields: [], published: true });
    const r = await saveCard(card);
    expect(r.public).toBe("withdrawn");
    expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/profile")).toBe(true);
    calls = [];
    const again = await saveCard(r.card);
    expect(again.public).toBe("none");
    expect(calls.some((c) => c.url === "/api/profile")).toBe(false);
  });

  it("a refused public part still saves the card, and says why", async () => {
    replies["PUT /api/profile"] = () => json({ ok: false, message: "Too many profile changes" }, 429);
    const r = await saveCard(CARD());
    expect(r.publicError).toContain("Too many");
    expect(calls.some((c) => c.method === "PUT" && c.url === "/api/account/vault")).toBe(true);
    expect(r.card.published).toBeUndefined();
  });

  it("is refused signed out", async () => {
    session.key = null;
    await expect(saveCard(CARD())).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe("loading the card", () => {
  it("opens the vault's slot, or starts an empty (private) one", async () => {
    const sealed = await sealProfile(CARD(), session.key!);
    replies["GET /api/account/vault?only=card"] = () => json({ ok: true, card: { ct: sealed } });
    expect((await loadCard())?.nickname.value).toBe("Alice");
    expect(myRoomView()?.about).toBe("Only my friends in rooms");
    replies["GET /api/account/vault?only=card"] = () => json({ ok: true, card: null });
    const empty = await loadCard();
    expect(empty?.about.audience).toBe("me");
    expect(myRoomView(empty)).toBeNull();
  });
});

describe("a public lookup", () => {
  it("asks only for that username, without the session; 404 is nothing; what comes is checked", async () => {
    replies["GET /api/profile/bob-x"] = () => json({ ok: false }, 404);
    expect(await fetchPublicProfile("bob-x")).toBeNull();
    expect(calls[0].auth).toBeNull();
    replies["GET /api/profile/carol-y"] = () => json({ ok: true, username: "carol-y", profile: { v: 1, nickname: "Carol", avatar: "https://evil.example/p.png", fields: [] }, accountKey: "K".repeat(43) });
    const got = (await fetchPublicProfile("carol-y"))!;
    expect(got.profile.nickname).toBe("Carol");
    expect(got.profile.avatar).toBeUndefined();
    expect(got.accountKey).toBe("K".repeat(43));
    expect(await fetchPublicProfile("../admin")).toBeNull();
  });
});

describe("the editor", () => {
  it("previews exactly what each audience gets, follows the audience switches, and saves", async () => {
    _setCardForTests(CARD());
    render(<ProfileEditor lang="en" signedIn />);
    expect(screen.getByTestId("profile-save")).toHaveProperty("disabled", true);
    // Room members: the about text, not the private phone.
    fireEvent.click(screen.getByTestId("profile-preview-room"));
    expect(screen.getByTestId("profile-preview").textContent).toContain("Only my friends in rooms");
    expect(screen.getByTestId("profile-preview").textContent).not.toContain("+420 777 000 111");
    // Public: no about text.
    fireEvent.click(screen.getByTestId("profile-preview-public"));
    expect(screen.getByTestId("profile-preview").textContent).not.toContain("Only my friends");
    // Only me: everything.
    fireEvent.click(screen.getByTestId("profile-preview-me"));
    expect(screen.getByTestId("profile-preview").textContent).toContain("+420 777 000 111");
    // The phone made public shows in the public preview; the change is unsaved.
    fireEvent.click(screen.getByTestId("profile-field-0-aud-public"));
    expect(screen.getByTestId("profile-field-0-aud").getAttribute("data-value")).toBe("public");
    fireEvent.click(screen.getByTestId("profile-preview-public"));
    expect(screen.getByTestId("profile-preview").textContent).toContain("+420 777 000 111");
    expect(screen.getByTestId("profile-dirty")).toBeTruthy();
    // A new field starts as only me.
    fireEvent.click(screen.getByTestId("profile-add-field"));
    expect(screen.getByTestId("profile-field-2-aud").getAttribute("data-value")).toBe("me");
    fireEvent.click(screen.getByTestId("profile-save"));
    await waitFor(() => expect(screen.getByTestId("profile-msg").textContent).toContain("public part is on the server"));
    const pub = JSON.parse(calls.find((c) => c.url === "/api/profile")!.body).profile;
    expect(pub.fields.map((f: { value: string }) => f.value)).toEqual(["+420 777 000 111", "https://alice.example"]);
  });

  it("marks a value that will not be shared", () => {
    _setCardForTests(normalizeCard({ fields: [{ id: "x", type: "email", label: "", value: "not-an-email", audience: "public" }] }));
    render(<ProfileEditor lang="en" signedIn />);
    expect(screen.getByTestId("profile-field-0-value").getAttribute("aria-invalid")).toBe("true");
  });

  it("asks to sign in when nobody is", () => {
    render(<ProfileEditor lang="en" signedIn={false} />);
    expect(screen.getByTestId("profile-need-signin-card")).toBeTruthy();
  });
});

describe("another member's profile", () => {
  const room = { v: 1 as const, nickname: "Bob", about: "From the room", fields: [{ type: "email" as const, label: "Mail", value: "bob@example.org" }], rev: "r1", updatedAt: 0 };

  it("shows what they share with the room, and their public one only on request — verified when the signing account matches", async () => {
    replies["GET /api/profile/bob-public-1"] = () => json({ ok: true, username: "bob-public-1", profile: { v: 1, nickname: "Bob P.", fields: [] }, accountKey: "B".repeat(43) });
    render(<PeerProfile info={{ room, accountKey: "B".repeat(43) }} name="Bob" username="bob-public-1" lang="en" />);
    expect(screen.getByTestId("peer-profile-room").textContent).toContain("From the room");
    expect(calls).toEqual([]);
    fireEvent.click(screen.getByTestId("peer-profile-load"));
    await waitFor(() => expect(screen.getByTestId("peer-profile-public").textContent).toContain("Bob P."));
    expect(screen.getByTestId("peer-profile-trust").getAttribute("data-verified")).toBe("true");
  });

  it("an unmatched account is marked as the member's own claim", async () => {
    replies["GET /api/profile/alice-real-1"] = () => json({ ok: true, username: "alice-real-1", profile: { v: 1, nickname: "Alice", fields: [] }, accountKey: "A".repeat(43) });
    render(<PeerProfile info={{ room: null, accountKey: "M".repeat(43) }} name="Mallory" username="alice-real-1" lang="en" />);
    fireEvent.click(screen.getByTestId("peer-profile-load"));
    await waitFor(() => expect(screen.getByTestId("peer-profile-trust").getAttribute("data-verified")).toBe("false"));
  });

  it("is part of the person's details, and the people list opens them", () => {
    const info: UserInfo = { name: "Bob", peerId: "peer-bob-0001", self: false, connectedForMs: 1000, transport: "p2p-direct", appType: "M5cet Web", usesServer: false, sentBytes: 0, recvBytes: 0, security: "x", profile: { room } };
    render(<UserInfoView info={info} lang="en" />);
    expect(screen.getByTestId("peer-profile-room").textContent).toContain("bob@example.org");
    cleanup();
    const onInfo = vi.fn();
    render(<PeerList peers={[{ id: "peer-bob-0001", name: "Bob", status: "open", initiator: false, audio: "off" }]} lang="en" onInfo={onInfo} />);
    fireEvent.click(screen.getByTestId("peer-profile-peer-bob-0001"));
    expect(onInfo).toHaveBeenCalledWith("peer-bob-0001");
  });
});
