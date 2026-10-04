package cz.m5cet.app.telecom;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;

import cz.m5cet.app.security.Crypto;

/** 6.8: which rooms become Android conversations, in what order, under what label, and what goes (telecom/ConversationPlan). */
public class ConversationPlanTest {
    private static final byte[] SECRET = Crypto.unhex("00112233445566778899aabbccddeeff");
    private static final Function<String, String> ID = key -> ConversationPlan.id(SECRET, key);

    private static ConversationPlan.Room room(String key, String label, long activity, boolean joined) {
        return new ConversationPlan.Room(key, label, activity, joined);
    }

    private static final List<ConversationPlan.Room> ROOMS = Arrays.asList(
        room("rodina", "Rodina", 300, true),
        room("prace", "Práce", 900, true),
        room("stara", "Stará", 999, false),          // saved, left: no conversation
        room("klub", "Klub", 300, true),             // the same activity as "rodina": by key
        room("bez-nazvu", "  ", 100, true));          // no label: its key

    @Test
    public void onlyJoinedRoomsMostRecentFirst() {
        List<ConversationPlan.Entry> all = ConversationPlan.plan(ROOMS, ID, true, "Konverzace {n}");
        assertEquals(4, all.size());
        assertEquals("prace", all.get(0).key);
        assertEquals("klub", all.get(1).key);
        assertEquals("rodina", all.get(2).key);
        assertEquals("bez-nazvu", all.get(3).key);
        for (int i = 0; i < all.size(); i++) assertEquals(i, all.get(i).rank);
        assertEquals("Práce", all.get(0).label);
        assertEquals("P", all.get(0).glyph);
        assertEquals("Práce", all.get(0).seed);
        assertEquals("bez-nazvu", all.get(3).label);
        assertTrue(all.get(0).named);
    }

    @Test
    public void aRoomTwiceCountsOnce() {
        List<ConversationPlan.Entry> all = ConversationPlan.plan(Arrays.asList(room("a", "A", 1, true), room("a", "A again", 2, true), null), ID, true, "C {n}");
        assertEquals(1, all.size());
    }

    @Test
    public void capFollowsTheSystemButStaysSmall() {
        assertEquals(8, ConversationPlan.cap(15));
        assertEquals(5, ConversationPlan.cap(5));
        assertEquals(0, ConversationPlan.cap(0));
        assertEquals(0, ConversationPlan.cap(-1));
        List<ConversationPlan.Entry> all = ConversationPlan.plan(ROOMS, ID, true, "C {n}");
        List<ConversationPlan.Entry> top = ConversationPlan.top(all, 2);
        assertEquals(2, top.size());
        assertEquals("prace", top.get(0).key);
        assertEquals("klub", top.get(1).key);
        assertEquals(4, ConversationPlan.top(all, 10).size());
        assertEquals(0, ConversationPlan.top(all, 0).size());
    }

    @Test
    public void namesOnlyWhenWantedUnlockedAndNotificationsMayNameTheRoom() {
        assertTrue(ConversationPlan.names(true, false, 2));   // "room"
        assertTrue(ConversationPlan.names(true, false, 3));   // "content"
        assertFalse(ConversationPlan.names(true, true, 3));   // locked (S11)
        assertFalse(ConversationPlan.names(true, false, 1));  // "sender": a conversation notification shows the shortcut's label
        assertFalse(ConversationPlan.names(true, false, 0));  // "neutral"
        assertFalse(ConversationPlan.names(false, false, 3)); // switched off
    }

