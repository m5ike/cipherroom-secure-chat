package cz.m5cet.app.security;

/**
 * 6.10 (security analysis G-23): extras the app takes only from its own
 * intents. The main activity is exported (the launcher, shares, links) and
 * took a "room" extra from any app — opening, and connecting, a room the
 * user had left; the direct reply's PendingIntent must be mutable (the
 * system fills in the typed text), so whoever holds it (a notification
 * listener) could also replace its "room" and send the reply elsewhere.
 *
 * Every such extra now travels with a tag: HMAC-SHA256 under a key that
 * exists only in this process (made at its start, never stored), over what
 * the intent is for and the value. Another app cannot make one, and a tag
 * fits only its own value and purpose. A tag from an earlier process is no
 * longer valid: its notification opens the app, not the room.
 */
public final class IntentSeal {
    private IntentSeal() {}

    /** The extra that carries the tag. */
    public static final String EXTRA = "cz.m5cet.seal";
    /** What a tag is for: a notification opening its room, a direct reply into one. */
    public static final String OPEN = "open", REPLY = "reply";

    private static final byte[] KEY = Crypto.random(32);

    /** The tag of a value for a purpose under a key: 128 bits of HMAC-SHA256, base64url. */
    static String tag(byte[] key, String purpose, String value) {
        byte[] mac = Crypto.hmac256(key, Crypto.utf8("m5cet/intent\u0000" + purpose + "\u0000" + value));
        return Crypto.b64url(java.util.Arrays.copyOf(mac, 16));
    }

    /** Whether a tag is this key's for the purpose and value (in constant time). */
    static boolean valid(byte[] key, String purpose, String value, String tag) {
        if (purpose == null || value == null || tag == null || value.isEmpty()) return false;
        return Crypto.same(Crypto.utf8(tag(key, purpose, value)), Crypto.utf8(tag));
    }

    /** This process's tag of a value. */
    public static String tag(String purpose, String value) { return tag(KEY, purpose, value); }

    /** Whether the tag is this process's for the purpose and value. */
    public static boolean valid(String purpose, String value, String tag) { return valid(KEY, purpose, value, tag); }
}
