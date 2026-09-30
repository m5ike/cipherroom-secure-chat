// @vitest-environment node
// 6.2 — the look of the Android app: the web's templates carry their family,
// corner radius and font (server/android/themes.ts); the look's design
// module (server/android/design-62-look.ts) is valid and complete.

import { describe, it, expect } from "vitest";
import { androidThemes, fontKind, radiusDp } from "../server/android/themes";
import { THEME_IDS } from "../client/src/lib/theme-catalog";
import { ACTIONS, DEFAULT_SCREENS, DEFAULT_STRINGS, ELEMENTS, sanitizeScreen, type ANode } from "../server/android/design";
import * as L from "../server/android/design-62-look";

const walk = (n: ANode, f: (n: ANode) => void): void => { f(n); (n.children ?? []).forEach((c) => walk(c, f)); };

describe("android look (design-62-look)", () => {
  // Before design-62.ts merges this module into the catalog, its own element and actions are not known yet.
  const wired = ELEMENTS.some((e) => e.el === "sheet") && ACTIONS.some((a) => a.action === "look.set");
  const own = (p: string) => !wired && (/unknown element "sheet"/.test(p) || /unknown action "look\.(set|reset)"/.test(p));

  it("its trees pass the sanitizer (after node script/gen-menu-icons.mjs)", () => {
    for (const [id, tree] of Object.entries(L.SCREENS_TREES_62_LOOK)) {
      const problems: string[] = [];
      sanitizeScreen(structuredClone(tree), id, problems);
      expect(problems.filter((p) => !own(p)), id).toEqual([]);
    }
  });

  it("every text the trees and the app use exists in Czech, English and German", () => {
    const keys = new Set((["cs", "en", "de"] as const).flatMap((l) => Object.keys(L.STRINGS_62_LOOK[l])));
    for (const l of ["cs", "en", "de"] as const) for (const k of keys) expect(L.STRINGS_62_LOOK[l][k], `${l} ${k}`).toBeTruthy();
    const used = new Set<string>();
    const scan = (v: unknown): void => {
      if (typeof v === "string") for (const m of v.matchAll(/_\(?'([A-Za-z0-9_.]+)'/g)) used.add(m[1]);
      else if (v && typeof v === "object") Object.values(v).forEach(scan);
    };
    scan(L.SCREENS_TREES_62_LOOK);
    for (const k of used) expect(k in L.STRINGS_62_LOOK.cs || k in DEFAULT_STRINGS.cs, k).toBe(true);
  });

  it("the Tools are a dock that closes after a tool, with short labels", () => {
    const tools = L.SCREENS_TREES_62_LOOK.tools;
    expect(tools.el).toBe("sheet");
    expect(tools.props?.present).toContain("dock");
    expect(tools.props?.dismissOnAction).toBe(true);
    const tiles: ANode[] = [];
    walk(tools, (n) => { if (n.on?.click) tiles.push(n); });
    expect(tiles.length).toBeGreaterThanOrEqual(6);
  });

  it("patches the bars without losing what other areas put there", () => {
    const screens = structuredClone(DEFAULT_SCREENS);
    const before = (screens.room.children ?? []).find((c) => c.id === "bar")!.children!.map((c) => c.id);
    L.patch62Look(screens);
    const bar = (screens.room.children ?? []).find((c) => c.id === "bar")!;
    const after = bar.children!.map((c) => c.id);
    for (const id of before) if (id !== "video") expect(after).toContain(id);
    expect(after).toContain("avatar");
    expect(bar.style?.elevation).toBe(0);
    expect((screens.room.children ?? []).map((c) => c.id)).toContain("bar-line");
    // twice is the same as once
    L.patch62Look(screens);
    expect((screens.room.children ?? []).filter((c) => c.id === "bar-line")).toHaveLength(1);
  });
});

describe("android templates", () => {
  it("reads a radius in rem or px as dp, within what a card takes", () => {
    expect(radiusDp("1.125rem")).toBe(18);
    expect(radiusDp("0.4rem")).toBe(6);
    expect(radiusDp("12px")).toBe(12);
    expect(radiusDp("3rem")).toBe(28);
    expect(radiusDp("var(--x)")).toBeUndefined();
    expect(radiusDp(undefined)).toBeUndefined();
  });

  it("tells a font stack's kind by its first family", () => {
    expect(fontKind('"SFMono-Regular", "Cascadia Code", Menlo, monospace')).toBe("mono");
    expect(fontKind('ui-serif, Georgia, "Times New Roman", serif')).toBe("serif");
    expect(fontKind("ui-sans-serif, system-ui, sans-serif")).toBe("sans");
    expect(fontKind('"Nunito", ui-rounded, system-ui, sans-serif')).toBe("sans");
    expect(fontKind(undefined)).toBeUndefined();
  });

  it("every web template comes with its family, and radius / font where its CSS sets them", () => {
    const themes = androidThemes();
    expect(themes.map((t) => t.id).sort()).toEqual([...THEME_IDS].sort());
    for (const t of themes) expect(["classic", "system", "studio"]).toContain(t.family);
    const by = Object.fromEntries(themes.map((t) => [t.id, t]));
    expect(by.terminal.font).toBe("mono");
    expect(by.paper.font).toBe("serif");
    expect(by.ios.radius).toBeGreaterThan(by.contrast.radius ?? 0);
  });
});
