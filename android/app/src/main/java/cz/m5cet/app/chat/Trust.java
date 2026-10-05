package cz.m5cet.app.chat;

/**
 * 6.12: a peer's identity state (docs/protocol-v4.md § 12.1). Pure (JVM tests).
 *
 *   new       first time this key is seen (trust on first use) — "new key — not verified", never "verified"
 *   verified  the person compared the safety number (the device key), or verified the account it belongs to
 *   account   certified by an account key that is pinned (across rooms) but not verified — shown as the account's state
 *   changed   a different key for a pinned name or account, or a device key-transparency shows revoked:
 *             a red warning, and its messages are held until the person accepts
 *
 * The protocol is a separate fact: a protocol-3 peer is "older protocol (no
 * PCS / PQ)" whatever its trust (`legacy` in the spec's table).
 */
final class Trust {
    private Trust() {}

    static final String NEW = "new", VERIFIED = "verified", ACCOUNT = "account", CHANGED = "changed";

    /**
     * @param attested     the hello's account certificate is valid for this device key
     * @param accountPin   the account pin's verdict for an attested device: new, match, changed (null when not attested)
     * @param namePin      the (room, name) pin's verdict: new, match, changed
     * @param deviceVerified the person verified this device key (safety number)
     * @param accountVerified the person verified the account
     * @param ktRevoked    key transparency shows this device revoked, or the account key replaced
     */
    static String of(boolean attested, String accountPin, String namePin, boolean deviceVerified, boolean accountVerified, boolean ktRevoked) {
        if (ktRevoked) return CHANGED;
        if (attested) {
            if ("changed".equals(accountPin)) return CHANGED;
            // A first-seen account under a name pinned to another, unattested key: as a changed key.
            if ("new".equals(accountPin) && "changed".equals(namePin)) return CHANGED;
            if (accountVerified || deviceVerified) return VERIFIED;
            return ACCOUNT;
        }
        if ("changed".equals(namePin)) return CHANGED;
        return deviceVerified ? VERIFIED : NEW;
    }
}
