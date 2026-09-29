// 6.0: the recipients widget docked to the left, right or bottom edge of
// the chat area — pinned, or auto-hidden behind a handle (the widget.handle
// layout) that slides it out on hover, a tap, a click or Enter, and back in
// after the pointer leaves, on Escape or a click outside. Dragging the head
// undocks it; dropping it near an edge docks it there. Stored preferences
// from before 6.0 ("locked") keep working.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, fireEvent, cleanup, act, within } from "@testing-library/react";
import { RecipientsWidget, snapEdge, HIDE_DELAY_MS, SNAP_PX, DOCK_PANEL_ID, type WidgetPeer } from "../client/src/components/RecipientsWidget";
import { LayoutProvider } from "../client/src/components/LayoutProvider";
import { dockPatch, loadPreferences, sanitizeWidget, widgetDock, type WidgetState } from "../client/src/lib/preferences";
import { profileFromPrefs } from "../client/src/components/panels";
import { sanitizeLayout } from "../client/src/lib/layout-config";
import { DEFAULT_LAYOUTS, LAYOUT_GROUP, LAYOUT_IDS } from "../client/src/lib/layouts";
import { LAYOUT_CONTRACTS } from "../client/src/lib/layouts/contracts";
import { PREVIEW_VARIANTS } from "../client/src/lib/layouts/samples";
import { walkTree, type LNode } from "../client/src/lib/layout-tree";

beforeEach(() => { try { localStorage.clear(); } catch { /* none */ } });
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.documentElement.removeAttribute("data-form");
});

const BASE: WidgetState = { x: 0, y: 0, minimized: false, autoRoom: true, locked: false, dock: "none", autoHide: false, width: 240, opacity: 1, fontScale: 1, zoom: 1, accent: "" };
const PEERS: WidgetPeer[] = [
  { id: "p1", name: "Bob", status: "open", rttMs: 40 },
  { id: "p2", name: "Carol", status: "away" },
  { id: "p3", name: "Dan", status: "closed" },
];

function show(state: Partial<WidgetState> = {}, over: Partial<Parameters<typeof RecipientsWidget>[0]> = {}) {
  const props = {
    peers: PEERS,
    room: "brno",
    state: { ...BASE, ...state },
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
    lang: "en" as const,
    ...over,
  };
  const r = render(<RecipientsWidget {...props} />);
  return { ...props, ...r };
}

const docked = (edge: "left" | "right" | "bottom", autoHide = false): Partial<WidgetState> => ({ ...dockPatch(edge), autoHide });
const panel = () => document.getElementById(DOCK_PANEL_ID) as HTMLElement;
const handle = () => screen.getByTestId("recip-handle");
const isOut = () => handle().getAttribute("aria-expanded") === "true" && !panel().hasAttribute("inert");
const isIn = () => handle().getAttribute("aria-expanded") === "false" && panel().hasAttribute("inert");

describe("preferences: the edge, pinned or auto-hide", () => {
  const base = () => loadPreferences().widget;

  it("defaults to the right edge, pinned (as the widget was docked before)", () => {
    expect(base()).toMatchObject({ dock: "right", locked: true, autoHide: false });
    expect(sanitizeWidget(undefined, base())).toMatchObject({ dock: "right", locked: true, autoHide: false });
  });

  it("reads preferences stored before 6.0: locked is the right edge, unlocked floats", () => {
    expect(sanitizeWidget({ locked: true, x: 10, y: 20 }, base())).toMatchObject({ dock: "right", locked: true, x: 10, y: 20 });
    expect(sanitizeWidget({ locked: false, x: 10, y: 20 }, base())).toMatchObject({ dock: "none", locked: false, x: 10, y: 20 });
    expect(widgetDock({ locked: true })).toBe("right");
    expect(widgetDock({ locked: false })).toBe("none");
    expect(widgetDock({})).toBe("right");
  });

  it("keeps an edge it knows, with locked in step (older clients read it)", () => {
    for (const dock of ["left", "right", "bottom"] as const) {
      expect(sanitizeWidget({ dock, locked: false }, base())).toMatchObject({ dock, locked: true });
    }
    expect(sanitizeWidget({ dock: "none", locked: true }, base())).toMatchObject({ dock: "none", locked: false });
  });

  it("drops an edge it does not know, falling back to locked", () => {
    expect(sanitizeWidget({ dock: "top" }, base()).dock).toBe("right");
    expect(sanitizeWidget({ dock: "top", locked: false }, base()).dock).toBe("none");
    expect(sanitizeWidget({ dock: 3, locked: true }, base()).dock).toBe("right");
    expect(sanitizeWidget({ dock: { edge: "left" } }, base()).dock).toBe("right");
  });

  it("takes auto-hide only as a real yes", () => {
    expect(sanitizeWidget({ dock: "left", autoHide: true }, base()).autoHide).toBe(true);
    for (const v of ["yes", 1, null, undefined, false]) expect(sanitizeWidget({ dock: "left", autoHide: v }, base()).autoHide).toBe(false);
  });

  it("migrates what localStorage holds and syncs the edge to the account vault", () => {
    localStorage.setItem("m5cet:prefs:v2", JSON.stringify({ widget: { locked: false, x: 100, y: 50, width: 300 } }));
    expect(loadPreferences().widget).toMatchObject({ dock: "none", locked: false, x: 100, y: 50, width: 300, autoHide: false });
    localStorage.setItem("m5cet:prefs:v2", JSON.stringify({ widget: { dock: "bottom", autoHide: true } }));
    const prefs = loadPreferences();
    expect(prefs.widget).toMatchObject({ dock: "bottom", locked: true, autoHide: true });
    expect(profileFromPrefs(prefs).widget).toMatchObject({ dock: "bottom", autoHide: true });
  });
});

