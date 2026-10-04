package cz.m5cet.app.chat;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** 6.8: the app's call history — bounded (500 calls, 90 days), kept as JSON in the vault. */
public class CallHistoryTest {
    private static final long DAY = 24 * 3600_000L;

    private static CallHistory.Entry entry(String id, long at) {
        return CallHistory.Entry.of(id, "team", "Team", new CallTrack.Record(CallTrack.IN, at, 5, false, Arrays.asList("Alice")));
    }

    @Test
    public void keepsTheLast500OldestFirst() {
        long now = 1_000 * DAY;
        List<CallHistory.Entry> list = new ArrayList<>();
        for (int i = 0; i < 700; i++) list.add(entry("c" + i, now - (700 - i) * 60_000L));
        java.util.Collections.shuffle(list, new java.util.Random(7));
        List<CallHistory.Entry> kept = CallHistory.bound(list, now);
        assertEquals(CallHistory.KEEP, kept.size());
        assertEquals("c200", kept.get(0).id);
        assertEquals("c699", kept.get(kept.size() - 1).id);
        for (int i = 1; i < kept.size(); i++) assertTrue(kept.get(i - 1).at <= kept.get(i).at);
    }

    @Test
    public void dropsWhatIsOlderThan90DaysOrFromTheFuture() {
        long now = 1_000 * DAY;
        List<CallHistory.Entry> kept = CallHistory.bound(Arrays.asList(entry("old", now - 91 * DAY), entry("edge", now - 89 * DAY), entry("new", now), entry("future", now + 3 * DAY)), now);
        assertEquals(2, kept.size());
        assertEquals("edge", kept.get(0).id);
        assertEquals("new", kept.get(1).id);
    }

    @Test
    public void roundTripsThroughJson() throws Exception {
        CallHistory.Entry e = CallHistory.Entry.of("x1", "team", "Tým", new CallTrack.Record(CallTrack.DECLINED, 123, 0, true, Arrays.asList("Alice", "Bob")));
        e.sysUri = "content://call_log/calls/42";
        JSONObject json = new JSONObject(CallHistory.toJson(Arrays.asList(e)).toString());
        CallHistory.Entry back = CallHistory.fromJson(json).get(0);
        assertEquals("x1", back.id);
        assertEquals("team", back.roomKey);
        assertEquals("Tým", back.room);
        assertEquals(CallTrack.DECLINED, back.kind);
        assertEquals(123, back.at);
        assertTrue(back.video);
        assertEquals(Arrays.asList("Alice", "Bob"), back.people);
        assertEquals("content://call_log/calls/42", back.sysUri);
    }

    @Test
    public void anUnknownKindReadsAsMissedAndNothingBreaksOnJunk() throws Exception {
        List<CallHistory.Entry> list = CallHistory.fromJson(new JSONObject("{c:[{id:'a', kind:'weird', at:5, sec:-3}, 7, null]}"));
        assertEquals(1, list.size());
        assertEquals(CallTrack.MISSED, list.get(0).kind);
        assertEquals(0, list.get(0).seconds);
        assertTrue(CallHistory.fromJson(new JSONObject()).isEmpty());
        assertTrue(CallHistory.fromJson(null).isEmpty());
    }
}
