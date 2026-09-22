// Floating "who receives my messages" widget. It can be dragged anywhere,
// minimised to a single button, and remembers its place (Preferences.widget,
// which syncs to the server in Server-enhanced mode). Each connected peer has:
//   • an avatar circle + name
//   • a graphical latency meter
//   • an info button (opens the same modal as the bubble avatar)
//   • a recipient checkbox (green check = receives, red cross = excluded)
// A final Room row toggles "send to everyone automatically". When it is off,
// at least one peer must be checked. The composer shows, unmistakably, whether
// the next message goes to everyone or privately to a subset.

import { useEffect, useRef, useState } from "react";
import { Users, Info, Check, X, Radio, Minus, GripHorizontal } from "lucide-react";
import { t, type Lang } from "../lib/i18n";
import { Avatar } from "./UserBadge";
import type { WidgetState } from "../lib/preferences";

export type WidgetPeer = { id: string; name: string; status: "connecting" | "open" | "closed"; rttMs?: number; avatar?: string };

function LatencyMeter({ rttMs, open }: { rttMs?: number; open: boolean }) {
  // 4 bars; green < 80 ms, amber < 200 ms, red otherwise.
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
  peers, room, state, selected, onTogglePeer, onToggleAuto, onSelectAll, onSelectNone, onPeerInfo, onRoomInfo, onMove, onMinimize, lang,
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
  lang: Lang;
}) {
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const anchored = state.x === 0 && state.y === 0;

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
    const host = (e.currentTarget as HTMLElement).closest(".recip-widget") as HTMLElement | null;
    const rect = host?.getBoundingClientRect();
    if (rect) {
      dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
      if (anchored) onMove(rect.left, rect.top); // switch from anchored to absolute at grab point
    }
    setDragging(true);
  }

  const posStyle: React.CSSProperties = anchored ? { right: 12, bottom: 88 } : { left: state.x, top: state.y };
  const openPeers = peers.filter((p) => p.status === "open");

  if (state.minimized) {
    return (
      <button type="button" className="recip-fab" style={posStyle} onClick={() => onMinimize(false)} data-testid="recip-fab" title={t(lang, "recipients.title")}>
        <Users className="h-5 w-5" />
        <span className="recip-fab__count">{openPeers.length}</span>
      </button>
    );
  }

  return (
    <div className="recip-widget" style={posStyle} data-testid="recip-widget" role="group" aria-label={t(lang, "recipients.title")}>
      <div className="recip-widget__head" onPointerDown={startDrag} data-testid="recip-drag">
        <GripHorizontal className="h-4 w-4 opacity-60" />
        <span className="recip-widget__title">{t(lang, "recipients.title")}</span>
        <button type="button" className="recip-widget__min" onClick={() => onMinimize(true)} aria-label={t(lang, "recipients.minimize")}>
          <Minus className="h-4 w-4" />
        </button>
      </div>

      <div className="recip-widget__body">
        {peers.length === 0 ? (
          <p className="recip-empty">{t(lang, "recipients.nopeers")}</p>
        ) : (
          <ul className="recip-list">
            {peers.map((p) => {
              const checked = state.autoRoom || selected.has(p.id);
              const disabled = state.autoRoom || p.status !== "open";
              return (
                <li key={p.id} className="recip-row" data-testid={`recip-${p.id}`}>
                  <Avatar name={p.name} avatar={p.avatar} size={26} />
                  <span className="recip-name">{p.name}</span>
                  <LatencyMeter rttMs={p.rttMs} open={p.status === "open"} />
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
