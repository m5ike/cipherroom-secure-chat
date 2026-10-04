package cz.m5cet.app.nfc;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;

/**
 * A model's NFC command on Android (ModelNfc): the command → result mapping the
 * web executor has (client/src/lib/nfc/web-executor.ts) — op routing, args in
 * camelCase or snake_case, writes denied, an unknown op unsupported, the reader
 * chosen, enum, the timeout / cancel shapes — run against a fake card; and the
 * e-ID document key the phone asks for itself, which never reaches the answer.
 */
public class ModelNfcTest {

    private static ModelNfc.Command cmd(String json) throws Exception {
        return ModelNfc.parse(new JSONObject().put("command", new JSONObject(json)));
    }

    /* ------------------------------------------------------------ a fake card */

    private static final class FakeCard implements ModelNfc.Card {
        final JSONObject identity;
        final Apdu.Transceiver iso;
        final List<ModelNfc.NdefRec> ndef;
        IOException ndefFails;
        int isoOpened;

        FakeCard(String tech, Apdu.Transceiver iso, List<ModelNfc.NdefRec> ndef) throws Exception {
            identity = new JSONObject().put("uid", "04A1B2C3D4E5F6").put("tech", tech).put("label", NfcCatalog.techInfo(tech).label)
                .put("sak", "20").put("atqa", "0044").put("techList", new JSONArray().put("IsoDep").put("NfcA")).put("sectors", 16);
            this.iso = iso;
            this.ndef = ndef;
        }

        @Override public JSONObject identity() { return identity; }
        @Override public Apdu.Transceiver isoDep() { if (iso != null) isoOpened++; return iso; }
        @Override public List<ModelNfc.NdefRec> ndef() throws IOException { if (ndefFails != null) throw ndefFails; return ndef; }
    }

    private static ModelNfc.NdefRec text(String lang, String s) {
        byte[] l = lang.getBytes(StandardCharsets.US_ASCII), t = s.getBytes(StandardCharsets.UTF_8);
        return new ModelNfc.NdefRec(1, new byte[]{'T'}, null, Apdu.concat(Apdu.u8(l.length), l, t));
    }

    private static ModelNfc.NdefRec uri(int code, String rest) {
        return new ModelNfc.NdefRec(1, new byte[]{'U'}, null, Apdu.concat(Apdu.u8(code), rest.getBytes(StandardCharsets.UTF_8)));
    }

    /* ---- a minimal EMV card (PPSE → SELECT → GPO → READ RECORD), as EmvReaderTest ---- */

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

    private static final String AID_VISA = "A0000000031010";

    /** A Visa card; it fails the test if anything but a read is sent. */
    private static Apdu.Transceiver visa() {
        byte[] ppse = tlv(0x6f, Apdu.concat(tlv(0x84, "2PAY.SYS.DDF01"), tlv(0xa5, tlv(0xbf0c, tlv(0x61, Apdu.concat(tlv(0x4f, Apdu.unhex(AID_VISA)), tlv(0x50, "VISA"), tlv(0x87, Apdu.u8(1))))))));
        byte[] fci = tlv(0x6f, Apdu.concat(tlv(0x84, Apdu.unhex(AID_VISA)), tlv(0xa5, Apdu.concat(tlv(0x50, "VISA"), tlv(0x9f38, Apdu.unhex("9F66049F02069F3704"))))));
        byte[] gpo = tlv(0x77, Apdu.concat(tlv(0x82, Apdu.unhex("5C00")), tlv(0x94, Apdu.unhex("08010100"))));
        byte[] rec = tlv(0x70, Apdu.concat(tlv(0x5a, Apdu.unhex("4111111111111111")), tlv(0x5f24, Apdu.unhex("291231")), tlv(0x5f20, "VISA CARDHOLDER")));
        String ppseHex = Apdu.hex("2PAY.SYS.DDF01".getBytes(StandardCharsets.US_ASCII));
        return c -> {
            int cla = c[0] & 0xff, ins = c[1] & 0xff, p1 = c[2] & 0xff, p2 = c[3] & 0xff;
            if (ins == 0x20 || (cla == 0x80 && ins == 0xae) || ins == 0xd6 || ins == 0xdc || ins == 0xe2)
                throw new AssertionError("a model's read must never VERIFY, GENERATE AC or write");
            if (ins == 0xa4 && p1 == 0x04) {
                String sel = Apdu.hex(Apdu.slice(c, 5, 5 + (c[4] & 0xff)));
                if (sel.equals(ppseHex)) return ok(ppse);
                if (sel.equals(AID_VISA)) return ok(fci);
                return Apdu.u8(0x6a, 0x82);
            }
            if (cla == 0x80 && ins == 0xa8) return ok(gpo);
            if (ins == 0xb2) return (p1 == 1 && (p2 >> 3) == 1) ? ok(rec) : Apdu.u8(0x6a, 0x83);
            return Apdu.u8(0x6d, 0x00);
        };
    }

