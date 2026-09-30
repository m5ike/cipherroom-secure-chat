package cz.m5cet.app.contacts;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Iterator;

import cz.m5cet.app.M5;
import cz.m5cet.app.security.Vault;

/**
 * 6.2 People: what the app keeps of people, in the vault (user tier) —
 *   people.links     username key → {username, contact (its name), lookup, id, at}:
 *                    the links with phone contacts, so a link survives the
 *                    integration being switched off and on, and a row of the
 *                    address book acts only for a username linked here
 *   people.verified  device key id → the time its safety number was compared
 * Read often (every refresh of the People widget), so kept in memory while
 * the vault is open.
 */
public final class Store {
    private Store() {}

    private static final String LINKS = "people.links", VERIFIED = "people.verified";
    private static JSONObject links, verified;

    private static synchronized JSONObject read(M5 app, String name) {
        if (!app.vault.unlocked()) { links = null; verified = null; return new JSONObject(); }
        if (name.equals(LINKS)) { if (links == null) links = app.vault.json(Vault.Tier.USER, LINKS); return links; }
        if (verified == null) verified = app.vault.json(Vault.Tier.USER, VERIFIED);
        return verified;
    }

    private static synchronized void write(M5 app, String name, JSONObject value) {
        if (!app.vault.unlocked()) return;
        app.vault.putJson(Vault.Tier.USER, name, value);
        if (name.equals(LINKS)) links = value; else verified = value;
    }

    /* ------------------------------------------------------------ links */

    /** The link of a username (a copy), null when there is none. */
    public static synchronized JSONObject link(M5 app, String username) {
        String k = Match.key(username);
        JSONObject o = k.isEmpty() ? null : read(app, LINKS).optJSONObject(k);
        try { return o == null ? null : new JSONObject(o.toString()); } catch (JSONException e) { return null; }
    }

    /** Every link (a copy). */
    public static synchronized JSONObject links(M5 app) {
        try { return new JSONObject(read(app, LINKS).toString()); } catch (JSONException e) { return new JSONObject(); }
    }

    public static synchronized void putLink(M5 app, AddressBook.Linked l) {
        JSONObject all = links(app);
        try {
            all.put(Match.key(l.username), new JSONObject().put("username", l.username).put("contact", l.contactName).put("lookup", l.lookup)
                .put("id", l.contactId).put("at", System.currentTimeMillis()));
        } catch (JSONException ignored) { }
        write(app, LINKS, all);
    }

    public static synchronized void removeLink(M5 app, String username) {
        JSONObject all = links(app);
        all.remove(Match.key(username));
        write(app, LINKS, all);
    }

    public static synchronized void clearLinks(M5 app) { write(app, LINKS, new JSONObject()); }

    /** The usernames linked here. */
    public static synchronized java.util.List<String> linkedUsers(M5 app) {
        java.util.List<String> out = new java.util.ArrayList<>();
        JSONObject all = read(app, LINKS);
        for (Iterator<String> it = all.keys(); it.hasNext(); ) {
            JSONObject o = all.optJSONObject(it.next());
            if (o != null) out.add(o.optString("username"));
        }
        return out;
    }

    /* --------------------------------------------------------- verified */

    public static synchronized boolean verified(M5 app, String kid) {
        return kid != null && !kid.isEmpty() && read(app, VERIFIED).has(kid);
    }

    public static synchronized void setVerified(M5 app, String kid, boolean on) {
        if (kid == null || kid.isEmpty()) return;
        JSONObject all;
        try { all = new JSONObject(read(app, VERIFIED).toString()); } catch (JSONException e) { all = new JSONObject(); }
        if (on) try { all.put(kid, System.currentTimeMillis()); } catch (JSONException ignored) { }
        else all.remove(kid);
        write(app, VERIFIED, all);
    }
}
