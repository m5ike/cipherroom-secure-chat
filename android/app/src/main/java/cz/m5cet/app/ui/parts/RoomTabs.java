package cz.m5cet.app.ui.parts;

import android.graphics.Color;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.List;

import cz.m5cet.app.chat.RoomSession;
import cz.m5cet.app.ui.Expr;
import cz.m5cet.app.ui.MainActivity;
import cz.m5cet.app.ui.Renderer;
import cz.m5cet.app.ui.Ui;

/**
 * The connected rooms as a bar of tabs (most recent activity first) with
 * unread counts; a tap switches, a long press disconnects. Swiping the
 * message list left/right also moves between these rooms (MessageList).
 */
final class RoomTabs extends HorizontalScrollView implements Renderer.Slot {
    private final MainActivity a;
    private final LinearLayout row;

    RoomTabs(MainActivity a, Parts parts) {
        super(a);
        this.a = a;
        setHorizontalScrollBarEnabled(false);
        row = new LinearLayout(a);
        row.setPadding(Ui.dp(a, 8), Ui.dp(a, 6), Ui.dp(a, 8), Ui.dp(a, 6));
        addView(row);
        refresh();
    }

    void refresh() {
        row.removeAllViews();
        List<RoomSession> rooms = a.app().rooms.connectedSessions();
        String active = a.app().rooms.active();
        int primary = Ui.color(getContext(), "@primary", Color.RED);
        int fg = Ui.color(getContext(), "@onSurface", Color.BLACK);
        for (RoomSession r : rooms) {
            boolean on = r.key.equals(active);
            TextView t = new TextView(getContext());
            String badge = r.unread() > 0 ? "  " + (r.unread() > 99 ? "99+" : r.unread()) : "";
            t.setText(r.label + badge);
            t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            t.setGravity(Gravity.CENTER);
            t.setTypeface(Ui.typeface(a.app().design(), on || r.unread() > 0, false));
            t.setTextColor(on ? primary : fg);
            t.setPadding(Ui.dp(getContext(), 14), Ui.dp(getContext(), 7), Ui.dp(getContext(), 14), Ui.dp(getContext(), 7));
            t.setBackground(Ui.ripple(Ui.shape(on ? Ui.alpha(primary, 0.14f) : Color.TRANSPARENT, Ui.dp(getContext(), 18), Ui.dp(getContext(), 1), on ? primary : Ui.color(getContext(), "@border", Color.LTGRAY)), Ui.alpha(primary, 0.2f)));
            if (!r.connected()) t.setAlpha(0.55f);
            t.setOnClickListener(v -> a.goRoom(r.key));
            t.setOnLongClickListener(v -> { a.app().rooms.leave(r.key); return true; });
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            lp.setMargins(0, 0, Ui.dp(getContext(), 6), 0);
            row.addView(t, lp);
        }
    }

    @Override public void bindSlot(Expr.Scope scope) { refresh(); }
}
