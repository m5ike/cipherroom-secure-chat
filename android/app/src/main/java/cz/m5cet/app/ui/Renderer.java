package cz.m5cet.app.ui;

import android.animation.AnimatorSet;
import android.animation.ObjectAnimator;
import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.text.Editable;
import android.text.InputType;
import android.text.TextUtils;
import android.text.TextWatcher;
import android.text.util.Linkify;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.widget.CheckBox;
import android.widget.CompoundButton;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.Space;
import android.widget.Switch;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

import cz.m5cet.app.R;
import cz.m5cet.app.design.Appearance;
import cz.m5cet.app.design.Design;
import cz.m5cet.app.ui.look.FlowLayout;
import cz.m5cet.app.ui.look.Look;

/**
 * Draws a screen's element tree (docs/android-architecture.md §4) as native
 * views. A tree is built ONCE into Bound nodes; later only bind(scope) runs:
 * texts, visibility (`if`), colours and props given as expressions, repeated
 * children (`each`). That keeps lists (messages, rooms, users) as fast as
 * hand-written adapters while the whole look comes from the console.
 */
public final class Renderer {
    public interface Host {
        Design design();
        boolean dark();
        Expr.Translate tr();
        /**
         * An action of the design: raw is its argument as the design wrote it
         * ("=expression", a template, a literal; null: none), arg its value in
         * the element's scope — 6.10 (G-20): ui/ActionGuard refuses a computed
         * argument where it could carry data off the phone.
         */
        void action(String action, String raw, Object arg, Expr.Scope scope, View source);
        /** An action of the app's own code (a value without a raw text counts as computed). */
        default void action(String action, Object arg, Expr.Scope scope, View source) { action(action, null, arg, scope, source); }
        /** A native part; bind is called with the part's scope on every bind of its tree. */
        View slot(String name, Bound bound);
        Map<String, Object> form();
        /** 6.1: the user's settings ($settings) — read by elements with a "setting" prop, changed by them. */
        default Object setting(String key) { return null; }
        default void setSetting(String key, Object value) { }
    }

    final Context ctx;
    final Host host;

    private boolean attached;

    public Renderer(Context ctx, Host host) { this.ctx = ctx; this.host = host; }

    public Bound build(JSONObject node) {
        // 6.2: the look's font and its watch, once the design is there (the first screen).
        if (!attached) { attached = true; Look.attach(ctx, host.design()); }
        return new Bound(this, node, null);
    }

    int dp(float v) { return Ui.dp(ctx, v); }

    int color(String v, int fallback) { return host.design().color(v, host.dark(), fallback); }

    static Expr.Scope child(Expr.Scope parent, String name, Object value, int index, int count) {
        return n -> {
            if (n.equals(name)) return value;
            if (n.equals("index")) return (double) index;
            if (n.equals("first")) return index == 0;
            if (n.equals("last")) return index == count - 1;
            return parent.get(n);
        };
    }

    /* ================================================================ Bound */

    public static final class Bound {
        final Renderer r;
        public final JSONObject node;
        final String el;
        public View view;
        /** The view that holds the children (a card's inner column, a scroll's content). */
        ViewGroup box;
        final List<Bound> children = new ArrayList<>();
        final Bound parent;
        JSONObject style;
        Expr.Scope scope;
        boolean animated;
        private ImageView iconView;
        private TextView badgeView;
        private List<Bound> repeated;
        private ViewGroup repeatBox;

        Bound(Renderer r, JSONObject node, Bound parent) {
            this.r = r;
            this.node = node;
            this.parent = parent;
            this.el = node.optString("el");
            this.style = node.optJSONObject("style");
            if (style == null) style = new JSONObject();
            create();
            if (node.has("each")) {
                // The repeated node lives in a box of its own; its copies are made on bind.
                if (parent != null && parent.box instanceof FlowLayout) {
                    // 6.2: in a row that wraps, the copies wrap too.
                    FlowLayout f = new FlowLayout(r.ctx);
                    f.setGap(r.dp((float) parent.style.optDouble("gap", 0) * Appearance.density()));
                    repeatBox = f;
                } else {
                    repeatBox = new LinearLayout(r.ctx);
                    ((LinearLayout) repeatBox).setOrientation(parent != null && "row".equals(parent.el) ? LinearLayout.HORIZONTAL : LinearLayout.VERTICAL);
                }
                repeated = new ArrayList<>();
            }
        }

        public View root() { return repeatBox != null ? repeatBox : view; }

        String s(String key) { return node.optJSONObject("props") == null ? null : node.optJSONObject("props").optString(key, null); }

