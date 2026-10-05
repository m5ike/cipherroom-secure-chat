package cz.m5cet.app.ui.parts;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Typeface;
import android.nfc.NdefMessage;
import android.nfc.NdefRecord;
import android.nfc.Tag;
import android.nfc.tech.Ndef;
import android.text.InputType;
import android.util.Base64;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;

import cz.m5cet.app.M5;
import cz.m5cet.app.chat.ChatMessage;
import cz.m5cet.app.chat.Payloads;
import cz.m5cet.app.chat.RoomSession;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.nfc.Apdu;
import cz.m5cet.app.nfc.ApduTemplates;
import cz.m5cet.app.nfc.CardOps;
import cz.m5cet.app.nfc.CardService;
import cz.m5cet.app.nfc.ConnTag;
import cz.m5cet.app.nfc.InternalReader;
import cz.m5cet.app.nfc.M5Card;
import cz.m5cet.app.nfc.MrtdReader;
import cz.m5cet.app.nfc.Nfc;
import cz.m5cet.app.nfc.NfcCatalog;
import cz.m5cet.app.nfc.Records;
import cz.m5cet.app.nfc.TagTech;
import cz.m5cet.app.nfc.TemplateRunner;
import cz.m5cet.app.nfc.TemplateViews;
import cz.m5cet.app.nfc.UsbReader;
import cz.m5cet.app.ui.Expr;
import cz.m5cet.app.ui.Icons;
import cz.m5cet.app.ui.MainActivity;
import cz.m5cet.app.ui.Renderer;
import cz.m5cet.app.ui.Ui;

/**
 * The NFC workbench (6.3): the native part that brings the Android app to parity
 * with the web workbench — a reader chooser (internal / USB / Bluetooth), a
 * continuous scan that shows the UID, the technology and the public record, the
 * per-technology functions from {@link NfcCatalog}, the M5Cet card (its records
 * and their actions), the room connection tag (read / write / emulate, kept
 * interoperable with the web), and emulation.
 *
 * Because an android {@link Tag} is only valid for a moment after it is
 * discovered, an operation is ARMED and then runs on the next tap; a plain scan
 * just detects and shows the card.
 *
 * 6.10: application templates (m5mobile.define › apduTemplates) — a picker by
 * card type; a template runs ALL its steps ({@link TemplateRunner}, read-only)
 * with a progress line and Cancel; its output switches between in / out, raw,
 * JSON and readable ({@link TemplateViews}, card numbers masked unless asked
 * for) and is shared, forwarded to a user or kept as a note to myself.
 */
final class NfcWorkbench extends ScrollView implements Renderer.Slot {
    private final MainActivity a;
    private final InternalReader reader;
    private final LinearLayout box;
    private final TextView status;
    private final EditText pin;
    private final EditText keyDict;
    private final LinearLayout readerRow;
    private final LinearLayout opsBox;
    private final LinearLayout result;

    private boolean scanning;
    private String armedOp;                 // the op waiting for the next tap (null = plain scan)
    private byte[] armedArg;                 // an op's binary argument (a block to write, a UID…)
    private int armedBlock = -1;
    private JSONObject lastDump;             // the last MIFARE Classic dump, for restore
    private MrtdReader.Options armedMrtdOpts; // the BAC key/MRZ gathered before an eid-read tap
    private String tech = NfcCatalog.UNKNOWN;

    // 6.10: application templates — the one waiting for the tap, the run in progress (Cancel), the last run's output.
    private ApduTemplates.Template armedTemplate;
    private volatile TemplateRunner running;
    private TemplateRunner.Result lastRun;
    private String outView = TemplateViews.READABLE;
    /** G-19: the card number and track data as read — only when the user turns it on (off again for each run). */
    private boolean fullPan;
    private TextView progressText;

