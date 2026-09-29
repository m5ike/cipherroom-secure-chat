package cz.m5cet.app.ui.parts;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.inputmethod.EditorInfo;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

import cz.m5cet.app.chat.ChatMessage;
import cz.m5cet.app.chat.RoomSession;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.ui.Expr;
import cz.m5cet.app.ui.Icons;
import cz.m5cet.app.ui.MainActivity;
import cz.m5cet.app.ui.Renderer;
import cz.m5cet.app.ui.Ui;

/**
 * Writing: the text field, a reply preview, a picture (inline, up to
 * 512 KiB like the web client, scaled down when bigger), send.
 */
final class Composer extends LinearLayout implements Renderer.Slot {
    static final int PICK = 7301;
    private final MainActivity a;
    private final EditText input;
    private final TextView reply;
    private ChatMessage replyTo;

    Composer(MainActivity a, Parts parts) {
        super(a);
        this.a = a;
        setOrientation(VERTICAL);
        int fg = Ui.color(a, "@onSurface", Color.BLACK);
        setBackgroundColor(Ui.color(a, "@surface", Color.WHITE));
        setElevation(Ui.dp(a, 6));
        reply = new TextView(a);
        reply.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        reply.setTextColor(Ui.color(a, "@muted", Color.GRAY));
        reply.setPadding(Ui.dp(a, 16), Ui.dp(a, 6), Ui.dp(a, 16), 0);
        reply.setVisibility(GONE);
        reply.setOnClickListener(v -> setReply(null));
        addView(reply);
        LinearLayout row = new LinearLayout(a);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(Ui.dp(a, 6), Ui.dp(a, 6), Ui.dp(a, 6), Ui.dp(a, 6));
        ImageView attach = iconButton("image", fg);
        attach.setOnClickListener(v -> a.startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("image/*"), PICK));
        row.addView(attach);
        input = new EditText(a);
        input.setHint(a.app().t("room.typeMessage"));
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        input.setMaxLines(5);
        input.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        input.setTextColor(fg);
        input.setHintTextColor(Ui.color(a, "@muted", Color.GRAY));
        input.setBackground(Ui.shape(Ui.color(a, "@surfaceVariant", Color.LTGRAY), Ui.dp(a, 22), 0, 0));
        input.setPadding(Ui.dp(a, 16), Ui.dp(a, 10), Ui.dp(a, 16), Ui.dp(a, 10));
        input.setImeOptions(EditorInfo.IME_ACTION_SEND);
        Object pending = a.form().remove("composer");
        if (pending != null) input.setText(String.valueOf(pending));
        LayoutParams il = new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f);
        il.setMargins(Ui.dp(a, 4), 0, Ui.dp(a, 4), 0);
        row.addView(input, il);
        ImageView send = iconButton("send-horizontal", Ui.color(a, "@onPrimary", Color.WHITE));
        send.setBackground(Ui.ripple(Ui.shape(Ui.color(a, "@primary", Color.RED), Ui.dp(a, 22), 0, 0), 0x33FFFFFF));
        send.setContentDescription(a.app().t("room.send"));
        send.setOnClickListener(v -> send());
        row.addView(send);
        addView(row);
        a.parts.composer = this;
        attachResult();
    }

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
        reply.setText("↪ " + m.senderName + ": " + (m.text.length() > 80 ? m.text.substring(0, 79) + "…" : m.text) + "   ✕");
        reply.setVisibility(VISIBLE);
        input.requestFocus();
    }

    void send() {
        String text = input.getText().toString().trim();
        RoomSession r = a.app().rooms.activeSession();
        if (text.isEmpty() || r == null) return;
        r.send(text, replyTo, null, null, null, 0);
        input.setText("");
        setReply(null);
    }

    /** The picked picture: scaled to at most 1280 px, JPEG, inline when ≤ 512 KiB. */
    void sendImage(Uri uri) {
        RoomSession r = a.app().rooms.activeSession();
        if (r == null) return;
        Io.bg(() -> {
            try (InputStream in = a.getContentResolver().openInputStream(uri)) {
                if (in == null) return;
                byte[] raw = in.readAllBytes();
                android.graphics.Bitmap bm = android.graphics.BitmapFactory.decodeByteArray(raw, 0, raw.length);
                if (bm == null) return;
                float scale = Math.min(1f, 1280f / Math.max(bm.getWidth(), bm.getHeight()));
                if (scale < 1f) bm = android.graphics.Bitmap.createScaledBitmap(bm, Math.round(bm.getWidth() * scale), Math.round(bm.getHeight() * scale), true);
                byte[] jpeg = null;
                for (int q = 85; q >= 40; q -= 15) {
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    bm.compress(android.graphics.Bitmap.CompressFormat.JPEG, q, out);
                    jpeg = out.toByteArray();
                    if (jpeg.length <= 512 * 1024) break;
                }
                if (jpeg == null || jpeg.length > 512 * 1024) { Io.main(() -> a.flash("", "too large", "warn")); return; }
                String dataUrl = "data:image/jpeg;base64," + android.util.Base64.encodeToString(jpeg, android.util.Base64.NO_WRAP);
                String caption = input.getText().toString().trim();
                r.send(caption, replyTo, "image.jpg", "image/jpeg", dataUrl, jpeg.length);
                Io.main(() -> { input.setText(""); setReply(null); });
            } catch (Exception e) {
                Log.e("composer", "the picture could not be sent", e);
            }
        });
    }

    private void attachResult() { }

    @Override public void bindSlot(Expr.Scope scope) { }

    static { Activity.class.getName(); }
}
