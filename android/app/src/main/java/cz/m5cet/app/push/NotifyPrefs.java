package cz.m5cet.app.push;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

import cz.m5cet.app.M5;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.core.Settings;
import cz.m5cet.app.net.Server;
import cz.m5cet.app.security.Crypto;
import cz.m5cet.app.security.Vault;
import cz.m5cet.app.ui.MainActivity;

/**
 * The user's notification settings on Android (6.7): which kinds, how much a
 * notification shows (within what the operator allows), the order of the
 * channels the server tries, quiet hours — kept as settings ("notify.*",
 * Settings › Notifications, a screen of the design) and, signed in, sent to
 * the server so it knows how to notify (PUT /api/account/notify).
 *
 * Signed in, this device also asks to be woken for the account (a request
 * signed with its key that carries the account's session: POST
 * /api/android/notify) and joins its rooms as "away-capable" — when the app
 * is closed the server keeps messages for it and wakes it through FCM, the
 * notification sealed for this device. Signed out, the link goes.
 *
 * The operator's templates (GET /api/notify/config) are kept in the vault's
 * system tier, so a notification can be drawn while the app is locked.
 */
public final class NotifyPrefs implements Settings.Listener {
    private static volatile NotifyPrefs instance;

    public static final String[] KINDS = { "message", "mention", "call", "function", "summon" };

    /** The settings' keys and defaults (Settings.DEFAULTS). */
    public static void defaults(Map<String, Object> d) {
        d.put("notify.on", true);                         // notifications at all
        d.put("notify.away", true);                       // signed in: the server keeps messages while the app is closed, and wakes it
        for (String k : KINDS) d.put("notify." + k, true); // each kind
        d.put("notify.privacy", "");                      // "" (the server's default) | neutral | sender | room | content
        d.put("notify.order", "android,webpush,email");   // the channels in the order the server tries them
        d.put("notify.quiet", false);                     // quiet hours
        d.put("notify.quietFrom", "22:00");
        d.put("notify.quietTo", "07:00");
        d.put("notify.lockScreenHide", false);            // 6.12 (G-22): message notifications not on the phone's lock screen at all (VISIBILITY_SECRET)
    }

    public static NotifyPrefs get(M5 app) {
        NotifyPrefs p = instance;
        if (p == null) synchronized (NotifyPrefs.class) {
            if (instance == null) { instance = new NotifyPrefs(app); app.settings.addListener(instance); }
            p = instance;
        }
        return p;
    }

    private final M5 app;
    private volatile ScheduledFuture<?> pending;
    private volatile String linkedToken = "";
    private volatile String status = "";
    private volatile boolean busy = false;

    private NotifyPrefs(M5 app) { this.app = app; }

    /* ------------------------------------------------------------- reading */

    public boolean on() { return app.settings.bool("notify.on"); }

    /** Join the rooms so that the server covers for this device while the app is closed. */
    public boolean awayWanted() { return app.account.signedIn() && on() && app.settings.bool("notify.away"); }

    /** Whether a notification of `kind` may show now (the user's switches and quiet hours; a test always). */
    public boolean allows(String kind, long at) {
        if (kind.equals("test")) return true;
        if (!on() || !app.settings.bool("notify." + kind)) return false;
        return !NotifyTemplate.inQuietHours(app.settings.bool("notify.quiet"), app.settings.str("notify.quietFrom"), app.settings.str("notify.quietTo"), "", at);
    }

    /** The operator's templates, as last fetched (empty before the first fetch). */
    public JSONObject policy() { return app.vault.json(Vault.Tier.SYS, "notify-policy"); }

    /** One kind's template ({title:{cs,en,de}, body:{…}, privacy, maxPrivacy, accent, sound…}), or null. */
    public JSONObject template(String kind) {
        JSONObject t = policy().optJSONObject("templates");
        return t == null ? null : t.optJSONObject(kind);
    }

    /**
     * The level a notification the app draws itself is shown at. The app
     * decrypted the message, so until the user picks a level it shows what it
     * always did (the content, within the operator's maximum); a locked app
     * never shows content.
     */
    public String localPrivacy(String kind, boolean locked) {
        JSONObject t = template(kind);
        String max = t == null ? "content" : t.optString("maxPrivacy", "content");
        String chosen = app.settings.str("notify.privacy");
        String level = NotifyTemplate.min(chosen.isEmpty() ? "content" : chosen, max);
        return locked ? NotifyTemplate.min(level, "room") : level;
    }

