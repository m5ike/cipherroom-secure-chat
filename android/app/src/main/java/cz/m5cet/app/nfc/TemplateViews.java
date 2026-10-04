package cz.m5cet.app.nfc;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * The output views of a template run (6.10) — apdu-templates.ts TEMPLATE_VIEWS,
 * the same names and the same text on the web and on the phone:
 *
 *   io        every command and its response: "→ <hex>" / "← <hex> <SW> (<meaning>)"
 *   raw       the responses only (hex + status word), one per line
 *   json      the TemplateExchange array — commands and responses — as
 *             JSON.stringify(exchanges, null, 2) writes it
 *   readable  for people: the card, the EMV applications (PAN masked, expiry,
 *             counters, the transaction history — the 6.6 card report), the
 *             e-ID holder and document, and for any other card each step's
 *             answer decoded (BER-TLV with the EMV names, DESFire's GetVersion,
 *             the status words explained)
 *
 * 6.10 security review (G-19): every view hides the card number — in the
 * readable report AND in the io / raw / json transcript — unless the user asks
 * for the full data: a PAN read anywhere (5A, Track 2 57 / 9F6B, Track 1 56)
 * keeps its first six and last four digits, in BCD and in ASCII-hex alike, and
 * the track data (57, 9F6B, 56, 9F1F, 9F20) is redacted ('X' for what is
 * hidden). The readable view says so; the app shows it above the others.
 *
 * Pure (no android.*): the labels of the readable view come through
 * {@link Labels} (the app's design strings), English when a key is missing.
 */
public final class TemplateViews {
    private TemplateViews() {}

    public static final String IO = "io", RAW = "raw", JSON = "json", READABLE = "readable";
    /** The views, in the order the switch shows them. */
    public static final List<String> VIEWS = java.util.Collections.unmodifiableList(Arrays.asList(IO, RAW, JSON, READABLE));

    /** The view's text, the card number masked. */
    public static String view(String view, TemplateRunner.Result r, Labels labels) { return view(view, r, labels, false); }

    /** The view's text; {@code full}: the card number and track data as read (the user asked for them). */
    public static String view(String view, TemplateRunner.Result r, Labels labels, boolean full) {
        switch (view == null ? "" : view) {
            case IO: return io(exchanges(r, full));
            case RAW: return raw(exchanges(r, full));
            case JSON: return json(exchanges(r, full));
            default: return readable(r, labels, true, full);
        }
    }

    /** The run's exchanges as a view shows them: masked (G-19) unless {@code full}. */
    public static List<TemplateRunner.Exchange> exchanges(TemplateRunner.Result r, boolean full) {
        if (full) return r.exchanges;
        Mask m = new Mask(pans(r));
        List<TemplateRunner.Exchange> out = new ArrayList<>(r.exchanges.size());
        for (TemplateRunner.Exchange e : r.exchanges)
            out.add(new TemplateRunner.Exchange(e.step, e.label, e.op, e.command, m.hex(e.response), e.sw, e.status, e.ms));
        return out;
    }

    /* ------------------------------------------------------------ masking (G-19) */

    /** Elements that carry the card number or track data: the PAN, Track 2 (57, 9F6B), Track 1 (56) and their discretionary data (9F1F, 9F20). */
    static final Set<String> SENSITIVE = new java.util.HashSet<>(Arrays.asList("5A", "57", "9F6B", "56", "9F1F", "9F20"));

    private static final java.util.regex.Pattern TRACK1 = java.util.regex.Pattern.compile("^(%?B?)(\\d{12,19})\\^");

    private static String xs(int n) { return repeat('X', Math.max(0, n)); }

    /** Every BER-TLV element of {@code b} and where its value lies — {tag, start, length}, nested ones too; a malformed tail ends the walk. */
    static List<int[]> nodes(byte[] b) {
        List<int[]> out = new ArrayList<>();
        walk(b, 0, b.length, 0, out);
        return out;
    }

    private static void walk(byte[] b, int from, int to, int depth, List<int[]> out) {
        int off = from;
        while (off < to && depth < 16) {
            int first = b[off] & 0xff;
            if (first == 0x00 || first == 0xff) { off++; continue; }
            int i = off + 1, tag = first;
            if ((first & 0x1f) == 0x1f) {
                int guard = 0;
                while (true) {
                    if (i >= to || guard++ > 3) return;
                    int c = b[i++] & 0xff;
                    tag = (tag << 8) | c;
                    if ((c & 0x80) == 0) break;
                }
            }
            if (i >= to) return;
            int len = b[i++] & 0xff;
            if (len > 0x80) {
                int k = len & 0x7f;
                if (k > 3 || i + k > to) return;
                len = 0;
                for (int j = 0; j < k; j++) len = (len << 8) | (b[i + j] & 0xff);
                i += k;
            } else if (len == 0x80) return;
            if (len < 0 || i + len > to) return;
            out.add(new int[]{tag, i, len});
            if ((first & 0x20) != 0) walk(b, i, i + len, depth + 1, out);
            off = i + len;
        }
    }

    /** The card number an element carries (5A, Track 2 before its "D", Track 1 between "B" and "^"), or null. */
    static String panOf(String tag, byte[] v) {
        switch (tag) {
            case "5A": { String h = Apdu.hex(v).replaceAll("F+$", ""); return h.matches("\\d{12,19}") ? h : null; }
            case "57": case "9F6B": {
                String h = Apdu.hex(v);
                int d = h.indexOf('D');
                return d > 0 && h.substring(0, d).matches("\\d{12,19}") ? h.substring(0, d) : null;
            }
            case "56": {
                java.util.regex.Matcher m = TRACK1.matcher(new String(v, java.nio.charset.StandardCharsets.ISO_8859_1));
                return m.find() ? m.group(2) : null;
            }
            default: return null;
        }
    }

    /** The card numbers a run read: the EMV applications', and every PAN or track in any answer. */
    public static Set<String> pans(TemplateRunner.Result r) {
        Set<String> out = new LinkedHashSet<>();
        JSONArray apps = r.emv == null ? null : r.emv.optJSONArray("apps");
        if (apps != null) for (int i = 0; i < apps.length(); i++) {
            String p = apps.optJSONObject(i) == null ? "" : apps.optJSONObject(i).optString("pan", "");
            if (p.matches("\\d{12,19}")) out.add(p);
        }
        List<String> answers = new ArrayList<>();
        for (TemplateRunner.Exchange e : r.exchanges) answers.add(e.response);
        for (TemplateRunner.StepResult s : r.steps) answers.add(s.data);
        for (String h : answers) {
            if (h == null || h.isEmpty() || !h.matches("([0-9A-F]{2})+")) continue;
            byte[] b = Apdu.unhex(h);
            for (int[] n : nodes(b)) {
                String p = panOf(Apdu.tagHex(n[0]), Apdu.slice(b, n[1], n[1] + n[2]));
                if (p != null) out.add(p);
            }
        }
        return out;
    }

    /** Whether masking hides anything in this run (the app then offers the full data and says it is masked). */
    public static boolean masks(TemplateRunner.Result r) {
        if (!pans(r).isEmpty()) return true;
        for (TemplateRunner.Exchange e : r.exchanges) {
            if (e.response.isEmpty() || !e.response.matches("([0-9A-F]{2})+")) continue;
            for (int[] n : nodes(Apdu.unhex(e.response))) if (SENSITIVE.contains(Apdu.tagHex(n[0]))) return true;
        }
        return false;
    }

    /** BCD digits (a trailing F kept): the first six and the last four, X between. */
    static String maskDigits(String digits) {
        String core = digits.replaceAll("F+$", ""), pad = digits.substring(core.length());
        if (core.length() < 10) return xs(core.length()) + pad;
        return core.substring(0, 6) + xs(core.length() - 10) + core.substring(core.length() - 4) + pad;
    }

    /** "54…" → "3534…": digits as ASCII, in hex. */
    static String asciiHex(String digits) { return Apdu.hex(digits.getBytes(java.nio.charset.StandardCharsets.US_ASCII)); }

    private static String maskedAsciiHex(String pan) {
        return asciiHex(pan.substring(0, 6)) + xs((pan.length() - 10) * 2) + asciiHex(pan.substring(pan.length() - 4));
    }

    /** A sensitive element's value (hex) as a masked view shows it. */
    static String maskValue(String tag, String hex) {
        switch (tag) {
            case "5A": return maskDigits(hex);
            case "57": case "9F6B": {
                int d = hex.indexOf('D');
                if (d <= 0) return hex.length() <= 6 ? xs(hex.length()) : hex.substring(0, 6) + xs(hex.length() - 6);
                return maskDigits(hex.substring(0, d)) + "D" + xs(hex.length() - d - 1);
            }
            case "56": {
                if (!hex.matches("([0-9A-F]{2})+")) return xs(hex.length());
                String s = new String(Apdu.unhex(hex), java.nio.charset.StandardCharsets.ISO_8859_1);
                java.util.regex.Matcher m = TRACK1.matcher(s);
                if (!m.find() || m.group(2).length() < 10) return xs(hex.length());
                String head = asciiHex(m.group(1)) + maskedAsciiHex(m.group(2));
                return head + xs(hex.length() - head.length());
            }
            default: return xs(hex.length());
        }
    }

    /** How a view hides the card number: in an answer (hex), in a decoded value, in text. Off: everything as read. */
    static final class Mask {
        final Set<String> pans;
        final boolean on;
        Mask(Set<String> pans) { this.pans = pans; this.on = true; }
        private Mask() { this.pans = new LinkedHashSet<>(); this.on = false; }
        static final Mask OFF = new Mask();

        /** An answer: its sensitive elements masked (when it is BER-TLV), then every PAN in BCD or ASCII-hex. */
        String hex(String h) {
            if (!on || h == null || h.isEmpty()) return h;
            char[] out = h.toCharArray();
            if (h.matches("([0-9A-F]{2})+")) {
                byte[] b = Apdu.unhex(h);
                if (isTlv(b)) for (int[] n : nodes(b)) {
                    String tag = Apdu.tagHex(n[0]);
                    if (!SENSITIVE.contains(tag)) continue;
                    String v = maskValue(tag, h.substring(n[1] * 2, (n[1] + n[2]) * 2));
                    for (int i = 0; i < v.length(); i++) out[n[1] * 2 + i] = v.charAt(i);
                }
            }
            String s = new String(out);
            for (String p : pans) { s = s.replace(p, maskDigits(p)); s = s.replace(asciiHex(p), maskedAsciiHex(p)); }
            return s;
        }

        /** A value as text (a decoded element, a label): every PAN masked. */
        String text(String t) {
            if (!on || t == null) return t;
            for (String p : pans) t = t.replace(p, maskDigits(p));
            return t;
        }

        /** An element's decoded value: a sensitive one shows only its masked hex. */
        String value(String tag, String shown, String hex) { return on && SENSITIVE.contains(tag) ? maskValue(tag, hex) : text(shown); }
    }

    /**
     * The {@code emv} object as a masked view shows it (the workbench draws it):
     * no whole PAN, the sensitive elements masked, the records and the log's raw
     * records masked.
     */
    public static JSONObject maskedEmv(JSONObject emv, Set<String> pans) {
        if (emv == null) return null;
        Mask m = new Mask(pans);
        try {
            JSONObject out = new JSONObject(emv.toString());
            JSONArray apps = out.optJSONArray("apps");
            if (apps != null) for (int i = 0; i < apps.length(); i++) {
                JSONObject a = apps.optJSONObject(i);
                if (a == null) continue;
                String pan = a.optString("pan", "");
                a.remove("pan");
                if (!pan.isEmpty() && a.optString("panMasked", "").isEmpty()) a.put("panMasked", pan.length() < 10 ? pan : pan.substring(0, 6) + repeat('•', pan.length() - 10) + pan.substring(pan.length() - 4));
                for (String list : new String[]{"tags", "getData"}) {
                    JSONArray tags = a.optJSONArray(list);
                    if (tags != null) for (int j = 0; j < tags.length(); j++) {
                        JSONObject t = tags.optJSONObject(j);
                        String tag = t.optString("tag"), hex = t.optString("hex");
                        t.put("value", m.value(tag, t.optString("value"), hex));
                        t.put("hex", SENSITIVE.contains(tag) ? maskValue(tag, hex) : m.hex(hex));
                    }
                }
                JSONArray recs = a.optJSONArray("records");
                if (recs != null) for (int j = 0; j < recs.length(); j++) { JSONObject rec = recs.optJSONObject(j); rec.put("hex", m.hex(rec.optString("hex"))); }
                JSONArray log = a.optJSONArray("log");
                if (log != null) for (int j = 0; j < log.length(); j++) { JSONObject e = log.optJSONObject(j); if (e.has("raw")) e.put("raw", m.hex(e.optString("raw"))); }
            }
            return out;
        } catch (org.json.JSONException e) { throw new IllegalStateException(e); }
    }

    /* ------------------------------------------------------------ io / raw / json */

    private static String answer(TemplateRunner.Exchange e) {
        StringBuilder sb = new StringBuilder();
        if (!e.response.isEmpty()) sb.append(e.response);
        if (!e.sw.isEmpty()) { if (sb.length() > 0) sb.append(' '); sb.append(e.sw); }
        return sb.toString();
    }

    /** Every command and its response: "→ 00A4…" then "← 6F2E… 9000 (OK)". */
    public static String io(List<TemplateRunner.Exchange> xs) {
        List<String> lines = new ArrayList<>();
        for (TemplateRunner.Exchange e : xs) {
            lines.add("→ " + e.command);
            String a = answer(e);
            lines.add("← " + (a.isEmpty() ? "" : a + " ") + "(" + StatusWords.describe(e.sw) + ")");
        }
        return String.join("\n", lines);
    }

    /** The responses only, one per line ("6F2E… 9000"). */
    public static String raw(List<TemplateRunner.Exchange> xs) {
        List<String> lines = new ArrayList<>();
        for (TemplateRunner.Exchange e : xs) { String a = answer(e); lines.add(a.isEmpty() ? "(" + StatusWords.describe(e.sw) + ")" : a); }
        return String.join("\n", lines);
    }

    /** The exchanges as JSON.stringify(exchanges, null, 2) writes them (TemplateExchange: step, label, op, command, response, sw, status, ms). */
    public static String json(List<TemplateRunner.Exchange> xs) {
        if (xs.isEmpty()) return "[]";
        StringBuilder sb = new StringBuilder("[\n");
        for (int i = 0; i < xs.size(); i++) {
            TemplateRunner.Exchange e = xs.get(i);
            sb.append("  {\n");
            sb.append("    \"step\": ").append(e.step).append(",\n");
            sb.append("    \"label\": ").append(str(e.label)).append(",\n");
            sb.append("    \"op\": ").append(str(e.op)).append(",\n");
            sb.append("    \"command\": ").append(str(e.command)).append(",\n");
            sb.append("    \"response\": ").append(str(e.response)).append(",\n");
            sb.append("    \"sw\": ").append(str(e.sw)).append(",\n");
            sb.append("    \"status\": ").append(str(e.status)).append(",\n");
            sb.append("    \"ms\": ").append(e.ms).append('\n');
            sb.append(i + 1 < xs.size() ? "  },\n" : "  }\n");
        }
        return sb.append(']').toString();
    }

    /** A JSON string as JSON.stringify writes it (no escaped "/", non-ASCII as it is, lone surrogates as \\uXXXX). */
    static String str(String s) {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder(s.length() + 2).append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
                    else if (Character.isHighSurrogate(c) && (i + 1 >= s.length() || !Character.isLowSurrogate(s.charAt(i + 1)))) sb.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
                    else if (Character.isLowSurrogate(c) && (i == 0 || !Character.isHighSurrogate(s.charAt(i - 1)))) sb.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.append('"').toString();
    }

    /* ------------------------------------------------------------ labels */

    /** The app's strings (design keys); a missing key falls back to English. */
    public interface Labels { String t(String key); }

    /** English for every key the readable view uses (the design's en strings say the same). */
    static final Map<String, String> EN = new LinkedHashMap<>();
    private static void en(String k, String v) { EN.put(k, v); }
    static {
        // 6.6 keys the workbench already has.
        en("nfc.emv.expiry", "Expiry"); en("nfc.emv.cardholder", "Cardholder"); en("nfc.emv.effective", "Effective"); en("nfc.emv.issuer", "Issuer country");
        en("nfc.emv.panSeq", "PAN sequence"); en("nfc.emv.atc", "Transactions (ATC)"); en("nfc.emv.lastOnlineAtc", "Last online ATC"); en("nfc.emv.ptc", "PIN tries left");
        en("nfc.emv.history", "Transaction history"); en("nfc.emv.noHistory", "The card keeps no transaction log (or it is not readable)."); en("nfc.emv.date", "Date");
        en("nfc.emv.time", "Time"); en("nfc.emv.amount", "Amount"); en("nfc.emv.merchant", "Merchant"); en("nfc.emv.type", "Type"); en("nfc.emv.getData", "Counters (GET DATA)");
        en("nfc.emv.tags", "Data elements"); en("nfc.emv.records", "Records"); en("nfc.emv.log", "log");
        en("nfc.eid.docCode", "Document"); en("nfc.eid.docNumber", "Document number"); en("nfc.eid.nationality", "Nationality");
        en("nfc.eid.issuer", "Issuing state"); en("nfc.eid.dobLabel", "Born"); en("nfc.eid.sex", "Sex"); en("nfc.eid.expiryLabel", "Expires"); en("nfc.eid.access", "Opened with");
        en("nfc.eid.dataGroups", "Data groups"); en("nfc.eid.personal", "Personal details (DG11)"); en("nfc.eid.fullName", "Full name"); en("nfc.eid.otherNames", "Other names");
        en("nfc.eid.personalNumber", "Personal number"); en("nfc.eid.fullDob", "Full date of birth"); en("nfc.eid.placeOfBirth", "Place of birth"); en("nfc.eid.address", "Address");
        en("nfc.eid.telephone", "Telephone"); en("nfc.eid.profession", "Profession"); en("nfc.eid.titleField", "Title"); en("nfc.eid.summary", "Personal summary");
        en("nfc.eid.otherDocs", "Other travel documents"); en("nfc.eid.custody", "Custody"); en("nfc.eid.document", "Document details (DG12)");
        en("nfc.eid.issuingAuthority", "Issuing authority"); en("nfc.eid.dateOfIssue", "Date of issue"); en("nfc.eid.otherPersons", "Other persons");
        en("nfc.eid.endorsements", "Endorsements"); en("nfc.eid.taxExit", "Tax / exit"); en("nfc.eid.personalized", "Personalized");
        en("nfc.eid.personalizationDevice", "Personalization system"); en("nfc.eid.optional", "Optional details (DG13)"); en("nfc.eid.notify", "Persons to notify (DG16)");
        en("nfc.eid.security", "Security"); en("nfc.eid.passive", "Passive authentication"); en("nfc.eid.passiveOk", "every group read matches EF.SOD");
        en("nfc.eid.passiveBad", "a group does NOT match EF.SOD"); en("nfc.eid.passiveNone", "not checked"); en("nfc.eid.hash", "Hash"); en("nfc.eid.signer", "Document signer");
        en("nfc.eid.signedBy", "Signed by"); en("nfc.eid.validity", "Valid"); en("nfc.eid.serial", "Serial number"); en("nfc.eid.protocols", "Protocols");
        en("nfc.eid.aaKey", "Active Authentication key"); en("nfc.eid.lds", "LDS version"); en("nfc.eid.unicode", "Unicode version"); en("nfc.eid.files", "Files");
        en("nfc.eid.st.read", "read"); en("nfc.eid.st.protected", "protected (EAC)"); en("nfc.eid.st.absent", "absent"); en("nfc.eid.st.error", "error");
        en("nfc.eid.images", "Pictures"); en("nfc.eid.img.face", "Face"); en("nfc.eid.img.portrait", "Portrait"); en("nfc.eid.img.signature", "Signature");
        en("nfc.eid.img.document", "Document"); en("nfc.eid.img.other", "Picture");
        // 6.10 (design-610-nfc.ts).
        en("nfc.tpl.r.card", "Card"); en("nfc.tpl.r.tech", "Technology"); en("nfc.tpl.r.aids", "Applications on the card"); en("nfc.tpl.r.read", "Read");
        en("nfc.tpl.r.deep", "every file"); en("nfc.tpl.r.afl", "AFL records"); en("nfc.tpl.r.app", "Application");
        en("nfc.tpl.r.label", "Label"); en("nfc.tpl.r.scheme", "Scheme"); en("nfc.tpl.r.pan", "Card number"); en("nfc.tpl.r.currency", "Currency");
        en("nfc.tpl.r.country", "Country"); en("nfc.tpl.r.result", "Result"); en("nfc.tpl.r.logSfi", "Log file (SFI)"); en("nfc.tpl.r.logFormat", "Log format");
        en("nfc.tpl.r.holder", "Holder"); en("nfc.tpl.r.name", "Name"); en("nfc.tpl.r.optionalData", "Optional data"); en("nfc.tpl.r.mrz", "MRZ");
        en("nfc.tpl.r.file", "File"); en("nfc.tpl.r.status", "Status"); en("nfc.tpl.r.size", "Size"); en("nfc.tpl.r.message", "Message");
        en("nfc.tpl.r.command", "Command"); en("nfc.tpl.r.response", "Response"); en("nfc.tpl.r.text", "Text");
        en("nfc.tpl.r.steps", "Steps"); en("nfc.tpl.r.total", "{0} commands · {1} s"); en("nfc.tpl.r.cancelled", "Cancelled — this is what was read before.");
        en("nfc.tpl.r.stopped", "The read stopped: {0}"); en("nfc.tpl.r.none", "none");
        en("nfc.tpl.r.desfire", "MIFARE DESFire"); en("nfc.tpl.r.vendor", "Vendor"); en("nfc.tpl.r.product", "Product"); en("nfc.tpl.r.hw", "Hardware");
        en("nfc.tpl.r.sw", "Software"); en("nfc.tpl.r.storage", "Storage"); en("nfc.tpl.r.protocol", "Protocol"); en("nfc.tpl.r.batch", "Batch");
        en("nfc.tpl.r.produced", "Produced"); en("nfc.tpl.r.week", "week {0} of {1}"); en("nfc.tpl.r.apps", "Applications (AIDs)");
        en("nfc.tpl.r.free", "Free memory"); en("nfc.tpl.r.keys", "Key settings (PICC)"); en("nfc.tpl.r.keyCount", "{0} key(s), {1}");
        en("nfc.tpl.r.ks.change", "master key changeable"); en("nfc.tpl.r.ks.list", "applications listed without a key");
        en("nfc.tpl.r.ks.create", "applications created without a key"); en("nfc.tpl.r.ks.config", "settings changeable"); en("nfc.tpl.r.ks.frozen", "settings frozen");
        en("nfc.tpl.n.dir", "{0} application(s) listed"); en("nfc.tpl.n.noDir", "no directory on the card"); en("nfc.tpl.n.selected", "selected: {0}");
        en("nfc.tpl.n.notSelected", "not on the card — its steps were skipped"); en("nfc.tpl.n.noAid", "no application to select");
        en("nfc.tpl.n.getData", "{0} of {1} answered"); en("nfc.tpl.n.noLog", "the card keeps no transaction log"); en("nfc.tpl.n.log", "{0} entries");
        en("nfc.tpl.n.gpo", "AIP {0} · AFL {1}"); en("nfc.tpl.n.gpoRefused", "the card refused GET PROCESSING OPTIONS"); en("nfc.tpl.n.noAfl", "no AFL (GPO gave none)");
        en("nfc.tpl.n.records", "{0} record(s)"); en("nfc.tpl.n.apps", "{0} application(s) read"); en("nfc.tpl.n.unknownOp", "unknown operation {0}");
        en("nfc.tpl.n.badCommand", "not a valid command"); en("nfc.tpl.n.lost", "the card stopped answering"); en("nfc.tpl.n.cancelled", "cancelled");
        en("nfc.tpl.n.refused", "refused, never sent — {0}"); en("nfc.tpl.r.masked", "Card numbers and track data are masked.");
    }

    private static final class L {
        final Labels src;
        L(Labels src) { this.src = src; }
        String t(String key) {
            String v = null;
            try { v = src == null ? null : src.t(key); } catch (RuntimeException ignored) { }
            if (v == null || v.isEmpty() || v.equals(key)) { String e = EN.get(key); return e != null ? e : key; }
            return v;
        }
        String f(String key, String... args) {
            String s = t(key);
            for (int i = 0; i < args.length; i++) s = s.replace("{" + i + "}", args[i] == null ? "" : args[i]);
            return s;
        }
    }

    /* ------------------------------------------------------------ readable */

    /** A part of the readable text (card-report.ts textOf's sections). */
    private static final class Section {
        final String title;
        final List<String[]> rows = new ArrayList<>();
        String[] columns;
        List<String[]> table;
        String pre, note;
        Section(String title) { this.title = title; }
        Section row(String field, String value) { if (value != null && !value.isEmpty()) rows.add(new String[]{field, value}); return this; }
        boolean empty() { return rows.isEmpty() && table == null && pre == null && note == null; }
    }

    private static String repeat(char c, int n) { StringBuilder sb = new StringBuilder(); for (int i = 0; i < n; i++) sb.append(c); return sb.toString(); }
    private static String pad(String s, int w) { return s.length() >= w ? s : s + repeat(' ', w - s.length()); }
    private static String trimEnd(String s) { int i = s.length(); while (i > 0 && s.charAt(i - 1) == ' ') i--; return s.substring(0, i); }

    /** The sections as plain text: a title over "=", each section over "-", fields aligned, tables in columns. */
    private static String text(String title, List<String> subtitle, List<Section> sections) {
        List<String> lines = new ArrayList<>();
        lines.add(title);
        lines.add(repeat('=', Math.min(72, Math.max(8, title.length()))));
        for (String s : subtitle) if (s != null && !s.isEmpty()) lines.add(s);
        for (Section s : sections) {
            if (s.empty()) continue;
            lines.add("");
            lines.add(s.title);
            lines.add(repeat('-', Math.min(72, s.title.length())));
            int w = 0;
            for (String[] r : s.rows) w = Math.max(w, r[0].length());
            w = Math.min(28, w);
            for (String[] r : s.rows) lines.add(pad(r[0], w) + "  " + r[1].replace("\n", "\n" + repeat(' ', w + 2)));
            if (s.table != null) {
                int[] widths = new int[s.columns.length];
                for (int i = 0; i < widths.length; i++) {
                    int m = s.columns[i].length();
                    for (String[] r : s.table) m = Math.max(m, i < r.length && r[i] != null ? r[i].length() : 0);
                    widths[i] = Math.min(30, m);
                }
                StringBuilder head = new StringBuilder(), rule = new StringBuilder();
                for (int i = 0; i < widths.length; i++) {
                    if (i > 0) { head.append("  "); rule.append("  "); }
                    head.append(pad(s.columns[i], widths[i]));
                    rule.append(repeat('-', widths[i]));
                }
                lines.add(trimEnd(head.toString()));
                lines.add(rule.toString());
                for (String[] r : s.table) {
                    StringBuilder row = new StringBuilder();
                    for (int i = 0; i < widths.length; i++) {
                        if (i > 0) row.append("  ");
                        String c = i < r.length && r[i] != null ? r[i] : "";
                        row.append(pad(c.length() > 30 ? c.substring(0, 30) : c, widths[i]));
                    }
                    lines.add(trimEnd(row.toString()));
                }
            }
            if (s.pre != null) lines.add(s.pre);
            if (s.note != null) lines.add(s.note);
        }
        return String.join("\n", lines) + "\n";
    }

    /**
     * The run for people. {@code cards} false leaves out the EMV and e-ID
     * sections (the workbench draws those itself, with the face beside the holder).
     */
    public static String readable(TemplateRunner.Result r, Labels labels, boolean cards) { return readable(r, labels, cards, false); }

    /** The run for people; {@code full}: the card number and track data as read, else masked (G-19) and said so. */
    public static String readable(TemplateRunner.Result r, Labels labels, boolean cards, boolean full) {
        L l = new L(labels);
        Mask m = full ? Mask.OFF : new Mask(pans(r));
        List<Section> sections = new ArrayList<>();
        List<String> subtitle = new ArrayList<>();
        if (r.note != null && !r.note.isEmpty()) subtitle.add(r.note);
        if (!full && masks(r)) subtitle.add(l.t("nfc.tpl.r.masked"));
        Section card = cardSection(l, r.cardInfo);
        if (card != null) sections.add(card);
        if (cards && r.emv != null) emv(l, r.emv, sections, m);
        if (cards && r.mrtd != null) mrtd(l, r.mrtd, sections);
        generic(l, r, sections, m);
        sections.add(steps(l, r, m));
        return text(r.label, subtitle, sections);
    }

    private static Section cardSection(L l, JSONObject c) {
        if (c == null) return null;
        Section s = new Section(l.t("nfc.tpl.r.card"));
        s.row("UID", c.optString("uid", ""));
        s.row(l.t("nfc.tpl.r.tech"), c.optString("label", c.optString("tech", "")));
        s.row("ATQA", c.optString("atqa", "")); s.row("SAK", c.optString("sak", "")); s.row("ATS", c.optString("ats", "")); s.row("ATR", c.optString("atr", ""));
        return s.empty() ? null : s;
    }

    private static String sym(String status) { return "error".equals(status) ? "✗" : "warn".equals(status) ? "⚠" : "✓"; }

    private static Section steps(L l, TemplateRunner.Result r, Mask m) {
        Section s = new Section(l.t("nfc.tpl.r.steps") + " (" + r.steps.size() + ")");
        for (TemplateRunner.StepResult x : r.steps) {
            String note = x.noteKey != null ? l.f(x.noteKey, x.noteArgs) : x.note;
            if (x.op.isEmpty() && !x.sw.isEmpty() && x.noteKey == null) note = x.sw + " " + StatusWords.describe(x.sw);
            s.rows.add(new String[]{x.step + " " + sym(x.status), m.text(x.label + (note == null || note.isEmpty() ? "" : " — " + note))});
        }
        s.rows.add(new String[]{"Σ", l.f("nfc.tpl.r.total", String.valueOf(r.exchanges.size()), String.format(Locale.ROOT, "%.1f", r.ms / 1000.0))});
        if (r.cancelled) s.note = l.t("nfc.tpl.r.cancelled");
        else if (r.error != null) s.note = l.f("nfc.tpl.r.stopped", r.error);
        return s;
    }

    /* ------------------------------------------------------------ EMV (card-report.ts buildEmv) */

    private static String maskPan(String pan) {
        if (pan.length() < 10) return pan;
        return pan.substring(0, 6) + repeat('•', pan.length() - 10) + pan.substring(pan.length() - 4);
    }

    private static void emv(L l, JSONObject d, List<Section> out, Mask m) {
        JSONArray apps = d.optJSONArray("apps");
        if (apps == null) apps = new JSONArray();
        Section head = new Section(l.t("nfc.tpl.r.aids"));
        JSONArray aids = d.optJSONArray("aids");
        StringBuilder list = new StringBuilder();
        if (aids != null) for (int i = 0; i < aids.length(); i++) { if (i > 0) list.append(", "); list.append(aids.optString(i)); }
        head.row("AID", list.length() > 0 ? list.toString() : "—");
        head.row(l.t("nfc.tpl.r.read"), l.t(d.optBoolean("deep", false) ? "nfc.tpl.r.deep" : "nfc.tpl.r.afl") + (d.optInt("apdus", 0) > 0 ? " · " + d.optInt("apdus") + " APDU" : ""));
        out.add(head);
        for (int i = 0; i < apps.length(); i++) {
            JSONObject a = apps.optJSONObject(i);
            if (a == null) continue;
            String name = a.optString("label", "").isEmpty() ? a.optString("scheme", a.optString("aid", "")) : a.optString("label");
            String n = apps.length() > 1 ? " " + (i + 1) + " — " + name : " — " + name;
            Section s = new Section(l.t("nfc.tpl.r.app") + n);
            s.row("AID", a.optString("aid", "")); s.row(l.t("nfc.tpl.r.label"), a.optString("label", "")); s.row(l.t("nfc.tpl.r.scheme"), a.optString("scheme", ""));
            String pan = m.on ? a.optString("panMasked", "") : a.optString("pan", a.optString("panMasked", ""));
            if (pan.isEmpty() && !a.optString("pan", "").isEmpty()) pan = maskPan(a.optString("pan"));
            s.row(l.t("nfc.tpl.r.pan"), pan); s.row(l.t("nfc.emv.expiry"), a.optString("expiry", "")); s.row(l.t("nfc.emv.effective"), a.optString("effective", ""));
            s.row(l.t("nfc.emv.cardholder"), a.optString("cardholder", "")); s.row(l.t("nfc.emv.issuer"), a.optString("issuerCountry", ""));
            s.row(l.t("nfc.emv.panSeq"), a.optString("panSequence", ""));
            if (a.has("atc")) s.row(l.t("nfc.emv.atc"), String.valueOf(a.optLong("atc")));
            if (a.has("lastOnlineAtc")) s.row(l.t("nfc.emv.lastOnlineAtc"), String.valueOf(a.optLong("lastOnlineAtc")));
            if (a.has("pinTryCounter")) s.row(l.t("nfc.emv.ptc"), String.valueOf(a.optLong("pinTryCounter")));
            s.row("AIP", a.optString("aip", "")); s.row("AFL", a.optString("afl", ""));
            if (a.has("logSfi")) s.row(l.t("nfc.tpl.r.logSfi"), String.valueOf(a.optInt("logSfi")));
            s.row(l.t("nfc.tpl.r.logFormat"), a.optString("logFormat", ""));
            out.add(s);
            // The history.
            JSONArray log = a.optJSONArray("log");
            if (a.has("logSfi") || (log != null && log.length() > 0)) {
                int count = log == null ? 0 : log.length();
                Section h = new Section(l.t("nfc.emv.history") + n + " (" + count + ")");
                if (count == 0) h.note = l.t("nfc.emv.noHistory");
                else {
                    String[][] cols = {{"date", "nfc.emv.date"}, {"time", "nfc.emv.time"}, {"amount", "nfc.emv.amount"}, {"currency", "nfc.tpl.r.currency"},
                        {"merchant", "nfc.emv.merchant"}, {"type", "nfc.emv.type"}, {"country", "nfc.tpl.r.country"}, {"atc", "ATC"}, {"cid", "nfc.tpl.r.result"}};
                    List<String[]> used = new ArrayList<>();
                    for (String[] c : cols) for (int j = 0; j < log.length(); j++) if (!log.optJSONObject(j).optString(c[0], "").isEmpty()) { used.add(c); break; }
                    Set<String> extra = new LinkedHashSet<>();
                    for (int j = 0; j < log.length(); j++) for (java.util.Iterator<String> it = log.optJSONObject(j).keys(); it.hasNext(); ) {
                        String k = it.next();
                        boolean known = k.equals("raw");
                        for (String[] c : cols) if (c[0].equals(k)) known = true;
                        if (!known) extra.add(k);
                    }
                    List<String> columns = new ArrayList<>();
                    for (String[] c : used) columns.add(c[1].startsWith("nfc.") ? l.t(c[1]) : c[1]);
                    columns.addAll(extra);
                    h.columns = columns.toArray(new String[0]);
                    h.table = new ArrayList<>();
                    for (int j = 0; j < log.length(); j++) {
                        JSONObject e = log.optJSONObject(j);
                        List<String> row = new ArrayList<>();
                        for (String[] c : used) row.add(e.optString(c[0], ""));
                        for (String k : extra) row.add(e.optString(k, ""));
                        h.table.add(row.toArray(new String[0]));
                    }
                }
                out.add(h);
            }
            JSONArray gd = a.optJSONArray("getData");
            if (gd != null && gd.length() > 0) {
                Section g = new Section(l.t("nfc.emv.getData") + n);
                for (int j = 0; j < gd.length(); j++) { JSONObject t = gd.optJSONObject(j); g.rows.add(new String[]{t.optString("tag") + " " + t.optString("name"), m.value(t.optString("tag"), t.optString("value"), t.optString("hex"))}); }
                out.add(g);
            }
            JSONArray tags = a.optJSONArray("tags");
            if (tags != null && tags.length() > 0) {
                Section t = new Section(l.t("nfc.emv.tags") + n + " (" + tags.length() + ")");
                for (int j = 0; j < tags.length(); j++) {
                    JSONObject tg = tags.optJSONObject(j);
                    String v = tg.optString("value"), hx = tg.optString("hex");
                    String tag = tg.optString("tag");
                    String shown = m.on && SENSITIVE.contains(tag) ? maskValue(tag, hx) : v.equals(hx) ? m.hex(hx) : m.text(v) + "  (" + m.hex(hx) + ")";
                    t.rows.add(new String[]{tag + " " + tg.optString("name"), shown});
                }
                out.add(t);
            }
            JSONArray recs = a.optJSONArray("records");
            if (recs != null && recs.length() > 0) {
                Section rs = new Section(l.t("nfc.emv.records") + n + " (" + recs.length() + ")");
                List<String> lines = new ArrayList<>();
                for (int j = 0; j < recs.length(); j++) {
                    JSONObject rec = recs.optJSONObject(j);
                    lines.add(String.format(Locale.ROOT, "SFI %2d · %2d%s  %s", rec.optInt("sfi"), rec.optInt("record"), rec.optBoolean("log") ? " (" + l.t("nfc.emv.log") + ")" : "", m.hex(rec.optString("hex"))));
                }
                rs.pre = String.join("\n", lines);
                out.add(rs);
            }
        }
    }

    /* ------------------------------------------------------------ e-ID (card-report.ts buildMrtd) */

    private static String joined(JSONObject o, String key) {
        JSONArray arr = o.optJSONArray(key);
        if (arr == null) return o.optString(key, "");
        List<String> parts = new ArrayList<>();
        for (int i = 0; i < arr.length(); i++) parts.add(arr.optString(i));
        return String.join("; ", parts);
    }

    private static String sizeText(long n) {
        if (n < 1024) return n + " B";
        if (n < 1024 * 1024) return n < 10_240 ? String.format(Locale.ROOT, "%.1f kB", n / 1024.0) : (n / 1024) + " kB";
        return String.format(Locale.ROOT, "%.1f MB", n / 1024.0 / 1024.0);
    }

    private static long b64Size(String b64) { return b64.length() * 3L / 4 - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0); }

    private static void mrtd(L l, JSONObject d, List<Section> out) {
        JSONObject m = d.optJSONObject("mrzInfo");
        if (m == null) m = new JSONObject();
        Section h = new Section(l.t("nfc.tpl.r.holder"));
        h.row(l.t("nfc.eid.docCode"), m.optString("documentCode", ""));
        h.row(l.t("nfc.eid.docNumber"), m.optString("documentNumber", ""));
        h.row(l.t("nfc.tpl.r.name"), (m.optString("givenNames", "") + " " + m.optString("surname", "")).trim());
        h.row(l.t("nfc.eid.nationality"), m.optString("nationality", ""));
        h.row(l.t("nfc.eid.dobLabel"), m.optString("dateOfBirth", ""));
        h.row(l.t("nfc.eid.sex"), m.optString("sex", ""));
        h.row(l.t("nfc.eid.expiryLabel"), m.optString("dateOfExpiry", ""));
        h.row(l.t("nfc.eid.issuer"), m.optString("issuer", ""));
        h.row(l.t("nfc.tpl.r.optionalData"), m.optString("optionalData", ""));
        String access = d.optString("access", "none");
        JSONObject pace = d.optJSONObject("pace");
        String how = "pace".equals(access) ? "PACE" + (pace != null && !pace.optString("password", "").isEmpty() ? " (" + pace.optString("password").toUpperCase(Locale.ROOT) + ")" : "")
            + (pace != null && !pace.optString("protocol", "").isEmpty() ? " · " + pace.optString("protocol") : "")
            : "bac".equals(access) ? "BAC (MRZ)" : "—";
        h.row(l.t("nfc.eid.access"), how);
        h.row(l.t("nfc.eid.dataGroups"), joined(d, "dataGroups").replace("; ", ", "));
        if (!d.has("mrzInfo")) h.row(l.t("nfc.tpl.r.message"), d.optString("message", ""));
        out.add(h);
        String mrz = m.optString("mrz", "");
        if (!mrz.isEmpty()) {
            Section z = new Section(l.t("nfc.tpl.r.mrz"));
            String flat = mrz.replace("\n", "");
            z.pre = mrz.contains("\n") ? mrz : flat.length() == 88 ? flat.substring(0, 44) + "\n" + flat.substring(44)
                : flat.length() == 90 ? flat.substring(0, 30) + "\n" + flat.substring(30, 60) + "\n" + flat.substring(60)
                : flat.length() == 72 ? flat.substring(0, 36) + "\n" + flat.substring(36) : flat;
            out.add(z);
        }
        JSONObject p = d.optJSONObject("personal");
        if (p != null && p.length() > 0) {
            Section s = new Section(l.t("nfc.eid.personal"));
            String[][] keys = {{"fullName", "nfc.eid.fullName"}, {"otherNames", "nfc.eid.otherNames"}, {"personalNumber", "nfc.eid.personalNumber"},
                {"fullDateOfBirth", "nfc.eid.fullDob"}, {"placeOfBirth", "nfc.eid.placeOfBirth"}, {"address", "nfc.eid.address"}, {"telephone", "nfc.eid.telephone"},
                {"profession", "nfc.eid.profession"}, {"title", "nfc.eid.titleField"}, {"personalSummary", "nfc.eid.summary"},
                {"otherTravelDocuments", "nfc.eid.otherDocs"}, {"custody", "nfc.eid.custody"}};
            for (String[] k : keys) s.row(l.t(k[1]), joined(p, k[0]));
            out.add(s);
        }
        JSONObject doc = d.optJSONObject("document");
        if (doc != null && doc.length() > 0) {
            Section s = new Section(l.t("nfc.eid.document"));
            String[][] keys = {{"issuingAuthority", "nfc.eid.issuingAuthority"}, {"dateOfIssue", "nfc.eid.dateOfIssue"}, {"otherPersons", "nfc.eid.otherPersons"},
                {"endorsements", "nfc.eid.endorsements"}, {"taxExit", "nfc.eid.taxExit"}, {"personalizationTime", "nfc.eid.personalized"},
                {"personalizationDevice", "nfc.eid.personalizationDevice"}};
            for (String[] k : keys) s.row(l.t(k[1]), joined(doc, k[0]));
            out.add(s);
        }
        if (!d.optString("optional", "").isEmpty()) { Section s = new Section(l.t("nfc.eid.optional")); s.pre = d.optString("optional"); out.add(s); }
        JSONArray notify = d.optJSONArray("personsToNotify");
        if (notify != null && notify.length() > 0) {
            Section s = new Section(l.t("nfc.eid.notify"));
            for (int i = 0; i < notify.length(); i++) s.row("#" + (i + 1), notify.optString(i));
            out.add(s);
        }
        JSONObject sec = d.optJSONObject("security");
        if (sec != null && sec.length() > 0) {
            Section s = new Section(l.t("nfc.eid.security"));
            String passive = sec.optString("passive", "");
            s.row(l.t("nfc.eid.passive"), passive.equals("ok") ? "✓ " + l.t("nfc.eid.passiveOk") : passive.equals("mismatch") ? "✗ " + l.t("nfc.eid.passiveBad") : l.t("nfc.eid.passiveNone"));
            s.row(l.t("nfc.eid.hash"), sec.optString("hashAlgorithm", ""));
            JSONObject signer = sec.optJSONObject("signer");
            if (signer != null) {
                s.row(l.t("nfc.eid.signer"), signer.optString("subject", ""));
                s.row(l.t("nfc.eid.signedBy"), signer.optString("issuer", ""));
                if (!signer.optString("notBefore", "").isEmpty() || !signer.optString("notAfter", "").isEmpty())
                    s.row(l.t("nfc.eid.validity"), signer.optString("notBefore", "?") + " – " + signer.optString("notAfter", "?"));
                s.row(l.t("nfc.eid.serial"), signer.optString("serial", ""));
            }
            s.row(l.t("nfc.eid.protocols"), joined(sec, "protocols").replace("; ", ", "));
            s.row(l.t("nfc.eid.aaKey"), sec.optString("activeAuthKey", ""));
            s.row(l.t("nfc.eid.lds"), d.optString("ldsVersion", ""));
            s.row(l.t("nfc.eid.unicode"), d.optString("unicodeVersion", ""));
            out.add(s);
        }
        JSONArray files = d.optJSONArray("files");
        if (files != null && files.length() > 0) {
            Section s = new Section(l.t("nfc.eid.files"));
            s.columns = new String[]{l.t("nfc.tpl.r.file"), "FID", l.t("nfc.tpl.r.status"), l.t("nfc.tpl.r.size"), l.t("nfc.eid.hash")};
            s.table = new ArrayList<>();
            for (int i = 0; i < files.length(); i++) {
                JSONObject f = files.optJSONObject(i);
                String st = f.optString("status", "error");
                String stText = l.t("read".equals(st) ? "nfc.eid.st.read" : "protected".equals(st) ? "nfc.eid.st.protected" : "absent".equals(st) ? "nfc.eid.st.absent" : "nfc.eid.st.error")
                    + (f.optString("message", "").isEmpty() ? "" : " — " + f.optString("message"));
                s.table.add(new String[]{f.optString("name"), f.optString("fid"), stText, f.has("size") ? sizeText(f.optLong("size")) : "",
                    f.has("hashOk") ? (f.optBoolean("hashOk") ? "✓" : "✗") : ""});
            }
            out.add(s);
        }
        JSONArray images = d.optJSONArray("images");
        if (images != null && images.length() > 0) {
            Section s = new Section(l.t("nfc.eid.images"));
            for (int i = 0; i < images.length(); i++) {
                JSONObject img = images.optJSONObject(i);
                String kind = img.optString("kind");
                String k = "face".equals(kind) ? "nfc.eid.img.face" : "portrait".equals(kind) ? "nfc.eid.img.portrait" : "signature".equals(kind) ? "nfc.eid.img.signature"
                    : "document".equals(kind) ? "nfc.eid.img.document" : "nfc.eid.img.other";
                s.row(l.t(k) + " · " + img.optString("group"), img.optString("name") + " · " + img.optString("mime") + " · " + sizeText(b64Size(img.optString("data"))));
            }
            out.add(s);
        }
    }

    /* ------------------------------------------------------------ any other card */

    /** ISO 7816-4 names the EMV dictionary lacks (EF.DIR, EF.ATR, FCP). */
    private static final Map<String, String> ISO_TAGS = new HashMap<>();
    static {
        String[] t = {"43", "Card service data", "46", "Pre-issuing data", "47", "Card capabilities", "51", "Path", "52", "Command to perform",
            "53", "Discretionary data", "62", "File control parameters (FCP)", "64", "File management data (FMD)", "73", "Discretionary data objects",
            "83", "File identifier", "8A", "Life cycle status", "7F66", "Extended length information", "78", "Compatible tag allocation authority",
            "4D", "Extended header list", "5F52", "Historical bytes"};
        for (int i = 0; i < t.length; i += 2) ISO_TAGS.put(t[i], t[i + 1]);
    }

    private static String tagName(String tag) {
        EmvTags.Info info = EmvTags.emvTagInfo(tag);
        if (!info.name.startsWith("Tag ")) return info.name;
        String iso = ISO_TAGS.get(tag);
        return iso != null ? iso : "";
    }

    /** Whether {@code b} is BER-TLV through and through (padding 00 / FF aside), so a decode is not a guess. */
    static boolean isTlv(byte[] b) {
        int off = 0, n = b.length, objects = 0;
        while (off < n) {
            int first = b[off] & 0xff;
            if (first == 0x00 || first == 0xff) { off++; continue; }
            int i = off + 1;
            if ((first & 0x1f) == 0x1f) {
                int guard = 0;
                do { if (i >= n || guard++ > 3) return false; } while ((b[i++] & 0x80) != 0);
            }
            if (i >= n) return false;
            int len = b[i] & 0xff;
            i++;
            if (len > 0x80) {
                int k = len & 0x7f;
                if (k > 3 || i + k > n) return false;
                len = 0;
                for (int j = 0; j < k; j++) len = (len << 8) | (b[i + j] & 0xff);
                i += k;
            } else if (len == 0x80) return false;
            if (i + len > n) return false;
            if ((first & 0x20) != 0 && len > 0 && !isTlv(Apdu.slice(b, i, i + len))) return false;
            off = i + len;
            objects++;
        }
        return objects > 0;
    }

    private static boolean printable(byte[] v) {
        if (v.length == 0) return false;
        for (byte c : v) if ((c & 0xff) < 0x20 || (c & 0xff) >= 0x7f) return false;
        return true;
    }

    /** A BER-TLV tree, one element per line, with the EMV (and ISO 7816) names and the values formatted. */
    static String tlvText(byte[] data) { return tlvText(data, Mask.OFF); }

    static String tlvText(byte[] data, Mask m) {
        List<String> lines = new ArrayList<>();
        tlvLines(Apdu.decodeTlv(data, true), 0, lines, m);
        return String.join("\n", lines);
    }

    private static void tlvLines(List<Apdu.Tlv> nodes, int depth, List<String> out, Mask m) {
        for (Apdu.Tlv n : nodes) {
            String tag = Apdu.hex(n.tagBytes);
            String name = tagName(tag);
            String head = repeat(' ', depth * 2) + tag + (name.isEmpty() ? "" : " " + name);
            if (n.constructed && n.children != null && !n.children.isEmpty()) {
                out.add(head);
                tlvLines(n.children, depth + 1, out, m);
                continue;
            }
            String hx = Apdu.hex(n.value);
            String shown;
            if (m.on && SENSITIVE.contains(tag)) shown = maskValue(tag, hx);
            else {
                EmvTags.Info info = EmvTags.emvTagInfo(tag);
                String v = info.name.startsWith("Tag ") ? hx : EmvReader.formatValue(tag, n.value, info.format);
                shown = v.equals(hx) ? m.hex(hx) + (printable(n.value) ? "  \"" + m.text(new String(n.value, java.nio.charset.StandardCharsets.US_ASCII)) + "\"" : "")
                    : m.text(v) + "  (" + m.hex(hx) + ")";
            }
            out.add(head + ": " + shown);
        }
    }

    /** Each fixed command's answer, decoded; a DESFire's GetVersion as the chip it describes. */
    private static void generic(L l, TemplateRunner.Result r, List<Section> out, Mask m) {
        Section desfire = desfire(l, r);
        if (desfire != null) out.add(desfire);
        for (TemplateRunner.StepResult x : r.steps) {
            if (!x.op.isEmpty() || x.command.isEmpty()) continue;
            Section s = new Section(x.step + ". " + x.label);
            s.row(l.t("nfc.tpl.r.command"), x.command);
            s.row(l.t("nfc.tpl.r.response"), m.hex(x.data));
            if (x.noteKey != null) s.row(l.t("nfc.tpl.r.status"), sym(x.status) + " " + l.f(x.noteKey, x.noteArgs));
            else s.row(l.t("nfc.tpl.r.status"), x.sw.isEmpty() ? StatusWords.describe("") : sym(x.status) + " " + x.sw + " — " + StatusWords.describe(x.sw));
            byte[] data = Apdu.unhex(x.data);
            if (data.length > 0) {
                if (isTlv(data)) s.pre = tlvText(data, m);
                else if (printable(data)) s.row(l.t("nfc.tpl.r.text"), m.text(new String(data, java.nio.charset.StandardCharsets.US_ASCII)));
            }
            out.add(s);
        }
    }

    /* ------------------------------------------------------------ DESFire */

    private static int bcd(int b) { return ((b >> 4) & 0x0f) * 10 + (b & 0x0f); }

    private static String bytesText(long n) { return n >= 1024 && n % 1024 == 0 ? (n / 1024) + " KB" : n + " B"; }

    /** The storage byte of GetVersion: 2^n bytes, or between 2^n and 2^(n+1) when its lowest bit is set. */
    static String storage(int b) {
        long size = 1L << ((b >> 1) & 0x3f);
        return (b & 1) == 0 ? bytesText(size) : bytesText(size) + " – " + bytesText(size * 2);
    }

    /** MIFARE DESFire generations by the hardware type and major version (NXP AN12343 / AN12752). */
    static String product(int type, int major) {
        if (type == 0x08) return "MIFARE DESFire Light";
        if (type == 0x01) {
            switch (major) {
                case 0x00: return "MIFARE DESFire (MF3ICD40)";
                case 0x01: return "MIFARE DESFire EV1";
                case 0x12: return "MIFARE DESFire EV2";
                case 0x22: return "MIFARE DESFire EV2 XL";
                case 0x33: return "MIFARE DESFire EV3";
                default: return "MIFARE DESFire";
            }
        }
        return String.format(Locale.ROOT, "type %02X", type);
    }

    private static TemplateRunner.StepResult byCommand(List<TemplateRunner.StepResult> steps, int from, String command) {
        for (int i = from; i < steps.size(); i++) if (steps.get(i).op.isEmpty() && command.equals(steps.get(i).command)) return steps.get(i);
        return null;
    }

    private static Section desfire(L l, TemplateRunner.Result r) {
        List<TemplateRunner.StepResult> st = r.steps;
        int v = -1;
        for (int i = 0; i < st.size(); i++) if (st.get(i).op.isEmpty() && "9060000000".equals(st.get(i).command)) { v = i; break; }
        if (v < 0) return null;
        byte[] hw = Apdu.unhex(st.get(v).data);
        if (hw.length < 7) return null;
        Section s = new Section(l.t("nfc.tpl.r.desfire"));
        s.row(l.t("nfc.tpl.r.vendor"), (hw[0] & 0xff) == 0x04 ? "NXP" : String.format(Locale.ROOT, "%02X", hw[0] & 0xff));
        s.row(l.t("nfc.tpl.r.product"), product(hw[1] & 0xff, hw[3] & 0xff));
        s.row(l.t("nfc.tpl.r.hw"), String.format(Locale.ROOT, "%d.%d (type %02X, subtype %02X)", hw[3] & 0xff, hw[4] & 0xff, hw[1] & 0xff, hw[2] & 0xff));
        s.row(l.t("nfc.tpl.r.storage"), storage(hw[5] & 0xff));
        s.row(l.t("nfc.tpl.r.protocol"), String.format(Locale.ROOT, "%02X%s", hw[6] & 0xff, (hw[6] & 0xff) == 0x05 ? " (ISO/IEC 14443-2 / -3)" : ""));
        TemplateRunner.StepResult swStep = byCommand(st, v + 1, "90AF000000");
        if (swStep != null) {
            byte[] sw = Apdu.unhex(swStep.data);
            if (sw.length >= 7) s.row(l.t("nfc.tpl.r.sw"), String.format(Locale.ROOT, "%d.%d", sw[3] & 0xff, sw[4] & 0xff));
            TemplateRunner.StepResult idStep = byCommand(st, st.indexOf(swStep) + 1, "90AF000000");
            byte[] id = idStep == null ? new byte[0] : Apdu.unhex(idStep.data);
            if (id.length >= 14) {
                s.row("UID", Apdu.hex(Apdu.slice(id, 0, 7)));
                s.row(l.t("nfc.tpl.r.batch"), Apdu.hex(Apdu.slice(id, 7, 12)));
                int week = bcd(id[12] & 0xff), year = bcd(id[13] & 0xff);
                if (week > 0 || year > 0) s.row(l.t("nfc.tpl.r.produced"), l.f("nfc.tpl.r.week", String.valueOf(week), String.valueOf(2000 + year)));
            }
        }
        TemplateRunner.StepResult apps = byCommand(st, 0, "906A000000");
        if (apps != null && apps.sw.startsWith("91")) {
            byte[] a = Apdu.unhex(apps.data);
            List<String> aids = new ArrayList<>();
            for (int i = 0; i + 3 <= a.length; i += 3) aids.add(String.format(Locale.ROOT, "%02X%02X%02X", a[i + 2] & 0xff, a[i + 1] & 0xff, a[i] & 0xff));
            s.row(l.t("nfc.tpl.r.apps"), aids.isEmpty() ? l.t("nfc.tpl.r.none") : String.join(", ", aids) + ("91AF".equals(apps.sw) ? ", …" : ""));
        }
        TemplateRunner.StepResult free = byCommand(st, 0, "906E000000");
        if (free != null && "9100".equals(free.sw)) {
            byte[] f = Apdu.unhex(free.data);
            if (f.length >= 3) s.row(l.t("nfc.tpl.r.free"), ((f[0] & 0xff) | (f[1] & 0xff) << 8 | (f[2] & 0xff) << 16) + " B");
        }
        TemplateRunner.StepResult keys = byCommand(st, 0, "9045000000");
        if (keys != null && "9100".equals(keys.sw)) {
            byte[] k = Apdu.unhex(keys.data);
            if (k.length >= 2) {
                int set = k[0] & 0xff, max = k[1] & 0xff;
                String crypto = (max & 0xc0) == 0x80 ? "AES" : (max & 0xc0) == 0x40 ? "3K3DES" : "DES / 2K3DES";
                List<String> flags = new ArrayList<>();
                if ((set & 0x01) != 0) flags.add(l.t("nfc.tpl.r.ks.change"));
                if ((set & 0x02) != 0) flags.add(l.t("nfc.tpl.r.ks.list"));
                if ((set & 0x04) != 0) flags.add(l.t("nfc.tpl.r.ks.create"));
                flags.add(l.t((set & 0x08) != 0 ? "nfc.tpl.r.ks.config" : "nfc.tpl.r.ks.frozen"));
                s.row(l.t("nfc.tpl.r.keys"), String.format(Locale.ROOT, "%02X · ", set) + l.f("nfc.tpl.r.keyCount", String.valueOf(max & 0x0f), crypto) + "\n" + String.join(", ", flags));
            }
        }
        return s;
    }
}
