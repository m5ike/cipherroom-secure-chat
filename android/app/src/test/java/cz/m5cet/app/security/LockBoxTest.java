package cz.m5cet.app.security;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * 6.12 (security analysis F-16): the lock inbox — items sealed to a
 * generation's public key while the data key is gone, opened only with the
 * private key the data key seals; in order, each once; a crash keeps what was
 * written and never makes it readable without the data key.
 */
public class LockBoxTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    private static byte[] utf8(String s) { return s.getBytes(StandardCharsets.UTF_8); }

    /** A lock: a generation whose private key is sealed by the data key and written; only the public key stays. */
    private static final class Generation {
        final PublicKey pub;
        final String kid;
        final File key, log;
        long seq;
        Generation(File dir, byte[] dek) throws Exception {
            KeyPair kp = LockBox.newKeyPair();
            pub = kp.getPublic();
            kid = LockBox.kid(pub);
            key = new File(dir, kid + ".key");
            log = new File(dir, kid + ".log");
            Files.write(key.toPath(), LockBox.wrapKey(dek, kid, kp.getPrivate().getEncoded()));
        }
        void add(String text) throws Exception { LockBox.append(log, LockBox.seal(pub, kid, ++seq, utf8(text))); }
    }

    private static List<String> texts(LockBox.Opened o) {
        List<String> out = new ArrayList<>();
        for (byte[] b : o.items) out.add(new String(b, StandardCharsets.UTF_8));
        return out;
    }

    @Test
    public void sealedItemsOpenInOrderWithTheDataKey() throws Exception {
        byte[] dek = Crypto.random(32);
        Generation g = new Generation(tmp.getRoot(), dek);
        for (int i = 1; i <= 5; i++) g.add("{\"t\":\"msg\",\"n\":" + i + "}");
        // Nothing of it is readable in the files.
        String onDisk = new String(Files.readAllBytes(g.log.toPath()), StandardCharsets.UTF_8) + new String(Files.readAllBytes(g.key.toPath()), StandardCharsets.ISO_8859_1);
        assertFalse(onDisk.contains("\"t\":\"msg\""));
        PrivateKey priv = LockBox.unwrapKey(dek, g.kid, Files.readAllBytes(g.key.toPath()));
        LockBox.Opened o = LockBox.openAll(priv, g.kid, LockBox.read(g.log));
        assertEquals(0, o.failed);
        assertEquals(5, o.items.size());
        for (int i = 0; i < 5; i++) assertEquals("{\"t\":\"msg\",\"n\":" + (i + 1) + "}", texts(o).get(i));
    }

    @Test
    public void theOrderIsTheSeqAndAnItemCountsOnce() throws Exception {
        byte[] dek = Crypto.random(32);
        Generation g = new Generation(tmp.getRoot(), dek);
        List<JSONObject> recs = new ArrayList<>();
        for (int i = 1; i <= 6; i++) recs.add(LockBox.seal(g.pub, g.kid, i, utf8("item " + i)));
        List<JSONObject> shuffled = new ArrayList<>(recs);
        Collections.reverse(shuffled);
        shuffled.add(recs.get(2)); // a line written twice
        PrivateKey priv = LockBox.unwrapKey(dek, g.kid, Files.readAllBytes(g.key.toPath()));
        LockBox.Opened o = LockBox.openAll(priv, g.kid, shuffled);
        assertEquals(List.of("item 1", "item 2", "item 3", "item 4", "item 5", "item 6"), texts(o));
    }

    @Test
    public void anotherDataKeyOpensNothing() throws Exception {
        byte[] dek = Crypto.random(32);
        Generation g = new Generation(tmp.getRoot(), dek);
        g.add("secret");
        byte[] wrapped = Files.readAllBytes(g.key.toPath());
        try { LockBox.unwrapKey(Crypto.random(32), g.kid, wrapped); fail("another data key"); } catch (GeneralSecurityException expected) { }
        try { LockBox.unwrapKey(dek, "another-kid", wrapped); fail("another generation's name"); } catch (GeneralSecurityException expected) { }
        try { LockBox.unwrapKey(dek, g.kid, new byte[10]); fail("not a key"); } catch (GeneralSecurityException expected) { }
        // Another generation's private key does not open these items.
        PrivateKey other = LockBox.newKeyPair().getPrivate();
        LockBox.Opened o = LockBox.openAll(other, g.kid, LockBox.read(g.log));
        assertEquals(0, o.items.size());
        assertEquals(1, o.failed);
    }

    @Test
    public void anItemIsBoundToItsPlace() throws Exception {
        byte[] dek = Crypto.random(32);
        Generation g = new Generation(tmp.getRoot(), dek);
        PrivateKey priv = LockBox.unwrapKey(dek, g.kid, Files.readAllBytes(g.key.toPath()));
        JSONObject rec = LockBox.seal(g.pub, g.kid, 3, utf8("third"));
        assertArrayEquals(utf8("third"), LockBox.open(priv, g.kid, rec));
        // Moved to another seq (its order), or read as another generation's: it does not open.
        try { LockBox.open(priv, g.kid, new JSONObject(rec.toString()).put("s", 1)); fail("seq"); } catch (GeneralSecurityException expected) { }
        try { LockBox.open(priv, "other", rec); fail("kid"); } catch (GeneralSecurityException expected) { }
        JSONObject flipped = new JSONObject(rec.toString());
        byte[] ct = Crypto.unb64(flipped.getString("ct"));
        ct[0] ^= 1;
        try { LockBox.open(priv, g.kid, flipped.put("ct", Crypto.b64(ct))); fail("changed"); } catch (GeneralSecurityException expected) { }
        try { LockBox.open(priv, g.kid, new JSONObject().put("s", 1)); fail("not an item"); } catch (GeneralSecurityException expected) { }
    }

    @Test
    public void aCrashKeepsWhatWasWrittenAndAPartialLineIsSkipped() throws Exception {
        byte[] dek = Crypto.random(32);
        Generation g = new Generation(tmp.getRoot(), dek);
        g.add("one");
        g.add("two");
        // The process died while writing the third line.
        String third = LockBox.seal(g.pub, g.kid, 3, utf8("three")).toString();
        try (FileOutputStream out = new FileOutputStream(g.log, true)) { out.write(third.substring(0, third.length() / 2).getBytes(StandardCharsets.UTF_8)); }
        // A new process: nothing of the generation in memory — the files and the data key after the next unlock.
        List<JSONObject> recs = LockBox.read(g.log);
        assertEquals(2, recs.size());
        PrivateKey priv = LockBox.unwrapKey(dek, g.kid, Files.readAllBytes(g.key.toPath()));
        assertEquals(List.of("one", "two"), texts(LockBox.openAll(priv, g.kid, recs)));
        // …and writing goes on after a cut line (a new lock writes to a new generation; here the same log).
        try (FileOutputStream out = new FileOutputStream(g.log, true)) { out.write('\n'); }
        g.seq = 3;
        g.add("four");
        assertEquals(List.of("one", "two", "four"), texts(LockBox.openAll(priv, g.kid, LockBox.read(g.log))));
    }

    @Test
    public void noLogIsNoItems() throws Exception {
        assertTrue(LockBox.read(new File(tmp.getRoot(), "none.log")).isEmpty());
        // Each item has its own ephemeral key: the same text twice is two different records.
        KeyPair kp = LockBox.newKeyPair();
        String kid = LockBox.kid(kp.getPublic());
        JSONObject a = LockBox.seal(kp.getPublic(), kid, 1, utf8("same")), b = LockBox.seal(kp.getPublic(), kid, 1, utf8("same"));
        assertFalse(a.getString("e").equals(b.getString("e")));
        assertFalse(a.getString("ct").equals(b.getString("ct")));
    }
}
