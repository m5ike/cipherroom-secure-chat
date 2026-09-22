// Edit Mode runtime: the live side of style-overrides.ts.
//
//   styleStore        saved overrides (localStorage) + undo, subscribable
//   startStyleRuntime injects <style id="m5-user-styles"> (always last in
//                     <head>, so an override of a class wins over its original)
//                     and applies class patches through a MutationObserver
//   createPicker      element picking: Ctrl + right mouse button, a long tap
//                     (touch / pen), or "tap to pick" armed from the inspector
//   matchedRules      the stylesheet rules that style an element (its classes'
//                     "source code"), incl. :hover/:active/… variants
//   stylesheetClasses every class name defined anywhere, for "add class"
//
// `?nostyles` in the URL skips every override for that page load — a way
// back if a rule ever makes the app unusable.

import { useSyncExternalStore } from "react";
import {
  type StyleScope,
  baseSelector, buildStylesheet, loadOverrides, sanitizeOverrides, saveOverrides, splitSelectorList, stateOf,
  EMPTY_OVERRIDES, type StyleOverrides,
} from "./style-overrides";

/* ----------------------------------------------------------------- store */

type Listener = () => void;
const listeners = new Set<Listener>();
let state: StyleOverrides = { ...EMPTY_OVERRIDES, rules: [], classes: [] };
let loaded = false;
const history: StyleOverrides[] = [];
const HISTORY_MAX = 50;

function ensureLoaded() {
  if (!loaded) { state = loadOverrides(); loaded = true; }
}

export function stylesSuspended(): boolean {
  if (typeof location === "undefined") return false;
  return /[?&#]nostyles\b/.test(location.search + location.hash);
}

export const styleStore = {
  get(): StyleOverrides { ensureLoaded(); return state; },
  subscribe(fn: Listener): () => void { listeners.add(fn); return () => listeners.delete(fn); },
  /** Persist + apply. Returns false if the browser refused to store it. */
  commit(next: StyleOverrides): boolean {
    ensureLoaded();
    history.push(state);
    if (history.length > HISTORY_MAX) history.shift();
    state = sanitizeOverrides(next);
    const ok = saveOverrides(state);
    applyUserStyles();
    listeners.forEach((l) => l());
    return ok;
  },
  undo(): boolean {
    const prev = history.pop();
    if (!prev) return false;
    state = prev;
    saveOverrides(state);
    applyUserStyles();
    listeners.forEach((l) => l());
    return true;
  },
  canUndo(): boolean { return history.length > 0; },
  /** Test hook: forget the in-memory copy. */
  _reset(): void { loaded = false; history.length = 0; state = { ...EMPTY_OVERRIDES, rules: [], classes: [] }; },
};

export function useStyleOverrides(): StyleOverrides {
  return useSyncExternalStore(styleStore.subscribe, styleStore.get, styleStore.get);
}

/* ------------------------------------------------ inspect requests */

/** "Edit" on a saved rule in the Appearance screen opens it in the
 *  inspector; the request waits if the inspector is not mounted yet. */
export type InspectRequest = { selector: string; state?: string; scope?: StyleScope };
const inspectListeners = new Set<(r: InspectRequest) => void>();
let pendingInspect: InspectRequest | null = null;

export function requestInspect(r: InspectRequest): void {
  if (inspectListeners.size) inspectListeners.forEach((l) => l(r));
  else pendingInspect = r;
}

export function onInspectRequest(fn: (r: InspectRequest) => void): () => void {
  inspectListeners.add(fn);
  if (pendingInspect) { const r = pendingInspect; pendingInspect = null; fn(r); }
  return () => inspectListeners.delete(fn);
}

/* ------------------------------------------------------ stylesheet layer */

export const EDITOR_ATTR = "data-m5-editor";
const USER_STYLE_ID = "m5-user-styles";

/** While the inspector has unsaved edits, the page shows this working copy
 *  instead of the saved overrides — an exact live preview (a removed
 *  declaration disappears too, which a separate "draft" sheet could not do). */
let preview: StyleOverrides | null = null;
const effective = (): StyleOverrides => preview ?? styleStore.get();

export function setPreviewOverrides(o: StyleOverrides | null): void {
  preview = o;
  applyUserStyles();
}

function styleEl(id: string): HTMLStyleElement {
  let el = document.getElementById(id) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = id;
    el.setAttribute(EDITOR_ATTR, "");
    document.head.appendChild(el);
  }
  return el;
}

