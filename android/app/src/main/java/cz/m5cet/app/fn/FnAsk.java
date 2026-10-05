package cz.m5cet.app.fn;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.drawable.GradientDrawable;
import android.text.InputType;
import android.util.TypedValue;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.ArrayAdapter;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Spinner;
import android.widget.Switch;
import android.widget.TextView;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.function.Consumer;
import java.util.function.Supplier;

/**
 * A running command's live question (m5.prompt / m5.form; the fn-ask dialog
 * in App.tsx): choices to tap, a line to type, or a small form — the answer
 * (the choice or text, the form's values as text, null for Cancel) goes to
 * answer, for Commands.answer(). A field with values is a choice among them.
 *
 * 6.11: a form's fields follow their type — a number's keyboard, an e-mail
 * address's, a phone's, a switch for a yes / no, several lines for a text, a
 * hidden one for a secret — and a required field must be filled before the
 * form goes (the values still go as text, as the web sends them).
 */
public final class FnAsk extends LinearLayout {
    private final Theme theme;
    private boolean answered;

    public FnAsk(Context c, Theme theme, Run.Interaction i, Consumer<Object> answer) {
        super(c);
        this.theme = theme;
        setOrientation(VERTICAL);
        int pad = theme.dp(12);
        setPadding(pad, pad, pad, pad);
        Consumer<Object> once = (v) -> { if (!answered) { answered = true; answer.accept(v); } };
        if (!i.title().isEmpty()) { TextView t = text(i.title()); t.setTypeface(theme.typeface(true)); add(t); }
        if (!i.text().isEmpty()) add(text(i.text()));
        if (i.kind.equals("prompt") && !i.choices().isEmpty()) {
            FlowRow row = new FlowRow(c, theme.dp(6));
            for (String choice : i.choices()) row.addView(button(choice, true, v -> once.accept(choice)));
            add(row);
        } else if (i.kind.equals("prompt")) {
            EditText e = input(i.placeholder(), "");
            e.setImeOptions(EditorInfo.IME_ACTION_DONE);
            e.setOnEditorActionListener((v, id, ev) -> { if (id == EditorInfo.IME_ACTION_DONE) { once.accept(e.getText().toString()); return true; } return false; });
            add(e);
            add(button(Words.t(theme, "functions.send"), true, v -> once.accept(e.getText().toString())));
        } else {
            List<String> names = new ArrayList<>();
            List<Supplier<String>> values = new ArrayList<>();
            List<EditText> requiredInputs = new ArrayList<>();
            TextView missing = text(Words.t(theme, "fnm.ask.required"));
            missing.setTextColor(theme.color("@danger"));
            missing.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            missing.setVisibility(GONE);
            for (Run.Interaction.Field f : i.fields()) {
                String type = f.type == null ? "" : f.type.toLowerCase(Locale.ROOT);
                String label = (f.label.isEmpty() ? f.name : f.label) + (f.required ? " *" : "");
                names.add(f.name);
                if (!f.values.isEmpty()) {
                    add(text(label));
                    Spinner s = new Spinner(c);
                    s.setAdapter(new ArrayAdapter<>(c, android.R.layout.simple_spinner_dropdown_item, f.values));
                    s.setContentDescription(label);
                    s.setMinimumHeight(theme.dp(48));
                    add(s);
                    values.add(() -> String.valueOf(s.getSelectedItem()));
                } else if (type.equals("boolean") || type.equals("bool") || type.equals("checkbox") || type.equals("switch")) {
                    Switch sw = new Switch(c);
                    sw.setText(label);
                    sw.setTextColor(theme.color("@onSurface"));
                    sw.setTypeface(theme.typeface(false));
                    sw.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
                    sw.setMinimumHeight(theme.dp(48));
                    sw.setThumbTintList(ColorStateList.valueOf(theme.color("@primary")));
                    add(sw);
                    values.add(() -> sw.isChecked() ? "true" : "false");
                } else {
                    add(text(label));
                    EditText e = input(f.placeholder, type);
                    e.setContentDescription(label);
                    add(e);
                    values.add(() -> e.getText().toString());
                    if (f.required) requiredInputs.add(e);
                }
            }
            add(missing);
            add(button(i.submit().isEmpty() ? Words.t(theme, "functions.send") : i.submit(), true, v -> {
                boolean ok = true;
                for (EditText e : requiredInputs) {
                    if (e.getText().toString().trim().isEmpty()) { e.setError(Words.t(theme, "fnui.required")); if (ok) e.requestFocus(); ok = false; }
                }
                missing.setVisibility(ok ? GONE : VISIBLE);
                if (!ok) return;
                JSONObject out = new JSONObject();
                try { for (int k = 0; k < names.size(); k++) out.put(names.get(k), values.get(k).get()); }
                catch (JSONException e) { throw new IllegalStateException(e); }
                once.accept(out);
            }));
        }
        add(button(Words.t(theme, "functions.cancel"), false, v -> once.accept(null)));
    }

