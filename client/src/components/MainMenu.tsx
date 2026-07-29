// Main toolbar / floating menu for the chat UI.
//
// Cross-browser / cross-device requirements:
//  1. Mobile-first layout that adapts from `sm` upward. The toolbar is
//     always reachable: on small screens we expose a SpeedDial (3 bars)
//     floating panel that fills the available drop area without overflowing.
//  2. Touch targets meet WCAG 2.5.5 — every button has at least
//     44×44 CSS px on touch-capable inputs (we use `min-h-11 min-w-11`).
//  3. Keyboard accessibility:
//        - Tab cycles through entries.
//        - Enter / Space activates the focused entry.
//        - Escape closes the floating panel (SpeedDial).
//        - Arrow Up/Down move focus inside the floating panel; Home/End
//          jump to first/last.
//  4. ARIA: the SpeedDial is a `menu` role; entries are `menuitem`.
//     We honour `aria-expanded`, `aria-controls`, `aria-current` for
//     the active panel.
//  5. Backdrop / glassmorphism (`.glass-card`) is optional — we fall
//     back to a solid background via `@supports not (backdrop-filter)`.
//  6. Animations honour `prefers-reduced-motion` (handled in index.css).
//  7. RTL: we mirror icon alignment + rely on logical CSS properties.
//
// Three display modes (driven by `prefs.menuDisplay`):
//   - "inline"    — toolbar: icon + label side by side (≥ sm).
//   - "tooltip"   — toolbar: icon only, label visible as native title.
//   - "speeddial" — three horizontal bars button replaces the toolbar;
//                   click / Enter / Space opens a floating panel with
//                   the same entries vertically. Always visible on
//                   touch devices.

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PanelKey } from "../App";
import type { Lang } from "../lib/i18n";
import { t } from "../lib/i18n";

export type MenuEntry = {
  panel: PanelKey;
  testId: string;
  labelKey: string;
  Icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
};

export const MENU_ENTRIES: MenuEntry[] = [
  { panel: "templates", testId: "btn-templates", labelKey: "menu.templates", Icon: PaintBrush },
  { panel: "settings", testId: "btn-settings", labelKey: "menu.settings", Icon: Gear },
  { panel: "encryption", testId: "btn-encryption", labelKey: "menu.encryption", Icon: Key },
  { panel: "roomSecurity", testId: "btn-room-security", labelKey: "room.security.title", Icon: Shield },
  { panel: "trust", testId: "btn-trust", labelKey: "menu.trust", Icon: ShieldCheckAlt },
  { panel: "privacy", testId: "btn-privacy", labelKey: "menu.privacy", Icon: Eye },
  { panel: "notifications", testId: "btn-notifications", labelKey: "menu.notifications", Icon: Bell },
  { panel: "analytics", testId: "btn-analytics", labelKey: "menu.analytics", Icon: Activity },
  { panel: "profile", testId: "btn-profile", labelKey: "menu.profile", Icon: User },
  { panel: "peers", testId: "btn-peers", labelKey: "menu.peers", Icon: Users },
  { panel: "audio", testId: "btn-audio", labelKey: "menu.audio", Icon: Mic },
  { panel: "video", testId: "btn-video", labelKey: "menu.video", Icon: Video },
  { panel: "files", testId: "btn-files", labelKey: "menu.files", Icon: Paperclip },
  { panel: "location", testId: "btn-location", labelKey: "menu.location", Icon: MapPin },
  { panel: "nfc", testId: "btn-nfc", labelKey: "menu.nfc", Icon: Nfc },
  { panel: "speech", testId: "btn-speech", labelKey: "menu.speech", Icon: Mic },
  { panel: "connection", testId: "btn-connection", labelKey: "menu.connection", Icon: Activity },
];

