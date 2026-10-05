package cz.m5cet.app.chat;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;

import cz.m5cet.app.p4.Mailbox;
import cz.m5cet.app.p4.P4Error;
import cz.m5cet.app.p4.Prim;
import cz.m5cet.app.p4.Rng;

/**
 * 6.12: protocol 4 between rooms on the JVM — two (or three) P4Rooms wired
 * through an ordered in-memory "data channel": hello v4 both ways, the KEM
 * messages, the session, sender keys v4 with their cert, private messages
 * over the ratchet, file keys, what waits for a session, the downgrade rule,
 * an older peer, and a reset after broken frames.
 */
public class P4RoomTest {
    static final String ROOM = "r3.p4RoomTestRoomId", CHECK = "00112233aabbccdd";

    /** One side: its identity, store and room; what it received. */
    final class Side implements P4Room.Link {
        final String id;
        final ChatIdentity identity;
        final P4Store store = new P4Store(new P4Store.MemoryBackend());
        final P4Room room;
        final List<JSONObject> privateIn = new ArrayList<>(), roomIn = new ArrayList<>();
        final List<String> established = new ArrayList<>();
        int rehellos = 0, floods = 0;
        boolean withBundle;
        /** Our hello v4 cannot be made (a broken attestation: the hello's sig4 transcript refuses it). */
        boolean badAccount;
        /** The channel refuses what we send. */
        boolean refuse;

        Side(String id, ChatIdentity identity) {
            this.id = id;
            this.identity = identity;
            Side self = this;
            this.room = new P4Room(ROOM, CHECK, identity, store, new P4Room.HelloExtras() {
                @Override public JSONObject mailbox() {
                    if (!self.withBundle) return null;
                    try { return new Mailbox(store.mailbox(), P4Device.signer(identity), Rng.SYSTEM).current(System.currentTimeMillis()).bundle.json(); }
                    catch (P4Error e) { return null; }
                }
                @Override public JSONObject account() {
                    try { return self.badAccount ? new JSONObject().put("x", 1) : null; } catch (Exception e) { return null; }
                }
                @Override public JSONObject sth() { return null; }
            }, this, null);
        }

        JSONObject v3(String to) throws Exception {
            return new JSONObject().put("kind", "hello").put("v", 3).put("check", CHECK).put("pk", identity.publicKey).put("dh", identity.dhPublicKey)
                .put("sig", identity.sign(Prim.utf8("m5cet/hello/1|room|" + id + "|" + to + "|" + CHECK + "|" + identity.dhPublicKey))).put("caps", new JSONArray().put("bin"));
        }

        /** Our hello to `to` (v4, or v3 when `v3only` — or when our hello v4 cannot be made, as RoomSession.sendHello does). */
        void hello(Side to, boolean v3only) throws Exception {
            JSONObject v3 = v3(to.id);
            JSONObject h = v3only ? v3 : room.hello(id, to.id, v3);
            if (v3only) room.hello(id, to.id, v3); // still a handshake on our side, never sent
            wire.add(new Object[]{this, to, (h == null ? v3 : h).toString()});
        }

        @Override public boolean send(String peerId, String text) {
            if (refuse) return false;
            wire.add(new Object[]{this, side(peerId), text});
            return true;
        }
        @Override public void delivered(String peerId, JSONObject payload, Envelopes.Signer signer, boolean pairSealed) {
            assertTrue(signer.valid);
            assertEquals(side(peerId).identity.publicKey, signer.publicKey);
            (pairSealed ? privateIn : roomIn).add(payload);
        }
        @Override public void established(String peerId) { established.add(peerId); }
        @Override public void rehello(String peerId) {
            rehellos++;
            try { hello(side(peerId), false); } catch (Exception e) { throw new AssertionError(e); }
        }
        @Override public void flood(String peerId) { floods++; }
    }

    final ArrayDeque<Object[]> wire = new ArrayDeque<>();
    final List<Side> sides = new ArrayList<>();
    final List<String> verdicts = new ArrayList<>();
    /** The newest hello on each "from>to" path. */
    final java.util.Map<String, JSONObject> lastHello = new java.util.HashMap<>();
    /** How many p4-reset frames were delivered. */
    int resetFrames = 0;

    Side side(String id) { for (Side s : sides) if (s.id.equals(id)) return s; throw new AssertionError("no side " + id); }

    Side add(String id, ChatIdentity identity) { Side s = new Side(id, identity); sides.add(s); return s; }

