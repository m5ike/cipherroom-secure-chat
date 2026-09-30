package cz.m5cet.app.ui.look;

import android.content.Context;
import android.graphics.Color;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import org.json.JSONObject;

import java.util.Map;

import cz.m5cet.app.design.Design;
import cz.m5cet.app.ui.Expr;
import cz.m5cet.app.ui.Renderer;
import cz.m5cet.app.ui.Ui;

/**
 * How a sheet of the design shows (6.2, Parts.showSheet). The root of its
 * tree (a "sheet" element) says it in its props:
 *  - present: "sheet" — 6.1's card from the bottom over a scrim — or
 *    "dock": a compact card floating just above the composer, no scrim; a
 *    tap outside closes it and still reaches what was tapped (an
 *    expression may choose, e.g. by the look.toolsDock setting);
 *  - dismissOnAction: the sheet fades away before any action its elements
 *    run (a tool was picked).
 * Back closes either (MainActivity asks Parts.closeOverlay first).
 */
public final class Sheets {
    private Sheets() {}

    /** The dock a tap outside just closed, and when: the same tap on the dock's own button must not open it again. */
    private static String closedByTap = "";
    private static long closedAt;

    private static Object prop(JSONObject tree, String key, Expr.Scope scope, Expr.Translate tr) {
        JSONObject props = tree.optJSONObject("props");
        if (props == null || !props.has(key)) return null;
        Object v = props.opt(key);
        return v instanceof String ? Expr.value((String) v, scope, tr) : v;
    }

    public static boolean dock(JSONObject tree, Expr.Scope scope, Expr.Translate tr) {
        return "dock".equals(Expr.toText(prop(tree, "present", scope, tr)));
    }

    public static boolean dismissOnAction(JSONObject tree, Expr.Scope scope, Expr.Translate tr) {
        return Expr.truthy(prop(tree, "dismissOnAction", scope, tr));
    }

    /** true: the dock of this screen was closed by the very tap that now asks for it — leave it closed (a toggle). */
    public static boolean justClosed(String screenId) {
        return screenId.equals(closedByTap) && System.currentTimeMillis() - closedAt < 400;
    }

    /** A host for the sheet's elements that closes the sheet before it passes an action on. */
    public static Renderer.Host dismissing(Renderer.Host base, Runnable close) {
        return new Renderer.Host() {
            @Override public Design design() { return base.design(); }
            @Override public boolean dark() { return base.dark(); }
            @Override public Expr.Translate tr() { return base.tr(); }
            @Override public void action(String action, Object arg, Expr.Scope scope, View source) { close.run(); base.action(action, arg, scope, source); }
            @Override public View slot(String name, Renderer.Bound bound) { return base.slot(name, bound); }
            @Override public Map<String, Object> form() { return base.form(); }
            @Override public Object setting(String key) { return base.setting(key); }
            @Override public void setSetting(String key, Object value) { base.setSetting(key, value); }
        };
    }