    /** Every key at any depth of a JSON value (the answer must not carry the command's args). */
    private static List<String> keysOf(Object v) {
        List<String> out = new ArrayList<>();
        if (v instanceof JSONObject) {
            for (Iterator<String> it = ((JSONObject) v).keys(); it.hasNext(); ) { String k = it.next(); out.add(k); out.addAll(keysOf(((JSONObject) v).opt(k))); }
        } else if (v instanceof JSONArray) {
            for (int i = 0; i < ((JSONArray) v).length(); i++) out.addAll(keysOf(((JSONArray) v).opt(i)));
        }
        return out;
    }

    /* ------------------------------------------------------------ the command */

    @Test
    public void parsesTheCommandWithDefaultsAndBounds() throws Exception {
        ModelNfc.Command c = cmd("{\"op\":\"emv-read\",\"reader\":\"usb\",\"tech\":\"emv\",\"timeout\":500,\"args\":{\"maxApps\":2}}");
        assertEquals("emv-read", c.op);
        assertEquals("usb", c.reader);
        assertEquals("emv", c.tech);
        assertEquals(120, c.timeout);
        assertEquals(2, c.args.optInt("maxApps"));

        assertEquals(20, cmd("{\"op\":\"scan\"}").timeout);
        assertEquals(1, cmd("{\"op\":\"scan\",\"timeout\":0.2}").timeout);
        assertEquals(20, cmd("{\"op\":\"scan\",\"timeout\":\"30\"}").timeout);
        assertNull(cmd("{\"op\":\"scan\",\"reader\":\"pn532-wifi\"}").reader);
        // The web answers an interaction without a command as a scan.
        assertEquals("scan", ModelNfc.parse(new JSONObject()).op);
        assertEquals("scan", ModelNfc.parse(null).op);
        // A malformed op is no op at all.
        assertEquals("", cmd("{\"op\":\"EMV READ\"}").op);
        assertEquals("unsupported", ModelNfc.refusal(cmd("{\"op\":\"EMV READ\"}")).optString("status"));
    }

    @Test
    public void argsAreCamelCaseFromSnakeCaseAndNeverAKey() throws Exception {
        ModelNfc.Command e = cmd("{\"op\":\"emv-read\",\"args\":{\"max_apps\":3,\"history\":false,\"deep\":true}}");
        assertEquals(3, e.args.optInt("maxApps"));
        assertFalse(e.args.has("max_apps"));
        assertFalse(e.args.optBoolean("history", true));
        assertEquals(3, EmvReader.Options.fromArgs(e.args).maxApps);

        ModelNfc.Command m = cmd("{\"op\":\"mrtd-read\",\"args\":{\"document_number\":\"L898902C\",\"date_of_birth\":\"690806\",\"date_of_expiry\":\"940623\",\"photo\":false,\"all\":false}}");
        assertEquals("L898902C", m.args.optString("documentNumber"));
        assertEquals("690806", m.args.optString("dateOfBirth"));
        assertEquals("940623", m.args.optString("dateOfExpiry"));
        assertEquals(Boolean.FALSE, m.args.opt("readPhoto"));
        MrtdReader.Options o = MrtdReader.Options.fromArgs(m.args);
        assertNotNull(o.key);
        assertFalse(o.readPhoto);
        assertFalse(o.all);

        // An explicit camelCase key wins over its snake_case twin.
        assertEquals(5, cmd("{\"op\":\"emv-read\",\"args\":{\"maxApps\":5,\"max_apps\":1}}").args.optInt("maxApps"));
        assertEquals(Boolean.TRUE, cmd("{\"op\":\"eid-read\",\"args\":{\"readPhoto\":true,\"read_photo\":false,\"photo\":false}}").args.opt("readPhoto"));
        // No raw card key / PIN argument gets through, whatever its spelling.
        JSONObject a = cmd("{\"op\":\"classic-read\",\"args\":{\"key\":\"FFFFFFFFFFFF\",\"key_a\":\"A0A1A2A3A4A5\",\"keyB\":\"B0\",\"pin\":\"1234\",\"PASSWORD\":\"x\",\"from\":4}}").args;
        assertEquals(Collections.singletonList("from"), keysOf(a));
    }

