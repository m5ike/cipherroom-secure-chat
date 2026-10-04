package cz.m5cet.app.nfc;

import static cz.m5cet.app.nfc.Tlvs.T;
import static cz.m5cet.app.nfc.Tlvs.ascii;
import static cz.m5cet.app.nfc.Tlvs.ok;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The deep EMV read (6.6) — the Java port of test/nfc-emv-deep.test.ts: GET DATA
 * counters, the transaction log decoded by the card's own log format (9F4F), the
 * AFL's records and every other short file — against a scripted card that
 * answers only reads (a VERIFY, GENERATE AC or any write fails the test).
 */
public class EmvDeepTest {

    private static final String AID = "A0000000041010";
    // The log format: date, time, amount, currency, country, type, merchant (8), ATC.
    private static final byte[] LOG_FORMAT = Apdu.unhex("9A039F21039F02065F2A029F1A029C019F4E089F3602");

    private static byte[] logRecord(String date, String time, String amount, String merchant, int atc) {
        StringBuilder m = new StringBuilder(merchant);
        while (m.length() < 8) m.append(' ');
        return Apdu.concat(Apdu.unhex(date), Apdu.unhex(time), Apdu.unhex(amount), Apdu.unhex("0203"), Apdu.unhex("0203"), Apdu.unhex("00"),
            ascii(m.substring(0, 8)), Apdu.u8(atc >> 8, atc & 0xff));
    }

    private static final byte[][] LOG = {
        logRecord("250914", "183005", "000000012345", "BILLA", 41),
        logRecord("250912", "091500", "000000000990", "DPP", 40),
        new byte[LOG_FORMAT.length], // an empty slot
    };

    /** A scripted read-only card; {@code seen} logs every command, {@code writes} any forbidden one. */
    private static final class Card {
        final List<String> seen = new ArrayList<>();
        final List<String> forbidden = new ArrayList<>();
        final Apdu.Transceiver t;

        Card(boolean logInFci) {
            byte[] fci = T(0x6f, T(0x84, Apdu.unhex(AID)), T(0xa5, T(0x50, ascii("MASTERCARD")), T(0x9f38, Apdu.unhex("9F1A02")),
                logInFci ? T(0xbf0c, T(0x9f4d, Apdu.u8(0x0b, 0x03))) : new byte[0]));
            byte[] ppse = T(0x6f, T(0x84, ascii("2PAY.SYS.DDF01")), T(0xa5, T(0xbf0c, T(0x61, T(0x4f, Apdu.unhex(AID)), T(0x87, Apdu.u8(1))))));
            Map<String, byte[]> files = new HashMap<>();
            files.put("1:1", T(0x70, T(0x5a, Apdu.unhex("5413330089020011")), T(0x5f24, Apdu.unhex("281231")), T(0x5f20, ascii("NOVAK/JAN")), T(0x5f28, Apdu.unhex("0203"))));
            files.put("2:1", T(0x70, T(0x8c, Apdu.unhex("9F02069F03069F1A02")), T(0x8e, Apdu.unhex("000000000000000042031E031F03"))));
            // Not in the AFL — only a deep read finds it.
            files.put("3:1", T(0x70, T(0x9f08, Apdu.unhex("0002")), T(0x5f30, Apdu.unhex("0201"))));
            files.put("3:2", T(0x70, T(0x9f42, Apdu.unhex("0203"))));
            t = cmd -> {
                int cla = cmd[0] & 0xff, ins = cmd[1] & 0xff, p1 = cmd[2] & 0xff, p2 = cmd[3] & 0xff;
                String h = Apdu.hex(cmd).toUpperCase();
                seen.add(h);
                if (ins == 0x20 || (cla == 0x80 && ins == 0xae) || ins == 0xd6 || ins == 0xdc || ins == 0xe2) {
                    forbidden.add(h);
                    throw new IOException("the reader must only read");
                }
                if (ins == 0xa4 && p1 == 0x04) {
                    String sel = Apdu.hex(Apdu.slice(cmd, 5, 5 + (cmd[4] & 0xff))).toUpperCase();
                    if (sel.equals(Apdu.hex(ascii("2PAY.SYS.DDF01")))) return ok(ppse);
                    return sel.equals(AID) ? ok(fci) : Apdu.u8(0x6a, 0x82);
                }
                if (cla == 0x80 && ins == 0xca) {
                    String tag = Integer.toHexString((p1 << 8) | p2).toUpperCase();
                    if (tag.equals("9F4F")) return ok(T(0x9f4f, LOG_FORMAT));
                    if (tag.equals("9F36")) return ok(T(0x9f36, Apdu.u8(0x00, 0x2a)));
                    if (tag.equals("9F13")) return ok(T(0x9f13, Apdu.u8(0x00, 0x28)));
                    if (tag.equals("9F17")) return ok(T(0x9f17, Apdu.u8(0x03)));
                    if (tag.equals("9F4D") && !logInFci) return ok(T(0x9f4d, Apdu.u8(0x0b, 0x03)));
                    return Apdu.u8(0x6a, 0x88);
                }
                if (cla == 0x80 && ins == 0xa8) return ok(T(0x77, T(0x82, Apdu.unhex("1980")), T(0x94, Apdu.unhex("0801010010010100"))));
                if (ins == 0xb2) {
                    int sfi = p2 >> 3;
                    if (sfi == 0x0b) return p1 <= LOG.length ? ok(LOG[p1 - 1]) : Apdu.u8(0x6a, 0x83);
                    byte[] f = files.get(sfi + ":" + p1);
                    if (f != null) return ok(f);
                    for (String k : files.keySet()) if (k.startsWith(sfi + ":")) return Apdu.u8(0x6a, 0x83);
                    return Apdu.u8(0x6a, 0x82);
                }
                return Apdu.u8(0x6d, 0x00);
            };
        }

