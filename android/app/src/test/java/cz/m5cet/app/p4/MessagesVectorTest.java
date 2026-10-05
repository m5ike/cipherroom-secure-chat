package cz.m5cet.app.p4;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** test/vectors/p4.json "senderKey", "mailbox", "files", "media". */
public class MessagesVectorTest {

    @Test
    public void senderKeyChainWithCertAndMessages() throws Exception {
        JSONObject V = Vectors.get();
        JSONObject S = V.getJSONObject("senderKey"), hs = V.getJSONObject("handshake");
        assertEquals(hs.getJSONObject("A").getString("peerId"), S.getString("owner"));
        assertEquals(hs.getJSONObject("A").getString("pk"), S.getString("ownerPk"));
        String roomId = S.getString("roomId");
        SenderKeys4 alice = new SenderKeys4(roomId, S.getString("ownerPk"), new Rng.Tape(S.getJSONArray("tape")));
        assertTrue(alice.prepare(1_800_000_000_000L));
        JSONObject chain = alice.chainFor(hs.getJSONObject("B").getString("peerId"));
        JSONObject expected = S.getJSONObject("chain");
        Vectors.assertJson("chain", Vectors.without(expected, "cert"), Vectors.without(chain, "cert")); // the cert is ECDSA: randomized
        assertEquals(S.getString("certSignedData"), Vectors.text(SenderKeys4.certData(roomId, expected.getString("keyId"), S.getString("ownerPk"))));
        assertTrue(Prim.ecdsaVerify(expected.getString("spk"), Prim.utf8(S.getString("certSignedData")), expected.getString("cert")));
        assertTrue(Prim.ecdsaVerify(expected.getString("spk"), Prim.utf8(S.getString("certSignedData")), chain.getString("cert")));
        JSONArray messages = S.getJSONArray("messages");
        for (int i = 0; i < messages.length(); i++) {
            JSONObject m = messages.getJSONObject(i);
            JSONObject env = alice.seal(m.getJSONObject("payload").getString("id"), m.getString("json"));
            Vectors.assertJson("message " + i, Vectors.without(m.getJSONObject("envelope"), "s"), Vectors.without(env, "s"));
            assertEquals(m.getString("aad"), Vectors.text(SenderKeys4.aad(roomId, env.getString("id"), env.getString("sk"), env.getLong("n"))));
        }
        SenderKeys4 bob = new SenderKeys4(roomId, hs.getJSONObject("B").getString("pk"), null);
        assertFalse(bob.acceptChain(S.getString("owner"), hs.getJSONObject("B").getString("pk"), expected)); // names A's device, not B's
        assertTrue(bob.acceptChain(S.getString("owner"), S.getString("ownerPk"), expected));
        for (int i : new int[]{3, 0, 2, 1}) {
            JSONObject m = messages.getJSONObject(i);
            Vectors.assertJson("open " + i, m.getJSONObject("payload"), bob.open(S.getString("owner"), m.getJSONObject("envelope")));
        }
        // The chain A hands to B in the ratchet script is this one.
        JSONArray script = V.getJSONObject("ratchet").getJSONArray("script");
        JSONObject sent = null;
        for (int i = 0; i < script.length(); i++) {
            JSONObject s = script.getJSONObject(i);
            if ("send".equals(s.getString("op")) && "sk".equals(s.getJSONObject("inner").getString("t"))) sent = s;
        }
        assertNotNull(sent);
        assertEquals("A", sent.getString("by"));
        Vectors.assertJson("sk in script", expected, sent.getJSONObject("inner"));
    }

