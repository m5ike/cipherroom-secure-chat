package cz.m5cet.app.p4;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Random;

/** Java↔Java sessions with real randomness: handshakes, out-of-order ratchets, resets, tampering. */
public class RoundTripTest {
    static final String ROOM = "r3.roundTripRoom", CHECK = "0123456789abcdef";

    static final class Dev {
        final Prim.P256 sign = Prim.generateP256();
        final Prim.P256 dh = Prim.generateP256();
        final String peerId;
        Dev(String peerId) { this.peerId = peerId; }
        Prim.DeviceSigner signer() { return Prim.signer(sign.privateKey, sign.spki); }
        JSONObject v3() throws Exception {
            return new JSONObject().put("kind", "hello").put("v", 3).put("check", CHECK).put("pk", sign.spki).put("dh", dh.spki).put("sig", Prim.b64(new byte[64])).put("caps", new JSONArray().put("bin"));
        }
    }

    /** Both sides' sessions after a full exchange (hello, KEM message each way). */
    static Handshake.Session[] pair(Dev a, Dev b) throws Exception {
        Handshake.Pair ha = Handshake.Pair.start(ROOM, CHECK, a.peerId, b.peerId, a.v3(), a.signer(), null, null, null, null);
        Handshake.Pair hb = Handshake.Pair.start(ROOM, CHECK, b.peerId, a.peerId, b.v3(), b.signer(), null, null, null, null);
        assertTrue(ha.acceptHello(hb.hello, System.currentTimeMillis()).ok);
        assertTrue(hb.acceptHello(ha.hello, System.currentTimeMillis()).ok);
        assertTrue(ha.acceptKem(hb.kem));
        assertTrue(hb.acceptKem(ha.kem));
        Handshake.Session sa = ha.establish(), sb = hb.establish();
        assertEquals(Prim.b64(sa.th), Prim.b64(sb.th));
        assertEquals(Prim.b64(sa.sid), Prim.b64(sb.sid));
        assertTrue(!sa.role.equals(sb.role));
        return new Handshake.Session[]{sa, sb};
    }

    static String msg(String id, String text) throws Exception {
        return new JSONObject().put("t", "msg").put("id", id).put("p", new JSONObject().put("id", id).put("kind", "text").put("text", text).put("createdAt", 1)).toString();
    }

    @Test
    public void conversationInBothDirectionsOutOfOrder() throws Exception {
        Dev a = new Dev("peer-a"), b = new Dev("peer-b");
        Handshake.Session[] s = pair(a, b);
        Ratchet ra = s[0].ratchet, rb = s[1].ratchet;
        Random rnd = new Random(7);
        int kemSteps = 0;
        for (int round = 0; round < 12; round++) {
            Ratchet from = round % 2 == 0 ? ra : rb, to = round % 2 == 0 ? rb : ra;
            List<JSONObject> frames = new ArrayList<>();
            int n = 1 + rnd.nextInt(5);
            for (int i = 0; i < n; i++) frames.add(from.encrypt(msg("m" + round + "-" + i, "round " + round + " #" + i + " ✓")));
            for (JSONObject f : frames) if (f.getJSONObject("h").has("kct")) kemSteps++;
            // The channel is ordered (§ 1); within a chain the skipped keys cope with gaps after its first
            // frame — the first (n = 0) carries the KEM ciphertext the chain's root key needs.
            Collections.shuffle(frames.subList(1, frames.size()), rnd);
            for (JSONObject f : frames) {
                Ratchet.Result r = to.decrypt(f);
                assertTrue(r.message, r.ok);
                assertEquals("msg", r.inner.getString("t"));
            }
        }
        assertTrue("the KEM ratchet ran", kemSteps >= 8);
    }

