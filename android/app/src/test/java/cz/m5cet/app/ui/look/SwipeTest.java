package cz.m5cet.app.ui.look;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * A row's swipe (6.7): which way reveals which actions, when the row takes
 * a drag from the list, where it settles. The rooms' row: Delete (one
 * action, 78 px here) when dragged right, Clone and Edit (156 px) when
 * dragged left.
 */
public class SwipeTest {
    static final float RIGHT_W = 78, LEFT_W = 156, SLOP = 8, FLING = 650;

    @Test public void aDragToTheRightShowsTheRightMenuAndToTheLeftTheLeftOne() {
        assertEquals(Swipe.RIGHT, Swipe.side(30));
        assertEquals(Swipe.LEFT, Swipe.side(-30));
        assertEquals(Swipe.CLOSED, Swipe.side(0));
        // Open to the right: the "right" menu's width (Delete); to the left: the "left" menu's (Clone, Edit).
        assertEquals(RIGHT_W, Swipe.settle(70, 0, FLING, RIGHT_W, LEFT_W), 0);
        assertEquals(-LEFT_W, Swipe.settle(-150, 0, FLING, RIGHT_W, LEFT_W), 0);
    }

    @Test public void onlyAClearlySidewaysDragPastTheSlopIsTheRows() {
        assertFalse("within the slop", Swipe.claims(SLOP, 0, SLOP, 0, RIGHT_W, LEFT_W));
        assertTrue(Swipe.claims(SLOP + 1, 0, SLOP, 0, RIGHT_W, LEFT_W));
        assertTrue(Swipe.claims(-20, 5, SLOP, 0, RIGHT_W, LEFT_W));
        // The list keeps its scrolling: mostly vertical, or diagonal, stays the list's.
        assertFalse(Swipe.claims(20, 30, SLOP, 0, RIGHT_W, LEFT_W));
        assertFalse(Swipe.claims(20, 18, SLOP, 0, RIGHT_W, LEFT_W));
        assertTrue(Swipe.claims(30, 20, SLOP, 0, RIGHT_W, LEFT_W));
    }

    @Test public void aClosedRowIgnoresADragTowardASideWithoutActions() {
        assertFalse(Swipe.claims(30, 0, SLOP, 0, 0, LEFT_W));
        assertTrue(Swipe.claims(-30, 0, SLOP, 0, 0, LEFT_W));
        assertFalse(Swipe.claims(-30, 0, SLOP, 0, RIGHT_W, 0));
        // An open one takes any sideways drag (back to close it).
        assertTrue(Swipe.claims(-30, 0, SLOP, RIGHT_W, RIGHT_W, 0));
        // Nothing to show either way: never.
        assertFalse(Swipe.claims(30, 0, SLOP, 0, 0, 0));
        assertFalse(Swipe.claims(-30, 0, SLOP, 0, 0, 0));
    }

    @Test public void theRowFollowsOverTheActionsAndResistsPastThem() {
        assertEquals(40, Swipe.clamp(40, RIGHT_W, LEFT_W), 0);
        assertEquals(-100, Swipe.clamp(-100, RIGHT_W, LEFT_W), 0);
        // past them only a fifth of the way
        assertEquals(RIGHT_W + 20 * Swipe.RESIST, Swipe.clamp(RIGHT_W + 20, RIGHT_W, LEFT_W), 0.001);
        assertEquals(-LEFT_W - 50 * Swipe.RESIST, Swipe.clamp(-LEFT_W - 50, RIGHT_W, LEFT_W), 0.001);
        // toward a side without actions it does not move at all
        assertEquals(0, Swipe.clamp(60, 0, LEFT_W), 0);
        assertEquals(0, Swipe.clamp(-60, RIGHT_W, 0), 0);
    }

    @Test public void letGoPastTheThresholdItOpensShortOfItItSpringsBack() {
        float at = Swipe.OPEN_AT * RIGHT_W;
        assertEquals(RIGHT_W, Swipe.settle(at, 0, FLING, RIGHT_W, LEFT_W), 0);
        assertEquals(0, Swipe.settle(at - 1, 0, FLING, RIGHT_W, LEFT_W), 0);
        float atLeft = Swipe.OPEN_AT * LEFT_W;
        assertEquals(-LEFT_W, Swipe.settle(-atLeft, 0, FLING, RIGHT_W, LEFT_W), 0);
        assertEquals(0, Swipe.settle(-atLeft + 1, 0, FLING, RIGHT_W, LEFT_W), 0);
        assertEquals(0, Swipe.settle(0, 0, FLING, RIGHT_W, LEFT_W), 0);
        // past the actions (the rubber band) it settles on them
        assertEquals(RIGHT_W, Swipe.settle(RIGHT_W + 12, 0, FLING, RIGHT_W, LEFT_W), 0);
        assertTrue(Swipe.pastOpen(at, RIGHT_W, LEFT_W));
        assertFalse(Swipe.pastOpen(at - 1, RIGHT_W, LEFT_W));
        assertFalse(Swipe.pastOpen(0, RIGHT_W, LEFT_W));
    }

    @Test public void aFlingDecidesOnItsOwn() {
        // A short quick flick toward the side opens it; a flick back closes even a wide-open row.
        assertEquals(RIGHT_W, Swipe.settle(10, FLING, FLING, RIGHT_W, LEFT_W), 0);
        assertEquals(-LEFT_W, Swipe.settle(-10, -FLING * 2, FLING, RIGHT_W, LEFT_W), 0);
        assertEquals(0, Swipe.settle(RIGHT_W, -FLING, FLING, RIGHT_W, LEFT_W), 0);
        assertEquals(0, Swipe.settle(-LEFT_W, FLING, FLING, RIGHT_W, LEFT_W), 0);
        // slower than a fling: the position decides
        assertEquals(0, Swipe.settle(10, FLING - 1, FLING, RIGHT_W, LEFT_W), 0);
        // no fling threshold given (a cancelled touch): the position decides
        assertEquals(RIGHT_W, Swipe.settle(RIGHT_W, -5000, 0, RIGHT_W, LEFT_W), 0);
    }

    @Test public void theActionsComeInWithTheRow() {
        assertEquals(0, Swipe.progress(0, RIGHT_W), 0);
        assertEquals(0.5f, Swipe.progress(RIGHT_W / 2, RIGHT_W), 0.0001);
        assertEquals(0.5f, Swipe.progress(-LEFT_W / 2, LEFT_W), 0.0001);
        assertEquals(1, Swipe.progress(RIGHT_W * 2, RIGHT_W), 0);
        assertEquals(0, Swipe.progress(30, 0), 0);
    }
}