    @Test
    public void senderKeyRefusals() throws Exception {
        JSONObject V = Vectors.get();
        JSONObject S = V.getJSONObject("senderKey");
        String roomId = S.getString("roomId"), owner = S.getString("owner"), ownerPk = S.getString("ownerPk");
        JSONObject chain = S.getJSONObject("chain");
        JSONObject first = S.getJSONArray("messages").getJSONObject(0).getJSONObject("envelope");
        SenderKeys4 bob = new SenderKeys4(roomId, "x", null);
        try { bob.open(owner, first); throw new AssertionError(); } catch (P4Error e) { assertEquals("no-chain", e.code); }
        assertTrue(bob.acceptChain(owner, ownerPk, chain));
        // Another member re-announcing A's chain (same spk) under its own device is refused.
        assertFalse(bob.acceptChain("peer-mallory", ownerPk + "x", chain));
        assertFalse(bob.acceptChain("peer-mallory", ownerPk, new JSONObject(chain.toString()).put("cert", Prim.b64(new byte[64]))));
        // A chain is found by (sender, keyId): the same envelope from another peer has no chain.
        try { bob.open("peer-mallory", first); throw new AssertionError(); } catch (P4Error e) { assertEquals("no-chain", e.code); }
        // A forged signature is refused BEFORE the chain moves; the real message still opens afterwards.
        JSONObject forged = new JSONObject(first.toString()).put("s", Prim.b64(new byte[64]));
        try { bob.open(owner, forged); throw new AssertionError(); } catch (P4Error e) { assertEquals("signature", e.code); }
        JSONObject tampered = new JSONObject(first.toString()).put("id", "sk-msg-x");
        try { bob.open(owner, tampered); throw new AssertionError(); } catch (P4Error e) { assertEquals("signature", e.code); }
        assertNotNull(bob.open(owner, first));
        try { bob.open(owner, first); throw new AssertionError(); } catch (P4Error e) { assertEquals("replay", e.code); }
    }

    @Test
    public void mailboxOpensAndResealsIdentically() throws Exception {
        JSONObject M = Vectors.get().getJSONObject("mailbox");
        long now = M.getLong("now");
        Mailbox.Keys rKeys = keysOf(M.getJSONObject("recipient"), now);
        Mailbox.Keys sKeys = keysOf(M.getJSONObject("sender"), now);
        JSONObject item = M.getJSONObject("item");
        Mailbox.Opened opened = Mailbox.open(item, M.getString("roomId"), rKeys);
        Vectors.assertJson("payload", M.getJSONObject("payload"), opened.payload);
        assertEquals(M.getJSONObject("sender").getString("pk"), opened.spk);
        assertNull(opened.sacc);
        assertEquals(M.getString("aad"), Vectors.text(Mailbox.aad(M.getString("roomId"), item.getString("id"), item.getString("spk"), item.getJSONObject("sb").getString("id"),
            item.getString("to"), item.getString("e"), Prim.hB64(Prim.unb64(item.getString("kct"))))));
        JSONObject again = Mailbox.seal(M.getString("roomId"), M.getJSONObject("payload").getString("id"), M.getString("json"), M.getJSONObject("recipient").getString("pk"),
            Mailbox.Bundle.parse(M.getJSONObject("recipient").getJSONObject("bundle")), M.getJSONObject("sender").getString("pk"), null, sKeys, now, new Rng.Tape(M.getJSONArray("sealTape")));
        Vectors.assertJson("resealed item", item, again);
        // Through a Mailbox (store of own bundles): an item, a set, another device's item, another room.
        Mailbox.MemoryStore store = new Mailbox.MemoryStore();
        store.put(rKeys);
        Mailbox box = new Mailbox(store, HandshakeRatchetVectorTest.signerOf(M.getJSONObject("recipient").getString("devicePkcs8"), M.getJSONObject("recipient").getString("pk")), null);
        assertNotNull(box.open(item, M.getString("roomId"), now));
        JSONObject other = new JSONObject(item.toString()).put("to", "AAAAAAAAAAA");
        java.util.List<JSONObject> both = new java.util.ArrayList<>();
        both.add(other);
        both.add(item);
        Vectors.assertJson("set", M.getJSONObject("payload"), box.open(Mailbox.set(item.getString("id"), both), M.getString("roomId"), now).payload);
        assertNull(box.open(other, M.getString("roomId"), now));
        try { box.open(item, "r3.another", now); throw new AssertionError(); } catch (P4Error e) { assertEquals("aead", e.code); }
        try { box.open(item, M.getString("roomId"), rKeys.bundle.exp + P4.MAILBOX_KEEP_MS); throw new AssertionError(); } catch (P4Error e) { assertEquals("wiped", e.code); }
        // The stored form of a bundle's keys round-trips (the vault keeps it so).
        Mailbox.Keys back = Mailbox.Keys.parse(rKeys.json());
        assertNotNull(Mailbox.open(item, M.getString("roomId"), back));
    }

