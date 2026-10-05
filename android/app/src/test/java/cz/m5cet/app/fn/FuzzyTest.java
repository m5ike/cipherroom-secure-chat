package cz.m5cet.app.fn;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.util.Arrays;
import java.util.List;

/** 6.11: the suggester's matching, how good each kind of match is, where it matched — and the frequent / recent ranking. */
public class FuzzyTest {
    private static int[][] hits(Fuzzy.Match m) { return m.hits.toArray(new int[0][]); }

    @Test public void bestFirst() throws Exception {
        assertEquals(Fuzzy.EXACT, Fuzzy.match("dns", "dns", true).score);
        assertEquals(Fuzzy.PREFIX, Fuzzy.match("dn", "dns", true).score);
        assertTrue(Fuzzy.match("look", "phone-lookup", true).score < Fuzzy.PREFIX);
        assertTrue(Fuzzy.match("look", "phone-lookup", true).score > Fuzzy.INSIDE);
        assertTrue(Fuzzy.match("ook", "phone-lookup", true).score <= Fuzzy.INSIDE);
        assertTrue(Fuzzy.match("pl", "phone-lookup", true).score <= Fuzzy.SPREAD);
        assertTrue(Fuzzy.match("pl", "phone-lookup", true).score > 0);
    }

    @Test public void whereItMatched() throws Exception {
        assertArrayEquals(new int[][]{{0, 2}}, hits(Fuzzy.match("DN", "dns", true)));
        assertArrayEquals(new int[][]{{6, 10}}, hits(Fuzzy.match("look", "phone-lookup", true)));
        assertArrayEquals(new int[][]{{0, 1}, {6, 7}}, hits(Fuzzy.match("pl", "phone-lookup", true)));
        assertArrayEquals(new int[][]{{0, 2}, {6, 7}}, hits(Fuzzy.match("phl", "phone-lookup", true)));
        assertEquals(0, Fuzzy.match("", "anything", false).hits.size());
    }

    @Test public void noCaseNoDiacritics() throws Exception {
        assertEquals(Fuzzy.PREFIX, Fuzzy.match("pocasi", "Počasí v Brně", false).score);
        assertArrayEquals(new int[][]{{9, 13}}, hits(Fuzzy.match("brne", "Počasí v Brně", false)));
        assertEquals(Fuzzy.EXACT, Fuzzy.match("ŽLUŤ", "zlut", false).score);
    }

    @Test public void lettersApartOnlyForKeywordsAndFromAWordStart() throws Exception {
        assertNull(Fuzzy.match("pl", "phone-lookup", false));
        assertNull(Fuzzy.match("hl", "phone-lookup", true));   // "h" starts no word
        assertNull(Fuzzy.match("zz", "dns", true));
        assertNull(Fuzzy.match("x", "", true));
    }

    @Test public void theUsedOnesLeadTheMostAndTheLatestFirst() throws Exception {
        long now = 100L * Usage.DAY;
        Usage u = new Usage();
        assertEquals(0, u.score("dns", now), 0);
        u.used("dns", now - 40 * Usage.DAY);
        u.used("hlr", now - 10_000);
        assertTrue(u.score("hlr", now) > u.score("dns", now));
        for (int i = 0; i < 30; i++) u.used("dns", now - 2 * Usage.DAY);
        assertTrue(u.score("dns", now) > u.score("hlr", now));
        assertEquals(31, u.count("dns"));
        // Through its JSON (the vault keeps it).
        Usage back = Usage.from(new JSONObject(u.toJson().toString()));
        assertEquals(u.score("dns", now), back.score("dns", now), 0);
        assertEquals(1, back.count("hlr"));
        // At most KEEP keywords — the latest stay.
        Usage many = new Usage();
        for (int i = 0; i < Usage.KEEP + 10; i++) many.used("k" + i, i + 1);
        assertEquals(Usage.KEEP, many.toJson().length());
        assertEquals(0, many.count("k0"));
        assertEquals(1, many.count("k" + (Usage.KEEP + 9)));
        assertEquals(0, Usage.from(new JSONObject().put("x", "junk")).toJson().length());
    }

    @Test public void theListOrderedByUseThenMatch() throws Exception {
        long now = 10L * Usage.DAY;
        Usage u = new Usage();
        u.used("dice", now - 1000);
        Command dns = new Command("dns", "DNS lookup", "Looks up a domain name", "server", "room", true, null, null, null);
        Command dice = new Command("dice", "Dice", "Throws a die", "server", "caller", true, null, null, null);
        Command help = new Command("help", "Help", "Every command and how to use it", "server", "caller", true, null, null, null);
        Commands.State s = new Commands.State(true, Arrays.asList(dns, dice, help));
        Suggestions.Result r = Suggestions.suggest("/d", 2, Commands.DEFAULT_COMPOSER, s, Arrays.asList(), Arrays.asList(), u, now);
        List<Suggestions.Item> items = r.items;
        assertEquals("/dice", items.get(0).label);
        assertEquals("recent", items.get(0).section);
        assertEquals("/dns", items.get(1).label);
        assertEquals("commands", items.get(1).section);
        assertEquals(2, items.size());
        // Found by its summary only: another section, after the keyword and name matches.
        Suggestions.Result byText = Suggestions.suggest("/domain", 7, Commands.DEFAULT_COMPOSER, s, Arrays.asList(), Arrays.asList(), u, now);
        assertEquals("/dns", byText.items.get(0).label);
        assertEquals("others", byText.items.get(0).section);
        assertArrayEquals(new int[][]{{11, 17}}, byText.items.get(0).summaryHits.toArray(new int[0][]));
        // The name's words count too ("look" → "DNS lookup").
        Suggestions.Item look = Suggestions.suggest("/look", 5, Commands.DEFAULT_COMPOSER, s, Arrays.asList(), Arrays.asList(), u, now).items.get(0);
        assertEquals("/dns", look.label);
        assertArrayEquals(new int[][]{{4, 8}}, look.nameHits.toArray(new int[0][]));
        // With nothing typed: the used one first, then the server's order.
        Suggestions.Result all = Suggestions.suggest("/", 1, Commands.DEFAULT_COMPOSER, s, Arrays.asList(), Arrays.asList(), u, now);
        assertEquals(Arrays.asList("/dice", "/dns", "/help"), Arrays.asList(all.items.get(0).label, all.items.get(1).label, all.items.get(2).label));
    }
}
