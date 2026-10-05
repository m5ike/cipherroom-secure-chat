package cz.m5cet.app.ui.parts;

import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.TextUtils;
import android.text.style.BackgroundColorSpan;
import android.text.style.ForegroundColorSpan;
import android.text.style.StyleSpan;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.List;
import java.util.function.BiConsumer;

import cz.m5cet.app.M5;
import cz.m5cet.app.contacts.Avatars;
import cz.m5cet.app.fn.ArgHint;
import cz.m5cet.app.fn.Command;
import cz.m5cet.app.fn.CommandCheck;
import cz.m5cet.app.fn.ModelIdentity;
import cz.m5cet.app.fn.Suggestions;
import cz.m5cet.app.ui.Icons;
import cz.m5cet.app.ui.MainActivity;
import cz.m5cet.app.ui.Ui;
import cz.m5cet.app.ui.bubble.ModelFace;
import cz.m5cet.app.ui.look.Look;

/**
 * 6.11: the message box's suggester (Composer) — what typing "/", "@" or "#"
 * offers, in sections ("Recently used", "Commands", "Other matches",
 * "People", "Tags"), each row a 56 dp target: a command with its model's
 * icon in its colour, the keyword and name with what matched highlighted,
 * the summary, the arguments (required ones stand out) and who sees the
 * answer; a person with their monogram; a tag. While a command's arguments
 * are typed, a hint bar says which one is next — the usage line with it
 * highlighted, what it expects, its help, and its values to tap. In the
 * design's colours; TalkBack reads each row whole, the headers as headings.
 */
final class ComposerSuggest {
    private final MainActivity a;
    private final Parts parts;
    /** Puts a text into the box with the cursor at a place (Composer). */
    private final BiConsumer<String, Integer> put;
    private final MaxScroll scroll;
    private final LinearLayout list;
    private final LinearLayout hint;

    ComposerSuggest(MainActivity a, Parts parts, BiConsumer<String, Integer> put) {
        this.a = a;
        this.parts = parts;
        this.put = put;
        Context c = a;
        list = new LinearLayout(c);
        list.setOrientation(LinearLayout.VERTICAL);
        list.setPadding(0, dp(4), 0, dp(4));
        scroll = new MaxScroll(c, dp(272));
        scroll.setVerticalScrollBarEnabled(true);
        scroll.addView(list, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        scroll.setVisibility(View.GONE);
        hint = new LinearLayout(c);
        hint.setOrientation(LinearLayout.VERTICAL);
        hint.setPadding(dp(14), dp(8), dp(14), dp(6));
        hint.setVisibility(View.GONE);
    }

    /** The list (above the hint). */
    View list() { return scroll; }

    /** The hint bar (just above the field). */
    View hint() { return hint; }

    private M5 app() { return a.app(); }
    private int dp(float v) { return Ui.dp(a, v); }
    private int color(String token, int fallback) { return Ui.color(a, token, fallback); }

    /** The text or the cursor changed: what to offer now. */
    void update(String text, int caret) {
        Suggestions.Result res = parts.suggestions(text, caret);
        fill(text, res);
        ArgHint h = res == null || res.items.isEmpty() ? parts.argHint(text, caret) : null;
        hint(h);
    }

    void hide() { scroll.setVisibility(View.GONE); hint.setVisibility(View.GONE); }

    /* ------------------------------------------------------------- list */

    private void fill(String text, Suggestions.Result res) {
        list.removeAllViews();
        if (res == null || res.items.isEmpty()) { scroll.setVisibility(View.GONE); return; }
        String section = null;
        for (Suggestions.Item it : res.items) {
            if (it.disabled) { list.addView(notice(it)); continue; }
            if (!it.section.isEmpty() && !it.section.equals(section)) { section = it.section; list.addView(header(section)); }
            list.addView(row(it));
        }
        scroll.setVisibility(View.VISIBLE);
        scroll.scrollTo(0, 0);
    }

    private View header(String section) {
        TextView t = new TextView(a);
        t.setText(app().t("fnm.sec." + section).toUpperCase(java.util.Locale.getDefault()));
        t.setTextColor(color("@muted", Color.GRAY));
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        t.setLetterSpacing(0.06f);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setPadding(dp(16), dp(8), dp(16), dp(2));
        t.setAccessibilityHeading(true);
        return t;
    }

    private View notice(Suggestions.Item it) {
        TextView t = new TextView(a);
        t.setText("off".equals(it.key) ? app().t("functions.off") : app().t("fnm.none"));
        t.setTextColor(color("@muted", Color.GRAY));
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f);
        t.setPadding(dp(16), dp(12), dp(16), dp(12));
        t.setMinHeight(dp(48));
        t.setGravity(Gravity.CENTER_VERTICAL);
        return t;
    }

