package cz.m5cet.app.ui.parts;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.ViewGroup;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;

import java.util.Collections;
import java.util.List;

import cz.m5cet.app.chat.ChatMessage;
import cz.m5cet.app.ui.Icons;
import cz.m5cet.app.ui.Ui;
import cz.m5cet.app.ui.bubble.BubbleSwipe;
import cz.m5cet.app.ui.look.Look;

/**
 * 6.10: one row of the message list (MessageList): the design's message
 * tree (and a legacy picture) on top, and under it the two icons a sideways
 * drag uncovers — reply under the reading direction's start edge (the
 * bubble moves toward the end to reply), forward under its end edge
 * (BubbleSwipe has the rule). The row follows the drag, the icon grows in
 * and fills with the primary colour once letting go counts, and the row
 * springs back. It also flashes when a quote's tap brought the list here.
 * TalkBack finds reply, forward, the sender's profile and "go to the
 * original" as the row's own actions.
 */
final class BubbleRow extends FrameLayout {
    /** A row action for TalkBack (the swipe's and the taps' alternatives). */
    static final class A11y {
        final String label;
        final Runnable run;
        A11y(String label, Runnable run) { this.label = label; this.run = run; }
    }

    interface A11ySource { List<A11y> of(ChatMessage m); }

    /** Custom accessibility action ids (away from the platform's and the room rows' 0x7E5A01xx). */
    private static final int A11Y_BASE = 0x7E5A0200;

    final LinearLayout content;
    private final FrameLayout under;
    private final ImageView reply, forward;
    private final int iconPx, circlePx;
    private ValueAnimator back, flash;
    private BubbleSwipe.Act lit = BubbleSwipe.Act.NONE;
    private boolean litArmed;
    /** The message the row shows now. */
    ChatMessage msg;
    private A11ySource a11y;

    BubbleRow(Context c, LinearLayout content) {
        super(c);
        this.content = content;
        iconPx = Ui.dp(c, 20);
        circlePx = Ui.dp(c, 36);
        under = new FrameLayout(c);
        under.setVisibility(INVISIBLE);
        under.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        // START / END follow the layout: in a right-to-left one the reply icon is on the right (the bubble moves left to reply).
        reply = icon(c, Gravity.START | Gravity.CENTER_VERTICAL);
        forward = icon(c, Gravity.END | Gravity.CENTER_VERTICAL);
        addView(under, new LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        addView(content, new LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        setAccessibilityDelegate(delegate);
    }

    private ImageView icon(Context c, int gravity) {
        ImageView v = new ImageView(c);
        v.setScaleType(ImageView.ScaleType.CENTER);
        LayoutParams lp = new LayoutParams(circlePx, circlePx, gravity);
        lp.setMarginStart(Ui.dp(c, 16));
        lp.setMarginEnd(Ui.dp(c, 16));
        under.addView(v, lp);
        v.setAlpha(0f);
        return v;
    }

    void setA11y(A11ySource source) { a11y = source; }

    /** The row's height is its content's; the icons only fill it. */
    @Override protected void onMeasure(int wSpec, int hSpec) {
        measureChildWithMargins(content, wSpec, 0, hSpec, 0);
        int w = resolveSize(content.getMeasuredWidth(), wSpec), h = content.getMeasuredHeight();
        under.measure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY));
        setMeasuredDimension(w, h);
    }

    /* ------------------------------------------------------------ drag */

    /** The drag moved: the row follows (px, physical), the icon of `showing` grows in; `armed` = letting go counts. */
    void drag(float offset, BubbleSwipe.Act showing, float progress, boolean armed) {
        stopBack();
        content.setTranslationX(offset);
        under.setVisibility(offset == 0 ? INVISIBLE : VISIBLE);
        if (showing != lit || armed != litArmed) paint(showing, armed);
        ImageView on = showing == BubbleSwipe.Act.REPLY ? reply : showing == BubbleSwipe.Act.FORWARD ? forward : null;
        for (ImageView v : new ImageView[]{reply, forward}) {
            float p = v == on ? progress : 0;
            v.setAlpha(p);
            float s = 0.6f + 0.4f * p;
            v.setScaleX(armed && v == on ? 1.08f : s);
            v.setScaleY(armed && v == on ? 1.08f : s);
        }
    }