export type MenuDisplayMode =
  // The four canonical values stored in `prefs.menuDisplay`:
  | "icons"
  | "text"
  | "icons-text"
  | "icons-tooltip"
  // Legacy aliases kept for graceful migration of older prefs stores:
  | "inline"        // → maps to "icons-text"
  | "tooltip"       // → maps to "icons-tooltip"
  | "speeddial";    // → keeps "speeddial" behaviour

export type MainMenuProps = {
  mode: MenuDisplayMode;
  lang: Lang;
  currentPanel?: PanelKey | null;
  onOpen: (panel: PanelKey) => void;
};

/* ---------- Reusable button containers ---------- */

const BTN_BASE =
  "group/menuitem relative inline-flex h-11 min-h-11 w-11 min-w-11 select-none " +
  "items-center justify-center gap-2 rounded-xl border border-transparent text-left " +
  "text-foreground transition-colors duration-150 hover:border-border hover:bg-accent " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 " +
  "focus-visible:ring-offset-background active:scale-[0.97]";

const BTN_INLINE =
  BTN_BASE + " sm:w-auto sm:px-3 sm:gap-2";
const BTN_ICON = BTN_BASE;
const BTN_PRIMARY = " text-primary";

/* ---------- Inline / Tooltip rendering (≥ sm) ---------- */

type ToolbarMode = "icons" | "text" | "icons-text" | "icons-tooltip";

function ToolbarEntry({
  entry,
  lang,
  onOpen,
  mode,
  isCurrent,
  isText,
  isInline,
}: {
  entry: MenuEntry;
  lang: Lang;
  onOpen: (panel: PanelKey) => void;
  mode: ToolbarMode;
  isCurrent: boolean;
  /** `text` mode: render label-only (no icon). */
  isText: boolean;
  /** `icons-text` mode: width is auto so label fits next to icon. */
  isInline: boolean;
}) {
  const { Icon } = entry;
  const label = t(lang, entry.labelKey);
  // Pick the right container class per mode. All buttons share the
  // same touch-aware sizing and focus-visible ring.
  let className: string;
  if (isText) className = BTN_BASE + " sm:w-auto sm:px-3 sm:gap-0 " + BTN_PRIMARY + " justify-start";
  else if (isInline) className = BTN_INLINE + " " + BTN_PRIMARY;
  else className = BTN_ICON + " " + BTN_PRIMARY;
  if (isCurrent) className += " bg-primary/15 text-primary";

  return (
    <button
      type="button"
      onClick={() => onOpen(entry.panel)}
      // Tooltip-style modes get a native browser title.
      title={mode === "icons-tooltip" || mode === "icons" ? label : undefined}
      aria-label={isText ? label : undefined}
      aria-current={isCurrent ? "page" : undefined}
      data-testid={entry.testId}
      data-panel={entry.panel}
      data-mode={mode}
      data-current={isCurrent ? "true" : undefined}
      className={className}
    >
      {!isText ? (
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      ) : null}
      {(isText || isInline) ? (
        <span className="hidden truncate text-xs sm:inline">{label}</span>
      ) : null}
    </button>
  );
}

/* ---------- Speed-dial (3 bars → floating panel) ---------- */

const FOCUSABLE = "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])";

