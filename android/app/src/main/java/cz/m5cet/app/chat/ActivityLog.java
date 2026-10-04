package cz.m5cet.app.chat;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;

import cz.m5cet.app.M5;

/**
 * 6.8: the app's own log — the calls and the messages of every room in one
 * list, newest first (the History screen, ui/parts/CallLogUi). Calls come
 * from the call history (CallHistory), messages from the rooms' own
 * histories as they are (a connected room's messages in memory, the others'
 * from the vault) — nothing is copied or stored again.
 *
 * What a message may show here: its text, a file's name or a command — but
 * a sealed, hold-to-read, vanishing or hidden message only its kind, never a
 * word of it (the search does not see into them either). System lines and
 * expired messages are left out. The pure parts (items, merge, filter,
 * search, days, lengths) are checked by ActivityLogTest.
 */
public final class ActivityLog {
    private ActivityLog() {}

    public static final String CALL = "call", MSG = "msg";
    /** The filters of the screen. */
    public static final String ALL = "all", CALLS = "calls", MESSAGES = "messages", MISSED = "missed";
    /** A message's preview is cut to this many characters. */
    static final int PREVIEW_MAX = 120;

    /** One line of the log. */
    public static final class Item {
        public String id = "";
        /** CALL or MSG. */
        public String type = MSG;
        /** in | out (calls also missed | declined). */
        public String dir = "in";
        /** A message's kind as the log may show it: text | file | fn | sealed | tap | vanish | hidden. */
        public String what = "text";
        public String roomKey = "", room = "";
        /** A call's others; a message's sender (received) or its recipients (a private one of mine). */
        public final List<String> people = new ArrayList<>();
        public long at;
        public long seconds;
        public boolean video;
        /** What a message says ("" for the kinds that show nothing). */
        public String preview = "";
        public String msgId = "";
        /** The room is still saved in the app (it opens; a call can be made again). */
        public boolean saved;
    }

    /* ------------------------------------------------------------ items */

    public static Item call(CallHistory.Entry e, boolean saved) {
        Item it = new Item();
        it.id = "c:" + e.id;
        it.type = CALL;
        it.dir = e.kind;
        it.what = e.video ? "video" : "audio";
        it.roomKey = e.roomKey;
        it.room = e.room;
        it.people.addAll(e.people);
        it.at = e.at;
        it.seconds = e.seconds;
        it.video = e.video;
        it.saved = saved;
        return it;
    }

    /** A message of a room as the log shows it, or null when it is not listed (system lines, expired, gone). */
    public static Item message(String roomKey, String room, ChatMessage m, boolean hidden, long now) {
        if (m == null || m.deleted || !"text".equals(m.kind) || m.expired(now)) return null;
        Item it = new Item();
        it.id = "m:" + Integer.toHexString(roomKey.hashCode()) + ":" + m.id;
        it.type = MSG;
        it.dir = m.mine ? "out" : "in";
        it.what = what(m, hidden);
        it.roomKey = roomKey;
        it.room = room;
        if (!m.mine && !m.senderName.isEmpty()) it.people.add(m.senderName);
        if (m.mine) it.people.addAll(m.to);
        it.at = m.createdAt;
        it.preview = preview(m, it.what);
        it.msgId = m.id;
        it.saved = true;
        return it;
    }

    /** What of a message the log may show: a kind that hides its text wins over everything else. */
    static String what(ChatMessage m, boolean hidden) {
        if (hidden) return "hidden";
        if (m.sealed != null) return "sealed";
        if (m.tap) return "tap";
        if (m.vanishSeconds > 0 || m.vanished) return "vanish";
        if (m.fileName != null) return "file";
        if (m.fn != null) return "fn";
        return "text";
    }

    static String preview(ChatMessage m, String what) {
        switch (what) {
            case "text": return oneLine(m.text);
            case "file": return oneLine(m.fileName + (m.text.isEmpty() ? "" : " · " + m.text));
            case "fn": return oneLine("/" + m.fn.optString("keyword") + (m.text.isEmpty() ? "" : " · " + m.text));
            default: return "";
        }
    }

