package cz.m5cet.app.nfc;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * EMV reader (6.5, deep read 6.6) — the Java port of client/src/lib/nfc/cards/emv.ts:
 * the public / holder data a contactless terminal reads, nothing more. Read-only:
 * PPSE → SELECT AID → GET DATA (counters, the log format) → the transaction log
 * (history) → GET PROCESSING OPTIONS → READ RECORD (the AFL's records, and with a
 * deep read every other short file), then the records' BER-TLV is parsed and the
 * known elements labelled ({@link EmvTags}). It never verifies a PIN (9F17 is read
 * as a counter, never checked), never runs GENERATE AC and writes nothing — the
 * same bytes a payment terminal sees.
 *
 * {@link #readEmv} produces the {@code emv} object of the NfcResult contract
 * (command.ts EmvData) and is unit-tested against scripted cards (EmvReaderTest,
 * EmvDeepTest), mirroring test/nfc-emv.test.ts and test/nfc-emv-deep.test.ts.
 */
public final class EmvReader {
    private EmvReader() {}

    private static final byte[] PPSE = "2PAY.SYS.DDF01".getBytes(StandardCharsets.US_ASCII);
    private static final byte[] PSE = "1PAY.SYS.DDF01".getBytes(StandardCharsets.US_ASCII);
    private static final String BULLET = "•";

    /** EMV read options (args of the emv-read op — command.ts EmvReadArgs). */
    public static final class Options {
        /** How many applications to open (default 8, at most 16). */
        public int maxApps = 8;
        /** Read the transaction log (default true). */
        public boolean history = true;
        /** Read every file the card has, not only the AFL's records (default true). */
        public boolean deep = true;
        /** 6.10: the preferred application (an older op template's {@code aid}): read first, whether the directory lists it or not. */
        public String aid;

        public Options() {}
        public Options(int maxApps) { this.maxApps = maxApps; }

        /** From an op's {@code args} (maxApps / history / deep; snake_case accepted too). */
        public static Options fromArgs(JSONObject args) {
            Options o = new Options();
            if (args == null) return o;
            Object m = args.has("maxApps") ? args.opt("maxApps") : args.opt("max_apps");
            if (m instanceof Number) o.maxApps = ((Number) m).intValue();
            Object h = args.opt("history");
            if (h instanceof Boolean) o.history = (Boolean) h;
            Object d = args.opt("deep");
            if (d instanceof Boolean) o.deep = (Boolean) d;
            Object aid = args.opt("aid");
            if (aid instanceof String && ((String) aid).matches("[0-9A-Fa-f]{10,32}")) o.aid = ((String) aid).toUpperCase(java.util.Locale.ROOT);
            return o;
        }
    }

    /** Counts every command the read sends (EmvData.apdus). 6.10: the template runner's steps send through one too. */
    static final class Sender {
        final Apdu.Transceiver t;
        int apdus;
        Sender(Apdu.Transceiver t) { this.t = t; }
        Apdu.Response send(byte[] cmd) throws IOException { apdus++; return Apdu.transmitSmart(t, cmd); }
    }

    private static void collectLeaves(List<Apdu.Tlv> nodes, Map<String, byte[]> into) {
        for (Apdu.Tlv n : nodes) {
            if (n.constructed && n.children != null) collectLeaves(n.children, into);
            else into.put(Apdu.tagHex(n.tag), n.value);   // newest wins; LinkedHashMap keeps the original position
        }
    }

    /* --------------------------------------------------------------- GPO/PDOL */

    private static final Map<String, int[]> PDOL_DEFAULTS = new LinkedHashMap<>();
    static {
        PDOL_DEFAULTS.put("9F66", new int[]{0x36, 0x00, 0x40, 0x00});
        PDOL_DEFAULTS.put("9F02", new int[]{0, 0, 0, 0, 0, 0});
        PDOL_DEFAULTS.put("9F03", new int[]{0, 0, 0, 0, 0, 0});
        PDOL_DEFAULTS.put("9F1A", new int[]{0x02, 0x03});
        PDOL_DEFAULTS.put("95", new int[]{0, 0, 0, 0, 0});
        PDOL_DEFAULTS.put("5F2A", new int[]{0x09, 0x78});
        PDOL_DEFAULTS.put("9A", new int[]{0x25, 0x01, 0x01});
        PDOL_DEFAULTS.put("9C", new int[]{0x00});
        PDOL_DEFAULTS.put("9F35", new int[]{0x22});
        PDOL_DEFAULTS.put("9F45", new int[]{0, 0});
        PDOL_DEFAULTS.put("9F4C", new int[]{0, 0, 0, 0, 0, 0, 0, 0});
        PDOL_DEFAULTS.put("9F34", new int[]{0, 0, 0});
        PDOL_DEFAULTS.put("9F21", new int[]{0, 0, 0});
        PDOL_DEFAULTS.put("9F40", new int[]{0, 0, 0, 0, 0});
        PDOL_DEFAULTS.put("9F1E", new int[]{0, 0, 0, 0, 0, 0, 0, 0});
    }

    private static byte[] pdolValue(String tag, int len) {
        byte[] out = new byte[len];
        if (tag.equals("9F37")) { for (int i = 0; i < len; i++) out[i] = (byte) (Math.random() * 256); return out; }
        int[] dflt = PDOL_DEFAULTS.get(tag);
        if (dflt != null) for (int i = 0; i < Math.min(len, dflt.length); i++) out[i] = (byte) dflt[i];
        return out;
    }

    private static byte[] fillDol(byte[] dol) {
        List<byte[]> parts = new ArrayList<>();
        int i = 0;
        while (i < dol.length) {
            int tag = dol[i++] & 0xff;
            if ((tag & 0x1f) == 0x1f) { while (i < dol.length) { int b = dol[i++] & 0xff; tag = (tag << 8) | b; if ((b & 0x80) == 0) break; } }
            int len = i < dol.length ? (dol[i++] & 0xff) : 0;
            parts.add(pdolValue(Apdu.tagHex(tag), len));
        }
        return Apdu.concat(parts.toArray(new byte[0][]));
    }

    /* ------------------------------------------------------------- AFL records */

    static final class Afl { final int sfi, first, last; Afl(int s, int f, int l) { sfi = s; first = f; last = l; } }

    static List<Afl> parseAfl(byte[] afl) {
        List<Afl> out = new ArrayList<>();
        for (int i = 0; i + 3 < afl.length; i += 4) out.add(new Afl((afl[i] & 0xff) >> 3, afl[i + 1] & 0xff, afl[i + 2] & 0xff));
        return out;
    }

    /** One record as read (command.ts EmvRecord). */
    static final class Rec {
        final int sfi, record; final String hex; final boolean log;
        Rec(int sfi, int record, byte[] data, boolean log) { this.sfi = sfi; this.record = record; this.hex = Apdu.hex(data).toUpperCase(); this.log = log; }
    }

    private static boolean has(List<Rec> records, int sfi, int rec) {
        for (Rec r : records) if (r.sfi == sfi && r.record == rec) return true;
        return false;
    }

    private static void keepTlv(byte[] data, Map<String, byte[]> into) {
        try { collectLeaves(Apdu.decodeTlv(data, true), into); } catch (RuntimeException e) { /* not TLV */ }
    }

    /** Reads records, parses their BER-TLV into {@code into}, and keeps each one raw. */
    private static void readRecords(Sender s, List<Afl> entries, Map<String, byte[]> into, List<Rec> records) {
        for (Afl e : entries) {
            for (int rec = e.first; rec <= e.last && rec > 0; rec++) {
                if (has(records, e.sfi, rec)) continue;
                Apdu.Response r;
                try { r = s.send(Apdu.readRecord(rec, e.sfi)); } catch (IOException ex) { continue; }
                if (!Apdu.isOk(r.sw) || r.data.length == 0) continue;
                records.add(new Rec(e.sfi, rec, r.data, false));
                keepTlv(r.data, into);
            }
        }
    }

    /**
     * A deep read (6.6): every short file 1–30, record by record, beyond what the
     * AFL lists — a file that answers no record 1 is skipped at once. READ RECORD
     * only; the transaction log's file is read as the log, not as TLV. 6.10: over
     * the short files {@code sfiFrom}–{@code sfiTo} and the records
     * {@code recFrom}–{@code recTo} (a template's read-files).
     */
    static void scanFiles(Sender s, Map<String, byte[]> into, List<Rec> records, Integer skipSfi, int[] budget, int sfiFrom, int sfiTo, int recFrom, int recTo) {
        for (int sfi = Math.max(1, sfiFrom); sfi <= Math.min(30, sfiTo) && budget[0] > 0; sfi++) {
            if (skipSfi != null && sfi == skipSfi) continue;
            for (int rec = Math.max(1, recFrom); rec <= Math.min(254, recTo) && budget[0] > 0; rec++) {
                if (has(records, sfi, rec)) continue;
                budget[0]--;
                Apdu.Response r;
                try { r = s.send(Apdu.readRecord(rec, sfi)); } catch (IOException ex) { break; }
                if (!Apdu.isOk(r.sw) || r.data.length == 0) break;
                records.add(new Rec(sfi, rec, r.data, false));
                keepTlv(r.data, into);
            }
        }
    }

    /* ------------------------------------------------------------- GET DATA */

    /** Data objects a terminal may ask for with GET DATA: counters, the log, balances. */
    static final String[] GET_DATA_TAGS = {"9F36", "9F13", "9F17", "9F4D", "9F4F", "9F50", "9F51", "9F5D", "9F6D", "9F6E", "9F79", "DF60", "DF61", "DF62"};

    static byte[] getData(Sender s, String tag) {
        int t = Integer.parseInt(tag, 16);
        Apdu.Response r;
        try { r = s.send(Apdu.apdu(0x80, 0xca, (t >> 8) & 0xff, t & 0xff, null, 0x00)); } catch (IOException e) { return null; }
        if (!Apdu.isOk(r.sw) || r.data.length == 0) return null;
        // The answer is the object itself (tag-length-value), or just its value.
        try { for (Apdu.Tlv n : Apdu.decodeTlv(r.data, false)) if (n.tag == t) return n.value; }
        catch (RuntimeException e) { /* plain value */ }
        return r.data;
    }

    /* ------------------------------------------------------------- the log */

    /** One DOL entry (a tag and its length). */
    public static final class DolEntry {
        public final String tag; public final int len;
        public DolEntry(String tag, int len) { this.tag = tag; this.len = len; }
    }

    /** A DOL (tag-length list) → its entries. */
    public static List<DolEntry> parseDol(byte[] dol) {
        List<DolEntry> out = new ArrayList<>();
        int i = 0;
        while (i < dol.length) {
            int tag = dol[i++] & 0xff;
            if ((tag & 0x1f) == 0x1f) { while (i < dol.length) { int b = dol[i++] & 0xff; tag = (tag << 8) | b; if ((b & 0x80) == 0) break; } }
            int len = i < dol.length ? (dol[i++] & 0xff) : 0;
            out.add(new DolEntry(Apdu.tagHex(tag), len));
        }
        return out;
    }

    private static final Map<String, String> TX_TYPE = new HashMap<>();
    private static final Map<String, String> CID = new HashMap<>();
    private static final Map<String, Integer> CURRENCY_EXP = new HashMap<>();
    static {
        String[] tx = {"00", "purchase", "01", "cash", "09", "purchase with cashback", "20", "refund", "21", "deposit", "30", "balance inquiry",
            "31", "balance inquiry", "40", "transfer", "50", "payment", "60", "load", "61", "unload"};
        for (int i = 0; i < tx.length; i += 2) TX_TYPE.put(tx[i], tx[i + 1]);
        CID.put("00", "declined (AAC)"); CID.put("40", "approved (TC)"); CID.put("80", "online (ARQC)");
        CURRENCY_EXP.put("0392", 0); CURRENCY_EXP.put("0410", 0); CURRENCY_EXP.put("0704", 0); CURRENCY_EXP.put("0152", 0);
        CURRENCY_EXP.put("0048", 3); CURRENCY_EXP.put("0414", 3); CURRENCY_EXP.put("0512", 3);
    }

    private static String amountText(String h, String currency) {
        String minor = h.replaceFirst("^0+(?=\\d)", "");
        if (minor.isEmpty()) minor = "0";
        Integer e = currency == null ? null : CURRENCY_EXP.get(currency);
        int exp = e != null ? e : 2;
        if (!minor.matches("\\d+")) return h;
        if (exp == 0) return minor;
        StringBuilder padded = new StringBuilder(minor);
        while (padded.length() < exp + 1) padded.insert(0, '0');
        String p = padded.toString();
        return p.substring(0, p.length() - exp) + "." + p.substring(p.length() - exp);
    }

    private static boolean all(byte[] b, int v) { for (byte x : b) if ((x & 0xff) != v) return false; return true; }

    /** One log record, decoded by the card's log format (command.ts EmvLogEntry). Empty slots give null. */
    public static Map<String, String> parseLogRecord(byte[] rec, List<DolEntry> dol) {
        if (rec.length == 0 || all(rec, 0x00) || all(rec, 0xff)) return null;
        Map<String, String> e = new LinkedHashMap<>();
        String currencyCode = null;
        int off = 0;
        for (DolEntry d : dol) {
            if (d.tag.equals("5F2A")) { currencyCode = pad4(Apdu.hex(Apdu.slice(rec, off, off + d.len)).toUpperCase()); break; }
            off += d.len;
        }
        int i = 0;
        for (DolEntry d : dol) {
            byte[] v = Apdu.slice(rec, i, i + d.len);
            i += d.len;
            String h = Apdu.hex(v).toUpperCase();
            switch (d.tag) {
                case "9A": e.put("date", h.length() >= 6 ? "20" + h.substring(0, 2) + "-" + h.substring(2, 4) + "-" + h.substring(4, 6) : h); break;
                case "9F21": e.put("time", h.length() >= 6 ? h.substring(0, 2) + ":" + h.substring(2, 4) + ":" + h.substring(4, 6) : h); break;
                case "9F02": e.put("amount", amountText(h, currencyCode)); break;
                case "9F03": e.put("otherAmount", amountText(h, currencyCode)); break;
                case "5F2A": { String c = EmvTags.CURRENCY_NUM.get(pad4(h)); e.put("currency", c != null ? c : h); break; }
                case "9F1A": { String c = EmvTags.COUNTRY_NUM.get(pad4(h)); e.put("country", c != null ? c : h); break; }
                case "9C": { String ty = TX_TYPE.get(h); e.put("type", ty != null ? ty : h); break; }
                case "9F4E": e.put("merchant", asciiOf(v)); break;
                case "9F36": e.put("atc", new java.math.BigInteger(h.isEmpty() ? "0" : h, 16).toString()); break;
                case "9F27": {
                    String key = h.length() < 2 ? "00" : String.format("%02x", Integer.parseInt(h.substring(0, 2), 16) & 0xc0);
                    String c = CID.get(key);
                    e.put("cid", c != null ? c : h);
                    break;
                }
                default: e.put(d.tag, h);
            }
        }
        e.put("raw", Apdu.hex(rec).toUpperCase());
        return e;
    }

    static List<Map<String, String>> readLog(Sender s, int sfi, int count, List<DolEntry> dol, List<Rec> records) {
        List<Map<String, String>> out = new ArrayList<>();
        int last = Math.min(count > 0 ? count : 30, 50);
        for (int rec = 1; rec <= last; rec++) {
            Apdu.Response r;
            try { r = s.send(Apdu.readRecord(rec, sfi)); } catch (IOException e) { break; }
            if (!Apdu.isOk(r.sw)) break;
            records.add(new Rec(sfi, rec, r.data, true));
            Map<String, String> e;
            if (!dol.isEmpty()) e = parseLogRecord(r.data, dol);
            else if (r.data.length > 0) { e = new LinkedHashMap<>(); e.put("raw", Apdu.hex(r.data).toUpperCase()); }
            else e = null;
            if (e != null) out.add(e);
        }
        return out;
    }

    /* --------------------------------------------------------------- formatting */

    static String asciiOf(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (byte c : b) if ((c & 0xff) >= 0x20 && (c & 0xff) < 0x7f) s.append((char) (c & 0xff));
        return s.toString().trim();
    }

    static String formatValue(String tag, byte[] value, String format) {
        String h = Apdu.hex(value).toUpperCase();
        switch (format) {
            case EmvTags.ANS: case EmvTags.AN: { String a = asciiOf(value); return a.isEmpty() ? h : a; }
            case EmvTags.CN: return h.replaceAll("(?i)F+$", "");
            case EmvTags.N: return value.length <= 6 ? String.valueOf(Long.parseLong(h.isEmpty() ? "0" : h, 16)) : h;
            case EmvTags.DATE: return h.length() >= 6 ? "20" + h.substring(0, 2) + "-" + h.substring(2, 4) + "-" + h.substring(4, 6) : h;
            case EmvTags.MONTH: return h.length() >= 4 ? "20" + h.substring(0, 2) + "-" + h.substring(2, 4) : h;
            case EmvTags.COUNTRY: { String c = EmvTags.COUNTRY_NUM.get(pad4(h)); return c != null ? c : h; }
            case EmvTags.CURRENCY: { String c = EmvTags.CURRENCY_NUM.get(pad4(h)); return c != null ? c : h; }
            default: return h;
        }
    }

    private static String pad4(String h) { while (h.length() < 4) h = "0" + h; return h; }

    /** PAN and expiry from Track 2 equivalent (tag 57): digits before "D", then YYMM. */
    private static String[] fromTrack2(String h) { // {pan|null, expiry|null}
        String t2 = h.toUpperCase().replaceAll("(?i)F+$", "");
        int sep = t2.indexOf('D');
        if (sep < 0) return new String[]{null, null};
        String pan = t2.substring(0, sep);
        String after = t2.substring(sep + 1);
        String expiry = after.length() >= 4 ? "20" + after.substring(0, 2) + "-" + after.substring(2, 4) : null;
        return new String[]{pan.matches("\\d{8,19}") ? pan : null, expiry};
    }

    private static String maskPan(String pan) {
        if (pan.length() < 10) return pan;
        StringBuilder mid = new StringBuilder();
        for (int i = 0; i < pan.length() - 10; i++) mid.append(BULLET);
        return pan.substring(0, 6) + mid + pan.substring(pan.length() - 4);
    }

    private static Long num(byte[] v) {
        if (v == null || v.length == 0 || v.length > 4) return null;
        String h = Apdu.hex(v);
        return Long.parseLong(h.isEmpty() ? "0" : h, 16);
    }

    private static JSONObject tagJson(String tag, byte[] value) throws JSONException {
        EmvTags.Info info = EmvTags.emvTagInfo(tag);
        return new JSONObject().put("tag", tag).put("name", info.name)
            .put("value", formatValue(tag, value, info.format)).put("hex", Apdu.hex(value).toUpperCase());
    }

    /** What one application gave besides its records' tags (emv.ts AppExtras). */
    static final class Extras {
        byte[] aip, afl, logFormat;
        Integer logSfi;
        List<Map<String, String>> log;
        final Map<String, byte[]> getData = new LinkedHashMap<>();
        final List<Rec> records = new ArrayList<>();
    }

    static JSONObject buildApp(String aid, Map<String, byte[]> tags, String label, Extras x) throws JSONException {
        // GET DATA answers fill in what the records did not carry.
        for (Map.Entry<String, byte[]> g : x.getData.entrySet()) tags.putIfAbsent(g.getKey(), g.getValue());
        JSONObject app = new JSONObject();
        app.put("aid", aid);
        JSONArray list = new JSONArray();
        for (Map.Entry<String, byte[]> e : tags.entrySet()) list.put(tagJson(e.getKey(), e.getValue()));
        app.put("tags", list);
        String scheme = EmvTags.schemeForAid(aid);
        if (scheme != null) app.put("scheme", scheme);
        if (label != null) app.put("label", label);
        else { byte[] lbl = tags.containsKey("50") ? tags.get("50") : tags.get("9F12"); if (lbl != null) app.put("label", asciiOf(lbl)); }
        // PAN: tag 5A, else from Track 2.
        byte[] pan5a = tags.get("5A");
        byte[] t2 = tags.containsKey("57") ? tags.get("57") : tags.get("9F6B");
        String[] fromT2 = t2 != null ? fromTrack2(Apdu.hex(t2)) : new String[]{null, null};
        String pan = pan5a != null ? Apdu.hex(pan5a).toUpperCase().replaceAll("(?i)F+$", "") : fromT2[0];
        if (pan != null && pan.matches("\\d{8,19}")) { app.put("pan", pan); app.put("panMasked", maskPan(pan)); }
        byte[] exp = tags.get("5F24");
        String expiry = exp != null ? formatValue("5F24", exp, EmvTags.MONTH) : fromT2[1];
        if (expiry != null && expiry.length() > 7) expiry = expiry.substring(0, 7);
        if (expiry != null && !expiry.isEmpty()) app.put("expiry", expiry);
        byte[] name = tags.get("5F20");
        if (name != null) {
            String n = asciiOf(name).replaceAll("\\s*/\\s*", " / ").trim();
            if (!n.isEmpty() && !n.equals("/")) app.put("cardholder", n);
        }
        byte[] eff = tags.get("5F25");
        if (eff != null) { String d = formatValue("5F25", eff, EmvTags.DATE); app.put("effective", d.length() >= 7 ? d.substring(0, 7) : d); }
        byte[] country = tags.get("5F28");
        if (country != null) app.put("issuerCountry", formatValue("5F28", country, EmvTags.COUNTRY));
        byte[] seq = tags.get("5F34");
        if (seq != null) { Long n = num(seq); app.put("panSequence", n == null ? "" : String.valueOf(n)); }
        Long atc = num(tags.get("9F36"));
        if (atc != null) app.put("atc", atc.longValue());
        Long lastOnline = num(tags.get("9F13"));
        if (lastOnline != null) app.put("lastOnlineAtc", lastOnline.longValue());
        Long ptc = num(tags.get("9F17"));
        if (ptc != null) app.put("pinTryCounter", ptc.longValue());
        if (x.aip != null && x.aip.length > 0) app.put("aip", Apdu.hex(x.aip).toUpperCase());
        if (x.afl != null && x.afl.length > 0) app.put("afl", Apdu.hex(x.afl).toUpperCase());
        if (!x.getData.isEmpty()) {
            JSONArray gd = new JSONArray();
            for (Map.Entry<String, byte[]> g : x.getData.entrySet()) gd.put(tagJson(g.getKey(), g.getValue()));
            app.put("getData", gd);
        }
        if (x.logFormat != null && x.logFormat.length > 0) app.put("logFormat", Apdu.hex(x.logFormat).toUpperCase());
        if (x.logSfi != null) app.put("logSfi", x.logSfi.intValue());
        if (x.log != null) {
            JSONArray log = new JSONArray();
            for (Map<String, String> e : x.log) {
                JSONObject o = new JSONObject();
                for (Map.Entry<String, String> kv : e.entrySet()) o.put(kv.getKey(), kv.getValue());
                log.put(o);
            }
            app.put("log", log);
        }
        if (!x.records.isEmpty()) {
            JSONArray recs = new JSONArray();
            for (Rec r : x.records) {
                JSONObject o = new JSONObject().put("sfi", r.sfi).put("record", r.record).put("hex", r.hex);
                if (r.log) o.put("log", true);
                recs.put(o);
            }
            app.put("records", recs);
        }
        return app;
    }

    /* ------------------------------------------------------------------ public */

    /** Candidate AIDs from the PPSE directory, by priority (tag 87) where present. */
    static List<String> aidsFromPpse(List<Apdu.Tlv> nodes) {
        List<Apdu.Tlv> apps = Apdu.findAllTlv(nodes, 0x61);
        List<String[]> found = new ArrayList<>(); // {aid, prio}
        for (Apdu.Tlv a : apps) {
            Apdu.Tlv aid = Apdu.findTlv(a.children, 0x4f);
            Apdu.Tlv prio = Apdu.findTlv(a.children, 0x87);
            if (aid != null) found.add(new String[]{Apdu.hex(aid.value).toUpperCase(), String.valueOf(prio != null ? (prio.value.length > 0 ? prio.value[0] & 0xff : 0xff) : 0xff)});
        }
        found.sort((x, y) -> Integer.compare(Integer.parseInt(x[1]), Integer.parseInt(y[1])));
        List<String> out = new ArrayList<>();
        for (String[] f : found) if (!out.contains(f[0])) out.add(f[0]);
        return out;
    }

    static final class Fci { boolean ok; List<Apdu.Tlv> fci = new ArrayList<>(); String label; byte[] pdol; }

    /** SELECT an application by its AID; keeps its FCI (the label, the PDOL). */
    static Fci selectAid(Sender s, String aidHex) {
        Fci out = new Fci();
        byte[] aid = Apdu.unhex(aidHex);
        Apdu.Response r;
        try { r = s.send(Apdu.selectByAid(aid)); } catch (IOException e) { return out; }
        if (!Apdu.isOk(r.sw)) return out;
        out.ok = true;
        try { out.fci = Apdu.decodeTlv(r.data, true); } catch (RuntimeException e) { out.fci = new ArrayList<>(); }
        Apdu.Tlv label = Apdu.findTlv(out.fci, 0x50);
        if (label == null) label = Apdu.findTlv(out.fci, 0x9f12);
        out.label = label != null ? asciiOf(label.value) : null;
        Apdu.Tlv pdol = Apdu.findTlv(out.fci, 0x9f38);
        out.pdol = pdol != null ? pdol.value : null;
        return out;
    }

    static final class Gpo { boolean ok; byte[] aip, afl; List<Apdu.Tlv> extra = new ArrayList<>(); }

    /** GET PROCESSING OPTIONS with the PDOL filled with a terminal's neutral defaults (no transaction is made) → AIP + AFL. */
    static Gpo gpo(Sender s, byte[] pdol) {
        Gpo out = new Gpo();
        byte[] data = pdol != null && pdol.length > 0 ? fillDol(pdol) : new byte[0];
        // Command data is a tag 83 holding the filled PDOL (empty when the card has none).
        byte[] field = Apdu.concat(Apdu.u8(0x83, data.length & 0xff), data);
        Apdu.Response r;
        try { r = s.send(Apdu.apdu(0x80, 0xa8, 0x00, 0x00, field, 0x00)); } catch (IOException e) { return out; }
        if (!Apdu.isOk(r.sw)) return out;
        out.ok = true;
        List<Apdu.Tlv> nodes = Apdu.decodeTlv(r.data, true);
        Apdu.Tlv fmt1 = Apdu.findTlv(nodes, 0x80);
        if (fmt1 != null) { out.aip = Apdu.slice(fmt1.value, 0, 2); out.afl = Apdu.slice(fmt1.value, 2); out.extra = nodes; return out; }
        Apdu.Tlv resp = Apdu.findTlv(nodes, 0x77);
        if (resp != null) {
            Apdu.Tlv aip = Apdu.findTlv(resp.children, 0x82), afl = Apdu.findTlv(resp.children, 0x94);
            out.aip = aip != null ? aip.value : null;
            out.afl = afl != null ? afl.value : null;
            out.extra = resp.children != null ? resp.children : new ArrayList<>();
            return out;
        }
        out.extra = nodes;
        return out;
    }

    /** Reads an EMV card with {@code maxApps} applications at most and the default deep read (history, every file). */
    public static JSONObject readEmv(Apdu.Transceiver t, int maxApps) throws IOException, JSONException {
        return readEmv(t, new Options(maxApps > 0 ? maxApps : 8));
    }

    /**
     * Reads an EMV card's applications and everything they show a terminal — the
     * records, the counters and the transaction log — into an {@code emv}
     * JSONObject (the NfcResult contract, command.ts EmvData). {@code maxApps}
     * caps how many applications are opened (default 8, at most 16);
     * {@code history} reads the log (default on); {@code deep} reads every short
     * file, not only the AFL's (default on).
     */
    public static JSONObject readEmv(Apdu.Transceiver t, Options opts) throws IOException, JSONException {
        if (opts == null) opts = new Options();
        Sender s = new Sender(t);
        int maxApps = Math.max(1, Math.min(16, opts.maxApps));
        boolean deep = opts.deep;
        String ppseTree = "";
        List<String> aids = new ArrayList<>();
        try {
            Directory dir = selectPpse(s);
            if (dir.ok) { ppseTree = dir.tree; aids = dir.aids; }
        } catch (IOException | RuntimeException e) { /* no PPSE — fall back to the candidate list */ }
        // 6.10: the preferred application goes first (an older op template's aid).
        if (opts.aid != null && !aids.isEmpty()) { aids.remove(opts.aid); aids.add(0, opts.aid); }
        if (aids.isEmpty()) {
            // No directory: try the well-known AIDs and keep the ones the card selects.
            if (opts.aid != null && selectAid(s, opts.aid).ok) aids.add(opts.aid);
            for (EmvTags.Candidate c : EmvTags.CANDIDATE_AIDS) {
                if (aids.size() >= maxApps) break;
                if (aids.contains(c.aid)) continue;
                if (selectAid(s, c.aid).ok) aids.add(c.aid);
            }
        }

        JSONArray apps = new JSONArray();
        int[] budget = {240};
        for (int i = 0; i < aids.size() && i < maxApps; i++) {
            String aidHex = aids.get(i);
            Fci sel = selectAid(s, aidHex);
            if (!sel.ok) continue;
            AppRead app = new AppRead(aidHex, sel);
            // Before the transaction starts: the counters, and the log the card keeps.
            app.getData(s, GET_DATA_TAGS);
            if (opts.history) app.history(s, false);
            app.gpo(s);
            app.readAfl(s, !deep);
            if (deep) app.scan(s, budget, 1, 30, 1, 16);
            apps.put(app.build());
        }
        return emvData(aids, apps, ppseTree, deep, s.apdus);
    }

    /* ------------------------------------------------- the steps (6.10) */

    /** A payment directory — PPSE (contactless) or PSE (contact) — the AIDs it lists by priority, and its tree. */
    static final class Directory { boolean ok; List<String> aids = new ArrayList<>(); String tree = ""; }

    /** SELECT 2PAY.SYS.DDF01: the contactless directory and the applications it lists. */
    static Directory selectPpse(Sender s) throws IOException {
        Directory d = new Directory();
        Apdu.Response r = s.send(Apdu.selectByAid(PPSE));
        if (!Apdu.isOk(r.sw)) return d;
        d.ok = true;
        List<Apdu.Tlv> nodes = Apdu.decodeTlv(r.data, true);
        d.tree = Apdu.formatTlv(nodes, 0);
        d.aids = aidsFromPpse(nodes);
        return d;
    }

    /**
     * SELECT 1PAY.SYS.DDF01: the contact directory — its FCI names a short file
     * (tag 88) whose records list the applications (61 → 4F), read until the
     * card has no more.
     */
    static Directory selectPse(Sender s) throws IOException {
        Directory d = new Directory();
        Apdu.Response r = s.send(Apdu.selectByAid(PSE));
        if (!Apdu.isOk(r.sw)) return d;
        d.ok = true;
        List<Apdu.Tlv> fci = Apdu.decodeTlv(r.data, true);
        StringBuilder tree = new StringBuilder(Apdu.formatTlv(fci, 0));
        Apdu.Tlv sfiTag = Apdu.findTlv(fci, 0x88);
        int sfi = sfiTag != null && sfiTag.value.length > 0 ? (sfiTag.value[0] & 0x1f) : 1;
        List<Apdu.Tlv> entries = new ArrayList<>();
        for (int rec = 1; rec <= 16 && sfi > 0; rec++) {
            Apdu.Response rr;
            try { rr = s.send(Apdu.readRecord(rec, sfi)); } catch (IOException e) { break; }
            if (!Apdu.isOk(rr.sw) || rr.data.length == 0) break;
            List<Apdu.Tlv> nodes = Apdu.decodeTlv(rr.data, true);
            entries.addAll(nodes);
            if (tree.length() > 0) tree.append('\n');
            tree.append(Apdu.formatTlv(nodes, 0));
        }
        d.tree = tree.toString();
        d.aids = aidsFromPpse(entries);
        return d;
    }

    /**
     * One application as it is read, step by step — what {@link #readEmv} does
     * for each AID, and what a 6.10 template's select-aid, get-data, read-log,
     * gpo, read-afl and read-files steps do one at a time. {@link #build} gives
     * the application of the contract (command.ts EmvApp).
     */
    static final class AppRead {
        final String aid;
        final String label;
        final byte[] pdol;
        final Map<String, byte[]> tags = new LinkedHashMap<>();
        final Extras x = new Extras();

        /** {@code sel} null: steps that ran with no application selected. */
        AppRead(String aid, Fci sel) {
            this.aid = aid;
            this.label = sel == null ? null : sel.label;
            this.pdol = sel == null ? null : sel.pdol;
            if (sel != null) collectLeaves(sel.fci, tags);
        }

        /** GET DATA for each tag; missing tags are not errors. Returns how many answered. */
        int getData(Sender s, String[] list) {
            int n = 0;
            for (String tag : list) {
                String k = tag.toUpperCase(java.util.Locale.ROOT);
                byte[] v = EmvReader.getData(s, k);
                if (v != null) { x.getData.put(k, v); n++; }
            }
            return n;
        }

        /** The log entry (9F4D: SFI, number of records) from the FCI or GET DATA. */
        byte[] logEntry() { return tags.containsKey("9F4D") ? tags.get("9F4D") : x.getData.get("9F4D"); }

        /**
         * The transaction log: 9F4D (SFI, count) and 9F4F (the format) → READ
         * RECORD of each entry, decoded by the format. {@code ask}: GET DATA them
         * when nothing so far carried them. The entries read, or -1 when the card
         * keeps no log.
         */
        int history(Sender s, boolean ask) {
            byte[] entry = logEntry();
            if (entry == null && ask) { byte[] v = EmvReader.getData(s, "9F4D"); if (v != null) { x.getData.put("9F4D", v); entry = v; } }
            if (entry == null || entry.length < 2) return -1;
            byte[] fmt = x.getData.containsKey("9F4F") ? x.getData.get("9F4F") : tags.get("9F4F");
            if (fmt == null && ask) { byte[] v = EmvReader.getData(s, "9F4F"); if (v != null) { x.getData.put("9F4F", v); fmt = v; } }
            x.logSfi = entry[0] & 0xff;
            if (fmt != null) x.logFormat = fmt;
            x.log = readLog(s, entry[0] & 0xff, entry[1] & 0xff, fmt != null ? parseDol(fmt) : new ArrayList<>(), x.records);
            return x.log.size();
        }

        /** GET PROCESSING OPTIONS (no transaction) → the AIP and the AFL, and what else the answer carries. */
        boolean gpo(Sender s) {
            Gpo g = EmvReader.gpo(s, pdol);
            collectLeaves(g.extra, tags);
            x.aip = g.aip; x.afl = g.afl;
            return g.ok;
        }

        boolean hasAfl() { return x.afl != null && x.afl.length > 0; }

        /** READ RECORD of every record the AFL lists; with no AFL, {@code light} scans the first files for the holder records. Returns the records read. */
        int readAfl(Sender s, boolean light) {
            int before = x.records.size();
            if (hasAfl()) readRecords(s, parseAfl(x.afl), tags, x.records);
            else if (light) {
                List<Afl> scan = new ArrayList<>();
                for (int sfi = 1; sfi <= 4; sfi++) scan.add(new Afl(sfi, 1, 8));
                readRecords(s, scan, tags, x.records);
            }
            return x.records.size() - before;
        }

        /** The deep scan over short files and records beyond the AFL (the log's own file is skipped once it was read as the log). Returns the records read. */
        int scan(Sender s, int[] budget, int sfiFrom, int sfiTo, int recFrom, int recTo) {
            int before = x.records.size();
            scanFiles(s, tags, x.records, x.logSfi, budget, sfiFrom, sfiTo, recFrom, recTo);
            return x.records.size() - before;
        }

        /** Whether any step gave this application something. */
        boolean empty() { return tags.isEmpty() && x.getData.isEmpty() && x.records.isEmpty() && x.aip == null && x.log == null; }

        JSONObject build() throws JSONException {
            Collections.sort(x.records, (a, b) -> a.sfi != b.sfi ? Integer.compare(a.sfi, b.sfi) : Integer.compare(a.record, b.record));
            return buildApp(aid, new LinkedHashMap<>(tags), label, x);
        }
    }

    /** The {@code emv} object of the contract (command.ts EmvData) from what a read gathered. */
    static JSONObject emvData(List<String> aids, JSONArray apps, String tree, boolean deep, int apdus) throws JSONException {
        JSONObject emv = new JSONObject();
        String app0Scheme = apps.length() > 0 ? apps.optJSONObject(0).optString("scheme", null) : null;
        String scheme = app0Scheme != null ? app0Scheme : (!aids.isEmpty() ? EmvTags.schemeForAid(aids.get(0)) : null);
        if (scheme != null) emv.put("scheme", scheme);
        emv.put("aids", new JSONArray(aids));
        emv.put("apps", apps);
        if (tree != null && !tree.isEmpty()) emv.put("tree", tree);
        emv.put("deep", deep);
        emv.put("apdus", apdus);
        return emv;
    }

    /** A one-line summary for a log / flash (emv.ts emvSummary). */
    public static String emvSummary(JSONObject d) {
        JSONArray apps = d.optJSONArray("apps");
        JSONArray aids = d.optJSONArray("aids");
        if (apps == null || apps.length() == 0) {
            int n = aids == null ? 0 : aids.length();
            return n > 0 ? cz.m5cet.app.core.Texts.n("nfc.emv.sum.noRecords", n, "EMV: {n} application(s), no records read") : cz.m5cet.app.core.Texts.t("nfc.emv.sum.none", "No EMV application found");
        }
        JSONObject a = apps.optJSONObject(0);
        int history = 0;
        for (int i = 0; i < apps.length(); i++) {
            JSONObject x = apps.optJSONObject(i);
            JSONArray log = x == null ? null : x.optJSONArray("log");
            if (log != null) history += log.length();
        }
        List<String> bits = new ArrayList<>();
        String head = a.optString("scheme", a.optString("label", ""));
        if (!head.isEmpty()) bits.add(head);
        if (!a.optString("panMasked", "").isEmpty()) bits.add(a.optString("panMasked"));
        if (!a.optString("expiry", "").isEmpty()) bits.add(a.optString("expiry"));
        if (history > 0) bits.add(cz.m5cet.app.core.Texts.n("nfc.emv.sum.transactions", history, history > 1 ? "{n} transactions" : "{n} transaction"));
        if (bits.isEmpty()) return cz.m5cet.app.core.Texts.n("nfc.emv.sum.apps", apps.length(), "EMV: {n} application(s)");
        return String.join(" · ", bits);
    }
}
