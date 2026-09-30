package cz.m5cet.app.contacts;

import android.Manifest;
import android.content.Intent;
import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

import cz.m5cet.app.M5;
import cz.m5cet.app.chat.RoomSession;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.ui.Actions;
import cz.m5cet.app.ui.MainActivity;

/**
 * 6.2 Contacts: "Zpráva přes M5cet" / "Volat přes M5cet" tapped in the
 * phone's Contacts app. MainActivity hands the intent over (handleIntent);
 * once the app is unlocked the row's username is looked for in the connected
 * rooms — waiting a little while rooms and peers are still connecting — and
 * the person gets a private message (their room opens, only they are
 * selected, the composer has the focus) or, after a confirmation, a call.
 * When they are not online anywhere, the app says so.
 *
 * A row acts only for a username linked in this app (Store), so another app
 * cannot make it reach whoever it likes.
 */
public final class ContactIntents {
    private ContactIntents() {}

    /** Marks an intent as handled: a recreated activity gets the same one again. */
    private static final String DONE = "cz.m5cet.people.done";

    private static final class Pending {
        final Uri uri;
        final String kind;
        final long at = System.currentTimeMillis();
        String username;
        long searchSince;
        boolean reading, told;
        Pending(Uri uri, String kind) { this.uri = uri; this.kind = kind; }
    }

    private static Pending pending;
    /** The one running lookup (a newer tap or activity replaces it), and the activity it runs in. */
    private static int loop;
    private static java.lang.ref.WeakReference<MainActivity> host = new java.lang.ref.WeakReference<>(null);

    /** From MainActivity.handleIntent: takes a Contacts app row's intent (true when it was one). */
    public static boolean accept(MainActivity a, Intent i) {
        if (i == null || !Intent.ACTION_VIEW.equals(i.getAction()) || i.getData() == null) return false;
        String type = i.resolveType(a);
        if (!AddressBook.MIME_MESSAGE.equals(type) && !AddressBook.MIME_CALL.equals(type)) return false;
        boolean old = i.getBooleanExtra(DONE, false) || (i.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0;
        i.putExtra(DONE, true);
        if (!old) pending = new Pending(i.getData(), AddressBook.MIME_CALL.equals(type) ? "call" : "message");
        host = new java.lang.ref.WeakReference<>(a);
        if (pending != null) later(++loop, 300);
        return true;
    }

    private static void later(int g, long ms) { Io.mainLater(() -> tick(g), ms); }

    private static String fill(String text, String name, String room) {
        return text.replace("{name}", name == null ? "" : name).replace("{room}", room == null ? "" : room);
    }

    private static void drop(MainActivity a, String message, String level) {
        pending = null;
        if (message != null) a.flash("", message, level);
    }

    private static void tick(int g) {
        Pending p = pending;
        MainActivity a = host.get();
        if (p == null || g != loop || a == null || a.isDestroyed()) return;
        M5 app = a.app();
        long now = System.currentTimeMillis();
        if (now - p.at > 5 * 60_000L) { pending = null; return; }
        String screen = a.screen();
        // First the app is unlocked and on its screens.
        if (app.lock.isLocked() || screen.isEmpty() || screen.equals("splash") || screen.equals("lock") || screen.equals("enroll")) { later(g, 600); return; }
        if (!app.settings.bool("people.contacts")) { drop(a, app.t("people.contactsOff"), "warn"); return; }
        if (p.username == null) {
            if (!a.has(Manifest.permission.READ_CONTACTS)) { a.withPermission(Manifest.permission.READ_CONTACTS, () -> tick(g)); return; }
            if (p.reading) return;
            p.reading = true;
            android.content.Context ctx = a.getApplicationContext();
            Io.bg(() -> {
                AddressBook.Row row = null;
                try { row = AddressBook.rowOf(ctx, p.uri); } catch (RuntimeException e) { Log.w("people", "contact row: " + e.getMessage()); }
                AddressBook.Row r = row;
                Io.main(() -> {
                    p.reading = false;
                    MainActivity cur = host.get();
                    if (pending != p || cur == null) return;
                    if (r == null) { drop(cur, app.t("people.notLinked"), "warn"); return; }
                    p.username = r.username;
                    tick(loop);
                });
            });
            return;
        }
        JSONObject link = Store.link(app, p.username);
        if (link == null) { drop(a, app.t("people.notLinked"), "warn"); return; }
        String name = link.optString("contact", "").isEmpty() ? p.username : link.optString("contact");
        List<RoomSession> rooms = app.rooms.connectedSessions();
        if (rooms.isEmpty()) { drop(a, fill(app.t("people.noRooms"), name, ""), "warn"); return; }
        List<Match.Candidate> candidates = new ArrayList<>();
        boolean settling = false;
        for (RoomSession r : rooms) {
            settling |= r.peopleSettling(now);
            JSONArray people = r.peopleScope();
            for (int i = 0; i < people.length(); i++) {
                JSONObject u = people.optJSONObject(i);
                if (u == null || u.optBoolean("me")) continue;
                candidates.add(new Match.Candidate(r.key, u.optString("id"), u.optString("username"), u.optBoolean("signedIn"),
                    "open".equals(u.optString("channel")), r.key.equals(app.rooms.active()), r.lastActivity()));
            }
        }
        if (p.searchSince == 0) p.searchSince = now;
        Match.Candidate found = Match.pick(candidates, p.username);
        switch (Match.decide(found != null, settling, p.searchSince, now)) {
            case Match.FOUND:
                pending = null;
                reach(a, p.kind, found);
                break;
            case Match.WAIT:
                if (!p.told) { p.told = true; a.flash("", fill(app.t("people.searching"), name, ""), "info"); }
                later(g, 700);
                break;
            default:
                drop(a, fill(app.t("people.notOnline"), name, ""), "warn");
        }
    }

    /** The person was found: their room, then a private message to only them — or a call, once the user confirms it. */
    private static void reach(MainActivity a, String kind, Match.Candidate c) {
        M5 app = a.app();
        RoomSession r = app.rooms.session(c.roomKey);
        if (r == null) return;
        String who = r.peerName(c.peerId) == null ? c.username : r.peerName(c.peerId);
        a.parts.closeOverlay();
        a.goRoom(c.roomKey);
        if ("call".equals(kind)) {
            // Calls are the room's (as on the web): everyone connected there hears it — so it is asked first.
            new android.app.AlertDialog.Builder(a).setMessage(fill(app.t("people.callAsk"), who, r.label))
                .setPositiveButton(app.t("people.call"), (d, w) -> a.withPermission(Manifest.permission.RECORD_AUDIO, () -> Actions.run(a, "call.audio", null, n -> null, null, 0)))
                .setNegativeButton(app.t("nav.close"), null).show();
            return;
        }
        a.parts.people().privateTo(c.peerId);
    }
}
