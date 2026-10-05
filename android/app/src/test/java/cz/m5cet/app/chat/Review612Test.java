package cz.m5cet.app.chat;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import cz.m5cet.app.p4.Handshake;
import cz.m5cet.app.p4.Kt;
import cz.m5cet.app.p4.Mailbox;
import cz.m5cet.app.p4.Merkle;
import cz.m5cet.app.p4.P4;
import cz.m5cet.app.p4.Prim;
import cz.m5cet.app.p4.Replay;
import cz.m5cet.app.p4.Rng;
import cz.m5cet.app.ui.bubble.ReplyQuote;

/**
 * 6.12 security review (docs/review-612.md) — the Android side of the
 * findings: each test asserts the secure behaviour (the web's PoCs in
 * test/review-612-p4.test.ts, as this port does them).
 */
public class Review612Test {
    static final long DAY = 24 * 3600_000L;
    static final String ROOM = "r3.review612Room";

    /** A device certified (v2) by account `seed`, with a mailbox bundle made at `at`: what the key directory lists. */
    static final class Certified {
        final ChatIdentity dev = ChatIdentity.generate();
        final byte[] seed;
        final String apk;
        final Mailbox.Keys keys;
        final JSONObject acc, directory;
        Certified(int accountSeed, long at) throws Exception {
            seed = new byte[32];
            java.util.Arrays.fill(seed, (byte) accountSeed);
            apk = Prim.b64(Prim.ed25519Public(seed));
            keys = Mailbox.createBundle(P4Device.signer(dev), at, Rng.SYSTEM);
            long exp = at + P4.DEVICE_CERT_LIFETIME_MS - 1000;
            JSONObject cert = Handshake.certifyDeviceV2(seed, dev.publicKey, exp, at);
            acc = new JSONObject().put("apk", apk).put("ac", cert.getString("sig")).put("cv", 2).put("exp", exp);
            directory = new JSONObject().put("pk", dev.publicKey).put("apk", apk).put("cert", cert).put("bundle", keys.bundle.json());
        }
        /** Does this device open the frame's item for `ref`? */
        boolean opens(JSONObject frame, String ref, long now) throws Exception {
            JSONObject per = frame.optJSONObject("per");
            if (per == null || !per.has(ref)) return false;
            Mailbox.MemoryStore s = new Mailbox.MemoryStore();
            s.put(keys);
            return new Mailbox(s, P4Device.signer(dev), Rng.SYSTEM).open(per.getJSONObject(ref), ROOM, now) != null;
        }
    }

    static JSONObject frameFor(P4Relay relay, P4Store store, String ref, boolean ktOn, long now) throws Exception {
        Map<String, List<P4Relay.Device>> all = new HashMap<>();
        all.put(ref, relay.devices(ref, store.refAccount(ref), store.devicesOfRef(ref), ktOn, now));
        ChatIdentity me = ChatIdentity.generate();
        Mailbox box = new Mailbox(new Mailbox.MemoryStore(), P4Device.signer(me), Rng.SYSTEM);
        String json = new JSONObject().put("id", "away-1").put("text", "for the member only").put("createdAt", now).toString();
        JSONObject roomEnv = new JSONObject().put("v", 3).put("id", "away-1").put("iv", "x").put("ciphertext", "y");
        return P4Relay.frame("away-1", List.of(ref), all, d -> box.seal(ROOM, "away-1", json, d.pk, d.bundle, null, now), () -> roomEnv, null);
    }

    /* ---------------------------------------------------------------- P01 */

