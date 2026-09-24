// Draws Markdown (lib/markdown.ts) as React elements (4.14): an AI answer,
// later a function's output. Text is always text — React escapes it — and a
// link is a link only to https / http / mailto, opened in a new tab without
// the page's opener.

import { Fragment, useMemo, type ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "../lib/markdown";

function inline(nodes: Inline[], key: string): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}.${i}`;
    switch (n.t) {
      case "text": return <Fragment key={k}>{n.v}</Fragment>;
      case "br": return <br key={k} />;
      case "code": return <code key={k} className="md-code">{n.v}</code>;
      case "strong": return <strong key={k}>{inline(n.c, k)}</strong>;
      case "em": return <em key={k}>{inline(n.c, k)}</em>;
      case "del": return <del key={k}>{inline(n.c, k)}</del>;
      case "link": return <a key={k} href={n.href} target="_blank" rel="noopener noreferrer nofollow" className="md-link">{inline(n.c, k)}</a>;
    }
  });
}

function blocks(list: Block[], key: string, tight = false): ReactNode[] {
  return list.map((b, i) => {
    const k = `${key}.${i}`;
    switch (b.t) {
      case "p": return tight && list.length === 1 ? <Fragment key={k}>{inline(b.c, k)}</Fragment> : <p key={k} className="md-p">{inline(b.c, k)}</p>;
      case "h": {
        const Tag = (["h3", "h3", "h4", "h5", "h6", "h6"] as const)[b.level - 1];
        return <Tag key={k} className={`md-h md-h${b.level}`}>{inline(b.c, k)}</Tag>;
      }
      case "code": return <pre key={k} className="md-pre" data-lang={b.lang || undefined}><code>{b.v}</code></pre>;
      case "quote": return <blockquote key={k} className="md-quote">{blocks(b.c, k)}</blockquote>;
      case "hr": return <hr key={k} className="md-hr" />;
      case "list": {
        const items = b.items.map((it, j) => <li key={`${k}.${j}`}>{blocks(it, `${k}.${j}`, true)}</li>);
        return b.ordered ? <ol key={k} className="md-list" start={b.start !== 1 ? b.start : undefined}>{items}</ol> : <ul key={k} className="md-list">{items}</ul>;
      }
      case "table":
        return (
          <div key={k} className="md-table-wrap">
            <table className="md-table">
              <thead><tr>{b.head.map((c, j) => <th key={j}>{inline(c, `${k}.h${j}`)}</th>)}</tr></thead>
              <tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, m) => <td key={m}>{inline(c, `${k}.${j}.${m}`)}</td>)}</tr>)}</tbody>
            </table>
          </div>
        );
    }
  });
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const tree = useMemo(() => parseMarkdown(text), [text]);
  return <div className={`md${className ? ` ${className}` : ""}`}>{blocks(tree, "md")}</div>;
}
