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
import { evalExpression, isTruthy, lookupValue, parseSafeHtml, renderTemplate, valueText, type SafeNode, type TemplateVars } from "../lib/menu-template";
import { styleProps } from "../lib/menu-style";
import { MENU_ICON_ALIASES, MENU_ICONS } from "../lib/menu-icons-data";
import { M5Logo } from "./M5Logo";
import { Avatar } from "./UserBadge";

export type LayoutActions = Record<string, (event: unknown, arg?: unknown) => void>;
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

type Scope = TemplateVars;

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
};

/** HTML attribute → React prop. */
const PROP_NAMES: Record<string, string> = {
  class: "className", for: "htmlFor", tabindex: "tabIndex", readonly: "readOnly", maxlength: "maxLength", minlength: "minLength",
  autocomplete: "autoComplete", autofocus: "autoFocus", spellcheck: "spellCheck", inputmode: "inputMode", enterkeyhint: "enterKeyHint",
  accesskey: "accessKey", novalidate: "noValidate", datetime: "dateTime", hreflang: "hrefLang",
};

const URL_ATTRS = new Set(["href", "src", "cite"]);

/** An icon of the catalog by name or by one of its old names. */
const ICON_BY_ALIAS: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [name, aliases] of Object.entries(MENU_ICON_ALIASES)) for (const a of aliases) out[a] = name;
  return out;
})();
export function iconName(name: string): string {
  return MENU_ICONS[name] ? name : ICON_BY_ALIAS[name] ?? "circle-alert";
}

/**
 * The common cases, compiled once: "$a.b", "!$a.b" (conditions) and "{$a.b}"
 * (texts) look the value up directly instead of running the template engine.
 * Same semantics as the engine (own properties, forbidden names, printing).
 */
type Fast = (scope: Scope) => unknown;
const fastExpr = new Map<string, Fast | null>();
const fastText = new Map<string, Fast | null>();
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);
function accessor(path: string): Fast | null {
  const parts = path.split(".");
  if (parts.some((p) => FORBIDDEN.has(p))) return null;
  const [head, ...rest] = parts;
  return (scope) => {
    let v: unknown = Object.prototype.hasOwnProperty.call(scope, head) ? scope[head] : undefined;
    for (const p of rest) v = lookupValue(v, p);
    return v;
  };
}
function compiledExpr(src: string): Fast | null {
  let f = fastExpr.get(src);
  if (f !== undefined) return f;
  const m = /^\s*(!?)\$([A-Za-z_]\w*(?:\.[A-Za-z0-9_]+)*)\s*$/.exec(src);
  const get = m ? accessor(m[2]) : null;
  f = get ? (m![1] ? (scope) => !isTruthy(get(scope)) : get) : null;
  if (fastExpr.size > 4000) fastExpr.clear();
  fastExpr.set(src, f);
  return f;
}
function compiledText(src: string): Fast | null {
  let f = fastText.get(src);
  if (f !== undefined) return f;
  const m = /^\{\$([A-Za-z_]\w*(?:\.[A-Za-z0-9_]+)*)\}$/.exec(src);
  const get = m ? accessor(m[1]) : null;
  f = get ? (scope) => valueText(get(scope)) : null;
  if (fastText.size > 4000) fastText.clear();
  fastText.set(src, f);
  return f;
}

const camel = (prop: string) => (prop.startsWith("--") ? prop : prop.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase()));

class Renderer {
  private errors = new Set<string>();
  private blockDepth = 0;
  constructor(private readonly env: LayoutEnv) {}

  private fail(node: LNode, message: string) {
    const key = `${node.id}:${message}`;
    if (this.errors.has(key)) return;
    this.errors.add(key);
    (this.env.onError ?? previewMode?.onError)?.(node.id, message);
  }

  /** An expression's value (undefined when it fails). */
  expr(node: LNode, src: string, scope: Scope): unknown {
    const fast = compiledExpr(src);
    if (fast) return fast(scope);
    try {
      return evalExpression(src, scope, { translate: this.env.translate, lang: this.env.lang });
    } catch (err) {
      this.fail(node, `${src}: ${(err as Error).message}`);
      return undefined;
    }
  }

  /** A template as plain text. */
  text(node: LNode, src: string, scope: Scope): string {
    if (!src.includes("{")) return src;
    const fast = compiledText(src);
    if (fast) return fast(scope) as string;
    try {
      return renderTemplate(src, scope, { translate: this.env.translate, lang: this.env.lang, raw: true });
    } catch (err) {
      this.fail(node, `${src.slice(0, 60)}: ${(err as Error).message}`);
      return "";
    }
  }

  /** An attribute or parameter value: "=expression" keeps its type, anything else is template text. */
  value(node: LNode, src: string, scope: Scope): unknown {
    if (src.startsWith("=")) {
      const v = this.expr(node, src.slice(1), scope);
      return v === null ? undefined : v;
    }
    return this.text(node, src, scope);
  }

