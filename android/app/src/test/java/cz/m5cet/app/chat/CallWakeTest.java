package cz.m5cet.app.chat;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * 6.14 — call wake (CallWake; the web's lib/call-wake.ts): when a call I
 * start rings the away members and when hanging up ends the ring; the sealed
 * payload and the relay frame's fields; a relayed item checked like a message
 * (and dropped by Payloads.validate — what an older app does); the server's
 * pushed call; and the inbox — a pushed ring rings, a relayed one waits for
 * the room, the room showing the call takes it over (one record per call),
 * the rest is a missed (or declined) call, once.
 */
public class CallWakeTest {
    private static final long NOW = 1_760_000_000_000L;
    private static List<String> refs(String... r) { return Arrays.asList(r); }

    /* ------------------------------------------------------------ sender */

    @Test
    public void aCallIStartRingsTheAwayMembers() {
        CallWake.Sender s = new CallWake.Sender();
        CallWake.Ring ring = s.start(true, 0, refs("a", "b", "a"), true, NOW, () -> "cw-1");
        assertNotNull(ring);
        assertEquals("cw-1", ring.callId);
        assertTrue(ring.video);
        assertEquals(NOW, ring.at);
        assertEquals(refs("a", "b"), ring.refs);
        assertEquals(ring, s.ringing());
    }

    @Test
    public void ringsNobodyOnAnOlderServerWhenJoiningSomeonesCallOrWithNobodyAway() {
        CallWake.Sender s = new CallWake.Sender();
        assertNull(s.start(false, 0, refs("a"), false, NOW, () -> "cw-1"));
        assertNull(s.start(true, 1, refs("a"), false, NOW, () -> "cw-1"));
        assertNull(s.start(true, 0, Collections.emptyList(), false, NOW, () -> "cw-1"));
        assertNull(s.stop(refs("a")));
    }

    @Test
    public void hangingUpUnansweredEndsTheRingForThoseStillAway() {
        CallWake.Sender s = new CallWake.Sender();
        s.start(true, 0, refs("a", "b"), false, NOW, () -> "cw-1");
        CallWake.Ring end = s.stop(refs("b", "c"));
        assertNotNull(end);
        assertEquals("cw-1", end.callId);
        assertEquals(refs("b"), end.refs);
        assertNull("once", s.stop(refs("b")));
        s.start(true, 0, refs("a"), false, NOW, () -> "cw-2");
        s.answered();
        assertNull(s.ringing());
        assertNull("answered: no end", s.stop(refs("a")));
        s.start(true, 0, refs("a"), false, NOW, () -> "cw-3");
        assertNull("everyone came back", s.stop(Collections.emptyList()));
    }

    @Test
    public void thePayloadAndTheRelayFields() throws Exception {
        JSONObject p = CallWake.payload("cw-7", CallWake.RING, true, NOW - 5, "peer-1", "Bob", NOW);
        assertEquals("call", p.getString("kind"));
        assertEquals("cw-7:r", p.getString("id"));
        assertEquals(NOW, p.getLong("createdAt"));
        assertEquals("peer-1", p.getString("senderId"));
        assertEquals("Bob", p.getString("senderName"));
        assertEquals("cw-7", p.getString("call"));
        assertEquals("ring", p.getString("state"));
        assertTrue(p.getBoolean("video"));
        assertEquals(NOW - 5, p.getLong("at"));
        assertEquals("cw-7:e", CallWake.messageId("cw-7", CallWake.END));
        JSONObject ring = CallWake.relayFields("cw-7", CallWake.RING, true);
        assertTrue(ring.getBoolean("call"));
        assertFalse(ring.has("callEnd"));
        assertEquals("cw-7", ring.getString("callId"));
        assertTrue(ring.getBoolean("video"));
        JSONObject end = CallWake.relayFields("cw-7", CallWake.END, false);
        assertTrue(end.getBoolean("callEnd"));
        assertFalse(end.has("call"));
        assertFalse(end.has("video"));
        assertTrue(CallWake.newCallId().matches("cw-[0-9a-f]{24}"));
    }

    /* ----------------------------------------------------------- parsing */

    private static JSONObject item(String state) { return CallWake.payload("cw-7", state, false, NOW - 1_000, "peer-1", "Bob", NOW - 1_000); }

    @Test
    public void aRelayedItemIsCheckedLikeAMessage() throws Exception {
        CallWake.Item it = CallWake.parse(item(CallWake.RING), "peer-1", "me", NOW);
        assertNotNull(it);
        assertEquals("cw-7", it.call);
        assertFalse(it.end());
        assertEquals("Bob", it.senderName);
        assertEquals(NOW - 1_000, it.at);
        assertNull("another sender", CallWake.parse(item(CallWake.RING), "peer-2", "me", NOW));
        assertNull("us", CallWake.parse(item(CallWake.RING).put("senderId", "me"), null, "me", NOW));
        assertNull("reserved", CallWake.parse(item(CallWake.RING).put("senderId", "system"), null, "me", NOW));
        assertNull(CallWake.parse(item(CallWake.RING).put("state", "ringing"), null, "me", NOW));
        assertNull(CallWake.parse(item(CallWake.RING).put("call", "with space"), null, "me", NOW));
        assertNull(CallWake.parse(item(CallWake.RING).put("kind", "text"), null, "me", NOW));
        CallWake.Item ahead = CallWake.parse(item(CallWake.END).put("at", NOW + 3_600_000L).put("video", "yes"), null, "me", NOW);
        assertTrue(ahead.end());
        assertEquals(NOW + Payloads.FUTURE_SKEW, ahead.at);
        assertFalse(ahead.video);
    }

    @Test
    public void anOlderAppDropsItSilently() {
        assertNull(Payloads.validate(item(CallWake.RING), "peer-1", "me"));
    }

    @Test
    public void theServersPushedCall() throws Exception {
        JSONObject n = new JSONObject().put("kind", "call").put("vars", new JSONObject().put("sender", "Bob"))
            .put("call", new JSONObject().put("id", "cw-7").put("room", "r3.alpha").put("video", true).put("at", NOW - 2_000));
        CallWake.Pushed p = CallWake.pushed(n, NOW);
        assertNotNull(p);
        assertEquals("cw-7", p.call);
        assertEquals("r3.alpha", p.room);
        assertEquals("Bob", p.who);
        assertTrue(p.video);
        assertFalse(p.end);
        assertEquals(NOW - 2_000, p.at);
        assertTrue(CallWake.pushed(new JSONObject(n.toString()).put("call", n.getJSONObject("call").put("end", true)), NOW).end);
        assertNull("no room (not the app channel)", CallWake.pushed(new JSONObject().put("kind", "call").put("call", new JSONObject().put("id", "cw-7")), NOW));
        assertNull("a 6.13 call notification", CallWake.pushed(new JSONObject().put("kind", "call"), NOW));
        assertNull(CallWake.pushed(new JSONObject(n.toString()).put("kind", "message"), NOW));
        assertEquals("privacy neutral: no name", "", CallWake.pushed(new JSONObject(n.toString()).put("vars", new JSONObject()), NOW).who);
    }

    /* ------------------------------------------------------------- inbox */

    private static CallWake.Pushed push(String call, boolean end, long at) throws Exception {
        return CallWake.pushed(new JSONObject().put("kind", "call").put("vars", new JSONObject().put("sender", "Bob"))
            .put("call", new JSONObject().put("id", call).put("room", "r3.alpha").put("at", at).put("end", end)), at);
    }

    private static CallWake.Item relayed(String call, String state) throws Exception {
        return CallWake.parse(CallWake.payload(call, state, false, NOW, "peer-1", "Bob", NOW), "peer-1", "me", NOW);
    }

    @Test
    public void aPushedRingRingsAndUnansweredBecomesAMissedCall() throws Exception {
        CallWake.Inbox box = new CallWake.Inbox();
        CallWake.Step s = box.push(push("cw-1", false, NOW), NOW, false);
        assertTrue(s.ring);
        assertEquals("Bob", s.who);
        assertTrue(box.waiting());
        assertEquals(NOW + CallWake.RING_MS, box.nextDue());
        assertTrue(box.due(NOW + CallWake.RING_MS - 1).records.isEmpty());
        s = box.due(NOW + CallWake.RING_MS);
        assertTrue(s.over);
        assertEquals(1, s.records.size());
        assertEquals(CallTrack.MISSED, s.records.get(0).kind);
        assertEquals(NOW, s.records.get(0).at);
        assertEquals(Collections.singletonList("Bob"), s.records.get(0).people);
        assertNotNull(s.missed);
        assertFalse(box.waiting());
        // The same call again (the relayed item later): nothing.
        assertTrue(box.relayed(relayed("cw-1", CallWake.RING), NOW + 70_000, false).records.isEmpty());
        assertTrue(box.relayed(relayed("cw-1", CallWake.END), NOW + 70_000, false).records.isEmpty());
    }

    @Test
    public void itsEndStopsTheRingAndRecordsTheMissedCallAtOnce() throws Exception {
        CallWake.Inbox box = new CallWake.Inbox();
        box.push(push("cw-1", false, NOW), NOW, false);
        CallWake.Step s = box.push(push("cw-1", true, NOW + 5_000), NOW + 5_000, false);
        assertTrue(s.over);
        assertFalse(s.ring);
        assertEquals(CallTrack.MISSED, s.records.get(0).kind);
        assertEquals(NOW, s.records.get(0).at);
        assertNotNull(s.missed);
        assertTrue(box.due(NOW + CallWake.RING_MS).records.isEmpty());
    }

    @Test
    public void declinedPushedRingIsADeclinedCallWithoutAMissedNotice() throws Exception {
        CallWake.Inbox box = new CallWake.Inbox();
        box.push(push("cw-1", false, NOW), NOW, false);
        box.decline();
        CallWake.Step s = box.due(NOW + CallWake.RING_MS);
        assertEquals(CallTrack.DECLINED, s.records.get(0).kind);
        assertNull(s.missed);
    }

    @Test
    public void theRoomShowingTheCallTakesItOverOneRecordPerCall() throws Exception {
        CallWake.Inbox box = new CallWake.Inbox();
        box.push(push("cw-1", false, NOW), NOW, false);
        assertFalse("not declined", box.roomInCall());
        assertFalse(box.waiting());
        assertTrue(box.due(NOW + CallWake.RING_MS).records.isEmpty());
        assertTrue("its end: CallTrack records it", box.push(push("cw-1", true, NOW + 9_000), NOW + 9_000, false).records.isEmpty());
        // Declined before the room showed it: the room declines its ring.
        box.push(push("cw-2", false, NOW), NOW, false);
        box.decline();
        assertTrue(box.roomInCall());
        // A ring while the room already shows a call: the room's own CallTrack rings.
        CallWake.Step s = box.push(push("cw-3", false, NOW), NOW, true);
        assertFalse(s.ring);
        assertFalse(box.waiting());
    }

    @Test
    public void aRelayedRingNeverRingsItWaitsForTheRoom() throws Exception {
        CallWake.Inbox box = new CallWake.Inbox();
        CallWake.Step s = box.relayed(relayed("cw-1", CallWake.RING), NOW, false);
        assertFalse(s.ring);
        assertEquals(NOW + CallWake.SETTLE_MS, box.nextDue());
        s = box.due(NOW + CallWake.SETTLE_MS);
        assertFalse("it never rang", s.over);
        assertEquals(CallTrack.MISSED, s.records.get(0).kind);
        // An end whose ring never came is a missed call by itself; one the room shows nothing.
        assertEquals(CallTrack.MISSED, box.relayed(relayed("cw-2", CallWake.END), NOW, false).records.get(0).kind);
        assertTrue(box.relayed(relayed("cw-3", CallWake.RING), NOW, true).records.isEmpty());
        assertFalse(box.waiting());
    }

    @Test
    public void aLatePushDoesNotRingItWaitsLikeARelayedOne() throws Exception {
        CallWake.Inbox box = new CallWake.Inbox();
        CallWake.Step s = box.push(push("cw-1", false, NOW - CallWake.RING_MS - 1), NOW, false);
        assertFalse(s.ring);
        assertEquals(NOW + CallWake.SETTLE_MS, box.nextDue());
    }

    @Test
    public void thePushDidNotNameTheCallerTheRelayedItemDoes() throws Exception {
        CallWake.Inbox box = new CallWake.Inbox();
        CallWake.Pushed anonymous = CallWake.pushed(new JSONObject().put("kind", "call").put("call", new JSONObject().put("id", "cw-1").put("room", "r3.alpha").put("at", NOW)), NOW);
        assertEquals("", box.push(anonymous, NOW, false).who);
        box.relayed(relayed("cw-1", CallWake.RING), NOW + 1_000, false);
        assertEquals(Collections.singletonList("Bob"), box.due(NOW + CallWake.RING_MS).records.get(0).people);
    }
}
