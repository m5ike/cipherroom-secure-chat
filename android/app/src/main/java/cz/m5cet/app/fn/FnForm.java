package cz.m5cet.app.fn;

import android.app.DatePickerDialog;
import android.app.TimePickerDialog;
import android.content.Context;
import android.graphics.drawable.GradientDrawable;
import android.text.Editable;
import android.text.InputFilter;
import android.text.InputType;
import android.text.TextWatcher;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.CheckBox;
import android.widget.CompoundButton;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.SeekBar;
import android.widget.Spinner;
import android.widget.Switch;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Calendar;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.Consumer;
import java.util.function.Supplier;

/**
 * A function's form (FnForm.tsx; m5.out.form): fields in panels, in rows of
 * columns, labels above or beside; text, numbers, ranges, dates and times,
 * masked values, selects, multi-selects, radios, checkboxes, switches…
 * Submitting checks the values like the web (Outputs.checkFormValues) and
 * hands { name: value } to the model's form entry point.
 */
final class FnForm extends LinearLayout {
    interface Submit { void submit(JSONObject values, Consumer<Boolean> done); }

    /** One field: its spec, what it holds now, the views to lock, where its problem shows. */
    private static final class Field {
        final JSONObject f;
        final String name;
        final String type;
        final List<View> inputs = new ArrayList<>();
        Supplier<Object> value;
        TextView problem;

        Field(JSONObject f) {
            this.f = f;
            name = f.optString("name", "");
            type = f.optString("type", "text");
        }
    }

    private final Theme theme;
    private final Markdown.Links links;
    private final JSONObject spec;
    private final boolean reachable;
    private final Submit submit;
    private final List<Field> fields = new ArrayList<>();
    private final TextView send;
    private String state;

