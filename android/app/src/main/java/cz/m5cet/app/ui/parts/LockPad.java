package cz.m5cet.app.ui.parts;

import android.graphics.Color;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.widget.GridLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import cz.m5cet.app.ui.Expr;
import cz.m5cet.app.ui.Icons;
import cz.m5cet.app.ui.MainActivity;
import cz.m5cet.app.ui.Renderer;
import cz.m5cet.app.ui.Ui;

/**
 * The PIN pad: dots for the typed digits and a keypad of all ten digits with
 * the dial-pad letters under each, one colour per key. With <i>Shuffle the
 * PIN keys</i> (Settings › Security) on, the digits are placed at random and
 * reshuffle after every tap, so the positions give nothing away to someone
 * watching or to a smudge on the glass. The PIN never exists outside this
 * object and the call to the lock; the digits are not echoed, the keys give
 * haptic feedback.
 */
final class LockPad extends LinearLayout implements Renderer.Slot {
    /** The dial-pad letters under each digit (ITU E.161); 1 and 0 have none. */
    private static final String[] LETTERS = {"", "", "ABC", "DEF", "GHI", "JKL", "MNO", "PQRS", "TUV", "WXYZ"};
    private static final String DEL = "⌫";
    private static final SecureRandom RND = new SecureRandom();

    private final MainActivity a;
    private final StringBuilder pin = new StringBuilder();
    private final LinearLayout dots;
    private final TextView step;
    private final GridLayout grid;
    private int length;
    /** The digits 0–9 in the order the keypad shows them (reshuffled while shuffle is on). */
    private final List<String> order = new ArrayList<>();

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
        grid = new GridLayout(a);
        grid.setColumnCount(3);
        addView(grid);
        length = a.app().lock.pinLength();
        reorder();
        layoutKeys();
        redraw();
    }

    private boolean shuffle() {
        try { return a.app().settings.bool("security.shufflePin"); } catch (RuntimeException e) { return false; }
    }

    /** The digit order: 0…9 as they are, or a fresh shuffle. */
    private void reorder() {
        order.clear();
        for (int i = 0; i <= 9; i++) order.add(Integer.toString(i));
        if (shuffle()) Collections.shuffle(order, RND);
    }

    /** Lays the keys out: three columns, the delete key fixed at the bottom-right. */
    private void layoutKeys() {
        grid.removeAllViews();
        // Nine cells of digits, then a blank, a digit and delete — the last row is [_, digit, ⌫]
        // when in order (…9, _, 0, ⌫), or the shuffled digits with one blank before delete.
        List<String> cells = new ArrayList<>();
        if (shuffle()) {
            cells.addAll(order);           // ten shuffled digits
            cells.add(10, "");             // a blank so the grid is full (11 + delete = 12)
        } else {
            for (int i = 1; i <= 9; i++) cells.add(Integer.toString(i));
            cells.add("");
            cells.add("0");
        }
        cells.add(DEL);
        for (String k : cells) grid.addView(key(k));
    }

    private View key(String k) {
        int size = Ui.dp(getContext(), 72);
        GridLayout.LayoutParams lp = new GridLayout.LayoutParams();
        lp.width = size;
        lp.height = size;
        lp.setMargins(Ui.dp(getContext(), 8), Ui.dp(getContext(), 6), Ui.dp(getContext(), 8), Ui.dp(getContext(), 6));
        if (k.isEmpty()) { View v = new View(getContext()); v.setLayoutParams(lp); return v; }

        int neutral = Ui.color(getContext(), "@surfaceVariant", Color.LTGRAY);
        int onSurface = Ui.color(getContext(), "@onSurface", Color.BLACK);

        if (k.equals(DEL)) {
            TextView t = new TextView(getContext());
            t.setLayoutParams(lp);
            t.setGravity(Gravity.CENTER);
            android.graphics.drawable.Drawable d = Icons.drawable(getContext(), "delete", Ui.dp(getContext(), 26), onSurface);
            d.setBounds(0, 0, Ui.dp(getContext(), 26), Ui.dp(getContext(), 26));
            t.setCompoundDrawables(d, null, null, null);
            t.setPadding(Ui.dp(getContext(), 23), 0, 0, 0);
            t.setContentDescription("delete");
            t.setBackground(Ui.ripple(Ui.shape(neutral, size / 2f, 0, 0), Ui.alpha(onSurface, 0.2f)));
            t.setOnClickListener(v -> press(k, v));
            return t;
        }

        int digit = k.charAt(0) - '0';
        int bg = keyColor(digit);
        int fg = textOn(bg);
        LinearLayout cell = new LinearLayout(getContext());
        cell.setLayoutParams(lp);
        cell.setOrientation(VERTICAL);
        cell.setGravity(Gravity.CENTER);
        cell.setBackground(Ui.ripple(Ui.shape(bg, size / 2f, 0, 0), Ui.alpha(fg, 0.24f)));

        TextView num = new TextView(getContext());
        num.setGravity(Gravity.CENTER);
        num.setTextSize(TypedValue.COMPLEX_UNIT_SP, 24);
        num.setTextColor(fg);
        num.setText(k);
        cell.addView(num);

        String letters = LETTERS[digit];
        if (!letters.isEmpty()) {
            TextView sub = new TextView(getContext());
            sub.setGravity(Gravity.CENTER);
            sub.setTextSize(TypedValue.COMPLEX_UNIT_SP, 9);
            sub.setLetterSpacing(0.12f);
            sub.setTextColor(Ui.alpha(fg, 0.7f));
            sub.setText(letters);
            cell.addView(sub);
        }
        cell.setContentDescription(k);
        cell.setOnClickListener(v -> press(k, v));
        return cell;
    }

    /** One colour per digit, spread around the hue wheel; soft in light, deep in dark. */
    private int keyColor(int digit) {
        boolean dark = luminance(Ui.color(getContext(), "@background", Color.WHITE)) < 0.5;
        float[] hsv = {(digit * 36f) % 360f, dark ? 0.52f : 0.42f, dark ? 0.46f : 0.94f};
        return Color.HSVToColor(hsv);
    }

    private static int textOn(int bg) { return luminance(bg) < 0.56 ? Color.WHITE : 0xFF14181F; }

    private static double luminance(int c) {
        return (0.2126 * Color.red(c) + 0.7152 * Color.green(c) + 0.0722 * Color.blue(c)) / 255.0;
    }

    private void press(String k, View v) {
        v.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP);
        if (k.equals(DEL)) { if (pin.length() > 0) pin.setLength(pin.length() - 1); }
        else if (pin.length() < 12) pin.append(k);
        redraw();
        if (shuffle()) { reorder(); layoutKeys(); }
        if (pin.length() >= length) {
            String entered = pin.toString();
            pin.setLength(0);
            redraw();
            if (shuffle()) { reorder(); layoutKeys(); }
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
        reorder();
        layoutKeys();
        redraw();
    }
}
