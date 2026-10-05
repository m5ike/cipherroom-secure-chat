package cz.m5cet.app.chat;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;

/**
 * 6.12 (security analysis F-16): what the lock inbox brings into a room's
 * history at the unlock — new messages after the history in their order, a
 * known id replaced in its place by its newer state, receipts on my older
 * messages, nothing twice (a second merge after a crash changes nothing),
 * and only what the history would keep.
 */
public class LockedRoomsTest {
    private static final String ROOM = "team";
    private static final long NOW = 1_800_000_000_000L;

    private static ChatMessage msg(String id, String text, boolean mine, long at) {
        ChatMessage m = new ChatMessage();
        m.id = id; m.roomKey = ROOM; m.text = text; m.mine = mine; m.createdAt = at;
        m.senderName = mine ? "me" : "Alice";
        m.status = mine ? "sent" : "received";
        return m;
    }

    private static JSONObject item(ChatMessage m) throws Exception { return new JSONObject().put("t", "msg").put("room", ROOM).put("m", m.toJson()); }

    private static JSONObject state(String id, String who, String name, String s) throws Exception {
        return new JSONObject().put("t", "state").put("room", ROOM).put("id", id).put("who", who).put("name", name).put("state", s);
    }

    private static List<String> ids(List<ChatMessage> l) { List<String> out = new ArrayList<>(); for (ChatMessage m : l) out.add(m.id); return out; }

    @Test
    public void newOnesAfterTheHistoryAKnownIdInItsPlace() throws Exception {
        List<ChatMessage> history = new ArrayList<>(Arrays.asList(msg("a", "first", false, 1), msg("b", "second", false, 2), msg("c", "mine", true, 3)));
        ChatMessage d = msg("d", "while locked", false, 10);
        ChatMessage b2 = msg("b", "second", false, 2);
        b2.filePath = "xfer-1"; // its file was stored meanwhile
        ChatMessage d2 = msg("d", "while locked", false, 10);
        d2.vanished = true;
        ChatMessage e = msg("e", "later", false, 11);
        List<JSONObject> items = Arrays.asList(item(d), item(b2), state("c", "peer-1", "Bob", "delivered"), item(e), item(d2));
        List<ChatMessage> merged = LockedRooms.merge(history, ROOM, items, NOW);
        assertEquals(List.of("a", "b", "c", "d", "e"), ids(merged));
        assertEquals("xfer-1", merged.get(1).filePath);
        assertTrue("the newer state of d", merged.get(3).vanished);
        ChatMessage c = merged.get(2);
        assertEquals("delivered", c.receipts.optString("peer-1"));
        assertEquals("delivered", c.status);
    }

    @Test
    public void aSecondMergeChangesNothing() throws Exception {
        List<ChatMessage> history = new ArrayList<>(Arrays.asList(msg("a", "first", false, 1), msg("c", "mine", true, 3)));
        List<JSONObject> items = Arrays.asList(item(msg("d", "x", false, 10)), state("c", "peer-1", "Bob", "read"), item(msg("e", "y", false, 11)));
        List<ChatMessage> once = LockedRooms.merge(history, ROOM, items, NOW);
        List<ChatMessage> twice = LockedRooms.merge(once, ROOM, items, NOW);
        assertEquals(ids(once), ids(twice));
        assertEquals("read", twice.get(1).receipts.optString("peer-1"));
        assertEquals("read", twice.get(1).status);
    }

    @Test
    public void receiptsMoveUpOnlyOnMine() throws Exception {
        List<ChatMessage> history = new ArrayList<>(Arrays.asList(msg("c", "mine", true, 3), msg("x", "theirs", false, 4)));
        List<JSONObject> items = Arrays.asList(state("c", "peer-1", "Bob", "read"), state("c", "peer-1", "Bob", "delivered"),
            state("x", "peer-1", "Bob", "read"), state("gone", "peer-1", "Bob", "read"), state("c", "relay", "relay", "nonsense"));
        List<ChatMessage> merged = LockedRooms.merge(history, ROOM, items, NOW);
        assertEquals("read", merged.get(0).receipts.optString("peer-1"));
        assertEquals("read", merged.get(0).status);
        assertEquals("", merged.get(1).receipts.optString("peer-1"));
        assertEquals(2, merged.size());
    }

