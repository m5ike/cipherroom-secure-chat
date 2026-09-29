package cz.m5cet.app.ui.parts;

import android.graphics.Color;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.widget.GridLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import cz.m5cet.app.ui.Expr;
import cz.m5cet.app.ui.Icons;
import cz.m5cet.app.ui.MainActivity;
import cz.m5cet.app.ui.Renderer;
import cz.m5cet.app.ui.Ui;

/**
 * The PIN pad: dots for the typed digits, a 3×4 keypad, delete. The PIN
 * never exists outside this object and the call to the lock; the digits are
 * not echoed, the keys give haptic feedback.
 */
final class LockPad extends LinearLayout implements Renderer.Slot {
    private final MainActivity a;
    private final StringBuilder pin = new StringBuilder();
    private final LinearLayout dots;
    private final TextView step;
    private int length;

    LockPad(MainActivity a, Parts parts) {
        super(a);
        this.a = a;
        setOrientation(VERTICAL);
        setGravity(Gravity.CENTER_HORIZONTAL);
        step = new TextView(a);
        step.setGravity(Gravity.CENTER);
        step.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        addView(step);
        dots = new LinearLayout(a);
        dots.setGravity(Gravity.CENTER);
        LayoutParams dl = new LayoutParams(LayoutParams.WRAP_CONTENT, Ui.dp(a, 36));
        dl.setMargins(0, Ui.dp(a, 8), 0, Ui.dp(a, 16));
        addView(dots, dl);
        GridLayout grid = new GridLayout(a);
        grid.setColumnCount(3);
        String[] keys = {"1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"};
        for (String k : keys) grid.addView(key(k));
        addView(grid);
        length = a.app().lock.pinLength();
        redraw();
    }

    private View key(String k) {
        int size = Ui.dp(getContext(), 72);
        GridLayout.LayoutParams lp = new GridLayout.LayoutParams();
        lp.width = size;
        lp.height = size;
        lp.setMargins(Ui.dp(getContext(), 8), Ui.dp(getContext(), 6), Ui.dp(getContext(), 8), Ui.dp(getContext(), 6));
        if (k.isEmpty()) { View v = new View(getContext()); v.setLayoutParams(lp); return v; }
        TextView t = new TextView(getContext());
        t.setLayoutParams(lp);
        t.setGravity(Gravity.CENTER);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 26);
        int fg = Ui.color(getContext(), "@onSurface", Color.BLACK);
        if (k.equals("⌫")) {
            android.graphics.drawable.Drawable d = Icons.drawable(getContext(), "delete", Ui.dp(getContext(), 26), fg);
            d.setBounds(0, 0, Ui.dp(getContext(), 26), Ui.dp(getContext(), 26));
            t.setCompoundDrawables(d, null, null, null);
            t.setPadding(Ui.dp(getContext(), 23), 0, 0, 0);
            t.setContentDescription("delete");
        } else {
            t.setText(k);
            t.setTextColor(fg);
        }
        t.setBackground(Ui.ripple(Ui.shape(Ui.color(getContext(), "@surfaceVariant", Color.LTGRAY), size / 2f, 0, 0), Ui.alpha(fg, 0.2f)));
        t.setOnClickListener(v -> press(k, v));
        return t;
    }

    private void press(String k, View v) {
        v.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP);
        if (k.equals("⌫")) { if (pin.length() > 0) pin.setLength(pin.length() - 1); }
        else if (pin.length() < 12) pin.append(k);
        redraw();
        if (pin.length() >= length) {
            String entered = pin.toString();
            pin.setLength(0);
            redraw();
            a.onPinEntered(entered);
        }
    }

    private void redraw() {
        dots.removeAllViews();
        int on = Ui.color(getContext(), "@primary", Color.RED), off = Ui.color(getContext(), "@border", Color.LTGRAY);
        for (int i = 0; i < length; i++) {
            View d = new View(getContext());
            int s = Ui.dp(getContext(), 14);
            LayoutParams lp = new LayoutParams(s, s);
            lp.setMargins(Ui.dp(getContext(), 7), 0, Ui.dp(getContext(), 7), 0);
            d.setBackground(Ui.shape(i < pin.length() ? on : off, s / 2f, 0, 0));
            dots.addView(d, lp);
        }
    }

    @Override
    public void bindSlot(Expr.Scope scope) {
        Object lock = scope.get("lock");
        org.json.JSONObject l = lock instanceof org.json.JSONObject ? (org.json.JSONObject) lock : new org.json.JSONObject();
        length = a.app().lock.pinLength();
        boolean setup = l.optBoolean("setup");
        step.setText(setup ? a.app().t("confirm".equals(l.optString("step")) ? "lock.confirmPin" : "lock.setPin") : "");
        step.setTextColor(Ui.color(getContext(), "@muted", Color.GRAY));
        step.setVisibility(setup ? VISIBLE : GONE);
        redraw();
    }
}
