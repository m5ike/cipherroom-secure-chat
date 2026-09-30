package cz.m5cet.app.ui.parts;

import android.animation.ObjectAnimator;
import android.content.Context;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.os.Build;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import cz.m5cet.app.M5;
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
 *
 * 6.2: the keys are sized to the space the pad gets — three across, four
 * down, 40–84 dp, the text with them — so the last row fits a folded
 * phone's cover screen, split screen and landscape too. A wrong PIN shakes
 * the dots; a long press on delete clears them.
 */
final class LockPad extends LinearLayout implements Renderer.Slot {
    /** The dial-pad letters under each digit (ITU E.161); 1 and 0 have none. */
    private static final String[] LETTERS = {"", "", "ABC", "DEF", "GHI", "JKL", "MNO", "PQRS", "TUV", "WXYZ"};
    static final String DEL = "⌫";
    private static final SecureRandom RND = new SecureRandom();

    private final MainActivity a;
    private final StringBuilder pin = new StringBuilder();
    private final TextView step;
    private final Dots dots;
    private final Keys keys;
    private int length;
    /** The digits 0–9 in the order the keypad shows them (reshuffled while shuffle is on). */
    private final List<String> order = new ArrayList<>();
    private boolean laidOut;
    private String lastError = "";
    private int lastAttempts;

