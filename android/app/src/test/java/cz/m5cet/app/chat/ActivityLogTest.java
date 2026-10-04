package cz.m5cet.app.chat;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.TimeZone;
import java.util.stream.Collectors;

/** 6.8: the History screen's list — calls and messages merged newest first, filters, search, what a message may show. */
public class ActivityLogTest {
    private static final long NOW = 1_760_000_000_000L;

    private static ChatMessage msg(String id, long at, boolean mine, String sender, String text) {
        ChatMessage m = new ChatMessage();
        m.id = id;
        m.createdAt = at;
        m.mine = mine;
        m.senderName = sender;
        m.text = text;
        return m;
    }

    private static ActivityLog.Item call(String id, String kind, long at, String room, String... people) {
        CallHistory.Entry e = CallHistory.Entry.of(id, room.toLowerCase(), room, new CallTrack.Record(kind, at, 61, false, Arrays.asList(people)));
        return ActivityLog.call(e, true);
    }

    private static List<String> ids(List<ActivityLog.Item> items) { return items.stream().map(i -> i.id).collect(Collectors.toList()); }

    @Test
    public void mergesNewestFirstCallsBeforeMessagesAtTheSameTime() {
        List<ActivityLog.Item> calls = Arrays.asList(call("a", CallTrack.MISSED, 300, "Team", "Alice"), call("b", CallTrack.OUT, 100, "Family"));
        List<ActivityLog.Item> messages = new ArrayList<>();
        messages.add(ActivityLog.message("team", "Team", msg("m1", 300, false, "Alice", "hi"), false, NOW));
        messages.add(ActivityLog.message("team", "Team", msg("m2", 200, true, "Me", "hello"), false, NOW));
        List<ActivityLog.Item> all = ActivityLog.merge(calls, messages);
        assertEquals(4, all.size());
        assertEquals("c:a", all.get(0).id);
        assertEquals(ActivityLog.MSG, all.get(1).type);
        assertEquals("m1", all.get(1).msgId);
        assertEquals("m2", all.get(2).msgId);
        assertEquals("c:b", all.get(3).id);
        assertEquals("the same input, the same order", ids(all), ids(ActivityLog.merge(calls, messages)));
    }

    @Test
    public void filtersAllCallsMessagesMissed() {
        List<ActivityLog.Item> all = ActivityLog.merge(
            Arrays.asList(call("a", CallTrack.MISSED, 5, "Team"), call("b", CallTrack.DECLINED, 4, "Team"), call("c", CallTrack.IN, 3, "Team")),
            Arrays.asList(ActivityLog.message("team", "Team", msg("m", 2, false, "Alice", "x"), false, NOW)));
        assertEquals(4, ActivityLog.filter(all, "all", "").size());
        assertEquals(4, ActivityLog.filter(all, null, null).size());
        assertEquals(Arrays.asList("c:a", "c:b", "c:c"), ids(ActivityLog.filter(all, "calls", "")));
        assertEquals(1, ActivityLog.filter(all, "messages", "").size());
        assertEquals("missed only (not declined)", Arrays.asList("c:a"), ids(ActivityLog.filter(all, "missed", "")));
    }

    @Test
    public void searchesRoomPeopleAndTextWithoutCaseOrAccents() {
        List<ActivityLog.Item> all = ActivityLog.merge(
            Arrays.asList(call("a", CallTrack.IN, 5, "Žluťoučký kůň", "Řehoř")),
            Arrays.asList(ActivityLog.message("team", "Team", msg("m", 2, false, "Alice", "Zavoláme se po OBĚDĚ?"), false, NOW)));
        assertEquals(Arrays.asList("c:a"), ids(ActivityLog.filter(all, "all", "zlutoucky")));
        assertEquals(Arrays.asList("c:a"), ids(ActivityLog.filter(all, "all", "REHOR")));
        assertEquals(1, ActivityLog.filter(all, "all", "obede alice").size());
        assertEquals("every word must match", 0, ActivityLog.filter(all, "all", "obede bob").size());
        assertEquals(0, ActivityLog.filter(all, "calls", "obede").size());
    }

