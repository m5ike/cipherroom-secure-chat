// A phone call a TSA routed by a route code (6.9), in the browser: the
// "phone-bridge" frames with `route` become cards (lib/phone-bridge.ts), the
// card of the layout "phone.bridge" offers Join audio / Not now, shows how
// many are in, a level meter, Mute, Leave and End for everyone — every
// situation drawn without a layout error, named and labelled, in cs / en / de
// — and the 6.0 bridge's card is what it was.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { PhoneBridgePanel, type PhoneBridgePanelProps } from "../client/src/components/PhoneBridgePanel";
import { setLayoutPreviewMode } from "../client/src/components/LayoutView";
import { bridgeUrl, callFromFrame, levelBars, type PhoneCall } from "../client/src/lib/phone-bridge";
import { RoomHub, roomKeyOf } from "../client/src/lib/room-hub";
import { DEFAULT_LAYOUTS } from "../client/src/lib/layouts";
import { LAYOUT_CONTRACTS } from "../client/src/lib/layouts/contracts";
import { PREVIEW_VARIANTS } from "../client/src/lib/layouts/samples";
import { checkDom, checkTree } from "../client/src/lib/layout-a11y";
import { walkTree } from "../client/src/lib/layout-tree";
import { t, type Lang } from "../client/src/lib/i18n";

afterEach(() => { cleanup(); document.body.innerHTML = ""; setLayoutPreviewMode(null); });

const LANGS: Lang[] = ["cs", "en", "de"];
const incoming = { type: "phone-bridge", event: "incoming", session: "tr_1", token: "tok-1", number: "+420222111000", from: "+420603123456", label: "Recepce", mode: "audio", route: "room", members: 1, channel: "audio" };

function call(over: Partial<PhoneCall> = {}): PhoneCall {
  return { ...callFromFrame(incoming)!, ...over };
}

function props(calls: PhoneCall[], over: Partial<PhoneBridgePanelProps> = {}): PhoneBridgePanelProps {
  return {
    lang: "en", calls, onTakeAudio: vi.fn(), onTakeText: vi.fn(), onReply: vi.fn(), onMute: vi.fn(), onHangup: vi.fn(), onDismiss: vi.fn(),
    onJoin: vi.fn(), onIgnore: vi.fn(), onLeave: vi.fn(), ...over,
  };
}

