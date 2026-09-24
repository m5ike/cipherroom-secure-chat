// Draws a Layout builder tree (lib/layout-tree.ts) as React elements — the
// app's message bubbles, app bar, chat window, composer and recipients widget
// are all drawn by it from their layouts, the builder's preview too.
//
// Values are templates of the menu's template language (menu-template.ts)
// rendered as plain text, or expressions ("=…") keeping their type. The
// component supplies the data, its actions (events), its slots (live
// sub-components) and its refs. Nothing is ever set as innerHTML; URLs are
// checked when drawn; an HTML element goes through the safe HTML parser.

import { createElement, Fragment, type CSSProperties, type ReactNode, type Ref } from "react";
import { Icon } from "lucide-react";
import { BOOLEAN_ATTRS, ELEMENT_BY_KIND, isSafeCssValue, isSafeUrl, type LNode, type LayoutEvent } from "../lib/layout-tree";
import {
  compileExpression, compileTemplate, isTruthy, lookupValue, parseSafeHtml, valueText, type CompiledTemplate, type RenderOptions, type SafeNode, type TemplateVars,
} from "../lib/menu-template";
import { styleProps } from "../lib/menu-style";
import { MENU_ICON_ALIASES, MENU_ICONS } from "../lib/menu-icons-data";
import { M5Logo } from "./M5Logo";
import { Avatar } from "./UserBadge";

export type LayoutActions = Record<string, (event: unknown, arg?: unknown) => void>;
/** A live part: its argument, and (to a function that declares a second parameter) the values in scope where it is drawn. */
export type LayoutSlots = Record<string, (arg: unknown, scope: TemplateVars) => ReactNode>;

export type LayoutEnv = {
  data: TemplateVars;
  actions?: LayoutActions;
  slots?: LayoutSlots;
  refs?: Record<string, Ref<never> | undefined>;
  /** Reusable templates of the builder ("block" elements). */
  blocks?: Record<string, LNode>;
  translate?: (key: string) => string;
  lang?: string;
  /** Text formats a text element may ask for (props.format): "links" → linkify. */
  formats?: Record<string, (text: string) => ReactNode>;
  /** The builder's preview: every element carries data-lb-id. */
  debug?: boolean;
  /** An expression or template that does not work (the preview lists them). */
  onError?: (nodeId: string, message: string) => void;
};

/** The builder's preview: every layout drawn on the page marks its elements and reports its errors. */
let previewMode: { onError?: (nodeId: string, message: string) => void } | null = null;
export function setLayoutPreviewMode(mode: { onError?: (nodeId: string, message: string) => void } | null): void {
  previewMode = mode;
}

const EVENT_PROPS: Record<LayoutEvent, string> = {
  click: "onClick", dblclick: "onDoubleClick", contextmenu: "onContextMenu", change: "onChange", input: "onInput",
  keydown: "onKeyDown", keyup: "onKeyUp", submit: "onSubmit", focus: "onFocus", blur: "onBlur",
  mouseenter: "onMouseEnter", mouseleave: "onMouseLeave", pointerdown: "onPointerDown", pointerup: "onPointerUp",
  pointerleave: "onPointerLeave", pointercancel: "onPointerCancel", dragover: "onDragOver", drop: "onDrop", paste: "onPaste",
  mousedown: "onMouseDown", mouseup: "onMouseUp", dragstart: "onDragStart", dragend: "onDragEnd", dragenter: "onDragEnter", dragleave: "onDragLeave",
  wheel: "onWheel", scroll: "onScroll", touchstart: "onTouchStart", touchend: "onTouchEnd", load: "onLoad", error: "onError",
};

/** HTML attribute → React prop. */
const PROP_NAMES: Record<string, string> = {
  class: "className", for: "htmlFor", tabindex: "tabIndex", readonly: "readOnly", maxlength: "maxLength", minlength: "minLength",
  autocomplete: "autoComplete", autofocus: "autoFocus", spellcheck: "spellCheck", inputmode: "inputMode", enterkeyhint: "enterKeyHint",
  accesskey: "accessKey", novalidate: "noValidate", datetime: "dateTime", hreflang: "hrefLang",
  autoplay: "autoPlay", playsinline: "playsInline",
};