/** Our sheet must stay the last one in <head>: equal specificity → later wins. */
function keepLast() {
  const user = document.getElementById(USER_STYLE_ID);
  if (user && document.head.lastElementChild !== user) document.head.appendChild(user);
}

export function applyUserStyles(): void {
  if (typeof document === "undefined") return;
  const css = stylesSuspended() ? "" : buildStylesheet(effective());
  const el = styleEl(USER_STYLE_ID);
  if (el.textContent !== css) el.textContent = css;
  keepLast();
  syncClassPatches();
}

/* -------------------------------------------------------- class patches */

/** What we changed on an element, and which patches did it. */
type Touched = { added: Set<string>; removed: Set<string>; patches: Set<string> };
const touched = new Map<Element, Touched>();
let patchObserver: MutationObserver | null = null;
let patchFrame = 0;

function isEditorNode(n: unknown): boolean {
  return n instanceof Element && n.closest(`[${EDITOR_ATTR}]`) !== null;
}

/** Did the event start inside the editor? composedPath() sees through the
 *  inspector's shadow root; event.target alone depends on retargeting. */
function fromEditor(e: Event): boolean {
  const path = typeof e.composedPath === "function" ? e.composedPath() : [];
  return path.some((n) => n instanceof Element && n.hasAttribute(EDITOR_ATTR)) || isEditorNode(e.target);
}

/** Bring every element in line with the enabled patches, and undo what a
 *  removed/disabled patch had done (we remember what we changed). */
export function applyClassPatches(): void {
  if (typeof document === "undefined") return;
  const desired = new Map<Element, Touched>();
  if (!stylesSuspended()) {
    for (const patch of effective().classes) {
      if (!patch.enabled) continue;
      let found: Element[];
      try { found = Array.from(document.querySelectorAll(patch.selector)); } catch { continue; }
      // An element this patch already changed stays its target even if the
      // change itself makes the selector stop matching (removing a class the
      // selector names) — otherwise remove / re-add would loop forever.
      for (const [el, t] of touched) if (t.patches.has(patch.id) && el.isConnected && !found.includes(el)) found.push(el);
      for (const el of found) {
        if (isEditorNode(el)) continue;
        const d = desired.get(el) ?? { added: new Set<string>(), removed: new Set<string>(), patches: new Set<string>() };
        patch.add.forEach((c) => d.added.add(c));
        patch.remove.forEach((c) => d.removed.add(c));
        d.patches.add(patch.id);
        desired.set(el, d);
      }
    }
  }
  // Revert what is no longer wanted.
  for (const [el, t] of touched) {
    const d = desired.get(el);
    t.added.forEach((c) => { if (!d?.added.has(c)) el.classList.remove(c); });
    t.removed.forEach((c) => { if (!d?.removed.has(c)) el.classList.add(c); });
    if (!el.isConnected || !d) touched.delete(el);
  }
  for (const [el, d] of desired) {
    const t = touched.get(el) ?? { added: new Set<string>(), removed: new Set<string>(), patches: new Set<string>() };
    t.patches = new Set(d.patches);
    d.added.forEach((c) => {
      if (!el.classList.contains(c)) { el.classList.add(c); t.added.add(c); }
      else if (!t.added.has(c) && !t.removed.has(c)) { /* already there by itself — not ours */ }
    });
    d.removed.forEach((c) => {
      if (el.classList.contains(c)) { el.classList.remove(c); t.removed.add(c); }
    });
    t.added.forEach((c) => { if (!d.added.has(c)) t.added.delete(c); });
    t.removed.forEach((c) => { if (!d.removed.has(c)) t.removed.delete(c); });
    if (t.added.size || t.removed.size) touched.set(el, t);
  }
}

/** Observe the DOM only while there is something to keep applied: React
 *  re-renders rewrite className, so patches are re-applied on the next frame. */
function syncClassPatches() {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
  applyClassPatches();
  const needed = !stylesSuspended() && effective().classes.some((p) => p.enabled);
  if (needed && !patchObserver) {
    patchObserver = new MutationObserver(() => {
      if (patchFrame) return;
      patchFrame = requestAnimationFrame(() => { patchFrame = 0; applyClassPatches(); });
    });
    patchObserver.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
  } else if (!needed && patchObserver) {
    patchObserver.disconnect();
    patchObserver = null;
  }
}