    @Test
    public void neutralLabelsSayNothingOfTheRoomAndStayPutWhenTheOrderChanges() {
        List<ConversationPlan.Entry> neutral = ConversationPlan.plan(ROOMS, ID, false, "Konverzace {n}");
        Set<String> labels = new HashSet<>();
        for (ConversationPlan.Entry e : neutral) {
            assertFalse(e.named);
            assertTrue(e.label, e.label.matches("Konverzace [1-4]"));
            assertEquals(e.label.substring("Konverzace ".length()), e.glyph);
            assertEquals(e.glyph, e.seed);
            for (String name : new String[]{ "Rodina", "Práce", "Klub", "rodina", "prace", "klub", "bez-nazvu" }) {
                assertFalse(e.label.contains(name));
                assertFalse(e.id.contains(name));
            }
            labels.add(e.label);
        }
        assertEquals(4, labels.size());
        // Numbered by id, not by activity: a new message elsewhere does not rename anything.
        List<ConversationPlan.Room> later = Arrays.asList(room("rodina", "Rodina", 5000, true), room("prace", "Práce", 900, true), room("klub", "Klub", 300, true), room("bez-nazvu", "", 100, true));
        List<ConversationPlan.Entry> after = ConversationPlan.plan(later, ID, false, "Konverzace {n}");
        assertEquals("rodina", after.get(0).key);
        assertEquals(labelsById(neutral), labelsById(after));
        assertEquals(ConversationPlan.setSignature(neutral, false), ConversationPlan.setSignature(after, false));
        assertNotEquals(ConversationPlan.rankSignature(neutral), ConversationPlan.rankSignature(after));
    }

    private static Map<String, String> labelsById(List<ConversationPlan.Entry> entries) {
        Map<String, String> out = new LinkedHashMap<>();
        for (ConversationPlan.Entry e : entries) out.put(e.id, e.label);
        return new java.util.TreeMap<>(out);
    }

    @Test
    public void neutralTemplateFallsBack() {
        assertEquals("Conversation 3", ConversationPlan.neutral("Conversation {n}", 3));
        assertEquals("M5cet 2", ConversationPlan.neutral("conversations.neutral", 2)); // a design without the string
        assertEquals("M5cet 1", ConversationPlan.neutral(null, 1));
    }

    @Test
    public void neutralOfKnownIdsAlone() {
        List<ConversationPlan.Entry> n = ConversationPlan.neutralOf(Arrays.asList("conv-b", "conv-a", "conv-b"), "C {n}");
        assertEquals(2, n.size());
        assertEquals("conv-a", n.get(0).id);
        assertEquals("C 1", n.get(0).label);
        assertEquals("C 2", n.get(1).label);
        assertFalse(n.get(1).named);
    }

    @Test
    public void idsAreKeyedStableAndCarryNoName() {
        String a = ConversationPlan.id(SECRET, "rodina");
        assertEquals(a, ConversationPlan.id(SECRET, "rodina"));
        assertTrue(a, a.matches("conv-[0-9a-f]{20}"));
        assertNotEquals(a, ConversationPlan.id(SECRET, "prace"));
        assertNotEquals(a, ConversationPlan.id(Crypto.unhex("ffeeddccbbaa99887766554433221100"), "rodina"));
        // 6.7's id was an unkeyed hash of the name — anyone could compute it; this one is not it.
        assertNotEquals("room-" + Integer.toHexString("rodina".hashCode()), a);
        assertTrue(ConversationPlan.ours(a));
        assertTrue(ConversationPlan.ours("room-1a2b"));
        assertFalse(ConversationPlan.ours("other"));
        assertFalse(ConversationPlan.ours(null));
    }

    @Test
    public void whatGoesWhenARoomIsLeftDeletedOrRenamed() {
        String rodina = ID.apply("rodina"), prace = ID.apply("prace"), klub = ID.apply("klub");
        List<String> existing = Arrays.asList(rodina, prace, klub, "room-6a1f", "other-shortcut", prace);
        // "klub" left (or deleted, or renamed — a new name is a new room): it goes, and so does 6.7's id.
        Set<String> keep = new HashSet<>(Arrays.asList(rodina, prace));
        assertEquals(Arrays.asList(klub, "room-6a1f"), ConversationPlan.stale(existing, keep));
        // Nothing changed: nothing goes but 6.7's.
        keep.add(klub);
        assertEquals(Collections.singletonList("room-6a1f"), ConversationPlan.stale(existing, keep));
    }

