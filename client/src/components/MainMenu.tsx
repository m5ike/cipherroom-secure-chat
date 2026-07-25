// Main toolbar / floating menu for the chat UI.
//
// Three display modes (driven by `prefs.menuDisplay`):
//   - "inline"    — original toolbar: icon + label side by side, sm:inline label
//   - "tooltip"   — icon only, label visible via native title attribute (no inline label)
//   - "speeddial" — three horizontal bars button replaces the toolbar;
//                   click opens a floating panel with menu entries as
//                   rows (icon + label + handler).
//
// All three modes emit the same `onOpen(panel)` callback to the parent;
// accessibility is preserved in every variant through standard
// aria-* attributes.

import { useEffect, useRef, useState } from "react";
import { Menu as MenuIcon } from "lucide-react";
import type { PanelKey } from "../App";
import type { Lang } from "../lib/i18n";
import { t } from "../lib/i18n";

export type MenuEntry = {
  panel: PanelKey;
  testId: string;
  labelKey: string;
  /** LucideIcon component class */
  Icon: React.ComponentType<{ className?: string }>;
};

/**
 * Single source-of-truth list of menu entries; the rendering mode
 * only changes presentation, not navigation.
 */
export const MENU_ENTRIES: MenuEntry[] = [
  { panel: "templates", testId: "btn-templates", labelKey: "menu.templates", Icon: (p: { className?: string }) => <PaintBrush {...p} /> },
  { panel: "settings", testId: "btn-settings", labelKey: "menu.settings", Icon: (p: { className?: string }) => <Gear {...p} /> },
  { panel: "encryption", testId: "btn-encryption", labelKey: "menu.encryption", Icon: (p: { className?: string }) => <KeyIcon {...p} /> },
  { panel: "roomSecurity", testId: "btn-room-security", labelKey: "room.security.title", Icon: (p: { className?: string }) => <Shield {...p} /> },
  { panel: "trust", testId: "btn-trust", labelKey: "menu.trust", Icon: (p: { className?: string }) => <Shield {...p} /> },
  { panel: "privacy", testId: "btn-privacy", labelKey: "menu.privacy", Icon: (p: { className?: string }) => <EyeIcon {...p} /> },
  { panel: "notifications", testId: "btn-notifications", labelKey: "menu.notifications", Icon: (p: { className?: string }) => <Bell {...p} /> },
  { panel: "analytics", testId: "btn-analytics", labelKey: "menu.analytics", Icon: (p: { className?: string }) => <ActivityIcon {...p} /> },
  { panel: "profile", testId: "btn-profile", labelKey: "menu.profile", Icon: (p: { className?: string }) => <UserIcon {...p} /> },
  { panel: "peers", testId: "btn-peers", labelKey: "menu.peers", Icon: (p: { className?: string }) => <UsersIcon {...p} /> },
  { panel: "audio", testId: "btn-audio", labelKey: "menu.audio", Icon: (p: { className?: string }) => <MicIcon {...p} /> },
  { panel: "video", testId: "btn-video", labelKey: "menu.video", Icon: (p: { className?: string }) => <VideoIcon {...p} /> },
  { panel: "files", testId: "btn-files", labelKey: "menu.files", Icon: (p: { className?: string }) => <PaperclipIcon {...p} /> },
  { panel: "location", testId: "btn-location", labelKey: "menu.location", Icon: (p: { className?: string }) => <PinIcon {...p} /> },
  { panel: "nfc", testId: "btn-nfc", labelKey: "menu.nfc", Icon: (p: { className?: string }) => <NfcIcon {...p} /> },
  { panel: "speech", testId: "btn-speech", labelKey: "menu.speech", Icon: (p: { className?: string }) => <MicIcon {...p} /> },
  { panel: "connection", testId: "btn-connection", labelKey: "menu.connection", Icon: (p: { className?: string }) => <ActivityIcon {...p} /> },
];

export type MainMenuProps = {
  mode: "inline" | "tooltip" | "speeddial";
  lang: Lang;
  onOpen: (panel: PanelKey) => void;
};

/* ---------- Inline / Tooltip rendering ---------- */

function InlineRow({
  entry, lang, onOpen, mode,
}: {
  entry: MenuEntry;
  lang: Lang;
  onOpen: (p: PanelKey) => void;
  mode: "inline" | "tooltip";
}) {
  const { Icon } = entry;
  const label = t(lang, entry.labelKey);
  return (
    <button
      type="button"
      onClick={() => onOpen(entry.panel)}
      title={label}
      aria-label={label}
      data-testid={entry.testId}
      className={mode === "inline"
        ? "inline-flex h-9 items-center justify-center gap-2 rounded-xl border border-transparent px-3 text-foreground hover:border-border hover:bg-accent"
        : "inline-flex h-9 w-9 items-center justify-center rounded-xl border border-transparent text-foreground hover:border-border hover:bg-accent"
      }
    >
      <Icon className="h-4 w-4" />
      {mode === "inline" ? <span className="hidden text-xs sm:inline">{label}</span> : null}
    </button>
  );
}

/* ---------- Speed-dial (three bars → floating panel) ---------- */

