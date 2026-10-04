package cz.m5cet.app.fn;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TableLayout;
import android.widget.TableRow;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/**
 * A function's outputs in a message, drawn natively (FnOutputs.tsx): text,
 * Markdown, code, tables, JSON, images, files, notices, sound and video,
 * buttons (side by side), forms — and formatted HTML (6.6) in a locked-down
 * WebView (FnHtmlView). Browser JavaScript and app panels are the web app's;
 * here they are a note.
 *
 * Each item stands on its own: one that fails to draw becomes a short note
 * and is reported once (Host.report → Commands.report, whose error entry
 * point may answer). What a message does once — its notices, autoplay, a
 * once-button or form used — is remembered by the message's key, so a list
 * that rebinds its rows does not repeat it; notices and autoplay happen only
 * while the message is fresh (30 s).
 */
public final class FnView extends LinearLayout {
    /** What the outputs need from the app. */
    public interface Host {
        /** A click or a form for the model (Commands.event with meta and ev); done(true) when the model answered. */
        void event(JSONObject meta, JSONObject ev, Consumer<Boolean> done);
        /** A notice of a fresh message. level: info, success, warning, error. */
        void flash(String text, String level);
        /** Save (open false) or open a file the function returned (or an image tapped). */
        void file(String name, String mime, byte[] data, boolean open);
        /** A link tapped in Markdown. */
        void openLink(String url);
        /** An output that could not be shown: {type: "error", error: {type, message}, output, fromError}. */
        default void report(JSONObject meta, JSONObject ev) { }
        /** Where a sound's or video's bytes are written to be played; null: the app's cache. Called off the main thread. */
        default File mediaFile(byte[] data, String mime) { return null; }
    }

    public static final long FRESH_MS = 30_000;

    private final Theme theme;
    private final Host host;
    private final List<FnMedia> media = new ArrayList<>();
    private final List<FnHtmlView> pages = new ArrayList<>();
    private String key = "";
    private JSONObject meta;
    private int generation;

    public FnView(Context c, Theme theme, Host host) {
        super(c);
        this.theme = theme;
        this.host = host;
        setOrientation(VERTICAL);
    }

    /* ---------------------------------------------------------- memory */

    /** What happened once, per message (the newest 2000). */
    private static final Map<String, Boolean> ONCE = new LinkedHashMap<String, Boolean>(64, 0.75f, true) {
        @Override protected boolean removeEldestEntry(Map.Entry<String, Boolean> e) { return size() > 2000; }
    };

    private static synchronized boolean happened(String k) { return ONCE.containsKey(k); }

    /** Marks k; true the first time. */
    private static synchronized boolean firstTime(String k) { return ONCE.put(k, Boolean.TRUE) == null; }

    /* ------------------------------------------------------------ show */

    /**
     * Shows a message's outputs (replacing what was shown).
     *
     * @param key       the message's id
     * @param outputs   its outputs (flags.fn.outputs)
     * @param meta      its flags.fn — a peer's as Run.meta() checked it: which model and session a click or a form reaches (null: none)
     * @param createdAt when it was made (ms)
     */
    public void show(String key, JSONArray outputs, JSONObject meta, long createdAt) {
        release();
        removeAllViews();
        generation++;
        this.key = key == null ? "" : key;
        this.meta = meta;
        boolean fresh = createdAt > 0 && System.currentTimeMillis() - createdAt < FRESH_MS;
        FlowRow buttons = null;
        for (int i = 0; outputs != null && i < outputs.length(); i++) {
            JSONObject o = outputs.optJSONObject(i);
            if (o == null) continue;
            if (o.optString("type").equals("button")) {
                if (buttons == null) { buttons = new FlowRow(getContext(), theme.dp(6)); addView(buttons, spaced()); }
                View b = safely(i, () -> new Button(o, meta).view);
                if (b != null) buttons.addView(b, new ViewGroup.LayoutParams(o.optString("css").contains("block") ? LayoutParams.MATCH_PARENT : LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT));
                continue;
            }
            buttons = null;
            int index = i;
            View v = safely(i, () -> item(index, o, fresh));
            if (v != null) addView(v, spaced());
        }
    }

    /** Stops sound and video and lets go of HTML pages (the row went away). */
    public void release() {
        for (FnMedia m : media) m.release();
        media.clear();
        for (FnHtmlView p : pages) p.release();
        pages.clear();
    }

    @Override protected void onDetachedFromWindow() {
        super.onDetachedFromWindow();
        for (FnMedia m : media) m.release();
    }

