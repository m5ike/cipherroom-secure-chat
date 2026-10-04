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
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * The 6.10 template runner against simulated cards: every template of the
 * standard set (android/app/src/test/resources/nfc/standard-apdu-templates.json —
 * test/android-nfc-610.test.ts keeps it equal to apdu-templates.ts
 * STANDARD_APDU_TEMPLATES) runs end to end on a card of its type; every APDU
 * that reaches the card is recorded (the e-ID read's secure messaging too);
 * optional steps are tolerated; for-each-aid reads every application the
 * directory lists; older entries (one command, command lines, one whole-read
 * op with its aid) still run; a cancel or a card that leaves ends the run with
 * what was read. Nothing here writes: the cards fail the test on VERIFY,
 * GENERATE AC or a write.
 */
public class TemplateRunnerTest {

    static JSONArray standard() throws Exception {
        try (InputStream in = TemplateRunnerTest.class.getClassLoader().getResourceAsStream("nfc/standard-apdu-templates.json")) {
            assertNotNull("the standard set fixture", in);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return new JSONArray(new String(out.toByteArray(), StandardCharsets.UTF_8));
        }
    }

    static ApduTemplates.Template template(String labelStart) throws Exception {
        for (ApduTemplates.Template t : ApduTemplates.parse(standard())) if (t.label.startsWith(labelStart)) return t;
        throw new AssertionError("no standard template " + labelStart);
    }

    private static final String MRZ = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C<3UTO6908061F9406236ZE184226B<<<<<10";
    private static final Bac.MrzKey KEY = new Bac.MrzKey("L898902C", "690806", "940623");

    private static List<String> commands(TemplateRunner.Result r) {
        List<String> out = new ArrayList<>();
        for (TemplateRunner.Exchange e : r.exchanges) out.add(e.command);
        return out;
    }

    private static TemplateRunner.StepResult step(TemplateRunner.Result r, String op, String aid) {
        for (TemplateRunner.StepResult s : r.steps) if (s.op.equals(op) && (aid == null || aid.equals(s.aid) || s.label.contains(aid))) return s;
        return null;
    }

    private static int count(TemplateRunner.Result r, String op) { int n = 0; for (TemplateRunner.StepResult s : r.steps) if (s.op.equals(op)) n++; return n; }

    /** Every exchange the card saw is in the transcript, in order, and each step's exchanges carry its number and label. */
    private static void everyApduRecorded(SimCards.Card card, TemplateRunner.Result r) {
        assertEquals(card.seen, commands(r));
        int last = 0;
        for (TemplateRunner.Exchange e : r.exchanges) {
            assertTrue("steps in order", e.step >= last);
            last = e.step;
            TemplateRunner.StepResult s = r.steps.get(e.step - 1);
            assertEquals(s.step, e.step);
            assertEquals(s.label, e.label);
            assertEquals(s.op, e.op);
            assertTrue(Arrays.asList("ok", "warn", "error").contains(e.status));
        }
        assertTrue(card.forbidden.isEmpty());
    }

    /* ------------------------------------------------------------ the standard set */

    @Test
    public void theStandardSetIsRunnableAndGroupedByCardType() throws Exception {
        List<ApduTemplates.Template> all = ApduTemplates.parse(standard());
        assertEquals(16, all.size());
        List<String> cards = new ArrayList<>();
        for (ApduTemplates.Template t : all) {
            assertTrue(t.label + ": " + t.problems, t.runnable());
            assertNull(t.legacy);
            assertFalse(t.note.isEmpty());
            cards.add(t.cardType());
        }
        assertEquals(12, java.util.Collections.frequency(cards, "emv"));
        assertEquals(2, java.util.Collections.frequency(cards, "emrtd"));
        assertEquals(1, java.util.Collections.frequency(cards, "desfire"));
        assertEquals(1, java.util.Collections.frequency(cards, "iso7816"));
        assertNotNull(template("e-ID / e-passport (PACE").eidRead());
        assertNull(template("Visa (credit").eidRead());
    }

    @Test
    public void everyApplicationOfAPaymentCardIsReadCompletely() throws Exception {
        SimCards.Emv card = new SimCards.Emv(true, false, "A0000000031010", "A0000000041010");
        List<String> progress = new ArrayList<>();
        TemplateRunner.Result r = new TemplateRunner(template("Payment card (EMV) — every")).listener(new TemplateRunner.Listener() {
            @Override public void onStep(int n, int total, String label) { progress.add(n + "/" + total + " " + label); }
            @Override public void onExchange(TemplateRunner.Exchange e) { }
        }).run(card);
        everyApduRecorded(card, r);
        assertNull(r.error);
        assertFalse(r.cancelled);
        assertEquals("emv", r.card);
        JSONObject emv = r.emv;
        assertNotNull(emv);
        assertEquals(Arrays.asList("A0000000031010", "A0000000041010"), strings(emv.optJSONArray("aids")));
        assertTrue(emv.optBoolean("deep"));
        JSONArray apps = emv.optJSONArray("apps");
        assertEquals(2, apps.length());
        JSONObject visa = apps.optJSONObject(0), mc = apps.optJSONObject(1);
        assertEquals("A0000000031010", visa.optString("aid"));
        assertEquals("Visa", visa.optString("scheme"));
        assertEquals("4111111111111111", visa.optString("pan"));
        assertEquals("Mastercard", mc.optString("scheme"));
        assertEquals("2028-12", mc.optString("expiry"));
        assertEquals("NOVAK / JAN", mc.optString("cardholder"));
        assertEquals(42, mc.optInt("atc"));
        assertEquals(3, mc.optInt("pinTryCounter"));
        assertEquals(2, mc.optJSONArray("log").length());
        assertEquals("BILLA", mc.optJSONArray("log").optJSONObject(0).optString("merchant"));
        // The AFL's records, the file only the deep read finds, and the log's own records.
        List<String> recs = new ArrayList<>();
        JSONArray rr = mc.optJSONArray("records");
        for (int i = 0; i < rr.length(); i++) recs.add(rr.optJSONObject(i).optInt("sfi") + ":" + rr.optJSONObject(i).optInt("record"));
        assertEquals(Arrays.asList("1:1", "2:1", "3:1", "11:1", "11:2"), recs);
        // Each application: SELECT, GET DATA, the log, GPO, the AFL, the other files — in that order.
        assertEquals(2, count(r, "select-aid"));
        assertEquals(2, count(r, "gpo"));
        assertEquals("ok", step(r, "gpo", "A0000000041010").status);
        assertEquals("ok", step(r, "read-log", "A0000000041010").status);
        assertEquals("nfc.tpl.n.apps", step(r, "for-each-aid", null).noteKey);
        assertEquals("2", step(r, "for-each-aid", null).noteArgs[0]);
        int log = card.seen.indexOf("00B2015C00"), gpo = -1;
        for (int i = 0; i < card.seen.size(); i++) if (card.seen.get(i).startsWith("80A8")) { gpo = i; break; }
        assertTrue(log > -1 && gpo > log); // the history before GPO (outside a transaction)
        // A missing GET DATA tag is tolerated (9F6E), not an error.
        boolean sawMissing = false;
        for (TemplateRunner.Exchange e : r.exchanges) if (e.command.equals("80CA9F6E00")) { assertEquals("6A88", e.sw); assertEquals("warn", e.status); sawMissing = true; }
        assertTrue(sawMissing);
        assertEquals("ok", r.status());
        // Progress: the template's two steps, the nested ones naming their application.
        assertEquals("1/2 SELECT PPSE (2PAY.SYS.DDF01)", progress.get(0));
        assertTrue(progress.contains("2/2 A0000000041010 · GET PROCESSING OPTIONS (no transaction)"));
        assertEquals(r.emv.optInt("apdus"), r.exchanges.size());
    }

    @Test
    public void theContactDirectoryListsTheApplicationsForAUsbReader() throws Exception {
        SimCards.Emv card = new SimCards.Emv(false, true, "A0000000041010");
        TemplateRunner.Result r = new TemplateRunner(template("Payment card (EMV, contact")).run(card);
        everyApduRecorded(card, r);
        TemplateRunner.StepResult pse = r.steps.get(0);
        assertEquals("select-pse", pse.op);
        assertEquals("ok", pse.status);
        assertEquals("1", pse.noteArgs[0]);
        assertTrue(card.seen.contains("00B2010C00")); // the directory's record (SFI 1)
        assertEquals(Arrays.asList("A0000000041010"), strings(r.emv.optJSONArray("aids")));
        assertEquals("5413330089020011", r.emv.optJSONArray("apps").optJSONObject(0).optString("pan"));
        assertTrue(r.emv.optString("tree").contains("4F (7) A0 00 00 00 04 10 10"));
    }

    @Test
    public void everySchemeTemplateReadsItsOwnApplication() throws Exception {
        int schemes = 0;
        for (ApduTemplates.Template t : ApduTemplates.parse(standard())) {
            if (!"emv".equals(t.card) || t.aid.isEmpty()) continue;
            schemes++;
            SimCards.Emv card = new SimCards.Emv(true, false, t.aid);
            TemplateRunner.Result r = new TemplateRunner(t).run(card);
            everyApduRecorded(card, r);
            assertEquals(t.label, "ok", r.status());
            JSONArray apps = r.emv.optJSONArray("apps");
            assertEquals(t.label, 1, apps.length());
            assertEquals(t.aid, apps.optJSONObject(0).optString("aid"));
            assertEquals(t.label, 2, apps.optJSONObject(0).optJSONArray("log").length());
            assertEquals(7, r.steps.size()); // the directory, then SELECT, counters, history, GPO, the AFL, the other files
        }
        assertEquals(10, schemes);
    }

    @Test
    public void aSchemeTemplateOnAnotherCardSaysTheApplicationIsMissing() throws Exception {
        SimCards.Emv card = new SimCards.Emv(true, false, "A0000000041010");
        TemplateRunner.Result r = new TemplateRunner(template("Visa (credit")).run(card);
        everyApduRecorded(card, r);
        TemplateRunner.StepResult sel = step(r, "select-aid", null);
        assertEquals("error", sel.status);
        assertEquals("nfc.tpl.n.notSelected", sel.noteKey);
        assertEquals("error", r.exchanges.get(r.exchanges.size() - 1).status);
        assertEquals(2, r.steps.size()); // nothing after the SELECT that failed
        for (String c : card.seen) assertFalse(c.startsWith("80A8"));
        assertEquals("error", r.status());
        assertEquals(0, r.emv.optJSONArray("apps").length());
    }

    @Test
    public void withoutADirectoryForEachAidTriesTheKnownApplications() throws Exception {
        SimCards.Emv card = new SimCards.Emv(false, false, "A0000000041010");
        TemplateRunner.Result r = new TemplateRunner(template("Payment card (EMV) — every")).run(card);
        everyApduRecorded(card, r);
        assertEquals("warn", r.steps.get(0).status); // the optional PPSE
        assertEquals("nfc.tpl.n.noDir", r.steps.get(0).noteKey);
        JSONArray apps = r.emv.optJSONArray("apps");
        assertEquals(1, apps.length());
        assertEquals("A0000000041010", apps.optJSONObject(0).optString("aid"));
        // The probes that missed are warnings, not errors.
        for (TemplateRunner.StepResult s : r.steps) if (s.op.equals("select-aid") && !s.label.contains("A0000000041010")) assertEquals("warn", s.status);
        assertEquals("warn", r.status());
    }

    /* ------------------------------------------------------------ e-ID */

    @Test
    public void theEidTemplateOpensTheDocumentAndRecordsEverySecureMessagingApdu() throws Exception {
        MrtdDeepTest.Chip chip = new MrtdDeepTest.Chip(KEY, MrtdDeepTest.files());
        ApduTemplates.Template t = template("e-ID / e-passport (PACE");
        MrtdReader.Options o = new MrtdReader.Options();
        o.mrz = MRZ;
        o.readPhoto = t.eidRead().args.optBoolean("readPhoto", true);
        o.all = t.eidRead().args.optBoolean("all", true);
        TemplateRunner.Result r = new TemplateRunner(t).mrtd(o).run(chip);
        assertEquals("emrtd", r.card);
        assertEquals(chip.log, commands(r)); // every APDU, the protected ones too
        assertTrue(r.exchanges.size() > 20);
        int sm = 0;
        for (TemplateRunner.Exchange e : r.exchanges) if (e.command.startsWith("0C")) sm++;
        assertTrue(sm > 10);
        assertEquals("ok", r.steps.get(0).status);
        assertEquals("bac", r.mrtd.optString("access"));
        assertEquals("ERIKSSON", r.mrtd.optJSONObject("mrzInfo").optString("surname"));
        assertTrue(chip.selected.contains(0x0102)); // the face
        assertNull(r.emv);
    }

    @Test
    public void theMrzOnlyTemplateReadsNoPicture() throws Exception {
        MrtdDeepTest.Chip chip = new MrtdDeepTest.Chip(KEY, MrtdDeepTest.files());
        ApduTemplates.Template t = template("e-ID / e-passport — MRZ");
        MrtdReader.Options o = new MrtdReader.Options();
        o.key = KEY;
        o.readPhoto = t.eidRead().args.optBoolean("readPhoto", true);
        o.all = t.eidRead().args.optBoolean("all", true);
        assertFalse(o.readPhoto);
        TemplateRunner.Result r = new TemplateRunner(t).mrtd(o).run(chip);
        assertEquals(chip.log, commands(r));
        assertTrue(chip.selected.contains(0x0101));
        assertFalse(chip.selected.contains(0x0102));
        assertEquals("L898902C", r.mrtd.optJSONObject("mrzInfo").optString("documentNumber"));
    }

    @Test
    public void withoutTheHoldersKeyTheEidReadSaysWhatItNeeds() throws Exception {
        MrtdDeepTest.Chip chip = new MrtdDeepTest.Chip(KEY, MrtdDeepTest.files());
        TemplateRunner.Result r = new TemplateRunner(template("e-ID / e-passport (PACE")).run(chip);
        assertEquals("error", r.steps.get(0).status);
        assertTrue(r.steps.get(0).note.contains("MRZ"));
        assertEquals(chip.log, commands(r));
    }

    /* ------------------------------------------------------------ DESFire / ISO 7816 */

    @Test
    public void theDesfireTemplateRunsEveryCommand() throws Exception {
        SimCards.Desfire card = new SimCards.Desfire();
        TemplateRunner.Result r = new TemplateRunner(template("MIFARE DESFire")).run(card);
        everyApduRecorded(card, r);
        assertEquals(Arrays.asList("9060000000", "90AF000000", "90AF000000", "906A000000", "906E000000", "9045000000"), commands(r));
        for (TemplateRunner.Exchange e : r.exchanges) assertEquals(e.command, "ok", e.status); // 91AF is what the first two expect
        assertEquals("91AF", r.exchanges.get(0).sw);
        assertEquals("04010101001A05", r.steps.get(0).data);
        assertEquals("ok", r.status());
        assertNull(r.emv);
    }

    @Test
    public void theIso7816TemplateFollowsGetResponseAndWrongLe() throws Exception {
        SimCards.Iso card = new SimCards.Iso();
        TemplateRunner.Result r = new TemplateRunner(template("Smart card (ISO 7816-4)")).run(card);
        everyApduRecorded(card, r);
        List<String> cmds = commands(r);
        // 61xx → GET RESPONSE, inside the same step; 6Cxx → the command again with the right Le.
        int rec1 = cmds.indexOf("00B2010400");
        assertEquals("00C00000" + String.format("%02X", SimCards.DIR1.length), cmds.get(rec1 + 1));
        assertEquals(r.exchanges.get(rec1).step, r.exchanges.get(rec1 + 1).step);
        assertEquals("ok", r.exchanges.get(rec1).status);
        int bin = cmds.indexOf("00B0000000");
        assertEquals("6C08", r.exchanges.get(bin).sw);
        assertEquals("00B0000008", cmds.get(bin + 1));
        TemplateRunner.StepResult rec1Step = r.steps.get(r.exchanges.get(rec1).step - 1);
        assertEquals(Apdu.hex(SimCards.DIR1), rec1Step.data);
        assertEquals("9000", rec1Step.sw);
        // Records 3 and 4 are not there: optional, so warnings.
        assertEquals("warn", r.steps.get(4).status);
        assertEquals("warn", r.steps.get(5).status);
        assertEquals("6A83", r.steps.get(4).sw);
        assertEquals(Apdu.hex(SimCards.ATR), r.steps.get(7).data);
        assertEquals("warn", r.status());
    }

    /* ------------------------------------------------------------ steps, expect, optional */

    private static ApduTemplates.Template one(JSONObject t) { return ApduTemplates.parse(t, 0); }

    @Test
    public void aFixedCommandSucceedsByWhatItExpects() throws Exception {
        SimCards.Desfire card = new SimCards.Desfire();
        JSONObject t = new JSONObject().put("label", "DESFire by hand").put("steps", new JSONArray()
            .put(new JSONObject().put("apdu", "90 60 00 00 00").put("expect", new JSONArray().put("91xx")))
            .put(new JSONObject().put("apdu", "9060000000"))                                  // 91AF ≠ 9000: an error
            .put(new JSONObject().put("apdu", "906E000000").put("optional", true)));          // 9100 ≠ 9000: optional, a warning
        TemplateRunner.Result r = new TemplateRunner(one(t)).run(card);
        assertEquals(Arrays.asList("ok", "error", "warn"), Arrays.asList(r.steps.get(0).status, r.steps.get(1).status, r.steps.get(2).status));
        assertEquals(Arrays.asList("ok", "error", "warn"), Arrays.asList(r.exchanges.get(0).status, r.exchanges.get(1).status, r.exchanges.get(2).status));
        assertEquals("9060000000", r.steps.get(0).label);
        assertEquals("error", r.status());
        assertTrue(TemplateRunner.expected(Arrays.asList("6Cxx", "9000"), 0x6c10));
        assertFalse(TemplateRunner.expected(new ArrayList<>(), 0x9100));
    }

    @Test
    public void forEachAidRunsItsOwnListAtMostMaxTimes() throws Exception {
        SimCards.Emv card = new SimCards.Emv(true, false, "A0000000031010", "A0000000041010");
        JSONObject t = new JSONObject().put("label", "two lists").put("steps", new JSONArray()
            .put(new JSONObject().put("op", "for-each-aid").put("aids", new JSONArray().put("A0000000041010").put("A0000000031010")).put("max", 1)
                .put("steps", new JSONArray().put(new JSONObject().put("op", "select-aid")).put(new JSONObject().put("op", "gpo")).put(new JSONObject().put("op", "read-afl")))));
        TemplateRunner.Result r = new TemplateRunner(one(t)).run(card);
        everyApduRecorded(card, r);
        assertEquals(1, r.emv.optJSONArray("apps").length());
        assertEquals("A0000000041010", r.emv.optJSONArray("apps").optJSONObject(0).optString("aid"));
        assertFalse(r.emv.optBoolean("deep"));
        assertEquals("1", step(r, "for-each-aid", null).noteArgs[0]);
        assertEquals(2, r.emv.optJSONArray("apps").optJSONObject(0).optJSONArray("records").length());
    }

    @Test
    public void olderEntriesStillRun() throws Exception {
        // One command per line (≤ 6.9).
        SimCards.Emv card = new SimCards.Emv(true, false, "A0000000041010");
        JSONObject lines = new JSONObject().put("label", "Select MC").put("apdu", "00A4040007A0000000041010\n80CA9F1700\nzz");
        ApduTemplates.Template t = one(lines);
        assertEquals("apdu", t.legacy);
        assertTrue(t.runnable());
        assertEquals(2, t.steps.size());
        TemplateRunner.Result r = new TemplateRunner(t).run(card);
        assertEquals(Arrays.asList("00A4040007A0000000041010", "80CA9F1700"), commands(r));
        assertEquals("ok", r.status());
        // One whole read with its preferred application: read first.
        SimCards.Emv two = new SimCards.Emv(true, false, "A0000000031010", "A0000000041010");
        JSONObject op = new JSONObject().put("label", "EMV").put("op", "emv-read").put("aid", "A0000000041010").put("args", new JSONObject().put("deep", false));
        ApduTemplates.Template et = one(op);
        assertEquals("op", et.legacy);
        assertEquals("A0000000041010", et.steps.get(0).args.optString("aid"));
        TemplateRunner.Result er = new TemplateRunner(et).run(two);
        everyApduRecorded(two, er);
        assertEquals("A0000000041010", er.emv.optJSONArray("apps").optJSONObject(0).optString("aid"));
        assertEquals(2, er.emv.optJSONArray("apps").length());
        assertTrue(er.steps.get(0).note.contains("Mastercard"));
        // The e-ID op.
        ApduTemplates.Template eid = one(new JSONObject().put("label", "ID").put("op", "eid-read"));
        assertNotNull(eid.eidRead());
        assertEquals("emrtd", eid.cardType());
        // A plain string is not a template (as on the web).
        assertEquals(Arrays.asList("not an object"), ApduTemplates.parse("00A40400", 3).problems);
    }

    @Test
    public void theProblemsAreTheContracts() throws Exception {
        assertEquals(Arrays.asList("not an object"), ApduTemplates.templateProblems(null));
        assertEquals(Arrays.asList("no label", "nothing to run: no steps, op or apdu"), ApduTemplates.templateProblems(new JSONObject()));
        assertEquals(Arrays.asList("no label", "nothing to run: no steps, op or apdu"), ApduTemplates.templateProblems(new JSONArray()));
        assertEquals(Arrays.asList("bad command 00A4"), ApduTemplates.templateProblems(new JSONObject().put("label", "x").put("steps", new JSONArray().put(new JSONObject().put("apdu", "00A4")))));
        assertEquals(Arrays.asList("bad command 00A4040"), ApduTemplates.templateProblems(new JSONObject().put("label", "x").put("steps", new JSONArray().put(new JSONObject().put("apdu", "00A4040")))));
        assertEquals(Arrays.asList("bad AID A0"), ApduTemplates.templateProblems(new JSONObject().put("label", "x").put("steps", new JSONArray().put(new JSONObject().put("op", "select-aid").put("aid", "A0")))));
        assertEquals(Arrays.asList("get-data needs 2-byte tags"), ApduTemplates.templateProblems(new JSONObject().put("label", "x").put("steps", new JSONArray().put(new JSONObject().put("op", "get-data").put("tags", new JSONArray().put("9F"))))));
        assertEquals(Arrays.asList("get-data needs 2-byte tags"), ApduTemplates.templateProblems(new JSONObject().put("label", "x").put("steps", new JSONArray().put(new JSONObject().put("op", "get-data")))));
        JSONObject deep = new JSONObject().put("op", "for-each-aid").put("steps", new JSONArray().put(new JSONObject().put("op", "for-each-aid").put("steps", new JSONArray()
            .put(new JSONObject().put("op", "for-each-aid").put("steps", new JSONArray().put(new JSONObject().put("op", "gpo")))))));
        assertEquals(Arrays.asList("for-each-aid nested too deep"), ApduTemplates.templateProblems(new JSONObject().put("label", "x").put("steps", new JSONArray().put(deep))));
        assertEquals(new ArrayList<String>(), ApduTemplates.templateProblems(new JSONObject().put("label", "x").put("apduHex", "00A40400")));
        // The standard set has none.
        JSONArray std = standard();
        for (int i = 0; i < std.length(); i++) assertEquals(new ArrayList<String>(), ApduTemplates.templateProblems(std.get(i)));
        // A template with a problem is listed but does not run.
        ApduTemplates.Template bad = ApduTemplates.parse(new JSONObject().put("label", "bad").put("steps", new JSONArray().put(new JSONObject().put("apdu", "zz"))), 2);
        assertFalse(bad.runnable());
        assertEquals("bad", bad.label);
    }

    /* ------------------------------------------------------------ G-18: read-only */

    @Test
    public void onlyReadCommandsAreAllowed() {
        for (String ok : new String[]{"00A4040007A0000000041010", "00A4000C023F00", "00B0000000", "0CB0000000", "00B2010C00", "80CA9F1700", "00CA9F7F00",
            "80A8000002830000", "00C0000010", "80C0000010", "9060000000", "90AF000000", "906A000000", "906E000000", "9045000000"})
            assertNull(ok, ApduTemplates.commandProblem(ok));
        assertEquals("not a read command: 00 20 (VERIFY)", ApduTemplates.commandProblem("0020008008241234FFFFFFFFFF"));
        assertEquals("not a read command: 80 AE (GENERATE AC)", ApduTemplates.commandProblem("80AE80001D00"));
        assertEquals("not a read command: 00 D6 (UPDATE BINARY)", ApduTemplates.commandProblem("00D6000002AABB"));
        assertEquals("not a read command: 00 DC (UPDATE RECORD)", ApduTemplates.commandProblem("00DC010C02AABB"));
        assertEquals("not a read command: 80 DA (PUT DATA)", ApduTemplates.commandProblem("80DA9F5A0101"));
        assertEquals("not a read command: 90 FC (FormatPICC)", ApduTemplates.commandProblem("90FC000000"));
        assertEquals("not a read command: 90 CA (CreateApplication)", ApduTemplates.commandProblem("90CA000005123456"));
        assertEquals("not a read command: 00 84 (GET CHALLENGE)", ApduTemplates.commandProblem("0084000008")); // outside eid-read
        assertEquals("not a read command: 00 B1 (READ BINARY (odd))", ApduTemplates.commandProblem("00B1000000"));
        // The e-ID reader's secure channel only inside eid-read.
        assertNull(TemplateRunner.refusal(Apdu.unhex("0084000008"), "eid-read"));
        assertNull(TemplateRunner.refusal(Apdu.unhex("1086000000"), "eid-read"));
        assertNull(TemplateRunner.refusal(Apdu.unhex("0022C1A4"), "eid-read"));
        assertEquals("not a read command: 00 84 (GET CHALLENGE)", TemplateRunner.refusal(Apdu.unhex("0084000008"), "select-aid"));
        assertEquals("not a read command: 00 20 (VERIFY)", TemplateRunner.refusal(Apdu.unhex("0020008008"), "eid-read"));
    }

    @Test
    public void aTemplateThatWritesIsRefusedAndNeverReachesTheCard() throws Exception {
        JSONObject t = new JSONObject().put("label", "PIN").put("steps", new JSONArray()
            .put(new JSONObject().put("apdu", "00A4040007A0000000041010"))
            .put(new JSONObject().put("apdu", "0020008008241234FFFFFFFFFF").put("label", "VERIFY"))
            .put(new JSONObject().put("apdu", "80CA9F1700")));
        ApduTemplates.Template tpl = ApduTemplates.parse(t, 0);
        assertFalse(tpl.runnable());
        assertEquals(Arrays.asList("not a read command: 00 20 (VERIFY)"), tpl.problems);
        assertEquals(Arrays.asList("not a read command: 80 AE (GENERATE AC)"),
            ApduTemplates.templateProblems(new JSONObject().put("label", "old").put("apdu", "80AE80001D00")));
        // Run anyway (a caller that skips the problems): the runner stops it before the card.
        SimCards.Emv card = new SimCards.Emv(true, false, "A0000000041010");
        TemplateRunner.Result r = new TemplateRunner(tpl).run(card);
        assertTrue(card.forbidden.isEmpty());
        assertFalse(card.seen.contains("0020008008241234FFFFFFFFFF"));
        assertEquals(Arrays.asList("00A4040007A0000000041010", "80CA9F1700"), commands(r));
        TemplateRunner.StepResult verify = r.steps.get(1);
        assertEquals("error", verify.status);
        assertEquals("nfc.tpl.n.refused", verify.noteKey);
        assertEquals("not a read command: 00 20 (VERIFY)", verify.noteArgs[0]);
        assertEquals(r.steps.get(2).first, r.steps.get(1).first); // nothing recorded for it
        assertTrue(TemplateViews.readable(r, null, true).contains("refused, never sent — not a read command: 00 20 (VERIFY)"));
    }

    /* ------------------------------------------------------------ cancel, a lost card */

    @Test
    public void aCancelStopsBeforeTheNextCommand() throws Exception {
        SimCards.Emv card = new SimCards.Emv(true, false, "A0000000031010", "A0000000041010");
        TemplateRunner[] runner = new TemplateRunner[1];
        runner[0] = new TemplateRunner(template("Payment card (EMV) — every")).listener(new TemplateRunner.Listener() {
            @Override public void onStep(int n, int total, String label) { }
            @Override public void onExchange(TemplateRunner.Exchange e) { if (e.command.startsWith("80A8")) runner[0].cancel(); }
        });
        TemplateRunner.Result r = runner[0].run(card);
        assertTrue(r.cancelled);
        assertEquals(card.seen, commands(r));
        assertTrue(card.seen.get(card.seen.size() - 1).startsWith("80A8")); // nothing after the GPO the cancel came in
        assertEquals("error", r.status());
        assertEquals(1, r.emv.optJSONArray("apps").length()); // what was read so far
        assertEquals("nfc.tpl.n.cancelled", r.steps.get(r.steps.size() - 1).noteKey);
    }

    @Test
    public void aCardThatLeavesEndsTheRunWithWhatWasRead() throws Exception {
        SimCards.Iso card = new SimCards.Iso();
        card.leaveAfter = 3;
        TemplateRunner.Result r = new TemplateRunner(template("Smart card (ISO 7816-4)")).run(card);
        assertEquals("Tag was lost.", r.error);
        assertEquals(4, r.exchanges.size()); // three answered, the fourth went unanswered
        TemplateRunner.Exchange last = r.exchanges.get(3);
        assertEquals("", last.sw);
        assertEquals("error", last.status);
        assertEquals("error", r.steps.get(r.steps.size() - 1).status);
        assertEquals("nfc.tpl.n.lost", r.steps.get(r.steps.size() - 1).noteKey);
        assertTrue(r.steps.size() < 8);
        assertEquals("error", r.status());
    }

    private static List<String> strings(JSONArray a) {
        List<String> out = new ArrayList<>();
        for (int i = 0; i < a.length(); i++) out.add(a.optString(i));
        return out;
    }
}
