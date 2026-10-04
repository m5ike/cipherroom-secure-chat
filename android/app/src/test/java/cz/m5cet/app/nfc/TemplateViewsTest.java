package cz.m5cet.app.nfc;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The views of a template run (6.10, apdu-templates.ts TEMPLATE_VIEWS): io, raw
 * and json exactly as the contract writes them (json as JSON.stringify(…, null,
 * 2) does), readable for people — the EMV card report with the card number
 * masked, the e-ID holder, a DESFire's version decoded, BER-TLV with the EMV
 * names, the status words explained, in the app's language.
 */
public class TemplateViewsTest {

    private static List<TemplateRunner.Exchange> sample() {
        return Arrays.asList(
            new TemplateRunner.Exchange(1, "SELECT PPSE (2PAY.SYS.DDF01)", "select-ppse", "00A404000E325041592E5359532E444446303100", "6F0A8408A000000004101000", "9000", "ok", 12),
            new TemplateRunner.Exchange(2, "Counters / log \"format\"", "get-data", "80CA9F6E00", "", "6A88", "warn", 3),
            new TemplateRunner.Exchange(3, "Záznam č. 1\tEF.DIR", "", "00B2010400", "", "", "error", 0));
    }

    @Test
    public void ioIsEveryCommandAndItsResponse() {
        assertEquals("→ 00A404000E325041592E5359532E444446303100\n"
            + "← 6F0A8408A000000004101000 9000 (OK)\n"
            + "→ 80CA9F6E00\n"
            + "← 6A88 (Referenced data not found)\n"
            + "→ 00B2010400\n"
            + "← (no answer)", TemplateViews.io(sample()));
        assertEquals("", TemplateViews.io(new ArrayList<>()));
    }

    @Test
    public void rawIsTheResponsesOnly() {
        assertEquals("6F0A8408A000000004101000 9000\n6A88\n(no answer)", TemplateViews.raw(sample()));
    }

    @Test
    public void jsonIsTheExchangesAsJsonStringifyWritesThem() throws Exception {
        String json = TemplateViews.json(sample());
        assertEquals("[\n"
            + "  {\n"
            + "    \"step\": 1,\n"
            + "    \"label\": \"SELECT PPSE (2PAY.SYS.DDF01)\",\n"
            + "    \"op\": \"select-ppse\",\n"
            + "    \"command\": \"00A404000E325041592E5359532E444446303100\",\n"
            + "    \"response\": \"6F0A8408A000000004101000\",\n"
            + "    \"sw\": \"9000\",\n"
            + "    \"status\": \"ok\",\n"
            + "    \"ms\": 12\n"
            + "  },\n"
            + "  {\n"
            + "    \"step\": 2,\n"
            + "    \"label\": \"Counters / log \\\"format\\\"\",\n"
            + "    \"op\": \"get-data\",\n"
            + "    \"command\": \"80CA9F6E00\",\n"
            + "    \"response\": \"\",\n"
            + "    \"sw\": \"6A88\",\n"
            + "    \"status\": \"warn\",\n"
            + "    \"ms\": 3\n"
            + "  },\n"
            + "  {\n"
            + "    \"step\": 3,\n"
            + "    \"label\": \"Záznam č. 1\\tEF.DIR\",\n"
            + "    \"op\": \"\",\n"
            + "    \"command\": \"00B2010400\",\n"
            + "    \"response\": \"\",\n"
            + "    \"sw\": \"\",\n"
            + "    \"status\": \"error\",\n"
            + "    \"ms\": 0\n"
            + "  }\n"
            + "]", json);
        // It is JSON, and it says what the exchanges say.
        JSONArray back = new JSONArray(json);
        assertEquals(3, back.length());
        assertEquals("Counters / log \"format\"", back.getJSONObject(1).getString("label"));
        assertEquals("[]", TemplateViews.json(new ArrayList<>()));
        assertEquals("\"a\\u0001\\ud800b\"", TemplateViews.str("a\u0001\ud800b"));
    }

