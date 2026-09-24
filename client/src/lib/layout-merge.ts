// A 3-way merge of layout trees (4.13). PURE module.
//
// An operator designs a layout starting from the app's own ("base"). An
// update changes the app's own ("theirs"). Instead of choosing between the
// operator's layout ("ours") and the new default, both sets of changes are
// combined, element by element — every element has an id that stays the same
// in all three trees:
//
//   · a field (text, tag, an attribute, a CSS property, a condition…) changed
//     on one side only takes that side's value;
//   · elements added on either side are kept, next to the same neighbours;
//   · elements removed on one side and untouched on the other are removed;
//   · moves and reordering on one side are kept.
//
// When both sides changed the same thing differently, the operator's choice
// wins and the conflict is reported (the builder lists it, with the app's
// value one click away).

import { sanitizeTree, type LNode } from "./layout-tree";

export type MergeConflict = {
  /** The element. */
  id: string;
  /** "text", "attrs.class", "css.gap"… — or "deleted" / "parent" / "root". */
  field: string;
  kind: "field" | "removed-by-you" | "removed-by-app" | "parent" | "root";
  ours?: unknown;
  theirs?: unknown;
};

export type MergeResult = {
  tree: LNode;
  conflicts: MergeConflict[];
  /** Whether the result differs from the operator's tree. */
  changed: boolean;
};

type Fields = Record<string, unknown>;
type Flat = Map<string, { fields: Fields; parent: string | null; children: string[]; container: boolean }>;

/** Maps merged key by key (two sides may change different attributes of one element). */
const MAP_FIELDS = new Set(["attrs", "css", "props", "on", "style"]);

/** JSON with sorted keys: equal values compare equal whatever their key order. */
export function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x)) ?? "undefined";
}
const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);

/** Every element by id, its fields, parent and children — the outermost one under the id `root`. */
function flatten(tree: LNode, root: string): Flat {
  const out: Flat = new Map();
  const idOf = (n: LNode) => (n === tree ? root : n.id);
  const visit = (n: LNode, parent: string | null) => {
    const { children, id: _id, ...fields } = n;
    void _id;
    out.set(idOf(n), { fields, parent, children: (children ?? []).map(idOf), container: children !== undefined });
    for (const c of children ?? []) visit(c, idOf(n));
  };
  visit(tree, null);
  return out;
}

/** One value, 3-way: the side that changed it wins; both changed differently → ours, reported. */
function pick(b: unknown, o: unknown, t: unknown, onConflict: () => void): unknown {
  if (same(o, t)) return o;
  if (same(o, b)) return t;
  if (same(t, b)) return o;
  onConflict();
  return o;
}

