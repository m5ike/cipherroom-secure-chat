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

import java.nio.charset.StandardCharsets;
import java.util.List;

import cz.m5cet.app.M5;
import cz.m5cet.app.chat.RoomSession;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.nfc.CardOps;
import cz.m5cet.app.nfc.CardService;
import cz.m5cet.app.nfc.InternalReader;
import cz.m5cet.app.nfc.M5Card;
import cz.m5cet.app.nfc.MrtdReader;
import cz.m5cet.app.nfc.Nfc;
import cz.m5cet.app.nfc.NfcCatalog;
import cz.m5cet.app.nfc.Records;
import cz.m5cet.app.nfc.TagTech;
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
            case "emv-read": showEmv(card, CardOps.emvRead(tag, 4)); return;
            case "eid-read": case "mrtd-read": {
                MrtdReader.Options o = armedMrtdOpts != null ? armedMrtdOpts : new MrtdReader.Options();
                showMrtd(card, CardOps.eidRead(tag, o));
                return;
            }
            case "write-uid": if (armedArg != null) { CardOps.writeUid(tag, armedArg, keys()); out.put("done", app().t("nfc.done.uid")); } else out.put("note", app().t("nfc.uid.need")); break;
            case "m5-read": openM5Records(container); return;
            case "conn-read": openConnection(conn); return;
            case "conn-write": writeConnection(tag); out.put("done", app().t("nfc.done.written")); break;
            default: out.put("note", app().t("nfc.op.unsupported")); break;
        }
        final JSONObject shown = out;
        showCard(card, shown);
    }

    /* ---------------------------------------------------------- connection */

    private JSONObject connectionOnTag(Tag tag) {
        try {
            Ndef ndef = Ndef.get(tag);
            if (ndef == null) return null;
            ndef.connect();
            try {
                NdefMessage msg = ndef.getNdefMessage();
                if (msg == null) return null;
                for (NdefRecord r : msg.getRecords()) {
                    String type = new String(r.getType(), StandardCharsets.US_ASCII);
                    if (Nfc.MIME.equals(type)) {
                        String blob = new String(r.getPayload(), StandardCharsets.UTF_8);
                        JSONObject o = new JSONObject().put("blob", blob);
                        String p = pinText();
                        if (Nfc.validPin(p)) { JSONObject opened = Nfc.open(blob, p); if (opened != null) o.put("room", opened); }
                        return o;
                    }
                }
            } finally { try { ndef.close(); } catch (Exception ignored) { } }
        } catch (Exception ignored) { }
        return null;
    }

    private void openConnection(JSONObject conn) {
        Io.main(() -> {
            if (conn == null) { refreshStatus(app().t("nfc.conn.none")); return; }
            JSONObject room = conn.optJSONObject("room");
            if (room == null) { refreshStatus(app().t("nfc.wrongPin")); return; }
            showCard(null, null);
            LinearLayout card = cardBox();
            card.addView(ToolPanels.label(a, app().t("nfc.card"), 12, Ui.color(a, "@muted", Color.GRAY), false));
            card.addView(ToolPanels.label(a, room.optString("room"), 18, Ui.color(a, "@onSurface", Color.BLACK), true));
            TextView join = ToolPanels.button(a, app().t("nfc.join"), "log-in", true);
            join.setOnClickListener(v -> a.finishJoin(room.optString("room"), room.optString("passphrase"), room.optString("name", "")));
            LinearLayout.LayoutParams jl = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            jl.topMargin = Ui.dp(a, 8);
            card.addView(join, jl);
            result.addView(card);
        });
    }

    private void writeConnection(Tag tag) throws Exception {
        String p = pinText();
        if (!Nfc.validPin(p)) throw new Exception(app().t("nfc.pin"));
        RoomSession r = app().rooms.activeSession();
        JSONObject card = r == null ? null : app().rooms.cardOf(r.key);
        if (card == null) throw new Exception(app().t("rooms.empty"));
        try { card.put("app", cz.m5cet.app.BuildConfig.VERSION_NAME); } catch (Exception ignored) { }
        CardOps.ndefWriteAny(tag, Nfc.message(Nfc.seal(card, p)), keys());
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
                new android.app.AlertDialog.Builder(a).setTitle(app().t("nfc.rec.wifi")).setMessage(sb.toString())
                    .setPositiveButton(app().t("nfc.wifi.settings"), (di, w) -> { try { a.startActivity(new android.content.Intent(android.provider.Settings.ACTION_WIFI_SETTINGS)); } catch (RuntimeException e) { a.flash("", app().t("file.noApp"), "warn"); } })
                    .setNeutralButton(app().t("msg.copy"), (di, w) -> a.copy(d.optString("password")))
                    .setNegativeButton(app().t("nav.close"), null).show();
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

    void emulateConnection() {
        try {
            String p = pinText();
            RoomSession r = app().rooms.activeSession();
            JSONObject card = r == null ? null : app().rooms.cardOf(r.key);
            if (card == null || !Nfc.validPin(p)) { a.flash("", app().t("nfc.pin"), "warn"); return; }
            card.put("app", cz.m5cet.app.BuildConfig.VERSION_NAME);
            CardService.serveConnection(Nfc.message(Nfc.seal(card, p)));
            refreshStatus(app().t("nfc.emulating"));
        } catch (Exception e) { a.flash("", e.getMessage(), "warn"); }
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

    /* ------------------------------------------------------- 6.5 EMV / e-ID */

    /** The EMV read result: parsed holder fields per application and a scrollable tag list. */
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
                if (app == null) continue;
                LinearLayout box = cardBox();
                String head = app.optString("scheme", app.optString("label", app.optString("aid", "")));
                box.addView(ToolPanels.label(a, head, 16, fg, true));
                if (!app.optString("label", "").isEmpty() && !app.optString("label").equals(head)) box.addView(ToolPanels.label(a, app.optString("label"), 13, muted, false));
                addField(box, "PAN", app.optString("panMasked", app.optString("pan", "")), fg);
                addField(box, app().t("nfc.emv.expiry"), app.optString("expiry", ""), fg);
                addField(box, app().t("nfc.emv.cardholder"), app.optString("cardholder", ""), fg);
                addField(box, app().t("nfc.emv.effective"), app.optString("effective", ""), fg);
                addField(box, app().t("nfc.emv.issuer"), app.optString("issuerCountry", ""), fg);
                if (app.has("atc")) addField(box, "ATC", String.valueOf(app.optInt("atc")), fg);
                if (app.has("pinTryCounter")) addField(box, app().t("nfc.emv.ptc"), String.valueOf(app.optInt("pinTryCounter")), fg);
                addField(box, "AID", app.optString("aid", ""), muted);
                JSONArray tags = app.optJSONArray("tags");
                if (tags != null && tags.length() > 0) {
                    box.addView(ToolPanels.label(a, app().t("nfc.emv.tags") + " (" + tags.length() + ")", 12, muted, false));
                    for (int j = 0; j < tags.length(); j++) {
                        JSONObject tg = tags.optJSONObject(j);
                        if (tg == null) continue;
                        TextView row = ToolPanels.label(a, tg.optString("tag") + "  " + tg.optString("name") + ": " + tg.optString("value"), 12, muted, false);
                        row.setTypeface(Typeface.MONOSPACE);
                        box.addView(row);
                    }
                }
                result.addView(box);
            }
            LinearLayout note = cardBox();
            note.addView(ToolPanels.label(a, app().t("nfc.readonly.help"), 12, muted, false));
            result.addView(note);
        });
    }

    /** The e-ID / MRTD read result: the MRZ fields, the data groups and the face. */
    private void showMrtd(JSONObject card, JSONObject mrtd) {
        Io.main(() -> {
            result.removeAllViews();
            opsBox.removeAllViews();
            int fg = Ui.color(a, "@onSurface", Color.BLACK), muted = Ui.color(a, "@muted", Color.GRAY);
            if (card != null) drawCardInfo(card);
            refreshStatus(MrtdReader.summary(mrtd));
            LinearLayout box = cardBox();
            JSONObject m = mrtd.optJSONObject("mrzInfo");
            if (m == null) {
                box.addView(ToolPanels.label(a, app().t("nfc.eid.title"), 16, fg, true));
                box.addView(ToolPanels.label(a, mrtd.optString("message", MrtdReader.summary(mrtd)), 13, muted, false));
            } else {
                String name = (m.optString("givenNames", "") + " " + m.optString("surname", "")).trim();
                box.addView(ToolPanels.label(a, name.isEmpty() ? app().t("nfc.eid.title") : name, 16, fg, true));
                addField(box, app().t("nfc.eid.docNumber"), m.optString("documentNumber", ""), fg);
                addField(box, app().t("nfc.eid.nationality"), m.optString("nationality", ""), fg);
                addField(box, app().t("nfc.eid.issuer"), m.optString("issuer", ""), fg);
                addField(box, app().t("nfc.eid.dobLabel"), m.optString("dateOfBirth", ""), fg);
                addField(box, app().t("nfc.eid.sex"), m.optString("sex", ""), fg);
                addField(box, app().t("nfc.eid.expiryLabel"), m.optString("dateOfExpiry", ""), fg);
            }
            JSONArray dg = mrtd.optJSONArray("dataGroups");
            if (dg != null && dg.length() > 0) {
                StringBuilder sb = new StringBuilder();
                for (int i = 0; i < dg.length(); i++) sb.append(i > 0 ? ", " : "").append(dg.optString(i));
                addField(box, app().t("nfc.eid.dataGroups"), sb.toString(), muted);
            }
            result.addView(box);
            // The face, where DG2 carried one.
            String photo = mrtd.optString("photo", "");
            if (!photo.isEmpty()) {
                String mime = mrtd.optString("photoMime", "");
                Bitmap bmp = null;
                try { byte[] img = Base64.decode(photo, Base64.DEFAULT); bmp = BitmapFactory.decodeByteArray(img, 0, img.length); } catch (RuntimeException ignored) { }
                LinearLayout pb = cardBox();
                pb.addView(ToolPanels.label(a, app().t("nfc.eid.photo"), 12, muted, false));
                if (bmp != null) {
                    ImageView iv = new ImageView(a);
                    iv.setImageBitmap(bmp);
                    iv.setAdjustViewBounds(true);
                    LinearLayout.LayoutParams ip = new LinearLayout.LayoutParams(Ui.dp(a, 140), ViewGroup.LayoutParams.WRAP_CONTENT);
                    ip.topMargin = Ui.dp(a, 6);
                    pb.addView(iv, ip);
                } else {
                    // A JPEG 2000 face may not decode on Android — show the fields and note the format.
                    pb.addView(ToolPanels.label(a, app().t("nfc.eid.photoFormat").replace("{0}", mime.isEmpty() ? "?" : mime), 13, fg, false));
                }
                result.addView(pb);
            }
            LinearLayout note = cardBox();
            note.addView(ToolPanels.label(a, app().t("nfc.readonly.help"), 12, muted, false));
            result.addView(note);
        });
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
            default: arm(op.id); return;
        }
    }

    /**
     * 6.3: the "Application template" dropdown — a menu of the operator's saved APDU
     * application templates (m5mobile.define › apduTemplates), each an object
     * { label, apdu } with apdu a hex string. Picking one arms and sends it like
     * Select application (a SELECT/APDU over ISO-DEP) and shows the response.
     */
    private void showAppTemplates(android.view.View anchor) {
        org.json.JSONArray tpls = app().define == null ? null : app().define.arr("apduTemplates");
        if (tpls == null || tpls.length() == 0) { a.flash("", app().t("nfc.tpl.none"), "info"); return; }
        android.widget.PopupMenu menu = new android.widget.PopupMenu(a, anchor);
        for (int i = 0; i < tpls.length(); i++) {
            org.json.JSONObject t = tpls.optJSONObject(i);
            String label = t == null ? "" : t.optString("label", t.optString("name", ""));
            menu.getMenu().add(0, i, i, label.isEmpty() ? "APDU " + (i + 1) : label);
        }
        menu.setOnMenuItemClickListener(item -> {
            org.json.JSONObject t = tpls.optJSONObject(item.getItemId());
            String hex = t == null ? "" : t.optString("apdu", t.optString("apduHex", "")).replaceAll("[^0-9A-Fa-f]", "");
            byte[] apdu = hex.length() >= 8 && hex.length() % 2 == 0 ? CardOps.unhex(hex) : new byte[0];
            if (apdu.length == 0) { a.flash("", app().t("nfc.tpl.bad"), "warn"); return true; }
            a.flash("", t.optString("label", t.optString("name", "APDU")), "info");
            arm("select-aid", -1, apdu);
            return true;
        });
        menu.show();
    }

    private byte[] lastContainerForEmulate;

    /* --------------------------------------------------------------- dialogs */

    private interface OnText { void run(String s); }
    private interface OnBlock { void run(int block, byte[] data); }
    private interface OnMrtd { void run(MrtdReader.Options opts); }

    /** The e-ID / MRTD access dialog: the BAC key (document number + DOB + expiry), a CAN, or a pasted MRZ, and a "read photo" toggle. */
    private void askMrtd(OnMrtd cb) {
        EditText doc = new EditText(a); doc.setHint(app().t("nfc.eid.docNumber")); doc.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        EditText dob = new EditText(a); dob.setHint(app().t("nfc.eid.dob")); dob.setInputType(InputType.TYPE_CLASS_NUMBER);
        EditText exp = new EditText(a); exp.setHint(app().t("nfc.eid.expiry")); exp.setInputType(InputType.TYPE_CLASS_NUMBER);
        EditText can = new EditText(a); can.setHint(app().t("nfc.eid.can")); can.setInputType(InputType.TYPE_CLASS_NUMBER);
        EditText mrz = new EditText(a); mrz.setHint(app().t("nfc.eid.mrz")); mrz.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS); mrz.setMinLines(2);
        CheckBox photo = new CheckBox(a); photo.setText(app().t("nfc.eid.photo")); photo.setChecked(true); photo.setTextColor(Ui.color(a, "@onSurface", Color.BLACK));
        LinearLayout l = new LinearLayout(a); l.setOrientation(LinearLayout.VERTICAL); l.setPadding(Ui.dp(a, 20), Ui.dp(a, 8), Ui.dp(a, 20), 0);
        l.addView(doc); l.addView(dob); l.addView(exp); l.addView(can); l.addView(mrz); l.addView(photo);
        ScrollView sv = new ScrollView(a); sv.addView(l);
        new android.app.AlertDialog.Builder(a).setTitle(app().t("nfc.eid.title")).setView(sv)
            .setPositiveButton(app().t("nfc.eid.read"), (d, w) -> {
                MrtdReader.Options o = new MrtdReader.Options();
                String mrzText = mrz.getText().toString().trim();
                if (!mrzText.isEmpty()) o.mrz = mrzText;
                else {
                    String dn = doc.getText().toString().trim(), db = dob.getText().toString().trim(), ex = exp.getText().toString().trim();
                    if (dn.isEmpty() || db.isEmpty() || ex.isEmpty()) { a.flash("", app().t("nfc.eid.needKey"), "warn"); return; }
                    o.key = new cz.m5cet.app.nfc.Bac.MrzKey(dn, db, ex);
                }
                String canText = can.getText().toString().trim();
                if (!canText.isEmpty()) o.can = canText;
                o.readPhoto = photo.isChecked();
                cb.run(o);
            })
            .setNegativeButton(app().t("nav.close"), null).show();
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