    @Test
    public void theStatusWordsAreTheWebsWords() {
        assertEquals("OK", StatusWords.describe(0x9000));
        assertEquals("OK, 16 more byte(s) available (GET RESPONSE)", StatusWords.describe(0x6110));
        assertEquals("Wrong Le, retry with Le=8", StatusWords.describe(0x6c08));
        assertEquals("Verification failed, 2 retries left", StatusWords.describe(0x63c2));
        assertEquals("End of file reached before Le", StatusWords.describe(0x6282));
        assertEquals("DESFire status af (ADDITIONAL_FRAME)", StatusWords.describe(0x91af));
        assertEquals("DESFire status 00 (OPERATION_OK)", StatusWords.describe(0x9100));
        assertEquals("File or application not found", StatusWords.describe(0x6a82));
        assertEquals("Unknown status 6A99", StatusWords.describe(0x6a99));
        assertEquals("no answer", StatusWords.describe(""));
    }

    /* ------------------------------------------------------------ readable */

    private static final TemplateViews.Labels CS = new TemplateViews.Labels() {
        final Map<String, String> m = new HashMap<>();
        { m.put("nfc.tpl.r.pan", "Číslo karty"); m.put("nfc.tpl.r.steps", "Kroky"); m.put("nfc.emv.expiry", "Platnost do"); }
        @Override public String t(String key) { return m.containsKey(key) ? m.get(key) : key; }
    };

    @Test
    public void readableIsTheCardReportWithTheCardNumberMasked() throws Exception {
        SimCards.Emv card = new SimCards.Emv(true, false, "A0000000041010");
        TemplateRunner.Result r = new TemplateRunner(TemplateRunnerTest.template("Payment card (EMV) — every")).run(card);
        r.cardInfo = new JSONObject().put("uid", "08A1B2C3").put("label", "EMV payment card").put("ats", "7880");
        String text = TemplateViews.readable(r, CS, true);
        String title = "Payment card (EMV) — every application";
        assertTrue(text.startsWith(title + "\n" + new String(new char[title.length()]).replace('\0', '=') + "\nPPSE → each application"));
        assertTrue(text.contains("\nUID         08A1B2C3\n"));
        assertTrue(text.contains("Application — MASTERCARD\n------------------------"));
        assertTrue(text.contains("Číslo karty"));                 // the app's own words
        assertTrue(text.contains("541333••••••0011"));
        assertTrue(text.contains("Platnost do"));
        assertTrue(text.contains("2028-12"));
        assertTrue(text.contains("Transaction history — MASTERCARD (2)"));  // English where the app has no word
        assertTrue(text.contains("2025-09-14  18:30:05  123.45  CZK"));
        assertTrue(text.contains("BILLA"));
        assertTrue(text.contains("9F36 Application transaction counter (ATC)"));
        // The whole number never shows: records and elements carry it masked.
        assertFalse(text.contains("5413330089020011"));
        assertTrue(text.contains("541333XXXXXX0011"));
        assertTrue(text.contains("SFI 11 ·  1 (log)"));
        // The steps, each with what it did.
        assertTrue(text.contains("\nKroky (8)\n"));
        assertTrue(text.contains("1 ✓  SELECT PPSE (2PAY.SYS.DDF01) — 1 application(s) listed"));
        assertTrue(text.contains("A0000000041010 · GET PROCESSING OPTIONS (no transaction) — AIP 1980 · AFL 0801010010010100"));
        assertTrue(text.endsWith("\n"));
        // Without the card sections (the workbench draws those) the steps stay.
        String generic = TemplateViews.readable(r, CS, false);
        assertFalse(generic.contains("Číslo karty"));
        assertTrue(generic.contains("Kroky (8)"));
    }

