package cz.m5cet.app.nfc;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/**
 * The EMV reader (EmvReader) against a scripted card — the Java port of
 * test/nfc-emv.test.ts: PPSE → SELECT AID → GPO → READ RECORD, then the records
 * parsed into the holder data a terminal reads. Read-only: the fake card has no
 * VERIFY / GENERATE AC and the reader never sends one.
 */
public class EmvReaderTest {

    private static final String AID_VISA = "A0000000031010";
    private static final String AID_MC = "A0000000041010";
    private static final String BULLET = "•";

    /* ---- a tiny BER-TLV encoder for the fixtures (all lengths < 128) ---- */
    private static byte[] tlv(int tag, byte[] value) {
        ByteArrayOutputStream w = new ByteArrayOutputStream();
        if (tag > 0xff) w.write((tag >> 8) & 0xff);
        w.write(tag & 0xff);
        w.write(value.length);
        w.write(value, 0, value.length);
        return w.toByteArray();
    }
    private static byte[] tlv(int tag, String ascii) { return tlv(tag, ascii.getBytes(StandardCharsets.US_ASCII)); }
    private static byte[] cat(byte[]... parts) { return Apdu.concat(parts); }
    private static byte[] ok(byte[] resp) { return Apdu.concat(resp, Apdu.u8(0x90, 0x00)); }

    private static byte[] visaRecord() {
        return tlv(0x70, cat(
            tlv(0x5a, Apdu.unhex("4111111111111111")),
            tlv(0x5f24, Apdu.unhex("291231")),
            tlv(0x57, Apdu.unhex("4111111111111111D291220100000000000F")),
            tlv(0x5f20, "VISA CARDHOLDER"),
            tlv(0x5f28, Apdu.unhex("0203")),
            tlv(0x9f36, Apdu.unhex("0005")),
            tlv(0x9f17, Apdu.unhex("03"))));
    }

    private static byte[] ppse() {
        byte[] app = tlv(0x61, cat(tlv(0x4f, Apdu.unhex(AID_VISA)), tlv(0x50, "VISA"), tlv(0x87, Apdu.u8(0x01))));
        return tlv(0x6f, cat(tlv(0x84, "2PAY.SYS.DDF01"), tlv(0xa5, tlv(0xbf0c, app))));
    }

    private static byte[] aidFci(String label) {
        return tlv(0x6f, cat(tlv(0x84, Apdu.unhex(AID_VISA)), tlv(0xa5, cat(tlv(0x50, label), tlv(0x9f38, Apdu.unhex("9F66049F02069F3704"))))));
    }

    private static byte[] gpo() { return tlv(0x77, cat(tlv(0x82, Apdu.unhex("5C00")), tlv(0x94, Apdu.unhex("08010100")))); }

    private static String selHex(byte[] cmd) {
        int lc = cmd[4] & 0xff;
        return Apdu.hex(Apdu.slice(cmd, 5, 5 + lc)).toUpperCase();
    }

    @Test
    public void readsVisaViaPpse() throws Exception {
        Apdu.Transceiver card = cmd -> {
            int ins = cmd[1] & 0xff, p1 = cmd[2] & 0xff, p2 = cmd[3] & 0xff;
            if (ins == 0xa4 && p1 == 0x04) {
                String sel = selHex(cmd);
                if (sel.equals(Apdu.hex("2PAY.SYS.DDF01".getBytes(StandardCharsets.US_ASCII)).toUpperCase())) return ok(ppse());
                if (sel.equals(AID_VISA)) return ok(aidFci("VISA"));
                return Apdu.u8(0x6a, 0x82);
            }
            if ((cmd[0] & 0xff) == 0x80 && ins == 0xa8) return ok(gpo());
            if (ins == 0xb2) return (p1 == 1 && (p2 >> 3) == 1) ? ok(visaRecord()) : Apdu.u8(0x6a, 0x83);
            if (ins == 0x20 || ((cmd[0] & 0xff) == 0x80 && ins == 0xae)) throw new IOException("the reader must never VERIFY a PIN or GENERATE AC");
            return Apdu.u8(0x6d, 0x00);
        };
        JSONObject d = EmvReader.readEmv(card, 4);
        assertEquals(1, d.optJSONArray("aids").length());
        assertEquals(AID_VISA, d.optJSONArray("aids").optString(0));
        assertEquals("Visa", d.optString("scheme"));
        JSONArray apps = d.optJSONArray("apps");
        assertEquals(1, apps.length());
        JSONObject app = apps.optJSONObject(0);
        assertEquals("VISA", app.optString("label"));
        assertEquals("4111111111111111", app.optString("pan"));
        assertEquals("411111" + repeat(BULLET, 6) + "1111", app.optString("panMasked"));
        assertEquals("2029-12", app.optString("expiry"));
        assertEquals("VISA CARDHOLDER", app.optString("cardholder"));
        assertEquals("Czechia", app.optString("issuerCountry"));
        assertEquals(5, app.optInt("atc"));
        assertEquals(3, app.optInt("pinTryCounter"));
        assertTrue(tagName(app, "5A").contains("PAN"));
        assertTrue(EmvReader.emvSummary(d).contains("411111" + repeat(BULLET, 6) + "1111"));
    }

