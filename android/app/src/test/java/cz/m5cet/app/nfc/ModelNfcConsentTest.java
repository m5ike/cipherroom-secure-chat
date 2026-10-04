package cz.m5cet.app.nfc;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.function.Function;

/**
 * 6.10 (security analysis G-17): a model's card read leaves the phone only with
 * the holder's yes — what goes masked (the default), what "send everything"
 * adds, and that the masked answer holds no card number, no track data, no MRZ
 * lines, no photo (ModelNfc.consent / masked / declined; the web's consent.ts).
 */
public class ModelNfcConsentTest {
    private static final String PAN = "4111111111111111";
    private static final String AID = "A0000000031010";

    private static ModelNfc.Command cmd(String json) throws Exception {
        return ModelNfc.parse(new JSONObject().put("command", new JSONObject(json)));
    }

    private static byte[] tlv(int tag, byte[] value) {
        ByteArrayOutputStream w = new ByteArrayOutputStream();
        if (tag > 0xff) w.write((tag >> 8) & 0xff);
        w.write(tag & 0xff);
        w.write(value.length);
        w.write(value, 0, value.length);
        return w.toByteArray();
    }
    private static byte[] tlv(int tag, String ascii) { return tlv(tag, ascii.getBytes(StandardCharsets.US_ASCII)); }
    private static byte[] ok(byte[] resp) { return Apdu.concat(resp, Apdu.u8(0x90, 0x00)); }

    /** A Visa card whose record carries the PAN (5A), Track 2 (57), Track 1 (56) and the holder's name. */
    private static Apdu.Transceiver visa() {
        byte[] ppse = tlv(0x6f, Apdu.concat(tlv(0x84, "2PAY.SYS.DDF01"), tlv(0xa5, tlv(0xbf0c, tlv(0x61, Apdu.concat(tlv(0x4f, Apdu.unhex(AID)), tlv(0x50, "VISA"), tlv(0x87, Apdu.u8(1))))))));
        byte[] fci = tlv(0x6f, Apdu.concat(tlv(0x84, Apdu.unhex(AID)), tlv(0xa5, Apdu.concat(tlv(0x50, "VISA"), tlv(0x9f38, Apdu.unhex("9F66049F02069F3704"))))));
        byte[] gpo = tlv(0x77, Apdu.concat(tlv(0x82, Apdu.unhex("5C00")), tlv(0x94, Apdu.unhex("08010100"))));
        byte[] rec = tlv(0x70, Apdu.concat(tlv(0x5a, Apdu.unhex(PAN)), tlv(0x57, Apdu.unhex(PAN + "D2912201987654321F")),
            tlv(0x56, "B" + PAN + "^NOVAK/JAN^2912201"), tlv(0x5f24, Apdu.unhex("291231")), tlv(0x5f20, "NOVAK/JAN")));
        String ppseHex = Apdu.hex("2PAY.SYS.DDF01".getBytes(StandardCharsets.US_ASCII));
        return c -> {
            int cla = c[0] & 0xff, ins = c[1] & 0xff, p1 = c[2] & 0xff, p2 = c[3] & 0xff;
            if (ins == 0xa4 && p1 == 0x04) {
                String sel = Apdu.hex(Apdu.slice(c, 5, 5 + (c[4] & 0xff)));
                if (sel.equals(ppseHex)) return ok(ppse);
                if (sel.equals(AID)) return ok(fci);
                return Apdu.u8(0x6a, 0x82);
            }
            if (cla == 0x80 && ins == 0xa8) return ok(gpo);
            if (ins == 0xb2) return (p1 == 1 && (p2 >> 3) == 1) ? ok(rec) : Apdu.u8(0x6a, 0x83);
            return Apdu.u8(0x6d, 0x00);
        };
    }

    private static final class IsoCard implements ModelNfc.Card {
        final Apdu.Transceiver iso;
        IsoCard(Apdu.Transceiver iso) { this.iso = iso; }
        @Override public JSONObject identity() {
            try { return new JSONObject().put("uid", "04A1B2C3D4E5F6").put("tech", NfcCatalog.ISO_DEP); } catch (Exception e) { throw new IllegalStateException(e); }
        }
        @Override public Apdu.Transceiver isoDep() { return iso; }
        @Override public List<ModelNfc.NdefRec> ndef() { return null; }
    }

