package cz.m5cet.app.ui.parts;

import android.annotation.SuppressLint;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.drawable.RippleDrawable;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewGroup;
import android.view.ViewParent;

import org.json.JSONObject;

import cz.m5cet.app.chat.ChatMessage;
import cz.m5cet.app.ui.Expr;
import cz.m5cet.app.ui.MainActivity;
import cz.m5cet.app.ui.Renderer;
import cz.m5cet.app.ui.Ui;
import cz.m5cet.app.ui.bubble.HoldGesture;
import cz.m5cet.app.ui.look.Look;

/**
 * The hold area beside a bubble (6.7, slot "msgHold" in message.in / .out):
 * the empty part of the row next to a hold-to-read ("tap") bubble reveals
 * it while held — as holding its chip does — so a short text is not under
 * the finger. A short hold first (HoldGesture): a scroll or a swipe that
 * starts here goes to the list and reveals nothing; once revealed, the list
 * leaves the finger alone until it lifts. The same ripple and long-press
 * tick as the other held controls.
 *
 * The design decides where it is and whether (the node's "if", by default
 * $msg.tap) and how wide: its weight takes the free part of the row, its
 * style.maxWidth (dp) caps it.
 */
final class HoldArea extends View implements Renderer.Slot {
    private final Parts parts;
    private final HoldGesture gesture;
    private final int maxWidth;
    private ChatMessage current, heldMsg;
    private MsgBody held;
    private int rippleFg;
    private final Runnable check = this::due;

    HoldArea(MainActivity a, Parts parts, Renderer.Bound bound) {
        super(a);
        this.parts = parts;
        gesture = new HoldGesture(HoldGesture.DELAY_MS, ViewConfiguration.get(a).getScaledTouchSlop());
        JSONObject style = bound == null ? null : bound.node.optJSONObject("style");
        double max = style == null ? 0 : style.optDouble("maxWidth", 0);
        maxWidth = max > 0 ? Ui.dp(a, (float) max) : 0;
        // The chip is the accessible way to reveal; this is only a larger target for a finger.
        setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
    }

    @Override public void bindSlot(Expr.Scope scope) {
        Object o = scope.get("_msg");
        ChatMessage m = o instanceof ChatMessage ? (ChatMessage) o : null;
        if (m != current) release();
        current = m;
        int fg = Ui.color(getContext(), "@onSurface", Color.BLACK);
        if (fg != rippleFg || getBackground() == null) {
            rippleFg = fg;
            setBackground(new RippleDrawable(ColorStateList.valueOf(Ui.alpha(fg, 0.12f)), null, Ui.shape(Color.WHITE, Ui.dp(getContext(), 16), 0, 0)));
        }
    }

    /** A message this area can reveal now: hold-to-read, not gone, not sealed shut. */
    private boolean holdable() {
        ChatMessage m = current;
        return m != null && m.tap && !m.vanished && !"sys".equals(m.kind) && (m.sealed == null || m.sealPlain != null);
    }

    @Override protected void onMeasure(int wSpec, int hSpec) {
        super.onMeasure(wSpec, hSpec);
        if (maxWidth > 0 && getMeasuredWidth() > maxWidth) setMeasuredDimension(maxWidth, getMeasuredHeight());
    }

    @SuppressLint("ClickableViewAccessibility")
    @Override public boolean onTouchEvent(MotionEvent e) {
        switch (e.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                if (!holdable()) return false;
                gesture.down(e.getX(), e.getY(), e.getEventTime());
                drawableHotspotChanged(e.getX(), e.getY());
                postDelayed(check, HoldGesture.DELAY_MS);
                return true;
            case MotionEvent.ACTION_MOVE:
                if (gesture.revealed()) drawableHotspotChanged(e.getX(), e.getY());
                else if (gesture.move(e.getX(), e.getY()) == HoldGesture.Step.CANCEL) removeCallbacks(check);
                return true;
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
                release();
                return true;
            default:
                return true;
        }
    }

    /** The delay passed with the finger still here: reveal. */
    private void due() {
        if (gesture.due(android.os.SystemClock.uptimeMillis()) != HoldGesture.Step.REVEAL || !holdable()) return;
        ViewParent p = getParent();
        if (p != null) p.requestDisallowInterceptTouchEvent(true); // the list does not scroll it away now
        setPressed(true);
        Look.haptic(this, true);
        heldMsg = current;
        held = body();
        if (held != null) held.hold(heldMsg, true);
    }

    private void release() {
        removeCallbacks(check);
        if (gesture.up() == HoldGesture.Step.HIDE) {
            if (held != null) held.hold(heldMsg, false);
            else if (heldMsg != null) parts.holding.remove(heldMsg.id);
        }
        held = null;
        heldMsg = null;
        setPressed(false);
    }

    @Override protected void onDetachedFromWindow() { release(); super.onDetachedFromWindow(); }

    /** The body of this row's bubble (the row is the list's item: up to it, then down to its MsgBody). */
    private MsgBody body() {
        View row = this;
        while (row.getParent() instanceof View && !(row.getParent() instanceof androidx.recyclerview.widget.RecyclerView)) row = (View) row.getParent();
        return find(row);
    }

    private MsgBody find(View v) {
        if (v instanceof MsgBody) return ((MsgBody) v).showing(current) ? (MsgBody) v : null;
        if (!(v instanceof ViewGroup)) return null;
        ViewGroup g = (ViewGroup) v;
        for (int i = 0; i < g.getChildCount(); i++) { MsgBody b = find(g.getChildAt(i)); if (b != null) return b; }
        return null;
    }
}
