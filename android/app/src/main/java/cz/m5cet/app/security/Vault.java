package cz.m5cet.app.security;

import android.content.Context;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.security.GeneralSecurityException;

import javax.crypto.Cipher;
import javax.crypto.SecretKey;

import cz.m5cet.app.core.Log;

/**
 * The two key tiers of all local data (docs/android-architecture.md §2).
 *
 *   system tier   DEK_sys, wrapped by Keystore m5.sys (no user needed): the
 *                 server settings, device keys, policy, the attempt counter,
 *                 events, bundles, the log — readable in the background
 *                 (FCM control messages) but never outside this phone.
 *   user tier     DEK_user, wrapped twice: by Keystore m5.bio (a biometric
 *                 per use, invalidated by a new fingerprint) and by the PIN
 *                 key = HMAC(Keystore m5.pep, PBKDF2-SHA256(PIN, salt, 210 000)).
 *                 Rooms, passphrases, messages, identities. Only after unlock.
 *
 * Records are AES-256-GCM with a fresh IV and the record's name as
 * associated data, so a file cannot be swapped for another.
 */
public final class Vault {
    public static final int PIN_ITERATIONS = 210_000;

    private final File dir;
    private byte[] sysKey;
    private volatile byte[] userKey;

    public Vault(Context ctx) {
        this.dir = new File(ctx.getNoBackupFilesDir(), "m5");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
    }

    public File dir() { return dir; }

    private File f(String name) { return new File(dir, name); }

    static byte[] read(File file) throws IOException { return Files.readAllBytes(file.toPath()); }

    static void writeAtomic(File file, byte[] data) throws IOException {
        File parent = file.getParentFile();
        if (parent != null) //noinspection ResultOfMethodCallIgnored
            parent.mkdirs();
        File tmp = new File(file.getPath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(data);
            out.getFD().sync();
        }
        if (!tmp.renameTo(file)) throw new IOException("cannot replace " + file.getName());
    }

    /* ------------------------------------------------------------ system */

    public synchronized byte[] sysKey() throws GeneralSecurityException {
        if (sysKey != null) return sysKey;
        File wrapped = f("sys.key");
        SecretKey k = Keystore.sysKey();
        byte[] aad = Crypto.utf8("m5/sys.key");
        try {
            if (wrapped.exists()) {
                sysKey = Keystore.open(k, read(wrapped), aad);
            } else {
                sysKey = Crypto.random(32);
                writeAtomic(wrapped, Keystore.seal(k, sysKey, aad));
            }
        } catch (IOException e) {
            throw new GeneralSecurityException("system key file", e);
        }
        return sysKey;
    }

    /* -------------------------------------------------------------- user */

    public boolean hasUserKey() { return f("user.pin").exists(); }
    public boolean unlocked() { return userKey != null; }
    public boolean bioEnrolled() { return f("user.bio").exists() && Keystore.has(Keystore.BIO); }

    public byte[] userKey() throws GeneralSecurityException {
        byte[] k = userKey;
        if (k == null) throw new GeneralSecurityException("locked");
        return k;
    }

    private byte[] pinKey(String pin, byte[] salt, int iterations) throws GeneralSecurityException {
        byte[] stretched = Crypto.pbkdf2(Crypto.utf8(pin), salt, iterations, 32);
        try { return Keystore.pepper(stretched); } finally { Crypto.wipe(stretched); }
    }

    /** First setup: a new user key protected by this PIN. */
    public synchronized void createUserKey(String pin) throws GeneralSecurityException {
        byte[] key = Crypto.random(32);
        writePinWrap(key, pin);
        userKey = key;
    }

    private void writePinWrap(byte[] key, String pin) throws GeneralSecurityException {
        byte[] salt = Crypto.random(16);
        byte[] kek = pinKey(pin, salt, PIN_ITERATIONS);
        byte[] iv = Crypto.random(12);
        byte[] ct = Crypto.gcmSeal(kek, iv, key, Crypto.utf8("m5/user.pin"));
        Crypto.wipe(kek);
        try {
            JSONObject o = new JSONObject().put("salt", Crypto.b64(salt)).put("iter", PIN_ITERATIONS).put("iv", Crypto.b64(iv)).put("ct", Crypto.b64(ct));
            writeAtomic(f("user.pin"), Crypto.utf8(o.toString()));
        } catch (JSONException | IOException e) {
            throw new GeneralSecurityException("cannot store the PIN wrap", e);
        }
    }

