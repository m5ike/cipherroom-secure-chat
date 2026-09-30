package cz.m5cet.app.ui;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.util.TypedValue;
import android.view.animation.AccelerateInterpolator;
import android.view.animation.BounceInterpolator;
import android.view.animation.DecelerateInterpolator;
import android.view.animation.Interpolator;
import android.view.animation.LinearInterpolator;
import android.view.animation.OvershootInterpolator;
import android.view.animation.PathInterpolator;

import cz.m5cet.app.M5;
import cz.m5cet.app.design.Design;

/** Units, colours, shapes and easings shared by the renderer and the native parts. */
public final class Ui {
    private Ui() {}

    public static int dp(Context c, float v) { return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, c.getResources().getDisplayMetrics())); }

    public static boolean dark(Context c) {
        // 6.1: a one-tone template decides; else Settings › Appearance › Tone; else the 5.x choice; else the system's.
        Boolean forced = cz.m5cet.app.design.Appearance.forcedDark();
        return forced != null ? forced : cz.m5cet.app.design.Appearance.userDark(c);
    }

    public static int color(Context c, String token, int fallback) {
        return M5.get().design().color(token, dark(c), fallback);
    }

    public static int color(Context c, String token) { return color(c, token, Color.MAGENTA); }

    public static GradientDrawable shape(int fill, float radiusPx, int strokeW, int strokeColor) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(fill);
        g.setCornerRadius(radiusPx);
        if (strokeW > 0) g.setStroke(strokeW, strokeColor);
        return g;
    }
    public static Drawable ripple(Drawable content, int rippleColor) {
        return new RippleDrawable(ColorStateList.valueOf(rippleColor), content, content == null ? new GradientDrawable() : null);
    }

    /** A byte count for people ("12.3 kB"), like the templates' |size filter. */
    public static String size(long bytes) { return String.valueOf(Expr.filter((double) bytes, "size", null)); }

    public static int alpha(int color, float a) { return Color.argb(Math.round(Color.alpha(color) * a), Color.red(color), Color.green(color), Color.blue(color)); }

    /** 6.2: the user's font family (Settings › Appearance), else the template's, else the design's. */
    public static Typeface typeface(Design d, boolean bold, boolean italic) {
        return typeface(cz.m5cet.app.ui.look.Look.family(d), bold, italic);
    }

    public static Typeface typeface(String family, boolean bold, boolean italic) {
        int style = bold && italic ? Typeface.BOLD_ITALIC : bold ? Typeface.BOLD : italic ? Typeface.ITALIC : Typeface.NORMAL;
        return Typeface.create(family, style);
    }

    /** Labels of buttons and chips: the medium weight where the family has one (calmer than bold). */
    public static Typeface labelFace(Design d) {
        String family = cz.m5cet.app.ui.look.Look.family(d);
        return family.equals("sans-serif") ? Typeface.create("sans-serif-medium", Typeface.NORMAL) : typeface(family, true, false);
    }

    public static Interpolator easing(String name) {
        switch (name == null ? "" : name) {
            case "decelerate": return new DecelerateInterpolator(1.6f);
            case "accelerate": return new AccelerateInterpolator(1.4f);
            case "linear": return new LinearInterpolator();
            case "overshoot": return new OvershootInterpolator(1.6f);
            case "bounce": return new BounceInterpolator();
            default: return new PathInterpolator(0.4f, 0f, 0.2f, 1f);
        }
    }

    /** Does the system ask for less motion? (then animations are skipped) */
    public static boolean reducedMotion(Context c) {
        try {
            return android.provider.Settings.Global.getFloat(c.getContentResolver(), android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f;
        } catch (RuntimeException e) {
            return false;
        }
    }

    /** A stable colour for a name (avatars). */
    public static int nameColor(String name) {
        int[] palette = {0xFFE11D48, 0xFF2563EB, 0xFF059669, 0xFFD97706, 0xFF7C3AED, 0xFF0891B2, 0xFFDB2777, 0xFF65A30D, 0xFFEA580C, 0xFF4F46E5};
        int h = 0;
        for (int i = 0; i < name.length(); i++) h = h * 31 + name.charAt(i);
        return palette[Math.abs(h % palette.length)];
    }

    public static String initials(String name) {
        String n = name == null ? "" : name.trim();
        if (n.isEmpty()) return "?";
        String[] parts = n.split("[\\s._-]+");
        String a = parts[0].isEmpty() ? "" : parts[0].substring(0, 1);
        String b = parts.length > 1 && !parts[1].isEmpty() ? parts[1].substring(0, 1) : "";
        return (a + b).toUpperCase(java.util.Locale.ROOT);
    }
}
