package cz.m5cet.app.location;

import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Where a position can go (6.7): navigation and ride-hailing apps — ONE
 * table. The web keeps the same in client/src/lib/geo-links.ts (same order,
 * the same web links): when a format changes, fix it in both.
 *
 * Pure Java (no Android): which apps are installed comes in from the
 * PackageManager (ui/parts/PlaceSheet), the choices go out. Nothing is
 * opened here; a link leaves the phone only when the user taps it.
 *
 * Formats (checked 2026-10): Google Maps google.navigation:q=lat,lng; Waze
 * waze://?ll=lat,lng&navigate=yes; Mapy.com https://mapy.com/fnc/v1/route
 * (lon first!); OsmAnd osmand.api://navigate; Sygic
 * com.sygic.aura://coordinate|lon|lat|drive; HERE WeGo
 * https://share.here.com/r/mylocation/lat,lng,name?m=d; Uber
 * uber://?action=setPickup…. Bolt, Liftago and FREENOW publish no
 * destination link: the app opens and the destination goes to the
 * clipboard (prefill false).
 */
public final class GeoLinks {
    private GeoLinks() {}

    public static final String NAV = "nav", RIDE = "ride";

    /** A link from the point (label: "" = none). */
    public interface Link { String of(double lat, double lon, String label); }

    public static final class App {
        public final String id, kind, name;
        public final List<String> packages;
        /** The destination goes along; false: the app only opens (the destination is copied for pasting). */
        public final boolean prefill;
        /** The app's own link (null: just open the app). */
        final Link app;
        /** In the browser when the app is not here (null: none). */
        final Link web;

        App(String id, String kind, String name, boolean prefill, List<String> packages, Link app, Link web) {
            this.id = id; this.kind = kind; this.name = name; this.prefill = prefill; this.packages = packages; this.app = app; this.web = web;
        }
    }

    /** One line of a picker. */
    public static final class Choice {
        public final String id, name;
        /** The app to open it in; null: the browser. */
        public final String pkg;
        /** The link; null: just open the app. */
        public final String uri;
        /** When the app refuses the link: geo: in the same app (navigation), else null. */
        public final String fallback;
        public final boolean web, prefill;

        Choice(String id, String name, String pkg, String uri, String fallback, boolean web, boolean prefill) {
            this.id = id; this.name = name; this.pkg = pkg; this.uri = uri; this.fallback = fallback; this.web = web; this.prefill = prefill;
        }

        @Override public String toString() { return id + (web ? " (web)" : " @" + pkg) + " " + uri; }
    }

    /* ------------------------------------------------------------ format */

    /** Degrees with six decimals (≈ 0.1 m), always a dot — the web's toFixed(6). */
    public static String deg(double v) { return String.format(Locale.ROOT, "%.6f", v); }

    private static String ll(double lat, double lon) { return deg(lat) + "," + deg(lon); }

    /** Like the web's encodeURIComponent (UTF-8, %20 for a space, !'()*~ as they are). */
    public static String enc(String s) {
        try {
            return URLEncoder.encode(s == null ? "" : s, "UTF-8").replace("+", "%20")
                .replace("%21", "!").replace("%27", "'").replace("%28", "(").replace("%29", ")").replace("%7E", "~");
        } catch (UnsupportedEncodingException e) {
            throw new IllegalStateException(e);
        }
    }

    /** geo:lat,lng?q=lat,lng(label) — a parenthesis in the label would end it early. */
    public static String geoUri(double lat, double lon, String label) {
        String l = label == null || label.isEmpty() ? "" : "(" + enc(label).replace("(", "%28").replace(")", "%29") + ")";
        return "geo:" + ll(lat, lon) + "?q=" + ll(lat, lon) + l;
    }

    private static List<String> pk(String... p) { return Collections.unmodifiableList(Arrays.asList(p)); }

    private static String has(String label, String prefix) { return label == null || label.isEmpty() ? "" : prefix + enc(label); }

    private static final Link MAPY = (la, lo, l) -> "https://mapy.com/fnc/v1/route?end=" + deg(lo) + "," + deg(la) + "&routeType=car_fast&navigate=true";
    private static final Link UBER_WEB = (la, lo, l) -> "https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff[latitude]=" + deg(la) + "&dropoff[longitude]=" + deg(lo) + has(l, "&dropoff[nickname]=");

    /* ------------------------------------------------------------- table */