        private void create() {
            Context c = r.ctx;
            switch (el) {
                case "row":
                    // 6.2: a row that wraps (chips of a choice, colour swatches).
                    if ("true".equals(s("wrap"))) { FlowLayout f = new FlowLayout(c); view = f; box = f; break; }
                    // fall through
                case "column": case "sheet": {
                    // 6.2: "sheet" is the root of a sheet or the Tools dock — a column; Parts.showSheet reads its props.
                    LinearLayout l = new LinearLayout(c);
                    l.setOrientation(el.equals("row") ? LinearLayout.HORIZONTAL : LinearLayout.VERTICAL);
                    view = l; box = l;
                    break;
                }
                case "card": {
                    LinearLayout l = new LinearLayout(c);
                    l.setOrientation(LinearLayout.VERTICAL);
                    view = l; box = l;
                    break;
                }
                case "stack": { FrameLayout f = new FrameLayout(c); view = f; box = f; break; }
                case "scroll": {
                    boolean h = "true".equals(s("horizontal"));
                    ViewGroup sv = h ? new HorizontalScrollView(c) : new ScrollView(c);
                    LinearLayout inner = new LinearLayout(c);
                    inner.setOrientation(h ? LinearLayout.HORIZONTAL : LinearLayout.VERTICAL);
                    sv.addView(inner, new ViewGroup.LayoutParams(h ? ViewGroup.LayoutParams.WRAP_CONTENT : ViewGroup.LayoutParams.MATCH_PARENT, h ? ViewGroup.LayoutParams.MATCH_PARENT : ViewGroup.LayoutParams.WRAP_CONTENT));
                    if (sv instanceof ScrollView) ((ScrollView) sv).setFillViewport(true);
                    view = sv; box = inner;
                    break;
                }
                case "text": case "badge": case "chip": view = new TextView(c); break;
                case "button": {
                    TextView b = new TextView(c);
                    b.setGravity(Gravity.CENTER);
                    b.setClickable(true);
                    b.setFocusable(true);
                    view = b;
                    break;
                }
                case "iconButton": {
                    FrameLayout f = new FrameLayout(c);
                    iconView = new ImageView(c);
                    iconView.setScaleType(ImageView.ScaleType.CENTER);
                    f.addView(iconView, new FrameLayout.LayoutParams(r.dp(44), r.dp(44)));
                    badgeView = new TextView(c);
                    badgeView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10);
                    badgeView.setGravity(Gravity.CENTER);
                    badgeView.setVisibility(View.GONE);
                    FrameLayout.LayoutParams bl = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, r.dp(16), Gravity.TOP | Gravity.END);
                    bl.setMargins(0, r.dp(4), r.dp(4), 0);
                    f.addView(badgeView, bl);
                    f.setClickable(true);
                    f.setFocusable(true);
                    view = f;
                    break;
                }
                case "icon": iconView = new ImageView(c); view = iconView; break;
                case "image": view = new RatioImageView(c); break;
                case "avatar": view = new AvatarView(c); break;
                case "divider": view = new View(c); break;
                // 6.2: a plain view, so a spacer with a background shows it (a Space draws nothing — the sheets' handle was invisible).
                case "spacer": view = new View(c); break;
                case "progress": view = new ProgressBar(c, null, s("value") == null ? android.R.attr.progressBarStyle : android.R.attr.progressBarStyleHorizontal); break;
                case "input": view = new EditText(c); break;
                case "switch": view = new Switch(c); break;
                case "checkbox": view = new CheckBox(c); break;
                case "select": {
                    TextView t = new TextView(c);
                    t.setGravity(Gravity.CENTER_VERTICAL);
                    t.setClickable(true);
                    t.setFocusable(true);
                    t.setMinHeight(r.dp(44));
                    t.setOnClickListener(this::openSelect);
                    view = t;
                    break;
                }
                case "slider": {
                    android.widget.SeekBar sb = new android.widget.SeekBar(c);
                    sb.setOnSeekBarChangeListener(new android.widget.SeekBar.OnSeekBarChangeListener() {
                        @Override public void onProgressChanged(android.widget.SeekBar b, int p, boolean user) { }
                        @Override public void onStartTrackingTouch(android.widget.SeekBar b) { }
                        @Override public void onStopTrackingTouch(android.widget.SeekBar b) { commit(sliderValue(b.getProgress()), b); }
                    });
                    view = sb;
                    break;
                }
                case "segmented": {
                    LinearLayout l = new LinearLayout(c);
                    l.setOrientation(LinearLayout.HORIZONTAL);
                    view = l;
                    break;
                }
                case "slot": view = r.host.slot(s("name"), this); break;
                // 6.7: a row that slides sideways to its menus' actions (ui/look/SwipeRow); the children are the row.
                case "swipe": { cz.m5cet.app.ui.look.SwipeRow sw = new cz.m5cet.app.ui.look.SwipeRow(c); view = sw; box = sw.content(); break; }
                default: view = new View(c);
            }
            if (view == null) view = new View(c);
            view.setTag(node.optString("id"));
            JSONArray kids = node.optJSONArray("children");
            if (box != null && kids != null) {
                String justify = style.optString("justify", "");
                boolean spread = justify.equals("between") || justify.equals("around");
                if (spread && justify.equals("around")) box.addView(flex());
                for (int i = 0; i < kids.length(); i++) {
                    JSONObject k = kids.optJSONObject(i);
                    if (k == null) continue;
                    Bound b = new Bound(r, k, this);
                    children.add(b);
                    if (spread && i > 0) box.addView(flex());
                    box.addView(b.root(), b.params(this, children.size() - 1));
                }
                if (spread && justify.equals("around")) box.addView(flex());
            }
            wireEvents();
            staticStyle();
        }

        private View flex() {
            Space s = new Space(r.ctx);
            s.setLayoutParams(new LinearLayout.LayoutParams(0, 0, 1f));
            return s;
        }

        private int size(Object v, int dflt) {
            if (v instanceof Number) return r.dp(((Number) v).floatValue());
            String s = v == null ? "" : String.valueOf(v);
            if (s.equals("match")) return ViewGroup.LayoutParams.MATCH_PARENT;
            if (s.equals("wrap")) return ViewGroup.LayoutParams.WRAP_CONTENT;
            try { return r.dp(Float.parseFloat(s)); } catch (NumberFormatException e) { return dflt; }
        }

        private static int gravityOf(String a, boolean vertical) {
            switch (a) {
                case "center": return vertical ? Gravity.CENTER_VERTICAL : Gravity.CENTER_HORIZONTAL;
                case "end": return vertical ? Gravity.BOTTOM : Gravity.END;
                case "start": return vertical ? Gravity.TOP : Gravity.START;
                default: return -1;
            }
        }

        /** Layout params in its parent (margins, gap, weight, alignment). */
        ViewGroup.LayoutParams params(Bound parent, int index) {
            boolean inRow = "row".equals(parent.el);
            boolean linear = parent.box instanceof LinearLayout;
            String parentAlign = parent.style.optString("align", inRow ? "center" : "stretch");
            int dW = !inRow && linear && parentAlign.equals("stretch") ? ViewGroup.LayoutParams.MATCH_PARENT : ViewGroup.LayoutParams.WRAP_CONTENT;
            int dH = inRow && linear && parentAlign.equals("stretch") ? ViewGroup.LayoutParams.MATCH_PARENT : ViewGroup.LayoutParams.WRAP_CONTENT;
            if (parent.box instanceof FrameLayout && !(parent.view instanceof ScrollView)) { dW = ViewGroup.LayoutParams.MATCH_PARENT; dH = ViewGroup.LayoutParams.MATCH_PARENT; }
            if (el.equals("divider")) { if (inRow) { dW = r.dp(1); dH = ViewGroup.LayoutParams.MATCH_PARENT; } else { dW = ViewGroup.LayoutParams.MATCH_PARENT; dH = r.dp(1); } }
            if (el.equals("spacer")) {
                Object sz = node.optJSONObject("props") == null ? null : node.optJSONObject("props").opt("size");
                if (sz == null) { LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, 0, 1f); return lp; }
                dW = dH = size(sz, 0);
            }
            int w = size(style.opt("width"), dW), h = size(style.opt("height"), dH);
            float weight = (float) style.optDouble("weight", 0);
            ViewGroup.MarginLayoutParams lp;
            if (parent.box instanceof LinearLayout) {
                LinearLayout.LayoutParams l = new LinearLayout.LayoutParams(weight > 0 && inRow ? 0 : w, weight > 0 && !inRow ? 0 : h, weight);
                String self = style.optString("self", "");
                int g = gravityOf(self.isEmpty() ? parentAlign : self, inRow);
                if (!self.equals("stretch") && g >= 0) l.gravity = g;
                if (self.equals("stretch")) { if (inRow) l.height = ViewGroup.LayoutParams.MATCH_PARENT; else l.width = ViewGroup.LayoutParams.MATCH_PARENT; }
                lp = l;
            } else {
                FrameLayout.LayoutParams f = new FrameLayout.LayoutParams(w, h);
                String self = style.optString("self", "");
                if (!self.isEmpty()) f.gravity = gravityOf(self, true) | gravityOf(self, false);
                lp = f;
            }
            int[] m = box4(style.opt("margin"));
            int gap = index > 0 && parent.box instanceof LinearLayout ? r.dp((float) parent.style.optDouble("gap", 0) * cz.m5cet.app.design.Appearance.density()) : 0;
            lp.setMargins(m[3] + (inRow ? gap : 0), m[0] + (inRow ? 0 : gap), m[1], m[2]);
            return lp;
        }

        int[] box4(Object v) {
            if (v == null) return new int[4];
            float k = cz.m5cet.app.design.Appearance.density();
            if (v instanceof Number) { int d = r.dp(((Number) v).floatValue() * k); return new int[]{d, d, d, d}; }
            String[] p = String.valueOf(v).trim().split("\\s+");
            int[] o = new int[4];
            try {
                float[] f = new float[p.length];
                for (int i = 0; i < p.length; i++) f[i] = Float.parseFloat(p[i]) * k;
                if (f.length == 1) o = new int[]{r.dp(f[0]), r.dp(f[0]), r.dp(f[0]), r.dp(f[0])};
                else if (f.length == 2) o = new int[]{r.dp(f[0]), r.dp(f[1]), r.dp(f[0]), r.dp(f[1])};
                else if (f.length == 3) o = new int[]{r.dp(f[0]), r.dp(f[1]), r.dp(f[2]), r.dp(f[1])};
                else if (f.length >= 4) o = new int[]{r.dp(f[0]), r.dp(f[1]), r.dp(f[2]), r.dp(f[3])};
            } catch (NumberFormatException ignored) { }
            return o;
        }

        private void staticStyle() {
            int[] p = box4(style.opt("padding"));
            if (el.equals("button")) { if (!style.has("padding")) p = new int[]{r.dp(11), r.dp(20), r.dp(11), r.dp(20)}; view.setMinimumHeight(r.dp(44)); }
            if (el.equals("badge") || el.equals("chip")) { if (!style.has("padding")) p = el.equals("chip") ? new int[]{r.dp(6), r.dp(12), r.dp(6), r.dp(12)} : new int[]{r.dp(2), r.dp(7), r.dp(2), r.dp(7)}; }
            view.setPadding(p[3], p[0], p[1], p[2]);
            if (box instanceof LinearLayout && view == box) {
                String j = style.optString("justify", "start");
                boolean row = "row".equals(el);
                int g = j.equals("center") ? (row ? Gravity.CENTER_HORIZONTAL : Gravity.CENTER_VERTICAL) : j.equals("end") ? (row ? Gravity.END : Gravity.BOTTOM) : (row ? Gravity.START : Gravity.TOP);
                ((LinearLayout) box).setGravity(g);
            }
            if (box instanceof FlowLayout) {
                String j = style.optString("justify", "start");
                ((FlowLayout) box).setGap(r.dp((float) style.optDouble("gap", 0) * Appearance.density()));
                ((FlowLayout) box).setJustify(j.equals("center") ? Gravity.CENTER_HORIZONTAL : j.equals("end") ? Gravity.END : Gravity.START);
            }
            if (style.has("elevation")) view.setElevation(r.dp((float) style.optDouble("elevation", 0)));
            if (style.has("maxWidth") && view instanceof TextView) ((TextView) view).setMaxWidth(r.dp((float) style.optDouble("maxWidth")));
            if (view instanceof TextView) {
                TextView t = (TextView) view;
                int lines = style.optInt("lines", 0);
                if (lines > 0) { t.setMaxLines(lines); t.setEllipsize(TextUtils.TruncateAt.END); }
                String align = s("align");
                if ("center".equals(align)) t.setGravity(Gravity.CENTER_HORIZONTAL);
                else if ("end".equals(align)) t.setGravity(Gravity.END);
                textAppearance(t);
            }
        }

        private void textAppearance(TextView t) {
            String variant = s("variant");
            if (variant == null) variant = el.equals("badge") ? "badge" : el.equals("button") || el.equals("chip") ? "label" : "body";
            float size; boolean bold = false;
            switch (variant) {
                case "display": size = 30; bold = true; break;
                case "headline": size = 23; bold = true; break;
                case "title": size = 19; bold = true; break;
                case "label": size = 14; bold = true; break;
                case "caption": size = 12; break;
                case "badge": size = 11; bold = true; break;
                case "mono": size = 13; break;
                default: size = 15.5f;
            }
            if (style.has("size")) size = (float) style.optDouble("size", size);
            t.setTextSize(TypedValue.COMPLEX_UNIT_SP, size * cz.m5cet.app.design.Appearance.fontScale());
            if (style.has("bold")) bold = style.optBoolean("bold");
            Design d = r.host.design();
            String font = style.optString("font", "");
            if ("mono".equals(variant)) t.setTypeface(android.graphics.Typeface.create(android.graphics.Typeface.MONOSPACE, bold ? android.graphics.Typeface.BOLD : android.graphics.Typeface.NORMAL));
            // 6.2: an element's own font (the font chips of Settings › Appearance show themselves).
            else if (!font.isEmpty()) t.setTypeface(Ui.typeface(Look.familyName(font), bold, style.optBoolean("italic")));
            // 6.2: labels of buttons and chips in the medium weight.
            else if (bold && !style.has("bold") && "label".equals(variant) && (el.equals("button") || el.equals("chip"))) t.setTypeface(Ui.labelFace(d));
            else t.setTypeface(Ui.typeface(d, bold, style.optBoolean("italic")));
            t.setLineSpacing(0, 1.1f);
            t.setIncludeFontPadding(false);
        }

        private void wireEvents() {
            JSONObject on = node.optJSONObject("on");
            if ((el.equals("switch") || el.equals("checkbox")) && (s("setting") != null || s("bind") != null) && (on == null || !on.has("click"))) {
                // A switch bound to a setting (or a form value) changes it itself; "change" follows.
                ((CompoundButton) view).setOnClickListener(v -> commit(((CompoundButton) v).isChecked(), v));
            }
            if (on == null) return;
            JSONObject click = on.optJSONObject("click");
            if (click != null) {
                View target = view;
                // 6.2: buttons tick under the finger (Settings › Appearance › Haptics).
                boolean tick = el.equals("button") || el.equals("iconButton") || el.equals("chip");
                target.setOnClickListener(v -> { if (tick) Look.haptic(v, false); fire(click, v); });
                if (!(target instanceof CompoundButton)) {
                    target.setClickable(true);
                    if (target.getBackground() == null && !el.equals("button") && !el.equals("iconButton") && !el.equals("chip")) {
                        TypedValue tv = new TypedValue();
                        r.ctx.getTheme().resolveAttribute(android.R.attr.selectableItemBackground, tv, true);
                        target.setForeground(r.ctx.getDrawable(tv.resourceId));
                    }
                }
            }
            JSONObject longClick = on.optJSONObject("longClick");
            if (longClick != null) view.setOnLongClickListener(v -> { Look.haptic(v, true); fire(longClick, v); return true; });
            JSONObject submit = on.optJSONObject("submit");
            if (submit != null && view instanceof EditText) {
                ((EditText) view).setImeOptions(EditorInfo.IME_ACTION_DONE);
                ((EditText) view).setOnEditorActionListener((v, id, ev) -> { fire(submit, v); return true; });
            }
        }

        /* ------------------------------------------------ values (6.1) */

        /** The value an input-like element shows: its setting, else its form value. */
        Object boundValue() {
            String key = s("setting");
            if (key != null) return r.host.setting(key);
            String bind = s("bind");
            return bind == null ? null : r.host.form().get(bind);
        }

        /** A new value from the user: into the setting / form, then the "change" event with $value. */
        void commit(Object value, View source) {
            String key = s("setting");
            // 6.2: the look (appearance.*) changes in place (Look draws the screen again) — the host would restart the activity.
            if (key != null && key.startsWith("appearance.")) Look.set(key, Expr.toText(value));
            else if (key != null) r.host.setSetting(key, value);
            String bind = s("bind");
            if (bind != null) r.host.form().put(bind, value);
            JSONObject on = node.optJSONObject("on");
            JSONObject change = on == null ? null : on.optJSONObject("change");
            Expr.Scope base = scope == null ? n -> null : scope;
            if (change != null) {
                Expr.Scope sc = n -> n.equals("value") ? value : base.get(n);
                String arg = change.optString("arg", null);
                r.host.action(change.optString("action"), arg, arg == null ? null : Expr.value(arg, sc, r.host.tr()), sc, source);
            }
        }

        /** "a:Label|b:{_'key'}" or "=expr" (a list of values or of {value, label}). */
        List<String[]> options(Expr.Scope sc) {
            List<String[]> out = new ArrayList<>();
            String raw = s("options");
            if (raw == null || raw.isEmpty()) return out;
            if (raw.startsWith("=")) {
                Object v = Expr.eval(raw.substring(1), sc, r.host.tr());
                if (v instanceof JSONArray) for (int i = 0; i < ((JSONArray) v).length() && i < 100; i++) {
                    Object o = ((JSONArray) v).opt(i);
                    if (o instanceof JSONObject) out.add(new String[]{((JSONObject) o).optString("value"), ((JSONObject) o).optString("label", ((JSONObject) o).optString("value"))});
                    else out.add(new String[]{Expr.toText(o), Expr.toText(o)});
                }
                return out;
            }
            for (String part : raw.split("\\|")) {
                int colon = part.indexOf(':');
                String value = colon < 0 ? part.trim() : part.substring(0, colon).trim();
                String label = colon < 0 ? value : Expr.render(part.substring(colon + 1).trim(), sc, r.host.tr());
                out.add(new String[]{value, label});
            }
            return out;
        }

        private void openSelect(View anchor) {
            Expr.Scope sc = scope == null ? n -> null : scope;
            List<String[]> opts = options(sc);
            if (opts.isEmpty()) return;
            // 6.7 (ui/look/Menus): the choices in the design's colours, the current one checked.
            String current = Expr.toText(boundValue());
            List<cz.m5cet.app.ui.look.Menus.Item> items = new ArrayList<>();
            for (String[] o : opts) items.add(new cz.m5cet.app.ui.look.Menus.Item("", o[1], false, o[0].equals(current), () -> commit(o[0], anchor)));
            cz.m5cet.app.ui.look.Menus.show(anchor, items);
        }

        private double num(String key, double d) {
            Object v = node.optJSONObject("props") == null ? null : node.optJSONObject("props").opt(key);
            if (v instanceof Number) return ((Number) v).doubleValue();
            try { return v == null ? d : Double.parseDouble(String.valueOf(v)); } catch (NumberFormatException e) { return d; }
        }

        private double sliderValue(int progress) {
            double min = num("min", 0), step = num("step", 0);
            double v = min + (num("max", 1) - min) * progress / 1000.0;
            if (step > 0) v = min + Math.round((v - min) / step) * step;
            return Math.round(v * 1000) / 1000.0;
        }

        private void fire(JSONObject handler, View source) {
            String arg = handler.optString("arg", null);
            Expr.Scope sc = scope == null ? n -> null : scope;
            Object value = arg == null ? null : Expr.value(arg, sc, r.host.tr());
            r.host.action(handler.optString("action"), arg, value, sc, source);
        }

        /* ------------------------------------------------------------ bind */

        public void bind(Expr.Scope sc) { bind(sc, 0); }

        void bind(Expr.Scope sc, int inheritedFg) {
            scope = sc;
            if (repeated != null) { bindEach(sc, inheritedFg); return; }
            String cond = node.optString("if", "");
            if (!cond.isEmpty()) {
                boolean show = Expr.truthy(Expr.eval(cond, sc, r.host.tr()));
                view.setVisibility(show ? View.VISIBLE : View.GONE);
                if (!show) return;
            }
            int fg = dynamicStyle(sc, inheritedFg);
            bindContent(sc, fg);
            for (Bound b : children) b.bind(sc, fg);
        }

        private void bindEach(Expr.Scope sc, int fg) {
            Object list = Expr.eval(node.optString("each"), sc, r.host.tr());
            List<Object> items = new ArrayList<>();
            if (list instanceof JSONArray) for (int i = 0; i < ((JSONArray) list).length() && i < 200; i++) items.add(((JSONArray) list).opt(i));
            else if (list instanceof List) for (Object o : (List<?>) list) { if (items.size() >= 200) break; items.add(o); }
            String as = node.optString("as", "item");
            JSONObject template = copyWithout(node, "each");
            while (repeated.size() > items.size()) repeatBox.removeView(repeated.remove(repeated.size() - 1).root());
            while (repeated.size() < items.size()) {
                Bound b = new Bound(r, template, parent);
                repeated.add(b);
                repeatBox.addView(b.root(), b.params(parent != null ? parent : this, repeated.size() - 1));
            }
            for (int i = 0; i < items.size(); i++) repeated.get(i).bind(child(sc, as, items.get(i), i, items.size()), fg);
        }

        private static JSONObject copyWithout(JSONObject o, String key) {
            JSONObject c = new JSONObject();
            for (Iterator<String> it = o.keys(); it.hasNext(); ) {
                String k = it.next();
                if (!k.equals(key)) try { c.put(k, o.opt(k)); } catch (org.json.JSONException ignored) { }
            }
            return c;
        }

        private String styleValue(String key, Expr.Scope sc) {
            Object v = style.opt(key);
            if (v == null) return null;
            if (v instanceof String && ((String) v).startsWith("=")) return Expr.toText(Expr.eval(((String) v).substring(1), sc, r.host.tr()));
            return String.valueOf(v);
        }

        /** Background, border, radius, opacity, text colour; returns the colour children inherit. */
        private int dynamicStyle(Expr.Scope sc, int inheritedFg) {
            Design d = r.host.design();
            int fg = inheritedFg == 0 ? r.color("@onSurface", Color.BLACK) : inheritedFg;
            String fgv = styleValue("fg", sc);
            if (fgv != null) fg = r.color(fgv, fg);
            String bg = styleValue("bg", sc);
            // 6.2: a card follows the template's radius; buttons and chips the user's shape (Settings › Appearance › Buttons).
            float radius = style.has("radius") ? r.dp((float) style.optDouble("radius")) : el.equals("card") ? r.dp(Appearance.radius(d) + 4)
                : el.equals("button") ? Look.radius(r.ctx, "button") : el.equals("chip") ? Look.radius(r.ctx, "chip") : el.equals("badge") ? r.dp(999) : 0;
            int borderW = 0, borderC = 0;
            String border = styleValue("border", sc);
            if (border != null) {
                String[] parts = border.trim().split("\\s+");
                try { borderW = r.dp(Float.parseFloat(parts[0])); } catch (NumberFormatException ignored) { }
                borderC = r.color(parts.length > 1 ? parts[1] : "@border", Color.GRAY);
            }
            int fill = Color.TRANSPARENT;
            boolean paint = false;
            if (bg != null) { fill = r.color(bg, Color.TRANSPARENT); paint = true; }
            // 6.2: a card rests lower (a calmer surface); the design can still raise it.
            if (el.equals("card") && bg == null) { fill = r.color("@surface", Color.WHITE); paint = true; if (!style.has("elevation")) view.setElevation(r.dp(1)); }
            if (el.equals("button")) {
                String variant = Expr.toText(propValue("variant", sc));
                if (variant.isEmpty()) variant = "primary";
                // 6.2: the main buttons in the user's style: filled, tonal, outlined or text.
                if (variant.equals("primary")) variant = "look:" + Look.buttons();
                if (bg == null) {
                    int primary = r.color("@primary", Color.BLUE);
                    switch (variant) {
                        case "primary": case "look:filled": fill = primary; fg = fgv == null ? r.color("@onPrimary", Color.WHITE) : fg; break;
                        case "look:outlined": fill = Color.TRANSPARENT; fg = fgv == null ? primary : fg; if (borderW == 0) { borderW = r.dp(1.5f); borderC = Ui.alpha(primary, 0.7f); } break;
                        case "danger": fill = r.color("@danger", Color.RED); fg = fgv == null ? Color.WHITE : fg; break;
                        case "tonal": case "look:tonal": fill = Ui.alpha(primary, 0.14f); fg = fgv == null ? primary : fg; break;
                        case "secondary": fill = Color.TRANSPARENT; if (borderW == 0) { borderW = r.dp(1); borderC = r.color("@border", Color.GRAY); } break;
                        default: fill = Color.TRANSPARENT; fg = fgv == null ? primary : fg;
                    }
                }
                paint = true;
            }
            if (el.equals("badge")) {
                String c = Expr.toText(propValue("color", sc));
                if (bg == null) { fill = r.color(c.isEmpty() ? "@primary" : c, Color.RED); paint = true; }
                if (fgv == null) fg = contrast(fill);
            }
            if (el.equals("chip")) {
                boolean sel = Expr.truthy(propValue("selected", sc));
                if (bg == null) { fill = sel ? Ui.alpha(r.color("@primary", Color.BLUE), 0.16f) : Color.TRANSPARENT; paint = true; }
                if (borderW == 0) { borderW = r.dp(1); borderC = sel ? r.color("@primary", Color.BLUE) : r.color("@border", Color.GRAY); }
                if (fgv == null && sel) fg = r.color("@primary", Color.BLUE);
            }
            if (el.equals("divider")) { fill = r.color(bg == null ? "@border" : bg, Color.LTGRAY); paint = true; }
            // 6.1: the bubbles' shape (Settings › Appearance › Bubbles) for the design's "bubble" elements
            // (6.2: and anything painted as a bubble — the preview's mini chat).
            if ("bubble".equals(node.optString("id")) || "@bubbleIn".equals(style.optString("bg")) || "@bubbleOut".equals(style.optString("bg"))) {
                String shape = cz.m5cet.app.design.Appearance.bubbles();
                if (shape.equals("square")) radius = r.dp(4);
                else if (shape.equals("minimal")) { fill = Color.TRANSPARENT; fg = r.color("@onSurface", fg); view.setElevation(0); if (borderW == 0) { borderW = r.dp(1); borderC = r.color("@border", Color.GRAY); } }
            }
            if (paint || borderW > 0 || radius > 0 && bg != null) {
                GradientDrawable g = Ui.shape(fill, radius, borderW, borderC);
                boolean clickable = node.optJSONObject("on") != null && node.optJSONObject("on").has("click");
                // 6.2: buttons and chips answer a press the user's way (ripple, scale, nothing).
                if (el.equals("button") || el.equals("chip") && clickable) view.setBackground(Look.pressable(view, g, Ui.alpha(fg, 0.18f)));
                else view.setBackground(clickable ? Ui.ripple(g, Ui.alpha(fg, 0.18f)) : g);
                if (radius > 0) { view.setClipToOutline(true); }
            }
            String op = styleValue("opacity", sc);
            if (op != null) try { view.setAlpha(Float.parseFloat(op)); } catch (NumberFormatException ignored) { }
            if (view instanceof TextView && !(view instanceof EditText)) ((TextView) view).setTextColor(fg);
            if (view instanceof EditText) {
                EditText e = (EditText) view;
                e.setTextColor(r.color("@onSurface", Color.BLACK));
                e.setHintTextColor(r.color("@muted", Color.GRAY));
            }
            if (view instanceof CompoundButton) {
                ((CompoundButton) view).setTextColor(fg);
                ((CompoundButton) view).setButtonTintList(ColorStateList.valueOf(r.color("@primary", Color.BLUE)));
            }
            return fg;
        }

        private static int contrast(int c) {
            double l = (0.299 * Color.red(c) + 0.587 * Color.green(c) + 0.114 * Color.blue(c)) / 255;
            return l > 0.6 ? 0xFF1C2330 : Color.WHITE;
        }

        private Object propValue(String key, Expr.Scope sc) {
            JSONObject props = node.optJSONObject("props");
            if (props == null || !props.has(key)) return null;
            Object v = props.opt(key);
            if (v instanceof String) return Expr.value((String) v, sc, r.host.tr());
            return v;
        }

        private void bindContent(Expr.Scope sc, int fg) {
            Expr.Translate tr = r.host.tr();
            switch (el) {
                case "text": case "badge": case "chip": case "button": {
                    TextView t = (TextView) view;
                    String text = Expr.render(node.optString("text", ""), sc, tr);
                    t.setText(text);
                    if ("true".equals(String.valueOf(propValue("links", sc)))) Linkify.addLinks(t, Linkify.WEB_URLS | Linkify.EMAIL_ADDRESSES);
                    String icon = Expr.toText(propValue("icon", sc));
                    if (!icon.isEmpty()) {
                        int px = el.equals("badge") ? r.dp(12) : r.dp(18);
                        Drawable dr = Icons.drawable(r.ctx, icon, px, fg);
                        dr.setBounds(0, 0, px, px);
                        t.setCompoundDrawablesRelative(dr, null, null, null);
                        t.setCompoundDrawablePadding(r.dp(el.equals("badge") ? 3 : 8));
                        // 6.7: in a wide button the icon stays beside its label (ui/look/Buttons).
                        if (el.equals("button")) cz.m5cet.app.ui.look.Buttons.hug(t);
                    } else {
                        t.setCompoundDrawablesRelative(null, null, null, null);
                    }
                    if (el.equals("button")) {
                        boolean disabled = Expr.truthy(propValue("disabled", sc));
                        t.setEnabled(!disabled);
                        t.setAlpha(disabled ? 0.5f : 1f);
                    }
                    break;
                }
                case "icon": {
                    String icon = Expr.toText(propValue("icon", sc));
                    Object size = propValue("size", sc);
                    int px = r.dp(size instanceof Number ? ((Number) size).floatValue() : parseF(size, 20));
                    String color = Expr.toText(propValue("color", sc));
                    iconView.setImageDrawable(Icons.drawable(r.ctx, icon.isEmpty() ? "circle" : icon, px, color.isEmpty() ? fg : r.color(color, fg)));
                    ViewGroup.LayoutParams lp = iconView.getLayoutParams();
                    iconView.setMinimumWidth(px);
                    iconView.setMinimumHeight(px);
                    if (lp != null && lp.width == ViewGroup.LayoutParams.WRAP_CONTENT) { lp.width = px; lp.height = px; }
                    break;
                }
                case "iconButton": {
                    String icon = Expr.toText(propValue("icon", sc));
                    String variant = Expr.toText(propValue("variant", sc));
                    // 6.2: a primary icon button in the user's button style and shape.
                    String look = variant.equals("primary") ? Look.buttons() : "";
                    int primary = r.color("@primary", Color.BLUE);
                    int color = look.equals("filled") ? r.color("@onPrimary", Color.WHITE) : look.isEmpty() ? fg : primary;
                    iconView.setImageDrawable(Icons.drawable(r.ctx, icon.isEmpty() ? "circle" : icon, r.dp(22), color));
                    float rad = Look.radius(r.ctx, "icon");
                    Drawable shape = look.equals("filled") ? Ui.shape(primary, rad, 0, 0) : look.equals("tonal") ? Ui.shape(Ui.alpha(primary, 0.14f), rad, 0, 0)
                        : look.equals("outlined") ? Ui.shape(Color.TRANSPARENT, rad, r.dp(1.5f), Ui.alpha(primary, 0.7f)) : null;
                    view.setBackground(Look.pressable(view, shape, Ui.alpha(shape == null ? fg : color, shape == null ? 0.16f : 0.2f)));
                    String label = Expr.render(s("label") == null ? "" : s("label"), sc, tr);
                    view.setContentDescription(label);
                    if (!label.isEmpty()) view.setTooltipText(label);
                    Object badge = propValue("badge", sc);
                    double n = badge instanceof Number ? ((Number) badge).doubleValue() : parseF(badge, 0);
                    if (n > 0) {
                        badgeView.setVisibility(View.VISIBLE);
                        badgeView.setText(n > 99 ? "99+" : Expr.toText(n));
                        badgeView.setTextColor(Color.WHITE);
                        badgeView.setPadding(r.dp(4), 0, r.dp(4), 0);
                        badgeView.setMinWidth(r.dp(16));
                        badgeView.setBackground(Ui.shape(r.color("@primary", Color.RED), r.dp(8), 0, 0));
                    } else {
                        badgeView.setVisibility(View.GONE);
                    }
                    break;
                }
                case "avatar": {
                    Object size = propValue("size", sc);
                    ((AvatarView) view).set(Expr.toText(propValue("name", sc)), r.dp(size instanceof Number ? ((Number) size).floatValue() : parseF(size, 36)));
                    break;
                }
                case "image": {
                    // 6.7 (F-01): a computed src may name only a local source; a remote one only as a literal.
                    JSONObject ps = node.optJSONObject("props");
                    Object rawSrc = ps == null ? null : ps.opt("src");
                    String src = DesignUrls.image(rawSrc instanceof String ? (String) rawSrc : null, Expr.toText(propValue("src", sc)));
                    RatioImageView iv = (RatioImageView) view;
                    Object ratio = propValue("ratio", sc);
                    iv.ratio = ratio instanceof Number ? ((Number) ratio).floatValue() : parseF(ratio, 0);
                    String fit = Expr.toText(propValue("fit", sc));
                    iv.setScaleType(fit.equals("contain") ? ImageView.ScaleType.FIT_CENTER : fit.equals("center") ? ImageView.ScaleType.CENTER : ImageView.ScaleType.CENTER_CROP);
                    Images.load(r, iv, src);
                    break;
                }
                case "progress": {
                    Object v = propValue("value", sc);
                    ProgressBar p = (ProgressBar) view;
                    if (v != null && !p.isIndeterminate()) { p.setMax(1000); p.setProgress((int) Math.round(Expr.num(v) * 1000)); }
                    p.setProgressTintList(ColorStateList.valueOf(r.color("@primary", Color.BLUE)));
                    p.setIndeterminateTintList(ColorStateList.valueOf(r.color("@primary", Color.BLUE)));
                    break;
                }
                case "input": {
                    EditText e = (EditText) view;
                    String bind = s("bind");
                    e.setHint(Expr.render(s("hint") == null ? "" : s("hint"), sc, tr));
                    String type = s("type") == null ? "text" : s("type");
                    int it;
                    switch (type) {
                        case "password": it = InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD; break;
                        case "number": it = InputType.TYPE_CLASS_NUMBER; break;
                        case "email": it = InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS; break;
                        case "phone": it = InputType.TYPE_CLASS_PHONE; break;
                        case "url": it = InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI; break;
                        case "multiline": it = InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES; break;
                        default: it = InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES;
                    }
                    if (e.getInputType() != it) e.setInputType(it);
                    if (bind != null && e.getTag(R.id.m5_input_bind) == null) {
                        e.setTag(R.id.m5_input_bind, bind);
                        Object v = r.host.form().get(bind);
                        if (v != null) e.setText(String.valueOf(v));
                        e.addTextChangedListener(new TextWatcher() {
                            @Override public void beforeTextChanged(CharSequence s, int a, int b, int c) { }
                            @Override public void onTextChanged(CharSequence s, int a, int b, int c) { }
                            @Override public void afterTextChanged(Editable s) { r.host.form().put(bind, s.toString()); }
                        });
                    } else if (bind != null) {
                        // 6.8: a value set elsewhere (a button that makes up a code) shows in the field; what is typed is there already.
                        Object v = r.host.form().get(bind);
                        if (v != null && !String.valueOf(v).equals(e.getText().toString())) { e.setText(String.valueOf(v)); e.setSelection(e.getText().length()); }
                    }
                    e.setBackground(Ui.shape(r.color("@surfaceVariant", Color.LTGRAY), Math.min(Look.radius(r.ctx, "field"), r.dp(22)), 0, 0));
                    if (!style.has("padding")) e.setPadding(r.dp(14), r.dp(10), r.dp(14), r.dp(10));
                    break;
                }
                case "switch": case "checkbox": {
                    CompoundButton cb = (CompoundButton) view;
                    cb.setText(Expr.render(node.optString("text", ""), sc, tr));
                    boolean checked = s("checked") != null ? Expr.truthy(propValue("checked", sc)) : Expr.truthy(boundValue());
                    if (cb.isChecked() != checked) cb.setChecked(checked);
                    break;
                }
                case "select": {
                    TextView t = (TextView) view;
                    String current = Expr.toText(boundValue());
                    String label = current;
                    for (String[] o : options(sc)) if (o[0].equals(current)) { label = o[1]; break; }
                    if (label.isEmpty()) label = Expr.render(s("hint") == null ? "" : s("hint"), sc, tr);
                    t.setText(label);
                    Drawable chevron = Icons.drawable(r.ctx, "chevron-down", r.dp(18), fg);
                    chevron.setBounds(0, 0, r.dp(18), r.dp(18));
                    t.setCompoundDrawablesRelative(null, null, chevron, null);
                    t.setCompoundDrawablePadding(r.dp(8));
                    if (!style.has("bg")) t.setBackground(Ui.ripple(Ui.shape(r.color("@surfaceVariant", Color.LTGRAY), r.dp(12), 0, 0), Ui.alpha(fg, 0.12f)));
                    if (!style.has("padding")) t.setPadding(r.dp(14), r.dp(8), r.dp(12), r.dp(8));
                    break;
                }
                case "slider": {
                    android.widget.SeekBar sb = (android.widget.SeekBar) view;
                    sb.setMax(1000);
                    double min = num("min", 0), max = num("max", 1);
                    double v = Expr.num(boundValue());
                    if (!sb.isPressed()) sb.setProgress(max > min ? (int) Math.round((Math.max(min, Math.min(max, v)) - min) / (max - min) * 1000) : 0);
                    int accent = r.color("@primary", Color.BLUE);
                    sb.setProgressTintList(ColorStateList.valueOf(accent));
                    sb.setThumbTintList(ColorStateList.valueOf(accent));
                    break;
                }
                case "segmented": {
                    LinearLayout l = (LinearLayout) view;
                    List<String[]> opts = options(sc);
                    String current = Expr.toText(boundValue());
                    if (l.getChildCount() != opts.size()) {
                        l.removeAllViews();
                        for (int i = 0; i < opts.size(); i++) {
                            TextView seg = new TextView(r.ctx);
                            seg.setGravity(Gravity.CENTER);
                            seg.setMinHeight(r.dp(38));
                            seg.setPadding(r.dp(12), r.dp(6), r.dp(12), r.dp(6));
                            seg.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f * Appearance.fontScale());
                            final int at = i;
                            seg.setOnClickListener(v -> { Look.haptic(v, false); List<String[]> now = options(scope == null ? n -> null : scope); if (at < now.size()) commit(now.get(at)[0], v); });
                            l.addView(seg, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
                        }
                    }
                    int accent = r.color("@primary", Color.BLUE);
                    // 6.2: the segments take the buttons' shape; the chosen one is a calm raised pill of the surface.
                    float outer = Math.min(Look.radius(r.ctx, "button"), r.dp(22)), inner = Math.max(0, outer - r.dp(3));
                    boolean tonal = !Look.buttons().equals("filled");
                    for (int i = 0; i < opts.size(); i++) {
                        TextView seg = (TextView) l.getChildAt(i);
                        boolean sel = opts.get(i)[0].equals(current);
                        seg.setText(opts.get(i)[1]);
                        seg.setTextColor(sel ? (tonal ? accent : r.color("@onPrimary", Color.WHITE)) : fg);
                        seg.setTypeface(sel ? Ui.labelFace(r.host.design()) : Ui.typeface(r.host.design(), false, false));
                        int selFill = tonal ? r.color("@surface", Color.WHITE) : accent;
                        seg.setBackground(Look.pressable(seg, Ui.shape(sel ? selFill : Color.TRANSPARENT, inner, 0, 0), Ui.alpha(fg, 0.12f)));
                        seg.setElevation(sel && tonal ? r.dp(1) : 0);
                        seg.setSelected(sel);
                    }
                    if (!style.has("bg")) l.setBackground(Ui.shape(r.color("@surfaceVariant", Color.LTGRAY), outer, 0, 0));
                    if (!style.has("padding")) l.setPadding(r.dp(3), r.dp(3), r.dp(3), r.dp(3));
                    break;
                }
                case "slot": {
                    if (view instanceof Slot) ((Slot) view).bindSlot(sc);
                    break;
                }
                case "swipe": ((cz.m5cet.app.ui.look.SwipeRow) view).bind(node.optJSONObject("props"), sc, tr, r.host.design(), r::color, (a, raw, arg, v) -> r.host.action(a, raw, arg, sc, v)); break;
                default: break;
            }
            if (!animated) {
                animated = true;
                JSONObject enter = node.optJSONObject("anim") == null ? null : node.optJSONObject("anim").optJSONObject("enter");
                if (enter != null && r.host instanceof AnimationGate && ((AnimationGate) r.host).animateEnter()) animate(view, enter, r.ctx);
            }
        }

        private static float parseF(Object v, float d) {
            if (v == null) return d;
            try { return Float.parseFloat(String.valueOf(v)); } catch (NumberFormatException e) { return d; }
        }

        /** Runs this node's (and its children's) enter animation again (a new list item). */
        public void enter() {
            JSONObject enter = node.optJSONObject("anim") == null ? null : node.optJSONObject("anim").optJSONObject("enter");
            if (enter != null) animate(view, enter, r.ctx);
        }
    }

    /** Hosts that decide whether enter animations run (not while recycling list rows). */
    public interface AnimationGate { boolean animateEnter(); }

    /** A native part that wants the scope of its tree. */
    public interface Slot { void bindSlot(Expr.Scope scope); }

    /**
     * An enter animation of the design, as the user wants motion (6.2,
     * Settings › Appearance › Animations): off, subtle (shorter and nearer),
     * normal, lively (further, springy), and at their speed.
     */
    public static void animate(View v, JSONObject spec, Context ctx) {
        if (Look.still(ctx)) return;
        String type = spec.optString("type", "fade");
        long ms = Look.ms(spec.optLong("ms", 220));
        long delay = Look.ms(spec.optLong("delay", 0));
        float k = Look.travel();
        float d = Ui.dp(ctx, 24) * k;
        float scale = 1 - 0.1f * k, pop = Math.max(0.2f, 1 - 0.5f * k);
        AnimatorSet set = new AnimatorSet();
        switch (type) {
            case "none": return;
            case "slide-up": set.playTogether(ObjectAnimator.ofFloat(v, View.TRANSLATION_Y, d, 0), ObjectAnimator.ofFloat(v, View.ALPHA, 0, 1)); break;
            case "slide-down": set.playTogether(ObjectAnimator.ofFloat(v, View.TRANSLATION_Y, -d, 0), ObjectAnimator.ofFloat(v, View.ALPHA, 0, 1)); break;
            case "slide-left": set.playTogether(ObjectAnimator.ofFloat(v, View.TRANSLATION_X, d, 0), ObjectAnimator.ofFloat(v, View.ALPHA, 0, 1)); break;
            case "slide-right": set.playTogether(ObjectAnimator.ofFloat(v, View.TRANSLATION_X, -d, 0), ObjectAnimator.ofFloat(v, View.ALPHA, 0, 1)); break;
            case "scale": set.playTogether(ObjectAnimator.ofFloat(v, View.SCALE_X, scale, 1), ObjectAnimator.ofFloat(v, View.SCALE_Y, scale, 1), ObjectAnimator.ofFloat(v, View.ALPHA, 0, 1)); break;
            case "pop": set.playTogether(ObjectAnimator.ofFloat(v, View.SCALE_X, pop, 1), ObjectAnimator.ofFloat(v, View.SCALE_Y, pop, 1), ObjectAnimator.ofFloat(v, View.ALPHA, 0, 1)); break;
            default: set.playTogether(ObjectAnimator.ofFloat(v, View.ALPHA, 0, 1));
        }
        set.setDuration(ms);
        set.setStartDelay(delay);
        set.setInterpolator(Look.easing(spec.optString("easing", type.equals("pop") ? "overshoot" : "decelerate")));
        set.start();
    }

    /* ========================================================= small views */

    static final class AvatarView extends View {
        private final Paint bg = new Paint(Paint.ANTI_ALIAS_FLAG), text = new Paint(Paint.ANTI_ALIAS_FLAG);
        private String initials = "?";
        private int size;

        AvatarView(Context c) { super(c); text.setColor(Color.WHITE); text.setTextAlign(Paint.Align.CENTER); text.setFakeBoldText(true); }

        void set(String name, int sizePx) {
            initials = Ui.initials(name);
            bg.setColor(Ui.nameColor(name == null ? "" : name));
            if (size != sizePx) { size = sizePx; requestLayout(); }
            invalidate();
        }

        @Override protected void onMeasure(int w, int h) { setMeasuredDimension(size, size); }

        @Override protected void onDraw(Canvas c) {
            float r = size / 2f;
            c.drawCircle(r, r, r, bg);
            text.setTextSize(size * 0.4f);
            c.drawText(initials, r, r - (text.descent() + text.ascent()) / 2, text);
        }
    }

    static final class RatioImageView extends ImageView {
        float ratio = 0;
        RatioImageView(Context c) { super(c); setAdjustViewBounds(true); }
        @Override protected void onMeasure(int w, int h) {
            super.onMeasure(w, h);
            if (ratio > 0) { int width = getMeasuredWidth(); setMeasuredDimension(width, Math.round(width / ratio)); }
        }
    }

    /** Images of the design (asset:<name>) and https URLs, decoded once and kept. */
    static final class Images {
        private static final android.util.LruCache<String, Bitmap> cache = new android.util.LruCache<String, Bitmap>(16 * 1024 * 1024) {
            @Override protected int sizeOf(String k, Bitmap b) { return b.getByteCount(); }
        };

        static void load(Renderer r, ImageView iv, String src) {
            if (src == null || src.isEmpty()) { iv.setImageDrawable(null); return; }
            Bitmap cached = cache.get(src);
            if (cached != null) { iv.setImageBitmap(cached); return; }
            if (src.startsWith("asset:")) {
                byte[] b = r.host.design().assets.get(src.substring(6));
                if (b != null) { Bitmap bm = BitmapFactory.decodeByteArray(b, 0, b.length); if (bm != null) { cache.put(src, bm); iv.setImageBitmap(bm); } }
                return;
            }
            if (src.startsWith("data:image/")) {
                int comma = src.indexOf(',');
                if (comma > 0) {
                    byte[] b = android.util.Base64.decode(src.substring(comma + 1), android.util.Base64.DEFAULT);
                    Bitmap bm = decodeScaled(b, 1600);
                    if (bm != null) { cache.put(src, bm); iv.setImageBitmap(bm); }
                }
                return;
            }
            if (!src.startsWith("https://")) return;
            iv.setTag(src);
            cz.m5cet.app.core.Io.bg(() -> {
                try {
                    java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(src).openConnection();
                    c.setConnectTimeout(10_000);
                    c.setReadTimeout(20_000);
                    byte[] b;
                    try (java.io.InputStream in = c.getInputStream()) { b = cz.m5cet.app.core.Streams.readAll(in, 16L << 20); }
                    Bitmap bm = decodeScaled(b, 1600);
                    if (bm == null) return;
                    cache.put(src, bm);
                    cz.m5cet.app.core.Io.main(() -> { if (src.equals(iv.getTag())) iv.setImageBitmap(bm); });
                } catch (Exception ignored) { }
            });
        }

        static Bitmap decodeScaled(byte[] b, int max) {
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(b, 0, b.length, o);
            int s = 1;
            while (o.outWidth / s > max || o.outHeight / s > max) s *= 2;
            o = new BitmapFactory.Options();
            o.inSampleSize = s;
            return BitmapFactory.decodeByteArray(b, 0, b.length, o);
        }
    }
}
