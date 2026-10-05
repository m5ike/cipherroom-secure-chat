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
import android.util.LruCache;
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
import cz.m5cet.app.ui.bubble.Hides;
import cz.m5cet.app.ui.bubble.MapPolicy;
import cz.m5cet.app.ui.media.AudioBar;
import cz.m5cet.app.ui.media.Previews;
import cz.m5cet.app.ui.media.VaultMedia;
import cz.m5cet.app.ui.media.VideoBox;

/**
 * The body of a message bubble (6.1, slot "msgBody" in message.in / .out):
 * what the design's elements cannot draw — a sealed message and its code, a
 * held ("tap") message, a vanishing one and its time, the text with links,
 * mentions and tags, a command's outputs, and the attachment.
 *
 * 6.2: a position message is a map (MapBubble; the text and the pin when
 * the operator switched maps off or the server cannot be reached); an
 * attachment shows a preview — a picture, a voice or audio player, a video
 * played in place, the first page of a PDF, the first lines of a text —
 * and under it a footer: its type, name and size with save, share and
 * forward. Revealing a held message and opening a sealed one are steps of
 * the message's timeline.
 */
final class MsgBody extends LinearLayout implements Renderer.Slot {
    private static final Pattern MENTION = Pattern.compile("(^|[\\s(])([@#])([\\p{L}\\p{N}_][\\p{L}\\p{N}_.-]{0,39})");
    /** Text previews and a PDF's page count / a video's size and length (by message id); the pictures are in Parts.imageCache. */
    private static final LruCache<String, Object> META = new LruCache<>(300);
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

    /** A deleted message's previews leave memory too. */
    static void forget(String id) { for (String k : new String[]{id + "#text", id + "#pdf", id + "#video"}) META.remove(k); }

    private M5 app() { return a.app(); }
    private int dp(float v) { return Ui.dp(getContext(), v); }
    /** The widest a map or a preview gets: the bubble's content (300 dp less its padding). */
    private int maxW() { return dp(276); }

    @Override
    public void bindSlot(Expr.Scope scope) {
        Object o = scope.get("_msg");
        if (!(o instanceof ChatMessage)) { removeAllViews(); boundKey = ""; return; }
        ChatMessage m = (ChatMessage) o;
        if (current != m) holding = false;
        current = m;
        MapPolicy map = MapBubble.policyFor(app(), m);
        String key = m.id + "|" + m.vanished + "|" + (m.sealPlain != null) + "|" + holding + "|" + Math.round(m.fileProgress * 50) + "|" + (m.filePath != null) + "|" + m.visibleText().length()
            + "|" + (map == null ? "" : map.hashCode()) + "|" + m.hiddenUntil + "|" + fnState(m);
        if (key.equals(boundKey)) return;
        boundKey = key;
        build(m);
    }

    private void rebuild(ChatMessage m) { if (current == m) { boundKey = ""; build(m); } }

    /**
     * 6.11: what of a command's state the body draws — its loading, progress,
     * status and outputs (they change in place: the row must draw again; the
     * text alone did not say so, and a status chip waited for a scroll).
     */
    private static String fnState(ChatMessage m) {
        org.json.JSONObject fd = m.fnDraw();
        if (fd == null) return "";
        org.json.JSONObject st = fd.optJSONObject("status"), pr = fd.optJSONObject("progress");
        org.json.JSONArray outs = fd.optJSONArray("outputs");
        return fd.optBoolean("pending") + "/" + (st == null ? "" : st.optString("kind") + st.optString("code") + st.optString("label"))
            + "/" + (pr == null ? "" : Math.round(pr.optDouble("p", -1) * 100) + pr.optString("text")) + "/" + (outs == null ? -1 : outs.length());
    }

