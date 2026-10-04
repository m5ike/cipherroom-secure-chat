package cz.m5cet.app.ui.bubble;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * 6.10: a bubble dragged sideways — right replies, left forwards (mirrored
 * in a right-to-left layout); a clear threshold with a tick; a vertical drag
 * stays the list's; a fling off the bubbles still changes the room.
 */
public class BubbleSwipeTest {
    private static final float D = 2f;     // px per dp
    private static final float SLOP = 16f; // px
    private static final float TRIGGER = BubbleSwipe.TRIGGER_DP * D;

    private static BubbleSwipe at(boolean onBubble, boolean reply, boolean forward, boolean rtl) {
        return new BubbleSwipe(D, SLOP, onBubble, reply, forward, rtl, 100, 100);
    }

    @Test public void rightReplies() {
        BubbleSwipe g = at(true, true, true, false);
        assertEquals(BubbleSwipe.Kind.WAIT, g.kind());
        assertFalse(g.move(110, 102));            // inside the slop: still deciding
        assertEquals(BubbleSwipe.Kind.WAIT, g.kind());
        assertTrue(g.move(130, 104));             // clearly sideways: the bubble's
        assertTrue(g.dragging());
        assertEquals(30 - SLOP, g.offset(), 1e-3); // no jump by the slop
        assertEquals(BubbleSwipe.Act.REPLY, g.showing());
        assertFalse(g.armed());
        g.move(100 + SLOP + TRIGGER, 104);
        assertTrue(g.crossed());                  // the tick
        assertTrue(g.armed());
        assertEquals(1f, g.progress(), 1e-6);
        assertEquals(BubbleSwipe.Act.REPLY, g.release());
        assertEquals(BubbleSwipe.Kind.NONE, g.kind());
    }

    @Test public void leftForwards() {
        BubbleSwipe g = at(true, true, true, false);
        assertTrue(g.move(60, 100));
        assertEquals(BubbleSwipe.Act.FORWARD, g.showing());
        assertTrue(g.offset() < 0);
        g.move(100 - SLOP - TRIGGER - 10, 100);
        assertTrue(g.armed());
        assertEquals(BubbleSwipe.Act.FORWARD, g.release());
    }

    @Test public void shortOfTheTriggerNothingRuns() {
        BubbleSwipe g = at(true, true, true, false);
        g.move(130, 100);
        g.move(100 + SLOP + TRIGGER - 1, 100);
        assertFalse(g.armed());
        assertEquals(BubbleSwipe.Act.NONE, g.release());
    }

    @Test public void theTickComesOnceOutAndOnceBack() {
        BubbleSwipe g = at(true, true, true, false);
        g.move(140, 100);
        int ticks = 0;
        for (float x = 140; x <= 100 + SLOP + TRIGGER + 40; x += 4) { g.move(x, 100); if (g.crossed()) ticks++; }
        assertEquals(1, ticks);
        for (float x = 100 + SLOP + TRIGGER + 40; x >= 120; x -= 4) { g.move(x, 100); if (g.crossed()) ticks++; }
        assertEquals(2, ticks);
        assertFalse(g.armed());                   // brought back: letting go does nothing
        assertEquals(BubbleSwipe.Act.NONE, g.release());
    }

    @Test public void aVerticalDragIsTheListsForGood() {
        BubbleSwipe g = at(true, true, true, false);
        assertFalse(g.move(104, 130));
        assertEquals(BubbleSwipe.Kind.SCROLL, g.kind());
        assertFalse(g.move(200, 135));            // sideways later: still the list's
        assertEquals(0f, g.offset(), 0f);
        assertEquals(BubbleSwipe.Act.NONE, g.release());
    }

    @Test public void aDiagonalDragIsNotSidewaysEnough() {
        BubbleSwipe g = at(true, true, true, false);
        // 30 px across, 24 down: less than 1.5× as sideways — not decided, then the list's.
        assertFalse(g.move(130, 124));
        assertEquals(BubbleSwipe.Kind.SCROLL, g.kind());
        BubbleSwipe h = at(true, true, true, false);
        assertTrue(h.move(130, 119));             // 30 across, 19 down: ≥ 1.5×
        assertTrue(h.dragging());
    }