const URL_ATTRS = new Set(["href", "src", "cite", "poster"]);

/** An icon of the catalog by name or by one of its old names. */
const ICON_BY_ALIAS: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [name, aliases] of Object.entries(MENU_ICON_ALIASES)) for (const a of aliases) out[a] = name;
  return out;
})();
export function iconName(name: string): string {
  return MENU_ICONS[name] ? name : ICON_BY_ALIAS[name] ?? "circle-alert";
}

const camel = (prop: string) => (prop.startsWith("--") ? prop : prop.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase()));

/* ------------------------------------------------------------- compiling */
//
// Every node of a tree is compiled once into a function (cached per node
// object — trees are data that is replaced, never changed in place): its
// templates and expressions are compiled closures, whatever does not depend
// on the data (static attributes, CSS, the designer's style) is computed
// ahead, and repeats extend a chain of scopes instead of copying the data.
// Drawing a layout then only runs those functions.

/** Scopes from the component's data (outermost) to the innermost repeat or template. */
type Chain = TemplateVars[];

/** One drawing of a layout: its environment, and errors reported once. */
type Run = {
  env: LayoutEnv;
  debug: boolean;
  opts: RenderOptions;
  rawOpts: RenderOptions;
  errors: Set<string> | null;
  blockDepth: number;
};

/** Draws a node; `key` is its React key — its id, or its id and item key in a repeat. */
type Draw = (run: Run, chain: Chain, key: string) => ReactNode;
type Get = (run: Run, chain: Chain) => unknown;

function fail(run: Run, nodeId: string, message: string): void {
  const key = `${nodeId}:${message}`;
  if (!run.errors) run.errors = new Set();
  else if (run.errors.has(key)) return;
  run.errors.add(key);
  (run.env.onError ?? previewMode?.onError)?.(nodeId, message);
}

function chainGet(chain: Chain, name: string): unknown {
  for (let i = chain.length - 1; i >= 0; i--) if (Object.prototype.hasOwnProperty.call(chain[i], name)) return chain[i][name];
  return undefined;
}

/** A merged copy of the scopes — what a slot sees as its scope. */
function flatten(chain: Chain): TemplateVars {
  return chain.length === 1 ? chain[0] : Object.assign({}, ...chain) as TemplateVars;
}

/** An expression's value (undefined when it fails). */
function exprGetter(node: LNode, src: string): Get {
  let fn: ReturnType<typeof compileExpression>;
  try {
    fn = compileExpression(src);
  } catch (err) {
    const message = `${src}: ${(err as Error).message}`;
    return (run) => { fail(run, node.id, message); return undefined; };
  }
  return (run, chain) => {
    try {
      return fn(chain, run.opts);
    } catch (err) {
      fail(run, node.id, `${src}: ${(err as Error).message}`);
      return undefined;
    }
  };
}

const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);

/** A template as plain text. */
function textGetter(node: LNode, src: string): Get {
  if (!src.includes("{")) return () => src;
  // "{$a.b}" alone: the value itself, as text — never cut to the template's output limit (a long message).
  const m = /^\{\$([A-Za-z_]\w*(?:\.[A-Za-z0-9_]+)*)\}$/.exec(src);
  if (m && !m[1].split(".").some((p) => FORBIDDEN.has(p))) {
    const [head, ...rest] = m[1].split(".");
    return (_run, chain) => {
      let v = chainGet(chain, head);
      for (const p of rest) v = lookupValue(v, p);
      return valueText(v);
    };
  }
  let t: CompiledTemplate;
  try {
    t = compileTemplate(src);
  } catch (err) {
    const message = `${src.slice(0, 60)}: ${(err as Error).message}`;
    return (run) => { fail(run, node.id, message); return ""; };
  }
  return (run, chain) => {
    try {
      return t.run(chain, run.rawOpts);
    } catch (err) {
      fail(run, node.id, `${src.slice(0, 60)}: ${(err as Error).message}`);
      return "";
    }
  };
}

