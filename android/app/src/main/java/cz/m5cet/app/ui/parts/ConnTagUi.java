package cz.m5cet.app.ui.parts;

import android.app.AlertDialog;
import android.graphics.Color;
import android.graphics.Typeface;
import android.util.TypedValue;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

import java.util.function.Consumer;

import cz.m5cet.app.M5;
import cz.m5cet.app.chat.P4Texts;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.nfc.ConnTag;
import cz.m5cet.app.ui.MainActivity;
import cz.m5cet.app.ui.Ui;

/**
 * 6.12 (protocol 4 § 16, F-12): connection tags in format 2, the app's side —
 * the writer chooses an invitation (recommended) or an offline tag, the body
 * is prepared in the background (the invitation on the server, the offline
 * tag's Argon2id), an offline tag's code is shown ONCE; the reader sees the
 * room to join, what is missing (the code, or a format-1 PIN), why not, and a
 * format-1 tag marked weak with the offer to rewrite it as format 2. Native
 * views, used by the NFC panel and the workbench.
 */
final class ConnTagUi {
    private ConnTagUi() {}

    static String t(MainActivity a, String key) { return P4Texts.t(a.app(), key); }

    /** Invitation or offline, then the prepared body to `then` (on the main thread). `card`: {room, passphrase, name}. */
    static void prepare(MainActivity a, JSONObject card, Consumer<String> then) {
        String[] labels = {t(a, "nfc.v2.kind.inv"), t(a, "nfc.v2.kind.off")};
        new AlertDialog.Builder(a).setTitle(t(a, "nfc.v2.kind.title")).setItems(labels, (d, which) -> {
            String kind = which == 0 ? "inv" : "off";
            a.flash("", t(a, "nfc.v2.preparing"), "info");
            M5 app = a.app();
            Io.bg(() -> {
                try {
                    ConnTag.Prepared p = ConnTag.prepare(card, kind, app.config.server(), cz.m5cet.app.BuildConfig.VERSION_NAME);
                    Io.main(() -> {
                        if (p.code != null) showCode(a, p.code, () -> then.accept(p.body));
                        else then.accept(p.body);
                    });
                } catch (Exception e) {
                    Log.w("nfc", "tag not prepared: " + e.getMessage());
                    Io.main(() -> a.flash("", "⚠ " + (e.getMessage() == null ? "error" : e.getMessage()), "warn"));
                }
            });
        }).show();
    }

    /** An offline tag's code, shown once (it is on no tag and stored nowhere). */
    static void showCode(MainActivity a, String code, Runnable after) {
        LinearLayout box = new LinearLayout(a);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(Ui.dp(a, 24), Ui.dp(a, 8), Ui.dp(a, 24), 0);
        TextView number = new TextView(a);
        number.setText(code);
        number.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        number.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        number.setTextIsSelectable(true);
        box.addView(number);
        TextView hint = new TextView(a);
        hint.setText(t(a, "nfc.v2.code.text"));
        hint.setPadding(0, Ui.dp(a, 12), 0, 0);
        box.addView(hint);
        SecureDialog.show(a, new AlertDialog.Builder(a).setTitle(t(a, "nfc.v2.code.title")).setView(box).setCancelable(false)
            .setPositiveButton(t(a, "nfc.v2.code.done"), (d, w) -> after.run()));
    }

    /** Words for a reading's error code ("" for none). */
    static String error(MainActivity a, ConnTag.Read r) {
        if (r.error.isEmpty()) return "";
        if (r.error.equals("wrong-pin")) return a.app().t("nfc.wrongPin");
        return t(a, "nfc.v2.err." + r.error).replace("{origin}", r.origin);
    }

