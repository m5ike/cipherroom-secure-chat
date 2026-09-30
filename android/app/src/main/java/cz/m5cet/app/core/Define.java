package cz.m5cet.app.core;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.nio.charset.StandardCharsets;

import cz.m5cet.app.M5;
import cz.m5cet.app.net.Server;
import cz.m5cet.app.security.Vault;

/**
 * The operator's typed definitions (6.3 define) as the app sees them:
 * m5mobile.define.&lt;name&gt;, the very values the web app and the Functions
 * get. The server materialises them for us — GET /api/define?scope=android
 * answers { ok, values, updatedAt } where "values" is already name → plain
 * typed value (string / number / boolean; a hex string for bytes; nested
 * objects and arrays; a script as { "__m5script": true, code, lang }). So
 * there is no node tree to walk here: we fetch "values", keep it, and expose
 * it. It is cached in the vault's system tier (record "define"), readable
 * while the app is locked exactly like {@link Config}, and refreshed at
 * check-in; a failed fetch keeps the last cached copy.
 *
 * A script value is returned as its {@code {__m5script}} object and never run.
 */
public final class Define {
    /** Fetches the raw server answer { ok, values, updatedAt }; testable without HTTP. */
    interface Fetcher { JSONObject fetch() throws Exception; }

    private final M5 app;          // null in unit tests (no vault, no persistence)
    private final Fetcher fetcher;
    private JSONObject values;     // materialised name → value; never null
    private long updatedAt;

    /** The app-wide instance: HTTP fetch + vault cache. */
    public Define(M5 app) {
        this.app = app;
        this.fetcher = () -> httpFetch(app);
        load();
    }

    /** Test seam: no vault, an injectable fetcher (may be null). */
    Define(Fetcher fetcher) {
        this.app = null;
        this.fetcher = fetcher;
        this.values = new JSONObject();
    }

    /* ----------------------------------------------------------- reading */

    /** All defines as one object (name → materialised value). Read-only. */
    public synchronized JSONObject all() { return values; }

    /** When the cached values were last materialised by the server (0 = never). */
    public synchronized long updatedAt() { return updatedAt; }

    /** A define's value, or null when there is none. A script comes back as its object. */
    public synchronized Object get(String name) {
        Object v = values.opt(name);
        return v == JSONObject.NULL ? null : v;
    }

    public synchronized String str(String name) { return values.optString(name, ""); }

    public synchronized double num(String name) { return values.optDouble(name, 0); }

    public synchronized boolean bool(String name) { return values.optBoolean(name, false); }

    /** A nested object define (or null); a script value is such an object. */
    public synchronized JSONObject obj(String name) { return values.optJSONObject(name); }

    /** A nested array define (or null) — e.g. the EMV template list. */
    public synchronized JSONArray arr(String name) { return values.optJSONArray(name); }

    /* -------------------------------------------------------- refreshing */

    /**
     * Fetches the newest values and caches them; on any failure the cached
     * copy stays (offline / not enrolled). True when usable values were kept.
     */
    public synchronized boolean refresh() {
        if (fetcher == null) return false;
        try {
            if (apply(fetcher.fetch())) { save(); return true; }
            return false;
        } catch (Exception e) {
            Log.d("define", "not now: " + e.getMessage());
            return false; // the cached values remain in force
        }
    }

    /**
     * Adopts a server answer { ok, values, updatedAt }. True when it carried
     * usable values (the cache is then replaced); an absent/!ok/empty answer
     * is ignored and the current values stay. Pure — no HTTP, no vault.
     */
    synchronized boolean apply(JSONObject answer) {
        if (answer == null || !answer.optBoolean("ok", false)) return false;
        JSONObject v = answer.optJSONObject("values");
        if (v == null) return false;
        this.values = v;
        this.updatedAt = answer.optLong("updatedAt", updatedAt);
        return true;
    }

    /* ------------------------------------------------------------- cache */

    private void load() {
        JSONObject doc = app.vault.json(Vault.Tier.SYS, "define");
        JSONObject v = doc.optJSONObject("values");
        this.values = v != null ? v : new JSONObject();
        this.updatedAt = doc.optLong("updatedAt", 0);
    }

    private void save() {
        if (app == null) return; // test seam: nothing to persist to
        try {
            JSONObject doc = new JSONObject().put("values", values).put("updatedAt", updatedAt);
            app.vault.putJson(Vault.Tier.SYS, "define", doc);
        } catch (JSONException ignored) { }
    }

    private static JSONObject httpFetch(M5 app) throws IOException {
        String base = app.config.server(); // already normalised, like Server.turn()
        if (base == null || base.isEmpty()) throw new IOException("no server");
        byte[] raw = Server.send(base + "/api/define?scope=android", "GET", null, null, null, 1 << 20);
        try { return new JSONObject(new String(raw, StandardCharsets.UTF_8)); }
        catch (JSONException e) { throw new IOException("not a JSON answer", e); }
    }
}
