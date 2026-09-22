// Floating "who receives my messages" widget. It can be dragged anywhere,
// minimised to a single button, LOCKED (docked to a fixed corner next to the
// menu), and restyled (size / opacity / colour / font / zoom) from its gear
// menu. Layout persists in Preferences.widget (which syncs to the server in
// Server-enhanced mode). Each connected peer shows an avatar, a latency meter,
// an info button and a recipient checkbox; offline peers sink to the bottom of
// the list and render disabled. A final Room row toggles "send to everyone".

import { useEffect, useRef, useState } from "react";
import { Users, Info, Check, X, Radio, Minus, GripHorizontal, Lock, LockOpen, Settings2 } from "lucide-react";
import { t, type Lang } from "../lib/i18n";
import { Avatar } from "./UserBadge";
import type { WidgetState } from "../lib/preferences";

export type WidgetPeer = { id: string; name: string; status: "connecting" | "open" | "closed"; rttMs?: number; avatar?: string };

function LatencyMeter({ rttMs, open }: { rttMs?: number; open: boolean }) {
  const bars = 4;
  const q = !open ? 0 : rttMs === undefined ? 2 : rttMs < 60 ? 4 : rttMs < 120 ? 3 : rttMs < 250 ? 2 : 1;
  const tone = q >= 4 ? "good" : q >= 2 ? "ok" : q >= 1 ? "bad" : "off";
  return (
    <span className={`lat-meter lat-${tone}`} title={open && rttMs !== undefined ? `${rttMs} ms` : "—"} aria-hidden="true">
      {Array.from({ length: bars }, (_, i) => (
        <span key={i} className={`lat-bar ${i < q ? "on" : ""}`} style={{ height: `${(i + 1) * 25}%` }} />
      ))}
    </span>
  );
}

