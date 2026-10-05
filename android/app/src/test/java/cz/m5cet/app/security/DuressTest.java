package cz.m5cet.app.security;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

/**
 * 6.12 (security analysis F-16): the duress PIN's verifier — only it is
 * kept (HMAC by a Keystore key over PBKDF2 of the PIN), it matches exactly
 * its PIN, and it may not be the unlock PIN.
 */
public class DuressTest {
    private static final int IT = 2_000; // the app uses Vault.PIN_ITERATIONS; fewer here for speed
    private static final byte[] KEY = Crypto.random(32), OTHER = Crypto.random(32);
    private static final Duress.Mac MAC = data -> Crypto.hmac256(KEY, data);

    @Test
    public void theVerifierMatchesItsPinOnly() throws Exception {
        JSONObject v = Duress.verifier("135790", Crypto.random(16), IT, MAC);
        assertEquals(IT, v.getInt("iter"));
        assertFalse("no PIN in it", v.toString().contains("135790"));
        assertTrue(Duress.matches(v, "135790", MAC));
        assertFalse(Duress.matches(v, "135791", MAC));
        assertFalse(Duress.matches(v, "", MAC));
        assertFalse(Duress.matches(v, null, MAC));
        // Another phone's Keystore key: it does not match (no guessing without this phone).
        assertFalse(Duress.matches(v, "135790", data -> Crypto.hmac256(OTHER, data)));
        // The same PIN with another salt is another verifier.
        assertNotEquals(v.getString("tag"), Duress.verifier("135790", Crypto.random(16), IT, MAC).getString("tag"));
    }

    @Test
    public void aDamagedVerifierMatchesNothing() throws Exception {
        JSONObject v = Duress.verifier("2468", Crypto.random(16), IT, MAC);
        assertFalse(Duress.matches(null, "2468", MAC));
        assertFalse(Duress.matches(new JSONObject(), "2468", MAC));
        assertFalse(Duress.matches(new JSONObject(v.toString()).put("tag", "not base64 !"), "2468", MAC));
        assertFalse(Duress.matches(new JSONObject(v.toString()).put("iter", 10), "2468", MAC));
        assertFalse(Duress.matches(new JSONObject(v.toString()).put("iter", 50_000_000), "2468", MAC));
        assertFalse(Duress.matches(v, "2468", data -> { throw new java.security.GeneralSecurityException("no key"); }));
    }

    @Test
    public void whichDuressPinsAreRefused() {
        assertNull(Duress.refusal("123456", 6, false));
        assertEquals("same", Duress.refusal("123456", 6, true));
        // The lock pad takes exactly the policy's length.
        assertEquals("length", Duress.refusal("12345", 6, false));
        assertEquals("length", Duress.refusal("1234567", 6, false));
        assertEquals("length", Duress.refusal("12a456", 6, false));
        assertEquals("length", Duress.refusal(null, 6, false));
        assertNull(Duress.refusal("0000", 4, false));
        assertEquals("security.duress", Duress.SETTING);
    }
}
