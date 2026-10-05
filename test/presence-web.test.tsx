// 6.7 presence on the web: the room's presence book fed with signaling
// frames (lib/presence-book.ts), how a status is worded, the throttled
// foreground / background signal, and the status dot with "last seen …" in
// the recipients widget, the people panel and a person's details.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { PresenceBook, PresenceSignal, agoText, presenceView } from "../client/src/lib/presence-book";
import { RecipientsWidget, type WidgetPeer } from "../client/src/components/RecipientsWidget";
import { PeerList } from "../client/src/components/CallPanels";
import { UserInfoView, type UserInfo } from "../client/src/components/UserInfoModal";
import type { RoomPresence } from "../client/src/lib/use-room-presence";
import type { WidgetState } from "../client/src/lib/preferences";

afterEach(() => { cleanup(); vi.useRealTimers(); });

const MIN = 60_000;

describe("PresenceBook", () => {
  it("reads foreground and last seen from joined, presence and held frames", () => {
    const book = new PresenceBook();
    const now = Date.now();
    book.onFrame({
      type: "joined",
      peers: [{ peerId: "p-a", name: "A", foreground: true, lastSeen: now }, { peerId: "p-b", name: "B", foreground: false, lastSeen: now - 20 * MIN }],
      held: [{ peerId: "p-c", name: "C", lastSeen: now - 2 * 60 * MIN, since: now - MIN, account: "ref-c" }],
      away: [{ account: "ref-d", name: "D", since: now - 5_000, lastSeen: now - 30 * MIN }],
    });
    expect(book.facts("p-a")).toEqual({ connected: true, foreground: true, lastSeen: now });
    expect(book.facts("p-b")).toEqual({ connected: true, foreground: false, lastSeen: now - 20 * MIN });
    expect(book.facts("p-c")).toEqual({ connected: false, foreground: false, lastSeen: now - 2 * 60 * MIN });
    expect(book.awayFacts("ref-d").lastSeen).toBe(now - 30 * MIN);
    // A member nobody told us about (a server before 6.7) counts as online.
    expect(book.facts("p-x")).toEqual({ connected: true, foreground: true, lastSeen: 0 });

    expect(book.onFrame({ type: "peer-presence", peerId: "p-a", foreground: false, lastSeen: now + 1 })).toBe(true);
    expect(book.facts("p-a")).toMatchObject({ foreground: false, lastSeen: now + 1 });

    // B's connection goes without a goodbye: held; then back.
    book.onFrame({ type: "peer-left", peerId: "p-b", held: true, name: "B", lastSeen: now - 20 * MIN, since: now });
    expect(book.heldList().map((h) => h.peerId)).toEqual(["p-c", "p-b"]);
    book.onFrame({ type: "peer-joined", peerId: "p-b", name: "B", foreground: true, lastSeen: now });
    expect(book.heldList().map((h) => h.peerId)).toEqual(["p-c"]);

    // Gone for good.
    book.onFrame({ type: "peer-left", peerId: "p-c" });
    expect(book.heldList()).toEqual([]);
    expect(book.onFrame({ type: "pong" })).toBe(false);
  });

  it("does not list a held member twice: not beside the relay's entry of the same account, nor a live peer", () => {
    const book = new PresenceBook();
    book.onFrame({ type: "peer-left", peerId: "p-1", held: true, name: "Ann", account: "ref-ann", lastSeen: 1, since: 2 });
    book.onFrame({ type: "peer-left", peerId: "p-2", held: true, name: "Ben", lastSeen: 1, since: 2 });
    expect(book.heldList(["ref-ann"]).map((h) => h.peerId)).toEqual(["p-2"]);
    expect(book.heldList([], ["p-2"]).map((h) => h.peerId)).toEqual(["p-1"]);
  });
});

describe("presenceView", () => {
  const now = 1_800_000_000_000;
  it("words online, away and far away with when they were last seen", () => {
    expect(presenceView({ connected: true, foreground: true, lastSeen: now }, now, "en")).toEqual({ presence: "online", presenceLabel: "Online", seenText: "In the app right now" });
    expect(presenceView({ connected: true, foreground: false, lastSeen: now - 3 * MIN }, now, "en")).toEqual({ presence: "online", presenceLabel: "Online", seenText: "Last seen 3 min ago" });
    expect(presenceView({ connected: false, foreground: false, lastSeen: now - 12 * MIN }, now, "cs")).toEqual({ presence: "away", presenceLabel: "Pryč", seenText: "Naposledy online před 12 min" });
    expect(presenceView({ connected: false, foreground: false, lastSeen: now - 3 * 60 * MIN }, now, "de")).toEqual({ presence: "far", presenceLabel: "Länger abwesend", seenText: "Zuletzt online vor 3 Std." });
    expect(presenceView({ connected: false, foreground: false, lastSeen: 0 }, now, "en").seenText).toBe("Not known when last seen");
    expect(agoText(now - 20_000, now, "en")).toBe("just now");
    expect(agoText(now - 2 * 24 * 60 * MIN, now, "cs")).toBe("před 2 dny"); // 6.13: Intl.RelativeTimeFormat
  });
});

