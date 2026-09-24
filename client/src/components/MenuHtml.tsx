// A menu HTML block (menu-config.ts › HtmlNode): the template rendered with
// the live variables, parsed into a safe element tree (menu-template.ts) and
// built as React elements — never innerHTML. {icon …} placeholders become
// the catalog's icons; a click on an element with data-action runs that
// action (a panel or one of the menu's functions).

import { createElement, Fragment, memo, useMemo, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { renderMenuHtml, type SafeNode, type TemplateVars } from "../lib/menu-template";
import { MENU_FN_IDS, MENU_PANELS } from "../lib/menu-config";
import { MenuIcon } from "./MenuIcon";

const ALLOW = { panels: MENU_PANELS, fns: MENU_FN_IDS };

function styleObject(style: string): CSSProperties {
  const out: Record<string, string> = {};
  for (const decl of style.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim();
    if (!prop) continue;
    out[prop.startsWith("--") ? prop : prop.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())] = decl.slice(i + 1).trim();
  }
  return out as CSSProperties;
}

function build(nodes: SafeNode[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${keyPrefix}${i}`;
    if (typeof node === "string") return <Fragment key={key}>{node}</Fragment>;
    if (node.t === "i" && node.a["data-icon"]) return <MenuIcon key={key} name={node.a["data-icon"]} className="mb-inline-icon" />;
    const props: Record<string, unknown> = { key };
    for (const [name, value] of Object.entries(node.a)) {
      if (name === "class") props.className = value;
      else if (name === "style") props.style = styleObject(value);
      else props[name] = value;
    }
    return createElement(node.t, props, ...(node.c.length ? build(node.c, `${key}.`) : []));
  });
}

export const MenuHtml = memo(function MenuHtml({ html, vars, translate, lang, onAction, className, style }: {
  html: string;
  vars: TemplateVars;
  translate: (key: string) => string;
  lang: string;
  /** "panel:<panel>" or "fn:<fn>[:param]" from a clicked data-action. */
  onAction: (action: string) => void;
  className?: string;
  style?: CSSProperties;
}) {
  const { nodes, error } = useMemo(() => renderMenuHtml(html, vars, ALLOW, { translate, lang }), [html, vars, translate, lang]);
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = (event.target as HTMLElement).closest?.("[data-action]");
    if (!target || !event.currentTarget.contains(target)) return;
    event.preventDefault();
    onAction(target.getAttribute("data-action") ?? "");
  };
  if (error) return <div className={`menu-html is-error ${className ?? ""}`} style={style} role="note">{error}</div>;
  // A click handler on a wrapper that only forwards data-action clicks; the
  // interactive elements inside are real buttons and links.
  // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
  return <div className={`menu-html ${className ?? ""}`} style={style} onClick={onClick}>{build(nodes, "h")}</div>;
});
