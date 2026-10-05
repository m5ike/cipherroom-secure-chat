package cz.m5cet.app.p4;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/**
 * 6.12 security review, the wire changes (docs/protocol-v4.md § 2, § 7.2):
 * P02 — `sig4` also signs `caps`, `user` and `sth`, so a man in the middle
 * who knows the room key can no longer strip "media" or the gossiped tree
 * head; P13 — the mailbox AAD binds the sender's account attestation, so a
 * relay can neither strip nor swap `sacc`. (The byte-exact transcripts are
 * pinned by test/vectors/p4.json — HandshakeRatchetVectorTest, MessagesVectorTest.)
 */
public class Review612WireTest {
    static final String ROOM = "r3.review612Wire", CHECK = "00112233aabbccdd";

    static JSONObject v3(Prim.P256 dev, String user) throws Exception {
        JSONObject v3 = new JSONObject().put("check", CHECK).put("pk", dev.spki).put("dh", Prim.generateP256().spki).put("sig", "c2lnLXYz")
            .put("caps", new JSONArray().put("bin").put("media"));
        if (user != null) v3.put("user", user);
        return v3;
    }

    @Test
    public void p02_aHelloWhoseCapsUserOrTreeHeadChangedInTransitDoesNotVerify() throws Exception {
        Prim.P256 a = Prim.generateP256(), b = Prim.generateP256();
        byte[] ktSeed = new byte[32];
        ktSeed[0] = 0x17;
        JSONObject sth = Kt.signSth(ktSeed, 1, new byte[32], 1);
        long now = System.currentTimeMillis();
        Handshake.Pair hb = Handshake.Pair.start(ROOM, CHECK, "p-b", "p-a", v3(b, "bob"), Prim.signer(b.privateKey, b.spki), null, null, sth, null);
        // The untouched hello verifies (at A: from B to A).
        assertTrue(Handshake.verifyHello(hb.hello, ROOM, "p-b", "p-a", CHECK, now).ok);
        // "media" stripped from the caps, the tree head removed or replaced, the username changed: bad-sig4.
        JSONObject stripped = new JSONObject(hb.hello.toString()).put("caps", new JSONArray().put("bin").put("p4"));
        assertEquals("bad-sig4", Handshake.verifyHello(stripped, ROOM, "p-b", "p-a", CHECK, now).why);
        assertEquals("bad-sig4", Handshake.verifyHello(new JSONObject(hb.hello.toString()).put("sth", JSONObject.NULL), ROOM, "p-b", "p-a", CHECK, now).why);
        assertEquals("bad-sig4", Handshake.verifyHello(new JSONObject(hb.hello.toString()).put("sth", Kt.signSth(ktSeed, 2, new byte[32], 2)), ROOM, "p-b", "p-a", CHECK, now).why);
        assertEquals("bad-sig4", Handshake.verifyHello(new JSONObject(hb.hello.toString()).put("user", "mallory"), ROOM, "p-b", "p-a", CHECK, now).why);
        JSONObject noUser = new JSONObject(hb.hello.toString());
        noUser.remove("user");
        assertEquals("bad-sig4", Handshake.verifyHello(noUser, ROOM, "p-b", "p-a", CHECK, now).why);
        // The caps' order and repeats do not matter (sorted, duplicates removed); a non-string user is malformed.
        JSONObject reordered = new JSONObject(hb.hello.toString()).put("caps", new JSONArray().put("p4").put("media").put("bin").put("media"));
        assertTrue(Handshake.verifyHello(reordered, ROOM, "p-b", "p-a", CHECK, now).ok);
        assertEquals("malformed", Handshake.verifyHello(new JSONObject(hb.hello.toString()).put("user", 5), ROOM, "p-b", "p-a", CHECK, now).why);
        // A capability with "|" cannot be in a transcript: the hello is malformed.
        assertEquals("malformed", Handshake.verifyHello(new JSONObject(hb.hello.toString()).put("caps", new JSONArray().put("a|b")), ROOM, "p-b", "p-a", CHECK, now).why);
        // The digests (§ 2).
        assertEquals(Prim.hB64(new byte[0]), Handshake.capsDigest(new JSONArray()));
        assertEquals(Prim.hB64(Prim.utf8("bin|media|p4")), Handshake.capsDigest(new JSONArray().put("p4").put("bin").put("media").put("bin")));
        assertEquals("-", Handshake.userDigest(null));
        assertEquals("-", Handshake.userDigest(JSONObject.NULL));
        assertEquals(Prim.hB64(Prim.utf8("bob")), Handshake.userDigest("bob"));
        assertEquals("-", Handshake.sthDigest(JSONObject.NULL));
        assertEquals(Prim.hB64(Prim.utf8("1|" + sth.getString("root") + "|1|" + sth.getString("sig"))), Handshake.sthDigest(sth));
        // A hello without a user and without a head still makes a session.
        Handshake.Pair ha = Handshake.Pair.start(ROOM, CHECK, "p-a", "p-b", v3(a, null), Prim.signer(a.privateKey, a.spki), null, null, null, null);
        assertTrue(Handshake.verifyHello(ha.hello, ROOM, "p-a", "p-b", CHECK, now).ok);
        assertTrue(hb.acceptHello(ha.hello, now).ok);
        assertTrue(ha.acceptHello(hb.hello, now).ok);
        assertTrue(ha.acceptKem(hb.kem));
        assertTrue(hb.acceptKem(ha.kem));
        assertNotEquals(null, ha.establish());
    }

