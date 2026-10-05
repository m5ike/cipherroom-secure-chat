package cz.m5cet.app.security;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * The rules of the unlock-attempt counter (AppLock keeps the record in the
 * system tier). Pure: the state is the record, the time is given — the JVM
 * tests run it.
 *
 * 6.7 (audit S10): an attempt counts before the slow PIN derivation —
 * begin() raises the counter and marks it "pending", and AppLock stores that
 * before deriving. Killing the app during the derivation therefore cannot
 * forget the attempt: the pending mark survives, and the next attempt
 * settles it as a failure first (with its wait, lock-out or wipe).
 *
 * 6.12 (F-16): the record is sealed by a Keystore key that changes with every
 * write (LockStore) — an older copy is a rollback and counts as every attempt
 * used (rolledBack).
 */
final class LockCounter {
    private LockCounter() {}

    enum Outcome { WRONG, LOCKED_OUT, WIPE }

    static final long LOCKOUT_MS = 3600_000L;

    /** The attempt about to be checked counts now; returns the new count. */
    static int begin(JSONObject s, long now) throws JSONException {
        int attempts = s.optInt("attempts", 0) + 1;
        s.put("attempts", attempts).put("last", now).put("pending", now);
        return attempts;
    }

    /** An attempt was begun and never finished (the app died while checking it). */
    static boolean interrupted(JSONObject s) { return s.has("pending"); }

    /**
     * A wrong answer, or one that never came: decides on the wait, the
     * lock-out or the wipe. An attempt begin() counted already is not counted
     * twice; any other failure (a rejected finger) is counted here.
     */
    static Outcome settle(JSONObject s, long now, int maxAttempts, boolean wipe, boolean backoff) throws JSONException {
        int attempts = s.optInt("attempts", 0);
        if (!s.has("pending")) attempts++;
        s.remove("pending");
        s.put("attempts", attempts).put("last", now);
        if (attempts >= maxAttempts) {
            if (wipe) return Outcome.WIPE;
            s.put("until", now + LOCKOUT_MS);
            return Outcome.LOCKED_OUT;
        }
        if (backoff && attempts >= 3) s.put("until", now + waitMs(attempts));
        return Outcome.WRONG;
    }

    /** 30 s after the third failure, doubling, at most an hour. */
    static long waitMs(int attempts) {
        return Math.min(3600L, 30L << Math.min(10, Math.max(0, attempts - 3))) * 1000L;
    }

    static JSONObject fresh() {
        try { return new JSONObject().put("attempts", 0).put("until", 0); }
        catch (JSONException e) { throw new IllegalStateException(e); }
    }

    /**
     * 6.12 (F-16, LockStore): the counter after a rollback was found — one
     * short of the maximum, so the failure it is settled as is the last one
     * (the policy's wipe, or the lock-out).
     */
    static JSONObject rolledBack(int maxAttempts) {
        try { return new JSONObject().put("attempts", Math.max(0, maxAttempts - 1)).put("until", 0); }
        catch (JSONException e) { throw new IllegalStateException(e); }
    }
}
