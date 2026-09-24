// The app's own layouts, drawn: a snapshot of their DOM (attributes as a
// sorted set) in the situations that matter. Taken when 4.0.5 turned the
// components into layouts, and checked then against the previous JSX
// element for element — so a change here is a change of what users see:
// update the snapshot (vitest -u) only on purpose.

import { describe, it, expect, beforeEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { createRef } from "react";
import { MessageBubble } from "../client/src/components/MessageBubble";
import { RecipientsWidget } from "../client/src/components/RecipientsWidget";
import { renderLayout, type LayoutEnv } from "../client/src/components/LayoutView";
import { DEFAULT_LAYOUTS } from "../client/src/lib/layouts";
import { t } from "../client/src/lib/i18n";
import { linkify } from "../client/src/lib/linkify";
import { canonOf } from "./helpers/canon";

beforeEach(() => cleanup());
const noop = () => undefined;

describe("message layouts", () => {
  const base = { id: "m1", senderId: "p-a", senderName: "Alice", createdAt: 0, timeLabel: "10:42", text: "hi https://example.org", lang: "en" as const, renderText: linkify, formatSize: (n: number) => `${n} B`, onVanish: noop };
  const variants: Array<[string, Record<string, unknown>]> = [
    ["plain", {}],
    ["full", { secure: true, onInfo: noop, onReply: noop, onForward: noop, forwardedFrom: "Bob", replyTo: { id: "m0", senderName: "Bob", text: "t" }, to: ["Bob"], flags: { vanishSeconds: 5 }, sealedWith: "pair", bubbleStyle: { color: "#f00" } }],
    ["tap", { flags: { tap: true } }],
    ["sealed", { flags: { sealed: { iv: "x", salt: "y" } }, text: "C" }],
    ["image", { attachment: { kind: "image", name: "a.png", mime: "image/png", size: 1, dataUrl: "data:image/png;base64,AA" } }],
    ["audio", { attachment: { kind: "file", name: "v.webm", mime: "audio/webm", size: 2, dataUrl: "data:audio/webm;base64,AA" }, text: "" }],
    ["file", { attachment: { kind: "file", name: "d.pdf", mime: "application/pdf", size: 3, dataUrl: "data:application/pdf;base64,AA" } }],
    ["vanished", { vanished: true }],
  ];
  for (const [kind, k] of [["in", { mine: false, isSystem: false }], ["out", { mine: true, isSystem: false, deliveryState: "read", head: { showAvatar: true, avatar: "🦊" } }], ["sys", { mine: false, isSystem: true, senderId: "system", head: { showLogo: true, headerText: "M5cet · 10:42" } }]] as const) {
    for (const [name, v] of variants) {
      it(`${kind} · ${name}`, () => {
        const { container } = render(<MessageBubble {...(base as never)} {...(k as object)} {...(v as object)} badge={kind === "in" ? <b>badge</b> : null} />);
        expect(canonOf(container)).toMatchSnapshot();
      });
    }
  }
});

describe("recipients widget layouts", () => {
  const state = { x: 0, y: 0, minimized: false, locked: false, autoRoom: false, width: 260, opacity: 1, fontScale: 1, zoom: 1, accent: "#123456" };
  const peers = [
    { id: "p1", name: "Ann", status: "open" as const, rttMs: 40 },
    { id: "p2", name: "Bob", status: "away" as const },
    { id: "p3", name: "Cyd", status: "closed" as const },
  ];
  const props = { peers, room: "brno", selected: new Set(["p1"]), onTogglePeer: noop, onToggleAuto: noop, onSelectAll: noop, onSelectNone: noop, onPeerInfo: noop, onRoomInfo: noop, onMove: noop, onMinimize: noop, onUpdate: noop, lang: "en" as const };
  for (const [name, st, cfg] of [["floating, manual, settings", {}, true], ["docked, everyone", { locked: true, autoRoom: true }, false], ["minimised", { minimized: true, x: 10, y: 20 }, false]] as const) {
    it(name, () => {
      const r = render(<RecipientsWidget {...props} state={{ ...state, ...st }} />);
      if (cfg) fireEvent.click(r.getByTestId("recip-config-toggle"));
      expect(canonOf(r.container)).toMatchSnapshot();
    });
  }
});

describe("app bar, chat window and composer layouts", () => {
  const env = (data: Record<string, unknown>, extra: Partial<LayoutEnv> = {}): LayoutEnv => ({ data, lang: "en", translate: (k) => t("en", k), formats: { links: linkify }, ...extra });
  it("app bar", () => {
    const { container } = render(<>{renderLayout(DEFAULT_LAYOUTS.header, env(
      { status: "joined", room: "brno", openPeerCount: 2, reconnectPending: false, statusTitle: "state: open", showSwitcher: true, profiles: [{ id: "a", label: "Team" }], activeProfileId: "a", showFullscreen: true, fullscreen: false },
      { slots: { signedIn: () => <i data-slot="signed-in" />, menu: () => <i data-slot="menu" /> } },
    ))}</>);
    expect(canonOf(container)).toMatchSnapshot();
  });
  it("chat window with messages", () => {
    const { container } = render(<>{renderLayout(DEFAULT_LAYOUTS.chat, env(
      { notice: "hello", room: "brno", myIdShort: "0123456789", connected: true, copied: false, transfers: [{ id: "t1" }], empty: false, emptyTitle: "T", emptyBody: "B", hiddenMessages: 3, newestFirst: false, showEarlierText: "Show 3", messages: [{ id: "m1" }, { id: "m2" }] },
      { refs: { dock: createRef() as never, end: createRef() as never }, slots: { transfer: (x) => <i data-t={(x as { id: string }).id} />, message: (x) => <i data-m={(x as { id: string }).id} />, composer: () => <i data-slot="composer" /> } },
    ))}</>);
    expect(canonOf(container)).toMatchSnapshot();
  });
  it("empty chat window", () => {
    const { container } = render(<>{renderLayout(DEFAULT_LAYOUTS.chat, env({ notice: "", room: "", myIdShort: "0123456789", connected: false, copied: true, transfers: [], empty: true, emptyTitle: "Title", emptyBody: "Body", hiddenMessages: 0, newestFirst: false, showEarlierText: "", messages: [] }))}</>);
    expect(canonOf(container)).toMatchSnapshot();
  });
  it("composer", () => {
    const { container } = render(<>{renderLayout(DEFAULT_LAYOUTS.composer, env(
      { replyTo: { id: "m1", senderName: "Bob", text: "yes" }, emojiOpen: true, emojis: ["😀", "👍"], filesOn: true, openPeerCount: 0, room: "brno", placeholder: "Write…", messageInput: "draft", everyone: false, recipientNames: "Ann, Bob" },
      { refs: { fileInput: createRef() as never, imageInput: createRef() as never }, slots: { recorder: () => <i data-slot="recorder" />, sendOptions: () => <i data-slot="send" /> } },
    ))}</>);
    expect(canonOf(container)).toMatchSnapshot();
  });
});
