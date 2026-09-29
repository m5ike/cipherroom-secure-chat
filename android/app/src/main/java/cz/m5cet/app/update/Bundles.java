package cz.m5cet.app.update;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.nio.file.Files;
import java.security.GeneralSecurityException;
import java.security.PublicKey;
import java.util.Iterator;
import java.util.Map;

import cz.m5cet.app.BuildConfig;
import cz.m5cet.app.M5;
import cz.m5cet.app.core.Events;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.design.Design;
import cz.m5cet.app.security.Crypto;
import cz.m5cet.app.security.Ec;
import cz.m5cet.app.security.Vault;

/**
 * Framework bundles on the device (docs/android-architecture.md §5):
 *
 *   available → download → verify (pinned server key) → unwrap (device key)
 *   → decrypt → check (hashes, manifest, format, app version, screens parse)
 *   → staged (kept encrypted with the system key) → trial on the next start
 *   → good after 20 s without a crash, or back to the last good one.
 *
 * Every step is logged and reported as an event.
 */
public final class Bundles {
    public static final long TRIAL_MS = 20_000;
    private static final int KEEP = 3;

    public interface Listener { void onBundle(String state, String id, double progress); }

    private final M5 app;
    private volatile Listener listener;
    private volatile String activeId = "";

    public Bundles(M5 app) { this.app = app; }

    public void setListener(Listener l) { listener = l; }

    private void tell(String state, String id, double progress) {
        Listener l = listener;
        if (l != null) Io.main(() -> l.onBundle(state, id, progress));
    }

    private File dir() { return new File(app.vault.dir(), "bundles"); }
    private File file(String id) { return new File(dir(), id.replaceAll("[^A-Za-z0-9_]", "") + ".bin"); }

    public synchronized JSONObject state() {
        JSONObject s = app.vault.json(Vault.Tier.SYS, "bundles");
        try {
            if (!s.has("items")) s.put("items", new JSONObject());
            if (!s.has("good")) s.put("good", new JSONArray());
        } catch (JSONException ignored) { }
        return s;
    }

    private synchronized void save(JSONObject s) { app.vault.putJson(Vault.Tier.SYS, "bundles", s); }

    public String activeId() { return activeId; }

    /* ---------------------------------------------------------- loading */

    /**
     * The design to use now. A staged bundle becomes the trial; a trial that
     * crashed is dropped; anything unreadable falls back to the last good or
     * the built-in design.
     */
    public synchronized Design loadActive() {
        JSONObject s = state();
        try {
            String trial = s.optString("trial", "");
            if (!trial.isEmpty() && s.optBoolean("trialCrashed", false)) {
                rollback(s, trial, "the app crashed with it");
                s = state();
            }
            String staged = s.optString("staged", "");
            if (!staged.isEmpty()) {
                s.put("trial", staged).put("trialSince", System.currentTimeMillis()).put("trialCrashed", false).put("staged", "");
                save(s);
                Log.i("bundle", "starting " + staged + " on trial");
                Io.later(this::confirmTrial, TRIAL_MS);
            }
            String candidate = s.optString("trial", "");
            if (candidate.isEmpty()) candidate = s.optString("active", "");
            while (!candidate.isEmpty()) {
                try {
                    Design d = open(candidate);
                    activeId = candidate;
                    return d;
                } catch (Exception e) {
                    Log.e("bundle", "bundle " + candidate + " cannot be used", e);
                    rollback(state(), candidate, e.getMessage());
                    JSONObject now = state();
                    candidate = now.optString("active", "");
                }
            }
        } catch (JSONException e) {
            Log.e("bundle", "bundle state broken", e);
        }
        activeId = "";
        return Design.builtIn(app);
    }

    private Design open(String id) throws GeneralSecurityException, JSONException, java.io.IOException {
        byte[] content = app.vault.open(Vault.Tier.SYS, "bundle-" + id, Files.readAllBytes(file(id).toPath()));
        Map<String, byte[]> files = BundleFile.unpack(content);
        JSONObject manifest = new JSONObject(new String(files.get("manifest.json"), java.nio.charset.StandardCharsets.UTF_8));
        if (manifest.optInt("minAppCode") > BuildConfig.VERSION_CODE) throw new JSONException("the bundle needs a newer app");
        return Design.fromFiles(id, manifest.optString("version"), files);
    }

