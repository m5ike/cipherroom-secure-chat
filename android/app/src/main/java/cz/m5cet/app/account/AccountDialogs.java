package cz.m5cet.app.account;

import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.PersistableBundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;

import cz.m5cet.app.M5;
import cz.m5cet.app.ui.MainActivity;
import cz.m5cet.app.ui.Ui;

/**
 * What the app says around passkeys (6.2): the answer to a ceremony — a
 * notice, or a choice where the person has one (a passkey the server does
 * not know → create an account; a device-bound account → a recovery code or
 * another passkey) — and the recovery code, shown once. Making a recovery
 * code or adding a passkey is confirmed with one of the account's passkeys
 * first (Account.confirm), as on the web.
 */
public final class AccountDialogs {
    private AccountDialogs() {}

    private static String t(MainActivity a, String key) { return a.app().t(key); }

    /** The activity a ceremony started from was closed meanwhile (recreated): no dialog on it. */
    private static boolean gone(MainActivity a) { return a.isFinishing() || a.isDestroyed(); }

    /** The server's address without the scheme (chat.example.com). */
    private static String host(String server) { return server == null ? "" : server.replaceFirst("(?i)^https?://", ""); }

    /** After a sign-in (or sign-up) ended. */
    public static void after(MainActivity a, boolean signUp, Account.Result r) {
        if (gone(a)) return;
        a.refresh();
        if (r.ok) {
            if (signUp && r.deviceBound) { deviceBound(a, r.username); return; }
            a.flash("", t(a, "set.user.viaPasskey") + " · " + r.username, "success");
            return;
        }
        String server = host(a.app().config.server());
        switch (r.code) {
            case "cancelled": a.flash("", t(a, "passkey.cancelled"), "info"); break;
            case "unknown-passkey": {
                // Most likely left over from a sign-up the server never finished (before 6.2: no PRF when creating).
                String name = r.username.isEmpty() ? "M5cet" : "M5cet · " + r.username;
                offerAccount(a, t(a, "passkey.unknownTitle"), t(a, "passkey.unknownText").replace("{server}", server) + "\n\n" + t(a, "passkey.unknownHint").replace("{name}", name));
                break;
            }
            case "no-passkey": offerAccount(a, t(a, "passkey.noneTitle"), t(a, "passkey.noneText").replace("{server}", server)); break;
            case "unsupported": notice(a, t(a, "passkey.problem"), t(a, "passkey.unsupported")); break;
            case "no-prf": case "wrong-key": case "orphan": notice(a, t(a, "passkey.problem"), r.message); break;
            default: a.flash("", r.message.isEmpty() ? t(a, "voice.failed") : r.message, "error");
        }
    }

    private static void offerAccount(MainActivity a, String title, String text) {
        new AlertDialog.Builder(a).setTitle(title).setMessage(text)
            .setPositiveButton(t(a, "passkey.createAccount"), (d, w) -> a.accountSignIn(true))
            .setNegativeButton(t(a, "passkey.cancel"), null)
            .show();
    }

    private static void notice(MainActivity a, String title, String text) {
        new AlertDialog.Builder(a).setTitle(title).setMessage(text).setPositiveButton("OK", null).show();
    }

    /** A new account whose root lives only on this phone: say so, and offer the ways to reach it elsewhere. */
    private static void deviceBound(MainActivity a, String user) {
        new AlertDialog.Builder(a).setTitle(t(a, "passkey.boundTitle")).setMessage(t(a, "passkey.boundText").replace("{user}", user))
            .setPositiveButton(t(a, "set.user.recoveryCreate"), (d, w) -> createCode(a))
            .setNeutralButton(t(a, "set.user.addPasskey"), (d, w) -> addPasskey(a))
            .setNegativeButton(t(a, "passkey.later"), null)
            .show();
    }

    /* ------------------------------------------------ recovery, passkeys */

