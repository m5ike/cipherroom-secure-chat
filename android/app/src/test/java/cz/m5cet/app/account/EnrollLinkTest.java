package cz.m5cet.app.account;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** The console's enrolment link (m5cet://enroll?server=…&code=…&kid=…, server/android/admin-routes.ts). */
public class EnrollLinkTest {
    private static final String KID = "DbEdmBPXJKyqeplx";

    @Test
    public void theConsolesLink() {
        // As URLSearchParams writes it: server first, then kid; no code for an open server.
        EnrollLink l = EnrollLink.parse("m5cet://enroll?server=https%3A%2F%2Fchat.fir.ma&kid=" + KID);
        assertNotNull(l);
        assertEquals("https://chat.fir.ma", l.server);
        assertEquals("", l.code);
        assertEquals(KID, l.kid);

        l = EnrollLink.parse("m5cet://enroll?server=https%3A%2F%2Fchat.fir.ma&kid=" + KID + "&code=ABCD-EFGH-JKLM");
        assertNotNull(l);
        assertEquals("ABCD-EFGH-JKLM", l.code);
    }

    @Test
    public void theServerIsNormalised() {
        assertEquals("https://chat.fir.ma", EnrollLink.parse("m5cet://enroll?server=chat.fir.ma").server);
        assertEquals("https://chat.fir.ma", EnrollLink.parse("m5cet://enroll?server=HTTPS%3A%2F%2FChat.Fir.MA%2F%2F").server);
        assertEquals("https://chat.example.com:8443/m5", EnrollLink.parse("m5cet://enroll?server=https%3A%2F%2Fchat.example.com%3A8443%2Fm5%2F").server);
        assertEquals("http://192.168.1.20:5000", EnrollLink.parse("m5cet://enroll?server=http%3A%2F%2F192.168.1.20%3A5000").server);
        // Not encoded at all still works (a hand-made link).
        assertEquals("https://chat.fir.ma", EnrollLink.parse("m5cet://enroll?server=https://chat.fir.ma&kid=" + KID).server);
        // Spaces around it (form encoding: + is a space).
        assertEquals("https://chat.fir.ma", EnrollLink.parse("m5cet://enroll?server=+chat.fir.ma+").server);
    }

    @Test
    public void notAServer() {
        assertNull(EnrollLink.parse("m5cet://enroll"));
        assertNull(EnrollLink.parse("m5cet://enroll?kid=" + KID));
        assertNull(EnrollLink.parse("m5cet://enroll?server="));
        assertNull(EnrollLink.parse("m5cet://enroll?server=%20%20"));
        assertNull(EnrollLink.parse("m5cet://enroll?server=javascript%3Aalert(1)"));
        assertNull(EnrollLink.parse("m5cet://enroll?server=ftp%3A%2F%2Fchat.fir.ma"));
        assertNull(EnrollLink.parse("m5cet://enroll?server=file%3A%2F%2F%2Fetc%2Fpasswd"));
        assertNull(EnrollLink.parse("m5cet://enroll?server=https%3A%2F%2Fuser%40evil.example"));
        assertNull(EnrollLink.parse("m5cet://enroll?server=https%3A%2F%2Fchat.fir.ma%2F%3Fx%3D1"));
        assertNull(EnrollLink.parse("m5cet://enroll?server=https%3A%2F%2Fchat.fir.ma%23frag"));
        assertNull(EnrollLink.parse("m5cet://enroll?server=https%3A%2F%2Fchat.fir.ma%3A99999"));
        assertNull(EnrollLink.parse("m5cet://enroll?server=https%3A%2F%2F"));
        // A broken escape in the server.
        assertNull(EnrollLink.parse("m5cet://enroll?server=https%3A%2F%2Fchat%ZZfir.ma"));
    }

    @Test
    public void aDamagedKidIsRefused() {
        assertNull(EnrollLink.parse("m5cet://enroll?server=chat.fir.ma&kid=short"));
        assertNull(EnrollLink.parse("m5cet://enroll?server=chat.fir.ma&kid=" + KID + "X"));
        assertNull(EnrollLink.parse("m5cet://enroll?server=chat.fir.ma&kid=DbEdmBPX%2FKyqeplx"));
        assertNull(EnrollLink.parse("m5cet://enroll?server=chat.fir.ma&kid=DbEdmBPX%3CKyqeplx"));
        // An empty kid is no pin (as a link without one).
        assertEquals("", EnrollLink.parse("m5cet://enroll?server=chat.fir.ma&kid=").kid);
        // base64url: - and _ belong to it.
        assertEquals("Ab-_0123456789xy", EnrollLink.parse("m5cet://enroll?server=chat.fir.ma&kid=Ab-_0123456789xy").kid);
    }

    @Test
    public void junkIsIgnored() {
        EnrollLink l = EnrollLink.parse("m5cet://enroll?utm_source=qr&server=chat.fir.ma&code=%3Cscript%3E&x&=y&kid=" + KID + "&junk=%ZZ");
        assertNotNull(l);
        assertEquals("https://chat.fir.ma", l.server);
        assertEquals("", l.code);   // not a code: the person types it
        assertEquals(KID, l.kid);
        // The code: spaces and case do not matter.
        assertEquals("ABCD-EFGH", EnrollLink.parse("m5cet://enroll?server=chat.fir.ma&code=abcd-+efgh").code);
        // Of repeated parameters the first counts.
        l = EnrollLink.parse("m5cet://enroll?server=chat.fir.ma&server=evil.example&code=AAAA&code=BBBB");
        assertEquals("https://chat.fir.ma", l.server);
        assertEquals("AAAA", l.code);
    }

    @Test
    public void onlyEnrolmentLinks() {
        assertTrue(EnrollLink.isEnrollLink("M5CET://ENROLL?server=chat.fir.ma"));
        assertNotNull(EnrollLink.parse("M5CET://ENROLL?server=chat.fir.ma"));
        assertFalse(EnrollLink.isEnrollLink("m5cet://join?server=chat.fir.ma"));
        assertNull(EnrollLink.parse("m5cet://join?server=chat.fir.ma"));
        assertNull(EnrollLink.parse("https://chat.fir.ma/enroll?server=chat.fir.ma"));
        assertNull(EnrollLink.parse("m5cet:enroll?server=chat.fir.ma"));
        assertNull(EnrollLink.parse("not a link at all"));
        assertNull(EnrollLink.parse(null));
    }

    @Test
    public void sameServer() {
        assertTrue(EnrollLink.sameServer("https://chat.fir.ma", "chat.fir.ma/"));
        assertTrue(EnrollLink.sameServer("https://Chat.Fir.ma", "https://chat.fir.ma"));
        assertFalse(EnrollLink.sameServer("https://chat.fir.ma", "http://chat.fir.ma"));
        assertFalse(EnrollLink.sameServer("https://chat.fir.ma", "https://chat.fir.ma:8443"));
        assertFalse(EnrollLink.sameServer("https://chat.fir.ma", ""));
        assertFalse(EnrollLink.sameServer(null, null));
        // The enrolment form's "this QR code is for another server" warning looks at the host only.
        assertTrue(EnrollLink.sameHost("http://chat.fir.ma", "https://chat.fir.ma"));
        assertTrue(EnrollLink.sameHost("chat.fir.ma", "https://chat.fir.ma/"));
        assertFalse(EnrollLink.sameHost("https://chat.fir.ma.evil.example", "https://chat.fir.ma"));
        assertFalse(EnrollLink.sameHost("https://chat.fir.ma:8443", "https://chat.fir.ma"));
        assertFalse(EnrollLink.sameHost("", "https://chat.fir.ma"));
    }
}
