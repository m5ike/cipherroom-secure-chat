package cz.m5cet.app.contacts;

import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * 6.2 Contacts: who a phone contact's "message / call via M5cet" goes to.
 * A link holds an account's username (the main user identifier; a guest's
 * per-session username is not one), so the person must be signed in: the
 * server reports an account on their connection and their hello names the
 * username. Of the connected rooms the active one wins, then the most
 * recently active one.
 */
public final class Match {
    private Match() {}

    /** How long a lookup waits for rooms and peers that are still connecting before it says "not online". */
    public static final long WAIT_MS = 15_000;

    public static final String FOUND = "found", WAIT = "wait", MISSING = "missing";

    private static final Pattern USERNAME = Pattern.compile("^[A-Za-z0-9_-]{3,64}$");

    /** cleanUsername() of username.ts: what a peer says its username is — short and plain, or nothing. */
    public static String cleanUsername(Object value) {
        if (!(value instanceof String)) return "";
        String v = ((String) value).trim();
        return USERNAME.matcher(v).matches() ? v : "";
    }

    /** A person can be linked with a phone contact: signed in, with an account username. */
    public static boolean canLink(String username, boolean signedIn) {
        return signedIn && !cleanUsername(username).isEmpty();
    }

    /** The key a link is kept under (usernames are unique case-insensitively on the server). */
    public static String key(String username) { return cleanUsername(username).toLowerCase(Locale.ROOT); }

    /** One person of one connected room. */
    public static final class Candidate {
        public final String roomKey, peerId, username;
        public final boolean signedIn, open, activeRoom;
        public final long roomActivity;

        public Candidate(String roomKey, String peerId, String username, boolean signedIn, boolean open, boolean activeRoom, long roomActivity) {
            this.roomKey = roomKey;
            this.peerId = peerId;
            this.username = username == null ? "" : username;
            this.signedIn = signedIn;
            this.open = open;
            this.activeRoom = activeRoom;
            this.roomActivity = roomActivity;
        }
    }

    /** The person to reach: this username, signed in, a channel open; the active room first, then the most recently active. null = nobody. */
    public static Candidate pick(List<Candidate> candidates, String username) {
        String want = key(username);
        if (want.isEmpty() || candidates == null) return null;
        Candidate best = null;
        for (Candidate c : candidates) {
            if (!c.open || !c.signedIn || !key(c.username).equals(want)) continue;
            if (best == null || better(c, best)) best = c;
        }
        return best;
    }

    private static boolean better(Candidate a, Candidate b) {
        if (a.activeRoom != b.activeRoom) return a.activeRoom;
        return a.roomActivity > b.roomActivity;
    }

    /**
     * found: act; wait: rooms or peers are still settling and the lookup has
     * not waited WAIT_MS yet; missing: say that the person is not online.
     */
    public static String decide(boolean found, boolean settling, long startedAt, long now) {
        if (found) return FOUND;
        return settling && now - startedAt < WAIT_MS ? WAIT : MISSING;
    }
}