    LockPad(MainActivity a, Parts parts) {
        super(a);
        this.a = a;
        setOrientation(VERTICAL);
        setGravity(Gravity.CENTER_HORIZONTAL);
        step = new TextView(a);
        step.setGravity(Gravity.CENTER);
        step.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        step.setVisibility(GONE);
        addView(step, new LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT));
        dots = new Dots(a);
        LayoutParams dl = new LayoutParams(LayoutParams.WRAP_CONTENT, Ui.dp(a, 24));
        dl.setMargins(0, Ui.dp(a, 6), 0, Ui.dp(a, 14));
        addView(dots, dl);
        keys = new Keys(a, this::press);
        addView(keys, new LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT));
        length = a.app().lock.pinLength();
        dots.set(length, 0);
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

    /** The twelve cells, row by row: nine digits, then a blank, a digit and delete (…9, _, 0, ⌫ in order). */
    private List<String> cells() {
        List<String> cells = new ArrayList<>(12);
        if (shuffle()) {
            cells.addAll(order);           // ten shuffled digits
            cells.add("");                 // a blank so the grid is full (11 + delete = 12)
        } else {
            for (int i = 1; i <= 9; i++) cells.add(Integer.toString(i));
            cells.add("");
            cells.add("0");
        }
        cells.add(DEL);
        return cells;
    }

    private void press(String k, View v) {
        v.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP);
        if (k.equals(DEL)) { if (pin.length() > 0) pin.setLength(pin.length() - 1); }
        else if (pin.length() < 12) pin.append(k);
        dots.set(length, pin.length());
        if (shuffle()) { reorder(); keys.setCells(cells()); }
        if (pin.length() >= length) {
            String entered = pin.toString();
            pin.setLength(0);
            dots.set(length, 0);
            a.onPinEntered(entered);
        }
    }

    /** A long press on delete: start again. */
    private void clear(View v) {
        v.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS);
        pin.setLength(0);
        dots.set(length, 0);
    }

    /* ------------------------------------------------------------ sizing */

    @Override
    protected void onMeasure(int widthSpec, int heightSpec) {
        // The keys get what is left after the step text and the dots.
        int wMode = MeasureSpec.getMode(widthSpec), hMode = MeasureSpec.getMode(heightSpec);
        int w = Math.max(0, MeasureSpec.getSize(widthSpec) - getPaddingLeft() - getPaddingRight());
        int h = Math.max(0, MeasureSpec.getSize(heightSpec) - getPaddingTop() - getPaddingBottom());
        int above = 0;
        if (step.getVisibility() != GONE) {
            step.measure(MeasureSpec.makeMeasureSpec(w, wMode == MeasureSpec.UNSPECIFIED ? MeasureSpec.UNSPECIFIED : MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED));
            above += step.getMeasuredHeight();
        }
        LayoutParams dl = (LayoutParams) dots.getLayoutParams();
        above += dl.height + dl.topMargin + dl.bottomMargin;
        keys.fit(wMode == MeasureSpec.UNSPECIFIED ? Integer.MAX_VALUE : w, hMode == MeasureSpec.UNSPECIFIED ? Integer.MAX_VALUE : h - above);
        super.onMeasure(widthSpec, heightSpec);
    }

    @Override
    protected void onConfigurationChanged(Configuration c) {
        super.onConfigurationChanged(c);
        // Folded, unfolded, turned, split: the lock tree may put its header beside the pad.
        a.lockResized();
    }

    @Override
    public void bindSlot(Expr.Scope scope) {
        Object lock = scope.get("lock");
        JSONObject l = lock instanceof JSONObject ? (JSONObject) lock : new JSONObject();
        int len = a.app().lock.pinLength();
        if (len != length) { length = len; pin.setLength(0); }
        boolean setup = l.optBoolean("setup");
        step.setText(setup ? a.app().t("confirm".equals(l.optString("step")) ? "lock.confirmPin" : "lock.setPin") : "");
        step.setTextColor(Ui.color(getContext(), "@muted", Color.GRAY));
        step.setVisibility(setup ? VISIBLE : GONE);
        String error = l.optString("error", "");
        int attempts = l.optInt("attempts", 0);
        if ((!error.isEmpty() && !error.equals(lastError)) || attempts > lastAttempts) dots.shake();
        lastError = error;
        lastAttempts = attempts;
        if (!laidOut || shuffle()) { reorder(); keys.setCells(cells()); laidOut = true; }
        dots.set(length, pin.length());
    }

    /* -------------------------------------------------------------- keys */

    interface Press { void press(String key, View v); }

    /**
     * {key, horizontal gap, vertical gap} in px for w × h px of room
     * (Integer.MAX_VALUE: unbounded) at this density: three keys and two gaps
     * (28 % of a key) across, four keys and three gaps (14 %) down, keys
     * 40–84 dp. At the smallest keys the gaps give way first.
     */
    static int[] keySizes(int w, int h, float density) {
        int min = Math.round(40 * density), max = Math.round(84 * density);
        float byW = w == Integer.MAX_VALUE ? Float.MAX_VALUE : w / 3.56f;
        float byH = h == Integer.MAX_VALUE ? Float.MAX_VALUE : h / 4.42f;
        int k = clamp((int) Math.min(Math.min(byW, byH), max), min, max);
        int gv = clamp(Math.round(k * 0.14f), Math.round(4 * density), Math.round(16 * density));
        int gh = clamp(Math.round(k * 0.28f), Math.round(6 * density), Math.round(28 * density));
        if (h != Integer.MAX_VALUE && 4 * k + 3 * gv > h) gv = Math.max(0, (h - 4 * k) / 3);
        if (w != Integer.MAX_VALUE && 3 * k + 2 * gh > w) gh = Math.max(0, (w - 3 * k) / 2);
        return new int[]{k, gh, gv};
    }

    private static int clamp(int v, int lo, int hi) { return Math.max(lo, Math.min(hi, v)); }

    /** Colours: one per digit, spread around the hue wheel; soft in light, deep in dark. */
    static int keyColor(Context c, int digit) {
        boolean dark = luminance(Ui.color(c, "@background", Color.WHITE)) < 0.5;
        float[] hsv = {(digit * 36f) % 360f, dark ? 0.52f : 0.42f, dark ? 0.46f : 0.94f};
        return Color.HSVToColor(hsv);
    }

    static int textOn(int bg) { return luminance(bg) < 0.56 ? Color.WHITE : 0xFF14181F; }

    static double luminance(int c) {
        return (0.2126 * Color.red(c) + 0.7152 * Color.green(c) + 0.0722 * Color.blue(c)) / 255.0;
    }

    /** Twelve round keys in three columns, as large as the space allows. */
    static final class Keys extends ViewGroup {
        private final Press press;
        private final List<Key> cells = new ArrayList<>(12);
        private int key, gapH, gapV;

        Keys(Context c, Press press) {
            super(c);
            this.press = press;
            key = Ui.dp(c, 72);
            gapH = Ui.dp(c, 16);
            gapV = Ui.dp(c, 12);
            for (int i = 0; i < 12; i++) {
                Key k = new Key(c);
                cells.add(k);
                addView(k);
            }
        }

        void setCells(List<String> labels) {
            for (int i = 0; i < cells.size(); i++) {
                Key k = cells.get(i);
                k.set(i < labels.size() ? labels.get(i) : "");
                String label = k.label;
                if (label.isEmpty()) { k.setOnClickListener(null); k.setOnLongClickListener(null); k.setClickable(false); continue; }
                k.setOnClickListener(v -> press.press(label, v));
                if (label.equals(DEL)) k.setOnLongClickListener(v -> { if (getParent() instanceof LockPad) ((LockPad) getParent()).clear(v); return true; });
                else k.setOnLongClickListener(null);
            }
        }

        /** The key and gap sizes for this much room (Integer.MAX_VALUE: unbounded). */
        void fit(int w, int h) {
            int[] s = keySizes(w, h, getResources().getDisplayMetrics().density);
            key = s[0];
            gapH = s[1];
            gapV = s[2];
        }

        @Override
        protected void onMeasure(int widthSpec, int heightSpec) {
            int spec = MeasureSpec.makeMeasureSpec(key, MeasureSpec.EXACTLY);
            for (Key k : cells) k.measure(spec, spec);
            setMeasuredDimension(3 * key + 2 * gapH, 4 * key + 3 * gapV);
        }

        @Override
        protected void onLayout(boolean changed, int l, int t, int r, int b) {
            int left = Math.max(0, (r - l - (3 * key + 2 * gapH)) / 2);
            for (int i = 0; i < cells.size(); i++) {
                int x = left + (i % 3) * (key + gapH), y = (i / 3) * (key + gapV);
                cells.get(i).layout(x, y, x + key, y + key);
            }
        }
    }

    /** One round key: the digit and its letters drawn to its size, or the delete icon. */
    static final class Key extends View {
        String label = "";
        private final Paint num = new Paint(Paint.ANTI_ALIAS_FLAG), sub = new Paint(Paint.ANTI_ALIAS_FLAG);
        private Drawable icon;

        Key(Context c) {
            super(c);
            num.setTextAlign(Paint.Align.CENTER);
            num.setTypeface(Ui.typeface(M5.get().design(), false, false));
            sub.setTextAlign(Paint.Align.CENTER);
            sub.setTypeface(Ui.typeface(M5.get().design(), true, false));
            sub.setLetterSpacing(0.14f);
        }

        void set(String k) {
            label = k;
            Context c = getContext();
            int onSurface = Ui.color(c, "@onSurface", Color.BLACK);
            GradientDrawable mask = new GradientDrawable();
            mask.setShape(GradientDrawable.OVAL);
            mask.setColor(Color.WHITE);
            if (k.isEmpty()) {
                setBackground(null);
                setVisibility(INVISIBLE);
                setContentDescription(null);
            } else if (k.equals(DEL)) {
                setVisibility(VISIBLE);
                icon = Icons.drawable(c, "delete", Ui.dp(c, 26), onSurface);
                setBackground(new RippleDrawable(ColorStateList.valueOf(Ui.alpha(onSurface, 0.18f)), null, mask));
                setContentDescription(M5.get().t("lock.delete"));
            } else {
                setVisibility(VISIBLE);
                int bg = keyColor(c, k.charAt(0) - '0');
                int fg = textOn(bg);
                num.setColor(fg);
                sub.setColor(Ui.alpha(fg, 0.7f));
                GradientDrawable g = new GradientDrawable();
                g.setShape(GradientDrawable.OVAL);
                g.setColor(bg);
                setBackground(new RippleDrawable(ColorStateList.valueOf(Ui.alpha(fg, 0.24f)), g, mask));
                setContentDescription(k);
                icon = null;
            }
            setClickable(!k.isEmpty());
            setFocusable(!k.isEmpty());
            invalidate();
        }

        @Override
        protected void onDraw(Canvas c) {
            float s = Math.min(getWidth(), getHeight());
            if (s <= 0 || label.isEmpty()) return;
            float cx = getWidth() / 2f, cy = getHeight() / 2f;
            if (label.equals(DEL)) {
                if (icon == null) return;
                int half = Math.round(s * 0.18f);
                icon.setBounds(Math.round(cx) - half, Math.round(cy) - half, Math.round(cx) + half, Math.round(cy) + half);
                icon.draw(c);
                return;
            }
            String letters = LETTERS[label.charAt(0) - '0'];
            // Below 52 dp the letters would be too small to read: the digit alone.
            boolean withLetters = !letters.isEmpty() && s >= 52 * getResources().getDisplayMetrics().density;
            num.setTextSize(s * 0.38f);
            float numY = withLetters ? cy - s * 0.07f : cy;
            c.drawText(label, cx, numY - (num.ascent() + num.descent()) / 2f, num);
            if (withLetters) {
                sub.setTextSize(s * 0.13f);
                c.drawText(letters, cx, cy + s * 0.25f - (sub.ascent() + sub.descent()) / 2f, sub);
            }
        }
    }

    /* -------------------------------------------------------------- dots */

    /** One dot per digit of the PIN, filled as they are typed; they shrink to fit a narrow pad. */
    static final class Dots extends View {
        private final Paint on = new Paint(Paint.ANTI_ALIAS_FLAG), off = new Paint(Paint.ANTI_ALIAS_FLAG);
        private int length = 6, filled;

        Dots(Context c) {
            super(c);
            on.setStyle(Paint.Style.FILL);
            off.setStyle(Paint.Style.STROKE);
            off.setStrokeWidth(Ui.dp(c, 1.5f));
            setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_YES);
        }

        void set(int length, int filled) {
            this.length = Math.max(1, length);
            this.filled = Math.max(0, Math.min(filled, this.length));
            setContentDescription(this.filled + " / " + this.length);
            requestLayoutIfNeeded();
            invalidate();
        }

        private int lastLength = -1;

        private void requestLayoutIfNeeded() { if (lastLength != length) { lastLength = length; requestLayout(); } }

        private float dot() { return Ui.dp(getContext(), 14); }

        @Override
        protected void onMeasure(int widthSpec, int heightSpec) {
            int want = Math.round(length * dot() * 2f);
            setMeasuredDimension(resolveSize(want, widthSpec), resolveSize(Ui.dp(getContext(), 24), heightSpec));
        }

        @Override
        protected void onDraw(Canvas c) {
            on.setColor(Ui.color(getContext(), "@primary", Color.RED));
            off.setColor(Ui.color(getContext(), "@border", Color.LTGRAY));
            float step = Math.min(dot() * 2f, getWidth() / (float) length);
            float r = Math.min(dot(), step * 0.62f) / 2f;
            float x = (getWidth() - step * length) / 2f + step / 2f, y = getHeight() / 2f;
            for (int i = 0; i < length; i++, x += step) {
                if (i < filled) c.drawCircle(x, y, r, on);
                else c.drawCircle(x, y, r - off.getStrokeWidth() / 2f, off);
            }
        }

        /** A wrong PIN: a short shake (and a buzz). */
        void shake() {
            performHapticFeedback(Build.VERSION.SDK_INT >= 30 ? HapticFeedbackConstants.REJECT : HapticFeedbackConstants.LONG_PRESS);
            if (Ui.reducedMotion(getContext())) return;
            float d = Ui.dp(getContext(), 10);
            ObjectAnimator.ofFloat(this, "translationX", 0, d, -d, d * 0.7f, -d * 0.7f, d * 0.35f, 0).setDuration(380).start();
        }
    }
}
