// 6.2: the map preview in a message — Web Mercator tile math, the mosaic
// centred on the position, and what a bubble's layout gets (lib/map-preview.ts).

import { describe, it, expect } from "vitest";
import { MAX_LAT, TILE_SIZE, formatCoords, mapMosaic, mapView, textOn, tileOf, tilePath, worldPixel } from "../client/src/lib/map-preview";
import { DEFAULT_MAP_PREVIEW } from "../client/src/lib/client-config";

const PRAGUE = { lat: 50.0875, lon: 14.4213 };

describe("Web Mercator", () => {
  it("puts (0, 0) in the middle of the world and the corners at its edges", () => {
    expect(worldPixel(0, 0, 0)).toEqual({ x: 128, y: 128 });
    expect(worldPixel(0, 0, 3)).toEqual({ x: 1024, y: 1024 });
    expect(worldPixel(MAX_LAT, -180, 1).x).toBe(0);
    expect(worldPixel(MAX_LAT, -180, 1).y).toBeCloseTo(0, 3);
    expect(worldPixel(-MAX_LAT, 180, 1).y).toBeCloseTo(512, 3);
    // Beyond the square world the latitude is held at its edge.
    expect(worldPixel(89.9, 0, 2).y).toBeCloseTo(worldPixel(MAX_LAT, 0, 2).y, 6);
  });

  it("finds the tile of a place (Prague's Old Town Square at zoom 16)", () => {
    expect(tileOf(PRAGUE.lat, PRAGUE.lon, 16)).toEqual({ x: 35393, y: 22201 });
    expect(tileOf(0, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(tileOf(-33.8568, 151.2153, 10)).toEqual({ x: 942, y: 614 }); // Sydney
    expect(tileOf(0, 180, 2).x).toBe(0); // the date line wraps
  });

  it("addresses this server's tile proxy", () => {
    expect(tilePath(16, 35393, 22201)).toBe("/api/map/tile/16/35393/22201");
  });
});

describe("the mosaic", () => {
  it("covers the box with the position exactly in its middle", () => {
    const m = mapMosaic(PRAGUE.lat, PRAGUE.lon, 16, 280, 160);
    expect(m.pin).toEqual({ left: 140, top: 80 });
    expect(m.tiles.map((t) => [t.x, t.y, t.left, t.top])).toEqual([[35392, 22201, -197, -19], [35393, 22201, 59, -19]]);
    expect(m.tiles[1].src).toBe("/api/map/tile/16/35393/22201");
    // The point's pixel in its tile, placed in the box, is the box's centre.
    const p = worldPixel(PRAGUE.lat, PRAGUE.lon, 16);
    const inTile = { x: p.x - 35393 * TILE_SIZE, y: p.y - 22201 * TILE_SIZE };
    expect(59 + inTile.x).toBeCloseTo(140, 0);
    expect(-19 + inTile.y).toBeCloseTo(80, 0);
  });

  it("leaves no gap: every pixel of the box is on a tile", () => {
    for (const [w, h, z] of [[160, 100, 3], [280, 160, 16], [640, 480, 19], [333, 211, 11]] as const) {
      const m = mapMosaic(48.2082, 16.3738, z, w, h);
      for (const [x, y] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1], [w / 2, h / 2]]) {
        expect(m.tiles.some((t) => x >= t.left && x < t.left + TILE_SIZE && y >= t.top && y < t.top + TILE_SIZE)).toBe(true);
      }
      const cols = Math.ceil(w / TILE_SIZE) + 1;
      const rows = Math.ceil(h / TILE_SIZE) + 1;
      expect(m.tiles.length).toBeLessThanOrEqual(cols * rows);
    }
  });

  it("wraps across the date line and stops at the poles", () => {
    const east = mapMosaic(0, 179.999, 3, 280, 160);
    expect(east.tiles.map((t) => t.x).sort()).toEqual([0, 0, 7, 7]);
    const north = mapMosaic(85, 0, 2, 280, 160);
    expect(north.tiles.every((t) => t.y >= 0)).toBe(true);
    expect(north.tiles.map((t) => [t.x, t.y])).toEqual([[1, 0], [2, 0]]);
  });

  it("keeps the zoom in range", () => {
    expect(mapMosaic(0, 0, 25, 160, 100).zoom).toBe(19);
    expect(mapMosaic(0, 0, -2, 160, 100).zoom).toBe(0);
  });
});

describe("what the bubble draws", () => {
  const opts = { caption: "Aktuální poloha: Jana", url: "https://www.openstreetmap.org/?mlat=50.0875&mlon=14.4213#map=17/50.0875/14.4213" };

  it("is nothing when the operator turned it off, or the position is not one", () => {
    expect(mapView(PRAGUE, { ...DEFAULT_MAP_PREVIEW, enabled: false }, opts)).toBeNull();
    expect(mapView({ lat: 91, lon: 0 }, DEFAULT_MAP_PREVIEW, opts)).toBeNull();
    expect(mapView({ lat: Number.NaN, lon: 0 }, DEFAULT_MAP_PREVIEW, opts)).toBeNull();
  });

  it("carries the operator's look", () => {
    const v = mapView({ ...PRAGUE, acc: 12 }, { ...DEFAULT_MAP_PREVIEW, pinColor: "#112233", accent: "#ffee00", grayscale: true }, opts)!;
    expect(v.style).toEqual({ width: "280px", height: "160px" });
    expect(v.pinStyle).toEqual({ left: "140px", top: "80px", color: "#112233" });
    expect(v.tiles[0].style).toMatchObject({ left: "-197px", top: "-19px", width: "256px", height: "256px" });
    expect(v.caption).toBe("Aktuální poloha: Jana");
    expect(v.captionStyle).toEqual({ background: "#ffee00", color: "#000000" });
    expect(v.coords).toBe("50.08750, 14.42130 ± 12 m");
    expect(v.gray).toBe(true);
    expect(v.attribution).toBe("© OpenStreetMap");
    expect(v.url).toBe(opts.url);
  });

  it("leaves out the caption and the coordinates when asked, and uses the theme's colour by default", () => {
    const v = mapView(PRAGUE, { ...DEFAULT_MAP_PREVIEW, label: false, showCoords: false }, opts)!;
    expect(v.caption).toBe("");
    expect(v.coords).toBe("");
    expect(mapView(PRAGUE, DEFAULT_MAP_PREVIEW, opts)!.captionStyle).toBeNull();
  });

  it("words coordinates and picks readable caption text", () => {
    expect(formatCoords(50.0875, 14.4213)).toBe("50.08750, 14.42130");
    expect(formatCoords(50.0875, 14.4213, 1500)).toBe("50.08750, 14.42130 ± 1.5 km");
    expect(formatCoords(-1, -2, 0)).toBe("-1.00000, -2.00000");
    expect(textOn("#ffffff")).toBe("#000000");
    expect(textOn("#1d4ed8")).toBe("#ffffff");
    expect(textOn("nope")).toBe("#ffffff");
  });
});
