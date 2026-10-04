package cz.m5cet.app.ui.look;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Color;
import android.os.Bundle;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.VelocityTracker;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import cz.m5cet.app.design.Appearance;
import cz.m5cet.app.design.Design;
import cz.m5cet.app.ui.Expr;
import cz.m5cet.app.ui.Icons;
import cz.m5cet.app.ui.Ui;

/**
 * A list row that slides sideways (6.7, the design's "swipe" element; the
 * rooms' rows): dragged to the right it uncovers the actions of its
 * "right" menu at its left edge, dragged to the left those of its "left"
 * menu at its right edge — each an icon over a label (Swipe has the
 * thresholds). A tap on an action runs it and the row springs back; let
 * go short of the actions, or tapped while open, the row springs back too.
 * One row of a list is open at a time. Vertical scrolling stays the
 * list's: the row only takes a drag that is clearly sideways. TalkBack
 * finds the same actions on the row (custom accessibility actions).
 */
public final class SwipeRow extends FrameLayout {
    /** A menu item resolved in the row's scope. */
    public static final class Action {
        public final String icon, label, action;
        public final Object arg;
        Action(String icon, String label, String action, Object arg) { this.icon = icon; this.label = label; this.action = action; this.arg = arg; }
    }

    /** A design colour ("@primary", "#rrggbb") → ARGB. */
    public interface Colors { int of(String value, int fallback); }

    /** Runs an action of the design (the renderer's host). */
    public interface Run { void run(String action, Object arg, View source); }

    /** What the rooms' rows swipe to (RoomList, when the design's rooms.item has no swipe of its own). */
    public static JSONObject roomDefaults() {
        try { return new JSONObject().put("right", "room-swipe-right").put("left", "room-swipe-left").put("rightColor", "@danger").put("leftColor", "@primary"); }
        catch (JSONException e) { return new JSONObject(); }
    }

    /** Custom accessibility action ids (away from the platform's). */
    private static final int A11Y_BASE = 0x7E5A0100;
    private static final int MAX_PER_SIDE = 4;

    /** The row that is open now: a touch on another one closes it. */
    private static WeakReference<SwipeRow> opened = new WeakReference<>(null);

    private final LinearLayout content;
    /** Under the left edge: the "right" menu's actions (uncovered by a drag to the right); under the right edge the "left" menu's. */
    private final LinearLayout underLeft, underRight;
    private List<Action> rightActions = Collections.emptyList(), leftActions = Collections.emptyList();
    private Run run;
    private String signature = "", lookKey = "";
    private final int slop, tileW;
    private final float fling;

    private float offset, downX, downY, startOffset;
    private boolean dragging, tapToClose, wasPastOpen;
    private VelocityTracker tracker;
    private ValueAnimator anim;

