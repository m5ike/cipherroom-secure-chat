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
//
// 4.0 — the menu is DATA (lib/menu-config.ts), built in the operator
// console's Menu builder: sections, items, HTML blocks with live variables,
// separators, rows and special buttons, each with its own style and states.
// The default configuration draws exactly the menu above (same entries,
// groups, test ids, classes). Both the speed-dial panel and the toolbar are
// rendered from it.

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
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check, LogOut, X } from "lucide-react";
import type { PanelKey } from "../App";
import type { Lang } from "../lib/i18n";
import { t } from "../lib/i18n";
import {
  DEFAULT_MENU_CONFIG, isI18nLabel, type ElementStyle, type ItemNode, type MenuAction, type MenuConfig, type MenuNode,
} from "../lib/menu-config";
import { renderText, type TemplateVars } from "../lib/menu-template";
import { mergeStyles, styleProps } from "../lib/menu-style";
import { MenuIcon } from "./MenuIcon";
import { MenuHtml } from "./MenuHtml";
import "../menu.css";

type IconComponent = ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;

export type MenuEntry = {
  panel: PanelKey;
  testId: string;
  group: MenuGroup;
  labelKey: string;
  Icon: IconComponent;
};

export type MenuGroup = string;

/** An icon of the catalog as a component (for code that wants one). */
const iconComponent = (name: string): IconComponent => {
  const Named = ({ className }: { className?: string }) => <MenuIcon name={name} className={className} />;
  Named.displayName = `MenuIcon(${name})`;
  return Named;
};

/** The default menu's groups: sections of DEFAULT_MENU_CONFIG. */
export const MENU_GROUPS: ReadonlyArray<{ id: MenuGroup; labelKey: string }> = DEFAULT_MENU_CONFIG.items
  .filter((n): n is Extract<MenuNode, { kind: "section" }> => n.kind === "section")
  .map((s) => ({ id: s.id, labelKey: s.label.replace(/^@/, "") }));

/** The default menu's entries, in order (tests, and code that lists panels). */
export const MENU_ENTRIES: MenuEntry[] = DEFAULT_MENU_CONFIG.items.flatMap((n) => (n.kind === "section"
  ? n.children.filter((c): c is ItemNode => c.kind === "item" && c.action.type === "panel").map((c) => ({
      panel: (c.action as { panel: string }).panel as PanelKey,
      testId: c.id,
      group: n.id,
      labelKey: c.label.replace(/^@/, ""),
      Icon: iconComponent(c.icon),
    }))
  : []));

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

/** What the special buttons show. */
export type MenuStates = { tone?: "light" | "dark"; notifications?: boolean; signedIn?: boolean; username?: string };

export type MainMenuProps = {
  mode: MenuDisplayMode;
  lang: Lang;
  currentPanel?: PanelKey | null;
  onOpen: (panel: PanelKey) => void;
  /** Shown as the user chip (toolbar) / panel header (speed-dial). */
  user?: MenuUser;
  /** Renders the highlighted "Clear & Quit" action at the end of the menu. */
  onClearQuit?: () => void;
  /** Edit Mode quick switch (top of the menu). Omitted → no switch. */
  editMode?: boolean;
  onToggleEditMode?: () => void;
  /** "M5cet 2.8.0 · build abc123" in the menu footer. */
  buildLabel?: string;
  /** 4.0: entries of modules the user may not use are left out. */
  visible?: (panel: PanelKey) => boolean;
  /** 4.0: the menu to draw (the console's Menu builder); default: the classic one. */
  config?: MenuConfig;
  /** Live values for labels and HTML blocks (menu-template.ts). */
  vars?: TemplateVars;
  /** A node's own rule (its module, when it shows). */
  nodeVisible?: (node: MenuNode) => boolean;
  /** Functions and links (a panel goes through onOpen). */
  onAction?: (action: MenuAction) => void;
  states?: MenuStates;
};

