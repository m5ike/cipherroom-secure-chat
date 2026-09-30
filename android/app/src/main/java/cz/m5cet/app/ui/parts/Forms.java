package cz.m5cet.app.ui.parts;

import android.graphics.Color;
import android.os.Build;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

import java.util.Map;

import cz.m5cet.app.BuildConfig;
import cz.m5cet.app.M5;
import cz.m5cet.app.account.EnrollLink;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.net.Server;
import cz.m5cet.app.ui.Expr;
import cz.m5cet.app.ui.Icons;
import cz.m5cet.app.ui.MainActivity;
import cz.m5cet.app.ui.Renderer;
import cz.m5cet.app.ui.Ui;

/** The enrolment form (server, code, device name) and the link that fills it; the join-a-room form. */
public final class Forms {
    private Forms() {}

    static EditText field(MainActivity a, String hint, int type, String value) {
        EditText e = new EditText(a);
        e.setHint(hint);
        e.setInputType(type);
        e.setSingleLine(true);
        if (value != null) e.setText(value);
        e.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        e.setTextColor(Ui.color(a, "@onSurface", Color.BLACK));
        e.setHintTextColor(Ui.color(a, "@muted", Color.GRAY));
        e.setBackground(Ui.shape(Ui.color(a, "@surfaceVariant", Color.LTGRAY), Ui.dp(a, 14), 0, 0));
        e.setPadding(Ui.dp(a, 16), Ui.dp(a, 14), Ui.dp(a, 16), Ui.dp(a, 14));
        return e;
    }

    static TextView button(MainActivity a, String text) {
        TextView b = new TextView(a);
        b.setText(text);
        b.setGravity(Gravity.CENTER);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        b.setTextColor(Ui.color(a, "@onPrimary", Color.WHITE));
        b.setTypeface(Ui.typeface(M5.get().design(), true, false));
        b.setPadding(Ui.dp(a, 20), Ui.dp(a, 14), Ui.dp(a, 20), Ui.dp(a, 14));
        b.setBackground(Ui.ripple(Ui.shape(Ui.color(a, "@primary", Color.RED), Ui.dp(a, 28), 0, 0), 0x33FFFFFF));
        return b;
    }

