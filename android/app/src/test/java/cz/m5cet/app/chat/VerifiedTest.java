package cz.m5cet.app.chat;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import cz.m5cet.app.security.Ec;

/** 6.7 (audit S15): "verified" means signed by the key pinned for the name the message is shown under. */
public class VerifiedTest {
    private static final String ALICE = Ec.spki(Ec.generate().getPublic());
    private static final String MALLORY = Ec.spki(Ec.generate().getPublic());

    private static Envelopes.Signer signed(String key, boolean valid) { return new Envelopes.Signer(key, valid, null, false); }

    @Test
    public void peerToPeer() {
        assertTrue(Verified.p2p(signed(ALICE, true), ALICE, false, "Alice", "alice "));
        // The attack: a member signs a message as "Alice" with a valid signature of their own key.
        assertFalse(Verified.p2p(signed(MALLORY, true), ALICE, false, "Alice", "Alice"));
        // Mallory's own channel, Alice's name in the payload.
        assertFalse(Verified.p2p(signed(MALLORY, true), MALLORY, false, "Alice", "Mallory"));
        assertFalse(Verified.p2p(signed(ALICE, false), ALICE, false, "Alice", "Alice"));   // bad signature
        assertFalse(Verified.p2p(signed(ALICE, true), ALICE, true, "Alice", "Alice"));     // the pin changed
        assertFalse(Verified.p2p(null, ALICE, false, "Alice", "Alice"));                   // unsigned
        assertFalse(Verified.p2p(signed(ALICE, true), null, false, "Alice", "Alice"));     // no hello yet
        assertFalse(Verified.p2p(signed(ALICE, true), ALICE, false, "", ""));
    }

    @Test
    public void throughTheRelay() {
        assertTrue(Verified.relay(signed(ALICE, true), Ec.kid(ALICE)));
        assertFalse(Verified.relay(signed(MALLORY, true), Ec.kid(ALICE)));  // signed, but not by Alice's pinned key
        assertFalse(Verified.relay(signed(ALICE, true), ""));              // nobody pinned under that name
        assertFalse(Verified.relay(signed(ALICE, false), Ec.kid(ALICE)));
        assertFalse(Verified.relay(signed("not a key", true), Ec.kid(ALICE)));
        assertFalse(Verified.relay(null, Ec.kid(ALICE)));
    }
}
