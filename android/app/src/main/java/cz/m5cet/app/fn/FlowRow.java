package cz.m5cet.app.fn;

import android.content.Context;
import android.view.View;
import android.view.ViewGroup;

/** Children side by side, wrapping to the next line when they do not fit (a function's buttons); a MATCH_PARENT child takes a line. */
final class FlowRow extends ViewGroup {
    private final int gap;

    FlowRow(Context c, int gap) {
        super(c);
        this.gap = gap;
    }

    @Override protected void onMeasure(int widthSpec, int heightSpec) {
        int mode = MeasureSpec.getMode(widthSpec);
        int max = mode == MeasureSpec.UNSPECIFIED ? Integer.MAX_VALUE : MeasureSpec.getSize(widthSpec) - getPaddingLeft() - getPaddingRight();
        int x = 0, y = 0, lineHeight = 0, widest = 0;
        for (int i = 0; i < getChildCount(); i++) {
            View child = getChildAt(i);
            if (child.getVisibility() == GONE) continue;
            boolean full = child.getLayoutParams().width == LayoutParams.MATCH_PARENT && max != Integer.MAX_VALUE;
            child.measure(MeasureSpec.makeMeasureSpec(max == Integer.MAX_VALUE ? 0 : max, full ? MeasureSpec.EXACTLY : max == Integer.MAX_VALUE ? MeasureSpec.UNSPECIFIED : MeasureSpec.AT_MOST),
                MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED));
            int w = child.getMeasuredWidth();
            if (x > 0 && x + w > max) { y += lineHeight + gap; x = 0; lineHeight = 0; }
            x += w + gap;
            widest = Math.max(widest, x - gap);
            lineHeight = Math.max(lineHeight, child.getMeasuredHeight());
        }
        int width = mode == MeasureSpec.EXACTLY ? MeasureSpec.getSize(widthSpec) : widest + getPaddingLeft() + getPaddingRight();
        setMeasuredDimension(width, resolveSize(y + lineHeight + getPaddingTop() + getPaddingBottom(), heightSpec));
    }

    @Override protected void onLayout(boolean changed, int l, int t, int r, int b) {
        int max = r - l - getPaddingLeft() - getPaddingRight();
        int x = 0, y = 0, lineHeight = 0;
        for (int i = 0; i < getChildCount(); i++) {
            View child = getChildAt(i);
            if (child.getVisibility() == GONE) continue;
            int w = child.getMeasuredWidth(), h = child.getMeasuredHeight();
            if (x > 0 && x + w > max) { y += lineHeight + gap; x = 0; lineHeight = 0; }
            child.layout(getPaddingLeft() + x, getPaddingTop() + y, getPaddingLeft() + x + w, getPaddingTop() + y + h);
            x += w + gap;
            lineHeight = Math.max(lineHeight, h);
        }
    }

    @Override protected LayoutParams generateDefaultLayoutParams() { return new LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT); }
}
