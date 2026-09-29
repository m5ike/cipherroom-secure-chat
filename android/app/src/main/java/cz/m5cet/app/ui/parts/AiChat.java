package cz.m5cet.app.ui.parts;

import android.graphics.Color;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;

import java.util.concurrent.Executor;

import cz.m5cet.app.M5;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.fn.Assistant;
import cz.m5cet.app.fn.Markdown;
import cz.m5cet.app.ui.Expr;
import cz.m5cet.app.ui.MainActivity;
import cz.m5cet.app.ui.Renderer;
import cz.m5cet.app.ui.Ui;

/**
 * The AI assistant's conversation (6.1, slot "aiChat"): a scrolling thread of
 * turns and an input row. The server-side model streams its answer — the
 * assistant runs on the main thread (the executor we give it), so each piece
 * lands here as it comes. AI is not end-to-end encrypted and the screen says so.
 */
final class AiChat extends LinearLayout implements Renderer.Slot {
    private final MainActivity a;
    private final M5 app;
    private final Executor main = Io::main;
    private final Assistant assistant;

    private final ScrollView scroller;
    private final LinearLayout thread;
    private final EditText input;
    private final ImageButton send;
    private final TextView banner;
    private boolean loaded;

    AiChat(MainActivity a, Parts parts) {
        super(a);
        this.a = a;
        this.app = a.app();
        this.assistant = parts.fn.assistant();
        setOrientation(VERTICAL);

        banner = new TextView(a);
        banner.setTextColor(Ui.color(a, "@muted", Color.GRAY));
        banner.setTextSize(12);
        banner.setPadding(Ui.dp(a, 16), Ui.dp(a, 8), Ui.dp(a, 16), Ui.dp(a, 4));
        banner.setText(app.t("ai.notE2ee"));
        addView(banner);

        thread = new LinearLayout(a);
        thread.setOrientation(VERTICAL);
        thread.setPadding(Ui.dp(a, 12), Ui.dp(a, 6), Ui.dp(a, 12), Ui.dp(a, 12));
        scroller = new ScrollView(a);
        scroller.addView(thread, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        addView(scroller, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));

        LinearLayout row = new LinearLayout(a);
        row.setOrientation(HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(Ui.dp(a, 12), Ui.dp(a, 6), Ui.dp(a, 12), Ui.dp(a, 12));
        input = new EditText(a);
        input.setHint(app.t("ai.placeholder"));
        input.setMaxLines(5);
        input.setBackground(Ui.shape(Ui.color(a, "@surfaceVariant", 0xFFEEEEEE), Ui.dp(a, 20), 0, 0));
        input.setPadding(Ui.dp(a, 16), Ui.dp(a, 10), Ui.dp(a, 16), Ui.dp(a, 10));
        input.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int st, int c, int af) { }
            @Override public void onTextChanged(CharSequence s, int st, int b, int c) { }
            @Override public void afterTextChanged(Editable s) { refreshSend(); }
        });
        send = new ImageButton(a);
        send.setBackground(null);
        LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(Ui.dp(a, 44), Ui.dp(a, 44));
        sp.leftMargin = Ui.dp(a, 6);
        send.setLayoutParams(sp);
        send.setOnClickListener(v -> { if (assistant.busy()) stop(); else send(); });
        row.addView(input, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        row.addView(send);
        addView(row);
    }

    @Override protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        if (!loaded) { loaded = true; assistant.loadStatus(bearer(), main, s -> render()); }
        render();
    }

    private String bearer() { return app.account == null ? "" : app.account.bearer(); }

    private final Assistant.Listener listener = new Assistant.Listener() {
        @Override public void changed(Assistant.Turn answer) { render(); }
        @Override public void finished(Assistant.Turn answer) { render(); }
    };

    void send() {
        Assistant.Status st = assistant.status();
        if (st == null || (!"ready".equals(st.state) && !"no-limit".equals(st.state))) { render(); return; }
        String q = input.getText().toString().trim();
        if (q.isEmpty() || assistant.busy()) return;
        if (assistant.model().isEmpty() && !st.defaultRef.isEmpty()) assistant.setModel(st.defaultRef);
        if (assistant.send(bearer(), q, main, listener)) { input.setText(""); render(); }
    }

    void stop() { assistant.stop(); render(); }

    void clear() { assistant.clear(); render(); }

    JSONObject scope() {
        Assistant.Status st = assistant.status();
        return MainActivity.jo("state", st == null ? "loading" : st.state, "busy", assistant.busy(), "model", assistant.model());
    }

    /* --------------------------------------------------------------- draw */

    private void render() {
        Assistant.Status st = assistant.status();
        if (st == null) {
            banner.setText(app.t("ai.notE2ee"));
            input.setEnabled(false);
            send.setEnabled(false);
            thread.removeAllViews();
            return;
        }
        boolean usable = "ready".equals(st.state) || "no-limit".equals(st.state);
        String note = "off".equals(st.state) ? app.t("ai.off")
            : "sign-in".equals(st.state) ? app.t("ai.signIn")
            : "no-model".equals(st.state) ? app.t("ai.noModel")
            : app.t("ai.notE2ee");
        banner.setText(note);
        input.setEnabled(usable);
        send.setEnabled(usable || assistant.busy());
        send.setImageResource(assistant.busy() ? android.R.drawable.ic_media_pause : android.R.drawable.ic_menu_send);
        send.setColorFilter(Ui.color(a, "@primary", Color.BLUE));

        thread.removeAllViews();
        for (Assistant.Turn t : assistant.turns()) thread.addView(bubble(t));
        scroller.post(() -> scroller.fullScroll(View.FOCUS_DOWN));
    }

    private View bubble(Assistant.Turn t) {
        LinearLayout box = new LinearLayout(a);
        box.setOrientation(VERTICAL);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.gravity = t.user ? Gravity.END : Gravity.START;
        lp.topMargin = Ui.dp(a, 4);
        box.setLayoutParams(lp);
        int bg = t.user ? Ui.color(a, "@bubbleOut", 0xFF2563EB) : Ui.color(a, "@bubbleIn", 0xFFEDEDED);
        int fg = t.user ? Ui.color(a, "@onBubbleOut", Color.WHITE) : Ui.color(a, "@onBubbleIn", Color.BLACK);
        box.setBackground(Ui.shape(bg, Ui.dp(a, 16), 0, 0));
        box.setPadding(Ui.dp(a, 12), Ui.dp(a, 8), Ui.dp(a, 12), Ui.dp(a, 8));

        TextView body = new TextView(a);
        body.setTextColor(fg);
        body.setTextSize(15);
        String text = t.failed() ? (t.errorMessage.isEmpty() ? app.t("ai.error") : t.errorMessage)
            : t.text.isEmpty() && t.pending ? app.t("ai.thinking") : t.text;
        if (t.user) body.setText(text);
        else Markdown.show(body, text, new AiTheme(fg), a::openUrl);
        box.addView(body);

        if (!t.user && (t.stopped || t.model.length() > 0)) {
            TextView meta = new TextView(a);
            meta.setTextColor(Ui.color(a, "@muted", Color.GRAY));
            meta.setTextSize(11);
            meta.setText((t.stopped ? app.t("ai.stopped") + " · " : "") + t.model);
            meta.setPadding(0, Ui.dp(a, 4), 0, 0);
            box.addView(meta);
        }
        return box;
    }

    private void refreshSend() { send.setColorFilter(Ui.color(a, input.getText().length() > 0 || assistant.busy() ? "@primary" : "@muted", Color.GRAY)); }

    @Override public void bindSlot(Expr.Scope scope) { render(); }

    /** The assistant's Markdown drawn in a bubble's colour. */
    private final class AiTheme implements cz.m5cet.app.fn.Theme {
        private final int fg;
        AiTheme(int fg) { this.fg = fg; }
        @Override public int color(String token) { return "@onSurface".equals(token) ? fg : Ui.color(a, token); }
        @Override public int dp(float value) { return Ui.dp(a, value); }
        @Override public android.graphics.Typeface typeface(boolean bold) { return Ui.typeface(app.design(), bold, false); }
        @Override public String text(String key) { return app.t(key); }
    }
}