    public SwipeRow(Context c) {
        super(c);
        ViewConfiguration vc = ViewConfiguration.get(c);
        slop = vc.getScaledTouchSlop();
        fling = Swipe.FLING_DP * c.getResources().getDisplayMetrics().density;
        tileW = Ui.dp(c, 78);
        underLeft = layer(c, Gravity.LEFT);
        underRight = layer(c, Gravity.RIGHT);
        addView(underLeft, new LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        addView(underRight, new LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        content = new LinearLayout(c);
        content.setOrientation(LinearLayout.VERTICAL);
        addView(content, new LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        setAccessibilityDelegate(a11y);
        setOffset(0);
    }

    private static LinearLayout layer(Context c, int gravity) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.HORIZONTAL);
        // Physical edges: a drag to the right is to the right in every language.
        l.setLayoutDirection(View.LAYOUT_DIRECTION_LTR);
        l.setGravity(gravity | Gravity.CENTER_VERTICAL);
        l.setVisibility(INVISIBLE);
        return l;
    }

    /** The row itself (the element's children go here). */
    public ViewGroup content() { return content; }

    /** The width the actions of a side take (px). */
    private float rightWidth() { return rightActions.size() * tileW; }
    private float leftWidth() { return leftActions.size() * tileW; }

    /* ------------------------------------------------------------- bind */

    /**
     * The row's actions from its props (right / left: menu ids, rightColor /
     * leftColor), resolved in its scope: an item's condition, label and
     * argument see the row's variables. A row that now shows something else
     * (a recycled list row) closes at once.
     */
    public void bind(JSONObject props, Expr.Scope scope, Expr.Translate tr, Design design, Colors colors, Run run) {
        this.run = run;
        JSONObject p = props == null ? new JSONObject() : props;
        rightActions = actions(design, prop(p, "right", scope, tr), scope, tr);
        leftActions = actions(design, prop(p, "left", scope, tr), scope, tr);
        String rc = prop(p, "rightColor", scope, tr), lc = prop(p, "leftColor", scope, tr);
        int right = colors.of(rc.isEmpty() ? "@danger" : rc, Color.RED), left = colors.of(lc.isEmpty() ? "@primary" : lc, Color.BLUE);
        int surface = colors.of("@surface", Color.WHITE), variant = colors.of("@surfaceVariant", Color.LTGRAY), onSurface = colors.of("@onSurface", Color.BLACK);
        content.setBackgroundColor(surface);
        StringBuilder sig = new StringBuilder(), look = new StringBuilder();
        for (List<Action> side : Arrays.asList(rightActions, leftActions)) {
            sig.append('|');
            for (Action a : side) { sig.append(a.action).append('=').append(Expr.toText(a.arg)).append(';'); look.append(a.icon).append(a.label).append(';'); }
        }
        // The tiles run the actions they were made with: made again for another item too.
        look.append(sig).append(right).append(left).append(variant).append(onSurface).append(Appearance.fontScale());
        if (!sig.toString().equals(signature)) { signature = sig.toString(); snap(0); }
        if (!look.toString().equals(lookKey)) {
            lookKey = look.toString();
            tiles(underLeft, rightActions, right, variant, onSurface, true, design);
            tiles(underRight, leftActions, left, variant, onSurface, false, design);
        }
        for (int i = 0; i < content.getChildCount(); i++) content.getChildAt(i).setAccessibilityDelegate(a11y);
        // Fewer actions on the open side now (an item's condition): closed.
        if (!dragging && Math.abs(offset) > (offset > 0 ? rightWidth() : leftWidth())) snap(0);
        setOffset(offset);
    }

    private static String prop(JSONObject props, String key, Expr.Scope scope, Expr.Translate tr) {
        Object v = props.opt(key);
        if (v == null) return "";
        return Expr.toText(v instanceof String ? Expr.value((String) v, scope, tr) : v).trim();
    }

    /** A menu's items for this row (their conditions applied), at most four. */
    static List<Action> actions(Design design, String menuId, Expr.Scope scope, Expr.Translate tr) {
        List<Action> out = new ArrayList<>();
        JSONArray items = design == null || menuId.isEmpty() ? null : design.menus.get(menuId);
        if (items == null) return out;
        for (int i = 0; i < items.length() && out.size() < MAX_PER_SIDE; i++) {
            JSONObject it = items.optJSONObject(i);
            if (it == null || it.optString("action").isEmpty()) continue;
            String cond = it.optString("if", "");
            try {
                if (!cond.isEmpty() && !Expr.truthy(Expr.eval(cond, scope, tr))) continue;
                String arg = it.optString("arg", null);
                out.add(new Action(it.optString("icon", "circle"), Expr.render(it.optString("label"), scope, tr), it.optString("action"), arg == null ? null : Expr.value(arg, scope, tr)));
            } catch (RuntimeException e) {
                cz.m5cet.app.core.Log.w("swipe", menuId + "[" + i + "]: " + e.getMessage());
            }
        }
        return out;
    }

    /**
     * A side's tiles. The one at the very edge is filled with the side's
     * colour, the others are tonal (the surface, the colour's icon) — so a
     * Delete stands out and Clone sits quietly beside Edit. The layer's
     * background continues the tile next to the row (a drag past the
     * actions shows more of it).
     */
    private void tiles(LinearLayout layer, List<Action> actions, int color, int variant, int onSurface, boolean atLeft, Design design) {
        layer.removeAllViews();
        int n = actions.size();
        if (n == 0) { layer.setBackground(null); return; }
        Context c = getContext();
        float scale = Math.min(1.15f, Appearance.fontScale());
        for (int i = 0; i < n; i++) {
            Action a = actions.get(i);
            boolean edge = atLeft ? i == 0 : i == n - 1;
            int bg = edge ? color : variant, fg = edge ? Palette.onColor(color) : color, text = edge ? fg : onSurface;
            LinearLayout t = new LinearLayout(c);
            t.setOrientation(LinearLayout.VERTICAL);
            t.setGravity(Gravity.CENTER);
            t.setPadding(Ui.dp(c, 4), 0, Ui.dp(c, 4), 0);
            t.setBackground(Ui.ripple(Ui.shape(bg, 0, 0, 0), Ui.alpha(fg, 0.22f)));
            ImageView icon = new ImageView(c);
            icon.setImageDrawable(Icons.drawable(c, a.icon, Ui.dp(c, 22), fg));
            icon.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
            t.addView(icon, new LinearLayout.LayoutParams(Ui.dp(c, 24), Ui.dp(c, 24)));
            TextView label = new TextView(c);
            label.setText(a.label);
            label.setTextColor(text);
            label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f * scale);
            label.setTypeface(Ui.labelFace(design));
            label.setSingleLine(true);
            label.setEllipsize(TextUtils.TruncateAt.END);
            label.setGravity(Gravity.CENTER);
            label.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.topMargin = Ui.dp(c, 4);
            t.addView(label, lp);
            t.setContentDescription(a.label);
            t.setClickable(true);
            t.setFocusable(true);
            t.setOnClickListener(v -> { Look.haptic(v, false); animateTo(0); fire(a, this); });
            layer.addView(t, new LinearLayout.LayoutParams(tileW, ViewGroup.LayoutParams.MATCH_PARENT));
        }
        // The tile next to the row continues under it.
        boolean innerIsEdge = n == 1;
        layer.setBackgroundColor(innerIsEdge ? color : variant);
    }

