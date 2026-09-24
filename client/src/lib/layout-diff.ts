// What changed between two versions of the layout configuration (4.13) —
// the Layout builder's history shows it before an operator rolls back.
// PURE module.
//
// Per layout, variant and template: elements added, removed, moved and
// changed, with each field before → after (attributes, CSS, parameters and
// events key by key). Plus the texts, behaviour and quick colours.

import { DEFAULT_LAYOUTS, LAYOUT_IDS, LAYOUT_LABELS } from "./layouts";
import { stableJson } from "./layout-merge";
import type { LNode } from "./layout-tree";
import type { LayoutConfig } from "./layout-config";

export type FieldChange = { field: string; before?: unknown; after?: unknown };

export type NodeChange = {
  id: string;
  /** How the builder's tree names it: its name, or its tag / kind. */
  label: string;
  kind: "added" | "removed" | "changed" | "moved";
  fields: FieldChange[];
  /** Elements inside an added or removed one (not listed on their own). */
  inside?: number;
};

export type ConfigChange = {
  /** "layout:chat", "variant:chat/admins", "block:card", "settings". */
  target: string;
  label: string;
  kind: "added" | "removed" | "changed";
  nodes?: NodeChange[];
  fields?: FieldChange[];
};

const MAP_FIELDS = new Set(["attrs", "css", "props", "on", "style"]);
const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);

type Flat = Map<string, { node: LNode; parent: string | null; index: number }>;
function flatten(tree: LNode | null): Flat {
  const out: Flat = new Map();
  const visit = (n: LNode, parent: string | null, index: number) => {
    out.set(n.id, { node: n, parent, index });
    (n.children ?? []).forEach((c, i) => visit(c, n.id, i));
  };
  if (tree) visit(tree, null, 0);
  return out;
}

export function nodeLabel(n: LNode): string {
  if (n.name) return n.name;
  if (n.el === "text") return `“${(n.text ?? "").slice(0, 30)}”`;
  if (n.el === "icon") return `icon ${n.props?.icon ?? ""}`;
  if (n.el === "slot") return `part: ${n.slot}`;
  if (n.el === "block") return `template: ${n.block}`;
  return n.tag ? `<${n.tag}>` : n.el;
}

function fieldChanges(a: LNode, b: LNode): FieldChange[] {
  const out: FieldChange[] = [];
  const skip = new Set(["id", "children"]);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !skip.has(k)).sort();
  for (const k of keys) {
    const av = (a as Record<string, unknown>)[k];
    const bv = (b as Record<string, unknown>)[k];
    if (same(av, bv)) continue;
    if (MAP_FIELDS.has(k) && (av === undefined || typeof av === "object") && (bv === undefined || typeof bv === "object")) {
      const am = (av ?? {}) as Record<string, unknown>;
      const bm = (bv ?? {}) as Record<string, unknown>;
      for (const sk of [...new Set([...Object.keys(am), ...Object.keys(bm)])].sort()) {
        if (!same(am[sk], bm[sk])) out.push({ field: `${k}.${sk}`, before: am[sk], after: bm[sk] });
      }
      continue;
    }
    out.push({ field: k, before: av, after: bv });
  }
  return out;
}

const count = (n: LNode): number => 1 + (n.children ?? []).reduce((s, c) => s + count(c), 0);

/** The longest common subsequence of two lists of ids: what kept its order. */
function lcs(a: string[], b: string[]): Set<string> {
  const m = a.length;
  const n = b.length;
  const len: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) len[i][j] = a[i] === b[j] ? len[i + 1][j + 1] + 1 : Math.max(len[i + 1][j], len[i][j + 1]);
  const out = new Set<string>();
  for (let i = 0, j = 0; i < m && j < n;) {
    if (a[i] === b[j]) { out.add(a[i]); i++; j++; } else if (len[i + 1][j] >= len[i][j + 1]) i++; else j++;
  }
  return out;
}