/** An attribute or parameter value: "=expression" keeps its type (null → left out), anything else is template text. */
function valueGetter(node: LNode, src: string): Get {
  if (!src.startsWith("=")) return textGetter(node, src);
  const get = exprGetter(node, src.slice(1));
  return (run, chain) => { const v = get(run, chain); return v === null ? undefined : v; };
}

/** An argument (of a repeat's key, a slot, a template, an event): always an expression. */
const argGetter = (node: LNode, src: string): Get => valueGetter(node, src.startsWith("=") ? src : `=${src}`);

const compiled = new WeakMap<LNode, Draw>();

function compileNode(node: LNode): Draw {
  let draw = compiled.get(node);
  if (!draw) {
    draw = buildNode(node);
    compiled.set(node, draw);
  }
  return draw;
}

function buildNode(node: LNode): Draw {
  if (node.hidden) return () => null;
  const body = buildBody(node);
  if (!node.each) return body;
  const list = exprGetter(node, node.each);
  const as = node.as || "item";
  const keyOf = node.key ? argGetter(node, node.key) : null;
  return (run, chain) => {
    const v = list(run, chain);
    const items = Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v as Record<string, unknown>) : [];
    const n = Math.min(items.length, 2000);
    const out: ReactNode[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const inner: Chain = [...chain, {
        [as]: items[i],
        iterator: { counter: i + 1, counter0: i, first: i === 0, last: i === items.length - 1, odd: i % 2 === 0, even: i % 2 === 1, length: items.length },
      }];
      const k = keyOf ? keyOf(run, inner) : i;
      out[i] = body(run, inner, `${node.id}:${String(k)}`);
    }
    return out;
  };
}

/** Whether a value is the same whatever the data: no template, no expression. */
const fixedValue = (v: string | undefined) => v === undefined || (!v.startsWith("=") && !v.includes("{"));

/**
 * Whether what a node draws (its "show only when" and repeat aside) never
 * changes: fixed attributes, CSS and texts, no events, refs, live parts,
 * templates or data — and so do its children. Such an element is created
 * once and handed to React again and again, which then skips it on a redraw.
 */
function fixedElement(node: LNode): boolean {
  if (["slot", "block", "html", "logo", "avatar", "text"].includes(node.el)) return false;
  if (node.styleBind || node.ref || (node.on && Object.keys(node.on).length) || !fixedValue(node.text)) return false;
  if (node.el === "icon" && !(fixedValue(node.props?.icon) && fixedValue(node.props?.strokeWidth) && fixedValue(node.props?.size))) return false;
  for (const [name, raw] of Object.entries(node.attrs ?? {})) {
    if (!fixedValue(raw) || (URL_ATTRS.has(name) && !isSafeUrl(raw, { data: false }))) return false;
  }
  if (Object.values(node.css ?? {}).some((v) => !fixedValue(v))) return false;
  return (node.children ?? []).every((c) => c.hidden || (!c.if && !c.each && (c.el === "text" ? fixedValue(c.text) && !c.props?.format : fixedElement(c))));
}

/** The node itself: "show only when", then what it draws. */
function buildBody(node: LNode): Draw {
  let draw = buildElement(node);
  if (fixedElement(node)) {
    const make = draw;
    const id = node.id;
    let made: ReactNode | undefined;
    // Not in the builder's preview (marks) nor in a repeat (a key of its own each time).
    draw = (run, chain, key) => (run.debug || key !== id ? make(run, chain, key) : (made ??= make(run, chain, key)));
  }
  if (!node.if) return draw;
  const cond = exprGetter(node, node.if);
  return (run, chain, key) => (isTruthy(cond(run, chain)) ? draw(run, chain, key) : null);
}

/** Something drawn without an element of this tree (a live part, a template, the logo, an avatar):
 *  in the builder's preview it gets a box of its own (display: contents) to be picked by a click. */
