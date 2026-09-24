// The app's menu as data (4.0) — what the console's Menu builder edits and
// MainMenu.tsx renders. PURE module (no DOM, no Node): the server validates
// and stores it (server/menu-config.ts, $DATA_DIR/menu-config.json), the
// client renders it, and the default reproduces the menu as it always was.
//
//   trigger   the main button (the ☰): icon, text, style
//   panel     the menu window: width, title, header, headings, item defaults
//   items     what the panel lists, top to bottom:
//               section    a heading and its items
//               item       icon + label + action (a panel, a function, a URL)
//               html       a block of HTML with live variables (menu-template.ts)
//               separator  a line or a space
//               row        items or special buttons side by side
//               special    Appearance, Edit Mode, the user, light/dark, …
//   footer    the same kinds, below the list (Clear & Quit, the build)
//
// Every node can carry a style — alignment, wrapping, colours, icon, font,
// decoration, spacing, border — and the same for its states (hover, click,
// focus, current), and be shown only for a module or a situation.

import { MENU_ICONS } from "./menu-icons-data";
import { MODULE_IDS } from "./modules";

/* ------------------------------------------------------------------ style */

export const STATE_KEYS = ["hover", "active", "focus", "current"] as const;
export type StateKey = (typeof STATE_KEYS)[number];
export const FONT_WEIGHTS = ["300", "400", "500", "600", "700", "800"] as const;
export type FontWeight = (typeof FONT_WEIGHTS)[number];
export const SHADOWS = ["none", "sm", "md", "lg", "glow"] as const;
export type Shadow = (typeof SHADOWS)[number];
export const BORDER_STYLES = ["solid", "dashed", "dotted", "double", "none"] as const;
export type BorderStyle = (typeof BORDER_STYLES)[number];
export const ALIGNS = ["start", "center", "end", "between"] as const;
export const WRAPS = ["wrap", "nowrap", "ellipsis"] as const;
export const ICON_POSITIONS = ["start", "end", "top", "none"] as const;
/** Font stacks by name; "inherit" keeps the template's font. */
export const FONT_STACKS: Record<string, string> = {
  inherit: "inherit",
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  rounded: 'ui-rounded, "SF Pro Rounded", Nunito, system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
  condensed: '"Roboto Condensed", "Arial Narrow", sans-serif',
};
/** The template's own colours, usable next to #rrggbb. */
export const COLOR_TOKENS: Record<string, string> = {
  primary: "hsl(var(--primary))", "primary-foreground": "hsl(var(--primary-foreground))",
  foreground: "hsl(var(--foreground))", background: "hsl(var(--background))", card: "hsl(var(--card))",
  muted: "hsl(var(--muted))", "muted-foreground": "hsl(var(--muted-foreground))",
  accent: "hsl(var(--accent))", "accent-foreground": "hsl(var(--accent-foreground))",
  destructive: "hsl(var(--destructive))", "destructive-foreground": "hsl(var(--destructive-foreground))",
  border: "hsl(var(--border))", transparent: "transparent", current: "currentColor",
};

export type StateStyle = {
  color?: string;
  background?: string;
  iconColor?: string;
  borderColor?: string;
  fontWeight?: FontWeight;
  underline?: boolean;
  /** 0–1 */
  opacity?: number;
  /** 0.8–1.2 */
  scale?: number;
  shadow?: Shadow;
};

export type ElementStyle = StateStyle & {
  align?: (typeof ALIGNS)[number];
  wrap?: (typeof WRAPS)[number];
  fontSize?: number;
  fontFamily?: string;
  italic?: boolean;
  uppercase?: boolean;
  letterSpacing?: number;
  iconSize?: number;
  iconPosition?: (typeof ICON_POSITIONS)[number];
  paddingX?: number;
  paddingY?: number;
  gap?: number;
  minHeight?: number;
  radius?: number;
  borderWidth?: number;
  borderStyle?: BorderStyle;
  /** hover, active (click), focus, current (the open panel). */
  states?: Partial<Record<StateKey, StateStyle>>;
};

