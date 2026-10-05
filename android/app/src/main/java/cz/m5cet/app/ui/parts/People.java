package cz.m5cet.app.ui.parts;

import android.Manifest;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Typeface;
import android.util.TypedValue;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

import cz.m5cet.app.M5;
import cz.m5cet.app.chat.RoomSession;
import cz.m5cet.app.contacts.AddressBook;
import cz.m5cet.app.contacts.LastSeen;
import cz.m5cet.app.contacts.Avatars;
import cz.m5cet.app.contacts.LinkActivity;
import cz.m5cet.app.contacts.Match;
import cz.m5cet.app.contacts.Presence;
import cz.m5cet.app.contacts.RtcStats;
import cz.m5cet.app.contacts.Safety;
import cz.m5cet.app.contacts.Store;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.ui.Actions;
import cz.m5cet.app.ui.MainActivity;
import cz.m5cet.app.ui.Ui;

/**
 * 6.2 People: the People widget's model and actions, as the web's recipients
 * widget does them — who is in the room (status, connection quality, the
 * avatar, a linked contact's photo), choosing who gets the next message
 * ($form.msgTo, which the composer reads), a person's detail ("users.person",
 * a sheet bound to $form.person), private messages, calls, comparing safety
 * numbers, and links with the phone's contacts (contacts.AddressBook).
 */
public final class People {
    private final MainActivity a;
    private final Parts parts;
    /** A linked contact's photo per username key, as a data: URL ("" = none or not readable). */
    private static final Map<String, String> photos = new ConcurrentHashMap<>();
    private static final Set<String> loading = ConcurrentHashMap.newKeySet();
    private static WeakReference<MainActivity> current = new WeakReference<>(null);
    private static boolean switchInstalled;
    /** The person the open detail shows, and the one loop keeping it fresh. */
    private String shown;
    private int fresh;

    People(MainActivity a, Parts parts) {
        this.a = a;
        this.parts = parts;
        current = new WeakReference<>(a);
        installSwitch(a.app());
    }

    private M5 app() { return a.app(); }

    private String t(String key) { return app().t(key); }

    private static String fill(String text, String name, String other) {
        return text.replace("{name}", name == null ? "" : name).replace("{contact}", other == null ? "" : other).replace("{room}", other == null ? "" : other);
    }

    /* ------------------------------------------------------------- model */

    /** Who gets the next message ($form.msgTo): peer ids; empty = everyone. */
    List<String> selection() {
        Object to = a.form().get("msgTo");
        List<String> out = new ArrayList<>();
        if (to instanceof List) for (Object o : (List<?>) to) out.add(String.valueOf(o));
        return out;
    }

    /** The people of a room for the widget, connected first (me on top), away next, the rest last. */
    JSONArray users(RoomSession r) {
        JSONArray out = new JSONArray();
        if (r == null) return out;
        JSONArray base = r.peopleScope();
        List<String> sel = selection();
        List<JSONObject> list = new ArrayList<>();
        for (int i = 0; i < base.length(); i++) {
            JSONObject u = base.optJSONObject(i);
            if (u != null) list.add(ProfileUi.decorate(app(), r, enrich(u, sel))); // 6.7: a shared profile photo
        }
        list.sort(Comparator.comparingInt((JSONObject u) -> u.optBoolean("me") ? -1 : Presence.rank(u.optString("status"))));
        for (JSONObject u : list) out.put(u);
        return out;
    }