describe("snapping to an edge", () => {
  it("picks the nearest edge within reach — the bottom is the composer's top", () => {
    expect(snapEdge(10, 300, 1024, 768, 88)).toBe("left");
    expect(snapEdge(1014, 300, 1024, 768, 88)).toBe("right");
    expect(snapEdge(500, 700, 1024, 768, 88)).toBe("bottom"); // over the composer
    expect(snapEdge(500, 768 - 88 - 20, 1024, 768, 88)).toBe("bottom");
    expect(snapEdge(20, 740, 1024, 768, 88)).toBe("bottom"); // a corner: the nearer edge
    expect(snapEdge(SNAP_PX + 1, 300, 1024, 768, 88)).toBe("none");
    expect(snapEdge(500, 300, 1024, 768, 88)).toBe("none");
  });
});

describe("docked panels", () => {
  it("sit at their edge: the sides below the header, the bottom above the composer", () => {
    show(docked("left"));
    let dock = screen.getByTestId("recip-dock");
    expect(dock.getAttribute("data-edge")).toBe("left");
    expect(dock.style.left).toBe("0px");
    expect(dock.style.top).toContain("--m5-dock-top");
    cleanup();
    show(docked("bottom"));
    dock = screen.getByTestId("recip-dock");
    expect(dock.style.bottom).toContain("--m5-dock-bottom");
    expect(dock.style.left).toBe("0px");
    expect(dock.style.right).toBe("0px");
    expect(screen.getByTestId("recip-widget").className).toContain("is-dock-bottom");
  });

  it("pinned: always shown, no handle", () => {
    show(docked("right"));
    expect(screen.queryByTestId("recip-handle")).toBeNull();
    expect(panel().hasAttribute("inert")).toBe(false);
    expect(screen.getByTestId("recip-dock").className).toContain("is-open");
    expect(screen.getByTestId("recip-pin").getAttribute("aria-pressed")).toBe("true");
  });

  it("a floating widget has no pin toggle and no auto-hide setting", () => {
    show();
    expect(screen.queryByTestId("recip-dock")).toBeNull();
    expect(screen.queryByTestId("recip-pin")).toBeNull();
    fireEvent.click(screen.getByTestId("recip-config-toggle"));
    expect(screen.getByTestId("recip-cfg-dock")).toBeTruthy();
    expect(screen.queryByTestId("recip-cfg-autohide")).toBeNull();
  });
});

