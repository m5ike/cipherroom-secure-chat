// The Layout builder's element trees (4.0.5) — what the console's GUI
// designer edits and LayoutView.tsx renders. PURE module (no DOM, no Node):
// the server validates and stores trees with it, the client renders them.
//
// A layout is a tree of nodes. Each node is an element of the PALETTE
// (panel, area, text, button, input, icon, slot…) with:
//
//   tag        the HTML element (a panel is a div, a section, a header…)
//   text       its text — a template: "{$message.senderName}", "{_'menu.room'}"
//   attrs      HTML attributes in order; a value is template text, or an
//              expression when it starts with "=" ("=$openPeerCount == 0")
//   css        CSS properties → template values ("display": "flex")
//   style      the designer's style with states (hover, click, focus,
//              current) — the same model as the Menu builder (menu-config.ts)
//   styleBind  an expression giving CSS the app computes (a bubble's colours)
//   if / each  show only when…, repeat for each item of a list
//   on         events → actions of the component ("click": "reply")
//   ref        a handle the component keeps (focus, scrolling, measuring)
//   slot       a live part the component draws itself (a sub-component)
//   block      a reusable template of elements (saved in the builder)
//
// Everything an operator stores goes through sanitizeTree(): known elements
// and tags, safe attributes and URLs, CSS without url() or expressions, no
// inline event handlers. The renderer never uses innerHTML.

import { sanitizeStyle, type ElementStyle } from "./menu-config";

/* ------------------------------------------------------------- palette */

export type ElementKind =
  | "panel" | "area" | "row" | "column" | "grid" | "list" | "item" | "group"
  | "table" | "tableSection" | "tableRow" | "tableCell"
  | "text" | "heading" | "paragraph" | "label" | "link" | "icon" | "image" | "audio" | "video" | "logo" | "avatar" | "html" | "separator"
  | "button" | "input" | "textarea" | "select" | "option" | "form"
  | "slot" | "block";

export type PropDef = {
  key: string;
  label: string;
  kind: "text" | "expr" | "number" | "bool" | "icon" | "select";
  options?: readonly string[];
  hint?: string;
};

export type ElementDef = {
  el: ElementKind;
  label: string;
  group: "layout" | "content" | "controls" | "logic";
  /** An icon of the menu catalog for the palette. */
  icon: string;
  hint: string;
  /** The default tag, and the tags it may be. None: renders no element of its own. */
  tag?: string;
  tags?: readonly string[];
  /** Takes children. */
  container: boolean;
  /** What `text` holds: a text template, safe HTML, or nothing. */
  text?: "template" | "html";
  /** Element parameters (not HTML attributes). */
  props?: readonly PropDef[];
  /** What a new element starts with. */
  preset?: Partial<LNode>;
};

const BLOCK_TAGS = ["div", "section", "article", "header", "footer", "main", "nav", "aside", "figure", "figcaption", "details", "summary", "fieldset", "legend", "blockquote", "address"] as const;
const INLINE_TAGS = ["span", "strong", "em", "b", "i", "u", "s", "small", "code", "kbd", "mark", "abbr", "time", "sup", "sub", "q", "cite", "bdi", "output", "data", "var", "samp", "del", "ins"] as const;

