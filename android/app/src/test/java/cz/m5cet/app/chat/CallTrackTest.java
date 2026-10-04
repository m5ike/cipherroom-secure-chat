package cz.m5cet.app.chat;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** 6.8: what a room's call was for me — incoming, outgoing, missed, declined; one record per call. */
public class CallTrackTest {
    private static final List<String> NOBODY = Collections.emptyList();
    private static List<String> live(String... names) { return Arrays.asList(names); }

    @Test
    public void iStartAloneOthersComeIHangUpOutgoing() {
        CallTrack t = new CallTrack();
        assertTrue(t.update(1_000, true, false, NOBODY, false).records.isEmpty());
        CallTrack.Step s = t.update(2_000, true, false, live("Alice"), false);
        assertFalse("my own call does not ring", s.ring);
        t.update(3_000, true, false, live("Alice", "Bob"), false);
        s = t.update(63_000, false, false, live("Alice", "Bob"), false);
        assertEquals(1, s.records.size());
        CallTrack.Record r = s.records.get(0);
        assertEquals(CallTrack.OUT, r.kind);
        assertEquals(1_000, r.at);
        assertEquals(62, r.seconds);
        assertFalse(r.video);
        assertEquals(live("Alice", "Bob"), r.people);
        // The others go on and end: nothing more for me (I was in it).
        t.update(70_000, false, false, NOBODY, false);
        assertTrue(t.update(70_000 + CallTrack.GRACE_MS, false, false, NOBODY, false).records.isEmpty());
    }

    @Test
    public void anOutgoingCallNobodyCameToIsStillOneOutgoing() {
        CallTrack t = new CallTrack();
        t.update(0, true, false, NOBODY, false);
        CallTrack.Step s = t.update(30_000, false, false, NOBODY, false);
        assertEquals(1, s.records.size());
        assertEquals(CallTrack.OUT, s.records.get(0).kind);
        assertTrue(s.records.get(0).people.isEmpty());
        assertTrue("no missed call after it", t.update(30_000 + CallTrack.GRACE_MS, false, false, NOBODY, false).records.isEmpty());
    }

    @Test
    public void someoneCallsItRingsIJoinIncomingWithVideo() {
        CallTrack t = new CallTrack();
        CallTrack.Step s = t.update(1_000, false, false, live("Alice"), true);
        assertTrue(s.ring);
        assertEquals("Alice", s.who);
        assertTrue(s.video);
        assertFalse("rings once", t.update(2_000, false, false, live("Alice"), true).ring);
        s = t.update(5_000, true, false, live("Alice"), true);
        assertTrue("joining ends the ring", s.ringOver);
        s = t.update(65_000, false, false, live("Alice"), true);
        assertEquals(CallTrack.IN, s.records.get(0).kind);
        assertEquals(5_000, s.records.get(0).at);
        assertEquals(60, s.records.get(0).seconds);
        assertTrue("the others' video makes it a video call", s.records.get(0).video);
    }

    @Test
    public void myCameraMakesItAVideoCall() {
        CallTrack t = new CallTrack();
        t.update(0, true, true, NOBODY, false);
        t.update(1_000, true, false, live("Bob"), false); // the camera off later: still a video call
        assertTrue(t.update(9_000, false, false, live("Bob"), false).records.get(0).video);
    }

    @Test
    public void aCallThatEndsWithoutMeIsMissedAfterTheGrace() {
        CallTrack t = new CallTrack();
        assertTrue(t.update(1_000, false, false, live("Alice"), false).ring);
        CallTrack.Step s = t.update(10_000, false, false, NOBODY, false);
        assertTrue("not yet: the call may come back", s.records.isEmpty());
        assertEquals(10_000 + CallTrack.GRACE_MS, s.recheckAt);
        s = t.update(10_000 + CallTrack.GRACE_MS, false, false, NOBODY, false);
        assertEquals(1, s.records.size());
        CallTrack.Record r = s.records.get(0);
        assertEquals(CallTrack.MISSED, r.kind);
        assertEquals("when the call started", 1_000, r.at);
        assertEquals(0, r.seconds);
        assertEquals(live("Alice"), r.people);
        assertTrue(s.ringOver);
    }