function mergeFields(id: string, b: Fields | undefined, o: Fields, t: Fields, conflicts: MergeConflict[]): Fields {
  const out: Fields = {};
  const keys = new Set([...Object.keys(o), ...Object.keys(t), ...Object.keys(b ?? {})]);
  for (const k of keys) {
    const bv = b?.[k];
    const ov = o[k];
    const tv = t[k];
    if (MAP_FIELDS.has(k) && [bv, ov, tv].every((v) => v === undefined || (v && typeof v === "object" && !Array.isArray(v)))) {
      const bm = (bv ?? {}) as Record<string, unknown>;
      const om = (ov ?? {}) as Record<string, unknown>;
      const tm = (tv ?? {}) as Record<string, unknown>;
      const m: Record<string, unknown> = {};
      for (const sk of new Set([...Object.keys(om), ...Object.keys(tm), ...Object.keys(bm)])) {
        const v = pick(bm[sk], om[sk], tm[sk], () => conflicts.push({ id, field: `${k}.${sk}`, kind: "field", ours: om[sk], theirs: tm[sk] }));
        if (v !== undefined) m[sk] = v;
      }
      if (Object.keys(m).length) out[k] = m;
      continue;
    }
    const v = pick(bv, ov, tv, () => conflicts.push({ id, field: k, kind: "field", ours: ov, theirs: tv }));
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Children of one parent in the merged order: the side that did not reorder
 * the elements all three share follows the other; elements only one side has
 * go next to the same neighbours as there.
 */
function orderChildren(members: Set<string>, b: string[], o: string[], t: string[]): string[] {
  const inAll = (id: string) => b.includes(id) && o.includes(id) && t.includes(id);
  const oCommon = o.filter(inAll);
  const bCommon = b.filter(inAll);
  const oursReordered = oCommon.join("\n") !== bCommon.join("\n");
  const primary = oursReordered ? o : t;
  const secondary = oursReordered ? t : o;
  const out = primary.filter((id) => members.has(id));
  const placed = new Set(out);
  const place = (list: string[]) => {
    list.forEach((id, i) => {
      if (placed.has(id) || !members.has(id)) return;
      let at = -1;
      for (let j = i - 1; j >= 0 && at < 0; j--) if (placed.has(list[j])) at = out.indexOf(list[j]) + 1;
      if (at < 0) for (let j = i + 1; j < list.length && at < 0; j++) if (placed.has(list[j])) at = out.indexOf(list[j]);
      if (at < 0) at = out.length;
      out.splice(at, 0, id);
      placed.add(id);
    });
  };
  place(secondary);
  // Moved here from elsewhere (neither side had it under this parent): at the end.
  for (const id of members) if (!placed.has(id)) { out.push(id); placed.add(id); }
  return out;
}

function countIds(tree: LNode): number {
  const ids = new Set<string>();
  let n = 0;
  const visit = (x: LNode) => { n++; ids.add(x.id); for (const c of x.children ?? []) visit(c); };
  visit(tree);
  return n === ids.size ? n : -1;
}

/** Merges the operator's tree (ours) and the app's new default (theirs), both made from base. */
export function mergeTrees(base: LNode, ours: LNode, theirs: LNode): MergeResult {
  const conflicts: MergeConflict[] = [];
  const unchanged = (): MergeResult => ({ tree: ours, conflicts, changed: false });
  // The outermost element is the same element in all three (the builder never
  // removes or moves it; its id may have been renamed on one side).
  const root = ours.id !== base.id ? ours.id : theirs.id;
  const B = flatten(base, root);
  const O = flatten(ours, root);
  const T = flatten(theirs, root);
  const renamedTwice = ours.id !== base.id && theirs.id !== base.id && ours.id !== theirs.id;
  // Ids must be unique in each tree (the sanitizer makes sure) — and stay so with the outermost renamed.
  const clash = (f: Flat, tree: LNode) => countIds(tree) !== f.size;
  if (renamedTwice || clash(B, base) || clash(O, ours) || clash(T, theirs)) {
    conflicts.push({ id: root, field: "root", kind: "root", ours: ours.id, theirs: theirs.id });
    return unchanged();
  }

  // Which elements stay. "Changed" for a removal: its fields, or which children it has.
  const touched = (b: { fields: Fields; children: string[] }, x: { fields: Fields; children: string[] }) => !same(b.fields, x.fields) || b.children.join("\n") !== x.children.join("\n");
  const kept = new Set<string>();
  const removedByOurs = new Set<string>();
  for (const id of new Set([...B.keys(), ...O.keys(), ...T.keys()])) {
    const b = B.get(id);
    const o = O.get(id);
    const t = T.get(id);
    if (o && t) kept.add(id);
    else if (b && !o && t) {
      // Removed by the operator; the app changed it meanwhile → stays removed, reported.
      removedByOurs.add(id);
      if (touched(b, t)) conflicts.push({ id, field: "deleted", kind: "removed-by-you", theirs: t.fields });
    } else if (b && o && !t) {
      if (touched(b, o)) { kept.add(id); conflicts.push({ id, field: "deleted", kind: "removed-by-app", ours: o.fields }); }
    } else if (!b && (o || t)) kept.add(id);
  }
  kept.add(root);
  // What the operator kept although the app removed it stays whole, as the operator has it.
  for (const c of conflicts) {
    if (c.kind !== "removed-by-app") continue;
    const stack = [...O.get(c.id)!.children];
    while (stack.length) { const x = stack.pop()!; kept.add(x); stack.push(...(O.get(x)?.children ?? [])); }
  }
  // What the app added inside something the operator removed goes with it.
  for (const id of [...kept]) {
    if (O.has(id) || !T.has(id)) continue;
    for (let p = T.get(id)!.parent; p !== null; p = T.get(p)?.parent ?? null) {
      if (removedByOurs.has(p)) { kept.delete(id); break; }
    }
  }

  // Where each one goes.
  const parent = new Map<string, string>();
  const ancestorsIn = (flat: Flat, id: string) => {
    const out: string[] = [];
    for (let p = flat.get(id)?.parent ?? null; p !== null && out.length < 100; p = flat.get(p)?.parent ?? null) out.push(p);
    return out;
  };
  for (const id of kept) {
    if (id === root) continue;
    const pb = B.get(id)?.parent;
    const po = O.get(id)?.parent;
    const pt = T.get(id)?.parent;
    let p: string | null | undefined;
    if (po !== undefined && pt !== undefined) {
      p = pick(pb, po, pt, () => conflicts.push({ id, field: "parent", kind: "parent", ours: po, theirs: pt })) as string | null;
    } else p = po !== undefined ? po : pt;
    // Its parent went: the nearest ancestor that stayed.
    const candidates = [p, po, pt, ...(O.has(id) ? ancestorsIn(O, id) : []), ...(T.has(id) ? ancestorsIn(T, id) : [])];
    parent.set(id, (candidates.find((c) => typeof c === "string" && kept.has(c) && c !== id) as string | undefined) ?? root);
  }
  // A move on each side can make a loop (A into B, B into A): the operator's structure then wins.
  for (let round = 0; round < 3; round++) {
    let looped = false;
    for (const id of parent.keys()) {
      const seen = new Set<string>([id]);
      for (let p = parent.get(id); p !== undefined && p !== root; p = parent.get(p)) {
        if (seen.has(p)) {
          looped = true;
          for (const x of seen) {
            const po = O.get(x)?.parent;
            if (!po || !kept.has(po) || parent.get(x) === po) continue;
            conflicts.push({ id: x, field: "parent", kind: "parent", ours: po, theirs: parent.get(x) });
            parent.set(x, po);
          }
          break;
        }
        seen.add(p);
      }
    }
    if (!looped) break;
    if (round === 2) { conflicts.push({ id: root, field: "parent", kind: "parent" }); return unchanged(); }
  }

  // The merged elements.
  const kids = new Map<string, Set<string>>();
  for (const [id, p] of parent) {
    if (!kids.has(p)) kids.set(p, new Set());
    kids.get(p)!.add(id);
  }
  const build = (id: string, depth: number): LNode => {
    const b = B.get(id);
    const o = O.get(id);
    const t = T.get(id);
    const fields = o && t ? mergeFields(id, b?.fields, o.fields, t.fields, conflicts) : (o ?? t)!.fields;
    const node = { id, ...fields } as LNode;
    const members = kids.get(id) ?? new Set<string>();
    const container = Boolean(o?.container || t?.container || members.size);
    if (container && depth < 60) {
      node.children = orderChildren(members, b?.children ?? [], o?.children ?? [], t?.children ?? []).map((c) => build(c, depth + 1));
    }
    return node;
  };
  const merged = sanitizeTree(build(root, 0));
  if (!merged) {
    conflicts.push({ id: root, field: "root", kind: "root" });
    return unchanged();
  }
  return { tree: merged, conflicts, changed: !same(merged, ours) };
}