    /* ------------------------------------------------------- what may run */

    @Test
    public void writesAndEmulationAreDeniedUnknownOpsUnsupported() throws Exception {
        for (String op : new String[]{"ndef-write", "ndef-lock", "classic-write", "classic-restore", "ntag-write", "ul-write", "write-uid", "m5-write", "m5-erase", "conn-write", "desfire-write", "v-write", "ntag-password"}) {
            JSONObject r = ModelNfc.refusal(cmd("{\"op\":\"" + op + "\"}"));
            assertNotNull(op, r);
            assertEquals(op, "denied", r.optString("status"));
            assertTrue(op, r.optString("message").contains("workbench"));
        }
        for (String op : new String[]{"m5-emulate", "conn-emulate"}) assertEquals(op, "denied", ModelNfc.refusal(cmd("{\"op\":\"" + op + "\"}")).optString("status"));
        // Reads a model does not get here (keys, raw APDUs, dumps) and ops nobody knows.
        for (String op : new String[]{"raw-apdu", "select-aid", "classic-read", "classic-dump", "desfire-read", "felica-read", "frobnicate", "write"})
            assertEquals(op, "unsupported", ModelNfc.refusal(cmd("{\"op\":\"" + op + "\"}")).optString("status"));
        // What runs.
        for (String op : ModelNfc.READS) assertNull(op, ModelNfc.refusal(cmd("{\"op\":\"" + op + "\"}")));
        assertNull(ModelNfc.refusal(cmd("{\"op\":\"enum\"}")));
        assertEquals("enum", ModelNfc.kindOf("enum"));
        assertEquals("write", ModelNfc.kindOf("ndef-write"));
        assertEquals("emulate", ModelNfc.kindOf("m5-emulate"));
        assertEquals("other", ModelNfc.kindOf("raw-apdu"));
        assertEquals("unknown", ModelNfc.kindOf("frobnicate"));
    }

    @Test
    public void aTechnologyThatDoesNotOfferTheOp() throws Exception {
        JSONObject r = ModelNfc.refusal(cmd("{\"op\":\"emv-read\",\"tech\":\"ndef\"}"));
        assertEquals("unsupported", r.optString("status"));
        assertTrue(r.optString("message").contains("NDEF tag"));
        assertNull(ModelNfc.refusal(cmd("{\"op\":\"emv-read\",\"tech\":\"emv\"}")));
        assertNull(ModelNfc.refusal(cmd("{\"op\":\"mrtd-read\",\"tech\":\"eid\"}")));   // eid.read() sends mrtd-read
        assertNull(ModelNfc.refusal(cmd("{\"op\":\"scan\",\"tech\":\"felica\"}")));
        assertNull(ModelNfc.refusal(cmd("{\"op\":\"emv-read\",\"tech\":\"no-such-tech\"}")));
    }

    /* ------------------------------------------------------------ the reader */

    private static ModelNfc.Device phone(boolean nfc, boolean on) {
        ModelNfc.Device d = new ModelNfc.Device();
        d.internal = nfc;
        d.internalOn = on;
        return d;
    }

