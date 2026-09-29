package cz.m5cet.app.fn;

import android.content.Context;
import android.graphics.drawable.GradientDrawable;
import android.text.InputType;
import android.util.TypedValue;
import android.view.View;
import android.widget.ArrayAdapter;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Spinner;
import android.widget.TextView;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import java.util.function.Supplier;

/**
 * A running command's live question (m5.prompt / m5.form; the fn-ask dialog
 * in App.tsx): choices to tap, a line to type, or a small form — the answer
 * (the choice or text, the form's values as text, null for Cancel) goes to
 * answer, for Commands.answer(). A field with values is a choice among them.
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
            EditText e = input(i.placeholder());
            add(e);
            add(button(Words.t(theme, "functions.send"), true, v -> once.accept(e.getText().toString())));
        } else {
            List<String> names = new ArrayList<>();
            List<Supplier<String>> values = new ArrayList<>();
            for (Run.Interaction.Field f : i.fields()) {
                add(text((f.label.isEmpty() ? f.name : f.label) + (f.required ? " *" : "")));
                names.add(f.name);
                if (!f.values.isEmpty()) {
                    Spinner s = new Spinner(c);
                    s.setAdapter(new ArrayAdapter<>(c, android.R.layout.simple_spinner_dropdown_item, f.values));
                    add(s);
                    values.add(() -> String.valueOf(s.getSelectedItem()));
                } else {
                    EditText e = input(f.placeholder);
                    add(e);
                    values.add(() -> e.getText().toString());
                }
            }
            add(button(i.submit().isEmpty() ? Words.t(theme, "functions.send") : i.submit(), true, v -> {
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

    private EditText input(String hint) {
        EditText e = new EditText(getContext());
        e.setHint(hint);
        e.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        e.setTextColor(theme.color("@onSurface"));
        e.setHintTextColor(theme.color("@muted"));
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
