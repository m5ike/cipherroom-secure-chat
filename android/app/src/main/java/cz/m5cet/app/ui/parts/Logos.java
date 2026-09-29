package cz.m5cet.app.ui.parts;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.view.View;
import android.view.animation.LinearInterpolator;

import org.json.JSONObject;

import cz.m5cet.app.M5;
import cz.m5cet.app.ui.Ui;

/**
 * The M5cet mark, drawn in code (crisp at any size, coloured by the theme),
 * and its animated splash variant: orbiting dots, a pulse or a reveal — the
 * design's animations.splash chooses and times it.
 */
final class Logos {
    private Logos() {}

    /** The mark: a rounded square with an "M5" shield cut. */
    static void drawMark(Canvas c, float cx, float cy, float size, int color, int onColor) {
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setColor(color);
        float h = size / 2f;
        RectF r = new RectF(cx - h, cy - h, cx + h, cy + h);
        c.drawRoundRect(r, size * 0.28f, size * 0.28f, p);
        Paint t = new Paint(Paint.ANTI_ALIAS_FLAG);
        t.setColor(onColor);
        t.setStyle(Paint.Style.STROKE);
        t.setStrokeWidth(size * 0.085f);
        t.setStrokeCap(Paint.Cap.ROUND);
        t.setStrokeJoin(Paint.Join.ROUND);
        Path m = new Path();
        float l = cx - size * 0.28f, rgt = cx + size * 0.28f, top = cy - size * 0.2f, bot = cy + size * 0.22f;
        m.moveTo(l, bot);
        m.lineTo(l, top);
        m.lineTo(cx, cy + size * 0.04f);
        m.lineTo(rgt, top);
        m.lineTo(rgt, bot);
        c.drawPath(m, t);
    }

    static final class Mark extends View {
        private final int sizeDp;
        Mark(Context c, int sizeDp) { super(c); this.sizeDp = sizeDp; }
        @Override protected void onMeasure(int w, int h) { int s = Ui.dp(getContext(), sizeDp); setMeasuredDimension(s, s); }
        @Override protected void onDraw(Canvas c) {
            float s = Math.min(getWidth(), getHeight());
            drawMark(c, getWidth() / 2f, getHeight() / 2f, s, Ui.color(getContext(), "@primary", Color.RED), Ui.color(getContext(), "@onPrimary", Color.WHITE));
        }
    }

    static final class Splash extends View {
        private final ValueAnimator anim;
        private float t = 0;
        private final String style;
        private final Paint dot = new Paint(Paint.ANTI_ALIAS_FLAG), ring = new Paint(Paint.ANTI_ALIAS_FLAG);

        Splash(Context c) {
            super(c);
            JSONObject spec = M5.get().design().anim("splash");
            style = spec.optString("style", "orbit");
            ring.setStyle(Paint.Style.STROKE);
            ring.setStrokeWidth(Ui.dp(c, 2));
            anim = ValueAnimator.ofFloat(0f, 1f);
            anim.setDuration(Math.max(300, spec.optLong("ms", 1400)));
            anim.setRepeatCount(ValueAnimator.INFINITE);
            anim.setInterpolator(new LinearInterpolator());
            anim.addUpdateListener(a -> { t = (float) a.getAnimatedValue(); invalidate(); });
        }

        @Override protected void onAttachedToWindow() { super.onAttachedToWindow(); if (!style.equals("none") && !Ui.reducedMotion(getContext())) anim.start(); }
        @Override protected void onDetachedFromWindow() { anim.cancel(); super.onDetachedFromWindow(); }
        @Override protected void onMeasure(int w, int h) { int s = Ui.dp(getContext(), 168); setMeasuredDimension(s, s); }

        @Override protected void onDraw(Canvas c) {
            int primary = Ui.color(getContext(), "@primary", Color.RED);
            int on = Ui.color(getContext(), "@onPrimary", Color.WHITE);
            float cx = getWidth() / 2f, cy = getHeight() / 2f, s = Math.min(getWidth(), getHeight());
            float mark = s * 0.42f;
            switch (style) {
                case "pulse": {
                    for (int i = 0; i < 3; i++) {
                        float p = (t + i / 3f) % 1f;
                        ring.setColor(Ui.alpha(primary, 1f - p));
                        c.drawCircle(cx, cy, mark * 0.55f + p * s * 0.32f, ring);
                    }
                    drawMark(c, cx, cy, mark * (1f + 0.04f * (float) Math.sin(t * Math.PI * 2)), primary, on);
                    break;
                }
                case "reveal": {
                    float p = Math.min(1f, t * 1.4f);
                    c.save();
                    c.clipRect(cx - s / 2f, cy + s / 2f - s * p, cx + s / 2f, cy + s / 2f);
                    drawMark(c, cx, cy, mark, primary, on);
                    c.restore();
                    ring.setColor(Ui.alpha(primary, 0.35f));
                    c.drawArc(new RectF(cx - s * 0.4f, cy - s * 0.4f, cx + s * 0.4f, cy + s * 0.4f), -90, 360 * t, false, ring);
                    break;
                }
                default: {
                    // Orbit: three dots circling the mark on tilted rings.
                    ring.setColor(Ui.alpha(primary, 0.18f));
                    float r1 = s * 0.40f, r2 = s * 0.31f;
                    c.drawCircle(cx, cy, r1, ring);
                    c.drawCircle(cx, cy, r2, ring);
                    for (int i = 0; i < 3; i++) {
                        double a = (t + i / 3.0) * Math.PI * 2 * (i % 2 == 0 ? 1 : -1);
                        float r = i == 1 ? r2 : r1;
                        dot.setColor(Ui.alpha(primary, 0.55f + 0.45f * (i == 0 ? 1 : 0.6f)));
                        c.drawCircle(cx + (float) Math.cos(a) * r, cy + (float) Math.sin(a) * r, Ui.dp(getContext(), i == 0 ? 6 : 4.5f), dot);
                    }
                    drawMark(c, cx, cy, mark * (0.96f + 0.04f * (float) Math.sin(t * Math.PI * 4)), primary, on);
                }
            }
        }
    }
}
