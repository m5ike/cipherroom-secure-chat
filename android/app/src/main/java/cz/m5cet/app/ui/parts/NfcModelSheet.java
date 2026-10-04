package cz.m5cet.app.ui.parts;

import android.app.Activity;
import android.app.Application;
import android.app.Dialog;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.nfc.Tag;
import android.os.Bundle;
import android.text.InputFilter;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

import cz.m5cet.app.M5;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.nfc.InternalReader;
import cz.m5cet.app.nfc.ModelNfc;
import cz.m5cet.app.nfc.ModelNfcDevice;
import cz.m5cet.app.nfc.NfcCatalog;
import cz.m5cet.app.nfc.ReaderMode;
import cz.m5cet.app.nfc.UsbReader;
import cz.m5cet.app.ui.Icons;
import cz.m5cet.app.ui.MainActivity;
import cz.m5cet.app.ui.Ui;

/**
 * A Functions model asks this phone for a card (6.6): the "nfc" run interaction
 * as a compact sheet from the bottom — what is asked in plain words and by
 * which model, "hold the card to the back of your phone", a progress state while
 * reading and the result line. It runs the op through {@link ModelNfc} on the
 * phone's own antenna (reader mode, borrowed from whoever held it and given
 * back) or on a USB reader the user already allowed in the workbench, and
 * answers the run with the NfcResult. 6.10 (security analysis G-17): a result
 * with card data (a card number, track data, a document's holder, MRZ or
 * photo) goes only after the holder chose what — the sheet names the model and
 * lists it; "Send (masked)" is the default, "Send everything" says what it
 * adds, "Don't send" (or closing the sheet) answers "denied" (ModelNfc.consent).
 *
 * An e-ID read that came without the document key asks the holder for the CAN
 * or the MRZ here first; it is used for this read only and never sent.
 *
 * Reader mode is released when the sheet closes, while the activity is paused
 * (taken again on resume if the sheet still waits) and when it goes away.
 * Closing the sheet before an answer answers { status: "timeout", message:
 * "Cancelled" }. Writes and emulation never get a sheet: they are refused.
 */
final class NfcModelSheet {
    private enum State { KEY, WAIT, READ, CONSENT, DONE }

    private final MainActivity a;
    final String runId;
    private final String modelName;
    private final Consumer<JSONObject> answer;
    private ModelNfc.Command command;
    private String reader = NfcCatalog.READER_INTERNAL;
    private UsbReader usb;

    private final Dialog dialog;
    private final LinearLayout body;
    private final int fg, muted, primary, danger, success;

    private volatile State state = State.WAIT;
    private volatile boolean over;             // answered (or the run went away): nothing more is sent
    private volatile JSONObject consenting;    // 6.10 (G-17): the read's result while the holder decides what of it goes
    private final AtomicBoolean taken = new AtomicBoolean();
    private boolean holdsReader;
    private Application.ActivityLifecycleCallbacks lifecycle;
    private long deadline;
    private final Runnable tick = this::tick;
    private final Runnable autoClose = this::close;

