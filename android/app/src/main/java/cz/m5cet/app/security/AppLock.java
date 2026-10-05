package cz.m5cet.app.security;

import android.security.keystore.KeyPermanentlyInvalidatedException;

import org.json.JSONException;
import org.json.JSONObject;

import java.security.GeneralSecurityException;
import java.util.Set;

import javax.crypto.Cipher;

import cz.m5cet.app.M5;
import cz.m5cet.app.chat.RoomSession;
import cz.m5cet.app.core.Events;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;

/**
 * Opening the app: biometrics or the PIN, the policy from the console
 * (biometric required/optional/off, PIN length, attempts, wipe, a growing
 * wait, auto-lock). Every failure — a wrong PIN or a rejected finger — counts;
 * after the last allowed one the device wipes itself (or locks for an hour)
 * and tells the server. The counter lives in the system tier, so killing
 * the app does not reset it.
 *
 * 6.12 (security analysis F-16):
 *   - a lock forgets: "Lock" (the menu, the design's lock.now, the server's
 *     lock command) and the auto-lock (back from the background, or its time
 *     passing there — M5.whenLocked) zero the vault's data key and drop what
 *     was opened with it (M5.forgetSecrets). By default the open rooms keep
 *     receiving into the lock inbox (chat/LockedRooms), merged at the unlock;
 *     with security.lockDisconnect they close too. The next unlock derives
 *     the key again. During a call the key stays until the call ends (the
 *     screen is locked at once), and while the unlock merges the inbox;
 *   - the attempt counter is sealed by a Keystore key that changes with every
 *     write (LockStore): an older copy of the vault's files does not give the
 *     attempts back — a rollback counts as every attempt used (the policy's
 *     wipe or lock-out);
 *   - the duress PIN (Duress, off by default) erases the app.
 */
public final class AppLock {
    public enum Result { OK, WRONG, WAIT, WIPED, LOCKED_OUT, DURESS }

    /** How often a lock that waits for a call to end looks again. */
    static final long FORGET_RETRY_MS = 15_000;

    private final M5 app;
    /** The UI is locked (6.12: the data key is gone too, except while a call keeps it — forgetWaiting). */
    private volatile boolean uiLocked = true;
    private volatile long backgroundSince = 0;
    /** 6.12: locked during a call — the data key goes when the call ends. */
    private volatile boolean forgetWaiting;
    private final LockStore store;

    public AppLock(M5 app) {
        this.app = app;
        this.store = new LockStore(new KeystoreAnchor(), new LockStore.Records() {
            @Override public JSONObject read() { return app.vault.strictJson(Vault.Tier.SYS, "lock"); }
            @Override public boolean write(JSONObject r) {
                try { app.vault.putDurable(Vault.Tier.SYS, "lock", Crypto.utf8(r.toString())); return true; }
                catch (GeneralSecurityException e) { Log.e("lock", "the attempt counter could not be written", e); return false; }
            }
        });
    }

    /** The counter's seal in the Keystore (m5.ctr.N). */
    private static final class KeystoreAnchor implements LockStore.Anchor {
        @Override public Set<Long> generations() { return Keystore.counterGenerations(); }
        @Override public boolean create(long gen) { return Keystore.newCounterKey(gen); }
        @Override public void delete(long gen) { Keystore.delete(Keystore.COUNTER + gen); }
        @Override public byte[] mac(long gen, byte[] data) {
            try { return Keystore.hmacBy(Keystore.COUNTER + gen, data); }
            catch (GeneralSecurityException | RuntimeException e) { return null; }
        }
    }

    /** The counter as the lock screen shows it (not checked — what decides is verified()). */
    private JSONObject state() {
        JSONObject r = app.vault.strictJson(Vault.Tier.SYS, "lock");
        return r == null ? new JSONObject() : LockStore.fields(r);
    }

