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

    /**
     * Review P09: is "forwarded from X" (`fwd.forwardedFrom`) backed by an
     * original in `messages` — the same text, from the device key pinned for
     * X in this room (`pinnedKid`), or mine when X is my name (`myName`)? Not
     * by a message whose identity changed (held), a forward itself, or the
     * forwarder's own message under another name.
     */
    static boolean forward(ChatMessage fwd, java.util.List<ChatMessage> messages, String pinnedKid, String myName) {
        if (fwd == null || fwd.forwardedFrom == null || fwd.forwardedFrom.trim().isEmpty() || messages == null) return false;
        String text = fwd.visibleText();
        if (text == null || text.isEmpty()) return false;
        for (ChatMessage x : messages) {
            if (x == fwd || x.forwardedFrom != null || x.changed || "sys".equals(x.kind) || !text.equals(x.visibleText())) continue;
            if (x.mine && fwd.mine) continue; // the forwarder's own
            if (!x.mine && !fwd.mine && x.senderId != null && x.senderId.equals(fwd.senderId)) continue;
            if (x.mine) { if (sameName(fwd.forwardedFrom, myName)) return true; continue; }
            if (pinnedKid != null && !pinnedKid.isEmpty() && pinnedKid.equals(x.senderKid) && sameName(x.senderName, fwd.forwardedFrom)) return true;
        }
        return false;
    }

    /** As the pins are keyed: trimmed, case-insensitive. */
    static boolean sameName(String a, String b) {
        if (a == null || b == null) return false;
        String x = a.trim().toLowerCase(Locale.ROOT), y = b.trim().toLowerCase(Locale.ROOT);
        return !x.isEmpty() && x.equals(y);
    }
}
