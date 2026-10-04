package cz.m5cet.app.telecom;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.provider.CallLog;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;

import cz.m5cet.app.chat.CallTrack;

/** 6.8: what a phone call log entry is named (neutral by default, never more while locked) and its type. */
public class CallLogBridgeTest {
    @Test
    public void onlyTheAppByDefaultAndWhileLocked() {
        assertEquals("M5cet", CallLogBridge.entryName("app", false, "M5cet", "Team", Arrays.asList("Alice")));
        assertEquals("an unknown level is the neutral one", "M5cet", CallLogBridge.entryName("everything", false, "M5cet", "Team", Arrays.asList("Alice")));
        assertEquals("M5cet", CallLogBridge.entryName("room", true, "M5cet", "Team", Arrays.asList("Alice")));
        assertEquals("M5cet", CallLogBridge.entryName("people", true, "M5cet", "Team", Arrays.asList("Alice")));
        assertEquals("no app name: still not the room", "M5cet", CallLogBridge.entryName("app", false, "  ", "Team", null));
    }

    @Test
    public void theRoomAndThePeopleWhenChosen() {
        assertEquals("Chat · Team", CallLogBridge.entryName("room", false, "Chat", "Team", Arrays.asList("Alice")));
        assertEquals("Alice, Bob · Team", CallLogBridge.entryName("people", false, "M5cet", "Team", Arrays.asList("Alice", "Bob")));
        assertEquals("A, B, C +2 · Team", CallLogBridge.entryName("people", false, "M5cet", "Team", Arrays.asList("A", "B", "", "C", "D", "E")));
        assertEquals("nobody: the room", "M5cet · Team", CallLogBridge.entryName("people", false, "M5cet", "Team", Collections.emptyList()));
        assertEquals("no room: the app", "M5cet", CallLogBridge.entryName("room", false, "M5cet", "", Arrays.asList("Alice")));
    }

    @Test
    public void namesAreOneCleanBoundedLine() {
        String name = CallLogBridge.entryName("people", false, "M5cet", "Te\nam‮", Arrays.asList("Al\tice\u0000"));
        assertEquals("Al ice · Te am", name);
        StringBuilder huge = new StringBuilder();
        for (int i = 0; i < 300; i++) huge.append('x');
        String cut = CallLogBridge.entryName("people", false, "M5cet", huge.toString(), Arrays.asList(huge.toString(), huge.toString(), huge.toString()));
        assertTrue(cut.length() <= 120);
        assertFalse(cut.contains("\n"));
    }

    @Test
    public void typesOfTheCallLog() {
        assertEquals(CallLog.Calls.OUTGOING_TYPE, CallLogBridge.systemType(CallTrack.OUT));
        assertEquals(CallLog.Calls.INCOMING_TYPE, CallLogBridge.systemType(CallTrack.IN));
        assertEquals(CallLog.Calls.MISSED_TYPE, CallLogBridge.systemType(CallTrack.MISSED));
        assertEquals(CallLog.Calls.REJECTED_TYPE, CallLogBridge.systemType(CallTrack.DECLINED));
        assertEquals(CallLog.Calls.MISSED_TYPE, CallLogBridge.systemType("anything else"));
    }

    @Test
    public void legacyRowsAreTheOnesWithTheRoomAsTheirNumber() {
        assertEquals("number LIKE 'm5cet:%'", CallLogBridge.LEGACY);
    }
}
