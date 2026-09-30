package cz.m5cet.app.ui.bubble;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.ColorMatrix;
import android.graphics.ColorMatrixColorFilter;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.text.TextPaint;
import android.text.TextUtils;
import android.util.LruCache;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import cz.m5cet.app.M5;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;

/**
 * The map in a message with a position (6.2): the tiles around it from the
 * app's server (GET /api/map/tile/{z}/{x}/{y} — the server fetches them from
 * the operator's provider, so the provider never sees this phone), put
 * together centred exactly on the point, with the pin, a caption ("Jana's
 * current position") and the provider's attribution in a corner.
 *
 * Tiles and finished previews stay in memory only (LRU): a tile tells
 * roughly where someone was, so nothing of it is written to the disk.
 */
public final class MapPreview {
    private MapPreview() {}

    /** What one preview shows. */
    public static final class Spec {
        final double lat, lon;
        final long acc;
        /** "" = no caption. */
        final String caption;
        final int captionBg;

        public Spec(double lat, double lon, long acc, String caption, int captionBg) {
            this.lat = lat;
            this.lon = lon;
            this.acc = acc;
            this.caption = caption == null ? "" : caption;
            this.captionBg = captionBg;
        }

        String key(MapPolicy p, float scale) {
            return String.format(Locale.ROOT, "%.6f,%.6f,%d|%s|%08x|%.2f|%s", lat, lon, acc, caption, captionBg, scale, p.signature());
        }
    }

    public interface Done { void on(Bitmap preview); }

    private static final class Tile { final byte[] bytes; final long at; Tile(byte[] b, long at) { bytes = b; this.at = at; } }

    private static final LruCache<String, Tile> TILES = new LruCache<String, Tile>(6 * 1024 * 1024) {
        @Override protected int sizeOf(String k, Tile t) { return t.bytes.length; }
    };
    private static final LruCache<String, Bitmap> PREVIEWS = new LruCache<String, Bitmap>(12 * 1024 * 1024) {
        @Override protected int sizeOf(String k, Bitmap b) { return b.getByteCount(); }
    };
    private static final ExecutorService FETCH = Executors.newFixedThreadPool(4, daemon("m5-map-tile"));
    private static final ExecutorService DRAW = Executors.newSingleThreadExecutor(daemon("m5-map"));
    private static final Map<String, Future<byte[]>> fetching = new ConcurrentHashMap<>();
    private static final Map<String, List<Done>> drawing = new HashMap<>();

    private static java.util.concurrent.ThreadFactory daemon(String name) {
        return r -> { Thread t = new Thread(r, name); t.setDaemon(true); return t; };
    }

    /** The pixel scale of a preview: the screen's density, less for a large one (at most ~1.4 megapixels). */
    public static float scale(MapPolicy p, float density) {
        return (float) Math.max(1, Math.min(density, Math.sqrt(1_400_000.0 / (p.width * (double) p.height))));
    }

    public static Bitmap cached(MapPolicy p, Spec s, float scale) { return PREVIEWS.get(s.key(p, scale)); }

    /** Draws the preview off the UI thread; done gets it on the UI thread (null: no tile came — show the pin). */
    public static void render(M5 app, MapPolicy p, Spec s, float scale, Done done) {
        String key = s.key(p, scale);
        Bitmap hit = PREVIEWS.get(key);
        if (hit != null) { done.on(hit); return; }
        synchronized (drawing) {
            List<Done> waiting = drawing.get(key);
            if (waiting != null) { waiting.add(done); return; }
            List<Done> list = new ArrayList<>();
            list.add(done);
            drawing.put(key, list);
        }
        String server = app.config.server();
        DRAW.execute(() -> {
            Bitmap b = null;
            try { b = draw(app, server, p, s, scale); }
            catch (Throwable t) { Log.w("map", "preview: " + t.getMessage()); }
            List<Done> list;
            synchronized (drawing) { list = drawing.remove(key); }
            Bitmap out = b;
            Io.main(() -> { if (list != null) for (Done d : list) d.on(out); });
        });
    }

