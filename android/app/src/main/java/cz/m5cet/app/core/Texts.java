package cz.m5cet.app.core;

import cz.m5cet.app.M5;

/**
 * 6.13: a text from code that has no activity or app at hand (an error a
 * reader or a sender throws, a reader's hint): the design's text of the key
 * in the app's language (M5.t — the chain and the built-in design behind a
 * bundle), else the English given here. Every user-visible text of the Java
 * side goes through a design key — server/android/design-613.ts carries the
 * nine languages — so this English is only what a unit test (no app) sees.
 */
public final class Texts {
    private Texts() {}

    public static String t(String key, String en) {
        M5 app = M5.get();
        String s = null;
        try { s = app == null ? null : app.t(key); } catch (RuntimeException notReady) { /* the app is starting: English */ }
        return s == null || s.equals(key) ? en : s;
    }

    /** With "{0}", "{1}" … filled from {@code args}. */
    public static String f(String key, String en, Object... args) {
        String s = t(key, en);
        for (int i = 0; i < args.length; i++) s = s.replace("{" + i + "}", String.valueOf(args[i]));
        return s;
    }

    /** A text with a count: its plural form in the app's language, "{n}" filled in. */
    public static String n(String key, long n, String en) {
        M5 app = M5.get();
        String s = null;
        try { s = app == null ? null : app.tn(key, n); } catch (RuntimeException notReady) { /* English */ }
        return s == null || s.equals(key) ? en.replace("{n}", Long.toString(n)) : s;
    }
}
