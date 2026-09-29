// Floating "who receives my messages" widget. It can be dragged anywhere
// (the minimised button too — dragging it undocks it), minimised to a single
// button, DOCKED — 6.0: to the left, right or bottom edge of the chat area,
// pinned there or auto-hidden (slid into the edge behind a handle, the
// `widget.handle` layout) — and restyled (size / opacity / colour / font /
// zoom) from its gear menu. Dragging a docked panel's head undocks it;
// dropping a panel near an edge docks it there. Layout persists in
// Preferences.widget (which syncs to the account vault). Each connected peer
// shows an avatar, a latency meter, an info button and a recipient checkbox;
// offline peers sink to the bottom of the list and render disabled. A final
// Room row toggles "send to everyone".

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { t, type Lang } from "../lib/i18n";
import { dockPatch, isWidgetDock, widgetDock, WIDGET_DOCKS, type WidgetDock, type WidgetState } from "../lib/preferences";
import type { LNode } from "../lib/layout-tree";
import { DEFAULT_LAYOUTS } from "../lib/layouts";
import { useLayout } from "./LayoutProvider";
import { renderLayout, type LayoutEnv } from "./LayoutView";

/** "away": signed in, not connected right now — the server holds messages
 *  for them (server/accounts/relay.ts), so they stay selectable. */
export type WidgetPeer = { id: string; name: string; status: "connecting" | "open" | "closed" | "away"; rttMs?: number; avatar?: string; since?: number };

/** The latency meter's data: four bars, how many lit, and a tone. */
function latency(rttMs: number | undefined, open: boolean) {
  const q = !open ? 0 : rttMs === undefined ? 2 : rttMs < 60 ? 4 : rttMs < 120 ? 3 : rttMs < 250 ? 2 : 1;
  return {
    tone: q >= 4 ? "good" : q >= 2 ? "ok" : q >= 1 ? "bad" : "off",
    rttTitle: open && rttMs !== undefined ? `${rttMs} ms` : "—",
    bars: Array.from({ length: 4 }, (_, i) => ({ on: i < q, height: `${(i + 1) * 25}%` })),
  };
}

const DEFAULT_WIDGET = DEFAULT_LAYOUTS.widget;
const DEFAULT_FAB = DEFAULT_LAYOUTS["widget.fab"];

type Edge = Exclude<WidgetDock, "none">;

/** How near an edge (px) a dragged widget docks to it. */
export const SNAP_PX = 48;
/** How long (ms) an auto-hidden panel stays out after the pointer left it. */
export const HIDE_DELAY_MS = 800;
/** The docked panel's id — the handle's aria-controls. */
export const DOCK_PANEL_ID = "recip-dock-panel";
/** An icon per edge (in the Layout builder's icon catalog). */
const DOCK_ICONS: Record<WidgetDock, string> = { none: "move", left: "panel-left", right: "panel-right", bottom: "panel-bottom" };
/** Below the header and the status bar (App measures --m5-dock-top), above the composer (--m5-dock-bottom, measured here). */
const DOCK_TOP = "var(--m5-dock-top, 96px)";
const DOCK_BOTTOM = "var(--m5-dock-bottom, 88px)";
const DOCK_PLACE: Record<Edge, CSSProperties> = {
  left: { left: 0, top: DOCK_TOP, transformOrigin: "top left" },
  right: { right: 0, top: DOCK_TOP, transformOrigin: "top right" },
  bottom: { left: 0, right: 0, bottom: DOCK_BOTTOM, transformOrigin: "bottom center" },
};
/** Out (shown) and in (slid into the edge) — the same functions, so the transform animates. */
const SLIDE_SHOWN: Record<Edge, string> = { left: "translateX(0)", right: "translateX(0)", bottom: "translateY(0)" };
const SLIDE_HIDDEN: Record<Edge, string> = { left: "translateX(-100%)", right: "translateX(100%)", bottom: "translateY(100%)" };
const FOCUSABLE = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

const isPhone = () => typeof document !== "undefined" && document.documentElement.getAttribute("data-form") === "phone";

/** Where "dock" goes when no edge was chosen: the bottom on a phone (a side panel would cover the conversation), else the right. */
export function defaultDock(): Edge {
  return isPhone() ? "bottom" : "right";
}

/**
 * The edge a widget dragged to (x, y) docks to: the nearest one within
 * SNAP_PX — the left or right edge of the window, or the bottom (the
 * composer's top, `bottomInset` px above the window's bottom) — else "none".
 */
