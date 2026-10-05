package cz.m5cet.app.ui.parts;

import android.app.AlertDialog;
import android.app.Dialog;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.text.DateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Date;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import cz.m5cet.app.M5;
import cz.m5cet.app.chat.ChatMessage;
import cz.m5cet.app.chat.RoomSession;
import cz.m5cet.app.chat.Rooms;
import cz.m5cet.app.ui.Icons;
import cz.m5cet.app.ui.MainActivity;
import cz.m5cet.app.ui.Ui;
import cz.m5cet.app.ui.bubble.Hides;
import cz.m5cet.app.ui.bubble.Kinds;

/**
 * Everything this device knows of a message (6.2), behind the (i) of its
 * bubble: when and from whom, to whom, how large, what kind, every state
 * with its time (the timeline, the web's vocabulary) and each recipient's
 * receipts; the attachment's actions; hiding it for a while and deleting it
 * from this device — both logged for the operator's audit, never the text.
 *
 * A dialog from the bottom (back closes it); it follows the message while
 * open (a receipt arriving shows at once).
 */
final class MsgDetails implements Rooms.Listener {
    /** States with a recipient's name in meta: the "Recipients" part groups them. */
    private static final String[] PER_RECIPIENT = {"stored", "forwarded", "delivered", "read"};

    private final MainActivity a;
    private final Parts parts;
    private final RoomSession room;
    private final ChatMessage m;
    private final Dialog dialog;
    private final LinearLayout content;
    private final int fg, muted, primary, danger;

    static void show(MainActivity a, Parts parts, RoomSession room, ChatMessage m) { new MsgDetails(a, parts, room, m).dialog.show(); }