    private static Mailbox.Keys keysOf(JSONObject side, long now) throws Exception {
        Mailbox.Keys rebuilt = Mailbox.createBundle(HandshakeRatchetVectorTest.signerOf(side.getString("devicePkcs8"), side.getString("pk")), now, new Rng.Tape(side.getJSONArray("bundleTape")));
        Vectors.assertJson("bundle", Vectors.without(side.getJSONObject("bundle"), "sig"), Vectors.without(rebuilt.bundle.json(), "sig"));
        assertNull(Mailbox.check(side.getJSONObject("bundle"), side.getString("pk"), now));
        return new Mailbox.Keys(Mailbox.Bundle.parse(side.getJSONObject("bundle")), rebuilt.dh, rebuilt.kemDk, rebuilt.created);
    }

    @Test
    public void filesAndMedia() throws Exception {
        JSONObject V = Vectors.get();
        JSONObject F = V.getJSONObject("files");
        String tx = F.getString("transferId");
        byte[] key = Files4.fileKey(Prim.unb64(F.getString("fk")), tx);
        assertEquals(F.getString("fileKey"), Prim.b64(key));
        assertEquals(F.getJSONObject("aad").getString("meta"), Vectors.text(Files4.metaAad(tx)));
        assertEquals(F.getJSONObject("aad").getString("chunk"), Vectors.text(Files4.chunkAad(tx, 3, 10)));
        assertEquals(F.getJSONObject("aad").getString("end"), Vectors.text(Files4.endAad(tx)));
        JSONObject meta = F.getJSONObject("meta");
        assertEquals(meta.getString("text"), Files4.openBody(key, Files4.metaAad(tx), meta.getString("iv"), meta.getString("ciphertext")));
        JSONArray ivTape = new JSONArray().put(new JSONObject().put("what", "file.iv").put("bytes", meta.getString("iv")));
        JSONObject resealed = Files4.sealBody(key, Files4.metaAad(tx), meta.getString("text"), new Rng.Tape(ivTape));
        assertEquals(meta.getString("iv"), resealed.getString("iv"));
        assertEquals(meta.getString("ciphertext"), resealed.getString("ciphertext"));
        try { Files4.openBody(key, Files4.endAad(tx), meta.getString("iv"), meta.getString("ciphertext")); throw new AssertionError(); } catch (P4Error e) { assertEquals("aead", e.code); }

        JSONObject media = V.getJSONObject("media");
        JSONArray ivs = media.getJSONArray("ivs");
        for (int i = 0; i < ivs.length(); i++) {
            JSONObject c = ivs.getJSONObject(i);
            assertEquals(c.getString("iv"), Prim.hex(Media4.frameIv(c.getLong("epoch"), c.getLong("counter"))));
        }
        JSONObject f = media.getJSONObject("frame");
        byte[] mk = Prim.unb64(f.getString("key"));
        byte[] sealed = Media4.sealFrame(mk, Prim.unb64(f.getString("in")), f.getInt("clear"), Media4.frameIv(f.getLong("epoch"), f.getLong("counter")));
        assertEquals(f.getString("out"), Prim.b64(sealed));
        assertEquals(f.getString("in"), Prim.b64(Media4.openFrame(mk, Prim.unb64(f.getString("out")))));
    }
}
