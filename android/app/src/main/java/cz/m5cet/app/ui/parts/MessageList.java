package cz.m5cet.app.ui.parts;

import android.graphics.Bitmap;
import android.graphics.Color;
import android.util.TypedValue;
import android.view.GestureDetector;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.TextView;

import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import cz.m5cet.app.chat.ChatMessage;
import cz.m5cet.app.chat.RoomSession;
import cz.m5cet.app.ui.Expr;
import cz.m5cet.app.ui.MainActivity;
import cz.m5cet.app.ui.Renderer;
import cz.m5cet.app.ui.Ui;

/**
 * The messages of the room on screen: a RecyclerView whose rows are the
 * design's message.in / message.out / message.sys trees, built once per
 * row and bound per message; a new message plays its row's enter animation.
 *
 * 6.1: rows follow their message (delivery state, file progress, receipts);
 * a vanishing message counts its time only while it is on screen and open;
 * what was shown gets a read receipt (Settings › Messages); a #tag filters
 * the conversation. A long press offers reply, copy, forward, the map and
 * the recording; a horizontal fling moves to the previous / next connected
 * room.
 */
final class MessageList extends FrameLayout implements Renderer.Slot {
    private static final int IN = 0, OUT = 1, SYS = 2;
    private final MainActivity a;
    private final Parts parts;
    private final RecyclerView list;
    private final TextView empty, state, filterBar;
    private final LinearLayoutManager lm;
    private final List<ChatMessage> all = new ArrayList<>();
    private final List<ChatMessage> items = new ArrayList<>();
    private String roomKey = "";
    private String animateId = null;
    private String tag = "";
    private final boolean[] legacyImage = new boolean[3];
    private long lastTick = 0;
    private final Runnable ticker = this::tick;