/* ----------------------------------------------------------------- nodes */

export const MENU_PANELS = [
  "join", "roomSecurity", "encryption", "trust", "peers", "connection", "connections", "audio", "video", "files", "location",
  "speech", "ai", "phone", "nfc", "appearance", "settings", "notifications", "privacy", "analytics", "profile",
] as const;

export const MENU_FNS: ReadonlyArray<{ id: string; label: string; param?: string }> = [
  { id: "openRoom", label: "Open the Room window" },
  { id: "signIn", label: "Sign in (the Connection window)" },
  { id: "connectDefault", label: "Connect the default saved connection" },
  { id: "disconnect", label: "Disconnect from the room" },
  { id: "toggleEditMode", label: "Edit Mode on / off" },
  { id: "toggleTone", label: "Light / dark" },
  { id: "setTheme", label: "Switch to a template", param: "template id (ios, windows, nord…)" },
  { id: "setLang", label: "Switch the language", param: "cs, en or de" },
  { id: "toggleNotifications", label: "Notifications on / off" },
  { id: "clearQuit", label: "Clear & Quit" },
];
export const MENU_FN_IDS: readonly string[] = MENU_FNS.map((f) => f.id);

export const SPECIALS: ReadonlyArray<{ id: string; label: string; stateful: boolean }> = [
  { id: "user", label: "The user (avatar and nickname)", stateful: false },
  { id: "appearance", label: "Appearance (quick button)", stateful: false },
  { id: "editMode", label: "Edit Mode switch", stateful: true },
  { id: "toneToggle", label: "Light / dark switch", stateful: true },
  { id: "notifications", label: "Notifications switch", stateful: true },
  { id: "account", label: "Account (username or sign-in)", stateful: true },
  { id: "clearQuit", label: "Clear & Quit", stateful: false },
  { id: "build", label: "Version and build", stateful: false },
];
export const SPECIAL_IDS: readonly string[] = SPECIALS.map((x) => x.id);

export const WHEN = ["always", "signedIn", "signedOut", "connected", "disconnected", "phone", "desktop"] as const;
export type When = (typeof WHEN)[number];

export type MenuAction =
  | { type: "panel"; panel: string }
  | { type: "fn"; fn: string; param?: string }
  | { type: "url"; href: string; newTab?: boolean }
  | { type: "none" };

type Base = {
  id: string;
  /** Hidden in the menu (kept in the builder). */
  hidden?: boolean;
  /** Shown only when this module is on for the user (modules.ts). */
  module?: string;
  when?: When;
  style?: ElementStyle;
};
export type SectionNode = Base & { kind: "section"; label: string; icon?: string; children: MenuNode[] };
export type ItemNode = Base & { kind: "item"; icon: string; label: string; action: MenuAction; badge?: string };
export type HtmlNode = Base & { kind: "html"; html: string };
export type SeparatorNode = Base & { kind: "separator"; variant: "line" | "dashed" | "dotted" | "double" | "space"; color?: string; thickness?: number; spacing?: number };
export type RowNode = Base & { kind: "row"; children: MenuNode[] };
export type SpecialNode = Base & { kind: "special"; special: string; icon?: string; label?: string; showState?: boolean };
export type MenuNode = SectionNode | ItemNode | HtmlNode | SeparatorNode | RowNode | SpecialNode;
export type NodeKind = MenuNode["kind"];

export type MenuConfig = {
  version: 1;
  updatedAt: number;
  trigger: { icon: string; text: string; showText: boolean; title: string; style: ElementStyle };
  panel: {
    width: number;
    title: string;
    showHeader: boolean;
    showClose: boolean;
    style: ElementStyle;
    header: ElementStyle;
    headings: ElementStyle;
    items: ElementStyle;
  };
  items: MenuNode[];
  footer: MenuNode[];
};

export const MENU_LIMITS = { nodes: 300, depth: 3, label: 80, html: 8000, width: [220, 560] as const } as const;

/* --------------------------------------------------------------- default */

