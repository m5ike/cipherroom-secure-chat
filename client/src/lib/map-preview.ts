// 6.2: the map drawn in a message that carries a position — a few raster
// tiles laid side by side (Web Mercator, 256 px tiles) so that the position
// is exactly in the middle of a width × height box, with the pin on it.
// The tiles come from this server (GET /api/map/tile/{z}/{x}/{y}, a proxy of
// the operator's provider), so the browser never asks a third party and the
// CSP stays img-src 'self'. The operator's look is client config › map
// (MapPreviewPolicy). PURE: numbers in, numbers and strings out.

import type { MapPreviewPolicy } from "./client-config";

export const TILE_SIZE = 256;
/** Web Mercator stops here (the square world). */
export const MAX_LAT = 85.05112878;

/** The tile of this server's proxy. */
export const tilePath = (z: number, x: number, y: number): string => `/api/map/tile/${z}/${x}/${y}`;

/** A point in the world at a zoom, in pixels from the top-left corner (x east, y south). */
export function worldPixel(lat: number, lon: number, zoom: number): { x: number; y: number } {
  const size = TILE_SIZE * 2 ** zoom;
  const la = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  const s = Math.sin((la * Math.PI) / 180);
  const x = ((lon + 180) / 360) * size;
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size;
  return { x, y };
}

/** The tile a point falls into (x wraps around the date line). */
export function tileOf(lat: number, lon: number, zoom: number): { x: number; y: number } {
  const n = 2 ** zoom;
  const p = worldPixel(lat, lon, zoom);
  return { x: (((Math.floor(p.x / TILE_SIZE)) % n) + n) % n, y: Math.max(0, Math.min(n - 1, Math.floor(p.y / TILE_SIZE))) };
}

export type MapTile = { z: number; x: number; y: number; left: number; top: number; src: string };
export type MapMosaic = { zoom: number; width: number; height: number; tiles: MapTile[]; pin: { left: number; top: number } };

/**
 * The tiles covering a width × height box centred on (lat, lon): each with
 * its place in the box (px from the box's top-left; may be negative — the
 * box clips). Above the poles there are no tiles (the box shows its
 * background); across the date line x wraps.
 */
export function mapMosaic(lat: number, lon: number, zoom: number, width: number, height: number, src: (z: number, x: number, y: number) => string = tilePath): MapMosaic {
  const z = Math.max(0, Math.min(19, Math.round(zoom)));
  const n = 2 ** z;
  const c = worldPixel(lat, lon, z);
  const x0 = c.x - width / 2;
  const y0 = c.y - height / 2;
  const tiles: MapTile[] = [];
  for (let ty = Math.floor(y0 / TILE_SIZE); ty * TILE_SIZE < y0 + height; ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = Math.floor(x0 / TILE_SIZE); tx * TILE_SIZE < x0 + width; tx++) {
      const wx = ((tx % n) + n) % n;
      tiles.push({ z, x: wx, y: ty, left: Math.round(tx * TILE_SIZE - x0), top: Math.round(ty * TILE_SIZE - y0), src: src(z, wx, ty) });
    }
  }
  return { zoom: z, width, height, tiles, pin: { left: width / 2, top: height / 2 } };
}

/** "50.08750, 14.42130 ± 12 m" (± 1.5 km from a kilometre on). */
export function formatCoords(lat: number, lon: number, acc?: number | null): string {
  const base = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  if (typeof acc !== "number" || !Number.isFinite(acc) || acc <= 0) return base;
  return `${base} ± ${acc < 1000 ? `${Math.round(acc)} m` : `${(acc / 1000).toFixed(1)} km`}`;
}

/** Text on a caption of this colour: black or white, whichever reads better (WCAG luminance). */
export function textOn(hex: string): "#000000" | "#ffffff" {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return "#ffffff";
  const lin = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const l = 0.2126 * lin(parseInt(m[1], 16)) + 0.7152 * lin(parseInt(m[2], 16)) + 0.0722 * lin(parseInt(m[3], 16));
  return (l + 0.05) / 0.05 > 1.05 / (l + 0.05) ? "#000000" : "#ffffff";
}

/** What a bubble's layout draws for a position (null: no map — the pin link instead). */
export type MapView = {
  width: number;
  height: number;
  gray: boolean;
  /** The box: its size. */
  style: Record<string, string>;
  tiles: Array<{ key: string; src: string; style: Record<string, string> }>;
  pinStyle: Record<string, string>;
  caption: string;
  captionStyle: Record<string, string> | null;
  coords: string;
  attribution: string;
  url: string;
};

