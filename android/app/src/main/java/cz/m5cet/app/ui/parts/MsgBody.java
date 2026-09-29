package cz.m5cet.app.ui.parts;

import android.annotation.SuppressLint;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Typeface;
import android.text.InputType;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.method.LinkMovementMethod;
import android.text.style.ClickableSpan;
import android.text.style.ForegroundColorSpan;
import android.text.style.StyleSpan;
import android.text.util.Linkify;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

import cz.m5cet.app.M5;
import cz.m5cet.app.chat.ChatMessage;
import cz.m5cet.app.chat.Sealed;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.ui.Expr;
import cz.m5cet.app.ui.Icons;
import cz.m5cet.app.ui.MainActivity;
import cz.m5cet.app.ui.Renderer;
import cz.m5cet.app.ui.Ui;
import cz.m5cet.app.ui.media.AudioBar;
import cz.m5cet.app.ui.media.VaultMedia;

/**
 * The body of a message bubble (6.1, slot "msgBody" in message.in / .out):
 * what the design's elements cannot draw — a sealed message and its code, a
 * held ("tap") message, a vanishing one and its time, the text with links,
 * mentions and tags, a command's outputs, and the attachment (a picture, a
 * voice message, a video, a file with its transfer).
 */
final class MsgBody extends LinearLayout implements Renderer.Slot {
    private static final Pattern MENTION = Pattern.compile("(^|[\\s(])([@#])([\\p{L}\\p{N}_][\\p{L}\\p{N}_.-]{0,39})");
    private final MainActivity a;
    private final Parts parts;
    private String boundKey = "";
    private boolean holding;
    private ChatMessage current;

    MsgBody(MainActivity a, Parts parts) {
        super(a);
        this.a = a;
        this.parts = parts;
        setOrientation(VERTICAL);
    }

    private M5 app() { return a.app(); }
    private int dp(float v) { return Ui.dp(getContext(), v); }

    @Override
    public void bindSlot(Expr.Scope scope) {
        Object o = scope.get("_msg");
        if (!(o instanceof ChatMessage)) { removeAllViews(); boundKey = ""; return; }
        ChatMessage m = (ChatMessage) o;
        if (current != m) holding = false;
        current = m;
        String key = m.id + "|" + m.vanished + "|" + (m.sealPlain != null) + "|" + holding + "|" + m.status + "|" + Math.round(m.fileProgress * 50) + "|" + (m.filePath != null) + "|" + m.visibleText().length();
        if (key.equals(boundKey)) return;
        boundKey = key;
        build(m);
    }

    private void build(ChatMessage m) {
        removeAllViews();
        boolean plain = "minimal".equals(cz.m5cet.app.design.Appearance.bubbles());
        int fg = Ui.color(getContext(), plain ? "@onSurface" : m.mine ? "@onBubbleOut" : "@onBubbleIn", Color.BLACK);
        int accent = m.mine ? fg : Ui.color(getContext(), "@primary", Color.BLUE);
        if (m.vanished) { addView(note(app().t("msg.vanished"), fg, true)); return; }
        boolean hidden = false;
        if (m.sealed != null && m.sealPlain == null) { addView(sealedBox(m, fg, accent)); hidden = true; }
        if (m.sealed != null && m.mine && m.sealCode != null) addView(note(app().t("msg.yourCode") + ": " + m.sealCode, fg, false));
        if (m.tap && !holding) { addView(holdChip(m, fg, accent)); hidden = true; }
        if (!hidden) {
            if (m.fnDraw() != null && m.fnDraw().optJSONArray("outputs") != null && m.fnDraw().optJSONArray("outputs").length() > 0) parts.fnOutputs(this, m, fg);
            else if (!m.visibleText().isEmpty()) addView(text(m.visibleText(), fg, accent));
            if (m.fileName != null) addView(attachment(m, fg, accent));
        }
        if (m.tap && holding) addView(note("👁 " + app().t("msg.holding"), fg, false));
        if (m.vanishSeconds > 0 && !m.vanished) {
            long left = Math.max(0, m.vanishSeconds - m.vanishedMs / 1000);
            addView(note("⏳ " + left + " s", fg, false));
        }
    }

    /* -------------------------------------------------------------- text */

