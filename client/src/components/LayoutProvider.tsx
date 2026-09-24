// Which layouts the app draws with (4.13): the operator's configuration and
// who is looking (their groups and GUI template, for variants), handed down
// to every component that draws a layout — the windows, the Room window,
// dialogs and panels. Without a provider (tests, a component on its own)
// the app's own layouts are drawn.

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { layoutBlocks, layoutTree, type LayoutConfig, type LayoutContext } from "../lib/layout-config";
import { DEFAULT_LAYOUTS, type LayoutId } from "../lib/layouts";
import type { LNode } from "../lib/layout-tree";
import { t, type Lang } from "../lib/i18n";
import type { LayoutEnv } from "./LayoutView";

type Value = { config: LayoutConfig; ctx: LayoutContext; blocks: Record<string, LNode> };
const LayoutCtx = createContext<Value | null>(null);
const NO_BLOCKS: Record<string, LNode> = {};

export function LayoutProvider({ config, ctx, children }: { config: LayoutConfig; ctx: LayoutContext; children: ReactNode }) {
  const value = useMemo(() => ({ config, ctx, blocks: layoutBlocks(config) }), [config, ctx]);
  return <LayoutCtx.Provider value={value}>{children}</LayoutCtx.Provider>;
}

/** The tree a layout is drawn with here, and the operator's templates. */
export function useLayout(id: LayoutId): { tree: LNode; blocks: Record<string, LNode> } {
  const v = useContext(LayoutCtx);
  return useMemo(() => (v ? { tree: layoutTree(v.config, id, v.ctx), blocks: v.blocks } : { tree: DEFAULT_LAYOUTS[id], blocks: NO_BLOCKS }), [v, id]);
}

/** The environment every layout of a component shares: the language, translations and templates. */
export function useLayoutBase(id: LayoutId, lang: Lang): { tree: LNode; base: Pick<LayoutEnv, "lang" | "translate" | "blocks"> } {
  const { tree, blocks } = useLayout(id);
  const base = useMemo(() => ({ lang, translate: (key: string) => t(lang, key), blocks }), [lang, blocks]);
  return { tree, base };
}
