package cz.m5cet.app.nfc;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.ArrayList;
import java.util.List;

import cz.m5cet.app.security.Crypto;

/**
 * The M5Cet card — the app's own encrypted format on an NFC tag (6.3), a
 * byte-for-byte port of client/src/lib/nfc/m5card.ts so a card written on the
 * web opens on Android and vice-versa.
 *
 *   container = "M5CD" | ver(1) | flags(1) | count(1) | record*
 *   record    = type(1) | mode(1) | rflags(1) | id(3) | salt(1+n) | iv(1+n)
 *               | ct(u16 BE + bytes)             ct = AES-GCM(plaintext)
 *               AAD = "M5CD" | ver | type | id
 *
 * Two ways to get a record's key:
 *   external (PIN)     PBKDF2-SHA256(pin, salt, 600k) → AES-GCM-256. A 6–18
 *                      digit code, so the card opens on ANY device.
 *   internal (passkey) HKDF-SHA256(account root, salt, "m5cet:nfc:card:v1")
 *                      — the card opens only on this user's own devices. The
 *                      caller passes that root; this class never sees the
 *                      account.
 *
 * A record can be marked one-time (rflags bit 0): after the user has seen it,
 * the reader rewrites the card without it (removeRecord + write).
 */
public final class M5Card {
    private M5Card() {}

    public static final String MAGIC = "M5CD";
    public static final int VERSION = 1;
    /** NDEF external type that carries a container (urn:nfc:ext:m5cet.cz:card). */
    public static final String EXTERNAL_TYPE = "m5cet.cz:card";
    public static final int PBKDF2_ROUNDS = 600_000;
    private static final byte[] HKDF_INFO = "m5cet:nfc:card:v1".getBytes(StandardCharsets.UTF_8);

    public static final String MODE_EXTERNAL = "external";
    public static final String MODE_INTERNAL = "internal";

    /** The wire value (number) is fixed — never renumber (mirror m5card.ts). */
    private static final String[] TYPE_NAMES = {
        null, "passkey-backup", "identity-backup", "one-time-message", "message",
        "server-room", "external-key", "contact", "wifi", "url-login",
    };

    static int codeOf(String type) {
        for (int i = 1; i < TYPE_NAMES.length; i++) if (TYPE_NAMES[i].equals(type)) return i;
        throw new IllegalArgumentException("unknown record type " + type);
    }

    static String typeOf(int code) { return code > 0 && code < TYPE_NAMES.length ? TYPE_NAMES[code] : null; }

    /** A key for one record, given its mode and salt. */
    public interface KeyProvider { byte[] key(String mode, byte[] salt) throws GeneralSecurityException; }

    /** external (PIN) key: PBKDF2-SHA256(pin, salt, 600k) → 32 bytes. */
    public static byte[] pinKey(String pin, byte[] salt) throws GeneralSecurityException {
        if (!isValidPin(pin)) throw new GeneralSecurityException("A card PIN is 6–18 digits.");
        return Crypto.pbkdf2(pin.getBytes(StandardCharsets.UTF_8), salt, PBKDF2_ROUNDS, 32);
    }

    /** internal (passkey) key: HKDF-SHA256(root, salt, "m5cet:nfc:card:v1") → 32 bytes. */
    public static byte[] accountKey(byte[] root, byte[] salt) {
        return Crypto.hkdf(root, salt, HKDF_INFO, 32);
    }

    /** Opens external records with {@code pin} and internal ones with {@code root} (null when not signed in). */
    public static KeyProvider keys(String pin, byte[] root) {
        return (mode, salt) -> {
            if (MODE_INTERNAL.equals(mode)) {
                if (root == null) throw new GeneralSecurityException(cz.m5cet.app.core.Texts.t("nfc.m5.needsAccount", "This record needs your account (sign in on this device)."));
                return accountKey(root, salt);
            }
            if (pin == null) throw new GeneralSecurityException(cz.m5cet.app.core.Texts.t("nfc.m5.needsPin", "This record needs a PIN."));
            return pinKey(pin, salt);
        };
    }

