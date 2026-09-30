// @vitest-environment node
// 6.2 — the look of the Android app: the web's templates carry their family,
// corner radius and font (server/android/themes.ts).

import { describe, it, expect } from "vitest";
import { androidThemes, fontKind, radiusDp } from "../server/android/themes";
import { THEME_IDS } from "../client/src/lib/theme-catalog";

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
