package cz.m5cet.app.ui.parts;

import android.graphics.Color;
import android.nfc.NdefMessage;
import android.nfc.NdefRecord;
import android.nfc.Tag;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import cz.m5cet.app.M5;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.nfc.CardOps;
import cz.m5cet.app.nfc.InternalReader;
import cz.m5cet.app.nfc.M5Card;
import cz.m5cet.app.nfc.Nfc;
import cz.m5cet.app.nfc.Records;
import cz.m5cet.app.ui.Expr;
import cz.m5cet.app.ui.MainActivity;
import cz.m5cet.app.ui.Renderer;
import cz.m5cet.app.ui.Ui;

/**
 * The M5Cet card builder (6.3): add / edit / reorder / remove records, choose an
 * encryption PIN (external) or the account PassKey (internal), toggle one-time,
 * see the size against the tag's capacity, then write the card as an NDEF
 * external record (m5cet.cz:card) — the same bytes the web builder writes.
 */
final class NfcCardBuilder extends ScrollView implements Renderer.Slot {
    private final MainActivity a;
    private final InternalReader reader;
    private final LinearLayout box;
    private final LinearLayout list;
    private final TextView sizeLabel;
    private final EditText pin;
    private final List<Draft> drafts = new ArrayList<>();

    /** The per-type fields the builder offers (mirrors the records.ts shapes). */
    private static final java.util.Map<String, String[]> FIELDS = new java.util.LinkedHashMap<>();
    static {
        FIELDS.put("message", new String[]{"text", "url"});
        FIELDS.put("one-time-message", new String[]{"text", "url"});
        FIELDS.put("server-room", new String[]{"server", "room", "passphrase", "name"});
        FIELDS.put("wifi", new String[]{"ssid", "password", "auth"});
        FIELDS.put("url-login", new String[]{"url", "user", "password", "note"});
        FIELDS.put("contact", new String[]{"name", "tel", "email", "org", "url", "note"});
        FIELDS.put("external-key", new String[]{"label", "key", "algo"});
        FIELDS.put("passkey-backup", new String[]{"user", "root"});
        FIELDS.put("identity-backup", new String[]{"user"});
    }

    static final class Draft {
        String type;
        boolean internal;
        boolean oneTime;
        JSONObject data = new JSONObject();
    }

    NfcCardBuilder(MainActivity a) {
        super(a);
        this.a = a;
        this.reader = new InternalReader(a);
        box = new LinearLayout(a);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(Ui.dp(a, 16), Ui.dp(a, 14), Ui.dp(a, 16), Ui.dp(a, 28));
        addView(box);
        int muted = Ui.color(a, "@muted", Color.GRAY);

        box.addView(ToolPanels.label(a, app().t("nfc.builder.pin"), 12, muted, false));
        pin = new EditText(a);
        pin.setHint(app().t("nfc.pin"));
        pin.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD);
        pin.setTextColor(Ui.color(a, "@onSurface", Color.BLACK));
        pin.setBackground(Ui.shape(Ui.color(a, "@surfaceVariant", Color.LTGRAY), Ui.dp(a, 12), 0, 0));
        pin.setPadding(Ui.dp(a, 14), Ui.dp(a, 10), Ui.dp(a, 14), Ui.dp(a, 10));
        box.addView(pin);

        list = new LinearLayout(a);
        list.setOrientation(LinearLayout.VERTICAL);
        list.setPadding(0, Ui.dp(a, 10), 0, 0);
        box.addView(list);

        TextView add = ToolPanels.button(a, app().t("nfc.builder.add"), "plus", false);
        LinearLayout.LayoutParams al = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        al.topMargin = Ui.dp(a, 10);
        al.gravity = Gravity.CENTER_HORIZONTAL;
        add.setOnClickListener(v -> pickType());
        box.addView(add, al);

        sizeLabel = ToolPanels.label(a, "", 12, muted, false);
        sizeLabel.setGravity(Gravity.CENTER);
        sizeLabel.setPadding(0, Ui.dp(a, 12), 0, Ui.dp(a, 6));
        box.addView(sizeLabel);

        TextView write = ToolPanels.button(a, app().t("nfc.builder.write"), "nfc", true);
        LinearLayout.LayoutParams wl = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        write.setOnClickListener(v -> write());
        box.addView(write, wl);

