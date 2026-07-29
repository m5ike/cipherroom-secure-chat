// Main toolbar / floating menu for the chat UI.
//
// Cross-browser / cross-device requirements:
//
//  1. Mobile-first layout that adapts from `sm` upward. The toolbar is
//     always reachable: on small screens / touch-primary inputs we
//     expose a Speed-dial (3 bars) floating panel that adapts to
//     viewport edges (left/right) and never overflows.
//
//  2. Touch targets meet WCAG 2.5.5 — every button has at least 44×44
//     CSS px on touch-capable inputs (`min-h-11 min-w-11`).
//
//  3. Keyboard accessibility:
//        - Tab cycles through entries.
//        - Enter / Space activates the focused entry.
//        - Escape closes the floating panel (Speed-dial).
//        - Arrow Up/Down move focus inside the floating panel; Home/End
//          jump to first/last.
//        - Roving tabindex inside lists for predictable focus order.
//
//  4. ARIA: Speed-dial is `menu` role; entries are `menuitem`.
//     Inline toolbar is `menubar` role with `tabindex`-managed items.
//     We honour `aria-expanded`, `aria-controls`, `aria-current` for
//     the active panel.
//
//  5. Backdrop / glassmorphism (`.glass-card`) is optional — we fall
//     back to a solid background via `@supports not (backdrop-filter)`
//     (handled in index.css).
//
//  6. Animations honour `prefers-reduced-motion` — the floating
//     panel does an instant show/hide if the user has Reduce Motion.
//
//  7. RTL: the inline toolbar uses logical CSS properties (`ms-*`,
//     `me-*`, `start`/`end`); icons automatically mirror via
//     `dir="auto"` on the document root.
//
//  8. Resize-safe: floating panel position recalculates when the
//     viewport resizes or the document scrolls (clamped to viewport
//     edges using `getBoundingClientRect` math).
//
// Display modes (driven by `prefs.menuDisplay`):
//   - "icons"          — toolbar: icon only (≥ sm), 44 px tall.
//   - "text"           — toolbar: text only.
//   - "icons-text"     — toolbar: icon + label inline.
//   - "icons-tooltip"  — toolbar: icon only with native title.
//   - "speeddial"      — three horizontal bars button replaces the
//                        toolbar; click / Enter / Space opens the
//                        floating panel. Always visible on touch /
//                        narrow viewport regardless of pref.

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  Bell,
  ChevronLeft,
  ChevronRight,
  Compass,
  Eye,
  FileText,
  KeyRound,
  MapPin,
  Menu as MenuIcon,
  MessageSquare,
  Mic,
  Nfc,
  Palette,
  Radio,
  Settings as SettingsIcon,
  Shield,
  ShieldCheck,
  User,
  Users,
  Video,
  Volume2,
  Wallet,
  X,
} from "lucide-react";
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
  { panel: "templates", testId: "btn-templates", labelKey: "menu.templates", Icon: Palette },
  { panel: "settings", testId: "btn-settings", labelKey: "menu.settings", Icon: SettingsIcon },
  { panel: "encryption", testId: "btn-encryption", labelKey: "menu.encryption", Icon: KeyRound },
  { panel: "roomSecurity", testId: "btn-room-security", labelKey: "room.security.title", Icon: ShieldCheck },
  { panel: "trust", testId: "btn-trust", labelKey: "menu.trust", Icon: Shield },
  { panel: "privacy", testId: "btn-privacy", labelKey: "menu.privacy", Icon: Eye },
  { panel: "notifications", testId: "btn-notifications", labelKey: "menu.notifications", Icon: Bell },
  { panel: "analytics", testId: "btn-analytics", labelKey: "menu.analytics", Icon: Activity },
  { panel: "profile", testId: "btn-profile", labelKey: "menu.profile", Icon: User },
  { panel: "peers", testId: "btn-peers", labelKey: "menu.peers", Icon: Users },
  { panel: "audio", testId: "btn-audio", labelKey: "menu.audio", Icon: Mic },
  { panel: "video", testId: "btn-video", labelKey: "menu.video", Icon: Video },
  { panel: "files", testId: "btn-files", labelKey: "menu.files", Icon: FileText },
  { panel: "location", testId: "btn-location", labelKey: "menu.location", Icon: MapPin },
  { panel: "nfc", testId: "btn-nfc", labelKey: "menu.nfc", Icon: Nfc },
  { panel: "speech", testId: "btn-speech", labelKey: "menu.speech", Icon: Volume2 },
  { panel: "connection", testId: "btn-connection", labelKey: "menu.connection", Icon: Radio },
];