    /** Settings › User: create the recovery code (asks first when it replaces one). */
    public static void recoveryCode(MainActivity a) {
        M5 app = a.app();
        if (!app.account.hasRoot()) { a.flash("", t(a, "passkey.noRoot"), "warn"); return; }
        if (app.account.summary().optJSONObject("recovery") != null && app.account.summary().optJSONObject("recovery").optBoolean("set")) {
            new AlertDialog.Builder(a).setTitle(t(a, "set.user.recoveryReplace")).setMessage(t(a, "passkey.recoveryReplaceAsk"))
                .setPositiveButton(t(a, "set.user.recoveryReplace"), (d, w) -> createCode(a))
                .setNegativeButton(t(a, "passkey.cancel"), null)
                .show();
            return;
        }
        createCode(a);
    }

    private static void createCode(MainActivity a) {
        a.app().account.createRecoveryCode(a, (code, failure) -> {
            if (gone(a)) return;
            a.refresh();
            if (code != null) { showCode(a, code); return; }
            if (failure != null && failure.code.equals("cancelled")) a.flash("", t(a, "passkey.cancelled"), "info");
            else a.flash("", failure == null || failure.message.isEmpty() ? t(a, "voice.failed") : failure.message, "error");
        });
    }

    /** The code, once: large, monospaced; copying marks it sensitive; no screenshot where the app forbids them. */
    private static void showCode(MainActivity a, String code) {
        LinearLayout box = new LinearLayout(a);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(Ui.dp(a, 24), Ui.dp(a, 8), Ui.dp(a, 24), 0);
        TextView value = new TextView(a);
        value.setText(code);
        value.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        value.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        value.setGravity(Gravity.CENTER);
        value.setTextColor(Ui.color(a, "@onSurface", Color.BLACK));
        value.setPadding(Ui.dp(a, 12), Ui.dp(a, 14), Ui.dp(a, 12), Ui.dp(a, 14));
        value.setBackground(Ui.shape(Ui.color(a, "@surfaceVariant", Color.LTGRAY), Ui.dp(a, 12), 0, 0));
        box.addView(value);
        TextView hint = new TextView(a);
        hint.setText(t(a, "passkey.recoveryShow"));
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        hint.setTextColor(Ui.color(a, "@muted", Color.GRAY));
        LinearLayout.LayoutParams hl = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        hl.topMargin = Ui.dp(a, 14);
        box.addView(hint, hl);
        AlertDialog dialog = new AlertDialog.Builder(a).setTitle(t(a, "passkey.recoveryTitle")).setView(box).setCancelable(false)
            .setPositiveButton(t(a, "passkey.recoveryDone"), null)
            .setNeutralButton(t(a, "passkey.recoveryCopy"), null)
            .create();
        if ((a.getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_SECURE) != 0 && dialog.getWindow() != null) dialog.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        dialog.setOnShowListener(d -> dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(v -> {
            // The dialog stays: copying is not writing it down.
            ClipboardManager cm = a.getSystemService(ClipboardManager.class);
            if (cm == null) return;
            ClipData clip = ClipData.newPlainText("M5cet", code);
            PersistableBundle extras = new PersistableBundle();
            extras.putBoolean("android.content.extra.IS_SENSITIVE", true);
            clip.getDescription().setExtras(extras);
            cm.setPrimaryClip(clip);
            ((TextView) v).setText("✓ " + t(a, "passkey.recoveryCopy"));
        }));
        dialog.show();
    }

    /** Settings › User (or after a device-bound sign-up): add a passkey with PRF, the root sealed for it. */
    public static void addPasskey(MainActivity a) {
        M5 app = a.app();
        if (!app.account.hasRoot()) { a.flash("", t(a, "passkey.noRoot"), "warn"); return; }
        app.account.addPasskey(a, r -> {
            if (gone(a)) return;
            a.refresh();
            if (r.ok) a.flash("", t(a, "passkey.added"), "success");
            else if (r.code.equals("cancelled")) a.flash("", t(a, "passkey.cancelled"), "info");
            else if (r.code.equals("exists")) a.flash("", t(a, "passkey.exists"), "warn");
            else if (r.code.equals("orphan") || r.code.equals("unsupported")) notice(a, t(a, "passkey.problem"), r.code.equals("orphan") ? r.message : t(a, "passkey.unsupported"));
            else a.flash("", r.message.isEmpty() ? t(a, "voice.failed") : r.message, "error");
        });
    }
}
