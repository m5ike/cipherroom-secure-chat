package cz.m5cet.app.core;

import static org.junit.Assert.assertArrayEquals;
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
import java.util.List;

/**
 * 6.12 (security analysis F-22): display names — normalized, their
 * skeletons, mixed scripts, who is flagged. The cases are
 * names-vectors.json; the web (client/src/lib/names.ts) must answer them the
 * same way.
 */
public class NamesTest {
    private static JSONObject vectors() throws Exception {
        try (InputStream in = NamesTest.class.getClassLoader().getResourceAsStream("cz/m5cet/app/names-vectors.json")) {
            if (in == null) throw new IllegalStateException("names-vectors.json is missing");
            return new JSONObject(new String(Streams.readAll(in), StandardCharsets.UTF_8));
        }
    }

    @Test
    public void theVectorsNormalizeAndSkeletonAsWritten() throws Exception {
        JSONArray names = vectors().getJSONArray("names");
        assertTrue(names.length() >= 30);
        for (int i = 0; i < names.length(); i++) {
            JSONObject v = names.getJSONObject(i);
            String in = v.getString("input"), note = v.getString("note");
            assertEquals(note + ": normalized", v.getString("normalized"), Names.normalize(in));
            assertEquals(note + ": skeleton", v.getString("skeleton"), Names.skeleton(in));
            assertEquals(note + ": mixed script", v.getBoolean("mixedScript"), Names.mixedScript(in));
            // Normalizing is idempotent, and a skeleton is the same from the normalized name.
            assertEquals(note, Names.normalize(in), Names.normalize(Names.normalize(in)));
            assertEquals(note, Names.skeleton(in), Names.skeleton(Names.normalize(in)));
        }
    }

    @Test
    public void theVectorsPairsAndFlags() throws Exception {
        JSONObject doc = vectors();
        JSONArray pairs = doc.getJSONArray("pairs");
        for (int i = 0; i < pairs.length(); i++) {
            JSONObject p = pairs.getJSONObject(i);
            assertEquals(p.toString(), p.getBoolean("confusable"), Names.confusable(p.getString("a"), p.getString("b")));
            assertEquals(p.toString(), p.getBoolean("confusable"), Names.confusable(p.getString("b"), p.getString("a")));
        }
        JSONArray flags = doc.getJSONArray("flags");
        for (int i = 0; i < flags.length(); i++) {
            JSONObject f = flags.getJSONObject(i);
            JSONArray people = f.getJSONArray("people");
            List<String[]> list = new ArrayList<>();
            for (int j = 0; j < people.length(); j++) list.add(new String[]{people.getJSONArray(j).getString(0), people.getJSONArray(j).getString(1)});
            JSONArray want = f.getJSONArray("flagged");
            boolean[] expected = new boolean[want.length()];
            for (int j = 0; j < want.length(); j++) expected[j] = want.getBoolean(j);
            assertArrayEquals(f.toString(), expected, Names.flags(list));
        }
    }

    @Test
    public void nothingHiddenSurvives() {
        // Every format and control character of the BMP, between two letters: gone.
        for (int c = 0; c < 0x10000; c++) {
            int t = Character.getType(c);
            if (t != Character.FORMAT && t != Character.CONTROL) continue;
            String n = Names.normalize("a" + (char) c + "b");
            assertTrue(Integer.toHexString(c) + " → " + n, n.equals("ab") || n.equals("a b"));
        }
        assertEquals("Alice", Names.normalize("‮Alice‬"));
        assertEquals("", Names.normalize(null));
        assertEquals("", Names.skeleton(null));
        assertFalse(Names.mixedScript(null));
    }

    @Test
    public void aSenderIsComparedWithTheRoomAndWithMe() {
        List<String[]> roster = Arrays.asList(
            new String[]{"p-me", "k:me", "Mike"},
            new String[]{"p-1", "k:alice", "Alice"},
            new String[]{"p-2", "k:bob", "Bob"});
        // Bob, as himself: fine.
        assertFalse(Names.senderFlag(roster, "Mike", "p-2", "Bob"));
        // Someone in the room calling themselves Аlice (Cyrillic А): flagged on the script alone.
        assertTrue(Names.senderFlag(roster, "Mike", "p-2", "Аlice"));
        // Bob renamed to "alice" while Alice is here: another identity has that skeleton.
        assertTrue(Names.senderFlag(roster, "Mike", "p-2", "alice"));
        // Someone no longer here who used my name: flagged; an old message of Alice's (her earlier connection): not.
        assertTrue(Names.senderFlag(roster, "Mike", "p-gone", "Mıke"));
        assertTrue(Names.senderFlag(roster, "Mike", "p-gone", "mike"));
        assertFalse(Names.senderFlag(roster, "Mike", "p-old", "Alice"));
        // Nothing to compare: no flag.
        assertFalse(Names.senderFlag(new ArrayList<>(), "", "p-x", "Carol"));
        assertFalse(Names.senderFlag(roster, "Mike", "p-x", ""));
    }

    @Test
    public void flaggedNamesAndTheOperator() {
        assertEquals("⚠ Alice", Names.shown("Al​ice", true));
        assertEquals("Alice", Names.shown("Al​ice", false));
        // An operator notice never shows the name its frame gave — only its kind's sign.
        assertEquals("📣 Operator", Names.operator("📣 Alice", "Operator"));
        assertEquals("✉ Operator", Names.operator("✉ Bob", "Operator"));
        assertEquals("📌 Operator", Names.operator("📌 ", "Operator"));
        assertEquals("📣 Operator", Names.operator("Mallory", "Operator"));
        assertEquals("📣 Operator", Names.operator(null, "Operator"));
        assertTrue("notice-x".startsWith(Names.NOTICE_ID));
    }
}