    private void build(ChatMessage m) {
        removeAllViews();
        stopPulse(); // 6.5: a previous call's pulse, if any
        setMinimumWidth(0);
        setPadding(0, 0, 0, 0);
        boolean plain = "minimal".equals(cz.m5cet.app.design.Appearance.bubbles());
        // 6.11: a model's answer is drawn as an incoming message even when this device sent it to the room.
        boolean model = cz.m5cet.app.ui.bubble.ModelFace.of(m) != null;
        boolean out = m.mine && !model;
        int fg = Ui.color(getContext(), plain ? "@onSurface" : out ? "@onBubbleOut" : "@onBubbleIn", Color.BLACK);
        int accent = out ? fg : Ui.color(getContext(), "@primary", Color.BLUE);
        if (m.vanished) { addView(note(app().t("msg.vanished"), fg, true)); return; }
        if (m.hiddenUntil != 0 && Hides.hidden(m, System.currentTimeMillis())) addView(note(hiddenNote(m), fg, true)); // shown only with "show hidden"
        boolean hidden = false;
        if (m.sealed != null && m.sealPlain == null) { addView(sealedBox(m, fg, accent)); hidden = true; }
        if (m.sealed != null && m.mine && m.sealCode != null) addView(note(app().t("msg.yourCode") + ": " + m.sealCode, fg, false));
        if (m.tap && !holding) { addView(holdChip(m, fg, accent)); hidden = true; }
        if (!hidden) {
            MapPolicy map = MapBubble.policyFor(app(), m);
            boolean positionMap = map != null && cz.m5cet.app.ui.bubble.Kinds.isPositionMessage(m);
            org.json.JSONObject fd = m.fnDraw();
            boolean fnCall = fd != null && (fd.has("query") || fd.optBoolean("pending") || fd.optJSONObject("status") != null);
            boolean fnOut = fd != null && fd.optJSONArray("outputs") != null && fd.optJSONArray("outputs").length() > 0;
            if (model && !fnCall) fitAnswer(fd);                            // 6.11: the answer's bubble fits what it shows
            if (model && !fnCall && fd != null && fd.optBoolean("problem")) addView(problemHead(fd));
            if (fnCall) fnCall(m, fd, fg, accent);                          // 6.5: query + loading / result / status
            else if (fnOut) parts.fnOutputs(this, m, fg);
            else if (positionMap) addView(MapBubble.build(a, parts, m, map, fg, maxW(), () -> rebuild(m)));
            else if (!m.visibleText().isEmpty()) addView(text(m.visibleText(), fg, accent));
            if (m.fileName != null) attachment(m, fg, accent);
        }
        if (m.tap && holding) addView(note("👁 " + app().t("msg.holding"), fg, false));
        if (m.vanishSeconds > 0 && !m.vanished) {
            long left = Math.max(0, m.vanishSeconds - m.vanishedMs / 1000);
            addView(note("⏳ " + left + " s", fg, false));
        }
    }

    private String hiddenNote(ChatMessage m) {
        if (m.hiddenUntil == ChatMessage.UNTIL_SIGNIN) return app().t("msg.hiddenSignin");
        return app().t("msg.hiddenUntil") + " " + cz.m5cet.app.core.Formats.time(app().lang(), m.hiddenUntil);
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

    /* ----------------------------------------------- 6.5 a command call */

    /**
     * The call's own bubble: the query, then the loading indicator (6.11: with
     * what the model says it is doing, and how far) / result / status. The
     * run's clock (Fn, 30 s) settles it; a bubble from before a restart that
     * still loads is over after 5 minutes.
     */
    private void fnCall(ChatMessage m, org.json.JSONObject fd, int fg, int accent) {
        String query = fd.optString("query", "");
        if (!query.isEmpty()) addView(text(query, fg, accent));
        boolean pending = fd.optBoolean("pending", false) && System.currentTimeMillis() - m.createdAt < 300_000;
        org.json.JSONObject status = fd.optJSONObject("status");
        if (pending) {
            LinearLayout col = new LinearLayout(getContext());
            col.setOrientation(LinearLayout.VERTICAL);
            col.setGravity(Gravity.CENTER_HORIZONTAL);
            col.setPadding(0, dp(6), 0, dp(2));
            col.addView(new DotsView(getContext(), fg));
            org.json.JSONObject progress = fd.optJSONObject("progress");
            String said = progress == null ? "" : progress.optString("text", "").trim();
            double p = progress == null ? -1 : progress.optDouble("p", -1);
            if (p > 0 && p <= 1) {
                ProgressBar bar = new ProgressBar(getContext(), null, android.R.attr.progressBarStyleHorizontal);
                bar.setMax(1000);
                bar.setProgress((int) Math.round(p * 1000));
                bar.setProgressTintList(android.content.res.ColorStateList.valueOf(fg));
                bar.setContentDescription(Math.round(p * 100) + " %");
                LayoutParams bl = new LayoutParams(dp(160), dp(4));
                bl.topMargin = dp(4);
                col.addView(bar, bl);
            }
            TextView lbl = new TextView(getContext());
            lbl.setText(!said.isEmpty() ? said : app().t("functions.running").replace("{name}", fd.optString("name", "")));
            lbl.setTextColor(Ui.alpha(fg, 0.7f));
            lbl.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f);
            lbl.setGravity(Gravity.CENTER_HORIZONTAL);
            lbl.setPadding(0, dp(3), 0, 0);
            lbl.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
            col.addView(lbl);
            addView(col);
            startPulse();
        } else if (status != null) {
            addView(statusChip(status, fg, accent));
        } else {
            parts.fnOutputs(this, m, fg); // settled with the caller-only result (a bubble from before 6.11)
        }
    }

