package cz.m5cet.app.security;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.json.JSONObject;
import org.junit.Test;

import java.security.GeneralSecurityException;

/**
 * 6.12 (security analysis F-16): the PIN wrap — a 6.11 install (v 1, the
 * pepper) still opens, and moves to v 2 (the checked PIN key) with the same
 * data key, so no data is lost on the upgrade.
 */
public class PinWrapTest {
    private static final int IT = 1_000;
    /** The Keystore's two keys, as fixed HMAC keys: m5.pep (v 1) and m5.pin (v 2). */
    private static final byte[] PEPPER = Crypto.random(32), PIN_KEY = Crypto.random(32);
    private static final PinWrap.Kek KEK = (stretched, version) -> version >= 2
        ? Crypto.hmac256(PIN_KEY, Crypto.concat(Crypto.utf8("m5/pin/2|"), stretched))
        : Crypto.hmac256(PEPPER, stretched);

    private static byte[] stretch(String pin, JSONObject wrap) throws GeneralSecurityException {
        return Crypto.pbkdf2(Crypto.utf8(pin), PinWrap.salt(wrap), PinWrap.iterations(wrap), 32);
    }

    /** A wrap exactly as 6.11's Vault wrote it (no "v": HMAC(m5.pep, PBKDF2), AAD "m5/user.pin"). */
    private static JSONObject v611(byte[] dek, String pin) throws Exception {
        byte[] salt = Crypto.random(16), iv = Crypto.random(12);
        byte[] kek = Crypto.hmac256(PEPPER, Crypto.pbkdf2(Crypto.utf8(pin), salt, IT, 32));
        byte[] ct = Crypto.gcmSeal(kek, iv, dek, Crypto.utf8("m5/user.pin"));
        return new JSONObject().put("salt", Crypto.b64(salt)).put("iter", IT).put("iv", Crypto.b64(iv)).put("ct", Crypto.b64(ct));
    }

    @Test
    public void a611WrapOpensAndMovesWithTheSameDataKey() throws Exception {
        byte[] dek = Crypto.random(32);
        JSONObject old = v611(dek, "246810");
        assertEquals(1, PinWrap.version(old));
        assertNull("a wrong PIN", PinWrap.open(old, stretch("246811", old), KEK));
        byte[] stretched = stretch("246810", old);
        byte[] opened = PinWrap.open(old, stretched, KEK);
        assertArrayEquals(dek, opened);
        // The move: the PBKDF2 output of that unlock seals v 2 — same salt and iterations.
        JSONObject moved = PinWrap.moved(old, opened, stretched, "strongbox", KEK);
        assertEquals(2, PinWrap.version(moved));
        assertEquals("strongbox", moved.getString("hw"));
        assertEquals(old.getString("salt"), moved.getString("salt"));
        assertEquals(old.getInt("iter"), moved.getInt("iter"));
        assertArrayEquals(dek, PinWrap.open(moved, stretch("246810", moved), KEK));
        assertNull(PinWrap.open(moved, stretch("000000", moved), KEK));
        // v 2 needs the PIN key — the old pepper does not open it.
        PinWrap.Kek pepperOnly = (s, v) -> Crypto.hmac256(PEPPER, s);
        assertNull(PinWrap.open(moved, stretch("246810", moved), pepperOnly));
    }

    @Test
    public void theVersionIsBoundToTheCiphertext() throws Exception {
        byte[] dek = Crypto.random(32);
        JSONObject v2 = PinWrap.seal(dek, Crypto.pbkdf2(Crypto.utf8("1357"), Crypto.utf8("0123456789abcdef"), IT, 32), Crypto.utf8("0123456789abcdef"), IT, 2, "tee", KEK);
        // A v 2 wrap relabelled as v 1 (its "v" removed): it does not open under v 1's rules.
        JSONObject relabelled = new JSONObject(v2.toString());
        relabelled.remove("v");
        assertNull(PinWrap.open(relabelled, stretch("1357", relabelled), KEK));
        // The same KEK under the other version's AAD fails too.
        PinWrap.Kek sameKek = (s, v) -> KEK.of(s, 2);
        assertNull(PinWrap.open(relabelled, stretch("1357", relabelled), sameKek));
        assertFalse(java.util.Arrays.equals(PinWrap.aad(1), PinWrap.aad(2)));
        assertTrue(new String(PinWrap.aad(1), "UTF-8").equals("m5/user.pin"));
    }

    @Test
    public void aDamagedWrapIsAnErrorNotAWrongPin() throws Exception {
        JSONObject bad = v611(Crypto.random(32), "1111").put("iv", "%%%");
        try {
            PinWrap.open(bad, stretch("1111", bad), KEK);
            fail("a damaged wrap is an error (logged), not a wrong PIN");
        } catch (GeneralSecurityException expected) { }
        try { PinWrap.salt(new JSONObject()); fail(); } catch (GeneralSecurityException expected) { }
        try { PinWrap.iterations(new JSONObject()); fail(); } catch (GeneralSecurityException expected) { }
    }
}