    NfcWorkbench(MainActivity a) {
        super(a);
        this.a = a;
        this.reader = new InternalReader(a);
        box = new LinearLayout(a);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(Ui.dp(a, 16), Ui.dp(a, 14), Ui.dp(a, 16), Ui.dp(a, 28));
        addView(box);
        int fg = Ui.color(a, "@onSurface", Color.BLACK), muted = Ui.color(a, "@muted", Color.GRAY);

        box.addView(ToolPanels.label(a, app().t("nfc.reader.title"), 12, muted, false));
        readerRow = new LinearLayout(a);
        readerRow.setPadding(0, Ui.dp(a, 6), 0, Ui.dp(a, 10));
        box.addView(readerRow);
        buildReaderRow();

        status = ToolPanels.label(a, app().t("nfc.work.tapScan"), 15, fg, true);
        status.setGravity(Gravity.CENTER);
        status.setPadding(0, Ui.dp(a, 6), 0, Ui.dp(a, 6));
        box.addView(status);

        LinearLayout scanRow = new LinearLayout(a);
        scanRow.setGravity(Gravity.CENTER);
        scanRow.setPadding(0, Ui.dp(a, 4), 0, Ui.dp(a, 8));
        TextView scan = ToolPanels.button(a, app().t("nfc.work.scan"), "scan-line", true);
        scan.setOnClickListener(v -> { armedOp = null; startScan(); });
        TextView stop = ToolPanels.button(a, app().t("nfc.stop"), "square", false);
        LinearLayout.LayoutParams sl = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        sl.setMarginStart(Ui.dp(a, 10));
        stop.setOnClickListener(v -> stopScan());
        scanRow.addView(scan);
        scanRow.addView(stop, sl);
        box.addView(scanRow);

        // PIN (for the M5Cet card and the connection tag) and the key dictionary.
        pin = field(app().t("nfc.work.pin"), InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD);
        box.addView(pin);
        keyDict = field(app().t("nfc.keys.hint"), InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        keyDict.setText(app().settings.str("nfc.keyDictionary"));
        keyDict.setMinLines(1);
        box.addView(keyDict);

        // M5Cet: open records and build a card.
        LinearLayout m5 = new LinearLayout(a);
        m5.setGravity(Gravity.CENTER);
        m5.setPadding(0, Ui.dp(a, 10), 0, Ui.dp(a, 2));
        TextView open = ToolPanels.button(a, app().t("nfc.m5.open"), "id-card", false);
        open.setOnClickListener(v -> arm("m5-read"));
        TextView build = ToolPanels.button(a, app().t("nfc.m5.build"), "square-pen", false);
        LinearLayout.LayoutParams bl = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        bl.setMarginStart(Ui.dp(a, 10));
        build.setOnClickListener(v -> a.showScreen("nfc.builder", true));
        m5.addView(open);
        m5.addView(build, bl);
        box.addView(m5);

        // 6.10: an application template — a complete read of a card type — whatever the card turns out to be.
        LinearLayout tplRow = new LinearLayout(a);
        tplRow.setGravity(Gravity.CENTER);
        tplRow.setPadding(0, Ui.dp(a, 6), 0, Ui.dp(a, 2));
        TextView tpl = ToolPanels.button(a, app().t("nfc.tpl.open"), "square-arrow-down", false);
        tpl.setOnClickListener(this::showAppTemplates);
        tplRow.addView(tpl);
        box.addView(tplRow);

        opsBox = new LinearLayout(a);
        opsBox.setOrientation(LinearLayout.VERTICAL);
        opsBox.setPadding(0, Ui.dp(a, 8), 0, 0);
        box.addView(opsBox);

        result = new LinearLayout(a);
        result.setOrientation(LinearLayout.VERTICAL);
        result.setPadding(0, Ui.dp(a, 12), 0, 0);
        box.addView(result);

        refreshStatus(app().t("nfc.work.tapScan"));
    }

    private M5 app() { return a.app(); }

    private EditText field(String hint, int inputType) {
        EditText e = new EditText(a);
        e.setHint(hint);
        e.setInputType(inputType);
        e.setTextColor(Ui.color(a, "@onSurface", Color.BLACK));
        e.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        e.setBackground(Ui.shape(Ui.color(a, "@surfaceVariant", Color.LTGRAY), Ui.dp(a, 12), 0, 0));
        e.setPadding(Ui.dp(a, 14), Ui.dp(a, 10), Ui.dp(a, 14), Ui.dp(a, 10));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = Ui.dp(a, 8);
        e.setLayoutParams(lp);
        return e;
    }

    /* ------------------------------------------------------- reader chooser */

    private void buildReaderRow() {
        readerRow.removeAllViews();
        String chosen = app().settings.str("nfc.reader");
        for (NfcCatalog.ReaderInfo ri : NfcCatalog.READERS) {
            if (ri.kind.equals(NfcCatalog.READER_SERIAL)) continue; // no Web Serial equivalent on Android
            boolean on = ri.kind.equals(chosen) || (chosen.isEmpty() && ri.kind.equals(NfcCatalog.READER_INTERNAL));
            TextView chip = new TextView(a);
            chip.setText(readerLabel(ri.kind));
            chip.setTextColor(on ? Ui.color(a, "@onPrimary", Color.WHITE) : Ui.color(a, "@onSurface", Color.BLACK));
            chip.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            chip.setTypeface(on ? Typeface.DEFAULT_BOLD : Typeface.DEFAULT);
            chip.setPadding(Ui.dp(a, 14), Ui.dp(a, 8), Ui.dp(a, 14), Ui.dp(a, 8));
            int bg = on ? Ui.color(a, "@primary", Color.BLUE) : Ui.alpha(Ui.color(a, "@primary", Color.BLUE), 0.12f);
            chip.setBackground(Ui.ripple(Ui.shape(bg, Ui.dp(a, 999), 0, 0), Ui.alpha(Color.WHITE, 0.2f)));
            chip.setOnClickListener(v -> chooseReader(ri.kind));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.setMarginEnd(Ui.dp(a, 8));
            readerRow.addView(chip, lp);
        }
    }

    private String readerLabel(String kind) {
        switch (kind) {
            case NfcCatalog.READER_USB: return app().t("nfc.reader.usb");
            case NfcCatalog.READER_BLUETOOTH: return app().t("nfc.reader.bluetooth");
            default: return app().t("nfc.reader.internal");
        }
    }

    private void chooseReader(String kind) {
        app().settings.set("nfc.reader", kind);
        buildReaderRow();
        if (NfcCatalog.READER_USB.equals(kind)) {
            UsbReader u = cz.m5cet.app.nfc.Readers.usb(a);
            if (u == null) { refreshStatus(app().t("nfc.reader.noUsb")); return; }
            u.requestPermission(ok -> Io.main(() -> refreshStatus(ok ? u.name() + " ✓" : app().t("nfc.reader.denied"))));
        } else if (NfcCatalog.READER_BLUETOOTH.equals(kind)) {
            refreshStatus(new cz.m5cet.app.nfc.BleReader(a).connectHint());
        } else {
            refreshStatus(app().t("nfc.work.tapScan"));
        }
    }

    /* ------------------------------------------------------------- scanning */

    private void arm(String op) { arm(op, -1, null); }

    private void arm(String op, int block, byte[] arg) {
        armedOp = op; armedBlock = block; armedArg = arg;
        startScan();
        refreshStatus(app().t("nfc.work.holdCard"));
    }

    private void startScan() {
        if (!reader.available(a)) { a.flash("", app().t("nfc.unavailable"), "warn"); return; }
        if (!reader.enabled()) { a.flash("", app().t("nfc.disabled"), "warn"); a.systemSettings("app"); return; }
        // The connection-card panel and the workbench must not both own reader mode.
        CardService.stopServing();
        scanning = true;
        reader.startScan(this::onTag);
        if (armedOp == null) refreshStatus(app().t("nfc.hold"));
    }

    private void stopScan() {
        scanning = false;
        armedOp = null;
        reader.stopScan();
        refreshStatus(app().t("nfc.work.tapScan"));
    }

    /** On the NFC binder thread: detect the card, then run any armed op. */
    private void onTag(Tag tag) {
        try {
            JSONObject conn = connectionOnTag(tag);
            byte[] container = m5CardOnTag(tag);
            TagTech.Detected d = TagTech.detect(tag, conn != null, container != null);
            this.tech = d.tech;
            String op = armedOp;
            armedOp = null; // one-shot
            JSONObject shown = d.card;
            if (op == null || op.equals("scan") || op.equals("read-uid") || op.equals("read-public")) {
                if (op != null && op.equals("read-public")) shown.put("ndefResult", CardOps.ndefRead(tag));
                // A connection tag whose PIN was already entered opens its join card in one tap.
                if (conn != null && conn.optJSONObject("room") != null) openConnection(conn);
                else showCard(shown, null);
            } else {
                runOp(op, tag, d.tech, container, conn, shown);
            }
        } catch (Exception e) {
            Log.w("nfc", "op failed: " + e.getMessage());
            final String m = e instanceof CardOps.NfcWriteException ? writeErr(e) : ("⚠ " + (e.getMessage() == null ? "error" : e.getMessage()));
            Io.main(() -> refreshStatus(m));
        }
        if (!scanning) Io.main(reader::stopScan);
    }

    /** Runs the armed op against the tag and shows the result. */
    private void runOp(String op, Tag tag, String tech, byte[] container, JSONObject conn, JSONObject card) throws Exception {
        JSONObject out = new JSONObject();
        switch (op) {
            case "ndef-read": out = CardOps.ndefRead(tag); break;
            case "ndef-lock": CardOps.ndefLock(tag); out.put("done", app().t("nfc.done.locked")); break;
            case "ndef-write": if (armedArg != null) { CardOps.ndefWriteAny(tag, new NdefMessage(NdefRecord.createTextRecord(null, new String(armedArg, StandardCharsets.UTF_8))), keys()); out.put("done", app().t("nfc.done.written")); } break;
            case "classic-read": out = CardOps.classicRead(tag, keys()); break;
            case "classic-dump": out = CardOps.classicDump(tag, keys()); lastDump = out; break;
            case "classic-restore": if (lastDump != null) out.put("restored", CardOps.classicRestore(tag, lastDump, keys())); else out.put("note", app().t("nfc.restore.none")); break;
            case "classic-write": if (armedArg != null && armedBlock >= 0) { CardOps.classicWrite(tag, armedBlock, armedArg, keys()); out.put("done", app().t("nfc.done.written")); } break;
            case "ul-read": case "ntag-read": out = CardOps.ultralightRead(tag); break;
            case "ul-write": case "ntag-write": if (armedArg != null && armedBlock >= 0) { CardOps.ultralightWrite(tag, armedBlock, armedArg); out.put("done", app().t("nfc.done.written")); } break;
            case "desfire-apps": out = CardOps.desfireApps(tag); break;
            case "select-aid": case "raw-apdu": if (armedArg != null) out.put("apdu", TagTech.hex(CardOps.isoTransceive(tag, armedArg))); break;
            case "v-read": out = CardOps.nfcvRead(tag); break;
            case "v-write": if (armedArg != null && armedBlock >= 0) { CardOps.nfcvWrite(tag, armedBlock, armedArg); out.put("done", app().t("nfc.done.written")); } break;
            case "felica-systems": out = CardOps.felicaSystems(tag); break;
            case "emv-public": out = CardOps.emvPublic(tag); break;
            case "eid-public": out = CardOps.eidPublic(tag); break;
            // 6.6: the deep read — every application, the history, every file (read-only).
            case "emv-read": showEmv(card, CardOps.emvRead(tag, new cz.m5cet.app.nfc.EmvReader.Options())); return;
            case "eid-read": case "mrtd-read": {
                MrtdReader.Options o = armedMrtdOpts != null ? armedMrtdOpts : new MrtdReader.Options();
                showMrtd(card, CardOps.eidRead(tag, o));
                return;
            }
            case "write-uid": if (armedArg != null) { CardOps.writeUid(tag, armedArg, keys()); out.put("done", app().t("nfc.done.uid")); } else out.put("note", app().t("nfc.uid.need")); break;
            case "app-template": runTemplateOnTag(tag, card); return;
            case "m5-read": openM5Records(container); return;
            case "conn-read": {
                // Asked for: an invitation is redeemed now (after the tag's content was read).
                String blob = conn == null ? null : conn.optString("blob", null);
                if (blob != null && "redeem".equals(conn.optJSONObject("conn") == null ? "" : conn.optJSONObject("conn").optString("need"))) {
                    conn = new JSONObject().put("blob", blob).put("conn", ConnTag.open(blob, pinText(), app().config.server(), true).json());
                }
                openConnection(conn);
                return;
            }
            case "conn-write": writeConnection(tag); out.put("done", app().t("nfc.done.written")); break;
            default: out.put("note", app().t("nfc.op.unsupported")); break;
        }
        final JSONObject shown = out;
        showCard(card, shown);
    }

    /* ---------------------------------------------------------- connection */

    private JSONObject connectionOnTag(Tag tag) {
        String blob = null;
        try {
            Ndef ndef = Ndef.get(tag);
            if (ndef == null) return null;
            ndef.connect();
            try {
                blob = Nfc.connectionBody(ndef.getNdefMessage());
            } finally { try { ndef.close(); } catch (Exception ignored) { } }
        } catch (Exception ignored) { }
        if (blob == null) return null;
        // 6.12 (§ 16): format 2 (an offline tag with its code) or format 1 with its PIN — the field holds the code
        // or the PIN. An invitation is redeemed only when asked (Open): every redemption uses one of its uses.
        ConnTag.Read r = ConnTag.open(blob, pinText(), app().config.server(), false);
        try {
            JSONObject o = new JSONObject().put("blob", blob).put("conn", r.json());
            if (r.room != null) o.put("room", r.json().optJSONObject("room"));
            return o;
        } catch (org.json.JSONException e) { return null; }
    }

    private void openConnection(JSONObject conn) {
        Io.main(() -> {
            if (conn == null) { refreshStatus(app().t("nfc.conn.none")); return; }
            showCard(null, null);
            String blob = conn.optString("blob");
            LinearLayout card = ConnTagUi.result(a, conn.optJSONObject("conn"),
                () -> Io.bg(() -> {
                    ConnTag.Read again = ConnTag.open(blob, pinText(), app().config.server(), true);
                    try { openConnection(new JSONObject().put("blob", blob).put("conn", again.json())); } catch (org.json.JSONException ignored) { }
                }),
                room -> ConnTagUi.prepare(a, room, body -> arm("conn-write", -1, body.getBytes(StandardCharsets.UTF_8))));
            result.addView(card);
        });
    }

    /** 6.12: writes the format-2 body prepared when the op was armed (ConnTagUi.prepare) — never a PIN tag. */
    private void writeConnection(Tag tag) throws Exception {
        byte[] body = armedArg;
        if (body == null) throw new Exception(app().t("rooms.empty"));
        CardOps.ndefWriteAny(tag, Nfc.message(new String(body, StandardCharsets.UTF_8)), keys());
    }

    /** "Write connection": an invitation or an offline tag for the active room, prepared, then the tap. */
    private void prepareConnection(String op) {
        RoomSession r = app().rooms.activeSession();
        JSONObject card = r == null ? null : app().rooms.cardOf(r.key);
        if (card == null) { a.flash("", app().t("rooms.empty"), "warn"); return; }
        ConnTagUi.prepare(a, card, body -> arm(op, -1, body.getBytes(StandardCharsets.UTF_8)));
    }

    /* --------------------------------------------------------- M5Cet card */

    /** The M5Cet container off a tag: the NDEF external record m5cet.cz:card. */
    private byte[] m5CardOnTag(Tag tag) {
        try {
            Ndef ndef = Ndef.get(tag);
            if (ndef == null) return null;
            ndef.connect();
            try {
                NdefMessage msg = ndef.getNdefMessage();
                if (msg == null) return null;
                for (NdefRecord r : msg.getRecords()) {
                    if (r.getTnf() == NdefRecord.TNF_EXTERNAL_TYPE) {
                        String type = new String(r.getType(), StandardCharsets.US_ASCII);
                        if (M5Card.EXTERNAL_TYPE.equalsIgnoreCase(type) && M5Card.isM5Card(r.getPayload())) return r.getPayload();
                    }
                }
            } finally { try { ndef.close(); } catch (Exception ignored) { } }
        } catch (Exception ignored) { }
        return null;
    }

    private void openM5Records(byte[] container) {
        if (container == null) { Io.main(() -> refreshStatus(app().t("nfc.m5.none"))); return; }
        final List<M5Card.Sealed> records;
        try { records = M5Card.decodeContainer(container); }
        catch (Exception e) { Io.main(() -> refreshStatus("⚠ " + e.getMessage())); return; }
        lastContainerForEmulate = container;
        Io.main(() -> {
            showCard(null, null);
            result.addView(ToolPanels.label(a, app().t("nfc.m5.records") + " (" + records.size() + ")", 12, Ui.color(a, "@muted", Color.GRAY), false));
            for (M5Card.Sealed s : records) result.addView(recordRow(container, s));
            TextView emu = ToolPanels.button(a, app().t("nfc.m5.emulate"), "smartphone", false);
            LinearLayout.LayoutParams el = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            el.topMargin = Ui.dp(a, 10);
            emu.setOnClickListener(v -> emulateM5(container));
            result.addView(emu, el);
        });
    }

    private View recordRow(byte[] container, M5Card.Sealed s) {
        Records.Meta meta = Records.meta(s.type);
        LinearLayout row = cardBox();
        LinearLayout head = new LinearLayout(a);
        head.setGravity(Gravity.CENTER_VERTICAL);
        android.widget.ImageView icon = new android.widget.ImageView(a);
        int px = Ui.dp(a, 20);
        icon.setImageDrawable(Icons.drawable(a, meta == null ? "file" : meta.icon, px, Ui.color(a, "@primary", Color.BLUE)));
        LinearLayout.LayoutParams il = new LinearLayout.LayoutParams(px, px);
        il.setMarginEnd(Ui.dp(a, 10));
        head.addView(icon, il);
        LinearLayout col = new LinearLayout(a);
        col.setOrientation(LinearLayout.VERTICAL);
        col.addView(ToolPanels.label(a, meta == null ? s.type : app().t(meta.label), 15, Ui.color(a, "@onSurface", Color.BLACK), true));
        String sub = (s.oneTime ? "🔥 " : "") + (M5Card.MODE_INTERNAL.equals(s.mode) ? app().t("nfc.rec.account") : app().t("nfc.rec.pin"));
        col.addView(ToolPanels.label(a, sub, 12, Ui.color(a, "@muted", Color.GRAY), false));
        head.addView(col, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        row.addView(head);
        TextView act = ToolPanels.button(a, meta == null ? app().t("nfc.rec.show") : app().t(meta.actionLabel), meta == null ? "eye" : meta.icon, false);
        LinearLayout.LayoutParams al = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        al.topMargin = Ui.dp(a, 8);
        act.setOnClickListener(v -> openRecord(container, s));
        row.addView(act, al);
        return row;
    }

    /** Open one record with its key and run its RECORD_META action (display / save / run). */
    private void openRecord(byte[] container, M5Card.Sealed s) {
        Io.bg(() -> {
            try {
                String p = pinText();
                M5Card.KeyProvider keys = M5Card.keys(M5Card.isValidPin(p) ? p : null, accountRoot());
                M5Card.Record rec = M5Card.open(s, keys);
                Io.main(() -> actOnRecord(container, rec));
            } catch (Exception e) {
                Io.main(() -> a.flash("", e.getMessage(), "warn"));
            }
        });
    }

    private void actOnRecord(byte[] container, M5Card.Record rec) {
        Records.Meta meta = Records.meta(rec.type);
        JSONObject d = rec.data == null ? new JSONObject() : rec.data;
        String action = meta == null ? Records.DISPLAY : meta.action;
        switch (action) {
            case Records.RUN:
                if (rec.type.equals("server-room")) a.finishJoin(d.optString("room"), d.optString("passphrase"), d.optString("name", ""));
                else if (!d.optString("url").isEmpty()) a.openUrl(d.optString("url"));
                break;
            case Records.SAVE:
                saveRecord(rec.type, d);
                break;
            default: // DISPLAY
                showText(app().t(meta == null ? "nfc.rec.message" : meta.label), d.has("text") ? d.optString("text") : d.optString("url", d.toString()));
                break;
        }
        // A one-time record erases itself once it has been shown.
        if (rec.oneTime) eraseOneTime(container, rec.id);
    }

    private void saveRecord(String type, JSONObject d) {
        switch (type) {
            case "wifi": {
                StringBuilder sb = new StringBuilder(app().t("nfc.rec.wifi")).append("\nSSID: ").append(d.optString("ssid"));
                if (!d.optString("password").isEmpty()) sb.append("\n").append(app().t("nfc.wifi.pw")).append(": ").append(d.optString("password"));
                SecureDialog.show(a, new android.app.AlertDialog.Builder(a).setTitle(app().t("nfc.rec.wifi")).setMessage(sb.toString()) // 6.7 N18: the password
                    .setPositiveButton(app().t("nfc.wifi.settings"), (di, w) -> { try { a.startActivity(new android.content.Intent(android.provider.Settings.ACTION_WIFI_SETTINGS)); } catch (RuntimeException e) { a.flash("", app().t("file.noApp"), "warn"); } })
                    .setNeutralButton(app().t("msg.copy"), (di, w) -> a.copy(d.optString("password")))
                    .setNegativeButton(app().t("nav.close"), null));
                break;
            }
            case "contact": {
                android.content.Intent i = new android.content.Intent(android.content.Intent.ACTION_INSERT_OR_EDIT).setType(android.provider.ContactsContract.Contacts.CONTENT_ITEM_TYPE);
                if (!d.optString("name").isEmpty()) i.putExtra(android.provider.ContactsContract.Intents.Insert.NAME, d.optString("name"));
                if (!d.optString("tel").isEmpty()) i.putExtra(android.provider.ContactsContract.Intents.Insert.PHONE, d.optString("tel"));
                if (!d.optString("email").isEmpty()) i.putExtra(android.provider.ContactsContract.Intents.Insert.EMAIL, d.optString("email"));
                if (!d.optString("org").isEmpty()) i.putExtra(android.provider.ContactsContract.Intents.Insert.COMPANY, d.optString("org"));
                try { a.startActivity(i); } catch (RuntimeException e) { a.flash("", app().t("file.noApp"), "warn"); }
                break;
            }
            case "url-login": {
                new android.app.AlertDialog.Builder(a).setTitle(app().t("nfc.rec.urlLogin"))
                    .setMessage(d.optString("url") + "\n" + d.optString("user"))
                    .setPositiveButton(app().t("nfc.rec.open"), (di, w) -> a.openUrl(d.optString("url")))
                    .setNeutralButton(app().t("nfc.login.copyPw"), (di, w) -> a.copy(d.optString("password")))
                    .setNegativeButton(app().t("nav.close"), null).show();
                break;
            }
            default: // passkey / identity / external-key → hand to the app's account / vault import
                a.flash("", app().t("nfc.rec.handoff"), "info");
                showText(app().t(Records.meta(type) == null ? "nfc.rec.externalKey" : Records.meta(type).label), app().t("nfc.rec.handoff"));
                break;
        }
    }

    private void eraseOneTime(byte[] container, int id) {
        final byte[] rewritten = M5Card.removeRecord(container, id);
        a.flash("", app().t("nfc.onetime.rewrite"), "info");
        CardService.stopServing();
        scanning = true;
        // Rewrite the card without the one-time record on the next tap.
        reader.startScan(tag -> {
            try {
                CardOps.ndefWriteAny(tag, new NdefMessage(new NdefRecord[]{NdefRecord.createExternal("m5cet.cz", "card", rewritten)}), keys());
                scanning = false;
                Io.main(() -> { refreshStatus(app().t("nfc.onetime.erased") + " ✓"); reader.stopScan(); });
            } catch (Exception e) {
                Io.main(() -> a.flash("", writeErr(e), "warn"));
            }
        });
    }

    /**
     * The account root for internal (passkey) records. Reaching it needs a small
     * accessor on account/Account (owned by the account/Functions side); until
     * that is wired, internal records show the "needs your account" hand-off.
     */
    private byte[] accountRoot() { return app().account == null ? null : app().account.cardRoot(); }

    /* ---------------------------------------------------------- emulation */

    void emulateM5(byte[] container) {
        CardService.serveM5Card(container);
        refreshStatus(app().t("nfc.emulating"));
    }

    /** 6.12 (§ 16): the phone answers as a format-2 connection tag (an invitation or an offline tag, prepared first). */
    void emulateConnection() {
        RoomSession r = app().rooms.activeSession();
        JSONObject card = r == null ? null : app().rooms.cardOf(r.key);
        if (card == null) { a.flash("", app().t("rooms.empty"), "warn"); return; }
        ConnTagUi.prepare(a, card, body -> {
            try {
                CardService.serveConnection(Nfc.message(body));
                refreshStatus(app().t("nfc.emulating"));
            } catch (Exception e) { a.flash("", e.getMessage(), "warn"); }
        });
    }

    /* ------------------------------------------------------------- display */

    private java.util.List<byte[]> keys() {
        if (app().settings.bool("nfc.saveKeys")) app().settings.set("nfc.keyDictionary", keyDict.getText().toString());
        return CardOps.keyDictionary(keyDict.getText().toString());
    }

    private String pinText() { return pin.getText().toString().trim(); }

    /** A writable, localized message for a write failure (typed reasons localized, others verbatim). */
    private String writeErr(Exception e) {
        if (!(e instanceof CardOps.NfcWriteException)) return e.getMessage() == null ? "error" : e.getMessage();
        CardOps.NfcWriteException w = (CardOps.NfcWriteException) e;
        switch (w.kind) {
            case CardOps.NfcWriteException.READ_ONLY: return app().t("nfc.err.readOnly");
            case CardOps.NfcWriteException.TOO_SMALL: return app().t("nfc.err.tooSmall").replace("{0}", String.valueOf(w.needed)).replace("{1}", String.valueOf(w.available));
            case CardOps.NfcWriteException.NO_KEY: return app().t("nfc.err.noKey").replace("{0}", String.valueOf(w.sector));
            default: return app().t("nfc.err.notWritable");
        }
    }

    private void refreshStatus(String s) { Io.main(() -> status.setText(s)); }

    private LinearLayout cardBox() {
        LinearLayout card = new LinearLayout(a);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(Ui.dp(a, 14), Ui.dp(a, 12), Ui.dp(a, 14), Ui.dp(a, 12));
        card.setBackground(Ui.shape(Ui.color(a, "@surface", Color.WHITE), Ui.dp(a, 16), Ui.dp(a, 1), Ui.color(a, "@border", Color.LTGRAY)));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = Ui.dp(a, 10);
        card.setLayoutParams(lp);
        return card;
    }

    private void showText(String title, String body) {
        new android.app.AlertDialog.Builder(a).setTitle(title).setMessage(body)
            .setPositiveButton(app().t("nav.close"), null)
            .setNeutralButton(app().t("msg.copy"), (d, w) -> a.copy(body)).show();
    }

    /** Draws the detected card box and its op buttons (call on the main thread). */
    private void drawCardInfo(JSONObject card) {
        int fg = Ui.color(a, "@onSurface", Color.BLACK), muted = Ui.color(a, "@muted", Color.GRAY);
        refreshStatus(card.optString("label", tech));
        LinearLayout ci = cardBox();
        ci.addView(ToolPanels.label(a, card.optString("label"), 16, fg, true));
        if (!card.optString("uid").isEmpty()) ci.addView(ToolPanels.label(a, "UID " + card.optString("uid"), 13, muted, false));
        String meta = card.optString("sak", "").isEmpty() ? "" : "SAK " + card.optString("sak");
        if (!card.optString("atqa", "").isEmpty()) meta += (meta.isEmpty() ? "" : " · ") + "ATQA " + card.optString("atqa");
        if (!card.optString("ats", "").isEmpty()) meta += (meta.isEmpty() ? "" : " · ") + "ATS " + card.optString("ats");
        if (!meta.isEmpty()) ci.addView(ToolPanels.label(a, meta, 12, muted, false));
        if (!card.optString("memory", "").isEmpty()) ci.addView(ToolPanels.label(a, card.optString("memory"), 12, muted, false));
        JSONArray tl = card.optJSONArray("techList");
        if (tl != null) { StringBuilder t = new StringBuilder(); for (int i = 0; i < tl.length(); i++) t.append(i > 0 ? " · " : "").append(tl.optString(i)); ci.addView(ToolPanels.label(a, t.toString(), 12, muted, false)); }
        result.addView(ci);
        buildOps(card.optString("tech", tech));
    }

    /** Redraws the detected card, its op buttons and any op result. */
    private void showCard(JSONObject card, JSONObject opResult) {
        Io.main(() -> {
            result.removeAllViews();
            opsBox.removeAllViews();
            int fg = Ui.color(a, "@onSurface", Color.BLACK), muted = Ui.color(a, "@muted", Color.GRAY);
            if (card != null) drawCardInfo(card);
            if (opResult != null) {
                LinearLayout r = cardBox();
                if (opResult.has("done")) r.addView(ToolPanels.label(a, "✓ " + opResult.optString("done"), 14, Ui.color(a, "@success", 0xFF2e7d32), true));
                if (opResult.has("note")) r.addView(ToolPanels.label(a, opResult.optString("note"), 13, muted, false));
                if (opResult.has("apdu")) r.addView(ToolPanels.label(a, "← " + opResult.optString("apdu"), 13, fg, false));
                String pretty = opResult.toString().length() > 1600 ? opResult.toString().substring(0, 1600) + "…" : opResult.toString();
                if (!opResult.has("done") || opResult.length() > 1) {
                    TextView j = ToolPanels.label(a, pretty, 12, muted, false);
                    j.setTypeface(Typeface.MONOSPACE);
                    j.setPadding(0, Ui.dp(a, 6), 0, 0);
                    r.addView(j);
                }
                result.addView(r);
            }
        });
    }

    /* ------------------------------------------------- 6.5 / 6.6 EMV / e-ID */

    /**
     * The EMV read result (6.6 deep read): per application its holder fields and
     * counters, the transaction history as a table, what GET DATA answered, and
     * the data elements and the raw records as collapsible lists.
     */
    private void showEmv(JSONObject card, JSONObject emv) {
        Io.main(() -> {
            result.removeAllViews();
            opsBox.removeAllViews();
            int fg = Ui.color(a, "@onSurface", Color.BLACK), muted = Ui.color(a, "@muted", Color.GRAY);
            if (card != null) drawCardInfo(card);
            refreshStatus(cz.m5cet.app.nfc.EmvReader.emvSummary(emv));
            JSONArray apps = emv.optJSONArray("apps");
            if (apps == null || apps.length() == 0) {
                LinearLayout r = cardBox();
                r.addView(ToolPanels.label(a, cz.m5cet.app.nfc.EmvReader.emvSummary(emv), 14, fg, true));
                r.addView(ToolPanels.label(a, app().t("nfc.readonly.help"), 12, muted, false));
                result.addView(r);
                return;
            }
            for (int i = 0; i < apps.length(); i++) {
                JSONObject app = apps.optJSONObject(i);
                if (app != null) result.addView(emvApp(app, fg, muted));
            }
            LinearLayout note = cardBox();
            String how = app().t(emv.optBoolean("deep", false) ? "nfc.emv.readDeep" : "nfc.emv.readAfl").replace("{0}", String.valueOf(emv.optInt("apdus", 0)));
            if (emv.has("apdus")) note.addView(ToolPanels.label(a, how, 12, muted, false));
            note.addView(ToolPanels.label(a, app().t("nfc.readonly.help"), 12, muted, false));
            result.addView(note);
        });
    }

    /** One EMV application: fields, counters, the history, GET DATA, the elements and the records. */
    private View emvApp(JSONObject app, int fg, int muted) {
        LinearLayout box = cardBox();
        String head = app.optString("scheme", app.optString("label", app.optString("aid", "")));
        box.addView(ToolPanels.label(a, head, 16, fg, true));
        if (!app.optString("label", "").isEmpty() && !app.optString("label").equals(head)) box.addView(ToolPanels.label(a, app.optString("label"), 13, muted, false));
        addField(box, "PAN", app.optString("panMasked", app.optString("pan", "")), fg);
        addField(box, app().t("nfc.emv.expiry"), app.optString("expiry", ""), fg);
        addField(box, app().t("nfc.emv.cardholder"), app.optString("cardholder", ""), fg);
        addField(box, app().t("nfc.emv.effective"), app.optString("effective", ""), fg);
        addField(box, app().t("nfc.emv.issuer"), app.optString("issuerCountry", ""), fg);
        addField(box, app().t("nfc.emv.panSeq"), app.optString("panSequence", ""), fg);
        if (app.has("atc")) addField(box, app().t("nfc.emv.atc"), String.valueOf(app.optLong("atc")), fg);
        if (app.has("lastOnlineAtc")) addField(box, app().t("nfc.emv.lastOnlineAtc"), String.valueOf(app.optLong("lastOnlineAtc")), fg);
        if (app.has("pinTryCounter")) addField(box, app().t("nfc.emv.ptc"), String.valueOf(app.optLong("pinTryCounter")), fg);
        addField(box, "AID", app.optString("aid", ""), muted);
        addField(box, "AIP", app.optString("aip", ""), muted);
        addField(box, "AFL", app.optString("afl", ""), muted);

        // The transaction history (newest first, as the card keeps it).
        JSONArray log = app.optJSONArray("log");
        box.addView(sectionTitle(app().t("nfc.emv.history") + (log != null && log.length() > 0 ? " (" + log.length() + ")" : "")));
        if (log == null || log.length() == 0) box.addView(ToolPanels.label(a, app().t("nfc.emv.noHistory"), 12, muted, false));
        else {
            List<String[]> rows = new java.util.ArrayList<>();
            for (int j = 0; j < log.length(); j++) {
                JSONObject e = log.optJSONObject(j);
                if (e == null) continue;
                String amount = (e.optString("amount", "") + " " + e.optString("currency", "")).trim();
                rows.add(new String[]{e.optString("date", ""), e.optString("time", ""), amount, e.optString("merchant", ""), e.optString("type", "")});
            }
            table(box, new String[]{app().t("nfc.emv.date"), app().t("nfc.emv.time"), app().t("nfc.emv.amount"), app().t("nfc.emv.merchant"), app().t("nfc.emv.type")},
                new float[]{1.25f, 0.95f, 1.2f, 1.4f, 1f}, rows, 2);
            if (app.has("logSfi")) box.addView(ToolPanels.label(a, "SFI " + app.optInt("logSfi") + (app.optString("logFormat", "").isEmpty() ? "" : " · " + app.optString("logFormat")), 11, muted, false));
        }

        // What GET DATA answered (counters, the log entry and format, balances).
        JSONArray gd = app.optJSONArray("getData");
        if (gd != null && gd.length() > 0) {
            box.addView(sectionTitle(app().t("nfc.emv.getData")));
            for (int j = 0; j < gd.length(); j++) {
                JSONObject g = gd.optJSONObject(j);
                if (g != null) box.addView(mono(g.optString("tag") + "  " + g.optString("name") + ": " + g.optString("value"), 12, fg));
            }
        }

        JSONArray tags = app.optJSONArray("tags");
        if (tags != null && tags.length() > 0) collapsible(box, app().t("nfc.emv.tags") + " (" + tags.length() + ")", body -> {
            for (int j = 0; j < tags.length(); j++) {
                JSONObject tg = tags.optJSONObject(j);
                if (tg != null) body.addView(mono(tg.optString("tag") + "  " + tg.optString("name") + ": " + tg.optString("value"), 12, muted));
            }
        });
        JSONArray recs = app.optJSONArray("records");
        if (recs != null && recs.length() > 0) collapsible(box, app().t("nfc.emv.records") + " (" + recs.length() + ")", body -> {
            for (int j = 0; j < recs.length(); j++) {
                JSONObject r = recs.optJSONObject(j);
                if (r == null) continue;
                String head2 = "SFI " + r.optInt("sfi") + " · #" + r.optInt("record") + (r.optBoolean("log") ? " · " + app().t("nfc.emv.log") : "");
                TextView h = ToolPanels.label(a, head2, 12, fg, true);
                h.setPadding(0, Ui.dp(a, 6), 0, 0);
                body.addView(h);
                body.addView(mono(spaced(r.optString("hex", "")), 11, muted));
            }
        });
        return box;
    }

    /** The e-ID / MRTD read result (6.6): the holder beside the face, DG11 / DG12, every picture, the security objects and the files. */
    private void showMrtd(JSONObject card, JSONObject mrtd) {
        Io.main(() -> {
            result.removeAllViews();
            opsBox.removeAllViews();
            int fg = Ui.color(a, "@onSurface", Color.BLACK), muted = Ui.color(a, "@muted", Color.GRAY);
            if (card != null) drawCardInfo(card);
            refreshStatus(MrtdReader.summary(mrtd));
            drawMrtd(result, mrtd, fg, muted);
        });
    }

    /** The e-ID read (6.6) drawn into {@code into} — the workbench's own read, and an e-ID template's readable view (6.10). */
    private void drawMrtd(LinearLayout into, JSONObject mrtd, int fg, int muted) {
        JSONArray images = mrtd.optJSONArray("images");

        // The holder (DG1) beside the face.
        LinearLayout box = cardBox();
        JSONObject m = mrtd.optJSONObject("mrzInfo");
        if (m == null) {
            box.addView(ToolPanels.label(a, app().t("nfc.eid.title"), 16, fg, true));
            box.addView(ToolPanels.label(a, mrtd.optString("message", MrtdReader.summary(mrtd)), 13, muted, false));
        } else {
            LinearLayout row = new LinearLayout(a);
            row.setOrientation(LinearLayout.HORIZONTAL);
            String photo = mrtd.optString("photo", "");
            if (!photo.isEmpty()) {
                LinearLayout.LayoutParams pl = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                pl.setMarginEnd(Ui.dp(a, 12));
                row.addView(picture(photo, mrtd.optString("photoMime", ""), null, 104, muted), pl);
            }
            LinearLayout col = new LinearLayout(a);
            col.setOrientation(LinearLayout.VERTICAL);
            String name = (m.optString("givenNames", "") + " " + m.optString("surname", "")).trim();
            col.addView(ToolPanels.label(a, name.isEmpty() ? app().t("nfc.eid.title") : name, 16, fg, true));
            addField(col, app().t("nfc.eid.docCode"), m.optString("documentCode", ""), fg);
            addField(col, app().t("nfc.eid.docNumber"), m.optString("documentNumber", ""), fg);
            addField(col, app().t("nfc.eid.nationality"), m.optString("nationality", ""), fg);
            addField(col, app().t("nfc.eid.issuer"), m.optString("issuer", ""), fg);
            addField(col, app().t("nfc.eid.dobLabel"), m.optString("dateOfBirth", ""), fg);
            addField(col, app().t("nfc.eid.sex"), m.optString("sex", ""), fg);
            addField(col, app().t("nfc.eid.expiryLabel"), m.optString("dateOfExpiry", ""), fg);
            row.addView(col, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            box.addView(row);
        }
        // How the chip was opened: BAC, or PACE (and what the chip offers).
        String access = mrtd.optString("access", "none");
        JSONObject pace = mrtd.optJSONObject("pace");
        if (!access.equals("none")) {
            String how = access.toUpperCase(java.util.Locale.ROOT);
            if (access.equals("pace") && pace != null) how += " · " + pace.optString("protocol", "") + (pace.has("password") ? " · " + pace.optString("password").toUpperCase(java.util.Locale.ROOT) : "");
            addField(box, app().t("nfc.eid.access"), how, fg);
        }
        if (pace != null && pace.optBoolean("supported") && !pace.optBoolean("used")) {
            String offered = pace.optString("protocol", "PACE");
            if (pace.has("parameterId")) {
                String p = cz.m5cet.app.nfc.Pace.PARAMETERS.get(pace.optInt("parameterId"));
                offered += " (" + (p != null ? p : String.valueOf(pace.optInt("parameterId"))) + ")";
            }
            addField(box, app().t("nfc.eid.paceOffered"), offered + " — " + app().t("nfc.eid.notUsed"), muted);
        }
        JSONArray dg = mrtd.optJSONArray("dataGroups");
        if (dg != null && dg.length() > 0) addField(box, app().t("nfc.eid.dataGroups"), join(dg, ", "), muted);
        if (m != null && !mrtd.optString("message", "").isEmpty()) box.addView(ToolPanels.label(a, mrtd.optString("message"), 12, muted, false));
        into.addView(box);

        // DG11 — personal details.
        JSONObject p = mrtd.optJSONObject("personal");
        if (p != null && p.length() > 0) {
            LinearLayout b = cardBox();
            b.addView(ToolPanels.label(a, app().t("nfc.eid.personal"), 15, fg, true));
            String[][] keys = {{"fullName", "nfc.eid.fullName"}, {"otherNames", "nfc.eid.otherNames"}, {"personalNumber", "nfc.eid.personalNumber"},
                {"fullDateOfBirth", "nfc.eid.fullDob"}, {"placeOfBirth", "nfc.eid.placeOfBirth"}, {"address", "nfc.eid.address"}, {"telephone", "nfc.eid.telephone"},
                {"profession", "nfc.eid.profession"}, {"title", "nfc.eid.titleField"}, {"personalSummary", "nfc.eid.summary"},
                {"otherTravelDocuments", "nfc.eid.otherDocs"}, {"custody", "nfc.eid.custody"}};
            for (String[] k : keys) addField(b, app().t(k[1]), valueOf(p, k[0]), fg);
            into.addView(b);
        }
        // DG12 — document details.
        JSONObject d = mrtd.optJSONObject("document");
        if (d != null && d.length() > 0) {
            LinearLayout b = cardBox();
            b.addView(ToolPanels.label(a, app().t("nfc.eid.document"), 15, fg, true));
            String[][] keys = {{"issuingAuthority", "nfc.eid.issuingAuthority"}, {"dateOfIssue", "nfc.eid.dateOfIssue"}, {"otherPersons", "nfc.eid.otherPersons"},
                {"endorsements", "nfc.eid.endorsements"}, {"taxExit", "nfc.eid.taxExit"}, {"personalizationTime", "nfc.eid.personalized"},
                {"personalizationDevice", "nfc.eid.personalizationDevice"}};
            for (String[] k : keys) addField(b, app().t(k[1]), valueOf(d, k[0]), fg);
            into.addView(b);
        }
        // DG13 / DG16.
        String optional = mrtd.optString("optional", "");
        JSONArray notify = mrtd.optJSONArray("personsToNotify");
        if (!optional.isEmpty() || (notify != null && notify.length() > 0)) {
            LinearLayout b = cardBox();
            if (!optional.isEmpty()) { b.addView(sectionTitle(app().t("nfc.eid.optional"))); b.addView(ToolPanels.label(a, optional, 13, fg, false)); }
            if (notify != null && notify.length() > 0) {
                b.addView(sectionTitle(app().t("nfc.eid.notify")));
                for (int i = 0; i < notify.length(); i++) b.addView(ToolPanels.label(a, notify.optString(i), 13, fg, false));
            }
            into.addView(b);
        }

        // Every picture the document holds (the face beside the holder is not repeated).
        if (images != null && images.length() > 0) {
            LinearLayout strip = new LinearLayout(a);
            strip.setOrientation(LinearLayout.HORIZONTAL);
            boolean faceShown = m != null && !mrtd.optString("photo", "").isEmpty();
            int shown = 0;
            for (int i = 0; i < images.length(); i++) {
                JSONObject img = images.optJSONObject(i);
                if (img == null) continue;
                if (faceShown && "face".equals(img.optString("kind")) && img.optString("data").equals(mrtd.optString("photo"))) { faceShown = false; continue; }
                LinearLayout.LayoutParams il = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                il.setMarginEnd(Ui.dp(a, 10));
                int w = "document".equals(img.optString("kind")) ? 200 : 120;
                strip.addView(picture(img.optString("data"), img.optString("mime"), imageLabel(img.optString("kind")) + " · " + img.optString("group"), w, muted), il);
                shown++;
            }
            if (shown > 0) {
                LinearLayout b = cardBox();
                b.addView(ToolPanels.label(a, app().t("nfc.eid.images") + " (" + shown + ")", 15, fg, true));
                android.widget.HorizontalScrollView hs = new android.widget.HorizontalScrollView(a);
                hs.setPadding(0, Ui.dp(a, 6), 0, 0);
                hs.addView(strip);
                b.addView(hs);
                into.addView(b);
            }
        }

        // The security objects: passive authentication, the signer, the protocols, the AA key.
        JSONObject sec = mrtd.optJSONObject("security");
        if (sec != null && sec.length() > 0) {
            LinearLayout b = cardBox();
            b.addView(ToolPanels.label(a, app().t("nfc.eid.security"), 15, fg, true));
            String passive = sec.optString("passive", "");
            if (!passive.isEmpty()) {
                int ok = Ui.color(a, "@success", 0xFF2e7d32), bad = Ui.color(a, "@danger", 0xFFdc2626);
                String text = passive.equals("ok") ? "✓ " + app().t("nfc.eid.passiveOk") : passive.equals("mismatch") ? "✗ " + app().t("nfc.eid.passiveBad") : "— " + app().t("nfc.eid.passiveNone");
                addField(b, app().t("nfc.eid.passive"), text, passive.equals("ok") ? ok : passive.equals("mismatch") ? bad : muted);
            }
            addField(b, app().t("nfc.eid.hash"), sec.optString("hashAlgorithm", ""), fg);
            JSONObject signer = sec.optJSONObject("signer");
            if (signer != null) {
                addField(b, app().t("nfc.eid.signer"), signer.optString("subject", ""), fg);
                addField(b, app().t("nfc.eid.signedBy"), signer.optString("issuer", ""), fg);
                String validity = (signer.optString("notBefore", "") + " – " + signer.optString("notAfter", "")).trim();
                if (!validity.equals("–")) addField(b, app().t("nfc.eid.validity"), validity, fg);
                addField(b, app().t("nfc.eid.serial"), signer.optString("serial", ""), muted);
            }
            JSONArray protocols = sec.optJSONArray("protocols");
            if (protocols != null && protocols.length() > 0) addField(b, app().t("nfc.eid.protocols"), join(protocols, ", "), fg);
            addField(b, app().t("nfc.eid.aaKey"), sec.optString("activeAuthKey", ""), fg);
            addField(b, app().t("nfc.eid.lds"), mrtd.optString("ldsVersion", ""), muted);
            addField(b, app().t("nfc.eid.unicode"), mrtd.optString("unicodeVersion", ""), muted);
            into.addView(b);
        }

        // Every file tried, and how it went.
        JSONArray files = mrtd.optJSONArray("files");
        if (files != null && files.length() > 0) {
            LinearLayout b = cardBox();
            b.addView(ToolPanels.label(a, app().t("nfc.eid.files"), 15, fg, true));
            for (int i = 0; i < files.length(); i++) {
                JSONObject f = files.optJSONObject(i);
                if (f != null) b.addView(fileRow(f, fg, muted));
            }
            into.addView(b);
        }

        LinearLayout note = cardBox();
        note.addView(ToolPanels.label(a, app().t("nfc.readonly.help"), 12, muted, false));
        into.addView(note);
    }

    /** One file of the document: its name and id, its status (read / protected (EAC) / absent / error), size and hash check. */
    private View fileRow(JSONObject f, int fg, int muted) {
        String status = f.optString("status", "error");
        int bad = Ui.color(a, "@danger", 0xFFdc2626), ok = Ui.color(a, "@success", 0xFF2e7d32);
        LinearLayout row = new LinearLayout(a);
        row.setPadding(0, Ui.dp(a, 3), 0, Ui.dp(a, 3));
        row.setGravity(Gravity.CENTER_VERTICAL);
        TextView name = ToolPanels.label(a, f.optString("name") + "  " + f.optString("fid"), 13, fg, true);
        name.setTypeface(Typeface.create(Typeface.MONOSPACE, Typeface.BOLD));
        row.addView(name, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1.1f));
        String st;
        switch (status) {
            case "read": st = app().t("nfc.eid.st.read"); break;
            case "protected": st = app().t("nfc.eid.st.protected"); break;
            case "absent": st = app().t("nfc.eid.st.absent"); break;
            default: st = app().t("nfc.eid.st.error");
        }
        if (f.has("size")) st += " · " + sizeText(f.optInt("size"));
        if (!f.optString("message", "").isEmpty()) st += " · " + f.optString("message");
        int color = status.equals("read") ? fg : status.equals("error") ? bad : muted;
        row.addView(ToolPanels.label(a, st, 12, color, false), new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 2f));
        if (f.has("hashOk")) {
            boolean good = f.optBoolean("hashOk");
            row.addView(ToolPanels.label(a, good ? "✓" : "✗", 15, good ? ok : bad, true));
        }
        return row;
    }

    private String imageLabel(String kind) {
        switch (kind) {
            case "face": return app().t("nfc.eid.img.face");
            case "portrait": return app().t("nfc.eid.img.portrait");
            case "signature": return app().t("nfc.eid.img.signature");
            case "document": return app().t("nfc.eid.img.document");
            default: return app().t("nfc.eid.img.other");
        }
    }

    /**
     * A picture from the document, {@code widthDp} wide, with an optional caption.
     * BitmapFactory cannot decode JPEG 2000 (many faces are) — that shows a
     * labelled placeholder instead.
     */
    private View picture(String b64, String mime, String caption, int widthDp, int muted) {
        LinearLayout col = new LinearLayout(a);
        col.setOrientation(LinearLayout.VERTICAL);
        Bitmap bmp = decodeImage(b64);
        if (bmp != null) {
            ImageView iv = new ImageView(a);
            iv.setImageBitmap(bmp);
            iv.setAdjustViewBounds(true);
            if (caption != null) iv.setContentDescription(caption);
            col.addView(iv, new LinearLayout.LayoutParams(Ui.dp(a, widthDp), ViewGroup.LayoutParams.WRAP_CONTENT));
        } else {
            String format = "image/jp2".equals(mime) ? "JPEG 2000" : (mime == null || mime.isEmpty() ? "?" : mime);
            TextView ph = ToolPanels.label(a, app().t("nfc.eid.cantShow").replace("{0}", format), 12, muted, false);
            ph.setGravity(Gravity.CENTER);
            ph.setPadding(Ui.dp(a, 8), Ui.dp(a, 8), Ui.dp(a, 8), Ui.dp(a, 8));
            ph.setBackground(Ui.shape(Ui.color(a, "@surfaceVariant", Color.LTGRAY), Ui.dp(a, 10), Ui.dp(a, 1), Ui.color(a, "@border", Color.LTGRAY)));
            col.addView(ph, new LinearLayout.LayoutParams(Ui.dp(a, widthDp), Ui.dp(a, Math.max(72, widthDp * 4 / 3))));
        }
        if (caption != null) {
            TextView c = ToolPanels.label(a, caption, 11, muted, false);
            c.setMaxWidth(Ui.dp(a, widthDp));
            c.setPadding(0, Ui.dp(a, 3), 0, 0);
            col.addView(c);
        }
        return col;
    }

    /** Decodes a base64 picture, scaled down when it is large; null when Android cannot decode it (JPEG 2000). */
    private static Bitmap decodeImage(String b64) {
        try {
            byte[] img = Base64.decode(b64, Base64.DEFAULT);
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(img, 0, img.length, bounds);
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null;
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inSampleSize = 1;
            while (Math.max(bounds.outWidth, bounds.outHeight) / o.inSampleSize > 1600) o.inSampleSize *= 2;
            return BitmapFactory.decodeByteArray(img, 0, img.length, o);
        } catch (RuntimeException e) { return null; }
    }

    private TextView sectionTitle(String s) {
        TextView t = ToolPanels.label(a, s, 12, Ui.color(a, "@muted", Color.GRAY), true);
        t.setPadding(0, Ui.dp(a, 10), 0, Ui.dp(a, 3));
        return t;
    }

    private TextView mono(String s, float sp, int color) {
        TextView t = ToolPanels.label(a, s, sp, color, false);
        t.setTypeface(Typeface.MONOSPACE);
        return t;
    }

    private interface Fill { void into(LinearLayout body); }

    /** A list behind a header that opens and closes it; the rows are built on the first open. */
    private void collapsible(LinearLayout box, String title, Fill fill) {
        TextView head = ToolPanels.label(a, "▸ " + title, 13, Ui.color(a, "@primary", Color.BLUE), true);
        head.setPadding(0, Ui.dp(a, 10), 0, Ui.dp(a, 4));
        LinearLayout body = new LinearLayout(a);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setVisibility(View.GONE);
        boolean[] built = {false};
        head.setOnClickListener(v -> {
            if (!built[0]) { fill.into(body); built[0] = true; }
            boolean open = body.getVisibility() != View.VISIBLE;
            body.setVisibility(open ? View.VISIBLE : View.GONE);
            head.setText((open ? "▾ " : "▸ ") + title);
        });
        box.addView(head);
        box.addView(body);
    }

    /** A small table: a header row, a rule, then the rows; {@code endColumn} is right-aligned (amounts). */
    private void table(LinearLayout box, String[] head, float[] weights, List<String[]> rows, int endColumn) {
        int fg = Ui.color(a, "@onSurface", Color.BLACK), muted = Ui.color(a, "@muted", Color.GRAY);
        box.addView(tableRow(head, weights, muted, true, endColumn));
        View rule = new View(a);
        rule.setBackgroundColor(Ui.color(a, "@border", Color.LTGRAY));
        box.addView(rule, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, Ui.dp(a, 1))));
        for (String[] r : rows) box.addView(tableRow(r, weights, fg, false, endColumn));
    }

    private View tableRow(String[] cells, float[] weights, int color, boolean bold, int endColumn) {
        LinearLayout row = new LinearLayout(a);
        row.setPadding(0, Ui.dp(a, 3), 0, Ui.dp(a, 3));
        for (int i = 0; i < cells.length; i++) {
            TextView c = ToolPanels.label(a, cells[i] == null ? "" : cells[i], 12, color, bold);
            c.setPadding(0, 0, Ui.dp(a, 6), 0);
            if (i == endColumn) c.setGravity(Gravity.END);
            row.addView(c, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, weights[i]));
        }
        return row;
    }

    /** A field's text: a string, or a list joined by ", ". */
    private static String valueOf(JSONObject o, String key) {
        JSONArray arr = o.optJSONArray(key);
        return arr != null ? join(arr, ", ") : o.optString(key, "");
    }

    private static String join(JSONArray a, String sep) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < a.length(); i++) { if (i > 0) sb.append(sep); sb.append(a.optString(i)); }
        return sb.toString();
    }

    /** Hex in byte pairs ("70 0F 5A…"), for the records list. */
    private static String spaced(String hex) {
        StringBuilder sb = new StringBuilder(hex.length() * 3 / 2);
        for (int i = 0; i + 1 < hex.length(); i += 2) { if (i > 0) sb.append(' '); sb.append(hex, i, i + 2); }
        return sb.toString();
    }

    private static String sizeText(int n) {
        if (n < 1024) return n + " B";
        if (n < 1024 * 1024) return n < 10_240 ? String.format(java.util.Locale.ROOT, "%.1f kB", n / 1024.0) : (n / 1024) + " kB";
        return String.format(java.util.Locale.ROOT, "%.1f MB", n / 1024.0 / 1024.0);
    }

    private void addField(LinearLayout box, String label, String value, int color) {
        if (value == null || value.isEmpty()) return;
        box.addView(ToolPanels.label(a, label + ": " + value, 14, color, false));
    }

    /** The op buttons for the detected technology (from the shared catalogue). */
    private void buildOps(String tech) {
        opsBox.removeAllViews();
        LinearLayout rowv = null;
        int perRow = 2, i = 0;
        for (NfcCatalog.Op op : NfcCatalog.opsFor(tech)) {
            if (op.id.equals("scan") || op.id.equals("read-uid")) continue; // scan is the top button
            if (i % perRow == 0) { rowv = new LinearLayout(a); rowv.setPadding(0, Ui.dp(a, 4), 0, 0); opsBox.addView(rowv); }
            TextView b = ToolPanels.button(a, op.label, opIcon(op), false);
            b.setOnClickListener(v -> onOpClicked(tech, op, v));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
            lp.setMarginEnd(Ui.dp(a, 6));
            rowv.addView(b, lp);
            i++;
        }
    }

    private String opIcon(NfcCatalog.Op op) {
        if (op.id.equals("app-template")) return "square-arrow-down"; // a dropdown of APDU templates
        if (op.kind.equals("write")) return "pencil";
        if (op.kind.equals("emulate")) return "smartphone";
        return "eye";
    }

    /** Clicking an op: writes/UID/APDU gather input first, then arm and tap. */
    private void onOpClicked(String tech, NfcCatalog.Op op, android.view.View anchor) {
        switch (op.id) {
            case "app-template": showAppTemplates(anchor); return;
            case "m5-emulate": {
                byte[] c = lastContainerForEmulate;
                if (c == null) { a.flash("", app().t("nfc.m5.buildFirst"), "info"); a.showScreen("nfc.builder", true); }
                else emulateM5(c);
                return;
            }
            case "conn-emulate": emulateConnection(); return;
            case "m5-write": a.showScreen("nfc.builder", true); return;
            case "eid-read": case "mrtd-read": askMrtd(opts -> { armedMrtdOpts = opts; arm("eid-read"); }); return;
            case "raw-apdu": case "select-aid": askHex(app().t("nfc.apdu.prompt"), hex -> arm(op.id, -1, CardOps.unhex(hex))); return;
            case "ndef-write": askText(app().t("nfc.ndef.prompt"), t -> arm(op.id, -1, t.getBytes(StandardCharsets.UTF_8))); return;
            case "classic-write": askBlockHex(32, (blk, data) -> arm(op.id, blk, data)); return;
            case "ul-write": case "ntag-write": askBlockHex(8, (blk, data) -> arm(op.id, blk, data)); return;
            case "v-write": askBlockHex(8, (blk, data) -> arm(op.id, blk, data)); return;
            case "write-uid": askHex(app().t("nfc.uid.prompt"), hex -> arm(op.id, -1, CardOps.unhex(hex))); return;
            case "conn-write": prepareConnection(op.id); return; // 6.12: format 2, prepared before the tap
            default: arm(op.id); return;
        }
    }

    /* ------------------------------------------- 6.10 application templates */

    /** Text the screen shows of a view at most (Share gives the whole output). */
    private static final int SCREEN_MAX = 80_000;
    /** A text message's limit (Payloads takes 64 000); longer goes as a file. */
    private static final int MESSAGE_MAX = 60_000;
    /** The share sheet's text; longer goes as a file (a binder transaction has its limit). */
    private static final int SHARE_TEXT_MAX = 100_000;
    /** A note's inline file (the history keeps a data URL below 800 000 characters); larger goes to the vault. */
    private static final int NOTE_INLINE_MAX = 560 * 1024;

    private String t(String key) { return app().t(key); }

    private TemplateViews.Labels labels() { return this::t; }

    /**
     * 6.10: the "Application template" picker — m5mobile.define › apduTemplates
     * (the contract client/src/lib/nfc/apdu-templates.ts), grouped by the card
     * type each reads, with its note. A template with a problem (a bad command,
     * a command that is not a read — G-18) is listed, not runnable, and says
     * why; an older entry (≤ 6.9: command lines, one whole read) is marked.
     * Picking one runs ALL its steps on the next card.
     */
    private void showAppTemplates(android.view.View anchor) {
        JSONArray raw = app().define == null ? null : app().define.arr("apduTemplates");
        List<ApduTemplates.Template> all = ApduTemplates.parse(raw);
        if (all.isEmpty()) { a.flash("", t("nfc.tpl.none"), "info"); return; }
        LinearLayout list = new LinearLayout(a);
        list.setOrientation(LinearLayout.VERTICAL);
        list.setPadding(Ui.dp(a, 12), Ui.dp(a, 4), Ui.dp(a, 12), Ui.dp(a, 8));
        android.app.AlertDialog[] dialog = new android.app.AlertDialog[1];
        String[] groups = {ApduTemplates.EMV, ApduTemplates.EMRTD, ApduTemplates.DESFIRE, ApduTemplates.ISO7816, ""};
        for (String g : groups) {
            boolean head = false;
            for (ApduTemplates.Template tp : all) {
                String c = ApduTemplates.CARDS.contains(tp.cardType()) ? tp.cardType() : "";
                if (!c.equals(g)) continue;
                if (!head) { list.addView(sectionTitle(t("nfc.tpl.group." + (g.isEmpty() ? "other" : g)))); head = true; }
                list.addView(templateRow(tp, () -> { if (dialog[0] != null) dialog[0].dismiss(); pickTemplate(tp); }));
            }
        }
        ScrollView sv = new ScrollView(a);
        sv.addView(list);
        dialog[0] = new android.app.AlertDialog.Builder(a).setTitle(t("nfc.tpl.title")).setView(sv).setNegativeButton(t("nav.close"), null).create();
        dialog[0].show();
    }

    /** One template in the picker: its label, its note, how many steps (or that it is an older entry), and why it cannot run. */
    private View templateRow(ApduTemplates.Template tp, Runnable pick) {
        int fg = Ui.color(a, "@onSurface", Color.BLACK), muted = Ui.color(a, "@muted", Color.GRAY), danger = Ui.color(a, "@danger", 0xFFdc2626);
        LinearLayout row = new LinearLayout(a);
        row.setOrientation(LinearLayout.VERTICAL);
        row.setPadding(Ui.dp(a, 10), Ui.dp(a, 8), Ui.dp(a, 10), Ui.dp(a, 8));
        row.addView(ToolPanels.label(a, tp.label, 15, fg, true));
        if (!tp.note.isEmpty()) row.addView(ToolPanels.label(a, tp.note, 12, muted, false));
        String meta = tp.legacy == null ? t("nfc.tpl.steps").replace("{0}", String.valueOf(tp.steps.size()))
            : t("op".equals(tp.legacy) ? "nfc.tpl.legacyOp" : "nfc.tpl.legacy");
        row.addView(ToolPanels.label(a, meta, 11, muted, false));
        if (!tp.runnable()) {
            String why = tp.problems.isEmpty() ? "—" : String.join("; ", tp.problems);
            row.addView(ToolPanels.label(a, t("nfc.tpl.cantRun").replace("{0}", why), 12, danger, false));
            row.setAlpha(0.6f);
            row.setEnabled(false);
        } else {
            row.setBackground(Ui.ripple(Ui.shape(Color.TRANSPARENT, Ui.dp(a, 12), 0, 0), Ui.alpha(Ui.color(a, "@primary", Color.BLUE), 0.2f)));
            row.setOnClickListener(v -> pick.run());
        }
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = Ui.dp(a, 2);
        row.setLayoutParams(lp);
        return row;
    }

    /** An e-ID template asks the holder's key first (its args preset what to read); the others wait for the card. */
    private void pickTemplate(ApduTemplates.Template tp) {
        ApduTemplates.Step eid = tp.eidRead();
        if (eid != null) {
            askMrtd(eid.args.optBoolean("readPhoto", true), eid.args.optBoolean("all", true), opts -> startTemplate(tp, opts));
            return;
        }
        startTemplate(tp, null);
    }

    /** On a permitted USB reader the template runs at once; on the phone's antenna with the next card. */
    private void startTemplate(ApduTemplates.Template tp, MrtdReader.Options opts) {
        armedTemplate = tp;
        armedMrtdOpts = opts;
        if (NfcCatalog.READER_USB.equals(app().settings.str("nfc.reader"))) {
            UsbReader u = cz.m5cet.app.nfc.ModelNfcDevice.permittedUsb(a);
            if (u != null) { runTemplateOnUsb(u, tp, opts); return; }
        }
        arm("app-template");
        refreshStatus(tp.label + " — " + t("nfc.tpl.hold"));
    }

    /** On the NFC thread: the card's ISO-DEP, every step of the armed template. */
    private void runTemplateOnTag(Tag tag, JSONObject card) throws IOException {
        ApduTemplates.Template tp = armedTemplate;
        if (tp == null) { showCard(card, null); return; }
        android.nfc.tech.IsoDep iso = android.nfc.tech.IsoDep.get(tag);
        if (iso == null) { showCard(card, null); refreshStatus(t("nfc.tpl.noIsoDep")); return; }
        iso.connect();
        try {
            // A deep read is a few hundred APDUs; give each one time.
            iso.setTimeout(5000);
            runTemplate(tp, armedMrtdOpts, iso::transceive, card);
        } finally {
            try { iso.close(); } catch (IOException ignored) { }
        }
        // The output stays on the screen: the next card is a new scan.
        scanning = false;
    }

    private void runTemplateOnUsb(UsbReader u, ApduTemplates.Template tp, MrtdReader.Options opts) {
        refreshStatus(t("nfc.tpl.usb"));
        Io.bg(() -> {
            try {
                if (!u.connect()) { refreshStatus(t("nfc.tpl.noCard")); return; }
                JSONObject card = new JSONObject().put("label", u.name());
                byte[] atr = u.atr();
                if (atr != null && atr.length > 0) card.put("atr", Apdu.hex(atr));
                runTemplate(tp, opts, u::transceive, card);
            } catch (IOException | org.json.JSONException e) {
                refreshStatus("⚠ " + (e.getMessage() == null ? "error" : e.getMessage()));
            } finally {
                u.disconnect();
            }
        });
    }

    /** Runs every step (on the caller's thread — never the UI's), with the progress on the screen, then shows the output. */
    private void runTemplate(ApduTemplates.Template tp, MrtdReader.Options opts, Apdu.Transceiver card, JSONObject cardInfo) {
        TemplateRunner runner = new TemplateRunner(tp).mrtd(opts).listener(new TemplateRunner.Listener() {
            @Override public void onStep(int n, int total, String label) { Io.main(() -> progress(n, total, label)); }
            @Override public void onExchange(TemplateRunner.Exchange e) { }
        });
        running = runner;
        Io.main(() -> showProgress(tp));
        TemplateRunner.Result r = runner.run(card);
        r.cardInfo = cardInfo;
        running = null;
        armedTemplate = null;
        Io.main(() -> {
            lastRun = r;
            outView = TemplateViews.READABLE;
            fullPan = false;
            showRun();
        });
    }

    private void showProgress(ApduTemplates.Template tp) {
        result.removeAllViews();
        opsBox.removeAllViews();
        int fg = Ui.color(a, "@onSurface", Color.BLACK), muted = Ui.color(a, "@muted", Color.GRAY);
        LinearLayout box = cardBox();
        box.addView(ToolPanels.label(a, tp.label, 16, fg, true));
        progressText = ToolPanels.label(a, "…", 13, muted, false);
        progressText.setPadding(0, Ui.dp(a, 4), 0, 0);
        box.addView(progressText);
        TextView cancel = ToolPanels.button(a, t("nfc.tpl.cancel"), "x", false);
        cancel.setOnClickListener(v -> { TemplateRunner r = running; if (r != null) r.cancel(); v.setEnabled(false); v.setAlpha(0.5f); });
        LinearLayout.LayoutParams cl = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        cl.topMargin = Ui.dp(a, 10);
        box.addView(cancel, cl);
        result.addView(box);
    }

    private void progress(int n, int total, String label) {
        String s = t("nfc.tpl.running").replace("{0}", String.valueOf(n)).replace("{1}", String.valueOf(total)).replace("{2}", label);
        if (progressText != null) progressText.setText(s);
        status.setText(s);
    }

    /** How the run went, in one line. */
    private String runSummary(TemplateRunner.Result r) {
        String sym = "error".equals(r.status()) ? "✗ " : "warn".equals(r.status()) ? "⚠ " : "✓ ";
        if (r.cancelled) return sym + t("nfc.tpl.cancelled");
        if (r.error != null) return sym + t("nfc.tpl.failed").replace("{0}", r.error);
        return sym + t("nfc.tpl.done").replace("{0}", String.valueOf(r.exchanges.size())).replace("{1}", cz.m5cet.app.core.Formats.decimal(app().lang(), r.ms / 1000.0, 1)); // 6.13: 1,5 s in cs
    }

    /**
     * The output of a run: the template and how it went, the three icons
     * (Share, Forward to a user, Keep for myself), the switch of the views (in
     * / out · raw · JSON · readable) and the view — card numbers masked unless
     * the user turns on the full data (G-19).
     */
    private void showRun() {
        TemplateRunner.Result r = lastRun;
        if (r == null) return;
        result.removeAllViews();
        opsBox.removeAllViews();
        int fg = Ui.color(a, "@onSurface", Color.BLACK), muted = Ui.color(a, "@muted", Color.GRAY);
        int statusColor = "error".equals(r.status()) ? Ui.color(a, "@danger", 0xFFdc2626) : "warn".equals(r.status()) ? Ui.color(a, "@warning", 0xFFb45309) : Ui.color(a, "@success", 0xFF2e7d32);
        LinearLayout head = cardBox();
        LinearLayout top = new LinearLayout(a);
        top.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout col = new LinearLayout(a);
        col.setOrientation(LinearLayout.VERTICAL);
        col.addView(ToolPanels.label(a, r.label, 16, fg, true));
        col.addView(ToolPanels.label(a, runSummary(r), 12, statusColor, false));
        top.addView(col, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        top.addView(iconButton("share-2", t("nfc.out.share"), v -> shareOutput()));
        top.addView(iconButton("forward", t("nfc.out.forward"), v -> forwardOutput()));
        top.addView(iconButton("lock", t("nfc.out.toMyself"), v -> keepForMyself()));
        head.addView(top);
        LinearLayout.LayoutParams sl = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        sl.topMargin = Ui.dp(a, 12);
        head.addView(viewSwitch(), sl);
        if (TemplateViews.masks(r)) {
            CheckBox full = new CheckBox(a);
            full.setText(t("nfc.out.fullPan"));
            full.setTextColor(fg);
            full.setChecked(fullPan);
            full.setOnCheckedChangeListener((b, on) -> { fullPan = on; showRun(); });
            head.addView(full);
            if (!fullPan) head.addView(ToolPanels.label(a, t("nfc.out.masked"), 12, muted, false));
        }
        result.addView(head);
        drawView(result, r);
        refreshStatus(runSummary(r));
    }

    /** The four views as a segmented switch (the design's colours); readable after a run. */
    private View viewSwitch() {
        int primary = Ui.color(a, "@primary", Color.BLUE);
        LinearLayout seg = new LinearLayout(a);
        seg.setPadding(Ui.dp(a, 3), Ui.dp(a, 3), Ui.dp(a, 3), Ui.dp(a, 3));
        seg.setBackground(Ui.shape(Ui.color(a, "@surfaceVariant", Color.LTGRAY), Ui.dp(a, 999), 0, 0));
        String[][] views = {{TemplateViews.IO, "nfc.out.io"}, {TemplateViews.RAW, "nfc.out.raw"}, {TemplateViews.JSON, "nfc.out.json"}, {TemplateViews.READABLE, "nfc.out.readable"}};
        for (String[] v : views) {
            boolean on = v[0].equals(outView);
            TextView b = new TextView(a);
            b.setText(t(v[1]));
            b.setGravity(Gravity.CENTER);
            b.setSingleLine(true);
            b.setEllipsize(android.text.TextUtils.TruncateAt.END);
            b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            b.setTypeface(on ? Typeface.DEFAULT_BOLD : Typeface.DEFAULT);
            b.setTextColor(on ? Ui.color(a, "@onPrimary", Color.WHITE) : Ui.color(a, "@onSurface", Color.BLACK));
            b.setPadding(Ui.dp(a, 4), Ui.dp(a, 8), Ui.dp(a, 4), Ui.dp(a, 8));
            b.setBackground(on ? Ui.shape(primary, Ui.dp(a, 999), 0, 0) : Ui.ripple(Ui.shape(Color.TRANSPARENT, Ui.dp(a, 999), 0, 0), Ui.alpha(primary, 0.2f)));
            b.setSelected(on);
            b.setContentDescription(t(v[1]));
            b.setOnClickListener(x -> { if (!v[0].equals(outView)) { outView = v[0]; showRun(); } });
            seg.addView(b, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        }
        return seg;
    }

    /** An icon that acts on the output (its name as the description and the tooltip). */
    private View iconButton(String icon, String desc, View.OnClickListener l) {
        int primary = Ui.color(a, "@primary", Color.BLUE);
        ImageView iv = new ImageView(a);
        iv.setImageDrawable(Icons.drawable(a, icon, Ui.dp(a, 22), primary));
        iv.setScaleType(ImageView.ScaleType.CENTER);
        iv.setContentDescription(desc);
        iv.setTooltipText(desc);
        iv.setBackground(Ui.ripple(Ui.shape(Ui.alpha(primary, 0.12f), Ui.dp(a, 999), 0, 0), Ui.alpha(primary, 0.25f)));
        iv.setOnClickListener(l);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(Ui.dp(a, 42), Ui.dp(a, 42));
        lp.setMarginStart(Ui.dp(a, 6));
        iv.setLayoutParams(lp);
        return iv;
    }

    /** The current view: readable draws the EMV applications and the e-ID natively (the face beside the holder) above the rest as text. */
    private void drawView(LinearLayout into, TemplateRunner.Result r) {
        int fg = Ui.color(a, "@onSurface", Color.BLACK), muted = Ui.color(a, "@muted", Color.GRAY);
        if (!TemplateViews.READABLE.equals(outView)) {
            if (r.exchanges.isEmpty()) { LinearLayout b = cardBox(); b.addView(ToolPanels.label(a, t("nfc.out.empty"), 13, muted, false)); into.addView(b); return; }
            into.addView(textBox(TemplateViews.view(outView, r, labels(), fullPan), fg, muted));
            return;
        }
        if (r.emv != null) {
            JSONObject emv = fullPan ? r.emv : TemplateViews.maskedEmv(r.emv, TemplateViews.pans(r));
            JSONArray apps = emv.optJSONArray("apps");
            if (apps != null) for (int i = 0; i < apps.length(); i++) { JSONObject x = apps.optJSONObject(i); if (x != null) into.addView(emvApp(x, fg, muted)); }
        }
        if (r.mrtd != null) drawMrtd(into, r.mrtd, fg, muted);
        into.addView(textBox(TemplateViews.readable(r, labels(), false, fullPan), fg, muted));
    }

    /** Monospaced, selectable text — at most {@link #SCREEN_MAX} characters on the screen. */
    private View textBox(String text, int fg, int muted) {
        LinearLayout b = cardBox();
        boolean cut = text.length() > SCREEN_MAX;
        TextView tv = mono(cut ? text.substring(0, SCREEN_MAX) + "\n…" : text, 11.5f, fg);
        tv.setTextIsSelectable(true);
        b.addView(tv);
        if (cut) b.addView(ToolPanels.label(a, t("nfc.out.truncated"), 12, muted, false));
        return b;
    }

    /** The current view's text, as shared (masked unless the full data is on). */
    private String outputText(TemplateRunner.Result r) { return TemplateViews.view(outView, r, labels(), fullPan); }

    /** A file name for the output: nfc-<template>-<date>. */
    private static String fileBase(TemplateRunner.Result r) {
        String base = r.label.toLowerCase(java.util.Locale.ROOT).replaceAll("[^a-z0-9]+", "-").replaceAll("^-+|-+$", "");
        if (base.length() > 40) base = base.substring(0, 40).replaceAll("-+$", "");
        String when = new java.text.SimpleDateFormat("yyyyMMdd-HHmmss", java.util.Locale.ROOT).format(new java.util.Date());
        return "nfc-" + (base.isEmpty() ? "card" : base) + "-" + when;
    }

    /** Share: the system share sheet — the text, or the JSON (and a very long text) as a file served from memory, never written to the disk. */
    private void shareOutput() {
        TemplateRunner.Result r = lastRun;
        if (r == null) return;
        String text = outputText(r);
        boolean json = TemplateViews.JSON.equals(outView);
        try {
            if (json || text.length() > SHARE_TEXT_MAX) {
                String name = fileBase(r) + (json ? ".json" : ".txt");
                String mime = json ? "application/json" : "text/plain";
                android.net.Uri uri = cz.m5cet.app.ui.media.VaultMedia.memoryUri(app(), name, mime, text.getBytes(StandardCharsets.UTF_8));
                android.content.Intent i = new android.content.Intent(android.content.Intent.ACTION_SEND).setType(mime)
                    .putExtra(android.content.Intent.EXTRA_STREAM, uri).putExtra(android.content.Intent.EXTRA_SUBJECT, r.label)
                    .addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
                i.setClipData(android.content.ClipData.newRawUri(name, uri));
                a.startActivity(android.content.Intent.createChooser(i, name));
            } else {
                android.content.Intent i = new android.content.Intent(android.content.Intent.ACTION_SEND).setType("text/plain")
                    .putExtra(android.content.Intent.EXTRA_TEXT, text).putExtra(android.content.Intent.EXTRA_SUBJECT, r.label);
                a.startActivity(android.content.Intent.createChooser(i, t("nfc.out.share")));
            }
        } catch (RuntimeException e) {
            a.flash("", t("file.noApp"), "warn");
        }
    }

    /**
     * Forward to a user: the chat's own forward (Parts.forward — a room, then
     * everyone there or one member) with the output as the message: the text,
     * or the JSON (and a text too long for a message) as a file — inline when
     * small, else through the vault (a transfer goes to the whole room).
     */
    private void forwardOutput() {
        TemplateRunner.Result r = lastRun;
        if (r == null) return;
        String text = outputText(r);
        boolean json = TemplateViews.JSON.equals(outView);
        ChatMessage m = new ChatMessage();
        m.id = "nfc-" + Long.toString(System.nanoTime(), 36);
        m.senderName = "NFC";
        m.forwardedFrom = "NFC · " + r.label;
        if (!json && text.length() <= MESSAGE_MAX) {
            m.text = text;
            a.parts.forward(m);
            return;
        }
        if (!json) a.flash("", t("nfc.out.asFile"), "info");
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        m.text = r.label;
        m.fileName = fileBase(r) + (json ? ".json" : ".txt");
        m.fileMime = Payloads.safeMime(json ? "application/json" : "text/plain");
        m.fileSize = bytes.length;
        if (bytes.length <= Composer.INLINE_MAX) {
            m.fileDataUrl = "data:" + m.fileMime + ";base64," + Base64.encodeToString(bytes, Base64.NO_WRAP);
            a.parts.forward(m);
            return;
        }
        Io.bg(() -> {
            try {
                String id = "out-" + System.nanoTime();
                try (cz.m5cet.app.security.FileVault.Writer w = new cz.m5cet.app.security.FileVault.Writer(app(), id)) { w.write(bytes, 0, bytes.length); }
                m.filePath = id;
                Io.main(() -> a.parts.forward(m));
            } catch (Exception e) {
                Io.main(() -> a.flash("", e.getMessage(), "error"));
            }
        });
    }

    /**
     * Keep for myself: a note in the current room's history — visible only on
     * this device, never sent (RoomSession.addNote, kind "note"): the text, or
     * the JSON (and a long text) as its file.
     */
    private void keepForMyself() {
        TemplateRunner.Result r = lastRun;
        if (r == null) return;
        RoomSession room = app().rooms.activeSession();
        if (room == null) { a.flash("", t("nfc.out.noRoom"), "warn"); return; }
        String text = outputText(r);
        boolean json = TemplateViews.JSON.equals(outView);
        String head = "🔒 " + t("nfc.out.noteHead") + " · " + r.label;
        String me = t("nfc.out.me");
        if (!json && text.length() <= MESSAGE_MAX) {
            room.addNote(head + "\n\n" + text, null, null, null, null, 0, me);
            a.flash("", t("nfc.out.noted").replace("{0}", room.label), "success");
            return;
        }
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        String name = fileBase(r) + (json ? ".json" : ".txt");
        String mime = Payloads.safeMime(json ? "application/json" : "text/plain");
        if (bytes.length <= NOTE_INLINE_MAX) {
            room.addNote(head, name, mime, "data:" + mime + ";base64," + Base64.encodeToString(bytes, Base64.NO_WRAP), null, bytes.length, me);
            a.flash("", t("nfc.out.noted").replace("{0}", room.label), "success");
            return;
        }
        Io.bg(() -> {
            try {
                String id = "note-" + System.nanoTime();
                try (cz.m5cet.app.security.FileVault.Writer w = new cz.m5cet.app.security.FileVault.Writer(app(), id)) { w.write(bytes, 0, bytes.length); }
                room.addNote(head, name, mime, null, id, bytes.length, me);
                Io.main(() -> a.flash("", t("nfc.out.noted").replace("{0}", room.label), "success"));
            } catch (Exception e) {
                Io.main(() -> a.flash("", e.getMessage(), "error"));
            }
        });
    }

    private byte[] lastContainerForEmulate;

    /* --------------------------------------------------------------- dialogs */

    private interface OnText { void run(String s); }
    private interface OnBlock { void run(int block, byte[] data); }
    private interface OnMrtd { void run(MrtdReader.Options opts); }

    /**
     * The e-ID / MRTD access dialog: the BAC key (document number + DOB + expiry)
     * or a pasted MRZ, and / or the CAN printed on the document (PACE), with the
     * "read photo" and "every data group" toggles.
     */
    private void askMrtd(OnMrtd cb) { askMrtd(true, true, cb); }

    /** 6.10: an e-ID template's args preset what to read (the photo, every group); the holder may change it. */
    private void askMrtd(boolean photoOn, boolean allOn, OnMrtd cb) {
        EditText doc = new EditText(a); doc.setHint(app().t("nfc.eid.docNumber")); doc.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        EditText dob = new EditText(a); dob.setHint(app().t("nfc.eid.dob")); dob.setInputType(InputType.TYPE_CLASS_NUMBER);
        EditText exp = new EditText(a); exp.setHint(app().t("nfc.eid.expiry")); exp.setInputType(InputType.TYPE_CLASS_NUMBER);
        EditText can = new EditText(a); can.setHint(app().t("nfc.eid.can")); can.setInputType(InputType.TYPE_CLASS_NUMBER);
        EditText mrz = new EditText(a); mrz.setHint(app().t("nfc.eid.mrz")); mrz.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS); mrz.setMinLines(2);
        CheckBox photo = new CheckBox(a); photo.setText(app().t("nfc.eid.photo")); photo.setChecked(photoOn); photo.setTextColor(Ui.color(a, "@onSurface", Color.BLACK));
        CheckBox all = new CheckBox(a); all.setText(app().t("nfc.eid.all")); all.setChecked(allOn); all.setTextColor(Ui.color(a, "@onSurface", Color.BLACK));
        LinearLayout l = new LinearLayout(a); l.setOrientation(LinearLayout.VERTICAL); l.setPadding(Ui.dp(a, 20), Ui.dp(a, 8), Ui.dp(a, 20), 0);
        l.addView(doc); l.addView(dob); l.addView(exp); l.addView(mrz); l.addView(can); l.addView(photo); l.addView(all);
        ScrollView sv = new ScrollView(a); sv.addView(l);
        SecureDialog.show(a, new android.app.AlertDialog.Builder(a).setTitle(app().t("nfc.eid.title")).setView(sv) // 6.7 N18: MRZ / CAN
            .setPositiveButton(app().t("nfc.eid.read"), (d, w) -> {
                MrtdReader.Options o = new MrtdReader.Options();
                String mrzText = mrz.getText().toString().trim();
                String canText = can.getText().toString().trim();
                if (!canText.isEmpty()) o.can = canText;
                if (!mrzText.isEmpty()) o.mrz = mrzText;
                else {
                    String dn = doc.getText().toString().trim(), db = dob.getText().toString().trim(), ex = exp.getText().toString().trim();
                    boolean anyKey = !dn.isEmpty() || !db.isEmpty() || !ex.isEmpty();
                    // The CAN alone opens a PACE document; otherwise the three BAC fields are needed.
                    if ((anyKey || canText.isEmpty()) && (dn.isEmpty() || db.isEmpty() || ex.isEmpty())) { a.flash("", app().t("nfc.eid.needKey"), "warn"); return; }
                    if (anyKey) o.key = new cz.m5cet.app.nfc.Bac.MrzKey(dn, db, ex);
                }
                o.readPhoto = photo.isChecked();
                o.all = all.isChecked();
                cb.run(o);
            })
            .setNegativeButton(app().t("nav.close"), null));
    }

    private void askText(String title, OnText cb) {
        EditText e = new EditText(a);
        new android.app.AlertDialog.Builder(a).setTitle(title).setView(pad(e))
            .setPositiveButton("OK", (d, w) -> cb.run(e.getText().toString()))
            .setNegativeButton(app().t("nav.close"), null).show();
    }

    private void askHex(String title, OnText cb) {
        EditText e = new EditText(a);
        e.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        new android.app.AlertDialog.Builder(a).setTitle(title).setView(pad(e))
            .setPositiveButton("OK", (d, w) -> { String h = e.getText().toString().replaceAll("[^0-9A-Fa-f]", ""); if ((h.length() & 1) == 0 && !h.isEmpty()) cb.run(h); else a.flash("", app().t("nfc.hex.bad"), "warn"); })
            .setNegativeButton(app().t("nav.close"), null).show();
    }

    private void askBlockHex(int hexLen, OnBlock cb) {
        EditText blk = new EditText(a); blk.setHint(app().t("nfc.block.no")); blk.setInputType(InputType.TYPE_CLASS_NUMBER);
        EditText data = new EditText(a); data.setHint(app().t("nfc.block.data") + " (" + hexLen + " hex)"); data.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        LinearLayout l = new LinearLayout(a); l.setOrientation(LinearLayout.VERTICAL); l.setPadding(Ui.dp(a, 20), Ui.dp(a, 8), Ui.dp(a, 20), 0);
        l.addView(blk); l.addView(data);
        new android.app.AlertDialog.Builder(a).setTitle(app().t("nfc.write.title")).setView(l)
            .setPositiveButton("OK", (d, w) -> {
                String h = data.getText().toString().replaceAll("[^0-9A-Fa-f]", "");
                int b; try { b = Integer.parseInt(blk.getText().toString().trim()); } catch (NumberFormatException e) { a.flash("", app().t("nfc.block.no"), "warn"); return; }
                if (h.length() != hexLen) { a.flash("", app().t("nfc.hex.bad"), "warn"); return; }
                cb.run(b, CardOps.unhex(h));
            })
            .setNegativeButton(app().t("nav.close"), null).show();
    }

    private LinearLayout pad(View v) {
        LinearLayout l = new LinearLayout(a);
        l.setPadding(Ui.dp(a, 20), Ui.dp(a, 8), Ui.dp(a, 20), 0);
        l.addView(v, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return l;
    }

    @Override protected void onDetachedFromWindow() {
        stopScan();
        super.onDetachedFromWindow();
    }

    @Override public void bindSlot(Expr.Scope scope) { }
}
