package cz.m5cet.app.nfc;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.util.List;

/** 6.7 (audit N18): what a hostile card or an NFC relay can no longer do. */
public class HardeningTest {
    private static byte[] b(String h) { return Apdu.unhex(h); }

    /** ICAO 9303 Worked Example keys and counter (BacDesTest), the EF.COM answer without its DO'8E. */
    @Test
    public void bacRefusesAnAnswerStrippedOfItsMac() {
        Bac.Session s = new Bac.Session(b("979EC13B1CBFE9DCD01AB0FED307EAE5"), b("F1CB1F1FB5ADF208806B89DC579DC1F8"), b("887022120C06C228"));
        try {
            Bac.unprotectResponse(s, b("8709019FF0EC34F9922651990290009000"));
            fail("data without a MAC was accepted");
        } catch (IllegalStateException expected) {
            assertTrue(expected.getMessage().contains("no MAC"));
        }
        Bac.Session s2 = new Bac.Session(b("979EC13B1CBFE9DCD01AB0FED307EAE5"), b("F1CB1F1FB5ADF208806B89DC579DC1F8"), b("887022120C06C226"));
        try {
            Bac.unprotectResponse(s2, b("99029000" + "9000"));
            fail("a protected status without a MAC was accepted");
        } catch (IllegalStateException expected) { }
        // A plain error status (no body at all) stays readable, as before.
        Bac.Session s3 = new Bac.Session(b("979EC13B1CBFE9DCD01AB0FED307EAE5"), b("F1CB1F1FB5ADF208806B89DC579DC1F8"), b("887022120C06C226"));
        assertEquals(0x6A82, Bac.unprotectResponse(s3, b("6A82")).sw);
    }

    /** Constructed tags nested thousands deep: parsed to a bounded depth, no StackOverflowError. */
    @Test
    public void tlvNestingIsBounded() {
        byte[] inner = new byte[0];
        for (int i = 0; i < 5000; i++) inner = wrap(0x30, inner);
        List<Apdu.Tlv> top = Apdu.decodeTlv(inner);
        assertEquals(1, top.size());
        int depth = 0;
        Apdu.Tlv n = top.get(0);
        while (n.children != null && !n.children.isEmpty()) { n = n.children.get(0); depth++; }
        assertEquals(Apdu.MAX_TLV_DEPTH, depth);
        assertNull(n.children);
    }

    private static byte[] wrap(int tag, byte[] v) {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        o.write(tag);
        int len = v.length;
        if (len < 0x80) o.write(len);
        else if (len < 0x100) { o.write(0x81); o.write(len); }
        else if (len < 0x10000) { o.write(0x82); o.write(len >> 8); o.write(len & 0xff); }
        else { o.write(0x83); o.write(len >> 16); o.write((len >> 8) & 0xff); o.write(len & 0xff); }
        o.write(v, 0, v.length);
        return o.toByteArray();
    }
}
