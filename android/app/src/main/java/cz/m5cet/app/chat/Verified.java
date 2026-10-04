package cz.m5cet.app.chat;

import java.util.Locale;

import cz.m5cet.app.security.Ec;

/**
 * 6.7 (audit S15 / F-07): what the "verified" mark of a message means — it
 * is signed by the key that is pinned for the name it is shown under. A
 * valid signature by just any key (a member signing as "Alice" with their own
 * key) is not enough. Pure (JVM tests).
 */
final class Verified {
    private Verified() {}

    /**
     * Over the peer-to-peer channel: signed by the key the sender's hello
     * presented (and pinned under the peer's name), that pin did not change,
     * and the message carries the same name.
     */
    static boolean p2p(Envelopes.Signer signer, String helloKey, boolean changed, String claimedName, String peerName) {
        if (signer == null || !signer.valid || changed) return false;
        if (helloKey == null || helloKey.isEmpty() || !helloKey.equals(signer.publicKey)) return false;
        return sameName(claimedName, peerName);
    }

    /** Through the relay (no hello): signed by the key pinned for the name the message carries. */
    static boolean relay(Envelopes.Signer signer, String pinnedKid) {
        if (signer == null || !signer.valid || pinnedKid == null || pinnedKid.isEmpty()) return false;
        try { return Ec.kid(signer.publicKey).equals(pinnedKid); }
        catch (RuntimeException e) { return false; }
    }

    /** As the pins are keyed: trimmed, case-insensitive. */
    static boolean sameName(String a, String b) {
        if (a == null || b == null) return false;
        String x = a.trim().toLowerCase(Locale.ROOT), y = b.trim().toLowerCase(Locale.ROOT);
        return !x.isEmpty() && x.equals(y);
    }
}