    @Test public void aDirectionWithoutItsActionStaysPut() {
        // A sealed message not opened here cannot be forwarded: a drag to the left is not taken.
        BubbleSwipe g = at(true, true, false, false);
        assertFalse(g.move(60, 100));
        assertEquals(BubbleSwipe.Kind.NONE, g.kind());
        // Dragged right, then back past the start: it stops at the start.
        BubbleSwipe h = at(true, true, false, false);
        h.move(140, 100);
        h.move(20, 100);
        assertEquals(0f, h.offset(), 0f);
        assertEquals(BubbleSwipe.Act.NONE, h.release());
    }

    @Test public void notOnABubbleTheBubbleNeverMoves() {
        BubbleSwipe g = at(false, true, true, false);
        assertEquals(BubbleSwipe.Kind.NONE, g.kind());
        assertFalse(g.move(300, 100));
        assertEquals(BubbleSwipe.Act.NONE, g.release());
        // Nothing allowed (a notice, a vanished message): the same.
        assertEquals(BubbleSwipe.Kind.NONE, at(true, false, false, false).kind());
    }

    @Test public void rightToLeftMirrors() {
        // In a right-to-left layout the reading direction's end is on the left: a drag to the left replies.
        BubbleSwipe g = at(true, true, true, true);
        assertTrue(g.move(60, 100));
        assertEquals(BubbleSwipe.Act.REPLY, g.showing());
        assertTrue(g.offset() < 0);               // the bubble moves where the finger goes
        g.move(100 - SLOP - TRIGGER, 100);
        assertEquals(BubbleSwipe.Act.REPLY, g.release());
        BubbleSwipe h = at(true, true, true, true);
        h.move(140, 100);
        assertEquals(BubbleSwipe.Act.FORWARD, h.showing());
        assertTrue(h.offset() > 0);
        assertEquals(BubbleSwipe.Act.REPLY, BubbleSwipe.act(-5, true));
        assertEquals(BubbleSwipe.Act.FORWARD, BubbleSwipe.act(5, true));
        assertEquals(BubbleSwipe.Act.REPLY, BubbleSwipe.act(5, false));
        assertEquals(BubbleSwipe.Act.FORWARD, BubbleSwipe.act(-5, false));
        assertEquals(BubbleSwipe.Act.NONE, BubbleSwipe.act(0, false));
    }

    @Test public void theBubbleFollowsThenResists() {
        float free = BubbleSwipe.FREE_DP * D, max = BubbleSwipe.MAX_DP * D;
        assertEquals(50f, BubbleSwipe.follow(50, free, max, BubbleSwipe.RESIST), 1e-4);
        assertEquals(-free, BubbleSwipe.follow(-free, free, max, BubbleSwipe.RESIST), 1e-4);
        assertEquals(free + 100 * BubbleSwipe.RESIST, BubbleSwipe.follow(free + 100, free, max, BubbleSwipe.RESIST), 1e-3);
        assertEquals(max, BubbleSwipe.follow(10_000, free, max, BubbleSwipe.RESIST), 1e-4);
        assertEquals(-max, BubbleSwipe.follow(-10_000, free, max, BubbleSwipe.RESIST), 1e-4);
        // The trigger is reached before the rubber band starts.
        assertTrue(BubbleSwipe.TRIGGER_DP < BubbleSwipe.FREE_DP && BubbleSwipe.FREE_DP < BubbleSwipe.MAX_DP);
    }

    @Test public void aCancelRunsNothing() {
        BubbleSwipe g = at(true, true, true, false);
        g.move(100 + SLOP + TRIGGER + 20, 100);
        assertTrue(g.armed());
        g.cancel();
        assertEquals(BubbleSwipe.Act.NONE, g.release());
        assertEquals(0f, g.offset(), 0f);
    }

    @Test public void aFlingOffTheBubblesChangesTheRoomOnABubbleItDoesNot() {
        float min = BubbleSwipe.ROOM_FLING_DP * D;
        assertTrue(BubbleSwipe.roomFling(false, -min, 100, min));
        assertTrue(BubbleSwipe.roomFling(false, min * 2, -min, min));
        assertFalse(BubbleSwipe.roomFling(true, -min * 3, 0, min));   // on a bubble: its drag, never the room
        assertFalse(BubbleSwipe.roomFling(false, min - 1, 0, min));   // too slow
        assertFalse(BubbleSwipe.roomFling(false, min * 2, min * 1.5f, min)); // not sideways enough
        assertEquals(1, BubbleSwipe.roomStep(-1));  // to the left: the next room (6.1)
        assertEquals(-1, BubbleSwipe.roomStep(1));
    }
}
