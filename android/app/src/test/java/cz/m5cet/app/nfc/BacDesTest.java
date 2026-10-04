package cz.m5cet.app.nfc;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * DES/3DES, the retail MAC and BAC (Des / Bac) pinned to the ICAO 9303 Part 11
 * worked example — the Java port of test/nfc-bac.test.ts. The canonical passport
 * (MRZ L898902C<3, 690806, 940623). If every value here matches the web's, the
 * key derivation, 3DES-CBC, the retail MAC and secure messaging are byte-exact.
 */
public class BacDesTest {

    private static byte[] b(String h) { return Apdu.unhex(h); }
    private static String H(byte[] u) { return Apdu.hex(u); }

    private static final Bac.MrzKey KEY = new Bac.MrzKey("L898902C", "690806", "940623");
    private static final byte[] RND_ICC = b("4608F91988702212");
    private static final byte[] RND_IFD = b("781723860C06C226");
    private static final byte[] K_IFD = b("0B795240CB7049B01C19B33E32804F0B");

    private static final byte[] KENC = b("AB94FDECF2674FDFB9B391F85D7F76F2");
    private static final byte[] KMAC = b("7962D9ECE03D1ACD4C76089DCE131543");
    private static final byte[] S = b("781723860C06C2264608F919887022120B795240CB7049B01C19B33E32804F0B");
    private static final byte[] EIFD = b("72C29C2371CC9BDB65B779B8E8D37B29ECC154AA56A8799FAE2F498F76ED92F2");

    @Test
    public void tdesCbcEncryptsAndDecryptsS() {
        assertEquals(H(EIFD), H(Des.tdesCbcEncrypt(KENC, S)));
        assertEquals(H(S), H(Des.tdesCbcDecrypt(KENC, EIFD)));
    }

    @Test
    public void retailMacOfEifdIsMifd() {
        assertEquals("5F1448EEA8AD90A7", H(Des.retailMac(KMAC, Des.pad(EIFD))));
    }

    @Test
    public void mrzInformationWithCheckDigits() {
        assertEquals("3", Bac.checkDigit("L898902C<"));
        assertEquals("1", Bac.checkDigit("690806"));
        assertEquals("6", Bac.checkDigit("940623"));
        assertEquals("L898902C<369080619406236", Bac.mrzInformation(KEY));
    }

    @Test
    public void readsKeyFieldsFromTd3Mrz() {
        String mrz = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C<3UTO6908061F9406236ZE184226B<<<<<10";
        Bac.MrzKey k = Bac.mrzKeyFromMrz(mrz);
        assertEquals("L898902C", k.documentNumber);
        assertEquals("690806", k.dateOfBirth);
        assertEquals("940623", k.dateOfExpiry);
    }

    @Test
    public void derivesKencAndKmac() {
        Bac.Keys k = Bac.bacKeys(KEY);
        assertEquals("239AB9CB282DAF66231DC5A4DF6BFBAE", H(k.seed));
        assertEquals("AB94FDECF2674FDFB9B391F85D7F76F2", H(k.kenc));
        assertEquals("7962D9ECE03D1ACD4C76089DCE131543", H(k.kmac));
    }

    @Test
    public void buildsExternalAuthenticateCommandData() {
        Bac.Keys k = Bac.bacKeys(KEY);
        byte[] cmd = Bac.mutualAuthCommand(k.kenc, k.kmac, RND_IFD, RND_ICC, K_IFD);
        assertEquals("72C29C2371CC9BDB65B779B8E8D37B29ECC154AA56A8799FAE2F498F76ED92F25F1448EEA8AD90A7", H(cmd));
    }

    @Test
    public void derivesSessionKeysAndSsc() {
        Bac.Keys k = Bac.bacKeys(KEY);
        byte[] response = b("46B9342A41396CD7386BF5803104D7CEDC122B9132139BAF2EEDC94EE178534F2F2D235D074D7449");
        Bac.Session s = Bac.sessionFromAuth(k.kenc, k.kmac, RND_IFD, RND_ICC, K_IFD, response);
        assertEquals("979EC13B1CBFE9DCD01AB0FED307EAE5", H(s.ksenc));
        assertEquals("F1CB1F1FB5ADF208806B89DC579DC1F8", H(s.ksmac));
        assertEquals("887022120C06C226", H(s.ssc));
    }

    @Test(expected = IllegalStateException.class)
    public void rejectsWrongMrz() {
        Bac.Keys k = Bac.bacKeys(new Bac.MrzKey("L898902C", "700101", "940623"));
        byte[] response = b("46B9342A41396CD7386BF5803104D7CEDC122B9132139BAF2EEDC94EE178534F2F2D235D074D7449");
        Bac.sessionFromAuth(k.kenc, k.kmac, RND_IFD, RND_ICC, K_IFD, response);
    }

    @Test
    public void protectsSelectEfComAndReadsBackStatus() {
        Bac.Session s = new Bac.Session(b("979EC13B1CBFE9DCD01AB0FED307EAE5"), b("F1CB1F1FB5ADF208806B89DC579DC1F8"), b("887022120C06C226"));
        assertEquals("0CA4020C158709016375432908C044F68E08BF8B92D635FF24F800", H(Bac.protectApdu(s, b("00A4020C02011E"))));
        assertEquals("887022120C06C227", H(s.ssc));
        Bac.Sm r = Bac.unprotectResponse(s, b("990290008E08FA855A5D4C50A8ED9000"));
        assertEquals(0x9000, r.sw);
        assertEquals(0, r.data.length);
        assertEquals("887022120C06C228", H(s.ssc));
    }

    @Test
    public void protectsReadBinaryAndDecryptsResponse() {
        Bac.Session s = new Bac.Session(b("979EC13B1CBFE9DCD01AB0FED307EAE5"), b("F1CB1F1FB5ADF208806B89DC579DC1F8"), b("887022120C06C228"));
        assertEquals("0CB000000D9701048E08ED6705417E96BA5500", H(Bac.protectApdu(s, b("00B0000004"))));
        Bac.Sm r = Bac.unprotectResponse(s, b("8709019FF0EC34F9922651990290008E08AD55CC17140B2DED4B9000"));
        assertEquals(0x9000, r.sw);
        assertTrue(H(r.data).startsWith("60145F01")); // EF.COM: tag 60, len 14, LDS version 5F01…
    }
}
