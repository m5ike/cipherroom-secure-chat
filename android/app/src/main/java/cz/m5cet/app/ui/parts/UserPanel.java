package cz.m5cet.app.ui.parts;

import android.annotation.SuppressLint;
import android.graphics.Color;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;

import cz.m5cet.app.R;
import cz.m5cet.app.chat.RoomSession;
import cz.m5cet.app.ui.Expr;
import cz.m5cet.app.ui.MainActivity;
import cz.m5cet.app.ui.Renderer;
import cz.m5cet.app.ui.Ui;

/**
 * The people of the room in a panel that floats (drag it by its header) or
 * docks to the left, right or bottom edge. Docked, it can be pinned or set
 * to hide itself: it slides into its edge and leaves the design's
 * "users.handle" tab there; a tap slides it back out, and it tucks away again
 * after a few seconds without a touch or on a tap outside. The trees
 * ("users", "users.item", "users.handle") and the timing (animations.users)
 * come from the design.
 *
 * 6.2: the people as the web's recipients widget shows them — avatar, status,
 * signal, a checkbox for who gets the next message, "Vybrat vše" / "Zrušit
 * výběr" — and a tap opens a person's detail (People).
 */
final class UserPanel extends FrameLayout implements Renderer.Slot {
    private static final long HIDE_AFTER = 5000;
    private final MainActivity a;
    private final Renderer.Bound panel, handle;
    private final FrameLayout panelBox;
    private boolean revealed = false;
    private final Runnable hideLater = this::tuck;

