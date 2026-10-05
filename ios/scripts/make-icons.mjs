#!/usr/bin/env node
// The iOS and watchOS app icons and the launch mark, generated from the Android app's
// launcher icon so both platforms show the same mark (one source of truth):
//
//   android/app/src/main/res/drawable/ic_launcher_foreground.xml   the "M" and its dot (white)
//   android/app/src/main/res/values/colors.xml                     ic_launcher_background, m5_splash
//   android/app/src/main/res/drawable/ic_mark.xml                  the mark of the splash (vector)
//
// Writes (commit the results; re-run when the Android icon changes):
//   ios/M5cet/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon{,-Dark,-Tinted}.png   1024 px
//   ios/M5cetWatch/Assets.xcassets/AppIcon.appiconset/AppIcon.png                         1024 px
//   ios/M5cet/Resources/Assets.xcassets/Mark.imageset/Mark.svg                            vector
//
// No dependencies: the strokes are rasterised here (distance to the path, so round caps
// and joins come out exactly as Android draws them) and written as PNG with node:zlib.
// Xcode 16+ takes one 1024 px icon per appearance and scales it for every size.
//
//   node ios/scripts/make-icons.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const res = join(root, "android", "app", "src", "main", "res");
const read = (p) => readFileSync(join(res, p), "utf8");

// ------------------------------------------------------------------ Android sources
const colors = Object.fromEntries([...read("values/colors.xml").matchAll(/<color name="([^"]+)">(#[0-9A-Fa-f]{6})<\/color>/g)].map((m) => [m[1], m[2]]));
const brand = colors.ic_launcher_background;
const splash = colors.m5_splash;
if (!brand || !splash) throw new Error("colors.xml: ic_launcher_background / m5_splash missing");

const attrs = (tag) => Object.fromEntries([...tag.matchAll(/android:(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const paths = (xml) => [...xml.matchAll(/<path\b[\s\S]*?\/>/g)].map((m) => attrs(m[0]));

const foreground = paths(read("drawable/ic_launcher_foreground.xml"));
const stroke = foreground.find((p) => p.strokeColor);
const dot = foreground.find((p) => p.fillColor);
if (!stroke || !dot) throw new Error("ic_launcher_foreground.xml: the stroke and the dot are expected");

/** "M38,68L38,40L54,56…" → [[38,68],[38,40],…] (absolute moves and lines only). */
function polyline(d) {
  if (!/^[ML0-9.,\s-]+$/.test(d)) throw new Error(`only M/L path data is supported here: ${d}`);
  return [...d.matchAll(/[ML]\s*(-?[\d.]+)[,\s]+(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
}
/** The circle Android writes as "Mcx,cy m-r,0 a r,r … a r,r …" → { cx, cy, r }. */
function circle(d) {
  const m = /^\s*M\s*(-?[\d.]+)[,\s]+(-?[\d.]+)\s*m\s*-([\d.]+)[,\s]+0\s*a\s*([\d.]+)[,\s]+([\d.]+)/.exec(d);
  if (!m || m[3] !== m[4] || m[4] !== m[5]) throw new Error(`not a circle: ${d}`);
  return { cx: Number(m[1]), cy: Number(m[2]), r: Number(m[3]) };
}
const points = polyline(stroke.pathData);
const halfWidth = Number(stroke.strokeWidth) / 2;
const spot = circle(dot.pathData);
const spotAlpha = dot.fillAlpha === undefined ? 1 : Number(dot.fillAlpha);

// ------------------------------------------------------------------ rasteriser
const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

function segmentDistance(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * One square icon: `size` px showing the adaptive icon's visible area (Android shows the
 * middle 72 of its 108 dp; the system masks it, as iOS and watchOS mask theirs).
 */
function render(size, { background, mark, spotColor = mark }) {
  const view = { x: 18, y: 18, w: 72 };
  const scale = size / view.w;
  const bg = hex(background), fg = hex(mark), sp = hex(spotColor);
  const rgb = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // The pixel's centre in the vector's coordinates; coverage from the distance to the edge.
      const vx = view.x + (x + 0.5) / scale, vy = view.y + (y + 0.5) / scale;
      let d = Infinity;
      for (let i = 1; i < points.length; i++) d = Math.min(d, segmentDistance(vx, vy, points[i - 1], points[i]));
      const strokeCover = Math.max(0, Math.min(1, (halfWidth - d) * scale + 0.5));
      const spotCover = Math.max(0, Math.min(1, (spot.r - Math.hypot(vx - spot.cx, vy - spot.cy)) * scale + 0.5)) * spotAlpha;
      const o = (y * size + x) * 3;
      for (let c = 0; c < 3; c++) {
        let v = bg[c];
        v = v + (sp[c] - v) * spotCover;
        v = v + (fg[c] - v) * strokeCover;
        rgb[o + c] = Math.round(v);
      }
    }
  }
  return png(size, size, rgb);
}

// ------------------------------------------------------------------ PNG (RGB, 8 bit)
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(width, height, rgb) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2; header[10] = 0; header[11] = 0; header[12] = 0; // 8 bit, RGB (no alpha: App Store icons have none)
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0; // filter: none
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------ the mark as SVG
/** An Android <vector> of plain paths → SVG (the path data syntax is the same). */
function vectorToSvg(xml) {
  const v = attrs(/<vector\b[\s\S]*?>/.exec(xml)[0]);
  const body = paths(xml).map((p) => {
    const a = [`d="${p.pathData}"`];
    a.push(`fill="${p.fillColor ?? "none"}"`);
    if (p.fillAlpha) a.push(`fill-opacity="${p.fillAlpha}"`);
    if (p.strokeColor) a.push(`stroke="${p.strokeColor}"`, `stroke-width="${p.strokeWidth ?? 1}"`);
    if (p.strokeLineCap) a.push(`stroke-linecap="${p.strokeLineCap}"`);
    if (p.strokeLineJoin) a.push(`stroke-linejoin="${p.strokeLineJoin}"`);
    return `  <path ${a.join(" ")}/>`;
  });
  const w = v.viewportWidth, h = v.viewportHeight;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">\n${body.join("\n")}\n</svg>\n`;
}

// ------------------------------------------------------------------ write
const ios = join(root, "ios");
const out = (p, data) => { writeFileSync(join(ios, p), data); console.log(`ios/${p}`); };

const light = render(1024, { background: brand, mark: "#FFFFFF" });
out("M5cet/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png", light);
// Dark: the brand mark on the splash colour. Tinted: grey levels, iOS applies the tint.
out("M5cet/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon-Dark.png", render(1024, { background: splash, mark: brand }));
out("M5cet/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon-Tinted.png", render(1024, { background: "#000000", mark: "#FFFFFF" }));
out("M5cetWatch/Assets.xcassets/AppIcon.appiconset/AppIcon.png", light);
out("M5cet/Resources/Assets.xcassets/Mark.imageset/Mark.svg", vectorToSvg(read("drawable/ic_mark.xml")));
