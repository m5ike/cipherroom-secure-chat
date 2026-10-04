package cz.m5cet.app.ui;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

import cz.m5cet.app.core.SettingSchema;

/**
 * 6.10 (security analysis G-20, G-21 — the class of F-01): an action of the
 * design cannot carry data it computed off the phone, nor change a privacy
 * setting (ui/ActionGuard, Actions.run).
 */
public class ActionGuardTest {
    private static final Expr.Translate TR = k -> k;

    /** A bubble's scope: a decrypted message, the log of every room, the open person. */
    private static Expr.Scope scope() {
        JSONObject msg = new JSONObject(), person = new JSONObject();
        JSONArray log = new JSONArray();
        try {
            msg.put("text", "the secret plaintext").put("id", "msg-1");
            person.put("username", "alice");
            log.put(new JSONObject().put("preview", "another secret"));
        } catch (Exception e) { throw new IllegalStateException(e); }
        JSONObject form = new JSONObject();
        try { form.put("person", person); } catch (Exception e) { throw new IllegalStateException(e); }
        return n -> n.equals("msg") ? msg : n.equals("log") ? log : n.equals("form") ? form : n.equals("value") ? 1.2 : null;
    }

    /** What the action would get, and whether it may run (null = yes). */
    private static String check(String action, String raw) { return check(action, raw, null); }

    private static String check(String action, String raw, String own) {
        Object value = raw == null ? null : Expr.value(raw, scope(), TR);
        return ActionGuard.check(action, raw, value, own);
    }

    @Test
    public void whatReadsData() {
        assertFalse(Expr.readsData(null));
        assertFalse(Expr.readsData("https://help.example/android"));
        assertFalse(Expr.readsData("{_'help.url'}"));
        assertFalse(Expr.readsData("=_('help.url')"));
        assertFalse(Expr.readsData("='https://a.example/' + 'x'"));
        assertFalse(Expr.readsData("a {{literal} brace"));
        assertTrue(Expr.readsData("{$msg.text}"));
        assertTrue(Expr.readsData("https://e.example/?q={$msg.text|upper}"));
        assertTrue(Expr.readsData("=$msg.text"));
        assertTrue(Expr.readsData("{=$log[0].preview}"));
        assertTrue(Expr.readsData("{=true ? 'x' : $msg.text}"));
        assertTrue(Expr.readsData("{=_('k') + $msg.text}"));
        assertTrue(Expr.readsData("=-$msg.n"));
        assertTrue(Expr.readsData("=!$msg.n"));
        assertTrue(Expr.readsData("={'unclosed"));         // unparsable: counts as data
        assertTrue(Expr.readsData("x {unclosed"));
    }

    @Test
    public void networkActionsTakeOnlyTheDesignsLiteral() {
        for (String action : new String[]{ "url.open", "lib.run", "fn.run", "profile.public" }) {
            assertEquals(action, ActionGuard.COMPUTED, check(action, "https://evil.example/?{$msg.text}"));
            assertEquals(action, ActionGuard.COMPUTED, check(action, "=$msg.text"));
            assertEquals(action, ActionGuard.COMPUTED, check(action, "{=$log[0].preview}"));
            assertEquals(action + ": a value without the raw text", ActionGuard.COMPUTED, ActionGuard.check(action, null, "https://evil.example/x", null));
        }
        assertNull(check("url.open", "https://help.example/android"));
        assertNull(check("url.open", "{_'help.url'}"));
        assertNull(check("lib.run", "lock-and-rooms"));
        assertNull(check("fn.run", "/help"));
        assertNull(check("profile.public", "bob"));
        assertNull("no argument at all", ActionGuard.check("lib.run", null, null, null));
    }

    @Test
    public void profilePublicMayNameTheOpenPersonOnly() {
        // The default design: profile.public {$form.person.username} on the person's detail.
        assertNull(check("profile.public", "{$form.person.username}", "alice"));
        assertEquals(ActionGuard.COMPUTED, check("profile.public", "{$msg.text}", "alice"));
        assertEquals("no detail open", ActionGuard.COMPUTED, check("profile.public", "{$form.person.username}", null));
        assertEquals(ActionGuard.COMPUTED, check("profile.public", "{$form.person.username}", ""));
    }

    @Test
    public void aSettingsKeyIsLiteralItsValueWithinTheRule() {
        assertNull(check("setting.set", "voice.rate={$value}"));
        assertNull(check("setting.set", "voice.rate=1.5"));
        assertNull(check("setting.set", "voice.lang=de"));
        assertEquals(ActionGuard.OUTSIDE, check("setting.set", "voice.rate=99"));
        assertEquals(ActionGuard.OUTSIDE, check("setting.set", "voice.lang={$msg.text}"));
        assertEquals(ActionGuard.COMPUTED_KEY, check("setting.set", "{$msg.text}=1"));
        assertEquals(ActionGuard.COMPUTED_KEY, check("setting.set", "=$msg.text + '=1'"));
        assertEquals("data inside the key", ActionGuard.COMPUTED_KEY, check("setting.set", "voice.{$msg.n}rate=1"));
        assertNull("a constant inside the key reads nothing", check("setting.set", "voice.{=''}rate=1"));
        assertEquals(ActionGuard.COMPUTED_KEY, ActionGuard.check("setting.set", null, "voice.rate=1", null));
        assertEquals(ActionGuard.UNKNOWN, check("setting.set", "no.such.key=1"));
        assertNull("nothing to set", check("setting.set", "voice.rate"));
        // look.set: the same rules (appearance.* / look.*)
        assertNull(check("look.set", "look.font=sans"));
        assertNull(check("look.set", "appearance.accent="));
        assertNull(ActionGuard.check("look.set", "appearance.preset={$p.value}", "appearance.preset=ocean", null));
        assertEquals(ActionGuard.OUTSIDE, ActionGuard.check("look.set", "look.variant={$v.value}", "look.variant=the secret", null));
    }

