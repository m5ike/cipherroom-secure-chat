// The iOS design (6.14): the same design language as Android's (elements,
// actions, expressions, texts, menus, libraries — server/android/design.ts),
// its own document. The default is Android's default design with an iOS look:
// the system colours (blue tint, grouped backgrounds, iMessage-like bubbles),
// iOS corner radii and transitions, and "sans" drawn in SF Pro by the app.
// Builds are the same M5PK / M5AB bundles, gated by minAppCode for iOS builds
// (the first iOS app is 6.14.0 = 61400).
//
// What iOS cannot do of a valid design (docs/ios-architecture.md §5) is not
// refused — the app hides or replaces it — but the console says so: the
// warnings of /design/validate and /design/preview.

import { join } from "node:path";
import {
  androidCatalog, DEFAULT_ANIMATIONS, DEFAULT_DESIGN, designRev, sanitizeDesign,
  type AndroidDesign, type Animations, type Theme,
} from "../android/design";
import { designMinAppCode } from "../mobile/bundle";
import { createDesignStore } from "../mobile/design-store";
import { mobileDir } from "../mobile/store";
import type { AndroidTheme } from "../android/themes";
import { THEMES_67_LOOK } from "../android/design-67-look";

/** The first iOS app (6.14.0): the oldest that reads bundle format 1. */
export const IOS_MIN_APP_CODE = 61400;

/**
 * iOS system colours on the design's tokens. The tint is iOS blue, darkened
 * where white text sits on it (#0064e0: 5.4:1; Apple's #007aff is 4.0:1) and
 * lightened in the dark tone with dark text on it; red / green / orange are
 * Apple's accessible variants.
 */
export const IOS_THEME: Theme = {
  light: {
    primary: "#0064e0", onPrimary: "#ffffff", background: "#f2f2f7", surface: "#ffffff", surfaceVariant: "#e5e5ea", onSurface: "#000000",
    muted: "#6c6c70", accent: "#5856d6", border: "#c6c6c8", danger: "#d70015", success: "#248a3d", warning: "#c93400",
    bubbleIn: "#e9e9eb", onBubbleIn: "#000000", bubbleOut: "#0064e0", onBubbleOut: "#ffffff", scrim: "#66000000",
  },
  dark: {
    primary: "#409cff", onPrimary: "#001a33", background: "#000000", surface: "#1c1c1e", surfaceVariant: "#2c2c2e", onSurface: "#ffffff",
    muted: "#98989f", accent: "#7d7aff", border: "#38383a", danger: "#ff6961", success: "#30db5b", warning: "#ffb340",
    bubbleIn: "#262628", onBubbleIn: "#ffffff", bubbleOut: "#0060c8", onBubbleOut: "#ffffff", scrim: "#99000000",
  },
  radius: 12,
  font: "sans",
  density: "normal",
};

/** iOS motion: a pushed screen slides in from the right, sheets rise from the bottom. */
export const IOS_ANIMATIONS: Animations = {
  ...structuredClone(DEFAULT_ANIMATIONS),
  screen: { type: "slide-left", ms: 350, easing: "decelerate" },
  dialog: { type: "slide-up", ms: 300, easing: "decelerate" },
  message: { type: "slide-up", ms: 220, easing: "decelerate" },
  users: { type: "slide-left", ms: 300, easing: "decelerate" },
  splash: { style: "reveal", ms: 900, minMs: 500 },
};

export const IOS_DEFAULT_DESIGN: AndroidDesign = {
  ...DEFAULT_DESIGN,
  theme: IOS_THEME,
  animations: IOS_ANIMATIONS,
  rev: "default",
};

/** The look as a template of Settings › Appearance (first in the iOS app's list). */
export const IOS_LOOK_THEME: AndroidTheme = {
  id: "ios", family: "studio", tones: ["light", "dark"], radius: IOS_THEME.radius, font: "sans",
  label: { cs: "iOS", en: "iOS", de: "iOS", es: "iOS", it: "iOS", fr: "iOS", sk: "iOS", sl: "iOS", fi: "iOS" },
  light: { ...IOS_THEME.light }, dark: { ...IOS_THEME.dark },
};


