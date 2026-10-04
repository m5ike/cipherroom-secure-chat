package cz.m5cet.app.ui.look;

/**
 * The arithmetic of a row's swipe (6.7, the design's "swipe" element —
 * SwipeRow does the views and the touch). Dragged to the RIGHT a row
 * slides away from the actions of its "right" menu, which wait at its
 * left edge (the rooms: Delete); dragged to the LEFT from those of its
 * "left" menu at its right edge (Clone, Edit). Directions are physical
 * (what the finger does), also in a right-to-left language. Pure Java,
 * so the thresholds are unit-tested.
 *
 * Offsets are the row's translation in px: positive = moved right.
 */
public final class Swipe {
    private Swipe() {}

    /** Which actions an offset shows. */
    public static final int CLOSED = 0, RIGHT = 1, LEFT = -1;

    /** A drag is the row's (not the list's scrolling) once it is this many times more sideways than down. */
    public static final float DOMINANCE = 1.25f;
    /** Let go past this share of a side's actions, the row stays open on that side; short of it, it springs back. */
    public static final float OPEN_AT = 0.45f;
    /** Past its actions the row follows the finger only this much (a rubber band). */
    public static final float RESIST = 0.2f;
    /** A fling this fast (dp/s; the caller scales it) decides on its own: toward a side opens it, back closes. */
    public static final float FLING_DP = 650f;

    public static int side(float offset) { return offset > 0 ? RIGHT : offset < 0 ? LEFT : CLOSED; }

    /**
     * Does a movement since the finger went down (dx, dy px) belong to the
     * row? Only a sideways one past the touch slop, clearly more sideways
     * than vertical (the list keeps its scrolling), and toward actions: a
     * closed row with nothing on that side ignores it; an open row takes any
     * sideways drag (back to close it, or on to the other side).
     */
    public static boolean claims(float dx, float dy, float slop, float offset, float rightWidth, float leftWidth) {
        float ax = Math.abs(dx);
        if (ax <= slop || ax < DOMINANCE * Math.abs(dy)) return false;
        if (offset != 0) return true;
        return dx > 0 ? rightWidth > 0 : leftWidth > 0;
    }

    /** Where the row is while dragged: free over its actions, a rubber band past them, not at all toward a side without any. */
    public static float clamp(float offset, float rightWidth, float leftWidth) {
        if (offset > 0) {
            if (rightWidth <= 0) return 0;
            return offset <= rightWidth ? offset : rightWidth + (offset - rightWidth) * RESIST;
        }
        if (offset < 0) {
            if (leftWidth <= 0) return 0;
            return -offset <= leftWidth ? offset : -leftWidth + (offset + leftWidth) * RESIST;
        }
        return 0;
    }

    /**
     * Where the row settles when let go (velocity px/s, positive = to the
     * right; fling = FLING_DP in px/s): open on the side it shows — all its
     * actions in view — or closed.
     */
    public static float settle(float offset, float velocity, float fling, float rightWidth, float leftWidth) {
        int s = side(offset);
        if (s == CLOSED) return 0;
        float width = s == RIGHT ? rightWidth : leftWidth;
        if (width <= 0) return 0;
        if (fling > 0 && Math.abs(velocity) >= fling) return velocity * s > 0 ? s * width : 0;
        return Math.abs(offset) >= OPEN_AT * width ? s * width : 0;
    }

    /** Would letting go here (slowly) open the row? — the drag ticks once when this changes. */
    public static boolean pastOpen(float offset, float rightWidth, float leftWidth) {
        float width = offset > 0 ? rightWidth : leftWidth;
        return width > 0 && offset != 0 && Math.abs(offset) >= OPEN_AT * width;
    }

    /** How much of a side's actions shows (0–1): their icons fade and grow in with it. */
    public static float progress(float offset, float width) {
        if (width <= 0) return 0;
        return Math.max(0f, Math.min(1f, Math.abs(offset) / width));
    }
}
