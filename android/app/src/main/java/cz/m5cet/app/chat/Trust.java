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
     * Review P08: an account the person verified under `verifiedName` counts
     * as verified under display name `name` only when it is that name ("" —
     * verified before the fix, the name unknown — any name).
     */
    static boolean verifiedUnder(String verifiedName, String name) {
        return verifiedName == null || verifiedName.isEmpty() || Verified.sameName(verifiedName, name);
    }

    /** Without the key-transparency gate (a server without key transparency, a relayed message). */
    static String of(boolean attested, String accountPin, String namePin, boolean deviceVerified, boolean accountVerified, boolean ktRevoked) {
        return of(attested, accountPin, namePin, deviceVerified, accountVerified, ktRevoked, true);
    }

    /**
     * @param attested     the hello's account certificate is valid for this device key
     * @param accountPin   the account pin's verdict for an attested device: new, match, changed (null when not attested)
     * @param namePin      the (room, name) pin's verdict: new, match, changed
     * @param deviceVerified the person verified this device key (safety number)
     * @param accountVerified the person verified the account — under the name it shows now (review P08)
     * @param ktRevoked    key transparency shows this device revoked, or the account key replaced
     * @param ktConfirmed  key transparency confirms the account and the device (a verified lookup includes both),
     *                     or this server runs no key transparency — § 14.4 / review P04: without it an attested
     *                     device is never "account" or "verified" by its account, only "new" (its device key on first use)
     */
    static String of(boolean attested, String accountPin, String namePin, boolean deviceVerified, boolean accountVerified, boolean ktRevoked, boolean ktConfirmed) {
        if (ktRevoked) return CHANGED;
        if (attested) {
            if ("changed".equals(accountPin)) return CHANGED;
            // A first-seen account under a name pinned to another, unattested key: as a changed key.
            if ("new".equals(accountPin) && "changed".equals(namePin)) return CHANGED;
            if (deviceVerified) return VERIFIED;
            if (!ktConfirmed) return NEW;
            return accountVerified ? VERIFIED : ACCOUNT;
        }
        if ("changed".equals(namePin)) return CHANGED;
        return deviceVerified ? VERIFIED : NEW;
    }
}