    @Test
    public void theReaderIsThePhonesOwnUnlessAUsbOneIsAllowed() throws Exception {
        ModelNfc.Command scan = cmd("{\"op\":\"scan\"}");
        assertEquals("internal", ModelNfc.route(scan, phone(true, true)).reader);

        ModelNfc.Route off = ModelNfc.route(scan, phone(true, false));
        assertNull(off.reader);
        assertTrue(off.nfcOff);
        assertEquals("unsupported", off.result.optString("status"));
        assertTrue(off.result.optString("message").contains("switched off"));

        ModelNfc.Route none = ModelNfc.route(scan, phone(false, false));
        assertFalse(none.nfcOff);
        assertEquals("unsupported", none.result.optString("status"));

        ModelNfc.Device usb = phone(true, true);
        usb.usb.add(new ModelNfc.Device.Usb("ACR122U", false));
        assertEquals("internal", ModelNfc.route(scan, usb).reader);
        ModelNfc.Route notAllowed = ModelNfc.route(cmd("{\"op\":\"scan\",\"reader\":\"usb\"}"), usb);
        assertEquals("unsupported", notAllowed.result.optString("status"));
        assertTrue(notAllowed.result.optString("message").contains("Allow"));
        usb.usb.set(0, new ModelNfc.Device.Usb("ACR122U", true));
        assertEquals("usb", ModelNfc.route(cmd("{\"op\":\"emv-read\",\"reader\":\"usb\"}"), usb).reader);
        assertEquals("internal", ModelNfc.route(scan, usb).reader);
        usb.preferred = "usb";                      // the workbench uses the USB reader
        assertEquals("usb", ModelNfc.route(scan, usb).reader);
        assertEquals("internal", ModelNfc.route(cmd("{\"op\":\"scan\",\"reader\":\"internal\"}"), usb).reader);

        assertEquals("No USB reader is connected.", ModelNfc.route(cmd("{\"op\":\"scan\",\"reader\":\"usb\"}"), phone(true, true)).result.optString("message"));
        assertEquals("unsupported", ModelNfc.route(cmd("{\"op\":\"scan\",\"reader\":\"bluetooth\"}"), usb).result.optString("status"));
        assertEquals("unsupported", ModelNfc.route(cmd("{\"op\":\"scan\",\"reader\":\"serial\"}"), usb).result.optString("status"));
    }

    @Test
    public void enumTellsTheReadersAndTechnologiesWithoutACard() throws Exception {
        ModelNfc.Device d = phone(true, true);
        d.usb.add(new ModelNfc.Device.Usb("ACR1252U", true));
        d.bluetooth = true;
        JSONObject r = ModelNfc.enumResult(cmd("{\"op\":\"enum\"}"), d);
        assertEquals("ok", r.optString("status"));
        assertFalse(r.has("card"));
        assertTrue(r.optString("message").contains("This device (NFC on)"));
        assertTrue(r.optString("message").contains("ACR1252U"));
        JSONObject data = new JSONObject(new String(Base64.getDecoder().decode(r.optString("data")), StandardCharsets.UTF_8));
        JSONArray readers = data.getJSONArray("readers");
        assertEquals(3, readers.length());
        assertEquals("internal", readers.getJSONObject(0).optString("kind"));
        assertTrue(readers.getJSONObject(0).optBoolean("enabled"));
        assertEquals("usb", readers.getJSONObject(1).optString("kind"));
        assertFalse(readers.getJSONObject(2).optBoolean("available"));
        assertEquals("internal", data.optString("default"));
        List<String> techs = new ArrayList<>();
        for (int i = 0; i < data.getJSONArray("technologies").length(); i++) techs.add(data.getJSONArray("technologies").optString(i));
        assertTrue(techs.containsAll(Arrays.asList("emv", "eid", "ndef", "ntag21x", "iso-dep")));
        assertFalse("no NXP controller: no MIFARE Classic", techs.contains("mifare-classic-1k"));
        assertFalse(techs.contains("unknown"));
        assertTrue(data.getJSONArray("ops").toString().contains("emv-read"));

        d.mifareClassic = true;
        assertTrue(ModelNfc.enumResult(cmd("{\"op\":\"enum\"}"), d).optString("message").contains("mifare-classic-1k"));
        // Scoped to one reader.
        JSONObject only = new JSONObject(new String(Base64.getDecoder().decode(ModelNfc.enumResult(cmd("{\"op\":\"enum\",\"reader\":\"usb\"}"), d).optString("data")), StandardCharsets.UTF_8));
        assertEquals(1, only.getJSONArray("readers").length());
        // Nothing at all.
        assertEquals("No NFC reader on this device.", ModelNfc.enumResult(cmd("{\"op\":\"enum\"}"), phone(false, false)).optString("message"));
    }

