package cz.m5cet.app.chat;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.stream.Collectors;

/** 6.7: what a room learns of its people's presence from the server's frames (hub.ts). */
public class RoomPresenceTest {
    private static JSONObject j(String s) { try { return new JSONObject(s); } catch (Exception e) { throw new IllegalStateException(e); } }

    private static List<String> ids(List<RoomPresence.Held> held) { return held.stream().map(h -> h.peerId).collect(Collectors.toList()); }

    @Test
    public void foregroundLastSeenAndHeldMembersFromJoined() {
        RoomPresence p = new RoomPresence();
        p.onFrame(j("{type:'joined', peerId:'me', peers:[{peerId:'p1', name:'A', foreground:true, lastSeen:100}, {peerId:'p2', name:'B', foreground:false, lastSeen:50}],"
            + " held:[{peerId:'p3', name:'C', lastSeen:20, since:30, account:'ref-c'}], away:[{account:'ref-d', name:'D', since:9, lastSeen:7}]}"));
        assertTrue(p.live("p1").foreground);
        assertFalse(p.live("p2").foreground);
        assertEquals(50, p.live("p2").lastSeen);
        assertEquals(Collections.singletonList("p3"), ids(p.held(Collections.emptySet(), Collections.emptySet())));
        RoomPresence.Held c = p.held(Collections.emptySet(), Collections.emptySet()).get(0);
        assertEquals("C", c.name);
        assertEquals(20, c.lastSeen);
        assertEquals(30, c.since);
        assertEquals(7, p.awayLastSeen("ref-d"));
        assertEquals(0, p.awayLastSeen("ref-x"));
    }

    @Test
    public void aServerBefore67CountsAsForeground() {
        RoomPresence p = new RoomPresence();
        p.onFrame(j("{type:'peer-joined', peerId:'p1', name:'A'}"));
        assertTrue(p.live("p1").foreground);
        assertEquals(0, p.live("p1").lastSeen);
        assertNull(p.live("p9"));
    }

    @Test
    public void backgroundHeldBackAndGone() {
        RoomPresence p = new RoomPresence();
        p.onFrame(j("{type:'peer-joined', peerId:'p1', name:'A', foreground:true, lastSeen:1}"));
        p.onFrame(j("{type:'peer-presence', peerId:'p1', foreground:false, lastSeen:5}"));
        assertFalse(p.live("p1").foreground);
        assertEquals(5, p.live("p1").lastSeen);

        // The connection went: held, not gone.
        p.onFrame(j("{type:'peer-left', peerId:'p1', held:true, name:'A', lastSeen:5, since:8}"));
        assertNull(p.live("p1"));
        assertEquals(Collections.singletonList("p1"), ids(p.held(Collections.emptySet(), Collections.emptySet())));

        // Back as the same peer.
        p.onFrame(j("{type:'peer-joined', peerId:'p1', name:'A', foreground:true, lastSeen:9}"));
        assertTrue(p.held(Collections.emptySet(), Collections.emptySet()).isEmpty());
        assertTrue(p.live("p1").foreground);

        // Gone for good.
        p.onFrame(j("{type:'peer-left', peerId:'p1', held:true, name:'A', lastSeen:9, since:10}"));
        p.onFrame(j("{type:'peer-left', peerId:'p1'}"));
        assertTrue(p.held(Collections.emptySet(), Collections.emptySet()).isEmpty());
    }

    @Test
    public void heldMembersAreNotListedTwice() {
        RoomPresence p = new RoomPresence();
        p.onFrame(j("{type:'peer-left', peerId:'p1', held:true, name:'Ann', account:'ref-ann', lastSeen:1, since:2}"));
        p.onFrame(j("{type:'peer-left', peerId:'p2', held:true, name:'Ben', lastSeen:1, since:2}"));
        // The relay already lists Ann under her account; a live p2 is not held.
        assertEquals(Collections.singletonList("p2"), ids(p.held(Collections.emptySet(), Collections.singleton("ref-ann"))));
        assertEquals(Collections.singletonList("p1"), ids(p.held(Collections.singleton("p2"), Collections.emptySet())));
        assertEquals(Arrays.asList("p1", "p2"), ids(p.held(Collections.emptySet(), Collections.emptySet())));
    }

    @Test
    public void relayAwayMembersKeepWhenTheyWereLastSeen() {
        RoomPresence p = new RoomPresence();
        p.onFrame(j("{type:'peer-away', account:'ref-a', name:'A', since:20, lastSeen:15}"));
        assertEquals(15, p.awayLastSeen("ref-a"));
        p.onFrame(j("{type:'peer-away', accountId:'ref-b', name:'B', since:30}"));
        assertEquals(30, p.awayLastSeen("ref-b"));
        p.onFrame(j("{type:'peer-back', account:'ref-a'}"));
        assertEquals(0, p.awayLastSeen("ref-a"));
        p.onFrame(j("{type:'unknown'}"));
        p.onFrame(j("{}"));
    }
}
