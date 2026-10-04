package cz.m5cet.app.chat;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.HashSet;
import java.util.Set;

/** 6.7: a saved room's Clone — the copy's name is the next free one (a room's name is its key). */
public class RoomsCloneTest {
    private static Set<String> keys(String... names) {
        Set<String> out = new HashSet<>();
        for (String n : names) out.add(RoomKeys.normalizeRoom(n));
        return out;
    }

    @Test public void theNextNumberNoRoomHas() {
        assertEquals("Tým 2", Rooms.cloneName("Tým", keys("Tým")));
        assertEquals("Tým 3", Rooms.cloneName("Tým", keys("Tým", "Tým 2")));
        // a numbered one counts on from its number
        assertEquals("Tým 3", Rooms.cloneName("Tým 2", keys("Tým", "Tým 2")));
        assertEquals("Sprint 13", Rooms.cloneName("Sprint 12", keys("Sprint 12")));
        assertEquals("Sprint 14", Rooms.cloneName("Sprint 12", keys("Sprint 12", "sprint-13")));
    }

    @Test public void theCopyIsAnotherRoom() {
        Set<String> taken = keys("Rodina", "Rodina 2", "Rodina 3");
        String name = Rooms.cloneName("Rodina", taken);
        assertFalse(taken.contains(RoomKeys.normalizeRoom(name)));
        // a long name keeps room for the number within the key's 48 characters
        String longName = "A very long room name that goes on and on and on and on";
        Set<String> t2 = keys(longName);
        String copy = Rooms.cloneName(longName, t2);
        assertTrue(copy, copy.endsWith(" 2"));
        assertFalse(t2.contains(RoomKeys.normalizeRoom(copy)));
        assertTrue(RoomKeys.normalizeRoom(copy).length() <= 48);
    }

    @Test public void anEmptyNameStillGetsOne() {
        assertEquals("room 2", Rooms.cloneName("", keys()));
        assertEquals("room 2", Rooms.cloneName(null, keys()));
    }
}