    /** The icon's look: tonal while counting up, filled with the primary colour once letting go counts. */
    private void paint(BubbleSwipe.Act showing, boolean armed) {
        lit = showing;
        litArmed = armed;
        Context c = getContext();
        int primary = Ui.color(c, "@primary", Color.BLUE), variant = Ui.color(c, "@surfaceVariant", Color.LTGRAY), onPrimary = Ui.color(c, "@onPrimary", Color.WHITE);
        reply.setImageDrawable(Icons.drawable(c, "reply", iconPx, armed && showing == BubbleSwipe.Act.REPLY ? onPrimary : primary));
        forward.setImageDrawable(Icons.drawable(c, "forward", iconPx, armed && showing == BubbleSwipe.Act.FORWARD ? onPrimary : primary));
        reply.setBackground(Ui.shape(armed && showing == BubbleSwipe.Act.REPLY ? primary : variant, circlePx / 2f, 0, 0));
        forward.setBackground(Ui.shape(armed && showing == BubbleSwipe.Act.FORWARD ? primary : variant, circlePx / 2f, 0, 0));
    }

    /** The tick where letting go starts (or stops) to count — the gesture threshold's own haptic where the phone has one. */
    void tick() {
        if (!Look.haptics()) return;
        performHapticFeedback(Build.VERSION.SDK_INT >= 34 ? HapticFeedbackConstants.GESTURE_THRESHOLD_ACTIVATE : HapticFeedbackConstants.CLOCK_TICK);
    }

    /** Back to its place (animated as the user likes motion). */
    void springBack() {
        stopBack();
        float from = content.getTranslationX();
        long ms = Look.ms(220);
        if (from == 0 || ms <= 0 || Look.still(getContext()) || !isAttachedToWindow()) { rest(); return; }
        back = ValueAnimator.ofFloat(from, 0f);
        back.setDuration(ms);
        back.setInterpolator(Look.easing("decelerate"));
        float a0 = Math.max(reply.getAlpha(), forward.getAlpha());
        back.addUpdateListener(v -> {
            float x = (Float) v.getAnimatedValue();
            content.setTranslationX(x);
            float k = from == 0 ? 0 : x / from;
            reply.setAlpha(Math.min(reply.getAlpha(), a0 * k));
            forward.setAlpha(Math.min(forward.getAlpha(), a0 * k));
        });
        back.addListener(new android.animation.AnimatorListenerAdapter() {
            @Override public void onAnimationEnd(android.animation.Animator a) { if (back == a) rest(); }
        });
        back.start();
    }

    /** At rest at once (a recycled row, a cancel without motion). */
    void rest() {
        stopBack();
        content.setTranslationX(0);
        under.setVisibility(INVISIBLE);
        reply.setAlpha(0f);
        forward.setAlpha(0f);
        lit = BubbleSwipe.Act.NONE;
        litArmed = false;
    }

    private void stopBack() {
        if (back == null) return;
        ValueAnimator b = back;
        back = null;
        b.cancel();
    }

    /* ----------------------------------------------------------- flash */

    /** The quote's tap brought the list here: the row lights up in the primary colour for a moment. */
    void flash() {
        if (flash != null) flash.cancel();
        ColorDrawable d = new ColorDrawable(Ui.alpha(Ui.color(getContext(), "@primary", Color.BLUE), 0.22f));
        content.setForeground(d);
        long ms = Look.ms(1400);
        if (ms <= 0 || Look.still(getContext())) {
            d.setAlpha(255);
            postDelayed(() -> { if (content.getForeground() == d) content.setForeground(null); }, 1200);
            return;
        }
        ValueAnimator f = ValueAnimator.ofFloat(0f, 1f, 1f, 0f);
        f.setDuration(ms);
        f.addUpdateListener(v -> d.setAlpha(Math.round(255 * (Float) v.getAnimatedValue())));
        f.addListener(new android.animation.AnimatorListenerAdapter() {
            @Override public void onAnimationEnd(android.animation.Animator a) { if (content.getForeground() == d) content.setForeground(null); }
        });
        flash = f;
        f.start();
    }

    @Override protected void onDetachedFromWindow() {
        if (flash != null) { flash.cancel(); flash = null; }
        content.setForeground(null);
        rest();
        super.onDetachedFromWindow();
    }

    /* ---------------------------------------------------- accessibility */

    private List<A11y> actions() {
        ChatMessage m = msg;
        return a11y == null || m == null ? Collections.emptyList() : a11y.of(m);
    }

    private final AccessibilityDelegate delegate = new AccessibilityDelegate() {
        @Override public void onInitializeAccessibilityNodeInfo(View host, AccessibilityNodeInfo info) {
            super.onInitializeAccessibilityNodeInfo(host, info);
            List<A11y> all = actions();
            for (int i = 0; i < all.size(); i++) info.addAction(new AccessibilityNodeInfo.AccessibilityAction(A11Y_BASE + i, all.get(i).label));
        }

        @Override public boolean performAccessibilityAction(View host, int action, Bundle args) {
            int i = action - A11Y_BASE;
            List<A11y> all = actions();
            if (i >= 0 && i < all.size()) { all.get(i).run.run(); return true; }
            return super.performAccessibilityAction(host, action, args);
        }
    };
}
