package cz.m5cet.app.ui;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.util.HashMap;
import java.util.Map;

/**
 * The expressions of the 6.2 trees (server/android/design-62-fixes.ts) as the
 * app evaluates them: the lock screen's header and layout, Settings › User's
 * device-bound account.
 */
public class LockTreeExprTest {
    static final String TITLE = "{=$lock.setup ? _('lock.setupTitle') : _('lock.title')}";
    static final String HINT = "{=$lock.setup ? _('lock.setupHint') : ($lock.mode == 'biometric' ? _('lock.useBiometric') : _('lock.enterPin'))}";
    static final String BIO = "$lock.biometricAvailable && $lock.wait == 0";

    static final Expr.Translate TR = k -> "[" + k + "]";

    private static Expr.Scope scope(String name, JSONObject value) {
        Map<String, Object> m = new HashMap<>();
        m.put(name, value);
        return Expr.scope(m);
    }

    private static boolean truthy(String src, Expr.Scope s) { return Expr.truthy(Expr.eval(src, s, TR)); }

    @Test
    public void lockHeader() throws Exception {
        Expr.Scope locked = scope("lock", new JSONObject().put("mode", "pin").put("setup", false).put("wait", 0).put("biometricAvailable", true).put("wide", false));
        assertNull(Expr.check(TITLE.substring(2, TITLE.length() - 1)));
        assertNull(Expr.check(HINT.substring(2, HINT.length() - 1)));
        assertEquals("[lock.title]", Expr.render(TITLE, locked, TR));
        assertEquals("[lock.enterPin]", Expr.render(HINT, locked, TR));
        assertTrue(truthy(BIO, locked));
        assertTrue(truthy("!$lock.wide", locked));
        assertFalse(truthy("$lock.wide", locked));

        Expr.Scope bio = scope("lock", new JSONObject().put("mode", "biometric").put("setup", false).put("wait", 30).put("biometricAvailable", true).put("wide", true));
        assertEquals("[lock.useBiometric]", Expr.render(HINT, bio, TR));
        assertFalse(truthy(BIO, bio));
        assertTrue(truthy("$lock.wide", bio));

        Expr.Scope setup = scope("lock", new JSONObject().put("mode", "pin").put("setup", true).put("step", "confirm").put("wait", 0).put("biometricAvailable", false));
        assertEquals("[lock.setupTitle]", Expr.render(TITLE, setup, TR));
        assertEquals("[lock.setupHint]", Expr.render(HINT, setup, TR));
        assertFalse(truthy(BIO, setup));
        // A scope from before 6.2 (no wide): the tall layout.
        assertTrue(truthy("!$lock.wide", scope("lock", new JSONObject().put("mode", "pin"))));
    }

    @Test
    public void deviceBoundAccount() throws Exception {
        Expr.Scope bound = scope("account", new JSONObject().put("signedIn", true).put("deviceBound", true).put("canSeal", true).put("recovery", false));
        assertTrue(truthy("$account.signedIn && $account.deviceBound", bound));
        assertEquals("primary", Expr.value("=$account.deviceBound && !$account.recovery ? 'primary' : 'tonal'", bound, TR));
        assertEquals("[set.user.recoveryCreate]", Expr.render("{=$account.recovery ? _('set.user.recoveryReplace') : _('set.user.recoveryCreate')}", bound, TR));

        Expr.Scope usual = scope("account", new JSONObject().put("signedIn", true).put("deviceBound", false).put("canSeal", true).put("recovery", true));
        assertFalse(truthy("$account.signedIn && $account.deviceBound", usual));
        assertEquals("tonal", Expr.value("=$account.deviceBound && !$account.recovery ? 'primary' : 'tonal'", usual, TR));
        assertEquals("[set.user.recoverySet]", Expr.render("{=$account.recovery ? _('set.user.recoverySet') : _('set.user.recoveryNone')}", usual, TR));
    }
}
