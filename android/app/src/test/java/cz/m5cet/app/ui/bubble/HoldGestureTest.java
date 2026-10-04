package cz.m5cet.app.ui.bubble;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** 6.7: the hold area beside a hold-to-read bubble — a short still hold reveals; a scroll or a quick tap does not. */
public class HoldGestureTest {
    private static final float SLOP = 16;

    @Test public void aStillHoldRevealsUntilTheFingerLifts() {
        HoldGesture g = new HoldGesture(180, SLOP);
        assertEquals(HoldGesture.Step.ARM, g.down(100, 40, 1000));
        assertEquals(HoldGesture.Step.NONE, g.move(104, 43)); // a finger trembles
        assertEquals(HoldGesture.Step.NONE, g.due(1100));     // not yet
        assertTrue(g.armed());
        assertEquals(HoldGesture.Step.REVEAL, g.due(1180));
        assertTrue(g.revealed());
        assertEquals(HoldGesture.Step.NONE, g.due(1300));     // once
        assertEquals(HoldGesture.Step.NONE, g.move(300, 200)); // revealed: the finger may wander
        assertEquals(HoldGesture.Step.HIDE, g.up());
        assertFalse(g.revealed());
    }

    @Test public void aScrollThatStartsHereRevealsNothing() {
        HoldGesture g = new HoldGesture(180, SLOP);
        g.down(100, 40, 1000);
        assertEquals(HoldGesture.Step.CANCEL, g.move(100, 70));
        assertEquals(HoldGesture.Step.NONE, g.due(2000));
        assertFalse(g.revealed());
        assertEquals(HoldGesture.Step.NONE, g.up());
    }

    @Test public void aQuickTapRevealsNothing() {
        HoldGesture g = new HoldGesture(180, SLOP);
        g.down(10, 10, 0);
        assertEquals(HoldGesture.Step.CANCEL, g.up());
        assertEquals(HoldGesture.Step.NONE, g.due(500));
        assertFalse(g.revealed());
    }

    @Test public void theWebWaitsAsLong() {
        assertEquals(180, HoldGesture.DELAY_MS); // client MessageBubble.tsx HOLD_SIDE_MS
    }
}
