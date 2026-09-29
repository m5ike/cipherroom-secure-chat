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

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
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
 * A long press offers reply and copy; a horizontal fling moves to the
 * previous / next connected room (smart switching by gesture).
 */
final class MessageList extends FrameLayout implements Renderer.Slot {
    private static final int IN = 0, OUT = 1, SYS = 2;
    private final MainActivity a;
    private final RecyclerView list;
    private final TextView empty, state;
    private final LinearLayoutManager lm;
    private final List<ChatMessage> items = new ArrayList<>();
    private String roomKey = "";
    private String animateId = null;

    MessageList(MainActivity a, Parts parts) {
        super(a);
        this.a = a;
        list = new RecyclerView(a);
        lm = new LinearLayoutManager(a);
        lm.setStackFromEnd(true);
        list.setLayoutManager(lm);
        list.setItemAnimator(null);
        list.setAdapter(new Adapter());
        list.setPadding(0, Ui.dp(a, 6), 0, Ui.dp(a, 6));
        list.setClipToPadding(false);
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
        load();
    }

    private void load() {
        RoomSession r = a.app().rooms.activeSession();
        roomKey = r == null ? "" : r.key;
        items.clear();
        if (r != null) items.addAll(r.messagesCopy());
        RecyclerView.Adapter<?> ad = list.getAdapter();
        if (ad != null) ad.notifyDataSetChanged();
        if (!items.isEmpty()) list.scrollToPosition(items.size() - 1);
        refreshHeaderState();
    }

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
        for (int i = items.size() - 1; i >= 0 && i >= items.size() - 30; i--) if (items.get(i).id.equals(m.id)) return;
        boolean atBottom = lm.findLastVisibleItemPosition() >= items.size() - 2;
        items.add(m);
        animateId = m.id;
        RecyclerView.Adapter<?> ad = list.getAdapter();
        if (ad != null) ad.notifyItemInserted(items.size() - 1);
        if (atBottom || m.mine) list.smoothScrollToPosition(items.size() - 1);
        empty.setVisibility(GONE);
    }

    @Override public void bindSlot(Expr.Scope scope) { refreshHeaderState(); }

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
            h.bound.bind(s::get);
            if (m.id.equals(animateId)) { h.bound.enter(); animateId = null; }
            if (m.fileDataUrl != null && m.fileMime != null && m.fileMime.startsWith("image/")) {
                Bitmap bm = decode(m.fileDataUrl);
                h.image.setImageBitmap(bm);
                h.image.setVisibility(bm == null ? GONE : VISIBLE);
            } else {
                h.image.setVisibility(GONE);
            }
            h.itemView.setOnLongClickListener(v -> { menu(v, m); return true; });
        }

        @Override public int getItemCount() { return items.size(); }
    }

    private static final android.util.LruCache<String, Bitmap> images = new android.util.LruCache<>(24);

    private static Bitmap decode(String dataUrl) {
        Bitmap b = images.get(dataUrl.length() + ":" + dataUrl.hashCode());
        if (b != null) return b;
        int comma = dataUrl.indexOf(',');
        if (comma < 0) return null;
        byte[] raw = android.util.Base64.decode(dataUrl.substring(comma + 1), android.util.Base64.DEFAULT);
        android.graphics.BitmapFactory.Options o = new android.graphics.BitmapFactory.Options();
        o.inSampleSize = raw.length > 400_000 ? 2 : 1;
        b = android.graphics.BitmapFactory.decodeByteArray(raw, 0, raw.length, o);
        if (b != null) images.put(dataUrl.length() + ":" + dataUrl.hashCode(), b);
        return b;
    }

    private void menu(View anchor, ChatMessage m) {
        if ("sys".equals(m.kind)) return;
        PopupMenu pm = new PopupMenu(getContext(), anchor);
        pm.getMenu().add(0, 1, 1, a.app().t("notify.reply"));
        pm.getMenu().add(0, 2, 2, "Copy");
        pm.setOnMenuItemClickListener(mi -> {
            if (mi.getItemId() == 1) a.parts.replyTo(m.id);
            else a.parts.copyMessage(m.id);
            return true;
        });
        pm.show();
    }
}
