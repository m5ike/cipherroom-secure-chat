// 6.2: the map preview's tiles, through this server.
//
//   GET /api/map/tile/:z/:x/:y      a raster tile of the operator's provider
//                                   (client config › map.tiles), cached
//
// A message with a position draws a small map. Fetching its tiles straight
// from a public provider would tell that provider where the user is looking
// (and from which address); through here the provider sees only this server,
// the web's CSP stays img-src 'self', and a popular spot is fetched once.
// Tiles are kept on disk ($DATA_DIR/map-tiles, 0600) for map.cacheHours and a
// few hundred in memory; nothing about who asked is logged.

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Express, Request, Response } from "express";
import { rateLimit } from "express-rate-limit";
import { clientConfigStore } from "./client-config";
import { buildInfo } from "./build-info";

const MEMORY_MAX = 400;
const TILE_MAX_BYTES = 512 * 1024;

function tileDir(): string {
  const data = process.env.DATA_DIR?.trim();
  return data ? resolve(data, "map-tiles") : resolve(process.cwd(), ".m5cet", "map-tiles");
}

type Tile = { bytes: Buffer; type: string; at: number };
const memory = new Map<string, Tile>();
const inflight = new Map<string, Promise<Tile | null>>();

function remember(key: string, tile: Tile): void {
  memory.delete(key);
  memory.set(key, tile);
  while (memory.size > MEMORY_MAX) memory.delete(memory.keys().next().value as string);
}

/** The upstream URL for a tile, or null when the template is unusable. */
export function tileUrl(template: string, subdomains: string, z: number, x: number, y: number): string {
  const s = subdomains ? subdomains[(x + y) % subdomains.length] : "";
  return template.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y)).replace("{s}", s).replace("{r}", "");
}

async function fetchTile(url: string): Promise<Tile | null> {
  const version = (() => { try { return buildInfo().version; } catch { return "dev"; } })();
  const base = process.env.PUBLIC_BASE_URL?.trim() || "";
  const res = await fetch(url, {
    headers: { "User-Agent": `M5cet/${version} map preview${base ? ` (+${base})` : ""}`, Accept: "image/png,image/*;q=0.8" },
    signal: AbortSignal.timeout(8000),
    redirect: "follow",
  });
  if (!res.ok) return null;
  const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!/^image\/(png|jpeg|webp)$/.test(type)) return null;
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length || bytes.length > TILE_MAX_BYTES) return null;
  return { bytes, type, at: Date.now() };
}

export function registerMapTileRoutes(app: Express): void {
  // A preview is 6–12 tiles; a busy chat a few dozen a minute per person.
  const limiter = rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false, message: { ok: false, message: "Too many map tiles; wait a moment." } });

  app.get("/api/map/tile/:z/:x/:y", limiter, async (req: Request, res: Response) => {
    const map = clientConfigStore.get().map;
    if (!map.enabled) return res.status(404).json({ ok: false, code: "map-off", message: "Map previews are switched off." });
    const z = Number(req.params.z), x = Number(req.params.x), y = Number(String(req.params.y).replace(/\.(png|jpg|jpeg|webp)$/i, ""));
    if (![z, x, y].every(Number.isInteger) || z < 0 || z > 19 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) {
      return res.status(400).json({ ok: false, message: "Not a tile." });
    }
    // The cache key covers the provider: changing it in the console never serves the old one's tiles.
    const provider = createHash("sha256").update(`${map.tiles}|${map.subdomains}`).digest("hex").slice(0, 16);
    const key = `${provider}/${z}/${x}/${y}`;
    const maxAge = map.cacheHours * 3_600_000;
    const send = (t: Tile) => {
      res.setHeader("Content-Type", t.type);
      // private: a tile says roughly where someone was; keep it out of shared caches.
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end(t.bytes);
    };

    const hot = memory.get(key);
    if (hot && Date.now() - hot.at < maxAge) { remember(key, hot); return send(hot); }

    const file = join(tileDir(), provider, String(z), String(x), `${y}.tile`);
    try {
      const st = await stat(file);
      if (Date.now() - st.mtimeMs < maxAge) {
        const raw = await readFile(file);
        const nl = raw.indexOf(10);
        if (nl > 0 && nl < 40) {
          const tile: Tile = { type: raw.subarray(0, nl).toString("utf8"), bytes: raw.subarray(nl + 1), at: st.mtimeMs };
          remember(key, tile);
          return send(tile);
        }
      }
    } catch { /* not cached yet */ }

    let pending = inflight.get(key);
    if (!pending) {
      pending = fetchTile(tileUrl(map.tiles, map.subdomains, z, x, y)).catch(() => null);
      inflight.set(key, pending);
      void pending.finally(() => inflight.delete(key));
    }
    const tile = await pending;
    if (!tile) return res.status(502).json({ ok: false, code: "tile-unavailable", message: "The map provider did not answer." });
    remember(key, tile);
    try {
      await mkdir(join(tileDir(), provider, String(z), String(x)), { recursive: true, mode: 0o700 });
      await writeFile(file, Buffer.concat([Buffer.from(`${tile.type}\n`), tile.bytes]), { mode: 0o600 });
    } catch { /* the memory copy still serves */ }
    send(tile);
  });
}