/** Everything the nodes need, handed down once. */
type Ctx = {
  lang: Lang;
  config: MenuConfig;
  label: (text: string) => string;
  vars: TemplateVars;
  translate: (key: string) => string;
  isVisible: (node: MenuNode) => boolean;
  run: (action: MenuAction) => void;
  runHtml: (action: string) => void;
  close: () => void;
  currentPanel: PanelKey | null;
  user?: MenuUser;
  editMode?: boolean;
  onToggleEditMode?: () => void;
  onClearQuit?: () => void;
  buildLabel?: string;
  states: MenuStates;
};

/** Edit Mode switch used in the menu: green check when on, red cross when off. */
function EditModeQuick({ on, onToggle, lang, testId, compact, showState = true, label = "Edit Mode", icon, style }: {
  on: boolean; onToggle: () => void; lang: Lang; testId: string; compact?: boolean; showState?: boolean; label?: string; icon?: string;
  style?: { className: string; style: CSSProperties };
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={on}
      onClick={onToggle}
      data-testid={testId}
      title={t(lang, "ap.edit.toggleHint")}
      aria-label={`${label}: ${on ? "ON" : "OFF"}`}
      className={`menu-edit ${on ? "is-on" : "is-off"} ${compact ? "is-compact" : ""}${style?.className ? ` ${style.className}` : ""}`}
      style={style?.style}
    >
      <span className="menu-edit__icon" aria-hidden="true">
        {on ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : <X className="h-3.5 w-3.5" strokeWidth={3} />}
      </span>
      {compact ? <MenuIcon name={icon ?? "pencil-ruler"} className="h-4 w-4" /> : (
        <>
          <span className="menu-edit__label">{label}</span>
          {showState ? <span className="menu-edit__state">{on ? "ON" : "OFF"}</span> : null}
        </>
      )}
    </button>
  );
}

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
  node: ItemNode;
  ctx: Ctx;
  mode: ToolbarMode;
}) {
  const { node, ctx, mode } = props;
  const panel = node.action.type === "panel" ? (node.action.panel as PanelKey) : undefined;
  const isCurrent = Boolean(panel) && ctx.currentPanel === panel;
  const label = ctx.label(node.label);
  const custom = styleProps(mergeStyles(ctx.config.panel.items, node.style));

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
  if (custom.className) className += ` ${custom.className}`;

  const title = mode === "icons" || mode === "icons-tooltip" ? label : undefined;
  // Always name the button: in icons-text mode the visible <span> is
  // `hidden sm:inline` (display:none below sm), which would otherwise leave
  // the button without an accessible name on narrow viewports.
  return (
    <button
      type="button"
      onClick={() => ctx.run(node.action)}
      title={title}
      aria-label={label}
      aria-current={isCurrent ? "page" : undefined}
      data-testid={node.id}
      data-panel={panel}
      data-mode={mode}
      data-current={isCurrent ? "true" : undefined}
      className={className}
      style={custom.style}
    >
      {mode !== "text" ? <MenuIcon name={node.icon} className="h-4 w-4 shrink-0" /> : null}
      {mode === "icons-text" || mode === "text" ? (
        <span className="hidden truncate text-xs sm:inline">{label}</span>
      ) : null}
    </button>
  );
}

/* ---------- User chip: the "user space" of the header ---------- */

function UserChip(props: { node: ItemNode; ctx: Ctx }) {
  const { node, ctx } = props;
  const label = ctx.label(node.label);
  const name = ctx.user?.name?.trim() || label;
  const isCurrent = ctx.currentPanel === "profile";
  const custom = styleProps(node.style);
  return (
    <button
      type="button"
      onClick={() => ctx.run(node.action)}
      title={label}
      aria-label={`${label}: ${name}`}
      aria-current={isCurrent ? "page" : undefined}
      data-testid={node.id}
      data-panel="profile"
      data-current={isCurrent ? "true" : undefined}
      className={"user-chip" + (isCurrent ? " is-current" : "") + (custom.className ? ` ${custom.className}` : "")}
      style={custom.style}
    >
      <span className="user-chip__avatar" aria-hidden="true">{avatarGlyph(ctx.user)}</span>
      <span className="user-chip__name">{name}</span>
    </button>
  );
}

