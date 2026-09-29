package cz.m5cet.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.BeforeClass;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.GeneralSecurityException;
import java.security.PrivateKey;
import java.util.Map;

import cz.m5cet.app.chat.Argon2;
import cz.m5cet.app.chat.ChatIdentity;
import cz.m5cet.app.chat.Envelopes;
import cz.m5cet.app.chat.RoomKeys;
import cz.m5cet.app.chat.SenderKeys;
import cz.m5cet.app.security.Crypto;
import cz.m5cet.app.security.Ec;
import cz.m5cet.app.security.Ecies;
import cz.m5cet.app.update.BundleFile;

/**
 * The Java port against what the web client and the server really produce
 * (test/fixtures/android-interop.json, script/android-vectors.ts).
 */
public class InteropTest {
    static JSONObject v;
    static RoomKeys keys;

    public static Path fixtures() {
        Path p = Paths.get("").toAbsolutePath();
        for (int i = 0; i < 5 && p != null; i++, p = p.getParent()) {
            Path f = p.resolve("test").resolve("fixtures");
            if (Files.isDirectory(f)) return f;
        }
        throw new IllegalStateException("test/fixtures not found");
    }

    @BeforeClass
    public static void load() throws Exception {
        v = new JSONObject(new String(Files.readAllBytes(fixtures().resolve("android-interop.json")), StandardCharsets.UTF_8));
        JSONObject r = v.getJSONObject("room");
        keys = RoomKeys.derive(r.getString("room"), r.getString("passphrase"));
    }

    @Test
    public void argon2idMatchesRfc9106() throws Exception {
        byte[] p = new byte[32], s = new byte[16], k = new byte[8], x = new byte[12];
        java.util.Arrays.fill(p, (byte) 1); java.util.Arrays.fill(s, (byte) 2); java.util.Arrays.fill(k, (byte) 3); java.util.Arrays.fill(x, (byte) 4);
        byte[] tag = Argon2.argon2id(p, s, 3, 32, 4, 32, k, x);
        assertEquals("0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659", Crypto.hex(tag));
    }

    @Test
    public void argon2idMatchesHashWasm() throws Exception {
        JSONArray list = v.getJSONArray("argon2id");
        for (int i = 0; i < list.length(); i++) {
            JSONObject c = list.getJSONObject(i);
            byte[] tag = Argon2.argon2id(c.getString("password").getBytes(StandardCharsets.UTF_8), c.getString("salt").getBytes(StandardCharsets.UTF_8), c.getInt("t"), c.getInt("m"), c.getInt("p"), c.getInt("len"), null, null);
            assertEquals(c.getString("password"), c.getString("hex"), Crypto.hex(tag));
        }
    }

    @Test
    public void roomKeysMatchTheWeb() throws Exception {
        JSONObject r = v.getJSONObject("room");
        assertEquals(r.getString("room"), RoomKeys.normalizeRoom(r.getString("input")));
        assertEquals(r.getString("roomId"), keys.roomId);
        assertEquals(r.getString("check"), keys.check);
        assertEquals(r.getString("message"), Crypto.hex(keys.message));
        assertEquals(r.getString("signal"), Crypto.hex(keys.signal));
        assertEquals(r.getString("files"), Crypto.hex(keys.files));
        assertEquals(v.getString("context"), new String(Envelopes.context("msg", "team", "id-1"), StandardCharsets.UTF_8));
    }

    @Test
    public void opensWebMessagesAndChecksTheSignature() throws Exception {
        JSONObject m = v.getJSONObject("message");
        Envelopes.Opened signed = Envelopes.openMessage(keys, m.getJSONObject("signed"));
        assertEquals(m.getJSONObject("payload").getString("text"), signed.payload.getString("text"));
        assertNotNull(signed.signer);
        assertTrue(signed.signer.valid);
        assertEquals(v.getJSONObject("alice").getString("publicKey"), signed.signer.publicKey);
        Envelopes.Opened plain = Envelopes.openMessage(keys, m.getJSONObject("plain"));
        assertNull(plain.signer);
        // Tampering is caught.
        JSONObject bad = new JSONObject(m.getJSONObject("signed").toString());
        bad.put("id", "msg-other");
        try { Envelopes.openMessage(keys, bad); fail("tampered id opened"); } catch (GeneralSecurityException expected) { }
    }