    @Test
    public void p01_aPinnedMembersExpiredBundleDoesNotLetTheServerChooseTheDevice() throws Exception {
        long now = System.currentTimeMillis(), seen = now - 8 * DAY;
        Certified bob = new Certified(0x0b, seen);
        P4Store store = new P4Store(new P4Store.MemoryBackend());
        // Bob's attested hello 8 days ago: his account is pinned for his reference; his bundle has expired since.
        assertEquals("new", store.pinRef("ref-bob", bob.apk));
        store.rememberDevice(ROOM, bob.dev.publicKey, bob.keys.bundle, bob.acc, bob.apk, "ref-bob");
        assertTrue(bob.keys.bundle.exp < now);
        assertEquals(bob.apk, store.refAccount("ref-bob")); // the pin outlives the bundle
        // The server answers key-bundles for Bob's reference with a device of its own account.
        Certified server = new Certified(0x5e, now);
        P4Relay relay = new P4Relay();
        relay.onKeyBundles(new JSONObject().put("ref", "ref-bob").put("devices", new JSONArray().put(server.directory)), now);
        JSONObject frame = frameFor(relay, store, "ref-bob", false, now);
        assertFalse(server.opens(frame, "ref-bob", now));
        assertFalse(frame.has("per"));
        assertTrue(frame.has("envelope")); // the room envelope, which the server cannot open
    }

    @Test
    public void p01_aDevicePlantedBehindAMembersReferenceIsNotSealedTo() throws Exception {
        long now = System.currentTimeMillis();
        Certified bob = new Certified(0x0b, now), planted = new Certified(0x5e, now);
        P4Store store = new P4Store(new P4Store.MemoryBackend());
        store.pinRef("ref-bob", bob.apk);
        store.rememberDevice(ROOM, bob.dev.publicKey, bob.keys.bundle, bob.acc, bob.apk, "ref-bob");
        // A device the server controls shows up under Bob's reference — without an account, or with another one.
        store.rememberDevice("r3.otherRoom", planted.dev.publicKey, planted.keys.bundle, null, null, "ref-bob");
        Certified planted2 = new Certified(0x5f, now);
        store.rememberDevice("r3.third", planted2.dev.publicKey, planted2.keys.bundle, planted2.acc, planted2.apk, "ref-bob");
        // Neither is filed under a reference pinned to Bob's account.
        assertEquals(1, store.devicesOfRef("ref-bob").size());
        // A relayed item's sender bundle never makes a device pin.
        store.updateBundle(planted.dev.publicKey, planted.keys.bundle);
        assertEquals(1, store.devicesOfRef("ref-bob").size());
        JSONObject frame = frameFor(new P4Relay(), store, "ref-bob", false, now);
        assertTrue(bob.opens(frame, "ref-bob", now));
        assertFalse(planted.opens(frame, "ref-bob", now));
        assertTrue(Mailbox.isItem(frame.getJSONObject("per").getJSONObject("ref-bob")));
    }

    @Test
    public void p01_aNeverMetMemberGetsTheRoomEnvelope() throws Exception {
        long now = System.currentTimeMillis();
        Certified server = new Certified(0x5e, now);
        P4Store store = new P4Store(new P4Store.MemoryBackend());
        P4Relay relay = new P4Relay();
        relay.onKeyBundles(new JSONObject().put("ref", "ref-carol").put("devices", new JSONArray().put(server.directory)), now);
        JSONObject frame = frameFor(relay, store, "ref-carol", false, now);
        assertFalse(server.opens(frame, "ref-carol", now));
        assertTrue(frame.has("envelope"));
    }

    @Test
    public void p01_directoryDevicesOfThePinnedAccountNeedKeyTransparency() throws Exception {
        long now = System.currentTimeMillis();
        Certified bob = new Certified(0x0b, now);
        P4Store store = new P4Store(new P4Store.MemoryBackend());
        store.pinRef("ref-bob", bob.apk);
        P4Relay relay = new P4Relay();
        relay.onKeyBundles(new JSONObject().put("ref", "ref-bob").put("devices", new JSONArray().put(bob.directory)), now);
        // No key transparency on this server: the pinned account's v2 certificate is enough.
        assertTrue(bob.opens(frameFor(relay, store, "ref-bob", false, now), "ref-bob", now));
        // Key transparency on, no lookup (or one that did not verify): not sealed to — the room envelope.
        assertFalse(bob.opens(frameFor(relay, store, "ref-bob", true, now), "ref-bob", now));
        relay.onKt("ref-bob", null, now);
        assertEquals("unverified", relay.ktStatus("ref-bob", bob.apk, bob.dev.publicKey, now));
        assertFalse(bob.opens(frameFor(relay, store, "ref-bob", true, now), "ref-bob", now));
        // A verified lookup that logs the account and the device: sealed to; a later `rev`: never.
        String u = Kt.user("bob");
        List<JSONObject> entries = new ArrayList<>();
        entries.add(new JSONObject().put("t", "acct").put("u", u).put("apk", bob.apk).put("ts", 1));
        entries.add(new JSONObject().put("t", "dev").put("u", u).put("apk", bob.apk).put("dpk", bob.dev.publicKey).put("exp", now + DAY).put("ts", 2));
        relay.onKt("ref-bob", checked(entries), now);
        assertEquals("ok", relay.ktStatus("ref-bob", bob.apk, bob.dev.publicKey, now));
        assertTrue(bob.opens(frameFor(relay, store, "ref-bob", true, now), "ref-bob", now));
        entries.add(new JSONObject().put("t", "rev").put("u", u).put("apk", bob.apk).put("dpk", bob.dev.publicKey).put("ts", 3));
        relay.onKt("ref-bob", checked(entries), now);
        assertEquals("revoked", relay.ktStatus("ref-bob", bob.apk, bob.dev.publicKey, now));
        assertFalse(bob.opens(frameFor(relay, store, "ref-bob", false, now), "ref-bob", now));
    }

