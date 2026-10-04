package cz.m5cet.app.telecom;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;

import cz.m5cet.app.contacts.Avatars;
import cz.m5cet.app.security.Crypto;

/**
 * 6.8: which rooms become Android conversations and how they look — the
 * pure part of telecom/Conversations (no Android API, so the JVM tests run
 * it). The joined rooms, the most recently active first; their shortcut ids
 * (keyed with a secret of this install, so an id says nothing of the room's
 * name — 6.7's said a hash of it); the label: the room's name, or a neutral
 * "Conversation 2" whenever names may not show (switched off, the app
 * locked, or notifications may not name the room); the monogram; which of
 * the app's shortcuts have to go; and when a change is worth a
 * ShortcutManager call (the system rate-limits them in the background).
 */
public final class ConversationPlan {
    private ConversationPlan() {}

    public static final String SETTING_ON = "conversations.on";
    public static final String SETTING_NAMES = "conversations.names";
    /** The shortcuts' category; res/xml/shortcuts.xml maps the share target to it (direct share). */
    public static final String CATEGORY = "cz.m5cet.app.category.ROOM";
    /** This version's ids, and 6.7's ("room-" + the room key's String.hashCode) — both the app's own. */
    public static final String PREFIX = "conv-", OLD_PREFIX = "room-";
    /** At most this many dynamic shortcuts (the share sheet shows 4–8, the launcher 4–5); fewer when the system allows fewer. */
    public static final int LIMIT = 8;
    /** Changes close together are published once. */
    public static final long DEBOUNCE_MS = 1_500;
    /** A new order alone (activity) is published at most this often, and only with the app in the foreground. */
    public static final long RANK_EVERY_MS = 5 * 60_000L;
    /** when(): publish now / nothing to do / when the app is next in the foreground (else: in that many ms). */
    public static final long NOW = 0, NOTHING = -2, ON_FOREGROUND = -1;

    /** The settings' keys and defaults (core/Settings.DEFAULTS). */
    public static void defaults(Map<String, Object> d) {
        d.put(SETTING_ON, true);    // the joined rooms as conversation shortcuts (Conversations, Share, the launcher); off removes them
        d.put(SETTING_NAMES, true); // with the room's name — only while the app is unlocked and notifications may name the room
    }

    /** A room as the plan needs it: its key, label, latest activity, and whether it is joined (selected or connected). */
    public static final class Room {
        public final String key, label;
        public final long activity;
        public final boolean joined;

        public Room(String key, String label, long activity, boolean joined) {
            this.key = key; this.label = label; this.activity = activity; this.joined = joined;
        }
    }

    /** One conversation shortcut: id, room, label, monogram (glyph + colour seed), rank (0 = most recent), named or neutral. */
    public static final class Entry {
        public final String id, key, label, glyph, seed;
        public final int rank;
        public final boolean named;

        Entry(String id, String key, String label, String glyph, String seed, int rank, boolean named) {
            this.id = id; this.key = key; this.label = label; this.glyph = glyph; this.seed = seed; this.rank = rank; this.named = named;
        }
    }

    /**
     * Whether shortcuts carry the room's name: the user wants it, the app is
     * not locked (audit S11, as notifications), and notifications may name
     * the room (privacy rank ≥ "room" = 2) — the system shows a conversation
     * notification under its shortcut's label.
     */
    public static boolean names(boolean wanted, boolean locked, int privacyRank) { return wanted && !locked && privacyRank >= 2; }

    /** How many dynamic shortcuts: LIMIT, or the system's maximum when lower. */
    public static int cap(int systemMax) { return Math.max(0, Math.min(LIMIT, systemMax)); }

    /** A room's shortcut id: "conv-" + 80 bits of HMAC-SHA256(secret, room key) — stable for this install, nothing of the name. */
    public static String id(byte[] secret, String roomKey) {
        return PREFIX + Crypto.hex(Crypto.hmac256(secret, Crypto.utf8("m5cet/conversation\u0000" + roomKey))).substring(0, 20);
    }

    /** Whether a shortcut id is one of the app's conversations (this version's or 6.7's). */
    public static boolean ours(String id) { return id != null && (id.startsWith(PREFIX) || id.startsWith(OLD_PREFIX)); }

    /** A neutral label: the design's "Conversation {n}" (a design without it: "M5cet {n}"). */
    public static String neutral(String template, int n) {
        String t = template == null || !template.contains("{n}") ? "M5cet {n}" : template;
        return t.replace("{n}", Integer.toString(n));
    }