    /**
     * Handles one "nfc" interaction: refused / answered at once (a write, an
     * unknown op, enum, NFC off) or a sheet that waits for the card. Returns the
     * sheet, or null when there is none to keep.
     */
    static NfcModelSheet start(MainActivity a, String runId, JSONObject spec, String modelName, Consumer<JSONObject> answer) {
        M5 app = a.app();
        ModelNfc.Command cmd = ModelNfc.parse(spec);
        JSONObject refused = ModelNfc.refusal(cmd);
        if (refused != null) {
            answer.accept(refused);
            boolean denied = "denied".equals(refused.optString("status"));
            a.flash("", app.t(denied ? "nfc.model.denied" : "nfc.model.unsupported"), denied ? "warn" : "info");
            Log.i("nfc", "model op " + cmd.op + ": " + refused.optString("status"));
            return null;
        }
        ModelNfc.Device device = ModelNfcDevice.snapshot(a, app.settings.str("nfc.reader"));
        if (ModelNfc.ENUM.equals(cmd.op)) { answer.accept(ModelNfc.enumResult(cmd, device)); return null; }
        ModelNfc.Route route = ModelNfc.route(cmd, device);
        NfcModelSheet s = new NfcModelSheet(a, runId, cmd, modelName, answer);
        if (route.result != null) {
            s.answerOnce(route.result);
            if (!route.nfcOff) {
                String why = NfcCatalog.READER_USB.equals(cmd.reader) ? "nfc.reader.noUsb"
                    : cmd.reader == null || NfcCatalog.READER_INTERNAL.equals(cmd.reader) ? "nfc.unavailable" : "nfc.model.unsupported";
                a.flash("", app.t(why), "warn");
                return null;
            }
            s.showOff();
            s.dialog.show();
            return s;
        }
        s.reader = route.reader;
        if (NfcCatalog.READER_USB.equals(s.reader)) s.usb = ModelNfcDevice.permittedUsb(a);
        s.dialog.show();
        s.watchLifecycle();
        if (ModelNfc.needsDocumentKey(cmd)) s.askKey();
        else s.waitForCard();
        return s;
    }

