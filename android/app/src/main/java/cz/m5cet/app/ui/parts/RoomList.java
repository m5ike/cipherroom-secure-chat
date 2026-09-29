package cz.m5cet.app.ui.parts;

import android.graphics.Color;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.TextView;

import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;

import cz.m5cet.app.ui.Expr;
import cz.m5cet.app.ui.MainActivity;
import cz.m5cet.app.ui.Renderer;
import cz.m5cet.app.ui.Ui;

/**
 * The saved rooms, several of which can be connected at once: each row is
 * the design's "rooms.item" tree (checkbox to select, users badge, unread
 * badge), bound — not rebuilt — on every change.
 */
final class RoomList extends FrameLayout implements Renderer.Slot {
    private final MainActivity a;
    private final RecyclerView list;
    private final TextView empty;
    private JSONArray rooms = new JSONArray();

    RoomList(MainActivity a, Parts parts) {
        super(a);
        this.a = a;
        list = new RecyclerView(a);
        list.setLayoutManager(new LinearLayoutManager(a));
        list.setAdapter(new Adapter());
        addView(list, new LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        empty = new TextView(a);
        empty.setGravity(Gravity.CENTER);
        empty.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        empty.setPadding(Ui.dp(a, 32), 0, Ui.dp(a, 32), 0);
        empty.setTextColor(Ui.color(a, "@muted", Color.GRAY));
        empty.setText(a.app().t("rooms.empty"));
        addView(empty, new LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        refresh();
    }

    void refresh() {
        rooms = a.app().rooms.scope();
        empty.setVisibility(rooms.length() == 0 ? VISIBLE : GONE);
        RecyclerView.Adapter<?> ad = list.getAdapter();
        if (ad != null) ad.notifyDataSetChanged();
    }

    @Override public void bindSlot(Expr.Scope scope) { refresh(); }

    private final class Holder extends RecyclerView.ViewHolder {
        final Renderer.Bound bound;
        Holder(Renderer.Bound b) { super(b.root()); bound = b; }
    }

    private final class Adapter extends RecyclerView.Adapter<Holder> {
        @Override public Holder onCreateViewHolder(ViewGroup parent, int type) {
            JSONObject tree = a.app().design().screen("rooms.item");
            Renderer.Bound b = a.renderer().build(tree);
            b.root().setLayoutParams(new RecyclerView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            return new Holder(b);
        }
        @Override public void onBindViewHolder(Holder h, int i) {
            Map<String, Object> s = new HashMap<>();
            s.put("room", rooms.optJSONObject(i));
            h.bound.bind(s::get);
        }
        @Override public int getItemCount() { return rooms.length(); }
    }

    static { View.class.getName(); }
}