function ToolbarHtml({ node, ctx }: { node: Extract<MenuNode, { kind: "html" }>; ctx: Ctx }) {
  const st = styleProps(node.style);
  return <MenuHtml html={node.html} vars={ctx.vars} translate={ctx.translate} lang={ctx.lang} onAction={ctx.runHtml} className={`menu-html--inline ${st.className}`} style={st.style} />;
}

/** The toolbar: the sections' items in order, a divider between sections
 *  and before the user chip, the Edit Mode switch and Clear & Quit last. */
function Toolbar({ ctx, mode }: { ctx: Ctx; mode: ToolbarMode }) {
  const flat: Array<{ group: string; node: MenuNode }> = [];
  let editMode: MenuNode | null = null;
  let clearQuit: MenuNode | null = null;
  const take = (node: MenuNode, group: string) => {
    if (!ctx.isVisible(node)) return;
    if (node.kind === "section") { for (const child of node.children) take(child, node.id); return; }
    if (node.kind === "row") { for (const child of node.children) take(child, group); return; }
    if (node.kind === "special") {
      if (node.special === "editMode") editMode = node;
      if (node.special === "clearQuit") clearQuit = node;
      return;
    }
    flat.push({ group, node });
  };
  for (const node of ctx.config.items) take(node, `top:${node.id}`);
  for (const node of ctx.config.footer) take(node, "footer");
  const edit = editMode as MenuNode | null;
  const clear = clearQuit as MenuNode | null;
  return (
    <nav aria-label={t(ctx.lang, "menu.title")} className="ml-auto flex flex-wrap items-center gap-1" data-testid="main-nav" role="menubar">
      {flat.map(({ group, node }, index) => {
        const startsGroup = index > 0 && flat[index - 1].group !== group;
        const isProfile = node.kind === "item" && node.action.type === "panel" && node.action.panel === "profile";
        const divider = startsGroup || isProfile || node.kind === "separator";
        return (
          <Fragment key={node.id}>
            {divider ? <span role="separator" aria-orientation="vertical" className="menu-divider" /> : null}
            {node.kind === "item" ? (isProfile ? <UserChip node={node} ctx={ctx} /> : <ToolbarEntry node={node} ctx={ctx} mode={mode} />)
              : node.kind === "html" ? <ToolbarHtml node={node} ctx={ctx} />
              : null}
          </Fragment>
        );
      })}
      {edit && ctx.onToggleEditMode ? (
        <EditModeQuick on={Boolean(ctx.editMode)} onToggle={ctx.onToggleEditMode} lang={ctx.lang} testId="btn-edit-mode" compact icon={(edit as { icon?: string }).icon} />
      ) : null}
      {clear && ctx.onClearQuit ? (
        <>
          <span role="separator" aria-orientation="vertical" className="menu-divider" />
          <button
            type="button"
            onClick={ctx.onClearQuit}
            title={t(ctx.lang, "menu.clearQuit")}
            aria-label={t(ctx.lang, "menu.clearQuit")}
            data-testid="btn-clear-quit"
            className={`${BTN_ICON} border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive hover:text-destructive-foreground`}
          >
            <LogOut className="h-4 w-4 shrink-0" aria-hidden="true" />
          </button>
        </>
      ) : null}
    </nav>
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
function SpeedDial({ ctx, reducedMotion }: { ctx: Ctx; reducedMotion: boolean }) {
  const panelWidth = ctx.config.panel.width;
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
    const width = Math.min(panelWidth, typeof window !== "undefined" ? window.innerWidth - 32 : 280);
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
  }, [toggleRect, isRtl, reducedMotion, panelWidth]);


  const announceOpen = open ? "true" : "false";
  const cfg = ctx.config;
  const listCtx: Ctx = { ...ctx, close: closeMenu };
  const items = cfg.items.map((node) => <SpeedNode key={node.id} node={node} ctx={listCtx} />);
  const footerNodes = cfg.footer.filter((n) => ctx.isVisible(n));
  const footer = footerNodes.map((node) => <FooterNode key={node.id} node={node} ctx={listCtx} />);
  const trigger = styleProps(cfg.trigger.style);
  const triggerTitle = ctx.label(cfg.trigger.title);
  const panel = styleProps(cfg.panel.style);
  const header = styleProps(cfg.panel.header);

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
        title={triggerTitle}
        aria-label={triggerTitle}
        className={`${BTN_ICON} border border-border bg-background${cfg.trigger.showText && cfg.trigger.text ? " menu-trigger--text" : ""}${trigger.className ? ` ${trigger.className}` : ""}`}
        style={trigger.style}
      >
        <MenuIcon
          name={cfg.trigger.icon}
          className={`h-5 w-5 ${open ? "rotate-90" : "rotate-0"} transition-transform duration-150`}
        />
        {cfg.trigger.showText && cfg.trigger.text ? <span className="menu-trigger__text">{ctx.label(cfg.trigger.text)}</span> : null}
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
              className={`menu-panel fixed flex max-h-[80dvh]${panel.className ? ` ${panel.className}` : ""}`}
              style={{
                ...panelStyle,
                ...panel.style,
                // index.css pins the radius (Edit Mode's --c-menu-radius, !important): the builder's radius goes through it.
                ...(cfg.panel.style.radius !== undefined ? { "--c-menu-radius": `${cfg.panel.style.radius}px` } as CSSProperties : {}),
              }}
            >
              {cfg.panel.showHeader ? (
                <header className={`flex items-center justify-between gap-2 border-b border-border bg-card/60 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground${header.className ? ` ${header.className}` : ""}`} style={header.style}>
                  <span id={`${menuId}-title`}>{ctx.label(cfg.panel.title)}</span>
                  {cfg.panel.showClose ? (
                    <button
                      type="button"
                      onClick={closeMenu}
                      aria-label={t(ctx.lang, "common.close")}
                      data-testid="speeddial-close"
                      className="inline-flex h-8 w-8 min-h-8 min-w-8 items-center justify-center rounded-md hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <X aria-hidden="true" className="h-4 w-4" />
                    </button>
                  ) : null}
                </header>
              ) : null}
              <ul
                ref={listRef}
                className="flex-1 overflow-y-auto overscroll-contain p-1"
                role="none"
                aria-labelledby={`${menuId}-title`}
                onKeyDown={onListKeyDown}
              >
                {items}
              </ul>
              {footerNodes.length ? <footer className="menu-footer">{footer}</footer> : null}
            </div>,
            document.body
          )
        : null}
    </div>
  );
}