/** The menu as it always was: the same entries, groups, testids and look. */
const item = (id: string, panel: string, icon: string, label: string): ItemNode => ({ kind: "item", id, icon, label: `@${label}`, action: { type: "panel", panel } });

export const DEFAULT_MENU_CONFIG: MenuConfig = {
  version: 1,
  updatedAt: 0,
  trigger: { icon: "menu", text: "", showText: false, title: "@menu.open", style: {} },
  panel: { width: 320, title: "@menu.title", showHeader: true, showClose: true, style: {}, header: {}, headings: {}, items: {} },
  items: [
    { kind: "special", id: "user", special: "user" },
    { kind: "row", id: "quick", children: [
      { kind: "special", id: "quick-appearance", special: "appearance" },
      { kind: "special", id: "quick-editmode", special: "editMode", showState: true },
    ] },
    { kind: "section", id: "room", label: "@menu.group.room", children: [
      item("btn-room-security", "roomSecurity", "shield-check", "room.security.title"),
      item("btn-encryption", "encryption", "key-round", "menu.encryption"),
      item("btn-trust", "trust", "shield", "menu.trust"),
      item("btn-peers", "peers", "users", "menu.peers"),
      item("btn-connection", "connection", "radio", "menu.connection"),
      item("btn-connections", "connections", "plug", "menu.connections"),
    ] },
    { kind: "section", id: "talk", label: "@menu.group.talk", children: [
      item("btn-audio", "audio", "mic", "menu.audio"),
      item("btn-video", "video", "video", "menu.video"),
      item("btn-files", "files", "file-text", "menu.files"),
      item("btn-location", "location", "map-pin", "menu.location"),
    ] },
    { kind: "section", id: "tools", label: "@menu.group.tools", children: [
      item("btn-speech", "speech", "volume-2", "menu.speech"),
      item("btn-ai", "ai", "sparkles", "menu.ai"),
      item("btn-phone", "phone", "phone", "menu.phone"),
      item("btn-nfc", "nfc", "nfc", "menu.nfc"),
    ] },
    { kind: "section", id: "app", label: "@menu.group.app", children: [
      item("btn-appearance", "appearance", "palette", "menu.appearance"),
      item("btn-settings", "settings", "settings", "menu.settings"),
      item("btn-notifications", "notifications", "bell", "menu.notifications"),
      item("btn-privacy", "privacy", "eye", "menu.privacy"),
      item("btn-analytics", "analytics", "activity", "menu.analytics"),
      item("btn-profile", "profile", "user", "menu.profile"),
    ] },
  ],
  footer: [
    { kind: "special", id: "clear-quit", special: "clearQuit" },
    { kind: "special", id: "build", special: "build" },
  ],
};

