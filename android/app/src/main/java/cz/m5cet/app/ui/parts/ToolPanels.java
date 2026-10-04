package cz.m5cet.app.ui.parts;

import android.Manifest;
import android.graphics.Color;
import android.graphics.Typeface;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import cz.m5cet.app.M5;
import cz.m5cet.app.chat.RoomSession;
import cz.m5cet.app.nfc.Nfc;
import cz.m5cet.app.ui.Expr;
import cz.m5cet.app.ui.Icons;
import cz.m5cet.app.ui.MainActivity;
import cz.m5cet.app.ui.Renderer;
import cz.m5cet.app.ui.Ui;

/** The native parts of the quick tools (6.1): the voice pad and the NFC panel. */
final class ToolPanels {
    private ToolPanels() {}

    static TextView label(MainActivity a, String s, float sp, int color, boolean bold) {
        TextView t = new TextView(a);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    static TextView button(MainActivity a, String s, String icon, boolean primary) {
        TextView b = new TextView(a);
        int fg = primary ? Ui.color(a, "@onPrimary", Color.WHITE) : Ui.color(a, "@primary", Color.BLUE);
        b.setText(s);
        b.setTextColor(fg);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14.5f);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setGravity(Gravity.CENTER);
        b.setPadding(Ui.dp(a, 16), Ui.dp(a, 11), Ui.dp(a, 16), Ui.dp(a, 11));
        android.graphics.drawable.Drawable d = Icons.drawable(a, icon, Ui.dp(a, 18), fg);
        d.setBounds(0, 0, Ui.dp(a, 18), Ui.dp(a, 18));
        b.setCompoundDrawablesRelative(d, null, null, null);
        b.setCompoundDrawablePadding(Ui.dp(a, 8));
        int bg = primary ? Ui.color(a, "@primary", Color.BLUE) : Ui.alpha(Ui.color(a, "@primary", Color.BLUE), 0.12f);
        b.setBackground(Ui.ripple(Ui.shape(bg, Ui.dp(a, 999), 0, 0), Ui.alpha(fg, 0.2f)));
        return b;
    }

    /* ============================================================ voice pad */

    /** Dictation into a transcript (big microphone, level, partial text), read aloud, into a message. */
    static final class VoicePad extends LinearLayout implements Renderer.Slot {
        private final MainActivity a;
        private final EditText transcript;
        private final ImageView mic;
        private final TextView state;
        private String base = "";