    /** 6.12: the counter checked against its Keystore seal. */
    private LockStore.View verified() { return store.load(); }

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
     * foreground — so new notifications (Rooms → Notify) are neutral in time.
     * There is no event at that moment: those posted before become neutral by
     * Conversations' lock timer and alarm (M5.whenLocked → Notify.neutralizeAll, 6.10 G-22),
     * which 6.12 (F-16) also lets forget the data key (autolocked).
     */
    public boolean isLocked() { return uiLocked || !app.vault.unlocked() || autolockDue(backgroundSince, System.currentTimeMillis(), autolockSeconds()); }

    /** In the background (since > 0) at least the auto-lock time: locked, as if it had come back. */
    static boolean autolockDue(long backgroundSince, long now, int autolockSeconds) {
        return backgroundSince > 0 && now - backgroundSince >= autolockSeconds * 1000L;
    }
    public int attempts() { return state().optInt("attempts", 0); }
    public int left() { return Math.max(0, maxAttempts() - attempts()); }

    /** Seconds until the next attempt is allowed. */
    public long waitSeconds() { return waitSeconds(state()); }

    private static long waitSeconds(JSONObject s) {
        long left = s.optLong("until", 0) - System.currentTimeMillis();
        return left > 0 ? (left + 999) / 1000 : 0;
    }

    /** 6.12: what protects the PIN (Vault.pinKeyLevel) — the security screen shows it. */
    public String pinKeyLevel() { return app.vault.pinKeyLevel(); }

    public void setUp(String pin) throws GeneralSecurityException {
        app.vault.createUserKey(pin);
        reset();
        uiLocked = false;
        Log.i("lock", "PIN set up");
    }

    private void reset() { if (!store.save(LockCounter.fresh())) Log.w("lock", "the attempt counter could not be reset"); }

    public synchronized Result unlockWithPin(String pin) { return attemptPin(pin, true); }

    /** 6.7 (audit N18): the current PIN before a change — counted (and wiped after) like an unlock. */
    public synchronized Result confirmPin(String pin) { return attemptPin(pin, false); }

    private Result attemptPin(String pin, boolean unlock) {
        // 6.12: the duress PIN first, also during a wait — it only erases.
        if (unlock && Duress.check(app, pin)) return duress();
        LockStore.View v = verified();
        if (v.verdict == LockStore.Verdict.ROLLBACK) return rolledBack();
        JSONObject s = v.state;
        // An attempt the app was killed in the middle of counts as a failure first.
        if (LockCounter.interrupted(s)) {
            Result r = failed("pin-interrupted");
            if (r != Result.WRONG) return r;
            s = verified().state;
        }
        if (waitSeconds(s) > 0) return Result.WAIT;
        // 6.7 (audit S10): the attempt is counted and stored BEFORE the slow derivation (PBKDF2 +
        // Keystore), so killing the app meanwhile cannot undo it. Not stored → not checked.
        // 6.12: stored sealed by a new Keystore key generation (LockStore), the directory synced.
        try {
            LockCounter.begin(s, System.currentTimeMillis());
        } catch (JSONException e) {
            return Result.WAIT;
        }
        if (!store.save(s)) {
            Log.e("lock", "the attempt could not be counted; not checking the PIN", null);
            return Result.WAIT;
        }
        try {
            if (app.vault.unlockWithPin(pin)) { if (unlock) succeeded("pin"); else reset(); return Result.OK; }
        } catch (GeneralSecurityException e) {
            Log.e("lock", "PIN unlock failed", e);
        }
        return failed("pin");
    }

    /** 6.12: an older copy of the counter (or none where one must be) — every attempt counts as used. */
    private Result rolledBack() {
        Log.w("lock", "the attempt counter does not match its Keystore seal: every attempt counts as used");
        return failed("rollback");
    }

    /** 6.12: the duress PIN — the app erases itself (quietly: no "data erased" notice on the next start). */
    private Result duress() {
        Log.w("lock", "the duress PIN was typed");
        Wiper.wipe(app, "duress", false, 0, true);
        return Result.DURESS;
    }

    private void succeeded(String how) {
        JSONObject s = state();
        int before = s.optInt("attempts", 0) - (LockCounter.interrupted(s) ? 1 : 0); // not the attempt that just opened it
        reset();
        uiLocked = false;
        forgetWaiting = false;
        if (before > 0) app.events.add("unlock", Events.detail("method", how, "after", before));
        app.onUnlocked();
    }

