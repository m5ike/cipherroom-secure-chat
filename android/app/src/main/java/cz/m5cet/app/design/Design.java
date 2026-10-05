package cz.m5cet.app.design;

import android.content.Context;
import android.graphics.Color;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

import cz.m5cet.app.core.Formats;
import cz.m5cet.app.core.Locales;
import cz.m5cet.app.core.Plurals;

/**
 * A design as the app uses it: the screens' element trees, the theme, the
 * animations, the texts, the menus, the action libraries, the assets — from
 * the active bundle, or the built-in default (assets/m5/default-design.json,
 * generated from the server's DEFAULT_DESIGN).
 */
public final class Design {
    public final String source;
    public final String version;
    public final JSONObject app;
    public final JSONObject theme;
    public final JSONObject animations;
    public final Map<String, JSONObject> screens = new HashMap<>();
    public final Map<String, JSONArray> menus = new HashMap<>();
    public final Map<String, JSONObject> strings = new HashMap<>();
    public final Map<String, JSONObject> libraries = new HashMap<>();
    public final Map<String, byte[]> assets = new HashMap<>();

    private Design(String source, String version, JSONObject app, JSONObject theme, JSONObject animations) {
        this.source = source;
        this.version = version;
        this.app = app;
        this.theme = theme;
        this.animations = animations;
    }

    /** 6.13: read once — it is the same for the whole life of the installed app. */
    private static volatile Design builtIn;

    public static Design builtIn(Context ctx) {
        Design cached = builtIn;
        if (cached != null) return cached;
        try (InputStream in = ctx.getAssets().open("m5/default-design.json")) {
            Design design = fromJson(new JSONObject(new String(readAll(in), StandardCharsets.UTF_8)));
            builtIn = design;
            return design;
        } catch (IOException | JSONException e) {
            throw new IllegalStateException("the built-in design is broken", e);
        }
    }

    /** A whole design as default-design.json has it. */
    public static Design fromJson(JSONObject d) {
        Design design = new Design("built-in", d.optString("rev", "default"), d.optJSONObject("app"), d.optJSONObject("theme"), d.optJSONObject("animations"));
        copy(d.optJSONObject("screens"), design.screens);
        JSONObject menus = d.optJSONObject("menus");
        if (menus != null) for (Iterator<String> it = menus.keys(); it.hasNext(); ) { String k = it.next(); design.menus.put(k, menus.optJSONArray(k)); }
        copy(d.optJSONObject("strings"), design.strings);
        copy(d.optJSONObject("libraries"), design.libraries);
        return design;
    }

    private static void copy(JSONObject from, Map<String, JSONObject> to) {
        if (from == null) return;
        for (Iterator<String> it = from.keys(); it.hasNext(); ) { String k = it.next(); JSONObject v = from.optJSONObject(k); if (v != null) to.put(k, v); }
    }