    private static JSONObject emvRead() throws Exception {
        JSONObject r = ModelNfc.run(cmd("{\"op\":\"emv-read\",\"args\":{\"max_apps\":1,\"history\":false,\"deep\":false}}"), new IsoCard(visa()));
        assertEquals("ok", r.optString("status"));
        assertEquals(PAN, r.getJSONObject("emv").getJSONArray("apps").getJSONObject(0).optString("pan"));
        return r;
    }

    private static JSONObject eidRead() throws Exception {
        MrtdReader.Options o = new MrtdReader.Options();
        o.mrz = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C<3UTO6908061F9406236ZE184226B<<<<<10";
        JSONObject mrtd = MrtdReader.readMrtd(new MrtdDeepTest.Chip(new Bac.MrzKey("L898902C", "690806", "940623"), MrtdDeepTest.files()), o);
        return new JSONObject().put("status", MrtdReader.statusFor(mrtd)).put("mrtd", mrtd).put("message", "ERIKSSON L898902C read")
            .put("card", new JSONObject().put("uid", "08112233").put("tech", NfcCatalog.EID));
    }

    private static final Function<String, String> EN = k -> {
        switch (k) {
            case "nfc.consent.text": return "{model} read a card on this device. With your yes, it gets:";
            case "nfc.consent.aModel": return "A function";
            case "nfc.consent.emvApp": return "{app}: card number {pan}, expires {expiry}";
            case "nfc.consent.fullAdds": return "\"Send everything\" also sends:";
            case "nfc.consent.fullPan": return "the full card number and the track data (numbers: {n})";
            default: return k;
        }
    };

    private static List<String> keys(List<ModelNfc.ConsentLine> lines) {
        List<String> out = new ArrayList<>();
        for (ModelNfc.ConsentLine l : lines) out.add(l.key);
        return out;
    }

    /* ------------------------------------------------------------ EMV */

    @Test
    public void aPaymentCardsReadAsksAndListsWhatGoes() throws Exception {
        JSONObject r = emvRead();
        ModelNfc.Consent c = ModelNfc.consent(r);
        assertTrue(c.sensitive);
        assertEquals("nfc.consent.emvApp", c.masked.get(0).key);
        assertEquals("411111••••••1111", c.masked.get(0).vars.get("pan"));
        assertFalse(c.masked.get(0).vars.get("app").isEmpty());
        assertTrue(keys(c.full).contains("nfc.consent.fullPan"));
        assertEquals("1", c.full.get(keys(c.full).indexOf("nfc.consent.fullPan")).vars.get("n"));
        String text = ModelNfc.consentText(c, "Card checker", EN);
        assertTrue(text, text.startsWith("Card checker read a card on this device."));
        assertTrue(text, text.contains(": card number 411111••••••1111, expires 2029-12"));
        assertTrue(text, text.contains("\"Send everything\" also sends:\n• the full card number and the track data (numbers: 1)"));
        assertFalse("the prompt itself shows no whole number", text.contains(PAN));
        assertTrue(ModelNfc.consentText(c, " ", EN).startsWith("A function read a card"));
    }

    @Test
    public void sendMaskedHoldsNoCardNumberAndNoTrackData() throws Exception {
        JSONObject r = emvRead();
        JSONObject m = ModelNfc.masked(r);
        String all = m.toString();
        assertFalse(all, all.contains(PAN));
        assertFalse("not as ASCII hex either (Track 1)", all.toUpperCase().contains(TemplateViews.asciiHex(PAN)));
        assertFalse("the track's discretionary data", all.contains("987654321"));
        JSONObject app = m.getJSONObject("emv").getJSONArray("apps").getJSONObject(0);
        assertFalse("the PAN field goes", app.has("pan"));
        assertEquals("411111••••••1111", app.optString("panMasked"));
        assertEquals("the expiry stays", "2029-12", app.optString("expiry"));
        assertTrue(all.contains("411111XXXXXX1111"));
        // What the read found is still there for the model, just masked; the original is untouched.
        assertEquals(r.optJSONObject("card").toString(), m.optJSONObject("card").toString());
        assertEquals(PAN, r.getJSONObject("emv").getJSONArray("apps").getJSONObject(0).optString("pan"));
    }

