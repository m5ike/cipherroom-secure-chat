package cz.m5cet.app.ui.look;

import android.animation.TimeInterpolator;
import android.app.Activity;
import android.content.Context;
import android.graphics.drawable.Drawable;
import android.view.HapticFeedbackConstants;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewTreeObserver;
import android.widget.HorizontalScrollView;
import android.widget.ScrollView;

import java.lang.ref.WeakReference;
import java.util.HashMap;
import java.util.Map;

import cz.m5cet.app.M5;
import cz.m5cet.app.R;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.core.Settings;
import cz.m5cet.app.design.Appearance;
import cz.m5cet.app.design.Design;
import cz.m5cet.app.ui.Ui;

/**
 * The user's look beyond colours (6.2, Settings › Appearance): the font,
 * motion, buttons and the Tools dock, read from the look.* settings — and
 * the screen drawn again when any of it (or a 6.1 appearance.* key)
 * changes, in place: the activity is not restarted, so the user stays on
 * the screen and its scroll position.
 */
public final class Look {
    private Look() {}

    public static final String VARIANT = "look.variant", FONT = "look.font", MOTION = "look.motion", SPEED = "look.speed",
        BUTTONS = "look.buttons", SHAPE = "look.shape", PRESS = "look.press", HAPTICS = "look.haptics",
        TOOLS_DOCK = "look.toolsDock", HINT_SEND = "look.hintSendOptions", VERSION = "look.v";

    private static Settings settings() { return M5.get().settings; }

    private static String str(String key, String dflt) {
        Settings s = settings();
        String v = s == null ? "" : s.str(key);
        return v.isEmpty() ? dflt : v;
    }

    /* ------------------------------------------------------------ motion */

    /** off | subtle | normal | lively */
    public static String motion() { return str(MOTION, "normal"); }

    /** 0.5 (slow) … 2 (fast). */
    public static float speed() {
        Settings s = settings();
        double v = s == null ? 1 : s.num(SPEED);
        return (float) (v <= 0 ? 1 : Math.max(0.5, Math.min(2, v)));
    }

    public static boolean still(Context c) { return motion().equals("off") || Ui.reducedMotion(c); }

    /** A duration of the design scaled by the motion and the speed (0 when motion is off). */
    public static long ms(long base) {
        String m = motion();
        if (m.equals("off")) return 0;
        double k = m.equals("subtle") ? 0.8 : m.equals("lively") ? 1.15 : 1;
        return Math.max(0, Math.round(base * k / speed()));
    }

    /** How far things slide / how much they grow: subtle less, lively more. */
    public static float travel() {
        String m = motion();
        return m.equals("subtle") ? 0.4f : m.equals("lively") ? 1.6f : 1f;
    }

    /** Lively motion overshoots where the design decelerates. */
    public static TimeInterpolator easing(String name) {
        if (motion().equals("lively") && (name == null || name.isEmpty() || name.equals("decelerate") || name.equals("standard"))) return Ui.easing("overshoot");
        return Ui.easing(name);
    }

    /* ------------------------------------------------------------ buttons */

    /** filled | tonal | outlined | text — the main (primary) buttons. */
    public static String buttons() { return str(BUTTONS, "filled"); }

    /** pill | rounded | square */
    public static String shape() { return str(SHAPE, "pill"); }

    /** ripple | scale | none */
    public static String press() { return str(PRESS, "ripple"); }

    public static boolean haptics() { Settings s = settings(); return s != null && s.bool(HAPTICS); }

    /** The corner radius (px) of a button ("button"), a chip ("chip"), a round icon button ("icon") or a text field ("field"). */
    public static float radius(Context c, String role) {
        String sh = shape();
        if (sh.equals("pill")) return Ui.dp(c, 999);
        boolean square = sh.equals("square");
        switch (role) {
            case "chip": return Ui.dp(c, square ? 4 : 10);
            case "icon": return Ui.dp(c, square ? 6 : 14);
            case "field": return Ui.dp(c, square ? 6 : 16);
            default: return Ui.dp(c, square ? 4 : 12);
        }
    }

