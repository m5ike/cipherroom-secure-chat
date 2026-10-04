package cz.m5cet.app.security;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;

/**
 * 6.7 (audit S10, S11): the attempt counts before the slow PIN check (a killed
 * app cannot forget it), the wipe after the last attempt stays, and the
 * auto-lock applies while the app is still in the background.
 */
public class LockCounterTest {
    private static final long T = 1_700_000_000_000L;

    /** The record as AppLock stores it — a JSON round trip, like the vault's. */
    private static JSONObject stored(JSONObject s) throws JSONException { return new JSONObject(s.toString()); }

    @Test
    public void anAttemptCountsBeforeTheCheck() throws JSONException {
        JSONObject s = LockCounter.fresh();
        assertEquals(1, LockCounter.begin(s, T));
        // The app is killed during the derivation: what was stored already holds the attempt.
        JSONObject afterKill = stored(s);
        assertEquals(1, afterKill.getInt("attempts"));
        assertTrue(LockCounter.interrupted(afterKill));
        // The next attempt settles it as a failure — counted once, not twice.
        assertEquals(LockCounter.Outcome.WRONG, LockCounter.settle(afterKill, T + 5, 8, true, true));
        assertEquals(1, afterKill.getInt("attempts"));
        assertFalse(LockCounter.interrupted(afterKill));
    }

    @Test
    public void killingTheAppEveryTimeStillReachesTheWipe() throws JSONException {
        JSONObject s = LockCounter.fresh();
        LockCounter.Outcome last = null;
        for (int i = 0; i < 8; i++) {
            s = stored(s);
            if (LockCounter.interrupted(s)) {
                last = LockCounter.settle(s, T + i, 8, true, false);
                if (last != LockCounter.Outcome.WRONG) break;
            }
            LockCounter.begin(s, T + i); // …and killed before an answer, again
        }
        s = stored(s);
        assertTrue(LockCounter.interrupted(s));
        assertEquals(8, s.getInt("attempts"));
        assertEquals(LockCounter.Outcome.WIPE, LockCounter.settle(s, T + 100, 8, true, false));
    }

    @Test
    public void theRightPinOnTheLastAttemptDoesNotWipe() throws JSONException {
        JSONObject s = LockCounter.fresh();
        for (int i = 0; i < 7; i++) { LockCounter.begin(s, T); assertEquals(LockCounter.Outcome.WRONG, LockCounter.settle(s, T, 8, true, false)); }
        assertEquals(8, LockCounter.begin(s, T)); // the 8th counts first…
        s = LockCounter.fresh();                  // …and the right PIN resets it (AppLock.succeeded)
        assertEquals(0, s.getInt("attempts"));
    }

    @Test
    public void aWrongLastAttemptWipesOrLocksOut() throws JSONException {
        JSONObject s = new JSONObject().put("attempts", 7);
        LockCounter.begin(s, T);
        assertEquals(LockCounter.Outcome.WIPE, LockCounter.settle(stored(s), T, 8, true, true));
        JSONObject l = stored(s);
        assertEquals(LockCounter.Outcome.LOCKED_OUT, LockCounter.settle(l, T, 8, false, true));
        assertEquals(T + LockCounter.LOCKOUT_MS, l.getLong("until"));
    }

    @Test
    public void aRejectedFingerCountsOnce() throws JSONException {
        JSONObject s = LockCounter.fresh();
        assertEquals(LockCounter.Outcome.WRONG, LockCounter.settle(s, T, 8, true, true));
        assertEquals(1, s.getInt("attempts"));
        assertEquals(LockCounter.Outcome.WRONG, LockCounter.settle(s, T, 8, true, true));
        assertEquals(2, s.getInt("attempts"));
    }

    @Test
    public void theWaitGrowsFromTheThirdFailure() throws JSONException {
        JSONObject s = LockCounter.fresh();
        for (int i = 0; i < 2; i++) { LockCounter.begin(s, T); LockCounter.settle(s, T, 20, true, true); }
        assertEquals(0, s.optLong("until", 0));
        LockCounter.begin(s, T);
        LockCounter.settle(s, T, 20, true, true);
        assertEquals(T + 30_000, s.getLong("until"));
        assertEquals(60_000, LockCounter.waitMs(4));
        assertEquals(3_600_000, LockCounter.waitMs(19));
        JSONObject noBackoff = new JSONObject().put("attempts", 5);
        LockCounter.settle(noBackoff, T, 20, true, false);
        assertFalse(noBackoff.has("until"));
    }

    @Test
    public void autolockAppliesInTheBackground() {
        assertFalse(AppLock.autolockDue(0, T, 60));               // in the foreground
        assertFalse(AppLock.autolockDue(T, T + 59_999, 60));      // away less than the auto-lock
        assertTrue(AppLock.autolockDue(T, T + 60_000, 60));       // away long enough: locked before it returns
        assertTrue(AppLock.autolockDue(T, T, 0));                 // auto-lock 0: at once
    }
}