    @Test
    public void timeoutAndCancelShapes() {
        JSONObject c = ModelNfc.cancelled();
        assertEquals("timeout", c.optString("status"));
        assertEquals("Cancelled", c.optString("message"));
        assertEquals(2, c.length());
        JSONObject t = ModelNfc.timedOut(20);
        assertEquals("timeout", t.optString("status"));
        assertTrue(t.optString("message").contains("20 s"));
        assertFalse(t.has("card"));
    }

    /* ------------------------------------------------------------ on a card */

    @Test
    public void readUidAnswersTheCardWithOnlyItsPublicFields() throws Exception {
        JSONObject r = ModelNfc.run(cmd("{\"op\":\"read-uid\"}"), new FakeCard(NfcCatalog.ISO_DEP, null, null));
        assertEquals("ok", r.optString("status"));
        JSONObject card = r.getJSONObject("card");
        assertEquals("04A1B2C3D4E5F6", card.optString("uid"));
        assertEquals("iso-dep", card.optString("tech"));
        assertEquals("20", card.optString("sak"));
        assertEquals("0044", card.optString("atqa"));
        assertFalse(card.has("techList"));
        assertFalse(card.has("sectors"));
    }

    @Test
    public void scanAndNdefReadDecodeTheRecords() throws Exception {
        List<ModelNfc.NdefRec> recs = Arrays.asList(text("cs", "Ahoj světe"), uri(4, "m5cet.cz/x"),
            new ModelNfc.NdefRec(2, "text/plain".getBytes(StandardCharsets.US_ASCII), null, new byte[]{0x41}),
            new ModelNfc.NdefRec(4, "example.com:t".getBytes(StandardCharsets.US_ASCII), null, new byte[]{0x01, 0x02}),
            new ModelNfc.NdefRec(0, null, null, null));
        JSONObject r = ModelNfc.run(cmd("{\"op\":\"scan\"}"), new FakeCard(NfcCatalog.NTAG21X, null, recs));
        assertEquals("ok", r.optString("status"));
        JSONArray n = r.getJSONArray("ndef");
        assertEquals(5, n.length());
        assertEquals("text", n.getJSONObject(0).optString("kind"));
        assertEquals("Ahoj světe", n.getJSONObject(0).optString("text"));
        assertEquals("cs", n.getJSONObject(0).optString("lang"));
        assertEquals("uri", n.getJSONObject(1).optString("kind"));
        assertEquals("https://m5cet.cz/x", n.getJSONObject(1).optString("data"));
        assertEquals("mime", n.getJSONObject(2).optString("kind"));
        assertEquals("text/plain", n.getJSONObject(2).optString("type"));
        assertEquals("41", n.getJSONObject(2).optString("data"));
        assertEquals("external", n.getJSONObject(3).optString("kind"));
        assertEquals("empty", n.getJSONObject(4).optString("kind"));
        assertFalse(r.has("records"));

        JSONObject nd = ModelNfc.run(cmd("{\"op\":\"ndef-read\"}"), new FakeCard(NfcCatalog.NTAG21X, null, recs));
        assertEquals(5, nd.getJSONArray("ndef").length());
        // Not an NDEF tag.
        JSONObject not = ModelNfc.run(cmd("{\"op\":\"ndef-read\"}"), new FakeCard(NfcCatalog.MIFARE_CLASSIC_1K, null, null));
        assertEquals("unsupported", not.optString("status"));
        assertEquals("mifare-classic-1k", not.getJSONObject("card").optString("tech"));
        // A scan of a card without NDEF is still its identity.
        JSONObject plain = ModelNfc.run(cmd("{\"op\":\"scan\"}"), new FakeCard(NfcCatalog.ISO_DEP, null, null));
        assertEquals("ok", plain.optString("status"));
        assertFalse(plain.has("ndef"));
    }

    @Test
    public void aSmartPosterGivesItsUri() throws Exception {
        // Sp payload = an NDEF message: a short URI record (MB|ME|SR, TNF 1).
        byte[] inner = Apdu.concat(Apdu.u8(0xd1, 0x01, 0x05), new byte[]{'U'}, Apdu.u8(0x03), "a.cz".getBytes(StandardCharsets.US_ASCII));
        ModelNfc.NdefRec sp = new ModelNfc.NdefRec(1, new byte[]{'S', 'p'}, null, inner);
        JSONObject r = ModelNfc.run(cmd("{\"op\":\"ndef-read\"}"), new FakeCard(NfcCatalog.NDEF, null, Collections.singletonList(sp)));
        assertEquals("smart-poster", r.getJSONArray("ndef").getJSONObject(0).optString("kind"));
        assertEquals("http://a.cz", r.getJSONArray("ndef").getJSONObject(0).optString("data"));
    }

