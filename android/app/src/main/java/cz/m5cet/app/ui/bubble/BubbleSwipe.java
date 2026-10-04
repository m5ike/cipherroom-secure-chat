package cz.m5cet.app.ui.bubble;

/**
 * 6.10: a message bubble dragged sideways (MessageList). Dragged toward the
 * reading direction's END — to the RIGHT in Czech, English or German, to
 * the left in a right-to-left layout — it REPLIES; toward the START it
 * FORWARDS. The bubble follows the finger (freely, then a rubber band),
 * the icon of what it will do grows in under the edge it uncovers, the
 * phone ticks once where letting go starts to count (TRIGGER_DP) and once
 * more if the finger comes back; let go past it the action runs, short of
 * it nothing happens; either way the bubble springs back.
 *
 * Who gets the gesture:
 *  - a drag that STARTS ON A BUBBLE (its quote included) and is clearly
 *    sideways (DOMINANCE times more than down, past the touch slop) is the
 *    bubble's — never a change of room;
 *  - a more vertical one is the list's scrolling, for good (the bubble no
 *    longer listens to it);
 *  - a quick sideways FLING that starts ANYWHERE ELSE — the free space beside
 *    the bubbles, the avatars, the list's background — moves to the
 *    previous / next connected room (6.1), see {@link #roomFling}.
 *
 * Pure: fed the touch's numbers (px; the density turns the dp constants
 * into px), it answers, so the thresholds are unit-tested.
 */
public final class BubbleSwipe {
    public enum Act { NONE, REPLY, FORWARD }

    /** What the touch became: still deciding, the bubble's drag, the list's scroll, or nothing for the bubble. */
    public enum Kind { WAIT, DRAG, SCROLL, NONE }

    /** A drag is the bubble's once it is this many times more sideways than vertical (a chat list scrolls a lot: stricter than a room row's 1.25). */
    public static final float DOMINANCE = 1.5f;
    /** Let go this far (dp) from where the drag began: the action runs. The tick comes here. */
    public static final float TRIGGER_DP = 64f;
    /** The bubble follows the finger freely this far (dp), then as a rubber band … */
    public static final float FREE_DP = 84f;
    public static final float RESIST = 0.3f;
    /** … never further than this (dp). */
    public static final float MAX_DP = 120f;
    /** A fling off the bubbles at least this fast (dp/s), twice as sideways as vertical, changes the room. */
    public static final float ROOM_FLING_DP = 700f;

    private final float slop, trigger, free, max;
    private final boolean reply, forward, rtl;
    private Kind kind;
    private float x0, y0;
    /** How far the bubble is moved toward the END of the reading direction (px; negative = toward the start). */
    private float along;
    private boolean past, crossed;

    /**
     * A finger went down at (x, y).
     *   density     px per dp
     *   slop        the touch slop (px)
     *   onBubble    it went down on a bubble that may be swiped (not a sys notice, not a moving list…)
     *   canReply / canForward   what the message allows (a direction without its action stays put)
     *   rtl         the layout reads right to left (the directions mirror)
     */
    public BubbleSwipe(float density, float slop, boolean onBubble, boolean canReply, boolean canForward, boolean rtl, float x, float y) {
        this.slop = Math.max(1f, slop);
        this.trigger = TRIGGER_DP * density;
        this.free = FREE_DP * density;
        this.max = MAX_DP * density;
        this.reply = canReply;
        this.forward = canForward;
        this.rtl = rtl;
        this.x0 = x;
        this.y0 = y;
        this.kind = onBubble && (canReply || canForward) ? Kind.WAIT : Kind.NONE;
    }

    public Kind kind() { return kind; }

    /** The bubble's own drag (it moves, the list does not scroll, the room stays). */
    public boolean dragging() { return kind == Kind.DRAG; }

    /**
     * The finger is at (x, y) now: is the gesture the bubble's? The first
     * clearly sideways move toward an allowed action makes it so (DRAG); a
     * clearly vertical one gives it to the list (SCROLL), a sideways one
     * toward a direction without its action gives it up (NONE).
     */
    public boolean move(float x, float y) {
        crossed = false;
        if (kind == Kind.NONE || kind == Kind.SCROLL) return false;
        float dx = x - x0, dy = y - y0;
        if (kind == Kind.WAIT) {
            float ax = Math.abs(dx), ay = Math.abs(dy);
            if (ax > slop && ax >= DOMINANCE * ay) {
                Act toward = act(dx, rtl);
                if (!allows(toward)) { kind = Kind.NONE; return false; }
                kind = Kind.DRAG;
                x0 += dx > 0 ? slop : -slop; // no jump by the slop
                dx = x - x0;
            } else if (ay > slop) {
                kind = Kind.SCROLL;
                return false;
            } else {
                return false;
            }
        }
        float e = rtl ? -dx : dx;
        float next = follow(e, free, max, RESIST);
        if (next > 0 && !reply || next < 0 && !forward) next = 0; // back past the start: only toward an allowed side
        along = next;
        boolean nowPast = Math.abs(along) >= trigger;
        crossed = nowPast != past;
        past = nowPast;
        return true;
    }

    /** Where the bubble is now, physically (px for translationX: positive = to the right). */
    public float offset() { return rtl ? -along : along; }

    /** The last move crossed the trigger (out or back): the tick. */
    public boolean crossed() { return crossed; }

    /** Letting go here runs the action. */
    public boolean armed() { return kind == Kind.DRAG && past; }

    /** What the drag shows now (its icon), NONE before it moved. */
    public Act showing() { return along > 0 ? Act.REPLY : along < 0 ? Act.FORWARD : Act.NONE; }

    /** How much of the way to the trigger (0–1): the icon grows in with it. */
    public float progress() { return trigger <= 0 ? 0 : Math.min(1f, Math.abs(along) / trigger); }

    /** The finger lifted: what runs (NONE short of the trigger, or when it was not the bubble's). The gesture is over. */
    public Act release() {
        Act out = armed() ? showing() : Act.NONE;
        kind = Kind.NONE;
        along = 0;
        past = false;
        crossed = false;
        return out;
    }

    /** The gesture was taken away (a cancel, a child that claimed the touch): nothing runs. */
    public void cancel() {
        kind = Kind.NONE;
        along = 0;
        past = false;
        crossed = false;
    }

    private boolean allows(Act a) { return a == Act.REPLY ? reply : a == Act.FORWARD && forward; }

    /* ------------------------------------------------------------ rules */

    /** A physical sideways movement (px, positive = to the right) → the action it means in this layout. */
    public static Act act(float dx, boolean rtl) {
        float e = rtl ? -dx : dx;
        return e > 0 ? Act.REPLY : e < 0 ? Act.FORWARD : Act.NONE;
    }

    /** Where the bubble is for a finger `d` px from the start: 1:1 up to `free`, then `resist` of the rest, at most `max`. */
    public static float follow(float d, float free, float max, float resist) {
        float a = Math.abs(d);
        float v = a <= free ? a : Math.min(max, free + (a - free) * resist);
        return Math.signum(d) * Math.min(v, max);
    }

    /**
     * The 6.1 room change: a fling (velocity px/s) that did not start on a
     * bubble, at least `min` px/s sideways and twice as sideways as vertical.
     */
    public static boolean roomFling(boolean startedOnBubble, float vx, float vy, float min) {
        return !startedOnBubble && Math.abs(vx) >= min && Math.abs(vx) >= 2 * Math.abs(vy);
    }

    /** Which way the room changes for that fling: +1 the next room (a fling to the left), −1 the previous one. Physical, as 6.1. */
    public static int roomStep(float vx) { return vx < 0 ? 1 : -1; }
}