    /** A failure of either kind; decides on the wait, the lock-out or the wipe. */
    public synchronized Result failed(String how) {
        LockStore.View v = verified();
        // 6.12: a rollback leaves one attempt short of the maximum, this failure is the last one.
        JSONObject s = v.verdict == LockStore.Verdict.ROLLBACK ? LockCounter.rolledBack(maxAttempts()) : v.state;
        LockCounter.Outcome o;
        try {
            o = LockCounter.settle(s, System.currentTimeMillis(), maxAttempts(), wipeOnMax(), policy().optBoolean("backoff", true));
        } catch (JSONException e) {
            o = LockCounter.Outcome.WRONG;
        }
        int attempts = s.optInt("attempts", 0);
        if (!store.save(s)) Log.w("lock", "the failure could not be stored");
        if (o == LockCounter.Outcome.WRONG) {
            app.events.add("unlock-failed", Events.detail("attempts", attempts, "method", how, "left", Math.max(0, maxAttempts() - attempts)));
            return Result.WRONG;
        }
        app.events.add("lockout", Events.detail("attempts", attempts, "method", how, "wipe", o == LockCounter.Outcome.WIPE));
        if (o == LockCounter.Outcome.WIPE) {
            Wiper.wipe(app, "rollback".equals(how) ? "rollback" : "attempts", false, attempts);
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

    public synchronized Result bioSucceeded(Cipher cipher) {
        // 6.12: a finger does not open a counter that was put back.
        if (verified().verdict == LockStore.Verdict.ROLLBACK) return rolledBack();
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

    /** On return to the app: locks (6.12: and forgets) when it was away longer than the policy allows. */
    public void onForeground() {
        boolean due = autolockDue(backgroundSince, System.currentTimeMillis(), autolockSeconds());
        backgroundSince = 0;
        if (!due) return;
        boolean was = uiLocked;
        uiLocked = true;
        boolean held = app.vault.unlocked();
        forgetOrWait(false);
        if (!was || held) app.emit("locked");
    }

    /**
     * Locks the screen and (6.12, F-16) forgets the data key: the rooms close,
     * the key is zeroed, what was opened with it goes (M5.forgetSecrets).
     * remote (the server's lock command): at once, a call or not; otherwise a
     * call keeps the key until it ends.
     */
    public void lockNow(boolean remote) {
        uiLocked = true;
        forgetOrWait(remote);
        app.onLocked();
    }

    /**
     * 6.12 (F-16): the auto-lock's time passed in the background (M5.whenLocked:
     * Conversations' timer and alarm) — the data key goes then too, not only
     * when the app comes back. Main thread.
     */
    public void autolocked() {
        if (!isLocked() || !app.vault.unlocked() || forgetWaiting) return;
        boolean was = uiLocked;
        uiLocked = true;
        forgetOrWait(false);
        if (!was) app.emit("locked");
    }

    private void forgetOrWait(boolean force) {
        if (!app.vault.unlocked()) return;
        // A call keeps the key until it ends; the unlock's merge of the lock inbox needs it until it is done (moments).
        boolean draining = cz.m5cet.app.chat.LockedRooms.draining();
        if ((!force && inCall()) || draining) {
            if (!forgetWaiting) {
                forgetWaiting = true;
                Log.i("lock", draining ? "locked while the lock inbox is merged: the data key goes right after" : "locked during a call: the data key goes when it ends");
                Io.mainLater(this::retryForget, draining ? 1_000 : FORGET_RETRY_MS);
            }
            return;
        }
        forgetWaiting = false;
        app.forgetSecrets();
    }

    private void retryForget() {
        if (!forgetWaiting) return;
        forgetWaiting = false;
        if (isLocked() && app.vault.unlocked()) forgetOrWait(false);
    }

    /** A call of any open room (the key stays for it). */
    private boolean inCall() {
        try {
            for (RoomSession r : app.rooms.connectedSessions()) if (!"off".equals(r.calls().state())) return true;
        } catch (RuntimeException ignored) { }
        return false;
    }
}
