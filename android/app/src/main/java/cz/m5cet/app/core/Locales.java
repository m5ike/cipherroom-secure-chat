package cz.m5cet.app.core;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 6.13: the languages M5cet speaks — the Java copy of the contract
 * client/src/lib/locales.ts (the web client, the server's notifications and
 * share pages, the Android design). Same codes, native names, BCP 47 tags and
 * fallbacks; LocalesTest checks it against vectors the TypeScript side writes
 * (script/android-assets.ts → test resources core/locales-vectors.json).
 *
 * English is the source language and the last fallback. Slovak is its own
 * language: a text it lacks comes from Czech, then English (before 6.13 the
 * app showed Czech to a Slovak phone).
 */
public final class Locales {
    private Locales() {}

    /** One language. */
    public static final class Info {
        public final String code;
        /** The language's own name, as the language picker shows it. */
        public final String nativeName;
        /** English name (logs). */
        public final String english;
        /** BCP 47 tag for dates, numbers, collation and plural rules. */
        public final String tag;
        /** Where a missing text comes from, in order, before English. */
        public final List<String> fallback;

        Info(String code, String nativeName, String english, String tag, String... fallback) {
            this.code = code;
            this.nativeName = nativeName;
            this.english = english;
            this.tag = tag;
            this.fallback = Collections.unmodifiableList(Arrays.asList(fallback));
        }

        public Locale locale() { return Locale.forLanguageTag(tag); }
    }

    /** In the contract's order (LOCALES). */
    public static final List<String> CODES = Collections.unmodifiableList(Arrays.asList("en", "cs", "de", "es", "it", "fr", "sk", "sl", "fi"));

    private static final Map<String, Info> INFO = new LinkedHashMap<>();
    static {
        add(new Info("en", "English", "English", "en-GB"));
        add(new Info("cs", "Čeština", "Czech", "cs-CZ"));
        add(new Info("de", "Deutsch", "German", "de-DE"));
        add(new Info("es", "Español", "Spanish", "es-ES"));
        add(new Info("it", "Italiano", "Italian", "it-IT"));
        add(new Info("fr", "Français", "French", "fr-FR"));
        add(new Info("sk", "Slovenčina", "Slovak", "sk-SK", "cs"));
        add(new Info("sl", "Slovenščina", "Slovenian", "sl-SI"));
        add(new Info("fi", "Suomi", "Finnish", "fi-FI"));
    }

    private static void add(Info i) { INFO.put(i.code, i); }

    public static boolean isLocale(String v) { return v != null && INFO.containsKey(v); }

    /** The language's facts, or English's for anything else. */
    public static Info info(String code) { Info i = code == null ? null : INFO.get(code); return i != null ? i : INFO.get("en"); }

    public static String tag(String code) { return info(code).tag; }

    public static Locale locale(String code) { return info(code).locale(); }

    /** The best supported language for a list of BCP 47 tags (Android's LocaleList, Accept-Language), else {@code fallback}. */
    public static String pick(Iterable<String> preferred, String fallback) {
        if (preferred != null) {
            for (String raw : preferred) {
                if (raw == null) continue;
                String code = raw.trim();
                int semi = code.indexOf(';');
                if (semi >= 0) code = code.substring(0, semi);
                code = code.toLowerCase(Locale.ROOT).split("[-_]", 2)[0];
                if (isLocale(code)) return code;
            }
        }
        return fallback;
    }

    /** The same for a comma-separated list ("sk-SK,cs;q=0.8,en"). */
    public static String pick(String preferred, String fallback) {
        return preferred == null ? fallback : pick(Arrays.asList(preferred.split(",", -1)), fallback);
    }

    private static final Map<String, List<String>> CHAINS = new LinkedHashMap<>();
    static {
        for (Info i : INFO.values()) {
            List<String> out = new ArrayList<>();
            out.add(i.code);
            out.addAll(i.fallback);
            if (!out.contains("en")) out.add("en");
            CHAINS.put(i.code, Collections.unmodifiableList(out));
        }
    }

    /**
     * A text from a { "cs": …, "en": … } object (a template's title, a theme's
     * label) along the language's chain — an older server's has three languages.
     * Empty texts count as missing.
     */
    public static String text(org.json.JSONObject byLang, String code, String dflt) {
        if (byLang != null) {
            for (String l : chain(code)) {
                String v = byLang.optString(l, "");
                if (!v.isEmpty()) return v;
            }
        }
        return dflt;
    }

    /** The chain a text is looked up in: the language, its fallbacks, then English (English's for anything unknown). */
    public static List<String> chain(String code) { return CHAINS.get(info(code).code); }
}