export const ELEMENTS: readonly ElementDef[] = [
  { el: "panel", label: "Panel", group: "layout", icon: "square", hint: "A block (<div>) holding other elements", tag: "div", tags: BLOCK_TAGS, container: true },
  { el: "area", label: "Area", group: "layout", icon: "minus", hint: "An inline span (<span>) holding text and elements", tag: "span", tags: INLINE_TAGS, container: true },
  { el: "row", label: "Row", group: "layout", icon: "columns-2", hint: "A flex row: children side by side", tag: "div", tags: BLOCK_TAGS, container: true, preset: { attrs: { class: "flex items-center gap-2" } } },
  { el: "column", label: "Column", group: "layout", icon: "rows-2", hint: "A flex column: children one under another", tag: "div", tags: BLOCK_TAGS, container: true, preset: { attrs: { class: "flex flex-col gap-2" } } },
  { el: "grid", label: "Grid", group: "layout", icon: "layout-grid", hint: "A CSS grid", tag: "div", tags: BLOCK_TAGS, container: true, preset: { attrs: { class: "grid grid-cols-1 gap-2 md:grid-cols-2" } } },
  { el: "list", label: "List", group: "layout", icon: "list", hint: "A list (<ul> or <ol>) of items", tag: "ul", tags: ["ul", "ol", "menu"], container: true },
  { el: "item", label: "List item", group: "layout", icon: "circle-dot", hint: "One <li> of a list", tag: "li", tags: ["li"], container: true },
  { el: "group", label: "Group", group: "layout", icon: "layers", hint: "Groups elements without an element of its own (for a condition or a repeat)", container: true },
  // 4.13: tables (the version check's list, and whatever an operator lays out in rows and columns)
  { el: "table", label: "Table", group: "layout", icon: "layout-grid", hint: "A table (<table>): head, body and foot sections of rows", tag: "table", tags: ["table"], container: true },
  { el: "tableSection", label: "Table section", group: "layout", icon: "rows-2", hint: "The head, body or foot of a table (<thead>, <tbody>, <tfoot>)", tag: "tbody", tags: ["thead", "tbody", "tfoot"], container: true },
  { el: "tableRow", label: "Table row", group: "layout", icon: "minus", hint: "A row of a table (<tr>) — repeat it for a list", tag: "tr", tags: ["tr"], container: true },
  { el: "tableCell", label: "Table cell", group: "layout", icon: "square", hint: "A cell (<td>, or <th> for a heading)", tag: "td", tags: ["td", "th"], container: true, text: "template" },
  {
    el: "text", label: "Text", group: "content", icon: "file-text", hint: "Text with {$variables} — no element of its own", container: false, text: "template",
    props: [{ key: "format", label: "Format", kind: "select", options: ["", "links"], hint: "links: web addresses become links" }],
    preset: { text: "Text" },
  },
  { el: "heading", label: "Heading", group: "content", icon: "hash", hint: "A heading h1–h6", tag: "h3", tags: ["h1", "h2", "h3", "h4", "h5", "h6"], container: true, text: "template", preset: { text: "Heading" } },
  { el: "paragraph", label: "Paragraph", group: "content", icon: "newspaper", hint: "A paragraph (<p>)", tag: "p", tags: ["p", "div", "span", "blockquote", "pre"], container: true, text: "template", preset: { text: "Paragraph" } },
  { el: "label", label: "Label", group: "content", icon: "tag", hint: "A form label (<label for>)", tag: "label", tags: ["label"], container: true, text: "template", preset: { text: "Label" } },
  { el: "link", label: "Link", group: "content", icon: "link", hint: "A link — https:// or a path of this site", tag: "a", tags: ["a"], container: true, text: "template", preset: { text: "Link", attrs: { href: "https://" } } },
  {
    el: "icon", label: "Icon", group: "content", icon: "star", hint: "An icon of the catalog (lucide)", container: false,
    props: [{ key: "icon", label: "Icon", kind: "icon", hint: "A name, or a template: {if $on}moon{else}sun{/if}" }, { key: "strokeWidth", label: "Stroke width", kind: "number" }, { key: "size", label: "Size (px)", kind: "number", hint: "Its width and height (else a class sets them)" }],
    preset: { props: { icon: "star" }, attrs: { class: "h-4 w-4" } },
  },
  { el: "image", label: "Image", group: "content", icon: "image", hint: "An image — https://, a path, or data:image", tag: "img", tags: ["img"], container: false, preset: { attrs: { src: "", alt: "" } } },
  { el: "audio", label: "Audio", group: "content", icon: "volume-2", hint: "An audio player", tag: "audio", tags: ["audio"], container: false, preset: { attrs: { controls: "=true" } } },
  { el: "video", label: "Video", group: "content", icon: "video", hint: "A video (a camera of a call is given by a ref)", tag: "video", tags: ["video"], container: false, preset: { attrs: { controls: "=true" } } },
  {
    el: "logo", label: "Logo", group: "content", icon: "shield-check", hint: "The M5cet logo", container: false,
    props: [{ key: "size", label: "Size (px)", kind: "number" }, { key: "mono", label: "One colour", kind: "bool" }],
    preset: { props: { size: "32" } },
  },
  {
    el: "avatar", label: "Avatar", group: "content", icon: "circle-user-round", hint: "A person's avatar: emoji or initial, colour from the name", container: false,
    props: [{ key: "name", label: "Name", kind: "text" }, { key: "avatar", label: "Avatar", kind: "text" }, { key: "size", label: "Size (px)", kind: "number" }],
    preset: { props: { name: "{$user.nickname}", size: "26" } },
  },
  { el: "html", label: "HTML", group: "content", icon: "code", hint: "Safe HTML with {$variables} (no scripts, no handlers)", container: false, text: "html", preset: { text: "<b>{$user.nickname}</b>" } },
  { el: "separator", label: "Separator", group: "content", icon: "minus", hint: "A horizontal rule (<hr>)", tag: "hr", tags: ["hr"], container: false },
  { el: "button", label: "Button", group: "controls", icon: "square-terminal", hint: "A button that runs an action", tag: "button", tags: ["button"], container: true, text: "template", preset: { text: "Button", attrs: { type: "button" } } },
  { el: "input", label: "Input", group: "controls", icon: "keyboard", hint: "A text field, number, checkbox, range, colour, file…", tag: "input", tags: ["input"], container: false, preset: { attrs: { type: "text" } } },
  { el: "textarea", label: "Text area", group: "controls", icon: "pen-line", hint: "A multi-line field", tag: "textarea", tags: ["textarea"], container: false, preset: { attrs: { rows: "3" } } },
  { el: "select", label: "Select", group: "controls", icon: "chevron-down", hint: "A drop-down; its options are Option elements", tag: "select", tags: ["select"], container: true },
  { el: "option", label: "Option", group: "controls", icon: "check", hint: "One option of a select", tag: "option", tags: ["option"], container: false, text: "template", preset: { text: "Option", attrs: { value: "" } } },
  { el: "form", label: "Form", group: "controls", icon: "send", hint: "A form; its submit runs an action", tag: "form", tags: ["form"], container: true },
  { el: "slot", label: "App part", group: "logic", icon: "puzzle", hint: "A live part the component draws itself (a menu, a user badge, a file card…)", container: false },
  { el: "block", label: "Template", group: "logic", icon: "bookmark", hint: "A reusable template of elements saved in the builder", container: false },
];

