package cz.m5cet.app.account;

import android.app.AlertDialog;
import android.app.Dialog;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.os.Build;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.widget.ArrayAdapter;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import cz.m5cet.app.M5;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.net.Server;
import cz.m5cet.app.ui.Icons;
import cz.m5cet.app.ui.MainActivity;
import cz.m5cet.app.ui.Ui;

/**
 * Registration (6.4): a full-screen form — first and last name, country (a
 * searchable list with flags and dial codes), mobile, e-mail — and then the
 * account, step by step, each step shown as it goes:
 *
 *   Checking     /register/check (the server's verdict per field), then
 *                /register/start with the same body: the username and the
 *                passkey's creation options, the values normalized
 *   Passkey      the Credential Manager ceremony (Account.register: the same
 *                PRF, root and key proof as "Create an account")
 *   Keys         the account root and its key proof
 *   Registering  /register/verify — a 409 "taken" means someone registered
 *                that e-mail or phone meanwhile: back to the form
 *   Syncing      the registration record sealed into the account vault's own
 *                "registration" part (Account.saveRegistration)
 *
 * The values go nowhere but these calls and the sealed vault: never into the
 * log, not to an autofill service, not into the keyboard's learning.
 */
public final class RegisterDialog {
    private static final String[] STEPS = {"check", "passkey", "keys", "register", "sync"};

    private final MainActivity a;
    private final M5 app;
    private final Dialog dialog;
    private final int fg, muted, primary, danger, success, field;
    private final Map<String, EditText> inputs = new HashMap<>();
    private final Map<String, TextView> errors = new HashMap<>();
    private final Map<String, ImageView> stepIcons = new HashMap<>();
    private final Map<String, String> stepStates = new HashMap<>();
    private TextView country, dial, notice, submit;
    private ImageView close;
    private LinearLayout steps;
    private List<Registration.Country> countries = new ArrayList<>();
    private Registration.Country selected;
    /** "loading", "failed" or "" (loaded). */
    private String countriesState = "loading";
    private boolean busy;

    /** Opens the form (only without an account: signed in, it says as whom). */
    public static void show(MainActivity a) {
        Account acc = a.app().account;
        if (acc.signedIn()) { a.flash("", a.app().t("reg.already").replace("{user}", acc.username()), "info"); return; }
        new RegisterDialog(a).dialog.show();
    }

    private RegisterDialog(MainActivity a) {
        this.a = a;
        this.app = a.app();
        fg = Ui.color(a, "@onSurface", Color.BLACK);
        muted = Ui.color(a, "@muted", Color.GRAY);
        primary = Ui.color(a, "@primary", Color.BLUE);
        danger = Ui.color(a, "@danger", Color.RED);
        success = Ui.color(a, "@success", Color.GREEN);
        field = Ui.color(a, "@surfaceVariant", Color.LTGRAY);
        dialog = new Dialog(a, android.R.style.Theme_Material_NoActionBar);
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        dialog.setContentView(build());
        dialog.setOnKeyListener((d, code, e) -> busy && code == android.view.KeyEvent.KEYCODE_BACK);
        Window w = dialog.getWindow();
        if (w != null) {
            w.setBackgroundDrawable(new ColorDrawable(Ui.color(a, "@background", Color.WHITE)));
            w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
            w.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
            // A window of its own: it keeps screenshots out like the app's.
            if ((a.getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_SECURE) != 0) w.addFlags(WindowManager.LayoutParams.FLAG_SECURE);
            if (Build.VERSION.SDK_INT >= 30 && w.getInsetsController() != null) {
                int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                w.getInsetsController().setSystemBarsAppearance(Ui.dark(a) ? 0 : light, light);
            }
        }
        loadCountries();
    }

    private String t(String key) { return app.t(key); }
    private int dp(float v) { return Ui.dp(a, v); }

    /* -------------------------------------------------------------- view */