/** Mount the override layer; keeps it last when other sheets are added. */
export function startStyleRuntime(): () => void {
  if (typeof document === "undefined") return () => {};
  applyUserStyles();
  const headObserver = new MutationObserver(() => keepLast());
  headObserver.observe(document.head, { childList: true });
  return () => {
    headObserver.disconnect();
    patchObserver?.disconnect();
    patchObserver = null;
  };
}

/* ---------------------------------------------------------------- picker */

export type PickerOptions = {
  onPick: (el: Element) => void;
  /** Mouse hover while Ctrl is held (or tap-to-pick is armed): highlight target. */
  onHover?: (el: Element | null) => void;
};

export type Picker = {
  destroy: () => void;
  /** Next click / tap anywhere (outside the editor) picks that element. */
  armTapPick: (on: boolean) => void;
  isArmed: () => boolean;
};

const LONG_PRESS_MS = 520;
const MOVE_TOLERANCE = 10;

/** SVG icon parts resolve to their <svg>; text nodes to their element. */
export function pickTarget(t: EventTarget | null): Element | null {
  if (!(t instanceof Element)) return null;
  if (t instanceof SVGElement && !(t instanceof SVGSVGElement)) return t.closest("svg") ?? t;
  return t;
}

export function createPicker(opts: PickerOptions): Picker {
  let armed = false;
  let ctrlDown = false;
  let timer: ReturnType<typeof setTimeout> | 0 = 0;
  let press: { id: number; x: number; y: number; target: Element; type: string; at: number } | null = null;
  let suppressClickUntil = 0;
  // -Infinity, not 0: performance.now() starts at page load, so a 0 here made
  // a Ctrl + right click in the first 1.5 s look like a touch long press.
  let lastTouchAt = Number.NEGATIVE_INFINITY;

  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  const cancelPress = () => { if (timer) clearTimeout(timer); timer = 0; press = null; };
  const pick = (el: Element | null) => {
    if (!el || isEditorNode(el)) return;
    opts.onHover?.(null);
    opts.onPick(el);
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === "mouse") return;
    lastTouchAt = now();
    if (fromEditor(e)) return;
    const target = pickTarget(e.target);
    if (!target) return;
    cancelPress();
    press = { id: e.pointerId, x: e.clientX, y: e.clientY, target, type: e.pointerType, at: now() };
    timer = setTimeout(() => {
      timer = 0;
      if (!press) return;
      const el = press.target;
      press = null;
      suppressClickUntil = now() + 1200;
      try { navigator.vibrate?.(12); } catch { /* not supported */ }
      pick(el);
    }, LONG_PRESS_MS);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (press && e.pointerId === press.id && Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_TOLERANCE) cancelPress();
    if (e.pointerType === "mouse" && (ctrlDown || armed)) {
      const el = pickTarget(document.elementFromPoint(e.clientX, e.clientY));
      opts.onHover?.(el && !isEditorNode(el) ? el : null);
    }
  };
  const onPointerEnd = (e: PointerEvent) => { if (press && e.pointerId === press.id) cancelPress(); };
  const onClick = (e: MouseEvent) => {
    if (fromEditor(e)) return;
    if (now() < suppressClickUntil) {
      suppressClickUntil = 0;
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (armed) {
      e.preventDefault();
      e.stopImmediatePropagation();
      armed = false;
      pick(pickTarget(e.target));
    }
  };
  const onContextMenu = (e: MouseEvent) => {
    if (fromEditor(e)) return;
    const fromTouch = now() - lastTouchAt < 1500;
    if (e.ctrlKey && !fromTouch) {
      e.preventDefault();
      e.stopImmediatePropagation();
      suppressClickUntil = now() + 400; // macOS: Ctrl+click is also a context-menu gesture
      pick(pickTarget(e.target));
      return;
    }
    if (fromTouch) {
      // Android fires contextmenu on a long press: no native menu in Edit Mode.
      e.preventDefault();
      if (press) {
        const el = press.target;
        cancelPress();
        suppressClickUntil = now() + 1200;
        pick(el);
      }
    }
  };
  const onKey = (e: KeyboardEvent) => {
    const down = e.type === "keydown";
    if (e.key === "Control") { ctrlDown = down; if (!down && !armed) opts.onHover?.(null); }
    if (down && e.key === "Escape" && armed) { armed = false; opts.onHover?.(null); }
  };
  const onBlur = () => { ctrlDown = false; cancelPress(); opts.onHover?.(null); };
  const onScroll = () => cancelPress();

  const cap = { capture: true } as const;
  window.addEventListener("pointerdown", onPointerDown, cap);
  window.addEventListener("pointermove", onPointerMove, cap);
  window.addEventListener("pointerup", onPointerEnd, cap);
  window.addEventListener("pointercancel", onPointerEnd, cap);
  window.addEventListener("click", onClick, cap);
  window.addEventListener("contextmenu", onContextMenu, cap);
  window.addEventListener("keydown", onKey, cap);
  window.addEventListener("keyup", onKey, cap);
  window.addEventListener("blur", onBlur);
  window.addEventListener("scroll", onScroll, { capture: true, passive: true });

  return {
    destroy() {
      cancelPress();
      window.removeEventListener("pointerdown", onPointerDown, cap);
      window.removeEventListener("pointermove", onPointerMove, cap);
      window.removeEventListener("pointerup", onPointerEnd, cap);
      window.removeEventListener("pointercancel", onPointerEnd, cap);
      window.removeEventListener("click", onClick, cap);
      window.removeEventListener("contextmenu", onContextMenu, cap);
      window.removeEventListener("keydown", onKey, cap);
      window.removeEventListener("keyup", onKey, cap);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("scroll", onScroll, cap);
    },
    armTapPick(on: boolean) { armed = on; if (!on) opts.onHover?.(null); },
    isArmed: () => armed,
  };
}