    /** A lookup of these entries, verified against a log of exactly them (Kt.State.lookup's answer). */
    static Kt.Checked checked(List<JSONObject> entries) throws Exception {
        byte[] seed = new byte[32];
        seed[0] = 0x17;
        String key = Prim.b64(Prim.ed25519Public(seed));
        List<byte[]> leaves = new ArrayList<>();
        for (JSONObject e : entries) leaves.add(Kt.entryLeafHash(e));
        int n = entries.size();
        JSONObject sth = Kt.signSth(seed, n, Merkle.treeHash(leaves, 0, n), 1);
        JSONArray items = new JSONArray();
        for (int i = 0; i < n; i++) {
            JSONArray proof = new JSONArray();
            for (byte[] p : Merkle.inclusionProof(leaves, i, n)) proof.put(Prim.b64(p));
            items.put(new JSONObject().put("entry", entries.get(i)).put("index", i).put("proof", proof));
        }
        Kt.Checked c = Kt.verifyLookup(new JSONObject().put("sth", sth).put("entries", items), key, null);
        assertTrue(c.why, c.ok);
        return c;
    }

    @Test
    public void p01_aDeviceStaysUnderTheReferenceItWasFirstSeenWith() throws Exception {
        long now = System.currentTimeMillis();
        Certified bob = new Certified(0x0b, now);
        P4Store store = new P4Store(new P4Store.MemoryBackend());
        store.rememberDevice(ROOM, bob.dev.publicKey, bob.keys.bundle, bob.acc, bob.apk, "ref-bob");
        // The server gives the same device another reference in the same room: it does not move.
        store.rememberDevice(ROOM, bob.dev.publicKey, bob.keys.bundle, bob.acc, bob.apk, "ref-mallory");
        assertEquals(1, store.devicesOfRef("ref-bob").size());
        assertEquals(0, store.devicesOfRef("ref-mallory").size());
        // In another room (references are per room) it has that room's reference too.
        store.rememberDevice("r3.room2", bob.dev.publicKey, bob.keys.bundle, bob.acc, bob.apk, "ref-bob-2");
        assertEquals(1, store.devicesOfRef("ref-bob-2").size());
        // The reference's account pin: first use; another account is not taken over until the person accepts it.
        assertEquals("new", store.pinRef("ref-bob", bob.apk));
        assertEquals("match", store.pinRef("ref-bob", bob.apk));
        assertEquals("changed", store.pinRef("ref-bob", Prim.b64(new byte[32])));
        assertEquals(bob.apk, store.refAccount("ref-bob"));
        store.repinRef("ref-bob", Prim.b64(new byte[32]));
        assertEquals(Prim.b64(new byte[32]), store.refAccount("ref-bob"));
    }

    /* ---------------------------------------------------------------- P03 */