    /**
     * Puts the content into the overlay as a sheet or a dock and animates it
     * in; returns the layer to remove later (hide).
     *   anchor  what the dock floats above (the composer), or null
     */
    public static View show(FrameLayout overlay, String screenId, View content, boolean dock, View anchor, JSONObject dialogAnim, Runnable close) {
        Context c = overlay.getContext();
        content.setClickable(true);
        int margin = Ui.dp(c, dock ? 12 : 8);
        int free = overlay.getWidth() - overlay.getPaddingLeft() - overlay.getPaddingRight();
        int max = Ui.dp(c, dock ? 440 : 560);
        int width = free > 0 ? Math.min(free - 2 * margin, max) : ViewGroup.LayoutParams.MATCH_PARENT;
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(width, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        lp.setMargins(margin, 0, margin, margin);
        if (content.getBackground() == null) content.setBackground(Ui.shape(Ui.color(c, "@surface", Color.WHITE), Ui.dp(c, dock ? 22 : 24), 0, 0));
        content.setElevation(Ui.dp(c, dock ? 10 : 12));
        content.setClipToOutline(true);
        FrameLayout layer;
        if (dock) {
            lp.bottomMargin = above(overlay, anchor) + Ui.dp(c, 8);
            layer = new FrameLayout(c) {
                @Override public boolean dispatchTouchEvent(MotionEvent e) {
                    // Outside the dock: close it and let the touch through to the screen below.
                    if (e.getActionMasked() == MotionEvent.ACTION_DOWN && !inside(content, e)) {
                        closedByTap = screenId;
                        closedAt = System.currentTimeMillis();
                        close.run();
                        return false;
                    }
                    return super.dispatchTouchEvent(e);
                }
            };
        } else {
            layer = new FrameLayout(c);
            layer.setBackgroundColor(Ui.color(c, "@scrim", 0x99000000));
            layer.setOnClickListener(v -> close.run());
        }
        layer.addView(content, lp);
        overlay.addView(layer, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        long ms = Look.ms(dialogAnim.optLong("ms", 220));
        if (ms == 0 || Ui.reducedMotion(c)) return layer;
        float k = Look.travel();
        content.setAlpha(0f);
        content.setTranslationY(Ui.dp(c, (dock ? 16 : 40) * k));
        if (!dock) { layer.setAlpha(0f); layer.animate().alpha(1f).setDuration(ms).start(); }
        // Once laid out: the dock grows from its bottom edge (towards the composer it came from).
        android.view.ViewTreeObserver.OnPreDrawListener[] once = new android.view.ViewTreeObserver.OnPreDrawListener[1];
        once[0] = () -> {
            content.getViewTreeObserver().removeOnPreDrawListener(once[0]);
            if (dock) {
                content.setPivotX(content.getWidth() / 2f);
                content.setPivotY(content.getHeight());
                content.setScaleX(1 - 0.05f * k);
                content.setScaleY(1 - 0.05f * k);
            }
            content.animate().alpha(1f).translationY(0).scaleX(1f).scaleY(1f).setDuration(ms).setInterpolator(Look.easing(dialogAnim.optString("easing", "decelerate"))).start();
            return true;
        };
        content.getViewTreeObserver().addOnPreDrawListener(once[0]);
        return layer;
    }

    /** Fades the layer away (the dock sinks a little) and removes it. */
    public static void hide(FrameLayout overlay, View layer) {
        long ms = Look.ms(160);
        View content = layer instanceof ViewGroup && ((ViewGroup) layer).getChildCount() > 0 ? ((ViewGroup) layer).getChildAt(0) : null;
        if (ms == 0) { overlay.removeView(layer); return; }
        if (content != null) content.animate().translationY(Ui.dp(overlay.getContext(), 8 * Look.travel())).setDuration(ms).start();
        layer.animate().alpha(0f).setDuration(ms).withEndAction(() -> overlay.removeView(layer)).start();
    }

    /** How far above the overlay's bottom the anchor's top is (0 without an anchor on screen). */
    private static int above(FrameLayout overlay, View anchor) {
        if (anchor == null || !anchor.isAttachedToWindow() || anchor.getVisibility() != View.VISIBLE || anchor.getHeight() == 0) return Ui.dp(overlay.getContext(), 8);
        int[] o = new int[2], a = new int[2];
        overlay.getLocationInWindow(o);
        anchor.getLocationInWindow(a);
        int bottom = o[1] + overlay.getHeight() - overlay.getPaddingBottom();
        return Math.max(0, bottom - a[1]);
    }

    private static boolean inside(View v, MotionEvent e) {
        int[] at = new int[2];
        v.getLocationOnScreen(at);
        float x = e.getRawX(), y = e.getRawY();
        return x >= at[0] && x < at[0] + v.getWidth() && y >= at[1] && y < at[1] + v.getHeight();
    }
}
