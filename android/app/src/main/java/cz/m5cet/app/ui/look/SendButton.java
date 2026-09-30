package cz.m5cet.app.ui.look;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.InsetDrawable;
import android.view.View;

import cz.m5cet.app.ui.Icons;
import cz.m5cet.app.ui.Ui;

/**
 * The composer's Send (6.2): the arrow on the button's shape, a small badge
 * at its corner saying who gets the message — a group for the whole room,
 * one person when it goes only to the chosen — and three dots at the other
 * corner hinting that holding it offers more ("send.options"). The colours
 * come from the caller (the design's tokens), the shape and the press
 * response from the look.
 */
public final class SendButton extends View {
    private final int size, inset;
    private Drawable arrow, glyph;
    private final Paint badge = new Paint(Paint.ANTI_ALIAS_FLAG), ring = new Paint(Paint.ANTI_ALIAS_FLAG), dots = new Paint(Paint.ANTI_ALIAS_FLAG);
    private boolean cue = true;

    public SendButton(Context c) {
        super(c);
        size = Ui.dp(c, 48);
        inset = Ui.dp(c, 2);
        setClickable(true);
        setFocusable(true);
    }

    /**
     * fill/fg: the button and its arrow; people: "users" (everyone) or "user"
     * (only the chosen); badgeFill/badgeFg: the badge; ringColor: what it
     * sits on (the composer's surface); cue: the long-press dots.
     */
    public void set(String icon, int fill, int fg, String people, int badgeFill, int badgeFg, int ringColor, boolean cue) {
        Context c = getContext();
        arrow = Icons.drawable(c, icon, Ui.dp(c, 21), fg);
        glyph = people == null ? null : Icons.drawable(c, people, Ui.dp(c, 10), badgeFg);
        badge.setColor(badgeFill);
        ring.setColor(ringColor);
        dots.setColor(Ui.alpha(fg, 0.8f));
        this.cue = cue;
        Drawable shape = new InsetDrawable(Ui.shape(fill, Math.min(Look.radius(c, "icon"), size / 2f - inset), 0, 0), inset);
        setBackground(Look.pressable(this, shape, Ui.alpha(fg, 0.25f)));
        invalidate();
    }

    @Override protected void onMeasure(int w, int h) { setMeasuredDimension(size, size); }

    @Override protected void onDraw(Canvas c) {
        super.onDraw(c);
        int w = getWidth(), h = getHeight();
        float d = getResources().getDisplayMetrics().density;
        if (arrow != null) {
            int s = arrow.getIntrinsicWidth(), l = (w - s) / 2 + Math.round(d), t = (h - s) / 2;
            arrow.setBounds(l, t, l + s, t + s);
            arrow.draw(c);
        }
        if (glyph != null) {
            // The badge at the bottom end corner, with a ring of the surface around it.
            float r = 8 * d, cx = w - r - 0.5f * d, cy = h - r - 0.5f * d;
            c.drawCircle(cx, cy, r + 1.5f * d, ring);
            c.drawCircle(cx, cy, r, badge);
            int g = Math.round(10 * d);
            glyph.setBounds(Math.round(cx - g / 2f), Math.round(cy - g / 2f), Math.round(cx - g / 2f) + g, Math.round(cy - g / 2f) + g);
            glyph.draw(c);
        }
        if (cue) {
            // Three small dots at the top end corner: hold for more.
            float r = 1.3f * d, y = inset + 8.5f * d, x = w - inset - 9.5f * d;
            for (int i = 0; i < 3; i++) c.drawCircle(x - i * 3.6f * d, y, r, dots);
        }
    }
}
