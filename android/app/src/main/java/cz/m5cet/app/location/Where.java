package cz.m5cet.app.location;

import android.Manifest;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.CancellationSignal;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import cz.m5cet.app.M5;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;

/**
 * Where the phone is (6.1), with the platform's location service (no Google
 * libraries):
 *  - current(): one fix for a message — "location.inHeader" puts it into
 *    every message's header, "location.share" sends it as a message;
 *  - tracking: with "location.track" (and the operator's policy allowing
 *    it) positions go to the server every location.interval seconds, in
 *    batches, for the device's track in the console. A foreground service
 *    (LocationService) keeps it running in the background.
 */
public final class Where {
    public interface Fix { void on(Location l); }

    private final M5 app;
    private volatile Location last;
    private final List<JSONObject> queue = new ArrayList<>();
    private LocationListener tracker;
    private long lastSent = 0;

    public Where(M5 app) { this.app = app; }

    public boolean permitted() {
        return app.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || app.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private LocationManager lm() { return app.getSystemService(LocationManager.class); }

    private String provider() {
        LocationManager lm = lm();
        if (Build.VERSION.SDK_INT >= 31 && lm.hasProvider(LocationManager.FUSED_PROVIDER) && lm.isProviderEnabled(LocationManager.FUSED_PROVIDER)) return LocationManager.FUSED_PROVIDER;
        boolean fine = app.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        if (fine && app.settings.bool("location.precise") && lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) return LocationManager.GPS_PROVIDER;
        return lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER) ? LocationManager.NETWORK_PROVIDER : LocationManager.PASSIVE_PROVIDER;
    }

    /** The last fix, when it is fresh enough for a message header (2 minutes). */
    public Location recent() {
        Location l = last;
        return l != null && System.currentTimeMillis() - l.getTime() < 120_000 ? l : null;
    }

    /** One fix (the recent one, or a new one — at most 20 s); null when there is none. */
    @SuppressWarnings("MissingPermission")
    public void current(Fix fix) {
        if (!permitted()) { Io.main(() -> fix.on(null)); return; }
        Location r = recent();
        if (r != null) { Io.main(() -> fix.on(r)); return; }
        try {
            CancellationSignal cancel = new CancellationSignal();
            Io.mainLater(cancel::cancel, 20_000);
            lm().getCurrentLocation(provider(), cancel, app.getMainExecutor(), l -> {
                if (l != null) last = l;
                fix.on(l != null ? l : lastKnown());
            });
        } catch (RuntimeException e) {
            Log.w("where", "no fix: " + e.getMessage());
            Io.main(() -> fix.on(lastKnown()));
        }
    }

    @SuppressWarnings("MissingPermission")
    private Location lastKnown() {
        try {
            Location best = null;
            for (String p : lm().getProviders(true)) {
                Location l = lm().getLastKnownLocation(p);
                if (l != null && (best == null || l.getTime() > best.getTime())) best = l;
            }
            return best;
        } catch (RuntimeException e) { return null; }
    }

    /** The position as a message carries it (the header's "loc" and a location message). */
    public static JSONObject json(Location l) {
        JSONObject o = new JSONObject();
        try {
            o.put("lat", round(l.getLatitude())).put("lon", round(l.getLongitude())).put("acc", Math.round(l.getAccuracy())).put("at", l.getTime());
            if (l.hasAltitude()) o.put("alt", Math.round(l.getAltitude()));
        } catch (JSONException ignored) { }
        return o;
    }

    static double round(double v) { return Math.round(v * 1e6) / 1e6; }

    /** An https link that opens the pin on a map (OpenStreetMap). */
    public static String mapUrl(double lat, double lon) {
        return String.format(Locale.ROOT, "https://www.openstreetmap.org/?mlat=%.6f&mlon=%.6f#map=17/%.6f/%.6f", lat, lon, lat, lon);
    }

    /** The web's link for a shared position (maps.ts osmLink, zoom 15) — the same text on both sides. */
    public static String mapUrlWeb(double lat, double lon) {
        return String.format(Locale.ROOT, "https://www.openstreetmap.org/?mlat=%.6f&mlon=%.6f#map=15/%.6f/%.6f", lat, lon, lat, lon);
    }

    /** A geo: intent URI (the phone's map app) with a pin and a label. */
    public static String geoUri(double lat, double lon, String label) {
        return String.format(Locale.ROOT, "geo:%.6f,%.6f?q=%.6f,%.6f(%s)", lat, lon, lat, lon, android.net.Uri.encode(label == null ? "" : label));
    }

    /* ---------------------------------------------------------- tracking */

    /** The user's setting, and the operator's policy (tracking allowed; true when it says nothing). */
    public boolean trackingWanted() {
        JSONObject pol = app.config.policy().optJSONObject("location");
        return app.settings.bool("location.track") && (pol == null || pol.optBoolean("track", true));
    }

    public boolean tracking() { return tracker != null; }

    /** Starts the updates (on the main looper); LocationService calls it. */
    @SuppressWarnings("MissingPermission")
    public synchronized void startTracking() {
        if (tracker != null || !permitted()) return;
        long every = Math.max(15, (long) app.settings.num("location.interval")) * 1000;
        JSONObject pol = app.config.policy().optJSONObject("location");
        if (pol != null) every = Math.max(every, pol.optLong("minSeconds", 15) * 1000);
        tracker = new LocationListener() {
            @Override public void onLocationChanged(Location l) { last = l; queue(l); }
            @Override public void onProviderDisabled(String p) { }
            @Override public void onProviderEnabled(String p) { }
        };
        try {
            lm().requestLocationUpdates(provider(), every, 10f, tracker, Looper.getMainLooper());
            Log.i("where", "tracking every " + every / 1000 + " s");
        } catch (RuntimeException e) {
            Log.w("where", "tracking failed: " + e.getMessage());
            tracker = null;
        }
    }

    public synchronized void stopTracking() {
        if (tracker == null) return;
        try { lm().removeUpdates(tracker); } catch (RuntimeException ignored) { }
        tracker = null;
        flush();
    }

    private void queue(Location l) {
        JSONObject p = json(l);
        try {
            if (l.hasSpeed()) p.put("speed", Math.round(l.getSpeed() * 10) / 10.0);
            if (l.hasBearing()) p.put("heading", Math.round(l.getBearing()));
        } catch (JSONException ignored) { }
        synchronized (queue) {
            queue.add(p);
            while (queue.size() > 2000) queue.remove(0);
        }
        if (System.currentTimeMillis() - lastSent > 60_000 || queue.size() >= 20) flush();
    }

    /** Sends the waiting points (a signed request); they stay queued when the server is not reachable. */
    public void flush() {
        List<JSONObject> batch;
        synchronized (queue) {
            if (queue.isEmpty()) return;
            batch = new ArrayList<>(queue.subList(0, Math.min(100, queue.size())));
        }
        lastSent = System.currentTimeMillis();
        Io.bg(() -> {
            try {
                JSONArray points = new JSONArray();
                for (JSONObject p : batch) points.put(p);
                app.server.signed("POST", "/api/android/location", new JSONObject().put("points", points), null, 64 * 1024);
                synchronized (queue) { queue.removeAll(batch); }
            } catch (Exception e) {
                String m = String.valueOf(e.getMessage());
                if (m.contains("location-off") || m.contains("403")) { synchronized (queue) { queue.clear(); } Log.i("where", "the server does not keep positions"); }
                else Log.w("where", "points not sent: " + m);
            }
        });
    }
}
