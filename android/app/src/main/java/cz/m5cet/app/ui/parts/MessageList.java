package cz.m5cet.app.ui.parts;

import android.graphics.Bitmap;
import android.graphics.Color;
import android.util.TypedValue;
import android.view.GestureDetector;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
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
import cz.m5cet.app.ui.bubble.BubbleSwipe;
import cz.m5cet.app.ui.bubble.Hides;
import cz.m5cet.app.ui.bubble.Kinds;
import cz.m5cet.app.ui.bubble.MapPolicy;
import cz.m5cet.app.ui.bubble.ModelFace;
import cz.m5cet.app.ui.bubble.ReplyQuote;
import cz.m5cet.app.ui.bubble.Runs;

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
 *
 * 6.2: hidden messages are left out until their time passes (or the next
 * unlock), "Hidden (n)" shows them for a moment; a received message's first
 * time on screen is its "displayed" step; $msg also has position (a
 * position message), mapPreview (its bubble draws the map) and hidden.
 *
 * 6.10: a bubble dragged sideways replies (toward the reading direction's
 * end) or forwards (toward its start) — the row follows the finger over the
 * action's icon and springs back (Swiper, BubbleRow; the rule is
 * ui/bubble/BubbleSwipe); the room still changes with a fling off the
 * bubbles. $msg.replyTo is the quote card's (ReplyQuote: the original's
 * kind, its sender's colour, whether it is here), $msg.cont continues one
 * person's run (Runs: no avatar, no name), $msg.photo is the photo the
 * sender shares with the room. A quote's tap scrolls to the original and
 * flashes it (jumpTo). TalkBack: reply, forward, the original and the
 * sender's profile are each row's actions.
 */
