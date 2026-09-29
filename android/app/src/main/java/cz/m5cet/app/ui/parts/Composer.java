package cz.m5cet.app.ui.parts;

import android.Manifest;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.net.Uri;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.EditText;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import cz.m5cet.app.M5;
import cz.m5cet.app.chat.ChatMessage;
import cz.m5cet.app.chat.Outgoing;
import cz.m5cet.app.chat.Payloads;
import cz.m5cet.app.chat.RoomSession;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.location.Where;
import cz.m5cet.app.security.FileVault;
import cz.m5cet.app.ui.Expr;
import cz.m5cet.app.ui.Icons;
import cz.m5cet.app.ui.MainActivity;
import cz.m5cet.app.ui.Renderer;
import cz.m5cet.app.ui.Ui;
import cz.m5cet.app.voice.Audio;
import cz.m5cet.app.voice.Voice;

/**
 * Writing (6.1): the text field with suggestions (/ commands, @ people,
 * # tags), a reply preview, the kinds of the next message (hold to reveal,
 * vanishing, sealed with a code, private to some people) as chips, and four
 * buttons —
 *  - attach (+): the "attach" sheet of the design (picture, camera, file,
 *    position, voice message, kinds, recipients);
 *  - dictate (mic): speech into the field; a long press opens the dictation
 *    options ("dictate.options": read back, send at once, language);
 *  - send: a long press opens "send.options" — the text as a voice message
 *    (speech synthesis), or record and send it as text (recognition);
 *  - while recording, a bar with the level, the time, cancel and done.
 * Small files (and pictures) go inline in the message like the web's; larger
 * ones by file transfer from the vault.
 */
final class Composer extends LinearLayout implements Renderer.Slot {
    static final int PICK = 7301, PICK_FILE = 7303, CAPTURE = 7304;
    /** Larger than this goes by file transfer: one data-channel message stays under the browsers' limits. */
    static final int INLINE_MAX = 96 * 1024;

    private final MainActivity a;
    private final Parts parts;
    private final EditText input;
    private final TextView reply;
    private final LinearLayout kinds, row, recBar;
    private final HorizontalScrollView kindsScroll;
    private final LinearLayout suggestions;
    private final ImageView dictate, send;
    private final TextView recTime;
    private final ProgressBar recLevel;
    private ChatMessage replyTo;
    private Audio.Recorder recorder;
    private String recMode = "";
    private String dictatedBase = "";