  render(node: LNode, scope: Scope, key?: string): ReactNode {
    if (node.hidden) return null;
    if (node.each) {
      const list = this.expr(node, node.each, scope);
      const items = Array.isArray(list) ? list : list && typeof list === "object" ? Object.values(list as Record<string, unknown>) : [];
      const as = node.as || "item";
      const one: LNode = { ...node, each: undefined };
      return items.slice(0, 2000).map((item, i) => {
        const inner: Scope = {
          ...scope,
          [as]: item,
          iterator: { counter: i + 1, counter0: i, first: i === 0, last: i === items.length - 1, odd: i % 2 === 0, even: i % 2 === 1, length: items.length },
        };
        const k = node.key ? this.value(node, node.key.startsWith("=") ? node.key : `=${node.key}`, inner) : i;
        return this.render(one, inner, `${node.id}:${String(k)}`);
      });
    }
    if (node.if && !isTruthy(this.expr(node, node.if, scope))) return null;
    const k = key ?? node.id;
    switch (node.el) {
      case "text": {
        const t = this.text(node, node.text ?? "", scope);
        const format = node.props?.format;
        if (format && this.env.formats?.[format]) return <Fragment key={k}>{this.env.formats[format](t)}</Fragment>;
        return t === "" ? null : <Fragment key={k}>{t}</Fragment>;
      }
      case "group":
        return <Fragment key={k}>{this.children(node, scope)}</Fragment>;
      case "slot": {
        const fn = node.slot ? this.env.slots?.[node.slot] : undefined;
        if (!fn) return null;
        const arg = node.arg ? this.value(node, node.arg.startsWith("=") ? node.arg : `=${node.arg}`, scope) : undefined;
        return this.mark(node, k, fn(arg, scope));
      }
      case "block": {
        const tree = node.block ? this.env.blocks?.[node.block] : undefined;
        if (!tree || this.blockDepth >= 6) return null;
        const inner = node.arg ? { ...scope, arg: this.value(node, node.arg.startsWith("=") ? node.arg : `=${node.arg}`, scope) } : scope;
        this.blockDepth++;
        try { return this.mark(node, k, this.render(tree, inner)); } finally { this.blockDepth--; }
      }
      case "icon": return this.icon(node, scope, k);
      case "logo": {
        const p = this.attrs(node, "svg", scope);
        const size = Number(this.value(node, node.props?.size ?? "36", scope)) || 36;
        const mono = isTruthy(this.value(node, node.props?.mono ?? "=false", scope));
        return this.mark(node, k, <M5Logo size={size} mono={mono} className={p.className as string | undefined} />);
      }
      case "avatar": {
        const p = this.attrs(node, "span", scope);
        const size = Number(this.value(node, node.props?.size ?? "32", scope)) || 32;
        return this.mark(node, k, <Avatar name={String(this.value(node, node.props?.name ?? "", scope) ?? "")} avatar={String(this.value(node, node.props?.avatar ?? "", scope) ?? "") || undefined} size={size} className={(p.className as string | undefined) ?? ""} />);
      }
      case "html": return this.html(node, scope, k);
      default: return this.element(node, scope, k);
    }
  }

  /** Something drawn without an element of this tree (a live part, a template, the logo, an avatar):
   *  in the builder's preview it gets a box of its own (display: contents) to be picked by a click. */
  mark(node: LNode, key: string, content: ReactNode): ReactNode {
    if (!(this.env.debug ?? previewMode)) return <Fragment key={key}>{content}</Fragment>;
    return <span key={key} data-lb-id={node.id} style={{ display: "contents" }}>{content}</span>;
  }

  children(node: LNode, scope: Scope): ReactNode[] {
    const out: ReactNode[] = [];
    if (node.text !== undefined && node.el !== "html") {
      const t = this.text(node, node.text, scope);
      if (t !== "") out.push(t);
    }
    for (const c of node.children ?? []) {
      const r = this.render(c, scope);
      if (r !== null && r !== undefined) out.push(r);
    }
    return out;
  }

