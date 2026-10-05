package cz.m5cet.app.chat;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.security.GeneralSecurityException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import cz.m5cet.app.account.Account;
import cz.m5cet.app.p4.Handshake;
import cz.m5cet.app.p4.HubProof;
import cz.m5cet.app.p4.Mailbox;
import cz.m5cet.app.p4.P4;
import cz.m5cet.app.p4.Prim;
import cz.m5cet.app.p4.Replay;
import cz.m5cet.app.p4.Rng;
import cz.m5cet.app.security.Ec;

/** 6.12: the app's side of protocol 4 — trust states, pins, the relay frame, the hub proof, the account key, the stores. */
public class P4IntegrationTest {

    @Test
    public void trustStates() {
        // § 12.1: a first-seen key is new, never verified.
        assertEquals(Trust.NEW, Trust.of(false, null, "new", false, false, false));
        assertEquals(Trust.NEW, Trust.of(false, null, "match", false, false, false));
        assertEquals(Trust.VERIFIED, Trust.of(false, null, "match", true, false, false));
        assertEquals(Trust.CHANGED, Trust.of(false, null, "changed", true, false, false));
        // An attested device: its account decides; a new device of a known account is fine.
        assertEquals(Trust.ACCOUNT, Trust.of(true, "new", "new", false, false, false));
        assertEquals(Trust.ACCOUNT, Trust.of(true, "match", "changed", false, false, false));
        assertEquals(Trust.VERIFIED, Trust.of(true, "match", "match", false, true, false));
        assertEquals(Trust.CHANGED, Trust.of(true, "changed", "match", true, true, false));
        assertEquals(Trust.CHANGED, Trust.of(true, "new", "changed", false, false, false));
        // Key transparency shows the device revoked (or the account key replaced).
        assertEquals(Trust.CHANGED, Trust.of(true, "match", "match", true, true, true));
    }

    @Test
    public void accountPinsAcrossRooms() {
        P4Store store = new P4Store(new P4Store.MemoryBackend());
        String apk1 = Prim.b64(new byte[32]), apk2 = Prim.b64(Prim.H(new byte[]{1}));
        String d1 = Prim.generateP256().spki, d2 = Prim.generateP256().spki;
        assertEquals("new", store.pinAccount(apk1, d1, "Alice"));
        assertEquals("match", store.pinAccount(apk1, d2, "alice")); // a new device of the same account
        assertEquals("changed", store.pinAccount(apk2, d1, "alice")); // another account key under that username
        assertFalse(store.accountAllowed(apk2, "alice"));
        assertTrue(store.accountAllowed(apk1, "alice"));
        assertTrue(store.accountAllowed(apk2, "bob"));
        assertFalse(store.accountVerified(apk1));
        store.setAccountVerified(apk1, true);
        assertTrue(store.accountVerified(apk1));
        store.acceptAccount(apk2, d1, "alice");
        assertEquals("match", store.pinAccount(apk2, d1, "alice"));
        assertTrue(store.accountAllowed(apk2, "alice"));
    }

    @Test
    public void downgradeMarkAndBundlesPersist() throws Exception {
        P4Store.MemoryBackend backend = new P4Store.MemoryBackend();
        P4Store store = new P4Store(backend);
        ChatIdentity peer = ChatIdentity.generate();
        assertFalse(store.p4Seen(peer.publicKey));
        store.markP4(peer.publicKey);
        long now = System.currentTimeMillis();
        Mailbox.Keys b = Mailbox.createBundle(P4Device.signer(peer), now, Rng.SYSTEM);
        store.rememberBundle(peer.publicKey, b.bundle, "ref-1");
        // A new store over the same backend (the app restarted) remembers both.
        P4Store again = new P4Store(backend);
        assertTrue(again.p4Seen(peer.publicKey));
        assertEquals(1, again.bundlesOfRef("ref-1", now).size());
        assertEquals(0, again.bundlesOfRef("ref-1", b.bundle.exp).size());
        // The own mailbox's keys survive too (they live in the vault).
        Mailbox mine = new Mailbox(store.mailbox(), P4Device.signer(peer), Rng.SYSTEM);
        String id = mine.current(now).bundle.id;
        assertEquals(id, new Mailbox(new P4Store(backend).mailbox(), P4Device.signer(peer), Rng.SYSTEM).current(now).bundle.id);
    }