export const ELEMENT_BY_KIND: Readonly<Record<string, ElementDef>> = Object.fromEntries(ELEMENTS.map((d) => [d.el, d]));

/* ------------------------------------------------------- the node model */

export const LAYOUT_EVENTS = [
  "click", "dblclick", "contextmenu", "change", "input", "keydown", "keyup", "submit", "focus", "blur",
  "mouseenter", "mouseleave", "pointerdown", "pointerup", "pointerleave", "pointercancel", "dragover", "drop", "paste",
  // 4.13 (the windows, panels and dialogs use them)
  "mousedown", "mouseup", "dragstart", "dragend", "dragenter", "dragleave", "wheel", "scroll", "touchstart", "touchend", "load", "error",
] as const;
export type LayoutEvent = (typeof LAYOUT_EVENTS)[number];

/** An event runs an action of the component, with an optional argument (an expression). */
export type EventBinding = { action: string; arg?: string };

export type LNode = {
  id: string;
  el: ElementKind;
  /** Shown in the builder's tree instead of the element's kind. */
  name?: string;
  tag?: string;
  text?: string;
  /** Element parameters (icon name, avatar size…). Values: template text or "=expression". */
  props?: Record<string, string>;
  attrs?: Record<string, string>;
  css?: Record<string, string>;
  style?: ElementStyle;
  styleBind?: string;
  if?: string;
  each?: string;
  as?: string;
  key?: string;
  on?: Partial<Record<LayoutEvent, EventBinding>>;
  ref?: string;
  slot?: string;
  arg?: string;
  block?: string;
  /** Kept in the builder, not drawn. */
  hidden?: boolean;
  children?: LNode[];
};

export const LAYOUT_LIMITS = {
  nodes: 2500,
  depth: 40,
  text: 8000,
  attr: 2000,
  expr: 600,
  blocks: 60,
  blockNodes: 600,
} as const;

/* ----------------------------------------------------------- attributes */

/** Attributes any element may have (plus aria-* and data-*). */
export const GLOBAL_ATTRS = ["class", "id", "title", "role", "lang", "dir", "tabindex", "hidden", "draggable", "spellcheck", "translate", "inputmode", "enterkeyhint", "accesskey"] as const;

/** Attributes by tag (besides the global ones). */
export const TAG_ATTRS: Readonly<Record<string, readonly string[]>> = {
  a: ["href", "target", "rel", "download", "hreflang"],
  img: ["src", "alt", "width", "height", "loading", "decoding"],
  audio: ["src", "controls", "preload", "loop", "muted", "autoplay"],
  video: ["src", "poster", "controls", "preload", "loop", "muted", "autoplay", "playsinline", "width", "height"],
  input: ["type", "name", "value", "checked", "placeholder", "min", "max", "step", "minlength", "maxlength", "size", "pattern", "autocomplete", "readonly", "disabled", "required", "multiple", "accept", "autofocus", "list"],
  textarea: ["name", "value", "placeholder", "rows", "cols", "minlength", "maxlength", "wrap", "autocomplete", "readonly", "disabled", "required", "autofocus"],
  select: ["name", "value", "multiple", "size", "disabled", "required", "autocomplete"],
  option: ["value", "selected", "disabled", "label"],
  button: ["type", "name", "value", "disabled", "autofocus"],
  label: ["for"],
  form: ["novalidate", "autocomplete"],
  ol: ["start", "reversed", "type"],
  li: ["value"],
  time: ["datetime"],
  details: ["open"],
  abbr: [],
  q: ["cite"],
  blockquote: ["cite"],
  fieldset: ["disabled", "name"],
  td: ["colspan", "rowspan", "headers"],
  th: ["colspan", "rowspan", "headers", "scope", "abbr"],
};

