// Pasted HTML → a Layout builder tree (4.13). PURE module (no DOM): the
// admin service converts, the builder inserts the result.
//
// A forgiving tokenizer (unclosed tags, implied </li> </p> </option>,
// entities), then every tag becomes the palette element it is: <div> a
// Panel, <span>/<b>/<code> an Area, <h1>–<h6> a Heading, <p> a Paragraph,
// <a> a Link, <img> an Image, <button>, <input>, <select>/<option>,
// <textarea>, <label>, <form>, <ul>/<ol>/<li>, <hr>, lucide <svg> icons…
// style="…" becomes CSS, class and safe attributes stay. Scripts, styles,
// frames and on… handlers are dropped — and the sanitizer checks the result
// like any tree an operator saves. Whatever did not fit is listed as a
// warning.

import { ELEMENT_BY_KIND, LAYOUT_LIMITS, sanitizeTree, walkTree, type ElementKind, type LNode } from "./layout-tree";
import { compileTemplate } from "./menu-template";
import { MENU_ICON_ALIASES, MENU_ICONS } from "./menu-icons-data";

export type HtmlImport = { tree: LNode | null; warnings: string[]; count: number };

export const HTML_IMPORT_MAX = 200_000;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const DROP = new Set(["script", "style", "iframe", "frame", "frameset", "object", "embed", "link", "meta", "base", "template", "noscript", "title", "head", "canvas", "math"]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);
const BLOCK = ["div", "section", "article", "header", "footer", "main", "nav", "aside", "figure", "figcaption", "details", "summary", "fieldset", "legend", "blockquote", "address"];
const INLINE = ["span", "strong", "em", "b", "i", "u", "s", "small", "code", "kbd", "mark", "abbr", "time", "sup", "sub", "q", "cite", "bdi", "output", "data", "var", "samp", "del", "ins"];
/** Tags that end an open <p>. */
const CLOSES_P = new Set([...BLOCK, "p", "ul", "ol", "table", "form", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "pre"]);

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–",
  laquo: "«", raquo: "»", bdquo: "„", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", middot: "·", bull: "•", times: "×", euro: "€", deg: "°",
};
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code < 0x110000 && !(code >= 0xd800 && code < 0xe000) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

type HNode = { tag: string; attrs: Record<string, string>; children: Array<HNode | string> };

/** HTML → a loose element tree (what a browser would roughly build). */
function parse(html: string, warn: (w: string) => void): HNode {
  const root: HNode = { tag: "#root", attrs: {}, children: [] };
  const stack: HNode[] = [root];
  const top = () => stack[stack.length - 1];
  const closeTo = (tag: string) => {
    for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === tag) { stack.length = i; return true; }
    return false;
  };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) { top().children.push(decode(html.slice(i))); break; }
    if (lt > i) top().children.push(decode(html.slice(i, lt)));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const end = html.indexOf(">", lt);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    const close = /^<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>/.exec(html.slice(lt, lt + 80));
    if (close) {
      const tag = close[1].toLowerCase();
      closeTo(tag);
      i = lt + close[0].length;
      continue;
    }
    const open = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(lt, lt + 80));
    if (!open) { top().children.push("<"); i = lt + 1; continue; }
    const tag = open[1].toLowerCase();
    // Attributes, up to the end of the tag.
    let j = lt + open[0].length;
    const attrs: Record<string, string> = {};
    let selfClose = false;
    while (j < html.length) {
      while (j < html.length && /\s/.test(html[j])) j++;
      if (html[j] === ">") { j++; break; }
      if (html.startsWith("/>", j)) { selfClose = true; j += 2; break; }
      const name = /^[^\s"'>/=]+/.exec(html.slice(j));
      if (!name) { j++; continue; }
      j += name[0].length;
      while (j < html.length && /\s/.test(html[j])) j++;
      let value = "";
      if (html[j] === "=") {
        j++;
        while (j < html.length && /\s/.test(html[j])) j++;
        const q = html[j];
        if (q === "\"" || q === "'") {
          const end = html.indexOf(q, j + 1);
          value = html.slice(j + 1, end < 0 ? html.length : end);
          j = end < 0 ? html.length : end + 1;
        } else {
          const m = /^[^\s>]*/.exec(html.slice(j))!;
          value = m[0];
          j += m[0].length;
        }
      }
      const key = name[0].toLowerCase();
      if (!(key in attrs)) attrs[key] = decode(value);
    }
    i = j;
    // Implied ends.
    if (tag === "li") { const at = stack.map((n) => n.tag).lastIndexOf("li"); const list = Math.max(stack.map((n) => n.tag).lastIndexOf("ul"), stack.map((n) => n.tag).lastIndexOf("ol")); if (at > list && at > 0) stack.length = at; }
    if (tag === "option" && top().tag === "option") stack.pop();
    if (CLOSES_P.has(tag) && stack.some((n) => n.tag === "p")) closeTo("p");
    const node: HNode = { tag, attrs, children: [] };
    if (RAW_TEXT.has(tag) && !selfClose) {
      const end = html.toLowerCase().indexOf(`</${tag}`, i);
      const body = html.slice(i, end < 0 ? html.length : end);
      if (tag === "textarea") node.children.push(decode(body));
      i = end < 0 ? html.length : html.indexOf(">", end) + 1 || html.length;
      if (DROP.has(tag)) { warn(`<${tag}> removed`); continue; }
      top().children.push(node);
      continue;
    }
    top().children.push(node);
    if (!VOID.has(tag) && !selfClose) stack.push(node);
  }
  return root;
}