    private static Bitmap draw(M5 app, String server, MapPolicy p, Spec s, float scale) {
        List<TileMath.Tile> tiles = TileMath.tiles(s.lat, s.lon, p.zoom, p.width, p.height);
        List<Future<byte[]>> got = new ArrayList<>();
        for (TileMath.Tile t : tiles) got.add(fetch(app, server, p, t));
        int w = Math.round(p.width * scale), h = Math.round(p.height * scale);
        Bitmap out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(out);
        c.drawColor(0xFFF2EFE9); // land, where a tile is missing
        Paint tp = new Paint(Paint.FILTER_BITMAP_FLAG | Paint.ANTI_ALIAS_FLAG);
        if (p.grayscale) { ColorMatrix cm = new ColorMatrix(); cm.setSaturation(0); tp.setColorFilter(new ColorMatrixColorFilter(cm)); }
        int drawn = 0;
        boolean offline = false, off = false;
        for (int i = 0; i < tiles.size(); i++) {
            TileMath.Tile t = tiles.get(i);
            byte[] bytes = null;
            try { bytes = got.get(i).get(); }
            catch (java.util.concurrent.ExecutionException e) {
                Throwable why = e.getCause();
                if (why instanceof Http.Refused) off |= "map-off".equals(((Http.Refused) why).code);
                else if (why instanceof IOException) offline = true;
            } catch (InterruptedException e) { Thread.currentThread().interrupt(); return null; }
            Bitmap tile = bytes == null ? null : BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            if (tile == null) continue;
            RectF dst = new RectF((float) t.left * scale, (float) t.top * scale, (float) (t.left + TileMath.TILE) * scale, (float) (t.top + TileMath.TILE) * scale);
            c.drawBitmap(tile, null, dst, tp);
            tile.recycle();
            drawn++;
        }
        if (drawn == 0) {
            out.recycle();
            if (off) MapPolicy.switchedOff(app);
            else if (offline) MapPolicy.unreachable();
            return null;
        }
        float cx = w / 2f, cy = h / 2f;
        accuracy(c, p, s, scale, cx, cy);
        pin(c, p.pinColor, scale, cx, cy);
        if (!s.caption.isEmpty()) caption(c, s, scale, cx, cy - 34 * scale, w);
        if (!p.attribution.isEmpty()) attribution(c, p.attribution, scale, w, h);
        if (drawn == tiles.size()) PREVIEWS.put(s.key(p, scale), out); // one with holes is drawn again next time
        return out;
    }

    private static Future<byte[]> fetch(M5 app, String server, MapPolicy p, TileMath.Tile t) {
        String key = server + "|" + p.tiles + p.subdomains + "|" + t;
        Tile hot = TILES.get(key);
        long maxAge = p.cacheHours * 3_600_000L;
        if (hot != null && System.currentTimeMillis() - hot.at < maxAge) return java.util.concurrent.CompletableFuture.completedFuture(hot.bytes);
        return fetching.computeIfAbsent(key, k -> FETCH.submit(() -> {
            try {
                byte[] b = Http.get(server + "/api/map/tile/" + t.z + "/" + t.x + "/" + t.y, 600 * 1024);
                TILES.put(key, new Tile(b, System.currentTimeMillis()));
                return b;
            } finally {
                fetching.remove(key);
            }
        }));
    }

    /** The accuracy as a faint circle, when it is larger than the pin and smaller than the map. */
    private static void accuracy(Canvas c, MapPolicy p, Spec s, float scale, float cx, float cy) {
        if (s.acc <= 0) return;
        float r = (float) (s.acc / TileMath.metersPerPixel(s.lat, p.zoom)) * scale;
        if (r < 10 * scale || r > Math.max(c.getWidth(), c.getHeight())) return;
        Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
        fill.setColor((p.pinColor & 0x00FFFFFF) | 0x26000000);
        c.drawCircle(cx, cy, r, fill);
        fill.setStyle(Paint.Style.STROKE);
        fill.setStrokeWidth(1.2f * scale);
        fill.setColor((p.pinColor & 0x00FFFFFF) | 0x80000000);
        c.drawCircle(cx, cy, r, fill);
    }

