package cz.m5cet.app.telecom;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * 6.12 (security analysis G-22, the rest): a message notification is kept
 * off the phone's lock screen (VISIBILITY_SECRET) when the person hides it
 * there or while the app is locked; otherwise as before (PRIVATE); a call's
 * ring never.
 */
public class LockScreenTest {
    @Test
    public void messagesLeaveTheLockScreenWhenHiddenOrLocked() {
        for (String kind : new String[]{ "message", "mention", "function", "summon", "test", "notify.message" }) {
            assertFalse(kind + ": as before", LockScreen.secret(kind, false, false));
            assertTrue(kind + ": the person hides it", LockScreen.secret(kind, false, true));
            assertTrue(kind + ": the app is locked", LockScreen.secret(kind, true, false));
            assertTrue(kind, LockScreen.secret(kind, true, true));
        }
    }

    @Test
    public void aRingStaysAnswerable() {
        for (String kind : new String[]{ "call", "ring.call", "ring.missed" }) {
            assertFalse(kind, LockScreen.secret(kind, true, true));
            assertFalse(kind, LockScreen.secret(kind, false, true));
        }
        assertEquals("notify.lockScreenHide", LockScreen.SETTING);
    }
}
