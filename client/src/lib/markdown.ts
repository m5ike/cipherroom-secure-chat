// Markdown as AI answers write it (4.14): paragraphs, headings, lists (one
// level of nesting), code blocks, quotes, rules, tables; inline code, bold,
// italic, strike-through, links and bare web addresses. Parsed into a tree
// that components/Markdown.tsx draws as React elements — no HTML is ever
// produced or parsed, so nothing in an answer can become markup. Links keep
// only https / http / mailto. Half-written input (a stream) parses too: an
// unclosed code block runs to the end.

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong" | "em" | "del"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "br" };

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: 1 | 2 | 3 | 4 | 5 | 6; c: Inline[] }
  | { t: "code"; lang: string; v: string }
  | { t: "quote"; c: Block[] }
  | { t: "list"; ordered: boolean; start: number; items: Block[][] }
  | { t: "hr" }
  | { t: "table"; head: Inline[][]; rows: Inline[][][] };

const MAX_INPUT = 200_000;
const MAX_DEPTH = 4;

/** A link target that may be followed (else the text stays plain). */
export function safeHref(raw: string): string | null {
  const v = raw.trim();
  if (/^https?:\/\/[^\s<>"]+$/i.test(v)) return v;
  if (/^mailto:[^\s<>"]+$/i.test(v)) return v;
  return null;
}

/* ------------------------------------------------------------- inline */

export function parseInline(src: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => { if (text) { out.push({ t: "text", v: text }); text = ""; } };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const rest = src.slice(i);
    // A backslash escapes the next punctuation.
    if (ch === "\\" && i + 1 < src.length && /[\\`*_~[\]()#>!|-]/.test(src[i + 1])) { text += src[i + 1]; i += 2; continue; }
    if (ch === "\n") { flush(); out.push({ t: "br" }); i += 1; continue; }
    if (ch === "`") {
      const m = /^(`+)([\s\S]*?[^`])\1(?!`)/.exec(rest);
      if (m) { flush(); out.push({ t: "code", v: m[2].replace(/^ (.*) $/s, "$1") }); i += m[0].length; continue; }
    }
    if (depth < MAX_DEPTH) {
      const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
      if (strong) { flush(); out.push({ t: "strong", c: parseInline(strong[2], depth + 1) }); i += strong[0].length; continue; }
      const del = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest);
      if (del) { flush(); out.push({ t: "del", c: parseInline(del[1], depth + 1) }); i += del[0].length; continue; }
      // _italic_ only at a word's edge (snake_case stays as it is).
      const em = /^\*(?=\S)([^*]*?\S)\*(?!\*)/.exec(rest) ?? (/[^\w]|^$/.test(src[i - 1] ?? "") ? /^_(?=\S)([^_]*?\S)_(?!\w)/.exec(rest) : null);
      if (em) { flush(); out.push({ t: "em", c: parseInline(em[1], depth + 1) }); i += em[0].length; continue; }
      if (ch === "[") {
        const link = /^\[([^\]\n]{1,500})\]\(\s*<?([^)\s>]{1,2000})>?(?:\s+"[^"]*")?\s*\)/.exec(rest);
        if (link) {
          flush();
          const href = safeHref(link[2]);
          const label = parseInline(link[1], depth + 1);
          if (href) out.push({ t: "link", href, c: label }); else out.push(...label);
          i += link[0].length;
          continue;
        }
      }
    }
    if (ch === "<") {
      const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(rest);
      if (auto) { flush(); const href = safeHref(auto[1]); out.push(href ? { t: "link", href, c: [{ t: "text", v: auto[1] }] } : { t: "text", v: auto[0] }); i += auto[0].length; continue; }
    }
    if ((ch === "h" || ch === "H") && /[^\w/]|^$/.test(src[i - 1] ?? "")) {
      const bare = /^https?:\/\/[^\s<>"]+/i.exec(rest);
      if (bare) {
        // Trailing punctuation belongs to the sentence, not to the address.
        let url = bare[0].replace(/[.,;:!?'"]+$/, "");
        while (url.endsWith(")") && (url.match(/\(/g) ?? []).length < (url.match(/\)/g) ?? []).length) url = url.slice(0, -1);
        flush();
        out.push({ t: "link", href: url, c: [{ t: "text", v: url }] });
        i += url.length;
        continue;
      }
    }
    text += ch;
    i += 1;
  }
  flush();
  return out;
}

/* ------------------------------------------------------------- blocks */

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)[^\n]*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const BULLET = /^( {0,6})([-*+])\s+(.*)$/;
const ORDERED = /^( {0,6})(\d{1,9})[.)]\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") { cur += "|"; i += 1; continue; }
    if (s[i] === "|") { out.push(cur.trim()); cur = ""; continue; }
    cur += s[i];
  }
  out.push(cur.trim());
  return out;
}

export function parseMarkdown(input: string, depth = 0): Block[] {
  const src = input.length > MAX_INPUT ? input.slice(0, MAX_INPUT) : input;
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  const isBlockStart = (l: string) => FENCE.test(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l) || BULLET.test(l) || ORDERED.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`).test(lines[i])) { body.push(lines[i]); i += 1; }
      i += 1; // the closing fence (or past the end)
      blocks.push({ t: "code", lang: fence[2].toLowerCase(), v: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) { blocks.push({ t: "h", level: heading[1].length as 1, c: parseInline(heading[2]) }); i += 1; continue; }
    if (HR.test(line)) { blocks.push({ t: "hr" }); i += 1; continue; }
    if (QUOTE.test(line) && depth < MAX_DEPTH) {
      const inner: string[] = [];
      while (i < lines.length && (QUOTE.test(lines[i]) || (lines[i].trim() && !isBlockStart(lines[i]) && inner.length))) {
        const q = QUOTE.exec(lines[i]);
        inner.push(q ? q[1] : lines[i]);
        i += 1;
      }
      blocks.push({ t: "quote", c: parseMarkdown(inner.join("\n"), depth + 1) });
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if ((bullet || ordered) && depth < MAX_DEPTH) {
      const isOrdered = Boolean(ordered && !bullet);
      const indent = (bullet ?? ordered)![1].length;
      const items: string[][] = [];
      while (i < lines.length) {
        const l = lines[i];
        const b = BULLET.exec(l);
        const o = ORDERED.exec(l);
        const m = isOrdered ? o : b;
        if (m && m[1].length <= indent + 1) { items.push([isOrdered ? o![3] : b![3]]); i += 1; continue; }
        // A deeper item or a continuation line belongs to the last item.
        if (items.length && l.trim() && (/^\s{2,}/.test(l) || (!isBlockStart(l) && !(b || o)))) { items[items.length - 1].push(l.replace(/^\s{1,8}/, "")); i += 1; continue; }
        if (items.length && !l.trim() && i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1])) { items[items.length - 1].push(""); i += 1; continue; }
        break;
      }
      blocks.push({ t: "list", ordered: isOrdered, start: isOrdered ? Number(ordered![2]) : 1, items: items.map((it) => parseMarkdown(it.join("\n"), depth + 1)) });
      continue;
    }
    // A table: a row, then a delimiter row with pipes (a bare "---" under a line is a rule, not a table).
    if (line.includes("|") && i + 1 < lines.length && lines[i + 1].includes("|") && TABLE_SEP.test(lines[i + 1])) {
      const head = cells(line).map((c) => parseInline(c));
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) { rows.push(cells(lines[i]).map((c) => parseInline(c))); i += 1; }
      blocks.push({ t: "table", head, rows });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !(para.length && isBlockStart(lines[i]))) {
      if (!para.length && isBlockStart(lines[i])) break;
      para.push(lines[i].replace(/^\s{1,3}/, ""));
      i += 1;
    }
    if (!para.length) { para.push(lines[i]); i += 1; }
    blocks.push({ t: "p", c: parseInline(para.join("\n")) });
  }
  return blocks;
}

/** The plain text of an answer (for copying without the marks). */
export function plainText(blocks: Block[]): string {
  const inl = (c: Inline[]): string => c.map((n) => (n.t === "text" || n.t === "code" ? n.v : n.t === "br" ? "\n" : inl(n.c))).join("");
  return blocks.map((b) => {
    switch (b.t) {
      case "p": case "h": return inl(b.c);
      case "code": return b.v;
      case "quote": return plainText(b.c).split("\n").map((l) => `> ${l}`).join("\n");
      case "list": return b.items.map((it, k) => `${b.ordered ? `${b.start + k}.` : "-"} ${plainText(it)}`).join("\n");
      case "hr": return "—";
      case "table": return [b.head, ...b.rows].map((r) => r.map(inl).join("\t")).join("\n");
    }
  }).join("\n\n");
}