    @Test
    public void theSyncedNotificationSettingsCarryNoMessage() {
        // G-20's example: notify.quietFrom goes to the server within 1.5 s.
        assertEquals(ActionGuard.PRIVACY, check("setting.set", "notify.quietFrom={$msg.text}"));
        assertEquals(ActionGuard.PRIVACY, check("setting.set", "notify.quietFrom=22:00"));
        assertEquals(ActionGuard.PRIVACY, check("setting.set", "notify.order=android,email"));
    }

    @Test
    public void privacySettingsAreNeverTheDesigns() {
        // G-21: the call log with names, the conversations' names, notifications, speech on the server, tracking.
        for (String raw : new String[]{ "callLog=true", "calls.logName=people", "conversations.names=true", "notify.privacy=content",
            "voice.engine=server", "location.track=true", "nfc.emulate=true", "messages.readReceipts=true", "people.contacts=true" }) {
            assertEquals(raw, ActionGuard.PRIVACY, check("setting.set", raw));
        }
        assertEquals(ActionGuard.PRIVACY, check("setting.toggle", "callLog"));
        assertEquals(ActionGuard.PRIVACY, check("setting.toggle", "conversations.names"));
        assertEquals(ActionGuard.PRIVACY, check("setting.toggle", "location.track"));
        assertNull(check("setting.toggle", "messages.enterSends"));
        assertEquals(ActionGuard.COMPUTED_KEY, check("setting.toggle", "{$msg.text}"));
        assertEquals("not a yes/no setting", ActionGuard.UNKNOWN, check("setting.toggle", "voice.rate"));
    }

    @Test
    public void otherActionsAreUntouched() {
        assertNull(check("msg.info", "{$msg.id}"));
        assertNull(check("screen.open", "settings"));
        assertNull(check("flash", "{_'look.preview.pressed'}"));
        assertNull(check("copy", "{$msg.text}")); // stays on the phone (the user's own copy)
        assertNull(ActionGuard.check(null, null, null, null));
    }

    @Test
    public void aLiteralKeyIsTheTextBeforeTheFirstEqualsAndBeforeAnyPlaceholder() {
        assertEquals("voice.rate", ActionGuard.literalKey("voice.rate={$value}"));
        assertEquals("voice.rate", ActionGuard.literalKey(" voice.rate = 1"));
        assertNull(ActionGuard.literalKey("{$k}=1"));
        assertNull(ActionGuard.literalKey("=$k"));
        assertNull(ActionGuard.literalKey("noequals"));
        assertNull(ActionGuard.literalKey("=1"));
        assertNull(ActionGuard.literalKey(null));
    }

    /** Every action of the built-in design with an argument (trees, menus, libraries). */
    private static void collect(Object node, List<String[]> out) {
        if (node instanceof JSONObject) {
            JSONObject o = (JSONObject) node;
            String action = o.optString("action", o.optString("do", ""));
            if (!action.isEmpty() && o.has("arg") && o.opt("arg") instanceof String) out.add(new String[]{ action, o.optString("arg") });
            for (Iterator<String> it = o.keys(); it.hasNext(); ) collect(o.opt(it.next()), out);
        } else if (node instanceof JSONArray) {
            for (int i = 0; i < ((JSONArray) node).length(); i++) collect(((JSONArray) node).opt(i), out);
        }
    }

    @Test
    public void theBuiltInDesignStillWorks() throws Exception {
        File f = new File("src/main/assets/m5/default-design.json");
        if (!f.exists()) f = new File("app/src/main/assets/m5/default-design.json");
        JSONObject design = new JSONObject(new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8));
        List<String[]> all = new ArrayList<>();
        collect(design, all);
        assertTrue(all.size() > 50);
        int literal = 0;
        for (String[] a : all) {
            String action = a[0], raw = a[1];
            if (ActionGuard.LITERAL.contains(action)) {
                literal++;
                if (action.equals("profile.public")) assertEquals("{$form.person.username}", raw); // the open person (People.shownUsername)
                else assertFalse(action + " " + raw, Expr.readsData(raw));
            }
            if (ActionGuard.KEY_VALUE.contains(action) || action.equals("setting.toggle")) {
                String key = action.equals("setting.toggle") ? raw.trim() : ActionGuard.literalKey(raw);
                assertTrue(action + " " + raw, key != null && !SettingSchema.privacy(key));
            }
        }
        assertTrue(literal > 0);
    }
}