    /** A button's background with the press response: a ripple over content, a scale, or nothing. */
    public static Drawable pressable(View v, Drawable content, int rippleColor) {
        String p = press();
        if (p.equals("scale")) { v.setOnTouchListener(SCALE); return content; }
        v.setOnTouchListener(null);
        if (p.equals("none")) return content;
        return Ui.ripple(content, rippleColor);
    }

    /** Shrinks the view a little while it is held; never takes the touch (the click still comes). */
    private static final View.OnTouchListener SCALE = (v, e) -> {
        int a = e.getActionMasked();
        if (a == MotionEvent.ACTION_DOWN) {
            if (Ui.reducedMotion(v.getContext())) { v.setScaleX(0.94f); v.setScaleY(0.94f); }
            else v.animate().scaleX(0.94f).scaleY(0.94f).setDuration(70).setInterpolator(Ui.easing("decelerate")).start();
        } else if (a == MotionEvent.ACTION_UP || a == MotionEvent.ACTION_CANCEL) {
            if (Ui.reducedMotion(v.getContext())) { v.setScaleX(1f); v.setScaleY(1f); }
            else v.animate().scaleX(1f).scaleY(1f).setDuration(140).setInterpolator(Ui.easing(motion().equals("lively") ? "overshoot" : "decelerate")).start();
        }
        return false;
    };

    /** A short tick under the finger (the system's touch-feedback setting still decides). */
    public static void haptic(View v, boolean longPress) {
        if (v != null && haptics()) v.performHapticFeedback(longPress ? HapticFeedbackConstants.LONG_PRESS : HapticFeedbackConstants.VIRTUAL_KEY);
    }

    /* --------------------------------------------------------------- font */

    /** "" (the template's / design's) | sans | serif | mono | condensed | medium | light | casual | cursive */
    public static String font() { return str(FONT, ""); }

    /** The font family in use: the user's, else the template's, else the design's. */
    public static String family(Design d) {
        String f = font();
        if (f.isEmpty()) { String t = Appearance.templateFont(); f = t != null ? t : d == null ? "sans" : d.font(); }
        return familyName(f);
    }

    /** A font choice → the Android family (these exist on every phone since Android 5). */
    public static String familyName(String f) {
        switch (f == null ? "" : f) {
            case "serif": return "serif";
            case "mono": return "monospace";
            case "condensed": return "sans-serif-condensed";
            case "medium": return "sans-serif-medium";
            case "light": return "sans-serif-light";
            case "casual": return "casual";
            case "cursive": return "cursive";
            default: return "sans-serif";
        }
    }

    /** Text the renderer does not draw (the native parts' own) follows the theme's font family. */
    static void applyFont(Context c, Design d) {
        int style;
        switch (family(d)) {
            case "serif": style = R.style.M5_Font_Serif; break;
            case "monospace": style = R.style.M5_Font_Mono; break;
            case "sans-serif-condensed": style = R.style.M5_Font_Condensed; break;
            case "sans-serif-medium": style = R.style.M5_Font_Medium; break;
            case "sans-serif-light": style = R.style.M5_Font_Light; break;
            case "casual": style = R.style.M5_Font_Casual; break;
            case "cursive": style = R.style.M5_Font_Cursive; break;
            default: style = R.style.M5_Font_Sans;
        }
        c.getTheme().applyStyle(style, true);
    }

    /* ---------------------------------------------------------- the dock */

    /** Tools as a floating dock above the composer (else the bottom sheet of 6.1). */
    public static boolean toolsDock() { Settings s = settings(); return s == null || !Boolean.FALSE.equals(s.get(TOOLS_DOCK)); }

    /* ------------------------------------------------------ changing it */

    private static WeakReference<Activity> activity = new WeakReference<>(null);
    private static boolean watching, migrated, pending;

    /** Keys that change nothing on screen. */
    private static boolean silent(String key) {
        return key.equals(HINT_SEND) || key.equals(VERSION) || key.equals(HAPTICS) || key.equals(TOOLS_DOCK);
    }