    @Test
    public void p03_noRoomKeyForPrivateMessagesOrADeviceThatSpokeProtocol4() {
        assertEquals("p4", RoomSession.envelopeFor(true, true, false, true));
        assertEquals("p4", RoomSession.envelopeFor(true, false, true, true));
        assertEquals("pair", RoomSession.envelopeFor(false, true, true, false));
        assertEquals("sender-key", RoomSession.envelopeFor(false, false, true, false));
        assertEquals("room", RoomSession.envelopeFor(false, false, false, false)); // an older peer, a room message
        assertEquals("none", RoomSession.envelopeFor(false, true, false, false)); // a private message: never the room key
        assertEquals("none", RoomSession.envelopeFor(false, false, false, true)); // a device that spoke protocol 4
    }

    /* ---------------------------------------------------------------- P04 */

    @Test
    public void p04_anAttestedDeviceIsAccountOrVerifiedOnlyWithKeyTransparency() {
        assertEquals(Trust.ACCOUNT, Trust.of(true, "match", "match", false, false, false, true));
        assertEquals(Trust.NEW, Trust.of(true, "match", "match", false, false, false, false));
        assertEquals(Trust.NEW, Trust.of(true, "match", "match", false, true, false, false)); // a verified account, unconfirmed
        assertEquals(Trust.VERIFIED, Trust.of(true, "match", "match", true, false, false, false)); // the device itself was verified
        assertEquals(Trust.CHANGED, Trust.of(true, "changed", "match", false, false, false, false));
        assertEquals(Trust.CHANGED, Trust.of(true, "match", "match", false, true, true, true)); // revoked in the log
        assertEquals(Trust.VERIFIED, Trust.of(true, "match", "match", false, true, false, true));
    }

    @Test
    public void p04_aPeersDeviceAgainstItsLookup() throws Exception {
        long now = System.currentTimeMillis();
        String u = Kt.user("bob"), apk = Prim.b64(new byte[32]), other = Prim.b64(Prim.H(new byte[]{9}));
        String pk = ChatIdentity.generate().publicKey;
        List<JSONObject> entries = new ArrayList<>();
        entries.add(new JSONObject().put("t", "acct").put("u", u).put("apk", apk).put("ts", 1));
        assertEquals("missing", RoomSession.ktState(checked(entries), apk, pk, now));
        entries.add(new JSONObject().put("t", "dev").put("u", u).put("apk", apk).put("dpk", pk).put("exp", now + DAY).put("ts", 2));
        Kt.Checked ok = checked(entries);
        assertEquals("ok", RoomSession.ktState(ok, apk, pk, now));
        assertEquals("unverifiable", RoomSession.ktState(null, apk, pk, now));
        entries.add(new JSONObject().put("t", "acct").put("u", u).put("apk", other).put("ts", 3)); // the account key replaced
        assertEquals("revoked", RoomSession.ktState(checked(entries), apk, pk, now));
        // A username the log does not show for that account is not shown.
        assertTrue(RoomSession.userShown(ok.entries, "bob"));
        assertFalse(RoomSession.userShown(ok.entries, "alice"));
    }

    @Test
    public void p04_ownEntriesShowADeviceThisPhoneDoesNotKnow() throws Exception {
        long now = System.currentTimeMillis();
        String u = Kt.user("me"), apk = Prim.b64(new byte[32]), mine = ChatIdentity.generate().publicKey;
        String laptop = ChatIdentity.generate().publicKey, added = ChatIdentity.generate().publicKey;
        List<Kt.Entry> first = checked(List.of(
            new JSONObject().put("t", "acct").put("u", u).put("apk", apk).put("ts", 1),
            new JSONObject().put("t", "dev").put("u", u).put("apk", apk).put("dpk", laptop).put("exp", now + DAY).put("ts", 2),
            new JSONObject().put("t", "dev").put("u", u).put("apk", apk).put("dpk", mine).put("exp", now + DAY).put("ts", 3))).entries;
        // The first check takes what is logged as known (trust on first use).
        P4Device.Own one = P4Device.ownCheck(new JSONObject(), u, first, apk, mine, now);
        assertEquals(0, one.unknown);
        assertFalse(one.accountChanged);
        // The server certifies a device for this account later: unknown.
        List<JSONObject> later = new ArrayList<>();
        for (Kt.Entry e : first) later.add(e.entry);
        later.add(new JSONObject().put("t", "dev").put("u", u).put("apk", apk).put("dpk", added).put("exp", now + DAY).put("ts", 4));
        P4Device.Own two = P4Device.ownCheck(one.state, u, checked(later).entries, apk, mine, now);
        assertEquals(1, two.unknown);
        assertEquals(added, two.state.getJSONArray("pending").getString(0));
        // Revoked again: no longer unknown. Another account key: the other alert.
        later.add(new JSONObject().put("t", "rev").put("u", u).put("apk", apk).put("dpk", added).put("ts", 5));
        later.add(new JSONObject().put("t", "acct").put("u", u).put("apk", Prim.b64(Prim.H(new byte[]{1}))).put("ts", 6));
        P4Device.Own three = P4Device.ownCheck(two.state, u, checked(later).entries, apk, mine, now);
        assertEquals(0, three.unknown);
        assertTrue(three.accountChanged);
    }