    @Test
    public void readableDecodesADesfiresVersion() throws Exception {
        TemplateRunner.Result r = new TemplateRunner(TemplateRunnerTest.template("MIFARE DESFire")).run(new SimCards.Desfire());
        String text = TemplateViews.readable(r, null, true);
        assertTrue(text.contains("\nMIFARE DESFire\n--------------\n"));
        assertTrue(text.contains("Vendor               NXP"));
        assertTrue(text.contains("MIFARE DESFire EV1"));
        assertTrue(text.contains("1.0 (type 01, subtype 01)"));
        assertTrue(text.contains("Software             1.4"));
        assertTrue(text.contains("Storage              8 KB"));
        assertTrue(text.contains("UID                  04112233445566"));
        assertTrue(text.contains("Batch                BA7C123456"));
        assertTrue(text.contains("week 12 of 2019"));
        assertTrue(text.contains("123456, 0B0C0D"));
        assertTrue(text.contains("Free memory          4096 B"));
        assertTrue(text.contains("0F · 1 key(s), AES"));
        assertTrue(text.contains("master key changeable, applications listed without a key, applications created without a key, settings changeable"));
        assertTrue(text.contains("✓ 91AF — DESFire status af (ADDITIONAL_FRAME)"));
        assertEquals("2 KB – 4 KB", TemplateViews.storage(0x17));
        assertEquals("MIFARE DESFire EV3", TemplateViews.product(0x01, 0x33));
    }

    @Test
    public void readableDecodesBerTlvWithTheNames() throws Exception {
        TemplateRunner.Result r = new TemplateRunner(TemplateRunnerTest.template("Smart card (ISO 7816-4)")).run(new SimCards.Iso());
        String text = TemplateViews.readable(r, null, true);
        assertTrue(text.contains("3. READ RECORD 1 of EF.DIR"));
        assertTrue(text.contains("61 Application template\n  4F Application identifier (AID): A0000002471001\n  50 Application label: ICAO eMRTD  (4943414F20654D525444)"));
        assertTrue(text.contains("  51 Path: 3F00"));
        assertTrue(text.contains("43 Card service data: F0\n47 Card capabilities: 9481C1"));
        assertTrue(text.contains("⚠ 6A83 — Record not found"));
        assertTrue(TemplateViews.isTlv(SimCards.DIR2));
        assertFalse(TemplateViews.isTlv(Apdu.unhex("04010101001A05")));
    }

    @Test
    public void readableShowsTheDocumentHolder() throws Exception {
        MrtdDeepTest.Chip chip = new MrtdDeepTest.Chip(new Bac.MrzKey("L898902C", "690806", "940623"), MrtdDeepTest.files());
        MrtdReader.Options o = new MrtdReader.Options();
        o.key = new Bac.MrzKey("L898902C", "690806", "940623");
        TemplateRunner.Result r = new TemplateRunner(TemplateRunnerTest.template("e-ID / e-passport (PACE")).mrtd(o).run(chip);
        String text = TemplateViews.readable(r, null, true);
        assertTrue(text.contains("\nHolder\n------\n"));
        assertTrue(text.contains("ANNA MARIA ERIKSSON"));
        assertTrue(text.contains("L898902C"));
        assertTrue(text.contains("BAC (MRZ)"));
        assertTrue(text.contains("Personal details (DG11)"));
        assertTrue(text.contains("✓ every group read matches EF.SOD"));
        assertTrue(text.contains("Face · DG2"));
        assertFalse(text.contains("/9j/")); // pictures are named, never dumped
    }

    /* ------------------------------------------------------------ G-19: masked card numbers */

    private static String xs(int n) { return new String(new char[n]).replace('\0', 'X'); }

