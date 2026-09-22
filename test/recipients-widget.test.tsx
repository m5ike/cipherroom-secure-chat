// The recipients widget: where it sits (docked on the right, next to the
// menu — not under the logo), that its button can be dragged to a remembered
// place, and that an away member stays a recipient because the server
// answers for them.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { RecipientsWidget, type WidgetPeer } from "../client/src/components/RecipientsWidget";
import type { WidgetState } from "../client/src/lib/preferences";

afterEach(() => cleanup());

const STATE: WidgetState = { x: 0, y: 0, minimized: false, autoRoom: false, locked: true, width: 240, opacity: 1, fontScale: 1, zoom: 1, accent: "" };

const PEERS: WidgetPeer[] = [
  { id: "peer-open", name: "Bob", status: "open", rttMs: 40 },
  { id: "away:acc-1", name: "Alice", status: "away", since: Date.now() - 60_000 },
  { id: "peer-gone", name: "Carol", status: "closed" },
];

function show(over: Partial<Parameters<typeof RecipientsWidget>[0]> = {}) {
  const props = {
    peers: PEERS,
    room: "brno-secure",
    state: STATE,
    selected: new Set<string>(),
    onTogglePeer: vi.fn(),
    onToggleAuto: vi.fn(),
    onSelectAll: vi.fn(),
    onSelectNone: vi.fn(),
    onPeerInfo: vi.fn(),
    onRoomInfo: vi.fn(),
    onMove: vi.fn(),
    onMinimize: vi.fn(),
    onUpdate: vi.fn(),
    lang: "cs" as const,
    ...over,
  };
  render(<RecipientsWidget {...props} />);
  return props;
}

describe("where the widget sits", () => {
  it("docks on the right, not under the logo", () => {
    show();
    const widget = screen.getByTestId("recip-widget") as HTMLElement;
    expect(widget.style.right).toBe("8px");
    expect(widget.style.left).toBe("");
    expect(widget.style.transformOrigin).toBe("top right");
    // Below the header + status bar, so it cannot cover Disconnect.
    expect(widget.style.top).toContain("--m5-dock-top");
  });

  it("floats at its remembered position once unlocked", () => {
    show({ state: { ...STATE, locked: false, x: 320, y: 140 } });
    const widget = screen.getByTestId("recip-widget") as HTMLElement;
    expect(widget.style.left).toBe("320px");
    expect(widget.style.top).toBe("140px");
  });
});

describe("the minimised button", () => {
  it("opens the list on a plain click", () => {
    const props = show({ state: { ...STATE, minimized: true } });
    fireEvent.click(screen.getByTestId("recip-fab"));
    expect(props.onMinimize).toHaveBeenCalledWith(false);
  });

  it("counts the people it would reach, away ones included", () => {
    show({ state: { ...STATE, minimized: true } });
    expect(screen.getByTestId("recip-fab").textContent).toContain("2"); // Bob + Alice
  });

  it("undocks and remembers its place when dragged", () => {
    const props = show({ state: { ...STATE, minimized: true } });
    const fab = screen.getByTestId("recip-fab");
    fireEvent.pointerDown(fab, { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 260, clientY: 300 });
    fireEvent.pointerUp(window);
    // Undocked on the way out, so the new position is the one that counts.
    expect(props.onUpdate).toHaveBeenCalledWith(expect.objectContaining({ locked: false }));
    expect(props.onMove).toHaveBeenCalled();
    const [x, y] = props.onMove.mock.calls.at(-1)!;
    expect(x).toBeGreaterThan(0);
    expect(y).toBeGreaterThan(0);
    // A drag is not a click: the list must not open behind it.
    fireEvent.click(fab);
    expect(props.onMinimize).not.toHaveBeenCalled();
  });
});

describe("away members", () => {
  it("are listed with the away mark, above the ones who left", () => {
    show();
    const rows = screen.getAllByTestId(/^recip-(peer|away)/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual(["recip-peer-open", "recip-away:acc-1", "recip-peer-gone"]);
    const away = screen.getByTestId("recip-away:acc-1");
    expect(away.className).toContain("is-away");
    expect(away.textContent).toContain("away");
  });

  it("can be selected as a recipient — the server takes the message", () => {
    const props = show();
    const check = screen.getByTestId("recip-check-away:acc-1") as HTMLButtonElement;
    expect(check.disabled).toBe(false);
    fireEvent.click(check);
    expect(props.onTogglePeer).toHaveBeenCalledWith("away:acc-1");
  });

  it("shows as checked when selected, while a peer who left cannot be", () => {
    show({ selected: new Set(["away:acc-1"]) });
    expect(screen.getByTestId("recip-check-away:acc-1").getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByTestId("recip-check-peer-gone") as HTMLButtonElement).disabled).toBe(true);
  });

  it("are all covered when the room is the recipient", () => {
    show({ state: { ...STATE, autoRoom: true } });
    const away = within(screen.getByTestId("recip-away:acc-1"));
    expect(away.getByTestId("recip-check-away:acc-1").getAttribute("aria-pressed")).toBe("true");
  });
});