    /** A crash while a trial runs: the next start rolls it back. */
    public void onCrash(Throwable e) {
        JSONObject s = state();
        if (!s.optString("trial", "").isEmpty()) {
            try { s.put("trialCrashed", true); } catch (JSONException ignored) { }
            save(s);
        }
    }

    /** A screen of the trial bundle could not be drawn. */
    public void onRenderFailure(String screen, Throwable e) {
        JSONObject s = state();
        String trial = s.optString("trial", "");
        if (trial.isEmpty() || !trial.equals(activeId)) return;
        Log.e("bundle", "screen " + screen + " failed with the trial bundle", e);
        rollback(s, trial, "screen " + screen + ": " + e.getMessage());
        app.reloadDesign();
    }

    private synchronized void confirmTrial() {
        JSONObject s = state();
        String trial = s.optString("trial", "");
        if (trial.isEmpty() || s.optBoolean("trialCrashed", false)) return;
        try {
            s.put("active", trial).put("trial", "");
            JSONArray good = s.getJSONArray("good");
            JSONArray next = new JSONArray().put(trial);
            for (int i = 0; i < good.length() && next.length() < KEEP; i++) if (!trial.equals(good.optString(i))) next.put(good.optString(i));
            s.put("good", next);
            item(s, trial).put("state", "good").put("at", System.currentTimeMillis());
            save(s);
            prune(s);
            JSONObject it = item(s, trial);
            Log.i("bundle", trial + " is good");
            app.events.add("bundle-installed", Events.detail("id", trial, "version", it.optString("version"), "number", it.optInt("number")));
            tell("installed", trial, 1);
        } catch (JSONException e) {
            Log.e("bundle", "cannot confirm the trial", e);
        }
    }

    private void rollback(JSONObject s, String id, String why) {
        try {
            item(s, id).put("state", "failed").put("error", why == null ? "" : why).put("at", System.currentTimeMillis());
            s.put("trial", "").put("trialCrashed", false);
            if (id.equals(s.optString("active"))) {
                JSONArray good = s.getJSONArray("good");
                String previous = "";
                for (int i = 0; i < good.length(); i++) if (!id.equals(good.optString(i))) { previous = good.optString(i); break; }
                s.put("active", previous);
            }
            save(s);
            Log.w("bundle", "rolled back " + id + ": " + why);
            app.events.add("bundle-rollback", Events.detail("id", id, "error", why == null ? "" : why, "now", s.optString("active")));
            tell("rolled-back", id, 0);
        } catch (JSONException e) {
            Log.e("bundle", "cannot roll back", e);
        }
    }

    private static JSONObject item(JSONObject s, String id) throws JSONException {
        JSONObject items = s.getJSONObject("items");
        JSONObject it = items.optJSONObject(id);
        if (it == null) { it = new JSONObject(); items.put(id, it); }
        return it;
    }

    private void prune(JSONObject s) {
        JSONArray good = s.optJSONArray("good");
        java.util.Set<String> keep = new java.util.HashSet<>();
        if (good != null) for (int i = 0; i < good.length(); i++) keep.add(good.optString(i));
        keep.add(s.optString("active"));
        keep.add(s.optString("trial"));
        keep.add(s.optString("staged"));
        File[] files = dir().listFiles();
        if (files != null) for (File f : files) {
            String id = f.getName().replace(".bin", "");
            if (!keep.contains(id)) //noinspection ResultOfMethodCallIgnored
                f.delete();
        }
    }

    /* ---------------------------------------------------------- updating */