    @Test
    public void transcriptsMessagesAndRawDataAreMaskedOrWithheld() throws Exception {
        String rec = Apdu.hex(tlv(0x70, Apdu.concat(tlv(0x5a, Apdu.unhex(PAN)), tlv(0x57, Apdu.unhex(PAN + "D2912201")))));
        JSONObject r = new JSONObject().put("status", "ok")
            .put("transcript", new JSONArray().put(new JSONObject().put("command", "00B2010C00").put("response", rec)))
            .put("data", Base64.getEncoder().encodeToString(Apdu.unhex(rec)))
            .put("message", "Card " + PAN + " read");
        ModelNfc.Consent c = ModelNfc.consent(r);
        assertTrue(c.sensitive);
        assertEquals(java.util.Arrays.asList("nfc.consent.transcriptMasked"), keys(c.masked));
        assertEquals(java.util.Arrays.asList("nfc.consent.dataPan"), keys(c.full));
        JSONObject m = ModelNfc.masked(r);
        assertFalse(m.toString().contains(PAN));
        assertFalse("raw bytes with a card number are withheld", m.has("data"));
        assertEquals("Card 411111XXXXXX1111 read", m.optString("message"));
        // Raw bytes without a card number go (masked or not).
        JSONObject plain = new JSONObject().put("status", "ok").put("data", Base64.getEncoder().encodeToString(Apdu.u8(1, 2, 3)));
        ModelNfc.Consent pc = ModelNfc.consent(plain);
        assertEquals(java.util.Arrays.asList("nfc.consent.data"), keys(pc.masked));
        assertEquals("3", pc.masked.get(0).vars.get("n"));
        assertTrue(ModelNfc.masked(plain).has("data"));
    }

    /* ------------------------------------------------------------ e-ID */

    @Test
    public void aDocumentGoesWithoutMrzPhotoDetailsOrFiles() throws Exception {
        JSONObject r = eidRead();
        JSONObject mrtd = r.getJSONObject("mrtd");
        assertTrue(mrtd.has("photo") && mrtd.has("personal") && mrtd.has("raw"));
        ModelNfc.Consent c = ModelNfc.consent(r);
        assertTrue(c.sensitive);
        assertEquals("nfc.consent.holder", c.masked.get(0).key);
        assertEquals("ANNA MARIA ERIKSSON", c.masked.get(0).vars.get("name"));
        assertEquals("•••••02C", c.masked.get(0).vars.get("doc"));
        assertTrue(keys(c.full).containsAll(java.util.Arrays.asList("nfc.consent.mrz", "nfc.consent.images", "nfc.consent.details", "nfc.consent.files")));

        JSONObject m = ModelNfc.masked(r);
        JSONObject mm = m.getJSONObject("mrtd");
        for (String gone : new String[]{"photo", "photoMime", "images", "personal", "document", "optional", "personsToNotify", "raw"}) assertFalse(gone, mm.has(gone));
        JSONObject z = mm.getJSONObject("mrzInfo");
        assertFalse(z.has("mrz"));
        assertFalse(z.has("optionalData"));
        assertEquals("•••••02C", z.optString("documentNumber"));
        assertEquals("ERIKSSON", z.optString("surname"));
        assertEquals(mrtd.optString("access"), mm.optString("access"));
        String all = m.toString();
        assertFalse(all, all.contains("L898902C"));
        assertFalse(all.contains("ZE184226B"));
        assertEquals("ERIKSSON •••••02C read", m.optString("message"));
    }

    /* ------------------------------------------------------------ no */

    @Test
    public void dontSendTellsTheModelOnlyThatTheHolderSaidNo() throws Exception {
        JSONObject r = emvRead();
        JSONObject d = ModelNfc.declined(r);
        assertEquals("denied", d.optString("status"));
        assertEquals(r.optJSONObject("card").toString(), d.optJSONObject("card").toString());
        assertFalse(d.has("emv"));
        assertFalse(d.toString().contains(PAN));
        assertNotNull(d.optString("message"));
    }

    @Test
    public void whatHoldsNoCardDataGoesWithoutAQuestion() throws Exception {
        assertFalse(ModelNfc.consent(ModelNfc.result("ok", new JSONObject().put("uid", "04A1").put("tech", "ntag21x"), null)).sensitive);
        assertFalse(ModelNfc.consent(ModelNfc.result("timeout", null, "Cancelled")).sensitive);
        assertFalse(ModelNfc.consent(new JSONObject().put("status", "ok").put("mrtd", new JSONObject().put("present", true).put("access", "none"))).sensitive);
        assertFalse(ModelNfc.consent(null).sensitive);
        // emv-public: the applications only — still the holder's card, so it asks (as the web does).
        ModelNfc.Consent pub = ModelNfc.consent(new JSONObject().put("status", "ok").put("emv", new JSONObject().put("aids", new JSONArray().put(AID)).put("apps", new JSONArray())));
        assertTrue(pub.sensitive);
        assertEquals("nfc.consent.aids", pub.masked.get(0).key);
        assertTrue(pub.full.isEmpty());
    }
}
