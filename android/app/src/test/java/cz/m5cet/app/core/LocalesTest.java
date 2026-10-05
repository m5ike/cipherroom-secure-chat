package cz.m5cet.app.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;

/**
 * 6.13: the nine languages. Locales.java must say what the contract
 * (client/src/lib/locales.ts) says, Plurals.java's CLDR table what
 * Intl.PluralRules says — locales-vectors.json, written from the TypeScript
 * side by script/android-assets.ts (test/i18n-android-locales.test.ts keeps it
 * current).
 */
public class LocalesTest {
    private static JSONObject vectors() throws Exception {
        try (InputStream in = LocalesTest.class.getClassLoader().getResourceAsStream("cz/m5cet/app/core/locales-vectors.json")) {
            if (in == null) throw new IllegalStateException("locales-vectors.json is missing (npx tsx script/android-assets.ts)");
            return new JSONObject(new String(Streams.readAll(in), StandardCharsets.UTF_8));
        }
    }

    private static List<String> list(JSONArray a) throws Exception {
        List<String> out = new ArrayList<>();
        for (int i = 0; i < a.length(); i++) out.add(a.getString(i));
        return out;
    }

    @Test
    public void theLanguagesAreTheContractsInItsOrder() throws Exception {
        JSONArray locales = vectors().getJSONArray("locales");
        assertEquals(9, locales.length());
        List<String> codes = new ArrayList<>();
        for (int i = 0; i < locales.length(); i++) {
            JSONObject v = locales.getJSONObject(i);
            String code = v.getString("code");
            codes.add(code);
            assertTrue(code, Locales.isLocale(code));
            Locales.Info info = Locales.info(code);
            assertEquals(code + " native", v.getString("native"), info.nativeName);
            assertEquals(code + " english", v.getString("english"), info.english);
            assertEquals(code + " tag", v.getString("tag"), info.tag);
            assertEquals(code + " tag()", v.getString("tag"), Locales.tag(code));
            assertEquals(code + " fallback", list(v.getJSONArray("fallback")), info.fallback);
            assertEquals(code + " chain", list(v.getJSONArray("chain")), Locales.chain(code));
        }
        assertEquals(codes, Locales.CODES);
    }

    @Test
    public void pickAnswersAsTheContractsPickLocale() throws Exception {
        JSONArray cases = vectors().getJSONArray("pick");
        assertTrue(cases.length() >= 20);
        for (int i = 0; i < cases.length(); i++) {
            JSONObject c = cases.getJSONObject(i);
            Object in = c.get("in");
            String got = in instanceof JSONArray ? Locales.pick(list((JSONArray) in), "en") : Locales.pick((String) in, "en");
            assertEquals("pick " + in, c.getString("out"), got);
        }
    }

    @Test
    public void slovakIsItsOwnLanguageAndFallsBackToCzechThenEnglish() {
        assertEquals("sk", Locales.pick(Arrays.asList("sk-SK", "cs-CZ"), "en"));
        assertEquals(Arrays.asList("sk", "cs", "en"), Locales.chain("sk"));
        assertEquals("Slovenčina", Locales.info("sk").nativeName);
        assertEquals("sk-SK", Locales.locale("sk").toLanguageTag());
        // anything else is English
        assertFalse(Locales.isLocale("pl"));
        assertFalse(Locales.isLocale(null));
        assertEquals("en", Locales.info("pl").code);
        assertEquals(Arrays.asList("en"), Locales.chain("xx"));
        assertEquals("cs", Locales.pick("pl-PL,cs;q=0.5", "en"));
        assertEquals("de", Locales.pick((String) null, "de"));
    }