    FnForm(Context c, Theme theme, Markdown.Links links, JSONObject spec, boolean reachable, boolean sent, Submit submit) {
        super(c);
        this.theme = theme;
        this.links = links;
        this.spec = spec;
        this.reachable = reachable;
        this.submit = submit;
        setOrientation(VERTICAL);
        setPadding(theme.dp(12), theme.dp(10), theme.dp(12), theme.dp(12));
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(theme.dp(10));
        bg.setStroke(Math.max(1, theme.dp(1)), theme.color("@border"));
        setBackground(bg);

        String title = str(spec, "title");
        if (!title.isEmpty()) { TextView t = label(title); t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16); add(this, t, 0); }
        if (!str(spec, "text").isEmpty()) add(this, markdown(str(spec, "text")), 4);
        JSONArray top = spec.optJSONArray("fields");
        if (top != null && top.length() > 0) add(this, grid(top, null, clamp(spec.optInt("columns", 1))), 6);
        JSONArray panels = spec.optJSONArray("panels");
        for (int i = 0; panels != null && i < panels.length(); i++) {
            JSONObject p = panels.optJSONObject(i);
            if (p != null) add(this, panel(p), 10);
        }
        send = new TextView(c);
        send.setGravity(Gravity.CENTER);
        send.setTypeface(theme.typeface(true));
        send.setTextColor(theme.color("@onPrimary"));
        send.setPadding(theme.dp(16), theme.dp(9), theme.dp(16), theme.dp(9));
        GradientDrawable sb = new GradientDrawable();
        sb.setColor(theme.color("@primary"));
        sb.setCornerRadius(theme.dp(10));
        send.setBackground(sb);
        send.setOnClickListener(v -> submit());
        LayoutParams lp = new LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT);
        lp.topMargin = theme.dp(12);
        addView(send, lp);
        set(sent ? "done" : "idle");
    }

    private static int clamp(int cols) { return Math.max(1, Math.min(4, cols)); }

    private static String str(JSONObject o, String k) { return o.opt(k) instanceof String ? o.optString(k) : ""; }

    private void add(LinearLayout parent, View v, int topDp) {
        LayoutParams lp = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        lp.topMargin = theme.dp(topDp);
        parent.addView(v, lp);
    }

    private TextView label(String s) {
        TextView t = new TextView(getContext());
        t.setText(s);
        t.setTextColor(theme.color("@onSurface"));
        t.setTypeface(theme.typeface(true));
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        return t;
    }

    private TextView small(String s, String token) {
        TextView t = new TextView(getContext());
        t.setText(s);
        t.setTextColor(theme.color(token));
        t.setTypeface(theme.typeface(false));
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        return t;
    }

    private TextView markdown(String s) {
        TextView t = new TextView(getContext());
        t.setTextColor(theme.color("@onSurface"));
        t.setTypeface(theme.typeface(false));
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        Markdown.show(t, s, theme, links);
        return t;
    }

    /* ------------------------------------------------------------ layout */

    /** A fieldset: its title (a tap folds a collapsed one), its text, its fields. */
    private View panel(JSONObject p) {
        LinearLayout box = new LinearLayout(getContext());
        box.setOrientation(VERTICAL);
        LinearLayout body = new LinearLayout(getContext());
        body.setOrientation(VERTICAL);
        if (!str(p, "text").isEmpty()) add(body, markdown(str(p, "text")), 0);
        int cols = "columns".equals(p.opt("layout")) ? clamp(p.optInt("columns", 2)) : clamp(p.optInt("columns", 1));
        add(body, grid(p.optJSONArray("fields"), p, cols), 4);
        boolean collapsed = Boolean.TRUE.equals(p.opt("collapsed"));
        String title = str(p, "title");
        if (collapsed || !title.isEmpty()) {
            TextView legend = label(collapsed ? "▸ " + (title.isEmpty() ? "…" : title) : title);
            if (collapsed) {
                body.setVisibility(GONE);
                legend.setOnClickListener(v -> {
                    boolean open = body.getVisibility() != VISIBLE;
                    body.setVisibility(open ? VISIBLE : GONE);
                    legend.setText((open ? "▾ " : "▸ ") + (title.isEmpty() ? "…" : title));
                });
            }
            add(box, legend, 0);
        }
        add(box, body, 4);
        return box;
    }

    /** Fields in rows of cols columns; a field takes span of them. */
    private View grid(JSONArray list, JSONObject panel, int cols) {
        LinearLayout grid = new LinearLayout(getContext());
        grid.setOrientation(VERTICAL);
        LinearLayout row = null;
        int used = 0;
        for (int i = 0; list != null && i < list.length(); i++) {
            JSONObject f = list.optJSONObject(i);
            if (f == null) continue;
            View v = field(f, panel);
            if (v == null) continue;
            int span = f.optString("type").equals("separator") || f.optString("type").equals("static") && !f.has("span") ? cols : Math.min(cols, Math.max(1, f.optInt("span", 1)));
            if (row == null || used + span > cols) {
                row = new LinearLayout(getContext());
                row.setOrientation(HORIZONTAL);
                row.setWeightSum(cols);
                add(grid, row, grid.getChildCount() == 0 ? 0 : 8);
                used = 0;
            }
            LayoutParams lp = new LayoutParams(0, LayoutParams.WRAP_CONTENT, span);
            if (used > 0) lp.leftMargin = theme.dp(8);
            row.addView(v, lp);
            used += span;
        }
        return grid;
    }

    /** A field with its label (above or beside), help and problem; null for a hidden one (its value still goes). */
    private View field(JSONObject spec, JSONObject panel) {
        Field fd = new Field(spec);
        String type = fd.type;
        if (type.equals("separator")) {
            View line = new View(getContext());
            line.setBackgroundColor(theme.color("@border"));
            line.setMinimumHeight(Math.max(1, theme.dp(1)));
            return line;
        }
        if (type.equals("static")) return markdown(str(spec, "text").isEmpty() ? str(spec, "label") : str(spec, "text"));
        fields.add(fd);
        Object initial = initialValue(spec);
        if (type.equals("hidden")) { fd.value = () -> initial; return null; }
        boolean required = Boolean.TRUE.equals(spec.opt("required"));
        String text = (str(spec, "label").isEmpty() ? fd.name : str(spec, "label")) + (required ? " *" : "");
        View control = control(fd, initial, text);

        LinearLayout col = new LinearLayout(getContext());
        col.setOrientation(VERTICAL);
        col.addView(control);
        if (!str(spec, "help").isEmpty()) add(col, small(str(spec, "help"), "@muted"), 2);
        fd.problem = small("", "@danger");
        fd.problem.setVisibility(GONE);
        add(col, fd.problem, 2);
        boolean inline = type.equals("checkbox") || type.equals("switch");
        if (inline) return col;
        String labels = spec.has("labels") ? spec.optString("labels") : panel != null && panel.has("labels") ? panel.optString("labels") : this.spec.optString("labels", "top");
        LinearLayout wrap = new LinearLayout(getContext());
        wrap.setOrientation(labels.equals("left") ? HORIZONTAL : VERTICAL);
        TextView l = label(text);
        l.setTypeface(theme.typeface(false));
        if (labels.equals("left")) {
            wrap.addView(l, new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1));
            LayoutParams lp = new LayoutParams(0, LayoutParams.WRAP_CONTENT, 2);
            lp.leftMargin = theme.dp(8);
            wrap.addView(col, lp);
        } else {
            wrap.addView(l);
            add(wrap, col, 4);
        }
        return wrap;
    }

    /* ---------------------------------------------------------- controls */

    /** initialValue() in FnForm.tsx: the default, or the empty value of the type. */
    static Object initialValue(JSONObject f) {
        Object d = f.opt("default");
        boolean none = d == null || d == JSONObject.NULL;
        switch (f.optString("type")) {
            case "checkbox": case "switch":
                return Boolean.TRUE.equals(d) || "true".equals(d) || (d instanceof Number && ((Number) d).doubleValue() == 1);
            case "multiselect": {
                JSONArray a = new JSONArray();
                if (d instanceof JSONArray) for (int i = 0; i < ((JSONArray) d).length(); i++) a.put(Js.str(((JSONArray) d).opt(i)));
                else if (!none && !"".equals(d)) a.put(Js.str(d));
                return a;
            }
            case "number": case "range":
                if (none || "".equals(d)) return f.optString("type").equals("range") ? (f.opt("min") instanceof Number ? f.opt("min") : (Object) 0) : "";
                return Outputs.jsonNumber(Js.toNumber(d));
            default:
                return none ? "" : d instanceof String ? d : Js.str(d);
        }
    }

    private void changed(Field fd) { if (fd.problem != null) fd.problem.setVisibility(GONE); }

    private EditText input(Field fd, String initial, int inputType) {
        EditText e = new EditText(getContext());
        e.setText(initial);
        e.setInputType(inputType);
        e.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        e.setTextColor(theme.color("@onSurface"));
        e.setHintTextColor(theme.color("@muted"));
        e.setHint(str(fd.f, "placeholder"));
        GradientDrawable g = new GradientDrawable();
        g.setColor(theme.color("@surfaceVariant"));
        g.setCornerRadius(theme.dp(8));
        e.setBackground(g);
        e.setPadding(theme.dp(10), theme.dp(8), theme.dp(10), theme.dp(8));
        e.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void onTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void afterTextChanged(Editable s) { changed(fd); }
        });
        fd.inputs.add(e);
        fd.value = () -> e.getText().toString();
        return e;
    }

    private View control(Field fd, Object initial, String labelText) {
        JSONObject f = fd.f;
        String text = initial instanceof String ? (String) initial : Js.str(initial);
        switch (fd.type) {
            case "textarea": {
                EditText e = input(fd, text, InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
                e.setMinLines(f.has("rows") ? f.optInt("rows") : 3);
                e.setGravity(Gravity.TOP | Gravity.START);
                return e;
            }
            case "number": return input(fd, text, InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL | InputType.TYPE_NUMBER_FLAG_SIGNED);
            case "tel": return input(fd, text, InputType.TYPE_CLASS_PHONE);
            case "email": return input(fd, text, InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
            case "url": return input(fd, text, InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
            case "password": return input(fd, text, InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
            case "color": {
                EditText e = input(fd, text, InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
                if (str(f, "placeholder").isEmpty()) e.setHint("#000000");
                return e;
            }
            case "date": case "time": case "datetime": case "month": return picker(fd, text);
            case "masked": return masked(fd, text);
            case "range": return range(fd, initial);
            case "select": return select(fd, text);
            case "multiselect": return multiselect(fd, (JSONArray) initial);
            case "radio": return radio(fd, text);
            case "checkbox": case "switch": {
                CompoundButton b = fd.type.equals("switch") ? new Switch(getContext()) : new CheckBox(getContext());
                b.setText(labelText);
                b.setTextColor(theme.color("@onSurface"));
                b.setTypeface(theme.typeface(false));
                b.setChecked(Boolean.TRUE.equals(initial));
                b.setOnCheckedChangeListener((v, on) -> changed(fd));
                fd.inputs.add(b);
                fd.value = b::isChecked;
                return b;
            }
            default: return input(fd, text, InputType.TYPE_CLASS_TEXT);
        }
    }

    /** 0 a digit, a a letter, * either; the rest is typed for you ("+420 000 000 000"). */
    private View masked(Field fd, String text) {
        String mask = str(fd.f, "mask");
        List<Outputs.MaskToken> tokens = Outputs.maskTokens(mask);
        boolean numeric = true;
        for (Outputs.MaskToken t : tokens) if (t.slot && !t.c.equals("0")) numeric = false;
        EditText e = input(fd, text, numeric && !tokens.isEmpty() ? InputType.TYPE_CLASS_PHONE : InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        if (str(fd.f, "placeholder").isEmpty()) e.setHint(Outputs.maskPlaceholder(mask));
        if (!tokens.isEmpty()) e.setFilters(new InputFilter[] { new InputFilter.LengthFilter(tokens.size()) });
        if (!mask.isEmpty()) e.addTextChangedListener(new TextWatcher() {
            private boolean self;
            @Override public void beforeTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void onTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void afterTextChanged(Editable s) {
                if (self) return;
                String m = Outputs.applyMask(mask, s.toString());
                if (m.equals(s.toString())) return;
                self = true;
                s.replace(0, s.length(), m);
                self = false;
            }
        });
        return e;
    }

    /** A date, time, date and time, or month from the system's pickers ("2026-09-30", "14:05", "2026-09-30T14:05", "2026-09"). */
    private View picker(Field fd, String text) {
        EditText e = input(fd, text, InputType.TYPE_NULL);
        e.setFocusable(false);
        if (str(fd.f, "placeholder").isEmpty()) e.setHint(fd.type.equals("time") ? "--:--" : fd.type.equals("month") ? "----/--" : "----/--/--");
        e.setOnClickListener(v -> {
            Calendar now = Calendar.getInstance();
            String type = fd.type;
            if (type.equals("time")) {
                new TimePickerDialog(getContext(), (tp, h, m) -> e.setText(String.format(Locale.ROOT, "%02d:%02d", h, m)), now.get(Calendar.HOUR_OF_DAY), now.get(Calendar.MINUTE), true).show();
                return;
            }
            new DatePickerDialog(getContext(), (dp, y, mo, d) -> {
                String date = type.equals("month") ? String.format(Locale.ROOT, "%04d-%02d", y, mo + 1) : String.format(Locale.ROOT, "%04d-%02d-%02d", y, mo + 1, d);
                if (!type.equals("datetime")) { e.setText(date); return; }
                new TimePickerDialog(getContext(), (tp, h, m) -> e.setText(date + String.format(Locale.ROOT, "T%02d:%02d", h, m)), now.get(Calendar.HOUR_OF_DAY), now.get(Calendar.MINUTE), true).show();
            }, now.get(Calendar.YEAR), now.get(Calendar.MONTH), now.get(Calendar.DAY_OF_MONTH)).show();
        });
        // A long press empties it (a date is not always wanted).
        e.setOnLongClickListener(v -> { e.setText(""); return true; });
        return e;
    }

    private View range(Field fd, Object initial) {
        double min = fd.f.opt("min") instanceof Number ? fd.f.optDouble("min") : 0;
        double max = fd.f.opt("max") instanceof Number ? fd.f.optDouble("max") : 100;
        double step = fd.f.opt("step") instanceof Number && fd.f.optDouble("step") > 0 ? fd.f.optDouble("step") : 1;
        int steps = (int) Math.max(1, Math.round((max - min) / step));
        LinearLayout row = new LinearLayout(getContext());
        row.setOrientation(HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        SeekBar bar = new SeekBar(getContext());
        bar.setMax(steps);
        double start = Js.toNumber(initial);
        bar.setProgress((int) Math.round(((Double.isFinite(start) ? start : min) - min) / step));
        TextView shown = small("", "@onSurface");
        Supplier<Object> value = () -> Outputs.jsonNumber(Math.min(max, min + bar.getProgress() * step));
        shown.setText(Js.str(value.get()));
        bar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar s, int p, boolean user) { shown.setText(Js.str(value.get())); changed(fd); }
            @Override public void onStartTrackingTouch(SeekBar s) { }
            @Override public void onStopTrackingTouch(SeekBar s) { }
        });
        row.addView(bar, new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1));
        row.addView(shown);
        fd.inputs.add(bar);
        fd.value = value;
        return row;
    }

    private static List<String[]> options(JSONObject f) {
        List<String[]> out = new ArrayList<>();
        JSONArray a = f.optJSONArray("options");
        for (int i = 0; a != null && i < a.length(); i++) {
            JSONObject o = a.optJSONObject(i);
            if (o == null) continue;
            String icon = str(o, "icon");
            out.add(new String[] { o.optString("value"), (icon.isEmpty() ? "" : icon + " ") + o.optString("label") });
        }
        return out;
    }

    private View select(Field fd, String text) {
        List<String[]> opts = options(fd.f);
        List<String> labels = new ArrayList<>();
        labels.add(str(fd.f, "placeholder").isEmpty() ? Words.t(theme, "fnui.choose") : str(fd.f, "placeholder"));
        int chosen = 0;
        for (int i = 0; i < opts.size(); i++) {
            labels.add(opts.get(i)[1]);
            if (opts.get(i)[0].equals(text)) chosen = i + 1;
        }
        Spinner s = new Spinner(getContext());
        ArrayAdapter<String> adapter = new ArrayAdapter<>(getContext(), android.R.layout.simple_spinner_item, labels);
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        s.setAdapter(adapter);
        s.setSelection(chosen);
        s.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override public void onItemSelected(AdapterView<?> p, View v, int pos, long id) { changed(fd); }
            @Override public void onNothingSelected(AdapterView<?> p) { }
        });
        fd.inputs.add(s);
        fd.value = () -> s.getSelectedItemPosition() > 0 ? opts.get(s.getSelectedItemPosition() - 1)[0] : "";
        return s;
    }

    private View multiselect(Field fd, JSONArray initial) {
        LinearLayout box = new LinearLayout(getContext());
        box.setOrientation(VERTICAL);
        List<String[]> opts = options(fd.f);
        List<CheckBox> checks = new ArrayList<>();
        List<String> start = Command.strings(initial);
        for (String[] o : opts) {
            CheckBox b = new CheckBox(getContext());
            b.setText(o[1]);
            b.setTextColor(theme.color("@onSurface"));
            b.setChecked(start.contains(o[0]));
            b.setOnCheckedChangeListener((v, on) -> changed(fd));
            checks.add(b);
            fd.inputs.add(b);
            box.addView(b);
        }
        fd.value = () -> {
            JSONArray a = new JSONArray();
            for (int i = 0; i < opts.size(); i++) if (checks.get(i).isChecked()) a.put(opts.get(i)[0]);
            return a;
        };
        return box;
    }

    private View radio(Field fd, String text) {
        RadioGroup g = new RadioGroup(getContext());
        List<String[]> opts = options(fd.f);
        for (int i = 0; i < opts.size(); i++) {
            RadioButton b = new RadioButton(getContext());
            b.setId(View.generateViewId());
            b.setText(opts.get(i)[1]);
            b.setTextColor(theme.color("@onSurface"));
            g.addView(b);
            if (opts.get(i)[0].equals(text)) g.check(b.getId());
            fd.inputs.add(b);
        }
        g.setOnCheckedChangeListener((grp, id) -> changed(fd));
        fd.value = () -> {
            for (int i = 0; i < g.getChildCount(); i++) if (((RadioButton) g.getChildAt(i)).isChecked()) return opts.get(i)[0];
            return "";
        };
        return g;
    }

    /* ------------------------------------------------------------ submit */

    private void set(String s) {
        state = s;
        boolean locked = !reachable || s.equals("busy") || (Boolean.TRUE.equals(spec.opt("once")) && s.equals("done"));
        send.setText(s.equals("busy") ? Words.t(theme, "fnui.sending")
            : s.equals("done") && Boolean.TRUE.equals(spec.opt("once")) ? Words.t(theme, "fnui.sent")
            : str(spec, "submit").isEmpty() ? Words.t(theme, "fnui.submit") : str(spec, "submit"));
        send.setEnabled(!locked);
        send.setAlpha(locked ? 0.55f : 1f);
        for (Field fd : fields) for (View v : fd.inputs) v.setEnabled(!locked && !Boolean.TRUE.equals(fd.f.opt("readonly")));
    }

    /** Numbers go as numbers; an empty number field is left out (FnForm.tsx submit()). */
    private void submit() {
        if (!reachable || state.equals("busy") || (Boolean.TRUE.equals(spec.opt("once")) && state.equals("done"))) return;
        JSONObject out = new JSONObject();
        try {
            for (Field fd : fields) {
                Object v = fd.value.get();
                boolean number = fd.type.equals("number") || fd.type.equals("range");
                if (number && !"".equals(v)) { double n = Js.toNumber(v); out.put(fd.name, Double.isFinite(n) ? Outputs.jsonNumber(n) : v); }
                else if (!(fd.type.equals("number") && "".equals(v))) out.put(fd.name, v);
            }
        } catch (JSONException e) { throw new IllegalStateException(e); }
        Map<String, String> problems = Outputs.checkFormValues(spec, out);
        for (Field fd : fields) {
            if (fd.problem == null) continue;
            String p = problems.get(fd.name);
            fd.problem.setVisibility(p == null ? GONE : VISIBLE);
            if (p != null) fd.problem.setText(problemText(p));
        }
        if (!problems.isEmpty()) return;
        set("busy");
        submit.submit(out, (ok) -> set(ok ? "done" : "idle"));
    }

    private String problemText(String p) {
        String key = p.equals("required") ? "fnui.required" : p.equals("email") ? "fnui.email" : p.equals("number") ? "fnui.number" : p.equals("incomplete") ? "fnui.incomplete" : "fnui.invalid";
        return Words.t(theme, key) + (p.startsWith("min ") || p.startsWith("max ") ? " (" + p + ")" : "");
    }
}