/** A value kept as the text it is: braces that are not a working template, and a leading "=", made literal. */
function literal(v: string): string {
  let out = v;
  if (out.includes("{")) {
    try { compileTemplate(out); } catch { out = out.replace(/\{/g, "{l}"); }
  }
  return out.startsWith("=") ? `{=''}${out}` : out;
}

function cssOf(style: string): Record<string, string> {
  const css: Record<string, string> = {};
  for (const decl of style.split(";")) {
    const at = decl.indexOf(":");
    if (at <= 0) continue;
    const prop = decl.slice(0, at).trim().toLowerCase();
    const value = decl.slice(at + 1).trim().replace(/\s*!important$/i, "");
    if (prop && value) css[prop] = value;
  }
  return css;
}

const ICON_BY_ALIAS: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [name, aliases] of Object.entries(MENU_ICON_ALIASES)) for (const a of aliases) out[a] = name;
  return out;
})();
const knownIcon = (name: string) => (MENU_ICONS[name] ? name : ICON_BY_ALIAS[name]);

/** Converts pasted HTML into an element tree of the palette (several top-level elements: a Group). */
export function htmlToTree(html: string): HtmlImport {
  const warnings: string[] = [];
  const warned = new Set<string>();
  const warn = (w: string) => { if (!warned.has(w) && warnings.length < 40) { warned.add(w); warnings.push(w); } };
  if (html.length > HTML_IMPORT_MAX) return { tree: null, warnings: [`The HTML is longer than ${HTML_IMPORT_MAX} characters.`], count: 0 };
  const doc = parse(html, warn);
  const counters = new Map<string, number>();
  const newId = (stem: string) => {
    const n = (counters.get(stem) ?? 0) + 1;
    counters.set(stem, n);
    return `${stem}-${n}`;
  };

  const element = (h: HNode): LNode | null => {
    const tag = h.tag;
    if (DROP.has(tag)) { warn(`<${tag}> removed`); return null; }
    let el: ElementKind;
    let as: string | undefined = tag;
    if (BLOCK.includes(tag)) el = "panel";
    else if (INLINE.includes(tag)) el = "area";
    else if (/^h[1-6]$/.test(tag)) el = "heading";
    else if (tag === "p" || tag === "pre") el = "paragraph";
    else if (tag === "a") el = "link";
    else if (tag === "img") el = "image";
    else if (tag === "audio") el = "audio";
    else if (tag === "video") el = "video";
    else if (tag === "button") el = "button";
    else if (tag === "input") el = "input";
    else if (tag === "textarea") el = "textarea";
    else if (tag === "select") el = "select";
    else if (tag === "option") el = "option";
    else if (tag === "label") el = "label";
    else if (tag === "form") el = "form";
    else if (tag === "ul" || tag === "ol" || tag === "menu") el = "list";
    else if (tag === "li") el = "item";
    else if (tag === "hr") el = "separator";
    else if (tag === "svg" || (tag === "i" && h.attrs["data-icon"])) {
      const cls = (h.attrs.class ?? "").split(/\s+/).filter(Boolean);
      const name = h.attrs["data-icon"] ?? cls.map((c) => /^lucide-(.+)$/.exec(c)?.[1]).find((n) => n && knownIcon(n));
      const icon = name ? knownIcon(name) : undefined;
      if (!icon) { warn("an <svg> that is not an icon of the catalog was removed"); return null; }
      const node: LNode = { id: newId("icon"), el: "icon", props: { icon } };
      const rest = cls.filter((c) => c !== "lucide" && !c.startsWith("lucide-")).join(" ");
      const attrs: Record<string, string> = {};
      if (rest) attrs.class = rest;
      for (const [k, v] of Object.entries(h.attrs)) if (/^aria-|^data-(?!icon$)|^title$|^role$/.test(k)) attrs[k] = literal(v);
      if (Object.keys(attrs).length) node.attrs = attrs;
      return node;
    } else if (tag === "br") {
      warn("<br> is not an element of the palette: a space instead (a Column or a Paragraph per line breaks lines)");
      return { id: newId("text"), el: "text", text: " " };
    } else if (tag === "table") el = "table";
    else if (tag === "thead" || tag === "tbody" || tag === "tfoot") el = "tableSection";
    else if (tag === "tr") el = "tableRow";
    else if (tag === "td" || tag === "th") el = "tableCell";
    else {
      warn(`<${tag}> is not in the palette: it became a Panel`);
      el = "panel"; as = "div";
    }
    const def = ELEMENT_BY_KIND[el];
    const node: LNode = { id: "", el };
    if (def.tag) node.tag = def.tags?.includes(as) ? as : def.tag;
    // The id: from id="…" when it makes one, else the kind numbered.
    const own = (h.attrs.id ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
    node.id = own && /^[a-z0-9]/.test(own) && !counters.has(`#${own}`) ? (counters.set(`#${own}`, 1), own) : newId(el);
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(h.attrs)) {
      if (k.startsWith("on")) { warn(`on… handlers removed (${k}) — events run the layout's actions instead`); continue; }
      if (k === "style") { const css = cssOf(v); if (Object.keys(css).length) node.css = Object.fromEntries(Object.entries(css).map(([p, x]) => [p, literal(x)])); continue; }
      attrs[k] = literal(v);
    }
    if (Object.keys(attrs).length) node.attrs = attrs;
    // Content: one text alone becomes the element's text; else children.
    const kids = h.children;
    if (tag === "textarea") {
      const t = kids.filter((k): k is string => typeof k === "string").join("");
      if (t) { attrs.value = literal(t); node.attrs = attrs; }
      return node;
    }
    if (!def.container) {
      if (def.text && kids.length) node.text = literal(textOf(h));
      else if (kids.some((k) => typeof k !== "string" || k.trim())) warn(`what was inside <${tag}> was left out (it takes no children)`);
      return node;
    }
    const children = content(kids, tag === "pre");
    if (def.text && children.length === 1 && children[0].el === "text") node.text = children[0].text;
    else node.children = children;
    return node;
  };

  const content = (kids: Array<HNode | string>, pre = false): LNode[] => {
    const out: LNode[] = [];
    for (const k of kids) {
      if (typeof k === "string") {
        if (!pre && !k.trim() && (k.includes("\n") || !out.length)) continue;
        const t = pre ? k : k.replace(/\s+/g, " ");
        out.push({ id: newId("text"), el: "text", text: literal(t) });
        continue;
      }
      const n = element(k);
      if (n) out.push(n);
    }
    // Whitespace at the edges of a block is not drawn either.
    if (!pre) {
      const first = out[0];
      const last = out[out.length - 1];
      if (first?.el === "text") first.text = first.text!.trimStart();
      if (last?.el === "text") last.text = last.text!.trimEnd();
    }
    return out.filter((n) => !(n.el === "text" && n.text === ""));
  };

  const top = content(doc.children);
  if (!top.length) return { tree: null, warnings: warnings.length ? warnings : ["Nothing to convert."], count: 0 };
  const raw: LNode = top.length === 1 ? top[0] : { id: newId("group"), el: "group", children: top };
  const tree = sanitizeTree(raw, LAYOUT_LIMITS.nodes);
  if (!tree) return { tree: null, warnings: [...warnings, "Nothing to convert."], count: 0 };
  // What the checks left out (unsafe addresses, unknown attributes, CSS with url()…).
  const kept = new Map<string, LNode>();
  walkTree(tree, (n) => kept.set(n.id, n));
  let rawCount = 0;
  walkTree(raw, (n) => {
    rawCount++;
    const k = kept.get(n.id);
    if (!k) return;
    for (const a of Object.keys(n.attrs ?? {})) if (!(a in (k.attrs ?? {}))) warn(`${a}="…" left out (not allowed there, or not a safe address)`);
    for (const p of Object.keys(n.css ?? {})) if (!(p in (k.css ?? {}))) warn(`CSS ${p} left out (unknown, or a value with url(), expressions or imports)`);
  });
  let count = 0;
  walkTree(tree, () => { count++; });
  if (count < rawCount) warn(`${rawCount - count} elements left out (the limit is ${LAYOUT_LIMITS.nodes}, a select holds options only)`);
  return { tree, warnings, count };
}

function textOf(h: HNode): string {
  return h.children.map((k) => (typeof k === "string" ? k : textOf(k))).join("").replace(/\s+/g, " ").trim();
}