    private MsgDetails(MainActivity a, Parts parts, RoomSession room, ChatMessage m) {
        this.a = a;
        this.parts = parts;
        this.room = room;
        this.m = m;
        fg = Ui.color(a, "@onSurface", Color.BLACK);
        muted = Ui.color(a, "@muted", Color.GRAY);
        primary = Ui.color(a, "@primary", Color.BLUE);
        danger = Ui.color(a, "@danger", Color.RED);
        dialog = new Dialog(a);
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        content = new LinearLayout(a);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(20), dp(12), dp(20), dp(20));
        ScrollView scroll = new ScrollView(a) {
            @Override protected void onMeasure(int ws, int hs) {
                int max = (int) (a.getResources().getDisplayMetrics().heightPixels * 0.86f);
                super.onMeasure(ws, MeasureSpec.makeMeasureSpec(max, MeasureSpec.AT_MOST));
            }
        };
        scroll.setBackground(Ui.shape(Ui.color(a, "@surface", Color.WHITE), dp(24), 0, 0));
        scroll.addView(content);
        dialog.setContentView(scroll);
        Window w = dialog.getWindow();
        if (w != null) {
            w.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            w.setGravity(Gravity.BOTTOM);
            // The dialog is a window of its own: it keeps screenshots out like the app's.
            if ((a.getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_SECURE) != 0) w.addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        }
        dialog.setOnShowListener(d -> app().rooms.addListener(this));
        dialog.setOnDismissListener(d -> app().rooms.removeListener(this));
        fill();
    }

    private M5 app() { return a.app(); }
    private int dp(float v) { return Ui.dp(a, v); }
    private String t(String key) { return app().t(key); }

    /** A word for a key when the design has one (6.12: or the app's English one), else the raw value (a name, an unknown state). */
    private String word(String prefix, String value) {
        String k = prefix + value, s = cz.m5cet.app.chat.P4Texts.t(app(), k);
        return s.equals(k) ? value : s;
    }

    @Override public void onRoomsChanged() { }
    @Override public void onRoomMessage(String roomKey, ChatMessage message) { }
    @Override public void onRoomMessageChanged(String roomKey, ChatMessage message) {
        if (message != m || !dialog.isShowing()) return;
        if (m.deleted) { dialog.dismiss(); return; }
        fill();
    }

    /* -------------------------------------------------------------- view */

    private void fill() {
        content.removeAllViews();
        header();
        DateFormat full = DateFormat.getDateTimeInstance(DateFormat.LONG, DateFormat.MEDIUM, app().locale()); // 6.13: in the app's language
        row(t("msginfo.when"), full.format(new Date(m.createdAt)));
        // 6.12 (F-22): the name as shown everywhere; an operator's notice names the operator, not its frame's "from".
        String sender = m.id != null && m.id.startsWith(cz.m5cet.app.core.Names.NOTICE_ID) && "sys".equals(m.kind)
            ? cz.m5cet.app.core.Names.operator(m.senderName, t("notice.operator")) : cz.m5cet.app.core.Names.normalize(m.senderName);
        row(t("msginfo.sender"), m.mine ? t("users.me") + " (" + sender + ")" : sender);
        row(t("msginfo.recipients"), !m.to.isEmpty() ? String.join(", ", m.to) : t("msginfo.everyone") + " · " + room.label);
        row(t("msginfo.size"), size());
        row(t("msginfo.verified"), m.verified ? "✓" : m.changed ? "⚠ " + t("msginfo.changed") : "—");
        if (m.expiresAt > 0) row(t("msginfo.expires"), full.format(new Date(m.expiresAt)));
        if (m.hiddenUntil != 0 && Hides.hidden(m, System.currentTimeMillis()))
            row(t("msginfo.hidden"), m.hiddenUntil == ChatMessage.UNTIL_SIGNIN ? t("msginfo.hide.until-signin") : full.format(new Date(m.hiddenUntil)));
        kinds();
        timeline();
        receipts();
        attachment();
        actions();
    }

    private void header() {
        LinearLayout bar = new LinearLayout(a);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = new TextView(a);
        title.setText(t("msg.info"));
        title.setTextColor(fg);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 19);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        bar.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        ImageView close = new ImageView(a);
        close.setImageDrawable(Icons.drawable(a, "x", dp(22), fg));
        close.setScaleType(ImageView.ScaleType.CENTER);
        close.setBackground(Ui.ripple(null, Ui.alpha(fg, 0.16f)));
        close.setContentDescription(t("nav.close"));
        close.setOnClickListener(v -> dialog.dismiss());
        bar.addView(close, new LinearLayout.LayoutParams(dp(44), dp(44)));
        content.addView(bar);
    }

    private void section(String title) {
        TextView s = new TextView(a);
        s.setText(title);
        s.setTextColor(primary);
        s.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        s.setTypeface(Typeface.DEFAULT_BOLD);
        s.setPadding(0, dp(16), 0, dp(4));
        content.addView(s);
    }

    private void row(String label, String value) { content.addView(line(label, value, null)); }

    /** A line: the label (muted, fixed width), the value, and an optional detail under it. */
    private View line(String label, String value, String detail) {
        LinearLayout r = new LinearLayout(a);
        r.setPadding(0, dp(3), 0, dp(3));
        TextView l = new TextView(a);
        l.setText(label);
        l.setTextColor(muted);
        l.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f);
        r.addView(l, new LinearLayout.LayoutParams(dp(118), ViewGroup.LayoutParams.WRAP_CONTENT));
        LinearLayout col = new LinearLayout(a);
        col.setOrientation(LinearLayout.VERTICAL);
        TextView v = new TextView(a);
        v.setText(value);
        v.setTextColor(fg);
        v.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        v.setTextIsSelectable(true);
        col.addView(v);
        if (detail != null && !detail.isEmpty()) {
            TextView d = new TextView(a);
            d.setText(detail);
            d.setTextColor(muted);
            d.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
            col.addView(d);
        }
        r.addView(col, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        return r;
    }

    private String size() {
        List<String> parts = new ArrayList<>();
        String text = m.sealed != null && m.sealPlain == null ? m.text : m.visibleText();
        if (!text.isEmpty()) parts.add(t("msginfo.sizeText") + " " + Ui.size(text.getBytes(java.nio.charset.StandardCharsets.UTF_8).length));
        if (m.fileName != null) parts.add(t("msginfo.sizeFile") + " " + Ui.size(m.fileSize));
        return parts.isEmpty() ? "—" : String.join(" · ", parts);
    }

    /* ------------------------------------------------------------- kinds */

    private void kinds() {
        List<String> ks = Kinds.of(m);
        if (ks.isEmpty()) return;
        section(t("msginfo.kinds"));
        LinearLayout chips = new LinearLayout(a);
        for (String k : ks) {
            String label = word("msginfo.kind.", k);
            if (k.equals("vanish")) label += " · " + m.vanishSeconds + " s";
            else if (k.equals("private")) label += " · " + String.join(", ", m.to);
            else if (k.equals("forwarded")) label += " · " + m.forwardedFrom + (room.forwardVerified(m) ? " ✓" : ""); // 6.12 P09: by key
            else if (k.equals("reply") && m.replyToSender != null && !m.replyToSender.isEmpty()) label += " · " + m.replyToSender;
            else if (k.equals("fn") && m.fnDraw() != null && !m.fnDraw().optString("keyword").isEmpty()) label += " · /" + m.fnDraw().optString("keyword");
            TextView c = new TextView(a);
            c.setText(label);
            c.setTextColor(fg);
            c.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
            c.setPadding(dp(10), dp(4), dp(10), dp(4));
            c.setBackground(Ui.shape(Ui.alpha(primary, 0.12f), dp(999), 0, 0));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.setMarginEnd(dp(6));
            chips.addView(c, lp);
        }
        HorizontalScrollView sc = new HorizontalScrollView(a);
        sc.setHorizontalScrollBarEnabled(false);
        sc.addView(chips);
        content.addView(sc);
    }

    /* ---------------------------------------------------------- timeline */

    private String when(long at) {
        Calendar c1 = Calendar.getInstance(), c2 = Calendar.getInstance();
        c1.setTimeInMillis(at);
        c2.setTimeInMillis(m.createdAt);
        boolean sameDay = c1.get(Calendar.YEAR) == c2.get(Calendar.YEAR) && c1.get(Calendar.DAY_OF_YEAR) == c2.get(Calendar.DAY_OF_YEAR);
        return (sameDay ? DateFormat.getTimeInstance(DateFormat.MEDIUM, app().locale()) : DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.MEDIUM, app().locale())).format(new Date(at));
    }

    private static String icon(String state) {
        switch (state) {
            case "created": return "pencil-line";
            case "encrypted": return "lock";
            case "decrypted": return "lock-open";
            case "sent": return "send-horizontal";
            case "queued": return "clock";
            case "stored": return "server";
            case "forwarded": return "forward";
            case "received": return "download";
            case "delivered": return "check";
            case "read": return "check-check";
            case "displayed": return "eye";
            case "revealed": return "hand";
            case "opened": return "key-round";
            case "expired": return "timer";
            case "hidden": return "eye-off";
            case "unhidden": return "eye";
            case "discarded": return "trash";
            case "relay-p4": return "shield-check"; // 6.12 § 7.4: away members — sealed for their devices
            case "relay-room": return "key-round"; // … or under the room key
            default: return "circle-dot";
        }
    }

    private void timeline() {
        List<ChatMessage.Step> steps = m.timeline();
        if (!m.has("created")) steps.add(0, new ChatMessage.Step("created", m.createdAt, "")); // a message from before 6.2
        section(t("msginfo.audit"));
        for (ChatMessage.Step st : steps) {
            LinearLayout r = new LinearLayout(a);
            r.setGravity(Gravity.CENTER_VERTICAL);
            r.setPadding(0, dp(4), 0, dp(4));
            ImageView ic = new ImageView(a);
            ic.setImageDrawable(Icons.drawable(a, icon(st.state), dp(16), primary));
            r.addView(ic, new LinearLayout.LayoutParams(dp(24), dp(20)));
            TextView label = new TextView(a);
            String meta = st.meta.isEmpty() ? "" : " · " + word("msginfo.meta.", st.meta);
            label.setText(word("msginfo.state.", st.state) + meta);
            label.setTextColor(fg);
            label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
            label.setPadding(dp(8), 0, dp(8), 0);
            r.addView(label, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            TextView time = new TextView(a);
            time.setText(when(st.at));
            time.setTextColor(muted);
            time.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
            r.addView(time);
            content.addView(r);
        }
    }

    /** Per recipient: the relay's and the receipts' states with their times (older messages: the state alone). */
    private void receipts() {
        if (!m.mine) return;
        Map<String, List<ChatMessage.Step>> by = new LinkedHashMap<>();
        for (ChatMessage.Step st : m.timeline()) {
            if (st.meta.isEmpty() || !perRecipient(st.state)) continue;
            by.computeIfAbsent(st.meta, k -> new ArrayList<>()).add(st);
        }
        Map<String, String> plain = new LinkedHashMap<>();
        for (Iterator<String> it = m.receipts.keys(); it.hasNext(); ) {
            String k = it.next();
            String name = room.peerName(k);
            if (name == null) name = k;
            if (!by.containsKey(name)) plain.put(name, m.receipts.optString(k));
        }
        if (by.isEmpty() && plain.isEmpty()) return;
        section(t("msginfo.receipts"));
        for (Map.Entry<String, List<ChatMessage.Step>> e : by.entrySet()) {
            List<String> states = new ArrayList<>();
            for (ChatMessage.Step st : e.getValue()) states.add(word("msginfo.state.", st.state) + " " + when(st.at));
            content.addView(line(word("msginfo.meta.", e.getKey()), String.join(" · ", states), null));
        }
        for (Map.Entry<String, String> e : plain.entrySet()) content.addView(line(e.getKey(), word("msginfo.state.", e.getValue()), null));
    }

    private static boolean perRecipient(String state) {
        for (String s : PER_RECIPIENT) if (s.equals(state)) return true;
        return false;
    }

    /* -------------------------------------------------------- attachment */

    private void attachment() {
        if (m.fileName == null) return;
        section(t("msginfo.attachment"));
        content.addView(line(m.fileName, Ui.size(m.fileSize) + (m.fileMime == null || m.fileMime.isEmpty() ? "" : " · " + m.fileMime), null));
        boolean ready = m.fileDataUrl != null || (m.filePath != null && m.fileProgress < 0 && m.fileProgress > -2);
        if (!ready) return;
        LinearLayout acts = new LinearLayout(a);
        acts.setPadding(0, dp(6), 0, 0);
        acts.addView(button("external-link", t("file.open"), primary, () -> parts.openFile(m)));
        acts.addView(button("download", t("file.save"), primary, () -> parts.saveFile(m)));
        acts.addView(button("share-2", t("file.share"), primary, () -> parts.shareFile(m)));
        acts.addView(button("forward", t("msg.forward"), primary, () -> parts.forward(m)));
        HorizontalScrollView sc = new HorizontalScrollView(a);
        sc.setHorizontalScrollBarEnabled(false);
        sc.addView(acts);
        content.addView(sc);
    }

    /* ----------------------------------------------------- hide, delete */

    private void actions() {
        if ("sys".equals(m.kind)) return;
        boolean hidden = m.hiddenUntil != 0 && Hides.hidden(m, System.currentTimeMillis());
        section(t("msginfo.hideTitle"));
        if (hidden) {
            content.addView(button("eye", t("msginfo.unhide"), primary, () -> { Hides.unhide(app(), room, m); dialog.dismiss(); }));
        } else {
            LinearLayout chips = new LinearLayout(a);
            for (int i = 0; i < Hides.FOR.length; i++) {
                int choice = i;
                chips.addView(button(i == Hides.FOR.length - 1 ? "log-in" : "eye-off", t("msginfo.hide." + Hides.NAMES[i]), primary, () -> {
                    Hides.hide(app(), room, m, choice);
                    a.flash("", t("msginfo.hiddenFlash"), "info");
                    dialog.dismiss();
                }));
            }
            HorizontalScrollView sc = new HorizontalScrollView(a);
            sc.setHorizontalScrollBarEnabled(false);
            sc.addView(chips);
            content.addView(sc);
        }
        LinearLayout del = new LinearLayout(a);
        del.setPadding(0, dp(12), 0, 0);
        del.addView(button("trash", t("msginfo.delete"), danger, this::askDelete));
        content.addView(del);
        TextView note = new TextView(a);
        note.setText(t("msginfo.auditNote"));
        note.setTextColor(muted);
        note.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        note.setPadding(0, dp(10), 0, 0);
        content.addView(note);
    }

    private void askDelete() {
        AlertDialog ask = new AlertDialog.Builder(a).setTitle(t("msginfo.delete")).setMessage(t("msginfo.deleteAsk"))
            .setPositiveButton(t("msginfo.deleteYes"), (d, w) -> {
                Hides.delete(app(), room, m);
                parts.forget(m);
                a.flash("", t("msginfo.deleted"), "success");
                dialog.dismiss();
            })
            .setNegativeButton(t("msginfo.cancel"), null).create();
        if ((a.getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_SECURE) != 0 && ask.getWindow() != null) ask.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        ask.show();
    }

    /** A tonal pill with an icon (the actions of the details). */
    private View button(String icon, String label, int color, Runnable click) {
        LinearLayout b = new LinearLayout(a);
        b.setGravity(Gravity.CENTER_VERTICAL);
        b.setPadding(dp(12), dp(8), dp(14), dp(8));
        b.setBackground(Ui.ripple(Ui.shape(Ui.alpha(color, 0.13f), dp(999), 0, 0), Ui.alpha(color, 0.25f)));
        ImageView ic = new ImageView(a);
        ic.setImageDrawable(Icons.drawable(a, icon, dp(16), color));
        b.addView(ic);
        TextView t = new TextView(a);
        t.setText(label);
        t.setTextColor(color);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setPadding(dp(6), 0, 0, 0);
        b.addView(t);
        b.setOnClickListener(v -> click.run());
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMarginEnd(dp(8));
        lp.topMargin = dp(4);
        b.setLayoutParams(lp);
        return b;
    }
}