    @Test
    public void anM5CetCardListsItsRecordsStillSealed() throws Exception {
        M5Card.Sealed s = new M5Card.Sealed();
        s.id = 0x0a0b0c; s.type = "message"; s.mode = M5Card.MODE_EXTERNAL; s.oneTime = true;
        s.salt = new byte[16]; s.iv = new byte[12]; s.ct = new byte[24];
        byte[] container = M5Card.encodeContainer(Collections.singletonList(s));
        ModelNfc.NdefRec rec = new ModelNfc.NdefRec(4, M5Card.EXTERNAL_TYPE.getBytes(StandardCharsets.US_ASCII), null, container);
        JSONObject r = ModelNfc.run(cmd("{\"op\":\"m5-read\"}"), new FakeCard(NfcCatalog.NTAG21X, null, Collections.singletonList(rec)));
        assertEquals("ok", r.optString("status"));
        assertEquals("m5cet-card", r.getJSONObject("card").optString("tech"));
        JSONObject one = r.getJSONArray("records").getJSONObject(0);
        assertEquals(0x0a0b0c, one.optInt("id"));
        assertEquals("message", one.optString("type"));
        assertTrue(one.optBoolean("oneTime"));
        // The scan shows them too; a tag without the card says so.
        assertEquals(1, ModelNfc.run(cmd("{\"op\":\"scan\"}"), new FakeCard(NfcCatalog.NTAG21X, null, Collections.singletonList(rec))).getJSONArray("records").length());
        assertEquals("Not an M5Cet card.", ModelNfc.run(cmd("{\"op\":\"m5-read\"}"), new FakeCard(NfcCatalog.NTAG21X, null, Collections.singletonList(text("en", "x")))).optString("message"));
    }

    @Test
    public void emvReadRunsTheCardLayerReadOnly() throws Exception {
        FakeCard card = new FakeCard(NfcCatalog.ISO_DEP, visa(), null);
        JSONObject r = ModelNfc.run(cmd("{\"op\":\"emv-read\",\"args\":{\"max_apps\":1,\"history\":false,\"deep\":false}}"), card);
        assertEquals("ok", r.optString("status"));
        assertEquals(1, card.isoOpened);
        JSONObject emv = r.getJSONObject("emv");
        assertEquals("4111111111111111", emv.getJSONArray("apps").getJSONObject(0).optString("pan"));
        assertEquals("2029-12", emv.getJSONArray("apps").getJSONObject(0).optString("expiry"));
        assertEquals("emv", r.getJSONObject("card").optString("tech"));
        assertEquals("EMV payment card", r.getJSONObject("card").optString("label"));
        assertTrue(r.optString("message").length() > 0);
        // emv-public: the PPSE only.
        JSONObject pub = ModelNfc.run(cmd("{\"op\":\"emv-public\"}"), new FakeCard(NfcCatalog.ISO_DEP, visa(), null));
        assertEquals("ok", pub.optString("status"));
        assertTrue(pub.optString("message"), pub.optString("message").contains(AID_VISA));
        assertFalse(pub.has("emv"));
    }

    @Test
    public void anIsoDepReadOnACardWithoutIsoDepIsUnsupported() throws Exception {
        for (String op : new String[]{"emv-read", "eid-read", "mrtd-read", "emv-public", "eid-public"}) {
            JSONObject r = ModelNfc.run(cmd("{\"op\":\"" + op + "\",\"args\":{\"can\":\"123456\"}}"), new FakeCard(NfcCatalog.MIFARE_ULTRALIGHT, null, null));
            assertEquals(op, "unsupported", r.optString("status"));
            assertEquals(op, "mifare-ultralight", r.getJSONObject("card").optString("tech"));
        }
    }

