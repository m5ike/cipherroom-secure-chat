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

    public static Design builtIn(Context ctx) {
        try (InputStream in = ctx.getAssets().open("m5/default-design.json")) {
            byte[] b = readAll(in);
            JSONObject d = new JSONObject(new String(b, StandardCharsets.UTF_8));
            Design design = new Design("built-in", d.optString("rev", "default"), d.optJSONObject("app"), d.optJSONObject("theme"), d.optJSONObject("animations"));
            copy(d.optJSONObject("screens"), design.screens);
            JSONObject menus = d.optJSONObject("menus");
            if (menus != null) for (Iterator<String> it = menus.keys(); it.hasNext(); ) { String k = it.next(); design.menus.put(k, menus.optJSONArray(k)); }
            copy(d.optJSONObject("strings"), design.strings);
            copy(d.optJSONObject("libraries"), design.libraries);
            return design;
        } catch (IOException | JSONException e) {
            throw new IllegalStateException("the built-in design is broken", e);
        }
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

    /** A text in a language, falling back to English and then to the key. */
    public String t(String key, String lang) {
        JSONObject table = strings.get(lang);
        if (table != null && table.has(key)) return table.optString(key);
        JSONObject en = strings.get("en");
        if (en != null && en.has(key)) return en.optString(key);
        return key;
    }

    /** A colour: "@token" from the theme (light/dark), "#rrggbb" or "#aarrggbb". */
    public int color(String value, boolean dark, int fallback) {
        if (value == null || value.isEmpty()) return fallback;
        try {
            if (value.startsWith("@")) {
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
