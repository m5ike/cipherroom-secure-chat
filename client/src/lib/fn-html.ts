// A function's HTML output (6.6: m5.out.html) made safe — one PURE parser (no
// DOM) the server, the web chat, the console and the Android app's checks all
// share. It keeps document markup only: headings, paragraphs, lists, tables,
// details, figures, links to http(s) / mailto, and pictures that are data:
// URIs of an image type. Scripts, styles, forms, frames, media, event handlers
// and every other attribute are dropped; `class` keeps only the report classes
// (m5h-…, so a function cannot dress up as the app), and `style` only harmless
// properties without url(). The result is a tree the clients turn into
// elements — never innerHTML — and the server stores it re-serialized.

export type HtmlNode = string | { t: string; a: Record<string, string>; c: HtmlNode[] };

export const FN_HTML_MAX = 2_000_000;
const MAX_NODES = 20_000;
const MAX_DEPTH = 48;

const ALLOWED = new Set([
  "div", "span", "p", "br", "hr", "b", "strong", "i", "em", "u", "s", "small", "mark", "code", "kbd", "samp", "var", "pre", "sub", "sup", "abbr", "time", "q", "cite", "del", "ins",
  "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "dl", "dt", "dd", "blockquote", "section", "article", "header", "footer", "aside", "figure", "figcaption",
  "details", "summary", "table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td", "colgroup", "col", "a", "img",
]);
const VOID = new Set(["br", "hr", "img", "col", "wbr"]);
/** Dropped with everything inside them. */
const DROP = new Set(["script", "style", "iframe", "object", "embed", "template", "noscript", "svg", "math", "textarea", "select", "option", "form", "input", "button", "link", "meta", "base", "frame", "frameset", "audio", "video", "source", "track", "canvas", "title", "head", "dialog", "portal", "applet"]);
const GLOBAL = new Set(["class", "style", "title", "lang", "dir"]);
const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href"]),
  img: new Set(["src", "alt", "width", "height"]),
  td: new Set(["colspan", "rowspan"]), th: new Set(["colspan", "rowspan", "scope"]),
  col: new Set(["span"]), colgroup: new Set(["span"]),
  ol: new Set(["start", "reversed"]), time: new Set(["datetime"]), details: new Set(["open"]),
};
const STYLE_PROPS = new Set([
  "color", "background-color", "font-size", "font-weight", "font-style", "font-family", "text-align", "text-decoration", "text-transform", "letter-spacing",
  "line-height", "white-space", "word-break", "vertical-align", "margin", "margin-top", "margin-right", "margin-bottom", "margin-left", "padding", "padding-top",
  "padding-right", "padding-bottom", "padding-left", "border", "border-top", "border-bottom", "border-left", "border-right", "border-color", "border-width",
  "border-style", "border-radius", "border-collapse", "display", "gap", "align-items", "justify-content", "flex", "flex-wrap", "flex-direction", "width", "max-width",
  "min-width", "height", "max-height", "min-height", "opacity", "overflow", "overflow-x", "text-overflow",
]);
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", bull: "•", ndash: "–", mdash: "—", hellip: "…", times: "×", euro: "€", copy: "©", deg: "°" };