    @Test
    public void aCardTakenAwayIsNoCardAndOtherFailuresAnError() throws Exception {
        FakeCard gone = new FakeCard(NfcCatalog.NDEF, null, null);
        gone.ndefFails = new ModelNfc.CardGone("tag lost");
        JSONObject r = ModelNfc.run(cmd("{\"op\":\"ndef-read\"}"), gone);
        assertEquals("no-card", r.optString("status"));
        assertTrue(r.has("card"));
        assertEquals("no-card", ModelNfc.run(cmd("{\"op\":\"scan\"}"), gone).optString("status"));
        FakeCard broken = new FakeCard(NfcCatalog.NDEF, null, null);
        broken.ndefFails = new IOException("the NDEF message is malformed");
        JSONObject e = ModelNfc.run(cmd("{\"op\":\"ndef-read\"}"), broken);
        assertEquals("error", e.optString("status"));
        assertEquals("the NDEF message is malformed", e.optString("message"));
        // A scan carries on without the NDEF it could not read.
        assertEquals("ok", ModelNfc.run(cmd("{\"op\":\"scan\"}"), broken).optString("status"));
    }

    /* ------------------------------------------------ the document key (e-ID) */

    @Test
    public void anEidReadWithoutADocumentKeyAsksTheHolder() throws Exception {
        assertTrue(ModelNfc.needsDocumentKey(cmd("{\"op\":\"eid-read\"}")));
        assertTrue(ModelNfc.needsDocumentKey(cmd("{\"op\":\"mrtd-read\",\"args\":{\"readPhoto\":true}}")));
        assertTrue(ModelNfc.needsDocumentKey(cmd("{\"op\":\"mrtd-read\",\"args\":{\"can\":\"  \",\"mrz\":\"\"}}")));
        assertTrue("two of the three fields are not a key", ModelNfc.needsDocumentKey(cmd("{\"op\":\"eid-read\",\"args\":{\"documentNumber\":\"L898902C\",\"dateOfBirth\":\"690806\"}}")));
        assertTrue(ModelNfc.needsDocumentKey(cmd("{\"op\":\"eid-read\",\"args\":{\"can\":123456}}")));
        assertFalse(ModelNfc.needsDocumentKey(cmd("{\"op\":\"eid-read\",\"args\":{\"can\":\"123456\"}}")));
        assertFalse(ModelNfc.needsDocumentKey(cmd("{\"op\":\"mrtd-read\",\"args\":{\"mrz\":\"P<UTO...\"}}")));
        assertFalse(ModelNfc.needsDocumentKey(cmd("{\"op\":\"eid-read\",\"args\":{\"documentNumber\":\"L898902C\",\"dateOfBirth\":\"690806\",\"dateOfExpiry\":\"940623\"}}")));
        assertFalse(ModelNfc.needsDocumentKey(cmd("{\"op\":\"eid-read\",\"args\":{\"document_number\":\"L898902C\",\"date_of_birth\":\"690806\",\"date_of_expiry\":\"940623\"}}")));
        assertFalse("not an e-ID read", ModelNfc.needsDocumentKey(cmd("{\"op\":\"emv-read\"}")));
        assertFalse(ModelNfc.needsDocumentKey(cmd("{\"op\":\"eid-public\"}")));
    }

    private static ModelNfc.DocumentKey key(String can, String mrz, String doc, String dob, String exp) {
        ModelNfc.DocumentKey k = new ModelNfc.DocumentKey();
        k.can = can; k.mrz = mrz; k.documentNumber = doc; k.dateOfBirth = dob; k.dateOfExpiry = exp;
        return k;
    }

    private static final String MRZ = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C<3UTO6908061F9406236ZE184226B<<<<<10";

    @Test
    public void whatTheHolderTypesIsChecked() {
        assertEquals("nfc.eid.needKey", ModelNfc.checkDocumentKey(key("", "", "", "", "")));
        assertEquals("nfc.model.key.badCan", ModelNfc.checkDocumentKey(key("12345", "", "", "", "")));
        assertEquals("nfc.model.key.badCan", ModelNfc.checkDocumentKey(key("12345a", "", "", "", "")));
        assertNull(ModelNfc.checkDocumentKey(key("123 456", "", "", "", "")));
        assertNull(ModelNfc.checkDocumentKey(key("", MRZ, "", "", "")));
        assertNull(ModelNfc.checkDocumentKey(key("", MRZ.toLowerCase(), "", "", "")));
        assertEquals("nfc.model.key.badMrz", ModelNfc.checkDocumentKey(key("", "not an mrz", "", "", "")));
        assertNull(ModelNfc.checkDocumentKey(key("", "", "l898902c", "690806", "940623")));
        assertEquals("nfc.eid.needKey", ModelNfc.checkDocumentKey(key("", "", "L898902C", "690806", "")));
        assertEquals("nfc.model.key.badDate", ModelNfc.checkDocumentKey(key("", "", "L898902C", "69-08-06", "940623")));
        assertNull("a CAN and the fields together", ModelNfc.checkDocumentKey(key("123456", "", "L898902C", "690806", "940623")));
    }

