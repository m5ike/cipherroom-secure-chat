package cz.m5cet.app.design;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Iterator;

import cz.m5cet.app.core.Locales;

/**
 * 6.13: how the app finds a text — along the language's chain (Slovak →
 * Czech → English), in the bundle's table and then the built-in design's, a
 * count's plural form before the plain key — and that the built-in design
 * (assets/m5/default-design.json, from the server's DEFAULT_DESIGN with the
 * translators' tables) has every text in all nine languages.
 */
public class DesignTextsTest {
    private static Design design(JSONObject strings) throws Exception {
        return Design.fromJson(new JSONObject().put("rev", "t").put("strings", strings));
    }

    @Test
    public void aMissingTextComesFromTheChain() throws Exception {
        Design d = design(new JSONObject()
            .put("cs", new JSONObject().put("a", "cs-a"))
            .put("en", new JSONObject().put("a", "en-a").put("b", "en-b"))
            .put("sk", new JSONObject()));
        assertEquals("cs-a", d.t("a", "sk"));
        assertEquals("en-b", d.t("b", "sk"));
        assertEquals("en-a", d.t("a", "fi")); // a language without a table
        assertEquals("c", d.t("c", "sk"));     // nobody has it: the key
        assertNull(d.text("c", "sk"));
        assertEquals("en-a", d.t("a", "xx"));  // not a language: English
    }

    @Test
    public void anEmptyTextIsATextNotAGap() throws Exception {
        Design d = design(new JSONObject().put("cs", new JSONObject().put("a", "")).put("en", new JSONObject().put("a", "A")));
        assertEquals("", d.t("a", "cs"));
    }

    @Test
    public void anOlderBundleIsBackedByTheBuiltInDesignPerLanguage() throws Exception {
        Design builtIn = design(new JSONObject()
            .put("cs", new JSONObject().put("a", "built-cs-a").put("x", "built-cs-x"))
            .put("es", new JSONObject().put("a", "built-es-a"))
            .put("en", new JSONObject().put("a", "built-en-a").put("y", "built-en-y")));
        Design bundle = design(new JSONObject()
            .put("cs", new JSONObject().put("y", "bundle-cs-y"))
            .put("en", new JSONObject().put("a", "bundle-en-a"))
            .put("de", new JSONObject())).withFallback(builtIn);
        assertEquals("bundle-en-a", bundle.t("a", "en"));   // the operator's text first
        assertEquals("built-cs-a", bundle.t("a", "cs"));    // Czech from the app beats the bundle's English
        assertEquals("built-es-a", bundle.t("a", "es"));    // a language the bundle does not have
        assertEquals("built-cs-x", bundle.t("x", "sk"));    // a newer key, along Slovak's chain
        assertEquals("bundle-cs-y", bundle.t("y", "sk"));
        assertEquals("built-en-y", bundle.t("y", "de"));
        assertEquals("z", bundle.t("z", "de"));
        assertEquals(builtIn, builtIn.withFallback(builtIn)); // never its own fallback
        assertEquals("built-en-y", builtIn.t("y", "fi"));
    }

    @Test
    public void aCountPicksItsPluralFormThenThePlainKey() throws Exception {
        Design d = design(new JSONObject()
            .put("cs", new JSONObject().put("k#one", "{n} zpráva").put("k#few", "{n} zprávy").put("k#other", "{n} zpráv").put("k", "zprávy: {n}"))
            .put("sl", new JSONObject().put("k#two", "{n} sporočili").put("k#other", "{n} sporočil"))
            .put("en", new JSONObject().put("k", "messages: {n}").put("p#one", "{n} item")));
        assertEquals("1 zpráva", d.tn("k", 1, "cs"));
        assertEquals("3 zprávy", d.tn("k", 3, "cs"));
        assertEquals("5 zpráv", d.tn("k", 5, "cs"));
        assertEquals("3 zprávy", d.tn("k", 3, "sk"));       // Slovak's few → Czech's few
        assertEquals("102 sporočili", d.tn("k", 102, "sl"));
        assertEquals("3 sporočil", d.tn("k", 3, "sl"));      // no "few": "other"
        assertEquals("messages: 2", d.tn("k", 2, "de"));     // English, plain key
        assertEquals("1 item", d.tn("p", 1, "fi"));
        assertEquals("p", d.tn("p", 2, "fi"));               // no form, no plain key: the key
        String big = d.tn("k", 1234, "cs");
        assertTrue(big, big.endsWith("zpráv") && big.replaceAll("[\\u00a0\\u202f ]", "").startsWith("1234"));
    }

    private static Path builtInFile() {
        Path p = Paths.get("").toAbsolutePath();
        for (int i = 0; i < 4 && p != null; i++, p = p.getParent()) {
            Path f = p.resolve("src/main/assets/m5/default-design.json");
            if (Files.isRegularFile(f)) return f;
            f = p.resolve("app/src/main/assets/m5/default-design.json");
            if (Files.isRegularFile(f)) return f;
        }
        throw new IllegalStateException("default-design.json not found");
    }

    @Test
    public void theBuiltInDesignHasEveryTextInAllNineLanguages() throws Exception {
        JSONObject json = new JSONObject(new String(Files.readAllBytes(builtInFile()), StandardCharsets.UTF_8));
        JSONObject strings = json.getJSONObject("strings");
        JSONObject en = strings.getJSONObject("en");
        assertTrue(en.length() > 1400);
        for (String lang : Locales.CODES) {
            JSONObject table = strings.optJSONObject(lang);
            assertTrue(lang + " has a table", table != null);
            int missing = 0;
            StringBuilder some = new StringBuilder();
            for (Iterator<String> it = en.keys(); it.hasNext(); ) {
                String key = it.next();
                if (!table.has(key)) { if (missing++ < 5) some.append(' ').append(key); }
            }
            assertEquals(lang + " lacks" + some, 0, missing);
        }
        Design d = Design.fromJson(json);
        assertEquals("Puhelimen mukaan", d.t("settings.languageSystem", "fi"));
        assertEquals("Slovenčina", Locales.info("sk").nativeName);
        assertTrue(d.t("settings.language", "sk"), !d.t("settings.language", "sk").isEmpty() && !d.t("settings.language", "sk").equals("settings.language"));
        // the 6.13 plural forms
        assertEquals("Nouzový PIN musí mít 4 číslice.", d.tn("set.security.duress.length", 4, "cs"));
        assertEquals("Nouzový PIN musí mít 6 číslic.", d.tn("set.security.duress.length", 6, "cs"));
        assertEquals("3 zadržané správy sa nezobrazili (identita sa zmenila a nebola overená)", d.tn("p4.heldDropped", 3, "sk"));
        assertEquals("2 sliki", d.tn("nfc.eid.sum.images", 2, "sl"));
        assertEquals("1 Bild", d.tn("nfc.eid.sum.images", 1, "de"));
    }
}
