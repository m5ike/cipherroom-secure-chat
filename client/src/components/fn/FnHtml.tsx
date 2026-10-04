// A function's formatted HTML (6.6: m5.out.html) — the safe tree fn-html.ts
// keeps, built as React elements (never innerHTML). The server sanitized it
// already; a message from a peer is parsed again here, so what renders is only
// ever document markup: text, tables, lists, details, data: pictures and links
// that open outside the app.

import { createElement, Fragment, useMemo, type CSSProperties, type ReactNode } from "react";
import { parseFnHtml, type HtmlNode } from "../../lib/fn-html";
import type { FnOutput } from "../../lib/fn-outputs";

const VOID = new Set(["br", "hr", "img", "col", "wbr"]);

function styleObject(style: string): CSSProperties {
  const out: Record<string, string> = {};
  for (const decl of style.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim();
    if (prop) out[prop.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())] = decl.slice(i + 1).trim();
  }
  return out as CSSProperties;
}

const ATTR_NAME: Record<string, string> = { class: "className", colspan: "colSpan", rowspan: "rowSpan", datetime: "dateTime" };

function build(nodes: HtmlNode[], key: string): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`;
    if (typeof n === "string") return <Fragment key={k}>{n}</Fragment>;
    const props: Record<string, unknown> = { key: k };
    for (const [name, value] of Object.entries(n.a)) {
      if (name === "style") props.style = styleObject(value);
      else if (name === "open" || name === "reversed") props[name] = true;
      else props[ATTR_NAME[name] ?? name] = value;
    }
    if (n.t === "a") { props.target = "_blank"; props.rel = "noopener noreferrer nofollow"; }
    if (n.t === "img") { props.loading = "lazy"; props.decoding = "async"; props.referrerPolicy = "no-referrer"; }
    return VOID.has(n.t) ? createElement(n.t, props) : createElement(n.t, props, ...build(n.c, `${k}.`));
  });
}

export function FnHtml({ o }: { o: Extract<FnOutput, { type: "html" }> }) {
  const tree = useMemo(() => parseFnHtml(o.html), [o.html]);
  return (
    <div className="fn-html">
      {o.title ? <div className="fn-html__title">{o.title}</div> : null}
      <div className="fn-html__body">{build(tree, "h")}</div>
    </div>
  );
}
