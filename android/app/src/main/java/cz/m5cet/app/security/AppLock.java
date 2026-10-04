package cz.m5cet.app.security;

import android.security.keystore.KeyPermanentlyInvalidatedException;

import org.json.JSONException;
import org.json.JSONObject;

import java.security.GeneralSecurityException;

import javax.crypto.Cipher;

import cz.m5cet.app.M5;
import cz.m5cet.app.core.Events;
import cz.m5cet.app.core.Log;

/**
 * Opening the app: biometrics or the PIN, the policy from the console
 * (biometric required/optional/off, PIN length, attempts, wipe, a growing
 * wait, auto-lock). Every failure — a wrong PIN or a rejected finger — counts;
 * after the last allowed one the device wipes itself (or locks for an hour)
 * and tells the server. The counter lives in the system tier, so killing
 * the app does not reset it.
 */
public final class AppLock {
    public enum Result { OK, WRONG, WAIT, WIPED, LOCKED_OUT }

    private final M5 app;
    /** The UI is locked (the data key may still be in memory for the open rooms). */
    private volatile boolean uiLocked = true;
    private volatile long backgroundSince = 0;

    public AppLock(M5 app) { this.app = app; }

    private JSONObject state() { return app.vault.json(Vault.Tier.SYS, "lock"); }
    private void save(JSONObject s) { app.vault.putJson(Vault.Tier.SYS, "lock", s); }

    public JSONObject policy() { return app.config.lockPolicy(); }
    public int pinLength() { return Math.max(4, Math.min(12, policy().optInt("pinLength", 6))); }
    public int maxAttempts() { return Math.max(3, Math.min(20, policy().optInt("maxAttempts", 8))); }
    public boolean wipeOnMax() { return policy().optBoolean("wipe", true); }
    public String biometricMode() { return policy().optString("biometric", "optional"); }
    public boolean screenshots() { return policy().optBoolean("screenshots", false); }
    public int autolockSeconds() { return Math.max(0, Math.min(86_400, policy().optInt("autolockSeconds", 60))); }

    public boolean isSetUp() { return app.vault.hasUserKey(); }
    /**
     * 6.7 (audit S11): also locked once the app has been in the background
     * longer than the auto-lock allows — not only after it comes back to the
     * foreground — so notifications (Rooms → Notify) go neutral in time.
     */
    public boolean isLocked() { return uiLocked || !app.vault.unlocked() || autolockDue(backgroundSince, System.currentTimeMillis(), autolockSeconds()); }

    /** In the background (since > 0) at least the auto-lock time: locked, as if it had come back. */
    static boolean autolockDue(long backgroundSince, long now, int autolockSeconds) {
        return backgroundSince > 0 && now - backgroundSince >= autolockSeconds * 1000L;
    }
    public int attempts() { return state().optInt("attempts", 0); }
    public int left() { return Math.max(0, maxAttempts() - attempts()); }

    /** Seconds until the next attempt is allowed. */
    public long waitSeconds() {
        long until = state().optLong("until", 0);
        long left = until - System.currentTimeMillis();
        return left > 0 ? (left + 999) / 1000 : 0;
    }

    public void setUp(String pin) throws GeneralSecurityException {
        app.vault.createUserKey(pin);
        reset();
        uiLocked = false;
        Log.i("lock", "PIN set up");
    }

    private void reset() { save(LockCounter.fresh()); }

    public synchronized Result unlockWithPin(String pin) {
        // An attempt the app was killed in the middle of counts as a failure first.
        if (LockCounter.interrupted(state())) {
            Result r = failed("pin-interrupted");
            if (r != Result.WRONG) return r;
        }
        if (waitSeconds() > 0) return Result.WAIT;
        // 6.7 (audit S10): the attempt is counted and stored BEFORE the slow derivation (PBKDF2 +
        // Keystore), so killing the app meanwhile cannot undo it. Not stored → not checked.
        try {
            JSONObject s = state();
            LockCounter.begin(s, System.currentTimeMillis());
            app.vault.put(Vault.Tier.SYS, "lock", Crypto.utf8(s.toString()));
        } catch (GeneralSecurityException | JSONException e) {
            Log.e("lock", "the attempt could not be counted; not checking the PIN", e);
            return Result.WAIT;
        }
        try {
            if (app.vault.unlockWithPin(pin)) { succeeded("pin"); return Result.OK; }
        } catch (GeneralSecurityException e) {
            Log.e("lock", "PIN unlock failed", e);
        }
        return failed("pin");
    }

    private void succeeded(String how) {
        JSONObject s = state();
        int before = s.optInt("attempts", 0) - (LockCounter.interrupted(s) ? 1 : 0); // not the attempt that just opened it
        reset();
        uiLocked = false;
        if (before > 0) app.events.add("unlock", Events.detail("method", how, "after", before));
        app.onUnlocked();
    }

    /** A failure of either kind; decides on the wait, the lock-out or the wipe. */
    public synchronized Result failed(String how) {
        JSONObject s = state();
        LockCounter.Outcome o;
        try {
            o = LockCounter.settle(s, System.currentTimeMillis(), maxAttempts(), wipeOnMax(), policy().optBoolean("backoff", true));
        } catch (JSONException e) {
            o = LockCounter.Outcome.WRONG;
        }
        int attempts = s.optInt("attempts", 0);
        save(s);
        if (o == LockCounter.Outcome.WRONG) {
            app.events.add("unlock-failed", Events.detail("attempts", attempts, "method", how, "left", Math.max(0, maxAttempts() - attempts)));
            return Result.WRONG;
        }
        app.events.add("lockout", Events.detail("attempts", attempts, "method", how, "wipe", o == LockCounter.Outcome.WIPE));
        if (o == LockCounter.Outcome.WIPE) {
            Wiper.wipe(app, "attempts", false, attempts);
            return Result.WIPED;
        }
        return Result.LOCKED_OUT;
    }

    /* ---------------------------------------------------------- biometrics */

    public boolean biometricAvailable() {
        return !"off".equals(biometricMode()) && app.vault.bioEnrolled() && Biometric.available(app);
    }

    /** The cipher for the prompt; null (and biometrics switched off) when the key was invalidated. */
    public Cipher bioCipher() {
        try {
            return app.vault.bioUnlockCipher();
        } catch (KeyPermanentlyInvalidatedException e) {
            app.vault.disableBio();
            app.events.add("key-invalidated", Events.detail("reason", "biometrics changed"));
            return null;
        } catch (GeneralSecurityException e) {
            Log.e("lock", "no biometric cipher", e);
            return null;
        }
    }

    public Result bioSucceeded(Cipher cipher) {
        try {
            app.vault.finishBioUnlock(cipher);
            succeeded("biometric");
            return Result.OK;
        } catch (GeneralSecurityException e) {
            Log.e("lock", "biometric unlock failed", e);
            return failed("biometric");
        }
    }

    /* ------------------------------------------------------------- locking */

    public void onBackground() { backgroundSince = System.currentTimeMillis(); }

    /** On return to the app: locks the UI when it was away longer than the policy allows. */
    public void onForeground() {
        if (autolockDue(backgroundSince, System.currentTimeMillis(), autolockSeconds())) uiLocked = true;
        backgroundSince = 0;
    }

    /** Locks the screen; `full` also forgets the data key and closes the rooms. */
    public void lockNow(boolean full) {
        uiLocked = true;
        if (full) {
            app.rooms.disconnectAll();
            app.vault.lock();
        }
        app.onLocked();
    }
}
