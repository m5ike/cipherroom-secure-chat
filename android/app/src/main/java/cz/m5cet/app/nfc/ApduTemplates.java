package cz.m5cet.app.nfc;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * APDU application templates (6.10) — the Java side of
 * client/src/lib/nfc/apdu-templates.ts: what an operator loads into
 * m5mobile.define.apduTemplates. A template is the COMPLETE read of one card
 * type: a list of steps the {@link TemplateRunner} executes one after another —
 * a fixed command ({@code { apdu, label?, optional?, expect? }}) or a reader
 * operation ({@code { op: select-ppse | select-pse | select-aid | get-data |
 * read-log | gpo | read-afl | read-files | for-each-aid | eid-read | emv-read }}).
 * An older entry (≤ 6.9: one command, several command lines, or one whole-read
 * op) still runs, as a one-step template ({@link #templateSteps}).
 *
 * Pure (no android.*): {@link #templateSteps} and {@link #templateProblems}
 * mirror the contract's functions of the same names, so a template is
 * runnable — or refused for the same reasons — on both platforms. 6.10
 * security review (G-18): a template only READS — every fixed command must be
 * one of {@link #readCommand} (a write, VERIFY, GENERATE AC, UPDATE, PUT DATA
 * is a problem, so the template is listed but refused), and the runner checks
 * every command again before it goes.
 */
public final class ApduTemplates {
    private ApduTemplates() {}

    /** The card types a template reads (they group the menu and pick the readable report). */
    public static final String EMV = "emv", EMRTD = "emrtd", DESFIRE = "desfire", ISO7816 = "iso7816";
    public static final List<String> CARDS = Collections.unmodifiableList(java.util.Arrays.asList(EMV, EMRTD, DESFIRE, ISO7816));

    /** The reader operations a step may be (the contract's TemplateStep ops). */
    public static final List<String> OPS = Collections.unmodifiableList(java.util.Arrays.asList(
        "select-ppse", "select-pse", "select-aid", "get-data", "read-log", "gpo", "read-afl", "read-files", "for-each-aid", "eid-read", "emv-read"));

    private static final Pattern COMMAND = Pattern.compile("^[0-9A-Fa-f]{8,522}$");
    private static final Pattern AID = Pattern.compile("^[0-9A-Fa-f]{10,32}$");
    private static final Pattern TAG = Pattern.compile("^[0-9A-Fa-f]{4}$");

    /** One step of a template, parsed. */
    public static final class Step {
        /** The reader operation, or "" for a fixed command. */
        public final String op;
        /** The fixed command (hex, upper case, no spaces), or null for an op. */
        public final String apdu;
        public final String label;
        public final boolean optional;
        /** Status words that count as success (upper case, "x" a wildcard nibble); empty = 9000. */
        public final List<String> expect;
        /** select-aid: the application (null: the current one of a for-each-aid). */
        public final String aid;
        /** get-data: the tags. */
        public final List<String> tags;
        /** read-files: the short files and the records ({from, to}), null for the defaults. */
        public final int[] sfi, records;
        /** for-each-aid: the steps run for every application, its own AIDs and the cap. */
        public final List<Step> steps;
        public final List<String> aids;
        public final int max;
        /** eid-read / emv-read: the op's args (never null). */
        public final JSONObject args;
        /** 6.10: a fixed command's follow-up while the card answers "more frames" (DESFire 91AF), hex; null for none. */
        public String more;

        Step(String op, String apdu, String label, boolean optional, List<String> expect, String aid, List<String> tags,
             int[] sfi, int[] records, List<Step> steps, List<String> aids, int max, JSONObject args) {
            this.op = op; this.apdu = apdu; this.label = label; this.optional = optional; this.expect = expect; this.aid = aid; this.tags = tags;
            this.sfi = sfi; this.records = records; this.steps = steps; this.aids = aids; this.max = max; this.args = args;
        }

        public boolean fixed() { return op.isEmpty(); }

        /** A fixed command from code (tests, the legacy lines). */
        public static Step command(String hex, String label, boolean optional, String... expect) {
            List<String> e = new ArrayList<>();
            for (String x : expect) e.add(x.toUpperCase(Locale.ROOT));
            return new Step("", clean(hex), label, optional, e, null, Collections.<String>emptyList(), null, null, Collections.<Step>emptyList(), Collections.<String>emptyList(), 0, new JSONObject());
        }
    }

    /** One template of m5mobile.define.apduTemplates, parsed (with its problems — a template with any does not run). */
    public static final class Template {
        /** Its position in the define list. */
        public final int index;
        public final String label;
        /** emv / emrtd / desfire / iso7816, or "" when the template says none. */
        public final String card;
        public final String note;
        public final String aid;
        public final List<Step> steps;
        public final List<String> problems;
        /** An older (≤ 6.9) entry: "apdu" (command lines) or "op" (one whole read); null for a 6.10 template. */
        public final String legacy;

        Template(int index, String label, String card, String note, String aid, List<Step> steps, List<String> problems, String legacy) {
            this.index = index; this.label = label; this.card = card; this.note = note; this.aid = aid; this.steps = steps; this.problems = problems; this.legacy = legacy;
        }

        public boolean runnable() { return problems.isEmpty() && !steps.isEmpty(); }

        /** The first eid-read step (it needs the holder's document key, asked on the device), or null. */
        public Step eidRead() { return find(steps, "eid-read", 0); }

        /** The card type it reads: its own, else what its steps say. */
        public String cardType() {
            if (!card.isEmpty()) return card;
            if (find(steps, "eid-read", 0) != null) return EMRTD;
            for (String o : new String[]{"emv-read", "select-ppse", "select-pse", "select-aid", "gpo", "for-each-aid"}) if (find(steps, o, 0) != null) return EMV;
            return "";
        }

        private static Step find(List<Step> list, String op, int depth) {
            if (depth > 3) return null;
            for (Step s : list) {
                if (op.equals(s.op)) return s;
                Step in = find(s.steps, op, depth + 1);
                if (in != null) return in;
            }
            return null;
        }
    }

    /* ------------------------------------------------------------ read-only (G-18) */

    /** An interindustry class (ISO 7816-4: logical channels, secure messaging, chaining). */
    static boolean isoClass(int cla) { return (cla & 0xe0) == 0x00 || (cla & 0xc0) == 0x40; }

    /** EMV's proprietary class (80 GET PROCESSING OPTIONS, 80 GET DATA). */
    static boolean emvClass(int cla) { return (cla & 0xf0) == 0x80; }

    /** DESFire's native commands wrapped in ISO 7816 that only read: GetVersion (and its frames), GetApplicationIDs, GetFreeMemory, GetKeySettings. */
    private static final int[] DESFIRE_READS = {0x60, 0xaf, 0x6a, 0x6e, 0x45};

    /**
     * Whether a command only reads (G-18): SELECT (A4), READ BINARY (B0), READ
     * RECORD (B2), GET DATA (CA, also 80 CA), GET PROCESSING OPTIONS (80 A8),
     * GET RESPONSE (C0) and DESFire's 90 60 / AF / 6A / 6E / 45. Never a VERIFY,
     * GENERATE AC, UPDATE, PUT DATA, a write or a key change.
     */
    public static boolean readCommand(int cla, int ins) {
        if (isoClass(cla)) return ins == 0xa4 || ins == 0xb0 || ins == 0xb2 || ins == 0xca || ins == 0xc0;
        if (emvClass(cla)) return ins == 0xa8 || ins == 0xca || ins == 0xc0;
        if (cla == 0x90) { for (int d : DESFIRE_READS) if (d == ins) return true; }
        return false;
    }

    /** The e-ID reader's own secure-channel commands — allowed only inside eid-read: GET CHALLENGE, EXTERNAL / MUTUAL AUTHENTICATE, MSE, GENERAL AUTHENTICATE, READ BINARY (odd INS). */
    public static boolean secureChannelCommand(int cla, int ins) {
        return isoClass(cla) && (ins == 0x84 || ins == 0x82 || ins == 0x22 || ins == 0x86 || ins == 0xb1);
    }

    private static final Map<Integer, String> INS_NAMES = new HashMap<>();
    private static final Map<Integer, String> DESFIRE_NAMES = new HashMap<>();
    static {
        Object[] n = {0x20, "VERIFY", 0x21, "VERIFY", 0x24, "CHANGE REFERENCE DATA", 0x2c, "RESET RETRY COUNTER", 0xae, "GENERATE AC",
            0xd6, "UPDATE BINARY", 0xd7, "UPDATE BINARY", 0xdc, "UPDATE RECORD", 0xdd, "UPDATE RECORD", 0xe2, "APPEND RECORD",
            0xda, "PUT DATA", 0xdb, "PUT DATA", 0xd0, "WRITE BINARY", 0xd1, "WRITE BINARY", 0xd2, "WRITE RECORD", 0xe0, "CREATE FILE",
            0xe4, "DELETE FILE", 0x0e, "ERASE BINARY", 0x0f, "ERASE BINARY", 0x44, "ACTIVATE FILE", 0x04, "DEACTIVATE FILE",
            0xe6, "TERMINATE DF", 0xe8, "TERMINATE CARD", 0x88, "INTERNAL AUTHENTICATE", 0x84, "GET CHALLENGE", 0x82, "EXTERNAL AUTHENTICATE",
            0x86, "GENERAL AUTHENTICATE", 0x22, "MANAGE SECURITY ENVIRONMENT", 0x2a, "PERFORM SECURITY OPERATION", 0x1e, "APPLICATION BLOCK",
            0x18, "APPLICATION UNBLOCK", 0x16, "CARD BLOCK", 0xb1, "READ BINARY (odd)"};
        for (int i = 0; i < n.length; i += 2) INS_NAMES.put((Integer) n[i], (String) n[i + 1]);
        Object[] d = {0xfc, "FormatPICC", 0xda, "DeleteApplication", 0xca, "CreateApplication", 0x3d, "WriteData", 0x3b, "WriteRecord",
            0xc4, "ChangeKey", 0x54, "ChangeKeySettings", 0x0a, "Authenticate", 0x1a, "AuthenticateISO", 0xaa, "AuthenticateAES",
            0xdf, "DeleteFile", 0x5f, "ChangeFileSettings", 0x0c, "Credit", 0xdc, "Debit", 0xc7, "CommitTransaction", 0x5c, "SetConfiguration"};
        for (int i = 0; i < d.length; i += 2) DESFIRE_NAMES.put((Integer) d[i], (String) d[i + 1]);
    }

    /**
     * Why a template's fixed command may not run (G-18), or null when it only
     * reads: "not a read command: 00 20 (VERIFY)".
     */
    public static String commandProblem(String hex) {
        String h = clean(hex);
        if (h.length() < 4 || !h.matches("[0-9A-F]+")) return "not a read command: " + h;
        int cla = Integer.parseInt(h.substring(0, 2), 16), ins = Integer.parseInt(h.substring(2, 4), 16);
        if (readCommand(cla, ins)) return null;
        String name = cla == 0x90 ? DESFIRE_NAMES.get(ins) : INS_NAMES.get(ins);
        return "not a read command: " + h.substring(0, 2) + " " + h.substring(2, 4) + (name == null ? "" : " (" + name + ")");
    }

    /* ------------------------------------------------------------ the contract */

    private static String clean(String hex) { return hex == null ? "" : hex.replaceAll("\\s", "").toUpperCase(Locale.ROOT); }

    /** String(v) as JavaScript says it (the contract's checks run on the text). */
    private static String jsString(Object v) {
        if (v == null || v == JSONObject.NULL) return v == null ? "undefined" : "null";
        if (v instanceof Double || v instanceof Float) {
            double d = ((Number) v).doubleValue();
            if (d == Math.rint(d) && !Double.isInfinite(d) && Math.abs(d) < 1e21) return String.valueOf((long) d);
        }
        return String.valueOf(v);
    }

    /** JavaScript truthiness of a JSON value. */
    private static boolean truthy(Object v) {
        if (v == null || v == JSONObject.NULL || Boolean.FALSE.equals(v)) return false;
        if (v instanceof String) return !((String) v).isEmpty();
        if (v instanceof Number) { double d = ((Number) v).doubleValue(); return d != 0 && !Double.isNaN(d); }
        return true;
    }

    /**
     * The steps a saved template runs (apdu-templates.ts templateSteps): its own,
     * or — an older entry — its one op, or its command lines turned into steps.
     * Empty when it has nothing runnable. Raw JSON, as the contract has them.
     */
    public static JSONArray templateSteps(JSONObject x) {
        JSONArray steps = x == null ? null : x.optJSONArray("steps");
        if (steps != null && steps.length() > 0) return steps;
        JSONArray out = new JSONArray();
        if (x == null) return out;
        try {
            String op = x.opt("op") instanceof String ? x.optString("op") : "";
            JSONObject args = x.optJSONObject("args");
            if (op.equals("emv-read")) {
                JSONObject a = args == null ? new JSONObject() : new JSONObject(args.toString());
                Object aid = x.opt("aid");
                if (truthy(aid)) a.put("aid", aid);
                return out.put(new JSONObject().put("op", "emv-read").put("args", a));
            }
            if (op.equals("eid-read")) return out.put(new JSONObject().put("op", "eid-read").put("args", args == null ? new JSONObject() : args));
            Object raw = x.has("apdu") && x.opt("apdu") != JSONObject.NULL ? x.opt("apdu") : x.has("apduHex") && x.opt("apduHex") != JSONObject.NULL ? x.opt("apduHex") : "";
            for (String line : jsString(raw).split("\\r?\\n", -1)) {
                String h = line.replaceAll("[^0-9A-Fa-f]", "");
                if (h.length() >= 8 && h.length() % 2 == 0) out.put(new JSONObject().put("apdu", h.toUpperCase(Locale.ROOT)));
            }
        } catch (JSONException e) { throw new IllegalStateException(e); }
        return out;
    }

    /** Problems of one template (apdu-templates.ts templateProblems) — the runners say them before running. */
    public static List<String> templateProblems(Object t) {
        List<String> out = new ArrayList<>();
        if (t instanceof JSONArray) {
            // A JS array is an object too: no label, nothing to run.
            out.add("no label");
            out.add("nothing to run: no steps, op or apdu");
            return out;
        }
        if (!(t instanceof JSONObject)) { out.add("not an object"); return out; }
        JSONObject x = (JSONObject) t;
        Object label = x.opt("label");
        if (!(label instanceof String) || ((String) label).trim().isEmpty()) out.add("no label");
        JSONArray steps = templateSteps(x);
        if (steps.length() == 0) out.add("nothing to run: no steps, op or apdu");
        walk(steps, 0, out);
        return out;
    }

    private static void walk(JSONArray list, int depth, List<String> out) {
        if (depth > 2) { out.add("for-each-aid nested too deep"); return; }
        for (int i = 0; i < list.length(); i++) {
            Object o = list.opt(i);
            if (!(o instanceof JSONObject)) continue;
            JSONObject s = (JSONObject) o;
            if (s.has("apdu")) {
                String text = jsString(s.opt("apdu"));
                String h = text.replaceAll("\\s", "");
                if (!COMMAND.matcher(h).matches() || h.length() % 2 != 0) out.add("bad command " + (text.length() > 20 ? text.substring(0, 20) : text));
                else {
                    // G-18: a template only reads.
                    String why = commandProblem(h);
                    if (why != null) out.add(why);
                }
                if (s.has("more") && s.opt("more") != JSONObject.NULL) {
                    String m = jsString(s.opt("more")), mh = m.replaceAll("\\s", "");
                    if (!COMMAND.matcher(mh).matches() || mh.length() % 2 != 0) out.add("bad follow-up command " + (m.length() > 20 ? m.substring(0, 20) : m));
                    else { String why2 = commandProblem(mh); if (why2 != null) out.add(why2); }
                }
                continue;
            }
            String op = s.opt("op") instanceof String ? s.optString("op") : "";
            if (op.equals("select-aid") && s.has("aid") && !AID.matcher(jsString(s.opt("aid"))).matches()) out.add("bad AID " + jsString(s.opt("aid")));
            if (op.equals("get-data")) {
                JSONArray tags = s.optJSONArray("tags");
                boolean good = tags != null;
                if (tags != null) for (int j = 0; j < tags.length(); j++) if (!TAG.matcher(jsString(tags.opt(j))).matches()) good = false;
                if (!good) out.add("get-data needs 2-byte tags");
            }
            if (op.equals("for-each-aid")) walk(s.optJSONArray("steps") != null ? s.optJSONArray("steps") : new JSONArray(), depth + 1, out);
        }
    }

    /* ------------------------------------------------------------ parsing */

    /** Every entry of m5mobile.define.apduTemplates, parsed (a problem keeps it in the list, not runnable). */
    public static List<Template> parse(JSONArray define) {
        List<Template> out = new ArrayList<>();
        if (define == null) return out;
        for (int i = 0; i < define.length(); i++) out.add(parse(define.opt(i), i));
        return out;
    }

    /** One entry. */
    public static Template parse(Object entry, int index) {
        List<String> problems = templateProblems(entry);
        if (!(entry instanceof JSONObject)) {
            String text = entry instanceof String ? (String) entry : "";
            return new Template(index, text.isEmpty() ? "APDU " + (index + 1) : text, "", "", "", Collections.<Step>emptyList(), problems, "apdu");
        }
        JSONObject x = (JSONObject) entry;
        JSONArray own = x.optJSONArray("steps");
        String legacy = own != null && own.length() > 0 ? null : ("emv-read".equals(x.optString("op")) || "eid-read".equals(x.optString("op")) ? "op" : "apdu");
        String label = x.opt("label") instanceof String ? x.optString("label").trim() : "";
        if (label.isEmpty() && x.opt("name") instanceof String) label = x.optString("name").trim();
        if (label.isEmpty()) label = "APDU " + (index + 1);
        String card = x.opt("card") instanceof String && CARDS.contains(x.optString("card")) ? x.optString("card") : "";
        String note = x.opt("note") instanceof String ? x.optString("note") : "";
        String aid = x.opt("aid") instanceof String ? x.optString("aid") : "";
        return new Template(index, label, card, note, aid, steps(templateSteps(x), 0), problems, legacy);
    }

    private static List<String> strings(JSONArray a, boolean upper) {
        List<String> out = new ArrayList<>();
        if (a == null) return out;
        for (int i = 0; i < a.length(); i++) if (a.opt(i) instanceof String) out.add(upper ? a.optString(i).toUpperCase(Locale.ROOT) : a.optString(i));
        return out;
    }

    private static int[] range(JSONArray a) {
        if (a == null || a.length() < 2 || !(a.opt(0) instanceof Number) || !(a.opt(1) instanceof Number)) return null;
        int lo = a.optInt(0), hi = a.optInt(1);
        return new int[]{Math.min(lo, hi), Math.max(lo, hi)};
    }

    private static List<Step> steps(JSONArray list, int depth) {
        List<Step> out = new ArrayList<>();
        if (list == null || depth > 3) return out;
        for (int i = 0; i < list.length(); i++) {
            JSONObject s = list.optJSONObject(i);
            if (s == null) continue;
            String label = s.opt("label") instanceof String && !s.optString("label").trim().isEmpty() ? s.optString("label").trim() : null;
            boolean optional = Boolean.TRUE.equals(s.opt("optional"));
            if (s.has("apdu")) {
                Step c = new Step("", clean(jsString(s.opt("apdu"))), label, optional, strings(s.optJSONArray("expect"), true), null, Collections.<String>emptyList(),
                    null, null, Collections.<Step>emptyList(), Collections.<String>emptyList(), 0, new JSONObject());
                if (s.has("more") && s.opt("more") != JSONObject.NULL) c.more = clean(jsString(s.opt("more")));
                out.add(c);
                continue;
            }
            String op = s.opt("op") instanceof String ? s.optString("op") : "?";
            String aid = s.opt("aid") instanceof String ? s.optString("aid").toUpperCase(Locale.ROOT) : null;
            JSONObject args = s.optJSONObject("args");
            int max = s.opt("max") instanceof Number ? s.optInt("max") : 0;
            out.add(new Step(op, null, label, optional, Collections.<String>emptyList(), aid, strings(s.optJSONArray("tags"), true),
                range(s.optJSONArray("sfi")), range(s.optJSONArray("records")), steps(s.optJSONArray("steps"), depth + 1),
                strings(s.optJSONArray("aids"), true), max, args == null ? new JSONObject() : args));
        }
        return out;
    }
}