        int indexOf(String prefix) { for (int i = 0; i < seen.size(); i++) if (seen.get(i).startsWith(prefix)) return i; return -1; }
    }

    private static List<String> recordKeys(JSONObject app, boolean markLog) {
        List<String> out = new ArrayList<>();
        JSONArray recs = app.optJSONArray("records");
        for (int i = 0; i < recs.length(); i++) {
            JSONObject r = recs.optJSONObject(i);
            out.add(r.optInt("sfi") + ":" + r.optInt("record") + (markLog && r.optBoolean("log") ? "L" : ""));
        }
        return out;
    }

    private static String tagHexOf(JSONObject app, String tag) {
        JSONArray tags = app.optJSONArray("tags");
        for (int i = 0; i < tags.length(); i++) if (tag.equals(tags.optJSONObject(i).optString("tag"))) return tags.optJSONObject(i).optString("hex");
        return null;
    }

    @Test
    public void readsTheHistoryTheCountersAndEveryFile() throws Exception {
        Card card = new Card(true);
        JSONObject d = EmvReader.readEmv(card.t, new EmvReader.Options());
        assertTrue(d.optBoolean("deep"));
        JSONObject app = d.optJSONArray("apps").optJSONObject(0);
        assertEquals("Mastercard", app.optString("scheme"));
        assertEquals("5413330089020011", app.optString("pan"));
        assertEquals("NOVAK / JAN", app.optString("cardholder"));
        assertEquals(42, app.optInt("atc"));
        assertEquals(40, app.optInt("lastOnlineAtc"));
        assertEquals(3, app.optInt("pinTryCounter"));
        assertEquals("1980", app.optString("aip"));
        assertEquals("0801010010010100", app.optString("afl"));
        // The history, decoded by the card's log format; the empty slot is skipped.
        assertEquals(11, app.optInt("logSfi"));
        assertEquals(Apdu.hex(LOG_FORMAT), app.optString("logFormat"));
        JSONArray log = app.optJSONArray("log");
        assertEquals(2, log.length());
        JSONObject e0 = log.optJSONObject(0);
        assertEquals("2025-09-14", e0.optString("date"));
        assertEquals("18:30:05", e0.optString("time"));
        assertEquals("123.45", e0.optString("amount"));
        assertEquals("CZK", e0.optString("currency"));
        assertEquals("Czechia", e0.optString("country"));
        assertEquals("purchase", e0.optString("type"));
        assertEquals("BILLA", e0.optString("merchant"));
        assertEquals("41", e0.optString("atc"));
        assertEquals(Apdu.hex(LOG[0]), e0.optString("raw"));
        assertEquals("9.90", log.optJSONObject(1).optString("amount"));
        assertEquals("DPP", log.optJSONObject(1).optString("merchant"));
        // Every record, including the file only a deep read finds (SFI 3) and the log's raw records.
        assertEquals(Arrays.asList("1:1", "2:1", "3:1", "3:2", "11:1L", "11:2L", "11:3L"), recordKeys(app, true));
        assertEquals("0002", tagHexOf(app, "9F08"));
        // GET DATA answers are kept.
        JSONArray gd = app.optJSONArray("getData");
        List<String> gdTags = new ArrayList<>();
        for (int i = 0; i < gd.length(); i++) gdTags.add(gd.optJSONObject(i).optString("tag"));
        assertEquals(Arrays.asList("9F36", "9F13", "9F17", "9F4F"), gdTags);
        // The log is read before GPO (outside a transaction).
        int firstLog = card.indexOf("00B2015C"), gpo = card.indexOf("80A8");
        assertTrue(firstLog > -1);
        assertTrue(firstLog < gpo);
        assertTrue(d.optInt("apdus") > 10);
        assertTrue(EmvReader.emvSummary(d).contains("2 transactions"));
        assertTrue(card.forbidden.isEmpty());
    }