    /**
     * What a read tag says, as a card: the room with Join (and, for a format-1
     * tag, the weak warning and "rewrite as a new tag"); else what is missing
     * with Open (`open` runs with what is typed now) or why not.
     */
    static LinearLayout result(MainActivity a, JSONObject conn, Runnable open, Consumer<JSONObject> rewrite) {
        ConnTag.Read r = parse(conn);
        int fg = Ui.color(a, "@onSurface", Color.BLACK), muted = Ui.color(a, "@muted", Color.GRAY), danger = Ui.color(a, "@danger", Color.RED);
        LinearLayout card = new LinearLayout(a);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(Ui.dp(a, 14), Ui.dp(a, 12), Ui.dp(a, 14), Ui.dp(a, 12));
        card.setBackground(Ui.shape(Ui.color(a, "@surface", Color.WHITE), Ui.dp(a, 16), Ui.dp(a, 1), Ui.color(a, "@border", Color.LTGRAY)));
        String kind = r.format.equals("v2-inv") ? t(a, "nfc.v2.invite") : r.format.equals("v2-off") ? t(a, "nfc.v2.offline") : r.format.equals("v1") ? t(a, "nfc.v2.old") : a.app().t("nfc.card");
        card.addView(ToolPanels.label(a, kind, 12, muted, false));
        if (r.weak) {
            TextView w = ToolPanels.label(a, "⚠ " + t(a, "nfc.v2.weak"), 13, danger, false);
            w.setPadding(0, Ui.dp(a, 4), 0, Ui.dp(a, 4));
            card.addView(w);
        }
        if (r.room != null) {
            card.addView(ToolPanels.label(a, r.room.room, 18, fg, true));
            LinearLayout row = new LinearLayout(a);
            row.setOrientation(LinearLayout.HORIZONTAL);
            TextView join = ToolPanels.button(a, a.app().t("nfc.join"), "log-in", true);
            // A format-2 tag suggests no name (the reader keeps its own); a format-1 card may carry one.
            String name = r.format.equals("v1") ? r.room.name : "";
            join.setOnClickListener(v -> a.finishJoin(r.room.room, r.room.passphrase, name == null ? "" : name));
            row.addView(join);
            if (r.weak && rewrite != null) {
                TextView again = ToolPanels.button(a, t(a, "nfc.v2.rewrite"), "pencil", false);
                JSONObject roomCard = new JSONObject();
                try { roomCard.put("room", r.room.room).put("passphrase", r.room.passphrase).put("name", ""); } catch (org.json.JSONException ignored) { }
                again.setOnClickListener(v -> rewrite.accept(roomCard));
                LinearLayout.LayoutParams gl = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                gl.setMarginStart(Ui.dp(a, 10));
                row.addView(again, gl);
            }
            LinearLayout.LayoutParams rl = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            rl.topMargin = Ui.dp(a, 8);
            card.addView(row, rl);
            return card;
        }
        String why = error(a, r);
        if (!why.isEmpty()) card.addView(ToolPanels.label(a, "⚠ " + why, 14, danger, false));
        if (!r.need.isEmpty() && open != null) {
            card.addView(ToolPanels.label(a, t(a, r.need.equals("code") ? "nfc.v2.needCode" : r.need.equals("pin") ? "nfc.v2.needPin" : "nfc.v2.needRedeem"), 14, fg, false));
            TextView go = ToolPanels.button(a, t(a, "nfc.v2.open"), "lock-open", true);
            go.setOnClickListener(v -> open.run());
            LinearLayout.LayoutParams ol = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            ol.topMargin = Ui.dp(a, 8);
            card.addView(go, ol);
        }
        return card;
    }

    static ConnTag.Read parse(JSONObject conn) {
        ConnTag.Read r = new ConnTag.Read();
        if (conn == null) return r;
        r.format = conn.optString("format");
        r.weak = conn.optBoolean("weak");
        r.need = conn.optString("need");
        r.error = conn.optString("error");
        r.origin = conn.optString("origin");
        JSONObject room = conn.optJSONObject("room");
        if (room != null) r.room = new cz.m5cet.app.nfc.TagV2.Room(room.optString("room"), room.optString("passphrase"), room.optString("name"), "");
        return r;
    }
}