export function mapView(
  loc: { lat: number; lon: number; acc?: number | null },
  policy: MapPreviewPolicy,
  opts: { caption: string; url: string },
): MapView | null {
  if (!policy.enabled || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon) || Math.abs(loc.lat) > 90 || Math.abs(loc.lon) > 180) return null;
  const mosaic = mapMosaic(loc.lat, loc.lon, policy.zoom, policy.width, policy.height);
  const px = (n: number) => `${n}px`;
  return {
    width: mosaic.width,
    height: mosaic.height,
    gray: policy.grayscale,
    style: { width: px(mosaic.width), height: px(mosaic.height) },
    tiles: mosaic.tiles.map((t) => ({ key: `${t.z}/${t.x}/${t.y}/${t.left}`, src: t.src, style: { left: px(t.left), top: px(t.top), width: px(TILE_SIZE), height: px(TILE_SIZE) } })),
    pinStyle: { left: px(mosaic.pin.left), top: px(mosaic.pin.top), color: policy.pinColor },
    caption: policy.label ? opts.caption : "",
    // "" = the theme's primary colour (the stylesheet's default for the caption).
    captionStyle: policy.accent ? { background: policy.accent, color: textOn(policy.accent) } : null,
    coords: policy.showCoords ? formatCoords(loc.lat, loc.lon, loc.acc) : "",
    attribution: policy.attribution,
    url: opts.url,
  };
}

/* ------------------------------------------------ 6.7: the place of a message */

/**
 * The web's and the app's position message: "📍 50.08804, 14.42076 (±12 m)
 * https://…" ("📍 live …" while sharing) — the pattern of the Android app's
 * Kinds.POSITION.
 */
const POSITION_RE = /^\s*📍\s*(live\s+)?(-?\d{1,2}(?:\.\d+)?),\s*(-?\d{1,3}(?:\.\d+)?)(?:\s*\(±\s*(\d+)\s*m\))?/u;

/** Where a message points: its header position (loc), else a position message's text. */
export type Place = {
  lat: number;
  lon: number;
  acc: number | null;
  /** "📍 live …": a position being shared live. */
  live: boolean;
  /** The message IS the position: the bubble draws the place chip instead of the text. */
  message: boolean;
  /** "50.08750, 14.42130 ± 12 m". */
  coords: string;
};

const inWorld = (lat: number, lon: number) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

/** The place of a message (null: none). A sealed message's text is not read (as Kinds.position). */
export function placeOf(text: string | undefined, loc: { lat: number; lon: number; acc?: number | null } | undefined, sealed = false): Place | null {
  const m = !sealed && text ? POSITION_RE.exec(text) : null;
  const message = Boolean(m && inWorld(Number(m[2]), Number(m[3])));
  if (loc && inWorld(loc.lat, loc.lon)) {
    const acc = typeof loc.acc === "number" && Number.isFinite(loc.acc) && loc.acc > 0 ? loc.acc : null;
    return { lat: loc.lat, lon: loc.lon, acc, live: Boolean(m?.[1]), message, coords: formatCoords(loc.lat, loc.lon, acc) };
  }
  if (!m || !message) return null;
  const lat = Number(m[2]), lon = Number(m[3]);
  const acc = m[4] && Number(m[4]) > 0 ? Number(m[4]) : null;
  return { lat, lon, acc, live: Boolean(m[1]), message: true, coords: formatCoords(lat, lon, acc) };
}

/**
 * The map of the place window: laid out for a box up to maxWidth wide with
 * the tiles placed from its centre, so a narrower window (a phone) crops
 * both sides alike and the pin stays in the middle.
 */
export type SheetMap = {
  height: number;
  gray: boolean;
  tiles: Array<{ key: string; src: string; style: Record<string, string> }>;
  pinColor: string;
  attribution: string;
};

export function sheetMap(lat: number, lon: number, policy: MapPreviewPolicy, maxWidth = 640): SheetMap | null {
  if (!policy.enabled || !inWorld(lat, lon)) return null;
  // The operator's aspect at the window's usual width, within reason.
  const height = Math.max(160, Math.min(320, Math.round((policy.height / Math.max(1, policy.width)) * 420)));
  const mosaic = mapMosaic(lat, lon, policy.zoom, maxWidth, height);
  const half = maxWidth / 2;
  const fromCentre = (left: number) => `calc(50% ${left - half < 0 ? "-" : "+"} ${Math.abs(left - half)}px)`;
  return {
    height,
    gray: policy.grayscale,
    tiles: mosaic.tiles.map((t) => ({ key: `${t.z}/${t.x}/${t.y}/${t.left}`, src: t.src, style: { left: fromCentre(t.left), top: `${t.top}px`, width: `${TILE_SIZE}px`, height: `${TILE_SIZE}px` } })),
    pinColor: policy.pinColor,
    attribution: policy.attribution,
  };
}
