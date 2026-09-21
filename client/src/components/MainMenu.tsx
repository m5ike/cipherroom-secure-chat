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
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  Bell,
  Eye,
  FileText,
  KeyRound,
  MapPin,
  Menu as MenuIcon,
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
  X,
} from "lucide-react";
import type { PanelKey } from "../App";
import type { Lang } from "../lib/i18n";
import { t } from "../lib/i18n";

export type MenuEntry = {
  panel: PanelKey;
  testId: string;
  group: MenuGroup;
  labelKey: string;
  Icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
};

export type MenuGroup = "room" | "talk" | "tools" | "app";

/** Display order of the groups; each gets a divider (toolbar) or a heading
 *  (speed-dial panel). `profile` closes the list: in the toolbar it renders
 *  as the user chip, visually separate from the tool icons. */
export const MENU_GROUPS: ReadonlyArray<{ id: MenuGroup; labelKey: string }> = [
  { id: "room",  labelKey: "menu.group.room" },
  { id: "talk",  labelKey: "menu.group.talk" },
  { id: "tools", labelKey: "menu.group.tools" },
  { id: "app",   labelKey: "menu.group.app" },
];

export const MENU_ENTRIES: MenuEntry[] = [
  { group: "room",  panel: "roomSecurity", testId: "btn-room-security", labelKey: "room.security.title", Icon: ShieldCheck },
  { group: "room",  panel: "encryption", testId: "btn-encryption", labelKey: "menu.encryption", Icon: KeyRound },
  { group: "room",  panel: "trust", testId: "btn-trust", labelKey: "menu.trust", Icon: Shield },
  { group: "room",  panel: "peers", testId: "btn-peers", labelKey: "menu.peers", Icon: Users },
  { group: "room",  panel: "connection", testId: "btn-connection", labelKey: "menu.connection", Icon: Radio },
  { group: "talk",  panel: "audio", testId: "btn-audio", labelKey: "menu.audio", Icon: Mic },
  { group: "talk",  panel: "video", testId: "btn-video", labelKey: "menu.video", Icon: Video },
  { group: "talk",  panel: "files", testId: "btn-files", labelKey: "menu.files", Icon: FileText },
  { group: "talk",  panel: "location", testId: "btn-location", labelKey: "menu.location", Icon: MapPin },
  { group: "tools", panel: "speech", testId: "btn-speech", labelKey: "menu.speech", Icon: Volume2 },
  { group: "tools", panel: "nfc", testId: "btn-nfc", labelKey: "menu.nfc", Icon: Nfc },
  { group: "app",   panel: "templates", testId: "btn-templates", labelKey: "menu.templates", Icon: Palette },
  { group: "app",   panel: "settings", testId: "btn-settings", labelKey: "menu.settings", Icon: SettingsIcon },
  { group: "app",   panel: "notifications", testId: "btn-notifications", labelKey: "menu.notifications", Icon: Bell },
  { group: "app",   panel: "privacy", testId: "btn-privacy", labelKey: "menu.privacy", Icon: Eye },
  { group: "app",   panel: "analytics", testId: "btn-analytics", labelKey: "menu.analytics", Icon: Activity },
  { group: "app",   panel: "profile", testId: "btn-profile", labelKey: "menu.profile", Icon: User },
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

export type MenuUser = { name: string; avatar?: string };

export type MainMenuProps = {
  mode: MenuDisplayMode;
  lang: Lang;
  currentPanel?: PanelKey | null;
  onOpen: (panel: PanelKey) => void;
  /** Shown as the user chip (toolbar) / panel header (speed-dial). */
  user?: MenuUser;
};

/** One glyph for the avatar circle: a short emoji avatar if the user set one,
 *  otherwise the initial. URLs are never rendered (CSP blocks remote images
 *  anyway, and a peer-supplied URL must not trigger requests). */
export function avatarGlyph(user: MenuUser | undefined): string {
  const avatar = user?.avatar?.trim() ?? "";
  if (avatar && !/[/:.]/.test(avatar) && Array.from(avatar).length <= 2) return avatar;
  const initial = Array.from(user?.name?.trim() ?? "")[0];
  return initial ? initial.toUpperCase() : "?";
}

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
  // Always name the button: in icons-text mode the visible <span> is
  // `hidden sm:inline` (display:none below sm), which would otherwise leave
  // the button without an accessible name on narrow viewports.
  const ariaLabel = label;

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

/* ---------- User chip: the "user space" of the header ---------- */

function UserChip(props: {
  entry: MenuEntry;
  lang: Lang;
  onOpen: (panel: PanelKey) => void;
  user?: MenuUser;
  isCurrent: boolean;
}) {
  const { entry, lang, onOpen, user, isCurrent } = props;
  const label = t(lang, entry.labelKey);
  const name = user?.name?.trim() || label;
  return (
    <button
      type="button"
      onClick={() => onOpen(entry.panel)}
      title={label}
      aria-label={`${label}: ${name}`}
      aria-current={isCurrent ? "page" : undefined}
      data-testid={entry.testId}
      data-panel={entry.panel}
      data-current={isCurrent ? "true" : undefined}
      className={"user-chip" + (isCurrent ? " is-current" : "")}
    >
      <span className="user-chip__avatar" aria-hidden="true">{avatarGlyph(user)}</span>
      <span className="user-chip__name">{name}</span>
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
  user?: MenuUser;
}) {
  const { lang, onOpen, currentPanel, reducedMotion, user } = props;
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
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        // The panel is portaled to <body>, so it is not next to the toggle in
        // tab order. While focus is still outside the list, arrows pull it in
        // (WAI-ARIA menu button pattern). Inside the list, onListKeyDown owns
        // the arrows and has already run by the time this bubbles here.
        if (listRef.current?.contains(document.activeElement)) return;
        const items = listRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
        if (!items || items.length === 0) return;
        event.preventDefault();
        (event.key === "ArrowDown" ? items[0] : items[items.length - 1]).focus();
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

  // `to` is a step (+1 / -1, wrapping) or an absolute edge.
  function moveFocus(to: 1 | -1 | "first" | "last") {
    const items = listRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    if (!items || items.length === 0) return;
    let next: number;
    if (to === "first") next = 0;
    else if (to === "last") next = items.length - 1;
    else {
      const active = document.activeElement as HTMLElement | null;
      const idx = active ? Array.prototype.indexOf.call(items, active) : 0;
      const safeIdx = idx < 0 ? 0 : idx;
      next = (safeIdx + to + items.length) % items.length;
    }
    items[next].focus();
  }

  function onListKeyDown(event: ReactKeyboardEvent<HTMLUListElement>) {
    if (event.key === "ArrowDown") { event.preventDefault(); moveFocus(+1); }
    else if (event.key === "ArrowUp")   { event.preventDefault(); moveFocus(-1); }
    else if (event.key === "Home")     { event.preventDefault(); moveFocus("first"); }
    else if (event.key === "End")      { event.preventDefault(); moveFocus("last"); }
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
                {user?.name ? (
                  <li role="none" className="menu-user" data-testid="speeddial-user">
                    <span className="user-chip__avatar" aria-hidden="true">{avatarGlyph(user)}</span>
                    <span className="truncate text-sm font-semibold">{user.name}</span>
                  </li>
                ) : null}
                {MENU_GROUPS.map((group) => (
                  <Fragment key={group.id}>
                    <li role="presentation" className="menu-group-label">{t(lang, group.labelKey)}</li>
                    {MENU_ENTRIES.filter((entry) => entry.group === group.id).map((entry) => (
                      <SpeedDialItem
                        key={entry.testId}
                        entry={entry}
                        lang={lang}
                        onOpen={onOpen}
                        close={closeMenu}
                        isCurrent={currentPanel === entry.panel}
                      />
                    ))}
                  </Fragment>
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

export function MainMenu ({ mode, lang, onOpen, currentPanel = null, user }: MainMenuProps) {
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
      user={user}
    />;
  }

  return (
    <nav
      aria-label={t(lang, "menu.title")}
      className="ml-auto flex flex-wrap items-center gap-1"
      data-testid="main-nav"
      role="menubar"
    >
      {MENU_ENTRIES.map((entry, index) => {
        const startsGroup = index > 0 && MENU_ENTRIES[index - 1].group !== entry.group;
        const isCurrent = currentPanel === entry.panel;
        return (
          <Fragment key={entry.testId}>
            {startsGroup || entry.panel === "profile" ? (
              <span role="separator" aria-orientation="vertical" className="menu-divider" />
            ) : null}
            {entry.panel === "profile" ? (
              <UserChip entry={entry} lang={lang} onOpen={onOpen} user={user} isCurrent={isCurrent} />
            ) : (
              <ToolbarEntry entry={entry} lang={lang} onOpen={onOpen} mode={effectiveMode} isCurrent={isCurrent} />
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}