function SpeedDial({
  lang, onOpen,
}: {
  lang: Lang;
  onOpen: (p: PanelKey) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent | TouchEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        type="button"
        data-testid="btn-menu-speeddial"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={t(lang, "menu.open")}
        aria-label={t(lang, "menu.open")}
        className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-background text-foreground hover:bg-accent"
      >
        {/* Three horizontal bars stacked vertically */}
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <rect x="4" y="6" width="16" height="2" rx="1" fill="currentColor" />
          <rect x="4" y="11" width="16" height="2" rx="1" fill="currentColor" />
          <rect x="4" y="16" width="16" height="2" rx="1" fill="currentColor" />
        </svg>
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={t(lang, "menu.title")}
          className="glass-card absolute right-0 top-11 z-40 flex max-h-[80dvh] w-72 flex-col gap-0.5 overflow-hidden rounded-2xl border border-border shadow-lg"
          data-testid="speeddial-menu"
        >
          <header className="border-b border-border bg-card/60 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t(lang, "menu.title")}
          </header>
          <ul className="flex-1 overflow-y-auto p-1">
            {MENU_ENTRIES.map((entry) => {
              const { Icon } = entry;
              const label = t(lang, entry.labelKey);
              return (
                <li key={entry.testId}>
                  <button
                    type="button"
                    onClick={() => { onOpen(entry.panel); setOpen(false); }}
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm hover:bg-accent"
                    data-testid={`speeddial-${entry.testId}`}
                  >
                    <Icon className="h-4 w-4 shrink-0 text-primary" />
                    <span className="font-medium">{label}</span>
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

export function MainMenu({ mode, lang, onOpen }: MainMenuProps) {
  if (mode === "speeddial") {
    return <SpeedDial lang={lang} onOpen={onOpen} />;
  }
  const displayMode = mode === "tooltip" ? "tooltip" : "inline";
  return (
    <div className="ml-auto hidden flex-wrap items-center gap-1 sm:flex">
      {MENU_ENTRIES.map((entry) => (
        <InlineRow key={entry.testId} entry={entry} lang={lang} onOpen={onOpen} mode={displayMode} />
      ))}
    </div>
  );
}

/* ---------- Local inline icon components (use lucide-react via dynamic
    imports to avoid loading all icons in the speed-dial bundle). ---------- */

function PaintBrush(p: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={p.className}>
      <circle cx="13.5" cy="6.5" r="1.5" />
      <circle cx="17.5" cy="10.5" r="1.5" />
      <circle cx="6.5" cy="12.5" r="1.5" />
      <circle cx="8.5" cy="7.5" r="1.5" />
      <path d="M12 22a10 10 0 1 1 10-10c0 2-1.5 3-3 3h-2c-1.5 0-3 1-3 2.5S15 22 12 22z" />
    </svg>
  );
}
function Gear(p: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={p.className}>
      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
      <path d="M19.4 15a1.65 1.65 0 1 0 0-1.65l-.18-.18a2 2 0 1 1-2.83-2.83l.18-.18a1.65 1.65 0 1 0-1.65-1.65h-.27a2 2 0 1 1-3.74-2.6l-.06-.13A2 2 0 0 0 4 7.5l.06.13a2 2 0 1 1-3.74 2.6H0a1.65 1.65 0 0 0-1.65 1.65l.18.18a2 2 0 1 1-2.83 2.83L-7 19.4a1.65 1.65 0 0 0 0 1.65l.18.18a2 2 0 1 1 2.83 2.83l-.18.18a1.65 1.65 0 0 0 1.65 1.65h.27a2 2 0 0 1 3.74 2.6l.06.13a2 2 0 0 0 3.74 0l-.06-.13a2 2 0 0 1 3.74-2.6h.27a1.65 1.65 0 0 0 1.65-1.65z" />
    </svg>
  );
}
function KeyIcon(p: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={p.className}>
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="m21 2-9.6 9.6" />
      <path d="m15.5 7.5 3 3L22 7l-3-3" />
    </svg>
  );
}
function Shield(p: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={p.className}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}
function EyeIcon(p: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={p.className}>
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function Bell(p: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={p.className}>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}
function ActivityIcon(p: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={p.className}>
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}
function UserIcon(p: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={p.className}>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}
function UsersIcon(p: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={p.className}>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
function MicIcon(p: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={p.className}>
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}
function VideoIcon(p: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={p.className}>
      <rect x="3" y="6" width="13" height="12" rx="2" />
      <path d="M16 10l5-3v10l-5-3z" />
    </svg>
  );
}
function PaperclipIcon(p: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={p.className}>
      <path d="m21.44 11.05-9.19 9.19a6 6 0 1 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}
function PinIcon(p: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={p.className}>
      <path d="M12 22s7-7.16 7-12a7 7 0 1 0-14 0c0 4.84 7 12 7 12z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}
function NfcIcon(p: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={p.className}>
      <path d="M4 8a8 8 0 0 1 16 0v8a8 8 0 0 1-16 0z" />
      <path d="M8 12a4 4 0 0 1 8 0" />
      <circle cx="12" cy="12" r="1" />
    </svg>
  );
}

// We re-export MenuIcon but rename to "SpeedDialBars"; the body of
// MainMenu uses the hand-rolled SVG instead.
export const SpeedDialBars = MenuIcon;
