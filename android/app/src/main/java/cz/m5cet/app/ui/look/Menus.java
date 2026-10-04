package cz.m5cet.app.ui.look;

import android.content.Context;
import android.graphics.Color;
import android.graphics.drawable.Drawable;
import android.text.TextUtils;
import android.util.DisplayMetrics;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.PopupWindow;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.List;

import cz.m5cet.app.M5;
import cz.m5cet.app.design.Appearance;
import cz.m5cet.app.design.Design;
import cz.m5cet.app.ui.Icons;
import cz.m5cet.app.ui.Ui;

/**
 * The app's menus (6.7): the design's menus (MainActivity.showMenu), a
 * message's long press, a select's choices — a card in the design's own
 * colours, each item an icon on the left and its label, a danger item
 * (delete, erase) in the danger colour, a chosen one with a check. The
 * platform's PopupMenu drew the Material dark popup in either tone, so in
 * the light tone the icons (tinted for the light surface) disappeared.
 */
public final class Menus {
    private Menus() {}

    /** One item: its icon (lucide; "" for none), label, and what it does. */
    public static final class Item {
        final String icon, label;
        final boolean danger, checked;
        final Runnable run;

        public Item(String icon, String label, Runnable run) { this(icon, label, false, false, run); }

        public Item(String icon, String label, boolean danger, boolean checked, Runnable run) {
            this.icon = icon == null ? "" : icon; this.label = label == null ? "" : label; this.danger = danger; this.checked = checked; this.run = run;
        }
    }

    /** Actions that destroy something: their items are drawn in the danger colour. */
    public static boolean dangerous(String action) {
        switch (action == null ? "" : action) {
            case "room.delete": case "room.forget": case "wipe.ask": case "people.unlinkAll": return true;
            default: return false;
        }
    }

    /** Shows the menu at its anchor (over it, aligned to its end edge); returns the popup (null when there is nothing to show). */
    public static PopupWindow show(View anchor, List<Item> items) {
        if (anchor == null || items == null || items.isEmpty() || anchor.getWindowToken() == null) return null;
        Context c = anchor.getContext();
        Design d = M5.get().design();
        int surface = Ui.color(c, "@surface", Color.WHITE), onSurface = Ui.color(c, "@onSurface", Color.BLACK);
        int primary = Ui.color(c, "@primary", Color.BLUE), danger = Ui.color(c, "@danger", Color.RED), border = Ui.color(c, "@border", Color.LTGRAY);
        float fs = Appearance.fontScale();
        boolean icons = false;
        for (Item it : items) if (!it.icon.isEmpty()) { icons = true; break; }

        LinearLayout list = new LinearLayout(c);
        list.setOrientation(LinearLayout.VERTICAL);
        list.setPadding(0, Ui.dp(c, 6), 0, Ui.dp(c, 6));
        PopupWindow[] pw = new PopupWindow[1];
        for (Item it : items) {
            LinearLayout row = new LinearLayout(c);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setMinimumHeight(Ui.dp(c, 48));
            row.setPadding(Ui.dp(c, 16), Ui.dp(c, 8), Ui.dp(c, 18), Ui.dp(c, 8));
            int fg = it.danger ? danger : onSurface;
            if (icons) {
                ImageView iv = new ImageView(c);
                iv.setScaleType(ImageView.ScaleType.CENTER);
                if (!it.icon.isEmpty()) iv.setImageDrawable(Icons.drawable(c, it.icon, Ui.dp(c, 20), it.danger ? danger : primary));
                iv.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
                LinearLayout.LayoutParams ip = new LinearLayout.LayoutParams(Ui.dp(c, 22), Ui.dp(c, 22));
                ip.setMarginEnd(Ui.dp(c, 14));
                row.addView(iv, ip);
            }
            TextView t = new TextView(c);
            t.setText(it.label);
            t.setTextColor(fg);
            t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15.5f * fs);
            t.setTypeface(it.checked ? Ui.labelFace(d) : Ui.typeface(d, false, false));
            t.setMaxLines(2);
            t.setEllipsize(TextUtils.TruncateAt.END);
            t.setIncludeFontPadding(false);
            row.addView(t, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            if (it.checked) {
                ImageView check = new ImageView(c);
                check.setImageDrawable(Icons.drawable(c, "check", Ui.dp(c, 18), primary));
                check.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
                LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(Ui.dp(c, 18), Ui.dp(c, 18));
                cp.setMarginStart(Ui.dp(c, 12));
                row.addView(check, cp);
                row.setSelected(true);
            }
            row.setBackground(Ui.ripple(null, Ui.alpha(onSurface, 0.12f)));
            row.setClickable(true);
            row.setFocusable(true);
            row.setContentDescription(it.label);
            row.setOnClickListener(v -> {
                Look.haptic(v, false);
                if (pw[0] != null) pw[0].dismiss();
                // After the popup is gone (its own views are detached by then: the main loop runs it).
                if (it.run != null) cz.m5cet.app.core.Io.mainLater(it.run, 0);
            });
            list.addView(row, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        }

        DisplayMetrics dm = c.getResources().getDisplayMetrics();
        int maxW = Math.min(Ui.dp(c, 320), dm.widthPixels - Ui.dp(c, 32));
        list.measure(View.MeasureSpec.makeMeasureSpec(maxW, View.MeasureSpec.AT_MOST), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
        int width = Math.max(Math.min(Ui.dp(c, 200), maxW), Math.min(maxW, list.getMeasuredWidth()));
        int maxH = (int) (dm.heightPixels * 0.6f);
        View body = list;
        int height = ViewGroup.LayoutParams.WRAP_CONTENT;
        if (list.getMeasuredHeight() > maxH) {
            ScrollView sv = new ScrollView(c);
            sv.addView(list);
            body = sv;
            height = maxH;
        }

        float radius = Ui.dp(c, Math.max(10, Math.min(20, Appearance.radius(d))));
        Drawable card = Ui.shape(surface, radius, Math.max(1, Ui.dp(c, 0.75f)), Ui.alpha(border, 0.9f));
        PopupWindow p = new PopupWindow(body, width, height, true);
        pw[0] = p;
        p.setBackgroundDrawable(card);
        p.setElevation(Ui.dp(c, 10));
        p.setOutsideTouchable(true);
        p.setOverlapAnchor(true);
        p.setAnimationStyle(0);
        body.setClipToOutline(true);
        body.setBackground(Ui.shape(Color.TRANSPARENT, radius, 0, 0));
        p.showAsDropDown(anchor, 0, 0, Gravity.END);
        enter(body);
        return p;
    }

    /** Grows from its corner, the way the user likes motion. */
    private static void enter(View v) {
        long ms = Look.ms(170);
        if (ms <= 0 || Look.still(v.getContext())) return;
        v.setAlpha(0f);
        v.setScaleX(0.94f);
        v.setScaleY(0.94f);
        v.setTranslationY(-Ui.dp(v.getContext(), 6) * Look.travel());
        v.post(() -> {
            v.setPivotX(v.getLayoutDirection() == View.LAYOUT_DIRECTION_RTL ? 0 : v.getWidth());
            v.setPivotY(0);
            v.animate().alpha(1f).scaleX(1f).scaleY(1f).translationY(0).setDuration(ms).setInterpolator(Look.easing("decelerate")).start();
        });
    }
}