  /** Attributes, CSS, the designer's style, events and a ref → React props. */
  attrs(node: LNode, tag: string, scope: Scope): Record<string, unknown> {
    const props: Record<string, unknown> = {};
    for (const [name, raw] of Object.entries(node.attrs ?? {})) {
      let v = this.value(node, raw, scope);
      if (v === undefined) continue;
      if (BOOLEAN_ATTRS.has(name)) {
        if (typeof v === "string") v = v === "" || v === "true" || v === name;
        else v = isTruthy(v);
      }
      if (URL_ATTRS.has(name) && typeof v === "string" && !isSafeUrl(v, { data: raw.startsWith("=") || raw.includes("{") })) {
        this.fail(node, `${name}: not a safe address`);
        continue;
      }
      props[PROP_NAMES[name] ?? name] = v;
    }
    const designer = node.style ? styleProps(node.style) : null;
    if (designer?.className) props.className = props.className ? `${props.className as string} ${designer.className}` : designer.className;
    let style: Record<string, unknown> | null = null;
    if (node.styleBind) {
      const bound = this.expr(node, node.styleBind, scope);
      if (bound && typeof bound === "object") style = { ...(bound as Record<string, unknown>) };
    }
    if (node.css) {
      style = style ?? {};
      for (const [prop, raw] of Object.entries(node.css)) {
        const v = this.text(node, raw, scope);
        if (v !== "" && isSafeCssValue(v)) style[camel(prop)] = v;
      }
    }
    if (designer && Object.keys(designer.style).length) style = { ...(style ?? {}), ...(designer.style as Record<string, unknown>) };
    if (style) props.style = style as CSSProperties;
    for (const [ev, binding] of Object.entries(node.on ?? {}) as Array<[LayoutEvent, { action: string; arg?: string }]>) {
      const fn = this.env.actions?.[binding.action];
      if (!fn) continue;
      const arg = binding.arg ? this.value(node, binding.arg.startsWith("=") ? binding.arg : `=${binding.arg}`, scope) : undefined;
      props[EVENT_PROPS[ev]] = (event: unknown) => fn(event, arg);
    }
    if (node.ref && this.env.refs?.[node.ref]) props.ref = this.env.refs[node.ref];
    if (this.env.debug ?? previewMode) props["data-lb-id"] = node.id;
    void tag;
    return props;
  }

  element(node: LNode, scope: Scope, key: string): ReactNode {
    const def = ELEMENT_BY_KIND[node.el];
    const tag = node.tag ?? def?.tag;
    if (!tag) return <Fragment key={key}>{this.children(node, scope)}</Fragment>;
    const props = this.attrs(node, tag, scope);
    props.key = key;
    if (def && !def.container && !def.text) return createElement(tag, props);
    const kids = this.children(node, scope);
    // <textarea> and <option> take their text as the value / label.
    if (tag === "textarea") return createElement(tag, props);
    return createElement(tag, props, ...kids);
  }

  icon(node: LNode, scope: Scope, key: string): ReactNode {
    const name = iconName(String(this.value(node, node.props?.icon ?? "circle-alert", scope) ?? "").trim());
    const props = this.attrs(node, "svg", scope);
    const stroke = node.props?.strokeWidth ? Number(this.value(node, node.props.strokeWidth, scope)) : undefined;
    const data = { name, node: MENU_ICONS[name], size: 24, aliases: MENU_ICON_ALIASES[name] ?? [] };
    return createElement(Icon, { key, icon: data as never, ...(stroke ? { strokeWidth: stroke } : {}), ...props });
  }

  html(node: LNode, scope: Scope, key: string): ReactNode {
    let nodes: SafeNode[] = [];
    try {
      const actions = Object.keys(this.env.actions ?? {});
      nodes = parseSafeHtml(renderTemplate(node.text ?? "", scope, { translate: this.env.translate, lang: this.env.lang }), { panels: [], fns: actions });
    } catch (err) {
      this.fail(node, (err as Error).message);
    }
    const props = this.attrs(node, "div", scope);
    props.key = key;
    const onClick = (event: { target: EventTarget | null; currentTarget: EventTarget; preventDefault: () => void }) => {
      const target = (event.target as HTMLElement | null)?.closest?.("[data-action]");
      if (!target || !(event.currentTarget as HTMLElement).contains(target)) return;
      const action = (target.getAttribute("data-action") ?? "").replace(/^fn:/, "").split(":");
      const fn = this.env.actions?.[action[0]];
      if (fn) { event.preventDefault(); fn(event, action.slice(1).join(":") || undefined); }
    };
    if (!props.onClick) props.onClick = onClick;
    return createElement("div", props, ...this.safe(nodes, `${key}.`));
  }

  private safe(nodes: SafeNode[], prefix: string): ReactNode[] {
    return nodes.map((n, i) => {
      const k = `${prefix}${i}`;
      if (typeof n === "string") return <Fragment key={k}>{n}</Fragment>;
      if (n.t === "i" && n.a["data-icon"]) {
        const name = iconName(n.a["data-icon"]);
        return createElement(Icon, { key: k, icon: { name, node: MENU_ICONS[name], size: 24, aliases: MENU_ICON_ALIASES[name] ?? [] } as never, className: "mb-inline-icon" });
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
      return createElement(n.t, props, ...(n.c.length ? this.safe(n.c, `${k}.`) : []));
    });
  }
}

/** Draws a layout tree with the component's data, actions, slots and refs. */
export function LayoutView({ tree, env }: { tree: LNode; env: LayoutEnv }): ReactNode {
  return new Renderer(env).render(tree, env.data);
}

/** The same as a function (for components that build their tree inline). */
export function renderLayout(tree: LNode, env: LayoutEnv): ReactNode {
  return new Renderer(env).render(tree, env.data);
}
