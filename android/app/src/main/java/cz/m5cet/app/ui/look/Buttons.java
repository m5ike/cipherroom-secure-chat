package cz.m5cet.app.ui.look;

import android.graphics.Rect;
import android.graphics.drawable.Drawable;
import android.view.Gravity;
import android.view.View;
import android.widget.TextView;

/**
 * A button's icon beside its label (6.7): in a wide button (a weight, the
 * full width) the platform draws the start icon at the edge and centres
 * the label alone; here the two are centred together, the icon just
 * before the label — like a narrow button looks.
 */
public final class Buttons {
    private Buttons() {}

    private static final View.OnLayoutChangeListener PLACE = (v, l, t, r, b, ol, ot, or, ob) -> {
        if (r - l != or - ol && v instanceof TextView) place((TextView) v);
    };

    /** Keeps the start icon of a centred button next to its label (now and whenever the button's width changes). */
    public static void hug(TextView t) {
        t.removeOnLayoutChangeListener(PLACE);
        t.addOnLayoutChangeListener(PLACE);
        place(t);
    }

    static void place(TextView t) {
        Drawable icon = t.getCompoundDrawablesRelative()[0];
        if (icon == null || t.getWidth() == 0) return;
        Rect b = icon.getBounds();
        int off = 0;
        if ((t.getGravity() & Gravity.HORIZONTAL_GRAVITY_MASK) == Gravity.CENTER_HORIZONTAL && t.getLineCount() <= 1) {
            int room = t.getWidth() - t.getCompoundPaddingLeft() - t.getCompoundPaddingRight();
            off = offset(room, t.getPaint().measureText(String.valueOf(t.getText())));
            if (t.getLayoutDirection() == View.LAYOUT_DIRECTION_RTL) off = -off;
        }
        if (b.left != off) { icon.setBounds(off, b.top, off + b.width(), b.bottom); t.invalidate(); }
    }

    /** How far the icon moves in from the edge: half the room the label leaves (none when it fills it). */
    static int offset(int room, float text) {
        return room <= 0 ? 0 : Math.max(0, Math.round((room - Math.min(text, room)) / 2f));
    }
}