describe("routed calls from the frames", () => {
  it("incoming → a ringing card with the route and how many are in; status updates them; ended ends it", () => {
    const c = callFromFrame(incoming)!;
    expect(c).toMatchObject({ session: "tr_1", token: "tok-1", route: "room", members: 1, state: "ringing", from: "+420603123456", level: 0 });
    const two = callFromFrame({ type: "phone-bridge", event: "status", session: "tr_1", members: 2, channel: "audio" }, c)!;
    expect(two).toMatchObject({ members: 2, state: "ringing" });
    // Nobody took the audio: the server went over to text — the card offers the written reply.
    expect(callFromFrame({ event: "status", session: "tr_1", members: 0, channel: "text" }, two)).toMatchObject({ state: "text", members: 0 });
    // A member who ignored it stays ignored.
    expect(callFromFrame({ event: "status", session: "tr_1", members: 0, channel: "text" }, { ...two, state: "ignored" })).toMatchObject({ state: "ignored" });
    expect(callFromFrame({ event: "ended", session: "tr_1", reason: "everyone left" }, two)).toMatchObject({ state: "ended", reason: "everyone left" });
    // Already in text mode when offered (someone connected later).
    expect(callFromFrame({ ...incoming, channel: "text" })).toMatchObject({ state: "text" });
    // The 6.0 bridge's frames: no route.
    expect(callFromFrame({ event: "incoming", session: "tb_1", token: "x", from: "+1" })).toMatchObject({ route: "", members: 0, state: "ringing" });
  });

  it("a room kept in the background is offered the call too — its media socket goes to that room's server", async () => {
    let sock: { url: string; onmessage?: (e: { data: string }) => void } | null = null;
    const hub = new RoomHub({
      wsUrl: (server) => `wss://${server || "here.example"}/ws`, rtcConfig: async () => ({}),
      makeSocket: (url) => (sock = { url, send() {}, close() {}, readyState: 0 }) as unknown as WebSocket,
      makePeer: () => { throw new Error("no WebRTC here"); }, derive: async () => ({ version: 3, roomId: "r3.AAAAAAAAAAAAAAAAAAAA" }) as never, identity: async () => null,
    });
    const got: Array<{ label: string; socketUrl: string; frame: Record<string, unknown> }> = [];
    hub.onPhone((e) => got.push(e));
    hub.add({ key: roomKeyOf("team", "other.example"), room: "team", label: "Team", name: "Me", passphrase: "x", server: "other.example" });
    for (let i = 0; i < 50 && !sock; i++) await new Promise((r) => setTimeout(r, 5));
    sock!.onmessage!({ data: JSON.stringify(incoming) });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ label: "Team", socketUrl: "wss://other.example/ws", frame: { route: "room", token: "tok-1" } });
    expect(bridgeUrl(got[0].socketUrl, "tok-1")).toBe("wss://other.example/media/tel/client/tok-1");
    hub.clear();
  });

  it("the level meter's bars: silence 0, a loud line 5", () => {
    expect(levelBars(new Float32Array(480))).toBe(0);
    expect(levelBars(new Float32Array(480).fill(0.9))).toBe(5);
    const mid = levelBars(new Float32Array(480).fill(0.02));
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(5);
  });
});

