package cz.m5cet.app.account;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

import java.util.HashSet;
import java.util.Set;

import cz.m5cet.app.security.Crypto;

/** The recovery code against the web (client/src/lib/recovery.ts: recoveryMaterial, normalizeRecoveryCode). */
public class RecoveryCodeTest {
    @Test
    public void materialAsTheWeb() {
        RecoveryCode.Material m = RecoveryCode.material("0123456789ABCDEFGHJKMNPQRS");
        assertEquals("cR844GIEoW3PHRm2pbnsKNTM", m.id);
        assertEquals("4Rrk2qDybJ22G_nylVw53ScZHfAIv6TPwbWKO3eQiks", m.proof);
        assertEquals("1fa55f656bd8467599a6a2d03a859114d2cc24d5b606a55ff97dbded605e0137", m.verifier);
        assertEquals("crIBSDzsoabt3c7bvJbZwtruVUXaa62hxrOMaaMLGHE=", Crypto.b64(m.secret));
        // What the server's store accepts (setRecovery).
        assertTrue(m.id.matches("[A-Za-z0-9_-]{16,64}"));
        assertTrue(m.verifier.matches("[0-9a-f]{64}"));
        // Grouped, lower case, look-alikes: the same material.
        assertEquals(m.id, RecoveryCode.material("oi234-56789-abcde-fghjk-mnpqr-s").id);
    }

    @Test
    public void normalize() {
        assertEquals("0123456789ABCDEFGHJKMNPQRS", RecoveryCode.normalize("oi23-4567 89ab-cdef-ghjk-mnpq-rs"));
        assertEquals("0123456789ABCDEFGHJKMNPQRV", RecoveryCode.normalize("0123456789ABCDEFGHJKMNPQRU"));
        assertNull(RecoveryCode.normalize("0123456789ABCDEFGHJKMNPQR"));     // 25
        assertNull(RecoveryCode.normalize("0123456789ABCDEFGHJKMNPQRST"));   // 27
        assertNull(RecoveryCode.normalize("0123456789ABCDEFGHJKMNPQR!"));
        assertNull(RecoveryCode.normalize(null));
        try { RecoveryCode.material("nope"); fail(); } catch (IllegalArgumentException expected) { }
    }

    @Test
    public void generate() {
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < 200; i++) {
            String c = RecoveryCode.generate();
            assertTrue(c, c.matches("([0-9A-HJKMNP-TV-Z]{5}-){5}[0-9A-HJKMNP-TV-Z]"));
            assertEquals(c.replace("-", ""), RecoveryCode.normalize(c));
            seen.add(c);
        }
        assertEquals(200, seen.size());
        assertNotEquals(RecoveryCode.material(RecoveryCode.generate()).id, RecoveryCode.material(RecoveryCode.generate()).id);
    }
}