    private void fire(Action a, View source) {
        if (run != null) run.run(a.action, a.arg, source);
    }

    /* ----------------------------------------------------------- layout */

    @Override protected void onMeasure(int wSpec, int hSpec) {
        // The row decides the height; the actions only fill it (a tall tile never makes the row taller).
        measureChildWithMargins(content, wSpec, 0, hSpec, 0);
        int w = resolveSize(content.getMeasuredWidth() + getPaddingLeft() + getPaddingRight(), wSpec);
        int h = MeasureSpec.getMode(hSpec) == MeasureSpec.EXACTLY ? MeasureSpec.getSize(hSpec) : content.getMeasuredHeight() + getPaddingTop() + getPaddingBottom();
        int iw = MeasureSpec.makeMeasureSpec(Math.max(0, w - getPaddingLeft() - getPaddingRight()), MeasureSpec.EXACTLY);
        int ih = MeasureSpec.makeMeasureSpec(Math.max(0, h - getPaddingTop() - getPaddingBottom()), MeasureSpec.EXACTLY);
        underLeft.measure(iw, ih);
        underRight.measure(iw, ih);
        setMeasuredDimension(w, h);
    }

    /* ------------------------------------------------------------ touch */

    private boolean swipeable() { return !rightActions.isEmpty() || !leftActions.isEmpty() || offset != 0; }

    private boolean overRow(float x) {
        float l = content.getLeft() + offset, r = content.getRight() + offset;
        return x >= l && x <= r;
    }

    @Override public boolean onInterceptTouchEvent(MotionEvent e) {
        if (!swipeable()) return false;
        switch (e.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                down(e);
                // An open row: a touch on the row itself closes it (its own click does not run); the actions keep theirs.
                tapToClose = offset != 0 && overRow(e.getX());
                return tapToClose;
            case MotionEvent.ACTION_MOVE:
                track(e);
                return startDrag(e);
            default:
                return false;
        }
    }

    @Override public boolean onTouchEvent(MotionEvent e) {
        if (!swipeable()) return super.onTouchEvent(e);
        switch (e.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                if (!tapToClose) { down(e); tapToClose = offset != 0; }
                return true;
            case MotionEvent.ACTION_MOVE:
                track(e);
                if (startDrag(e)) {
                    float to = Swipe.clamp(startOffset + e.getX() - downX, rightWidth(), leftWidth());
                    boolean past = Swipe.pastOpen(to, rightWidth(), leftWidth());
                    if (past != wasPastOpen) { wasPastOpen = past; if (past) Look.haptic(this, false); }
                    setOffset(to);
                }
                return true;
            case MotionEvent.ACTION_UP:
                track(e);
                if (dragging) {
                    tracker.computeCurrentVelocity(1000);
                    animateTo(Swipe.settle(offset, tracker.getXVelocity(), fling, rightWidth(), leftWidth()));
                } else if (offset != 0) {
                    animateTo(0);
                }
                end();
                return true;
            case MotionEvent.ACTION_CANCEL:
                if (dragging || offset != 0) animateTo(Swipe.settle(offset, 0, 0, rightWidth(), leftWidth()));
                end();
                return true;
            default:
                return true;
        }
    }

    private void down(MotionEvent e) {
        stopAnim();
        downX = e.getX();
        downY = e.getY();
        startOffset = offset;
        dragging = false;
        wasPastOpen = Swipe.pastOpen(offset, rightWidth(), leftWidth());
        if (tracker != null) tracker.recycle();
        tracker = VelocityTracker.obtain();
        track(e);
        SwipeRow other = opened.get();
        if (other != null && other != this) other.animateTo(0);
    }