    @Test
    public void aDroppedConnectionWithinTheGraceIsTheSameCall() {
        CallTrack t = new CallTrack();
        t.update(0, false, false, live("Alice"), false);
        t.update(5_000, false, false, NOBODY, false);                       // the channel dropped
        CallTrack.Step s = t.update(9_000, false, false, live("Alice"), false); // and came back
        assertFalse("no second ring", s.ring);
        assertTrue(s.records.isEmpty());
        t.update(20_000, false, false, NOBODY, false);
        s = t.update(20_000 + CallTrack.GRACE_MS, false, false, NOBODY, false);
        assertEquals("one missed call, not two", 1, s.records.size());
        assertEquals(0, s.records.get(0).at);
    }

    @Test
    public void declinedUnlessIJoinAfterAll() {
        CallTrack t = new CallTrack();
        t.update(0, false, false, live("Alice"), false);
        assertTrue(t.decline().ringOver);
        assertFalse(t.ringing());
        t.update(3_000, false, false, NOBODY, false);
        CallTrack.Step s = t.update(3_000 + CallTrack.GRACE_MS, false, false, NOBODY, false);
        assertEquals(CallTrack.DECLINED, s.records.get(0).kind);

        CallTrack u = new CallTrack();
        u.update(0, false, false, live("Alice"), false);
        u.decline();
        assertFalse("a declined call does not ring again", u.update(1_000, false, false, live("Alice", "Bob"), false).ring);
        u.update(2_000, true, false, live("Alice", "Bob"), false);
        s = u.update(12_000, false, false, NOBODY, false);
        assertEquals(CallTrack.IN, s.records.get(0).kind);
        assertTrue(u.update(12_000 + CallTrack.GRACE_MS, false, false, NOBODY, false).records.isEmpty());
    }

    @Test
    public void aDeclineWithoutACallChangesNothing() {
        CallTrack t = new CallTrack();
        assertFalse(t.decline().ringOver);
        t.update(0, true, false, NOBODY, false);
        t.decline(); // I am in it
        assertEquals(CallTrack.OUT, t.update(5_000, false, false, NOBODY, false).records.get(0).kind);
    }

    @Test
    public void flushRecordsWhatIsOpen() {
        CallTrack t = new CallTrack();
        t.update(0, true, false, live("Alice"), false);
        CallTrack.Step s = t.flush(30_000);
        assertEquals(1, s.records.size());
        assertEquals(CallTrack.IN, s.records.get(0).kind);
        assertEquals(30, s.records.get(0).seconds);

        CallTrack u = new CallTrack();
        u.update(0, false, false, live("Alice"), false);
        s = u.flush(5_000);
        assertEquals(CallTrack.MISSED, s.records.get(0).kind);
        assertTrue(s.ringOver);
        assertTrue("nothing twice", u.flush(6_000).records.isEmpty());
    }

    @Test
    public void rejoiningIsASecondRecordOfMine() {
        CallTrack t = new CallTrack();
        t.update(0, false, false, live("Alice"), false);
        t.update(1_000, true, false, live("Alice"), false);
        assertEquals(CallTrack.IN, t.update(11_000, false, false, live("Alice"), false).records.get(0).kind);
        assertFalse("no ring once I was in it", t.update(12_000, false, false, live("Alice"), false).ring);
        t.update(20_000, true, false, live("Alice"), false);
        CallTrack.Step s = t.update(50_000, false, false, live("Alice"), false);
        assertEquals(CallTrack.IN, s.records.get(0).kind);
        assertEquals(30, s.records.get(0).seconds);
    }

    @Test
    public void namesAreKeptInOrderOnceAndBounded() {
        CallTrack t = new CallTrack();
        t.update(0, true, false, live("A", "B"), false);
        t.update(1, true, false, live("B", "A", "", "C"), false);
        for (int i = 0; i < 20; i++) t.update(2 + i, true, false, live("P" + i), false);
        List<String> people = t.update(100, false, false, NOBODY, false).records.get(0).people;
        assertEquals(Arrays.asList("A", "B", "C"), people.subList(0, 3));
        assertEquals(CallTrack.PEOPLE_MAX, people.size());
    }
}