/* ---------- The nodes of the speed-dial panel ---------- */

/** A node in the list (the panel's <ul>). */
function SpeedNode({ node, ctx }: { node: MenuNode; ctx: Ctx }): ReactNode {
  if (!ctx.isVisible(node)) return null;
  switch (node.kind) {
    case "section": {
      const children = node.children.filter((c) => ctx.isVisible(c));
      if (!children.length) return null;
      const st = styleProps(mergeStyles(ctx.config.panel.headings, node.style));
      return (
        <>
          <li role="presentation" className={`menu-group-label${st.className ? ` ${st.className}` : ""}`} style={st.style}>
            {node.icon ? <MenuIcon name={node.icon} className="menu-group-label__icon" /> : null}
            {ctx.label(node.label)}
          </li>
          {children.map((c) => <SpeedNode key={c.id} node={c} ctx={ctx} />)}
        </>
      );
    }
    case "item":
      return <SpeedDialItem node={node} ctx={ctx} />;
    case "html": {
      const st = styleProps(node.style);
      return (
        <li role="none" className="menu-html-row" data-node={node.id}>
          <MenuHtml html={node.html} vars={ctx.vars} translate={ctx.translate} lang={ctx.lang} onAction={(a) => { ctx.runHtml(a); ctx.close(); }} className={st.className} style={st.style} />
        </li>
      );
    }
    case "separator":
      return <Separator node={node} />;
    case "row": {
      const children = node.children.filter((c) => ctx.isVisible(c));
      const shown = children.map((c) => <InlineNode key={c.id} node={c} ctx={ctx} />).filter(Boolean);
      if (!shown.length) return null;
      const st = styleProps(node.style);
      return <li role="none" className={`menu-quick${st.className ? ` ${st.className}` : ""}`} style={st.style} data-testid={`speeddial-${node.id}`}>{shown}</li>;
    }
    case "special": {
      if (node.special === "user") {
        if (!ctx.user?.name) return null;
        const st = styleProps(node.style);
        return (
          <li role="none" className={`menu-user${st.className ? ` ${st.className}` : ""}`} style={st.style} data-testid="speeddial-user">
            <span className="user-chip__avatar" aria-hidden="true">{avatarGlyph(ctx.user)}</span>
            <span className="truncate text-sm font-semibold">{node.label ? ctx.label(node.label) : ctx.user.name}</span>
          </li>
        );
      }
      if (node.special === "build") return ctx.buildLabel ? <li role="none" className="menu-build-row"><p className="menu-build" data-testid="menu-build">{ctx.buildLabel}</p></li> : null;
      const inner = <InlineNode node={node} ctx={ctx} />;
      return inner ? <li role="none" className="menu-special" data-node={node.id}>{inner}</li> : null;
    }
  }
}

