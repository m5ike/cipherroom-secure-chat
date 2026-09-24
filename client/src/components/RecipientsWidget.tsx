// Floating "who receives my messages" widget. It can be dragged anywhere
// (the minimised button too — dragging it undocks it), minimised to a single
// button, LOCKED (docked on the right, next to the menu button), and
// restyled (size / opacity / colour / font / zoom) from its gear menu. Layout persists in Preferences.widget (which syncs to the server in
// Server-enhanced mode). Each connected peer shows an avatar, a latency meter,
// an info button and a recipient checkbox; offline peers sink to the bottom of
// the list and render disabled. A final Room row toggles "send to everyone".

import { useEffect, useRef, useState } from "react";
import { t, type Lang } from "../lib/i18n";
import type { WidgetState } from "../lib/preferences";
import type { LNode } from "../lib/layout-tree";
import { DEFAULT_LAYOUTS } from "../lib/layouts";
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

export function RecipientsWidget({
  peers, room, state, selected, onTogglePeer, onToggleAuto, onSelectAll, onSelectNone, onPeerInfo, onRoomInfo, onMove, onMinimize, onUpdate, title, lang, tree, fabTree, blocks, configOpen = false,
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
  blocks?: Record<string, LNode>;
  /** Start with the settings open (the Layout builder's preview). */
  configOpen?: boolean;
}) {
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  /** A pointer that travelled: then it was a drag, not a click. */
  const movedRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [showConfig, setShowConfig] = useState(configOpen);
  const anchored = !state.locked && state.x === 0 && state.y === 0;
  const widgetTitle = title ?? t(lang, "recipients.title");

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const off = dragRef.current;
      if (!off) return;
      const from = startRef.current;
      if (from && Math.abs(e.clientX - from.x) + Math.abs(e.clientY - from.y) > 4) movedRef.current = true;
      const x = Math.max(4, Math.min(window.innerWidth - 60, e.clientX - off.dx));
      const y = Math.max(4, Math.min(window.innerHeight - 40, e.clientY - off.dy));
      onMove(x, y);
    };
    const up = () => {
      setDragging(false);
      dragRef.current = null;
      startRef.current = null;
      // Let the click that follows a drag fall through as a no-op.
      window.setTimeout(() => { movedRef.current = false; }, 0);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, [dragging, onMove]);

  /** Dragging the minimised button moves it — and undocks it, so its place
   *  is remembered (Preferences.widget, which the account vault syncs). */
  function startFabDrag(e: React.PointerEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    movedRef.current = false;
    startRef.current = { x: e.clientX, y: e.clientY };
    if (state.locked) onUpdate({ locked: false, x: rect.left, y: rect.top });
    else if (anchored) onMove(rect.left, rect.top);
    setDragging(true);
  }

  function startDrag(e: React.PointerEvent) {
    if (state.locked) return; // docked → no dragging
    const host = (e.currentTarget as HTMLElement).closest(".recip-widget") as HTMLElement | null;
    const rect = host?.getBoundingClientRect();
    if (rect) {
      dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
      if (anchored) onMove(rect.left, rect.top);
    }
    setDragging(true);
  }

  // Docked → top right, under the menu button. `--m5-dock-top` is the bottom
  // edge of the header + status bar (App measures it), so the widget never
  // covers the controls there. Floating → x/y or bottom-right.
  const posStyle: React.CSSProperties = state.locked
    ? { right: 8, top: "var(--m5-dock-top, 96px)", transformOrigin: "top right" }
    : anchored
      ? { right: 12, bottom: 88, transformOrigin: "bottom right" }
      : { left: state.x, top: state.y, transformOrigin: "top left" };

  const appearance: React.CSSProperties = {
    ...posStyle,
    width: state.width,
    opacity: state.opacity,
    transform: `scale(${state.zoom})`,
    fontSize: `${state.fontScale}rem`,
    ...(state.accent ? { background: state.accent } : {}),
  };

  const openPeers = peers.filter((p) => p.status === "open");
  const awayPeers = peers.filter((p) => p.status === "away");
  const env = (data: Record<string, unknown>): LayoutEnv => ({
    data: { ...data, title: widgetTitle, locked: state.locked, room, autoRoom: state.autoRoom },
    lang,
    translate: (key) => t(lang, key),
    blocks,
    actions: {
      fabDrag: (e) => startFabDrag(e as React.PointerEvent),
      fabClick: () => { if (!movedRef.current) onMinimize(false); },
      startDrag: (e) => startDrag(e as React.PointerEvent),
      toggleConfig: () => setShowConfig((v) => !v),
      toggleLock: () => onUpdate({ locked: !state.locked }),
      minimize: () => onMinimize(true),
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
    return renderLayout(fabTree ?? DEFAULT_FAB, env({ pos: posStyle, count: openPeers.length + awayPeers.length }));
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

  return renderLayout(tree ?? DEFAULT_WIDGET, env({
    appearance,
    showConfig,
    configRows,
    accent: state.accent,
    accentValue: /^#[0-9a-fA-F]{6}$/.test(state.accent) ? state.accent : "#151a23",
    hasPeers: peers.length > 0,
    peers: ordered,
  }));
}