    @Test
    public void replayWindowPersists() {
        P4Store.MemoryBackend backend = new P4Store.MemoryBackend();
        P4Store store = new P4Store(backend);
        long now = System.currentTimeMillis();
        Replay.MemoryStore window = store.replay("r3.room");
        Replay.Guard g = new Replay.Guard(window, 0);
        assertEquals("ok", g.check("r3.room", "m1", now, now, false));
        store.saveReplay("r3.room", window);
        Replay.Guard after = new Replay.Guard(new P4Store(backend).replay("r3.room"), 0);
        assertEquals("replay", after.check("r3.room", "m1", now, now, false));
        assertEquals("ok", after.check("r3.room", "m2", now, now, false));
        // An older peer's message: replay only, its clock is not held against it.
        assertEquals("ok", after.checkId("r3.room", "m3", now));
        assertEquals("replay", after.checkId("r3.room", "m3", now));
        assertEquals("replay", after.checkId("r3.room", "m1", now));
        // The stored form holds no readable id.
        assertFalse(backend.get(P4Store.replayName("r3.room")).toString().contains("m1"));
    }

    @Test
    public void relayFrameSealsPerDeviceAndFallsBack() throws Exception {
        long now = System.currentTimeMillis();
        String roomId = "r3.relayRoom";
        ChatIdentity me = ChatIdentity.generate(), bob1 = ChatIdentity.generate(), bob2 = ChatIdentity.generate();
        byte[] seed = new byte[32];
        seed[5] = 3;
        String apk = Prim.b64(Prim.ed25519Public(seed));
        Mailbox.Keys k1 = Mailbox.createBundle(P4Device.signer(bob1), now, Rng.SYSTEM), k2 = Mailbox.createBundle(P4Device.signer(bob2), now, Rng.SYSTEM);
        JSONArray devices = new JSONArray()
            .put(directoryDevice(bob1.publicKey, apk, seed, k1.bundle, now))
            .put(directoryDevice(bob2.publicKey, apk, seed, k2.bundle, now))
            .put(directoryDevice(bob2.publicKey, apk, new byte[32], k2.bundle, now)); // a certificate by another key: dropped
        P4Relay relay = new P4Relay();
        assertTrue(relay.shouldAsk("ref-bob", now));
        assertFalse(relay.shouldAsk("ref-bob", now));
        relay.onKeyBundles(new JSONObject().put("type", "key-bundles").put("ref", "ref-bob").put("devices", devices), now, a -> true);
        assertTrue(relay.known("ref-bob", now));
        List<P4Relay.Device> bobs = relay.devices("ref-bob", null, now);
        assertEquals(2, bobs.size());
        Map<String, List<P4Relay.Device>> all = new HashMap<>();
        all.put("ref-bob", bobs);
        all.put("ref-carol", new ArrayList<>()); // no bundle known: the protocol-3 room envelope
        Mailbox box = new Mailbox(new Mailbox.MemoryStore(), P4Device.signer(me), Rng.SYSTEM);
        String json = new JSONObject().put("id", "msg-1").put("text", "for later").put("createdAt", now).toString();
        JSONObject roomEnv = new JSONObject().put("v", 3).put("id", "msg-1").put("iv", "x").put("ciphertext", "y");
        JSONObject frame = P4Relay.frame("msg-1", List.of("ref-bob", "ref-carol"), all, d -> box.seal(roomId, "msg-1", json, d.pk, d.bundle, null, now), () -> roomEnv, List.of("ref-carol"));
        assertEquals("relay", frame.getString("type"));
        assertEquals(2, frame.getJSONArray("to").length());
        JSONObject set = frame.getJSONObject("per").getJSONObject("ref-bob");
        assertEquals("mb-set", set.getString("kind"));
        assertEquals(2, set.getJSONArray("items").length());
        assertFalse(frame.getJSONObject("per").has("ref-carol"));
        assertEquals(roomEnv.toString(), frame.getJSONObject("envelope").toString());
        assertEquals("ref-carol", frame.getJSONArray("mention").getString(0));
        // Each of Bob's devices opens its own item of the set.
        Mailbox.MemoryStore s1 = new Mailbox.MemoryStore();
        s1.put(k1);
        Mailbox.Opened o = new Mailbox(s1, P4Device.signer(bob1), Rng.SYSTEM).open(set, roomId, now);
        assertEquals("for later", o.payload.getString("text"));
        assertEquals(me.publicKey, o.spk);
        // Without a room envelope, a recipient without its own is left out (the server would refuse the frame).
        JSONObject noFallback = P4Relay.frame("msg-1", List.of("ref-bob", "ref-carol"), all, d -> box.seal(roomId, "msg-1", json, d.pk, d.bundle, null, now), () -> null, null);
        assertEquals(1, noFallback.getJSONArray("to").length());
        assertFalse(noFallback.has("envelope"));
        // An account key the pins call "changed" is not sealed to.
        P4Relay pinned = new P4Relay();
        pinned.onKeyBundles(new JSONObject().put("ref", "ref-bob").put("devices", devices), now, a -> false);
        assertEquals(0, pinned.devices("ref-bob", null, now).size());
    }

