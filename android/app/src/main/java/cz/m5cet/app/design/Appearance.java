package cz.m5cet.app.design;

import android.content.Context;
import android.graphics.Color;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

import cz.m5cet.app.M5;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.ui.look.Look;
import cz.m5cet.app.ui.look.Palette;

/**
 * The user's look on top of the design (6.1, Settings › Appearance):
 *  - a template of the web client (assets/m5/themes.json, taken from the
 *    web's CSS by the build): its colours replace the design's tokens; a
 *    template with one tone keeps it (like on the web); 6.2: its corner
 *    radius and font family too;
 *  - 6.2: a colour variant of the template (ui/look/Palette: its own
 *    colour or one of six or more that suit it, shaded for the tone) for
 *    primary, accent and my bubbles;
 *  - the tone (system / light / dark);
 *  - an accent — the web's presets (red, orange, green, blue, violet; one
 *    shade for dark, a darker one for light) or #rrggbb — 6.1's key, still
 *    honoured when no variant is chosen;
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

    /** The web's template families, in its picker's order (the design's own look first). */
    private static final String[] FAMILIES = {"system", "studio", "classic"};

    public static synchronized JSONArray themes() {
        if (themes != null) return themes;
        try (InputStream in = M5.get().getAssets().open("m5/themes.json")) {
            themes = new JSONArray(new String(cz.m5cet.app.core.Streams.readAll(in), StandardCharsets.UTF_8));
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

    public static boolean hasTemplate(String id) { return id != null && theme(id) != null; }

    private static String preset() { return M5.get().settings.str("appearance.preset"); }

    /** The look changed (Look's settings watch): colours are worked out again. */
    public static synchronized void invalidate() { cache.clear(); cacheKey = ""; }

    /**
     * $presets for the Appearance screen: the design's own look first, then
     * the web's templates by family — each with the colours of its preview
     * card (bg, surface, fg, primary, onPrimary in the tone it would show),
     * whether it is chosen, and its colour variants ({value, label, color,
     * on, selected}; the template's own colour first, value "").
     */
    public static JSONArray presets(String lang, String designLabel) {
        JSONArray out = new JSONArray();
        M5 app = M5.get();
        String current = preset(), variant = app.settings.str(Look.VARIANT);
        boolean userDark = userDark(app);
        try {
            out.put(entry(app, "design", designLabel, "design", null, current, variant, userDark));
            JSONArray t = themes();
            for (String family : FAMILIES) {
                for (int i = 0; i < t.length(); i++) {
                    JSONObject th = t.optJSONObject(i);
                    if (!family.equals(th.optString("family", "classic"))) continue;
                    JSONObject label = th.optJSONObject("label");
                    out.put(entry(app, th.optString("id"), label == null ? th.optString("id") : label.optString(lang, label.optString("en")), family, th, current, variant, userDark));
                }
            }
            // Templates of a family this app does not know yet (an older themes.json) at the end.
            for (int i = 0; i < t.length(); i++) {
                JSONObject th = t.optJSONObject(i);
                String f = th.optString("family", "classic");
                if (f.equals("system") || f.equals("studio") || f.equals("classic")) continue;
                JSONObject label = th.optJSONObject("label");
                out.put(entry(app, th.optString("id"), label == null ? th.optString("id") : label.optString(lang, label.optString("en")), f, th, current, variant, userDark));
            }
        } catch (org.json.JSONException ignored) { }
        return out;
    }

    private static JSONObject entry(M5 app, String id, String label, String family, JSONObject th, String current, String variant, boolean userDark) throws org.json.JSONException {
        boolean chosen = id.equals(current) || (id.equals("design") && (current.isEmpty() || theme(current) == null));
        Boolean forced = th == null ? null : forced(th);
        boolean dark = forced != null ? forced : userDark;
        JSONObject tokens = th == null ? designTokens(app, dark) : tones(th, dark);
        String primary = tokens.optString("primary", "#888888");
        JSONObject e = new JSONObject().put("value", id).put("label", label).put("family", family).put("selected", chosen)
            .put("tone", forced == null ? "both" : forced ? "dark" : "light")
            .put("bg", tokens.optString("background", "#808080")).put("surface", tokens.optString("surface", "#909090"))
            .put("fg", tokens.optString("onSurface", "#000000")).put("primary", primary).put("onPrimary", tokens.optString("onPrimary", "#ffffff"));
        JSONArray vs = new JSONArray();
        vs.put(new JSONObject().put("value", "").put("label", app.t("look.variant.own")).put("color", primary).put("on", tokens.optString("onPrimary", "#ffffff"))
            .put("selected", chosen && !Palette.has(id, variant)));
        for (String v : Palette.variants(id)) {
            Integer c = Palette.color(id, v, dark);
            if (c == null) continue;
            vs.put(new JSONObject().put("value", v).put("label", app.t("color." + v)).put("color", Palette.hex(c)).put("on", Palette.hex(Palette.onColor(c)))
                .put("selected", chosen && v.equals(variant)));
        }
        e.put("variants", vs);
        return e;
    }

    /** The template's tokens for a tone (its only tone when it has one). */
    private static JSONObject tones(JSONObject th, boolean dark) {
        JSONObject tone = th.optJSONObject(dark ? "dark" : "light");
        if (tone == null) { JSONArray tones = th.optJSONArray("tones"); tone = tones == null ? null : th.optJSONObject(tones.optString(0)); }
        return tone == null ? new JSONObject() : tone;
    }

    /** The design's own tokens (not the user's overrides). */
    private static JSONObject designTokens(M5 app, boolean dark) {
        JSONObject theme = app.design().theme;
        JSONObject tone = theme == null ? null : theme.optJSONObject(dark ? "dark" : "light");
        return tone == null ? new JSONObject() : tone;
    }

    private static Boolean forced(JSONObject th) {
        JSONArray tones = th.optJSONArray("tones");
        if (tones == null || tones.length() != 1) return null;
        return "dark".equals(tones.optString(0));
    }

    /** A template with a single tone decides the tone (null = the user's choice applies). */
    public static Boolean forcedDark() {
        JSONObject th = theme(preset());
        return th == null ? null : forced(th);
    }

    /** The tone the user chose (Settings › Appearance › Tone, else the 5.x choice, else the system's). */
    public static boolean userDark(Context c) {
        M5 app = M5.get();
        String t61 = app.settings.str("appearance.tone");
        if (t61.equals("dark")) return true;
        if (t61.equals("light")) return false;
        String tone = app.config.tone();
        if (tone.equals("dark")) return true;
        if (tone.equals("light")) return false;
        int mode = c.getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK;
        return mode == android.content.res.Configuration.UI_MODE_NIGHT_YES;
    }

    /** The colour a token has in the user's look, or null (the design's own). */
    public static synchronized Integer override(String token, boolean dark) {
        M5 app = M5.get();
        String preset = preset(), accent = app.settings.str("appearance.accent"), variant = app.settings.str(Look.VARIANT);
        String key = preset + "|" + accent + "|" + variant;
        if (!key.equals(cacheKey)) { cache.clear(); cacheKey = key; }
        String k = token + (dark ? "|d" : "|l");
        if (cache.containsKey(k)) return cache.get(k);
        Integer v = compute(token, dark, preset, accent, variant);
        cache.put(k, v);
        return v;
    }

    private static boolean accentToken(String token) {
        return token.equals("primary") || token.equals("accent") || token.equals("bubbleOut") || token.equals("onPrimary") || token.equals("onBubbleOut");
    }

    private static Integer compute(String token, boolean dark, String preset, String accent, String variant) {
        if (accentToken(token)) {
            // 6.2: the template's colour variant, else 6.1's accent.
            String template = theme(preset) == null ? "design" : preset;
            Integer a = Palette.has(template, variant) ? Palette.color(template, variant, dark) : accent.isEmpty() ? null : accentColor(accent, dark);
            if (a != null) return token.equals("onPrimary") || token.equals("onBubbleOut") ? readableOn(a) : a;
        }
        JSONObject th = theme(preset);
        if (th == null) return null;
        String hex = tones(th, dark).optString(token, null);
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
    static int readableOn(int c) { return Palette.onColor(c); }

    /* ---------------------------------------------------- the Renderer */

    /** 6.2: the template's corner radius (dp), else the design's. */
    public static int radius(Design d) {
        JSONObject th = theme(preset());
        if (th != null && th.has("radius")) return Math.max(0, Math.min(28, th.optInt("radius", 14)));
        return d == null ? 14 : d.radius();
    }

    /** 6.2: the template's font (sans / serif / mono), or null (the design's). */
    public static String templateFont() {
        JSONObject th = theme(preset());
        String f = th == null ? "" : th.optString("font", "");
        return f.isEmpty() ? null : f;
    }

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