function Separator({ node }: { node: Extract<MenuNode, { kind: "separator" }> }) {
  const style: CSSProperties = {};
  if (node.variant !== "space") {
    style.borderTopStyle = node.variant === "line" ? "solid" : node.variant;
    if (node.thickness) style.borderTopWidth = `${node.variant === "double" ? Math.max(3, node.thickness) : node.thickness}px`;
    if (node.color) style.borderTopColor = node.color.startsWith("#") ? node.color : `hsl(var(--${node.color}))`;
  }
  if (node.spacing !== undefined) style.marginBlock = `${node.spacing}px`;
  return <li role="separator" className={`menu-sep menu-sep--${node.variant}`} style={style} data-node={node.id} />;
}

/** A special button or a compact item — in a row, or on its own line. */
function InlineNode({ node, ctx }: { node: MenuNode; ctx: Ctx }): ReactNode {
  if (!ctx.isVisible(node)) return null;
  const st = styleProps(mergeStyles(node.kind === "item" ? ctx.config.panel.items : undefined, node.style));
  const testId = `speeddial-${node.id}`;
  if (node.kind === "item") {
    return (
      <button type="button" role="menuitem" className={`menu-quick__btn${st.className ? ` ${st.className}` : ""}`} style={st.style}
        onClick={() => { ctx.run(node.action); ctx.close(); }} data-testid={testId}
        data-panel={node.action.type === "panel" ? node.action.panel : undefined}>
        <MenuIcon name={node.icon} className="h-4 w-4 shrink-0" />
        <span>{ctx.label(node.label)}</span>
      </button>
    );
  }
  if (node.kind === "html") return <MenuHtml html={node.html} vars={ctx.vars} translate={ctx.translate} lang={ctx.lang} onAction={(a) => { ctx.runHtml(a); ctx.close(); }} className={`menu-html--inline ${st.className}`} style={st.style} />;
  if (node.kind === "separator") return <span role="separator" aria-orientation="vertical" className="menu-divider" />;
  if (node.kind !== "special") return null;
  const label = (fallbackKey: string) => (node.label ? ctx.label(node.label) : t(ctx.lang, fallbackKey));
  switch (node.special) {
    case "appearance":
      return (
        <button type="button" role="menuitem" className={`menu-quick__btn${st.className ? ` ${st.className}` : ""}`} style={st.style}
          onClick={() => { ctx.run({ type: "panel", panel: "appearance" }); ctx.close(); }} data-testid={testId}>
          <MenuIcon name={node.icon ?? "palette"} className="h-4 w-4 shrink-0" />
          <span>{label("menu.appearance")}</span>
        </button>
      );
    case "editMode":
      if (!ctx.onToggleEditMode) return null;
      return (
        <EditModeQuick on={Boolean(ctx.editMode)} onToggle={() => { ctx.onToggleEditMode!(); ctx.close(); }} lang={ctx.lang} testId={testId}
          showState={node.showState !== false} label={node.label ? ctx.label(node.label) : "Edit Mode"} style={st} />
      );
    case "toneToggle":
    case "notifications": {
      const on = node.special === "toneToggle" ? ctx.states.tone === "dark" : Boolean(ctx.states.notifications);
      const icon = node.icon ?? (node.special === "toneToggle" ? (on ? "moon" : "sun") : "bell");
      return (
        <button type="button" role="menuitemcheckbox" aria-checked={on} className={`menu-edit ${on ? "is-on" : "is-off"}${st.className ? ` ${st.className}` : ""}`} style={st.style}
          onClick={() => ctx.run({ type: "fn", fn: node.special === "toneToggle" ? "toggleTone" : "toggleNotifications" })} data-testid={testId}>
          <MenuIcon name={icon} className="h-4 w-4 shrink-0" />
          <span className="menu-edit__label">{label(node.special === "toneToggle" ? "mb.tone" : "mb.notifications")}</span>
          {node.showState !== false ? <span className="menu-edit__state">{on ? "ON" : "OFF"}</span> : null}
        </button>
      );
    }
    case "account": {
      const signedIn = Boolean(ctx.states.signedIn);
      return (
        <button type="button" role="menuitem" className={`menu-quick__btn menu-account${signedIn ? " is-on" : ""}${st.className ? ` ${st.className}` : ""}`} style={st.style}
          onClick={() => { ctx.run(signedIn ? { type: "panel", panel: "connection" } : { type: "fn", fn: "signIn" }); ctx.close(); }} data-testid={testId}>
          <MenuIcon name={node.icon ?? (signedIn ? "badge-check" : "key-round")} className="h-4 w-4 shrink-0" />
          <span className="truncate">{signedIn ? (node.showState === false ? label("id.signedInAs") : ctx.states.username ?? "") : label("id.signIn")}</span>
        </button>
      );
    }
    case "clearQuit":
      if (!ctx.onClearQuit) return null;
      return (
        <button type="button" className={`menu-clear${st.className ? ` ${st.className}` : ""}`} style={st.style} data-testid={testId}
          onClick={() => { ctx.close(); ctx.onClearQuit!(); }}>
          <MenuIcon name={node.icon ?? "log-out"} className="h-4 w-4 shrink-0" />
          <span>{label("menu.clearQuit")}</span>
        </button>
      );
    case "build":
      return ctx.buildLabel ? <p className="menu-build" data-testid="menu-build">{ctx.buildLabel}</p> : null;
    case "user":
      return ctx.user?.name ? <span className="menu-user menu-user--inline"><span className="user-chip__avatar" aria-hidden="true">{avatarGlyph(ctx.user)}</span><span className="truncate text-sm font-semibold">{ctx.user.name}</span></span> : null;
    default:
      return null;
  }
}