export function snapEdge(x: number, y: number, width: number, height: number, bottomInset: number): WidgetDock {
  const near: Array<[WidgetDock, number]> = [["left", x], ["right", width - x], ["bottom", height - bottomInset - y]];
  let best: WidgetDock = "none";
  let dist = SNAP_PX;
  for (const [edge, d] of near) if (d < dist) { best = edge; dist = d; }
  return best;
}

/** The composer's top, in px from the window's bottom (what useComposerInset keeps in --m5-dock-bottom). */
function dockBottomInset(): number {
  if (typeof document === "undefined") return 88;
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--m5-dock-bottom"));
  return Number.isFinite(v) && v >= 0 ? v : 88;
}

/**
 * Keeps --m5-dock-bottom measured: from the window's bottom to just above the
 * composer — so a dock (the bottom strip most of all) never covers it, also
 * while a phone's keyboard pushes the composer up.
 */
function useComposerInset(dock: WidgetDock): void {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const root = document.documentElement;
    const composer = () => document.querySelector<HTMLElement>(".composer");
    const apply = () => {
      const el = composer();
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      if (top <= 0) return; // not laid out (hidden, a test)
      root.style.setProperty("--m5-dock-bottom", `${Math.max(0, Math.round(window.innerHeight - top)) + 8}px`);
    };
    apply();
    const el = composer();
    const observer = el && typeof ResizeObserver === "function" ? new ResizeObserver(apply) : null;
    if (el) observer?.observe(el);
    const vv = window.visualViewport;
    window.addEventListener("resize", apply);
    vv?.addEventListener("resize", apply);
    vv?.addEventListener("scroll", apply);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", apply);
      vv?.removeEventListener("resize", apply);
      vv?.removeEventListener("scroll", apply);
    };
  }, [dock]);
}

/** A drag of the head or of the minimised button. */
type Drag = {
  dx: number;
  dy: number;
  startX: number;
  startY: number;
  /** Docked when it started: undocks once the pointer travels (a press alone is a click). */
  undock: boolean;
  /** Docks near an edge when dropped (the panel's head; not the minimised button). */
  snap: boolean;
  edge: WidgetDock;
  /** Where it floated before — kept for when it floats again after docking. */
  origin: { x: number; y: number };
};