describe("the routed call's card", () => {
  it("is in the layout's contract and its preview situations", () => {
    const c = LAYOUT_CONTRACTS["phone.bridge"];
    expect(c.actions.map((a) => a.name)).toEqual(expect.arrayContaining(["join", "ignore", "leave"]));
    expect(c.vars[0].description).toMatch(/\.route/);
    expect(PREVIEW_VARIANTS["phone.bridge"].map((v) => v.id)).toEqual(expect.arrayContaining(["room", "room-audio", "room-ignored"]));
    expect(checkTree(DEFAULT_LAYOUTS["phone.bridge"]).filter((i) => i.severity !== "info")).toEqual([]);
  });

  it("ringing in the room: who calls, how many are in, Join audio / Not now — no hang-up for a member not in it", () => {
    const p = props([call()]);
    render(<PhoneBridgePanel {...p} />);
    const card = screen.getByTestId("phone-bridge");
    expect(card.getAttribute("aria-label")).toBe("Phone call in the room +420603123456");
    expect(card.getAttribute("data-route")).toBe("room");
    expect(screen.getByTestId("pb-members").textContent).toBe("1 in the call");
    expect(screen.queryByTestId("pb-audio")).toBeNull(); // the bridge's buttons are not a routed call's
    expect(screen.queryByTestId("pb-hangup")).toBeNull();
    fireEvent.click(screen.getByTestId("pb-join"));
    expect(p.onJoin).toHaveBeenCalledWith("tr_1");
    fireEvent.click(screen.getByTestId("pb-ignore"));
    expect(p.onIgnore).toHaveBeenCalledWith("tr_1");
  });

  it("in the audio: the level meter, Mute, Leave and End for everyone", () => {
    const p = props([call({ state: "audio", members: 3, level: 3 })]);
    render(<PhoneBridgePanel {...p} />);
    const meter = screen.getByRole("meter", { name: "Call audio level" });
    expect(meter.getAttribute("aria-valuenow")).toBe("3");
    expect(meter.querySelectorAll(".pb-meter__bar.is-on")).toHaveLength(3);
    expect(screen.getByTestId("pb-members").textContent).toBe("3 in the call");
    fireEvent.click(screen.getByTestId("pb-leave"));
    expect(p.onLeave).toHaveBeenCalledWith("tr_1");
    expect(screen.getByTestId("pb-hangup").textContent).toBe("End for everyone");
    fireEvent.click(screen.getByTestId("pb-hangup"));
    expect(p.onHangup).toHaveBeenCalledWith("tr_1");
    fireEvent.click(screen.getByRole("button", { name: "Mute" }));
    expect(p.onMute).toHaveBeenCalledWith("tr_1");
    expect(screen.queryByTestId("pb-join")).toBeNull();
  });

  it("not joined (or left): a slim notice that still offers Join, and Close", () => {
    const p = props([call({ state: "ignored", members: 2 })]);
    render(<PhoneBridgePanel {...p} />);
    expect(screen.getByTestId("phone-bridge").className).toContain("pb-card--ignored");
    expect(screen.getByTestId("pb-state").textContent).toBe("not joined");
    expect(screen.queryByText(t("en", "phone.note"))).toBeNull();
    expect(screen.queryByTestId("pb-ignore")).toBeNull();
    fireEvent.click(screen.getByTestId("pb-join"));
    expect(p.onJoin).toHaveBeenCalledWith("tr_1");
    fireEvent.click(screen.getByTestId("pb-close"));
    expect(p.onDismiss).toHaveBeenCalledWith("tr_1");
  });

  it("several calls at once, each its own card; one member's call keeps Hang up", () => {
    const user = call({ session: "tr_2", route: "user", from: "", state: "ringing" });
    render(<PhoneBridgePanel {...props([call(), user])} />);
    const cards = screen.getAllByTestId("phone-bridge");
    expect(cards.map((c) => c.getAttribute("data-route"))).toEqual(["room", "user"]);
    // The member's own call: the caller's number withheld outside the room the code names.
    expect(cards[1].textContent).toContain(t("en", "phone.unknown"));
    expect(cards[1].querySelector("[data-testid=pb-hangup]")?.textContent).toBe("Hang up");
  });

  it("the 6.0 bridge's card is unchanged: Take as audio / As text, no Join, no members", () => {
    const bridge = callFromFrame({ event: "incoming", session: "tb_9", token: "x", number: "+420222111000", from: "+420603123456", label: "Podpora" })!;
    const p = props([bridge]);
    render(<PhoneBridgePanel {...p} />);
    expect(screen.getByTestId("pb-audio")).toBeTruthy();
    expect(screen.getByTestId("pb-text")).toBeTruthy();
    expect(screen.queryByTestId("pb-join")).toBeNull();
    expect(screen.queryByTestId("pb-members")).toBeNull();
    expect(screen.getByTestId("phone-bridge").getAttribute("aria-label")).toBe("Phone call +420603123456");
    fireEvent.click(screen.getByTestId("pb-audio"));
    expect(p.onTakeAudio).toHaveBeenCalledWith("tb_9");
  });

  for (const lang of LANGS) {
    it(`every routed situation draws without a layout error, named and labelled (${lang})`, () => {
      const own = new Set<string>();
      walkTree(DEFAULT_LAYOUTS["phone.bridge"], (n) => { own.add(n.id); });
      for (const state of ["ringing", "audio", "text", "ignored", "ended"] as const) {
        const errors: string[] = [];
        setLayoutPreviewMode({ onError: (id, message) => errors.push(`${id}: ${message}`) });
        render(<PhoneBridgePanel {...props([call({ state, level: 2, members: 2 })], { lang })} />);
        expect(errors, `${state} ${lang}`).toEqual([]);
        const issues = checkDom(document.body).filter((i) => own.has(i.id) && i.rule !== "contrast");
        expect(issues.map((i) => `${i.id}: ${i.rule} ${i.message}`), `${state} ${lang}`).toEqual([]);
        expect(screen.getByTestId("pb-state").textContent).toBe(t(lang, `phone.state.${state}`));
        cleanup();
        setLayoutPreviewMode(null);
      }
    });
  }
});