function mark(run: Run, node: LNode, key: string, content: ReactNode): ReactNode {
  if (!run.debug) return <Fragment key={key}>{content}</Fragment>;
  return <span key={key} data-lb-id={node.id} style={{ display: "contents" }}>{content}</span>;
}

function buildElement(node: LNode): (run: Run, chain: Chain, key: string) => ReactNode {
  switch (node.el) {
    case "text": {
      const text = textGetter(node, node.text ?? "");
      const format = node.props?.format;
      return (run, chain, k) => {
        const t = text(run, chain) as string;
        const f = format ? run.env.formats?.[format] : undefined;
        if (f) return <Fragment key={k}>{f(t)}</Fragment>;
        // A text is a text node of its parent (a string needs no key, nor a fragment around it).
        return t === "" ? null : t;
      };
    }
    case "group": {
      const kids = buildChildren(node);
      return (run, chain, k) => <Fragment key={k}>{kids(run, chain)}</Fragment>;
    }
    case "slot": {
      const arg = node.arg ? argGetter(node, node.arg) : null;
      return (run, chain, k) => {
        const fn = node.slot ? run.env.slots?.[node.slot] : undefined;
        if (!fn) return null;
        const a = arg ? arg(run, chain) : undefined;
        return mark(run, node, k, fn(a, fn.length >= 2 ? flatten(chain) : chain[0]));
      };
    }
    case "block": {
      const arg = node.arg ? argGetter(node, node.arg) : null;
      return (run, chain, k) => {
        const tree = node.block ? run.env.blocks?.[node.block] : undefined;
        if (!tree || run.blockDepth >= 6) return null;
        const inner = arg ? [...chain, { arg: arg(run, chain) }] : chain;
        run.blockDepth++;
        try { return mark(run, node, k, compileNode(tree)(run, inner, tree.id)); } finally { run.blockDepth--; }
      };
    }
    case "icon": {
      const name = valueGetter(node, node.props?.icon ?? "circle-alert");
      const props = buildAttrs(node);
      const stroke = node.props?.strokeWidth ? valueGetter(node, node.props.strokeWidth) : null;
      const sizeOf = node.props?.size ? valueGetter(node, node.props.size) : null;
      return (run, chain, key) => {
        const icon = iconData(iconName(String(name(run, chain) ?? "").trim()));
        const p = props(run, chain);
        const sw = stroke ? Number(stroke(run, chain)) : undefined;
        const size = sizeOf ? Number(sizeOf(run, chain)) : undefined;
        return createElement(Icon, { key, icon: icon as never, ...(sw ? { strokeWidth: sw } : {}), ...(size ? { size } : {}), ...p });
      };
    }
    case "logo": {
      const props = buildAttrs(node);
      const size = valueGetter(node, node.props?.size ?? "36");
      const mono = valueGetter(node, node.props?.mono ?? "=false");
      return (run, chain, k) => {
        const p = props(run, chain);
        const s = Number(size(run, chain)) || 36;
        const m = isTruthy(mono(run, chain));
        return mark(run, node, k, <M5Logo size={s} mono={m} className={p.className as string | undefined} />);
      };
    }
    case "avatar": {
      const props = buildAttrs(node);
      const size = valueGetter(node, node.props?.size ?? "32");
      const name = valueGetter(node, node.props?.name ?? "");
      const avatar = valueGetter(node, node.props?.avatar ?? "");
      return (run, chain, k) => {
        const p = props(run, chain);
        const s = Number(size(run, chain)) || 32;
        return mark(run, node, k, <Avatar name={String(name(run, chain) ?? "")} avatar={String(avatar(run, chain) ?? "") || undefined} size={s} className={(p.className as string | undefined) ?? ""} />);
      };
    }
    case "html": return buildHtml(node);
    default: {
      const def = ELEMENT_BY_KIND[node.el];
      const tag = node.tag ?? def?.tag;
      const kids = buildChildren(node);
      if (!tag) return (run, chain, k) => <Fragment key={k}>{kids(run, chain)}</Fragment>;
      const props = buildAttrs(node);
      if (def && !def.container && !def.text) {
        return (run, chain, key) => { const p = props(run, chain); p.key = key; return createElement(tag, p); };
      }
      return (run, chain, key) => {
        const p = props(run, chain);
        p.key = key;
        const children = kids(run, chain);
        // <textarea> takes its text as the value.
        if (tag === "textarea") return createElement(tag, p);
        return createElement(tag, p, ...children);
      };
    }
  }
}