/* ------------------------------------------------------------ selectors */

const UTILITY = /^(?:-?(?:m|p)[trblxyse]?-|flex$|flex-|grid$|grid-|block$|inline|hidden$|contents$|items-|justify-|content-|self-|place-|gap-|space-|text-|font-|leading-|tracking-|bg-|border|rounded|shadow|w-|h-|min-|max-|size-|overflow|z-|opacity-|ring|outline|transition|duration-|delay-|ease-|cursor-|select-|sr-only$|not-sr-only$|absolute$|relative$|fixed$|sticky$|static$|inset|top-|left-|right-|bottom-|start-|end-|col-|row-|order-|basis-|grow|shrink|truncate$|uppercase$|lowercase$|capitalize$|normal-case$|italic$|not-italic$|underline|no-underline$|line-through$|decoration-|backdrop-|blur|brightness-|antialiased$|subpixel-antialiased$|whitespace-|break-|aspect-|object-|fill-|stroke-|translate-|rotate-|scale-|skew-|origin-|transform|animate-|pointer-events-|visible$|invisible$|collapse$|container$|shrink-|list-|appearance-|resize|table|divide-|from-|to-|via-|accent-|caret-|dark$|isolate$|isolation-|mix-blend-|filter$|drop-shadow|align-|float-|clear-|box-|tabular-nums$|ordinal$|slashed-zero$|proportional-nums$|lining-nums$|oldstyle-nums$|diagonal-fractions$|group$|peer$|will-change-)/;

export function isUtilityClass(c: string): boolean {
  return /[:/[\].]/.test(c) || UTILITY.test(c);
}

const cssEscape = (s: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/([^\w-])/g, "\\$1"));
const attrValue = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export function countMatches(selector: string): number {
  try { return document.querySelectorAll(selector).length; } catch { return -1; }
}

export function describeElement(el: Element): string {
  const id = el.id && !/[:\s]/.test(el.id) ? `#${el.id}` : "";
  const cls = Array.from(el.classList).filter((c) => !isUtilityClass(c)).slice(0, 2).map((c) => `.${c}`).join("");
  const any = cls || (el.classList.length ? `.${el.classList[0]}` : "");
  return `${el.localName}${id}${any}`;
}

function step(el: Element): string {
  const tid = el.getAttribute("data-testid");
  if (tid) return `[data-testid="${attrValue(tid)}"]`;
  if (el.id && !/[:\s]/.test(el.id) && !/^\d/.test(el.id)) return `#${cssEscape(el.id)}`;
  const tag = el.localName;
  const semantic = Array.from(el.classList).filter((c) => !isUtilityClass(c)).slice(0, 2).map((c) => `.${cssEscape(c)}`).join("");
  let s = `${tag}${semantic}`;
  const parent = el.parentElement;
  if (parent) {
    const siblings = Array.from(parent.children);
    const alike = siblings.filter((c) => { try { return c.matches(s); } catch { return false; } });
    if (alike.length > 1) {
      const sameTag = siblings.filter((c) => c.localName === tag);
      s = `${s}:nth-of-type(${sameTag.indexOf(el) + 1})`;
    }
  }
  return s;
}