/** Attributes that are true or false (an expression, or "", "true", "false"). */
export const BOOLEAN_ATTRS = new Set(["hidden", "checked", "readonly", "disabled", "required", "multiple", "autofocus", "controls", "loop", "muted", "selected", "open", "novalidate", "reversed", "autoplay", "playsinline"]);

const URL_ATTRS = new Set(["href", "src", "cite", "poster"]);
const NEVER_ATTRS = /^(on|formaction$|action$|srcdoc$|style$|xmlns|xlink)/i;

/** Suggested values for enumerated attributes (the builder offers them while typing). */
export const ATTR_VALUES: Readonly<Record<string, readonly string[]>> = {
  "input.type": ["text", "password", "email", "number", "search", "tel", "url", "date", "time", "datetime-local", "month", "week", "color", "range", "checkbox", "radio", "file", "hidden"],
  "button.type": ["button", "submit", "reset"],
  "ol.type": ["1", "a", "A", "i", "I"],
  target: ["_blank", "_self", "_parent", "_top"],
  rel: ["noopener", "noreferrer", "noopener noreferrer", "nofollow", "external"],
  autocomplete: ["off", "on", "name", "nickname", "username", "email", "tel", "url", "new-password", "current-password", "one-time-code", "organization", "street-address", "postal-code", "country"],
  inputmode: ["none", "text", "decimal", "numeric", "tel", "search", "email", "url"],
  enterkeyhint: ["enter", "done", "go", "next", "previous", "search", "send"],
  role: ["button", "link", "menu", "menubar", "menuitem", "menuitemcheckbox", "dialog", "alert", "alertdialog", "status", "log", "note", "group", "list", "listitem", "tab", "tablist", "tabpanel", "region", "navigation", "banner", "main", "complementary", "contentinfo", "presentation", "none", "img", "separator", "switch", "checkbox", "radio", "radiogroup", "progressbar", "tooltip", "toolbar", "feed", "article"],
  dir: ["ltr", "rtl", "auto"],
  loading: ["lazy", "eager"],
  decoding: ["async", "sync", "auto"],
  preload: ["none", "metadata", "auto"],
  wrap: ["soft", "hard", "off"],
  translate: ["yes", "no"],
  draggable: ["true", "false"],
  spellcheck: ["true", "false"],
  accept: ["image/*", "audio/*", "video/*", "image/png,image/jpeg", ".pdf", ".txt", ".json"],
  "aria-live": ["off", "polite", "assertive"],
  "aria-hidden": ["true", "false"],
  "aria-pressed": ["true", "false", "mixed"],
  "aria-expanded": ["true", "false"],
  "aria-checked": ["true", "false", "mixed"],
  "aria-selected": ["true", "false"],
  "aria-disabled": ["true", "false"],
  "aria-current": ["page", "step", "location", "date", "time", "true", "false"],
  "aria-haspopup": ["true", "menu", "listbox", "tree", "grid", "dialog"],
  "aria-orientation": ["horizontal", "vertical"],
  "aria-modal": ["true", "false"],
  "aria-sort": ["ascending", "descending", "none", "other"],
};

/** ARIA attributes the builder suggests. */
export const ARIA_ATTRS = ["aria-label", "aria-labelledby", "aria-describedby", "aria-hidden", "aria-live", "aria-pressed", "aria-expanded", "aria-checked", "aria-selected", "aria-disabled", "aria-current", "aria-haspopup", "aria-controls", "aria-orientation", "aria-modal", "aria-busy", "aria-sort"] as const;

/** The value suggestions for an attribute of a tag. */
export function attrValues(tag: string, name: string): readonly string[] {
  return ATTR_VALUES[`${tag}.${name}`] ?? ATTR_VALUES[name] ?? (BOOLEAN_ATTRS.has(name) ? ["=true", "=false"] : []);
}

/** Every attribute a tag may have (for suggestions). */
export function attrNames(tag: string): string[] {
  return [...GLOBAL_ATTRS, ...(TAG_ATTRS[tag] ?? []), ...ARIA_ATTRS, "data-testid"];
}

/* ------------------------------------------------------------------ CSS */

