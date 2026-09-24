// Every layout the Layout builder offers: its id, its default tree (the app
// as it always was) and the default's revision — so the builder can tell an
// operator that the app's own layout changed since they customised theirs.

import { sanitizeTree, treeRev, type LNode } from "../layout-tree";
import { messageTree } from "./message";
import { widgetFabTree, widgetTree } from "./widget";
import { chatTree, composerTree, headerTree } from "./app";

export const LAYOUT_IDS = ["header", "chat", "message.in", "message.out", "message.sys", "composer", "widget", "widget.fab"] as const;
export type LayoutId = (typeof LAYOUT_IDS)[number];

export const LAYOUT_LABELS: Readonly<Record<LayoutId, string>> = {
  header: "App bar",
  chat: "Chat window",
  "message.in": "Incoming message",
  "message.out": "Outgoing message",
  "message.sys": "System message",
  composer: "Composer (send panel)",
  widget: "Recipients widget",
  "widget.fab": "Recipients button (minimised)",
};

/** The old Layout builder's component styles each layout carries on (CSS variables --c-<id>-…). */
export const LAYOUT_STYLE_COMPONENT: Readonly<Record<LayoutId, string>> = {
  header: "",
  chat: "chat",
  "message.in": "in",
  "message.out": "out",
  "message.sys": "sys",
  composer: "composer",
  widget: "widget",
  "widget.fab": "widget",
};

function build(): Record<LayoutId, LNode> {
  const trees: Record<LayoutId, LNode> = {
    header: headerTree(),
    chat: chatTree(),
    "message.in": messageTree("in"),
    "message.out": messageTree("out"),
    "message.sys": messageTree("sys"),
    composer: composerTree(),
    widget: widgetTree(),
    "widget.fab": widgetFabTree(),
  };
  // In the sanitizer's own form (key order, no empty maps): what the server
  // stores looks exactly like this, so "unchanged" compares equal.
  for (const id of LAYOUT_IDS) {
    const clean = sanitizeTree(trees[id]);
    if (!clean) throw new Error(`the default layout ${id} does not pass its own checks`);
    trees[id] = clean;
  }
  return trees;
}

/** The app's own layouts (built once). */
export const DEFAULT_LAYOUTS: Readonly<Record<LayoutId, LNode>> = build();

/** Each default's revision (a fingerprint of its tree). */
export const DEFAULT_LAYOUT_REVS: Readonly<Record<LayoutId, string>> = Object.fromEntries(
  LAYOUT_IDS.map((id) => [id, treeRev(DEFAULT_LAYOUTS[id])]),
) as Record<LayoutId, string>;

export function isLayoutId(v: unknown): v is LayoutId {
  return typeof v === "string" && (LAYOUT_IDS as readonly string[]).includes(v);
}
