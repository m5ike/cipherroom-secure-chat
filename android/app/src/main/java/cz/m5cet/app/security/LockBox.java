package cz.m5cet.app.security;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.util.ArrayList;
import java.util.List;
import java.util.TreeMap;

/**
 * 6.12 (security analysis F-16): the lock inbox's cryptography and file
 * format — what the rooms receive while the app is locked (the vault's data
 * key is gone then) is kept on the disk sealed to a key the locked app
 * cannot open.
 *
 *   a generation   at each lock a new P-256 key pair; its id (kid) is
 *                  Ec.kid(public key). The private key is sealed by the
 *                  vault's data key (wrapKey: AES-256-GCM, AAD
 *                  "m5/lockbox/1|key|<kid>") and written before that key is
 *                  zeroed; only the public key stays in memory.
 *   an item        sealed to that public key: a fresh ephemeral P-256 key,
 *                  ECDH, HKDF-SHA256 (salt "m5/lockbox/1", info
 *                  "<kid>|<seq>|<ephemeral SPKI>"), AES-256-GCM with AAD
 *                  "m5/lockbox/1|<kid>|<seq>" (the label and the item's id)
 *                  — {"s": seq, "e": ephemeral SPKI, "iv", "ct"}
 *   the log        one item per line, appended and synced (a crash keeps
 *                  every item written before it; a line cut by it is
 *                  skipped)
 *   opening        at the unlock, with the private key unwrapped by the data
 *                  key: every item in the order of its seq, each once; one
 *                  that does not open (another generation, damaged) is
 *                  skipped and counted
 *
 * Pure (no Android API): LockBoxTest.
 */
public final class LockBox {
    private LockBox() {}

    static final String LABEL = "m5/lockbox/1";

    /** A new generation's key pair (software P-256: its private key is kept only sealed by the data key). */
    public static KeyPair newKeyPair() { return Ec.generate(); }

    public static String kid(PublicKey pub) { return Ec.kid(Ec.spki(pub)); }

    static byte[] aad(String kid, long seq) { return Crypto.utf8(LABEL + "|" + kid + "|" + seq); }

    private static byte[] itemKey(byte[] shared, String kid, long seq, String eph) {
        return Crypto.hkdf(shared, Crypto.utf8(LABEL), Crypto.utf8(kid + "|" + seq + "|" + eph), 32);
    }

    /** One item sealed to the generation's public key. */
    public static JSONObject seal(PublicKey pub, String kid, long seq, byte[] plain) throws GeneralSecurityException {
        KeyPair eph = Ec.generate();
        String e = Ec.spki(eph.getPublic());
        byte[] shared = Ec.ecdh(eph.getPrivate(), pub);
        byte[] k = itemKey(shared, kid, seq, e);
        Crypto.wipe(shared);
        try {
            byte[] iv = Crypto.random(12);
            byte[] ct = Crypto.gcmSeal(k, iv, plain, aad(kid, seq));
            return new JSONObject().put("s", seq).put("e", e).put("iv", Crypto.b64(iv)).put("ct", Crypto.b64(ct));
        } catch (JSONException e2) {
            throw new GeneralSecurityException(e2);
        } finally {
            Crypto.wipe(k);
        }
    }

    /** An item's plaintext; throws when it does not open with this generation's private key. */
    public static byte[] open(PrivateKey priv, String kid, JSONObject rec) throws GeneralSecurityException {
        long seq = rec.optLong("s", -1);
        String e = rec.optString("e", "");
        if (seq < 0 || e.isEmpty()) throw new GeneralSecurityException("not an item");
        byte[] shared;
        try { shared = Ec.ecdh(priv, Ec.publicFromSpki(e)); }
        catch (IllegalArgumentException bad) { throw new GeneralSecurityException("not an item", bad); }
        byte[] k = itemKey(shared, kid, seq, e);
        Crypto.wipe(shared);
        try {
            return Crypto.gcmOpen(k, Crypto.unb64(rec.optString("iv")), Crypto.unb64(rec.optString("ct")), aad(kid, seq));
        } catch (IllegalArgumentException bad) {
            throw new GeneralSecurityException("not an item", bad);
        } finally {
            Crypto.wipe(k);
        }
    }

    /* ------------------------------------------------- the private key */

    static byte[] keyAad(String kid) { return Crypto.utf8(LABEL + "|key|" + kid); }

    /** The generation's private key (PKCS#8) sealed by the vault's data key: iv ‖ ct. */
    public static byte[] wrapKey(byte[] dek, String kid, byte[] pkcs8) {
        byte[] iv = Crypto.random(12);
        return Crypto.concat(iv, Crypto.gcmSeal(dek, iv, pkcs8, keyAad(kid)));
    }

    /** The private key again; throws with another data key (or another generation's file). */
    public static PrivateKey unwrapKey(byte[] dek, String kid, byte[] wrapped) throws GeneralSecurityException {
        if (wrapped == null || wrapped.length < 28) throw new GeneralSecurityException("not a key");
        byte[] pkcs8 = Crypto.gcmOpen(dek, java.util.Arrays.copyOf(wrapped, 12), java.util.Arrays.copyOfRange(wrapped, 12, wrapped.length), keyAad(kid));
        try { return Ec.privateFromPkcs8(pkcs8); } finally { Crypto.wipe(pkcs8); }
    }

    /* ------------------------------------------------------------ the log */

    /** Appends one item as a line and syncs it to the disk. */
    public static void append(File log, JSONObject rec) throws IOException {
        File parent = log.getParentFile();
        if (parent != null) //noinspection ResultOfMethodCallIgnored
            parent.mkdirs();
        try (FileOutputStream out = new FileOutputStream(log, true)) {
            out.write((rec.toString() + "\n").getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        }
    }

    /** The log's records; a line that is not one (cut by a crash) is skipped. */
    public static List<JSONObject> read(File log) throws IOException {
        List<JSONObject> out = new ArrayList<>();
        if (!log.exists()) return out;
        try (BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(log), StandardCharsets.UTF_8))) {
            for (String line; (line = r.readLine()) != null; ) {
                if (line.isEmpty()) continue;
                try { out.add(new JSONObject(line)); } catch (JSONException cut) { /* a partial line */ }
            }
        }
        return out;
    }

    /** What a generation's log held: its items in seq order (each once), and how many did not open. */
    public static final class Opened {
        public final List<byte[]> items = new ArrayList<>();
        public int failed;
    }

    public static Opened openAll(PrivateKey priv, String kid, List<JSONObject> recs) {
        TreeMap<Long, byte[]> bySeq = new TreeMap<>();
        Opened out = new Opened();
        for (JSONObject rec : recs) {
            long seq = rec.optLong("s", -1);
            if (bySeq.containsKey(seq)) continue; // a line written twice: once
            try { bySeq.put(seq, open(priv, kid, rec)); }
            catch (GeneralSecurityException e) { out.failed++; }
        }
        out.items.addAll(bySeq.values());
        return out;
    }
}