function buildChildren(node: LNode): (run: Run, chain: Chain) => ReactNode[] {
  const text = node.text !== undefined && node.el !== "html" ? textGetter(node, node.text) : null;
  const kids = (node.children ?? []).map((c) => ({ draw: compileNode(c), key: c.id }));
  return (run, chain) => {
    const out: ReactNode[] = [];
    if (text) {
      const t = text(run, chain) as string;
      if (t !== "") out.push(t);
    }
    for (const c of kids) {
      const r = c.draw(run, chain, c.key);
      if (r !== null && r !== undefined) out.push(r);
    }
    return out;
  };
}

type AttrPlan = {
  name: string;
  prop: string;
  get: Get;
  /** A value that does not depend on the data, worked out ahead (not for an unsafe address: that is reported when drawn). */
  fixed?: { v: unknown };
  boolean: boolean;
  /** Checked as an address when drawn; from data (an expression or a template) data: and blob: may pass. */
  url: boolean;
  fromData: boolean;
};

/** Attributes, CSS, the designer's style, events and a ref → React props. */
function buildAttrs(node: LNode): (run: Run, chain: Chain) => Record<string, unknown> {
  const attrs: AttrPlan[] = Object.entries(node.attrs ?? {}).map(([name, raw]) => {
    const plan: AttrPlan = {
      name,
      prop: PROP_NAMES[name] ?? name,
      get: valueGetter(node, raw),
      boolean: BOOLEAN_ATTRS.has(name),
      url: URL_ATTRS.has(name),
      fromData: raw.startsWith("=") || raw.includes("{"),
    };
    if (!plan.fromData && !(plan.url && !isSafeUrl(raw, { data: false }))) {
      plan.fixed = { v: plan.boolean ? raw === "" || raw === "true" || raw === name : raw };
    }
    return plan;
  });
  const designer = node.style ? styleProps(node.style) : null;
  const designerClass = designer?.className || "";
  const designerStyle = designer && Object.keys(designer.style).length ? (designer.style as Record<string, unknown>) : null;
  const bind = node.styleBind ? exprGetter(node, node.styleBind) : null;
  const css = Object.entries(node.css ?? {}).map(([prop, raw]) => ({ prop: camel(prop), get: textGetter(node, raw) }));
  const hasCss = Boolean(node.css);
  const events = (Object.entries(node.on ?? {}) as Array<[LayoutEvent, { action: string; arg?: string }]>).map(([ev, binding]) => ({
    prop: EVENT_PROPS[ev],
    action: binding.action,
    arg: binding.arg ? argGetter(node, binding.arg) : null,
  }));
  const ref = node.ref;
  const id = node.id;
  return (run, chain) => {
    const props: Record<string, unknown> = {};
    for (const a of attrs) {
      if (a.fixed) { props[a.prop] = a.fixed.v; continue; }
      let v = a.get(run, chain);
      if (v === undefined) continue;
      if (a.boolean) {
        if (typeof v === "string") v = v === "" || v === "true" || v === a.name;
        else v = isTruthy(v);
      }
      if (a.url && typeof v === "string" && !isSafeUrl(v, { data: a.fromData })) {
        fail(run, id, `${a.name}: not a safe address`);
        continue;
      }
      props[a.prop] = v;
    }
    if (designerClass) props.className = props.className ? `${props.className as string} ${designerClass}` : designerClass;
    let style: Record<string, unknown> | null = null;
    if (bind) {
      const bound = bind(run, chain);
      if (bound && typeof bound === "object") style = { ...(bound as Record<string, unknown>) };
    }
    if (hasCss) {
      style = style ?? {};
      for (const c of css) {
        const v = c.get(run, chain) as string;
        if (v !== "" && isSafeCssValue(v)) style[c.prop] = v;
      }
    }
    if (designerStyle) style = { ...(style ?? {}), ...designerStyle };
    if (style) props.style = style as CSSProperties;
    for (const e of events) {
      const fn = run.env.actions?.[e.action];
      if (!fn) continue;
      const arg = e.arg ? e.arg(run, chain) : undefined;
      props[e.prop] = (event: unknown) => fn(event, arg);
    }
    if (ref && run.env.refs?.[ref]) props.ref = run.env.refs[ref];
    if (run.debug) props["data-lb-id"] = id;
    return props;
  };
}

