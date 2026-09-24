// Accessibility checks for the Layout builder (4.13).
//
//   checkTree   the design itself (PURE): images without alt text, buttons
//               and links with no name, fields with no label, clicks on
//               elements a keyboard cannot reach, tabindex > 0, repeated
//               ids, skipped heading levels, …
//   checkDom    what the preview drew (needs a DOM): the accessible name of
//               every control as a browser computes it, labels of fields,
//               and the contrast of every text against what is really
//               behind it (WCAG 2.2: 4.5:1, large text 3:1).
//
// An issue points at the element of the tree (its id), so the builder can
// select it.

import { walkTree, type LNode } from "./layout-tree";

export type A11ySeverity = "error" | "warning" | "info";
export type A11yIssue = { id: string; rule: string; severity: A11ySeverity; message: string };

const fixed = (v: string | undefined) => v !== undefined && !v.startsWith("=") && !v.includes("{");
/** A value that is there: a literal that is not empty, or one computed from data (unknown here: assumed there). */
const present = (v: string | undefined) => v !== undefined && (!fixed(v) || v.trim() !== "");
const INTERACTIVE_EL = new Set(["button", "link", "input", "textarea", "select", "option", "label", "form"]);
const WIDGET_ROLES = new Set(["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "slider", "spinbutton", "textbox", "combobox", "treeitem", "gridcell"]);
const UNLABELLED_INPUTS = new Set(["hidden", "submit", "button", "reset", "image"]);

/** Whether a subtree says something (text, a named icon, a live part — assumed to). */
function speaks(n: LNode, blocks: Record<string, LNode>, depth = 0): boolean {
  if (depth > 20 || n.hidden) return false;
  if (n.el === "slot" || n.el === "html" || n.el === "avatar") return true;
  if (n.el === "block") return Boolean(n.block && blocks[n.block] && speaks(blocks[n.block], blocks, depth + 1));
  if (n.el === "image") return present(n.attrs?.alt);
  if (n.el === "icon" || n.el === "logo") return present(n.attrs?.["aria-label"]) || present(n.attrs?.title);
  if (present(n.text) && n.el !== "input") return true;
  if (present(n.attrs?.["aria-label"]) || present(n.attrs?.["aria-labelledby"])) return true;
  return (n.children ?? []).some((c) => speaks(c, blocks, depth + 1));
}

/** Checks a layout tree (and the templates it uses are checked where they are defined). */
export function checkTree(tree: LNode, blocks: Record<string, LNode> = {}): A11yIssue[] {
  const out: A11yIssue[] = [];
  const add = (id: string, rule: string, severity: A11ySeverity, message: string) => out.push({ id, rule, severity, message });
  // Labels in the tree: <label for="x"> and fields inside a label.
  const labelFor = new Set<string>();
  const insideLabel = new Set<string>();
  walkTree(tree, (n) => {
    if (n.el !== "label") return;
    if (n.attrs?.for) labelFor.add(n.attrs.for);
    walkTree(n, (c) => { if (c !== n) insideLabel.add(c.id); });
  });
  const ids = new Map<string, string>();
  let lastHeading = 0;
  walkTree(tree, (n) => {
    if (n.hidden) return;
    const a = n.attrs ?? {};
    const tag = n.tag ?? "";
    const named = present(a["aria-label"]) || present(a["aria-labelledby"]) || present(a.title);
    if (a.id && fixed(a.id)) {
      if (ids.has(a.id)) add(n.id, "duplicate-id", "error", `id="${a.id}" is used twice (also by ${ids.get(a.id)}) — labels and ARIA references break.`);
      else ids.set(a.id, n.id);
    }
    if (n.el === "image" && a.alt === undefined) add(n.id, "img-alt", "error", "An image needs alt text — alt=\"\" when it is only decoration.");
    if ((n.el === "button" || n.el === "link") && !named && !speaks({ ...n, attrs: {} }, blocks)) {
      add(n.id, "control-name", "error", `This ${n.el} has no name a screen reader can say: give it text, or aria-label (an icon alone says nothing).`);
    }
    if (n.el === "link" && a.href === undefined && !a.role) add(n.id, "link-href", "warning", "A link without href cannot be reached with the keyboard — a Button fits an action better.");
    // rel="noreferrer" implies noopener (HTML: "noreferrer" also sets the opener to null).
    if (n.el === "link" && a.target === "_blank" && !/(^|\s)no(opener|referrer)(\s|$)/.test(a.rel ?? "")) add(n.id, "blank-noopener", "info", "target=\"_blank\" without rel=\"noopener\": the opened page can reach this one.");
    // Not drawn at all (display: none, hidden): nothing to label.
    const undrawn = (a.hidden !== undefined && a.hidden !== "=false") || /(^|\s)hidden(\s|$)/.test(a.class ?? "") || a["aria-hidden"] === "true";
    if ((n.el === "input" || n.el === "textarea" || n.el === "select") && !undrawn && !named && !insideLabel.has(n.id) && !(a.id && labelFor.has(a.id))) {
      if (!(n.el === "input" && UNLABELLED_INPUTS.has(a.type ?? ""))) {
        add(n.id, "field-label", "warning", `This ${n.el === "select" ? "select" : "field"} has no label (a placeholder is not one): wrap it in a Label, point a Label's for at its id, or set aria-label.`);
      }
    }
    if (n.on?.click && !INTERACTIVE_EL.has(n.el) && !["button", "a", "input", "select", "textarea", "summary"].includes(tag)) {
      const role = a.role ?? "";
      if (!WIDGET_ROLES.has(role) || a.tabindex === undefined) {
        add(n.id, "click-keyboard", "warning", "A click on an element that is not a control: keyboard users cannot reach it. Use a Button, or give it role=\"button\" and tabindex=\"0\" (and a keydown).");
      }
    }
    if (a.tabindex && fixed(a.tabindex) && Number(a.tabindex) > 0) add(n.id, "tabindex-positive", "warning", `tabindex="${a.tabindex}" changes the keyboard order of the whole page — use 0 or -1.`);
    if (a["aria-hidden"] === "true" && (INTERACTIVE_EL.has(n.el) || a.tabindex === "0")) add(n.id, "hidden-focusable", "error", "aria-hidden on something that takes focus: the keyboard reaches it, a screen reader does not.");
    if (n.el === "audio" && a.autoplay !== undefined && a.autoplay !== "=false") add(n.id, "autoplay", "warning", "Sound that plays by itself is hard to stop with a screen reader.");
    if (n.el === "heading") {
      const level = Number(/^h([1-6])$/.exec(tag)?.[1] ?? 0);
      if (!speaks({ ...n, attrs: {} }, blocks)) add(n.id, "heading-empty", "warning", "An empty heading.");
      if (level && lastHeading && level > lastHeading + 1) add(n.id, "heading-order", "info", `h${lastHeading} → h${level}: a level skipped (screen readers navigate by them).`);
      if (level) lastHeading = level;
    }
  });
  return out;
}

/* ------------------------------------------------------------ contrast */

export type Rgba = [number, number, number, number];

/** A computed CSS colour ("rgb(…)", "rgba(…)", "#rrggbb", "transparent", "color(srgb …)") → RGBA; null when unknown. */
export function parseCssColor(v: string): Rgba | null {
  const s = v.trim().toLowerCase();
  if (s === "transparent") return [0, 0, 0, 0];
  let m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    const alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
    return [Number(m[1]), Number(m[2]), Number(m[3]), alpha];
  }
  m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    const h = m[1];
    const full = h.length <= 4 ? h.split("").map((c) => c + c).join("") : h;
    const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), full.length === 8 ? n(6) / 255 : 1];
  }
  m = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    const alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
    return [Number(m[1]) * 255, Number(m[2]) * 255, Number(m[3]) * 255, alpha];
  }
  return null;
}

