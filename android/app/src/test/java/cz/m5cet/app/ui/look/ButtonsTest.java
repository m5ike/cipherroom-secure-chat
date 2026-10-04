package cz.m5cet.app.ui.look;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/** 6.7: a wide button's icon moves in to its centred label. */
public class ButtonsTest {
    @Test public void theIconMovesHalfTheRoomTheLabelLeaves() {
        // 300 px for the label, which takes 100: the label starts 100 px in, so the icon moves 100 px too.
        assertEquals(100, Buttons.offset(300, 100));
        assertEquals(0, Buttons.offset(300, 300));
        // a label longer than its room (ellipsized, wrapped) leaves the icon at the edge
        assertEquals(0, Buttons.offset(300, 420));
        assertEquals(0, Buttons.offset(0, 50));
        assertEquals(0, Buttons.offset(-10, 50));
        assertEquals(50, Buttons.offset(100, 0));
    }
}