/** A step that stays meaningful as the page changes: a test id, an id or a
 *  semantic class — not a bare tag / position. */
const isAnchor = (s: string) => s.startsWith("[data-testid") || s.startsWith("#") || /^[a-z][\w-]*\./i.test(s);

/** Shortest selector (from the element up) that matches exactly this element
 *  AND is anchored: a bare "h3" may be unique right now, but a saved rule for
 *  it would also hit the next h3 a dialog renders. */
export function uniqueSelector(el: Element): string {
  if (el === document.documentElement) return ":root";
  if (el === document.body) return "body";
  const path: string[] = [];
  let node: Element | null = el;
  while (node && node !== document.documentElement && path.length < 14) {
    path.unshift(step(node));
    const sel = path.join(" > ");
    if (countMatches(sel) === 1 && path.some(isAnchor)) return sel;
    node = node.parentElement;
  }
  return path.join(" > ");
}

export type SelectorOption = { selector: string; label: string; count: number; kind: "unique" | "testid" | "class" | "classes" | "tag" };

/** Scopes an edit can apply to: exactly this element, its test id, each of
 *  its (non-utility) classes, the class combination, or the tag. */
export function selectorOptions(el: Element): SelectorOption[] {
  const out: SelectorOption[] = [];
  const push = (selector: string, label: string, kind: SelectorOption["kind"]) => {
    if (!selector || out.some((o) => o.selector === selector)) return;
    out.push({ selector, label, kind, count: countMatches(selector) });
  };
  push(uniqueSelector(el), "unique", "unique");
  const tid = el.getAttribute("data-testid");
  if (tid) push(`[data-testid="${attrValue(tid)}"]`, "testid", "testid");
  const classes = Array.from(el.classList).filter((c) => !isUtilityClass(c));
  classes.slice(0, 8).forEach((c) => push(`.${cssEscape(c)}`, "class", "class"));
  if (classes.length > 1) push(classes.slice(0, 3).map((c) => `.${cssEscape(c)}`).join(""), "classes", "classes");
  if (classes[0]) push(`${el.localName}.${cssEscape(classes[0])}`, "classes", "classes");
  push(el.localName, "tag", "tag");
  return out;
}

/* --------------------------------------------------------- rule lookup */

export type MatchedRule = {
  selector: string;      // the matching part of the selector list
  state: string;         // ":hover" etc. present in that part
  declarations: string;  // CSSOM cssText of the rule
  media: string;         // enclosing @media / @supports text, "" if none
  source: string;        // stylesheet label
  user: boolean;         // one of ours
  specificity: [number, number, number];
  order: number;
};

export function specificity(selector: string): [number, number, number] {
  let s = selector.replace(/:(?:not|is|has)\(([^()]*)\)/g, " $1").replace(/:where\([^()]*\)/g, "");
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  s = s.replace(/#[\w-]+/g, "");
  const cls = (s.match(/\.[\w\\:/[\]-]+|\[[^\]]*\]|:(?!:)[\w-]+(\([^)]*\))?/g) ?? []).length;
  s = s.replace(/\.[\w\\:/[\]-]+|\[[^\]]*\]|:(?!:)[\w-]+(\([^)]*\))?/g, "");
  const types = (s.match(/(^|[\s>+~])[a-z][\w-]*|::[\w-]+/gi) ?? []).length;
  return [ids, cls, types];
}

function sheetLabel(sheet: CSSStyleSheet): { label: string; user: boolean } {
  const owner = sheet.ownerNode as Element | null;
  const id = owner?.id ?? "";
  if (id === USER_STYLE_ID) return { label: "M5cet user styles", user: true };
  const devId = owner?.getAttribute?.("data-vite-dev-id");
  if (devId) return { label: devId.split("/").pop() ?? "style", user: false };
  if (sheet.href) return { label: sheet.href.split("/").pop()?.split("?")[0] ?? "stylesheet", user: false };
  return { label: "<style>", user: false };
}

type RuleVisitor = (rule: CSSStyleRule, media: string, source: { label: string; user: boolean }, order: number) => void;

