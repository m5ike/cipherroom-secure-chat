package cz.m5cet.app.design;

import android.graphics.Color;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

import cz.m5cet.app.M5;
import cz.m5cet.app.core.Log;

/**
 * The user's look on top of the design (6.1, Settings › Appearance):
 *  - a template of the web client (assets/m5/themes.json, taken from the
 *    web's CSS by the build): its colours replace the design's tokens; a
 *    template with one tone keeps it (like on the web);
 *  - the tone (system / light / dark);
 *  - an accent — the web's presets (red, orange, green, blue, violet; one
 *    shade for dark, a darker one for light) or #rrggbb — for primary and
 *    my bubbles;
 *  - the text size, the density and the bubbles' shape (the Renderer).
 */
public final class Appearance {
    private Appearance() {}

    private static JSONArray themes;
    private static String cacheKey = "";
    private static final Map<String, Integer> cache = new HashMap<>();

    /** The web's accent presets (index.css): {dark HSL, light HSL}. */
    private static final Map<String, float[][]> ACCENTS = new HashMap<>();
    static {
        ACCENTS.put("red", new float[][]{{356, 82, 56}, {356, 78, 42}});
        ACCENTS.put("orange", new float[][]{{27, 92, 54}, {24, 90, 38}});
        ACCENTS.put("green", new float[][]{{146, 62, 46}, {148, 64, 28}});
        ACCENTS.put("blue", new float[][]{{214, 88, 60}, {216, 84, 42}});
        ACCENTS.put("violet", new float[][]{{265, 84, 68}, {264, 62, 46}});
    }

    public static synchronized JSONArray themes() {
        if (themes != null) return themes;
        try (InputStream in = M5.get().getAssets().open("m5/themes.json")) {
            themes = new JSONArray(new String(in.readAllBytes(), StandardCharsets.UTF_8));
        } catch (Exception e) {
            Log.w("look", "no templates: " + e.getMessage());
            themes = new JSONArray();
        }
        return themes;
    }

    static JSONObject theme(String id) {
        JSONArray t = themes();
        for (int i = 0; i < t.length(); i++) if (id.equals(t.optJSONObject(i).optString("id"))) return t.optJSONObject(i);
        return null;
    }

    /** $presets for the Appearance screen: the design's own look first, then the web's templates. */
    public static JSONArray presets(String lang, String designLabel) {
        JSONArray out = new JSONArray();
        try {
            out.put(new JSONObject().put("value", "design").put("label", designLabel));
            JSONArray t = themes();
            for (int i = 0; i < t.length(); i++) {
                JSONObject th = t.optJSONObject(i);
                JSONObject label = th.optJSONObject("label");
                out.put(new JSONObject().put("value", th.optString("id")).put("label", label == null ? th.optString("id") : label.optString(lang, label.optString("en"))));
            }
        } catch (org.json.JSONException ignored) { }
        return out;
    }

    /** A template with a single tone decides the tone (null = the user's choice applies). */
    public static Boolean forcedDark() {
        JSONObject th = theme(M5.get().settings.str("appearance.preset"));
        if (th == null) return null;
        JSONArray tones = th.optJSONArray("tones");
        if (tones == null || tones.length() != 1) return null;
        return "dark".equals(tones.optString(0));
    }

    /** The colour a token has in the user's look, or null (the design's own). */
    public static synchronized Integer override(String token, boolean dark) {
        M5 app = M5.get();
        String preset = app.settings.str("appearance.preset"), accent = app.settings.str("appearance.accent");
        String key = preset + "|" + accent;
        if (!key.equals(cacheKey)) { cache.clear(); cacheKey = key; }
        String k = token + (dark ? "|d" : "|l");
        if (cache.containsKey(k)) return cache.get(k);
        Integer v = compute(token, dark, preset, accent);
        cache.put(k, v);
        return v;
    }

    private static Integer compute(String token, boolean dark, String preset, String accent) {
        if (!accent.isEmpty() && (token.equals("primary") || token.equals("accent") || token.equals("bubbleOut") || token.equals("onPrimary") || token.equals("onBubbleOut"))) {
            Integer a = accentColor(accent, dark);
            if (a != null) {
                if (token.equals("onPrimary") || token.equals("onBubbleOut")) return readableOn(a);
                return a;
            }
        }
        JSONObject th = theme(preset);
        if (th == null) return null;
        JSONObject tone = th.optJSONObject(dark ? "dark" : "light");
        if (tone == null) { JSONArray tones = th.optJSONArray("tones"); tone = tones == null ? null : th.optJSONObject(tones.optString(0)); }
        String hex = tone == null ? null : tone.optString(token, null);
        try { return hex == null ? null : Color.parseColor(hex); } catch (IllegalArgumentException e) { return null; }
    }

    static Integer accentColor(String accent, boolean dark) {
        if (accent.startsWith("#")) { try { return Color.parseColor(accent); } catch (IllegalArgumentException e) { return null; } }
        float[][] hsl = ACCENTS.get(accent);
        if (hsl == null) return null;
        float[] c = hsl[dark ? 0 : 1];
        return Color.HSVToColor(hslToHsv(c[0], c[1] / 100f, c[2] / 100f));
    }

    static float[] hslToHsv(float h, float s, float l) {
        float v = l + s * Math.min(l, 1 - l);
        return new float[]{h, v == 0 ? 0 : 2 * (1 - l / v), v};
    }

    /** White or near-black, whichever reads better on c (color.ts readableOn). */
    static int readableOn(int c) {
        double lum = 0.2126 * lin(Color.red(c)) + 0.7152 * lin(Color.green(c)) + 0.0722 * lin(Color.blue(c));
        double white = 1.05 / (lum + 0.05), black = (lum + 0.05) / (lum(0x0b, 0x0d, 0x10) + 0.05);
        return white >= black ? Color.WHITE : 0xFF0B0D10;
    }

    private static double lum(int r, int g, int b) { return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); }
    private static double lin(int v) { double c = v / 255.0; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }

    /* ---------------------------------------------------- the Renderer */

    public static float fontScale() {
        double s = M5.get().settings.num("appearance.fontScale");
        return (float) (s <= 0 ? 1 : Math.max(0.7, Math.min(1.8, s)));
    }

    /** Padding, margins and gaps: compact 0.8, comfortable 1.2. */
    public static float density() {
        String d = M5.get().settings.str("appearance.density");
        return d.equals("compact") ? 0.8f : d.equals("comfortable") ? 1.2f : 1f;
    }

    public static String bubbles() { return M5.get().settings.str("appearance.bubbles"); }
}