function buildHtml(node: LNode): (run: Run, chain: Chain, key: string) => ReactNode {
  const src = node.text ?? "";
  const props = buildAttrs(node);
  return (run, chain, key) => {
    let nodes: SafeNode[] = [];
    try {
      const actions = Object.keys(run.env.actions ?? {});
      nodes = parseSafeHtml(compileTemplate(src).run(chain, run.opts), { panels: [], fns: actions });
    } catch (err) {
      fail(run, node.id, (err as Error).message);
    }
    const p = props(run, chain);
    p.key = key;
    const onClick = (event: { target: EventTarget | null; currentTarget: EventTarget; preventDefault: () => void }) => {
      const target = (event.target as HTMLElement | null)?.closest?.("[data-action]");
      if (!target || !(event.currentTarget as HTMLElement).contains(target)) return;
      const action = (target.getAttribute("data-action") ?? "").replace(/^fn:/, "").split(":");
      const fn = run.env.actions?.[action[0]];
      if (fn) { event.preventDefault(); fn(event, action.slice(1).join(":") || undefined); }
    };
    if (!p.onClick) p.onClick = onClick;
    return createElement("div", p, ...safe(nodes, `${key}.`));
  };
}

const iconCache = new Map<string, unknown>();
function iconData(name: string): unknown {
  let data = iconCache.get(name);
  if (!data) {
    data = { name, node: MENU_ICONS[name], size: 24, aliases: MENU_ICON_ALIASES[name] ?? [] };
    iconCache.set(name, data);
  }
  return data;
}

function safe(nodes: SafeNode[], prefix: string): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${prefix}${i}`;
    if (typeof n === "string") return <Fragment key={k}>{n}</Fragment>;
    if (n.t === "i" && n.a["data-icon"]) {
      return createElement(Icon, { key: k, icon: iconData(iconName(n.a["data-icon"])) as never, className: "mb-inline-icon" });
    }
    const props: Record<string, unknown> = { key: k };
    for (const [name, value] of Object.entries(n.a)) {
      if (name === "class") props.className = value;
      else if (name === "style") {
        const st: Record<string, string> = {};
        for (const decl of value.split(";")) {
          const at = decl.indexOf(":");
          if (at > 0) st[camel(decl.slice(0, at).trim())] = decl.slice(at + 1).trim();
        }
        props.style = st;
      } else props[name] = value;
    }
    return createElement(n.t, props, ...(n.c.length ? safe(n.c, `${k}.`) : []));
  });
}

function draw(tree: LNode, env: LayoutEnv): ReactNode {
  const base = { translate: env.translate, lang: env.lang };
  const run: Run = { env, debug: Boolean(env.debug ?? previewMode), opts: base, rawOpts: { ...base, raw: true }, errors: null, blockDepth: 0 };
  return compileNode(tree)(run, [env.data], tree.id);
}

/** Draws a layout tree with the component's data, actions, slots and refs. */
export function LayoutView({ tree, env }: { tree: LNode; env: LayoutEnv }): ReactNode {
  return draw(tree, env);
}

/** The same as a function (for components that build their tree inline). */
export function renderLayout(tree: LNode, env: LayoutEnv): ReactNode {
  return draw(tree, env);
}