const COLORS = ["currentColor", "transparent", "inherit", "hsl(var(--primary))", "hsl(var(--primary-foreground))", "hsl(var(--foreground))", "hsl(var(--background))", "hsl(var(--card))", "hsl(var(--muted))", "hsl(var(--muted-foreground))", "hsl(var(--accent))", "hsl(var(--border))", "hsl(var(--destructive))", "#ffffff", "#000000"];
const LENGTHS = ["0", "auto", "1px", "2px", "4px", "6px", "8px", "12px", "16px", "20px", "24px", "32px", "0.25rem", "0.5rem", "0.75rem", "1rem", "1.5rem", "2rem", "50%", "100%", "fit-content", "max-content", "min-content"];
const ALIGN = ["normal", "stretch", "center", "start", "end", "flex-start", "flex-end", "baseline", "space-between", "space-around", "space-evenly"];

/** CSS properties the builder offers, with value suggestions. */
export const CSS_PROPERTIES: Readonly<Record<string, readonly string[]>> = {
  display: ["block", "inline", "inline-block", "flex", "inline-flex", "grid", "inline-grid", "contents", "flow-root", "list-item", "table", "table-row", "table-cell", "none"],
  position: ["static", "relative", "absolute", "fixed", "sticky"],
  top: LENGTHS, right: LENGTHS, bottom: LENGTHS, left: LENGTHS, inset: LENGTHS,
  "z-index": ["auto", "0", "1", "10", "50", "100", "var(--z-menu)"],
  width: LENGTHS, height: LENGTHS, "min-width": LENGTHS, "min-height": LENGTHS, "max-width": [...LENGTHS, "none", "20rem", "40rem", "56rem"], "max-height": [...LENGTHS, "none", "60dvh", "80dvh"],
  "aspect-ratio": ["auto", "1", "1 / 1", "4 / 3", "16 / 9"],
  "box-sizing": ["border-box", "content-box"],
  margin: LENGTHS, "margin-top": LENGTHS, "margin-right": LENGTHS, "margin-bottom": LENGTHS, "margin-left": LENGTHS, "margin-inline": LENGTHS, "margin-block": LENGTHS,
  padding: LENGTHS, "padding-top": LENGTHS, "padding-right": LENGTHS, "padding-bottom": LENGTHS, "padding-left": LENGTHS, "padding-inline": LENGTHS, "padding-block": LENGTHS,
  gap: LENGTHS, "row-gap": LENGTHS, "column-gap": LENGTHS,
  "flex-direction": ["row", "row-reverse", "column", "column-reverse"],
  "flex-wrap": ["nowrap", "wrap", "wrap-reverse"],
  flex: ["1", "1 1 auto", "0 0 auto", "none", "auto"],
  "flex-grow": ["0", "1", "2"], "flex-shrink": ["0", "1"], "flex-basis": LENGTHS,
  order: ["-1", "0", "1", "2"],
  "justify-content": ALIGN, "justify-items": ALIGN, "justify-self": ALIGN, "align-items": ALIGN, "align-content": ALIGN, "align-self": ["auto", ...ALIGN], "place-items": ALIGN, "place-content": ALIGN,
  "grid-template-columns": ["1fr", "1fr 1fr", "repeat(2, 1fr)", "repeat(3, 1fr)", "auto 1fr", "1fr auto", "repeat(auto-fill, minmax(12rem, 1fr))"],
  "grid-template-rows": ["auto", "auto 1fr", "1fr auto"],
  "grid-column": ["auto", "span 2", "1 / -1"], "grid-row": ["auto", "span 2", "1 / -1"],
  color: COLORS, background: COLORS, "background-color": COLORS, opacity: ["0", "0.25", "0.5", "0.75", "0.85", "1"],
  border: ["none", "1px solid hsl(var(--border))", "2px solid hsl(var(--primary))", "1px dashed hsl(var(--border))"],
  "border-width": ["0", "1px", "2px", "3px"], "border-style": ["none", "solid", "dashed", "dotted", "double"], "border-color": COLORS,
  "border-top": ["none", "1px solid hsl(var(--border))"], "border-bottom": ["none", "1px solid hsl(var(--border))"], "border-left": ["none", "3px solid hsl(var(--primary))"], "border-right": ["none", "1px solid hsl(var(--border))"],
  "border-radius": ["0", "4px", "8px", "12px", "16px", "24px", "9999px", "50%", "var(--radius)"],
  "box-shadow": ["none", "var(--shadow-sm)", "var(--shadow)", "var(--shadow-md)", "0 0 0 3px hsl(var(--primary) / 0.28)"],
  outline: ["none", "2px solid hsl(var(--ring))"], "outline-offset": ["0", "2px"],
  "font-family": ["inherit", "var(--font-sans)", "var(--font-serif)", "var(--font-mono)", "system-ui", "ui-monospace", "serif", "sans-serif"],
  "font-size": ["0.75rem", "0.875rem", "1rem", "1.125rem", "1.25rem", "1.5rem", "11px", "12px", "13px", "14px", "16px", "18px", "20px", "24px", "smaller", "larger"],
  "font-weight": ["100", "200", "300", "400", "500", "600", "700", "800", "900", "normal", "bold", "lighter", "bolder"],
  "font-style": ["normal", "italic", "oblique"],
  "font-variant-numeric": ["normal", "tabular-nums", "slashed-zero"],
  "line-height": ["1", "1.2", "1.4", "1.5", "1.75", "normal"],
  "letter-spacing": ["normal", "-0.01em", "0.02em", "0.05em", "0.1em"],
  "text-align": ["left", "right", "center", "justify", "start", "end"],
  "text-transform": ["none", "uppercase", "lowercase", "capitalize"],
  "text-decoration": ["none", "underline", "line-through", "overline", "underline dotted"],
  "text-overflow": ["clip", "ellipsis"],
  "text-shadow": ["none", "0 1px 2px rgb(0 0 0 / 0.25)"],
  "white-space": ["normal", "nowrap", "pre", "pre-wrap", "pre-line", "break-spaces"],
  "word-break": ["normal", "break-all", "keep-all", "break-word"],
  "overflow-wrap": ["normal", "break-word", "anywhere"],
  hyphens: ["none", "manual", "auto"],
  "vertical-align": ["baseline", "top", "middle", "bottom", "text-top", "text-bottom", "-0.125em"],
  "list-style": ["none", "disc", "decimal", "circle", "square"],
  overflow: ["visible", "hidden", "clip", "scroll", "auto"], "overflow-x": ["visible", "hidden", "clip", "scroll", "auto"], "overflow-y": ["visible", "hidden", "clip", "scroll", "auto"],
  "overscroll-behavior": ["auto", "contain", "none"],
  visibility: ["visible", "hidden", "collapse"],
  cursor: ["auto", "default", "pointer", "text", "move", "grab", "grabbing", "not-allowed", "help", "wait", "crosshair", "zoom-in"],
  "pointer-events": ["auto", "none"],
  "user-select": ["auto", "none", "text", "all"],
  "object-fit": ["fill", "contain", "cover", "none", "scale-down"],
  "object-position": ["center", "top", "bottom", "left", "right"],
  transform: ["none", "scale(1.05)", "scale(0.95)", "rotate(90deg)", "translateY(-2px)"],
  "transform-origin": ["center", "top left", "top right", "bottom left", "bottom right"],
  transition: ["none", "all 150ms ease", "opacity 150ms ease", "transform 150ms ease", "background-color 150ms ease"],
  animation: ["none"],
  filter: ["none", "blur(4px)", "grayscale(1)", "brightness(0.9)", "saturate(1.5)"],
  "backdrop-filter": ["none", "blur(12px)", "blur(20px) saturate(160%)"],
  "mix-blend-mode": ["normal", "multiply", "screen", "overlay"],
  "accent-color": COLORS,
  "caret-color": COLORS,
  "scroll-behavior": ["auto", "smooth"],
  "content-visibility": ["visible", "auto", "hidden"],
  contain: ["none", "layout", "paint", "content", "strict"],
  isolation: ["auto", "isolate"],
  float: ["none", "left", "right", "inline-start", "inline-end"],
  clear: ["none", "left", "right", "both"],
  resize: ["none", "both", "horizontal", "vertical"],
  "table-layout": ["auto", "fixed"],
  "border-collapse": ["separate", "collapse"],
};