    static byte[] readAll(InputStream in) throws IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toByteArray();
    }

    /** From a bundle's files; throws when anything essential is missing or malformed. */
    public static Design fromFiles(String bundleId, String version, Map<String, byte[]> files) throws JSONException {
        Design d = new Design(bundleId, version, obj(files, "app.json"), obj(files, "theme.json"), obj(files, "animations.json"));
        for (Map.Entry<String, byte[]> e : files.entrySet()) {
            String p = e.getKey();
            String text = p.endsWith(".json") ? new String(e.getValue(), StandardCharsets.UTF_8) : null;
            if (p.startsWith("screens/")) d.screens.put(p.substring(8, p.length() - 5), new JSONObject(text));
            else if (p.startsWith("menus/")) d.menus.put(p.substring(6, p.length() - 5), new JSONArray(text));
            else if (p.startsWith("strings/")) d.strings.put(p.substring(8, p.length() - 5), new JSONObject(text));
            else if (p.startsWith("lib/")) d.libraries.put(p.substring(4, p.length() - 5), new JSONObject(text));
            else if (p.startsWith("assets/")) d.assets.put(p.substring(7), e.getValue());
        }
        for (String required : new String[]{"splash", "lock", "rooms", "room", "message.in", "message.out", "message.sys"}) {
            if (!d.screens.containsKey(required)) throw new JSONException("the bundle has no " + required + " screen");
        }
        if (d.theme == null || d.theme.optJSONObject("light") == null) throw new JSONException("the bundle has no theme");
        return d;
    }

    private static JSONObject obj(Map<String, byte[]> files, String path) throws JSONException {
        byte[] b = files.get(path);
        if (b == null) throw new JSONException("the bundle has no " + path);
        return new JSONObject(new String(b, StandardCharsets.UTF_8));
    }

    public JSONObject screen(String id) { return screens.get(id); }

    public String appName() { return app == null ? "M5cet" : app.optString("name", "M5cet"); }

    /**
     * 6.13: where a text this design lacks comes from — the built-in design, so a
     * bundle built by an older server (three languages, fewer keys) still shows
     * the app's newer texts and languages. Set on bundle designs only.
     */
    private volatile Design fallback;

    public Design withFallback(Design builtIn) { this.fallback = builtIn == this ? null : builtIn; return this; }

    /**
     * A text in a language: along the language's chain (Locales.chain — the
     * language, its fallbacks such as Slovak → Czech, then English), in each
     * language this design's table first, then the built-in design's; the key
     * itself when nobody has it.
     */
    public String t(String key, String lang) {
        String v = text(key, lang);
        return v != null ? v : key;
    }

    /** The same, or null when no table along the chain has the key. */
    public String text(String key, String lang) {
        for (String l : Locales.chain(lang)) {
            String v = either(key, l);
            if (v != null) return v;
        }
        return null;
    }

    /**
     * 6.13: a text shown with a count: in each language of the chain the form
     * of n's plural category ("key#few"), then "key#other", then the plain key —
     * with "{n}" replaced by the number as the asked language writes it.
     */
    public String tn(String key, long n, String lang) {
        String v = null;
        for (String l : Locales.chain(lang)) {
            String cat = Plurals.category(Locales.tag(l), n);
            v = either(key + "#" + cat, l);
            if (v == null && !cat.equals("other")) v = either(key + "#other", l);
            if (v == null) v = either(key, l);
            if (v != null) break;
        }
        if (v == null) return key;
        return v.replace("{n}", Formats.count(lang, n));
    }

    private String either(String key, String lang) {
        String v = own(key, lang);
        if (v == null && fallback != null) v = fallback.own(key, lang);
        return v;
    }

    private String own(String key, String lang) {
        JSONObject table = strings.get(lang);
        return table != null && table.has(key) ? table.optString(key) : null;
    }

    /** A colour: "@token" from the theme (light/dark), "#rrggbb" or "#aarrggbb". */
    public int color(String value, boolean dark, int fallback) {
        if (value == null || value.isEmpty()) return fallback;
        try {
            if (value.startsWith("@")) {
                // 6.1: the user's template / accent first (Settings › Appearance).
                Integer own = Appearance.override(value.substring(1), dark);
                if (own != null) return own;
                JSONObject tone = theme == null ? null : theme.optJSONObject(dark ? "dark" : "light");
                String hex = tone == null ? null : tone.optString(value.substring(1), null);
                return hex == null ? fallback : parse(hex);
            }
            return parse(value);
        } catch (IllegalArgumentException e) {
            return fallback;
        }
    }

    /** "#rrggbbaa" (the design's alpha last) or "#rrggbb". */
    static int parse(String hex) {
        if (hex.length() == 9) {
            // Design colours carry alpha as #aarrggbb (Android's form) — the sanitizer accepts both lengths.
            return Color.parseColor(hex);
        }
        return Color.parseColor(hex);
    }

    public int radius() { return theme == null ? 14 : theme.optInt("radius", 14); }
    public String font() { return theme == null ? "sans" : theme.optString("font", "sans"); }

    public JSONObject anim(String name) {
        JSONObject a = animations == null ? null : animations.optJSONObject(name);
        return a != null ? a : new JSONObject();
    }
}
