package cz.m5cet.app.nfc;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Runs an APDU application template (6.10) — the Android side of the contract
 * in client/src/lib/nfc/apdu-templates.ts (the web runs the same in
 * template-runner.ts). Every step of the template, one after another, over the
 * connected card ({@link Apdu.Transceiver}: an open ISO-DEP, a USB reader):
 *
 *  - a fixed command is sent as written; 61xx is followed by GET RESPONSE and
 *    6Cxx re-sent with the Le the card asked for; the answer counts as success
 *    when its status word is one the step {@code expect}s (9000 by default),
 *    else the step is a warning when {@code optional}, an error otherwise;
 *  - a reader operation runs the EMV reader's own steps ({@link EmvReader}:
 *    the directories, SELECT with the PDOL, GET DATA, the transaction log, GPO,
 *    the AFL's records, the deep file scan, every application of a
 *    for-each-aid) or the e-ID read ({@link MrtdReader}, opened with the
 *    holder's key asked on the device).
 *
 * Every APDU that goes to the card is recorded — the transceiver is wrapped,
 * so the e-ID read's secure-messaging commands are in the transcript too — as
 * a {@link Exchange} (the contract's TemplateExchange); the results are
 * gathered into the same {@code emv} / {@code mrtd} objects the 6.6 card
 * report uses ({@link Result#emv}, {@link Result#mrtd}). {@link TemplateViews}
 * turns a {@link Result} into the io / raw / json / readable views.
 *
 * Runs on the caller's thread (never the UI's: the reader's thread, or a
 * background one); {@link #cancel} stops it before the next command. It never
 * throws: a card that leaves the field ends the run with what was read so far.
 * Read-only (6.10 security review, G-18): every command is checked before it
 * goes — a fixed command must be a read ({@link ApduTemplates#readCommand}:
 * SELECT, READ BINARY / RECORD, GET DATA, GET PROCESSING OPTIONS, GET RESPONSE,
 * DESFire's GetVersion / GetApplicationIDs / GetFreeMemory / GetKeySettings),
 * the readers' own commands too, the document's secure-channel commands only
 * inside eid-read. Anything else (VERIFY, GENERATE AC, UPDATE, PUT DATA, a
 * write) never reaches the card: the step is an error that says why.
 */
public final class TemplateRunner {

    /** One recorded exchange of a run (apdu-templates.ts TemplateExchange). */
    public static final class Exchange {
        /** The step that sent it (1-based, in the order the steps ran). */
        public final int step;
        public final String label;
        /** The reader operation that sent it, "" for a fixed command. */
        public final String op;
        public final String command;
        /** The response data (hex, without the status word). */
        public final String response;
        /** The status word ("9000"), "" when the card gave no answer. */
        public final String sw;
        /** ok (expected), warn (an optional step / a tolerated status), error. */
        public String status;
        public final long ms;

        public Exchange(int step, String label, String op, String command, String response, String sw, String status, long ms) {
            this.step = step; this.label = label; this.op = op; this.command = command; this.response = response; this.sw = sw; this.status = status; this.ms = ms;
        }
    }

    /** What one step did (the readable view's list of steps). */
    public static final class StepResult {
        public final int step;
        public final String label;
        public final String op;
        /** The application it ran for (a for-each-aid's), or null. */
        public final String aid;
        public final boolean optional;
        /** ok, warn, error. */
        public String status = "ok";
        /** A note the view localizes ({@link TemplateViews} keys, {0}… the args), or null. */
        public String noteKey;
        public String[] noteArgs = new String[0];
        /** A note as it is (a reader's own summary), or null. */
        public String note;
        /** Its exchanges: [first, last) of {@link Result#exchanges}. */
        public int first, last;
        /** A fixed command: the command, the whole answer (after GET RESPONSE) and its status word. */
        public String command = "", data = "", sw = "";

        StepResult(int step, String label, String op, String aid, boolean optional) {
            this.step = step; this.label = label; this.op = op; this.aid = aid; this.optional = optional;
        }

        void note(String key, Object... args) {
            noteKey = key;
            noteArgs = new String[args.length];
            for (int i = 0; i < args.length; i++) noteArgs[i] = String.valueOf(args[i]);
        }
    }

    /** A whole run. */
    public static final class Result {
        public final String label;
        /** emv / emrtd / desfire / iso7816 / "". */
        public final String card;
        public final String note;
        public final List<Exchange> exchanges = new ArrayList<>();
        public final List<StepResult> steps = new ArrayList<>();
        /** The EMV read (command.ts EmvData), or null when no EMV step ran. */
        public JSONObject emv;
        /** The e-ID read (command.ts MrtdData), or null. */
        public JSONObject mrtd;
        /** The detected card (uid, label, sak, atqa, ats…) — the caller's. */
        public JSONObject cardInfo;
        public boolean cancelled;
        /** Why the run stopped before its end (the card stopped answering), or null. */
        public String error;
        public long ms;

        Result(String label, String card, String note) { this.label = label; this.card = card; this.note = note; }

        /** ok / warn / error over the steps (a cancelled or broken run is an error). */
        public String status() {
            if (cancelled || error != null) return "error";
            String s = "ok";
            for (StepResult r : steps) { if ("error".equals(r.status)) return "error"; if ("warn".equals(r.status)) s = "warn"; }
            return s;
        }
    }

    /** Progress, on the runner's thread. */
    public interface Listener {
        /** A step starts: the template's step {@code n} of {@code total} (a for-each-aid's steps say their application in the label). */
        void onStep(int n, int total, String label);
        /** A command went and its answer came back. */
        void onExchange(Exchange e);
    }

    /** The commands stopped: cancelled, or the card no longer answers. */
    static final class Halt extends IOException { Halt(String m) { super(m); } }

    private final ApduTemplates.Template template;
    private MrtdReader.Options mrtdOptions;
    private Listener listener;
    private final AtomicBoolean cancel = new AtomicBoolean();

    // One run's state.
    private Recorder rec;
    private EmvReader.Sender sender;
    private Result result;
    private StepResult current;
    private int stepNo, topIndex, topTotal;
    private final List<String> dirAids = new ArrayList<>();
    private boolean dirRead, deep, emvRan;
    private String tree = "";
    private EmvReader.AppRead app;
    private boolean appSelected;
    private JSONArray apps = new JSONArray();
    private final List<String> readAids = new ArrayList<>();
    private final int[] budget = {480};

    public TemplateRunner(ApduTemplates.Template template) { this.template = template; }

    /** The holder's key for an eid-read step (the device's dialog); without one the e-ID read says what it needs. */
    public TemplateRunner mrtd(MrtdReader.Options o) { this.mrtdOptions = o; return this; }

    public TemplateRunner listener(Listener l) { this.listener = l; return this; }

    /** Stops the run before its next command (from any thread). */
    public void cancel() { cancel.set(true); }

    public boolean cancelled() { return cancel.get(); }

    /* ------------------------------------------------------------ recording */

    /** The card behind a recorder: every APDU becomes an {@link Exchange} of the current step. */
    private final class Recorder implements Apdu.Transceiver {
        final Apdu.Transceiver inner;
        IOException failure;
        /** Why the current step's last command was refused (never sent), or null. */
        String refused;

        Recorder(Apdu.Transceiver inner) { this.inner = inner; }

        @Override public byte[] transmit(byte[] apdu) throws IOException {
            if (cancel.get()) throw new Halt("cancelled");
            if (failure != null) throw new Halt("the card stopped answering");
            // G-18: only reads reach the card — whatever step sends it.
            String why = refusal(apdu, current == null ? "" : current.op);
            if (why != null) { refused = why; throw new IOException(why); }
            long t0 = System.nanoTime();
            byte[] resp;
            try {
                resp = inner.transmit(apdu);
            } catch (IOException e) {
                failure = e;
                add(apdu, null, t0);
                throw e;
            } catch (RuntimeException e) {
                failure = new IOException(e.getMessage() == null ? e.toString() : e.getMessage(), e);
                add(apdu, null, t0);
                throw failure;
            }
            add(apdu, resp, t0);
            return resp;
        }

        private void add(byte[] apdu, byte[] resp, long t0) {
            long ms = Math.max(0, Math.round((System.nanoTime() - t0) / 1e6));
            String data, sw;
            if (resp == null) { data = ""; sw = ""; }
            else if (resp.length < 2) { data = Apdu.hex(resp); sw = ""; }
            else { data = Apdu.hex(Apdu.slice(resp, 0, resp.length - 2)); sw = StatusWords.hex(((resp[resp.length - 2] & 0xff) << 8) | (resp[resp.length - 1] & 0xff)); }
            StepResult r = current;
            String status = resp == null ? "error" : tolerated(sw) ? "ok" : "warn";
            Exchange e = new Exchange(r == null ? 0 : r.step, r == null ? "" : r.label, r == null ? "" : r.op, Apdu.hex(apdu), data, sw, status, ms);
            result.exchanges.add(e);
            if (listener != null) try { listener.onExchange(e); } catch (RuntimeException ignored) { }
        }
    }

    /**
     * Why a command may not go to the card in a step of {@code op} (G-18), or
     * null: a read ({@link ApduTemplates#readCommand}); inside eid-read also the
     * document's own secure channel (GET CHALLENGE, EXTERNAL / GENERAL
     * AUTHENTICATE, MSE, READ BINARY with the odd INS).
     */
    static String refusal(byte[] apdu, String op) {
        if (apdu == null || apdu.length < 4) return "not a command";
        int cla = apdu[0] & 0xff, ins = apdu[1] & 0xff;
        if (ApduTemplates.readCommand(cla, ins)) return null;
        if ("eid-read".equals(op) && ApduTemplates.secureChannelCommand(cla, ins)) return null;
        String why = ApduTemplates.commandProblem(Apdu.hex(apdu));
        return why != null ? why : "not a read command";
    }

    /** A status a reader operation goes on from: success, more data (61xx), a Le to fix (6Cxx), the end of a file (6282). */
    static boolean tolerated(String sw) {
        int v = StatusWords.parse(sw);
        if (v < 0) return false;
        return Apdu.isOk(v) || (v >> 8) == 0x6c || v == 0x6282;
    }

    /** Whether a status word is one the step expects ("x" a wildcard nibble); none given: 9000. */
    static boolean expected(List<String> expect, int sw) {
        String h = StatusWords.hex(sw);
        if (expect == null || expect.isEmpty()) return sw == 0x9000;
        for (String e : expect) {
            String p = e.replaceAll("\\s", "").toUpperCase(Locale.ROOT);
            if (p.length() != 4) continue;
            boolean match = true;
            for (int i = 0; i < 4 && match; i++) if (p.charAt(i) != 'X' && p.charAt(i) != h.charAt(i)) match = false;
            if (match) return true;
        }
        return false;
    }

    private boolean halted() { return cancel.get() || (rec != null && rec.failure != null); }

    /* ------------------------------------------------------------ the run */

    /** Runs every step over {@code t}; never throws. */
    public Result run(Apdu.Transceiver t) {
        long t0 = System.nanoTime();
        result = new Result(template.label, template.cardType(), template.note);
        rec = new Recorder(t);
        sender = new EmvReader.Sender(rec);
        topTotal = template.steps.size();
        try {
            runBlock(template.steps, 0, null);
            finishApp();
            if (emvRan) result.emv = EmvReader.emvData(dirRead && !dirAids.isEmpty() ? dirAids : readAids, apps, tree, deep, countEmv());
        } catch (JSONException | RuntimeException e) {
            if (result.error == null) result.error = e.getMessage() == null ? e.toString() : e.getMessage();
        }
        result.cancelled = cancel.get();
        if (rec.failure != null && !(rec.failure instanceof Halt) && result.error == null)
            result.error = rec.failure.getMessage() == null ? rec.failure.getClass().getSimpleName() : rec.failure.getMessage();
        result.ms = Math.round((System.nanoTime() - t0) / 1e6);
        return result;
    }

    private int countEmv() {
        int n = 0;
        for (Exchange e : result.exchanges) if (!e.op.isEmpty() && !e.op.equals("eid-read")) n++;
        return n;
    }

    /** Runs a list of steps; false when its select-aid did not select (the rest of that application's steps are skipped). */
    private boolean runBlock(List<ApduTemplates.Step> steps, int depth, String aid) throws JSONException {
        for (int i = 0; i < steps.size(); i++) {
            if (halted()) return true;
            ApduTemplates.Step s = steps.get(i);
            if (depth == 0) topIndex = i + 1;
            StepResult r = runStep(s, depth, aid);
            if ("select-aid".equals(s.op) && !"ok".equals(r.status)) return false;
        }
        return true;
    }

    private static String rangeText(int[] r, int lo, int hi) { int a = r == null ? lo : r[0], b = r == null ? hi : r[1]; return a == b ? String.valueOf(a) : a + "–" + b; }

    /** The label a step shows: its own, else what its op does; a for-each-aid's steps name their application. */
    static String labelOf(ApduTemplates.Step s, String aid) {
        String l = s.label;
        if (l == null) {
            switch (s.op) {
                case "": l = s.apdu; break;
                case "select-ppse": l = "SELECT PPSE (2PAY.SYS.DDF01)"; break;
                case "select-pse": l = "SELECT PSE (1PAY.SYS.DDF01)"; break;
                case "select-aid": l = "SELECT " + (s.aid != null ? s.aid : aid != null ? aid : "AID"); break;
                case "get-data": l = "GET DATA " + String.join(" ", s.tags); break;
                case "read-log": l = "Transaction history"; break;
                case "gpo": l = "GET PROCESSING OPTIONS"; break;
                case "read-afl": l = "READ RECORD (AFL)"; break;
                case "read-files": l = "READ RECORD SFI " + rangeText(s.sfi, 1, 30) + ", records " + rangeText(s.records, 1, 16); break;
                case "for-each-aid": l = "Each application"; break;
                case "eid-read": l = "e-ID / e-passport read"; break;
                case "emv-read": l = "EMV read"; break;
                default: l = s.op; break;
            }
        }
        if (aid != null && !l.contains(aid)) l = aid + " · " + l;
        return l;
    }

    private StepResult runStep(ApduTemplates.Step s, int depth, String aid) throws JSONException {
        StepResult r = new StepResult(++stepNo, labelOf(s, aid), s.op, aid, s.optional);
        result.steps.add(r);
        current = r;
        r.first = result.exchanges.size();
        boolean brokenBefore = rec.failure != null, cancelledBefore = cancel.get();
        if (listener != null) try { listener.onStep(topIndex, topTotal, r.label); } catch (RuntimeException ignored) { }
        try {
            switch (s.op) {
                case "": fixed(s, r); break;
                case "select-ppse": case "select-pse": directory(s, r); break;
                case "select-aid": selectAid(s, r, aid); break;
                case "get-data": {
                    emvRan = true;
                    int n = app(aid).getData(sender, s.tags.toArray(new String[0]));
                    r.note("nfc.tpl.n.getData", n, s.tags.size());
                    if (n == 0) r.status = "warn";
                    break;
                }
                case "read-log": {
                    emvRan = true;
                    int n = app(aid).history(sender, true);
                    if (n < 0) { r.status = "warn"; r.note("nfc.tpl.n.noLog"); }
                    else r.note("nfc.tpl.n.log", n);
                    break;
                }
                case "gpo": {
                    emvRan = true;
                    EmvReader.AppRead a = app(aid);
                    if (a.gpo(sender)) r.note("nfc.tpl.n.gpo", a.x.aip == null ? "—" : Apdu.hex(a.x.aip), a.x.afl == null ? "—" : Apdu.hex(a.x.afl));
                    else { r.status = s.optional ? "warn" : "error"; r.note("nfc.tpl.n.gpoRefused"); }
                    break;
                }
                case "read-afl": {
                    emvRan = true;
                    EmvReader.AppRead a = app(aid);
                    if (!a.hasAfl()) { r.status = "warn"; r.note("nfc.tpl.n.noAfl"); }
                    else r.note("nfc.tpl.n.records", a.readAfl(sender, false));
                    break;
                }
                case "read-files": {
                    emvRan = true;
                    deep = true;
                    int[] sfi = s.sfi != null ? s.sfi : new int[]{1, 30}, recs = s.records != null ? s.records : new int[]{1, 16};
                    r.note("nfc.tpl.n.records", app(aid).scan(sender, budget, sfi[0], sfi[1], recs[0], recs[1]));
                    break;
                }
                case "for-each-aid": forEachAid(s, r, depth); break;
                case "eid-read": eidRead(s, r); break;
                case "emv-read": emvRead(s, r); break;
                default: r.status = "error"; r.note("nfc.tpl.n.unknownOp", s.op); break;
            }
        } catch (IOException e) {
            r.status = "error";
            if (!(e instanceof Halt)) r.note = e.getMessage();
        }
        current = r;
        r.last = result.exchanges.size();
        if (rec.refused != null) {
            // A command that is not a read was stopped before the card (G-18).
            r.status = "error";
            r.note = null;
            r.note("nfc.tpl.n.refused", rec.refused);
            rec.refused = null;
        } else if (!brokenBefore && rec.failure != null) {
            // The card stopped answering during this step (the result says why).
            r.status = "error";
            if (!"for-each-aid".equals(r.op)) { r.note = null; r.note("nfc.tpl.n.lost"); }
        } else if (!cancelledBefore && cancel.get()) {
            if (!"error".equals(r.status) || r.last == r.first) r.status = "warn";
            r.note("nfc.tpl.n.cancelled");
        }
        // A reader step that failed: its last command says so (the commands before it went as they should).
        if (!r.op.isEmpty() && !"ok".equals(r.status) && r.last > r.first && !"for-each-aid".equals(r.op)) {
            Exchange last = result.exchanges.get(r.last - 1);
            if (!"error".equals(last.status)) last.status = r.status;
        }
        return r;
    }

    /** The application the EMV steps act on: the selected one, else one without a SELECT (its data still kept). */
    private EmvReader.AppRead app(String aid) {
        if (app == null) { app = new EmvReader.AppRead(aid == null ? "" : aid, null); appSelected = false; }
        return app;
    }

    /** The application read so far goes into the result. */
    private void finishApp() throws JSONException {
        if (app != null && (appSelected || !app.empty())) apps.put(app.build());
        app = null;
        appSelected = false;
    }

    private void fixed(ApduTemplates.Step s, StepResult r) throws IOException {
        r.command = s.apdu == null ? "" : s.apdu;
        if (!r.command.matches("([0-9A-F]{2}){4,261}")) { r.status = "error"; r.note("nfc.tpl.n.badCommand"); return; }
        String why = ApduTemplates.commandProblem(r.command);
        if (why != null) { r.status = "error"; r.note("nfc.tpl.n.refused", why); return; } // G-18: never sent
        byte[] cmd = Apdu.unhex(r.command);
        Apdu.Response resp = Apdu.splitResponse(rec.transmit(cmd));
        if (resp.sw1 == 0x6c && cmd.length >= 5) {
            byte[] again = cmd.clone();
            again[again.length - 1] = (byte) resp.sw2;
            resp = Apdu.splitResponse(rec.transmit(again));
        }
        ByteArrayOutputStream data = new ByteArrayOutputStream();
        data.write(resp.data, 0, resp.data.length);
        int guard = 0;
        while (resp.sw1 == 0x61 && guard++ < 64) {
            resp = Apdu.splitResponse(rec.transmit(Apdu.u8(cmd[0] & 0xf0, 0xc0, 0x00, 0x00, resp.sw2)));
            data.write(resp.data, 0, resp.data.length);
        }
        r.data = Apdu.hex(data.toByteArray());
        r.sw = StatusWords.hex(resp.sw);
        r.status = expected(s.expect, resp.sw) ? "ok" : s.optional ? "warn" : "error";
        int last = result.exchanges.size();
        // The follow-ups (61xx, 6Cxx) went as they should; the last answer is the step's.
        for (int i = r.first; i < last; i++) result.exchanges.get(i).status = i == last - 1 ? r.status : "ok";
    }

    private void directory(ApduTemplates.Step s, StepResult r) throws IOException {
        emvRan = true;
        EmvReader.Directory d = "select-pse".equals(s.op) ? EmvReader.selectPse(sender) : EmvReader.selectPpse(sender);
        if (!d.ok) { r.status = s.optional ? "warn" : "error"; r.note("nfc.tpl.n.noDir"); return; }
        dirRead = true;
        for (String a : d.aids) if (!dirAids.contains(a)) dirAids.add(a);
        if (!d.tree.isEmpty()) tree = tree.isEmpty() ? d.tree : tree + "\n" + d.tree;
        r.note("nfc.tpl.n.dir", d.aids.size());
    }

    private void selectAid(ApduTemplates.Step s, StepResult r, String loopAid) throws JSONException {
        emvRan = true;
        String a = s.aid != null ? s.aid : loopAid;
        if (a == null) { r.status = "error"; r.note("nfc.tpl.n.noAid"); return; }
        finishApp();
        EmvReader.Fci sel = EmvReader.selectAid(sender, a);
        if (!sel.ok) {
            // In a for-each-aid the list may hold applications this card does not have.
            r.status = s.optional || (s.aid == null && loopAid != null) ? "warn" : "error";
            r.note("nfc.tpl.n.notSelected");
            return;
        }
        app = new EmvReader.AppRead(a, sel);
        appSelected = true;
        if (!readAids.contains(a)) readAids.add(a);
        String scheme = EmvTags.schemeForAid(a);
        r.note("nfc.tpl.n.selected", sel.label != null && !sel.label.isEmpty() ? sel.label : scheme != null ? scheme : a);
    }

    private void forEachAid(ApduTemplates.Step s, StepResult r, int depth) throws JSONException {
        List<String> list = new ArrayList<>();
        if (!s.aids.isEmpty()) list.addAll(s.aids);
        else if (!dirAids.isEmpty()) list.addAll(dirAids);
        else for (EmvTags.Candidate c : EmvTags.CANDIDATE_AIDS) list.add(c.aid);
        int max = s.max > 0 ? Math.min(16, s.max) : 8;
        int read = 0;
        for (String a : list) {
            if (read >= max || halted()) break;
            finishApp();
            if (runBlock(s.steps, depth + 1, a)) read++;
            finishApp();
        }
        current = r;
        r.note("nfc.tpl.n.apps", read);
        if (read == 0) r.status = "warn";
    }

    private void eidRead(ApduTemplates.Step s, StepResult r) throws JSONException {
        MrtdReader.Options o = mrtdOptions != null ? mrtdOptions : MrtdReader.Options.fromArgs(s.args);
        JSONObject m = MrtdReader.readMrtd(rec, o);
        result.mrtd = m;
        boolean opened = m.has("mrzInfo") || !"none".equals(m.optString("access", "none"));
        if (!opened) r.status = s.optional ? "warn" : "error";
        r.note = MrtdReader.summary(m);
    }

    private void emvRead(ApduTemplates.Step s, StepResult r) throws IOException, JSONException {
        emvRan = true;
        finishApp();
        JSONObject e = EmvReader.readEmv(rec, EmvReader.Options.fromArgs(s.args));
        JSONArray got = e.optJSONArray("apps");
        if (got != null) for (int i = 0; i < got.length(); i++) apps.put(got.get(i));
        JSONArray aids = e.optJSONArray("aids");
        if (aids != null) for (int i = 0; i < aids.length(); i++) if (!readAids.contains(aids.optString(i))) readAids.add(aids.optString(i));
        if (!e.optString("tree", "").isEmpty()) tree = tree.isEmpty() ? e.optString("tree") : tree + "\n" + e.optString("tree");
        if (e.optBoolean("deep")) deep = true;
        if (got == null || got.length() == 0) r.status = s.optional ? "warn" : "error";
        r.note = EmvReader.emvSummary(e);
    }
}