/** The footer below the list: the same kinds, drawn without a <li>. */
function FooterNode({ node, ctx }: { node: MenuNode; ctx: Ctx }): ReactNode {
  if (node.kind === "special") return <InlineNode node={node} ctx={ctx} />;
  if (node.kind === "separator") return <hr className={`menu-sep menu-sep--${node.variant}`} />;
  if (node.kind === "html" || node.kind === "item") return <InlineNode node={node} ctx={ctx} />;
  return null;
}

function SpeedDialItem({ node, ctx }: { node: ItemNode; ctx: Ctx }) {
  const panel = node.action.type === "panel" ? node.action.panel : undefined;
  const isCurrent = Boolean(panel) && ctx.currentPanel === panel;
  const label = ctx.label(node.label);
  const st = styleProps(mergeStyles(ctx.config.panel.items, node.style));
  const badge = node.badge ? ctx.label(node.badge) : "";
  return (
    <li role="none">
      <button
        type="button"
        role="menuitem"
        onClick={() => { ctx.run(node.action); ctx.close(); }}
        data-testid={`speeddial-${node.id}`}
        data-panel={panel}
        aria-current={isCurrent ? "page" : undefined}
        className={
          "flex w-full min-h-11 items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm " +
          "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 " +
          "focus-visible:ring-ring " +
          (isCurrent ? "bg-primary/15 text-primary" : "") +
          (st.className ? ` ${st.className}` : "")
        }
        style={st.style}
      >
        <span className="menu-icon" data-panel={panel} aria-hidden="true"><MenuIcon name={node.icon} className="h-4 w-4 shrink-0" /></span>
        <span className="font-medium">{label}</span>
        {badge ? <span className="menu-badge">{badge}</span> : null}
        {isCurrent ? (
          <span className="ms-auto h-2 w-2 rounded-full bg-primary" aria-hidden="true" />
        ) : null}
      </button>
    </li>
  );
}