    private void track(MotionEvent e) {
        if (tracker == null) return;
        // The tracker wants the row's own coordinates; the content's move does not shift them (the row stays put).
        tracker.addMovement(e);
    }

    /** Is this gesture (now) a sideways drag of the row? Takes it from the list once it is. */
    private boolean startDrag(MotionEvent e) {
        if (dragging) return true;
        float dx = e.getX() - downX, dy = e.getY() - downY;
        if (!Swipe.claims(dx, dy, slop, startOffset, rightWidth(), leftWidth())) return false;
        dragging = true;
        tapToClose = false;
        downX += dx > 0 ? slop : -slop; // no jump by the slop
        ViewParent p = getParent();
        if (p != null) p.requestDisallowInterceptTouchEvent(true);
        return true;
    }

    private void end() {
        dragging = false;
        tapToClose = false;
        if (tracker != null) { tracker.recycle(); tracker = null; }
    }

    /* ------------------------------------------------------------ motion */

    private void stopAnim() {
        if (anim != null) { anim.cancel(); anim = null; }
    }

    /** Opens on a side (± its actions' width) or closes (0), the way the user likes motion. */
    void animateTo(float target) {
        stopAnim();
        if (target != 0) opened = new WeakReference<>(this);
        else if (opened.get() == this) opened = new WeakReference<>(null);
        long ms = Look.ms(240);
        if (ms <= 0 || Look.still(getContext()) || !isAttachedToWindow() || target == offset) { setOffset(target); return; }
        anim = ValueAnimator.ofFloat(offset, target);
        anim.setDuration(ms);
        anim.setInterpolator(Look.easing("decelerate"));
        anim.addUpdateListener(v -> setOffset((Float) v.getAnimatedValue()));
        anim.start();
    }

    /** Closes at once (a recycled row that shows another item now). */
    private void snap(float to) {
        stopAnim();
        if (opened.get() == this && to == 0) opened = new WeakReference<>(null);
        setOffset(to);
    }

    /** Closes the row (animated): e.g. when its list goes away. */
    public void close() { if (offset != 0) animateTo(0); }

    private void setOffset(float v) {
        offset = v;
        content.setTranslationX(v);
        content.setElevation(v == 0 ? 0 : Ui.dp(getContext(), 2));
        underLeft.setVisibility(v > 0 ? VISIBLE : INVISIBLE);
        underRight.setVisibility(v < 0 ? VISIBLE : INVISIBLE);
        reveal(underLeft, Swipe.progress(v > 0 ? v : 0, rightWidth()));
        reveal(underRight, Swipe.progress(v < 0 ? v : 0, leftWidth()));
    }

    /** The actions' icons fade and grow in as they are uncovered. */
    private static void reveal(LinearLayout layer, float p) {
        float a = 0.35f + 0.65f * p, s = 0.7f + 0.3f * p;
        for (int i = 0; i < layer.getChildCount(); i++) {
            View tile = layer.getChildAt(i);
            if (!(tile instanceof ViewGroup) || ((ViewGroup) tile).getChildCount() == 0) continue;
            View icon = ((ViewGroup) tile).getChildAt(0);
            icon.setAlpha(a);
            icon.setScaleX(s);
            icon.setScaleY(s);
        }
    }

    @Override protected void onDetachedFromWindow() {
        stopAnim();
        if (offset != 0) setOffset(0);
        if (opened.get() == this) opened = new WeakReference<>(null);
        super.onDetachedFromWindow();
    }

    /* ---------------------------------------------------- accessibility */

    private List<Action> all() {
        List<Action> out = new ArrayList<>(rightActions);
        out.addAll(leftActions);
        return out;
    }

    /** The swipe's actions as the row's own (TalkBack › Actions), on the row and on what it holds. */
    private final AccessibilityDelegate a11y = new AccessibilityDelegate() {
        @Override public void onInitializeAccessibilityNodeInfo(View host, AccessibilityNodeInfo info) {
            super.onInitializeAccessibilityNodeInfo(host, info);
            List<Action> all = all();
            for (int i = 0; i < all.size(); i++) info.addAction(new AccessibilityNodeInfo.AccessibilityAction(A11Y_BASE + i, all.get(i).label));
        }

        @Override public boolean performAccessibilityAction(View host, int action, Bundle args) {
            int i = action - A11Y_BASE;
            List<Action> all = all();
            if (i >= 0 && i < all.size()) { snap(0); fire(all.get(i), host); return true; }
            return super.performAccessibilityAction(host, action, args);
        }
    };
}