/** A CSS value the app accepts: no url(), expression(), javascript:, @import, markup or braces. */
export function isSafeCssValue(value: string): boolean {
  return value.length <= 400 && !/url\s*\(|expression\s*\(|javascript:|vbscript:|@import|[<>{};\\]|behavior\s*:|-moz-binding/i.test(value);
}

export function isCssProperty(name: string): boolean {
  return name in CSS_PROPERTIES || /^--[a-z0-9][a-z0-9-]{0,40}$/i.test(name);
}

/* --------------------------------------------------------------- URLs */

/**
 * A URL an element may point to. Operators' literals: https://, a path of
 * this site, #anchor, mailto:/tel:, data:image/… (images). At render time the
 * app's own values may also be blob: or data: (an attachment it received).
 */
export function isSafeUrl(value: string, opts: { data?: boolean } = {}): boolean {
  const v = value.trim();
  if (!v) return true;
  if (/^(javascript|vbscript|file):/i.test(v.replace(/[\s\u0000-\u001f]/g, ""))) return false;
  if (/^https:\/\//i.test(v) || /^mailto:|^tel:/i.test(v)) return true;
  if (/^\/(?!\/)|^\.\.?\/|^#|^\?/.test(v)) return true;
  if (/^data:image\/(png|jpe?g|gif|webp|avif);/i.test(v)) return true;
  if (opts.data && (/^blob:/i.test(v) || (/^data:/i.test(v) && !/^data:(text\/html|image\/svg|application\/xhtml|text\/xml|application\/xml)/i.test(v)))) return true;
  return false;
}

/* ------------------------------------------------------------ sanitize */

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const NAME_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,59}$/;
const VAR_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

// eslint-disable-next-line no-control-regex
const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, max) : "");

function isAttrAllowed(tag: string, name: string): boolean {
  if (NEVER_ATTRS.test(name)) return false;
  if (/^aria-[a-z]{2,20}$/.test(name) || /^data-[a-z0-9][a-z0-9-]{0,40}$/.test(name)) return true;
  return (GLOBAL_ATTRS as readonly string[]).includes(name) || (TAG_ATTRS[tag] ?? []).includes(name);
}

type Budget = { left: number; ids: Set<string> };

function sanitizeNode(raw: unknown, depth: number, budget: Budget): LNode | null {
  if (budget.left <= 0 || depth > LAYOUT_LIMITS.depth) return null;
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const def = typeof r.el === "string" ? ELEMENT_BY_KIND[r.el] : undefined;
  if (!def) return null;
  budget.left -= 1;
  let id = clean(r.id, 40).toLowerCase();
  if (!ID_RE.test(id) || budget.ids.has(id)) {
    let n = budget.ids.size + 1;
    do { id = `n${n++}`; } while (budget.ids.has(id));
  }
  budget.ids.add(id);
  const node: LNode = { id, el: def.el };
  const name = clean(r.name, 60).trim();
  if (name) node.name = name;
  if (def.tag) {
    const tag = typeof r.tag === "string" && def.tags?.includes(r.tag) ? r.tag : def.tag;
    node.tag = tag;
  }
  const tag = node.tag ?? "";
  if (def.text && typeof r.text === "string") node.text = clean(r.text, LAYOUT_LIMITS.text);
  else if (def.container && typeof r.text === "string" && r.text) node.text = clean(r.text, LAYOUT_LIMITS.text);
  if (r.props && typeof r.props === "object" && def.props) {
    const props: Record<string, string> = {};
    for (const p of def.props) {
      const v = (r.props as Record<string, unknown>)[p.key];
      if (typeof v === "string" && v.length) props[p.key] = clean(v, 400);
    }
    if (Object.keys(props).length) node.props = props;
  }
  if (r.attrs && typeof r.attrs === "object" && tag) {
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.attrs as Record<string, unknown>)) {
      const key = k.toLowerCase();
      if (typeof v !== "string" || !isAttrAllowed(tag, key)) continue;
      const value = clean(v, LAYOUT_LIMITS.attr);
      // A literal URL must be safe here; a computed one is checked when it is drawn.
      if (URL_ATTRS.has(key) && !value.startsWith("=") && !value.includes("{") && !isSafeUrl(value)) continue;
      attrs[key] = value;
    }
    if (Object.keys(attrs).length) node.attrs = attrs;
  } else if (r.attrs && typeof r.attrs === "object" && (def.el === "icon" || def.el === "logo" || def.el === "avatar")) {
    // Icons, the logo and avatars take a class, a title and ARIA / data attributes.
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.attrs as Record<string, unknown>)) {
      const key = k.toLowerCase();
      if (typeof v !== "string" || !(key === "class" || key === "title" || key === "role" || /^aria-[a-z]{2,20}$/.test(key) || /^data-[a-z0-9][a-z0-9-]{0,40}$/.test(key))) continue;
      attrs[key] = clean(v, LAYOUT_LIMITS.attr);
    }
    if (Object.keys(attrs).length) node.attrs = attrs;
  }
  if (r.css && typeof r.css === "object") {
    const css: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.css as Record<string, unknown>)) {
      const key = k.trim().toLowerCase();
      if (typeof v !== "string" || !isCssProperty(key)) continue;
      const value = clean(v, 400).trim();
      // Template tags ({$x}, {if …}) are checked for what they produce, when drawn.
      if (value && isSafeCssValue(value.replace(/\{[^{}]*\}/g, "0"))) css[key] = value;
    }
    if (Object.keys(css).length) node.css = css;
  }
  if (r.style !== undefined) {
    const st = sanitizeStyle(r.style);
    if (Object.keys(st).length) node.style = st;
  }
  for (const k of ["styleBind", "if", "each", "key", "arg"] as const) {
    const v = clean(r[k], LAYOUT_LIMITS.expr).trim();
    if (v) node[k] = v;
  }
  if (node.each) {
    const as = clean(r.as, 32).trim().replace(/^\$/, "");
    node.as = VAR_RE.test(as) ? as : "item";
  }
  if (r.on && typeof r.on === "object") {
    const on: LNode["on"] = {};
    for (const ev of LAYOUT_EVENTS) {
      const b = (r.on as Record<string, unknown>)[ev];
      const action = typeof b === "string" ? b : b && typeof b === "object" ? (b as Record<string, unknown>).action : undefined;
      if (typeof action !== "string" || !NAME_RE.test(action)) continue;
      const arg = b && typeof b === "object" ? clean((b as Record<string, unknown>).arg, LAYOUT_LIMITS.expr).trim() : "";
      on[ev] = arg ? { action, arg } : { action };
    }
    if (Object.keys(on).length) node.on = on;
  }
  for (const k of ["ref", "slot", "block"] as const) {
    const v = clean(r[k], 60).trim();
    if (v && NAME_RE.test(v)) node[k] = v;
  }
  if (def.el === "slot" && !node.slot) node.slot = "missing";
  if (def.el === "block" && !node.block) node.block = "missing";
  if (r.hidden === true) node.hidden = true;
  if (def.container && Array.isArray(r.children)) {
    const children = r.children.map((c) => sanitizeNode(c, depth + 1, budget)).filter((c): c is LNode => Boolean(c));
    // A select holds options (and groups / repeats of them).
    node.children = def.el === "select" ? children.filter((c) => c.el === "option" || c.el === "group") : children;
  }
  return node;
}

