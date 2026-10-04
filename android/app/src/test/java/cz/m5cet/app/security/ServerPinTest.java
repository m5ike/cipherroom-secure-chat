package cz.m5cet.app.security;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

import java.util.Locale;

/** 6.7 (audit V6): the enrolment pin binds the server's public key, not the kid string the server sends. */
public class ServerPinTest {
    private static final String KEY = Ec.spki(Ec.generate().getPublic());
    private static final String OTHER = Ec.spki(Ec.generate().getPublic());

    @Test
    public void theRightKeyPasses() {
        String kid = Ec.kid(KEY);
        assertEquals(kid, ServerPin.check(KEY, kid));
        assertEquals(kid, ServerPin.check(KEY, kid, "", null, kid));
        assertEquals(kid, ServerPin.check(KEY, kid, Ec.fingerprint(KEY), kid));
    }

    /** The attack of V6: a forged server repeats the expected kid but sends its own key. */
    @Test
    public void aForgedServerRepeatingTheKidIsRefused() {
        String pinned = Ec.kid(KEY);
        expectRefusal(() -> ServerPin.check(OTHER, pinned, pinned), "does not match the key id");
        // …or states its own kid honestly: then the pin catches it.
        expectRefusal(() -> ServerPin.check(OTHER, Ec.kid(OTHER), pinned), "is not the pinned key");
        expectRefusal(() -> ServerPin.check(OTHER, Ec.kid(OTHER), "", pinned), "is not the pinned key");
    }

    @Test
    public void everyFormOfThePinNamesTheKey() {
        byte[] hash = Crypto.sha256(Crypto.unb64(KEY));
        String hex = Crypto.hex(hash);
        assertTrue(ServerPin.matches(KEY, Ec.kid(KEY)));
        assertTrue(ServerPin.matches(KEY, Ec.fingerprint(KEY)));                       // "ABCD EF01 …" (first 16 bytes)
        assertTrue(ServerPin.matches(KEY, Ec.fingerprint(KEY).replace(" ", "")));
        assertTrue(ServerPin.matches(KEY, hex));
        assertTrue(ServerPin.matches(KEY, hex.toUpperCase(Locale.ROOT).replaceAll("(..)(?!$)", "$1:")));
        assertTrue(ServerPin.matches(KEY, Crypto.b64url(hash)));
        assertTrue(ServerPin.matches(KEY, Crypto.b64(hash)));
        assertTrue(ServerPin.matches(KEY, "  " + Ec.kid(KEY) + " "));
        for (String other : new String[]{Ec.kid(OTHER), Ec.fingerprint(OTHER), Crypto.hex(Crypto.sha256(Crypto.unb64(OTHER))), "", "x", hex.substring(0, 40)}) {
            assertFalse(other, ServerPin.matches(KEY, other));
        }
        assertFalse(ServerPin.matches(KEY, null));
    }

    @Test
    public void aBrokenKeyIsRefused() {
        expectRefusal(() -> ServerPin.check("", "abc"), "no key");
        expectRefusal(() -> ServerPin.check(null, "abc"), "no key");
        expectRefusal(() -> ServerPin.check("not base64!", "abc"), "not a valid P-256 key");
        expectRefusal(() -> ServerPin.check(Crypto.b64(new byte[91]), "abc"), "not a valid P-256 key");
        expectRefusal(() -> ServerPin.check(KEY, null), "does not match the key id");
    }

    @Test
    public void theKeyMustNotChangeDuringEnrolment() {
        ServerPin.same(KEY, KEY, Ec.kid(KEY));
        expectRefusal(() -> ServerPin.same(KEY, OTHER, Ec.kid(OTHER)), "changed its key");
        expectRefusal(() -> ServerPin.same(KEY, KEY, Ec.kid(OTHER)), "does not match the key id");
        expectRefusal(() -> ServerPin.same("", "", ""), "changed its key");
    }

    private static void expectRefusal(Runnable r, String words) {
        try {
            r.run();
            fail("accepted, expected: " + words);
        } catch (SecurityException e) {
            assertTrue(e.getMessage(), e.getMessage().contains(words));
        }
    }
}