/* ---------- Root component ---------- */

export function MainMenu ({
  mode, lang, onOpen, currentPanel = null, user, onClearQuit, editMode, onToggleEditMode, buildLabel, visible,
  config = DEFAULT_MENU_CONFIG, vars, nodeVisible, onAction, states,
}: MainMenuProps) {
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

  const emptyVars = useMemo(() => ({}), []);
  const translate = useCallback((key: string) => t(lang, key), [lang]);
  const liveVars = vars ?? emptyVars;
  const label = useCallback((text: string) => {
    if (!text) return "";
    return isI18nLabel(text) ? t(lang, text.trim().slice(1)) : renderText(text, liveVars, { translate, lang });
  }, [lang, liveVars, translate]);

  const run = useCallback((action: MenuAction) => {
    if (action.type === "panel") onOpen(action.panel as PanelKey);
    else if (action.type !== "none") onAction?.(action);
  }, [onOpen, onAction]);
  const runHtml = useCallback((action: string) => {
    const [kind, name, ...rest] = action.split(":");
    if (kind === "panel" && name) onOpen(name as PanelKey);
    else if (kind === "fn" && name) onAction?.({ type: "fn", fn: name, ...(rest.length ? { param: rest.join(":") } : {}) });
  }, [onOpen, onAction]);

  const isVisible = useCallback((node: MenuNode) => {
    if (node.hidden) return false;
    if (nodeVisible && !nodeVisible(node)) return false;
    if (node.kind === "item" && node.action.type === "panel" && visible && !visible(node.action.panel as PanelKey)) return false;
    if (node.kind === "special") {
      // A special button without what it needs is left out (as before).
      switch (node.special) {
        case "user": return Boolean(user?.name);
        case "appearance": return !visible || visible("appearance");
        case "editMode": return Boolean(onToggleEditMode);
        case "clearQuit": return Boolean(onClearQuit);
        case "build": return Boolean(buildLabel);
      }
    }
    return true;
  }, [nodeVisible, visible, user?.name, onToggleEditMode, onClearQuit, buildLabel]);

  const ctx: Ctx = {
    lang, config, label, vars: liveVars, translate, isVisible, run, runHtml, close: () => undefined,
    currentPanel, user, editMode, onToggleEditMode, onClearQuit, buildLabel, states: states ?? {},
  };

  if (effectiveMode === "speeddial") {
    return <SpeedDial ctx={ctx} reducedMotion={reducedMotion} />;
  }
  return <Toolbar ctx={ctx} mode={effectiveMode} />;
}

export type { ElementStyle };