    UserPanel(MainActivity a, Parts parts) {
        super(a);
        this.a = a;
        setClipChildren(false);
        panel = a.renderer().build(a.app().design().screen("users"));
        panelBox = new FrameLayout(a);
        panelBox.addView(panel.root(), new LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        addView(panelBox);
        handle = a.renderer().build(a.app().design().screen("users.handle"));
        View h = handle.root();
        h.setOnClickListener(v -> reveal());
        addView(h, new LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        installDrag();
        a.parts.userPanel = this;
        refresh();
    }

    JSONObject state() { return a.app().config.usersPanel(); }

    private void save(JSONObject s) { a.app().config.saveUsersPanel(s); }

    private void put(String k, Object v) {
        JSONObject s = state();
        try { s.put(k, v); } catch (JSONException ignored) { }
        save(s);
    }

    void toggle() { put("open", !state().optBoolean("open")); revealed = true; refresh(); a.refresh(); }

    void dock(String edge) {
        put("dock", edge);
        if (edge.equals("none")) put("autoHide", false);
        put("open", true);
        revealed = true;
        refresh();
        a.refresh();
    }

    void autoHide(Boolean on) {
        boolean v = on == null ? !state().optBoolean("autoHide") : on;
        if ("none".equals(state().optString("dock"))) v = false;
        put("autoHide", v);
        revealed = !v;
        refresh();
        if (v) postDelayed(hideLater, 800);
    }

    /**
     * The panel's scope. 6.2: each person as the web's recipients widget shows
     * them (People.users: status, signal, avatar, selection, contact link) and
     * the selection's summary for the last row ("Vybrat vše" / "Zrušit výběr").
     */
    private Map<String, Object> scope() {
        RoomSession r = a.app().rooms.activeSession();
        JSONArray users = a.parts.people().users(r);
        int selectable = 0, selected = 0;
        for (int i = 0; i < users.length(); i++) {
            JSONObject u = users.optJSONObject(i);
            if (u.optBoolean("selectable")) selectable++;
            if (u.optBoolean("selected")) selected++;
        }
        JSONObject s = state();
        Map<String, Object> m = new HashMap<>();
        m.put("users", users);
        m.put("count", (double) users.length());
        m.put("selectable", (double) selectable);
        m.put("selectedCount", (double) selected);
        m.put("allSelected", selectable > 0 && selected == selectable);
        m.put("dock", s.optString("dock", "right"));
        m.put("autoHide", s.optBoolean("autoHide"));
        m.put("edge", s.optString("dock", "right"));
        m.put("open", revealed);
        return m;
    }

    void refresh() {
        JSONObject s = state();
        boolean open = s.optBoolean("open");
        setVisibility(open ? VISIBLE : GONE);
        if (!open) return;
        Map<String, Object> sc = scope();
        panel.bind(sc::get);
        handle.bind(sc::get);
        layoutPanel(false);
        if (!ticking && isAttachedToWindow()) { ticking = true; postDelayed(statsTick, 1000); }
    }

    /* ------------------------------------------------ signal (6.2) */

    /** While the panel is shown, the peers' connection statistics are read every few seconds (the signal bars). */
    private boolean ticking = false, refreshQueued = false;
    private final Runnable statsTick = new Runnable() {
        @Override public void run() {
            RoomSession r = a.app().rooms.activeSession();
            boolean shown = isAttachedToWindow() && getVisibility() == VISIBLE && (revealed || !state().optBoolean("autoHide"));
            if (!isAttachedToWindow() || getVisibility() != VISIBLE) { ticking = false; return; }
            if (shown && r != null) r.refreshStats(() -> post(UserPanel.this::refreshSoon));
            postDelayed(this, 3000);
        }
    };

    /** One rebind for the readings that arrive together (the panel stays where it is, mid-slide too). */
    private void refreshSoon() {
        if (refreshQueued) return;
        refreshQueued = true;
        postDelayed(() -> {
            refreshQueued = false;
            if (getVisibility() != VISIBLE) return;
            Map<String, Object> sc = scope();
            panel.bind(sc::get);
            handle.bind(sc::get);
        }, 200);
    }

    @Override protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        if (!ticking && getVisibility() == VISIBLE) { ticking = true; postDelayed(statsTick, 1000); }
    }

    @Override protected void onDetachedFromWindow() {
        removeCallbacks(statsTick);
        ticking = false;
        super.onDetachedFromWindow();
    }

    private void layoutPanel(boolean animate) {
        JSONObject s = state();
        String dock = s.optString("dock", "right");
        boolean hide = s.optBoolean("autoHide") && !dock.equals("none");
        int w = Ui.dp(getContext(), 264);
        LayoutParams lp;
        LayoutParams hl;
        switch (dock) {
            case "left":
                lp = new LayoutParams(w, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.START);
                lp.setMargins(Ui.dp(getContext(), 6), Ui.dp(getContext(), 8), 0, 0);
                hl = new LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER_VERTICAL | Gravity.START);
                break;
            case "bottom":
                lp = new LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM);
                lp.setMargins(Ui.dp(getContext(), 6), 0, Ui.dp(getContext(), 6), Ui.dp(getContext(), 6));
                hl = new LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
                break;
            case "none": {
                lp = new LayoutParams(w, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.START);
                int x = s.optInt("x", -1), y = s.optInt("y", -1);
                lp.leftMargin = x < 0 ? Math.max(0, getWidth() - w - Ui.dp(getContext(), 12)) : x;
                lp.topMargin = y < 0 ? Ui.dp(getContext(), 12) : y;
                hl = new LayoutParams(0, 0);
                break;
            }
            default:
                lp = new LayoutParams(w, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.END);
                lp.setMargins(0, Ui.dp(getContext(), 8), Ui.dp(getContext(), 6), 0);
                hl = new LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER_VERTICAL | Gravity.END);
        }
        panelBox.setLayoutParams(lp);
        handle.root().setLayoutParams(hl);
        handle.root().setVisibility(hide ? VISIBLE : GONE);
        int maxH = dock.equals("bottom") ? (int) (getHeight() * 0.45f) : (int) (getHeight() * 0.8f);
        if (maxH > 0) panelBox.getLayoutParams().height = Math.min(ViewGroup.LayoutParams.WRAP_CONTENT == -2 ? maxH : maxH, maxH);
        panelBox.getLayoutParams().height = ViewGroup.LayoutParams.WRAP_CONTENT;
        float tx = 0, ty = 0;
        if (hide && !revealed) {
            int pw = panelBox.getWidth() > 0 ? panelBox.getWidth() : w;
            int ph = panelBox.getHeight() > 0 ? panelBox.getHeight() : Ui.dp(getContext(), 240);
            if (dock.equals("left")) tx = -(pw + Ui.dp(getContext(), 12));
            else if (dock.equals("bottom")) ty = ph + Ui.dp(getContext(), 12);
            else tx = pw + Ui.dp(getContext(), 12);
        }
        JSONObject spec = a.app().design().anim("users");
        if (animate && !Ui.reducedMotion(getContext())) {
            panelBox.animate().translationX(tx).translationY(ty).setDuration(spec.optLong("ms", 240)).setInterpolator(Ui.easing(spec.optString("easing", "decelerate"))).start();
            handle.root().animate().alpha(revealed ? 0f : 1f).setDuration(spec.optLong("ms", 240)).start();
        } else {
            panelBox.setTranslationX(tx);
            panelBox.setTranslationY(ty);
            handle.root().setAlpha(revealed ? 0f : 1f);
        }
        requestLayout();
    }

    private void reveal() {
        revealed = true;
        refreshBound();
        layoutPanel(true);
        removeCallbacks(hideLater);
        postDelayed(hideLater, HIDE_AFTER);
    }

    private void tuck() {
        JSONObject s = state();
        if (!s.optBoolean("autoHide") || "none".equals(s.optString("dock"))) return;
        revealed = false;
        refreshBound();
        layoutPanel(true);
    }

    private void refreshBound() {
        Map<String, Object> sc = scope();
        handle.bind(sc::get);
    }

    @Override
    public boolean dispatchTouchEvent(MotionEvent e) {
        if (e.getActionMasked() == MotionEvent.ACTION_DOWN && revealed && state().optBoolean("autoHide")) {
            float x = e.getX(), y = e.getY();
            boolean inside = x >= panelBox.getX() && x <= panelBox.getX() + panelBox.getWidth() && y >= panelBox.getY() && y <= panelBox.getY() + panelBox.getHeight();
            removeCallbacks(hideLater);
            if (!inside) post(this::tuck);
            else postDelayed(hideLater, HIDE_AFTER);
        }
        return super.dispatchTouchEvent(e);
    }

    @SuppressLint("ClickableViewAccessibility")
    private void installDrag() {
        final float[] start = new float[4];
        final boolean[] dragging = {false};
        panelBox.setOnTouchListener((v, e) -> {
            if (!"none".equals(state().optString("dock"))) return false;
            switch (e.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    start[0] = e.getRawX(); start[1] = e.getRawY();
                    start[2] = ((LayoutParams) panelBox.getLayoutParams()).leftMargin; start[3] = ((LayoutParams) panelBox.getLayoutParams()).topMargin;
                    dragging[0] = e.getY() < Ui.dp(getContext(), 48);
                    return dragging[0];
                case MotionEvent.ACTION_MOVE:
                    if (!dragging[0]) return false;
                    LayoutParams lp = (LayoutParams) panelBox.getLayoutParams();
                    lp.leftMargin = (int) Math.max(0, Math.min(getWidth() - panelBox.getWidth(), start[2] + e.getRawX() - start[0]));
                    lp.topMargin = (int) Math.max(0, Math.min(getHeight() - panelBox.getHeight(), start[3] + e.getRawY() - start[1]));
                    panelBox.setLayoutParams(lp);
                    return true;
                case MotionEvent.ACTION_UP: case MotionEvent.ACTION_CANCEL:
                    if (!dragging[0]) return false;
                    dragging[0] = false;
                    LayoutParams done = (LayoutParams) panelBox.getLayoutParams();
                    int snap = Ui.dp(getContext(), 48);
                    // Dropped near an edge: docks there (as on the web).
                    if (done.leftMargin < snap) { dock("left"); return true; }
                    if (done.leftMargin + panelBox.getWidth() > getWidth() - snap) { dock("right"); return true; }
                    if (done.topMargin + panelBox.getHeight() > getHeight() - snap) { dock("bottom"); return true; }
                    JSONObject s = state();
                    try { s.put("x", done.leftMargin).put("y", done.topMargin); } catch (JSONException ignored) { }
                    save(s);
                    return true;
                default: return false;
            }
        });
    }

    @Override protected void onSizeChanged(int w, int h, int ow, int oh) { super.onSizeChanged(w, h, ow, oh); post(() -> layoutPanel(false)); }

    @Override public void bindSlot(Expr.Scope scope) { refresh(); }

    /** The list of people inside the panel: one "users.item" tree per person. */
    static final class List extends ScrollView implements Renderer.Slot {
        private final MainActivity a;
        private final LinearLayout box;

        List(MainActivity a, Parts parts) {
            super(a);
            this.a = a;
            box = new LinearLayout(a);
            box.setOrientation(LinearLayout.VERTICAL);
            addView(box);
            setBackgroundColor(Color.TRANSPARENT);
        }

        @Override protected void onMeasure(int w, int h) {
            super.onMeasure(w, MeasureSpec.makeMeasureSpec(Ui.dp(getContext(), 360), MeasureSpec.AT_MOST));
        }

        @Override public void bindSlot(Expr.Scope scope) {
            Object users = scope.get("users");
            JSONArray list = users instanceof JSONArray ? (JSONArray) users : new JSONArray();
            JSONObject tree = a.app().design().screen("users.item");
            while (box.getChildCount() > list.length()) box.removeViewAt(box.getChildCount() - 1);
            for (int i = 0; i < list.length(); i++) {
                Renderer.Bound b;
                if (i < box.getChildCount()) b = (Renderer.Bound) box.getChildAt(i).getTag(R.id.m5_bound);
                else {
                    b = a.renderer().build(tree);
                    b.root().setTag(R.id.m5_bound, b);
                    box.addView(b.root(), new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
                }
                Map<String, Object> s = new HashMap<>();
                s.put("user", list.optJSONObject(i));
                b.bind(s::get);
            }
        }
    }
}