    /** What the widget draws of one person (the room's facts + status, signal, avatar, selection, link). */
    private JSONObject enrich(JSONObject u, List<String> sel) {
        M5 app = app();
        String id = u.optString("id"), name = u.optString("name"), username = u.optString("username"), channel = u.optString("channel");
        boolean me = u.optBoolean("me"), signedIn = u.optBoolean("signedIn"), open = "open".equals(channel);
        String status = Presence.status(channel, signedIn, u.optString("audio"));
        long rtt = (long) u.optDouble("rtt", -1);
        int bars = Presence.bars(open, rtt);
        String kid = Safety.keyId(u.optString("publicKey"));
        boolean contacts = app.settings.bool("people.contacts");
        JSONObject link = me || !signedIn || username.isEmpty() ? null : Store.link(app, username);
        try {
            u.put("status", status).put("statusIcon", Presence.icon(status)).put("statusColor", Presence.color(status)).put("statusLabel", t("people.status." + status))
                .put("signal", (double) bars).put("signalIcon", Presence.signalIcon(bars)).put("signalColor", Presence.signalColor(bars)).put("rttText", rtt >= 0 ? rtt + " ms" : "—")
                .put("glyph", Avatars.glyph(name, null)).put("avatarBg", Avatars.background(name)).put("avatarFg", Avatars.foreground(name))
                .put("selectable", !me && open).put("selected", !me && open && sel.contains(id))
                .put("linked", link != null).put("contact", link == null ? "" : link.optString("contact"))
                .put("photo", link != null && contacts ? photo(username) : "")
                .put("canLink", !me && contacts && Match.canLink(username, signedIn))
                .put("kid", kid).put("safetyVerified", !me && Store.verified(app, kid))
                // The 6.0 trees: a valid hello with an unchanged key; "away" as a flag.
                .put("verified", u.optBoolean("signed") && !u.optBoolean("changed")).put("away", Presence.AWAY.equals(status));
        } catch (JSONException ignored) { }
        // 6.7: the status dot and "last seen …" (online / away / far away).
        return LastSeen.decorate(u, app::t, System.currentTimeMillis());
    }

    private JSONObject find(RoomSession r, String id) {
        JSONArray all = users(r);
        for (int i = 0; i < all.length(); i++) if (id != null && id.equals(all.optJSONObject(i).optString("id"))) return all.optJSONObject(i);
        return null;
    }

    /** Everything the detail shows of a person ($form.person). */
    JSONObject person(RoomSession r, String id) {
        JSONObject u = r == null ? null : find(r, id);
        if (u == null) return null;
        boolean me = u.optBoolean("me"), open = "open".equals(u.optString("channel"));
        long since = (long) u.optDouble("since", 0), now = System.currentTimeMillis();
        RtcStats.Summary st = me ? null : r.peerStats(id);
        String transport = me ? "self" : !open || st == null || st.transport().isEmpty() ? "connecting" : st.transport();
        String theirs = u.optString("publicKey"), mine = r.myPublicKey();
        // 6.12 (§ 12.2): both account keys when both devices are attested, else both device keys.
        String[] keys = me ? new String[]{mine, theirs} : r.safetyKeys(id);
        boolean safety = !me && !keys[0].isEmpty() && !keys[1].isEmpty();
        String candidates = "";
        if (st != null && !st.localType.isEmpty()) {
            candidates = st.localType + " → " + st.remoteType + (st.protocol.isEmpty() ? "" : " · " + st.protocol.toUpperCase(java.util.Locale.ROOT))
                + (st.relayProtocol.isEmpty() ? "" : " (TURN " + st.relayProtocol.toUpperCase(java.util.Locale.ROOT) + ")");
        }
        String security = "AES-GCM 256 (E2EE)";
        if (st != null && "connected".equals(st.dtlsState)) security += " · " + (st.dtlsVersion().isEmpty() ? "DTLS" : st.dtlsVersion()) + (st.srtpCipher.isEmpty() ? "" : " · " + st.srtpCipher);
        try {
            u.put("peerShort", id.length() > 16 ? id.substring(id.length() - 16) : id)
                .put("sinceText", since > 0 ? Presence.duration(now - since, t("people.h"), t("people.m"), t("people.s")) : "—")
                .put("transport", transport).put("transportLabel", t("people.transport." + transport)).put("candidates", candidates)
                .put("remote", st == null ? "" : st.remoteAddress).put("codec", st == null ? "" : st.codecs())
                .put("traffic", st == null ? "—" : Presence.bytes(st.bytesSent) + " / " + Presence.bytes(st.bytesReceived))
                .put("security", security).put("dtls", st == null ? "" : st.dtlsFingerprint)
                .put("fingerprint", Safety.fingerprint(me ? mine : theirs))
                .put("hasSafety", safety).put("safety", safety ? Safety.lines(Safety.number(keys[0], keys[1])) : "")
                .put("room", r.label).put("contactsOn", app().settings.bool("people.contacts"))
                .put("others", (double) Math.max(0, r.userCount() - 1));
        } catch (JSONException ignored) { }
        return ProfileUi.detail(app(), r, u); // 6.7: what they share, their public profile when asked for
    }