/** `top` painted over an opaque `bottom`. */
export function composite(top: Rgba, bottom: Rgba): Rgba {
  const a = top[3];
  return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
}

function luminance([r, g, b]: Rgba): number {
  const ch = (c: number) => { const x = c / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/** WCAG contrast ratio of two opaque colours (1–21). */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const hex = (c: Rgba) => `#${c.slice(0, 3).map((x) => Math.round(x).toString(16).padStart(2, "0")).join("")}`;

/* ------------------------------------------------------------ the DOM */

type Style = { color: string; backgroundColor: string; backgroundImage: string; fontSize: string; fontWeight: string; opacity: string; visibility: string; display: string };

/** The accessible name of a control, roughly as a browser computes it. */
export function accessibleName(el: Element): string {
  const aria = el.getAttribute("aria-label");
  if (aria && aria.trim()) return aria.trim();
  const by = el.getAttribute("aria-labelledby");
  if (by) {
    const text = by.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.textContent ?? "").join(" ").trim();
    if (text) return text;
  }
  const own = (node: Node): string => {
    if (node.nodeType === 3) return node.textContent ?? "";
    if (node.nodeType !== 1) return "";
    const e = node as Element;
    if (e.getAttribute("aria-hidden") === "true") return "";
    if (e.tagName === "IMG") return e.getAttribute("alt") ?? "";
    if (e.tagName.toLowerCase() === "svg") return e.getAttribute("aria-label") ?? e.querySelector("title")?.textContent ?? "";
    const label = e.getAttribute("aria-label");
    if (label) return label;
    return Array.from(e.childNodes).map(own).join(" ");
  };
  const text = own(el).replace(/\s+/g, " ").trim();
  if (text) return text;
  if ((el.tagName === "INPUT" && ["submit", "button", "reset"].includes((el as HTMLInputElement).type))) return (el as HTMLInputElement).value;
  return (el.getAttribute("title") ?? "").trim();
}

function hasLabel(el: Element): boolean {
  if ((el.getAttribute("aria-label") ?? "").trim() || el.getAttribute("aria-labelledby") || (el.getAttribute("title") ?? "").trim()) return true;
  if (el.closest("label")) return true;
  const id = el.getAttribute("id");
  return Boolean(id && el.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`));
}

/**
 * Checks what the preview drew: names, labels, contrast. `root` is the drawn
 * layout; issues point at the nearest element with data-lb-id.
 */
export function checkDom(root: Element, style: (el: Element) => Style = (el) => getComputedStyle(el) as unknown as Style): A11yIssue[] {
  const out: A11yIssue[] = [];
  const seen = new Set<string>();
  const idOf = (el: Element) => el.closest("[data-lb-id]")?.getAttribute("data-lb-id") ?? "";
  const add = (el: Element, rule: string, severity: A11ySeverity, message: string) => {
    const id = idOf(el);
    const key = `${id}:${rule}`;
    if (!id || seen.has(key)) return;
    seen.add(key);
    out.push({ id, rule, severity, message });
  };
  const visible = (el: Element) => {
    for (let e: Element | null = el; e && e !== root.parentElement; e = e.parentElement) {
      const st = style(e);
      if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return false;
    }
    return true;
  };
  for (const el of Array.from(root.querySelectorAll("button, a[href], [role=button], [role=link], [role=tab], [role=menuitem]"))) {
    if (visible(el) && !accessibleName(el)) add(el, "control-name", "error", "Drawn without a name a screen reader can say (text, aria-label or title).");
  }
  for (const el of Array.from(root.querySelectorAll("img"))) {
    if (!el.hasAttribute("alt")) add(el, "img-alt", "error", "An image drawn without alt text.");
  }
  for (const el of Array.from(root.querySelectorAll("input, select, textarea"))) {
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    if (UNLABELLED_INPUTS.has(type) || !visible(el)) continue;
    if (!hasLabel(el)) add(el, "field-label", "warning", "A field drawn without a label.");
  }
  // Contrast of every text against what is behind it.
  const background = (el: Element): Rgba | null => {
    const layers: Rgba[] = [];
    for (let e: Element | null = el; e; e = e.parentElement) {
      const st = style(e);
      if (st.backgroundImage && st.backgroundImage !== "none") return null; // a gradient or a picture: not measurable here
      const c = parseCssColor(st.backgroundColor);
      if (!c) return null;
      if (c[3] > 0) layers.push(c);
      if (c[3] >= 1) break;
    }
    let bg: Rgba = [255, 255, 255, 1];
    for (let i = layers.length - 1; i >= 0; i--) bg = composite(layers[i], bg);
    return bg;
  };
  for (const el of Array.from(root.querySelectorAll("*"))) {
    const text = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim());
    if (!text || !visible(el)) continue;
    const st = style(el);
    const fg = parseCssColor(st.color);
    const bg = background(el);
    if (!fg || !bg) continue;
    const color = composite(fg, bg);
    const ratio = contrastRatio(color, bg);
    const size = parseFloat(st.fontSize) || 16;
    const bold = Number(st.fontWeight) >= 700 || st.fontWeight === "bold";
    const large = size >= 24 || (bold && size >= 18.66);
    const need = large ? 3 : 4.5;
    if (ratio + 1e-6 < need) {
      add(el, "contrast", ratio < need - 1 ? "error" : "warning", `Contrast ${ratio.toFixed(2)}:1 (${hex(color)} on ${hex(bg)}) — WCAG asks ${need}:1${large ? " for large text" : ""}.`);
    }
  }
  return out;
}