    @Test
    public void everythingGoesWhenSwitchedOff() {
        String rodina = ID.apply("rodina"), prace = ID.apply("prace");
        List<String> existing = Arrays.asList(rodina, prace, "room-6a1f", "other-shortcut");
        assertEquals(Arrays.asList(rodina, prace, "room-6a1f"), ConversationPlan.stale(existing, Collections.emptySet()));
    }

    @Test
    public void signaturesSeparateWhatShowsFromTheOrder() {
        List<ConversationPlan.Entry> named = ConversationPlan.plan(ROOMS, ID, true, "C {n}");
        List<ConversationPlan.Entry> neutral = ConversationPlan.plan(ROOMS, ID, false, "C {n}");
        // The lock (names → neutral) changes what shows: published at once.
        assertNotEquals(ConversationPlan.setSignature(named, true), ConversationPlan.setSignature(neutral, false));
        // A rename changes what shows.
        List<ConversationPlan.Room> renamed = Arrays.asList(room("rodina", "Naši", 300, true), room("prace", "Práce", 900, true), room("klub", "Klub", 300, true), room("bez-nazvu", "", 100, true));
        assertNotEquals(ConversationPlan.setSignature(named, true), ConversationPlan.setSignature(ConversationPlan.plan(renamed, ID, true, "C {n}"), true));
        // A new message in another room: only the order.
        List<ConversationPlan.Room> busier = Arrays.asList(room("rodina", "Rodina", 5000, true), room("prace", "Práce", 900, true), room("klub", "Klub", 300, true), room("bez-nazvu", "  ", 100, true));
        List<ConversationPlan.Entry> after = ConversationPlan.plan(busier, ID, true, "C {n}");
        assertEquals(ConversationPlan.setSignature(named, true), ConversationPlan.setSignature(after, true));
        assertNotEquals(ConversationPlan.rankSignature(named), ConversationPlan.rankSignature(after));
        // A room left: what shows.
        List<ConversationPlan.Room> left = Arrays.asList(room("prace", "Práce", 900, true), room("klub", "Klub", 300, true), room("bez-nazvu", "  ", 100, true));
        assertNotEquals(ConversationPlan.setSignature(named, true), ConversationPlan.setSignature(ConversationPlan.plan(left, ID, true, "C {n}"), true));
    }

    @Test
    public void whenToPublish() {
        long now = 1_000_000_000L, last = now - 60_000;
        assertEquals(ConversationPlan.NOW, ConversationPlan.when(true, false, false, now, last));   // what shows: at once, even in the background
        assertEquals(ConversationPlan.NOW, ConversationPlan.when(true, true, true, now, now));
        assertEquals(ConversationPlan.NOTHING, ConversationPlan.when(false, false, true, now, last));
        assertEquals(ConversationPlan.ON_FOREGROUND, ConversationPlan.when(false, true, false, now, last));
        assertEquals(ConversationPlan.RANK_EVERY_MS - 60_000, ConversationPlan.when(false, true, true, now, last));
        assertEquals(ConversationPlan.NOW, ConversationPlan.when(false, true, true, now, now - ConversationPlan.RANK_EVERY_MS));
    }

    @Test
    public void monogramColoursAreOpaqueTintsOfTheWebs() {
        assertEquals(0xffffffff, ConversationPlan.opaque(0x00123456));
        assertEquals(0xff123456, ConversationPlan.opaque(0xff123456));
        int bg = ConversationPlan.background("Rodina");
        assertEquals(0xff, bg >>> 24);
        // A light tint: every channel well above the letter's.
        int fg = ConversationPlan.foreground("Rodina");
        for (int shift = 0; shift <= 16; shift += 8) assertTrue(((bg >> shift) & 0xff) > ((fg >> shift) & 0xff));
        assertEquals(ConversationPlan.background("rodina"), bg); // the web's hue ignores case
    }

    @Test
    public void defaultsAreOn() {
        Map<String, Object> d = new LinkedHashMap<>();
        ConversationPlan.defaults(d);
        assertEquals(Boolean.TRUE, d.get("conversations.on"));
        assertEquals(Boolean.TRUE, d.get("conversations.names"));
    }
}