    private LayoutParams spaced() {
        LayoutParams lp = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        if (getChildCount() > 0) lp.topMargin = theme.dp(8);
        return lp;
    }

    private interface Maker { View make() throws Exception; }

    /** An item drawn on its own: a failure becomes a note, reported once. */
    private View safely(int index, Maker m) {
        try { return m.make(); }
        catch (Exception | OutOfMemoryError e) {
            failed(index, e.getClass().getSimpleName(), String.valueOf(e.getMessage()));
            return note(Words.t(theme, "fnui.renderFailed", "message", cut(String.valueOf(e.getMessage()), 120)), "@danger");
        }
    }

    /** Reports an output that could not be shown (once per message and output). */
    private void failed(int index, String type, String message) {
        if (meta == null || meta.optString("chain", "").isEmpty() || !firstTime(key + "#" + index + ":report")) return;
        try {
            JSONObject ev = new JSONObject().put("type", "error")
                .put("error", new JSONObject().put("type", type.isEmpty() ? "RenderError" : type).put("message", cut(message, 1500)))
                .put("output", index).put("fromError", "error".equals(meta.opt("origin")));
            host.report(meta, ev);
        } catch (JSONException e) { throw new IllegalStateException(e); }
    }

    private static String cut(String s, int max) { return s.length() > max ? s.substring(0, max) : s; }

    private View item(int index, JSONObject o, boolean fresh) throws Exception {
        switch (o.optString("type")) {
            case "text": return text(o.optString("text"));
            case "markdown": {
                TextView t = text("");
                Markdown.show(t, o.optString("text"), theme, host::openLink);
                return t;
            }
            case "code": return code(o.optString("text"));
            case "json": return titled(o, code(Js.stringify(o.opt("value"), 2)));
            case "table": return titled(o, table(o));
            case "image": return image(index, o);
            case "file": return file(o);
            case "flash": return flash(index, o, fresh);
            case "audio": case "video": {
                boolean autoplay = Boolean.TRUE.equals(o.opt("autoplay")) && fresh && firstTime(key + "#" + index + ":play");
                FnMedia m = new FnMedia(getContext(), theme, o, autoplay, () -> mediaFile(o), (why) -> failed(index, "MediaError", why));
                media.add(m);
                return m;
            }
            case "form": return form(index, o);
            case "html": {
                // Outputs come here as they were sent (a peer's too): Outputs.check's limits here, the sanitizing in FnHtmlView.
                if (!(o.opt("html") instanceof String) || o.optString("html").length() > FnHtml.MAX) return null;
                String title = o.opt("title") instanceof String ? cut(o.optString("title"), 300) : "";
                return titled(new JSONObject().put("title", title), html(index, o));
            }
            case "js":
                // Hidden browser code is an effect of the web app; nothing to show.
                if (Boolean.TRUE.equals(o.opt("hidden"))) return null;
                return note(Words.t(theme, "fnui.webOnly"), "@muted");
            case "window": return note(Words.t(theme, "fnui.webOnly"), "@muted");
            default: return null;
        }
    }

    /* ---------------------------------------------------------- pieces */

    private TextView text(String s) {
        TextView t = new TextView(getContext());
        t.setText(s);
        t.setTextColor(theme.color("@onSurface"));
        t.setTypeface(theme.typeface(false));
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        return t;
    }

    private TextView note(String s, String token) {
        TextView t = text(s);
        t.setTextColor(theme.color(token));
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        t.setTypeface(theme.typeface(false), Typeface.ITALIC);
        return t;
    }

