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
 *                 key = HMAC(Keystore m5.pin, "m5/pin/2|" ‖ PBKDF2-SHA256(PIN, salt, 210 000))
 *                 (6.12; before: HMAC(Keystore m5.pep, PBKDF2(…)), "v" 1).
 *                 Rooms, passphrases, messages, identities. Only after unlock;
 *                 6.12 (F-16): a lock forgets it (lock() zeroes it), unlocking
 *                 derives it again.
 *
 * Records are AES-256-GCM with a fresh IV and the record's name as
 * associated data, so a file cannot be swapped for another.
 *
 * 6.12 (F-16), the PIN wrap "user.pin":
 *   v 1  {salt, iter, iv, ct}: KEK = HMAC(m5.pep, PBKDF2(PIN)) — m5.pep is a
 *        Keystore key too, but whether secure hardware holds it was never
 *        checked
 *   v 2  {v, salt, iter, iv, ct, hw}: KEK = HMAC(m5.pin, "m5/pin/2|" ‖ PBKDF2(PIN)),
 *        m5.pin in StrongBox or the TEE — checked (Keystore.ensurePinKey),
 *        hw says which; AAD "m5/user.pin/2"
 * An install with v 1 moves to v 2 at its next successful PIN unlock (same
 * salt, same data key — no second PBKDF2), and only once v 2 is on the disk
 * is m5.pep deleted. A phone without secure hardware for the key keeps v 1
 * (Keystore.ensurePinKey says so; the security screen shows it).
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

    /**
     * 6.12 (F-16): writeAtomic, and the directory synced too — the rename is
     * on the disk before anything that depends on it (the attempt counter's
     * old Keystore key is deleted only after its new record is).
     */
    public static void writeDurable(File file, byte[] data) throws IOException {
        writeAtomic(file, data);
        syncDir(file.getParentFile());
    }

    /** 6.12: a directory's entries on the disk (after a rename into it — the lock inbox's kept files). */
    public static void syncDir(File dir) {
        if (dir == null) return;
        java.io.FileDescriptor fd = null;
        try {
            fd = android.system.Os.open(dir.getPath(), android.system.OsConstants.O_RDONLY, 0);
            android.system.Os.fsync(fd);
        } catch (Throwable t) {
            Log.w("vault", "the directory could not be synced: " + t.getClass().getSimpleName());
        } finally {
            if (fd != null) try { android.system.Os.close(fd); } catch (Throwable ignored) { }
        }
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

    /** The KEK from the stretched PIN (PinWrap): v 2 by m5.pin over "m5/pin/2|" ‖ stretched, v 1 by m5.pep. */
    private static final PinWrap.Kek KEYSTORE_KEK = (stretched, version) -> version >= 2
        ? Keystore.hmacBy(Keystore.PIN, Crypto.utf8("m5/pin/2|"), stretched)
        : Keystore.pepper(stretched);

    private static byte[] stretch(String pin, byte[] salt, int iterations) { return Crypto.pbkdf2(Crypto.utf8(pin), salt, iterations, 32); }

    /** First setup: a new user key protected by this PIN. */
    public synchronized void createUserKey(String pin) throws GeneralSecurityException {
        byte[] key = Crypto.random(32);
        writePinWrap(key, pin);
        userKey = key;
    }

    /** A new wrap (setup, a changed PIN): v 2 where the PIN key has secure hardware, else v 1. */
    private void writePinWrap(byte[] key, String pin) throws GeneralSecurityException {
        byte[] salt = Crypto.random(16);
        byte[] stretched = stretch(pin, salt, PIN_ITERATIONS);
        try {
            String hw;
            boolean failedNow = false;
            try { hw = Keystore.ensurePinKey(); }
            catch (GeneralSecurityException e) { hw = null; failedNow = true; } // v 1 now; the next PIN unlock moves it
            JSONObject o = PinWrap.seal(key, stretched, salt, PIN_ITERATIONS, hw == null ? 1 : 2, hw, KEYSTORE_KEK);
            if (hw == null && !failedNow) o.put("hw", "software");
            storeWrap(o);
        } catch (JSONException e) {
            throw new GeneralSecurityException(e);
        } finally {
            Crypto.wipe(stretched);
        }
    }

    private void storeWrap(JSONObject o) throws GeneralSecurityException {
        try { writeDurable(f("user.pin"), Crypto.utf8(o.toString())); }
        catch (IOException e) { throw new GeneralSecurityException("cannot store the PIN wrap", e); }
        // The old pepper only once nothing needs it (a v 1 wrap is gone).
        if (PinWrap.version(o) >= 2) Keystore.delete(Keystore.PEPPER);
    }

    private JSONObject readWrap() throws GeneralSecurityException {
        try { return new JSONObject(Crypto.str(read(f("user.pin")))); }
        catch (IOException | JSONException e) { throw new GeneralSecurityException("cannot read the PIN wrap", e); }
    }

    /** The data key the PIN opens, or null for a wrong PIN; migrate: a v 1 wrap moves to v 2 then. */
    private byte[] open(String pin, boolean migrate) throws GeneralSecurityException {
        JSONObject o = readWrap();
        byte[] stretched = stretch(pin, PinWrap.salt(o), PinWrap.iterations(o));
        try {
            byte[] key = PinWrap.open(o, stretched, KEYSTORE_KEK);
            if (key == null) return null;
            if (migrate && PinWrap.version(o) < 2) migrate(o, key, stretched);
            else if (migrate && Keystore.has(Keystore.PEPPER)) Keystore.delete(Keystore.PEPPER); // a move that stopped before this
            return key;
        } finally {
            Crypto.wipe(stretched);
        }
    }

    /**
     * 6.12 (F-16): v 1 → v 2 with the PIN just typed (best effort: the v 1 wrap
     * stays on any failure). A phone found without secure hardware for the key
     * keeps v 1, marked so (hw "software") — not tried again.
     */
    private void migrate(JSONObject v1, byte[] key, byte[] stretched) {
        if ("software".equals(v1.optString("hw"))) return;
        try {
            String hw = Keystore.ensurePinKey();
            if (hw == null) {
                Log.w("vault", "no secure hardware for the PIN key: the PIN keeps the older scheme");
                writeDurable(f("user.pin"), Crypto.utf8(new JSONObject(v1.toString()).put("hw", "software").toString()));
                return;
            }
            storeWrap(PinWrap.moved(v1, key, stretched, hw, KEYSTORE_KEK));
            Log.i("vault", "the PIN key moved to " + hw);
        } catch (GeneralSecurityException | IOException | JSONException | RuntimeException e) {
            Log.w("vault", "the PIN key could not move yet: " + e.getClass().getSimpleName());
        }
    }

    /** True when the PIN opens the user key (it is then held in memory). */
    public synchronized boolean unlockWithPin(String pin) throws GeneralSecurityException {
        byte[] key = open(pin, true);
        if (key == null) return false;
        userKey = key;
        return true;
    }

    /**
     * 6.12: whether this PIN is the unlock PIN — nothing is kept or changed
     * (the duress PIN must differ from it). Asked only from the open app.
     */
    public synchronized boolean opensWith(String pin) {
        try {
            byte[] key = open(pin, false);
            if (key == null) return false;
            Crypto.wipe(key);
            return true;
        } catch (GeneralSecurityException e) {
            return false;
        }
    }

    public synchronized void changePin(String pin) throws GeneralSecurityException {
        writePinWrap(userKey(), pin);
    }

    /**
     * 6.12 (F-16): what protects the PIN, for the security screen: "strongbox",
     * "tee" (the v 2 key's checked place), "legacy" (v 1 — moves at the next
     * PIN unlock), "software" (v 1 to stay: no secure hardware), "" (no PIN).
     */
    public String pinKeyLevel() {
        if (!hasUserKey()) return "";
        try {
            JSONObject o = readWrap();
            if (PinWrap.version(o) >= 2) return o.optString("hw", "tee");
            return "software".equals(o.optString("hw")) ? "software" : "legacy";
        } catch (GeneralSecurityException e) {
            return "";
        }
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
        // 6.12 (F-16): no reader gets it any more, then its bytes are zeroed (copies handed out earlier share this array).
        byte[] k = userKey;
        userKey = null;
        Crypto.wipe(k);
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

    /** 6.12: put, with the directory synced (Vault.writeDurable). */
    public void putDurable(Tier tier, String name, byte[] plain) throws GeneralSecurityException {
        try { writeDurable(record(tier, name), seal(tier, name, plain)); }
        catch (IOException e) { throw new GeneralSecurityException("cannot write " + name, e); }
    }

    /**
     * 6.12 (F-16): a record for LockStore — {} when there is none, null when
     * it cannot be read now (the key, the storage), {"unreadable": true} when
     * it does not open (its authentication fails, or it is not JSON).
     */
    JSONObject strictJson(Tier tier, String name) {
        File file = record(tier, name);
        if (!file.exists()) return new JSONObject();
        byte[] key;
        try { key = keyOf(tier); } catch (GeneralSecurityException e) { return null; }
        byte[] sealed;
        try { sealed = read(file); } catch (IOException e) { return null; }
        try {
            if (key == null || sealed.length < 28) throw new javax.crypto.AEADBadTagException("short");
            return new JSONObject(Crypto.str(Crypto.gcmOpen(key, java.util.Arrays.copyOf(sealed, 12), java.util.Arrays.copyOfRange(sealed, 12, sealed.length), Crypto.utf8(tier + "|" + name))));
        } catch (GeneralSecurityException | JSONException e) {
            try { return new JSONObject().put(LockStore.UNREADABLE, true); } catch (JSONException x) { return null; }
        }
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