    @Test
    public void bothSidesSendAtOnceFromTheStart() throws Exception {
        Handshake.Session[] s = pair(new Dev("peer-x"), new Dev("peer-y"));
        JSONObject f1 = s[0].ratchet.encrypt(msg("x1", "hi"));
        JSONObject f2 = s[1].ratchet.encrypt(msg("y1", "hey"));
        assertTrue(s[1].ratchet.decrypt(f1).ok);
        assertTrue(s[0].ratchet.decrypt(f2).ok);
    }

    @Test
    public void tamperedFramesChangeNothingAndTheSecondFailureResets() throws Exception {
        Handshake.Session[] s = pair(new Dev("peer-a"), new Dev("peer-b"));
        Ratchet sender = s[0].ratchet, receiver = s[1].ratchet;
        JSONObject good = sender.encrypt(msg("a1", "hello"));
        // Every header field is in the AAD; a changed ciphertext fails the AEAD.
        JSONObject badC = new JSONObject(good.toString());
        byte[] c = Prim.unb64(badC.getString("c"));
        c[3] ^= 1;
        badC.put("c", Prim.b64(c));
        Ratchet.Result r1 = receiver.decrypt(badC);
        assertFalse(r1.ok);
        assertEquals("aead", r1.error);
        assertFalse(r1.reset);
        // The state did not move: the real frame still opens.
        assertTrue(receiver.decrypt(good).ok);
        JSONObject badN = new JSONObject(good.toString());
        badN.getJSONObject("h").put("n", 5);
        Ratchet.Result r2 = receiver.decrypt(badN);
        assertFalse(r2.ok);
        assertTrue("second failure: reset", r2.reset);
        receiver.wipe();
        assertEquals("state", receiver.decrypt(good).error);
    }

    @Test
    public void undecapsulatableKemCiphertextResetsAtOnce() throws Exception {
        Handshake.Session[] s = pair(new Dev("peer-a"), new Dev("peer-b"));
        Ratchet a = s[0].ratchet, b = s[1].ratchet;
        // Exchange until a frame carries kct.
        JSONObject withKct = null;
        Ratchet receiver = null;
        for (int i = 0; i < 6 && withKct == null; i++) {
            Ratchet from = i % 2 == 0 ? a : b, to = i % 2 == 0 ? b : a;
            JSONObject f = from.encrypt(msg("k" + i, "x"));
            if (f.getJSONObject("h").has("kct")) { withKct = f; receiver = to; }
            else assertTrue(to.decrypt(f).ok);
        }
        assertNotNull(withKct);
        JSONObject bad = new JSONObject(withKct.toString());
        bad.getJSONObject("h").put("kid", "AAAAAAAAAAAAAAAA"); // a kid this side never announced
        Ratchet.Result r = receiver.decrypt(bad);
        assertEquals("kct", r.error);
        assertTrue("a kct that cannot be decapsulated resets at once", r.reset);
        // The real frame still opens (nothing was committed).
        assertTrue(receiver.decrypt(withKct).ok);
    }

    @Test
    public void tooManySkippedKeysFail() throws Exception {
        Handshake.Session[] s = pair(new Dev("peer-a"), new Dev("peer-b"));
        JSONObject f = s[0].ratchet.encrypt(msg("a", "x"));
        f.getJSONObject("h").put("n", P4.MAX_SKIP + 1);
        assertEquals("skip", s[1].ratchet.decrypt(f).error);
    }

    @Test
    public void downgradedHelloIsNotV4() throws Exception {
        Dev a = new Dev("peer-a"), b = new Dev("peer-b");
        Handshake.Pair ha = Handshake.Pair.start(ROOM, CHECK, a.peerId, b.peerId, a.v3(), a.signer(), null, null, null, null);
        JSONObject stripped = new JSONObject(ha.hello.toString()).put("v", 3);
        assertEquals("not-v4", Handshake.verifyHello(stripped, ROOM, a.peerId, b.peerId, CHECK, 0).why);
        JSONObject swapped = new JSONObject(ha.hello.toString()).put("e", Prim.generateP256().spki);
        assertEquals("bad-sig4", Handshake.verifyHello(swapped, ROOM, a.peerId, b.peerId, CHECK, 0).why);
        JSONObject badK = new JSONObject(ha.hello.toString()).put("k", Prim.b64(new byte[10]));
        assertEquals("malformed", Handshake.verifyHello(badK, ROOM, a.peerId, b.peerId, CHECK, 0).why);
        JSONObject noMb = new JSONObject(ha.hello.toString());
        noMb.remove("mb");
        assertEquals("malformed", Handshake.verifyHello(noMb, ROOM, a.peerId, b.peerId, CHECK, 0).why);
    }