/* ----------------------------------------------------------- validation */

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const HEX_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
// eslint-disable-next-line no-control-regex
const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, max) : "");
const num = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v * 100) / 100)) : undefined;
const pickOf = <T extends string>(v: unknown, list: readonly T[]): T | undefined => (typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

export function isColor(v: unknown): v is string {
  return typeof v === "string" && (HEX_RE.test(v) || v in COLOR_TOKENS);
}
/** A colour as CSS: a token becomes the template's variable. */
export function cssColor(v: string): string {
  return COLOR_TOKENS[v] ?? v;
}
export function isIcon(v: unknown): v is string {
  return typeof v === "string" && v in MENU_ICONS;
}

function compact<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

function sanitizeState(raw: unknown): StateStyle {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return compact({
    color: isColor(r.color) ? r.color : undefined,
    background: isColor(r.background) ? r.background : undefined,
    iconColor: isColor(r.iconColor) ? r.iconColor : undefined,
    borderColor: isColor(r.borderColor) ? r.borderColor : undefined,
    fontWeight: pickOf(r.fontWeight, FONT_WEIGHTS),
    underline: bool(r.underline),
    opacity: num(r.opacity, 0, 1),
    scale: num(r.scale, 0.8, 1.2),
    shadow: pickOf(r.shadow, SHADOWS),
  });
}

export function sanitizeStyle(raw: unknown): ElementStyle {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const statesRaw = (r.states && typeof r.states === "object" ? r.states : {}) as Record<string, unknown>;
  const states: Partial<Record<StateKey, StateStyle>> = {};
  for (const key of STATE_KEYS) {
    const st = sanitizeState(statesRaw[key]);
    if (Object.keys(st).length) states[key] = st;
  }
  return compact({
    ...sanitizeState(r),
    align: pickOf(r.align, ALIGNS),
    wrap: pickOf(r.wrap, WRAPS),
    fontSize: num(r.fontSize, 8, 40),
    fontFamily: typeof r.fontFamily === "string" && r.fontFamily in FONT_STACKS ? r.fontFamily : undefined,
    italic: bool(r.italic),
    uppercase: bool(r.uppercase),
    letterSpacing: num(r.letterSpacing, -2, 10),
    iconSize: num(r.iconSize, 8, 48),
    iconPosition: pickOf(r.iconPosition, ICON_POSITIONS),
    paddingX: num(r.paddingX, 0, 48),
    paddingY: num(r.paddingY, 0, 48),
    gap: num(r.gap, 0, 32),
    minHeight: num(r.minHeight, 0, 120),
    radius: num(r.radius, 0, 64),
    borderWidth: num(r.borderWidth, 0, 8),
    borderStyle: pickOf(r.borderStyle, BORDER_STYLES),
    states: Object.keys(states).length ? states : undefined,
  });
}

function sanitizeAction(raw: unknown): MenuAction {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (r.type === "panel" && pickOf(r.panel, MENU_PANELS)) return { type: "panel", panel: r.panel as string };
  if (r.type === "fn" && typeof r.fn === "string" && MENU_FN_IDS.includes(r.fn)) {
    const param = clean(r.param, 40).trim();
    return { type: "fn", fn: r.fn, ...(param ? { param } : {}) };
  }
  if (r.type === "url") {
    const href = clean(r.href, 400).trim();
    // Only this site (a path) or https; never javascript: or data:.
    if (/^https:\/\/[^\s]+$/i.test(href) || /^\/(?!\/)[^\s]*$/.test(href)) return { type: "url", href, ...(r.newTab === true ? { newTab: true } : {}) };
  }
  return { type: "none" };
}

type Budget = { left: number; ids: Set<string> };

function sanitizeNode(raw: unknown, depth: number, budget: Budget): MenuNode | null {
  if (budget.left <= 0 || depth > MENU_LIMITS.depth) return null;
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  let id = clean(r.id, 40).toLowerCase();
  if (!ID_RE.test(id) || budget.ids.has(id)) {
    let n = 1;
    do { id = `node-${budget.ids.size + n++}`; } while (budget.ids.has(id));
  }
  budget.ids.add(id);
  budget.left -= 1;
  const base = compact({
    id,
    hidden: r.hidden === true ? true : undefined,
    module: typeof r.module === "string" && MODULE_IDS.includes(r.module) ? r.module : undefined,
    when: pickOf(r.when, WHEN) && r.when !== "always" ? (r.when as When) : undefined,
    style: (() => { const st = sanitizeStyle(r.style); return Object.keys(st).length ? st : undefined; })(),
  });
  const children = (list: unknown, allow: readonly NodeKind[]) =>
    (Array.isArray(list) ? list : []).map((c) => sanitizeNode(c, depth + 1, budget)).filter((c): c is MenuNode => Boolean(c) && allow.includes(c!.kind));
  switch (r.kind) {
    case "section":
      return { ...base, kind: "section", label: clean(r.label, MENU_LIMITS.label), ...(isIcon(r.icon) ? { icon: r.icon } : {}), children: children(r.children, ["item", "html", "separator", "row", "special"]) };
    case "item": {
      const badge = clean(r.badge, 40);
      return { ...base, kind: "item", icon: isIcon(r.icon) ? r.icon : "circle-alert", label: clean(r.label, MENU_LIMITS.label), action: sanitizeAction(r.action), ...(badge ? { badge } : {}) };
    }
    case "html":
      return { ...base, kind: "html", html: clean(r.html, MENU_LIMITS.html) };
    case "separator":
      return compact({
        ...base, kind: "separator" as const,
        variant: pickOf(r.variant, ["line", "dashed", "dotted", "double", "space"] as const) ?? "line",
        color: isColor(r.color) ? r.color : undefined,
        thickness: num(r.thickness, 1, 8),
        spacing: num(r.spacing, 0, 48),
      }) as SeparatorNode;
    case "row":
      return { ...base, kind: "row", children: children(r.children, ["item", "special", "html", "separator"]) };
    case "special": {
      const special = pickOf(r.special, SPECIAL_IDS);
      if (!special) return null;
      const label = clean(r.label, MENU_LIMITS.label);
      return compact({
        ...base, kind: "special" as const, special,
        icon: isIcon(r.icon) ? r.icon : undefined,
        label: label || undefined,
        showState: typeof r.showState === "boolean" ? r.showState : undefined,
      }) as SpecialNode;
    }
    default:
      budget.ids.delete(id);
      budget.left += 1;
      return null;
  }
}

export function sanitizeMenuConfig(raw: unknown): MenuConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_MENU_CONFIG;
  const t = (r.trigger && typeof r.trigger === "object" ? r.trigger : {}) as Record<string, unknown>;
  const p = (r.panel && typeof r.panel === "object" ? r.panel : {}) as Record<string, unknown>;
  const budget: Budget = { left: MENU_LIMITS.nodes, ids: new Set() };
  const list = (v: unknown, fallback: MenuNode[]) =>
    Array.isArray(v) ? v.map((n) => sanitizeNode(n, 1, budget)).filter((n): n is MenuNode => Boolean(n)) : fallback;
  const items = list(r.items, d.items);
  const footer = list(r.footer, d.footer);
  return {
    version: 1,
    updatedAt: num(r.updatedAt, 0, Number.MAX_SAFE_INTEGER) ?? 0,
    trigger: {
      icon: isIcon(t.icon) ? t.icon : d.trigger.icon,
      text: clean(t.text, 40),
      showText: t.showText === true,
      title: clean(t.title, MENU_LIMITS.label) || d.trigger.title,
      style: sanitizeStyle(t.style),
    },
    panel: {
      width: num(p.width, MENU_LIMITS.width[0], MENU_LIMITS.width[1]) ?? d.panel.width,
      title: typeof p.title === "string" ? clean(p.title, MENU_LIMITS.label) : d.panel.title,
      showHeader: p.showHeader !== false,
      showClose: p.showClose !== false,
      style: sanitizeStyle(p.style),
      header: sanitizeStyle(p.header),
      headings: sanitizeStyle(p.headings),
      items: sanitizeStyle(p.items),
    },
    items,
    footer,
  };
}

/* --------------------------------------------------------------- helpers */

/** Every node, depth first (sections and rows before their children). */
export function walkNodes(nodes: MenuNode[], visit: (node: MenuNode, parent: MenuNode | null) => void, parent: MenuNode | null = null): void {
  for (const node of nodes) {
    visit(node, parent);
    if (node.kind === "section" || node.kind === "row") walkNodes(node.children, visit, node);
  }
}

/** The module a node needs: its own, or the one of the panel it opens. */
export function nodeModule(node: MenuNode, moduleOfPanel: (panel: string) => string): string {
  if (node.module) return node.module;
  if (node.kind === "item" && node.action.type === "panel") return moduleOfPanel(node.action.panel);
  if (node.kind === "special" && node.special === "appearance") return "appearance";
  if (node.kind === "special" && node.special === "editMode") return "editMode";
  if (node.kind === "special" && node.special === "notifications") return "notifications";
  return "";
}

/** A label: "@key" is translated, anything else is text (with {$variables}). */
export function isI18nLabel(label: string): boolean {
  return /^@[a-z][\w.-]*$/i.test(label.trim());
}