export function RecipientsWidget({
  peers, room, state, selected, onTogglePeer, onToggleAuto, onSelectAll, onSelectNone, onPeerInfo, onRoomInfo, onMove, onMinimize, onUpdate, title, lang, tree, fabTree, handleTree, blocks,
  configOpen = false, dockMenuOpen = false, revealed = false,
}: {
  peers: WidgetPeer[];
  room: string;
  state: WidgetState;
  selected: Set<string>;
  onTogglePeer: (id: string) => void;
  onToggleAuto: (auto: boolean) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onPeerInfo: (id: string) => void;
  onRoomInfo: () => void;
  onMove: (x: number, y: number) => void;
  onMinimize: (min: boolean) => void;
  onUpdate: (patch: Partial<WidgetState>) => void;
  /** Rendered title (admin Layout builder template); falls back to the i18n label. */
  title?: string;
  lang: Lang;
  /** 4.0.5: the layouts to draw (Layout builder); default: the app's own. */
  tree?: LNode;
  fabTree?: LNode;
  /** 6.0: the handle of an auto-hidden docked panel; default: the LayoutProvider's (else the app's own). */
  handleTree?: LNode;
  blocks?: Record<string, LNode>;
  /** Start with the settings open (the Layout builder's preview). */
  configOpen?: boolean;
  /** Start with the edge chooser open (the preview). */
  dockMenuOpen?: boolean;
  /** An auto-hidden panel starts slid out (the preview). */
  revealed?: boolean;
}) {
  const dragRef = useRef<Drag | null>(null);
  /** A pointer that travelled: then it was a drag, not a click. */
  const movedRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  /** The edge a drag would dock to (the drop hint). */
  const [snap, setSnap] = useState<WidgetDock>("none");
  const [showConfig, setShowConfig] = useState(configOpen);
  const [showDockMenu, setShowDockMenu] = useState(dockMenuOpen);
  /** An auto-hidden panel slid out of its edge. */
  const [open, setOpen] = useState(revealed);
  const dockRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const tabRef = useRef<HTMLDivElement | null>(null);
  const hideTimer = useRef<number | null>(null);
  const hoverOpenedAt = useRef(0);
  const focusOnOpen = useRef(false);
  const { tree: providedHandle } = useLayout("widget.handle");

  const dock = widgetDock(state);
  const docked = dock !== "none";
  const autoHide = docked && state.autoHide === true;
  const hidden = autoHide && !open;
  const anchored = !docked && state.x === 0 && state.y === 0;
  const widgetTitle = title ?? t(lang, "recipients.title");

  useComposerInset(dock);

  // What listeners that outlive a render (a drag, the timers) need to see.
  const live = useRef({ onMove, onUpdate, autoHide, showConfig, showDockMenu });
  live.current = { onMove, onUpdate, autoHide, showConfig, showDockMenu };

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const travelled = Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) > 4;
      if (travelled) movedRef.current = true;
      if (d.undock && !travelled) return; // a press on a docked widget is not a drag (yet)
      const x = Math.max(4, Math.min(window.innerWidth - 60, e.clientX - d.dx));
      const y = Math.max(4, Math.min(window.innerHeight - 40, e.clientY - d.dy));
      if (d.undock) {
        // Pulled off its edge: it floats from here, under the pointer.
        d.undock = false;
        live.current.onUpdate(dockPatch("none"));
      }
      live.current.onMove(x, y);
      if (d.snap) {
        const edge = movedRef.current ? snapEdge(e.clientX, e.clientY, window.innerWidth, window.innerHeight, dockBottomInset()) : "none";
        if (edge !== d.edge) { d.edge = edge; setSnap(edge); }
      }
    };
    const end = (drop: boolean) => {
      const d = dragRef.current;
      setDragging(false);
      setSnap("none");
      dragRef.current = null;
      // Dropped near an edge: docked there (slid in, when it auto-hides), and
      // the place it floated at before is kept for when it floats again.
      if (drop && d?.snap && d.edge !== "none") {
        setOpen(false);
        live.current.onUpdate({ ...dockPatch(d.edge), x: d.origin.x, y: d.origin.y });
      }
      // Let the click that follows a drag fall through as a no-op.
      window.setTimeout(() => { movedRef.current = false; }, 0);
    };
    const up = () => end(true);
    const cancel = () => end(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
  }, [dragging]);

  /** Dragging the minimised button moves it — and undocks it, so its place
   *  is remembered (Preferences.widget, which the account vault syncs). */
  function startFabDrag(e: React.PointerEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, startX: e.clientX, startY: e.clientY, undock: docked, snap: false, edge: "none", origin: { x: state.x, y: state.y } };
    movedRef.current = false;
    if (anchored) onMove(rect.left, rect.top);
    setDragging(true);
  }

  function startDrag(e: React.PointerEvent) {
    if (e.button > 0) return;
    // A press on a control of the head (settings, dock, pin, minimise) is not a drag.
    const head = e.currentTarget as HTMLElement;
    const control = (e.target as Element | null)?.closest?.("button, input, select, textarea, a");
    if (control && control !== head && head.contains(control)) return;
    const host = (head.closest(".recip-widget") ?? head.parentElement) as HTMLElement | null;
    const rect = host?.getBoundingClientRect();
    if (!rect) return;
    dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, startX: e.clientX, startY: e.clientY, undock: docked, snap: true, edge: "none", origin: { x: state.x, y: state.y } };
    movedRef.current = false;
    if (anchored) onMove(rect.left, rect.top);
    setDragging(true);
  }

  /* ------------------------------------------------ docked: auto-hide */

  const cancelHide = () => {
    if (hideTimer.current !== null) { window.clearTimeout(hideTimer.current); hideTimer.current = null; }
  };
  /** Something inside keeps an auto-hidden panel out: its settings (the gear), a field being typed in. */
  const busy = () => {
    if (live.current.showConfig) return true;
    const active = typeof document !== "undefined" ? document.activeElement : null;
    return Boolean(active && dockRef.current?.contains(active) && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName));
  };
  const hide = (focusHandle: boolean) => {
    cancelHide();
    // Keyboard focus goes back to the handle before the panel turns inert.
    if (focusHandle) tabRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    setShowDockMenu(false);
    setOpen(false);
  };
  const scheduleHide = () => {
    cancelHide();
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = null;
      if (live.current.autoHide && !busy()) hide(false);
    }, HIDE_DELAY_MS);
  };
  useEffect(() => cancelHide, []);
  useEffect(() => { if (!autoHide) cancelHide(); }, [autoHide]);

  // Opened by a click, a tap or the keyboard: focus goes into the panel.
  useEffect(() => {
    if (!open || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, [open]);

  // Out: a click outside or Escape slides it back in (not while it is busy).
  useEffect(() => {
    if (!autoHide || !open) return;
    const down = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (target && dockRef.current?.contains(target)) return;
      if (busy()) return;
      hide(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const active = document.activeElement;
      const inside = Boolean(active && dockRef.current?.contains(active));
      if (!inside && active && active !== document.body) return; // an Escape meant for something else
      if (live.current.showDockMenu) { setShowDockMenu(false); return; }
      if (live.current.showConfig) { setShowConfig(false); return; }
      if (busy()) return;
      hide(inside);
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key);
    };
  }, [autoHide, open]);

  /** A mouse over the handle slides the panel out; leaving it (and the panel) slides it back in a moment later. */
  const onDockEnter = (e: React.PointerEvent) => {
    if (e.pointerType !== "mouse" || !autoHide) return;
    cancelHide();
    if (!open) { hoverOpenedAt.current = Date.now(); setOpen(true); }
  };
  const onDockLeave = (e: React.PointerEvent) => {
    if (e.pointerType !== "mouse" || !autoHide) return;
    scheduleHide();
  };

  /** The handle: a click, a tap or Enter slides the panel out — or back in. */
  function reveal() {
    if (!autoHide) return;
    cancelHide();
    if (!open) { focusOnOpen.current = true; setOpen(true); return; }
    // The click that follows the hover which slid it out keeps it out.
    if (Date.now() - hoverOpenedAt.current < 600) return;
    hide(false);
  }

  function setDock(next: WidgetDock) {
    setShowDockMenu(false);
    if (next === dock) return;
    // Moved to another edge while it auto-hides: it shows where it went, then tucks in.
    if (next !== "none" && state.autoHide === true) { setOpen(true); scheduleHide(); }
    onUpdate(dockPatch(next));
  }

  function setAutoHide(on: boolean) {
    // Turned on from inside the panel: it stays out until the pointer leaves (or a click outside).
    if (on) setOpen(true);
    onUpdate({ autoHide: on });
  }

  /* ------------------------------------------------------------ drawing */

  // Floating → x/y, or bottom-right until it was moved. Docked, the minimised
  // button sits where the panel's edge is: the top of a side (below the header
  // and the status bar, so it never covers Disconnect), or above the composer.
  const fabPos: CSSProperties = dock === "left"
    ? { left: 8, top: DOCK_TOP, transformOrigin: "top left" }
    : dock === "right"
      ? { right: 8, top: DOCK_TOP, transformOrigin: "top right" }
      : dock === "bottom"
        ? { right: 12, bottom: DOCK_BOTTOM, transformOrigin: "bottom right" }
        : anchored
          ? { right: 12, bottom: 88, transformOrigin: "bottom right" }
          : { left: state.x, top: state.y, transformOrigin: "top left" };

  const look: CSSProperties = {
    opacity: state.opacity,
    fontSize: `${state.fontScale}rem`,
    ...(state.accent ? { background: state.accent } : {}),
  };
  // Docked, the edge holder places, scales and slides it; floating, it does that itself.
  const appearance: CSSProperties = docked
    ? { ...(dock === "bottom" ? {} : { width: state.width }), ...look }
    : { ...fabPos, width: state.width, opacity: state.opacity, transform: `scale(${state.zoom})`, fontSize: look.fontSize, ...(state.accent ? { background: state.accent } : {}) };

  const openPeers = peers.filter((p) => p.status === "open");
  const awayPeers = peers.filter((p) => p.status === "away");
  const count = openPeers.length + awayPeers.length;
  // On a phone the bottom comes first: that is where docking goes there.
  const edges: readonly WidgetDock[] = isPhone() ? ["none", "bottom", "left", "right"] : WIDGET_DOCKS;
  const dockLabel = t(lang, `recipients.dock.${dock}`);
  const env = (data: Record<string, unknown>): LayoutEnv => ({
    data: { ...data, title: widgetTitle, locked: docked, docked, dock, autoHide, hidden, room, autoRoom: state.autoRoom },
    lang,
    translate: (key) => t(lang, key),
    blocks,
    actions: {
      fabDrag: (e) => startFabDrag(e as React.PointerEvent),
      fabClick: () => { if (!movedRef.current) onMinimize(false); },
      startDrag: (e) => startDrag(e as React.PointerEvent),
      toggleConfig: () => setShowConfig((v) => !v),
      // The button of layouts made before 6.0: dock (to the natural edge) / undock.
      toggleLock: () => setDock(docked ? "none" : defaultDock()),
      toggleDockMenu: () => setShowDockMenu((v) => !v),
      setDock: (_e, edge) => { if (isWidgetDock(edge)) setDock(edge); },
      dockChange: (e) => { const v = (e as { target: HTMLSelectElement }).target.value; if (isWidgetDock(v)) setDock(v); },
      togglePin: () => setAutoHide(state.autoHide !== true),
      autoHideChange: (e) => setAutoHide((e as { target: HTMLInputElement }).target.checked),
      reveal: () => reveal(),
      minimize: () => { setShowDockMenu(false); onMinimize(true); },
      configChange: (e, key) => onUpdate({ [String(key)]: Number((e as { target: HTMLInputElement }).target.value) } as Partial<WidgetState>),
      accentChange: (e) => onUpdate({ accent: (e as { target: HTMLInputElement }).target.value }),
      accentReset: () => onUpdate({ accent: "" }),
      peerInfo: (_e, id) => onPeerInfo(String(id)),
      togglePeer: (_e, id) => onTogglePeer(String(id)),
      roomInfo: () => onRoomInfo(),
      toggleAuto: () => onToggleAuto(!state.autoRoom),
      selectAll: () => onSelectAll(),
      selectNone: () => onSelectNone(),
    },
  });

  if (state.minimized) {
    return renderLayout(fabTree ?? DEFAULT_FAB, env({ pos: fabPos, count }));
  }

  // Online first, offline (not open) sunk to the bottom and disabled.
  // Connected first, away next (the server answers for them), gone last.
  const rank = (p: WidgetPeer) => (p.status === "open" ? 0 : p.status === "away" ? 1 : 2);
  const ordered = [...peers].sort((a, b) => rank(a) - rank(b)).map((p) => {
    const away = p.status === "away";
    const online = p.status === "open";
    // An away member is reachable through the server, so they can be
    // selected just like a connected peer.
    const reachable = online || away;
    const checked = reachable && (state.autoRoom || selected.has(p.id));
    return { id: p.id, name: p.name, avatar: p.avatar ?? "", status: p.status, away, online, reachable, checked, disabled: !reachable || state.autoRoom, ...latency(p.rttMs, online) };
  });
  const configRows = [
    { key: "width", label: t(lang, "recipients.cfg.width"), min: 180, max: 420, step: 10, value: state.width, display: `${state.width}px` },
    { key: "opacity", label: t(lang, "recipients.cfg.opacity"), min: 0.3, max: 1, step: 0.05, value: state.opacity, display: `${Math.round(state.opacity * 100)}%` },
    { key: "fontScale", label: t(lang, "recipients.cfg.font"), min: 0.8, max: 1.4, step: 0.05, value: state.fontScale, display: `${state.fontScale}×` },
    { key: "zoom", label: t(lang, "recipients.cfg.zoom"), min: 0.7, max: 1.4, step: 0.05, value: state.zoom, display: `${state.zoom}×` },
  ];

  const panel = renderLayout(tree ?? DEFAULT_WIDGET, env({
    appearance,
    showConfig,
    showDockMenu,
    dockLabel,
    dockIcon: DOCK_ICONS[dock],
    dockOptions: edges.map((d) => ({ id: d, label: t(lang, `recipients.dock.${d}`), icon: DOCK_ICONS[d], current: d === dock })),
    configRows,
    accent: state.accent,
    accentValue: /^#[0-9a-fA-F]{6}$/.test(state.accent) ? state.accent : "#151a23",
    hasPeers: peers.length > 0,
    peers: ordered,
  }));

  // Dragged near an edge: where it would dock.
  const hint = dragging && snap !== "none" ? (
    <div className={`recip-drop-hint recip-drop-hint--${snap}`} data-testid="recip-drop-hint" data-edge={snap} aria-hidden="true">
      <span>{t(lang, "recipients.dock.drop")}</span>
    </div>
  ) : null;

  if (!docked) return <>{panel}{hint}</>;

  const edge = dock as Edge;
  const holder: CSSProperties = { ...DOCK_PLACE[edge], transform: `scale(${state.zoom}) ${hidden ? SLIDE_HIDDEN[edge] : SLIDE_SHOWN[edge]}` };
  return (
    <>
      <div
        ref={dockRef}
        className={`recip-dock recip-dock--${edge}${autoHide ? " is-autohide" : ""}${hidden ? "" : " is-open"}`}
        style={holder}
        data-testid="recip-dock"
        data-edge={edge}
        onPointerEnter={onDockEnter}
        onPointerLeave={onDockLeave}
      >
        <div ref={panelRef} id={DOCK_PANEL_ID} className="recip-dock__panel" inert={hidden}>{panel}</div>
        {autoHide ? (
          <div ref={tabRef} className="recip-dock__tab">
            {renderLayout(handleTree ?? providedHandle, env({ edge, count, open: !hidden, label: `${widgetTitle} (${count})`, panelId: DOCK_PANEL_ID }))}
          </div>
        ) : null}
      </div>
      {hint}
    </>
  );
}
