package cz.m5cet.app.ui;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

import cz.m5cet.app.core.SettingSchema;
import cz.m5cet.app.core.Settings;

/**
 * 6.10 (security analysis G-20, G-21 — the class of F-01): what an action
 * of the server's design may do with an argument it computed. The design is
 * signed by the server, but the end-to-end promise holds against the server
 * too, and an argument built from $msg, $log, $form, $composer… holds
 * decrypted data. Some actions carry their argument where others read it:
 *
 *   lib.run, url.open,     the argument is the design's own literal (a
 *   fn.run, profile.public  library's name, a fixed address, a command);
 *                          profile.public also takes exactly the username of
 *                          the person the app itself shows (their detail)
 *   setting.set, look.set  "key=value": the key is literal (the value may be
 *                          computed — "voice.rate={$value}" — and must fit
 *                          the key's rule, core/SettingSchema)
 *   setting.toggle         the key is literal
 *   setting.* on a         never from the design (G-21) — only the user's own
 *   privacy key            tap on that setting's switch or choice
 *
 * The raw argument is what the design wrote ("=expression", a template, a
 * literal; Renderer, the menus, the swipe rows and the libraries pass it).
 * A refusal says why in a fixed word, never with the value.
 */
public final class ActionGuard {
    private ActionGuard() {}

    /** The argument must be the design's literal. */
    static final Set<String> LITERAL = new HashSet<>(Arrays.asList("lib.run", "url.open", "fn.run", "profile.public"));
    /** "key=value" with a literal key. */
    static final Set<String> KEY_VALUE = new HashSet<>(Arrays.asList("setting.set", "look.set"));

    /** Why an action was refused (fixed words: they go to the log). */
    public static final String COMPUTED = "a computed argument", COMPUTED_KEY = "a computed setting key",
        PRIVACY = "a privacy setting", UNKNOWN = "an unknown setting", OUTSIDE = "a value outside the setting's rule";

    /**
     * Whether the argument was computed: the raw text reads data, or there is
     * a value without a raw text the design wrote (it came from elsewhere).
     */
    public static boolean computed(String raw, Object value) {
        if (raw == null) return value != null;
        return Expr.readsData(raw);
    }

    /** The literal key of a raw "key=value" ("voice.rate={$value}" → voice.rate), or null when the key is computed. */
    static String literalKey(String raw) {
        if (raw == null || raw.startsWith("=")) return null;
        int eq = raw.indexOf('='), brace = raw.indexOf('{');
        if (eq <= 0 || (brace >= 0 && brace < eq)) return null;
        String key = raw.substring(0, eq).trim();
        return key.isEmpty() ? null : key;
    }

    /**
     * null: the action may run; otherwise why not.
     *   action  the action's name (the design's literal)
     *   raw     its argument as the design wrote it (null: none, or not from the design)
     *   value   the argument now (raw evaluated in the element's scope)
     *   own     what the app itself shows for this action — profile.public: the
     *           username of the person whose detail is open — or null
     */
    public static String check(String action, String raw, Object value, String own) {
        if (action == null) return null;
        String text = value == null ? "" : Expr.toText(value);
        if (LITERAL.contains(action)) {
            if (!computed(raw, value)) return null;
            return "profile.public".equals(action) && own != null && !own.isEmpty() && own.equals(text) ? null : COMPUTED;
        }
        if (KEY_VALUE.contains(action)) {
            int eq = text.indexOf('=');
            if (eq <= 0) return null; // nothing to set (the action ignores it)
            String key = text.substring(0, eq).trim();
            if (computed(raw, value) && !key.equals(literalKey(raw))) return COMPUTED_KEY;
            return setting(key, text.substring(eq + 1).trim());
        }
        if ("setting.toggle".equals(action)) {
            if (computed(raw, value)) return COMPUTED_KEY;
            String key = text.trim();
            if (!(Settings.DEFAULTS.get(key) instanceof Boolean)) return UNKNOWN;
            return SettingSchema.privacy(key) ? PRIVACY : null;
        }
        return null;
    }

    /** A design's write of one setting: a known key, not a privacy one, a value within its rule. */
    static String setting(String key, Object value) {
        Object dflt = Settings.DEFAULTS.get(key);
        if (dflt == null) return UNKNOWN;
        if (SettingSchema.privacy(key)) return PRIVACY;
        Object v = Settings.coerce(dflt, value);
        return v != null && SettingSchema.valid(key, v) ? null : OUTSIDE;
    }
}
