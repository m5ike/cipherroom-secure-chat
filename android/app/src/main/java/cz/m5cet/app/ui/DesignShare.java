package cz.m5cet.app.ui;

import android.app.AlertDialog;
import android.util.TypedValue;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * 6.12 (security analysis G-20, the rest of the class of F-01): the design's
 * "copy" and "share" with a text it computed — from $msg, $log, $form, the
 * room… — go through the person: a native dialog shows exactly that text
 * first (hidden characters made visible, nothing cut short) and only "Copy" /
 * "Share" there passes it on. A text the design wrote itself (a literal, a
 * translation) goes at once, as before. A computed text too long to read in
 * the dialog is refused, not shortened (like url.open, ui/DesignUrls).
 *
 * shown() and fits() are pure (DesignShareTest).
 */
public final class DesignShare {
    private DesignShare() {}

    /** Longer than this cannot be read in a dialog — refused, not cut. */
    static final int MAX = 2000;

    /**
     * The text as the dialog shows it: every invisible formatting or control
     * character (bidi overrides, zero-width…, but not a line break or a tab)
     * as [U+XXXX], so what will be copied is what the person reads.
     */
    static String shown(String text) {
        if (text == null) return "";
        StringBuilder sb = new StringBuilder(text.length());
        for (int i = 0; i < text.length(); ) {
            int c = text.codePointAt(i);
            i += Character.charCount(c);
            int t = Character.getType(c);
            boolean hidden = (t == Character.FORMAT || t == Character.CONTROL || t == Character.UNASSIGNED || t == Character.PRIVATE_USE || t == Character.SURROGATE)
                && c != '\n' && c != '\t';
            if (hidden) sb.append(String.format(java.util.Locale.ROOT, "[U+%04X]", c));
            else sb.appendCodePoint(c);
        }
        return sb.toString();
    }

    /** Whether a computed text may be offered: at most MAX characters (code points). */
    static boolean fits(String text) {
        return text != null && text.codePointCount(0, text.length()) <= MAX;
    }

    /** "copy" / "share" of the design; computed: its argument read data (ActionGuard.computed). */
    static void run(MainActivity a, String action, String text, boolean computed) {
        boolean share = "share".equals(action);
        if (!computed) { pass(a, share, text); return; }
        if (text == null || text.isEmpty()) return;
        if (!fits(text)) {
            cz.m5cet.app.core.Log.w("action", action + " refused: a computed text too long to show");
            a.flash("", a.app().t("security.shareTooLong"), "warn");
            return;
        }
        TextView body = new TextView(a);
        body.setText(shown(text));
        body.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        body.setTextIsSelectable(false);
        int pad = Ui.dp(a, 22);
        body.setPadding(pad, Ui.dp(a, 8), pad, Ui.dp(a, 8));
        ScrollView scroll = new ScrollView(a);
        scroll.addView(body);
        AlertDialog d = new AlertDialog.Builder(a)
            .setTitle(a.app().t(share ? "security.shareAsk" : "security.copyAsk"))
            .setView(scroll)
            .setPositiveButton(a.app().t(share ? "security.shareGo" : "msg.copy"), (x, w) -> pass(a, share, text))
            .setNegativeButton(a.app().t("nav.close"), null)
            .create();
        // The text may be a message: the dialog keeps the app's screenshot protection.
        if ((a.getWindow().getAttributes().flags & android.view.WindowManager.LayoutParams.FLAG_SECURE) != 0 && d.getWindow() != null)
            d.getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE);
        d.show();
    }

    private static void pass(MainActivity a, boolean share, String text) {
        if (share) a.share(text);
        else { a.copy(text); a.flash("", "✓", "success"); }
    }
}