function walkRules(visit: RuleVisitor) {
  let order = 0;
  const walk = (rules: CSSRuleList, media: string, source: { label: string; user: boolean }) => {
    for (const rule of Array.from(rules)) {
      order++;
      if (rule instanceof CSSStyleRule) { visit(rule, media, source, order); continue; }
      if (typeof CSSMediaRule !== "undefined" && rule instanceof CSSMediaRule) {
        let ok = true;
        try { ok = matchMedia(rule.conditionText || rule.media.mediaText).matches; } catch { ok = true; }
        if (ok) walk(rule.cssRules, `@media ${rule.conditionText || rule.media.mediaText}`, source);
        continue;
      }
      if (typeof CSSSupportsRule !== "undefined" && rule instanceof CSSSupportsRule) {
        let ok = true;
        try { ok = CSS.supports(rule.conditionText); } catch { ok = true; }
        if (ok) walk(rule.cssRules, `@supports ${rule.conditionText}`, source);
        continue;
      }
      const nested = (rule as CSSGroupingRule).cssRules;
      if (nested) walk(nested, media, source);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; } // cross-origin (Google Fonts)
    walk(rules, "", sheetLabel(sheet));
  }
}

export function matchedRules(el: Element, limit = 60): MatchedRule[] {
  if (typeof document === "undefined") return [];
  const out: MatchedRule[] = [];
  const seen = new Set<string>();
  walkRules((rule, media, source, order) => {
    for (const part of splitSelectorList(rule.selectorText)) {
      const base = baseSelector(part);
      let hit = false;
      try { hit = el.matches(base); } catch { hit = false; }
      if (!hit) continue;
      const declarations = rule.style.cssText;
      if (!declarations.trim()) continue;
      const key = `${part}|${media}|${declarations}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ selector: part, state: stateOf(part), declarations, media, source: source.label, user: source.user, specificity: specificity(part), order });
    }
  });
  out.sort((a, b) => {
    for (let i = 0; i < 3; i++) if (a.specificity[i] !== b.specificity[i]) return b.specificity[i] - a.specificity[i];
    return b.order - a.order;
  });
  return out.slice(0, limit);
}

let classCache: { sig: string; names: string[] } | null = null;

/** Every class name the loaded stylesheets define (Tailwind escapes undone). */
export function stylesheetClasses(): string[] {
  if (typeof document === "undefined") return [];
  const sig = Array.from(document.styleSheets).map((s) => { try { return s.cssRules.length; } catch { return 0; } }).join(",");
  if (classCache?.sig === sig) return classCache.names;
  const names = new Set<string>();
  walkRules((rule) => {
    for (const m of rule.selectorText.matchAll(/\.((?:\\.|[\w-])+)/g)) {
      names.add(m[1].replace(/\\(.)/g, "$1"));
    }
  });
  const sorted = Array.from(names).sort((a, b) => Number(isUtilityClass(a)) - Number(isUtilityClass(b)) || a.localeCompare(b));
  classCache = { sig, names: sorted };
  return sorted;
}

/** The rules whose selector is exactly this class (optionally with a state). */
export function classRules(name: string): MatchedRule[] {
  if (typeof document === "undefined") return [];
  const escaped = `.${cssEscape(name)}`;
  const out: MatchedRule[] = [];
  walkRules((rule, media, source, order) => {
    for (const part of splitSelectorList(rule.selectorText)) {
      if (baseSelector(part) !== escaped) continue;
      out.push({ selector: part, state: stateOf(part), declarations: rule.style.cssText, media, source: source.label, user: source.user, specificity: specificity(part), order });
    }
  });
  return out;
}

/* -------------------------------------------------------------- computed */

export const COMPUTED_PROPS = [
  "display", "position", "box-sizing", "width", "height", "font-family", "font-size", "font-weight", "line-height",
  "letter-spacing", "color", "background-color", "background-image", "border-top", "border-radius", "box-shadow",
  "opacity", "z-index", "overflow", "cursor", "transition",
] as const;

export function computedSnapshot(el: Element): Array<{ prop: string; value: string }> {
  const cs = getComputedStyle(el);
  return COMPUTED_PROPS.map((prop) => ({ prop, value: cs.getPropertyValue(prop) }));
}

export type BoxModel = {
  margin: [number, number, number, number];
  border: [number, number, number, number];
  padding: [number, number, number, number];
  width: number;
  height: number;
};

export function boxModel(el: Element): BoxModel {
  const cs = getComputedStyle(el);
  const four = (p: string, suffix = ""): [number, number, number, number] =>
    (["top", "right", "bottom", "left"] as const).map((s) => parseFloat(cs.getPropertyValue(`${p}-${s}${suffix}`)) || 0) as [number, number, number, number];
  const rect = el.getBoundingClientRect();
  return { margin: four("margin"), border: four("border", "-width"), padding: four("padding"), width: rect.width, height: rect.height };
}