    /* ----------------------------------------------------------- the screen */

    /** $notify for Settings › Notifications. */
    public JSONObject scope() {
        JSONObject s = new JSONObject();
        try {
            s.put("signedIn", app.account.signedIn()).put("linked", !linkedToken.isEmpty()).put("busy", busy).put("status", status)
                .put("push", app.push.enabled()).put("serverOff", policy().has("enabled") && !policy().optBoolean("enabled", true));
            JSONArray rows = new JSONArray();
            List<String> used = NotifyTemplate.order(app.settings.str("notify.order"));
            int i = 0;
            for (String c : used) rows.put(new JSONObject().put("id", c).put("used", true).put("n", (double) ++i).put("first", i == 1).put("last", i == used.size()).put("label", app.t("notify.channel." + c)));
            for (String c : NotifyTemplate.CHANNELS) if (!used.contains(c)) rows.put(new JSONObject().put("id", c).put("used", false).put("n", 0.0).put("first", true).put("last", true).put("label", app.t("notify.channel." + c)));
            s.put("channels", rows);
            JSONArray hours = new JSONArray();
            for (int h = 0; h < 48; h++) { String v = String.format(java.util.Locale.ROOT, "%02d:%s", h / 2, h % 2 == 0 ? "00" : "30"); hours.put(new JSONObject().put("value", v).put("label", v)); }
            s.put("hours", hours);
        } catch (JSONException ignored) { }
        return s;
    }

    /** notify.up / notify.down / notify.use / notify.drop / notify.test / notify.sync — from the design's screen. */
    public void run(MainActivity a, String action, String arg) {
        String order = app.settings.str("notify.order");
        switch (action) {
            case "notify.up": app.settings.set("notify.order", NotifyTemplate.move(order, arg, -1)); a.refresh(); break;
            case "notify.down": app.settings.set("notify.order", NotifyTemplate.move(order, arg, 1)); a.refresh(); break;
            case "notify.use": app.settings.set("notify.order", NotifyTemplate.use(order, arg, true)); a.refresh(); break;
            case "notify.drop": app.settings.set("notify.order", NotifyTemplate.use(order, arg, false)); a.refresh(); break;
            case "notify.test": test(a); break;
            case "notify.sync": Io.bg(() -> { sync(); Io.main(a::refresh); }); break;
            default: Log.w("notify", "unknown action " + action);
        }
    }

    /* ------------------------------------------------------------ the server */

    @Override
    public void onSetting(String key, Object value) {
        if (!key.startsWith("notify.")) return;
        // A few changes in a row (a reorder, two switches) go as one.
        ScheduledFuture<?> p = pending;
        if (p != null) p.cancel(false);
        pending = Io.TIMER.schedule(() -> Io.bg(this::sync), 1500, TimeUnit.MILLISECONDS);
        if (key.equals("notify.away") || key.equals("notify.on")) app.rooms.onAccountChanged(); // the rooms say away-capable or not
    }

    /** The settings as the server keeps them (client/src/lib/notify-template.ts UserNotifyPrefs). */
    JSONObject asServerPrefs() throws JSONException {
        JSONObject kinds = new JSONObject();
        for (String k : KINDS) kinds.put(k, app.settings.bool("notify." + k));
        return new JSONObject().put("on", on()).put("kinds", kinds).put("privacy", app.settings.str("notify.privacy"))
            .put("order", new JSONArray(NotifyTemplate.order(app.settings.str("notify.order"))))
            .put("quiet", new JSONObject().put("on", app.settings.bool("notify.quiet")).put("from", app.settings.str("notify.quietFrom")).put("to", app.settings.str("notify.quietTo")).put("tz", java.util.TimeZone.getDefault().getID()))
            .put("lang", app.lang());
    }

    private JSONObject bearer() throws JSONException {
        return new JSONObject().put("Authorization", app.account.bearer());
    }

