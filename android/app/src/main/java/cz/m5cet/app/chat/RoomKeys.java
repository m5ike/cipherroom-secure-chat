package cz.m5cet.app.chat;

import java.text.Normalizer;
import java.util.Locale;

import cz.m5cet.app.security.Crypto;

/**
 * A room's keys (client/src/lib/envelope.ts deriveRoomKeys):
 *
 *   passphrase ─NFC─▶ Argon2id(64 MiB, 3 passes, salt "m5cet:room:v3:<room>")      (v3)
 *                  or PBKDF2-SHA256(600 000, salt "m5cet:room:v2:<room>")          (v2)
 *   seed ─HKDF-SHA256(salt "m5cet:v2")─▶ message, signal, files, check (8 B hex), room-id (24 B)
 *
 * The server only ever sees roomId ("r3." + base64url), never the name.
 */
public final class RoomKeys {
    public static final int ARGON2_MEMORY_KIB = 64 * 1024;
    public static final int ARGON2_PASSES = 3;
    public static final int PBKDF2_ITERATIONS = 600_000;
    private static final byte[] HKDF_SALT = Crypto.utf8("m5cet:v2");

    public final int version;
    public final String room;
    public final String roomId;
    public final byte[] message;
    public final byte[] signal;
    public final byte[] files;
    public final String check;
    private final byte[] seed;
    private final String passphrase;
    private RoomKeys previous;

    private RoomKeys(int version, String room, byte[] seed, String passphrase) {
        this.version = version;
        this.room = room;
        this.seed = seed;
        this.passphrase = passphrase;
        this.message = derive("message", 32);
        this.signal = derive("signal", 32);
        this.files = derive("files", 32);
        this.check = Crypto.hex(derive("check", 8));
        this.roomId = version == 3 ? "r3." + Crypto.b64url(derive("room-id", 24)) : room;
    }

    /** app-helpers.ts normalizeRoom. */
    public static String normalizeRoom(String value) {
        String s = value.trim().toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9._-]+", "-").replaceAll("^-+|-+$", "");
        if (s.length() > 48) s = s.substring(0, 48);
        return s.isEmpty() ? "secure-room" : s;
    }

    public static RoomKeys derive(String room, String passphrase) {
        return derive(room, passphrase, ARGON2_MEMORY_KIB, ARGON2_PASSES);
    }

    public static RoomKeys derive(String room, String passphrase, int memoryKiB, int passes) {
        String password = Normalizer.normalize(passphrase, Normalizer.Form.NFC);
        byte[] seed = Argon2.argon2id(Crypto.utf8(password), Crypto.utf8("m5cet:room:v3:" + room), passes, memoryKiB, 1, 32, null, null);
        return new RoomKeys(3, room, seed, passphrase);
    }

    public static RoomKeys deriveV2(String room, String passphrase) {
        String password = Normalizer.normalize(passphrase, Normalizer.Form.NFC);
        byte[] seed = Crypto.pbkdf2(Crypto.utf8(password), Crypto.utf8("m5cet:room:v2:" + room), PBKDF2_ITERATIONS, 32);
        return new RoomKeys(2, room, seed, passphrase);
    }

    /** The v2 keys of the same passphrase (envelopes queued by 3.0), derived on first need. */
    public synchronized RoomKeys previous() {
        if (version != 3) return null;
        if (previous == null) previous = deriveV2(room, passphrase);
        return previous;
    }

    /** HKDF from the room secret, for sub-keys other parts need. */
    public byte[] derive(String info, int bytes) {
        return Crypto.hkdf(seed, HKDF_SALT, Crypto.utf8(info), bytes);
    }

    /** One AES key per file transfer. */
    public byte[] fileKey(String transferId) {
        return Crypto.hkdf(files, Crypto.utf8(transferId), Crypto.utf8("file"), 32);
    }

    public void wipe() {
        Crypto.wipe(seed);
        Crypto.wipe(message);
        Crypto.wipe(signal);
        Crypto.wipe(files);
    }
}