        redraw();
    }

    private M5 app() { return a.app(); }

    /* ------------------------------------------------------------- records */

    private void pickType() {
        final String[] types = Records.BUILDABLE.toArray(new String[0]);
        String[] labels = new String[types.length];
        for (int i = 0; i < types.length; i++) { Records.Meta m = Records.meta(types[i]); labels[i] = m == null ? types[i] : app().t(m.label); }
        new android.app.AlertDialog.Builder(a).setTitle(app().t("nfc.builder.add")).setItems(labels, (d, w) -> {
            Draft draft = new Draft();
            draft.type = types[w];
            Records.Meta m = Records.meta(draft.type);
            draft.oneTime = m != null && m.oneTimeDefault;
            draft.internal = m != null && m.accountOnly;
            edit(draft, true);
        }).show();
    }

    private void edit(Draft draft, boolean isNew) {
        LinearLayout form = new LinearLayout(a);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(Ui.dp(a, 20), Ui.dp(a, 8), Ui.dp(a, 20), 0);
        String[] fields = FIELDS.get(draft.type);
        final java.util.Map<String, EditText> inputs = new java.util.LinkedHashMap<>();
        if (fields != null) for (String f : fields) {
            EditText e = new EditText(a);
            e.setHint(app().t("nfc.field." + f));
            e.setText(draft.data.optString(f, ""));
            e.setInputType(InputType.TYPE_CLASS_TEXT | (f.equals("text") || f.equals("note") ? InputType.TYPE_TEXT_FLAG_MULTI_LINE : 0));
            form.addView(e);
            inputs.put(f, e);
        }
        final android.widget.CheckBox oneTime = new android.widget.CheckBox(a);
        oneTime.setText(app().t("nfc.builder.oneTime"));
        oneTime.setChecked(draft.oneTime);
        form.addView(oneTime);
        final android.widget.CheckBox internal = new android.widget.CheckBox(a);
        internal.setText(app().t("nfc.builder.internal"));
        internal.setChecked(draft.internal);
        form.addView(internal);

        new android.app.AlertDialog.Builder(a).setTitle(app().t(Records.meta(draft.type) == null ? draft.type : Records.meta(draft.type).label)).setView(form)
            .setPositiveButton("OK", (d, w) -> {
                JSONObject data = new JSONObject();
                try { for (java.util.Map.Entry<String, EditText> en : inputs.entrySet()) { String v = en.getValue().getText().toString(); if (!v.isEmpty()) data.put(en.getKey(), v); } } catch (org.json.JSONException ignored) { }
                draft.data = data;
                draft.oneTime = oneTime.isChecked();
                draft.internal = internal.isChecked();
                if (isNew) drafts.add(draft);
                redraw();
            })
            .setNegativeButton(app().t("nav.close"), null).show();
    }

    private void redraw() {
        list.removeAllViews();
        int fg = Ui.color(a, "@onSurface", Color.BLACK), muted = Ui.color(a, "@muted", Color.GRAY);
        for (int i = 0; i < drafts.size(); i++) {
            final int idx = i;
            Draft draft = drafts.get(i);
            Records.Meta m = Records.meta(draft.type);
            LinearLayout row = new LinearLayout(a);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(Ui.dp(a, 12), Ui.dp(a, 8), Ui.dp(a, 8), Ui.dp(a, 8));
            row.setBackground(Ui.shape(Ui.color(a, "@surface", Color.WHITE), Ui.dp(a, 14), Ui.dp(a, 1), Ui.color(a, "@border", Color.LTGRAY)));
            LinearLayout.LayoutParams rl = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            rl.topMargin = Ui.dp(a, 8);
            LinearLayout col = new LinearLayout(a);
            col.setOrientation(LinearLayout.VERTICAL);
            col.addView(ToolPanels.label(a, (m == null ? draft.type : app().t(m.label)) + (draft.oneTime ? "  🔥" : "") + (draft.internal ? "  🔑" : ""), 15, fg, true));
            col.addView(ToolPanels.label(a, Records.summary(draft.type, draft.data), 12, muted, false));
            row.addView(col, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            row.addView(iconBtn("chevron-up", () -> { if (idx > 0) { java.util.Collections.swap(drafts, idx, idx - 1); redraw(); } }));
            row.addView(iconBtn("chevron-down", () -> { if (idx < drafts.size() - 1) { java.util.Collections.swap(drafts, idx, idx + 1); redraw(); } }));
            row.addView(iconBtn("pencil", () -> edit(draft, false)));
            row.addView(iconBtn("trash", () -> { drafts.remove(idx); redraw(); }));
            list.addView(row, rl);
        }
        updateSize();
    }

    private View iconBtn(String icon, Runnable onClick) {
        android.widget.ImageView b = new android.widget.ImageView(a);
        int px = Ui.dp(a, 20);
        b.setImageDrawable(cz.m5cet.app.ui.Icons.drawable(a, icon, px, Ui.color(a, "@muted", Color.GRAY)));
        b.setPadding(Ui.dp(a, 8), Ui.dp(a, 8), Ui.dp(a, 8), Ui.dp(a, 8));
        b.setOnClickListener(v -> onClick.run());
        return b;
    }

    /**
     * Estimate the NDEF size against real tag capacities (no crypto): the container
     * is 7 header + Σ(37 overhead + json + 16 GCM tag), and the NDEF external record
     * (m5cet.cz:card) adds 16 B (19 B once the payload reaches 256). The fit names
     * the smallest tag that holds it — MIFARE Classic 1K/4K included, not just NTAG.
     */
    private void updateSize() {
        int size = 7;
        for (Draft d : drafts) size += 37 + d.data.toString().getBytes(StandardCharsets.UTF_8).length + 16;
        int ndef = size + (size < 256 ? 16 : 19);
        int[] caps = {144, 504, 716, 888, 3352};
        String[] names = {"NTAG213", "NTAG215", "MIFARE Classic 1K", "NTAG216", "MIFARE Classic 4K"};
        String fit = app().t("nfc.builder.big");
        for (int i = 0; i < caps.length; i++) if (ndef <= caps[i]) { fit = names[i]; break; }
        sizeLabel.setText(app().t("nfc.builder.size") + ": " + ndef + " B · " + fit);
    }

    /* ------------------------------------------------------------- write */

    private void write() {
        if (drafts.isEmpty()) { a.flash("", app().t("nfc.builder.empty"), "info"); return; }
        final String p = pin.getText().toString().trim();
        boolean anyExternal = false, anyInternal = false;
        for (Draft d : drafts) { if (d.internal) anyInternal = true; else anyExternal = true; }
        if (anyExternal && !M5Card.isValidPin(p)) { a.flash("", app().t("nfc.builder.pin"), "warn"); pin.requestFocus(); return; }
        if (anyInternal && accountRoot() == null) { a.flash("", app().t("nfc.builder.needAccount"), "warn"); return; }
        Io.bg(() -> {
            try {
                List<M5Card.Record> recs = new ArrayList<>();
                for (Draft d : drafts) {
                    M5Card.Record r = new M5Card.Record(d.type, d.internal ? M5Card.MODE_INTERNAL : M5Card.MODE_EXTERNAL, d.data);
                    r.oneTime = d.oneTime;
                    recs.add(r);
                }
                final byte[] container = M5Card.buildCard(recs, M5Card.keys(M5Card.isValidPin(p) ? p : null, accountRoot()));
                Io.main(() -> armWrite(container));
            } catch (Exception e) {
                Io.main(() -> a.flash("", e.getMessage(), "error"));
            }
        });
    }

    private void armWrite(byte[] container) {
        if (!reader.available(a) || !reader.enabled()) { a.flash("", app().t("nfc.disabled"), "warn"); a.systemSettings("app"); return; }
        a.flash("", app().t("nfc.work.holdCard"), "info");
        cz.m5cet.app.nfc.CardService.stopServing();
        reader.startScan(tag -> writeTo(tag, container));
    }

    private void writeTo(Tag tag, byte[] container) {
        try {
            NdefMessage msg = new NdefMessage(new NdefRecord[]{NdefRecord.createExternal("m5cet.cz", "card", container)});
            java.util.List<byte[]> keys = CardOps.keyDictionary(app().settings.str("nfc.keyDictionary"));
            cz.m5cet.app.core.Log.i("nfc", "builder: writing M5Cet card (NDEF " + msg.toByteArray().length + " B)");
            final int n = CardOps.ndefWriteAny(tag, msg, keys);
            Io.main(() -> { reader.stopScan(); a.flash("", app().t("nfc.done.writtenBytes").replace("{0}", String.valueOf(n)), "success"); });
        } catch (CardOps.NfcWriteException e) {
            Io.main(() -> a.flash("", writeError(e), "warn"));
        } catch (Exception e) {
            Io.main(() -> a.flash("", e.getMessage(), "warn"));
        }
    }

    /** A writable, localized message for a typed write failure. */
    private String writeError(CardOps.NfcWriteException e) {
        switch (e.kind) {
            case CardOps.NfcWriteException.READ_ONLY: return app().t("nfc.err.readOnly");
            case CardOps.NfcWriteException.TOO_SMALL: return app().t("nfc.err.tooSmall").replace("{0}", String.valueOf(e.needed)).replace("{1}", String.valueOf(e.available));
            case CardOps.NfcWriteException.NO_KEY: return app().t("nfc.err.noKey").replace("{0}", String.valueOf(e.sector));
            default: return app().t("nfc.err.notWritable");
        }
    }

    /** See NfcWorkbench#accountRoot — internal records need the account root wired in. */
    private byte[] accountRoot() { return app().account == null ? null : app().account.cardRoot(); }

    @Override protected void onDetachedFromWindow() { reader.stopScan(); super.onDetachedFromWindow(); }

    @Override public void bindSlot(Expr.Scope scope) { }
}