    @Test
    public void helloCarriesAValidBundleAndAccount() throws Exception {
        Dev a = new Dev("peer-a"), b = new Dev("peer-b");
        long now = System.currentTimeMillis();
        Mailbox.Keys bundle = Mailbox.createBundle(a.signer(), now, Rng.SYSTEM);
        byte[] accountSeed = new byte[32];
        accountSeed[0] = 9;
        JSONObject cert = Handshake.certifyDeviceV2(accountSeed, a.sign.spki, now + 1000, now);
        JSONObject acc = new JSONObject().put("apk", Prim.b64(Prim.ed25519Public(accountSeed))).put("ac", cert.getString("sig")).put("cv", 2).put("exp", cert.getLong("exp"));
        Handshake.Pair ha = Handshake.Pair.start(ROOM, CHECK, a.peerId, b.peerId, a.v3(), a.signer(), bundle.bundle.json(), acc, null, null);
        Handshake.Verdict v = Handshake.verifyHello(ha.hello, ROOM, a.peerId, b.peerId, CHECK, now);
        assertTrue(v.ok);
        assertEquals(bundle.bundle, v.mailbox);
        assertTrue(Handshake.verifyAccount(v.hello.opt("acc"), a.sign.spki, now).valid);
        // A bundle signed by another device is ignored, the hello stands.
        Mailbox.Keys foreign = Mailbox.createBundle(b.signer(), now, Rng.SYSTEM);
        Handshake.Pair hf = Handshake.Pair.start(ROOM, CHECK, a.peerId, b.peerId, a.v3(), a.signer(), foreign.bundle.json(), null, null, null);
        Handshake.Verdict vf = Handshake.verifyHello(hf.hello, ROOM, a.peerId, b.peerId, CHECK, now);
        assertTrue(vf.ok);
        assertNull(vf.mailbox);
        assertEquals("bad-signature", vf.mailboxProblem);
    }

    @Test
    public void senderKeysRoundTripAndRotation() throws Exception {
        SenderKeys4 alice = new SenderKeys4(ROOM, "pk-alice", null);
        SenderKeys4 bob = new SenderKeys4(ROOM, "pk-bob", null);
        // pk strings are only named in the cert: any ASCII works here.
        assertTrue(alice.prepare(0));
        assertTrue(bob.acceptChain("alice", "pk-alice", alice.chainFor("bob")));
        List<JSONObject> sent = new ArrayList<>();
        for (int i = 0; i < 5; i++) sent.add(alice.seal("m" + i, new JSONObject().put("id", "m" + i).put("text", "x" + i).toString()));
        Collections.reverse(sent);
        for (JSONObject e : sent) assertNotNull(bob.open("alice", e));
        assertFalse(alice.prepare(1));
        assertTrue(alice.due(P4.SENDER_KEY_ROTATE_MS));
        String old = alice.currentKeyId();
        assertTrue(alice.prepare(P4.SENDER_KEY_ROTATE_MS));
        assertTrue(!old.equals(alice.currentKeyId()));
        assertFalse(alice.hasOurChain("bob"));
        try { alice.seal("x", "{\"id\":\"y\"}"); throw new AssertionError(); } catch (P4Error e) { assertEquals("id-mismatch", e.code); }
    }