describe("choosing the edge", () => {
  it("from the head: Free / Left / Right / Bottom", () => {
    const p = show(docked("right"));
    const toggle = screen.getByTestId("recip-dock-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-label")).toBe("Dock: Right");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const menu = screen.getByTestId("recip-dock-menu");
    expect(within(menu).getAllByRole("button").map((b) => b.textContent)).toEqual(["Free", "Left", "Right", "Bottom"]);
    expect(screen.getByTestId("recip-dock-right").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("recip-dock-bottom"));
    expect(p.onUpdate).toHaveBeenCalledWith({ dock: "bottom", locked: true });
    expect(screen.queryByTestId("recip-dock-menu")).toBeNull();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId("recip-dock-none"));
    expect(p.onUpdate).toHaveBeenLastCalledWith({ dock: "none", locked: false });
  });

  it("from the gear panel: the edge, and auto-hide while docked", () => {
    const p = show(docked("left"));
    fireEvent.click(screen.getByTestId("recip-config-toggle"));
    fireEvent.change(screen.getByTestId("recip-cfg-dock"), { target: { value: "right" } });
    expect(p.onUpdate).toHaveBeenCalledWith({ dock: "right", locked: true });
    const box = screen.getByTestId("recip-cfg-autohide") as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(p.onUpdate).toHaveBeenLastCalledWith({ autoHide: true });
  });

  it("the pin toggles auto-hide", () => {
    const p = show(docked("left"));
    fireEvent.click(screen.getByTestId("recip-pin"));
    expect(p.onUpdate).toHaveBeenCalledWith({ autoHide: true });
    cleanup();
    const q = show(docked("left", true), { revealed: true });
    expect(screen.getByTestId("recip-pin").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByTestId("recip-pin"));
    expect(q.onUpdate).toHaveBeenCalledWith({ autoHide: false });
  });

  it("a layout made before 6.0 docks with its lock button — to the bottom on a phone", () => {
    const old: LNode = { id: "w", el: "panel", tag: "div", children: [{ id: "b", el: "button", tag: "button", attrs: { type: "button", "data-testid": "old-lock" }, text: "{if $locked}unlock{else}lock{/if}", on: { click: { action: "toggleLock" } } }] };
    const p = show({}, { tree: old });
    fireEvent.click(screen.getByTestId("old-lock"));
    expect(p.onUpdate).toHaveBeenCalledWith({ dock: "right", locked: true });
    cleanup();
    document.documentElement.setAttribute("data-form", "phone");
    const q = show({}, { tree: old });
    fireEvent.click(screen.getByTestId("old-lock"));
    expect(q.onUpdate).toHaveBeenCalledWith({ dock: "bottom", locked: true });
    cleanup();
    const r = show(docked("left"), { tree: old });
    expect(screen.getByTestId("old-lock").textContent).toBe("unlock");
    fireEvent.click(screen.getByTestId("old-lock"));
    expect(r.onUpdate).toHaveBeenCalledWith({ dock: "none", locked: false });
  });

  it("on a phone the bottom comes first", () => {
    document.documentElement.setAttribute("data-form", "phone");
    show(docked("bottom"), { dockMenuOpen: true });
    expect(within(screen.getByTestId("recip-dock-menu")).getAllByRole("button").map((b) => b.textContent)).toEqual(["Free", "Bottom", "Left", "Right"]);
  });
});

describe("dragging onto an edge", () => {
  const head = () => screen.getByTestId("recip-drag");

  it("shows where it would dock, and docks there when dropped — keeping where it floated", () => {
    const p = show({ x: 320, y: 140 });
    fireEvent.pointerDown(head(), { clientX: 400, clientY: 150 });
    fireEvent.pointerMove(window, { clientX: window.innerWidth - 10, clientY: 300 });
    const hint = screen.getByTestId("recip-drop-hint");
    expect(hint.getAttribute("data-edge")).toBe("right");
    expect(hint.getAttribute("aria-hidden")).toBe("true");
    fireEvent.pointerUp(window);
    expect(p.onUpdate).toHaveBeenCalledWith({ dock: "right", locked: true, x: 320, y: 140 });
    expect(screen.queryByTestId("recip-drop-hint")).toBeNull();
  });

  it("docks at the bottom above the composer, and not at all in the middle", () => {
    const p = show({ x: 320, y: 140 });
    fireEvent.pointerDown(head(), { clientX: 400, clientY: 150 });
    fireEvent.pointerMove(window, { clientX: 500, clientY: window.innerHeight - 20 });
    expect(screen.getByTestId("recip-drop-hint").getAttribute("data-edge")).toBe("bottom");
    fireEvent.pointerMove(window, { clientX: 500, clientY: 300 });
    expect(screen.queryByTestId("recip-drop-hint")).toBeNull();
    fireEvent.pointerUp(window);
    expect(p.onUpdate).not.toHaveBeenCalled();
    expect(p.onMove).toHaveBeenCalled();
  });

  it("undocks a docked panel once the head is pulled — a press alone is not a drag", () => {
    const p = show(docked("right"));
    fireEvent.pointerDown(head(), { clientX: 900, clientY: 120 });
    fireEvent.pointerUp(window);
    expect(p.onUpdate).not.toHaveBeenCalled();
    expect(p.onMove).not.toHaveBeenCalled();
    fireEvent.pointerDown(head(), { clientX: 900, clientY: 120 });
    fireEvent.pointerMove(window, { clientX: 600, clientY: 300 });
    expect(p.onUpdate).toHaveBeenCalledWith({ dock: "none", locked: false });
    expect(p.onMove).toHaveBeenCalled();
    fireEvent.pointerUp(window);
  });

  it("a press on a button of the head is not a drag", () => {
    const p = show({ x: 320, y: 140 });
    fireEvent.pointerDown(screen.getByTestId("recip-dock-toggle"), { clientX: 400, clientY: 150 });
    fireEvent.pointerMove(window, { clientX: 10, clientY: 300 });
    fireEvent.pointerUp(window);
    expect(p.onMove).not.toHaveBeenCalled();
    expect(p.onUpdate).not.toHaveBeenCalled();
  });
});