    private View row(Suggestions.Item it) {
        int fg = color("@onSurface", Color.BLACK), muted = color("@muted", Color.GRAY), primary = color("@primary", Color.BLUE);
        LinearLayout row = new LinearLayout(a);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setMinimumHeight(dp(56));
        row.setPadding(dp(12), dp(6), dp(12), dp(6));
        row.setBackground(Look.pressable(row, null, Ui.alpha(fg, 0.12f)));
        row.addView(face(it), new LinearLayout.LayoutParams(dp(36), dp(36)));
        LinearLayout col = new LinearLayout(a);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(dp(12), 0, dp(8), 0);
        // The keyword (or name, tag) and — for a command — its name beside it.
        SpannableStringBuilder top = new SpannableStringBuilder();
        append(top, it.label, it.labelHits, fg, primary, true);
        if (!it.name.isEmpty() && !it.name.equalsIgnoreCase(it.key)) {
            top.append("  ");
            append(top, it.name, it.nameHits, muted, primary, false);
        }
        TextView t = new TextView(a);
        t.setText(top);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        t.setSingleLine(true);
        t.setEllipsize(TextUtils.TruncateAt.END);
        col.addView(t);
        if (!it.summary.isEmpty()) {
            SpannableStringBuilder s = new SpannableStringBuilder();
            append(s, it.summary, it.summaryHits, muted, primary, false);
            TextView d = small(s, muted);
            d.setMaxLines(1);
            d.setEllipsize(TextUtils.TruncateAt.END);
            col.addView(d);
        }
        if (!it.args.isEmpty()) col.addView(small(signature(it.args, fg, muted), muted));
        row.addView(col, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        if (!it.visibility.isEmpty()) row.addView(badge(it.visibility));
        row.setContentDescription(describe(it));
        row.setOnClickListener(v -> { Look.haptic(v, false); hide(); put.accept(it.text, it.cursor); });
        return row;
    }

    /** The command's model in its colour, a person's monogram, a tag's hash. */
    private View face(Suggestions.Item it) {
        if (it.model != null) return modelCircle(it.model, 36, 20);
        boolean person = "people".equals(it.section);
        String name = it.key.isEmpty() ? "?" : it.key;
        int bg = person ? Avatars.hsl(Avatars.hue(name), 0.55f, 0.48f, 1f) : Ui.alpha(color("@primary", Color.BLUE), 0.14f);
        if (!person) {
            ImageView iv = new ImageView(a);
            iv.setScaleType(ImageView.ScaleType.CENTER);
            iv.setImageDrawable(Icons.drawable(a, "hash", dp(18), color("@primary", Color.BLUE)));
            iv.setBackground(Ui.shape(bg, dp(18), 0, 0));
            iv.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            return iv;
        }
        TextView t = new TextView(a);
        t.setText(name.substring(0, Character.charCount(name.codePointAt(0))).toUpperCase(java.util.Locale.getDefault()));
        t.setTextColor(Color.WHITE);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setGravity(Gravity.CENTER);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        t.setBackground(Ui.shape(bg, dp(18), 0, 0));
        t.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        return t;
    }

    /** A model's avatar: its icon (or emoji) in white on its colour. */
    View modelCircle(ModelIdentity id, int sizeDp, int iconDp) {
        if (!id.lucide()) {
            TextView t = new TextView(a);
            t.setText(id.icon);
            t.setGravity(Gravity.CENTER);
            t.setTextSize(TypedValue.COMPLEX_UNIT_SP, iconDp - 2);
            t.setBackground(Ui.shape(id.argb(), dp(sizeDp / 2f), 0, 0));
            t.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            return t;
        }
        ImageView iv = new ImageView(a);
        iv.setScaleType(ImageView.ScaleType.CENTER);
        iv.setImageDrawable(Icons.drawable(a, ModelFace.glyph(id, n -> Icons.has(a, n)), dp(iconDp), Color.WHITE));
        iv.setBackground(Ui.shape(id.argb(), dp(sizeDp / 2f), 0, 0));
        iv.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        return iv;
    }

    private TextView small(CharSequence s, int color) {
        TextView t = new TextView(a);
        t.setText(s);
        t.setTextColor(color);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
        t.setPadding(0, dp(1), 0, 0);
        return t;
    }

    /** "&lt;number&gt; [format]": required arguments in the text colour, optional ones muted. */
    private CharSequence signature(List<Suggestions.Arg> args, int fg, int muted) {
        SpannableStringBuilder sb = new SpannableStringBuilder();
        for (Suggestions.Arg x : args) {
            if (sb.length() > 0) sb.append(' ');
            int s = sb.length();
            sb.append(x.required ? "<" + x.name + ">" : "[" + x.name + "]");
            sb.setSpan(new ForegroundColorSpan(x.required ? fg : muted), s, sb.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            if (x.required) sb.setSpan(new StyleSpan(Typeface.BOLD), s, sb.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        }
        sb.setSpan(new android.text.style.TypefaceSpan("monospace"), 0, sb.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        return sb;
    }

    /** Who sees the model's answer: the room, or only the one who runs it. */
    private View badge(String visibility) {
        boolean room = "room".equals(visibility);
        int c = room ? color("@primary", Color.BLUE) : color("@muted", Color.GRAY);
        LinearLayout b = new LinearLayout(a);
        b.setGravity(Gravity.CENTER_VERTICAL);
        b.setPadding(dp(6), dp(2), dp(8), dp(2));
        b.setBackground(Ui.shape(Ui.alpha(c, 0.12f), dp(999), 0, 0));
        ImageView ic = new ImageView(a);
        ic.setImageDrawable(Icons.drawable(a, room ? "users" : "lock", dp(12), c));
        b.addView(ic, new LinearLayout.LayoutParams(dp(12), dp(12)));
        TextView t = new TextView(a);
        t.setText(app().t(room ? "fnm.vis.room" : "fnm.vis.caller"));
        t.setTextColor(c);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        t.setPadding(dp(4), 0, 0, 0);
        b.addView(t);
        b.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        return b;
    }

    private String describe(Suggestions.Item it) {
        StringBuilder sb = new StringBuilder(app().t("fnm.pick").replace("{label}", it.label));
        if (!it.name.isEmpty() && !it.name.equalsIgnoreCase(it.key)) sb.append(". ").append(it.name);
        if (!it.summary.isEmpty()) sb.append(". ").append(it.summary);
        for (Suggestions.Arg x : it.args) sb.append(". ").append(x.name).append(", ").append(app().t(x.required ? "fnm.required" : "fnm.optional"));
        if (!it.visibility.isEmpty()) sb.append(". ").append(app().t("room".equals(it.visibility) ? "fnm.vis.room" : "fnm.vis.caller"));
        return sb.toString();
    }

    /** text with its matched parts in the accent colour and bold. */
    private static void append(SpannableStringBuilder sb, String text, List<int[]> hits, int color, int accent, boolean bold) {
        int base = sb.length();
        sb.append(text);
        sb.setSpan(new ForegroundColorSpan(color), base, sb.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        if (bold) sb.setSpan(new StyleSpan(Typeface.BOLD), base, sb.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        for (int[] h : hits) {
            int s = base + Math.max(0, Math.min(h[0], text.length())), e = base + Math.max(0, Math.min(h[1], text.length()));
            if (e <= s) continue;
            sb.setSpan(new ForegroundColorSpan(accent), s, e, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            sb.setSpan(new StyleSpan(Typeface.BOLD), s, e, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        }
    }

    /* ------------------------------------------------------------- hint */

    private void hint(ArgHint h) {
        hint.removeAllViews();
        if (h == null) { hint.setVisibility(View.GONE); return; }
        int fg = color("@onSurface", Color.BLACK), muted = color("@muted", Color.GRAY), primary = color("@primary", Color.BLUE);
        hint.setBackground(Ui.shape(Ui.alpha(primary, 0.06f), 0, 0, 0));
        LinearLayout top = new LinearLayout(a);
        top.setGravity(Gravity.CENTER_VERTICAL);
        top.addView(modelCircle(h.model, 24, 14), new LinearLayout.LayoutParams(dp(24), dp(24)));
        // The usage line, the argument being typed highlighted.
        SpannableStringBuilder u = new SpannableStringBuilder(h.usage);
        u.setSpan(new android.text.style.TypefaceSpan("monospace"), 0, u.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        u.setSpan(new ForegroundColorSpan(muted), 0, u.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        for (int k = 0; k < h.spans.size(); k++) {
            int[] s = h.spans.get(k);
            if (k == h.current) {
                u.setSpan(new ForegroundColorSpan(Color.WHITE), s[0], s[1], Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                u.setSpan(new BackgroundColorSpan(primary), s[0], s[1], Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                u.setSpan(new StyleSpan(Typeface.BOLD), s[0], s[1], Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            } else if (h.command.inputs.get(k).mustGive()) {
                u.setSpan(new ForegroundColorSpan(fg), s[0], s[1], Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            }
        }
        TextView usage = new TextView(a);
        usage.setText(u);
        usage.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f);
        usage.setPadding(dp(8), 0, 0, 0);
        usage.setSingleLine(true);
        usage.setEllipsize(TextUtils.TruncateAt.END);
        top.addView(usage, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        hint.addView(top);
        Command.Input in = h.input();
        TextView what = new TextView(a);
        what.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
        what.setPadding(dp(32), dp(3), 0, 0);
        if (in == null) {
            what.setText(app().t("fnm.hint.done"));
            what.setTextColor(muted);
        } else {
            SpannableStringBuilder w = new SpannableStringBuilder();
            String name = in.label != null && !in.label.isEmpty() ? in.label : in.name;
            w.append(name);
            w.setSpan(new StyleSpan(Typeface.BOLD), 0, w.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            w.setSpan(new ForegroundColorSpan(fg), 0, w.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            w.append(" · ").append(app().t(in.mustGive() ? "fnm.required" : "fnm.optional")).append(" · ").append(CommandCheck.expectation(in, app()::t));
            if (in.help != null && !in.help.isEmpty()) w.append("\n").append(in.help);
            what.setText(w);
            what.setTextColor(muted);
        }
        what.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        hint.addView(what);
        if (!h.values.isEmpty()) {
            HorizontalScrollView hs = new HorizontalScrollView(a);
            hs.setHorizontalScrollBarEnabled(false);
            LinearLayout chips = new LinearLayout(a);
            chips.setPadding(dp(28), dp(4), 0, 0);
            for (String v : h.values) {
                TextView chip = new TextView(a);
                chip.setText(v);
                chip.setTextColor(primary);
                chip.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f);
                chip.setGravity(Gravity.CENTER);
                chip.setMinHeight(dp(36));
                chip.setPadding(dp(12), 0, dp(12), 0);
                chip.setBackground(Look.pressable(chip, Ui.shape(Ui.alpha(primary, 0.12f), dp(999), dp(1), Ui.alpha(primary, 0.4f)), Ui.alpha(primary, 0.2f)));
                chip.setContentDescription(app().t("fnm.hint.value").replace("{value}", v));
                chip.setOnClickListener(x -> { Look.haptic(x, false); String[] p = h.pick(v); put.accept(p[0], Integer.parseInt(p[1])); });
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                lp.setMarginEnd(dp(6));
                chips.addView(chip, lp);
            }
            hs.addView(chips);
            hint.addView(hs);
        }
        hint.setContentDescription(null);
        hint.setVisibility(View.VISIBLE);
    }

    /** A scroll view no taller than max (px): the list stays above the keyboard. */
    private static final class MaxScroll extends ScrollView {
        private final int max;
        MaxScroll(Context c, int max) { super(c); this.max = max; }
        @Override protected void onMeasure(int w, int h) {
            int size = MeasureSpec.getSize(h), mode = MeasureSpec.getMode(h);
            int cap = mode == MeasureSpec.UNSPECIFIED ? max : Math.min(size, max);
            super.onMeasure(w, MeasureSpec.makeMeasureSpec(cap, MeasureSpec.AT_MOST));
        }
    }
}