    private NfcModelSheet(MainActivity a, String runId, ModelNfc.Command command, String modelName, Consumer<JSONObject> answer) {
        this.a = a;
        this.runId = runId;
        this.command = command;
        this.modelName = modelName == null ? "" : modelName.trim();
        this.answer = answer;
        fg = Ui.color(a, "@onSurface", Color.BLACK);
        muted = Ui.color(a, "@muted", Color.GRAY);
        primary = Ui.color(a, "@primary", Color.BLUE);
        danger = Ui.color(a, "@danger", 0xFFdc2626);
        success = Ui.color(a, "@success", 0xFF2e7d32);

        dialog = new Dialog(a);
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        LinearLayout content = new LinearLayout(a);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(20), dp(12), dp(20), dp(20));
        content.addView(header());
        body = new LinearLayout(a);
        body.setOrientation(LinearLayout.VERTICAL);
        content.addView(body);
        TextView ro = ToolPanels.label(a, t("nfc.readonly.help"), 12, muted, false);
        ro.setPadding(0, dp(14), 0, 0);
        content.addView(ro);
        ScrollView scroll = new ScrollView(a) {
            @Override protected void onMeasure(int ws, int hs) {
                int max = (int) (a.getResources().getDisplayMetrics().heightPixels * 0.86f);
                super.onMeasure(ws, MeasureSpec.makeMeasureSpec(max, MeasureSpec.AT_MOST));
            }
        };
        scroll.setBackground(Ui.shape(Ui.color(a, "@surface", Color.WHITE), dp(24), 0, 0));
        scroll.addView(content);
        dialog.setContentView(scroll);
        dialog.setCanceledOnTouchOutside(false);
        Window w = dialog.getWindow();
        if (w != null) {
            w.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            w.setGravity(Gravity.BOTTOM);
            w.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
            // A window of its own: it keeps screenshots out like the app's (the document key is typed here).
            if ((a.getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_SECURE) != 0) w.addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        }
        // Back, the close button, the activity going away: cancel unless answered.
        dialog.setOnDismissListener(d -> { answerOnce(closingAnswer()); release(); unwatchLifecycle(); });
    }

    private M5 app() { return a.app(); }
    private int dp(float v) { return Ui.dp(a, v); }
    private String t(String key) { return app().t(key); }

    /* -------------------------------------------------------------- the view */

    private View header() {
        LinearLayout bar = new LinearLayout(a);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        ImageView icon = new ImageView(a);
        String op = command.op;
        String name = op.startsWith("emv") ? "credit-card" : (op.startsWith("eid") || op.equals("mrtd-read")) ? "contact-round" : "nfc";
        icon.setImageDrawable(Icons.drawable(a, name, dp(26), primary));
        icon.setScaleType(ImageView.ScaleType.CENTER);
        icon.setBackground(Ui.shape(Ui.alpha(primary, 0.12f), dp(999), 0, 0));
        LinearLayout.LayoutParams il = new LinearLayout.LayoutParams(dp(44), dp(44));
        il.setMarginEnd(dp(12));
        bar.addView(icon, il);
        LinearLayout col = new LinearLayout(a);
        col.setOrientation(LinearLayout.VERTICAL);
        TextView title = ToolPanels.label(a, t(ModelNfc.whatKey(op)), 18, fg, true);
        col.addView(title);
        if (!modelName.isEmpty()) col.addView(ToolPanels.label(a, t("nfc.model.by").replace("{0}", modelName), 13, muted, false));
        bar.addView(col, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        ImageView close = new ImageView(a);
        close.setImageDrawable(Icons.drawable(a, "x", dp(22), fg));
        close.setScaleType(ImageView.ScaleType.CENTER);
        close.setBackground(Ui.ripple(null, Ui.alpha(fg, 0.16f)));
        close.setContentDescription(t("nav.close"));
        close.setOnClickListener(v -> close());
        bar.addView(close, new LinearLayout.LayoutParams(dp(44), dp(44)));
        return bar;
    }

    private TextView line(String s, float sp, int color, boolean bold) {
        TextView v = ToolPanels.label(a, s, sp, color, bold);
        v.setPadding(0, dp(8), 0, 0);
        return v;
    }

    private LinearLayout buttons(TextView... bs) {
        LinearLayout row = new LinearLayout(a);
        row.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
        row.setPadding(0, dp(16), 0, 0);
        for (int i = 0; i < bs.length; i++) {
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            if (i > 0) lp.setMarginStart(dp(10));
            row.addView(bs[i], lp);
        }
        return row;
    }

    private TextView cancelButton() {
        TextView b = ToolPanels.button(a, t("nfc.model.cancel"), "x", false);
        b.setOnClickListener(v -> close());
        return b;
    }

    private View progress() {
        ProgressBar p = new ProgressBar(a);
        p.setIndeterminate(true);
        p.setIndeterminateTintList(ColorStateList.valueOf(primary));
        LinearLayout box = new LinearLayout(a);
        box.setGravity(Gravity.CENTER);
        box.setPadding(0, dp(18), 0, dp(6));
        box.addView(p, new LinearLayout.LayoutParams(dp(44), dp(44)));
        return box;
    }

    /* ---------------------------------------------------- the document key */

    /** e-ID without a key: the CAN, or the MRZ, or the three fields — typed here, kept here. */
    private void askKey() {
        state = State.KEY;
        body.removeAllViews();
        body.addView(line(t("nfc.model.key.title"), 15, fg, true));
        body.addView(line(t("nfc.model.key.help"), 13, muted, false));
        // The CAN is printed on the card (not a PIN): shown while typed, like the workbench's; the window is FLAG_SECURE as the app is.
        EditText can = field(t("nfc.model.key.can"), InputType.TYPE_CLASS_NUMBER, 6);
        EditText mrz = field(t("nfc.model.key.mrz"), InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS, 0);
        mrz.setMinLines(2);
        EditText doc = field(t("nfc.eid.docNumber"), InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS, 20);
        EditText dob = field(t("nfc.eid.dob"), InputType.TYPE_CLASS_NUMBER, 6);
        EditText exp = field(t("nfc.eid.expiry"), InputType.TYPE_CLASS_NUMBER, 6);
        body.addView(can);
        body.addView(orLine());
        body.addView(mrz);
        body.addView(orLine());
        body.addView(doc);
        body.addView(dob);
        body.addView(exp);
        TextView error = line("", 13, danger, false);
        error.setVisibility(View.GONE);
        body.addView(error);
        TextView read = ToolPanels.button(a, t("nfc.eid.read"), "scan-line", true);
        read.setOnClickListener(v -> {
            ModelNfc.DocumentKey k = new ModelNfc.DocumentKey();
            k.can = can.getText().toString();
            k.mrz = mrz.getText().toString();
            k.documentNumber = doc.getText().toString();
            k.dateOfBirth = dob.getText().toString();
            k.dateOfExpiry = exp.getText().toString();
            String problem = ModelNfc.checkDocumentKey(k);
            if (problem != null) { error.setText(t(problem)); error.setVisibility(View.VISIBLE); return; }
            command = ModelNfc.withDocumentKey(command, k);
            // The key now lives only in this read's command; the fields forget it.
            for (EditText e : new EditText[]{can, mrz, doc, dob, exp}) e.setText("");
            android.view.inputmethod.InputMethodManager imm = (android.view.inputmethod.InputMethodManager) a.getSystemService(android.content.Context.INPUT_METHOD_SERVICE);
            if (imm != null) imm.hideSoftInputFromWindow(v.getWindowToken(), 0);
            waitForCard();
        });
        body.addView(buttons(cancelButton(), read));
        can.requestFocus();
    }

    private EditText field(String hint, int inputType, int maxLength) {
        EditText e = new EditText(a);
        e.setHint(hint);
        e.setInputType(inputType);
        e.setTextColor(fg);
        e.setHintTextColor(muted);
        e.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        e.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        if (maxLength > 0) e.setFilters(new InputFilter[]{new InputFilter.LengthFilter(maxLength)});
        e.setBackground(Ui.shape(Ui.color(a, "@surfaceVariant", Color.LTGRAY), dp(12), 0, 0));
        e.setPadding(dp(14), dp(10), dp(14), dp(10));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(8);
        e.setLayoutParams(lp);
        return e;
    }

    private TextView orLine() {
        TextView o = ToolPanels.label(a, t("nfc.model.key.or"), 12, muted, true);
        o.setGravity(Gravity.CENTER);
        o.setPadding(0, dp(6), 0, 0);
        return o;
    }

    /* -------------------------------------------------------- the card */

    private void waitForCard() {
        state = State.WAIT;
        body.removeAllViews();
        body.addView(progress());
        boolean viaUsb = NfcCatalog.READER_USB.equals(reader) && usb != null;
        TextView hold = line(viaUsb ? t("nfc.model.holdUsb").replace("{0}", usb.name()) : t("nfc.model.hold"), 16, fg, true);
        hold.setGravity(Gravity.CENTER);
        body.addView(hold);
        TextView count = line("", 13, muted, false);
        count.setGravity(Gravity.CENTER);
        count.setTag("count");
        body.addView(count);
        body.addView(buttons(cancelButton()));
        deadline = System.currentTimeMillis() + command.timeout * 1000L;
        tick();
        if (viaUsb) {
            final UsbReader u = usb;
            Io.bg(() -> {
                ModelNfcDevice.UsbCard card = ModelNfcDevice.waitForUsb(u, () -> over || state != State.WAIT || System.currentTimeMillis() > deadline);
                if (card == null) return;
                if (!taken.compareAndSet(false, true) || over) { card.close(); return; }
                Io.main(this::reading);
                JSONObject r;
                try { r = ModelNfc.run(command, card); } finally { card.close(); }
                final JSONObject result = r;
                Io.main(() -> done(result));
            });
        } else {
            takeReader();
        }
    }

    /** Reader mode for this read: borrowed above whoever holds it, given back by release(). */
    private void takeReader() {
        if (holdsReader || over || state != State.WAIT) return;
        holdsReader = true;
        ReaderMode.borrow(a, this, this::onTag, InternalReader.FLAGS, InternalReader.extras());
    }

    private void giveReaderBack() {
        if (!holdsReader) return;
        holdsReader = false;
        ReaderMode.release(a, this);
    }

    /** On the NFC binder thread: the first card in the field runs the op; others are ignored. */
    private void onTag(Tag tag) {
        if (over || state != State.WAIT || !taken.compareAndSet(false, true)) return;
        Io.main(this::reading);
        ModelNfcDevice.TagCard card = null;
        JSONObject r;
        try {
            card = new ModelNfcDevice.TagCard(tag);
            r = ModelNfc.run(command, card);
        } catch (RuntimeException e) {
            Log.w("nfc", "model read failed: " + e.getMessage());
            r = ModelNfc.result("error", null, e.getMessage() == null ? "error" : e.getMessage());
        } finally {
            if (card != null) card.close();
        }
        final JSONObject result = r;
        Io.main(() -> done(result));
    }

    private void reading() {
        if (over) return;
        state = State.READ;
        Io.cancelMain(tick);
        body.removeAllViews();
        body.addView(progress());
        TextView l = line(t("nfc.model.reading"), 16, fg, true);
        l.setGravity(Gravity.CENTER);
        body.addView(l);
        body.addView(buttons(cancelButton()));
    }

    /** The countdown while waiting; at the end, the timeout answer. */
    private void tick() {
        if (over || state != State.WAIT) return;
        long left = deadline - System.currentTimeMillis();
        if (left <= 0) {
            JSONObject r = ModelNfc.timedOut(command.timeout);
            answerOnce(r);
            release();
            showResult(r);
            return;
        }
        View c = body.findViewWithTag("count");
        if (c instanceof TextView) ((TextView) c).setText(t("nfc.model.waiting").replace("{0}", String.valueOf((left + 999) / 1000)));
        Io.mainLater(tick, Math.min(1000, left));
    }

    private void done(JSONObject r) {
        if (over) return;
        release();
        // 6.10 (G-17): card data goes to the server and the model only with the holder's yes.
        ModelNfc.Consent consent = ModelNfc.consent(r);
        if (consent.sensitive && dialog.isShowing()) { askConsent(r, consent); return; }
        if (consent.sensitive) { answerOnce(ModelNfc.declined(r)); return; } // no one to ask: nothing leaves
        answerOnce(r);
        showResult(r);
    }

    /**
     * 6.10 (G-17): what the read found, for which model, and the choice —
     * "Send (masked)" first and highlighted (the default), "Send everything"
     * only when it adds something, "Don't send". Closing the sheet now is a no.
     */
    private void askConsent(JSONObject r, ModelNfc.Consent consent) {
        state = State.CONSENT;
        consenting = r;
        body.removeAllViews();
        body.addView(line(t("nfc.consent.title"), 16, fg, true));
        body.addView(line(ModelNfc.consentText(consent, modelName, this::t), 13, fg, false));
        LinearLayout col = new LinearLayout(a);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(0, dp(12), 0, 0);
        TextView maskedB = ToolPanels.button(a, t("nfc.consent.sendMasked"), "shield-check", true);
        maskedB.setOnClickListener(v -> consented(ModelNfc.masked(r)));
        col.addView(maskedB, consentButton());
        if (!consent.full.isEmpty()) {
            TextView fullB = ToolPanels.button(a, t("nfc.consent.sendFull"), "send", false);
            fullB.setOnClickListener(v -> consented(r));
            col.addView(fullB, consentButton());
        }
        TextView noB = ToolPanels.button(a, t("nfc.consent.dontSend"), "x", false);
        noB.setOnClickListener(v -> consented(ModelNfc.declined(r)));
        col.addView(noB, consentButton());
        body.addView(col);
        maskedB.requestFocus();
    }

    private LinearLayout.LayoutParams consentButton() {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(8);
        return lp;
    }

    private void consented(JSONObject sent) {
        if (over) return;
        consenting = null;
        answerOnce(sent);
        showResult(sent);
    }

    /** What closing the sheet answers: "Cancelled", or — while asking for consent — the holder's no. */
    private JSONObject closingAnswer() {
        JSONObject r = consenting;
        return r != null ? ModelNfc.declined(r) : ModelNfc.cancelled();
    }

    /** The result line: ✓ and what was read, or ⚠ and why not (the answer is already sent). */
    private void showResult(JSONObject r) {
        state = State.DONE;
        if (!dialog.isShowing()) return;
        body.removeAllViews();
        String status = r.optString("status");
        boolean ok = "ok".equals(status);
        String head;
        switch (status) {
            case "ok": head = "✓ " + t("nfc.model.done"); break;
            case "timeout": head = "⚠ " + t("nfc.model.timeout").replace("{0}", String.valueOf(command.timeout)); break;
            case "no-card": head = "⚠ " + t("nfc.model.lost"); break;
            case "auth-failed": head = "⚠ " + t("nfc.model.authFailed"); break;
            case "unsupported": head = "⚠ " + t("nfc.model.notThisCard"); break;
            case "denied": head = t("nfc.consent.notSent"); break; // 6.10 (G-17): the holder's no
            default: head = "⚠ " + t("nfc.model.error"); break;
        }
        body.addView(line(head, 16, ok ? success : "denied".equals(status) ? fg : danger, true));
        if ("denied".equals(status)) {
            TextView closeD = ToolPanels.button(a, t("nav.close"), "check", false);
            closeD.setOnClickListener(v -> close());
            body.addView(buttons(closeD));
            Io.mainLater(autoClose, 2500);
            return;
        }
        String detail = r.optString("message", "");
        JSONObject card = r.optJSONObject("card");
        if (detail.isEmpty() && card != null) detail = (card.optString("label", "") + " · " + card.optString("uid", "")).trim();
        if ("timeout".equals(status)) detail = "";
        if (!detail.isEmpty()) body.addView(line(detail, 13, muted, false));
        TextView closeB = ToolPanels.button(a, t("nav.close"), "check", ok);
        closeB.setOnClickListener(v -> close());
        body.addView(buttons(closeB));
        if (ok) Io.mainLater(autoClose, 2500);
    }

    /** NFC is off: the answer went ("unsupported"); offer the settings. */
    private void showOff() {
        state = State.DONE;
        body.removeAllViews();
        body.addView(line("⚠ " + t("nfc.disabled"), 16, danger, true));
        body.addView(line(t("nfc.model.offHelp"), 13, muted, false));
        TextView settings = ToolPanels.button(a, t("nfc.model.settings"), "settings", true);
        settings.setOnClickListener(v -> { a.systemSettings("nfc"); close(); });
        TextView closeB = ToolPanels.button(a, t("nav.close"), "x", false);
        closeB.setOnClickListener(v -> close());
        body.addView(buttons(closeB, settings));
    }

    /* ------------------------------------------------------------ lifecycle */

    /** Pause gives reader mode back; resume takes it again while the sheet still waits. */
    private void watchLifecycle() {
        if (lifecycle != null) return;
        lifecycle = new Application.ActivityLifecycleCallbacks() {
            @Override public void onActivityPaused(Activity act) { if (act == a) giveReaderBack(); }
            @Override public void onActivityResumed(Activity act) { if (act == a && !NfcCatalog.READER_USB.equals(reader)) takeReader(); }
            @Override public void onActivityDestroyed(Activity act) { if (act == a) close(); }
            @Override public void onActivityCreated(Activity act, Bundle b) { }
            @Override public void onActivityStarted(Activity act) { }
            @Override public void onActivityStopped(Activity act) { }
            @Override public void onActivitySaveInstanceState(Activity act, Bundle b) { }
        };
        a.registerActivityLifecycleCallbacks(lifecycle);
    }

    private void answerOnce(JSONObject r) {
        if (over) return;
        over = true;
        try { answer.accept(r); } catch (RuntimeException e) { Log.w("nfc", "model answer not sent: " + e.getMessage()); }
    }

    /** Lets go of the card: the countdown and reader mode (back to its owner); the USB poll stops on its own once answered. */
    private void release() {
        Io.cancelMain(tick);
        giveReaderBack();
    }

    private void unwatchLifecycle() {
        if (lifecycle != null) { a.unregisterActivityLifecycleCallbacks(lifecycle); lifecycle = null; }
    }

    /** Close: cancel when nothing was answered yet (the dismiss listener does it). */
    void close() {
        Io.cancelMain(autoClose);
        if (dialog.isShowing()) {
            try { dialog.dismiss(); return; } catch (RuntimeException ignored) { /* the window is gone already */ }
        }
        answerOnce(closingAnswer());
        release();
        unwatchLifecycle();
    }

    /**
     * The run ended (or was cancelled) while the sheet still waited: nothing more
     * to answer, the sheet goes. A sheet showing its result stays until it closes.
     */
    void runEnded() {
        if (over) return;
        over = true;
        close();
    }
}