    @Test
    public void aTextByLanguageFollowsTheChain() throws Exception {
        JSONObject label = new JSONObject().put("cs", "Les").put("en", "Forest").put("es", "");
        assertEquals("Les", Locales.text(label, "sk", "?"));
        assertEquals("Forest", Locales.text(label, "es", "?")); // empty counts as missing
        assertEquals("Forest", Locales.text(label, "fi", "?"));
        assertEquals("?", Locales.text(new JSONObject(), "fi", "?"));
        assertEquals("?", Locales.text(null, "cs", "?"));
    }

    @Test
    public void thePluralTableIsIntlsForEveryLanguage() throws Exception {
        JSONObject plurals = vectors().getJSONObject("plurals");
        assertEquals(9, plurals.length());
        int checked = 0;
        for (Iterator<String> tags = plurals.keys(); tags.hasNext(); ) {
            String tag = tags.next();
            JSONObject byCount = plurals.getJSONObject(tag);
            for (Iterator<String> it = byCount.keys(); it.hasNext(); ) {
                String n = it.next();
                assertEquals(tag + " " + n, byCount.getString(n), Plurals.builtIn(tag, Long.parseLong(n)));
                // On the JVM android.icu is a stub: category() falls back to the same table.
                assertEquals(tag + " " + n + " (category)", byCount.getString(n), Plurals.category(tag, Long.parseLong(n)));
                checked++;
            }
        }
        assertTrue(checked >= 9 * 140);
    }

    @Test
    public void pluralsOfTheSlavicLanguages() {
        assertEquals("one", Plurals.category("cs-CZ", 1));
        assertEquals("few", Plurals.category("cs-CZ", 4));
        assertEquals("other", Plurals.category("cs-CZ", 5));
        assertEquals("few", Plurals.category("sk", 2));
        assertEquals("one", Plurals.category("sl-SI", 101));
        assertEquals("two", Plurals.category("sl-SI", 2));
        assertEquals("few", Plurals.category("sl-SI", 204));
        assertEquals("one", Plurals.category("fr-FR", 0));
        assertEquals("many", Plurals.category("es-ES", 1_000_000));
        assertEquals("other", Plurals.category("fi-FI", 0));
    }

    @Test
    public void numbersAndDatesAreWrittenAsTheLanguageWritesThem() {
        assertEquals("7", Formats.count("cs", 7));
        assertEquals("1,234", Formats.count("en", 1234));
        assertEquals("1.234", Formats.count("de", 1234));
        // cs, sk, fi, fr group thousands with a (no-break / narrow no-break) space
        for (String l : new String[]{"cs", "sk", "fi", "fr"}) {
            String s = Formats.count(l, 1234567);
            assertTrue(l + ": " + s, !s.equals("1234567") && s.replaceAll("[\\u00a0\\u202f ]", "").equals("1234567"));
        }
        assertEquals("1,5", Formats.decimal("cs", 1.5, 1));
        assertEquals("1.5", Formats.decimal("en", 1.5, 1));
        java.util.TimeZone utc = java.util.TimeZone.getTimeZone("UTC");
        long at = 1_791_217_500_000L; // 2026-10-05 16:25 UTC
        assertTrue(Formats.date("de", at, utc), Formats.date("de", at, utc).contains("05.10.2026"));
        assertTrue(Formats.date("cs", at, utc), Formats.date("cs", at, utc).replace(' ', ' ').contains("5. 10. 2026"));
        assertTrue(Formats.date("fi", at, utc), Formats.date("fi", at, utc).contains("5.10.2026"));
        assertTrue(Formats.date("en", at, utc), Formats.date("en", at, utc).contains("Oct 2026"));
        assertTrue(Formats.date("es", at, utc), Formats.date("es", at, utc).toLowerCase(Locale.ROOT).contains("oct"));
        // a 24-hour clock in the European languages, 16:25
        for (String l : new String[]{"cs", "de", "es", "it", "fr", "sk", "sl", "fi", "en"}) {
            String time = Formats.time(l, at, utc);
            assertTrue(l + ": " + time, time.replace('.', ':').contains("16:25"));
        }
    }
}
