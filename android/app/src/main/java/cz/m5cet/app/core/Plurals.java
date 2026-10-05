package cz.m5cet.app.core;

import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 6.13: which plural form a count takes in a language — the CLDR categories
 * zero, one, two, few, many, other — so a text shown with a number can have
 * a form for each ("key#one", "key#few", "key#many", "key#other", falling
 * back to the plain "key", as the web client does).
 *
 * On the phone the platform's ICU decides (android.icu.text.PluralRules).
 * Where it is missing (the JVM unit tests run against android.jar's stubs)
 * the CLDR rules of the nine languages below do; PluralsTest checks them
 * against Intl.PluralRules' answers (core/plural-vectors.json).
 */
public final class Plurals {
    private Plurals() {}

    public static final String[] CATEGORIES = {"zero", "one", "two", "few", "many", "other"};

    private static final ConcurrentHashMap<String, Object> RULES = new ConcurrentHashMap<>();
    private static final Object NONE = new Object();

    /** The category of the whole number {@code n} in the language of {@code tag} ("cs-CZ", "sk", …). */
    public static String category(String tag, long n) {
        String key = tag == null ? "" : tag;
        Object rules = RULES.get(key);
        if (rules == null) {
            try {
                rules = android.icu.text.PluralRules.forLocale(android.icu.util.ULocale.forLanguageTag(key));
            } catch (Throwable notThere) {
                rules = null;
            }
            if (rules == null) rules = NONE;
            RULES.put(key, rules);
        }
        if (rules != NONE) {
            try {
                String c = ((android.icu.text.PluralRules) rules).select(n);
                if (c != null && !c.isEmpty()) return c;
            } catch (Throwable notThere) { /* the CLDR table below */ }
        }
        return builtIn(key, n);
    }

    /** The CLDR rules (v46) of the app's languages for whole numbers (v = 0, e = 0). */
    static String builtIn(String tag, long n) {
        String lang = tag.toLowerCase(Locale.ROOT).split("[-_]", 2)[0];
        long i = Math.abs(n);
        switch (lang) {
            case "cs": case "sk":
                return i == 1 ? "one" : i >= 2 && i <= 4 ? "few" : "other";
            case "sl": {
                long h = i % 100;
                return h == 1 ? "one" : h == 2 ? "two" : h == 3 || h == 4 ? "few" : "other";
            }
            case "fr":
                return i == 0 || i == 1 ? "one" : i % 1_000_000 == 0 ? "many" : "other";
            case "es": case "it":
                return i == 1 ? "one" : i != 0 && i % 1_000_000 == 0 ? "many" : "other";
            default: // en, de, fi and the rest
                return i == 1 ? "one" : "other";
        }
    }
}