    /** Navigation first, then rides — the order the pickers show (the web's, without Apple Maps; plus the Android-only apps). */
    public static final List<App> APPS = Collections.unmodifiableList(Arrays.asList(
        new App("google", NAV, "Google Maps", true, pk("com.google.android.apps.maps"),
            (la, lo, l) -> "google.navigation:q=" + ll(la, lo),
            (la, lo, l) -> "https://www.google.com/maps/dir/?api=1&destination=" + ll(la, lo)),
        new App("waze", NAV, "Waze", true, pk("com.waze"),
            (la, lo, l) -> "waze://?ll=" + ll(la, lo) + "&navigate=yes",
            (la, lo, l) -> "https://waze.com/ul?ll=" + ll(la, lo) + "&navigate=yes"),
        new App("mapy", NAV, "Mapy.com", true, pk("cz.seznam.mapy"), MAPY, MAPY),
        new App("osmand", NAV, "OsmAnd", true, pk("net.osmand.plus", "net.osmand"),
            (la, lo, l) -> "osmand.api://navigate?dest_lat=" + deg(la) + "&dest_lon=" + deg(lo) + has(l, "&dest_name=") + "&profile=car&force=true",
            null),
        new App("sygic", NAV, "Sygic", true, pk("com.sygic.aura"),
            (la, lo, l) -> "com.sygic.aura://coordinate|" + deg(lo) + "|" + deg(la) + "|drive",
            null),
        new App("here", NAV, "HERE WeGo", true, pk("com.here.app.maps"),
            (la, lo, l) -> "https://share.here.com/r/mylocation/" + ll(la, lo) + has(l, ",") + "?m=d",
            null),
        new App("osm", NAV, "OpenStreetMap", true, pk(),
            null,
            (la, lo, l) -> "https://www.openstreetmap.org/directions?to=" + ll(la, lo)),
        new App("uber", RIDE, "Uber", true, pk("com.ubercab"),
            (la, lo, l) -> "uber://?action=setPickup&pickup=my_location&dropoff[latitude]=" + deg(la) + "&dropoff[longitude]=" + deg(lo) + has(l, "&dropoff[nickname]="),
            UBER_WEB),
        new App("bolt", RIDE, "Bolt", false, pk("ee.mtakso.client"), null, (la, lo, l) -> "https://bolt.eu/"),
        new App("liftago", RIDE, "Liftago", false, pk("com.adleritech.app.liftago.passenger"), null, (la, lo, l) -> "https://www.liftago.cz/"),
        new App("freenow", RIDE, "FREENOW", false, pk("taxi.android.client"), null, (la, lo, l) -> "https://www.free-now.com/")
    ));

    /** Every package of the table (what the manifest's <queries> must name). */
    public static Set<String> packages() {
        Set<String> all = new HashSet<>();
        for (App a : APPS) all.addAll(a.packages);
        return all;
    }

    /** The web link of an app of the table (null: none), e.g. for a test or a share. */
    public static String web(String id, double lat, double lon, String label) {
        for (App a : APPS) if (a.id.equals(id) && a.web != null) return a.web.of(lat, lon, label == null ? "" : label);
        return null;
    }

    /** What goes to the clipboard for an app that cannot take the destination: "50.087500, 14.421300". */
    public static String destinationText(double lat, double lon) { return deg(lat) + ", " + deg(lon); }

    /**
     * The picker's lines for one kind: the table's apps that are installed
     * (their own links), then — for navigation — the other apps that open
     * geo: (geoApps: package → its name, in the system's order), then the
     * web links of the table's apps that are not installed.
     */
    public static List<Choice> choices(String kind, double lat, double lon, String label, Set<String> installed, Map<String, String> geoApps) {
        List<Choice> out = new ArrayList<>();
        if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return out;
        String l = label == null ? "" : label;
        String geo = geoUri(lat, lon, l);
        Set<String> known = new HashSet<>();
        List<App> missing = new ArrayList<>();
        for (App a : APPS) {
            if (!a.kind.equals(kind)) continue;
            known.addAll(a.packages);
            String pkg = null;
            for (String p : a.packages) if (installed.contains(p)) { pkg = p; break; }
            if (pkg != null) out.add(new Choice(a.id, a.name, pkg, a.app == null ? null : a.app.of(lat, lon, l), NAV.equals(kind) ? geo : null, false, a.prefill));
            else if (a.web != null) missing.add(a);
        }
        if (NAV.equals(kind) && geoApps != null) {
            for (Map.Entry<String, String> g : geoApps.entrySet()) {
                if (known.contains(g.getKey())) continue;
                out.add(new Choice("geo:" + g.getKey(), g.getValue(), g.getKey(), geo, null, false, true));
            }
        }
        for (App a : missing) out.add(new Choice(a.id, a.name, null, a.web.of(lat, lon, l), null, true, a.prefill));
        return out;
    }
}