/** Elements added, removed, moved and changed from tree `a` to tree `b`. */
export function diffTrees(a: LNode | null, b: LNode | null): NodeChange[] {
  const A = flatten(a);
  const B = flatten(b);
  const out: NodeChange[] = [];
  // Per parent: the siblings both versions have that kept their order (the others moved).
  const orderCache = new Map<string, Set<string>>();
  const inPlace = (parent: string) => {
    let hit = orderCache.get(parent);
    if (!hit) {
      const common = (list: LNode[] | undefined, other: Flat) => (list ?? []).filter((c) => other.get(c.id)?.parent === parent).map((c) => c.id);
      hit = lcs(common(A.get(parent)?.node.children, B), common(B.get(parent)?.node.children, A));
      orderCache.set(parent, hit);
    }
    return hit;
  };
  for (const [id, x] of A) {
    if (B.has(id)) continue;
    // Only the outermost of what went: what was inside it is counted.
    if (x.parent !== null && !B.has(x.parent) && A.has(x.parent)) continue;
    out.push({ id, label: nodeLabel(x.node), kind: "removed", fields: [], inside: count(x.node) - 1 });
  }
  for (const [id, y] of B) {
    const x = A.get(id);
    if (!x) {
      if (y.parent !== null && !A.has(y.parent) && B.has(y.parent)) continue;
      out.push({ id, label: nodeLabel(y.node), kind: "added", fields: [], inside: count(y.node) - 1 });
      continue;
    }
    const fields = fieldChanges(x.node, y.node);
    let moved = x.parent !== y.parent;
    if (!moved && y.parent !== null) moved = !inPlace(y.parent).has(id);
    if (moved) fields.unshift({ field: "position", before: x.parent === y.parent ? `#${x.index + 1}` : `in ${x.parent}`, after: x.parent === y.parent ? `#${y.index + 1}` : `in ${y.parent}` });
    if (fields.length) out.push({ id, label: nodeLabel(y.node), kind: moved && fields.length === 1 ? "moved" : "changed", fields });
  }
  return out;
}

function mapChanges(prefix: string, a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): FieldChange[] {
  const out: FieldChange[] = [];
  const am = a ?? {};
  const bm = b ?? {};
  for (const k of [...new Set([...Object.keys(am), ...Object.keys(bm)])].sort()) {
    if (!same(am[k], bm[k])) out.push({ field: `${prefix}.${k}`, before: am[k], after: bm[k] });
  }
  return out;
}

/** Everything that differs between two configurations (`a` → `b`). */
export function diffLayoutConfigs(a: LayoutConfig, b: LayoutConfig): ConfigChange[] {
  const out: ConfigChange[] = [];
  for (const id of LAYOUT_IDS) {
    const ta = a.layouts?.[id]?.tree ?? DEFAULT_LAYOUTS[id];
    const tb = b.layouts?.[id]?.tree ?? DEFAULT_LAYOUTS[id];
    if (!same(ta, tb)) out.push({ target: `layout:${id}`, label: LAYOUT_LABELS[id], kind: "changed", nodes: diffTrees(ta, tb) });
    const va = a.variants?.[id] ?? [];
    const vb = b.variants?.[id] ?? [];
    for (const v of va) {
      const w = vb.find((x) => x.id === v.id);
      const label = `${LAYOUT_LABELS[id]} · ${v.label}`;
      if (!w) { out.push({ target: `variant:${id}/${v.id}`, label, kind: "removed" }); continue; }
      const fields = [
        ...(v.label !== w.label ? [{ field: "label", before: v.label, after: w.label }] : []),
        ...(!same(v.groups, w.groups) ? [{ field: "groups", before: v.groups, after: w.groups }] : []),
        ...(!same(v.themes, w.themes) ? [{ field: "themes", before: v.themes, after: w.themes }] : []),
        ...(va.indexOf(v) !== vb.indexOf(w) ? [{ field: "order", before: va.indexOf(v) + 1, after: vb.indexOf(w) + 1 }] : []),
      ];
      const nodes = same(v.tree, w.tree) ? [] : diffTrees(v.tree, w.tree);
      if (fields.length || nodes.length) out.push({ target: `variant:${id}/${v.id}`, label: `${LAYOUT_LABELS[id]} · ${w.label}`, kind: "changed", fields, nodes });
    }
    for (const w of vb) {
      if (!va.some((v) => v.id === w.id)) out.push({ target: `variant:${id}/${w.id}`, label: `${LAYOUT_LABELS[id]} · ${w.label}`, kind: "added", nodes: diffTrees(null, w.tree) });
    }
  }
  const ba = a.blocks ?? {};
  const bb = b.blocks ?? {};
  for (const name of [...new Set([...Object.keys(ba), ...Object.keys(bb)])].sort()) {
    const x = ba[name];
    const y = bb[name];
    if (same(x, y)) continue;
    const label = `Template “${(y ?? x)!.label || name}”`;
    if (!x) out.push({ target: `block:${name}`, label, kind: "added", nodes: diffTrees(null, y!.tree) });
    else if (!y) out.push({ target: `block:${name}`, label, kind: "removed" });
    else out.push({ target: `block:${name}`, label, kind: "changed", fields: x.label !== y.label ? [{ field: "label", before: x.label, after: y.label }] : [], nodes: diffTrees(x.tree, y.tree) });
  }
  const settings = [
    ...mapChanges("templates", a.templates, b.templates),
    ...mapChanges("partials", a.partials, b.partials),
    ...mapChanges("flags", a.flags, b.flags),
    ...mapChanges("styles", a.styles as Record<string, unknown>, b.styles as Record<string, unknown>),
  ];
  if (settings.length) out.push({ target: "settings", label: "Texts & behaviour", kind: "changed", fields: settings });
  return out;
}
