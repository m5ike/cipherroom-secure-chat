// The unread count for the dock / taskbar (pure).
//
// The page already writes it into its title — "(3) M5cet | …" (App.tsx) — so
// the app reads it from there; the bridge's setBadge() can set it too. On
// Windows the taskbar has no numeric badge: an overlay icon is drawn here
// (BGRA bitmap, 32×32: a red disc with the count, "9+" above nine).

/** The count in a page title "(N) …", 0 when there is none. */
export function unreadFromTitle(title: string): number {
  const m = /^\((\d{1,6})\)\s/.exec(String(title ?? ""));
  return m ? Math.min(Number(m[1]), 999_999) : 0;
}

/** The title without the count (the window shows the page's title as it is, the badge carries the count). */
export function badgeText(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "";
  return count > 99 ? "99+" : String(Math.floor(count));
}

// A 3×5 pixel font for 0-9 and "+".
const GLYPHS: Record<string, string[]> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  "+": ["000", "010", "111", "010", "000"],
};

/** A size×size BGRA bitmap: red disc, white count (1–9, "9+"). */
export function overlayBitmap(count: number, size = 32): Buffer {
  const buf = Buffer.alloc(size * size * 4);
  const r = size / 2;
  const put = (x: number, y: number, b: number, g: number, rr: number, a: number) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    buf[i] = b; buf[i + 1] = g; buf[i + 2] = rr; buf[i + 3] = a;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - r, y + 0.5 - r);
      if (d <= r - 0.5) put(x, y, 0x2f, 0x1c, 0xd6, 0xff); // #d61c2f
      else if (d <= r + 0.5) put(x, y, 0x2f, 0x1c, 0xd6, Math.round(0xff * (r + 0.5 - d)));
    }
  }
  const text = count > 9 ? "9+" : String(Math.max(1, Math.floor(count)));
  const scale = Math.max(1, Math.floor(size / 10));
  const w = text.length * 3 * scale + (text.length - 1) * scale;
  const h = 5 * scale;
  const ox = Math.floor((size - w) / 2);
  const oy = Math.floor((size - h) / 2);
  [...text].forEach((ch, n) => {
    const g = GLYPHS[ch];
    for (let gy = 0; gy < 5; gy++) for (let gx = 0; gx < 3; gx++) {
      if (g[gy][gx] !== "1") continue;
      for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
        put(ox + n * 4 * scale + gx * scale + sx, oy + gy * scale + sy, 0xff, 0xff, 0xff, 0xff);
      }
    }
  });
  return buf;
}