    /** True when the PIN opens the user key (it is then held in memory). */
    public synchronized boolean unlockWithPin(String pin) throws GeneralSecurityException {
        try {
            JSONObject o = new JSONObject(Crypto.str(read(f("user.pin"))));
            byte[] kek = pinKey(pin, Crypto.unb64(o.getString("salt")), o.getInt("iter"));
            try {
                userKey = Crypto.gcmOpen(kek, Crypto.unb64(o.getString("iv")), Crypto.unb64(o.getString("ct")), Crypto.utf8("m5/user.pin"));
                return true;
            } catch (javax.crypto.AEADBadTagException bad) {
                return false;
            } finally {
                Crypto.wipe(kek);
            }
        } catch (IOException | JSONException e) {
            throw new GeneralSecurityException("cannot read the PIN wrap", e);
        }
    }

    public synchronized void changePin(String pin) throws GeneralSecurityException {
        writePinWrap(userKey(), pin);
    }

    /** A cipher to encrypt the user key under a new biometric key (after a prompt). */
    public Cipher bioEnrollCipher() throws GeneralSecurityException {
        return Keystore.encryptCipher(Keystore.newBioKey());
    }

    /** Stores the user key encrypted by the authenticated cipher. */
    public synchronized void finishBioEnroll(Cipher authenticated) throws GeneralSecurityException {
        authenticated.updateAAD(Crypto.utf8("m5/user.bio"));
        byte[] ct = authenticated.doFinal(userKey());
        try { writeAtomic(f("user.bio"), Crypto.concat(authenticated.getIV(), ct)); }
        catch (IOException e) { throw new GeneralSecurityException(e); }
    }

    /** A cipher that decrypts the user key once a biometric prompt authorises it. */
    public Cipher bioUnlockCipher() throws GeneralSecurityException {
        try {
            return Keystore.decryptCipher(Keystore.bioKey(), read(f("user.bio")));
        } catch (IOException e) {
            throw new GeneralSecurityException(e);
        }
    }

    public synchronized void finishBioUnlock(Cipher authenticated) throws GeneralSecurityException {
        try {
            byte[] sealed = read(f("user.bio"));
            authenticated.updateAAD(Crypto.utf8("m5/user.bio"));
            userKey = authenticated.doFinal(sealed, 12, sealed.length - 12);
        } catch (IOException e) {
            throw new GeneralSecurityException(e);
        }
    }

    public synchronized void disableBio() {
        Keystore.delete(Keystore.BIO);
        //noinspection ResultOfMethodCallIgnored
        f("user.bio").delete();
    }

    /** Forgets the user key in memory (a full lock). */
    public synchronized void lock() {
        Crypto.wipe(userKey);
        userKey = null;
    }

    /* ----------------------------------------------------------- records */

    public enum Tier { SYS, USER }

    private byte[] keyOf(Tier tier) throws GeneralSecurityException { return tier == Tier.SYS ? sysKey() : userKey(); }

    private File record(Tier tier, String name) {
        if (!name.matches("[A-Za-z0-9._-]{1,120}")) throw new IllegalArgumentException("bad record name " + name);
        return new File(new File(dir, tier == Tier.SYS ? "sys" : "user"), name + ".bin");
    }

    public byte[] seal(Tier tier, String name, byte[] plain) throws GeneralSecurityException {
        byte[] iv = Crypto.random(12);
        return Crypto.concat(iv, Crypto.gcmSeal(keyOf(tier), iv, plain, Crypto.utf8(tier + "|" + name)));
    }

    public byte[] open(Tier tier, String name, byte[] sealed) throws GeneralSecurityException {
        return Crypto.gcmOpen(keyOf(tier), java.util.Arrays.copyOf(sealed, 12), java.util.Arrays.copyOfRange(sealed, 12, sealed.length), Crypto.utf8(tier + "|" + name));
    }

    public void put(Tier tier, String name, byte[] plain) throws GeneralSecurityException {
        try { writeAtomic(record(tier, name), seal(tier, name, plain)); }
        catch (IOException e) { throw new GeneralSecurityException("cannot write " + name, e); }
    }

    /** null when there is no such record. */
    public byte[] get(Tier tier, String name) throws GeneralSecurityException {
        File file = record(tier, name);
        if (!file.exists()) return null;
        try { return open(tier, name, read(file)); }
        catch (IOException e) { throw new GeneralSecurityException("cannot read " + name, e); }
    }

    public JSONObject json(Tier tier, String name) {
        try {
            byte[] b = get(tier, name);
            return b == null ? new JSONObject() : new JSONObject(Crypto.str(b));
        } catch (GeneralSecurityException | JSONException e) {
            Log.w("vault", "record " + name + " unreadable: " + e.getMessage());
            return new JSONObject();
        }
    }

    public void putJson(Tier tier, String name, JSONObject value) {
        try { put(tier, name, Crypto.utf8(value.toString())); }
        catch (GeneralSecurityException e) { Log.e("vault", "cannot store " + name, e); }
    }

    public void delete(Tier tier, String name) {
        //noinspection ResultOfMethodCallIgnored
        record(tier, name).delete();
    }
}