    /** Delivers everything on the wire, in order, as RoomSession.onPeerText would. */
    void pump() throws Exception {
        while (!wire.isEmpty()) {
            Object[] w = wire.poll();
            Side from = (Side) w[0], to = (Side) w[1];
            JSONObject raw = new JSONObject((String) w[2]);
            switch (raw.optString("kind")) {
                case "hello":
                    lastHello.put(from.id + ">" + to.id, raw);
                    // A new hello from a peer we have a session with (it re-helloed): ours first, as RoomSession.onHello does.
                    P4Room.PeerState ps = to.room.peer(from.id);
                    if (ps != null && ps.session != null && !to.room.helloSent(from.id)) to.hello(from, false);
                    verdicts.add(to.room.onHello(from.id, raw, "ref-" + from.id, System.currentTimeMillis()));
                    break;
                case "p4-kem": to.room.onKem(from.id, raw); break;
                case "p4": to.room.onFrame(from.id, raw); break;
                case "p4-reset": resetFrames++; to.room.onReset(from.id, raw); break;
                default:
                    if (P4Room.isRoomEnvelope(raw)) to.roomIn.add(to.room.openRoom(from.id, raw));
                    break;
            }
        }
    }

    void connect(Side a, Side b) throws Exception {
        a.hello(b, false);
        b.hello(a, false);
        pump();
    }

    static JSONObject msg(String id, String text) throws Exception {
        return new JSONObject().put("id", id).put("text", text).put("createdAt", System.currentTimeMillis()).put("senderId", "x").put("senderName", "X");
    }

    @Test
    public void sessionRoomAndPrivateMessages() throws Exception {
        Side a = add("peer-a", ChatIdentity.generate()), b = add("peer-b", ChatIdentity.generate());
        a.withBundle = true;
        connect(a, b);
        assertEquals(List.of("v4", "v4"), verdicts);
        assertTrue(a.room.ready("peer-b"));
        assertTrue(b.room.ready("peer-a"));
        assertEquals(List.of("peer-b"), a.established);
        // B learned A's mailbox bundle from the hello (the relay can seal to it later).
        assertEquals(1, b.store.devicesOfRef("ref-peer-a").size());
        assertNotNull(b.store.devicesOfRef("ref-peer-a").get(0).bundle);
        assertTrue(b.store.p4Seen(a.identity.publicKey));

        // Room messages: our chain first (an `sk` inner), then the sender-key envelopes.
        for (int i = 0; i < 3; i++) assertEquals(1, a.room.sendRoom(List.of("peer-b"), "m" + i, msg("m" + i, "hi " + i).toString(), System.currentTimeMillis()));
        pump();
        assertEquals(3, b.roomIn.size());
        assertEquals("hi 2", b.roomIn.get(2).getString("text"));

        // Private messages both ways over the ratchet.
        assertTrue(a.room.sendPrivate("peer-b", msg("p1", "secret")));
        assertTrue(b.room.sendPrivate("peer-a", msg("p2", "back")));
        assertTrue(b.room.sendPrivate("peer-a", msg("p3", "again")));
        pump();
        assertEquals("secret", b.privateIn.get(0).getString("text"));
        assertEquals(2, a.privateIn.size());

        // A file key goes before the file; the receiver finds it by transfer id.
        byte[] fk = Prim.unb64(Prim.b64(new byte[32]));
        fk[0] = 7;
        assertTrue(a.room.sendFileKey("peer-b", "xfer-1", fk));
        pump();
        assertArrayEquals(fk, b.room.fileKey("peer-a", "xfer-1"));
        assertNull(b.room.fileKey("peer-a", "xfer-2"));
    }

    @Test
    public void whatWaitsForTheSessionGoesInOrder() throws Exception {
        Side a = add("peer-a", ChatIdentity.generate()), b = add("peer-b", ChatIdentity.generate());
        a.hello(b, false);
        b.hello(a, false);
        // Deliver only B's hello to A: A knows B speaks v4, the session is not up yet.
        Object[] helloToB = wire.poll();
        Object[] helloToA = wire.poll();
        wire.add(helloToA);
        pump();
        assertTrue(a.room.v4("peer-b"));
        assertFalse(a.room.ready("peer-b"));
        assertTrue(a.room.sendPrivate("peer-b", msg("early", "before the session")));
        assertEquals(1, a.room.sendRoom(List.of("peer-b"), "r-early", msg("r-early", "room, early").toString(), System.currentTimeMillis()));
        wire.add(helloToB);
        pump();
        assertTrue(a.room.ready("peer-b"));
        assertEquals("before the session", b.privateIn.get(0).getString("text"));
        assertEquals("room, early", b.roomIn.get(0).getString("text"));
    }

