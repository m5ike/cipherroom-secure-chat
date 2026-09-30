package cz.m5cet.app.ui.bubble;

import org.json.JSONObject;

import java.util.Locale;
import java.util.concurrent.CopyOnWriteArrayList;

import cz.m5cet.app.M5;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;

/**
 * The operator's map preview (6.2): GET /api/client-config › config.map,
 * checked like sanitizeMapPreview() in client/src/lib/client-config.ts.
 * Asked for once and again every 10 minutes (a minute after a failure);
 * until the server answered — or when it cannot be reached, or a server
 * without map previews answers — a message shows the pin as before 6.2.
 */
public final class MapPolicy {
    public final boolean enabled;
    public final String tiles, subdomains, attribution;
    public final int zoom, width, height;
    /** ARGB; accent 0 = the theme's primary colour. */
    public final int pinColor, accent;
    public final boolean label, showCoords, grayscale;
    public final int cacheHours;

    private MapPolicy(JSONObject r) {
        enabled = r.opt("enabled") instanceof Boolean ? r.optBoolean("enabled") : true;
        String t = r.opt("tiles") instanceof String ? r.optString("tiles").trim() : "";
        tiles = t.isEmpty() ? "https://tile.openstreetmap.org/{z}/{x}/{y}.png" : t;
        String s = r.opt("subdomains") instanceof String ? r.optString("subdomains") : "";
        subdomains = s.matches("[A-Za-z0-9]{0,8}") ? s : "";
        attribution = r.opt("attribution") instanceof String ? clean(r.optString("attribution"), 120) : "© OpenStreetMap";
        zoom = num(r.opt("zoom"), 3, 19, 16);
        width = num(r.opt("width"), 160, 640, 280);
        height = num(r.opt("height"), 100, 480, 160);
        pinColor = color(r.opt("pinColor"), 0xFFE11D48);
        accent = color(r.opt("accent"), 0);
        label = r.opt("label") instanceof Boolean ? r.optBoolean("label") : true;
        showCoords = r.opt("showCoords") instanceof Boolean ? r.optBoolean("showCoords") : true;
        grayscale = r.opt("grayscale") instanceof Boolean && r.optBoolean("grayscale");
        cacheHours = num(r.opt("cacheHours"), 1, 720, 168);
    }

    /** config.map as the server sent it; a server without it (before 6.2) has no tiles to give: off. */
    public static MapPolicy parse(JSONObject config) {
        JSONObject map = config == null ? null : config.optJSONObject("map");
        if (map == null) {
            try { return new MapPolicy(new JSONObject().put("enabled", false)); } catch (org.json.JSONException e) { throw new IllegalStateException(e); }
        }
        return new MapPolicy(map);
    }

    static int num(Object v, int lo, int hi, int dflt) {
        if (!(v instanceof Number) || !Double.isFinite(((Number) v).doubleValue())) return dflt;
        return (int) Math.max(lo, Math.min(hi, Math.round(((Number) v).doubleValue())));
    }

    static int color(Object v, int dflt) {
        if (!(v instanceof String)) return dflt;
        String s = ((String) v).trim().toLowerCase(Locale.ROOT);
        if (!s.matches("#[0-9a-f]{6}")) return dflt;
        return 0xFF000000 | Integer.parseInt(s.substring(1), 16);
    }

    static String clean(String s, int max) {
        String t = s.replaceAll("[\\u0000-\\u001f\\u007f<>]", "").trim();
        return t.length() > max ? t.substring(0, max) : t;
    }

    /** What a rendered preview depends on (part of its cache key). */
    String signature() {
        return zoom + "|" + width + "x" + height + "|" + Integer.toHexString(pinColor) + "|" + Integer.toHexString(accent) + "|" + label + showCoords + grayscale + "|" + attribution + "|" + tiles + subdomains;
    }

    /* ------------------------------------------------------------ loading */

    public interface Listener { void onMapPolicy(); }

    private static final CopyOnWriteArrayList<Listener> listeners = new CopyOnWriteArrayList<>();
    private static volatile MapPolicy current;
    private static volatile String currentFor = "";
    private static volatile long nextAsk;
    private static volatile boolean asking;
    /** Tiles did not come (no network, the server is down): the pin until then. */
    private static volatile long unreachableUntil;

    public static void addListener(Listener l) { if (!listeners.contains(l)) listeners.add(l); }
    public static void removeListener(Listener l) { listeners.remove(l); }

    /**
     * The policy to draw with, or null: not known yet (asked now), switched
     * off, or the server cannot be reached — the caller shows the pin then.
     */
    public static MapPolicy usable(M5 app) {
        String server = app.config.server();
        if (server.isEmpty()) return null;
        MapPolicy p = currentFor.equals(server) ? current : null;
        long now = System.currentTimeMillis();
        if (now >= nextAsk || p == null && !currentFor.equals(server)) ask(app, server);
        if (p == null || !p.enabled || now < unreachableUntil) return null;
        return p;
    }

    private static synchronized void ask(M5 app, String server) {
        if (asking) return;
        asking = true;
        nextAsk = System.currentTimeMillis() + 60_000;
        Io.bg(() -> {
            MapPolicy got = null;
            try {
                JSONObject o = new JSONObject(new String(Http.get(server + "/api/client-config", 256 * 1024), "UTF-8"));
                got = parse(o.optJSONObject("config") != null ? o.optJSONObject("config") : o);
            } catch (Exception e) {
                Log.w("map", "no map policy: " + e.getMessage());
            }
            boolean changed;
            synchronized (MapPolicy.class) {
                asking = false;
                changed = got != null && (current == null || !currentFor.equals(server) || !got.signature().equals(current.signature()) || got.enabled != current.enabled);
                if (got != null) { current = got; currentFor = server; nextAsk = System.currentTimeMillis() + 600_000; }
            }
            if (changed) emit();
        });
    }

    /** Tiles failed for want of the network or the server: the pin for a minute, then previews try again. */
    static void unreachable() {
        boolean was = System.currentTimeMillis() < unreachableUntil;
        unreachableUntil = System.currentTimeMillis() + 60_000;
        if (!was) { emit(); Io.mainLater(MapPolicy::emit, 61_000); }
    }

    /** A tile answered "map-off": the operator switched previews off since the policy came; asked again at once. */
    static void switchedOff(M5 app) {
        synchronized (MapPolicy.class) {
            try { if (current != null) current = new MapPolicy(new JSONObject().put("enabled", false)); } catch (org.json.JSONException ignored) { }
            nextAsk = 0;
        }
        usable(app);
        emit();
    }

    static void emit() { Io.main(() -> { for (Listener l : listeners) l.onMapPolicy(); }); }
}
