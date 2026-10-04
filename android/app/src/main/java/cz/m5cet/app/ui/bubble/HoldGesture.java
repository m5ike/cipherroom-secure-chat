package cz.m5cet.app.ui.bubble;

/**
 * The hold area beside a hold-to-read bubble (6.7, parts/HoldArea): a press
 * that stays put for a moment reveals the message until the finger lifts.
 * A finger that moves first (a scroll, a swipe) or lifts first reveals
 * nothing, so the list scrolls as before. Pure: fed the touch's numbers,
 * it answers what to do (the web's hold area waits as long: HOLD_SIDE_MS).
 */
public final class HoldGesture {
    /** How long the finger stays before the message shows. */
    public static final long DELAY_MS = 180;

    public enum Step { NONE, ARM, REVEAL, HIDE, CANCEL }

    private final long delayMs;
    private final float slop;
    private boolean down, revealed;
    private float x0, y0;
    private long t0;

    public HoldGesture(long delayMs, float slop) { this.delayMs = delayMs; this.slop = slop; }

    /** Finger down: ARM — check again after the delay (due). */
    public Step down(float x, float y, long t) {
        down = true;
        revealed = false;
        x0 = x; y0 = y; t0 = t;
        return Step.ARM;
    }

    /** Before the reveal, a move beyond the slop gives the gesture to the list (CANCEL); after it, the finger may wander. */
    public Step move(float x, float y) {
        if (!down || revealed) return Step.NONE;
        float dx = x - x0, dy = y - y0;
        if (dx * dx + dy * dy > slop * slop) { down = false; return Step.CANCEL; }
        return Step.NONE;
    }

    /** The delay's check: REVEAL once the finger stayed long enough. */
    public Step due(long t) {
        if (!down || revealed || t - t0 < delayMs) return Step.NONE;
        revealed = true;
        return Step.REVEAL;
    }

    /** Finger up (or the gesture taken away): HIDE what was revealed, else CANCEL the wait. */
    public Step up() {
        boolean was = revealed, armed = down;
        down = false;
        revealed = false;
        return was ? Step.HIDE : armed ? Step.CANCEL : Step.NONE;
    }

    public boolean revealed() { return revealed; }
    public boolean armed() { return down && !revealed; }
}