    private View build() {
        LinearLayout root = new LinearLayout(a);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Ui.color(a, "@background", Color.WHITE));
        // What is typed here is the person's: no autofill service gets to see (or keep) it.
        root.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            // Drawn behind the system bars (edge to edge): kept clear of them and of the keyboard.
            if (Build.VERSION.SDK_INT < 30) return insets;   // the window fits them itself (adjustResize)
            android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsets.CONSUMED;
        });

        LinearLayout bar = new LinearLayout(a);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(4), dp(8), dp(16), dp(8));
        bar.setBackgroundColor(Ui.color(a, "@surface", Color.WHITE));
        bar.setElevation(dp(2));
        close = new ImageView(a);
        close.setImageDrawable(Icons.drawable(a, "x", dp(22), fg));
        close.setPadding(dp(13), dp(13), dp(13), dp(13));
        close.setContentDescription(t("nav.close"));
        close.setBackground(Ui.ripple(null, Ui.alpha(fg, 0.15f)));
        close.setOnClickListener(v -> { if (!busy) dialog.dismiss(); });
        bar.addView(close, new LinearLayout.LayoutParams(dp(48), dp(48)));
        TextView title = text(t("reg.title"), 19, fg);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setPadding(dp(8), 0, 0, 0);
        bar.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        root.addView(bar);

        ScrollView scroll = new ScrollView(a);
        scroll.setFillViewport(true);
        LinearLayout form = new LinearLayout(a);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(dp(20), dp(16), dp(20), dp(28));
        scroll.addView(form);
        root.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        form.addView(text(t("reg.intro"), 14, muted));
        int name = InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PERSON_NAME | InputType.TYPE_TEXT_FLAG_CAP_WORDS;
        form.addView(labelled("firstName", t("reg.firstName"), input("firstName", name, "")));
        form.addView(labelled("lastName", t("reg.lastName"), input("lastName", name, "")));
        form.addView(labelled("country", t("reg.country"), countryField()));
        form.addView(labelled("phone", t("reg.phone"), phoneField()));
        EditText mail = input("email", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS, "");
        mail.setImeOptions(EditorInfo.IME_ACTION_DONE | EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING);
        mail.setOnEditorActionListener((v, action, e) -> { if (action == EditorInfo.IME_ACTION_DONE) { submit(); return true; } return false; });
        form.addView(labelled("email", t("reg.email"), mail));

        steps = new LinearLayout(a);
        steps.setOrientation(LinearLayout.VERTICAL);
        steps.setPadding(dp(14), dp(10), dp(14), dp(10));
        steps.setBackground(Ui.shape(field, dp(16), 0, 0));
        steps.setVisibility(View.GONE);
        for (String s : STEPS) steps.addView(stepRow(s));
        LinearLayout.LayoutParams sl = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        sl.topMargin = dp(20);
        form.addView(steps, sl);

        notice = text("", 14, danger);
        notice.setVisibility(View.GONE);
        LinearLayout.LayoutParams nl = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        nl.topMargin = dp(14);
        form.addView(notice, nl);

        submit = button(t("reg.submit"), "user-check");
        submit.setOnClickListener(v -> submit());
        LinearLayout.LayoutParams bl = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        bl.topMargin = dp(20);
        form.addView(submit, bl);
        return root;
    }

    private TextView text(String s, float sp, int color) {
        TextView v = new TextView(a);
        v.setText(s);
        v.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        v.setTextColor(color);
        return v;
    }

    /** A field: its label, the control, and the line its error goes to. */
    private View labelled(String key, String label, View control) {
        LinearLayout box = new LinearLayout(a);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(0, dp(16), 0, 0);
        TextView l = text(label, 13, muted);
        l.setPadding(dp(4), 0, 0, dp(6));
        box.addView(l);
        box.addView(control, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        TextView err = text("", 13, danger);
        err.setPadding(dp(4), dp(4), 0, 0);
        err.setVisibility(View.GONE);
        errors.put(key, err);
        box.addView(err);
        return box;
    }

    private EditText input(String key, int type, String hint) {
        EditText e = new EditText(a);
        e.setInputType(type);
        e.setSingleLine(true);
        // The keyboard does not learn names, numbers or addresses from here.
        e.setImeOptions(EditorInfo.IME_ACTION_NEXT | EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING);
        e.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        e.setHint(hint);
        e.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        e.setTextColor(fg);
        e.setHintTextColor(muted);
        e.setBackground(Ui.shape(field, dp(12), 0, 0));
        e.setPadding(dp(14), dp(12), dp(14), dp(12));
        e.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int st, int c, int af) { }
            @Override public void onTextChanged(CharSequence s, int st, int b, int c) { }
            @Override public void afterTextChanged(Editable s) { error(key, null); }
        });
        inputs.put(key, e);
        return e;
    }

    private View countryField() {
        country = text(t("reg.loading"), 16, fg);
        country.setGravity(Gravity.CENTER_VERTICAL);
        country.setPadding(dp(14), dp(12), dp(14), dp(12));
        country.setBackground(Ui.ripple(Ui.shape(field, dp(12), 0, 0), Ui.alpha(fg, 0.15f)));
        Drawable more = Icons.drawable(a, "chevron-down", dp(20), muted);
        more.setBounds(0, 0, dp(20), dp(20));
        country.setCompoundDrawablesRelative(null, null, more, null);
        country.setOnClickListener(v -> {
            if (busy) return;
            if (countriesState.equals("failed")) { loadCountries(); return; }
            if (!countries.isEmpty()) pickCountry();
        });
        return country;
    }

    /** The mobile number with the chosen country's dial code in front of it. */
    private View phoneField() {
        LinearLayout row = new LinearLayout(a);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setBackground(Ui.shape(field, dp(12), 0, 0));
        dial = text("+", 16, muted);
        dial.setPadding(dp(14), 0, dp(4), 0);
        row.addView(dial);
        EditText phone = input("phone", InputType.TYPE_CLASS_PHONE, "");
        phone.setBackground(null);
        phone.setPadding(dp(6), dp(12), dp(14), dp(12));
        row.addView(phone, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        return row;
    }

    private TextView button(String s, String icon) {
        TextView b = text(s, 15, Ui.color(a, "@onPrimary", Color.WHITE));
        b.setTypeface(Ui.labelFace(app.design()));
        b.setGravity(Gravity.CENTER);
        b.setPadding(dp(18), dp(13), dp(18), dp(13));
        Drawable d = Icons.drawable(a, icon, dp(18), Ui.color(a, "@onPrimary", Color.WHITE));
        d.setBounds(0, 0, dp(18), dp(18));
        b.setCompoundDrawablesRelative(d, null, null, null);
        b.setCompoundDrawablePadding(dp(8));
        b.setBackground(Ui.ripple(Ui.shape(primary, dp(999), 0, 0), Ui.alpha(Color.WHITE, 0.25f)));
        return b;
    }

    private View stepRow(String id) {
        LinearLayout row = new LinearLayout(a);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(0, dp(5), 0, dp(5));
        ImageView icon = new ImageView(a);
        stepIcons.put(id, icon);
        row.addView(icon, new LinearLayout.LayoutParams(dp(20), dp(20)));
        TextView label = text(t("reg.step." + id), 14, fg);
        label.setPadding(dp(12), 0, 0, 0);
        row.addView(label);
        return row;
    }

    /* --------------------------------------------------------- countries */

    private Locale appLocale() { return Locale.forLanguageTag(app.lang()); }

    private void loadCountries() {
        countriesState = "loading";
        showCountry();
        Io.bg(() -> {
            try {
                JSONObject answer = app.account.call("GET", "/api/account/countries", null, false);
                List<Registration.Country> list = Registration.countries(answer, appLocale());
                if (list.isEmpty()) throw new java.io.IOException("no countries");
                Io.main(() -> {
                    countries = list;
                    countriesState = "";
                    String region = a.getResources().getConfiguration().getLocales().get(0).getCountry();
                    if (selected == null) selected = Registration.preferred(list, region);
                    showCountry();
                });
            } catch (Exception e) {
                Log.w("account", "countries: " + e.getMessage());
                Io.main(() -> { countriesState = "failed"; showCountry(); });
            }
        });
    }

    private void showCountry() {
        if (countriesState.equals("loading")) country.setText(t("reg.loading"));
        else if (countriesState.equals("failed")) country.setText(t("reg.countriesFailed"));
        else country.setText(selected == null ? t("reg.countryPick") : selected.label());
        country.setTextColor(countriesState.equals("failed") ? danger : selected == null ? muted : fg);
        dial.setText(selected == null ? "+" : "+" + selected.dial);
    }

    /** The list to choose from: searched by name, code or dial code as one types. */
    private void pickCountry() {
        LinearLayout box = new LinearLayout(a);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(16), dp(8), dp(16), 0);
        EditText search = new EditText(a);
        search.setHint(t("reg.countrySearch"));
        search.setSingleLine(true);
        search.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        search.setImeOptions(EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING);
        Drawable glass = Icons.drawable(a, "search", dp(18), muted);
        glass.setBounds(0, 0, dp(18), dp(18));
        search.setCompoundDrawablesRelative(glass, null, null, null);
        search.setCompoundDrawablePadding(dp(8));
        box.addView(search);
        List<Registration.Country> shown = new ArrayList<>(countries);
        List<String> labels = new ArrayList<>();
        for (Registration.Country c : shown) labels.add(c.label());
        ArrayAdapter<String> adapter = new ArrayAdapter<>(a, android.R.layout.simple_list_item_1, labels);
        ListView list = new ListView(a);
        list.setAdapter(adapter);
        int height = (int) (a.getResources().getDisplayMetrics().heightPixels * 0.55f);
        box.addView(list, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, height));
        AlertDialog picker = new AlertDialog.Builder(a).setTitle(t("reg.countryPick")).setView(box)
            .setNegativeButton(t("passkey.cancel"), null)
            .create();
        search.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int st, int c, int af) { }
            @Override public void onTextChanged(CharSequence s, int st, int b, int c) { }
            @Override public void afterTextChanged(Editable s) {
                shown.clear();
                shown.addAll(Registration.filter(countries, s.toString()));
                labels.clear();
                for (Registration.Country c : shown) labels.add(c.label());
                adapter.notifyDataSetChanged();
            }
        });
        list.setOnItemClickListener((parent, view, position, id) -> {
            if (position < 0 || position >= shown.size()) return;
            selected = shown.get(position);
            error("country", null);
            showCountry();
            picker.dismiss();
            EditText phone = inputs.get("phone");
            if (phone != null && phone.getText().length() == 0) phone.requestFocus();
        });
        if (picker.getWindow() != null && (a.getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_SECURE) != 0) picker.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        picker.show();
        // Where the chosen one is.
        if (selected != null) { int at = shown.indexOf(selected); if (at > 0) list.setSelection(at); }
    }

    /* ------------------------------------------------------------ state */

    private String value(String key) { EditText e = inputs.get(key); return e == null ? "" : e.getText().toString(); }

    private void error(String key, String text) {
        TextView v = errors.get(key);
        if (v == null) return;
        v.setText(text == null ? "" : text);
        v.setVisibility(text == null || text.isEmpty() ? View.GONE : View.VISIBLE);
    }

    /** Field → code, each shown under its field; the first one gets the focus. */
    private void showErrors(Map<String, String> codes) {
        boolean focused = false;
        for (String f : Registration.FIELDS) {
            String code = codes.get(f);
            if (code == null) continue;
            error(f, t(Registration.errorKey(f, code)));
            if (!focused) {
                // The first field in the form's order gets the focus (the country is a list: nothing to type).
                EditText e = inputs.get(f);
                if (e != null) e.requestFocus();
                focused = true;
            }
        }
    }

    private void clearErrors() { for (String f : Registration.FIELDS) error(f, null); say(null, false); }

    /** The line above the button: a problem (red) or a note (muted). */
    private void say(String text, boolean problem) {
        notice.setText(text == null ? "" : text);
        notice.setTextColor(problem ? danger : muted);
        notice.setVisibility(text == null || text.isEmpty() ? View.GONE : View.VISIBLE);
    }

    private void setBusy(boolean b) {
        busy = b;
        dialog.setCancelable(!b);
        for (EditText e : inputs.values()) e.setEnabled(!b);
        country.setEnabled(!b);
        submit.setEnabled(!b);
        submit.setAlpha(b ? 0.6f : 1f);
        close.setAlpha(b ? 0.4f : 1f);
    }

    private void resetSteps() {
        stepStates.clear();
        for (String s : STEPS) step(s, "");
        steps.setVisibility(View.VISIBLE);
    }

    /** A step's mark: "" waiting, run, ok, fail. */
    private void step(String id, String state) {
        ImageView icon = stepIcons.get(id);
        if (icon == null) return;
        stepStates.put(id, state);
        String name; int color;
        switch (state) {
            case "run": name = "loader-circle"; color = primary; break;
            case "ok": name = "circle-check"; color = success; break;
            case "fail": name = "circle-x"; color = danger; break;
            default: name = "circle"; color = Ui.alpha(muted, 0.6f);
        }
        icon.setImageDrawable(Icons.drawable(a, name, dp(20), color));
    }

    private boolean open() { return dialog.isShowing() && !a.isFinishing() && !a.isDestroyed(); }

    /* ------------------------------------------------------------- flow */

    private void submit() {
        if (busy) return;
        clearErrors();
        JSONObject body = Registration.body(value("firstName"), value("lastName"), selected == null ? "" : selected.code, value("phone"), value("email"));
        Map<String, String> local = Registration.check(body);
        if (!local.isEmpty()) { showErrors(local); say(t("reg.err.fix"), true); return; }
        setBusy(true);
        resetSteps();
        step("check", "run");
        Io.bg(() -> {
            try {
                JSONObject checked = app.account.call("POST", "/api/account/register/check", body, false);
                JSONObject started = app.account.call("POST", "/api/account/register/start", body, false);
                JSONObject publicKey = started.getJSONObject("publicKey");
                JSONObject normalized = started.optJSONObject("normalized") != null ? started.optJSONObject("normalized") : checked.optJSONObject("normalized");
                String username = started.optString("username", "");
                Io.main(() -> passkey(publicKey, username, normalized == null ? body : normalized));
            } catch (Server.HttpError e) {
                Io.main(() -> refused(e));
            } catch (Exception e) {
                Log.w("account", "registration: " + e.getMessage());
                Io.main(() -> stopped("check", t("reg.failed").replace("{reason}", String.valueOf(e.getMessage()))));
            }
        });
    }

    /** /register/check or /register/start said no: the fields, the rate limit, or why. */
    private void refused(Server.HttpError e) {
        if (!open()) return;
        Map<String, String> codes = Registration.fieldErrors(e.body.optJSONObject("errors"));
        if (!codes.isEmpty()) {
            stopped("check", t("reg.err.fix"));
            showErrors(codes);   // once the fields take input again (the first one gets the focus)
            return;
        }
        if (e.status == 429) { stopped("check", t("reg.err.tooMany")); return; }
        if (e.status == 503 && "dns-unavailable".equals(e.code)) { stopped("check", t("reg.err.dns")); return; }
        stopped("check", t("reg.failed").replace("{reason}", String.valueOf(e.getMessage())));
    }

    /** A step failed: the form is the person's again, with why. */
    private void stopped(String stepId, String why) {
        if (!open()) return;
        if (stepId != null && !"fail".equals(stepStates.get(stepId))) step(stepId, "fail");
        setBusy(false);
        say(why, true);
    }

    private void passkey(JSONObject publicKey, String username, JSONObject normalized) {
        if (!open()) return;
        step("check", "ok");
        app.account.register(a, publicKey, username, this::step, r -> {
            if (r.ok) { sync(r, normalized); return; }
            if (!open()) { AccountDialogs.after(a, true, r); return; }
            switch (r.code) {
                // Back to the form, nothing to say: the person closed the sheet.
                case "cancelled": steps.setVisibility(View.GONE); setBusy(false); break;
                case "rp-unverified": stopped("passkey", null); AccountDialogs.rpUnverified(a); break;
                case "taken":
                    // Someone registered that e-mail or phone meanwhile: the fields say which.
                    stopped("register", t("reg.takenHint").replace("{user}", r.username));
                    showErrors(Registration.fieldErrors(r.errors));
                    break;
                case "unsupported": stopped("passkey", t("passkey.unsupported")); break;
                default: stopped(null, r.message.isEmpty() ? t("voice.failed") : r.message);
            }
        });
    }

    /** The account exists: its registration record into the vault, then done. */
    private void sync(Account.Result r, JSONObject normalized) {
        if (open()) step("sync", "run");
        app.account.saveRegistration(Registration.record(normalized, System.currentTimeMillis()), (ok, err) -> {
            if (open()) step("sync", ok ? "ok" : "fail");
            // A moment to see the list complete, then the answer on the app's own screen.
            Io.mainLater(() -> {
                busy = false;
                if (dialog.isShowing()) dialog.dismiss();
                if (a.isFinishing() || a.isDestroyed()) return;
                a.refresh();
                if (!ok) a.flash("", t("reg.syncFailed").replace("{user}", r.username).replace("{reason}", String.valueOf(err)), "warn");
                if (r.deviceBound) AccountDialogs.after(a, true, r);
                else if (ok) a.flash("", t("reg.done").replace("{user}", r.username), "success");
            }, ok ? 700 : 0);
        });
    }
}