    private static String oneLine(String s) {
        String t = s == null ? "" : s.replaceAll("[\\p{Cntrl}\\s]+", " ").trim();
        return t.length() > PREVIEW_MAX ? t.substring(0, PREVIEW_MAX - 1) + "…" : t;
    }

    /* ---------------------------------------------- merge, filter, search */

    /** One list, newest first (the same time: calls before messages, then by id — always the same order). */
    public static List<Item> merge(List<Item> calls, List<Item> messages) {
        List<Item> out = new ArrayList<>(calls.size() + messages.size());
        out.addAll(calls);
        out.addAll(messages);
        Collections.sort(out, (a, b) -> {
            if (a.at != b.at) return Long.compare(b.at, a.at);
            if (!a.type.equals(b.type)) return a.type.equals(CALL) ? -1 : 1;
            return a.id.compareTo(b.id);
        });
        return out;
    }

    /** The items of a filter (all | calls | messages | missed) that match the search (room, people, what a message says). */
    public static List<Item> filter(List<Item> all, String filter, String query) {
        String f = filter == null ? ALL : filter;
        String q = fold(query == null ? "" : query.trim());
        List<Item> out = new ArrayList<>();
        for (Item it : all) {
            if (f.equals(CALLS) && !it.type.equals(CALL)) continue;
            if (f.equals(MESSAGES) && !it.type.equals(MSG)) continue;
            if (f.equals(MISSED) && !(it.type.equals(CALL) && CallTrack.MISSED.equals(it.dir))) continue;
            if (!q.isEmpty() && !matches(it, q)) continue;
            out.add(it);
        }
        return out;
    }

    private static boolean matches(Item it, String q) {
        StringBuilder hay = new StringBuilder(it.room);
        for (String p : it.people) hay.append('\n').append(p);
        hay.append('\n').append(it.preview);
        String h = fold(hay.toString());
        for (String word : q.split("\\s+")) if (!word.isEmpty() && !h.contains(word)) return false;
        return true;
    }

    /** Lower case without diacritics ("Žluťoučký" finds "zlutoucky"). */
    static String fold(String s) {
        return Normalizer.normalize(s, Normalizer.Form.NFD).replaceAll("\\p{M}+", "").toLowerCase(Locale.ROOT);
    }

    /* ------------------------------------------------------- days, lengths */

    /** How many calendar days back a time is (0 = today, 1 = yesterday; the future counts as today). */
    public static int daysAgo(long at, long now, TimeZone tz) {
        long day = 86_400_000L;
        long a = Math.floorDiv(at + tz.getOffset(at), day), b = Math.floorDiv(now + tz.getOffset(now), day);
        return (int) Math.max(0, Math.min(Integer.MAX_VALUE, b - a));
    }

    /** A call's length: 0:42, 12:04, 1:02:09 ("" for none). */
    public static String length(long seconds) {
        if (seconds <= 0) return "";
        long h = seconds / 3600, m = seconds % 3600 / 60, s = seconds % 60;
        return h > 0 ? String.format(Locale.ROOT, "%d:%02d:%02d", h, m, s) : String.format(Locale.ROOT, "%d:%02d", m, s);
    }

    /* ----------------------------------------------------------- collect */

    /** Whether a message is hidden in this view now (ui/bubble/Hides). */
    public interface Hidden { boolean test(ChatMessage m, long now); }

    /** Everything the log lists: every call kept and the messages of every saved room, newest first. */
    public static List<Item> collect(M5 app, Hidden hidden) {
        long now = System.currentTimeMillis();
        java.util.Set<String> saved = new java.util.HashSet<>();
        List<Item> messages = new ArrayList<>();
        for (Rooms.Saved s : app.rooms.saved()) {
            saved.add(s.key);
            RoomSession r = app.rooms.session(s.key);
            String room = s.label == null || s.label.isEmpty() ? s.room : s.label;
            for (ChatMessage m : r != null ? r.messagesCopy() : History.load(app, s.key)) {
                Item it = message(s.key, room, m, hidden.test(m, now), now);
                if (it != null) messages.add(it);
            }
        }
        List<Item> calls = new ArrayList<>();
        for (CallHistory.Entry e : CallHistory.load(app)) calls.add(call(e, saved.contains(e.roomKey)));
        return merge(calls, messages);
    }
}