/* ============================================================ limits (§ 5) */

export type IosLimit = { action: string; arg?: RegExp; note: string };

/** Actions of the design language iOS cannot carry out as Android does — what the iOS app does instead. */
export const IOS_LIMITS: IosLimit[] = [
  { action: "nfc.emulate", note: "card emulation (HCE) needs Apple's HCE entitlement (EU, iOS 18.1+); without it the iOS app hides the control" },
  { action: "nfc.reader", arg: /usb/i, note: "iPhone has no USB NFC readers; the iOS app offers the internal reader (iPhone) and Bluetooth readers" },
  { action: "calllog.system", note: "iOS does not let an app remove calls from the Phone app's Recents; the iOS app hides it" },
  { action: "conversations.settings", note: "iOS has no per-conversation system settings; the iOS app opens its notification settings" },
  { action: "update.install", note: "an iOS update is installed by the App Store or TestFlight; the action opens the release's link" },
];

/** What of a design the iOS app will hide or replace, each once with where it is used. */
export function iosDesignWarnings(design: AndroidDesign): string[] {
  const found = new Map<IosLimit, Set<string>>();
  const check = (action: unknown, arg: unknown, where: string) => {
    if (typeof action !== "string") return;
    for (const l of IOS_LIMITS) {
      if (l.action !== action) continue;
      if (l.arg && !(typeof arg === "string" && l.arg.test(arg))) continue;
      if (!found.has(l)) found.set(l, new Set());
      found.get(l)!.add(where);
    }
  };
  const visit = (v: unknown, where: string, depth: number): void => {
    if (depth > 64 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) { for (const x of v) visit(x, where, depth + 1); return; }
    const o = v as Record<string, unknown>;
    if ("action" in o) check(o.action, o.arg, where);
    if ("do" in o) check(o.do, o.arg, where);
    for (const x of Object.values(o)) visit(x, where, depth + 1);
  };
  for (const [id, tree] of Object.entries(design.screens)) visit(tree, `screen ${id}`, 0);
  for (const [id, items] of Object.entries(design.menus)) visit(items, `menu ${id}`, 0);
  for (const [id, lib] of Object.entries(design.libraries)) visit(lib, `library ${id}`, 0);
  return [...found.entries()].map(([l, where]) => {
    const list = [...where];
    return `${l.action}${l.arg ? ` (${l.arg.source.replace(/\\/g, "")})` : ""} — ${list.slice(0, 4).join(", ")}${list.length > 4 ? ` and ${list.length - 4} more` : ""}: ${l.note}`;
  });
}

/** The oldest iOS app a design runs on: the first iOS app, or newer when a design element needs it. */
export function iosDesignMinAppCode(design: AndroidDesign): number {
  return Math.max(IOS_MIN_APP_CODE, designMinAppCode(design));
}

/* ================================================================ storage */

export const sanitizeIosDesign = (raw: unknown): AndroidDesign => sanitizeDesign(raw, IOS_DEFAULT_DESIGN);

const designStore = createDesignStore({ label: "ios", file: () => join(mobileDir("ios"), "design.json"), defaults: IOS_DEFAULT_DESIGN, sanitize: sanitizeIosDesign, rev: designRev });

export const iosDesign = (): AndroidDesign => designStore.get();
export const saveIosDesign = (raw: unknown, by: string): AndroidDesign => designStore.save(raw, by);
export const forgetIosDesign = (): void => designStore.forget();
export const savedIosDesignProblem = (): string | null => designStore.problem();

/**
 * What the console's design builder needs: Android's catalog with the iOS
 * defaults, the § 5 limits, and the app's own templates (the iOS look first;
 * the web's templates come from client CSS at build time — ios/assets.ts —
 * so the running server lists only these).
 */
export function iosCatalog() {
  return {
    ...androidCatalog(IOS_DEFAULT_DESIGN),
    platform: "ios",
    iosLimits: IOS_LIMITS.map((l) => ({ action: l.action, arg: l.arg?.source ?? "", note: l.note })),
    themes: [IOS_LOOK_THEME, ...THEMES_67_LOOK],
  };
}