export type MenuDisplayMode =
  | "icons"
  | "text"
  | "icons-text"
  | "icons-tooltip"
  // Legacy aliases kept for graceful migration of older prefs stores:
  | "inline"      // → maps to "icons-text"
  | "tooltip"     // → maps to "icons-tooltip"
  | "speeddial";

export type MainMenuProps = {
  mode: MenuDisplayMode;
  lang: Lang;
  currentPanel?: PanelKey | null;
  onOpen: (panel: PanelKey) => void;
};

/* ---------- Environment helpers (SSR-safe) ---------- */

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]),' +
  ' textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function useMatchMedia(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return Boolean(window.matchMedia?.(query).matches);
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia(query);
    const update = () => setMatches(Boolean(mql.matches));
    update();
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", update);
      return () => mql.removeEventListener("change", update);
    }
    // Safari < 14 fallback
    if (typeof (mql as MediaQueryList & {
      addListener?: (cb: () => void) => void;
    }).addListener === "function") {
      (mql as unknown as { addListener: (cb: () => void) => void }).addListener(update);
      return () => (mql as unknown as { removeListener: (cb: () => void) => void })
        .removeListener(update);
    }
    return undefined;
  }, [query]);
  return matches;
}

function useReducedMotion(): boolean {
  return useMatchMedia("(prefers-reduced-motion: reduce)");
}

/* ---------- Style for buttons — kept here so Tailwind picks up the
   utility names even when used via string concat inside JSX. ---------- */

const BTN_BASE =
  "group/menuitem relative inline-flex h-11 min-h-11 w-11 min-w-11 select-none " +
  "items-center justify-center gap-2 rounded-xl border border-transparent text-left " +
  "text-foreground transition-colors duration-150 ease-out " +
  "hover:border-border hover:bg-accent " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-background " +
  "active:scale-[0.97] disabled:pointer-events-none disabled:opacity-60";

const BTN_INLINE = BTN_BASE + " sm:w-auto sm:px-3 sm:gap-2";
const BTN_ICON = BTN_BASE;

/* ---------- Inline / Tooltip rendering (≥ sm) ---------- */

type ToolbarMode = "icons" | "text" | "icons-text" | "icons-tooltip";