        VoicePad(MainActivity a) {
            super(a);
            this.a = a;
            setOrientation(VERTICAL);
            setPadding(Ui.dp(a, 16), Ui.dp(a, 12), Ui.dp(a, 16), Ui.dp(a, 12));
            int fg = Ui.color(a, "@onSurface", Color.BLACK);
            transcript = new EditText(a);
            transcript.setGravity(Gravity.TOP);
            transcript.setHint(a.app().t("voice.tapToDictate"));
            transcript.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
            transcript.setTextColor(fg);
            transcript.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
            transcript.setBackground(Ui.shape(Ui.color(a, "@surface", Color.WHITE), Ui.dp(a, 16), Ui.dp(a, 1), Ui.color(a, "@border", Color.LTGRAY)));
            transcript.setPadding(Ui.dp(a, 16), Ui.dp(a, 14), Ui.dp(a, 16), Ui.dp(a, 14));
            addView(transcript, new LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
            state = label(a, "", 13, Ui.color(a, "@muted", Color.GRAY), false);
            state.setGravity(Gravity.CENTER);
            state.setPadding(0, Ui.dp(a, 10), 0, Ui.dp(a, 6));
            addView(state, new LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            LinearLayout row = new LinearLayout(a);
            row.setGravity(Gravity.CENTER);
            TextView clear = button(a, a.app().t("voice.clear"), "trash", false);
            clear.setOnClickListener(v -> { transcript.setText(""); base = ""; });
            row.addView(clear);
            mic = new ImageView(a);
            int s = Ui.dp(a, 76);
            LayoutParams ml = new LayoutParams(s, s);
            ml.setMargins(Ui.dp(a, 20), 0, Ui.dp(a, 20), 0);
            mic.setLayoutParams(ml);
            mic.setScaleType(ImageView.ScaleType.CENTER);
            mic.setContentDescription(a.app().t("voice.dictate"));
            mic.setOnClickListener(v -> toggle());
            mic.setOnLongClickListener(v -> { a.parts.showSheet("dictate.options"); return true; });
            row.addView(mic);
            TextView speak = button(a, a.app().t("voice.speak"), "volume-2", false);
            speak.setOnClickListener(v -> { if (a.app().voice.speaking()) a.app().voice.stopSpeaking(); else a.app().voice.say(transcript.getText().toString()); });
            row.addView(speak);
            addView(row);
            TextView toChat = button(a, a.app().t("voice.toChat"), "send-horizontal", true);
            LayoutParams tl = new LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            tl.topMargin = Ui.dp(a, 12);
            toChat.setOnClickListener(v -> {
                String text = transcript.getText().toString().trim();
                if (text.isEmpty() || a.app().rooms.activeSession() == null) return;
                a.form().put("composer", text);
                a.showScreen("room", true);
            });
            addView(toChat, tl);
            refresh();
        }

        /** 6.7: one of the voice's listeners (the composer is another). */
        private final Runnable sync = this::refresh;

        @Override protected void onAttachedToWindow() {
            super.onAttachedToWindow();
            a.app().voice.addStateListener(sync);
            refresh();
        }

        void toggle() {
            M5 app = a.app();
            if (app.voice.dictating()) { app.voice.stopDictation(); refresh(); return; }
            if (!a.has(Manifest.permission.RECORD_AUDIO)) { a.askPermissions(Manifest.permission.RECORD_AUDIO); return; }
            base = transcript.getText().toString();
            if (!base.isEmpty() && !base.endsWith(" ") && !base.endsWith("\n")) base += " ";
            app.voice.dictate((text, done) -> {
                transcript.setText(base + text);
                transcript.setSelection(transcript.getText().length());
                if (done) base = transcript.getText().toString() + " ";
            });
            refresh();
        }

        void refresh() {
            M5 app = a.app();
            boolean on = app.voice.dictating();
            int accent = on ? Ui.color(a, "@danger", Color.RED) : Ui.color(a, "@primary", Color.BLUE);
            mic.setImageDrawable(Icons.drawable(a, on ? "mic-off" : "mic", Ui.dp(a, 34), Ui.color(a, "@onPrimary", Color.WHITE)));
            mic.setBackground(Ui.ripple(Ui.shape(accent, Ui.dp(a, 38), 0, 0), 0x33FFFFFF));
            mic.setElevation(Ui.dp(a, on ? 10 : 4));
            state.setText(app.voice.speaking() ? "🔊 " + app.t("voice.speak") + "…" : on ? (app.voice.listening() ? "🎙 " + app.t("voice.listening") : "…") : app.t("voice.tapToDictate"));
        }

        @Override protected void onDetachedFromWindow() {
            super.onDetachedFromWindow();
            a.app().voice.removeStateListener(sync);
            // Leaving the voice screen stops dictation (the last words still come into the transcript).
            if (a.app().voice.dictating()) a.app().voice.stopDictation();
        }

        @Override public void bindSlot(Expr.Scope scope) { refresh(); }
    }

    /* ============================================================ NFC panel */

    /** PIN, read / write / be a card, what the last tag held — and joining a room from its card. */
    static final class NfcPanel extends ScrollView implements Renderer.Slot {
        private final MainActivity a;
        private final Nfc nfc;
        private final LinearLayout box;
        private final EditText pin;
        private final TextView status;
        private final LinearLayout result;
        private final ProgressBar waiting;

        NfcPanel(MainActivity a) {
            super(a);
            this.a = a;
            box = new LinearLayout(a);
            box.setOrientation(LinearLayout.VERTICAL);
            box.setPadding(Ui.dp(a, 16), Ui.dp(a, 16), Ui.dp(a, 16), Ui.dp(a, 24));
            addView(box);
            int fg = Ui.color(a, "@onSurface", Color.BLACK);
            nfc = new Nfc(a, s -> refresh());
            status = label(a, "", 15, fg, true);
            status.setGravity(Gravity.CENTER);
            box.addView(status);
            waiting = new ProgressBar(a);
            waiting.setIndeterminateTintList(android.content.res.ColorStateList.valueOf(Ui.color(a, "@primary", Color.BLUE)));
            box.addView(waiting);
            pin = new EditText(a);
            pin.setHint(a.app().t("nfc.pin"));
            pin.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD);
            pin.setTextColor(fg);
            pin.setBackground(Ui.shape(Ui.color(a, "@surfaceVariant", Color.LTGRAY), Ui.dp(a, 12), 0, 0));
            pin.setPadding(Ui.dp(a, 14), Ui.dp(a, 10), Ui.dp(a, 14), Ui.dp(a, 10));
            LayoutParams pl = new LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            pl.topMargin = Ui.dp(a, 14);
            box.addView(pin, pl);
            LinearLayout row = new LinearLayout(a);
            row.setGravity(Gravity.CENTER);
            row.setPadding(0, Ui.dp(a, 12), 0, Ui.dp(a, 4));
            TextView read = button(a, a.app().t("nfc.read"), "scan-line", true);
            read.setOnClickListener(v -> action("read"));
            TextView write = button(a, a.app().t("nfc.write"), "pencil", false);
            write.setOnClickListener(v -> action("write"));
            row.addView(read);
            LayoutParams wl = new LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            wl.setMarginStart(Ui.dp(a, 10));
            row.addView(write, wl);
            box.addView(row);
            TextView emulate = button(a, a.app().t("nfc.emulate"), "smartphone", false);
            emulate.setOnClickListener(v -> action("emulate"));
            LayoutParams el = new LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            el.gravity = Gravity.CENTER_HORIZONTAL;
            box.addView(emulate, el);
            result = new LinearLayout(a);
            result.setOrientation(LinearLayout.VERTICAL);
            result.setPadding(0, Ui.dp(a, 16), 0, 0);
            box.addView(result);
            a.parts.nfcPanel = this;
            refresh();
        }

        JSONObject scope() { return nfc.state(); }

        /** read | write | emulate | stop — write / emulate take the active room. */
        void action(String what) {
            M5 app = a.app();
            String p = pin.getText().toString().trim();
            if (what.equals("stop")) { nfc.stop(); return; }
            if (!Nfc.available(a)) { a.flash("", app.t("nfc.unavailable"), "warn"); return; }
            if (!nfc.enabled()) { a.flash("", app.t("nfc.disabled"), "warn"); a.systemSettings("app"); return; }
            if ((what.equals("write") || what.equals("emulate")) && !Nfc.validPin(p)) { a.flash("", app.t("nfc.pin"), "warn"); pin.requestFocus(); return; }
            if (what.equals("read")) { nfc.read(p); return; }
            RoomSession r = app.rooms.activeSession();
            JSONObject card = r == null ? null : app.rooms.cardOf(r.key);
            if (card == null) { a.flash("", app.t("rooms.empty"), "warn"); return; }
            try { card.put("app", cz.m5cet.app.BuildConfig.VERSION_NAME); } catch (org.json.JSONException ignored) { }
            if (what.equals("write")) nfc.write(p, card); else nfc.emulate(p, card);
        }

        void refresh() {
            M5 app = a.app();
            JSONObject s = nfc.state();
            String st = s.optString("state");
            boolean busy = st.equals("read") || st.equals("write");
            waiting.setVisibility(busy || st.equals("emulate") ? VISIBLE : GONE);
            String msg = s.optString("message");
            status.setText(!s.optBoolean("available") ? app.t("nfc.unavailable") : !s.optBoolean("enabled") ? app.t("nfc.disabled")
                : st.equals("emulate") ? app.t("nfc.emulating") : busy ? app.t("nfc.hold")
                : msg.equals("written") ? "✓ " + app.t("nfc.written") : msg.equals("wrong-pin") ? app.t("nfc.wrongPin") : msg.equals("too-small") ? app.t("nfc.tooSmall") : msg.isEmpty() ? app.t("tools.nfc") : "⚠ " + msg);
            result.removeAllViews();
            JSONObject last = s.optJSONObject("last");
            if (last == null) return;
            int fg = Ui.color(a, "@onSurface", Color.BLACK), muted = Ui.color(a, "@muted", Color.GRAY);
            JSONArray tech = last.optJSONArray("tech");
            StringBuilder techs = new StringBuilder();
            if (tech != null) for (int i = 0; i < tech.length(); i++) techs.append(i > 0 ? " · " : "").append(tech.optString(i));
            result.addView(label(a, techs.toString(), 13, muted, false));
            if (!last.optString("id").isEmpty()) result.addView(label(a, "ID " + last.optString("id"), 13, muted, false));
            if (last.optBoolean("ndef")) result.addView(label(a, "NDEF · " + last.optString("type").replace("org.nfcforum.ndef.", "") + " · " + last.optInt("capacity") + " B", 13, muted, false));
            JSONArray recs = last.optJSONArray("records");
            if (recs != null) for (int i = 0; i < recs.length(); i++) {
                JSONObject r = recs.optJSONObject(i);
                String line = r.has("text") ? "T  " + r.optString("text") : r.has("uri") ? "U  " + r.optString("uri") : r.has("mime") ? "M  " + r.optString("mime") + " (" + r.optInt("size") + " B)" : "·  " + r.optInt("size") + " B";
                TextView t = label(a, line.length() > 200 ? line.substring(0, 200) + "…" : line, 14, fg, false);
                t.setPadding(0, Ui.dp(a, 4), 0, 0);
                result.addView(t);
            }
            JSONObject room = last.optJSONObject("room");
            if (room != null) {
                LinearLayout card = new LinearLayout(a);
                card.setOrientation(LinearLayout.VERTICAL);
                card.setPadding(Ui.dp(a, 14), Ui.dp(a, 12), Ui.dp(a, 14), Ui.dp(a, 12));
                card.setBackground(Ui.shape(Ui.color(a, "@surface", Color.WHITE), Ui.dp(a, 16), Ui.dp(a, 1), Ui.color(a, "@border", Color.LTGRAY)));
                card.addView(label(a, app.t("nfc.card"), 12, muted, false));
                card.addView(label(a, room.optString("room"), 18, fg, true));
                TextView join = button(a, app.t("nfc.join"), "log-in", true);
                join.setOnClickListener(v -> a.finishJoin(room.optString("room"), room.optString("passphrase"), room.optString("name", "")));
                LayoutParams jl = new LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                jl.topMargin = Ui.dp(a, 8);
                card.addView(join, jl);
                LayoutParams cl = new LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                cl.topMargin = Ui.dp(a, 12);
                result.addView(card, cl);
            }
        }

        @Override protected void onDetachedFromWindow() { nfc.stop(); if (a.parts.nfcPanel == this) a.parts.nfcPanel = null; super.onDetachedFromWindow(); }

        @Override public void bindSlot(Expr.Scope scope) { refresh(); }
    }
}