    @Test
    public void javaSealsWhatJavaOpens() throws Exception {
        ChatIdentity me = ChatIdentity.generate();
        JSONObject payload = new JSONObject().put("id", "msg-java-1").put("text", "z Javy ✓").put("createdAt", 1L).put("senderId", "p-me").put("senderName", "Me");
        Envelopes.Opened o = Envelopes.openMessage(keys, Envelopes.sealMessage(keys, "msg-java-1", payload, me));
        assertEquals("z Javy ✓", o.payload.getString("text"));
        assertTrue(o.signer.valid);
    }

    @Test
    public void opensASealedSignal() throws Exception {
        JSONObject s = v.getJSONObject("signal");
        JSONObject opened = Envelopes.openSignal(keys, s.getString("from"), s.getString("to"), s.getJSONObject("sealed").getJSONObject("sealed"));
        assertEquals("offer", opened.getString("type"));
        try { Envelopes.openSignal(keys, s.getString("to"), s.getString("from"), s.getJSONObject("sealed").getJSONObject("sealed")); fail("swapped peers opened"); } catch (GeneralSecurityException expected) { }
    }

    static ChatIdentity identity(JSONObject who) throws Exception {
        return ChatIdentity.fromPkcs8(who.getString("signPkcs8"), who.getString("publicKey"), who.getString("dhPkcs8"), who.getString("dhPublicKey"));
    }

    @Test
    public void pairKeysSenderKeysAndPrivateMessagesMatchTheWeb() throws Exception {
        JSONObject pair = v.getJSONObject("pair");
        ChatIdentity bob = identity(v.getJSONObject("bob"));
        SenderKeys store = new SenderKeys();
        assertNull(store.acceptHello(keys, bob, pair.getJSONObject("helloA"), "p-alice", "p-bob"));
        assertEquals(pair.getString("pairKey"), Crypto.hex(store.pairOf("p-alice").key));
        assertTrue(store.acceptSenderKey(keys, pair.getJSONObject("senderKey"), "p-alice", "p-bob"));
        JSONArray live = pair.getJSONArray("live");
        // Out of order: the third first (skipping), then the others.
        for (int i : new int[]{2, 0, 1}) {
            JSONObject item = live.getJSONObject(i);
            Envelopes.Opened o = store.openLive(keys, item.getJSONObject("envelope"), "p-alice");
            assertEquals(item.getJSONObject("payload").getString("text"), o.payload.getString("text"));
            assertTrue(o.signer.valid);
        }
        // A message key is used only once.
        try { store.openLive(keys, live.getJSONObject(0).getJSONObject("envelope"), "p-alice"); fail("replayed"); } catch (GeneralSecurityException expected) { }
        Envelopes.Opened priv = store.openPrivate(keys, pair.getJSONObject("private").getJSONObject("envelope"), "p-alice", "p-bob");
        assertEquals("jen pro Boba", priv.payload.getString("text"));
        // The hello is checked: a wrong check value or a forged signature is refused.
        JSONObject wrong = new JSONObject(pair.getJSONObject("helloA").toString()).put("check", "0000000000000000");
        assertEquals("key-mismatch", new SenderKeys().acceptHello(keys, bob, wrong, "p-alice", "p-bob"));
        assertEquals("bad-signature", new SenderKeys().acceptHello(keys, bob, pair.getJSONObject("helloA"), "p-mallory", "p-bob"));
    }