    Composer(MainActivity a, Parts parts) {
        super(a);
        this.a = a;
        this.parts = parts;
        setOrientation(VERTICAL);
        int fg = Ui.color(a, "@onSurface", Color.BLACK);
        setBackgroundColor(Ui.color(a, "@surface", Color.WHITE));
        setElevation(Ui.dp(a, 6));

        suggestions = new LinearLayout(a);
        suggestions.setOrientation(VERTICAL);
        suggestions.setVisibility(GONE);
        addView(suggestions);

        reply = new TextView(a);
        reply.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        reply.setTextColor(Ui.color(a, "@muted", Color.GRAY));
        reply.setPadding(Ui.dp(a, 16), Ui.dp(a, 6), Ui.dp(a, 16), 0);
        reply.setVisibility(GONE);
        reply.setOnClickListener(v -> setReply(null));
        addView(reply);

        kindsScroll = new HorizontalScrollView(a);
        kindsScroll.setHorizontalScrollBarEnabled(false);
        kinds = new LinearLayout(a);
        kinds.setPadding(Ui.dp(a, 10), Ui.dp(a, 6), Ui.dp(a, 10), 0);
        kindsScroll.addView(kinds);
        addView(kindsScroll);

        row = new LinearLayout(a);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(Ui.dp(a, 6), Ui.dp(a, 6), Ui.dp(a, 6), Ui.dp(a, 6));
        ImageView attach = iconButton("plus", fg);
        attach.setContentDescription(a.app().t("composer.attach"));
        attach.setOnClickListener(v -> parts.showSheet("attach"));
        row.addView(attach);
        input = new EditText(a);
        input.setHint(a.app().t("room.typeMessage"));
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        input.setMaxLines(6);
        input.setTextSize(TypedValue.COMPLEX_UNIT_SP, (float) (16 * a.app().settings.num("appearance.fontScale")));
        input.setTextColor(fg);
        input.setHintTextColor(Ui.color(a, "@muted", Color.GRAY));
        input.setBackground(Ui.shape(Ui.color(a, "@surfaceVariant", Color.LTGRAY), Ui.dp(a, 22), 0, 0));
        input.setPadding(Ui.dp(a, 16), Ui.dp(a, 10), Ui.dp(a, 16), Ui.dp(a, 10));
        input.setImeOptions(a.app().settings.bool("messages.enterSends") ? EditorInfo.IME_ACTION_SEND : EditorInfo.IME_ACTION_NONE);
        input.setOnEditorActionListener((v, id, e) -> { if (id == EditorInfo.IME_ACTION_SEND) { send(); return true; } return false; });
        input.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int st, int c, int af) { }
            @Override public void onTextChanged(CharSequence s, int st, int b, int c) { }
            @Override public void afterTextChanged(Editable s) { suggest(); }
        });
        Object pending = a.form().remove("composer");
        if (pending != null) input.setText(String.valueOf(pending));
        LayoutParams il = new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f);
        il.setMargins(Ui.dp(a, 4), 0, Ui.dp(a, 4), 0);
        row.addView(input, il);
        dictate = iconButton("mic", fg);
        dictate.setContentDescription(a.app().t("voice.dictate"));
        dictate.setOnClickListener(v -> toggleDictation());
        dictate.setOnLongClickListener(v -> { parts.showSheet("dictate.options"); return true; });
        row.addView(dictate);
        send = iconButton("send-horizontal", Ui.color(a, "@onPrimary", Color.WHITE));
        send.setBackground(Ui.ripple(Ui.shape(Ui.color(a, "@primary", Color.RED), Ui.dp(a, 22), 0, 0), 0x33FFFFFF));
        send.setContentDescription(a.app().t("room.send"));
        send.setOnClickListener(v -> send());
        send.setOnLongClickListener(v -> { parts.showSheet("send.options"); return true; });
        row.addView(send);
        addView(row);

        recBar = new LinearLayout(a);
        recBar.setGravity(Gravity.CENTER_VERTICAL);
        recBar.setPadding(Ui.dp(a, 10), Ui.dp(a, 8), Ui.dp(a, 10), Ui.dp(a, 8));
        recBar.setVisibility(GONE);
        ImageView cancel = iconButton("x", fg);
        cancel.setContentDescription(a.app().t("nav.close"));
        cancel.setOnClickListener(v -> stopRecording(false));
        recBar.addView(cancel);
        recTime = new TextView(a);
        recTime.setTextColor(Ui.color(a, "@danger", Color.RED));
        recTime.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        recTime.setPadding(Ui.dp(a, 8), 0, Ui.dp(a, 8), 0);
        recBar.addView(recTime);
        recLevel = new ProgressBar(a, null, android.R.attr.progressBarStyleHorizontal);
        recLevel.setMax(100);
        recLevel.setProgressTintList(android.content.res.ColorStateList.valueOf(Ui.color(a, "@primary", Color.BLUE)));
        recBar.addView(recLevel, new LayoutParams(0, Ui.dp(a, 8), 1f));
        ImageView done = iconButton("check", Ui.color(a, "@onPrimary", Color.WHITE));
        done.setBackground(Ui.ripple(Ui.shape(Ui.color(a, "@primary", Color.RED), Ui.dp(a, 22), 0, 0), 0x33FFFFFF));
        done.setContentDescription(a.app().t("room.send"));
        done.setOnClickListener(v -> stopRecording(true));
        LayoutParams dl = new LayoutParams(Ui.dp(a, 44), Ui.dp(a, 44));
        dl.setMarginStart(Ui.dp(a, 8));
        recBar.addView(done, dl);
        addView(recBar);

        a.parts.composer = this;
        refreshKinds();
        warmLocation();
    }

    private M5 app() { return a.app(); }

    private ImageView iconButton(String icon, int color) {
        ImageView b = new ImageView(getContext());
        int s = Ui.dp(getContext(), 44);
        b.setLayoutParams(new LayoutParams(s, s));
        b.setScaleType(ImageView.ScaleType.CENTER);
        b.setImageDrawable(Icons.drawable(getContext(), icon, Ui.dp(getContext(), 22), color));
        b.setBackground(Ui.ripple(null, Ui.alpha(color, 0.18f)));
        return b;
    }

    void setReply(ChatMessage m) {
        replyTo = m;
        if (m == null) { reply.setVisibility(GONE); return; }
        String q = m.sealed != null ? "🔒" : m.visibleText();
        reply.setText("↪ " + m.senderName + ": " + (q.length() > 80 ? q.substring(0, 79) + "…" : q) + "   ✕");
        reply.setVisibility(VISIBLE);
        input.requestFocus();
    }

    String text() { return input.getText().toString(); }
    void setText(String t) { input.setText(t); input.setSelection(input.getText().length()); }

    /* ------------------------------------------------------ kinds */

    /** The kinds of the next message: $form.msgTap, msgVanish (s), msgSeal ("" = new code), msgTo (peer ids) — shown as chips. */
    void refreshKinds() {
        kinds.removeAllViews();
        Map<String, Object> f = a.form();
        if (Boolean.TRUE.equals(f.get("msgTap"))) kinds.addView(kindChip("👁 " + app().t("msgkind.tap"), () -> f.remove("msgTap")));
        Object v = f.get("msgVanish");
        if (v != null && Expr.num(v) > 0) kinds.addView(kindChip("⏳ " + (int) Expr.num(v) + " s", () -> f.remove("msgVanish")));
        if (f.get("msgSeal") != null) kinds.addView(kindChip("🔒 " + app().t("msgkind.sealed") + (String.valueOf(f.get("msgSeal")).isEmpty() ? "" : " · " + f.get("msgSeal")), () -> f.remove("msgSeal")));
        List<String> to = recipientNames();
        if (!to.isEmpty()) kinds.addView(kindChip("✉ " + String.join(", ", to), () -> f.remove("msgTo")));
        if (app().settings.bool("location.inHeader")) kinds.addView(kindChip("📍 " + app().t("location.inHeader"), () -> { app().settings.set("location.inHeader", false); }));
        kindsScroll.setVisibility(kinds.getChildCount() == 0 ? GONE : VISIBLE);
    }

    private TextView kindChip(String label, Runnable clear) {
        TextView t = new TextView(getContext());
        int accent = Ui.color(getContext(), "@primary", Color.BLUE);
        t.setText(label + "  ✕");
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
        t.setTextColor(accent);
        t.setPadding(Ui.dp(getContext(), 10), Ui.dp(getContext(), 4), Ui.dp(getContext(), 10), Ui.dp(getContext(), 4));
        t.setBackground(Ui.ripple(Ui.shape(Ui.alpha(accent, 0.12f), Ui.dp(getContext(), 999), Ui.dp(getContext(), 1), Ui.alpha(accent, 0.4f)), Ui.alpha(accent, 0.2f)));
        t.setOnClickListener(v -> { clear.run(); refreshKinds(); a.refresh(); });
        LayoutParams lp = new LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT);
        lp.setMarginEnd(Ui.dp(getContext(), 6));
        t.setLayoutParams(lp);
        return t;
    }

    @SuppressWarnings("unchecked")
    private List<String> recipientIds() {
        Object to = a.form().get("msgTo");
        return to instanceof List ? (List<String>) to : new ArrayList<>();
    }

    private List<String> recipientNames() {
        RoomSession r = app().rooms.activeSession();
        List<String> out = new ArrayList<>();
        if (r == null) return out;
        for (String id : recipientIds()) { String n = r.peerName(id); if (n != null) out.add(n); }
        return out;
    }

    /** The message's kinds, recipients, expiry and position from the composer's state and the settings. */
    Outgoing outgoing(String text) {
        Outgoing o = new Outgoing();
        o.text = text;
        o.replyTo = replyTo;
        Map<String, Object> f = a.form();
        o.tap = Boolean.TRUE.equals(f.get("msgTap"));
        Object v = f.get("msgVanish");
        if (v != null) o.vanishSeconds = (int) Expr.num(v);
        Object seal = f.get("msgSeal");
        if (seal != null) o.sealCode = String.valueOf(seal);
        RoomSession r = app().rooms.activeSession();
        for (String id : recipientIds()) { String n = r == null ? null : r.peerName(id); if (n != null) { o.recipients.add(id); o.recipientNames.add(n); } }
        o.ttlMinutes = (int) app().settings.num("messages.ttlMinutes");
        if (app().settings.bool("location.inHeader")) {
            android.location.Location l = app().where.recent();
            if (l != null) o.loc = Where.json(l);
        }
        return o;
    }

    /** A fix in the background so the header position is ready when the message goes. */
    private void warmLocation() {
        if (app().settings.bool("location.inHeader") && app().where.permitted()) app().where.current(l -> { });
    }

    /* -------------------------------------------------------- send */

    void send() {
        String text = input.getText().toString().trim();
        RoomSession r = app().rooms.activeSession();
        if (text.isEmpty() || r == null) return;
        if (parts.runCommand(r, text)) { clearAfterSend(); return; }
        r.send(outgoing(text));
        clearAfterSend();
    }

    private void clearAfterSend() {
        input.setText("");
        setReply(null);
        Map<String, Object> f = a.form();
        f.remove("msgSeal");
        f.remove("msgTap");
        f.remove("msgVanish");
        refreshKinds();
        warmLocation();
    }

    /** send.options › "as voice": the text spoken (speech synthesis) and sent as a voice message. */
    void sendAsVoice() {
        String text = input.getText().toString().trim();
        RoomSession r = app().rooms.activeSession();
        if (text.isEmpty() || r == null) return;
        a.flash("", app().t("voice.synthesizing"), "info");
        app().voice.textToVoiceMessage(text, (clip, err) -> {
            if (clip == null) { a.flash("", app().t("voice.failed") + (err == null ? "" : ": " + err), "error"); return; }
            sendAudio(r, clip);
            clearAfterSend();
        });
    }

    /* ---------------------------------------------------- recording */

    /** Records a voice message ("voice") or speech to send as text ("text"). */
    void record(String mode) {
        if (!a.has(Manifest.permission.RECORD_AUDIO)) { a.askPermissions(Manifest.permission.RECORD_AUDIO); return; }
        if (recorder != null) return;
        if (app().voice.dictating()) toggleDictation();
        recorder = new Audio.Recorder();
        if (!recorder.start()) { recorder = null; a.flash("", app().t("voice.failed"), "error"); return; }
        recMode = mode;
        row.setVisibility(GONE);
        recBar.setVisibility(VISIBLE);
        recTick();
    }

    private void recTick() {
        if (recorder == null) return;
        long ms = recorder.elapsedMs();
        recTime.setText((recMode.equals("text") ? "✍ " : "● ") + ms / 60000 + ":" + String.format(java.util.Locale.ROOT, "%02d", ms / 1000 % 60));
        recLevel.setProgress(Math.round(recorder.level() * 100));
        if (ms > 15 * 60_000) { stopRecording(true); return; }
        postDelayed(this::recTick, 100);
    }

    private void stopRecording(boolean keep) {
        if (recorder == null) return;
        byte[] pcm = recorder.stop();
        recorder = null;
        recBar.setVisibility(GONE);
        row.setVisibility(VISIBLE);
        RoomSession r = app().rooms.activeSession();
        if (!keep || r == null || pcm.length < Audio.RATE / 5) return;
        if (recMode.equals("text")) {
            a.flash("", app().t("voice.recognizing"), "info");
            app().voice.voiceToText(pcm, Audio.RATE, (text, err) -> {
                if (text == null || text.trim().isEmpty()) { a.flash("", app().t(text == null ? "voice.failed" : "voice.nothingHeard"), "warn"); return; }
                r.send(outgoing(text.trim()));
                clearAfterSend();
            });
            return;
        }
        Io.bg(() -> {
            try {
                Voice.Clip clip = Voice.clip(app(), pcm, Audio.RATE);
                Io.main(() -> sendAudio(r, clip));
            } catch (Exception e) {
                Log.w("composer", "voice message: " + e.getMessage());
                Io.main(() -> a.flash("", app().t("voice.failed"), "error"));
            }
        });
    }

    /** A voice message: inline when small, else by file transfer (web: hlas-<ms>.m4a, audio/mp4). */
    private void sendAudio(RoomSession r, Voice.Clip clip) {
        String name = "hlas-" + System.currentTimeMillis() + ".m4a";
        sendBytes(r, clip.bytes, name, clip.mime, false);
    }

    /* ------------------------------------------------ pictures, files */

    /** A picked picture: scaled to at most 1600 px (JPEG); inline when small, else by transfer. */
    void sendImage(Uri uri) {
        RoomSession r = app().rooms.activeSession();
        if (r == null) return;
        Io.bg(() -> {
            try (InputStream in = a.getContentResolver().openInputStream(uri)) {
                if (in == null) return;
                byte[] raw = in.readAllBytes();
                Bitmap bm = BitmapFactory.decodeByteArray(raw, 0, raw.length);
                if (bm == null) { Io.main(() -> sendFileUri(uri)); return; }
                float scale = Math.min(1f, 1600f / Math.max(bm.getWidth(), bm.getHeight()));
                if (scale < 1f) bm = Bitmap.createScaledBitmap(bm, Math.round(bm.getWidth() * scale), Math.round(bm.getHeight() * scale), true);
                byte[] jpeg = null;
                for (int q = 85; q >= 45; q -= 10) {
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    bm.compress(Bitmap.CompressFormat.JPEG, q, out);
                    jpeg = out.toByteArray();
                    if (jpeg.length <= INLINE_MAX) break;
                }
                byte[] b = jpeg;
                Io.main(() -> sendBytes(r, b, "photo-" + System.currentTimeMillis() + ".jpg", "image/jpeg", true));
            } catch (Exception e) {
                Log.e("composer", "the picture could not be sent", e);
            }
        });
    }

    /** Any file: inline when small and of a safe type, else stored in the vault and transferred. */
    void sendFileUri(Uri uri) {
        RoomSession r = app().rooms.activeSession();
        if (r == null) return;
        String name = "file", mime = a.getContentResolver().getType(uri);
        long size = -1;
        try (android.database.Cursor c = a.getContentResolver().query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int ni = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME), si = c.getColumnIndex(android.provider.OpenableColumns.SIZE);
                if (ni >= 0) name = c.getString(ni);
                if (si >= 0 && !c.isNull(si)) size = c.getLong(si);
            }
        } catch (RuntimeException ignored) { }
        String fname = Payloads.safeFileName(name);
        String fmime = mime == null ? "application/octet-stream" : mime;
        long fsize = size;
        Io.bg(() -> {
            try (InputStream in = a.getContentResolver().openInputStream(uri)) {
                if (in == null) return;
                if (fsize >= 0 && fsize <= INLINE_MAX) {
                    byte[] b = in.readAllBytes();
                    Io.main(() -> sendBytes(r, b, fname, fmime, false));
                    return;
                }
                String id = "out-" + System.nanoTime();
                long total = 0;
                try (FileVault.Writer w = new FileVault.Writer(app(), id)) {
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) { w.write(buf, 0, n); total += n; }
                }
                long t = total;
                Io.main(() -> r.sendFile(id, fname, fmime, t, outgoing("")));
            } catch (Exception e) {
                Log.e("composer", "the file could not be sent", e);
                Io.main(() -> a.flash("", e.getMessage(), "error"));
            }
        });
    }

    /** Bytes of a file: inline (≤ INLINE_MAX, safe type) or through the vault by transfer. */
    private void sendBytes(RoomSession r, byte[] b, String name, String mime, boolean image) {
        String safe = Payloads.safeMime(mime);
        if (b.length <= INLINE_MAX) {
            Outgoing o = outgoing(input.getText().toString().trim());
            o.fileName = name;
            o.fileMime = safe;
            o.fileSize = b.length;
            o.fileImage = image && Payloads.inlineImage(safe);
            o.dataUrl = "data:" + safe + ";base64," + android.util.Base64.encodeToString(b, android.util.Base64.NO_WRAP);
            r.send(o);
            clearAfterSend();
            return;
        }
        Io.bg(() -> {
            try {
                String id = "out-" + System.nanoTime();
                try (FileVault.Writer w = new FileVault.Writer(app(), id)) { w.write(b, 0, b.length); }
                Io.main(() -> { r.sendFile(id, name, mime, b.length, outgoing("")); clearAfterSend(); });
            } catch (Exception e) {
                Io.main(() -> a.flash("", e.getMessage(), "error"));
            }
        });
    }

    void pickImage() { a.startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("image/*"), PICK); }
    void pickFile() { a.startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*"), PICK_FILE); }

    /** The camera writes into the app's cache (through our provider); the photo is then sent and the file deleted. */
    void capture() {
        if (!a.has(Manifest.permission.CAMERA)) { a.askPermissions(Manifest.permission.CAMERA); return; }
        Uri out = cz.m5cet.app.ui.media.VaultMedia.captureUri(app());
        try {
            a.startActivityForResult(new Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE).putExtra(android.provider.MediaStore.EXTRA_OUTPUT, out)
                .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION), CAPTURE);
        } catch (RuntimeException e) {
            a.flash("", app().t("file.noApp"), "warn");
        }
    }

    void captured() {
        java.io.File f = cz.m5cet.app.ui.media.VaultMedia.captureFile(app());
        if (!f.exists() || f.length() == 0) return;
        sendImage(Uri.fromFile(f));
        Io.mainLater(() -> { //noinspection ResultOfMethodCallIgnored
            f.delete(); }, 30_000);
    }

    /** location.share: the position as a message (the web's text, and loc for a pin). */
    void sharePosition() {
        RoomSession r = app().rooms.activeSession();
        if (r == null) return;
        if (!app().where.permitted()) { a.askPermissions(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION); return; }
        a.flash("", app().t("location.finding"), "info");
        app().where.current(l -> {
            if (l == null) { a.flash("", app().t("location.none"), "warn"); return; }
            Outgoing o = outgoing(String.format(java.util.Locale.ROOT, "📍 %.5f, %.5f (±%d m) %s", l.getLatitude(), l.getLongitude(), Math.round(l.getAccuracy()),
                Where.mapUrlWeb(l.getLatitude(), l.getLongitude())));
            o.loc = Where.json(l);
            r.send(o);
            clearAfterSend();
        });
    }

    /* ------------------------------------------------------- dictation */

    void toggleDictation() {
        Voice v = app().voice;
        if (v.dictating()) { v.stopDictation(); dictateIcon(false); return; }
        if (!a.has(Manifest.permission.RECORD_AUDIO)) { a.askPermissions(Manifest.permission.RECORD_AUDIO); return; }
        dictatedBase = input.getText().toString();
        if (!dictatedBase.isEmpty() && !dictatedBase.endsWith(" ")) dictatedBase += " ";
        v.dictate((text, done) -> {
            input.setText(dictatedBase + text);
            input.setSelection(input.getText().length());
            if (done) {
                dictatedBase = input.getText().toString() + " ";
                if (app().settings.bool("voice.dictateSend")) send();
            }
        });
        dictateIcon(true);
    }

    private void dictateIcon(boolean on) {
        int c = on ? Ui.color(getContext(), "@danger", Color.RED) : Ui.color(getContext(), "@onSurface", Color.BLACK);
        dictate.setImageDrawable(Icons.drawable(getContext(), on ? "mic-off" : "mic", Ui.dp(getContext(), 22), c));
    }

    /* ----------------------------------------------------- suggestions */

    /** / commands, @ people, # tags — up to 8 under the caret's word (Parts.suggest). */
    private void suggest() {
        suggestions.removeAllViews();
        List<String[]> items = parts.suggest(input.getText().toString(), input.getSelectionStart());
        if (items.isEmpty()) { suggestions.setVisibility(GONE); return; }
        int fg = Ui.color(getContext(), "@onSurface", Color.BLACK);
        for (String[] it : items) {
            LinearLayout line = new LinearLayout(getContext());
            line.setOrientation(VERTICAL);
            line.setPadding(Ui.dp(getContext(), 16), Ui.dp(getContext(), 8), Ui.dp(getContext(), 16), Ui.dp(getContext(), 8));
            line.setBackground(Ui.ripple(null, Ui.alpha(fg, 0.12f)));
            TextView t = new TextView(getContext());
            t.setText(it[0]);
            t.setTextColor(fg);
            t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14.5f);
            t.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
            line.addView(t);
            if (it.length > 1 && it[1] != null && !it[1].isEmpty()) {
                TextView d = new TextView(getContext());
                d.setText(it[1]);
                d.setTextColor(Ui.color(getContext(), "@muted", Color.GRAY));
                d.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
                line.addView(d);
            }
            String replacement = it.length > 2 ? it[2] : it[0];
            line.setOnClickListener(v -> { setText(replacement); suggestions.setVisibility(GONE); });
            suggestions.addView(line);
        }
        suggestions.setVisibility(VISIBLE);
    }

    @Override public void bindSlot(Expr.Scope scope) { refreshKinds(); }
}
