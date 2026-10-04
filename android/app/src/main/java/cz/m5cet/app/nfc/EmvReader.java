package cz.m5cet.app.nfc;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * EMV reader (6.5) — the Java port of client/src/lib/nfc/cards/emv.ts: the public
 * / holder data a contactless terminal reads, nothing more. Read-only:
 * PPSE → SELECT AID → GET PROCESSING OPTIONS → READ RECORD, then the records'
 * BER-TLV is parsed and the known elements labelled ({@link EmvTags}). It never
 * verifies a PIN (9F17 is read as a counter, never checked), never runs GENERATE
 * AC and writes nothing — the same bytes a payment terminal sees.
 *
 * {@link #readEmv} is byte-compatible with the web and unit-tested against a
 * scripted card (EmvReaderTest), mirroring test/nfc-emv.test.ts.
 */
public final class EmvReader {
    private EmvReader() {}

    private static final byte[] PPSE = "2PAY.SYS.DDF01".getBytes(StandardCharsets.US_ASCII);
    private static final String BULLET = "•";

    private static Apdu.Response send(Apdu.Transceiver t, byte[] cmd) throws IOException { return Apdu.transmitSmart(t, cmd); }

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

    private static final class Afl { final int sfi, first, last; Afl(int s, int f, int l) { sfi = s; first = f; last = l; } }

    private static List<Afl> parseAfl(byte[] afl) {
        List<Afl> out = new ArrayList<>();
        for (int i = 0; i + 3 < afl.length; i += 4) out.add(new Afl((afl[i] & 0xff) >> 3, afl[i + 1] & 0xff, afl[i + 2] & 0xff));
        return out;
    }

    private static void readRecords(Apdu.Transceiver t, List<Afl> entries, Map<String, byte[]> into) throws IOException {
        for (Afl e : entries) {
            for (int rec = e.first; rec <= e.last && rec > 0; rec++) {
                Apdu.Response r;
                try { r = send(t, Apdu.readRecord(rec, e.sfi)); } catch (IOException ex) { continue; }
                if (!Apdu.isOk(r.sw) || r.data.length == 0) continue;
                collectLeaves(Apdu.decodeTlv(r.data, true), into);
            }
        }
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

    private static Integer num(byte[] v) {
        if (v == null || v.length == 0 || v.length > 4) return null;
        String h = Apdu.hex(v);
        return (int) Long.parseLong(h.isEmpty() ? "0" : h, 16);
    }

    private static JSONObject buildApp(String aid, Map<String, byte[]> tags, String label) throws JSONException {
        JSONObject app = new JSONObject();
        app.put("aid", aid);
        JSONArray list = new JSONArray();
        for (Map.Entry<String, byte[]> e : tags.entrySet()) {
            EmvTags.Info info = EmvTags.emvTagInfo(e.getKey());
            list.put(new JSONObject().put("tag", e.getKey()).put("name", info.name)
                .put("value", formatValue(e.getKey(), e.getValue(), info.format)).put("hex", Apdu.hex(e.getValue()).toUpperCase()));
        }
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
        if (expiry != null) app.put("expiry", expiry);
        byte[] name = tags.get("5F20");
        if (name != null) app.put("cardholder", asciiOf(name));
        byte[] eff = tags.get("5F25");
        if (eff != null) { String d = formatValue("5F25", eff, EmvTags.DATE); app.put("effective", d.length() >= 7 ? d.substring(0, 7) : d); }
        byte[] country = tags.get("5F28");
        if (country != null) app.put("issuerCountry", formatValue("5F28", country, EmvTags.COUNTRY));
        byte[] seq = tags.get("5F34");
        if (seq != null) { Integer n = num(seq); app.put("panSequence", n == null ? "" : String.valueOf(n)); }
        Integer atc = num(tags.get("9F36"));
        if (atc != null) app.put("atc", atc.intValue());
        Integer ptc = num(tags.get("9F17"));
        if (ptc != null) app.put("pinTryCounter", ptc.intValue());
        return app;
    }

    /* ------------------------------------------------------------------ public */

    /** Candidate AIDs from the PPSE directory, by priority (tag 87) where present. */
    private static List<String> aidsFromPpse(List<Apdu.Tlv> nodes) {
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

    private static final class Fci { boolean ok; List<Apdu.Tlv> fci = new ArrayList<>(); String label; byte[] pdol; }

    private static Fci selectAid(Apdu.Transceiver t, String aidHex) {
        Fci out = new Fci();
        byte[] aid = Apdu.unhex(aidHex);
        Apdu.Response r;
        try { r = send(t, Apdu.selectByAid(aid)); } catch (IOException e) { return out; }
        if (!Apdu.isOk(r.sw)) return out;
        out.ok = true;
        out.fci = Apdu.decodeTlv(r.data, true);
        Apdu.Tlv label = Apdu.findTlv(out.fci, 0x50);
        if (label == null) label = Apdu.findTlv(out.fci, 0x9f12);
        out.label = label != null ? asciiOf(label.value) : null;
        Apdu.Tlv pdol = Apdu.findTlv(out.fci, 0x9f38);
        out.pdol = pdol != null ? pdol.value : null;
        return out;
    }

    private static final class Gpo { byte[] aip, afl; List<Apdu.Tlv> extra = new ArrayList<>(); }

    private static Gpo gpo(Apdu.Transceiver t, byte[] pdol) {
        Gpo out = new Gpo();
        byte[] data = pdol != null && pdol.length > 0 ? fillDol(pdol) : new byte[0];
        byte[] field = Apdu.concat(Apdu.u8(0x83, data.length & 0xff), data);
        Apdu.Response r;
        try { r = send(t, Apdu.apdu(0x80, 0xa8, 0x00, 0x00, field, 0x00)); } catch (IOException e) { return out; }
        if (!Apdu.isOk(r.sw)) return out;
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

    /**
     * Reads an EMV card's applications and their records into an {@code emv}
     * JSONObject (the NfcResult contract). {@code maxApps} caps how many
     * applications are opened (default 4).
     */
    public static JSONObject readEmv(Apdu.Transceiver t, int maxApps) throws IOException, JSONException {
        if (maxApps <= 0) maxApps = 4;
        String ppseTree = "";
        List<String> aids = new ArrayList<>();
        try {
            Apdu.Response r = send(t, Apdu.selectByAid(PPSE));
            if (Apdu.isOk(r.sw)) { List<Apdu.Tlv> nodes = Apdu.decodeTlv(r.data, true); ppseTree = Apdu.formatTlv(nodes, 0); aids = aidsFromPpse(nodes); }
        } catch (IOException e) { /* no PPSE — fall back to the candidate list */ }
        if (aids.isEmpty()) {
            for (EmvTags.Candidate c : EmvTags.CANDIDATE_AIDS) {
                if (selectAid(t, c.aid).ok) aids.add(c.aid);
                if (aids.size() >= maxApps) break;
            }
        }

        JSONArray apps = new JSONArray();
        for (int i = 0; i < aids.size() && i < maxApps; i++) {
            String aidHex = aids.get(i);
            Fci sel = selectAid(t, aidHex);
            if (!sel.ok) continue;
            Map<String, byte[]> tags = new LinkedHashMap<>();
            collectLeaves(sel.fci, tags);
            Gpo options = gpo(t, sel.pdol);
            collectLeaves(options.extra, tags);
            if (options.afl != null && options.afl.length > 0) readRecords(t, parseAfl(options.afl), tags);
            else {
                List<Afl> scan = new ArrayList<>();
                for (int sfi = 1; sfi <= 4; sfi++) scan.add(new Afl(sfi, 1, 8));
                readRecords(t, scan, tags);
            }
            apps.put(buildApp(aidHex, tags, sel.label));
        }

        JSONObject emv = new JSONObject();
        String app0Scheme = apps.length() > 0 ? apps.optJSONObject(0).optString("scheme", null) : null;
        String scheme = app0Scheme != null ? app0Scheme : (!aids.isEmpty() ? EmvTags.schemeForAid(aids.get(0)) : null);
        if (scheme != null) emv.put("scheme", scheme);
        emv.put("aids", new JSONArray(aids));
        emv.put("apps", apps);
        if (!ppseTree.isEmpty()) emv.put("tree", ppseTree);
        return emv;
    }

    /** A one-line summary for a log / flash (emv.ts emvSummary). */
    public static String emvSummary(JSONObject d) {
        JSONArray apps = d.optJSONArray("apps");
        JSONArray aids = d.optJSONArray("aids");
        if (apps == null || apps.length() == 0) {
            int n = aids == null ? 0 : aids.length();
            return n > 0 ? "EMV: " + n + " application(s), no records read" : "No EMV application found";
        }
        JSONObject a = apps.optJSONObject(0);
        List<String> bits = new ArrayList<>();
        String head = a.optString("scheme", a.optString("label", ""));
        if (!head.isEmpty()) bits.add(head);
        if (!a.optString("panMasked", "").isEmpty()) bits.add(a.optString("panMasked"));
        if (!a.optString("expiry", "").isEmpty()) bits.add(a.optString("expiry"));
        if (bits.isEmpty()) return "EMV: " + apps.length() + " application(s)";
        return String.join(" · ", bits);
    }
}