    /** A linked contact's photo as a data: URL ("" until it is read, or without one); read once, in the background. */
    private String photo(String username) {
        String k = Match.key(username);
        String p = photos.get(k);
        if (p != null) return p;
        if (!a.has(Manifest.permission.READ_CONTACTS) || !loading.add(k)) return "";
        Context ctx = a.getApplicationContext();
        Io.bg(() -> {
            String url = "";
            try {
                byte[] b = AddressBook.photo(ctx, username);
                if (b != null) url = "data:image/jpeg;base64," + android.util.Base64.encodeToString(small(b), android.util.Base64.NO_WRAP);
            } catch (RuntimeException e) { Log.w("people", "contact photo: " + e.getMessage()); }
            photos.put(k, url);
            loading.remove(k);
            if (!url.isEmpty()) Io.main(this::refreshAll);
        });
        return "";
    }

    /** A photo small enough for an avatar (the thumbnail usually is). */
    private static byte[] small(byte[] b) {
        if (b.length <= 48 * 1024) return b;
        Bitmap bm = BitmapFactory.decodeByteArray(b, 0, b.length);
        if (bm == null) return b;
        Bitmap s = Bitmap.createScaledBitmap(bm, 128, Math.max(1, Math.round(128f * bm.getHeight() / bm.getWidth())), true);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        s.compress(Bitmap.CompressFormat.JPEG, 85, out);
        return out.toByteArray();
    }

    /** The screen, the panel and an open detail again. */
    private void refreshAll() {
        if (shown != null && "users.person".equals(parts.sheetScreen())) {
            JSONObject p = person(app().rooms.activeSession(), shown);
            if (p != null) a.form().put("person", p);
        }
        a.refresh();
    }

    /**
     * 6.10 (G-20): the username of the person whose detail is open now, or
     * null — profile.public looks up only them (the design's argument is
     * computed: "{$form.person.username}"), never a name a design built from data.
     */
    public String shownUsername() {
        if (shown == null || !"users.person".equals(parts.sheetScreen())) return null;
        JSONObject p = person(app().rooms.activeSession(), shown);
        String u = p == null ? "" : p.optString("username", "");
        return u.isEmpty() ? null : u;
    }

    /* ----------------------------------------------------------- actions */

    /** The design's people.* actions. */
    public void run(String action, String arg) {
        switch (action) {
            case "people.open": open(arg); break;
            case "people.select": toggle(arg); break;
            case "people.all": selectAll(); break;
            case "people.none": select(Collections.emptyList()); break;
            case "people.message": privateTo(arg); break;
            case "people.call": call(arg, false); break;
            case "people.video": call(arg, true); break;
            case "people.verify": verify(arg); break;
            case "people.link": link(arg); break;
            case "people.unlink": unlink(arg); break;
            case "people.unlinkAll": unlinkAll(); break;
            default: Log.w("people", "unknown action " + action);
        }
    }

    private void select(List<String> ids) {
        if (ids.isEmpty()) a.form().remove("msgTo"); else a.form().put("msgTo", new ArrayList<>(ids));
        parts.refreshComposer();
        a.refresh();
    }

    /** Adds or removes a person from who gets the next message (only connected peers of the active room). */
    private void toggle(String id) {
        RoomSession r = app().rooms.activeSession();
        if (r == null || id == null || r.peerName(id) == null) return;
        List<String> sel = selection();
        sel.removeIf(x -> r.peerName(x) == null);
        if (!sel.remove(id)) sel.add(id);
        select(sel);
    }

    /** "Vybrat vše": every connected person of the room. */
    private void selectAll() {
        List<String> ids = new ArrayList<>();
        JSONArray all = users(app().rooms.activeSession());
        for (int i = 0; i < all.length(); i++) if (all.optJSONObject(i).optBoolean("selectable")) ids.add(all.optJSONObject(i).optString("id"));
        select(ids);
    }

