// @vitest-environment node
//
// Font catalogue (≥ 40 Google fonts, verified weights, Czech coverage flags)
// and the colour helpers behind the extended palette.

import { describe, it, expect } from "vitest";
import { FONTS, GOOGLE_FONTS, findFont, fontStack, googleCssUrl, isFontId } from "../client/src/lib/fonts";
import { PALETTE, contrastRatio, hexToHsl, hexToHslVar, hslToHex, isHexColor, readableOn } from "../client/src/lib/color";

describe("font catalogue", () => {
  it("offers well over 40 Google fonts in every category, ids unique", () => {
    expect(GOOGLE_FONTS.length).toBeGreaterThanOrEqual(70);
    const ids = FONTS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const cat of ["sans", "serif", "display", "hand", "mono"]) {
      expect(GOOGLE_FONTS.filter((f) => f.category === cat).length).toBeGreaterThanOrEqual(7);
    }
  });
  it("keeps the ids older preferences stored", () => {
    for (const id of ["system", "mono", "rounded", "serif"]) expect(isFontId(id)).toBe(true);
    expect(isFontId("comic-sans")).toBe(false);
  });
  it("builds css2 URLs with the family's own weights", () => {
    expect(googleCssUrl(findFont("g-inter")!)).toBe("https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap");
    expect(googleCssUrl(findFont("g-plus-jakarta-sans")!)).toContain("family=Plus+Jakarta+Sans:wght@");
    expect(googleCssUrl(findFont("g-bebas-neue")!)).toContain(":wght@400&");
    expect(googleCssUrl(findFont("system")!)).toBe("");
  });
  it("stacks always end in a generic family; theme font has no stack", () => {
    for (const f of FONTS.filter((x) => x.id !== "theme")) expect(f.stack).toMatch(/(sans-serif|serif|monospace|cursive)$/);
    expect(fontStack("theme")).toBe("");
  });
  it("flags the one family without Czech diacritics", () => {
    expect(GOOGLE_FONTS.filter((f) => !f.czech).map((f) => f.label)).toEqual(["Orbitron"]);
  });
});

describe("colour helpers", () => {
  it("round-trips hex ↔ HSL", () => {
    for (const hex of ["#ff0000", "#1c5fd6", "#0b0d10", "#ffffff", "#7f7f7f"]) {
      const [h, s, l] = hexToHsl(hex)!;
      const back = hslToHex(h, s, l);
      const d = (a: string, b: string) => Math.abs(parseInt(a.slice(1, 3), 16) - parseInt(b.slice(1, 3), 16));
      expect(d(back, hex)).toBeLessThanOrEqual(3);
    }
    expect(hexToHslVar("#ff0000")).toBe("0 100% 50%");
  });
  it("picks readable text and measures contrast", () => {
    expect(readableOn("#ffffff")).toBe("#0b0d10");
    expect(readableOn("#1c5fd6")).toBe("#ffffff");
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
  });
  it("palette: 18 hues × 6 shades + 8 neutrals, all valid hex", () => {
    expect(PALETTE.length).toBe(19);
    expect(PALETTE.flat().length).toBe(116);
    expect(PALETTE.flat().every(isHexColor)).toBe(true);
  });
});