describe("auto-hide: the handle", () => {
  it("slid in: only the handle shows; it names the panel it opens", () => {
    show(docked("right", true));
    const dock = screen.getByTestId("recip-dock");
    expect(dock.className).toContain("is-autohide");
    expect(dock.className).not.toContain("is-open");
    expect(dock.style.transform).toContain("translateX(100%)");
    expect(isIn()).toBe(true);
    expect(handle().getAttribute("aria-controls")).toBe(DOCK_PANEL_ID);
    expect(handle().tagName).toBe("BUTTON");
    expect(handle().getAttribute("aria-label")).toBe("Recipients (2)"); // Bob + Carol (away)
    expect(handle().textContent).toBe("2");
    expect(handle().className).toContain("recip-handle--right");
  });

  it("slides into its own edge", () => {
    show(docked("left", true));
    expect(screen.getByTestId("recip-dock").style.transform).toContain("translateX(-100%)");
    cleanup();
    show(docked("bottom", true));
    expect(screen.getByTestId("recip-dock").style.transform).toContain("translateY(100%)");
  });

  it("a click (or a tap, or Enter) slides it out and moves focus into it; Escape slides it back and focus returns", () => {
    show(docked("left", true));
    fireEvent.click(handle());
    expect(isOut()).toBe(true);
    expect(screen.getByTestId("recip-dock").style.transform).toContain("translateX(0)");
    expect(panel().contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(isIn()).toBe(true);
    expect(document.activeElement).toBe(handle());
  });

  it("a click outside slides it back", () => {
    show(docked("bottom", true));
    fireEvent.click(handle());
    expect(isOut()).toBe(true);
    fireEvent.pointerDown(document.body);
    expect(isIn()).toBe(true);
  });

  it("a click on the handle while it is out slides it back", () => {
    show(docked("right", true));
    fireEvent.click(handle());
    expect(isOut()).toBe(true);
    fireEvent.click(handle());
    expect(isIn()).toBe(true);
  });

  it("stays out while its settings are open or a field in it is focused", () => {
    show(docked("right", true));
    fireEvent.click(handle());
    fireEvent.click(screen.getByTestId("recip-config-toggle"));
    fireEvent.pointerDown(document.body);
    expect(isOut()).toBe(true);
    const range = screen.getByTestId("recip-config").querySelector("input") as HTMLInputElement;
    range.focus();
    fireEvent.keyDown(range, { key: "Escape" }); // closes the settings first
    expect(screen.queryByTestId("recip-config")).toBeNull();
    expect(isOut()).toBe(true);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(isIn()).toBe(true);
  });

  it("the edge chooser does not hold it out: Escape closes the chooser, a click outside closes both", () => {
    show(docked("left", true));
    fireEvent.click(handle());
    fireEvent.click(screen.getByTestId("recip-dock-toggle"));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByTestId("recip-dock-menu")).toBeNull();
    expect(isOut()).toBe(true);
    fireEvent.click(screen.getByTestId("recip-dock-toggle"));
    fireEvent.pointerDown(document.body);
    expect(isIn()).toBe(true);
    expect(screen.queryByTestId("recip-dock-menu")).toBeNull();
  });

  it("a mouse over the handle slides it out; leaving slides it back after a moment", () => {
    vi.useFakeTimers();
    show(docked("right", true));
    fireEvent.pointerEnter(handle(), { pointerType: "mouse" });
    expect(isOut()).toBe(true);
    // Hover does not steal the focus (someone may be typing).
    expect(panel().contains(document.activeElement)).toBe(false);
    fireEvent.pointerLeave(handle(), { pointerType: "mouse" });
    act(() => { vi.advanceTimersByTime(HIDE_DELAY_MS - 100); });
    expect(isOut()).toBe(true);
    // Back over it before the time is up: it stays.
    fireEvent.pointerEnter(screen.getByTestId("recip-widget"), { pointerType: "mouse" });
    act(() => { vi.advanceTimersByTime(HIDE_DELAY_MS * 2); });
    expect(isOut()).toBe(true);
    fireEvent.pointerLeave(screen.getByTestId("recip-widget"), { pointerType: "mouse" });
    act(() => { vi.advanceTimersByTime(HIDE_DELAY_MS + 10); });
    expect(isIn()).toBe(true);
  });

  it("a touch that brushes the handle does not open it — the tap (click) does", () => {
    show(docked("bottom", true));
    fireEvent.pointerEnter(handle(), { pointerType: "touch" });
    expect(isIn()).toBe(true);
    fireEvent.click(handle());
    expect(isOut()).toBe(true);
  });

  it("draws the operator's handle: the icon is theirs to change", () => {
    const tree = structuredClone(DEFAULT_LAYOUTS["widget.handle"]);
    walkTree(tree, (n) => { if (n.el === "icon") n.props = { ...n.props, icon: "pin" }; });
    show(docked("right", true), { handleTree: tree });
    expect(handle().querySelector("svg")?.getAttribute("class")).toContain("lucide-pin");
    cleanup();
    // In the app the handle comes from the LayoutProvider (the operator's layout, or a variant).
    const cfg = sanitizeLayout({ layouts: { "widget.handle": { tree, rev: "x" } } });
    render(
      <LayoutProvider config={cfg} ctx={{}}>
        <RecipientsWidget peers={PEERS} room="brno" state={{ ...BASE, ...docked("left", true) }} selected={new Set()} onTogglePeer={vi.fn()} onToggleAuto={vi.fn()} onSelectAll={vi.fn()} onSelectNone={vi.fn()} onPeerInfo={vi.fn()} onRoomInfo={vi.fn()} onMove={vi.fn()} onMinimize={vi.fn()} onUpdate={vi.fn()} lang="cs" />
      </LayoutProvider>,
    );
    expect(handle().querySelector("svg")?.getAttribute("class")).toContain("lucide-pin");
    expect(handle().getAttribute("aria-label")).toBe("Příjemci (2)");
  });
});

