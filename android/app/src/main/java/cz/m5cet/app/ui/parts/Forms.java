package cz.m5cet.app.ui.parts;

import android.graphics.Color;
import android.os.Build;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

import cz.m5cet.app.BuildConfig;
import cz.m5cet.app.M5;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.net.Server;
import cz.m5cet.app.ui.Expr;
import cz.m5cet.app.ui.MainActivity;
import cz.m5cet.app.ui.Renderer;
import cz.m5cet.app.ui.Ui;

/** The enrolment form (server, code, device name) and the join-a-room form. */
final class Forms {
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

    /** Server address, code and name → /api/android/info, pin check, /enroll. */
    static final class Enroll extends LinearLayout implements Renderer.Slot {
        private final MainActivity a;
        private final EditText server, code, name;
        private final TextView go;
        private boolean busy;

        Enroll(MainActivity a, Parts parts) {
            super(a);
            this.a = a;
            setOrientation(VERTICAL);
            M5 app = a.app();
            Object preset = a.form().get("server");
            server = field(a, app.t("enroll.server"), InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI, preset != null ? String.valueOf(preset) : BuildConfig.DEFAULT_SERVER);
            code = field(a, app.t("enroll.code"), InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS, a.form().get("code") == null ? "" : String.valueOf(a.form().get("code")));
            name = field(a, app.t("enroll.name"), InputType.TYPE_CLASS_TEXT, Build.MANUFACTURER + " " + Build.MODEL);
            go = button(a, app.t("enroll.submit"));
            addView(server, gap(a));
            addView(code, gap(a));
            addView(name, gap(a));
            LayoutParams bl = gap(a);
            bl.topMargin = Ui.dp(a, 18);
            addView(go, bl);
            go.setOnClickListener(v -> submit());
        }

        private void submit() {
            if (busy) return;
            busy = true;
            go.setAlpha(0.6f);
            M5 app = a.app();
            String base = Server.normalize(server.getText().toString());
            String c = code.getText().toString().trim();
            String n = name.getText().toString().trim();
            String pinKid = String.valueOf(a.form().getOrDefault("kid", "")).trim();
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

        @Override public void bindSlot(Expr.Scope scope) { }
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
