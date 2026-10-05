package cz.m5cet.app.profile;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import cz.m5cet.app.M5;
import cz.m5cet.app.chat.RoomSession;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.net.Server;

/**
 * 6.7: the signed-in user's profile card on this phone, as the web keeps it
 * (client/src/lib/profile/client.ts) — opened from the account vault's own
 * "card" part (Account.loadCard), saved there sealed (every audience; what is
 * "only me" never leaves the phone readable), its public view put on the
 * server or withdrawn. The rooms hand the "room" view to their members
 * (RoomSession → ProfileRoom). Also: the editor's working copy and the
 * public lookups the people's detail asks for.
 */
public final class Profiles {
    private static Profiles instance;

    public static synchronized Profiles of(M5 app) {
        if (instance == null || instance.app != app) instance = new Profiles(app);
        return instance;
    }

    private final M5 app;
    /** What the other members share, by their device key and rev (every room). */
    public final ProfileRoom.Cache cache = new ProfileRoom.Cache(64);
    private JSONObject card;
    /** The account the card was opened for ("" = none yet). */
    private String loadedFor = "";
    private boolean loading;
    private String error = "";
    /** Public lookups by username: {state: loading | none | error | ok, profile, accountKey}. */
    private final Map<String, JSONObject> lookups = new ConcurrentHashMap<>();
    private volatile Runnable onChange;

    private Profiles(M5 app) { this.app = app; }

    /** Told (on the main thread) when the card was opened, saved or dropped. */
    public void onChange(Runnable r) { onChange = r; }

    /** The card of the signed-in account (null: signed out, or still opening — it is opened once, in the background). */
    public JSONObject card() {
        String user = app.accountName();
        boolean dropped = false;
        synchronized (this) {
            if (user.isEmpty()) {
                if (card != null || !loadedFor.isEmpty()) { card = null; loadedFor = ""; error = ""; lookups.clear(); dropped = true; }
            } else if (!user.equals(loadedFor) && !loading) {
                loading = true;
                Io.bg(() -> open(user));
            }
        }
        if (dropped) changed();
        synchronized (this) { return user.equals(loadedFor) ? card : null; }
    }

    private void open(String user) {
        JSONObject opened = null;
        String err = "";
        try {
            opened = ProfileCard.normalize(app.account.loadCard());
        } catch (Exception e) {
            err = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
            Log.w("profile", "the card did not open: " + err);
        }
        synchronized (this) {
            loading = false;
            loadedFor = user;
            card = opened;
            error = err;
        }
        changed();
    }

    /**
     * 6.12 (F-16): the app locked — the opened card, the public lookups and what
     * the other members shared leave the memory (the card opens again after
     * the unlock, the rooms share again when they reconnect).
     */
    public void forget() {
        synchronized (this) { card = null; loadedFor = ""; error = ""; lookups.clear(); }
        cache.clear();
    }

    public synchronized boolean loading() { return loading; }
    public synchronized String error() { return error; }

    /** What room members may see of me now (null: nothing). */
    public JSONObject roomView() {
        JSONObject c = card();
        if (c == null) return null;
        JSONObject v = ProfileCard.viewFor(c, "room");
        return ProfileCard.isEmptyView(v) ? null : v;
    }

    /** The name a room's name field starts with: the public nickname, else `current`. */
    public String prefill(String current) { return ProfileCard.prefill(card(), current); }

    /** My photo (for my own avatar on this phone), "" without one. */
    public String myPhoto() {
        JSONObject c = card();
        JSONObject a = c == null ? null : c.optJSONObject("avatar");
        return a == null ? "" : a.optString("value");
    }

    /** The rooms learn the new version, the screen draws again (on the main thread, where the rooms are kept). */
    private void changed() {
        Io.main(() -> {
            for (RoomSession r : app.rooms.connectedSessions()) r.profileChanged();
            Runnable r = onChange;
            if (r != null) r.run();
        });
    }

    /* -------------------------------------------------------------- save */

    /** How a save went: the public part ("published", "withdrawn", "none") and its error ("" = none). */
    public static final class Saved {
        public final JSONObject card;
        public final String outcome;
        public final String publicError;
        Saved(JSONObject card, String outcome, String publicError) { this.card = card; this.outcome = outcome; this.publicError = publicError; }
    }

