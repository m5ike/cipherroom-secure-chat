package cz.m5cet.app.ui.look;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * The colour variants of the templates (6.2, Settings › Appearance ›
 * Colour). Every template offers its own colour and six or more that suit
 * it; a variant is a named hue and saturation, and its shade for the light
 * and the dark tone is found here so that it stays readable — white text
 * on it (and it on white) in the light tone, it on the dark background
 * (and near-black text on it) in the dark one, about 6:1 like the web's
 * accent presets. Pure Java (no android.graphics), so it is unit-tested.
 */
public final class Palette {
    private Palette() {}

    /** The dark tone's text colour (Appearance.readableOn) and the background the shades are measured against. */
    public static final int INK = 0xFF0B0D10;

    /** id → {hue 0–360, saturation 0–1}. */
    private static final Map<String, float[]> NAMED = new LinkedHashMap<>();
    /** template id → its variants, in the picker's order (its own colour comes first, not listed). */
    private static final Map<String, List<String>> TEMPLATES = new HashMap<>();

    private static void named(String id, float h, float s) { NAMED.put(id, new float[]{h, s}); }
    private static void template(String id, String... variants) { TEMPLATES.put(id, Collections.unmodifiableList(Arrays.asList(variants))); }

    static {
        named("red", 356, .82f); named("coral", 8, .78f); named("orange", 27, .92f); named("amber", 38, .95f); named("yellow", 50, .95f);
        named("lime", 84, .75f); named("green", 146, .62f); named("emerald", 160, .72f); named("mint", 165, .55f); named("teal", 174, .72f);
        named("cyan", 188, .85f); named("sky", 200, .88f); named("blue", 214, .88f); named("indigo", 236, .72f); named("violet", 265, .84f);
        named("purple", 285, .68f); named("magenta", 312, .72f); named("pink", 336, .80f); named("rose", 350, .70f);
        named("brown", 24, .45f); named("slate", 215, .22f);
        // Nord's muted ones: frost, steel, sage, sand, terracotta, plum.
        named("frost", 193, .43f); named("steel", 213, .32f); named("sage", 92, .28f); named("sand", 40, .60f); named("clay", 14, .50f); named("plum", 311, .22f);

        // "design" is the design's own look; its list starts with the web's five accents (the 6.1 appearance.accent values).
        template("design", "red", "orange", "green", "blue", "violet", "teal", "pink");
        template("motorsport", "red", "orange", "amber", "cyan", "green", "violet");
        template("glass", "blue", "sky", "indigo", "violet", "teal", "pink");
        template("terminal", "green", "lime", "amber", "cyan", "magenta", "slate");
        template("midnight", "violet", "indigo", "blue", "pink", "teal", "amber");
        template("paper", "brown", "red", "green", "blue", "purple", "teal");
        template("contrast", "yellow", "cyan", "lime", "orange", "pink", "sky");
        template("ios", "blue", "indigo", "purple", "pink", "red", "orange", "green", "teal");
        template("windows", "blue", "sky", "teal", "green", "purple", "rose", "orange");
        template("aurora", "emerald", "teal", "cyan", "sky", "violet", "pink");
        template("nord", "frost", "steel", "sage", "sand", "clay", "plum");
        template("sakura", "pink", "rose", "magenta", "purple", "coral", "mint");
        template("ocean", "teal", "cyan", "sky", "blue", "indigo", "coral", "emerald");
        template("graphite", "orange", "amber", "red", "blue", "green", "slate");
    }

    /** The variants a template offers (an unknown template gets the design's list). */
    public static List<String> variants(String template) {
        List<String> l = TEMPLATES.get(template == null ? "" : template);
        return l != null ? l : TEMPLATES.get("design");
    }

    public static boolean has(String template, String id) { return id != null && !id.isEmpty() && variants(template).contains(id); }

    public static boolean known(String id) { return NAMED.containsKey(id); }

    /** Templates that are bright on black (terminal, contrast) keep their variants as bright. */
    static double target(String template, boolean dark) {
        if (dark && ("terminal".equals(template) || "contrast".equals(template))) return 10;
        return 6;
    }

    /** The variant's colour (ARGB) for a tone of a template, or null for an unknown id. */
    public static Integer color(String template, String id, boolean dark) {
        float[] hs = NAMED.get(id);
        if (hs == null) return null;
        return shade(hs[0], hs[1], dark, target(template, dark));
    }

    /**
     * The lightness that reaches the contrast: in the light tone the lightest
     * shade white text still reads on; in the dark tone the darkest shade that
     * still stands out on the dark background.
     */
    static int shade(float h, float s, boolean dark, double target) {
        double lo = dark ? 0.35 : 0.12, hi = dark ? 0.92 : 0.62;
        for (int i = 0; i < 24; i++) {
            double mid = (lo + hi) / 2;
            int c = hsl(h, s, mid);
            boolean ok = dark ? contrast(c, INK) >= target : contrast(0xFFFFFFFF, c) >= target;
            // light: ok → try lighter; dark: ok → try darker
            if (dark == ok) hi = mid; else lo = mid;
        }
        return hsl(h, s, dark ? hi : lo);
    }

    /** White or near-black, whichever reads better on c. */
    public static int onColor(int c) {
        return contrast(0xFFFFFFFF, c) >= contrast(c, INK) ? 0xFFFFFFFF : INK;
    }

    /* ---------------------------------------------------------- colour math */

    /** HSL (h 0–360, s and l 0–1) → opaque ARGB. */
    public static int hsl(double h, double s, double l) {
        h = ((h % 360) + 360) % 360;
        double c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
        double r, g, b;
        if (h < 60) { r = c; g = x; b = 0; } else if (h < 120) { r = x; g = c; b = 0; } else if (h < 180) { r = 0; g = c; b = x; }
        else if (h < 240) { r = 0; g = x; b = c; } else if (h < 300) { r = x; g = 0; b = c; } else { r = c; g = 0; b = x; }
        return 0xFF000000 | ch(r + m) << 16 | ch(g + m) << 8 | ch(b + m);
    }

    private static int ch(double v) { return (int) Math.round(Math.max(0, Math.min(1, v)) * 255); }

    /** WCAG relative luminance. */
    public static double luminance(int c) {
        return 0.2126 * lin(c >> 16 & 0xFF) + 0.7152 * lin(c >> 8 & 0xFF) + 0.0722 * lin(c & 0xFF);
    }

    private static double lin(int v) { double c = v / 255.0; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }

    /** WCAG contrast ratio (1–21), the lighter colour first or not. */
    public static double contrast(int a, int b) {
        double x = luminance(a), y = luminance(b);
        return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    }

    public static String hex(int c) { return String.format(Locale.ROOT, "#%06x", c & 0xFFFFFF); }
}
