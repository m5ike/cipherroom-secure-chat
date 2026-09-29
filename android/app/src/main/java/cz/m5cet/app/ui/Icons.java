package cz.m5cet.app.ui;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.RectF;
import android.graphics.drawable.Drawable;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The lucide icons of the builders (assets/m5/icons.json, generated from
 * the same catalogue the console offers), drawn natively: 24×24 view box,
 * 2 px round strokes, parsed once and kept as Paths.
 */
public final class Icons {
    private Icons() {}

    private static final class Shape { final Path path; final boolean fill; Shape(Path p, boolean f) { path = p; fill = f; } }
    private static Map<String, List<Shape>> icons;

    private static synchronized Map<String, List<Shape>> load(Context ctx) {
        if (icons != null) return icons;
        icons = new HashMap<>();
        try (InputStream in = ctx.getAssets().open("m5/icons.json")) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            JSONObject all = new JSONObject(new String(out.toByteArray(), StandardCharsets.UTF_8));
            for (java.util.Iterator<String> it = all.keys(); it.hasNext(); ) {
                String name = it.next();
                JSONArray children = all.getJSONArray(name);
                List<Shape> shapes = new ArrayList<>();
                for (int i = 0; i < children.length(); i++) {
                    JSONArray child = children.getJSONArray(i);
                    Shape s = shape(child.getString(0), child.getJSONObject(1));
                    if (s != null) shapes.add(s);
                }
                icons.put(name, shapes);
            }
        } catch (Exception e) {
            cz.m5cet.app.core.Log.e("icons", "icons unreadable", e);
        }
        return icons;
    }

    private static float f(JSONObject a, String k) { return (float) a.optDouble(k, 0); }

    private static Shape shape(String tag, JSONObject a) {
        Path p = new Path();
        boolean fill = "currentColor".equals(a.optString("fill"));
        switch (tag) {
            case "path": p = SvgPath.parse(a.optString("d")); break;
            case "circle": p.addCircle(f(a, "cx"), f(a, "cy"), f(a, "r"), Path.Direction.CW); break;
            case "ellipse": p.addOval(new RectF(f(a, "cx") - f(a, "rx"), f(a, "cy") - f(a, "ry"), f(a, "cx") + f(a, "rx"), f(a, "cy") + f(a, "ry")), Path.Direction.CW); break;
            case "rect": {
                float x = f(a, "x"), y = f(a, "y"), w = f(a, "width"), h = f(a, "height"), rx = a.has("rx") ? f(a, "rx") : f(a, "ry"), ry = a.has("ry") ? f(a, "ry") : rx;
                p.addRoundRect(new RectF(x, y, x + w, y + h), rx, ry, Path.Direction.CW);
                break;
            }
            case "line": p.moveTo(f(a, "x1"), f(a, "y1")); p.lineTo(f(a, "x2"), f(a, "y2")); break;
            case "polyline": case "polygon": {
                String[] pts = a.optString("points").trim().split("[\\s,]+");
                for (int i = 0; i + 1 < pts.length; i += 2) {
                    float x = Float.parseFloat(pts[i]), y = Float.parseFloat(pts[i + 1]);
                    if (i == 0) p.moveTo(x, y); else p.lineTo(x, y);
                }
                if (tag.equals("polygon")) p.close();
                break;
            }
            default: return null;
        }
        return new Shape(p, fill);
    }

    public static boolean has(Context ctx, String name) { return load(ctx).containsKey(name); }

    /** An icon drawable of this size (px) and colour; unknown names draw a circle. */
    public static Drawable drawable(Context ctx, String name, int sizePx, int color) {
        List<Shape> shapes = load(ctx).get(name);
        if (shapes == null) shapes = load(ctx).get("circle");
        return new IconDrawable(shapes == null ? new ArrayList<>() : shapes, sizePx, color);
    }

    static final class IconDrawable extends Drawable {
        private final List<Shape> shapes;
        private final int size;
        private final Paint stroke = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);

        IconDrawable(List<Shape> shapes, int size, int color) {
            this.shapes = shapes;
            this.size = size;
            stroke.setStyle(Paint.Style.STROKE);
            stroke.setStrokeWidth(2f);
            stroke.setStrokeCap(Paint.Cap.ROUND);
            stroke.setStrokeJoin(Paint.Join.ROUND);
            stroke.setColor(color);
            fill.setStyle(Paint.Style.FILL);
            fill.setColor(color);
        }

        public void setColor(int color) { stroke.setColor(color); fill.setColor(color); invalidateSelf(); }

        @Override public void draw(Canvas c) {
            android.graphics.Rect b = getBounds();
            float scale = Math.min(b.width(), b.height()) / 24f;
            c.save();
            c.translate(b.left + (b.width() - 24 * scale) / 2f, b.top + (b.height() - 24 * scale) / 2f);
            c.scale(scale, scale);
            for (Shape s : shapes) c.drawPath(s.path, s.fill ? fill : stroke);
            c.restore();
        }

        @Override public int getIntrinsicWidth() { return size; }
        @Override public int getIntrinsicHeight() { return size; }
        @Override public void setAlpha(int alpha) { stroke.setAlpha(alpha); fill.setAlpha(alpha); }
        @Override public void setColorFilter(ColorFilter cf) { stroke.setColorFilter(cf); fill.setColorFilter(cf); }
        @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
    }
}