    @Test
    public void sealedHoldVanishingAndHiddenMessagesShowOnlyTheirKind() {
        ChatMessage sealed = msg("s", 1, false, "Eva", "CIPHERTEXT");
        sealed.sealed = new JSONObject();
        sealed.sealPlain = "the secret";
        ChatMessage tap = msg("t", 1, false, "Eva", "hold me");
        tap.tap = true;
        ChatMessage vanish = msg("v", 1, false, "Eva", "gone soon");
        vanish.vanishSeconds = 30;
        ChatMessage hidden = msg("h", 1, false, "Eva", "not now");
        String[][] cases = { {"sealed", "the secret"}, {"tap", "hold me"}, {"vanish", "gone soon"}, {"hidden", "not now"} };
        ChatMessage[] ms = { sealed, tap, vanish, hidden };
        for (int i = 0; i < ms.length; i++) {
            ActivityLog.Item it = ActivityLog.message("team", "Team", ms[i], ms[i] == hidden, NOW);
            assertEquals(cases[i][0], it.what);
            assertEquals("", it.preview);
            assertTrue("the search does not see into it", ActivityLog.filter(Arrays.asList(it), "all", cases[i][1].split(" ")[0]).isEmpty());
        }
        // A sealed one even when it is also a file or a command.
        sealed.fileName = "plan.pdf";
        assertEquals("sealed", ActivityLog.message("team", "Team", sealed, false, NOW).what);
    }

    @Test
    public void filesCommandsAndTextHaveAOneLinePreview() throws Exception {
        ChatMessage file = msg("f", 1, true, "Me", "");
        file.fileName = "plan.pdf";
        file.to.add("Bob");
        ActivityLog.Item it = ActivityLog.message("team", "Team", file, false, NOW);
        assertEquals("file", it.what);
        assertEquals("plan.pdf", it.preview);
        assertEquals("out", it.dir);
        assertEquals("a private message of mine names its recipients", Arrays.asList("Bob"), it.people);
        ChatMessage fn = msg("c", 1, false, "Alice", "done");
        fn.fn = new JSONObject("{keyword:'weather'}");
        assertEquals("/weather · done", ActivityLog.message("team", "Team", fn, false, NOW).preview);
        StringBuilder longText = new StringBuilder("line one\nline\ttwo ");
        for (int i = 0; i < 50; i++) longText.append("word ");
        String p = ActivityLog.message("team", "Team", msg("l", 1, false, "A", longText.toString()), false, NOW).preview;
        assertTrue(p.startsWith("line one line two word"));
        assertEquals(ActivityLog.PREVIEW_MAX, p.length());
        assertTrue(p.endsWith("…"));
    }

    @Test
    public void systemLinesExpiredAndDeletedMessagesAreLeftOut() {
        assertNull(ActivityLog.message("team", "Team", ChatMessage.system("team", "Alice joined"), false, NOW));
        ChatMessage expired = msg("e", 1, false, "A", "x");
        expired.expiresAt = NOW - 1;
        assertNull(ActivityLog.message("team", "Team", expired, false, NOW));
        ChatMessage deleted = msg("d", 1, false, "A", "x");
        deleted.deleted = true;
        assertNull(ActivityLog.message("team", "Team", deleted, false, NOW));
        assertNull(ActivityLog.message("team", "Team", null, false, NOW));
    }

    @Test
    public void callsOfARoomNoLongerSavedCannotBeCalled() {
        CallHistory.Entry e = CallHistory.Entry.of("z", "gone", "Gone", new CallTrack.Record(CallTrack.OUT, 1, 0, true, new ArrayList<>()));
        ActivityLog.Item it = ActivityLog.call(e, false);
        assertFalse(it.saved);
        assertEquals("video", it.what);
        assertEquals("out", it.dir);
    }

    @Test
    public void daysAndLengths() {
        TimeZone prague = TimeZone.getTimeZone("Europe/Prague");
        long noon = 1_759_917_600_000L; // 2025-10-08 12:00 in Prague
        assertEquals(0, ActivityLog.daysAgo(noon - 11 * 3600_000L, noon, prague));
        assertEquals(1, ActivityLog.daysAgo(noon - 13 * 3600_000L, noon, prague));
        assertEquals(2, ActivityLog.daysAgo(noon - 2 * 24 * 3600_000L, noon, prague));
        assertEquals("the future counts as today", 0, ActivityLog.daysAgo(noon + 3600_000L, noon, prague));
        assertEquals("", ActivityLog.length(0));
        assertEquals("0:42", ActivityLog.length(42));
        assertEquals("12:04", ActivityLog.length(724));
        assertEquals("1:02:09", ActivityLog.length(3729));
    }
}