    /** The operator's templates (public), kept for drawing notifications while locked. */
    public void fetchPolicy() {
        try {
            byte[] b = Server.send(app.config.server() + "/api/notify/config", "GET", null, null, null, 512 * 1024);
            JSONObject p = new JSONObject(Crypto.str(b));
            app.vault.putJson(Vault.Tier.SYS, "notify-policy", p);
        } catch (Exception e) {
            Log.w("notify", "the server's templates: " + e.getMessage());
        }
    }

    /** Sends the settings (signed in) and links or unlinks this device. Background thread. */
    public synchronized void sync() {
        fetchPolicy();
        // 6.12 (F-16): a locked app has no account session in memory — that is not a sign-out (the link stays).
        if (!app.vault.unlocked()) return;
        if (!app.account.signedIn()) { link(false); return; }
        try {
            Server.send(app.config.server() + "/api/account/notify", "PUT", Crypto.utf8(asServerPrefs().toString()), bearer(), null, 256 * 1024);
            status = "";
        } catch (Exception e) {
            status = e.getMessage() == null ? "?" : e.getMessage();
            Log.w("notify", "settings not saved on the server: " + status);
        }
        link(on() && app.settings.bool("notify.away"));
    }

    /** The device and the account's session together: wake this device for the account (or no longer). */
    void link(boolean on) {
        String token = app.account.token();
        if (on && (token.isEmpty() || token.equals(linkedToken))) return;
        if (!on && linkedToken.isEmpty() && token.isEmpty()) return;
        try {
            JSONObject body = new JSONObject().put("on", on);
            if (on) body.put("token", token);
            app.server.signed("POST", "/api/android/notify", body, null, 64 * 1024);
            linkedToken = on ? token : "";
            Log.i("notify", on ? "this device wakes for the account" : "this device no longer wakes for an account");
        } catch (Exception e) {
            Log.w("notify", "device link: " + e.getMessage());
        }
    }

    /** Signed in or out (Rooms.onAccountChanged): the settings and the link follow. */
    public void onAccountChanged() {
        if (app.account.signedIn() && app.account.token().equals(linkedToken)) return; // a refresh of the same session
        Io.bg(this::sync);
    }

    /** "Send a test notification": through the server and the account's channels, with the fallback. */
    void test(MainActivity a) {
        if (!app.account.signedIn()) {
            app.notify.templated(testPayload(), true);
            a.flash("", app.t("notify.test.local"), "info");
            return;
        }
        busy = true;
        a.refresh();
        Io.bg(() -> {
            String text, level = "success";
            try {
                sync();
                byte[] b;
                try {
                    b = Server.send(app.config.server() + "/api/account/notify/test", "POST", Crypto.utf8("{}"), bearer(), null, 256 * 1024);
                } catch (Server.HttpError e) {
                    if (e.body == null) throw e;
                    b = Crypto.utf8(e.body.toString());
                }
                JSONObject r = new JSONObject(Crypto.str(b));
                if (r.optBoolean("ok")) text = app.t("notify.test.ok").replace("{channel}", app.t("notify.channel." + r.optString("channel")));
                else if (!r.optString("skipped").isEmpty() && !r.isNull("skipped")) { text = app.t("notify.test.skipped").replace("{reason}", r.optString("skipped")); level = "warn"; }
                else { text = app.t("notify.test.failed"); level = "error"; }
            } catch (Exception e) {
                text = e.getMessage() == null ? "?" : e.getMessage();
                level = "error";
            }
            busy = false;
            final String t = text, l = level;
            Io.main(() -> { a.flash("", t, l); a.refresh(); });
        });
    }

    /** A local test notification (signed out: there is no server side). */
    JSONObject testPayload() {
        JSONObject t = template("test");
        JSONObject p = new JSONObject();
        try {
            String lang = app.lang();
            p.put("kind", "test").put("privacy", "neutral").put("tag", "m5-test")
                .put("vars", new JSONObject().put("app", app.design().appName()))
                .put("tpl", new JSONObject().put("title", t == null ? "{app} · test" : t.getJSONObject("title").optString(lang, "{app} · test"))
                    .put("body", t == null ? app.t("notify.test.local") : t.getJSONObject("body").optString(lang, "")))
                .put("title", app.design().appName()).put("body", app.t("notify.test.local")).put("sound", true).put("vibrate", true);
        } catch (JSONException ignored) { }
        return p;
    }
}
