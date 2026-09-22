// The round avatar / monogram shown beside a participant's name, and the small
// functional menu that opens when it (or the name) is clicked:
//
//   • Info    → opens a modal with what we know about the participant
//   • Font    → text colour / family / size for THIS user's bubbles
//   • Bckg    → bubble background colour + opacity
//   • Border  → bubble border colour + style (solid / dashed / dotted / …)
//
// Colours are plain hex, applied locally and stored per user. Avatars are a
// monogram or a short emoji — never a remote URL (CSP blocks those and a
// peer-supplied URL must not trigger a request).

import { useEffect, useRef, useState } from "react";
import { Info, KeyRound, PaintBucket, SquareDashed, RotateCcw } from "lucide-react";
import { t, type Lang } from "../lib/i18n";
import { FONT_FAMILIES } from "../lib/themes";
import { BORDER_STYLES, type BorderStyleId, type PerUserStyle } from "../lib/message-styles";

/** A single "block letter" monogram, or a 1–2 char emoji avatar if set. */
export function avatarGlyphFor(name: string, avatar?: string): string {
  const a = (avatar || "").trim();
  if (a && !/[/:.]/.test(a) && Array.from(a).length <= 2) return a;
  const initial = Array.from((name || "").trim())[0];
  return initial ? initial.toUpperCase() : "?";
}

/** Deterministic hue from the name, so avatars are recognisable at a glance. */
function hueFor(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) % 360;
  return h;
}

const SWATCHES = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#3b82f6", "#8b5cf6", "#ec4899", "#64748b", "#0f172a", "#f8fafc"];

type Tab = "info" | "font" | "bckg" | "border";

export function Avatar({ name, avatar, size = 32, className = "" }: { name: string; avatar?: string; size?: number; className?: string }) {
  const glyph = avatarGlyphFor(name, avatar);
  const hue = hueFor((name || "?").toLowerCase());
  return (
    <span
      className={`user-avatar ${className}`}
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        background: `hsl(${hue} 62% 42% / 0.22)`,
        color: `hsl(${hue} 70% 42%)`,
        fontSize: Math.round(size * 0.42),
      }}
    >
      {glyph}
    </span>
  );
}