    /** A private message to only this person: they alone are selected and the composer gets the focus. */
    public void privateTo(String peerId) {
        RoomSession r = app().rooms.activeSession();
        if (r == null || peerId == null || r.peerName(peerId) == null) return;
        parts.closeOverlay();
        select(Collections.singletonList(peerId));
        Io.mainLater(parts::focusComposer, 250);
    }

    /** The person's detail as a sheet, kept fresh (duration, round trip) while it is open. */
    private void open(String id) {
        RoomSession r = app().rooms.activeSession();
        JSONObject p = person(r, id);
        if (p == null) return;
        shown = id;
        a.form().put("person", p);
        parts.showSheet("users.person");
        int g = ++fresh;
        Io.mainLater(() -> keepFresh(id, g), 1500);
    }

    private void keepFresh(String id, int g) {
        if (g != fresh || !id.equals(shown) || !"users.person".equals(parts.sheetScreen()) || a.isDestroyed()) return;
        RoomSession r = app().rooms.activeSession();
        if (r == null) return;
        r.refreshStats(null);
        Io.mainLater(() -> {
            if (!id.equals(shown) || !"users.person".equals(parts.sheetScreen())) return;
            JSONObject p = person(r, id);
            if (p == null) return;
            a.form().put("person", p);
            parts.refreshSheet();
        }, 400);
        Io.mainLater(() -> keepFresh(id, g), 2000);
    }

    /** A call from the detail: the room's call (as on the web) — asked first when more people would hear it. */
    private void call(String id, boolean video) {
        RoomSession r = app().rooms.activeSession();
        if (r == null) return;
        parts.closeOverlay();
        Runnable go = () -> a.withPermission(Manifest.permission.RECORD_AUDIO, () -> {
            if (video) a.withPermission(Manifest.permission.CAMERA, () -> Actions.run(a, "call.video", null, n -> null, null, 0));
            else Actions.run(a, "call.audio", null, n -> null, null, 0);
        });
        if (r.userCount() <= 2 || !"off".equals(r.calls().state())) { go.run(); return; }
        String who = r.peerName(id) == null ? "" : r.peerName(id);
        new android.app.AlertDialog.Builder(a).setMessage(fill(t("people.callAsk"), who, r.label))
            .setPositiveButton(video ? t("people.video") : t("people.call"), (d, w) -> go.run())
            .setNegativeButton(t("nav.close"), null).show();
    }

    /** The safety number to compare; "they match" marks the person's device key as verified. */
    private void verify(String id) {
        RoomSession r = app().rooms.activeSession();
        JSONObject p = person(r, id);
        if (p == null || !p.optBoolean("hasSafety")) return;
        String kid = p.optString("kid"), name = p.optString("name");
        boolean done = p.optBoolean("safetyVerified");
        LinearLayout box = new LinearLayout(a);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(Ui.dp(a, 24), Ui.dp(a, 8), Ui.dp(a, 24), 0);
        TextView number = new TextView(a);
        number.setText(p.optString("safety"));
        number.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        number.setTextSize(TypedValue.COMPLEX_UNIT_SP, 19);
        number.setLineSpacing(0, 1.25f);
        number.setTextIsSelectable(true);
        box.addView(number);
        TextView hint = new TextView(a);
        hint.setText(fill(t("people.verify.hint"), name, ""));
        hint.setPadding(0, Ui.dp(a, 14), 0, 0);
        box.addView(hint);
        SecureDialog.show(a, new android.app.AlertDialog.Builder(a).setTitle(t("people.safety")).setView(box) // 6.7 N18
            .setPositiveButton(done ? t("people.verify.undo") : t("people.verify.match"), (d, w) -> {
                Store.setVerified(app(), kid, !done);
                // 6.12 (§ 12): a verified identity is accepted — a changed one's pins follow and its held messages appear;
                // an attested device's account counts as verified everywhere.
                RoomSession room = app().rooms.activeSession();
                if (room != null) room.identityVerified(id, !done);
                if (!done) a.flash("", fill(t("people.verify.done"), name, ""), "success");
                refreshAll();
            })
            .setNegativeButton(t("nav.close"), null));
    }

