package cz.m5cet.app.ui.parts;

import android.Manifest;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.provider.Settings;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;

import org.json.JSONException;
import org.json.JSONObject;

import cz.m5cet.app.M5;
import cz.m5cet.app.security.Biometric;
import cz.m5cet.app.security.Vault;
import cz.m5cet.app.security.Wiper;
import cz.m5cet.app.ui.Expr;
import cz.m5cet.app.ui.Icons;
import cz.m5cet.app.ui.MainActivity;
import cz.m5cet.app.ui.Renderer;
import cz.m5cet.app.ui.Ui;

/** The settings: lock, biometrics, PIN, notifications, look, language, call log, updates, erase. */
final class SettingsList extends ScrollView implements Renderer.Slot {
    private final MainActivity a;
    private final LinearLayout box;

    SettingsList(MainActivity a, Parts parts) {
        super(a);
        this.a = a;
        box = new LinearLayout(a);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(0, Ui.dp(a, 8), 0, Ui.dp(a, 24));
        addView(box);
        build();
    }

    private void build() {
        box.removeAllViews();
        M5 app = a.app();
        section(app.t("settings.lock"));
        if (!"off".equals(app.lock.biometricMode()) && Biometric.available(a)) {
            toggle("fingerprint-pattern", app.t("settings.biometric"), app.vault.bioEnrolled(), on -> { a.toggleBiometric(); });
        }
        row("key-round", app.t("settings.changePin"), this::changePin);
        row("lock", app.t("menu.lock"), () -> app.lock.lockNow(false));
        section(app.t("settings.notifications"));
        row("bell", app.t("settings.notifications"), () -> a.startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, a.getPackageName())));
        JSONObject prefs = app.vault.json(Vault.Tier.SYS, "settings");
        toggle("phone", app.t("settings.callLog"), prefs.optBoolean("callLog"), on -> {
            try { prefs.put("callLog", on); } catch (JSONException ignored) { }
            app.vault.putJson(Vault.Tier.SYS, "settings", prefs);
            if (on && !a.has(Manifest.permission.WRITE_CALL_LOG)) a.askPermissions(Manifest.permission.WRITE_CALL_LOG);
        });
        section(app.t("settings.theme"));
        toggle("moon", app.t("settings.theme"), Ui.dark(a), on -> { app.config.setTone(on ? "dark" : "light"); a.recreate(); });
        row("languages", app.t("settings.language") + " · " + app.lang().toUpperCase(), () -> {
            String[] langs = {"cs", "en", "de"};
            new AlertDialog.Builder(a).setItems(new String[]{"Čeština", "English", "Deutsch"}, (d, i) -> { app.config.setLang(langs[i]); a.recreate(); }).show();
        });
        section(app.t("settings.updates"));
        row("refresh-cw", app.t("menu.update"), () -> Actions_run("update.check"));
        row("info", app.t("settings.about"), () -> a.showScreen("about", true));
        section("");
        row("trash", app.t("settings.wipe"), () -> new AlertDialog.Builder(a).setMessage(app.t("settings.wipe") + "?")
            .setPositiveButton(app.t("settings.wipe"), (d, w) -> { Wiper.wipe(app, "user", false, 0); app.restart(); })
            .setNegativeButton(app.t("nav.close"), null).show());
    }

    private void Actions_run(String action) { a.action(action, null, n -> null, this); }

    private void section(String title) {
        TextView t = new TextView(a);
        t.setText(title.toUpperCase());
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        t.setTypeface(Ui.typeface(a.app().design(), true, false));
        t.setTextColor(Ui.color(a, "@primary", Color.RED));
        t.setPadding(Ui.dp(a, 20), Ui.dp(a, 18), Ui.dp(a, 20), Ui.dp(a, 6));
        box.addView(t);
    }

    private TextView line(String icon, String label) {
        TextView t = new TextView(a);
        t.setText(label);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        int fg = Ui.color(a, "@onSurface", Color.BLACK);
        t.setTextColor(fg);
        t.setGravity(Gravity.CENTER_VERTICAL);
        t.setMinHeight(Ui.dp(a, 52));
        t.setPadding(Ui.dp(a, 20), 0, Ui.dp(a, 20), 0);
        android.graphics.drawable.Drawable d = Icons.drawable(a, icon, Ui.dp(a, 22), Ui.color(a, "@muted", Color.GRAY));
        d.setBounds(0, 0, Ui.dp(a, 22), Ui.dp(a, 22));
        t.setCompoundDrawablesRelative(d, null, null, null);
        t.setCompoundDrawablePadding(Ui.dp(a, 18));
        t.setBackground(Ui.ripple(null, Ui.alpha(fg, 0.12f)));
        return t;
    }

    private void row(String icon, String label, Runnable onClick) {
        TextView t = line(icon, label);
        t.setOnClickListener(v -> onClick.run());
        box.addView(t);
    }

    interface OnToggle { void on(boolean value); }

    private void toggle(String icon, String label, boolean value, OnToggle onToggle) {
        LinearLayout row = new LinearLayout(a);
        row.setGravity(Gravity.CENTER_VERTICAL);
        TextView t = line(icon, label);
        row.addView(t, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        Switch s = new Switch(a);
        s.setChecked(value);
        s.setPadding(0, 0, Ui.dp(a, 16), 0);
        s.setOnCheckedChangeListener((b, on) -> onToggle.on(on));
        t.setOnClickListener(v -> s.toggle());
        row.addView(s);
        box.addView(row);
    }

    private void changePin() {
        M5 app = a.app();
        EditText p1 = new EditText(a), p2 = new EditText(a);
        for (EditText e : new EditText[]{p1, p2}) e.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD);
        p1.setHint(app.t("lock.setPin"));
        p2.setHint(app.t("lock.confirmPin"));
        LinearLayout l = new LinearLayout(a);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setPadding(Ui.dp(a, 20), Ui.dp(a, 8), Ui.dp(a, 20), 0);
        l.addView(p1);
        l.addView(p2);
        new AlertDialog.Builder(a).setTitle(app.t("settings.changePin")).setView(l)
            .setPositiveButton("OK", (d, w) -> {
                String a1 = p1.getText().toString(), a2 = p2.getText().toString();
                if (a1.length() < app.lock.pinLength() || !a1.equals(a2)) { a.flash("", app.t("lock.pinMismatch"), "error"); return; }
                try { app.vault.changePin(a1); a.flash("", app.t("settings.changePin") + " ✓", "success"); }
                catch (Exception e) { a.flash("", e.getMessage(), "error"); }
            })
            .setNegativeButton(app.t("nav.close"), null).show();
    }

    @Override public void bindSlot(Expr.Scope scope) { }
}