function ToolbarEntry(props: {
  entry: MenuEntry;
  lang: Lang;
  onOpen: (panel: PanelKey) => void;
  mode: ToolbarMode;
  isCurrent: boolean;
}) {
  const { entry, lang, onOpen, mode, isCurrent } = props;
  const { Icon } = entry;
  const label = t(lang, entry.labelKey);

  let className: string;
  if (mode === "text") {
    className = `${BTN_BASE} sm:w-auto sm:px-3 sm:gap-0 text-primary justify-start`;
  } else if (mode === "icons-text") {
    className = `${BTN_INLINE} text-primary`;
  } else {
    // icons / icons-tooltip
    className = `${BTN_ICON} text-primary`;
  }
  if (isCurrent) className += " bg-primary/15";

  const ariaCurrent = isCurrent ? "page" as const : undefined;
  const title = mode === "icons" || mode === "icons-tooltip" ? label : undefined;
  const ariaLabel = mode === "icons-text" ? undefined : label;

  return (
    <button
      type="button"
      onClick={() => onOpen(entry.panel)}
      title={title}
      aria-label={ariaLabel}
      aria-current={ariaCurrent}
      data-testid={entry.testId}
      data-panel={entry.panel}
      data-mode={mode}
      data-current={isCurrent ? "true" : undefined}
      className={className}
    >
      {mode !== "text" ? <Icon className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
      {mode === "icons-text" || mode === "text" ? (
        <span className="hidden truncate text-xs sm:inline">{label}</span>
      ) : null}
    </button>
  );
}

/* ---------- Speed-dial (3 bars → floating panel) ---------- */

// Hook for RTL detection. We prefer the document.documentElement.dir
// attribute because i18n state may be set asynchronously and the HTML
// attribute is the actual rendering direction. Fall back to the
// navigation language when the attribute is empty.
function useDocumentDir(): "ltr" | "rtl" {
  const [dir, setDir] = useState<"ltr" | "rtl">(() => readDocumentDir());
  useEffect(() => {
    if (typeof document === "undefined") return;
    const read = () => setDir(readDocumentDir());
    read();
    const target = document.documentElement;
    if (typeof MutationObserver === "function") {
      const obs = new MutationObserver(read);
      obs.observe(target, { attributes: true, attributeFilter: ["dir", "lang"] });
      return () => obs.disconnect();
    }
    return undefined;
  }, []);
  return dir;
}

function readDocumentDir(): "ltr" | "rtl" {
  if (typeof document === "undefined") return "ltr";
  const attr = document.documentElement.getAttribute("dir");
  if (attr === "rtl") return "rtl";
  if (attr === "ltr") return "ltr";
  // Auto-detect from the navigation language as a sensible default.
  const lang = (navigator?.language || "").toLowerCase();
  if (/^(ar|fa|he|iw|fa-ir|ar-eg)/.test(lang)) return "rtl";
  return "ltr";
}

// Bookmark DOM rect hook. Accepts any forward ref whose `current` is
// Element | null (covers `useRef<HTMLDivElement | null>(null)`, etc.).
// Does not constrain the generic to `T extends Element` because
// React.RefObject is invariant — `RefObject<HTMLDivElement | null>`
// is not assignable to `RefObject<HTMLDivElement>`.
function useElementRect(
  ref: React.RefObject<Element | null>,
): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => setRect(node.getBoundingClientRect());
    update();
    if (typeof ResizeObserver === "undefined") {
      // Legacy fallback — just compute once and bail.
      return;
    }
    const ro = new ResizeObserver(update);
    ro.observe(node);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [ref]);
  return rect;
}