    @Test
    public void onlyWhatAHistoryKeeps() throws Exception {
        ChatMessage sys = msg("s1", "connected", false, 5);
        sys.kind = "sys";
        ChatMessage longId = msg("x".repeat(97), "too long an id", false, 6);
        ChatMessage noId = msg("", "no id", false, 7);
        ChatMessage future = msg("f", "from the future", false, NOW + 86_400_000L);
        ChatMessage otherRoom = msg("o", "elsewhere", false, 8);
        otherRoom.roomKey = "elsewhere";
        List<JSONObject> items = Arrays.asList(item(sys), item(longId), item(noId), item(future), item(otherRoom),
            new JSONObject().put("t", "msg").put("room", ROOM)); // no message at all
        List<ChatMessage> merged = LockedRooms.merge(new ArrayList<>(), ROOM, items, NOW);
        assertEquals(List.of("f", "o"), ids(merged));
        assertEquals("a time from the future is the bound", NOW + Payloads.FUTURE_SKEW, merged.get(0).createdAt);
        assertEquals("the item's room is the room", ROOM, merged.get(1).roomKey);
        assertNull(LockedRooms.valid(null, ROOM, NOW));
        assertNotNull(LockedRooms.valid(msg("ok", "fine", false, 1).toJson(), ROOM, NOW));
    }

    @Test
    public void itemsAreGroupedForTheirStores() throws Exception {
        List<byte[]> opened = new ArrayList<>();
        for (JSONObject o : new JSONObject[]{
            item(msg("a", "x", false, 1)),
            state("a", "p", "P", "read"),
            new JSONObject().put("t", "msg").put("room", "other").put("m", msg("b", "y", false, 2).toJson()),
            new JSONObject().put("t", "pin").put("slot", "team\u0000alice").put("kid", "K1"),
            new JSONObject().put("t", "pin").put("slot", "team\u0000alice").put("kid", "K2"), // first use wins
            new JSONObject().put("t", "resume").put("room", ROOM).put("peerId", "peer-9").put("secret", "s"),
            new JSONObject().put("t", "call").put("e", new JSONObject().put("id", "c1").put("key", ROOM)),
            new JSONObject().put("t", "callUri").put("id", "c1").put("uri", "content://call/1"),
            new JSONObject().put("t", "file").put("id", "xfer-1"),
            new JSONObject().put("t", "what"),
        }) opened.add(o.toString().getBytes(StandardCharsets.UTF_8));
        opened.add("not json".getBytes(StandardCharsets.UTF_8));
        LockedRooms.Parsed p = LockedRooms.parse(opened);
        assertEquals(new HashSet<>(Arrays.asList(ROOM, "other")), p.rooms.keySet());
        assertEquals(2, p.rooms.get(ROOM).size());
        assertEquals("K1", p.pins.get("team\u0000alice"));
        assertEquals("peer-9", p.resumes.get(ROOM)[0]);
        assertEquals(1, p.calls.size());
        assertEquals("content://call/1", p.callUris.get("c1"));
        assertEquals(1, p.files.size());
        assertEquals(2, p.unknown);
    }

    @Test
    public void aFileThatCouldNotBeStoredSaysSo() {
        ChatMessage got = msg("m1", "", false, 1);
        got.filePath = "xfer-1";
        ChatMessage mine = msg("m2", "", true, 2);
        mine.filePath = "xfer-1";
        List<ChatMessage> list = Arrays.asList(got, mine);
        LockedRooms.markLostFiles(list, new HashSet<>(List.of("xfer-1")));
        assertNull(got.filePath);
        assertEquals(-2, got.fileProgress, 0);
        assertEquals("xfer-1", mine.filePath);
    }
}