    @Test
    public void javaHelloAndSenderKeysWorkBothWays() throws Exception {
        ChatIdentity a = ChatIdentity.generate(), b = ChatIdentity.generate();
        SenderKeys sa = new SenderKeys(), sb = new SenderKeys();
        assertNull(sb.acceptHello(keys, b, sa.hello(keys, a, "pa", "pb", null), "pa", "pb"));
        assertNull(sa.acceptHello(keys, a, sb.hello(keys, b, "pb", "pa", null), "pb", "pa"));
        assertArrayEquals(sa.pairOf("pb").key, sb.pairOf("pa").key);
        assertTrue(sb.acceptSenderKey(keys, sa.senderKeyFor(keys, "pa", "pb"), "pa", "pb"));
        JSONObject p = new JSONObject().put("id", "m1").put("text", "hi");
        assertEquals("hi", sb.openLive(keys, sa.sealLive(keys, "m1", p, a), "pa").payload.getString("text"));
    }

    @Test
    public void opensAWebFile() throws Exception {
        JSONObject f = v.getJSONObject("file");
        byte[] fk = keys.fileKey(f.getString("transferId"));
        JSONObject meta = Envelopes.openFileBody(fk, Envelopes.fileMetaContext(f.getString("transferId")), f.getJSONObject("meta").getString("iv"), f.getJSONObject("meta").getString("ciphertext"));
        assertEquals("a.txt", meta.getString("name"));
        byte[] chunk = Envelopes.openChunk(fk, Envelopes.fileChunkContext(f.getString("transferId"), 0, 1), f.getJSONObject("chunk").getString("iv"), f.getJSONObject("chunk").getString("ciphertext"));
        assertArrayEquals(Crypto.unb64(f.getString("chunkPlain")), chunk);
    }

    @Test
    public void identityHelpersMatch() throws Exception {
        JSONObject a = v.getJSONObject("alice");
        assertEquals(a.getString("kid"), Ec.kid(a.getString("publicKey")));
        assertEquals(a.getString("fingerprint"), Ec.fingerprint(a.getString("publicKey")));
        assertEquals(v.getString("safetyNumber"), ChatIdentity.safetyNumber(a.getString("publicKey"), v.getJSONObject("bob").getString("publicKey")));
    }

    @Test
    public void opensAServerBundleForThisDevice() throws Exception {
        JSONObject and = v.getJSONObject("android");
        PrivateKey device = Ec.privateFromPkcs8(Crypto.unb64(and.getString("devicePkcs8")));
        BundleFile file = BundleFile.parse(Crypto.unb64(and.getString("bundle")));
        assertTrue(file.verify(Ec.publicFromSpki(and.getString("serverPublicKey"))));
        assertFalse(file.verify(Ec.publicFromSpki(Ec.spki(Ec.generate().getPublic()))));
        byte[] cek = file.unwrapKey(device, and.getString("deviceId"));
        Map<String, byte[]> files = BundleFile.unpack(file.decrypt(cek));
        assertTrue(files.containsKey("screens/room.json"));
        assertEquals("column", new JSONObject(new String(files.get("screens/lock.json"), StandardCharsets.UTF_8)).getString("el"));
        try { file.unwrapKey(device, "and_other"); fail("another device"); } catch (GeneralSecurityException expected) { }
    }

    @Test
    public void opensAServerPushMessage() throws Exception {
        JSONObject and = v.getJSONObject("android");
        JSONObject push = and.getJSONObject("push");
        String signed = "m5push/1|" + and.getString("deviceId") + "|" + push.getString("i") + "|" + push.getString("e") + "|" + push.getString("iv") + "|" + push.getString("ct");
        assertTrue(Ec.verify(and.getString("serverPublicKey"), signed.getBytes(StandardCharsets.UTF_8), push.getString("s")));
        PrivateKey device = Ec.privateFromPkcs8(Crypto.unb64(and.getString("devicePkcs8")));
        JSONObject content = new JSONObject(new String(Ecies.open(device, and.getString("deviceId"), "push", new Ecies.Wire(push.getString("e"), push.getString("iv"), push.getString("ct"))), StandardCharsets.UTF_8));
        assertEquals("flash", content.getString("kind"));
        assertEquals("ahoj", content.getJSONObject("payload").getString("text"));
    }
}
