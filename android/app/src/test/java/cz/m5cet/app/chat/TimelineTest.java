package cz.m5cet.app.chat;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

/** 6.2: every state of a message with its time, kept in the history with the message; a hide. */
public class TimelineTest {

    private static List<String> states(ChatMessage m) {
        List<String> out = new ArrayList<>();
        for (ChatMessage.Step s : m.timeline()) out.add(s.state + (s.meta.isEmpty() ? "" : ":" + s.meta));
        return out;
    }

    @Test public void aStatusMoveIsAStepAndARecipientsReceiptNamesThem() {
        ChatMessage m = new ChatMessage();
        m.status = "sending";
        m.mark("created", "", 100);
        m.mark("encrypted", "", 110);
        assertTrue(m.raise("sent", "Jana, Petr"));
        assertEquals("sent", m.status);
        m.raise("delivered", "Jana");
        m.raise("delivered", "Petr"); // the status is already "delivered": a step anyway
        assertFalse(m.raise("sent")); // never down, and no step
        m.raise("read", "Jana");
        assertEquals("read", m.status);
        List<String> s = states(m);
        assertEquals("created", s.get(0));
        assertEquals("encrypted", s.get(1));
        assertTrue(s.contains("sent:Jana, Petr"));
        assertTrue(s.contains("delivered:Jana"));
        assertTrue(s.contains("delivered:Petr"));
        assertTrue(s.contains("read:Jana"));
        assertFalse(s.contains("sent"));
        assertEquals(6, s.size());
    }

    @Test public void theOutboxRaiseIsAStepToo() {
        ChatMessage m = new ChatMessage();
        m.status = "queued";
        m.mark("queued");
        assertTrue(m.raise("sent"));
        assertTrue(states(m).contains("sent"));
        assertFalse(m.raise("sent"));
        assertEquals(2, m.timeline().size());
    }

    @Test public void theSameStepCountsOnceButHidesRepeat() {
        ChatMessage m = new ChatMessage();
        assertTrue(m.mark("displayed"));
        assertFalse(m.mark("displayed"));
        assertTrue(m.mark("revealed"));
        assertFalse(m.mark("revealed"));
        assertTrue(m.mark("hidden", "1h", 10));
        assertTrue(m.mark("unhidden", "time", 20));
        assertTrue(m.mark("hidden", "1h", 30));
        assertEquals(5, m.timeline().size());
        assertTrue(m.has("revealed"));
        assertFalse(m.has("opened"));
    }

    @Test public void stepsComeInTheOrderTheyHappened() {
        ChatMessage m = new ChatMessage();
        m.mark("received", "relay", 300);
        m.mark("created", "", 100); // the sender's clock, earlier
        m.mark("decrypted", "", 300);
        assertEquals("created", m.timeline().get(0).state);
        assertEquals(100, m.timeline().get(0).at);
    }

    @Test public void theTimelineAndAHideAreKeptInTheHistory() throws Exception {
        ChatMessage m = new ChatMessage();
        m.id = "msg-1";
        m.roomKey = "k";
        m.text = "ahoj";
        m.createdAt = 100;
        m.mark("created", "", 100);
        m.mark("received", "p2p", 200);
        m.mark("displayed", "", 250);
        m.hiddenUntil = ChatMessage.UNTIL_SIGNIN;
        m.hiddenFor = "u1";
        JSONObject stored = new JSONObject(m.toJson().toString());
        ChatMessage back = ChatMessage.fromJson(stored);
        assertEquals(states(m), states(back));
        assertEquals(200, back.timeline().get(1).at);
        assertEquals("p2p", back.timeline().get(1).meta);
        assertEquals(ChatMessage.UNTIL_SIGNIN, back.hiddenUntil);
        assertEquals("u1", back.hiddenFor);
        assertFalse(back.deleted);

        // A message from before 6.2: no timeline, not hidden.
        stored.remove("timeline");
        stored.remove("hiddenUntil");
        stored.remove("hiddenFor");
        ChatMessage old = ChatMessage.fromJson(stored);
        assertTrue(old.timeline().isEmpty());
        assertEquals(0, old.hiddenUntil);
        assertNull(old.hiddenFor);
        assertFalse(old.toJson().has("hiddenUntil"));
    }

    @Test public void aLongTimelineKeepsItsFirstStep() {
        ChatMessage m = new ChatMessage();
        m.mark("created", "", 1);
        for (int i = 0; i < ChatMessage.TIMELINE_MAX + 20; i++) m.mark("delivered", "peer" + i, 10 + i);
        assertEquals(ChatMessage.TIMELINE_MAX, m.timeline().size());
        assertEquals("created", m.timeline().get(0).state);
    }
}