    /** 6.11: the command's end — an icon and a word: answered below, sent to the room, an error (the timeout, a wrong call…), cancelled. */
    private View statusChip(org.json.JSONObject status, int fg, int accent) {
        String kind = status.optString("kind", "info");
        String code = status.optString("code", "");
        int col = "error".equals(kind) ? Ui.color(getContext(), "@danger", 0xFFCC3333) : "ok".equals(kind) ? accent : Ui.alpha(fg, 0.75f);
        String icon = "error".equals(kind) ? ("timeout".equals(code) ? "clock" : "circle-alert") : "ok".equals(kind) ? ("sent".equals(code) ? "users" : "circle-check")
            : "cancelled".equals(code) ? "circle-x" : "info";
        String label = status.optString("label", "");
        if (label.isEmpty() && !code.isEmpty()) label = app().t("fnm." + code);
        LinearLayout row = new LinearLayout(getContext());
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(8), dp(4), dp(10), dp(4));
        row.setBackground(Ui.shape(Ui.alpha(col, 0.12f), dp(999), 0, 0));
        ImageView ic = new ImageView(getContext());
        ic.setImageDrawable(Icons.drawable(getContext(), icon, dp(16), col));
        ic.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        row.addView(ic, new LayoutParams(dp(16), dp(16)));
        TextView t = new TextView(getContext());
        t.setText(label);
        t.setTextColor(col);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f);
        t.setPadding(dp(6), 0, 0, 0);
        row.addView(t);
        row.setContentDescription(label);
        LinearLayout wrap = new LinearLayout(getContext());
        wrap.setPadding(0, dp(4), 0, dp(1));
        wrap.addView(row, new LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return wrap;
    }

    /**
     * 6.11: a model's answer fits what it shows — at least a comfortable
     * width, and the whole row's width (less a margin) for what needs room:
     * a table, code, JSON, a form, a page, a picture, a video.
     */
    private void fitAnswer(org.json.JSONObject fd) {
        org.json.JSONArray outs = fd == null ? null : fd.optJSONArray("outputs");
        boolean wide = false;
        for (int i = 0; outs != null && i < outs.length(); i++) {
            org.json.JSONObject o = outs.optJSONObject(i);
            String t = o == null ? "" : o.optString("type");
            if (t.equals("table") || t.equals("code") || t.equals("json") || t.equals("form") || t.equals("html") || t.equals("image") || t.equals("video")) { wide = true; break; }
        }
        // The row: 12 dp each side, the 36 dp avatar and 8 dp gap, the bubble's 12 dp padding each side; a 16 dp margin keeps it an incoming bubble.
        int avail = getResources().getDisplayMetrics().widthPixels - dp(12 + 12 + 36 + 8 + 24 + 16);
        setMinimumWidth(Math.max(0, Math.min(wide ? dp(560) : dp(220), avail)));
        setPadding(0, dp(2), 0, dp(2));
    }

    /** 6.11: a wrong call's answer starts with what it is about, in the danger colour. */
    private View problemHead(org.json.JSONObject fd) {
        int danger = Ui.color(getContext(), "@danger", 0xFFCC3333);
        LinearLayout row = new LinearLayout(getContext());
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(0, dp(2), 0, dp(6));
        ImageView ic = new ImageView(getContext());
        ic.setImageDrawable(Icons.drawable(getContext(), "circle-alert", dp(18), danger));
        ic.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        row.addView(ic, new LayoutParams(dp(18), dp(18)));
        TextView t = new TextView(getContext());
        t.setText(fd.optString("title", ""));
        t.setTextColor(danger);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14.5f);
        t.setPadding(dp(8), 0, 0, 0);
        row.addView(t, new LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        return row;
    }

    /** Three dots that bounce in turn — a self-contained loading indicator. */
    private static final class DotsView extends View {
        private final android.graphics.Paint paint = new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);
        private final android.animation.ValueAnimator anim;
        private float phase;
        DotsView(android.content.Context c, int color) {
            super(c);
            paint.setColor(color);
            anim = android.animation.ValueAnimator.ofFloat(0f, (float) (Math.PI * 2));
            anim.setDuration(1000);
            anim.setRepeatCount(android.animation.ValueAnimator.INFINITE);
            anim.setInterpolator(new android.view.animation.LinearInterpolator());
            anim.addUpdateListener(a -> { phase = (float) a.getAnimatedValue(); invalidate(); });
        }
        @Override protected void onMeasure(int wSpec, int hSpec) {
            float d = getResources().getDisplayMetrics().density;
            setMeasuredDimension(Math.round(28 * d), Math.round(14 * d));
        }
        @Override protected void onAttachedToWindow() { super.onAttachedToWindow(); anim.start(); }
        @Override protected void onDetachedFromWindow() { anim.cancel(); super.onDetachedFromWindow(); }
        @Override protected void onDraw(android.graphics.Canvas canvas) {
            float d = getResources().getDisplayMetrics().density;
            float r = 3f * d, gap = 8f * d, cy = getHeight() / 2f, amp = 3.2f * d, mid = getWidth() / 2f;
            for (int i = 0; i < 3; i++) {
                float off = Math.max(0f, (float) Math.sin(phase - i * 0.6f));
                paint.setAlpha(Math.round((0.45f + 0.55f * off) * 255));
                canvas.drawCircle(mid + (i - 1) * gap, cy - off * amp, r, paint);
            }
        }
    }

    /* The whole bubble pulses while a call runs (ancestor with the bubble background). */
    private android.animation.ObjectAnimator pulse;
    private void startPulse() {
        stopPulse();
        View target = this;
        View v = this;
        for (int i = 0; i < 4 && v.getParent() instanceof View; i++) { v = (View) v.getParent(); if (v.getBackground() != null) { target = v; break; } }
        pulse = android.animation.ObjectAnimator.ofFloat(target, "alpha", 1f, 0.82f);
        pulse.setDuration(1600);
        pulse.setRepeatCount(android.animation.ObjectAnimator.INFINITE);
        pulse.setRepeatMode(android.animation.ObjectAnimator.REVERSE);
        pulse.start();
    }
    private void stopPulse() {
        if (pulse == null) return;
        Object t = pulse.getTarget();
        pulse.cancel();
        if (t instanceof View) ((View) t).setAlpha(1f);
        pulse = null;
    }
    @Override protected void onDetachedFromWindow() { stopPulse(); super.onDetachedFromWindow(); }

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
                    if (m.mark("opened")) parts.touched(m);
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
            if (e.getAction() == MotionEvent.ACTION_DOWN) {
                holding = true;
                parts.holding.add(m.id);
                if (m.mark("revealed")) parts.touched(m); // the first time it was shown
                boundKey = "";
                build(m);
                return true;
            }
            return false;
        });
        return c;
    }

    /** 6.7: is this body drawing m now (HoldArea finds its row's body). */
    boolean showing(ChatMessage m) { return m != null && current == m; }

    /** 6.7: held from beside the bubble (HoldArea) — the same as holding the chip; letting go hides it again. */
    void hold(ChatMessage m, boolean on) {
        if (m == null) return;
        if (!on) parts.holding.remove(m.id);
        if (current != m || !m.tap || holding == on) return;
        holding = on;
        if (on) {
            parts.holding.add(m.id);
            if (m.mark("revealed")) parts.touched(m); // the first time it was shown
        }
        boundKey = "";
        build(m);
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

    /** The preview (when the type has one and the file is here), then the footer. */
    private void attachment(ChatMessage m, int fg, int accent) {
        boolean ready = m.fileDataUrl != null || (m.filePath != null && m.fileProgress < 0 && m.fileProgress > -2);
        Previews.Type type = Previews.type(m);
        View preview = null;
        if (ready) switch (type) {
            case IMAGE: preview = picture(m); break;
            case AUDIO: {
                AudioBar bar = new AudioBar(getContext(), fg, accent);
                bar.set(() -> VaultMedia.source(app(), m), 0);
                preview = bar;
                break;
            }
            case VIDEO: preview = video(m); break;
            case PDF: preview = pdf(m, fg); break;
            case TEXT: preview = textHead(m, fg); break;
            default: break;
        }
        if (preview != null) addView(preview);
        addView(footer(m, type, fg, accent, ready));
    }

    private LayoutParams gap(int w, int h) {
        LayoutParams lp = new LayoutParams(w, h);
        lp.topMargin = dp(4);
        return lp;
    }

    private View picture(ChatMessage m) {
        ImageView iv = new ImageView(getContext());
        iv.setAdjustViewBounds(true);
        iv.setMaxHeight(dp(300));
        iv.setMaxWidth(maxW());
        iv.setScaleType(ImageView.ScaleType.FIT_START);
        iv.setClipToOutline(true);
        iv.setContentDescription(m.fileName);
        Bitmap cached = parts.imageCache.get(m.id);
        if (cached != null) {
            iv.setBackground(Ui.shape(Color.TRANSPARENT, dp(12), 0, 0));
            iv.setImageBitmap(cached);
            iv.setLayoutParams(gap(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        } else {
            // A placeholder of a picture's size while it is decoded, so the list does not jump twice.
            iv.setBackground(Ui.shape(Ui.alpha(Color.GRAY, 0.18f), dp(12), 0, 0));
            iv.setLayoutParams(gap(dp(200), dp(150)));
            Io.bg(() -> {
                Bitmap b = VaultMedia.bitmap(app(), m, 1280);
                if (b == null) return;
                parts.imageCache.put(m.id, b);
                Io.main(() -> {
                    iv.setBackground(Ui.shape(Color.TRANSPARENT, dp(12), 0, 0));
                    iv.setLayoutParams(gap(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
                    iv.setImageBitmap(b);
                });
            });
        }
        iv.setOnClickListener(v -> parts.viewImage(m));
        return iv;
    }

    private View video(ChatMessage m) {
        VideoBox box = new VideoBox(getContext(), maxW());
        box.set(() -> VaultMedia.source(app(), m));
        box.setLayoutParams(gap(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        Bitmap poster = parts.imageCache.get(m.id + "#poster");
        Object meta = META.get(m.id + "#video");
        if (meta instanceof long[]) { long[] v = (long[]) meta; box.frame(poster, (int) v[0], (int) v[1], v[2]); }
        else Io.bg(() -> {
            Previews.Frame f = Previews.videoFrame(app(), m, 720);
            if (f == null) return;
            if (f.bitmap != null) parts.imageCache.put(m.id + "#poster", f.bitmap);
            META.put(m.id + "#video", new long[]{f.width, f.height, f.durationMs});
            Io.main(() -> box.frame(f.bitmap, f.width, f.height, f.durationMs));
        });
        return box;
    }

    /** The first page (a white sheet, the page count in its corner); a tap opens it in another app. */
    private View pdf(ChatMessage m, int fg) {
        FrameLayout box = new FrameLayout(getContext());
        box.setClipToOutline(true);
        box.setBackground(Ui.shape(Color.WHITE, dp(10), dp(1), Ui.alpha(fg, 0.2f)));
        ImageView iv = new ImageView(getContext());
        iv.setAdjustViewBounds(true);
        iv.setMaxHeight(dp(260));
        iv.setScaleType(ImageView.ScaleType.FIT_START);
        iv.setContentDescription(m.fileName);
        box.addView(iv, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        TextView badge = new TextView(getContext());
        badge.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        badge.setTextColor(Color.WHITE);
        badge.setPadding(dp(6), dp(2), dp(6), dp(2));
        badge.setBackground(Ui.shape(0xAA000000, dp(8), 0, 0));
        FrameLayout.LayoutParams bl = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM | Gravity.END);
        bl.setMargins(0, 0, dp(6), dp(6));
        box.addView(badge, bl);
        badge.setVisibility(GONE);
        int w = Math.min(maxW(), dp(220));
        box.setLayoutParams(gap(w, dp(120)));
        Runnable[] show = new Runnable[1];
        show[0] = () -> {
            Bitmap b = parts.imageCache.get(m.id + "#pdf");
            Object pages = META.get(m.id + "#pdf");
            if (b == null) return;
            iv.setImageBitmap(b);
            box.setLayoutParams(gap(w, ViewGroup.LayoutParams.WRAP_CONTENT));
            if (pages instanceof Integer) { badge.setText("PDF · " + pages + " " + app().t("file.pages")); badge.setVisibility(VISIBLE); }
        };
        if (parts.imageCache.get(m.id + "#pdf") != null) show[0].run();
        else Io.bg(() -> {
            Previews.Page p = Previews.pdfFirstPage(app(), m, Math.min(1080, w * 2));
            if (p == null) { Io.main(() -> box.setVisibility(GONE)); return; }
            parts.imageCache.put(m.id + "#pdf", p.bitmap);
            META.put(m.id + "#pdf", p.pages);
            Io.main(show[0]);
        });
        box.setOnClickListener(v -> parts.openFile(m));
        return box;
    }

    /** The first lines of a text file (a tap opens it). */
    private View textHead(ChatMessage m, int fg) {
        TextView t = new TextView(getContext());
        t.setTextColor(fg);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
        t.setMaxLines(8);
        t.setEllipsize(android.text.TextUtils.TruncateAt.END);
        String name = m.fileName == null ? "" : m.fileName.toLowerCase(java.util.Locale.ROOT);
        if (!name.endsWith(".md") && !name.endsWith(".markdown") && !name.endsWith(".txt")) t.setTypeface(Typeface.MONOSPACE);
        t.setPadding(dp(10), dp(8), dp(10), dp(8));
        t.setBackground(Ui.shape(Ui.alpha(fg, 0.07f), dp(10), 0, 0));
        t.setLayoutParams(gap(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        Object cached = META.get(m.id + "#text");
        if (cached instanceof String) t.setText((String) cached);
        else {
            t.setText("…");
            Io.bg(() -> {
                String head = Previews.textHead(app(), m, 8);
                if (head == null || head.isEmpty()) { Io.main(() -> t.setVisibility(GONE)); return; }
                META.put(m.id + "#text", head);
                Io.main(() -> t.setText(head));
            });
        }
        t.setOnClickListener(v -> parts.openFile(m));
        return t;
    }

    /** Under the content: the type, name and size, then save, share and forward (or the transfer's progress). */
    private View footer(ChatMessage m, Previews.Type type, int fg, int accent, boolean ready) {
        LinearLayout box = new LinearLayout(getContext());
        box.setOrientation(VERTICAL);
        box.setPadding(0, dp(6), 0, 0);
        LinearLayout row = new LinearLayout(getContext());
        row.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout what = new LinearLayout(getContext());
        what.setGravity(Gravity.CENTER_VERTICAL);
        ImageView ic = new ImageView(getContext());
        ic.setImageDrawable(Icons.drawable(getContext(), Previews.icon(type), dp(20), accent));
        what.addView(ic);
        LinearLayout col = new LinearLayout(getContext());
        col.setOrientation(VERTICAL);
        col.setPadding(dp(8), 0, dp(4), 0);
        TextView name = new TextView(getContext());
        name.setText(m.fileName);
        name.setTextColor(fg);
        name.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        name.setSingleLine(true);
        name.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);
        col.addView(name);
        String sub = Ui.size(m.fileSize);
        if (m.fileProgress == -2) sub = "⚠ " + app().t("file.failed");
        else if (m.fileProgress >= 0) sub = Math.round(m.fileProgress * 100) + " % · " + Ui.size(m.fileSize);
        else if (m.filePath != null && !m.mine && m.fileVerified) sub += " · ✓";
        TextView size = note(sub, fg, false);
        size.setPadding(0, 0, 0, 0);
        size.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11.5f);
        col.addView(size);
        what.addView(col, new LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        row.addView(what, new LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        if (ready) {
            what.setBackground(Ui.ripple(null, Ui.alpha(fg, 0.16f)));
            what.setOnClickListener(v -> parts.openFile(m));
            what.setContentDescription(app().t("file.open") + " " + m.fileName);
            row.addView(action("download", app().t("file.save"), fg, v -> parts.saveFile(m)));
            row.addView(action("share-2", app().t("file.share"), fg, v -> parts.shareFile(m)));
            row.addView(action("forward", app().t("msg.forward"), fg, v -> parts.forward(m)));
        }
        box.addView(row);
        if (m.fileProgress >= 0) {
            ProgressBar p = new ProgressBar(getContext(), null, android.R.attr.progressBarStyleHorizontal);
            p.setMax(1000);
            p.setProgress((int) Math.round(m.fileProgress * 1000));
            p.setProgressTintList(android.content.res.ColorStateList.valueOf(accent));
            box.addView(p, new LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(6)));
        }
        return box;
    }

    private View action(String icon, String label, int fg, View.OnClickListener click) {
        ImageView b = new ImageView(getContext());
        b.setScaleType(ImageView.ScaleType.CENTER);
        b.setImageDrawable(Icons.drawable(getContext(), icon, dp(18), fg));
        b.setBackground(Ui.ripple(null, Ui.alpha(fg, 0.2f)));
        b.setContentDescription(label);
        b.setTooltipText(label);
        b.setOnClickListener(click);
        b.setLayoutParams(new LayoutParams(dp(34), dp(34)));
        return b;
    }
}