export function UserBadge({
  name, senderId, avatar, mine, style, onChangeStyle, onResetStyle, onInfo, lang,
}: {
  name: string;
  senderId: string;
  avatar?: string;
  mine: boolean;
  style: PerUserStyle | undefined;
  onChangeStyle: (patch: PerUserStyle) => void;
  onResetStyle: () => void;
  onInfo: () => void;
  lang: Lang;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("info");
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  function toggle() {
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) {
      const width = 248;
      const left = Math.max(8, Math.min(window.innerWidth - width - 8, mine ? rect.right - width : rect.left));
      setPos({ top: rect.bottom + 6, left });
    }
    setTab("info");
    setOpen((v) => !v);
  }

  const s = style ?? {};
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        className="user-badge"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={`user-badge-${senderId}`}
        title={t(lang, "userstyle.open")}
      >
        <Avatar name={name} avatar={avatar} size={24} />
        <span className="user-badge__name">{name}</span>
      </button>

      {open && pos ? (
        <>
          <div className="user-pop__backdrop" onMouseDown={() => setOpen(false)} />
          <div
            className="user-pop"
            role="menu"
            style={{ top: pos.top, left: pos.left }}
            onMouseDown={(e) => e.stopPropagation()}
            data-testid={`user-pop-${senderId}`}
          >
            <div className="user-pop__tabs">
              <TabBtn active={tab === "info"} onClick={() => setTab("info")} label={t(lang, "userstyle.info")} Icon={Info} />
              <TabBtn active={tab === "font"} onClick={() => setTab("font")} label={t(lang, "userstyle.font")} Icon={KeyRound} />
              <TabBtn active={tab === "bckg"} onClick={() => setTab("bckg")} label={t(lang, "userstyle.bckg")} Icon={PaintBucket} />
              <TabBtn active={tab === "border"} onClick={() => setTab("border")} label={t(lang, "userstyle.border")} Icon={SquareDashed} />
            </div>

            <div className="user-pop__body">
              {tab === "info" ? (
                <button type="button" className="user-pop__action" onClick={() => { onInfo(); setOpen(false); }} data-testid={`user-info-${senderId}`}>
                  <Info className="h-4 w-4" /> {t(lang, "userstyle.info.open")}
                </button>
              ) : null}

              {tab === "font" ? (
                <div className="space-y-2">
                  <ColorRow label={t(lang, "userstyle.font.color")} value={s.fontColor} onChange={(v) => onChangeStyle({ fontColor: v })} />
                  <label className="user-pop__label">{t(lang, "common.font")}
                    <select className="user-pop__select" value={s.fontFamily ?? ""} onChange={(e) => onChangeStyle({ fontFamily: e.target.value || undefined })}>
                      <option value="">{t(lang, "userstyle.default")}</option>
                      {FONT_FAMILIES.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                    </select>
                  </label>
                  <RangeRow label={t(lang, "common.size")} min={0.8} max={1.4} step={0.05} value={s.fontScale ?? 1} onChange={(v) => onChangeStyle({ fontScale: v })} suffix="×" />
                </div>
              ) : null}

              {tab === "bckg" ? (
                <div className="space-y-2">
                  <ColorRow label={t(lang, "userstyle.bckg.color")} value={s.bubbleColor} onChange={(v) => onChangeStyle({ bubbleColor: v })} />
                  <RangeRow label={t(lang, "userstyle.opacity")} min={0} max={1} step={0.05} value={s.bubbleOpacity ?? 1} onChange={(v) => onChangeStyle({ bubbleOpacity: v })} suffix="" percent />
                </div>
              ) : null}

              {tab === "border" ? (
                <div className="space-y-2">
                  <ColorRow label={t(lang, "userstyle.border.color")} value={s.borderColor} onChange={(v) => onChangeStyle({ borderColor: v })} />
                  <label className="user-pop__label">{t(lang, "userstyle.border.type")}
                    <select className="user-pop__select" value={s.borderStyle ?? "solid"} onChange={(e) => onChangeStyle({ borderStyle: e.target.value as BorderStyleId })}>
                      {BORDER_STYLES.map((b) => <option key={b} value={b}>{t(lang, `userstyle.border.${b}`)}</option>)}
                    </select>
                  </label>
                </div>
              ) : null}
            </div>

            <button type="button" className="user-pop__reset" onClick={() => { onResetStyle(); setOpen(false); }}>
              <RotateCcw className="h-3.5 w-3.5" /> {t(lang, "userstyle.reset")}
            </button>
          </div>
        </>
      ) : null}
    </>
  );
}

function TabBtn({ active, onClick, label, Icon }: { active: boolean; onClick: () => void; label: string; Icon: typeof Info }) {
  return (
    <button type="button" role="tab" aria-selected={active} onClick={onClick} className={`user-pop__tab ${active ? "is-active" : ""}`} title={label}>
      <Icon className="h-4 w-4" />
      <span>{label}</span>
    </button>
  );
}

function ColorRow({ label, value, onChange }: { label: string; value?: string; onChange: (v: string) => void }) {
  return (
    <div>
      <div className="user-pop__label">{label}</div>
      <div className="user-pop__swatches">
        {SWATCHES.map((c) => (
          <button key={c} type="button" aria-label={c} aria-pressed={value === c} className="user-pop__swatch" style={{ background: c }} onClick={() => onChange(c)} />
        ))}
        <input type="color" className="user-pop__color" value={value && /^#/.test(value) ? value : "#3b82f6"} onChange={(e) => onChange(e.target.value)} aria-label={label} />
      </div>
    </div>
  );
}

function RangeRow({ label, min, max, step, value, onChange, suffix, percent }: {
  label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void; suffix: string; percent?: boolean;
}) {
  return (
    <label className="user-pop__label">
      <span className="flex justify-between"><span>{label}</span><span>{percent ? `${Math.round(value * 100)} %` : `${value.toFixed(2)}${suffix}`}</span></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="user-pop__range" />
    </label>
  );
}