export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code < 0x110000 && !(code >= 0xd800 && code < 0xe000) ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function safeStyle(style: string): string {
  const out: string[] = [];
  for (const decl of style.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const value = decl.slice(i + 1).trim();
    if (!STYLE_PROPS.has(prop) || !value || value.length > 160) continue;
    if (/url\s*\(|expression|javascript:|@import|\\|[<>{}]|behavior|var\s*\(|attr\s*\(/i.test(value)) continue;
    // 6.7 (N26): nothing that reaches out of the output's box over other messages —
    // no negative margins, no sizes relative to the window.
    if (prop.startsWith("margin") && /(^|[\s(,])-\s*[\d.]/.test(value)) continue;
    if (/\d\s*(d|s|l)?v(w|h|min|max|i|b)\b/i.test(value)) continue;
    if (prop === "display" && !/^(inline|inline-block|block|flex|inline-flex|grid|table|table-row|table-cell|none)$/.test(value)) continue;
    out.push(`${prop}: ${value}`);
  }
  return out.join("; ");
}

const IMG_SRC = /^data:image\/(png|jpeg|gif|webp|bmp);base64,[A-Za-z0-9+/]+={0,2}$/;
const OPEN_TAG = /<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y;
const CLOSE_TAG = /<\/([a-zA-Z][a-zA-Z0-9]*)\s*>/y;
function safeHref(v: string): string | null {
  const s = v.trim();
  return /^https?:\/\/[^\s"'<>]+$/i.test(s) || /^mailto:[^\s"'<>]+$/i.test(s) ? s : null;
}

/** Parses HTML and keeps only the safe document markup (see the header). */
export function parseFnHtml(html: string): HtmlNode[] {
  const src = String(html ?? "").slice(0, FN_HTML_MAX);
  const root = { t: "#root", a: {} as Record<string, string>, c: [] as HtmlNode[] };
  const stack: Array<typeof root> = [root];
  let drop = 0, dropTag = "", nodes = 0, i = 0;
  const top = () => stack[stack.length - 1];
  const text = (s: string) => {
    if (drop || !s) return;
    const d = decodeHtmlEntities(s);
    const p = top();
    const last = p.c[p.c.length - 1];
    if (typeof last === "string") p.c[p.c.length - 1] = last + d; else { p.c.push(d); nodes++; }
  };
  while (i < src.length && nodes < MAX_NODES) {
    const lt = src.indexOf("<", i);
    if (lt < 0) { text(src.slice(i)); break; }
    text(src.slice(i, lt));
    if (src.startsWith("<!--", lt)) { const end = src.indexOf("-->", lt + 4); i = end < 0 ? src.length : end + 3; continue; }
    if (src.startsWith("<!", lt) || src.startsWith("<?", lt)) { const end = src.indexOf(">", lt); i = end < 0 ? src.length : end + 1; continue; }
    const close = src[lt + 1] === "/";
    // Sticky matches on the whole source: a picture's data: URI can be long, and
    // names never take a "<", so a broken tag fails at the next one (linear time).
    const re = close ? CLOSE_TAG : OPEN_TAG;
    re.lastIndex = lt;
    const m = re.exec(src);
    if (!m) { text("<"); i = lt + 1; continue; }
    i = re.lastIndex;
    const tag = m[1].toLowerCase();
    if (close) {
      if (drop) { if (tag === dropTag && --drop === 0) dropTag = ""; continue; }
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].t === tag) { stack.length = k; break; }
      continue;
    }
    if (drop) { if (tag === dropTag && !VOID.has(tag) && !m[3]) drop++; continue; }
    if (DROP.has(tag)) { if (!m[3] && !VOID.has(tag)) { drop = 1; dropTag = tag; } continue; }
    if (!ALLOWED.has(tag)) continue;
    const attrs: Record<string, string> = {};
    const are = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let am: RegExpExecArray | null;
    while ((am = are.exec(m[2] ?? ""))) {
      const name = am[1].toLowerCase();
      const value = decodeHtmlEntities(am[2] ?? am[3] ?? am[4] ?? "");
      if (name.startsWith("on") || (!GLOBAL.has(name) && !TAG_ATTRS[tag]?.has(name))) continue;
      if (name === "class") { const cls = value.split(/\s+/).filter((c) => /^m5h-[a-z0-9-]{1,40}$/.test(c)).slice(0, 8).join(" "); if (cls) attrs.class = cls; continue; }
      if (name === "style") { const st = safeStyle(value); if (st) attrs.style = st; continue; }
      if (name === "href") { const u = safeHref(value); if (u) attrs.href = u; continue; }
      if (name === "src") { const v = value.replace(/\s+/g, ""); if (IMG_SRC.test(v)) attrs.src = v; continue; }
      if (["width", "height", "colspan", "rowspan", "span", "start"].includes(name)) { const n = Number(value); if (Number.isInteger(n) && n >= 0 && n <= (name === "width" || name === "height" ? 4000 : 1000)) attrs[name] = String(n); continue; }
      if (name === "dir") { if (value === "ltr" || value === "rtl" || value === "auto") attrs.dir = value; continue; }
      if (name === "scope") { if (/^(row|col|rowgroup|colgroup)$/.test(value)) attrs.scope = value; continue; }
      if (name === "open" || name === "reversed") { attrs[name] = ""; continue; }
      attrs[name] = value.slice(0, 300);
    }
    if (tag === "img" && !attrs.src) continue; // no picture, no element
    const el = { t: tag, a: attrs, c: [] as HtmlNode[] };
    top().c.push(el);
    nodes++;
    if (!VOID.has(tag) && !m[3] && stack.length < MAX_DEPTH) stack.push(el);
  }
  return root.c;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** A safe tree back to HTML text (what the server stores). */
export function serializeFnHtml(nodes: HtmlNode[]): string {
  return nodes.map((n) => {
    if (typeof n === "string") return esc(n);
    const attrs = Object.entries(n.a).map(([k, v]) => (v === "" && (k === "open" || k === "reversed") ? ` ${k}` : ` ${k}="${esc(v)}"`)).join("");
    return VOID.has(n.t) ? `<${n.t}${attrs}>` : `<${n.t}${attrs}>${serializeFnHtml(n.c)}</${n.t}>`;
  }).join("");
}

/** Sanitizes HTML text: parse, keep what is safe, serialize. */
export function sanitizeFnHtml(html: string): string {
  return serializeFnHtml(parseFnHtml(html));
}

const BLOCKS = new Set(["p", "div", "section", "article", "header", "footer", "aside", "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr", "dt", "dd", "pre", "blockquote", "figure", "figcaption", "details", "summary", "table", "caption"]);
/** The text of a safe tree (search, forwarding, older apps). */
export function fnHtmlText(nodes: HtmlNode[]): string {
  const walk = (list: HtmlNode[]): string => list.map((n) => {
    if (typeof n === "string") return n;
    if (n.t === "br") return "\n";
    if (n.t === "img") return n.a.alt ? `[${n.a.alt}]` : "";
    const inner = walk(n.c);
    if (n.t === "td" || n.t === "th") return `${inner}\t`;
    return BLOCKS.has(n.t) ? `\n${inner}\n` : inner;
  }).join("");
  return walk(nodes).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