    @Test
    public void downgradeIsRefusedAndOlderPeersAreLegacy() throws Exception {
        ChatIdentity bId = ChatIdentity.generate();
        Side a = add("peer-a", ChatIdentity.generate()), b = add("peer-b", bId);
        connect(a, b);
        assertTrue(a.store.p4Seen(bId.publicKey));
        // The same device key comes back with a protocol-3 hello: refused (§ 1).
        verdicts.clear();
        a.hello(b, false);
        b.hello(a, true);
        pump();
        assertEquals("downgrade", verdicts.get(1));
        assertTrue(a.room.downgrade("peer-b"));
        assertFalse(a.room.v4("peer-b"));
        // A device never seen with protocol 4 is simply older.
        Side c = add("peer-c", ChatIdentity.generate());
        verdicts.clear();
        a.hello(c, false);
        c.hello(a, true);
        pump();
        assertEquals("legacy", verdicts.get(1));
        assertFalse(a.room.v4("peer-c"));
        assertFalse(a.room.sendPrivate("peer-c", msg("x", "y")));
    }

    @Test
    public void brokenFramesResetAndTheSessionComesBack() throws Exception {
        Side a = add("peer-a", ChatIdentity.generate()), b = add("peer-b", ChatIdentity.generate());
        connect(a, b);
        // Two frames that do not open at B: the second failure resets (§ 5.5).
        List<Object[]> bad = new ArrayList<>();
        for (int i = 0; i < 2; i++) {
            a.room.sendPrivate("peer-b", msg("bad" + i, "x"));
            Object[] w = wire.pollLast();
            JSONObject f = new JSONObject((String) w[2]);
            byte[] c = Prim.unb64(f.getString("c"));
            c[0] ^= 1;
            f.put("c", Prim.b64(c));
            bad.add(new Object[]{w[0], w[1], f.toString()});
        }
        wire.addAll(bad);
        pump();
        assertEquals(1, b.rehellos);
        assertEquals(1, a.rehellos);
        assertTrue(a.room.ready("peer-b"));
        assertTrue(b.room.ready("peer-a"));
        a.room.sendPrivate("peer-b", msg("after", "works again"));
        pump();
        assertEquals("works again", b.privateIn.get(b.privateIn.size() - 1).getString("text"));
        assertEquals(0, a.floods + b.floods);
        // A second reset from the peer within 10 s: the channel closes.
        b.room.onReset("peer-a", new JSONObject().put("kind", "p4-reset").put("v", 4).put("why", "x"));
        b.room.onReset("peer-a", new JSONObject().put("kind", "p4-reset").put("v", 4).put("why", "x"));
        assertEquals(1, b.floods);
    }