    @Test
    public void theTypedKeyGoesIntoThisReadOnly() throws Exception {
        ModelNfc.Command c = cmd("{\"op\":\"eid-read\",\"timeout\":30,\"args\":{\"readPhoto\":false}}");
        ModelNfc.Command k = ModelNfc.withDocumentKey(c, key("123 456", "", "l898902c", "690806", "940623"));
        assertEquals("123456", k.args.optString("can"));
        assertEquals("L898902C", k.args.optString("documentNumber"));
        assertEquals("690806", k.args.optString("dateOfBirth"));
        assertEquals(Boolean.FALSE, k.args.opt("readPhoto"));
        assertEquals(30, k.timeout);
        assertFalse(ModelNfc.needsDocumentKey(k));
        // The model's command is left as it was.
        assertFalse(c.args.has("can"));
        assertTrue(ModelNfc.needsDocumentKey(c));
        // An MRZ wins over the fields.
        ModelNfc.Command m = ModelNfc.withDocumentKey(c, key("", MRZ, "X", "1", "2"));
        assertEquals(MRZ, m.args.optString("mrz"));
        assertFalse(m.args.has("documentNumber"));
    }

    @Test
    public void theKeyNeverReachesTheAnswer() throws Exception {
        String can = "987654";
        // A chip that opens with BAC (the three fields) — the CAN typed beside them is not usable without PACE.
        Bac.MrzKey bac = new Bac.MrzKey("L898902C", "690806", "940623");
        ModelNfc.Command c = ModelNfc.withDocumentKey(cmd("{\"op\":\"eid-read\"}"), key(can, "", "L898902C", "690806", "940623"));
        JSONObject r = ModelNfc.run(c, new FakeCard(NfcCatalog.ISO_DEP, new MrtdDeepTest.Chip(bac, MrtdDeepTest.files()), null));
        assertEquals("ok", r.optString("status"));
        assertEquals("bac", r.getJSONObject("mrtd").optString("access"));
        assertEquals("eid", r.getJSONObject("card").optString("tech"));
        assertFalse(r.toString().contains(can));
        List<String> keys = keysOf(r);
        assertFalse(keys.contains("args"));
        assertFalse(keys.contains("can"));
        assertFalse(keys.contains("key"));

        // A chip that refuses everything: auth-failed, and still no CAN.
        Apdu.Transceiver refuses = cmd2 -> Apdu.u8(0x6a, 0x82);
        JSONObject f = ModelNfc.run(ModelNfc.withDocumentKey(cmd("{\"op\":\"mrtd-read\"}"), key(can, "", "", "", "")), new FakeCard(NfcCatalog.ISO_DEP, refuses, null));
        assertEquals("auth-failed", f.optString("status"));
        assertFalse(f.toString().contains(can));
        assertFalse(keysOf(f).contains("args"));

        // Even a reader error that repeats it is blanked.
        Apdu.Transceiver chatty = cmd2 -> { throw new IOException("the chip said " + can); };
        JSONObject e = ModelNfc.run(ModelNfc.withDocumentKey(cmd("{\"op\":\"eid-read\"}"), key(can, "", "L898902C", "690806", "940623")), new FakeCard(NfcCatalog.ISO_DEP, chatty, null));
        assertFalse(e.toString(), e.toString().contains(can));
    }

    @Test
    public void theSheetSaysWhatIsAsked() {
        assertEquals("nfc.model.what.emv", ModelNfc.whatKey("emv-read"));
        assertEquals("nfc.model.what.eid", ModelNfc.whatKey("mrtd-read"));
        assertEquals("nfc.model.what.eid", ModelNfc.whatKey("eid-read"));
        assertEquals("nfc.model.what.uid", ModelNfc.whatKey("read-uid"));
        assertEquals("nfc.model.what.scan", ModelNfc.whatKey("read-public"));
    }
}