final class MessageList extends FrameLayout implements Renderer.Slot, Hides.Listener, MapPolicy.Listener {
    private static final int IN = 0, OUT = 1, SYS = 2;
    private final MainActivity a;
    private final Parts parts;
    private final RecyclerView list;
    private final TextView empty, state, filterBar;
    private final LinearLayoutManager lm;
    private final List<ChatMessage> all = new ArrayList<>();
    private final List<ChatMessage> items = new ArrayList<>();
    /** 6.10: the room's messages here by id (a quote's original), and the one a quote's tap flashes once bound. */
    private final Map<String, ChatMessage> byId = new HashMap<>();
    private String flashId;
    private String roomKey = "";
    private String animateId = null;
    private String tag = "";
    private final boolean[] legacyImage = new boolean[3];
    private long lastTick = 0;
    private final Runnable ticker = this::tick;
    /** 6.2: hidden messages shown for now ("Hidden (n)"), how many there are, and when the next timed hide ends. */
    private boolean peek;
    private int hiddenCount;
    private final java.util.Set<String> hiddenIds = new java.util.HashSet<>();
    private long nextHideEnd = Long.MAX_VALUE;
    private final TextView hiddenBar;

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
        hiddenBar = new TextView(a);
        hiddenBar.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        hiddenBar.setPadding(Ui.dp(a, 10), Ui.dp(a, 4), Ui.dp(a, 10), Ui.dp(a, 4));
        hiddenBar.setVisibility(GONE);
        hiddenBar.setOnClickListener(v -> toggleHidden());
        LayoutParams hl = new LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.END);
        hl.setMargins(0, Ui.dp(a, 6), Ui.dp(a, 10), 0);
        addView(hiddenBar, hl);
        list.addOnItemTouchListener(new Swiper());
        for (int t = 0; t < 3; t++) legacyImage[t] = !usesSlot(t == SYS ? "message.sys" : t == OUT ? "message.out" : "message.in", "msgBody");
        load();
    }

    /* ---------------------------------------------- 6.10 sideways gestures */

    /**
     * The list's sideways gestures (the rule: ui/bubble/BubbleSwipe). A drag
     * that starts on a bubble and is clearly sideways moves that bubble's row
     * — to the reading direction's end it replies, to its start it forwards;
     * a vertical one stays the list's scrolling. A quick fling that starts
     * off the bubbles (beside them, on an avatar, on the background) moves
     * to the previous / next connected room, as in 6.1. A touch on a control
     * that moves sideways itself (an audio player's seek bar, a field, a wide
     * output that scrolls) stays that control's; so does a held message.
     */
    private final class Swiper implements RecyclerView.OnItemTouchListener {
        private final float density = getResources().getDisplayMetrics().density;
        private final int slop = android.view.ViewConfiguration.get(getContext()).getScaledTouchSlop();
        private final GestureDetector fling;
        private BubbleSwipe gesture;
        private BubbleRow row;
        private ChatMessage msg;
        private boolean onBubble;

        Swiper() {
            fling = new GestureDetector(getContext(), new GestureDetector.SimpleOnGestureListener() {
                @Override public boolean onFling(MotionEvent e1, MotionEvent e2, float vx, float vy) {
                    if (e1 == null || !BubbleSwipe.roomFling(onBubble, vx, vy, BubbleSwipe.ROOM_FLING_DP * density)) return false;
                    List<RoomSession> rooms = a.app().rooms.connectedSessions();
                    if (rooms.size() < 2) return false;
                    int at = 0;
                    for (int i = 0; i < rooms.size(); i++) if (rooms.get(i).key.equals(roomKey)) at = i;
                    int next = (at + BubbleSwipe.roomStep(vx) + rooms.size()) % rooms.size();
                    a.goRoom(rooms.get(next).key);
                    return true;
                }
            });
        }

        @Override public boolean onInterceptTouchEvent(RecyclerView rv, MotionEvent e) {
            if (e.getActionMasked() == MotionEvent.ACTION_DOWN) down(rv, e);
            // A hold-to-read message held by its chip (the chip takes the touch after us): it stays held, never swiped.
            if (gesture != null && !gesture.dragging() && msg != null && parts.holding.contains(msg.id)) { gesture.cancel(); gesture = null; }
            if (gesture != null && e.getActionMasked() == MotionEvent.ACTION_MOVE && gesture.move(e.getX(), e.getY())) {
                // The bubble's from now on: the row's children get a cancel (no long press), the list does not scroll.
                ViewParent p = rv.getParent();
                if (p != null) p.requestDisallowInterceptTouchEvent(true);
                show();
                return true;
            }
            if (e.getActionMasked() == MotionEvent.ACTION_UP || e.getActionMasked() == MotionEvent.ACTION_CANCEL) end(false);
            return fling.onTouchEvent(e);
        }

        @Override public void onTouchEvent(RecyclerView rv, MotionEvent e) {
            switch (e.getActionMasked()) {
                case MotionEvent.ACTION_MOVE:
                    if (gesture != null && gesture.move(e.getX(), e.getY())) show();
                    break;
                case MotionEvent.ACTION_UP: end(true); break;
                case MotionEvent.ACTION_CANCEL: end(false); break;
                default: break;
            }
        }

        /** A child claimed the touch (the hold area revealing, a seek bar): the bubble lets go. */
        @Override public void onRequestDisallowInterceptTouchEvent(boolean disallow) {
            if (disallow && gesture != null && !gesture.dragging()) { gesture.cancel(); gesture = null; }
        }

        private void down(RecyclerView rv, MotionEvent e) {
            if (row != null) row.springBack();
            gesture = null;
            row = null;
            msg = null;
            onBubble = false;
            View child = rv.findChildViewUnder(e.getX(), e.getY());
            if (!(child instanceof BubbleRow)) return;
            BubbleRow r = (BubbleRow) child;
            ChatMessage m = r.msg;
            if (m == null || "sys".equals(m.kind)) return;
            View target = bubbleOf(r);
            android.graphics.Rect box = new android.graphics.Rect();
            target.getDrawingRect(box);
            rv.offsetDescendantRectToMyCoords(target, box);
            onBubble = box.contains(Math.round(e.getX()), Math.round(e.getY()));
            // A list still moving stops under the finger (not a swipe); a held message stays held; a sideways control keeps its drag.
            boolean free = onBubble && rv.getScrollState() == RecyclerView.SCROLL_STATE_IDLE && !parts.holding.contains(m.id)
                && !movesSideways(target, e.getX() - box.left, e.getY() - box.top);
            gesture = new BubbleSwipe(density, slop, free, canReply(m), canForward(m), rv.getLayoutDirection() == View.LAYOUT_DIRECTION_RTL, e.getX(), e.getY());
            row = r;
            msg = m;
        }

        private void show() {
            if (row == null || gesture == null) return;
            row.drag(gesture.offset(), gesture.showing(), gesture.progress(), gesture.armed());
            if (gesture.crossed()) row.tick();
        }

        private void end(boolean lifted) {
            BubbleSwipe g = gesture;
            BubbleRow r = row;
            ChatMessage m = msg;
            gesture = null;
            if (g == null) return;
            boolean was = g.dragging();
            BubbleSwipe.Act act = lifted ? g.release() : BubbleSwipe.Act.NONE;
            g.cancel();
            if (was && r != null) r.springBack();
            row = null;
            msg = null;
            if (m == null || act == BubbleSwipe.Act.NONE) return;
            if (act == BubbleSwipe.Act.REPLY) reply(m);
            else parts.forward(m);
        }
    }

    /** The part of a row that swipes: its bubble (with what is beside it, e.g. a recording's button), else the whole row. */
    private static View bubbleOf(BubbleRow r) {
        View v = r.content.findViewWithTag("bubble-wrap");
        if (v == null || v.getVisibility() != VISIBLE) v = r.content.findViewWithTag("bubble");
        return v != null && v.getVisibility() == VISIBLE ? v : r.content;
    }

    /** Under (x, y) of `v` (its own coordinates), a view that drags sideways on its own. */
    private static boolean movesSideways(View v, float x, float y) {
        if (v instanceof android.widget.AbsSeekBar || v instanceof android.widget.EditText || v instanceof android.widget.HorizontalScrollView) return true;
        if (v.canScrollHorizontally(1) || v.canScrollHorizontally(-1)) return true;
        if (!(v instanceof ViewGroup)) return false;
        ViewGroup g = (ViewGroup) v;
        for (int i = g.getChildCount() - 1; i >= 0; i--) {
            View c = g.getChildAt(i);
            if (c.getVisibility() != VISIBLE) continue;
            float cx = x + g.getScrollX() - c.getLeft() - c.getTranslationX(), cy = y + g.getScrollY() - c.getTop() - c.getTranslationY();
            if (cx >= 0 && cy >= 0 && cx < c.getWidth() && cy < c.getHeight()) return movesSideways(c, cx, cy);
        }
        return false;
    }

    /** Can be answered: a message (not a notice) that is still there. */
    private static boolean canReply(ChatMessage m) { return m != null && !"sys".equals(m.kind) && !m.vanished; }

    /** Can be forwarded: something to send — never a sealed one not opened here (its text is the ciphertext). */
    private static boolean canForward(ChatMessage m) {
        if (!canReply(m) || m.sealed != null && m.sealPlain == null) return false;
        return !m.visibleText().isEmpty() || m.fileName != null && (m.fileDataUrl != null || m.filePath != null);
    }

    /** A reply from the swipe: the composer quotes the message and gets the keyboard. */
    private void reply(ChatMessage m) {
        parts.replyTo(m.id);
        parts.focusComposer();
    }

    /** What TalkBack offers on a row: the swipe's actions and the taps' (profile, the original). */
    private List<BubbleRow.A11y> a11y(ChatMessage m) {
        List<BubbleRow.A11y> out = new ArrayList<>();
        cz.m5cet.app.M5 app = a.app();
        if (canReply(m)) out.add(new BubbleRow.A11y(app.t("notify.reply"), () -> reply(m)));
        if (canForward(m)) out.add(new BubbleRow.A11y(app.t("msg.forward"), () -> parts.forward(m)));
        if (m.replyToId != null && !m.replyToId.isEmpty()) out.add(new BubbleRow.A11y(app.t("quote.go"), () -> parts.quote(m.replyToId)));
        cz.m5cet.app.fn.ModelIdentity model = ModelFace.of(m);
        if (model != null) out.add(new BubbleRow.A11y(app.t("fnm.about") + ": " + model.name, () -> parts.showSender(m.id)));
        else if (!m.mine && !"sys".equals(m.kind)) out.add(new BubbleRow.A11y(app.t("sender.profile") + ": " + cz.m5cet.app.core.Names.normalize(m.senderName), () -> parts.showSender(m.id)));
        return out;
    }

    /* ---------------------------------------------- 6.10 the quote's tap */

    /** Where a quote's original is: on screen now, hidden here, or not in this device's history. */
    enum Jump { SHOWN, HIDDEN, MISSING }

    /**
     * Scrolls to the message a reply quotes and flashes it; it may be hidden
     * on this device (said, not shown — "Hidden (n)" shows it) or not here at
     * all (older than the history, deleted, expired).
     */
    Jump jumpTo(String id) {
        if (id == null || id.isEmpty()) return Jump.MISSING;
        ChatMessage o = byId.get(id);
        if (o == null || o.deleted || o.expired(System.currentTimeMillis())) return Jump.MISSING;
        if (!tag.isEmpty() && !matches(o)) { tag = ""; applyFilter(); }
        int at = indexOf(id);
        if (at < 0) return hiddenIds.contains(id) ? Jump.HIDDEN : Jump.MISSING;
        flashId = id;
        lm.scrollToPositionWithOffset(at, Ui.dp(getContext(), 96));
        // Already bound on screen: flash it once the list has moved; else onBind does.
        list.post(() -> {
            RecyclerView.ViewHolder h = list.findViewHolderForAdapterPosition(at);
            if (h != null && h.itemView instanceof BubbleRow && id.equals(flashId)) { flashId = null; ((BubbleRow) h.itemView).flash(); }
        });
        return Jump.SHOWN;
    }

    /** A design from before 6.1 has no msgBody slot: the picture then goes under the bubble as before. */
    private boolean usesSlot(String screen, String slot) {
        JSONObject tree = a.app().design().screen(screen);
        return tree != null && tree.toString().contains("\"" + slot + "\"");
    }

    private void load() {
        RoomSession r = a.app().rooms.activeSession();
        String was = roomKey;
        roomKey = r == null ? "" : r.key;
        restoresSeen = r == null ? -1 : r.restores();
        if (!roomKey.equals(was)) peek = false;
        all.clear();
        byId.clear();
        long now = System.currentTimeMillis();
        if (r != null) for (ChatMessage m : r.messagesCopy()) if (!m.expired(now)) { all.add(m); byId.put(m.id, m); }
        applyFilter();
        if (!items.isEmpty()) list.scrollToPosition(items.size() - 1);
        refreshHeaderState();
        post(this::markShown);
    }

    private void applyFilter() {
        items.clear();
        long now = System.currentTimeMillis();
        RoomSession r = a.app().rooms.session(roomKey);
        hiddenIds.clear();
        for (ChatMessage m : all) {
            if (Hides.endIfOver(m, now) && r != null) r.touched(m);
            boolean hidden = m.hiddenUntil != 0 && Hides.hidden(m, now);
            if (hidden) hiddenIds.add(m.id);
            if (matches(m) && (!hidden || peek)) items.add(m);
        }
        hiddenCount = hiddenIds.size();
        nextHideEnd = Hides.nextEnd(all, now);
        if (hiddenCount == 0) peek = false;
        RecyclerView.Adapter<?> ad = list.getAdapter();
        if (ad != null) ad.notifyDataSetChanged();
        hiddenBar.setVisibility(hiddenCount == 0 ? GONE : VISIBLE);
        hiddenBar.setText((peek ? "🙈 " + a.app().t("msg.hideHidden") : "👁 " + a.app().t("msg.showHidden")) + " (" + hiddenCount + ")");
        hiddenBar.setTextColor(Ui.color(getContext(), "@onSurface", Color.BLACK));
        hiddenBar.setBackground(Ui.shape(Ui.color(getContext(), "@surfaceVariant", Color.LTGRAY), Ui.dp(getContext(), 999), 0, 0));
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

    /** "Hidden (n)": the hidden messages in their places for now (dimmed), or out of the list again. */
    void toggleHidden() { peek = !peek && hiddenCount > 0; applyFilter(); }

    /** 6.8 (the History screen): scrolls to a message of this room, when it is in the list; whether it was. */
    boolean reveal(String id) {
        if (id == null) return false;
        if (!tag.isEmpty()) { tag = ""; applyFilter(); }
        for (int i = 0; i < items.size(); i++) {
            if (!id.equals(items.get(i).id)) continue;
            lm.scrollToPositionWithOffset(i, Ui.dp(getContext(), 96));
            return true;
        }
        return false;
    }

    private boolean shows(ChatMessage m) {
        return !m.deleted && matches(m) && (peek || m.hiddenUntil == 0 || !Hides.hidden(m, System.currentTimeMillis()));
    }

    /** A hide began or ended, or the app was unlocked (hides "until the next sign-in" end). */
    @Override public void onHidesChanged() { if (isAttachedToWindow()) applyFilter(); }

    /** The operator's map policy came or changed, or the server stopped answering: the bubbles draw again. */
    @Override public void onMapPolicy() {
        RecyclerView.Adapter<?> ad = list.getAdapter();
        if (ad != null && isAttachedToWindow()) ad.notifyDataSetChanged();
    }

    /** 6.12: the room's history as last read (RoomSession.restores — it comes again after an unlock). */
    private int restoresSeen = -1;

    void refreshHeaderState() {
        RoomSession r = a.app().rooms.activeSession();
        if (r == null || !r.key.equals(roomKey) || r.restores() != restoresSeen) { load(); return; }
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
        byId.put(m.id, m);
        if (!shows(m)) return;
        boolean atBottom = lm.findLastVisibleItemPosition() >= items.size() - 2;
        items.add(m);
        animateId = m.id;
        RecyclerView.Adapter<?> ad = list.getAdapter();
        if (ad != null) ad.notifyItemInserted(items.size() - 1);
        if (atBottom || m.mine) list.smoothScrollToPosition(items.size() - 1);
        empty.setVisibility(GONE);
        post(this::markShown);
    }

    /** A message changed (state, progress, receipts) or went (expiry): its row follows. 6.2: hidden, shown again, deleted. */
    void changed(ChatMessage m) {
        if (!m.roomKey.equals(roomKey)) return;
        int at = indexOf(m.id);
        boolean known = at >= 0 || all.contains(m);
        if (m.deleted) { all.remove(m); byId.remove(m.id); }
        boolean nowHidden = m.hiddenUntil != 0 && Hides.hidden(m, System.currentTimeMillis());
        boolean hideChange = m.deleted || (at >= 0) != shows(m) || nowHidden != hiddenIds.contains(m.id);
        if (known && hideChange) { applyFilter(); return; }
        if (at < 0) return;
        RecyclerView.Adapter<?> ad = list.getAdapter();
        if (m.expired(System.currentTimeMillis()) && m.ttlMinutes > 0) {
            items.remove(at);
            all.remove(m);
            byId.remove(m.id);
            if (ad != null) { ad.notifyItemRemoved(at); if (at < items.size()) ad.notifyItemChanged(at); } // 6.10: the next one may start a run now
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

    @Override protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        lastTick = System.currentTimeMillis();
        postDelayed(ticker, 250);
        Hides.addListener(this);
        MapPolicy.addListener(this);
    }

    @Override protected void onDetachedFromWindow() {
        removeCallbacks(ticker);
        Hides.removeListener(this);
        MapPolicy.removeListener(this);
        super.onDetachedFromWindow();
    }

    private boolean watching() {
        return a.app().inForeground() && !a.app().lock.isLocked() && "room".equals(a.screen());
    }

    /** Vanishing messages on screen and open use up their time; the countdown refreshes each second. */
    private void tick() {
        long now = System.currentTimeMillis();
        long delta = Math.min(1000, now - lastTick);
        lastTick = now;
        if (now >= nextHideEnd) applyFilter(); // a timed hide is over: the message is back
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
        boolean steps = false;
        for (int i = first; i <= last && i >= 0; i++) {
            ChatMessage m = items.get(i);
            shown.add(m);
            // 6.2: its first time on screen (not for a message from before the timeline: that time would say nothing)
            if (!m.mine && !"sys".equals(m.kind) && m.has("received")) steps |= m.mark("displayed");
        }
        if (steps) r.touched(shown.get(0));
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
            // 6.11: a model's answer is an incoming message — also the one this device sent to the room for it.
            return "sys".equals(m.kind) ? SYS : m.mine && ModelFace.of(m) == null ? OUT : IN;
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
            // 6.10: the row under a sideways drag (reply / forward icons), its flash, its TalkBack actions.
            BubbleRow row = new BubbleRow(getContext(), wrap);
            row.setA11y(MessageList.this::a11y);
            row.setLayoutParams(new RecyclerView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            return new Holder(b, image, row);
        }

        @Override public void onBindViewHolder(Holder h, int i) {
            ChatMessage m = items.get(i);
            Map<String, Object> s = new HashMap<>();
            JSONObject ms = m.scope();
            boolean hidden = m.hiddenUntil != 0 && Hides.hidden(m, System.currentTimeMillis());
            JSONObject quote = ReplyQuote.of(m, m.replyToId == null ? null : byId.get(m.replyToId), a.app()::t);
            try {
                boolean position = Kinds.isPositionMessage(m);
                ms.put("position", position).put("mapPreview", position && MapBubble.policyFor(a.app(), m) != null).put("hidden", hidden);
                // 6.12 (F-22): names as the app shows them; a sender that looks like someone else gets "⚠ ";
                // an operator's notice says it is the operator's, whatever its frame named.
                boolean flag = senderFlagged(m);
                ms.put("sender", cz.m5cet.app.core.Names.shown(m.senderName, flag)).put("senderFlag", flag)
                    .put("forwarded", cz.m5cet.app.core.Names.normalize(m.forwardedFrom == null ? "" : m.forwardedFrom));
                if (quote != null) quote.put("sender", cz.m5cet.app.core.Names.normalize(quote.optString("sender")));
                if ("sys".equals(m.kind) && m.id != null && m.id.startsWith(cz.m5cet.app.core.Names.NOTICE_ID)) {
                    String who = cz.m5cet.app.core.Names.operator(m.senderName, a.app().t("notice.operator"));
                    ms.put("sender", who).put("text", who + ": " + ms.optString("text"));
                }
                // 6.10: the quote card, a run of one person's messages, the photo they share with the room.
                if (quote != null) ms.put("replyTo", quote);
                ms.put("cont", i > 0 && Runs.continues(items.get(i - 1), m)).put("photo", m.mine ? "" : senderPhoto(m));
                // 6.11: a model's answer — the model is the sender (its name, its face), the line says how it came; no "forwarded from /kw".
                JSONObject model = ModelFace.scope(m, a.app()::t, name -> cz.m5cet.app.ui.Icons.has(a, name));
                ms.put("model", model == null ? JSONObject.NULL : model);
                if (model != null) ms.put("sender", model.optString("name")).put("photo", "").put("forwarded", "");
            } catch (org.json.JSONException ignored) { }
            s.put("msg", ms);
            s.put("_msg", m);
            s.put("settings", a.app().settings.scope());
            h.bound.bind(s::get);
            if (m.id.equals(animateId)) { h.bound.enter(); animateId = null; }
            BubbleRow row = (BubbleRow) h.itemView;
            if (row.msg != m) row.rest();
            row.msg = m;
            describe(row, m, quote);
            if (m.id.equals(flashId)) { flashId = null; row.post(row::flash); }
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
            h.itemView.setAlpha(hidden ? 0.55f : 1f); // a hidden one while "Hidden (n)" shows it
        }

        @Override public int getItemCount() { return items.size(); }
    }

    /** 6.12 (F-22): the room's members as the look-alike check sees them ({id, identity, name}), and my name — read at most every 2 s. */
    private List<String[]> roster = new ArrayList<>();
    private String rosterRoom = "", myName = "";
    private long rosterAt;

    private boolean senderFlagged(ChatMessage m) {
        if (m.mine || "sys".equals(m.kind) || m.senderName == null || m.senderName.isEmpty()) return false;
        long now = System.currentTimeMillis();
        if (!rosterRoom.equals(m.roomKey) || now - rosterAt > 2000) {
            List<String[]> next = new ArrayList<>();
            String me = a.app().config.userName();
            RoomSession r = a.app().rooms.session(m.roomKey);
            org.json.JSONArray people = r == null ? new org.json.JSONArray() : r.peopleScope();
            for (int i = 0; i < people.length(); i++) {
                JSONObject u = people.optJSONObject(i);
                if (u == null) continue;
                next.add(new String[]{u.optString("id"), People.identity(u), u.optString("name")});
                if (u.optBoolean("me")) me = u.optString("name", me);
            }
            roster = next;
            myName = me;
            rosterRoom = m.roomKey == null ? "" : m.roomKey;
            rosterAt = now;
        }
        return cz.m5cet.app.core.Names.senderFlag(roster, myName, m.senderId, m.senderName);
    }

    /** 6.10: the photo the sender shares with this room ("" without one: the design draws the monogram). */
    private String senderPhoto(ChatMessage m) {
        if (m.senderId == null || m.senderId.isEmpty() || "sys".equals(m.kind)) return "";
        RoomSession r = a.app().rooms.session(m.roomKey);
        JSONObject p = r == null ? null : r.profileOf(m.senderId);
        return p == null ? "" : p.optString("avatar");
    }

    /** 6.10: what TalkBack says on the face and the quote card (the design's elements have no label of their own). */
    private void describe(BubbleRow row, ChatMessage m, JSONObject quote) {
        cz.m5cet.app.M5 app = a.app();
        View face = row.content.findViewWithTag("face");
        cz.m5cet.app.fn.ModelIdentity model = ModelFace.of(m);
        if (face != null) face.setContentDescription(model != null ? app.t("fnm.about") + ": " + model.name : app.t("sender.profile") + ": " + cz.m5cet.app.core.Names.normalize(m.senderName));
        View q = row.content.findViewWithTag("quote");
        if (q != null && quote != null) q.setContentDescription(app.t("quote.replyTo") + " " + quote.optString("sender") + ": " + quote.optString("text") + ". " + app.t("quote.go"));
    }

    void menu(View anchor, ChatMessage m) {
        if ("sys".equals(m.kind) || m.vanished) return;
        // 6.7 (ui/look/Menus): in the design's colours, each item with its icon.
        cz.m5cet.app.M5 app = a.app();
        List<cz.m5cet.app.ui.look.Menus.Item> items = new ArrayList<>();
        items.add(new cz.m5cet.app.ui.look.Menus.Item("reply", app.t("notify.reply"), () -> parts.replyTo(m.id)));
        if (!m.visibleText().isEmpty() && (m.sealed == null || m.sealPlain != null)) items.add(new cz.m5cet.app.ui.look.Menus.Item("copy", app.t("msg.copy"), () -> parts.copyMessage(m.id)));
        // 6.10: only what can be forwarded (a sealed message not opened here would go out empty).
        if (canForward(m)) items.add(new cz.m5cet.app.ui.look.Menus.Item("forward", app.t("msg.forward"), () -> parts.forward(m)));
        if (Kinds.position(m) != null) items.add(new cz.m5cet.app.ui.look.Menus.Item("map", app.t("msg.map"), () -> parts.mapPreview(m))); // 6.7: the place sheet (map, navigation, a ride)
        if (m.sourceAudio != null) items.add(new cz.m5cet.app.ui.look.Menus.Item("audio-lines", app.t("msg.source"), () -> parts.playSource(m)));
        if (m.fileName != null && (m.fileDataUrl != null || m.filePath != null)) {
            items.add(new cz.m5cet.app.ui.look.Menus.Item("folder-open", app.t("file.open"), () -> parts.openFile(m)));
            items.add(new cz.m5cet.app.ui.look.Menus.Item("download", app.t("file.save"), () -> parts.saveFile(m)));
            items.add(new cz.m5cet.app.ui.look.Menus.Item("share-2", app.t("file.share"), () -> parts.shareFile(m)));
        }
        if (!m.visibleText().isEmpty() && m.sealed == null) items.add(new cz.m5cet.app.ui.look.Menus.Item("volume-2", app.t("msg.speak"), () -> app.voice.say(m.visibleText())));
        items.add(new cz.m5cet.app.ui.look.Menus.Item("info", app.t("msg.info"), () -> parts.messageInfo(m)));
        cz.m5cet.app.ui.look.Menus.show(anchor, items);
    }
}