    /** What the check-in said is available. Downloads it when the policy says so. */
    public void available(JSONObject info) {
        if (info == null) return;
        String id = info.optString("id");
        JSONObject s = state();
        JSONObject it = s.optJSONObject("items") == null ? null : s.optJSONObject("items").optJSONObject(id);
        if (id.isEmpty() || id.equals(activeId) || id.equals(s.optString("staged")) || id.equals(s.optString("trial"))) return;
        if (it != null && "failed".equals(it.optString("state"))) return;
        if (info.optInt("minAppCode") > BuildConfig.VERSION_CODE) return;
        JSONObject update = app.config.policy().optJSONObject("update");
        boolean auto = update == null || update.optBoolean("autoDownload", true);
        boolean wifiOnly = update != null && update.optBoolean("wifiOnly", false);
        app.events.add("update-available", Events.detail("kind", "bundle", "id", id, "version", info.optString("version")));
        if (auto && (!wifiOnly || app.releases.onUnmeteredNetwork())) Io.bg(() -> download(info));
        else tell("available", id, 0);
    }

    public synchronized boolean download(JSONObject info) {
        String id = info.optString("id");
        tell("downloading", id, 0);
        try {
            byte[] raw = app.server.bundle(id, (done, total) -> tell("downloading", id, total > 0 ? (double) done / total : 0));
            BundleFile bundle = BundleFile.parse(raw);
            if (!id.equals(bundle.id())) throw new GeneralSecurityException("the server sent another bundle");
            PublicKey serverKey = Ec.publicFromSpki(app.config.serverKey());
            if (!bundle.kid().equals(app.config.serverKid()) || !bundle.verify(serverKey)) throw new GeneralSecurityException("the bundle's signature is not the server's");
            if (bundle.minAppCode() > BuildConfig.VERSION_CODE) throw new GeneralSecurityException("the bundle needs a newer app");
            byte[] cek = bundle.unwrapKey(app.config.encPrivateKey(), app.config.deviceId());
            byte[] content;
            try { content = bundle.decrypt(cek); } finally { Crypto.wipe(cek); }
            Map<String, byte[]> files = BundleFile.unpack(content);
            Design.fromFiles(id, bundle.version(), files); // everything must parse before it is kept
            java.io.File f = file(id);
            //noinspection ResultOfMethodCallIgnored
            f.getParentFile().mkdirs();
            Files.write(f.toPath(), app.vault.seal(Vault.Tier.SYS, "bundle-" + id, content));
            JSONObject s = state();
            item(s, id).put("state", "staged").put("version", bundle.version()).put("number", bundle.number()).put("at", System.currentTimeMillis());
            s.put("staged", id);
            save(s);
            Log.i("bundle", "staged " + id + " (" + bundle.version() + ")");
            tell("ready", id, 1);
            return true;
        } catch (Exception e) {
            Log.e("bundle", "bundle " + id + " refused", e);
            JSONObject s = state();
            try { item(s, id).put("state", "failed").put("error", String.valueOf(e.getMessage())).put("at", System.currentTimeMillis()); save(s); } catch (JSONException ignored) { }
            app.events.add("bundle-failed", Events.detail("id", id, "error", String.valueOf(e.getMessage())));
            tell("failed", id, 0);
            return false;
        }
    }

    /** "Install": the staged bundle becomes the trial right away. */
    public void installNow() {
        app.reloadDesign();
    }

    public JSONObject report() {
        JSONObject s = state();
        try {
            JSONObject it = s.optJSONObject("items") == null ? null : s.optJSONObject("items").optJSONObject(activeId);
            return new JSONObject().put("id", activeId).put("version", it == null ? "built-in" : it.optString("version")).put("state", !s.optString("trial").isEmpty() ? "trial" : activeId.isEmpty() ? "built-in" : "good");
        } catch (JSONException e) { return new JSONObject(); }
    }

    public java.util.List<JSONObject> history() {
        java.util.List<JSONObject> out = new java.util.ArrayList<>();
        JSONObject items = state().optJSONObject("items");
        if (items != null) for (Iterator<String> it = items.keys(); it.hasNext(); ) {
            String id = it.next();
            try { out.add(new JSONObject(items.getJSONObject(id).toString()).put("id", id)); } catch (JSONException ignored) { }
        }
        return out;
    }
}