    private TextView text(String s, int fg, int accent) {
        TextView t = new TextView(getContext());
        t.setTextColor(fg);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, (float) (15.5 * app().settings.num("appearance.fontScale")));
        t.setLineSpacing(0, 1.1f);
        SpannableString sp = new SpannableString(s);
        Matcher mt = MENTION.matcher(s);
        while (mt.find()) {
            int start = mt.start(2), end = mt.end(3);
            sp.setSpan(new ForegroundColorSpan(accent), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            sp.setSpan(new StyleSpan(Typeface.BOLD), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            if ("#".equals(mt.group(2))) {
                String tag = mt.group(3).toLowerCase(java.util.Locale.ROOT).replaceAll("[.-]+$", "");
                sp.setSpan(new ClickableSpan() {
                    @Override public void onClick(View w) { parts.filterTag(tag); }
                    @Override public void updateDrawState(android.text.TextPaint ds) { ds.setColor(accent); ds.setUnderlineText(false); }
                }, start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            }
        }
        t.setText(sp);
        Linkify.addLinks(t, Linkify.WEB_URLS | Linkify.EMAIL_ADDRESSES | Linkify.PHONE_NUMBERS);
        t.setLinkTextColor(accent);
        t.setMovementMethod(LinkMovementMethod.getInstance());
        t.setTextIsSelectable(false);
        return t;
    }

    private TextView note(String s, int fg, boolean italic) {
        TextView t = new TextView(getContext());
        t.setText(s);
        t.setTextColor(Ui.alpha(fg, 0.75f));
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
        if (italic) t.setTypeface(Typeface.defaultFromStyle(Typeface.ITALIC));
        t.setPadding(0, dp(2), 0, dp(2));
        return t;
    }

    /* ------------------------------------------------------- kinds */

    /** A sealed message: a code field and Open (PBKDF2 off the UI thread). */
    private View sealedBox(ChatMessage m, int fg, int accent) {
        LinearLayout box = new LinearLayout(getContext());
        box.setOrientation(VERTICAL);
        box.addView(note("🔒 " + app().t("msg.sealed"), fg, false));
        LinearLayout row = new LinearLayout(getContext());
        row.setGravity(Gravity.CENTER_VERTICAL);
        EditText code = new EditText(getContext());
        code.setHint("XXXX-XXXX-XXXX");
        code.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
        code.setTextColor(fg);
        code.setHintTextColor(Ui.alpha(fg, 0.5f));
        code.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        code.setBackground(Ui.shape(Ui.alpha(fg, 0.1f), dp(10), 0, 0));
        code.setPadding(dp(10), dp(6), dp(10), dp(6));
        row.addView(code, new LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        TextView open = chip(app().t("msg.open"), fg, accent);
        LayoutParams ol = new LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        ol.setMarginStart(dp(8));
        row.addView(open, ol);
        TextView err = note("", fg, false);
        err.setVisibility(GONE);
        open.setOnClickListener(v -> {
            String c = code.getText().toString();
            if (c.trim().isEmpty()) return;
            open.setEnabled(false);
            open.setText("…");
            Io.bg(() -> {
                String plain = Sealed.open(m.text, m.sealed, c);
                Io.main(() -> {
                    if (plain == null) { open.setEnabled(true); open.setText(app().t("msg.open")); err.setText(app().t("msg.wrongCode")); err.setVisibility(VISIBLE); return; }
                    m.sealPlain = plain;
                    boundKey = "";
                    build(m);
                });
            });
        });
        box.addView(row);
        box.addView(err);
        return box;
    }

    /** A "tap" message: visible only while held (pointer down), like the web's Hold to reveal. */
    @SuppressLint("ClickableViewAccessibility")
    private View holdChip(ChatMessage m, int fg, int accent) {
        TextView c = chip("👁 " + app().t("msg.holdToReveal"), fg, accent);
        c.setOnTouchListener((v, e) -> {
            if (e.getAction() == MotionEvent.ACTION_DOWN) { holding = true; parts.holding.add(m.id); boundKey = ""; build(m); return true; }
            return false;
        });
        return c;
    }

    @SuppressLint("ClickableViewAccessibility")
    @Override public boolean dispatchTouchEvent(MotionEvent e) {
        if (holding && (e.getAction() == MotionEvent.ACTION_UP || e.getAction() == MotionEvent.ACTION_CANCEL)) {
            holding = false;
            boundKey = "";
            if (current != null) { parts.holding.remove(current.id); build(current); }
        }
        return super.dispatchTouchEvent(e);
    }

    private TextView chip(String s, int fg, int accent) {
        TextView t = new TextView(getContext());
        t.setText(s);
        t.setTextColor(fg);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setGravity(Gravity.CENTER);
        t.setPadding(dp(12), dp(7), dp(12), dp(7));
        t.setBackground(Ui.ripple(Ui.shape(Ui.alpha(accent, 0.16f), dp(999), dp(1), Ui.alpha(accent, 0.5f)), Ui.alpha(fg, 0.2f)));
        return t;
    }

    /* -------------------------------------------------------- attachment */

    private View attachment(ChatMessage m, int fg, int accent) {
        boolean ready = m.fileDataUrl != null || (m.filePath != null && m.fileProgress < 0 && m.fileProgress > -2);
        String mime = m.fileMime == null ? "" : m.fileMime;
        if (ready && m.fileImage) return picture(m);
        if (ready && mime.startsWith("audio/")) {
            AudioBar bar = new AudioBar(getContext(), fg, accent);
            bar.set(() -> VaultMedia.source(app(), m), 0);
            return bar;
        }
        return fileCard(m, fg, accent, ready);
    }

    private View picture(ChatMessage m) {
        ImageView iv = new ImageView(getContext());
        iv.setAdjustViewBounds(true);
        iv.setMaxHeight(dp(300));
        iv.setMaxWidth(dp(260));
        iv.setScaleType(ImageView.ScaleType.FIT_START);
        iv.setClipToOutline(true);
        iv.setBackground(Ui.shape(Color.TRANSPARENT, dp(12), 0, 0));
        iv.setContentDescription(m.fileName);
        Bitmap cached = parts.imageCache.get(m.id);
        if (cached != null) iv.setImageBitmap(cached);
        else Io.bg(() -> {
            Bitmap b = VaultMedia.bitmap(app(), m, 1280);
            if (b != null) { parts.imageCache.put(m.id, b); Io.main(() -> iv.setImageBitmap(b)); }
        });
        iv.setOnClickListener(v -> parts.viewImage(m));
        LayoutParams lp = new LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(4);
        iv.setLayoutParams(lp);
        return iv;
    }

    private View fileCard(ChatMessage m, int fg, int accent, boolean ready) {
        LinearLayout card = new LinearLayout(getContext());
        card.setOrientation(VERTICAL);
        card.setPadding(dp(10), dp(8), dp(10), dp(8));
        card.setBackground(Ui.shape(Ui.alpha(fg, 0.08f), dp(12), 0, 0));
        LinearLayout row = new LinearLayout(getContext());
        row.setGravity(Gravity.CENTER_VERTICAL);
        ImageView ic = new ImageView(getContext());
        String mime = m.fileMime == null ? "" : m.fileMime;
        ic.setImageDrawable(Icons.drawable(getContext(), mime.startsWith("video/") ? "video" : mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "mic" : "file-text", dp(22), accent));
        row.addView(ic);
        LinearLayout col = new LinearLayout(getContext());
        col.setOrientation(VERTICAL);
        col.setPadding(dp(10), 0, 0, 0);
        TextView name = new TextView(getContext());
        name.setText(m.fileName);
        name.setTextColor(fg);
        name.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        name.setMaxLines(2);
        name.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);
        col.addView(name);
        String sub = Ui.size(m.fileSize) + (mime.isEmpty() ? "" : " · " + mime);
        if (m.fileProgress == -2) sub = "⚠ " + app().t("file.failed");
        else if (m.fileProgress >= 0) sub = Math.round(m.fileProgress * 100) + " % · " + Ui.size(m.fileSize);
        else if (m.filePath != null && !m.mine) sub += m.fileVerified ? " · ✓" : "";
        col.addView(note(sub, fg, false));
        row.addView(col, new LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        card.addView(row);
        if (m.fileProgress >= 0) {
            ProgressBar p = new ProgressBar(getContext(), null, android.R.attr.progressBarStyleHorizontal);
            p.setMax(1000);
            p.setProgress((int) Math.round(m.fileProgress * 1000));
            p.setProgressTintList(android.content.res.ColorStateList.valueOf(accent));
            card.addView(p, new LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(6)));
        }
        if (ready) {
            LinearLayout acts = new LinearLayout(getContext());
            acts.setGravity(Gravity.END);
            acts.setPadding(0, dp(6), 0, 0);
            TextView open = chip(app().t("file.open"), fg, accent);
            open.setOnClickListener(v -> parts.openFile(m));
            TextView save = chip(app().t("file.save"), fg, accent);
            save.setOnClickListener(v -> parts.saveFile(m));
            acts.addView(open);
            LayoutParams sl = new LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            sl.setMarginStart(dp(8));
            acts.addView(save, sl);
            card.addView(acts);
        }
        FrameLayout wrap = new FrameLayout(getContext());
        wrap.setPadding(0, dp(4), 0, 0);
        wrap.addView(card);
        return wrap;
    }
}