    public static boolean isValidPin(String pin) { return pin != null && pin.matches("^[0-9]{6,18}$"); }

    /** One record as the app works with it (plaintext side). */
    public static final class Record {
        public int id;
        public String type;
        public String mode = MODE_EXTERNAL;
        public boolean oneTime;
        /** The record's own JSON shape (see records.ts / RECORD_META). */
        public JSONObject data;

        public Record() {}
        public Record(String type, String mode, JSONObject data) { this.type = type; this.mode = mode; this.data = data; }
    }

    /** A record still sealed (as read off the card, before the key is known). */
    public static final class Sealed {
        public int id;
        public String type;
        public String mode;
        public boolean oneTime;
        public byte[] salt;
        public byte[] iv;
        public byte[] ct;
    }

    private static byte[] aad(int type, int id) {
        byte[] b = new byte[9];
        b[0] = 'M'; b[1] = '5'; b[2] = 'C'; b[3] = 'D';
        b[4] = (byte) VERSION;
        b[5] = (byte) type;
        b[6] = (byte) ((id >>> 16) & 0xff);
        b[7] = (byte) ((id >>> 8) & 0xff);
        b[8] = (byte) (id & 0xff);
        return b;
    }

    private static int randomId() {
        byte[] b = Crypto.random(3);
        return ((b[0] & 0xff) << 16) | ((b[1] & 0xff) << 8) | (b[2] & 0xff);
    }

    /* --------------------------------------------------------------- encrypt */

    /** Seals one record: fresh salt and iv, AES-GCM with the record's AAD. */
    public static Sealed seal(Record rec, KeyProvider keys) throws GeneralSecurityException {
        int type = codeOf(rec.type);
        int id = rec.id != 0 ? rec.id : randomId();
        byte[] salt = Crypto.random(16);
        byte[] iv = Crypto.random(12);
        byte[] key = keys.key(rec.mode, salt);
        byte[] plain = (rec.data == null ? new JSONObject() : rec.data).toString().getBytes(StandardCharsets.UTF_8);
        byte[] ct = Crypto.gcmSeal(key, iv, plain, aad(type, id));
        Sealed s = new Sealed();
        s.id = id; s.type = rec.type; s.mode = rec.mode; s.oneTime = rec.oneTime; s.salt = salt; s.iv = iv; s.ct = ct;
        return s;
    }

    public static Record open(Sealed sealed, KeyProvider keys) throws GeneralSecurityException {
        byte[] key = keys.key(sealed.mode, sealed.salt);
        int type = codeOf(sealed.type);
        byte[] plain;
        try {
            plain = Crypto.gcmOpen(key, sealed.iv, sealed.ct, aad(type, sealed.id));
        } catch (GeneralSecurityException e) {
            throw new GeneralSecurityException(MODE_INTERNAL.equals(sealed.mode)
                ? cz.m5cet.app.core.Texts.t("nfc.m5.otherAccount", "This card was not written by this account.") : cz.m5cet.app.core.Texts.t("nfc.m5.wrongPin", "Wrong PIN, or the record is damaged."));
        }
        Record r = new Record();
        r.id = sealed.id; r.type = sealed.type; r.mode = sealed.mode; r.oneTime = sealed.oneTime;
        try {
            r.data = new JSONObject(new String(plain, StandardCharsets.UTF_8));
        } catch (JSONException e) {
            throw new GeneralSecurityException(cz.m5cet.app.core.Texts.t("nfc.m5.damaged", "The record is damaged."));
        }
        return r;
    }

    /* -------------------------------------------------------- container bytes */

