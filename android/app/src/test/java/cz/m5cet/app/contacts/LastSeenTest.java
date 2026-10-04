package cz.m5cet.app.contacts;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

/** 6.7 presence: the same thresholds and words as the web (client/src/lib/presence.ts, test/presence.test.ts). */
public class LastSeenTest {
    private static final long NOW = 1_800_000_000_000L, MIN = 60_000L;

    private static String away(long lastSeen) { return LastSeen.state(false, false, lastSeen, NOW); }

    @Test
    public void onlineWhileConnectedInTheForeground() {
        assertEquals("online", LastSeen.state(true, true, 0, NOW));
        assertEquals("online", LastSeen.state(true, true, NOW - 10 * 60 * MIN, NOW));
    }

    @Test
    public void theThresholdsMatchTheWeb() {
        assertEquals(5 * MIN, LastSeen.ONLINE_MS);
        assertEquals(60 * MIN, LastSeen.AWAY_MS);
        assertEquals("online", away(NOW));
        assertEquals("online", away(NOW - 5 * MIN));
        assertEquals("online", LastSeen.state(true, false, NOW - 4 * MIN, NOW));
        assertEquals("away", away(NOW - 5 * MIN - 1));
        assertEquals("away", away(NOW - 60 * MIN));
        assertEquals("far", away(NOW - 60 * MIN - 1));
        assertEquals("far", away(0));
    }

    @Test
    public void saysWhenTheColourChangesByItself() {
        assertEquals(-1, LastSeen.changeIn(true, true, NOW, NOW));
        long in = LastSeen.changeIn(false, false, NOW - 2 * MIN, NOW);
        assertEquals("away", LastSeen.state(false, false, NOW - 2 * MIN, NOW + in));
        assertEquals("online", LastSeen.state(false, false, NOW - 2 * MIN, NOW + in - 1));
        assertEquals(-1, LastSeen.changeIn(false, false, NOW - 2 * 60 * MIN, NOW));
        assertEquals(NOW, LastSeen.seenAt(true, true, 5, NOW));
        assertEquals(5, LastSeen.seenAt(true, false, 5, NOW));
    }

    @Test
    public void coloursAreThemeTokensAndOrange() {
        assertEquals("@success", LastSeen.color("online"));
        assertEquals("@warning", LastSeen.color("away"));
        assertEquals("#f97316", LastSeen.color("far"));
    }

    @Test
    public void wordsHowLongAgo() {
        LastSeen.Words en = key -> {
            switch (key) {
                case "presence.now": return "In the app right now";
                case "presence.seen": return "Last seen {ago}";
                case "presence.seen.unknown": return "Not known when last seen";
                case "presence.ago.now": return "just now";
                case "presence.ago.min": return "{n} min ago";
                case "presence.ago.h": return "{n} h ago";
                case "presence.ago.d": return "{n} d ago";
                default: return key;
            }
        };
        assertEquals("In the app right now", LastSeen.seenText(true, true, 0, NOW, en));
        assertEquals("Last seen just now", LastSeen.seenText(false, false, NOW - 20_000, NOW, en));
        assertEquals("Last seen 12 min ago", LastSeen.seenText(false, false, NOW - 12 * MIN, NOW, en));
        assertEquals("Last seen 3 h ago", LastSeen.seenText(true, false, NOW - 3 * 60 * MIN - 5, NOW, en));
        assertEquals("Last seen 2 d ago", LastSeen.seenText(false, false, NOW - 2 * 24 * 60 * MIN, NOW, en));
        assertEquals("Not known when last seen", LastSeen.seenText(false, false, 0, NOW, en));
        assertEquals("min", LastSeen.ago(NOW - 12 * MIN, NOW).unit);
        assertEquals(12, LastSeen.ago(NOW - 12 * MIN, NOW).n);
    }

    @Test
    public void decoratesAPersonOfThePeopleWidget() throws Exception {
        LastSeen.Words w = key -> key;
        JSONObject live = LastSeen.decorate(new JSONObject().put("channel", "open").put("connected", true).put("foreground", false).put("lastSeen", (double) (NOW - 20 * MIN)).put("statusIcon", "circle-check"), w, NOW);
        assertEquals("away", live.getString("presence"));
        assertEquals("@warning", live.getString("presenceColor"));
        assertEquals("presence.away", live.getString("presenceLabel"));
        assertEquals("circle-check", live.getString("statusIcon")); // a live peer keeps its connection status

        JSONObject held = LastSeen.decorate(new JSONObject().put("channel", "held").put("connected", false).put("foreground", false).put("lastSeen", (double) (NOW - 3 * 60 * MIN)), w, NOW);
        assertEquals("far", held.getString("presence"));
        assertEquals("moon", held.getString("statusIcon"));
        assertEquals("#f97316", held.getString("statusColor"));

        JSONObject none = LastSeen.decorate(new JSONObject().put("channel", "open"), w, NOW);
        assertFalse(none.has("presence"));
        assertTrue(LastSeen.decorate(new JSONObject().put("me", true).put("connected", true).put("foreground", true).put("lastSeen", (double) NOW), w, NOW).has("seenText"));
    }
}