    static LinearLayout.LayoutParams gap(MainActivity a) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.setMargins(0, Ui.dp(a, 10), 0, 0);
        return lp;
    }

    /* ------------------------------------------------------ enrolment link */

    /** What a link leaves in $form for the enrolment form, besides server, code and kid. */
    static final String PREFILL = "enrollPrefill", LINK_SERVER = "enrollLinkServer";

    /**
     * 6.2: the console's QR link (m5cet://enroll?server=…&code=…&kid=…), at a
     * cold start or while the app is open (singleTask: onNewIntent). Not
     * enrolled: the form gets the values under a new prefill number (the
     * form's fields take a newer one on their next bind) and the enrolment
     * screen comes forward. Enrolled already: a notice, never a silent
     * second enrolment.
     */
    public static void enrollLink(MainActivity a, String link) {
        M5 app = a.app();
        // Before the first screen (onCreate): route() shows what follows, a notice waits for it.
        boolean starting = a.screen().isEmpty() || a.screen().equals("splash");
        EnrollLink l = EnrollLink.parse(link);
        if (l == null) {
            Log.w("enroll", "an enrolment link that is not valid");
            notice(a, starting, app.t("enroll.qrInvalid"), "error");
            return;
        }
        if (app.config.enrolled()) {
            String now = app.config.server();
            // The lock screen does not tell which server this phone belongs to.
            String text = app.lock.isLocked() ? app.t("enroll.qrLocked")
                : EnrollLink.sameServer(now, l.server) ? app.t("enroll.qrAlready").replace("{server}", now)
                : app.t("enroll.qrOther").replace("{server}", now).replace("{other}", l.server);
            notice(a, starting, text, "warn");
            return;
        }
        Map<String, Object> f = a.form();
        f.put("server", l.server);
        f.put("code", l.code);
        f.put("kid", l.kid);
        f.put(LINK_SERVER, l.server);
        f.put(PREFILL, seq(f.get(PREFILL)) + 1);
        f.remove("enrollError");
        Log.i("enroll", "enrolment link for " + l.server + (l.kid.isEmpty() ? "" : " (key " + l.kid + ")"));
        if (starting) return;
        if (a.screen().equals("enroll")) a.refresh(); else a.showScreen("enroll", true);
        a.flash("", app.t("enroll.qrApplied") + (l.code.isEmpty() ? " " + app.t("enroll.qrNoCode") : ""), "info");
    }

    private static void notice(MainActivity a, boolean starting, String text, String level) {
        if (starting) Io.mainLater(() -> a.flash("", text, level), 1500);
        else a.flash("", text, level);
    }

    static long seq(Object v) { return v instanceof Number ? ((Number) v).longValue() : 0; }

    private static String str(Object v) { return v == null ? "" : String.valueOf(v); }

    /** Server address, code and name → /api/android/info, pin check, /enroll. */
    static final class Enroll extends LinearLayout implements Renderer.Slot {
        private final MainActivity a;
        private final EditText server, code, name;
        private final TextView pin, go;
        private boolean busy;
        /** The link's prefill already in the fields (only a newer one replaces what they hold). */
        private long applied;

        Enroll(MainActivity a, Parts parts) {
            super(a);
            this.a = a;
            setOrientation(VERTICAL);
            M5 app = a.app();
            Object preset = a.form().get("server");
            server = field(a, app.t("enroll.server"), InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI, preset != null ? String.valueOf(preset) : BuildConfig.DEFAULT_SERVER);
            code = field(a, app.t("enroll.code"), InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS, str(a.form().get("code")));
            name = field(a, app.t("enroll.name"), InputType.TYPE_CLASS_TEXT, Build.MANUFACTURER + " " + Build.MODEL);
            pin = new TextView(a);
            pin.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            pin.setGravity(Gravity.CENTER_VERTICAL);
            pin.setCompoundDrawablePadding(Ui.dp(a, 8));
            pin.setPadding(Ui.dp(a, 4), 0, Ui.dp(a, 4), 0);
            go = button(a, app.t("enroll.submit"));
            addView(server, gap(a));
            LayoutParams pl = gap(a);
            pl.topMargin = Ui.dp(a, 6);
            addView(pin, pl);
            addView(code, gap(a));
            addView(name, gap(a));
            LayoutParams bl = gap(a);
            bl.topMargin = Ui.dp(a, 18);
            addView(go, bl);
            go.setOnClickListener(v -> submit());
            server.addTextChangedListener(new TextWatcher() {
                @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
                @Override public void onTextChanged(CharSequence s, int start, int before, int count) { }
                @Override public void afterTextChanged(Editable s) { showPin(); }
            });
            // A link that opened the app is in the form already: its prefill counts as applied.
            applied = seq(a.form().get(PREFILL));
            showPin();
            if (applied > 0 && code.getText().length() == 0) askForCode();
        }

        /** The kid the scanned link pins: it holds whatever server is typed (a look-alike address fails on it). */
        private String pinnedKid() { return str(a.form().get("kid")).trim(); }

        /** "Server key from the QR code: …", so the person sees the link was taken — and a warning once the address is another one. */
        private void showPin() {
            String kid = pinnedKid();
            pin.setVisibility(kid.isEmpty() ? GONE : VISIBLE);
            if (kid.isEmpty()) return;
            String linkServer = str(a.form().get(LINK_SERVER));
            boolean same = linkServer.isEmpty() || EnrollLink.sameHost(server.getText().toString(), linkServer);
            int c = same ? Ui.color(a, "@success", Ui.color(a, "@primary", Color.GRAY)) : Ui.color(a, "@danger", Color.RED);
            android.graphics.drawable.Drawable d = Icons.drawable(a, same ? "shield-check" : "shield-alert", Ui.dp(a, 18), c);
            d.setBounds(0, 0, Ui.dp(a, 18), Ui.dp(a, 18));
            pin.setCompoundDrawables(d, null, null, null);
            pin.setTextColor(same ? Ui.color(a, "@muted", Color.GRAY) : c);
            pin.setText(a.app().t("enroll.qrKid") + ": " + kid + (same ? "" : "\n" + a.app().t("enroll.qrMismatch").replace("{server}", linkServer)));
        }

        private void askForCode() {
            code.requestFocus();
            code.postDelayed(() -> {
                InputMethodManager imm = a.getSystemService(InputMethodManager.class);
                if (imm != null && code.isAttachedToWindow()) imm.showSoftInput(code, InputMethodManager.SHOW_IMPLICIT);
            }, 250);
        }

        private void submit() {
            if (busy) return;
            busy = true;
            go.setAlpha(0.6f);
            M5 app = a.app();
            String base = Server.normalize(server.getText().toString());
            String c = code.getText().toString().trim();
            String n = name.getText().toString().trim();
            String pinKid = pinnedKid();
            Io.bg(() -> {
                try {
                    JSONObject info = Server.info(base);
                    String kid = info.getJSONObject("server").getString("kid");
                    String builtIn = BuildConfig.SERVER_KEY_PIN;
                    if ((!builtIn.isEmpty() && !builtIn.equals(kid)) || (!pinKid.isEmpty() && !pinKid.equals(kid))) throw new SecurityException("the server's key " + kid + " is not the expected one");
                    JSONObject answer = app.server.enroll(base, c, n, Build.MODEL, Build.MANUFACTURER, app.push.token(), app.lang());
                    if (!kid.equals(answer.getJSONObject("server").getString("kid"))) throw new SecurityException("the server changed its key during enrolment");
                    app.config.enrolled(base, answer);
                    Log.i("enroll", "enrolled as " + answer.getString("deviceId"));
                    app.push.init();
                    cz.m5cet.app.push.Checkin.schedule(app);
                    app.events.add("unlock", cz.m5cet.app.core.Events.detail("enrolled", true));
                    Io.main(() -> { a.form().remove("enrollError"); busy = false; aRoute(); });
                } catch (Server.HttpError e) {
                    fail(e.getMessage());
                } catch (Exception e) {
                    Log.e("enroll", "enrolment failed", e);
                    fail(e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
                }
            });
        }

        private void aRoute() { a.route(); }

        private void fail(String message) {
            Io.main(() -> {
                busy = false;
                go.setAlpha(1f);
                a.form().put("enrollError", a.app().t("enroll.failed") + ": " + message);
                a.refresh();
            });
        }

        @Override
        public void bindSlot(Expr.Scope scope) {
            // A newer link (onNewIntent while this screen is open) replaces the server and the
            // code; otherwise what the person typed stays.
            long seq = seq(a.form().get(PREFILL));
            if (seq <= applied) return;
            applied = seq;
            server.setText(str(a.form().get("server")));
            code.setText(str(a.form().get("code")));
            showPin();
            if (code.getText().length() == 0) askForCode();
        }
    }

    /** Your name, the room, its passphrase. */
    static final class Join extends LinearLayout implements Renderer.Slot {
        Join(MainActivity a, Parts parts) {
            super(a);
            setOrientation(VERTICAL);
            M5 app = a.app();
            EditText name = field(a, app.t("join.name"), InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_WORDS, app.config.userName());
            EditText room = field(a, app.t("join.room"), InputType.TYPE_CLASS_TEXT, "");
            EditText pass = field(a, app.t("join.passphrase"), InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD, "");
            TextView go = button(a, app.t("join.submit"));
            addView(name, gap(a));
            addView(room, gap(a));
            addView(pass, gap(a));
            LayoutParams bl = gap(a);
            bl.topMargin = Ui.dp(a, 18);
            addView(go, bl);
            go.setOnClickListener(v -> a.finishJoin(room.getText().toString(), pass.getText().toString(), name.getText().toString()));
            pass.setOnEditorActionListener((v, id, ev) -> { go.performClick(); return true; });
        }

        @Override public void bindSlot(Expr.Scope scope) { }
    }
}