    private Drawable box(int fill, int stroke) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(fill);
        g.setCornerRadius(theme.dp(8));
        if (stroke != 0) g.setStroke(Math.max(1, theme.dp(1)), stroke);
        return g;
    }

    /** Monospace text that scrolls sideways. */
    private View code(String s) {
        TextView t = text(s);
        t.setTypeface(Typeface.MONOSPACE);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        t.setHorizontallyScrolling(true);
        t.setPadding(theme.dp(10), theme.dp(8), theme.dp(10), theme.dp(8));
        HorizontalScrollView h = new HorizontalScrollView(getContext());
        h.setBackground(box(theme.color("@surfaceVariant"), 0));
        h.addView(t);
        return h;
    }

    /** A JSON value, a table or an HTML page with its title above. */
    private View titled(JSONObject o, View body) {
        String title = o.opt("title") instanceof String ? o.optString("title") : "";
        if (title.isEmpty()) return body;
        LinearLayout col = new LinearLayout(getContext());
        col.setOrientation(VERTICAL);
        TextView t = text(title);
        t.setTypeface(theme.typeface(true));
        col.addView(t);
        LayoutParams lp = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        lp.topMargin = theme.dp(4);
        col.addView(body, lp);
        return col;
    }

    private View table(JSONObject o) {
        TableLayout table = new TableLayout(getContext());
        table.setBackground(box(0, theme.color("@border")));
        JSONArray cols = o.optJSONArray("columns");
        JSONArray rows = o.optJSONArray("rows");
        table.addView(row(cols, true));
        for (int r = 0; rows != null && r < rows.length(); r++) {
            Object x = rows.opt(r);
            JSONArray cells = x instanceof JSONArray ? (JSONArray) x : new JSONArray().put(x);
            table.addView(row(cells, false));
        }
        HorizontalScrollView h = new HorizontalScrollView(getContext());
        h.addView(table);
        return h;
    }

    private TableRow row(JSONArray cells, boolean head) {
        TableRow tr = new TableRow(getContext());
        if (head) tr.setBackgroundColor(theme.color("@surfaceVariant"));
        for (int c = 0; cells != null && c < cells.length(); c++) {
            TextView t = text(head ? Js.str(cells.opt(c)) : Outputs.cellText(cells.opt(c)));
            t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
            if (head) t.setTypeface(theme.typeface(true));
            t.setPadding(theme.dp(10), theme.dp(6), theme.dp(10), theme.dp(6));
            tr.addView(t);
        }
        return tr;
    }

    private View image(int index, JSONObject o) {
        String mime = o.optString("mime");
        String alt = o.opt("alt") instanceof String ? o.optString("alt") : "";
        if (mime.equals("image/svg+xml")) {
            // No SVG renderer here: a placeholder that saves the file.
            TextView t = pill("SVG" + (alt.isEmpty() ? "" : " · " + alt) + " — " + Words.t(theme, "fnui.download"));
            t.setOnClickListener(v -> host.file(fileName(alt, "image.svg"), mime, decode(o.optString("data")), false));
            return t;
        }
        ImageView img = new ImageView(getContext());
        img.setAdjustViewBounds(true);
        img.setMaxHeight(theme.dp(360));
        img.setScaleType(ImageView.ScaleType.FIT_START);
        img.setContentDescription(alt);
        int gen = generation;
        int maxSide = Math.max(getResources().getDisplayMetrics().widthPixels, 1080);
        Api.background(() -> {
            try {
                Bitmap bmp = decodeBitmap(decode(o.optString("data")), maxSide);
                post(() -> {
                    if (gen != generation) return;
                    if (bmp == null) failed(index, "ImageError", "the image could not be shown (" + mime + ")");
                    else img.setImageBitmap(bmp);
                });
            } catch (OutOfMemoryError | IllegalArgumentException e) {
                post(() -> { if (gen == generation) failed(index, "ImageError", "the image could not be shown (" + mime + ")"); });
            }
        });
        img.setOnClickListener(v -> host.file(fileName(alt, "image." + mime.substring(6).replace("jpeg", "jpg")), mime, decode(o.optString("data")), true));
        return img;
    }

    /** A bitmap no larger than maxSide pixels a side (a function may return a huge one). */
    private static Bitmap decodeBitmap(byte[] bytes, int maxSide) {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inSampleSize = 1;
        while (Math.max(bounds.outWidth, bounds.outHeight) / opts.inSampleSize > maxSide) opts.inSampleSize *= 2;
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.length, opts);
    }

    private static String fileName(String alt, String fallback) {
        String n = alt.replaceAll("[^\\p{L}\\p{N} ._-]", "").trim();
        return n.isEmpty() ? fallback : n + fallback.substring(fallback.lastIndexOf('.'));
    }

    static byte[] decode(String b64) { return Base64.getDecoder().decode(b64); }

    private TextView pill(String s) {
        TextView t = text(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        t.setPadding(theme.dp(12), theme.dp(8), theme.dp(12), theme.dp(8));
        t.setBackground(ripple(box(theme.color("@surfaceVariant"), theme.color("@border"))));
        return t;
    }

    private Drawable ripple(Drawable d) { return new RippleDrawable(ColorStateList.valueOf(0x22000000), d, null); }

    /** 📎 name, then Save and Open. */
    private View file(JSONObject o) {
        String name = o.optString("name");
        String mime = o.optString("mime");
        LinearLayout row = new LinearLayout(getContext());
        row.setOrientation(HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(theme.dp(10), theme.dp(6), theme.dp(6), theme.dp(6));
        row.setBackground(box(theme.color("@surfaceVariant"), theme.color("@border")));
        TextView label = text("📎 " + name);
        label.setSingleLine(true);
        label.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);
        row.addView(label, new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1));
        for (boolean open : new boolean[] { false, true }) {
            TextView b = pill(Words.t(theme, open ? "fnui.open" : "fnui.download"));
            b.setTextColor(theme.color("@primary"));
            b.setOnClickListener(v -> host.file(name, mime, decode(o.optString("data")), open));
            LayoutParams lp = new LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT);
            lp.leftMargin = theme.dp(6);
            row.addView(b, lp);
        }
        return row;
    }

    /** Formatted HTML (6.6): sanitized again and shown in a WebView without scripts or network; a long-pressed picture opens like image(). */
    private View html(int index, JSONObject o) {
        FnHtmlView v = new FnHtmlView(getContext(), theme, o.optString("html"), host::openLink,
            (name, mime, data) -> host.file(name, mime, data, true), (why) -> failed(index, "HtmlError", why));
        pages.add(v);
        return v;
    }

    /** A notice in the message; the app shows it too while the message is fresh (once). */
    private View flash(int index, JSONObject o, boolean fresh) {
        String level = o.optString("level", "info");
        if (fresh && firstTime(key + "#" + index + ":flash")) host.flash(o.optString("text"), level);
        int color = theme.color(level.equals("success") ? "@success" : level.equals("warning") ? "@warning" : level.equals("error") ? "@danger" : "@primary");
        TextView t = text(o.optString("text"));
        t.setPadding(theme.dp(12), theme.dp(8), theme.dp(12), theme.dp(8));
        GradientDrawable g = new GradientDrawable();
        g.setColor((color & 0x00FFFFFF) | 0x22000000);
        g.setStroke(Math.max(1, theme.dp(1)), color);
        g.setCornerRadius(theme.dp(8));
        t.setBackground(g);
        return t;
    }

    private View form(int index, JSONObject o) {
        boolean reachable = Commands.answers(meta, "form");
        String used = key + "#" + index + ":used";
        FnForm f = new FnForm(getContext(), theme, host::openLink, o, reachable, Boolean.TRUE.equals(o.opt("once")) && happened(used), (values, done) ->
            host.event(meta, Commands.form(o.optString("name"), values), (ok) -> {
                if (ok && Boolean.TRUE.equals(o.opt("once"))) firstTime(used);
                done.accept(ok);
            }));
        if (!reachable) f.setTooltipText(Words.t(theme, "fnui.noEvent", "what", Words.t(theme, "fnui.what.form")));
        return f;
    }

    /** A sound's or video's bytes as a file to play (the host's, or the app's cache). Off the main thread. */
    private File mediaFile(JSONObject o) throws IOException {
        byte[] bytes = decode(o.optString("data"));
        String mime = o.optString("mime");
        File own = host.mediaFile(bytes, mime);
        if (own != null) return own;
        File dir = new File(getContext().getCacheDir(), "fn-media");
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("no cache directory");
        File f = new File(dir, sha256(bytes) + "." + mime.substring(mime.indexOf('/') + 1).replace("mpeg", "mp3").replace("x-", ""));
        if (!f.exists() || f.length() != bytes.length) try (FileOutputStream out = new FileOutputStream(f)) { out.write(bytes); }
        return f;
    }

    private static String sha256(byte[] b) {
        try {
            StringBuilder sb = new StringBuilder();
            for (byte x : MessageDigest.getInstance("SHA-256").digest(b)) sb.append(String.format("%02x", x));
            return sb.toString();
        } catch (NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }

    /* --------------------------------------------------------- buttons */

    /** A function's button: a tap calls its button entry point; confirm asks first, once locks it after a success. */
    private final class Button {
        final TextView view;
        private final JSONObject o;
        private final JSONObject meta;
        private final String used;
        private final boolean reachable;
        private String state = "idle"; // idle, confirm, busy, done
        private final Runnable unconfirm = () -> { if (state.equals("confirm")) set("idle"); };

        Button(JSONObject o, JSONObject meta) {
            this.o = o;
            this.meta = meta;
            this.used = key + "#" + o.optString("name") + ":" + o.optString("title") + ":used";
            reachable = Commands.answers(meta, "button");
            view = new TextView(getContext());
            view.setGravity(Gravity.CENTER);
            view.setTypeface(theme.typeface(true));
            view.setSingleLine(false);
            String css = " " + o.optString("css") + " ";
            float size = css.contains(" small ") ? 12 : css.contains(" large ") ? 16 : 14;
            view.setTextSize(TypedValue.COMPLEX_UNIT_SP, size);
            int v = theme.dp(css.contains(" small ") ? 4 : css.contains(" large ") ? 10 : 7);
            int h = theme.dp(css.contains(" small ") ? 9 : css.contains(" large ") ? 18 : 14);
            view.setPadding(h, v, h, v);
            if (!reachable) view.setTooltipText(Words.t(theme, "fnui.noEvent", "what", Words.t(theme, "fnui.what.button")));
            view.setOnClickListener(x -> click());
            set(Boolean.TRUE.equals(o.opt("once")) && happened(used) ? "done" : "idle");
        }

        private void click() {
            if (!reachable || state.equals("busy") || state.equals("done") || Boolean.TRUE.equals(o.opt("disabled"))) return;
            String confirm = o.opt("confirm") instanceof String ? o.optString("confirm") : "";
            if (!confirm.isEmpty() && !state.equals("confirm")) {
                set("confirm");
                // The web resets it when the button loses focus; here after a moment.
                view.removeCallbacks(unconfirm);
                view.postDelayed(unconfirm, 4000);
                return;
            }
            view.removeCallbacks(unconfirm);
            set("busy");
            int gen = generation;
            host.event(meta, Commands.button(o.optString("name"), o.opt("data")), (ok) -> {
                if (ok && Boolean.TRUE.equals(o.opt("once"))) firstTime(used);
                if (gen == generation) set(ok && Boolean.TRUE.equals(o.opt("once")) ? "done" : "idle");
            });
        }

        private void set(String s) {
            state = s;
            String icon = o.opt("icon") instanceof String ? o.optString("icon") + " " : "";
            String title = s.equals("confirm") ? (o.optString("confirm").isEmpty() ? Words.t(theme, "fnui.confirm") : o.optString("confirm")) : o.optString("title");
            view.setText(icon + title + (s.equals("busy") ? " …" : ""));
            boolean enabled = reachable && !Boolean.TRUE.equals(o.opt("disabled")) && !s.equals("busy") && !s.equals("done");
            view.setEnabled(enabled);
            view.setAlpha(enabled ? 1f : 0.55f);
            style(s.equals("confirm"));
        }

        /** The web's fn-btn classes in the theme's colours; a style's own colours win. */
        private void style(boolean confirming) {
            String css = " " + o.optString("css") + " ";
            int fill = theme.color("@surfaceVariant"), stroke = theme.color("@border"), ink = theme.color("@onSurface");
            if (css.contains(" primary ")) { fill = stroke = theme.color("@primary"); ink = theme.color("@onPrimary"); }
            else if (css.contains(" success ")) { fill = stroke = theme.color("@success"); ink = Color.WHITE; }
            else if (css.contains(" danger ")) { fill = stroke = theme.color("@danger"); ink = Color.WHITE; }
            else if (css.contains(" warning ")) { fill = stroke = theme.color("@warning"); ink = 0xFF1A1200; }
            else if (css.contains(" info ")) { fill = stroke = INFO; ink = Color.WHITE; }
            else if (css.contains(" ghost ")) { fill = stroke = Color.TRANSPARENT; }
            else if (css.contains(" outline ")) { fill = Color.TRANSPARENT; stroke = ink = theme.color("@primary"); }
            else if (css.contains(" link ")) { fill = stroke = Color.TRANSPARENT; ink = theme.color("@primary"); }
            JSONObject st = o.optJSONObject("style");
            if (st != null) {
                Integer c = CssColor.parse(st.optString("color", null));
                Integer b = CssColor.parse(st.optString("background", null));
                Integer r = CssColor.parse(st.optString("border", null));
                if (c != null) ink = c;
                if (b != null) fill = b;
                if (r != null) stroke = r;
            }
            view.setTextColor(ink);
            view.setPaintFlags(css.contains(" link ") ? view.getPaintFlags() | Paint.UNDERLINE_TEXT_FLAG : view.getPaintFlags() & ~Paint.UNDERLINE_TEXT_FLAG);
            GradientDrawable g = new GradientDrawable();
            g.setColor(fill);
            g.setCornerRadius(css.contains(" round ") ? theme.dp(999) : theme.dp(10));
            g.setStroke(Math.max(1, theme.dp(confirming ? 2 : 1)), confirming ? theme.color("@warning") : stroke);
            view.setBackground(ripple(g));
        }
    }

    /** .fn-btn--info: hsl(199 80% 42%). */
    private static final int INFO = CssColor.parse("hsl(199, 80%, 42%)");
}