    /* ---------------------------------------------------------------- P08 */

    @Test
    public void p08_aVerifiedAccountIsVerifiedUnderTheNameItWasVerifiedUnder() {
        P4Store store = new P4Store(new P4Store.MemoryBackend());
        String apk = Prim.b64(new byte[32]);
        store.pinAccount(apk, ChatIdentity.generate().publicKey, "mallory");
        store.setAccountVerified(apk, true, "Mallory");
        assertEquals("Mallory", store.accountVerifiedName(apk));
        assertTrue(Trust.verifiedUnder(store.accountVerifiedName(apk), "mallory "));
        assertFalse(Trust.verifiedUnder(store.accountVerifiedName(apk), "Alice"));
        // Under "Alice", the account is not "verified" (account key — and a warning naming the verified name).
        boolean accVerified = store.accountVerified(apk) && Trust.verifiedUnder(store.accountVerifiedName(apk), "Alice");
        assertEquals(Trust.ACCOUNT, Trust.of(true, "match", "new", false, accVerified, false, true));
        store.setAccountVerified(apk, false);
        assertEquals("", store.accountVerifiedName(apk));
        assertTrue(Trust.verifiedUnder("", "anyone")); // verified before the fix: the name is not known
    }

    /* ---------------------------------------------------------------- P09 */

    static ChatMessage msg(String id, String senderId, String name, String text, String kid) {
        ChatMessage m = new ChatMessage();
        m.id = id;
        m.senderId = senderId;
        m.senderName = name;
        m.text = text;
        m.senderKid = kid;
        return m;
    }

    @Test
    public void p09_aForwardIsVerifiedByTheKeyNotTheName() {
        String bobKid = "bob-kid-000000000", malloryKid = "mal-kid-000000000";
        ChatMessage fwd = msg("f1", "p-mallory", "Mallory", "pay 100 to X", malloryKid);
        fwd.forwardedFrom = "Bob";
        // Mallory's own message under the name "Bob" (any key but the one pinned for Bob): not verified.
        ChatMessage fake = msg("m1", "p-mallory-2", "Bob", "pay 100 to X", malloryKid);
        assertFalse(Verified.forward(fwd, List.of(fake, fwd), bobKid, "Me"));
        // Held behind a changed identity: not verified either.
        ChatMessage held = msg("m2", "p-bob", "Bob", "pay 100 to X", bobKid);
        held.changed = true;
        assertFalse(Verified.forward(fwd, List.of(held, fwd), bobKid, "Me"));
        // The forwarder's own message: not verified.
        ChatMessage own = msg("m3", "p-mallory", "Bob", "pay 100 to X", bobKid);
        assertFalse(Verified.forward(fwd, List.of(own, fwd), bobKid, "Me"));
        // Bob's message from the key pinned for Bob: verified.
        ChatMessage real = msg("m4", "p-bob", "Bob", "pay 100 to X", bobKid);
        assertTrue(Verified.forward(fwd, List.of(real, fwd), bobKid, "Me"));
        // A forward of my own message, by someone else: verified.
        ChatMessage mine = msg("m5", "p-me", "Me", "pay 100 to X", "");
        mine.mine = true;
        ChatMessage fwdMe = msg("f2", "p-mallory", "Mallory", "pay 100 to X", malloryKid);
        fwdMe.forwardedFrom = "Me";
        assertTrue(Verified.forward(fwdMe, List.of(mine, fwdMe), "", "Me"));
    }