function SpeedDial({
  lang, onOpen, currentPanel,
}: {
  lang: Lang;
  onOpen: (p: PanelKey) => void;
  currentPanel?: PanelKey | null;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const toggleBtnRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const menuId = useId();

  // Open / close behaviour: trap outside-click, restore focus on close.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = (document.activeElement as HTMLElement | null) ?? null;
    function onDown(event: MouseEvent | TouchEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onPointer(event: PointerEvent) {
      if (event.pointerType === "touch") {
        if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
          setOpen(false);
        }
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        toggleBtnRef.current?.focus();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "Home") {
        event.preventDefault();
        const first = listRef.current?.querySelector<HTMLElement>(FOCUSABLE);
        first?.focus();
        return;
      }
      if (event.key === "ArrowUp" || event.key === "End") {
        event.preventDefault();
        const all = listRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
        if (all && all.length) all[all.length - 1].focus();
        return;
      }
      if (event.key === "Tab") {
        // Focus trap: cycle within the menu.
        const items = listRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
        if (!items || items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
      // Restore focus to whatever opened the menu.
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  const closeMenu = useCallback(() => {
    setOpen(false);
    toggleBtnRef.current?.focus();
  }, []);

  function moveFocus(delta: number) {
    const items = listRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (!items || items.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const idx = active ? Array.prototype.indexOf.call(items, active) : 0;
    const next = (idx + delta + items.length) % items.length;
    items[next].focus();
  }

  return (
    <div className="relative shrink-0" ref={wrapperRef} data-testid="speeddial">
      <button
        ref={toggleBtnRef}
        type="button"
        data-testid="btn-menu-speeddial"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={menuId}
        title={t(lang, "menu.open")}
        aria-label={t(lang, "menu.open")}
        className={BTN_ICON + " border border-border bg-background"}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <rect x="3" y="6" width="18" height="2.5" rx="1.25" fill="currentColor" />
          <rect x="3" y="11" width="18" height="2.5" rx="1.25" fill="currentColor" />
          <rect x="3" y="16" width="18" height="2.5" rx="1.25" fill="currentColor" />
        </svg>
      </button>
      {open ? (
        <div
          role="menu"
          id={menuId}
          aria-label={t(lang, "menu.title")}
          className="menu-panel glass-card absolute right-0 top-full z-40 mt-2 flex max-h-[80dvh] w-[min(20rem,calc(100vw-2rem))] flex-col gap-0.5 overflow-hidden rounded-2xl border border-border shadow-lg"
          data-testid="speeddial-menu"
          onKeyDownCapture={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); moveFocus(+1); }
            if (e.key === "ArrowUp")   { e.preventDefault(); moveFocus(-1); }
          }}
        >
          <header className="flex items-center justify-between border-b border-border bg-card/60 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <span>{t(lang, "menu.title")}</span>
            <button
              type="button"
              onClick={closeMenu}
              aria-label={t(lang, "common.close")}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <path d="M6 6L18 18M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </header>
          <ul ref={listRef} className="flex-1 overflow-y-auto p-1" role="none">
            {MENU_ENTRIES.map((entry) => {
              const { Icon } = entry;
              const label = t(lang, entry.labelKey);
              const isCurrent = currentPanel === entry.panel;
              return (
                <li key={entry.testId} role="none">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => { onOpen(entry.panel); closeMenu(); }}
                    data-testid={`speeddial-${entry.testId}`}
                    aria-current={isCurrent ? "page" : undefined}
                    className={
                      "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm hover:bg-accent " +
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " +
                      (isCurrent ? " bg-primary/15 text-primary" : "")
                    }
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="font-medium">{label}</span>
                    {isCurrent ? <span className="ml-auto h-2 w-2 rounded-full bg-primary" aria-hidden="true" /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/* ---------- Root component ---------- */

export function MainMenu({ mode, lang, onOpen, currentPanel = null }: MainMenuProps) {
  // Resolve the "best" presentation per viewport. We force `speeddial`
  // on touch-primary / narrow viewports regardless of user pref because
  // 14 inline icons do not fit a 360 px phone.
  const [isTouch, setIsTouch] = useState(false);
  const [isNarrow, setIsNarrow] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const coarseQ = window.matchMedia?.("(pointer: coarse)");
    const narrowQ = window.matchMedia?.("(max-width: 640px)");
    const update = () => {
      setIsTouch(coarseQ?.matches ?? false);
      setIsNarrow(narrowQ?.matches ?? false);
    };
    update();
    coarseQ?.addEventListener?.("change", update);
    narrowQ?.addEventListener?.("change", update);
    return () => {
      coarseQ?.removeEventListener?.("change", update);
      narrowQ?.removeEventListener?.("change", update);
    };
  }, []);

  // Map legacy aliases to the canonical four. This keeps existing
  // localStorage payloads from older versions readable.
  const canonicalMode = useMemo<"icons" | "text" | "icons-text" | "icons-tooltip" | "speeddial">(() => {
    switch (mode) {
      case "inline": return "icons-text";
      case "tooltip": return "icons-tooltip";
      case "speeddial": return "speeddial";
      case "icons":
      case "text":
      case "icons-text":
      case "icons-tooltip":
        return mode;
      default: return "icons";
    }
  }, [mode]);

  // The "speeddial" mode is special — it always renders the 3-bars
  // floating panel regardless of viewport. On touch-primary / narrow
  // viewports we promote other modes to `speeddial` as well so the
  // toolbar fits inside a 360 px phone screen.
  const effectiveMode = useMemo(() => {
    if (canonicalMode === "speeddial") return "speeddial" as const;
    if (isTouch || isNarrow) return "speeddial" as const;
    return canonicalMode;
  }, [canonicalMode, isTouch, isNarrow]);

  if (effectiveMode === "speeddial") {
    return <SpeedDial lang={lang} onOpen={onOpen} currentPanel={currentPanel} />;
  }

  // Map remaining canonical modes onto the (icon / icon+text) row widget.
  // `text` collapses to a label-only row; `icons` is icon-only;
  // `icons-text` shows both; `icons-tooltip` shows icon + native title.
  const isText = effectiveMode === "text";
  const isIconOnly = effectiveMode === "icons";
  const isIconWithTooltip = effectiveMode === "icons-tooltip";
  const isInline = effectiveMode === "icons-text";
  return (
    <nav
      aria-label={t(lang, "menu.title")}
      className="ml-auto flex flex-wrap items-center gap-1"
      data-testid="main-nav"
      role="menubar"
    >
      {MENU_ENTRIES.map((entry) => (
        <ToolbarEntry
          key={entry.testId}
          entry={entry}
          lang={lang}
          onOpen={onOpen}
          mode={effectiveMode}
          isCurrent={currentPanel === entry.panel}
          isText={effectiveMode === "text"}
          isInline={isInline}
        />
      ))}
    </nav>
  );
}

/* ---------- Hand-rolled SVG icons ----------
 * We hand-roll thin SVG icons (instead of pulling `lucide-react`) so that
 * the toolbar bundle stays small. Every icon has `currentColor` strokes
 * and respects `prefers-reduced-motion`.
 */

function PaintBrush({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="13.5" cy="6.5" r="1.4" />
      <circle cx="17.5" cy="10.5" r="1.4" />
      <circle cx="6.5" cy="12.5" r="1.4" />
      <circle cx="8.5" cy="7.5" r="1.4" />
      <path d="M12 22a10 10 0 1 1 10-10c0 2-1.5 3-3 3h-2c-1.5 0-3 1-3 2.5S15 22 12 22z" />
    </svg>
  );
}
function Gear({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1A2 2 0 1 1 4.3 17l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1A2 2 0 1 1 7 4.3l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}
function Key({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="m21 2-9.6 9.6" />
      <path d="m15.5 7.5 3 3L22 7l-3-3" />
    </svg>
  );
}
function Shield({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}
function ShieldCheckAlt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}
function Eye({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function Bell({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}
function Activity({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}
function User({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}
function Users({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
function Mic({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}
function Video({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="3" y="6" width="13" height="12" rx="2" />
      <path d="M16 10l5-3v10l-5-3z" />
    </svg>
  );
}
function Paperclip({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="m21.44 11.05-9.19 9.19a6 6 0 1 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}
function MapPin({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 22s7-7.16 7-12a7 7 0 1 0-14 0c0 4.84 7 12 7 12z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}
function Nfc({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M4 8a8 8 0 0 1 16 0v8a8 8 0 0 1-16 0z" />
      <path d="M8 12a4 4 0 0 1 8 0" />
      <circle cx="12" cy="12" r="1.2" />
    </svg>
  );
}