describe("PresenceSignal", () => {
  it("sends a change at once, coalesces quick ones and skips what the server already knows", () => {
    vi.useFakeTimers();
    let clock = 1_000_000;
    const sent: unknown[] = [];
    const signal = new PresenceSignal((f) => { sent.push(f); return true; }, () => clock);
    signal.reset({ away: false, foreground: true });

    signal.set({ away: false, foreground: true });
    expect(sent).toEqual([]); // the join said so already
    signal.set({ away: false, foreground: false });
    expect(sent).toEqual([{ type: "presence", away: false, foreground: false }]);

    // Back and away again within the gap: only the latest state, later.
    clock += 1_000;
    signal.set({ away: false, foreground: true });
    signal.set({ away: true, foreground: false });
    expect(sent).toHaveLength(1);
    clock += PresenceSignal.GAP_MS;
    vi.advanceTimersByTime(PresenceSignal.GAP_MS);
    expect(sent).toEqual([{ type: "presence", away: false, foreground: false }, { type: "presence", away: true, foreground: false }]);

    // A freeze cannot wait.
    signal.set({ away: false, foreground: true }, true);
    expect(sent).toHaveLength(3);
  });
});

const STATE: WidgetState = { x: 0, y: 0, minimized: false, autoRoom: false, locked: true, width: 240, opacity: 1, fontScale: 1, zoom: 1, accent: "" };

describe("the status dot", () => {
  it("shows online, away and far away in the recipients widget, with the last seen in its tooltip", () => {
    const now = Date.now();
    const peers: WidgetPeer[] = [
      { id: "p-on", name: "Bob", status: "open", presence: { connected: true, foreground: true, lastSeen: now } },
      { id: "p-bg", name: "Eve", status: "open", presence: { connected: true, foreground: false, lastSeen: now - 20 * MIN } },
      { id: "p-held", name: "Carol", status: "closed", presence: { connected: false, foreground: false, lastSeen: now - 2 * 60 * MIN } },
      { id: "p-plain", name: "Dan", status: "open" },
    ];
    render(<RecipientsWidget peers={peers} room="r" state={STATE} selected={new Set()} onTogglePeer={vi.fn()} onToggleAuto={vi.fn()} onSelectAll={vi.fn()} onSelectNone={vi.fn()} onPeerInfo={vi.fn()} onRoomInfo={vi.fn()} onMove={vi.fn()} onMinimize={vi.fn()} onUpdate={vi.fn()} lang="en" />);
    expect(screen.getByTestId("presence-p-on").className).toContain("presence-dot--online");
    const bg = screen.getByTestId("presence-p-bg");
    expect(bg.className).toContain("presence-dot--away");
    expect(bg.getAttribute("title")).toBe("Away · Last seen 20 min ago");
    expect(screen.getByTestId("presence-p-held").className).toContain("presence-dot--far");
    expect(screen.getByTestId("recip-p-held").textContent).toContain("Last seen 2 hr ago"); // 6.13: Intl.RelativeTimeFormat (en-GB)
    expect(screen.getByTestId("recip-p-held").textContent).not.toContain("offline");
    expect(screen.queryByTestId("presence-p-plain")).toBeNull();
  });

  it("changes colour as minutes pass, without any news", () => {
    vi.useFakeTimers();
    const now = Date.now();
    const peers: WidgetPeer[] = [{ id: "p-1", name: "Bob", status: "open", presence: { connected: true, foreground: false, lastSeen: now - 4 * MIN } }];
    render(<RecipientsWidget peers={peers} room="r" state={STATE} selected={new Set()} onTogglePeer={vi.fn()} onToggleAuto={vi.fn()} onSelectAll={vi.fn()} onSelectNone={vi.fn()} onPeerInfo={vi.fn()} onRoomInfo={vi.fn()} onMove={vi.fn()} onMinimize={vi.fn()} onUpdate={vi.fn()} lang="en" />);
    expect(screen.getByTestId("presence-p-1").className).toContain("presence-dot--online");
    act(() => { vi.advanceTimersByTime(2 * MIN); });
    expect(screen.getByTestId("presence-p-1").className).toContain("presence-dot--away");
  });

  it("lists held members in the people panel with a dot", () => {
    const now = Date.now();
    const book = new PresenceBook();
    book.onFrame({ type: "joined", peers: [{ peerId: "p-a", name: "Ann", foreground: true, lastSeen: now }], held: [{ peerId: "p-h", name: "Hal", lastSeen: now - 10 * MIN, since: now }], away: [] });
    const presence = { factsOf: (id: string) => book.facts(id), held: (peerIds: string[], refs: string[]) => book.heldList(refs, peerIds), isHeld: (id: string) => Boolean(book.heldEntry(id)) } as unknown as RoomPresence;
    // Hal's closed peer entry (left behind by WebRTC) gives way to the server's held entry, with his name.
    render(<PeerList peers={[{ id: "p-a", name: "Ann", status: "open", initiator: false, audio: "off" }, { id: "p-h", name: "peer-p-h", status: "closed", initiator: false, audio: "off" }]} lang="en" presence={presence} />);
    expect(screen.getByTestId("presence-p-a").className).toContain("presence-dot--online");
    expect(screen.getByTestId("presence-p-h").className).toContain("presence-dot--away");
    expect(screen.getAllByTestId("text-peer-p-h")).toHaveLength(1);
    expect(screen.getByTestId("text-peer-p-h").textContent).toContain("Hal");
    expect(screen.getByText("Last seen 10 min ago")).toBeTruthy();
  });

  it("says in a person's details when they were last seen", () => {
    const now = Date.now();
    const info: UserInfo = {
      name: "Hal", peerId: "p-hal-0000000000001", self: false, connectedForMs: null, transport: "connecting", appType: "M5cet Web", usesServer: true,
      sentBytes: 0, recvBytes: 0, security: "AES-GCM 256 (E2EE)", presence: { connected: false, foreground: false, lastSeen: now - 30 * MIN },
    };
    render(<UserInfoView info={info} lang="en" />);
    expect(screen.getByTestId("userinfo-presence").textContent).toBe("Away · Last seen 30 min ago");
  });
});
