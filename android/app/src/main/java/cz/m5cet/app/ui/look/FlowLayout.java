package cz.m5cet.app.ui.look;

import android.content.Context;
import android.util.AttributeSet;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;

import java.util.ArrayList;
import java.util.List;

/**
 * A row that wraps its children onto more lines (6.2: the design's row with
 * wrap: true — chips of a choice, colour swatches). The row's gap is the
 * space between children and between lines; justify places each line.
 */
public final class FlowLayout extends ViewGroup {
    private int gap;
    private int justify = Gravity.START;
    private final List<int[]> lines = new ArrayList<>();

    public FlowLayout(Context c) { super(c); }
    public FlowLayout(Context c, AttributeSet a) { super(c, a); }

    public void setGap(int px) { if (gap != px) { gap = px; requestLayout(); } }

    /** Gravity.START, CENTER_HORIZONTAL or END. */
    public void setJustify(int g) { if (justify != g) { justify = g; requestLayout(); } }

    @Override
    protected void onMeasure(int wSpec, int hSpec) {
        int mode = MeasureSpec.getMode(wSpec);
        int limit = mode == MeasureSpec.UNSPECIFIED ? Integer.MAX_VALUE : MeasureSpec.getSize(wSpec) - getPaddingLeft() - getPaddingRight();
        int x = 0, lineH = 0, height = 0, widest = 0, first = 0;
        lines.clear();
        for (int i = 0; i < getChildCount(); i++) {
            View c = getChildAt(i);
            if (c.getVisibility() == GONE) continue;
            measureChildWithMargins(c, wSpec, 0, hSpec, 0);
            MarginLayoutParams lp = (MarginLayoutParams) c.getLayoutParams();
            int w = c.getMeasuredWidth() + lp.leftMargin + lp.rightMargin, h = c.getMeasuredHeight() + lp.topMargin + lp.bottomMargin;
            if (x > 0 && x + gap + w > limit) {
                lines.add(new int[]{first, i, x, lineH});
                height += lineH + gap;
                widest = Math.max(widest, x);
                x = 0; lineH = 0; first = i;
            }
            x += (x > 0 ? gap : 0) + w;
            lineH = Math.max(lineH, h);
        }
        if (x > 0 || lineH > 0) { lines.add(new int[]{first, getChildCount(), x, lineH}); height += lineH; widest = Math.max(widest, x); }
        int w = mode == MeasureSpec.EXACTLY ? MeasureSpec.getSize(wSpec) : Math.min(widest + getPaddingLeft() + getPaddingRight(), mode == MeasureSpec.AT_MOST ? MeasureSpec.getSize(wSpec) : Integer.MAX_VALUE);
        setMeasuredDimension(w, resolveSize(height + getPaddingTop() + getPaddingBottom(), hSpec));
    }

    @Override
    protected void onLayout(boolean changed, int l, int t, int r, int b) {
        int inner = r - l - getPaddingLeft() - getPaddingRight();
        int y = getPaddingTop();
        boolean rtl = getLayoutDirection() == LAYOUT_DIRECTION_RTL;
        for (int[] line : lines) {
            int free = Math.max(0, inner - line[2]);
            int x = justify == Gravity.CENTER_HORIZONTAL ? free / 2 : justify == Gravity.END ? free : 0;
            for (int i = line[0]; i < line[1] && i < getChildCount(); i++) {
                View c = getChildAt(i);
                if (c.getVisibility() == GONE) continue;
                MarginLayoutParams lp = (MarginLayoutParams) c.getLayoutParams();
                int cw = c.getMeasuredWidth(), ch = c.getMeasuredHeight();
                int left = x + lp.leftMargin, top = y + lp.topMargin + (line[3] - ch - lp.topMargin - lp.bottomMargin) / 2;
                int at = rtl ? r - l - getPaddingRight() - left - cw : getPaddingLeft() + left;
                c.layout(at, top, at + cw, top + ch);
                x += cw + lp.leftMargin + lp.rightMargin + gap;
            }
            y += line[3] + gap;
        }
    }

    @Override protected LayoutParams generateDefaultLayoutParams() { return new MarginLayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT); }
    @Override public LayoutParams generateLayoutParams(AttributeSet attrs) { return new MarginLayoutParams(getContext(), attrs); }
    @Override protected LayoutParams generateLayoutParams(LayoutParams p) { return p instanceof MarginLayoutParams ? new MarginLayoutParams((MarginLayoutParams) p) : new MarginLayoutParams(p); }
    @Override protected boolean checkLayoutParams(LayoutParams p) { return p instanceof MarginLayoutParams; }
}