    /** A drop pin whose tip is exactly on the point. */
    private static void pin(Canvas c, int color, float scale, float cx, float cy) {
        Paint shadow = new Paint(Paint.ANTI_ALIAS_FLAG);
        shadow.setColor(0x40000000);
        c.drawOval(new RectF(cx - 6 * scale, cy - 2.5f * scale, cx + 6 * scale, cy + 2.5f * scale), shadow);
        float r = 10 * scale, headY = cy - 22 * scale;
        Path drop = new Path();
        drop.moveTo(cx, cy);
        drop.lineTo(cx - r * 0.78f, headY + r * 0.62f);
        drop.lineTo(cx + r * 0.78f, headY + r * 0.62f);
        drop.close();
        drop.addCircle(cx, headY, r, Path.Direction.CW);
        Paint body = new Paint(Paint.ANTI_ALIAS_FLAG);
        body.setColor(color);
        c.drawPath(drop, body);
        body.setStyle(Paint.Style.STROKE);
        body.setStrokeWidth(1.5f * scale);
        body.setColor(0xFFFFFFFF);
        c.drawCircle(cx, headY, r, body);
        body.setStyle(Paint.Style.FILL);
        c.drawCircle(cx, headY, 3.8f * scale, body);
    }

    /** The caption over the pin: white on the accent, one line, ellipsized to the map. */
    private static void caption(Canvas c, Spec s, float scale, float cx, float bottom, int width) {
        TextPaint tp = new TextPaint(Paint.ANTI_ALIAS_FLAG);
        tp.setTextSize(12 * scale);
        tp.setTypeface(Typeface.DEFAULT_BOLD);
        tp.setColor(0xFFFFFFFF);
        float padX = 8 * scale, padY = 4 * scale;
        String text = TextUtils.ellipsize(s.caption, tp, width - 16 * scale - 2 * padX, TextUtils.TruncateAt.END).toString();
        float tw = tp.measureText(text);
        Paint.FontMetrics fm = tp.getFontMetrics();
        float th = fm.descent - fm.ascent;
        RectF box = new RectF(cx - tw / 2 - padX, bottom - th - 2 * padY, cx + tw / 2 + padX, bottom);
        if (box.top < 2 * scale) box.offset(0, 2 * scale - box.top);
        Paint bg = new Paint(Paint.ANTI_ALIAS_FLAG);
        bg.setColor(0x33000000);
        c.drawRoundRect(new RectF(box.left, box.top + 1.5f * scale, box.right, box.bottom + 1.5f * scale), 9 * scale, 9 * scale, bg);
        bg.setColor(s.captionBg);
        c.drawRoundRect(box, 9 * scale, 9 * scale, bg);
        c.drawText(text, box.left + padX, box.top + padY - fm.ascent, tp);
    }

    private static void attribution(Canvas c, String text, float scale, int w, int h) {
        TextPaint tp = new TextPaint(Paint.ANTI_ALIAS_FLAG);
        tp.setTextSize(9 * scale);
        tp.setColor(0xFF333333);
        String t = TextUtils.ellipsize(text, tp, w * 0.8f, TextUtils.TruncateAt.END).toString();
        float tw = tp.measureText(t), pad = 3 * scale;
        Paint.FontMetrics fm = tp.getFontMetrics();
        float th = fm.descent - fm.ascent;
        Paint bg = new Paint();
        bg.setColor(0xBFFFFFFF);
        c.drawRect(w - tw - 2 * pad, h - th - pad, w, h, bg);
        c.drawText(t, w - tw - pad, h - pad / 2 - fm.descent, tp);
    }
}