    @Test
    public void everyViewMasksTheCardNumberUnlessTheUserAsksForIt() throws Exception {
        SimCards.Emv card = new SimCards.Emv(true, false, "A0000000041010");
        TemplateRunner.Result r = new TemplateRunner(TemplateRunnerTest.template("Payment card (EMV) — every")).run(card);
        String pan = "5413330089020011", asciiPan = TemplateViews.asciiHex(pan);
        assertTrue(TemplateViews.pans(r).contains(pan));
        assertTrue(TemplateViews.masks(r));
        for (String v : TemplateViews.VIEWS) {
            String text = TemplateViews.view(v, r, null);
            assertFalse(v, text.contains(pan));
            assertFalse(v, text.contains(asciiPan));
            assertFalse(v, text.contains("1234567890")); // Track 2 / Track 1 discretionary data
        }
        String io = TemplateViews.view(TemplateViews.IO, r, null);
        assertTrue(io.contains("5A08541333XXXXXX0011"));                                          // the PAN
        assertTrue(io.contains("5711541333XXXXXX0011D" + xs(17)));                                // Track 2: the rest redacted
        assertTrue(io.contains("562C" + "42" + TemplateViews.asciiHex("541333") + xs(12) + TemplateViews.asciiHex("0011") + xs(54))); // Track 1 (ASCII)
        assertTrue(io.contains("9F1F0A" + xs(20)));
        assertTrue(TemplateViews.view(TemplateViews.JSON, r, null).contains("541333XXXXXX0011"));
        // The full data only when asked for.
        assertTrue(TemplateViews.view(TemplateViews.IO, r, null, true).contains("5A085413330089020011"));
        assertTrue(TemplateViews.view(TemplateViews.RAW, r, null, true).contains(asciiPan));
        assertTrue(TemplateViews.view(TemplateViews.READABLE, r, null, true).contains(pan));
        // The readable view says it is masked; the full one does not.
        assertTrue(TemplateViews.view(TemplateViews.READABLE, r, null).contains("Card numbers and track data are masked."));
        assertFalse(TemplateViews.view(TemplateViews.READABLE, r, null, true).contains("are masked"));
        // The masking never touches what the runner keeps.
        assertTrue(r.exchanges.stream().anyMatch(e -> e.response.contains(pan)));
    }

    @Test
    public void theWorkbenchsEmvObjectIsMaskedToo() throws Exception {
        SimCards.Emv card = new SimCards.Emv(true, false, "A0000000041010");
        TemplateRunner.Result r = new TemplateRunner(TemplateRunnerTest.template("Mastercard")).run(card);
        JSONObject m = TemplateViews.maskedEmv(r.emv, TemplateViews.pans(r));
        String all = m.toString();
        assertFalse(all.contains("5413330089020011"));
        assertFalse(all.contains(TemplateViews.asciiHex("5413330089020011")));
        JSONObject app = m.optJSONArray("apps").optJSONObject(0);
        assertFalse(app.has("pan"));
        assertEquals("541333••••••0011", app.optString("panMasked"));
        assertTrue(r.emv.optJSONArray("apps").optJSONObject(0).has("pan")); // the run's own object stays whole
    }

    @Test
    public void aFixedCommandThatReadsTheCardNumberIsMaskedToo() throws Exception {
        SimCards.Emv card = new SimCards.Emv(false, false, "A0000000041010");
        ApduTemplates.Template t = ApduTemplates.parse(new JSONObject().put("label", "by hand").put("apdu", "00A4040007A0000000041010\n00B2010C00"), 0);
        TemplateRunner.Result r = new TemplateRunner(t).run(card);
        assertNull(r.emv);
        assertTrue(TemplateViews.pans(r).contains("5413330089020011"));
        String readable = TemplateViews.view(TemplateViews.READABLE, r, null);
        assertFalse(readable.contains("5413330089020011"));
        assertTrue(readable.contains("5A Application PAN: 541333XXXXXX0011"));
        assertFalse(TemplateViews.view(TemplateViews.IO, r, null).contains("5413330089020011"));
    }

    @Test
    public void aRunWithoutCardNumbersMasksNothing() throws Exception {
        TemplateRunner.Result r = new TemplateRunner(TemplateRunnerTest.template("MIFARE DESFire")).run(new SimCards.Desfire());
        assertFalse(TemplateViews.masks(r));
        assertEquals(TemplateViews.view(TemplateViews.IO, r, null, true), TemplateViews.view(TemplateViews.IO, r, null));
        assertFalse(TemplateViews.view(TemplateViews.READABLE, r, null).contains("are masked"));
    }

    @Test
    public void aCancelledRunSaysSo() throws Exception {
        TemplateRunner runner = new TemplateRunner(TemplateRunnerTest.template("MIFARE DESFire"));
        runner.cancel();
        TemplateRunner.Result r = runner.run(new SimCards.Desfire());
        assertTrue(r.exchanges.isEmpty());
        String text = TemplateViews.view(TemplateViews.READABLE, r, null);
        assertTrue(text.contains("Cancelled — this is what was read before."));
        assertEquals("", TemplateViews.view(TemplateViews.IO, r, null));
        assertEquals("[]", TemplateViews.view(TemplateViews.JSON, r, null));
    }
}