    @Test
    public void recoversPanAndExpiryFromTrack2WhenNo5A() throws Exception {
        byte[] rec = tlv(0x70, tlv(0x57, Apdu.unhex("5555555555554444D2512201000000000F")));
        Apdu.Transceiver card = cmd -> {
            int ins = cmd[1] & 0xff, p1 = cmd[2] & 0xff, p2 = cmd[3] & 0xff;
            if (ins == 0xa4 && p1 == 0x04) {
                String sel = selHex(cmd);
                if (sel.equals(Apdu.hex("2PAY.SYS.DDF01".getBytes(StandardCharsets.US_ASCII)).toUpperCase())) return ok(ppse());
                return sel.equals(AID_VISA) ? ok(aidFci("VISA")) : Apdu.u8(0x6a, 0x82);
            }
            if ((cmd[0] & 0xff) == 0x80 && ins == 0xa8) return ok(gpo());
            if (ins == 0xb2) return (p1 == 1 && (p2 >> 3) == 1) ? ok(rec) : Apdu.u8(0x6a, 0x83);
            return Apdu.u8(0x6d, 0x00);
        };
        JSONObject d = EmvReader.readEmv(card, 4);
        JSONObject app = d.optJSONArray("apps").optJSONObject(0);
        assertEquals("5555555555554444", app.optString("pan"));
        assertEquals("2025-12", app.optString("expiry"));
    }

    @Test
    public void fallsBackToCandidateAidsWhenNoPpse() throws Exception {
        Apdu.Transceiver card = cmd -> {
            int ins = cmd[1] & 0xff, p1 = cmd[2] & 0xff, p2 = cmd[3] & 0xff;
            if (ins == 0xa4 && p1 == 0x04) {
                String sel = selHex(cmd);
                if (sel.equals(Apdu.hex("2PAY.SYS.DDF01".getBytes(StandardCharsets.US_ASCII)).toUpperCase())) return Apdu.u8(0x6a, 0x82);
                return sel.equals(AID_MC) ? ok(aidFci("MASTERCARD")) : Apdu.u8(0x6a, 0x82);
            }
            if ((cmd[0] & 0xff) == 0x80 && ins == 0xa8) return ok(gpo());
            if (ins == 0xb2) return (p1 == 1 && (p2 >> 3) == 1) ? ok(visaRecord()) : Apdu.u8(0x6a, 0x83);
            return Apdu.u8(0x6d, 0x00);
        };
        JSONObject d = EmvReader.readEmv(card, 4);
        assertTrue(contains(d.optJSONArray("aids"), AID_MC));
        JSONObject app = d.optJSONArray("apps").optJSONObject(0);
        assertEquals("Mastercard", app.optString("scheme"));
        assertEquals("MASTERCARD", app.optString("label"));
    }

    @Test
    public void emptyForCardWithNoEmvApplication() throws Exception {
        Apdu.Transceiver card = cmd -> Apdu.u8(0x6a, 0x82);
        JSONObject d = EmvReader.readEmv(card, 4);
        assertEquals(0, d.optJSONArray("apps").length());
        assertTrue(EmvReader.emvSummary(d).contains("No EMV"));
    }

    /* -------------------------------------------------------------- helpers */

    private static String repeat(String s, int n) { StringBuilder b = new StringBuilder(); for (int i = 0; i < n; i++) b.append(s); return b.toString(); }

    private static boolean contains(JSONArray a, String v) {
        for (int i = 0; i < a.length(); i++) if (v.equals(a.optString(i))) return true;
        return false;
    }

    private static String tagName(JSONObject app, String tag) {
        JSONArray tags = app.optJSONArray("tags");
        for (int i = 0; i < tags.length(); i++) {
            JSONObject t = tags.optJSONObject(i);
            if (t != null && tag.equals(t.optString("tag"))) return t.optString("name");
        }
        return "";
    }
}