    /** The container bytes for a set of sealed records (≤ 64). */
    public static byte[] encodeContainer(List<Sealed> records) {
        if (records.size() > 64) throw new IllegalArgumentException("A card holds at most 64 records.");
        ByteArrayOutputStream w = new ByteArrayOutputStream();
        w.write('M'); w.write('5'); w.write('C'); w.write('D');
        w.write(VERSION);
        w.write(0); // flags
        w.write(records.size());
        for (Sealed r : records) {
            w.write(codeOf(r.type));
            w.write(MODE_INTERNAL.equals(r.mode) ? 1 : 0);
            w.write(r.oneTime ? 1 : 0);
            w.write((r.id >>> 16) & 0xff); w.write((r.id >>> 8) & 0xff); w.write(r.id & 0xff);
            writeLenBytes(w, r.salt);
            writeLenBytes(w, r.iv);
            w.write((r.ct.length >>> 8) & 0xff); w.write(r.ct.length & 0xff);
            w.write(r.ct, 0, r.ct.length);
        }
        return w.toByteArray();
    }

    /** Whether a blob looks like an M5Cet container. */
    public static boolean isM5Card(byte[] bytes) {
        return bytes != null && bytes.length >= 7 && bytes[0] == 'M' && bytes[1] == '5' && bytes[2] == 'C' && bytes[3] == 'D';
    }

    public static List<Sealed> decodeContainer(byte[] bytes) {
        Cursor r = new Cursor(bytes);
        if (r.u8() != 'M' || r.u8() != '5' || r.u8() != 'C' || r.u8() != 'D') throw new IllegalArgumentException(cz.m5cet.app.core.Texts.t("nfc.m5.notCard", "Not an M5Cet card."));
        int ver = r.u8();
        if (ver != VERSION) throw new IllegalArgumentException("M5Cet card version " + ver + " is not supported.");
        r.u8(); // flags
        int count = r.u8();
        List<Sealed> out = new ArrayList<>();
        for (int i = 0; i < count; i++) {
            int typeCode = r.u8();
            String type = typeOf(typeCode);
            int modeCode = r.u8();
            boolean oneTime = r.u8() == 1;
            int id = (r.u8() << 16) | (r.u8() << 8) | r.u8();
            byte[] salt = r.lenBytes();
            byte[] iv = r.lenBytes();
            byte[] ct = r.take(r.u16());
            if (type == null || (modeCode != 0 && modeCode != 1)) continue; // an unknown record type is skipped, not fatal
            Sealed s = new Sealed();
            s.id = id; s.type = type; s.mode = modeCode == 0 ? MODE_EXTERNAL : MODE_INTERNAL; s.oneTime = oneTime;
            s.salt = salt; s.iv = iv; s.ct = ct;
            out.add(s);
        }
        return out;
    }

    /** The container with one sealed record removed (a one-time record after it was shown). */
    public static byte[] removeRecord(byte[] bytes, int id) {
        List<Sealed> kept = new ArrayList<>();
        for (Sealed s : decodeContainer(bytes)) if (s.id != id) kept.add(s);
        return encodeContainer(kept);
    }

    /** Builds a whole card from plaintext records in one go. */
    public static byte[] buildCard(List<Record> records, KeyProvider keys) throws GeneralSecurityException {
        List<Sealed> sealed = new ArrayList<>(records.size());
        for (Record r : records) sealed.add(seal(r, keys));
        return encodeContainer(sealed);
    }

    /* --------------------------------------------------------------- helpers */

    private static void writeLenBytes(ByteArrayOutputStream w, byte[] b) {
        w.write(b.length & 0xff);
        w.write(b, 0, b.length);
    }

    private static final class Cursor {
        private final byte[] b;
        private int at;
        Cursor(byte[] b) { this.b = b; }
        private void need(int n) { if (at + n > b.length) throw new IllegalArgumentException("M5Cet card is truncated."); }
        int u8() { need(1); return b[at++] & 0xff; }
        int u16() { return (u8() << 8) | u8(); }
        byte[] take(int n) { need(n); byte[] out = new byte[n]; System.arraycopy(b, at, out, 0, n); at += n; return out; }
        byte[] lenBytes() { return take(u8()); }
    }
}
