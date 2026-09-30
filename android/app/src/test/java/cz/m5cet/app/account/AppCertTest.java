package cz.m5cet.app.account;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import cz.m5cet.app.security.Crypto;

/** 6.4: the signing certificate's fingerprint, as the check-in sends it and the dialog shows it. */
public class AppCertTest {
    @Test
    public void fingerprintAsHexAndWithColons() {
        String hex = AppCert.of(Crypto.utf8("not really a certificate"));
        assertTrue(hex, hex.matches("[0-9a-f]{64}"));   // what the check-in sends (certSha256)
        assertEquals(Crypto.hex(Crypto.sha256(Crypto.utf8("not really a certificate"))), hex);
        String colons = AppCert.colons(hex);
        assertTrue(colons, colons.matches("([0-9A-F]{2}:){31}[0-9A-F]{2}"));   // what assetlinks.json lists
        assertEquals(hex.toUpperCase(java.util.Locale.ROOT), colons.replace(":", ""));
    }

    @Test
    public void colonsOfAnything() {
        assertEquals("3C:F2:AB", AppCert.colons("3cf2ab"));
        assertEquals("3C:F2:AB", AppCert.colons("3C:f2:ab"));
        assertEquals("3C:F2", AppCert.colons("3cf2a"));   // an odd digit left over is dropped
        assertEquals("", AppCert.colons(""));
        assertEquals("", AppCert.colons(null));
    }

    @Test
    public void theServersHostForAssetLinks() {
        assertEquals("chat.example.com", AccountDialogs.rpHost("https://chat.example.com"));
        assertEquals("chat.example.com", AccountDialogs.rpHost("https://chat.example.com:8443/app/"));
        assertEquals("m5cet.cz", AccountDialogs.rpHost("m5cet.cz"));
        assertEquals("m5cet.cz", AccountDialogs.rpHost("m5cet.cz:443/x"));
    }
}