    /**
     * Every joined room as a conversation, the most recently active first
     * (ties: by key). Named: the room's label (its key when it has none).
     * Neutral: numbered in the order of the ids — stable while the same
     * rooms are joined, and unrelated to names or activity.
     */
    public static List<Entry> plan(List<Room> rooms, Function<String, String> idOf, boolean names, String neutralTemplate) {
        List<Room> joined = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (Room r : rooms) if (r != null && r.joined && r.key != null && !r.key.isEmpty() && seen.add(r.key)) joined.add(r);
        joined.sort((a, b) -> a.activity != b.activity ? Long.compare(b.activity, a.activity) : a.key.compareTo(b.key));
        List<String> ids = new ArrayList<>();
        for (Room r : joined) ids.add(idOf.apply(r.key));
        List<String> sorted = new ArrayList<>(ids);
        Collections.sort(sorted);
        List<Entry> out = new ArrayList<>();
        for (int i = 0; i < joined.size(); i++) {
            Room r = joined.get(i);
            String id = ids.get(i);
            if (names) {
                String name = r.label == null || r.label.trim().isEmpty() ? r.key : r.label.trim();
                out.add(new Entry(id, r.key, name, Avatars.glyph(name, null), name, i, true));
            } else {
                int n = sorted.indexOf(id) + 1;
                out.add(new Entry(id, r.key, neutral(neutralTemplate, n), Integer.toString(n), Integer.toString(n), i, false));
            }
        }
        return out;
    }

    /** Neutral entries for shortcuts known only by id (a start while locked: the rooms are not readable), numbered in id order. */
    public static List<Entry> neutralOf(Collection<String> ids, String neutralTemplate) {
        List<String> sorted = new ArrayList<>(new LinkedHashSet<>(ids));
        Collections.sort(sorted);
        List<Entry> out = new ArrayList<>();
        for (int i = 0; i < sorted.size(); i++) {
            String n = Integer.toString(i + 1);
            out.add(new Entry(sorted.get(i), "", neutral(neutralTemplate, i + 1), n, n, i, false));
        }
        return out;
    }

    /** The first `cap` entries (the dynamic shortcuts). */
    public static List<Entry> top(List<Entry> all, int cap) { return new ArrayList<>(all.subList(0, Math.max(0, Math.min(cap, all.size())))); }

    public static Set<String> ids(Collection<Entry> entries) {
        Set<String> out = new LinkedHashSet<>();
        for (Entry e : entries) out.add(e.id);
        return out;
    }

    public static Map<String, Entry> byId(Collection<Entry> entries) {
        Map<String, Entry> out = new HashMap<>();
        for (Entry e : entries) out.put(e.id, e);
        return out;
    }

    /**
     * The app's shortcuts that have to go: its own ids (this version's and
     * 6.7's) not kept — a room left, deleted or renamed (a new name is a new
     * room), every one when conversations are off (keep empty). Each once, in
     * the order given; anything not the app's own is left alone.
     */
    public static List<String> stale(Collection<String> existing, Set<String> keep) {
        Set<String> out = new LinkedHashSet<>();
        for (String id : existing) if (ours(id) && !keep.contains(id)) out.add(id);
        return new ArrayList<>(out);
    }

    /** What the system shows of the conversations (which ones, their labels, named or not) — not their order. */
    public static String setSignature(List<Entry> all, boolean names) {
        List<String> parts = new ArrayList<>();
        for (Entry e : all) parts.add(e.id + "=" + e.label);
        Collections.sort(parts);
        return (names ? "named|" : "neutral|") + String.join("\u0000", parts);
    }

    /** Their order (the ranks, and which ones are dynamic). */
    public static String rankSignature(List<Entry> all) {
        List<String> parts = new ArrayList<>();
        for (Entry e : all) parts.add(e.id);
        return String.join(",", parts);
    }

    /**
     * When to publish a new plan: a change of what the system shows (a room
     * joined or gone, a name ↔ neutral, a rename) at once — a name must not
     * outlive the lock; a new order alone at most every RANK_EVERY_MS and
     * only in the foreground (in the background the system allows few calls;
     * a notification adds its own room's shortcut anyway).
     */
    public static long when(boolean setChanged, boolean rankChanged, boolean foreground, long now, long lastAt) {
        if (setChanged) return NOW;
        if (!rankChanged) return NOTHING;
        if (!foreground) return ON_FOREGROUND;
        long wait = lastAt + RANK_EVERY_MS - now;
        return wait <= 0 ? NOW : wait;
    }

    /** A colour with alpha laid over white, opaque (an icon has nothing under it). */
    public static int opaque(int argb) {
        int a = (argb >>> 24) & 0xff;
        int r = ((argb >> 16) & 0xff) * a / 255 + 255 * (255 - a) / 255;
        int g = ((argb >> 8) & 0xff) * a / 255 + 255 * (255 - a) / 255;
        int b = (argb & 0xff) * a / 255 + 255 * (255 - a) / 255;
        return 0xff000000 | (r << 16) | (g << 8) | b;
    }

    /** The monogram's background, as the web's tint (Avatars.background) on white. */
    public static int background(String seed) { return opaque(Avatars.hsl(Avatars.hue(seed), 0.62f, 0.42f, 0.22f)); }

    /** The monogram's letter (Avatars.foreground). */
    public static int foreground(String seed) { return Avatars.hsl(Avatars.hue(seed), 0.70f, 0.42f, 1f); }
}