    static JSONObject directoryDevice(String pk, String apk, byte[] seed, Mailbox.Bundle bundle, long now) throws Exception {
        long exp = now + P4.DEVICE_CERT_LIFETIME_MS - 1000;
        JSONObject cert = Handshake.certifyDeviceV2(seed, pk, exp, now);
        return new JSONObject().put("pk", pk).put("apk", apk).put("cert", cert).put("bundle", bundle.json());
    }

    @Test
    public void hubProofFromTheRoomKeys() throws Exception {
        RoomKeys keys = RoomKeys.derive("proof-room", "a passphrase", 64, 1);
        String nonce = Prim.b64url(new byte[24]);
        JSONObject proof = RoomSession.hubProof(keys, nonce);
        assertNotNull(proof);
        assertTrue(HubProof.verify(proof.getString("pub"), proof.getString("sig"), keys.roomId, nonce));
        // The same key in every member's app: derived from the room secret.
        assertEquals(proof.getString("pub"), RoomSession.hubProof(RoomKeys.derive("proof-room", "a passphrase", 64, 1), Prim.b64url(new byte[24])).getString("pub"));
        assertNull(RoomSession.hubProof(keys, ""));
    }

    @Test
    public void accountKeyIsTheWebsOne() {
        // client/src/lib/identity.ts accountSigningKey with the root bytes (i * 3 + 1) — computed with Node's WebCrypto.
        byte[] root = new byte[32];
        for (int i = 0; i < 32; i++) root[i] = (byte) (i * 3 + 1);
        byte[] seed = Account.accountSeedOf(root);
        assertEquals("yNIp/cOZHnL7VzZuTTBrZ3jAUMEv+MwMCyocab4D+1M=", Prim.b64(seed));
        try { assertEquals("WKVhp7dubTZvwu6+N52As3eDfiQanV4o9bnmFpe70WM=", Prim.b64(Prim.ed25519Public(seed))); }
        catch (Exception e) { fail(e.getMessage()); }
    }

    @Test
    public void oldEnvelopeVersionsAreNotOpened() {
        RoomKeys keys = RoomKeys.derive("v2-room", "pass", 64, 1);
        ChatIdentity me = ChatIdentity.generate();
        JSONObject v3 = Envelopes.sealMessage(keys, "id-1", jsonOf("id-1"), me);
        try { assertEquals("id-1", Envelopes.openMessage(keys, v3).payload.optString("id")); } catch (GeneralSecurityException e) { fail(e.getMessage()); }
        for (int v : new int[]{1, 2}) {
            try {
                JSONObject old = new JSONObject(v3.toString()).put("v", v);
                Envelopes.openMessage(keys, old);
                fail("version " + v + " opened");
            } catch (GeneralSecurityException expected) {
                // F-20
            } catch (Exception e) { fail(e.getMessage()); }
        }
    }

    @Test
    public void deviceCertificateV1VerifiesOnEveryAndroid() throws Exception {
        byte[] seed = new byte[32];
        seed[0] = 1;
        String apk = Prim.b64(Prim.ed25519Public(seed));
        String device = ChatIdentity.generate().publicKey;
        String cert = Prim.b64(Prim.ed25519Sign(seed, Prim.utf8("m5cet/device-cert/1|" + device)));
        assertTrue(Envelopes.verifyDeviceCert(apk, cert, device));
        assertFalse(Envelopes.verifyDeviceCert(apk, cert, ChatIdentity.generate().publicKey));
        assertEquals(16, Ec.kid(device).length());
    }

    @Test
    public void mentionsAndRoomEnvelopeShape() throws Exception {
        assertEquals(List.of("alice", "Bob_2"), RoomSession.mentionNames("hi @alice and @Bob_2!"));
        assertTrue(P4Room.isRoomEnvelope(new JSONObject().put("v", 4).put("id", "a").put("sk", "k").put("n", 0).put("c", "x").put("s", "y")));
        assertFalse(P4Room.isRoomEnvelope(new JSONObject().put("v", 3).put("id", "a").put("sk", "k").put("n", 0)));
        assertFalse(P4Room.isRoomEnvelope(new JSONObject().put("kind", "p4").put("v", 4).put("sk", "k").put("s", "y")));
    }

    private static JSONObject jsonOf(String id) {
        try { return new JSONObject().put("id", id).put("text", "x"); } catch (Exception e) { throw new AssertionError(e); }
    }
}