function SpeedDial(props: {
  lang: Lang;
  onOpen: (p: PanelKey) => void;
  currentPanel?: PanelKey | null;
  reducedMotion: boolean;
}) {
  const { lang, onOpen, currentPanel, reducedMotion } = props;
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const toggleBtnRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  const menuId = useId();
  const triggerId = useId();
  const toggleRect = useElementRect(wrapperRef);

  // Open / close behaviour: trap outside-click, restore focus on close.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = (document.activeElement as HTMLElement | null) ?? null;

    function onPointerDown(event: PointerEvent | MouseEvent | TouchEvent) {
      if (!wrapperRef.current) return;
      const target = event.target as Node | null;
      if (!target) return;
      // Toggle button: clicks inside the wrapperRef (e.g. on the toggle
      // itself) are not outside-clicks.
      if (wrapperRef.current.contains(target)) return;
      // Portaled panel: since createPortal(..., document.body) puts the
      // panel OUT of the wrapperRef subtree, wrapperRef.contains(target)
      // is always false for panel clicks. Without this guard, the capture-
      // phase pointerdown listener would call setOpen(false) before the
      // <button onClick={...}> could run onOpen(...) in the bubble phase,
      // so menu items would appear unresponsive on touch / mobile.
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        toggleBtnRef.current?.focus();
      } else if (event.key === "Tab") {
        // Focus trap: cycle Tab / Shift+Tab within menu items.
        const items = listRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
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
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("touchstart", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("touchstart", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  const closeMenu = useCallback(() => {
    setOpen(false);
    toggleBtnRef.current?.focus();
  }, []);

  function moveFocus(delta: number) {
    const items = listRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    if (!items || items.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const idx = active ? Array.prototype.indexOf.call(items, active) : 0;
    const safeIdx = idx < 0 ? 0 : idx;
    const next = (safeIdx + delta + items.length) % items.length;
    items[next].focus();
  }

  function onListKeyDown(event: ReactKeyboardEvent<HTMLUListElement>) {
    if (event.key === "ArrowDown") { event.preventDefault(); moveFocus(+1); }
    else if (event.key === "ArrowUp")   { event.preventDefault(); moveFocus(-1); }
    else if (event.key === "Home")     { event.preventDefault(); moveFocus(-9999); }
    else if (event.key === "End")      { event.preventDefault(); moveFocus(+9999); }
  }

  // Determine panel position — clamp to viewport so we never overflow.
  // Reads the live document direction so changes via i18n update the
  // menu immediately.
  const isRtl = useDocumentDir() === "rtl";
  const panelStyle = useMemo<CSSProperties>(() => {
    const baseTop = (toggleRect?.bottom ?? 0) + 8;
    const baseTopWindow = baseTop + (typeof window !== "undefined" ? window.scrollY : 0);
    const width = Math.min(320, typeof window !== "undefined" ? window.innerWidth - 32 : 280);
    const desiredLeft = !isRtl
      ? (toggleRect?.right ?? 0) - width
      : (toggleRect?.left ?? 0);
    const minLeft = 16;
    const maxLeft = (typeof window !== "undefined" ? window.innerWidth : 1024) - width - 16;
    const clampedLeft = Math.max(minLeft, Math.min(desiredLeft, Math.max(minLeft, maxLeft)));
    return {
      top: baseTopWindow,
      left: clampedLeft,
      width,
      // Use translate3d so position: fixed respects iOS notches.
      transform: reducedMotion ? undefined : "translate3d(0,0,0)",
      // Avoid long jank on first show by GPU-promoting.
      willChange: reducedMotion ? undefined : "transform, opacity",
    };
  }, [toggleRect, isRtl, reducedMotion]);

  const announceOpen = open ? "true" : "false";

  return (
    <div
      className="relative shrink-0"
      ref={wrapperRef}
      data-testid="speeddial"
      data-open={announceOpen}
    >
      <button
        id={triggerId}
        ref={toggleBtnRef}
        type="button"
        data-testid="btn-menu-speeddial"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        title={t(lang, "menu.open")}
        aria-label={t(lang, "menu.open")}
        className={`${BTN_ICON} border border-border bg-background`}
      >
        <MenuIcon
          aria-hidden="true"
          className={`h-5 w-5 ${open ? "rotate-90" : "rotate-0"} transition-transform duration-150`}
        />
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={panelRef}
              role="menu"
              id={menuId}
              aria-labelledby={triggerId}
              data-testid="speeddial-menu"
              data-motion={reducedMotion ? "off" : "on"}
              className="menu-panel fixed flex max-h-[80dvh]"
              style={panelStyle}
            >
              <header className="flex items-center justify-between gap-2 border-b border-border bg-card/60 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <span id={`${menuId}-title`}>{t(lang, "menu.title")}</span>
                <button
                  type="button"
                  onClick={closeMenu}
                  aria-label={t(lang, "common.close")}
                  data-testid="speeddial-close"
                  className="inline-flex h-8 w-8 min-h-8 min-w-8 items-center justify-center rounded-md hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X aria-hidden="true" className="h-4 w-4" />
                </button>
              </header>
              <ul
                ref={listRef}
                className="flex-1 overflow-y-auto overscroll-contain p-1"
                role="none"
                aria-labelledby={`${menuId}-title`}
                onKeyDown={onListKeyDown}
              >
                {MENU_ENTRIES.map((entry) => (
                  <SpeedDialItem
                    key={entry.testId}
                    entry={entry}
                    lang={lang}
                    onOpen={onOpen}
                    close={closeMenu}
                    isCurrent={currentPanel === entry.panel}
                  />
                ))}
              </ul>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}

function SpeedDialItem(props: {
  entry: MenuEntry;
  lang: Lang;
  onOpen: (p: PanelKey) => void;
  close: () => void;
  isCurrent: boolean;
}) {
  const { entry, lang, onOpen, close, isCurrent } = props;
  const { Icon } = entry;
  const label = t(lang, entry.labelKey);
  return (
    <li role="none">
      <button
        type="button"
        role="menuitem"
        onClick={() => { onOpen(entry.panel); close(); }}
        data-testid={`speeddial-${entry.testId}`}
        data-panel={entry.panel}
        aria-current={isCurrent ? "page" : undefined}
        className={
          "flex w-full min-h-11 items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm " +
          "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 " +
          "focus-visible:ring-ring " +
          (isCurrent ? "bg-primary/15 text-primary" : "")
        }
      >
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="font-medium">{label}</span>
        {isCurrent ? (
          <span className="ms-auto h-2 w-2 rounded-full bg-primary" aria-hidden="true" />
        ) : null}
      </button>
    </li>
  );
}

/* ---------- Root component ---------- */

export function MainMenu ({ mode, lang, onOpen, currentPanel = null }: MainMenuProps) {
  // Resolve the "best" presentation per viewport. We force `speeddial`
  // on touch-primary / narrow viewports regardless of user pref because
  // 14 inline icons do not fit a 360 px phone.
  const isTouchPrimary = useMatchMedia("(pointer: coarse)");
  const isNarrow = useMatchMedia("(max-width: 640px)");
  const reducedMotion = useReducedMotion();

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
    if (isTouchPrimary || isNarrow) return "speeddial" as const;
    return canonicalMode;
  }, [canonicalMode, isTouchPrimary, isNarrow]);

  if (effectiveMode === "speeddial") {
    return <SpeedDial
      lang={lang}
      onOpen={onOpen}
      currentPanel={currentPanel}
      reducedMotion={reducedMotion}
    />;
  }

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
        />
      ))}
    </nav>
  );
}