    /** "Propojit s kontaktem": the phone's contact picker, then the M5cet rows on the chosen contact. */
    private void link(String id) {
        M5 app = app();
        if (!app.settings.bool("people.contacts")) { a.flash("", t("people.contactsOff"), "warn"); return; }
        JSONObject p = person(app.rooms.activeSession(), id);
        if (p == null) return;
        if (!p.optBoolean("canLink")) { a.flash("", t("people.linkOnlyAccounts"), "warn"); return; }
        String username = p.optString("username"), name = p.optString("name");
        a.withPermission(Manifest.permission.READ_CONTACTS, () -> a.withPermission(Manifest.permission.WRITE_CONTACTS, () ->
            LinkActivity.start(a, username, t("people.contact.message"), t("people.contact.call"), (l, e) -> {
                if (l != null) {
                    photos.remove(Match.key(username));
                    a.flash("", fill(t("people.linked"), name, l.contactName), "success");
                    refreshAll();
                } else if (e != null) {
                    a.flash("", t("people.linkFailed"), "error");
                }
            })));
    }

    /** "Zrušit propojení": the M5cet rows go from the contact (the contact itself stays). */
    private void unlink(String id) {
        JSONObject p = person(app().rooms.activeSession(), id);
        String username = p != null ? p.optString("username") : id;
        if (Store.link(app(), username) == null) return;
        Context ctx = a.getApplicationContext();
        a.withPermission(Manifest.permission.WRITE_CONTACTS, () -> Io.bg(() -> {
            try { AddressBook.remove(ctx, username); } catch (RuntimeException e) { Log.w("people", "unlink: " + e.getMessage()); }
            Store.removeLink(app(), username);
            photos.remove(Match.key(username));
            Io.main(() -> { a.flash("", t("people.unlinked"), "success"); refreshAll(); });
        }));
    }

    /** Settings › People: every link goes (from the address book and from the app). */
    private void unlinkAll() {
        Context ctx = a.getApplicationContext();
        new android.app.AlertDialog.Builder(a).setMessage(t("people.unlinkAllAsk"))
            .setPositiveButton(t("people.unlinkAll"), (d, w) -> Io.bg(() -> {
                AddressBook.removeAll(ctx);
                Store.clearLinks(app());
                photos.clear();
                Io.main(() -> { a.flash("", t("people.unlinked"), "success"); refreshAll(); });
            }))
            .setNegativeButton(t("nav.close"), null).show();
    }

    /* ------------------------------------------------ the setting (6.2) */

    /**
     * people.contacts off: the M5cet rows leave the address book (the links
     * stay in the vault); on again: they come back, where the contact still is.
     */
    private static synchronized void installSwitch(M5 app) {
        if (switchInstalled) return;
        switchInstalled = true;
        // A wipe takes the M5cet rows out of the address book too (the vault with the links is gone).
        app.addListener(what -> { if ("wiped".equals(what)) Io.bg(() -> AddressBook.removeAll(app)); });
        app.settings.addListener((key, value) -> {
            if (!"people.contacts".equals(key)) return;
            photos.clear();
            if (Boolean.FALSE.equals(value)) { Io.bg(() -> AddressBook.removeAll(app)); return; }
            MainActivity a = current.get();
            if (app.checkSelfPermission(Manifest.permission.WRITE_CONTACTS) == android.content.pm.PackageManager.PERMISSION_GRANTED) Io.bg(() -> restore(app));
            else if (a != null && !a.isDestroyed()) a.withPermission(Manifest.permission.WRITE_CONTACTS, () -> Io.bg(() -> restore(app)));
        });
    }

    /** The links kept in the vault back in the address book. */
    private static void restore(M5 app) {
        JSONObject all = Store.links(app);
        for (Iterator<String> it = all.keys(); it.hasNext(); ) {
            JSONObject l = all.optJSONObject(it.next());
            if (l == null) continue;
            android.net.Uri contact = AddressBook.contactOf(app, l.optString("lookup"), l.optLong("id"));
            if (contact == null) continue;
            try { Store.putLink(app, AddressBook.link(app, l.optString("username"), contact, app.t("people.contact.message"), app.t("people.contact.call"))); }
            catch (Exception e) { Log.w("people", "restoring a link: " + e.getMessage()); }
        }
    }
}