    /** `n` private messages from `from` to `to` whose ciphertext was changed on the way (they do not open). */
    List<Object[]> brokenFrames(Side from, Side to, int n) throws Exception {
        List<Object[]> bad = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            from.room.sendPrivate(to.id, msg("bad-" + System.nanoTime(), "x"));
            Object[] w = wire.pollLast();
            JSONObject f = new JSONObject((String) w[2]);
            byte[] c = Prim.unb64(f.getString("c"));
            c[0] ^= 1;
            f.put("c", Prim.b64(c));
            bad.add(new Object[]{w[0], w[1], f.toString()});
        }
        return bad;
    }

    /* ------------------------------------------------- 6.12 security review */

    @Test
    public void reviewP03_aProtocol4PeerIsNeverLegacyWhenOurHelloV4CannotBeMade() throws Exception {
        ChatIdentity bId = ChatIdentity.generate();
        Side a = add("peer-a", ChatIdentity.generate()), b = add("peer-b", bId);
        connect(a, b);
        assertTrue(a.store.p4Seen(bId.publicKey));
        // A's next hello v4 cannot be made (its hello goes as protocol 3): B, whose device spoke protocol 4, is not
        // spoken to in protocol 3 (nor under the room key) — it waits ("pending").
        verdicts.clear();
        a.badAccount = true;
        a.hello(b, false);
        b.hello(a, false);
        pump();
        assertEquals("pending", verdicts.get(1));
        assertFalse(a.room.v4("peer-b"));
        assertFalse(a.room.downgrade("peer-b"));
        // A device never seen before whose hello says v4: the same.
        Side c = add("peer-c", ChatIdentity.generate());
        verdicts.clear();
        a.hello(c, false);
        c.hello(a, false);
        pump();
        assertEquals("pending", verdicts.get(1));
        // An older device (a protocol-3 hello, never seen with protocol 4): protocol 3 as before.
        Side d = add("peer-d", ChatIdentity.generate());
        verdicts.clear();
        a.hello(d, false);
        d.hello(a, true);
        pump();
        assertEquals("legacy", verdicts.get(1));
        // RoomSession then makes its hello again and answers the same hello of B: protocol 4 once it can.
        a.badAccount = false;
        a.hello(b, false);
        assertEquals("v4", a.room.onHello("peer-b", lastHello.get("peer-b>peer-a"), "ref-peer-b", System.currentTimeMillis()));
        assertTrue(a.room.v4("peer-b"));
    }

    @Test
    public void reviewP13_ourChainCountsAsHandedOutOnlyOnceItWent() throws Exception {
        Side a = add("peer-a", ChatIdentity.generate()), b = add("peer-b", ChatIdentity.generate());
        a.hello(b, false);
        b.hello(a, false);
        Object[] helloToB = wire.poll();
        Object[] helloToA = wire.poll();
        wire.add(helloToA);
        pump();
        // B speaks v4, no session yet: the chain waits in the queue — not handed out, and not queued twice.
        assertEquals(1, a.room.sendRoom(List.of("peer-b"), "q1", msg("q1", "one").toString(), System.currentTimeMillis()));
        assertEquals(1, a.room.sendRoom(List.of("peer-b"), "q2", msg("q2", "two").toString(), System.currentTimeMillis()));
        assertFalse(a.room.senderKeys.hasOurChain("peer-b"));
        int sks = 0;
        for (String[] w : a.room.peer("peer-b").pending) if ("sk".equals(w[0])) sks++;
        assertEquals(1, sks);
        wire.add(helloToB);
        pump();
        assertTrue(a.room.senderKeys.hasOurChain("peer-b"));
        assertEquals(List.of("one", "two"), List.of(b.roomIn.get(0).getString("text"), b.roomIn.get(1).getString("text")));

        // A channel that refuses the chain: the peer does not count as holding it (it gets it with the next message).
        Side c = add("peer-c", ChatIdentity.generate());
        connect(a, c);
        a.refuse = true;
        assertEquals(0, a.room.sendRoom(List.of("peer-c"), "q3", msg("q3", "lost").toString(), System.currentTimeMillis()));
        assertFalse(a.room.senderKeys.hasOurChain("peer-c"));
        a.refuse = false;
        assertEquals(1, a.room.sendRoom(List.of("peer-c"), "q4", msg("q4", "arrives").toString(), System.currentTimeMillis()));
        pump();
        assertEquals("arrives", c.roomIn.get(c.roomIn.size() - 1).getString("text"));
    }

    @Test
    public void reviewP13_ourOwnResetsNeverCloseTheChannel() throws Exception {
        Side a = add("peer-a", ChatIdentity.generate()), b = add("peer-b", ChatIdentity.generate());
        connect(a, b);
        // Two incidents within 10 s, each two broken frames: B resets twice. Only received resets count toward
        // closing (§ 5.5): B closes nothing, and its second reset goes as a new hello alone — A gets ONE p4-reset.
        wire.addAll(brokenFrames(a, b, 2));
        pump();
        assertEquals(1, resetFrames);
        assertTrue(b.room.ready("peer-a"));
        wire.addAll(brokenFrames(a, b, 2));
        pump();
        assertEquals(2, b.rehellos);
        assertEquals(0, a.floods + b.floods);
        assertEquals(1, resetFrames);
        assertTrue(a.room.ready("peer-b"));
        assertTrue(b.room.ready("peer-a"));
        a.room.sendPrivate("peer-b", msg("after", "still works"));
        pump();
        assertEquals("still works", b.privateIn.get(b.privateIn.size() - 1).getString("text"));
    }

    @Test
    public void reviewP13_theFailureCountDecays() throws Exception {
        Side a = add("peer-a", ChatIdentity.generate()), b = add("peer-b", ChatIdentity.generate());
        connect(a, b);
        // One broken frame, then enough good ones, then another broken one: two incidents far apart — no reset.
        wire.addAll(brokenFrames(a, b, 1));
        pump();
        for (int i = 0; i < cz.m5cet.app.p4.Ratchet.FAILURE_DECAY_FRAMES; i++) a.room.sendPrivate("peer-b", msg("ok" + i, "fine"));
        pump();
        wire.addAll(brokenFrames(a, b, 1));
        pump();
        assertEquals(0, b.rehellos);
        // Two close together still reset (§ 5.5).
        wire.addAll(brokenFrames(a, b, 1));
        pump();
        assertEquals(1, b.rehellos);
    }

    @Test
    public void aPeerGoneTakesItsChainsAndOursIsReplaced() throws Exception {
        Side a = add("peer-a", ChatIdentity.generate()), b = add("peer-b", ChatIdentity.generate());
        connect(a, b);
        a.room.sendRoom(List.of("peer-b"), "m1", msg("m1", "x").toString(), System.currentTimeMillis());
        pump();
        assertEquals(1, b.roomIn.size());
        String before = a.room.senderKeys.currentKeyId();
        a.room.peerGone("peer-b");
        assertNull(a.room.senderKeys.currentKeyId());
        assertEquals(0, a.room.sendRoom(List.of("peer-b"), "m2", msg("m2", "y").toString(), System.currentTimeMillis()));
        assertNotNull(a.room.senderKeys.currentKeyId());
        assertFalse(before.equals(a.room.senderKeys.currentKeyId()));
        assertFalse(a.room.v4("peer-b"));
    }
}