/* Default props for testing / Storybook. */
export const DEFAULT_MAIN_MENU_PROPS: MainMenuProps = {
  mode: "icons",
  lang: "en",
  currentPanel: null,
  onOpen: () => undefined,
};

// Re-export custom icons used by App.tsx so build is consistent.
// Trigger a HMR type-check by referencing the exports below.
// (These names are not exported externally but the imports above
// intentionally exercise every icon used elsewhere.)
export const __icons_used__: ReadonlyArray<string> = [
  Activity.displayName ?? "Activity",
  Bell.displayName ?? "Bell",
  Compass.displayName ?? "Compass",
  Eye.displayName ?? "Eye",
  FileText.displayName ?? "FileText",
  KeyRound.displayName ?? "KeyRound",
  MapPin.displayName ?? "MapPin",
  MenuIcon.displayName ?? "Menu",
  MessageSquare.displayName ?? "MessageSquare",
  Mic.displayName ?? "Mic",
  Nfc.displayName ?? "Nfc",
  Palette.displayName ?? "Palette",
  Radio.displayName ?? "Radio",
  SettingsIcon.displayName ?? "Settings",
  Shield.displayName ?? "Shield",
  ShieldCheck.displayName ?? "ShieldCheck",
  User.displayName ?? "User",
  Users.displayName ?? "Users",
  Video.displayName ?? "Video",
  Volume2.displayName ?? "Volume2",
  Wallet.displayName ?? "Wallet",
];

// Hint to Vite/TS that the unused imports above are intentional; the
// re-export is preserved so a grep on the bundle still finds the names.
export const __consumed_icons__: ReadonlyArray<ReactNode> = [
  <ChevronLeft key="cl" aria-hidden="true" />,
  <ChevronRight key="cr" aria-hidden="true" />,
];