    @Test
    public void findsTheLogEntryByGetDataWhenTheFciDoesNotCarryIt() throws Exception {
        JSONObject d = EmvReader.readEmv(new Card(false).t, new EmvReader.Options());
        assertEquals(2, d.optJSONArray("apps").optJSONObject(0).optJSONArray("log").length());
    }

    @Test
    public void readsOnlyTheAflAndNoHistoryWhenAsked() throws Exception {
        Card card = new Card(true);
        EmvReader.Options o = new EmvReader.Options();
        o.deep = false;
        o.history = false;
        JSONObject d = EmvReader.readEmv(card.t, o);
        assertFalse(d.optBoolean("deep", true));
        JSONObject app = d.optJSONArray("apps").optJSONObject(0);
        assertFalse(app.has("log"));
        assertEquals(Arrays.asList("1:1", "2:1"), recordKeys(app, false));
        assertEquals(-1, card.indexOf("00B2011C")); // SFI 3 never read
    }

    @Test
    public void decodesALogRecordByItsDol() {
        List<EmvReader.DolEntry> dol = EmvReader.parseDol(LOG_FORMAT);
        assertEquals(8, dol.size());
        assertEquals("9F4E", dol.get(6).tag);
        assertEquals(8, dol.get(6).len);
        Map<String, String> e = EmvReader.parseLogRecord(LOG[0], dol);
        assertEquals("2025-09-14", e.get("date"));
        assertEquals("123.45", e.get("amount"));
        assertEquals("CZK", e.get("currency"));
        assertEquals("BILLA", e.get("merchant"));
        assertEquals(Apdu.hex(LOG[0]), e.get("raw"));
        assertNull(EmvReader.parseLogRecord(new byte[10], Arrays.asList(new EmvReader.DolEntry("9A", 3))));
        assertNull(EmvReader.parseLogRecord(Tlvs.fill(10, 0xff), Arrays.asList(new EmvReader.DolEntry("9A", 3))));
    }

    @Test
    public void passesTheOpArgsThroughToTheRead() throws Exception {
        Card card = new Card(true);
        JSONObject r = CardOps.readResult("emv-read", card.t, new JSONObject().put("maxApps", 2).put("history", false).put("deep", false));
        assertEquals("ok", r.optString("status"));
        JSONObject emv = r.optJSONObject("emv");
        assertFalse(emv.optBoolean("deep", true));
        assertFalse(emv.optJSONArray("apps").optJSONObject(0).has("log"));
        assertTrue(r.optString("message").contains("Mastercard"));
        // Defaults: deep, with the history.
        JSONObject full = CardOps.readResult("emv-read", new Card(true).t, null).optJSONObject("emv");
        assertTrue(full.optBoolean("deep"));
        assertEquals(2, full.optJSONArray("apps").optJSONObject(0).optJSONArray("log").length());
        assertNull(CardOps.readResult("ndef-read", card.t, null));
    }
}