/** A tree an operator sent, made safe (unknown things dropped, ids unique). Null when nothing is left. */
export function sanitizeTree(raw: unknown, maxNodes: number = LAYOUT_LIMITS.nodes): LNode | null {
  return sanitizeNode(raw, 1, { left: maxNodes, ids: new Set() });
}

/* ------------------------------------------------------------- helpers */

export function walkTree(node: LNode, visit: (n: LNode, parent: LNode | null) => void, parent: LNode | null = null): void {
  visit(node, parent);
  for (const c of node.children ?? []) walkTree(c, visit, node);
}

export function countNodes(node: LNode): number {
  let n = 0;
  walkTree(node, () => { n++; });
  return n;
}

export function findNode(root: LNode, id: string): LNode | null {
  let found: LNode | null = null;
  walkTree(root, (n) => { if (!found && n.id === id) found = n; });
  return found;
}

/** A short, stable fingerprint of a tree (FNV-1a) — tells when the app's default changed. */
export function treeRev(node: LNode): string {
  const s = JSON.stringify(node);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/* ------------------------------------------------------ building trees */

/**
 * Builds a tree in code (the app's default layouts): `n("panel", {...}, [..])`.
 * Ids come from the optional `id` or are numbered in order — stable as long
 * as the default does not change.
 */
export function treeBuilder(prefix: string) {
  let counter = 0;
  const used = new Set<string>();
  const next = (want?: string): string => {
    if (want && !used.has(want)) { used.add(want); return want; }
    let id: string;
    do { id = `${prefix}${++counter}`; } while (used.has(id));
    used.add(id);
    return id;
  };
  function n(el: ElementKind, spec: Omit<Partial<LNode>, "el" | "children"> = {}, children?: Array<LNode | string | null | false>): LNode {
    const def = ELEMENT_BY_KIND[el];
    const node: LNode = { ...spec, id: next(spec.id), el } as LNode;
    if (def.tag && !node.tag) node.tag = def.tag;
    if (children) {
      node.children = children.filter((c): c is LNode | string => Boolean(c)).map((c) => (typeof c === "string" ? { id: next(), el: "text", text: c } as LNode : c));
    }
    return node;
  }
  /** A text node. */
  const text = (t: string, spec: Omit<Partial<LNode>, "el" | "text"> = {}): LNode => ({ ...spec, id: next(spec.id), el: "text", text: t } as LNode);
  /** An icon: `icon("lock", "h-3 w-3 opacity-70", { "aria-label": "…" })`. */
  const icon = (name: string, cls: string, attrs: Record<string, string> = {}, spec: Omit<Partial<LNode>, "el"> = {}): LNode =>
    ({ ...spec, id: next(spec.id), el: "icon", props: { icon: name, ...(spec.props ?? {}) }, attrs: { class: cls, ...attrs } } as LNode);
  return { n, text, icon };
}