    @Test
    public void mailboxMaintenanceRenewsAndWipes() throws Exception {
        Dev a = new Dev("peer-a"), r = new Dev("peer-r");
        Mailbox.MemoryStore store = new Mailbox.MemoryStore();
        Mailbox box = new Mailbox(store, a.signer(), null);
        long t0 = 1_800_000_000_000L;
        assertNotNull(box.maintain(t0, null));
        assertNull(box.maintain(t0 + 1000, null));
        Mailbox.Bundle first = box.current(t0).bundle;
        Mailbox.Bundle second = box.current(t0 + P4.MAILBOX_LIFETIME_MS - P4.MAILBOX_RENEW_BEFORE_MS).bundle;
        assertTrue(!first.id.equals(second.id));
        List<String> wiped = new ArrayList<>();
        box.maintain(first.exp + P4.MAILBOX_KEEP_MS, wiped);
        assertTrue(wiped.contains(first.id));
        // Seal to a recipient and open with its mailbox.
        Mailbox.MemoryStore rs = new Mailbox.MemoryStore();
        Mailbox rbox = new Mailbox(rs, r.signer(), null);
        Mailbox.Bundle rb = rbox.current(t0).bundle;
        JSONObject item = box.seal(ROOM, "id-1", "{\"id\":\"id-1\",\"text\":\"hi\"}", r.sign.spki, rb, null, t0);
        Mailbox.Opened o = rbox.open(item, ROOM, t0 + 1);
        assertEquals("hi", o.payload.getString("text"));
        assertEquals(a.sign.spki, o.spk);
        // A recipient bundle not signed by the recipient's key is refused.
        try { box.seal(ROOM, "id-2", "{\"id\":\"id-2\"}", a.sign.spki, rb, null, t0); throw new AssertionError(); } catch (P4Error e) { assertEquals("signature", e.code); }
        // A changed item does not open.
        JSONObject bad = new JSONObject(item.toString()).put("id", "id-x");
        try { rbox.open(bad, ROOM, t0 + 1); throw new AssertionError(); } catch (P4Error e) { assertEquals("aead", e.code); }
    }

    @Test
    public void filesRoundTrip() throws Exception {
        JSONObject inner = Files4.newFileKey("tx-9", Rng.SYSTEM);
        byte[] key = Files4.fileKey(inner.getString("key"), "tx-9");
        JSONObject meta = Files4.sealBody(key, Files4.metaAad("tx-9"), "{\"name\":\"a.txt\"}", Rng.SYSTEM);
        assertEquals("{\"name\":\"a.txt\"}", Files4.openBody(key, Files4.metaAad("tx-9"), meta.getString("iv"), meta.getString("ciphertext")));
        byte[][] chunk = Files4.sealChunk(key, Files4.chunkAad("tx-9", 0, 1), new byte[]{1, 2, 3}, Rng.SYSTEM);
        assertEquals(3, Files4.openChunk(key, Files4.chunkAad("tx-9", 0, 1), chunk[0], chunk[1]).length);
        try { Files4.openChunk(key, Files4.chunkAad("tx-9", 1, 2), chunk[0], chunk[1]); throw new AssertionError(); } catch (P4Error e) { assertEquals("aead", e.code); }
        try { Files4.newFileKey("bad|id", Rng.SYSTEM); throw new AssertionError(); } catch (P4Error e) { assertEquals("malformed", e.code); }
    }

    @Test
    public void p256PublicKeysAreStrict() {
        Prim.P256 k = Prim.generateP256();
        assertTrue(Prim.isP256Spki(k.spki));
        byte[] der = java.util.Base64.getDecoder().decode(k.spki);
        der[90] ^= 1; // off the curve
        assertFalse(Prim.isP256Spki(Prim.b64(der)));
        assertFalse(Prim.isP256Spki("AAAA"));
        assertFalse(Prim.ecdsaVerify(k.spki, new byte[]{1}, Prim.b64(new byte[64])));
    }
}