    @Test
    public void p13_aRelayCannotStripOrSwapTheSendersAccountAttestation() throws Exception {
        long now = System.currentTimeMillis();
        Prim.P256 s = Prim.generateP256(), r = Prim.generateP256();
        Mailbox.Keys sKeys = Mailbox.createBundle(Prim.signer(s.privateKey, s.spki), now, Rng.SYSTEM);
        Mailbox.Keys rKeys = Mailbox.createBundle(Prim.signer(r.privateKey, r.spki), now, Rng.SYSTEM);
        byte[] seed = new byte[32];
        seed[1] = 5;
        long exp = now + P4.DEVICE_CERT_LIFETIME_MS - 1000;
        JSONObject cert = Handshake.certifyDeviceV2(seed, s.spki, exp, now);
        JSONObject sacc = new JSONObject().put("apk", Prim.b64(Prim.ed25519Public(seed))).put("ac", cert.getString("sig")).put("cv", 2).put("exp", exp);
        String json = new JSONObject().put("id", "m-1").put("text", "hi").toString();
        JSONObject item = Mailbox.seal(ROOM, "m-1", json, r.spki, rKeys.bundle, s.spki, sacc, sKeys, now, Rng.SYSTEM);
        Mailbox.Opened o = Mailbox.open(item, ROOM, rKeys);
        assertEquals(sacc.toString(), o.sacc.toString());
        // Stripped: the item does not open.
        JSONObject stripped = new JSONObject(item.toString());
        stripped.remove("sacc");
        try { Mailbox.open(stripped, ROOM, rKeys); fail("opened without its sacc"); } catch (P4Error e) { assertEquals("aead", e.code); }
        // Swapped for another account's attestation: neither.
        byte[] other = new byte[32];
        other[1] = 6;
        JSONObject swapped = new JSONObject(item.toString()).put("sacc", new JSONObject(sacc.toString()).put("apk", Prim.b64(Prim.ed25519Public(other))));
        try { Mailbox.open(swapped, ROOM, rKeys); fail("opened with another sacc"); } catch (P4Error e) { assertEquals("aead", e.code); }
        // Added to an item sealed without one: neither.
        JSONObject plain = Mailbox.seal(ROOM, "m-1", json, r.spki, rKeys.bundle, s.spki, null, sKeys, now, Rng.SYSTEM);
        assertEquals(null, Mailbox.open(plain, ROOM, rKeys).sacc);
        try { Mailbox.open(new JSONObject(plain.toString()).put("sacc", sacc), ROOM, rKeys); fail("opened with an added sacc"); } catch (P4Error e) { assertEquals("aead", e.code); }
    }
}