    MessageList(MainActivity a, Parts parts) {
        super(a);
        this.a = a;
        this.parts = parts;
        list = new RecyclerView(a);
        lm = new LinearLayoutManager(a);
        lm.setStackFromEnd(true);
        list.setLayoutManager(lm);
        list.setItemAnimator(null);
        list.setAdapter(new Adapter());
        list.setPadding(0, Ui.dp(a, 6), 0, Ui.dp(a, 6));
        list.setClipToPadding(false);
        list.addOnScrollListener(new RecyclerView.OnScrollListener() {
            @Override public void onScrollStateChanged(RecyclerView rv, int s) { if (s == RecyclerView.SCROLL_STATE_IDLE) markShown(); }
        });
        addView(list, new LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        empty = new TextView(a);
        empty.setGravity(Gravity.CENTER);
        empty.setPadding(Ui.dp(a, 36), 0, Ui.dp(a, 36), 0);
        empty.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        addView(empty, new LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        state = new TextView(a);
        state.setGravity(Gravity.CENTER);
        state.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        state.setPadding(Ui.dp(a, 12), Ui.dp(a, 4), Ui.dp(a, 12), Ui.dp(a, 4));
        addView(state, new LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.CENTER_HORIZONTAL));
        filterBar = new TextView(a);
        filterBar.setGravity(Gravity.CENTER);
        filterBar.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        filterBar.setPadding(Ui.dp(a, 14), Ui.dp(a, 6), Ui.dp(a, 14), Ui.dp(a, 6));
        filterBar.setVisibility(GONE);
        filterBar.setOnClickListener(v -> filter(""));
        LayoutParams fl = new LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        fl.bottomMargin = Ui.dp(a, 8);
        addView(filterBar, fl);
        GestureDetector swipe = new GestureDetector(a, new GestureDetector.SimpleOnGestureListener() {
            @Override public boolean onFling(MotionEvent e1, MotionEvent e2, float vx, float vy) {
                if (e1 == null || Math.abs(vx) < 2200 || Math.abs(vx) < Math.abs(vy) * 2) return false;
                List<RoomSession> rooms = a.app().rooms.connectedSessions();
                if (rooms.size() < 2) return false;
                int at = 0;
                for (int i = 0; i < rooms.size(); i++) if (rooms.get(i).key.equals(roomKey)) at = i;
                int next = (at + (vx < 0 ? 1 : -1) + rooms.size()) % rooms.size();
                a.goRoom(rooms.get(next).key);
                return true;
            }
        });
        list.addOnItemTouchListener(new RecyclerView.SimpleOnItemTouchListener() {
            @Override public boolean onInterceptTouchEvent(RecyclerView rv, MotionEvent e) { return swipe.onTouchEvent(e); }
        });
        for (int t = 0; t < 3; t++) legacyImage[t] = !usesSlot(t == SYS ? "message.sys" : t == OUT ? "message.out" : "message.in", "msgBody");
        load();
    }

    /** A design from before 6.1 has no msgBody slot: the picture then goes under the bubble as before. */
    private boolean usesSlot(String screen, String slot) {
        JSONObject tree = a.app().design().screen(screen);
        return tree != null && tree.toString().contains("\"" + slot + "\"");
    }

    private void load() {
        RoomSession r = a.app().rooms.activeSession();
        roomKey = r == null ? "" : r.key;
        all.clear();
        long now = System.currentTimeMillis();
        if (r != null) for (ChatMessage m : r.messagesCopy()) if (!m.expired(now)) all.add(m);
        applyFilter();
        if (!items.isEmpty()) list.scrollToPosition(items.size() - 1);
        refreshHeaderState();
    }

    private void applyFilter() {
        items.clear();
        for (ChatMessage m : all) if (matches(m)) items.add(m);
        RecyclerView.Adapter<?> ad = list.getAdapter();
        if (ad != null) ad.notifyDataSetChanged();
        filterBar.setVisibility(tag.isEmpty() ? GONE : VISIBLE);
        filterBar.setText("#" + tag + "   ✕");
        filterBar.setTextColor(Ui.color(getContext(), "@onPrimary", Color.WHITE));
        filterBar.setBackground(Ui.shape(Ui.color(getContext(), "@primary", Color.BLUE), Ui.dp(getContext(), 999), 0, 0));
    }

    private boolean matches(ChatMessage m) {
        if (tag.isEmpty()) return true;
        String t = m.visibleText().toLowerCase(Locale.ROOT);
        int at = t.indexOf("#" + tag);
        while (at >= 0) {
            int end = at + 1 + tag.length();
            if (end >= t.length() || !Character.isLetterOrDigit(t.charAt(end)) && t.charAt(end) != '_') return true;
            at = t.indexOf("#" + tag, end);
        }
        return false;
    }

    /** Shows only the messages with #tag ("" = all again). */
    void filter(String t) { tag = t == null ? "" : t; applyFilter(); if (!items.isEmpty()) list.scrollToPosition(items.size() - 1); }

    void refreshHeaderState() {
        RoomSession r = a.app().rooms.activeSession();
        if (r == null || !r.key.equals(roomKey)) { load(); return; }
        empty.setText(a.app().t("room.empty"));
        empty.setTextColor(Ui.color(getContext(), "@muted", Color.GRAY));
        empty.setVisibility(items.isEmpty() ? VISIBLE : GONE);
        String status = r.status();
        String text = status.equals("joined") ? "" : status.equals("mismatch") ? a.app().t("room.keyMismatch") : status.equals("connecting") ? (r.notice().isEmpty() ? a.app().t("room.connecting") : r.notice()) : a.app().t("room.offline");
        state.setText(text);
        state.setVisibility(text.isEmpty() ? GONE : VISIBLE);
        state.setTextColor(status.equals("mismatch") ? Color.WHITE : Ui.color(getContext(), "@onSurface", Color.BLACK));
        state.setBackground(Ui.shape(status.equals("mismatch") ? Ui.color(getContext(), "@danger", Color.RED) : Ui.color(getContext(), "@surfaceVariant", Color.LTGRAY), Ui.dp(getContext(), 12), 0, 0));
    }

    void add(ChatMessage m) {
        if (!m.roomKey.equals(roomKey)) return;
        for (int i = all.size() - 1; i >= 0 && i >= all.size() - 30; i--) if (all.get(i).id.equals(m.id)) return;
        all.add(m);
        if (!matches(m)) return;
        boolean atBottom = lm.findLastVisibleItemPosition() >= items.size() - 2;
        items.add(m);
        animateId = m.id;
        RecyclerView.Adapter<?> ad = list.getAdapter();
        if (ad != null) ad.notifyItemInserted(items.size() - 1);
        if (atBottom || m.mine) list.smoothScrollToPosition(items.size() - 1);
        empty.setVisibility(GONE);
        post(this::markShown);
    }

    /** A message changed (state, progress, receipts) or went (expiry): its row follows. */
    void changed(ChatMessage m) {
        if (!m.roomKey.equals(roomKey)) return;
        int at = indexOf(m.id);
        if (at < 0) return;
        RecyclerView.Adapter<?> ad = list.getAdapter();
        if (m.expired(System.currentTimeMillis()) && m.ttlMinutes > 0) {
            items.remove(at);
            all.remove(m);
            if (ad != null) ad.notifyItemRemoved(at);
            empty.setVisibility(items.isEmpty() ? VISIBLE : GONE);
            return;
        }
        if (ad != null) ad.notifyItemChanged(at);
    }

    private int indexOf(String id) {
        for (int i = items.size() - 1; i >= 0; i--) if (items.get(i).id.equals(id)) return i;
        return -1;
    }

    /* ---------------------------------------------- shown / vanishing */

    @Override protected void onAttachedToWindow() { super.onAttachedToWindow(); lastTick = System.currentTimeMillis(); postDelayed(ticker, 250); }
    @Override protected void onDetachedFromWindow() { removeCallbacks(ticker); super.onDetachedFromWindow(); }

    private boolean watching() {
        return a.app().inForeground() && !a.app().lock.isLocked() && "room".equals(a.screen());
    }

    /** Vanishing messages on screen and open use up their time; the countdown refreshes each second. */
    private void tick() {
        long now = System.currentTimeMillis();
        long delta = Math.min(1000, now - lastTick);
        lastTick = now;
        RoomSession r = a.app().rooms.activeSession();
        if (watching() && r != null && !items.isEmpty()) {
            int first = Math.max(0, lm.findFirstVisibleItemPosition()), last = Math.min(items.size() - 1, lm.findLastVisibleItemPosition());
            for (int i = first; i <= last && i >= 0; i++) {
                ChatMessage m = items.get(i);
                if (m.vanishSeconds <= 0 || m.vanished) continue;
                boolean open = (m.sealed == null || m.sealPlain != null) && (!m.tap || parts.holding.contains(m.id));
                if (!open) continue;
                long before = m.vanishedMs / 1000;
                m.vanishedMs += delta;
                if (m.vanishedMs >= m.vanishSeconds * 1000L) r.vanished(m);
                else if (m.vanishedMs / 1000 != before) { RecyclerView.Adapter<?> ad = list.getAdapter(); if (ad != null) ad.notifyItemChanged(i); }
            }
        }
        postDelayed(ticker, 250);
    }

    /** What is on screen now counts as read (receipts: Settings › Messages). */
    private void markShown() {
        RoomSession r = a.app().rooms.activeSession();
        if (!watching() || r == null || items.isEmpty()) return;
        int first = Math.max(0, lm.findFirstVisibleItemPosition()), last = Math.min(items.size() - 1, lm.findLastVisibleItemPosition());
        List<ChatMessage> shown = new ArrayList<>();
        for (int i = first; i <= last && i >= 0; i++) shown.add(items.get(i));
        r.markRead(shown);
    }

    @Override public void bindSlot(Expr.Scope scope) { refreshHeaderState(); }

    /* ------------------------------------------------------------ rows */

    private final class Holder extends RecyclerView.ViewHolder {
        final Renderer.Bound bound;
        final ImageView image;
        Holder(Renderer.Bound b, ImageView image, View root) { super(root); bound = b; this.image = image; }
    }

    private final class Adapter extends RecyclerView.Adapter<Holder> {
        @Override public int getItemViewType(int i) {
            ChatMessage m = items.get(i);
            return "sys".equals(m.kind) ? SYS : m.mine ? OUT : IN;
        }

        @Override public Holder onCreateViewHolder(ViewGroup parent, int type) {
            String id = type == SYS ? "message.sys" : type == OUT ? "message.out" : "message.in";
            Renderer.Bound b = a.renderer().build(a.app().design().screen(id));
            LinearLayout wrap = new LinearLayout(getContext());
            wrap.setOrientation(LinearLayout.VERTICAL);
            wrap.addView(b.root(), new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            ImageView image = new ImageView(getContext());
            image.setAdjustViewBounds(true);
            image.setMaxHeight(Ui.dp(getContext(), 280));
            image.setScaleType(ImageView.ScaleType.FIT_START);
            LinearLayout.LayoutParams il = new LinearLayout.LayoutParams(Ui.dp(getContext(), 240), ViewGroup.LayoutParams.WRAP_CONTENT);
            il.gravity = type == OUT ? Gravity.END : Gravity.START;
            il.setMargins(Ui.dp(getContext(), type == OUT ? 0 : 50), 0, Ui.dp(getContext(), 14), Ui.dp(getContext(), 4));
            image.setVisibility(GONE);
            image.setClipToOutline(true);
            image.setBackground(Ui.shape(Color.TRANSPARENT, Ui.dp(getContext(), 14), 0, 0));
            wrap.addView(image, il);
            wrap.setLayoutParams(new RecyclerView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            return new Holder(b, image, wrap);
        }

        @Override public void onBindViewHolder(Holder h, int i) {
            ChatMessage m = items.get(i);
            Map<String, Object> s = new HashMap<>();
            s.put("msg", m.scope());
            s.put("_msg", m);
            s.put("settings", a.app().settings.scope());
            h.bound.bind(s::get);
            if (m.id.equals(animateId)) { h.bound.enter(); animateId = null; }
            int type = getItemViewType(i);
            if (legacyImage[type] && m.fileImage && m.fileDataUrl != null) {
                Bitmap bm = parts.imageCache.get(m.id);
                if (bm == null) { bm = cz.m5cet.app.ui.media.VaultMedia.bitmap(a.app(), m, 1280); if (bm != null) parts.imageCache.put(m.id, bm); }
                h.image.setImageBitmap(bm);
                h.image.setVisibility(bm == null ? GONE : VISIBLE);
            } else {
                h.image.setVisibility(GONE);
            }
            h.itemView.setOnLongClickListener(v -> { menu(v, m); return true; });
        }

        @Override public int getItemCount() { return items.size(); }
    }

    void menu(View anchor, ChatMessage m) {
        if ("sys".equals(m.kind) || m.vanished) return;
        PopupMenu pm = new PopupMenu(getContext(), anchor);
        cz.m5cet.app.M5 app = a.app();
        pm.getMenu().add(0, 1, 1, app.t("notify.reply"));
        if (!m.visibleText().isEmpty() && (m.sealed == null || m.sealPlain != null)) pm.getMenu().add(0, 2, 2, app.t("msg.copy"));
        pm.getMenu().add(0, 3, 3, app.t("msg.forward"));
        if (m.loc != null) pm.getMenu().add(0, 4, 4, app.t("msg.map"));
        if (m.sourceAudio != null) pm.getMenu().add(0, 5, 5, app.t("msg.source"));
        if (m.fileName != null && (m.fileDataUrl != null || m.filePath != null)) { pm.getMenu().add(0, 6, 6, app.t("file.open")); pm.getMenu().add(0, 7, 7, app.t("file.save")); }
        if (!m.visibleText().isEmpty() && m.sealed == null) pm.getMenu().add(0, 8, 8, app.t("msg.speak"));
        pm.getMenu().add(0, 9, 9, app.t("msg.info"));
        pm.setOnMenuItemClickListener(mi -> {
            switch (mi.getItemId()) {
                case 1: parts.replyTo(m.id); break;
                case 2: parts.copyMessage(m.id); break;
                case 3: parts.forward(m); break;
                case 4: parts.openMap(m); break;
                case 5: parts.playSource(m); break;
                case 6: parts.openFile(m); break;
                case 7: parts.saveFile(m); break;
                case 8: app.voice.say(m.visibleText()); break;
                case 9: parts.messageInfo(m); break;
                default: break;
            }
            return true;
        });
        pm.show();
    }
}