    /**
     * Saves the card (blocking — a background thread): the public view to the
     * server first (or withdrawn when nothing is public), then the whole card
     * sealed into the vault, `published` telling the next save whether there
     * is something to withdraw. A failed public step still saves the card.
     */
    public Saved save(JSONObject draft) throws IOException {
        JSONObject next = ProfileCard.normalize(draft);
        String outcome = "none", publicError = "";
        try {
            next.put("updatedAt", System.currentTimeMillis());
            JSONObject view = ProfileCard.publicBody(next);
            if (!ProfileCard.isEmptyView(view)) {
                app.account.profileApi("PUT", "/api/profile", new JSONObject().put("profile", view), true);
                next.put("published", true);
                outcome = "published";
            } else if (next.optBoolean("published")) {
                app.account.profileApi("DELETE", "/api/profile", null, true);
                next.remove("published");
                outcome = "withdrawn";
            }
        } catch (IOException e) {
            publicError = e.getMessage() == null ? "error" : e.getMessage();
        } catch (JSONException e) {
            throw new IOException(e.getMessage());
        }
        app.account.saveCard(next);
        synchronized (this) { card = next; loadedFor = app.accountName(); error = ""; }
        changed();
        return new Saved(next, outcome, publicError);
    }

    /* ------------------------------------------------------------ lookups */

    /** A public lookup's state for a username (null: not asked). */
    public JSONObject lookup(String username) { return username == null ? null : lookups.get(username); }

    /** Asks the server for the public profile of a username — only when the user asks (it tells the server whose profile is looked at). */
    public void fetchPublic(String username, Runnable done) {
        if (username == null || !username.matches("^[A-Za-z0-9_-]{3,64}$")) return;
        lookups.put(username, state("loading", null, ""));
        Io.bg(() -> {
            JSONObject result;
            try {
                JSONObject r = app.account.profileApi("GET", "/api/profile/" + username, null, false);
                JSONObject profile = ProfileCard.normalizeShared(r.optJSONObject("profile"));
                String key = r.optString("accountKey", "");
                result = profile == null ? state("none", null, "") : state("ok", profile, key.matches("^[A-Za-z0-9+/=_-]{40,64}$") ? key : "");
            } catch (Server.HttpError e) {
                result = state(e.status == 404 ? "none" : "error", null, "");
            } catch (IOException e) {
                result = state("error", null, "");
            }
            lookups.put(username, result);
            if (done != null) Io.main(done);
        });
    }

    private static JSONObject state(String s, JSONObject profile, String accountKey) {
        JSONObject o = new JSONObject();
        try { o.put("state", s).put("accountKey", accountKey); if (profile != null) o.put("profile", profile); } catch (JSONException ignored) { }
        return o;
    }

    /** Type → the icon the trees draw (all in the app's icon set). */
    public static String icon(String type) {
        switch (type) {
            case "name": return "user-round";
            case "phone": return "phone";
            case "email": return "mail";
            case "address": return "map-pin";
            case "url": return "globe";
            case "social": return "at-sign";
            case "org": return "briefcase";
            case "birthday": return "gift";
            default: return "file-text";
        }
    }

    public static String audienceIcon(String audience) {
        return "public".equals(audience) ? "globe" : "room".equals(audience) ? "users" : "lock";
    }

    /** A shared view as the trees draw it: the fields get their icons. */
    public static JSONObject drawn(JSONObject view) {
        if (view == null) return null;
        try {
            JSONObject out = new JSONObject(view.toString());
            JSONArray fields = new JSONArray();
            JSONArray in = view.optJSONArray("fields");
            for (int i = 0; in != null && i < in.length(); i++) {
                JSONObject f = in.getJSONObject(i);
                fields.put(new JSONObject().put("icon", icon(f.optString("type"))).put("label", f.optString("label")).put("value", f.optString("value")).put("type", f.optString("type")));
            }
            return out.put("fields", fields);
        } catch (JSONException e) { return null; }
    }
}