    /* ---------------------------------------------------------------- P10 */

    @Test
    public void p10_theReplayWindowFailsClosedOnAReadError() {
        P4Store.MemoryBackend backend = new P4Store.MemoryBackend();
        long now = System.currentTimeMillis();
        P4Store store = new P4Store(backend);
        Replay.MemoryStore window = store.replay(ROOM);
        new Replay.Guard(window, 0).check(ROOM, "m1", now, now, false);
        store.saveReplay(ROOM, window);
        // The stored window cannot be read (an error, not "absent"): a stand-in, not the stored one — the room accepts only
        // live chains; nothing is saved over the stored window.
        backend.failing = true;
        P4Store again = new P4Store(backend);
        Replay.MemoryStore standIn = again.replay(ROOM);
        assertFalse(P4Store.persistent(standIn));
        assertFalse(again.reloadReplay(ROOM, standIn));
        new Replay.Guard(standIn, 0).check(ROOM, "m2", now, now, false);
        again.saveReplay(ROOM, standIn);
        // Readable again: the stored ids join those accepted meanwhile, and the window is the stored one.
        backend.failing = false;
        assertTrue(again.reloadReplay(ROOM, standIn));
        assertTrue(P4Store.persistent(standIn));
        Replay.Guard g = new Replay.Guard(standIn, 0);
        assertEquals("replay", g.check(ROOM, "m1", now, now, false));
        assertEquals("replay", g.check(ROOM, "m2", now, now, false));
        again.saveReplay(ROOM, standIn);
        Replay.Guard after = new Replay.Guard(new P4Store(backend).replay(ROOM), 0);
        assertEquals("replay", after.check(ROOM, "m1", now, now, false));
        assertEquals("replay", after.check(ROOM, "m2", now, now, false));
    }

    /* ---------------------------------------------------------------- P14 */

    @Test
    public void p14_aHeldMessageNeverShowsThroughAQuoteOrANotification() throws Exception {
        ReplyQuote.Tr tr = k -> "[" + k + "]";
        ChatMessage held = msg("h1", "p-mallory", "Bob", "pay 100 to X", "k");
        held.changed = true;
        ChatMessage reply = msg("r1", "p-mallory2", "Mallory", "agreed", "k2");
        reply.replyToId = "h1";
        reply.replyToSender = "Bob";
        reply.replyToText = "pay 100 to X";
        // In the list (a relayed one before the fix), or held out of it: the quote says it is held, never the text.
        for (JSONObject q : new JSONObject[]{ReplyQuote.of(reply, held, tr), ReplyQuote.of(reply, null, true, tr)}) {
            assertNotNull(q);
            assertEquals("[quote.held]", q.getString("text"));
            assertEquals("held", q.getString("kind"));
            assertFalse(q.getBoolean("found"));
        }
        assertEquals("⚠", Rooms.notifyText(held));
        held.changed = false;
        assertEquals("pay 100 to X", Rooms.notifyText(held));
    }

    /* ---------------------------------------------------------------- P07 */