export function RecipientsWidget({
  peers, room, state, selected, onTogglePeer, onToggleAuto, onSelectAll, onSelectNone, onPeerInfo, onRoomInfo, onMove, onMinimize, onUpdate, title, lang,
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
}) {
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const anchored = !state.locked && state.x === 0 && state.y === 0;
  const widgetTitle = title ?? t(lang, "recipients.title");

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const off = dragRef.current;
      if (!off) return;
      const x = Math.max(4, Math.min(window.innerWidth - 60, e.clientX - off.dx));
      const y = Math.max(4, Math.min(window.innerHeight - 40, e.clientY - off.dy));
      onMove(x, y);
    };
    const up = () => { setDragging(false); dragRef.current = null; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, [dragging, onMove]);

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

  // Docked → fixed top-left, next to the menu. Floating → x/y or bottom-right.
  const posStyle: React.CSSProperties = state.locked
    ? { left: 8, top: 60, transformOrigin: "top left" }
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

  if (state.minimized) {
    return (
      <button type="button" className="recip-fab" style={posStyle} onClick={() => onMinimize(false)} data-testid="recip-fab" title={widgetTitle}>
        <Users className="h-5 w-5" />
        <span className="recip-fab__count">{openPeers.length}</span>
      </button>
    );
  }

  // Online first, offline (not open) sunk to the bottom and disabled.
  const ordered = [...peers].sort((a, b) => (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1));

  return (
    <div className={`recip-widget${state.locked ? " is-locked" : ""}`} style={appearance} data-testid="recip-widget" role="group" aria-label={widgetTitle}>
      <div className="recip-widget__head" onPointerDown={startDrag} data-testid="recip-drag">
        {state.locked ? <Lock className="h-4 w-4 opacity-70" /> : <GripHorizontal className="h-4 w-4 opacity-60" />}
        <span className="recip-widget__title">{widgetTitle}</span>
        <button type="button" className="recip-widget__min" onClick={() => setShowConfig((v) => !v)} aria-label={t(lang, "recipients.settings")} title={t(lang, "recipients.settings")} data-testid="recip-config-toggle">
          <Settings2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="recip-widget__min"
          onClick={() => onUpdate({ locked: !state.locked })}
          aria-label={state.locked ? t(lang, "recipients.unlock") : t(lang, "recipients.lock")}
          title={state.locked ? t(lang, "recipients.unlock") : t(lang, "recipients.lock")}
          data-testid="recip-lock"
        >
          {state.locked ? <LockOpen className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
        </button>
        <button type="button" className="recip-widget__min" onClick={() => onMinimize(true)} aria-label={t(lang, "recipients.minimize")}>
          <Minus className="h-4 w-4" />
        </button>
      </div>

      {showConfig ? (
        <div className="recip-config" data-testid="recip-config">
          <ConfigRow label={t(lang, "recipients.cfg.width")} min={180} max={420} step={10} value={state.width} onChange={(v) => onUpdate({ width: v })} suffix="px" />
          <ConfigRow label={t(lang, "recipients.cfg.opacity")} min={0.3} max={1} step={0.05} value={state.opacity} onChange={(v) => onUpdate({ opacity: v })} percent />
          <ConfigRow label={t(lang, "recipients.cfg.font")} min={0.8} max={1.4} step={0.05} value={state.fontScale} onChange={(v) => onUpdate({ fontScale: v })} suffix="×" />
          <ConfigRow label={t(lang, "recipients.cfg.zoom")} min={0.7} max={1.4} step={0.05} value={state.zoom} onChange={(v) => onUpdate({ zoom: v })} suffix="×" />
          <label className="recip-cfg-row">
            <span>{t(lang, "recipients.cfg.color")}</span>
            <span className="flex items-center gap-2">
              <input type="color" className="h-6 w-8 rounded border-0 bg-transparent p-0" value={/^#[0-9a-fA-F]{6}$/.test(state.accent) ? state.accent : "#151a23"} onChange={(e) => onUpdate({ accent: e.target.value })} />
              {state.accent ? <button type="button" className="text-[10px] underline" onClick={() => onUpdate({ accent: "" })}>{t(lang, "userstyle.default")}</button> : null}
            </span>
          </label>
        </div>
      ) : null}

      <div className="recip-widget__body">
        {peers.length === 0 ? (
          <p className="recip-empty">{t(lang, "recipients.nopeers")}</p>
        ) : (
          <ul className="recip-list">
            {ordered.map((p) => {
              const online = p.status === "open";
              const checked = online && (state.autoRoom || selected.has(p.id));
              const disabled = !online || state.autoRoom;
              return (
                <li key={p.id} className={`recip-row${online ? "" : " is-offline"}`} data-testid={`recip-${p.id}`}>
                  <Avatar name={p.name} avatar={p.avatar} size={26} />
                  <span className="recip-name">{p.name}{online ? "" : ` · ${t(lang, "recipients.offline")}`}</span>
                  <LatencyMeter rttMs={p.rttMs} open={online} />
                  <button type="button" className="recip-info" onClick={() => onPeerInfo(p.id)} aria-label={t(lang, "userstyle.info")}>
                    <Info className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    className={`recip-check ${checked ? "on" : "off"}`}
                    aria-pressed={checked}
                    disabled={disabled}
                    onClick={() => onTogglePeer(p.id)}
                    data-testid={`recip-check-${p.id}`}
                    aria-label={checked ? t(lang, "recipients.receiving") : t(lang, "recipients.excluded")}
                  >
                    {checked ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <div className="recip-room" data-testid="recip-room">
          <Radio className="h-4 w-4 opacity-80" />
          <span className="recip-name">{t(lang, "recipients.room")}{room ? ` · ${room}` : ""}</span>
          <button type="button" className="recip-info" onClick={onRoomInfo} aria-label={t(lang, "recipients.roominfo")}>
            <Info className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={`recip-check ${state.autoRoom ? "on" : "off"}`}
            aria-pressed={state.autoRoom}
            onClick={() => onToggleAuto(!state.autoRoom)}
            data-testid="recip-auto"
            aria-label={t(lang, "recipients.autoall")}
          >
            {state.autoRoom ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
          </button>
        </div>

        {!state.autoRoom ? (
          <div className="recip-actions">
            <button type="button" onClick={onSelectAll}>{t(lang, "recipients.all")}</button>
            <button type="button" onClick={onSelectNone}>{t(lang, "recipients.clear")}</button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ConfigRow({ label, min, max, step, value, onChange, suffix, percent }: {
  label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void; suffix?: string; percent?: boolean;
}) {
  return (
    <label className="recip-cfg-row">
      <span>{label}</span>
      <span className="flex items-center gap-2">
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
        <span className="recip-cfg-val">{percent ? `${Math.round(value * 100)}%` : `${value}${suffix ?? ""}`}</span>
      </span>
    </label>
  );
}