    /** The activity whose screens are drawn (the Renderer calls it): its font, the one-time migration, the watch. */
    public static void attach(Context c, Design d) {
        if (!(c instanceof Activity)) return;
        activity = new WeakReference<>((Activity) c);
        M5 app = M5.get();
        if (app == null || app.settings == null) return;
        if (!migrated) { migrated = true; migrate(app); }
        applyFont(c, d);
        if (watching) return;
        watching = true;
        app.settings.addListener((key, value) -> {
            if (silent(key) || !(key.startsWith("look.") || key.startsWith("appearance."))) return;
            Appearance.invalidate();
            redrawSoon();
        });
    }

    /** look.set: a look.* or appearance.* key, applied in place. */
    public static boolean set(String key, String value) {
        if (!(key.startsWith("look.") || key.startsWith("appearance."))) return false;
        Settings s = settings();
        // A colour the new template does not offer goes back to the template's own.
        String variant = s.str(VARIANT);
        if (key.equals("appearance.preset") && !variant.isEmpty() && !Palette.has(value, variant)) s.set(VARIANT, "");
        return s.set(key, value);
    }

    /** appearance.reset: the design's own look again — 6.1's keys and the look's — drawn in place. */
    public static void reset() {
        Settings s = settings();
        for (String k : new String[]{"appearance.tone", "appearance.preset", "appearance.accent", "appearance.fontScale", "appearance.density", "appearance.bubbles",
            VARIANT, FONT, MOTION, SPEED, BUTTONS, SHAPE, PRESS, HAPTICS, TOOLS_DOCK}) {
            Object d = Settings.DEFAULTS.get(k);
            if (d != null) s.set(k, d);
        }
    }

    private static void migrate(M5 app) {
        try {
            Settings s = app.settings;
            String preset = s.str("appearance.preset");
            boolean known = preset.isEmpty() || preset.equals("design") || Appearance.hasTemplate(preset);
            for (Map.Entry<String, Object> e : Migration.plan(s.num(VERSION), preset, s.str("appearance.accent"), s.str(VARIANT), known).entrySet()) s.set(e.getKey(), e.getValue());
        } catch (RuntimeException e) {
            Log.w("look", "migration: " + e.getMessage());
        }
    }

    private static void redrawSoon() {
        if (pending) return;
        pending = true;
        Io.mainLater(Look::redraw, 0);
    }

    /** Draws the current screen again (MainActivity's "design" state) and puts its scroll positions back. */
    private static void redraw() {
        pending = false;
        Activity a = activity.get();
        M5 app = M5.get();
        if (a == null || a.isFinishing() || app == null) return;
        applyFont(a, app.design());
        Map<String, int[]> scrolls = new HashMap<>();
        collect(a.getWindow().getDecorView(), scrolls);
        app.emit("design");
        restore(a.getWindow().getDecorView(), scrolls);
    }

    private static void collect(View v, Map<String, int[]> out) {
        if ((v instanceof ScrollView || v instanceof HorizontalScrollView) && v.getTag() instanceof String) {
            out.putIfAbsent(v.getClass().getSimpleName() + ":" + v.getTag(), new int[]{v.getScrollX(), v.getScrollY()});
        }
        if (v instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) v).getChildCount(); i++) collect(((ViewGroup) v).getChildAt(i), out);
    }

    private static void restore(View v, Map<String, int[]> scrolls) {
        if ((v instanceof ScrollView || v instanceof HorizontalScrollView) && v.getTag() instanceof String) {
            int[] at = scrolls.remove(v.getClass().getSimpleName() + ":" + v.getTag());
            if (at != null && (at[0] != 0 || at[1] != 0)) {
                ViewTreeObserver.OnPreDrawListener[] once = new ViewTreeObserver.OnPreDrawListener[1];
                once[0] = () -> {
                    v.getViewTreeObserver().removeOnPreDrawListener(once[0]);
                    v.scrollTo(at[0], at[1]);
                    return true;
                };
                v.getViewTreeObserver().addOnPreDrawListener(once[0]);
            }
        }
        if (v instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) v).getChildCount(); i++) restore(((ViewGroup) v).getChildAt(i), scrolls);
    }
}