    @Test
    public void p07_aProxiedFilesKeyOpensFromItsSealedItemAndTheMetaWaitsForIt() throws Exception {
        long now = System.currentTimeMillis();
        // The sender (a 6.12 web peer) seals FK as a mailbox item to this device: payload {id: transferId, t: "fk", fk}.
        Certified sender = new Certified(0x0c, now), me = new Certified(0x0d, now);
        String tx = "xfer-1f0c8a2e-1111-4222-8333-944455556666";
        byte[] fk = new byte[32];
        fk[0] = 42;
        String payload = new JSONObject().put("id", tx).put("t", "fk").put("fk", Prim.b64(fk)).toString();
        JSONObject item = Mailbox.seal(ROOM, tx, payload, me.dev.publicKey, me.keys.bundle, sender.dev.publicKey, sender.acc, sender.keys, now, Rng.SYSTEM);
        Mailbox.MemoryStore mine = new Mailbox.MemoryStore();
        mine.put(me.keys);
        Mailbox.Opened o = new Mailbox(mine, P4Device.signer(me.dev), Rng.SYSTEM).open(item, ROOM, now);
        assertEquals(Prim.b64(fk), Prim.b64(ProxyKeys.fkOf(o, tx, sender.dev.publicKey)));
        assertEquals(Prim.b64(fk), Prim.b64(ProxyKeys.fkOf(o, tx, null))); // no hello of the sender seen here
        assertEquals(null, ProxyKeys.fkOf(o, "xfer-other", null)); // another transfer
        assertEquals(null, ProxyKeys.fkOf(o, tx, me.dev.publicKey)); // sealed by another device than the member's
        // With it, the transfer's frames open under the protocol-4 file key (§ 8).
        byte[] key = cz.m5cet.app.p4.Files4.fileKey(fk, tx);
        JSONObject meta = cz.m5cet.app.p4.Files4.sealBody(key, cz.m5cet.app.p4.Files4.metaAad(tx), "{\"transferId\":\"" + tx + "\"}", Rng.SYSTEM);
        assertTrue(cz.m5cet.app.p4.Files4.openBody(key, cz.m5cet.app.p4.Files4.metaAad(tx), meta.getString("iv"), meta.getString("ciphertext")).contains(tx));

        // The meta came first: it waits, the later frames queue behind it; the key from the sender releases them in order.
        ProxyKeys keys = new ProxyKeys();
        JSONObject metaFrame = new JSONObject().put("kind", "proxy-meta").put("transferId", tx).put("v", 4).put("from", "p-sender");
        assertNotNull(keys.park("p-sender", tx, metaFrame));
        assertEquals(null, keys.park("p-sender", tx, metaFrame)); // one at a time
        assertEquals(null, keys.park("", "xfer-2", metaFrame)); // no sender: refused
        JSONObject chunk = new JSONObject().put("kind", "proxy-chunk").put("transferId", tx).put("seq", 0);
        byte[] binary = new byte[]{0x4D, 0x11};
        assertTrue(keys.queue(tx, chunk));
        assertTrue(keys.queue(tx, binary));
        assertFalse(keys.queue("xfer-other", chunk));
        assertEquals(null, keys.put("p-mallory", tx, new byte[32], "x")); // another sender's key does not release it
        List<Object> frames = keys.put("p-sender", tx, fk.clone(), sender.dev.publicKey);
        assertEquals(3, frames.size());
        assertEquals(metaFrame, frames.get(0));
        assertEquals(chunk, frames.get(1));
        assertEquals(binary, frames.get(2));
        assertFalse(keys.isWaiting(tx));
        ProxyKeys.Key k = keys.take("p-sender", tx);
        assertEquals(sender.dev.publicKey, k.spk);
        assertEquals(null, keys.take("p-sender", tx)); // used once
        // No key in time: dropped.
        ProxyKeys.Waiting w = keys.park("p-sender", "xfer-late", metaFrame);
        assertTrue(keys.expire("xfer-late", w));
        assertFalse(keys.expire("xfer-late", w));
        assertFalse(keys.queue("xfer-late", chunk));
    }

    /* ---------------------------------------------------------------- S14 */

    @Test
    public void s14_aSquattedRoomIsJoinedWithoutTheProofUnlessProofsAreRequired() {
        // § 13: only when the refusal says legacyAllowed: true (either code), once per socket.
        assertEquals("legacy", RoomSession.proofRefusal("room-proof", Boolean.TRUE, false));
        assertEquals("legacy", RoomSession.proofRefusal("room-proof-required", Boolean.TRUE, false));
        assertEquals("refuse", RoomSession.proofRefusal("room-proof", null, false)); // a server that does not say
        assertEquals("refuse", RoomSession.proofRefusal("room-proof", Boolean.FALSE, false));
        assertEquals("refuse", RoomSession.proofRefusal("room-proof", Boolean.TRUE, true));
        assertEquals("refuse", RoomSession.proofRefusal("room-proof-required", Boolean.FALSE, false));
        assertEquals("", RoomSession.proofRefusal("room-full", null, false));
    }
}