    private void add(View v) {
        LayoutParams lp = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        if (getChildCount() > 0) lp.topMargin = theme.dp(8);
        addView(v, lp);
    }

    private TextView text(String s) {
        TextView t = new TextView(getContext());
        t.setText(s);
        t.setTextColor(theme.color("@onSurface"));
        t.setTypeface(theme.typeface(false));
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        return t;
    }

    /** The keyboard and lines a field's type wants (form fields; "" for a prompt's line). */
    static int inputType(String type) {
        switch (type) {
            case "number": return InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL | InputType.TYPE_NUMBER_FLAG_SIGNED;
            case "integer": case "int": return InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_SIGNED;
            case "email": return InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS;
            case "phone": case "tel": return InputType.TYPE_CLASS_PHONE;
            case "url": case "hostname": return InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI;
            case "password": case "secret": return InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD;
            case "date": return InputType.TYPE_CLASS_DATETIME | InputType.TYPE_DATETIME_VARIATION_DATE;
            case "time": return InputType.TYPE_CLASS_DATETIME | InputType.TYPE_DATETIME_VARIATION_TIME;
            case "text": case "textarea": case "multiline": return InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES | InputType.TYPE_TEXT_FLAG_MULTI_LINE;
            default: return InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES;
        }
    }

    private EditText input(String hint, String type) {
        EditText e = new EditText(getContext());
        e.setHint(hint);
        int it = inputType(type);
        e.setInputType(it);
        if ((it & InputType.TYPE_TEXT_FLAG_MULTI_LINE) != 0) { e.setMinLines(3); e.setMaxLines(8); e.setGravity(android.view.Gravity.TOP | android.view.Gravity.START); }
        e.setTextColor(theme.color("@onSurface"));
        e.setHintTextColor(theme.color("@muted"));
        e.setMinHeight(theme.dp(48));
        GradientDrawable g = new GradientDrawable();
        g.setColor(theme.color("@surfaceVariant"));
        g.setCornerRadius(theme.dp(8));
        e.setBackground(g);
        e.setPadding(theme.dp(10), theme.dp(8), theme.dp(10), theme.dp(8));
        return e;
    }

    private TextView button(String s, boolean primary, View.OnClickListener click) {
        TextView b = text(s);
        b.setGravity(android.view.Gravity.CENTER);
        b.setTypeface(theme.typeface(true));
        b.setPadding(theme.dp(14), theme.dp(8), theme.dp(14), theme.dp(8));
        b.setMinHeight(theme.dp(44));
        GradientDrawable g = new GradientDrawable();
        g.setCornerRadius(theme.dp(10));
        g.setColor(primary ? theme.color("@primary") : 0);
        g.setStroke(Math.max(1, theme.dp(1)), primary ? theme.color("@primary") : theme.color("@border"));
        b.setBackground(g);
        b.setTextColor(theme.color(primary ? "@onPrimary" : "@onSurface"));
        b.setOnClickListener(click);
        return b;
    }
}