describe("the widget.handle layout", () => {
  it("is a layout of the app's main screen with a default tree, a contract and preview situations", () => {
    expect(LAYOUT_IDS).toContain("widget.handle");
    expect(LAYOUT_GROUP["widget.handle"]).toBe("app");
    const icons: string[] = [];
    walkTree(DEFAULT_LAYOUTS["widget.handle"], (n) => { if (n.el === "icon") icons.push(String(n.props?.icon)); });
    expect(icons).toEqual(["users"]);
    const c = LAYOUT_CONTRACTS["widget.handle"];
    expect(c.vars.map((v) => v.path)).toEqual(expect.arrayContaining(["$edge", "$count", "$open", "$label", "$panelId"]));
    expect(c.actions.map((a) => a.name)).toEqual(["reveal"]);
    expect(PREVIEW_VARIANTS["widget.handle"].map((v) => v.id)).toEqual(["right", "left", "bottom", "open"]);
    expect(LAYOUT_CONTRACTS.widget.actions.map((a) => a.name)).toEqual(expect.arrayContaining(["toggleDockMenu", "setDock", "dockChange", "togglePin", "autoHideChange", "toggleLock"]));
  });

  it("slides with the operator's timing, and not at all for reduced motion", () => {
    const css = readFileSync(resolve(import.meta.dirname, "..", "client", "src", "index.css"), "utf8");
    expect(css).toContain("transition: transform var(--c-widget-slide-dur, 220ms) var(--c-widget-slide-ease, ease-out)");
    const reduced = css.slice(css.indexOf("Reduced motion: no slide"));
    expect(reduced).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.recip-dock, \.recip-dock__panel[^{]*\{ transition: none; \}/);
  });
});
