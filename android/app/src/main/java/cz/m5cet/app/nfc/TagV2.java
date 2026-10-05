package cz.m5cet.app.nfc;

import org.json.JSONException;
import org.json.JSONObject;

import java.math.BigInteger;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.Locale;
import java.util.regex.Pattern;

import cz.m5cet.app.chat.Argon2;
import cz.m5cet.app.security.Crypto;

/**
 * NFC connection tag v2 (6.12, F-12; docs/protocol-v4.md § 16), byte for byte
 * as the web (client/src/lib/nfc/tag-v2.ts; vectors test/vectors/nfc-tag-v2.json).
 * Format 1 sealed the room under a 4–16 digit PIN — whoever read the tag once
 * could guess it offline. Format 2 never uses a PIN:
 *
 *   inv   an invitation reference: the server's origin, the invite id and a
 *         130-bit secret (26 Crockford base32 symbols); the room key stays on
 *         the server, sealed under keys from that secret (ShareInvite, the
 *         web's share links); the tag stops working when the invite runs out
 *   off   the room on the tag, AES-256-GCM under Argon2id (64 MiB, 3 passes) of
 *         a 100-bit code (20 symbols) that is NOT on the tag — shown once to
 *         the writer, typed by the reader
 *
 * body = "m5cet:nfc:v2:" + JSON, in the record application/vnd.m5cet.conn.
 * Pure Java (JVM tests).
 */
public final class TagV2 {
    private TagV2() {}

    public static final String PREFIX = "m5cet:nfc:v2:";
    public static final String V1_PREFIX = "m5cet:nfc:v1:";
    static final String LABEL = "m5cet/nfc-tag/2";
    public static final String CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    public static final int INVITE_SECRET_SYMBOLS = 26, OFFLINE_CODE_SYMBOLS = 20;
    /** The room KDF's cost (RoomKeys): what writers use. */
    public static final int WRITE_MEMORY_KIB = 64 * 1024, WRITE_PASSES = 3;
    /** What a reader accepts from a tag. */
    public static final int MIN_MEMORY_KIB = 8, MAX_MEMORY_KIB = 256 * 1024, MIN_PASSES = 1, MAX_PASSES = 10;

    private static final SecureRandom RNG = new SecureRandom();
    private static final Pattern ID22 = Pattern.compile("^[A-Za-z0-9_-]{22}$"), IV16 = Pattern.compile("^[A-Za-z0-9_-]{16}$"),
        CT = Pattern.compile("^[A-Za-z0-9_-]{24,4096}$");

    /** A tag's content that is not readable (malformed, unknown version or type, out-of-bounds cost, wrong code). */
    public static final class TagError extends GeneralSecurityException {
        public final String code;
        TagError(String code, String message) { super(message); this.code = code; }
    }

    /** A parsed v2 tag: inv (o, id, k) or off (m, i, s, n, c). */
    public static final class Tag {
        public final String t, o, id, k, s, n, c;
        public final int m, i;
        Tag(String t, String o, String id, String k, int m, int i, String s, String n, String c) {
            this.t = t; this.o = o; this.id = id; this.k = k; this.m = m; this.i = i; this.s = s; this.n = n; this.c = c;
        }
        public boolean invite() { return "inv".equals(t); }
    }

    /** What a tag opens to: the room to join; `name` a suggested name only. */
    public static final class Room {
        public final String room, passphrase, name, app;
        public Room(String room, String passphrase, String name, String app) { this.room = room; this.passphrase = passphrase; this.name = name; this.app = app; }
    }

    /* ------------------------------------------------------------ base32 */

    public static String b64url(byte[] b) { return Base64.getUrlEncoder().withoutPadding().encodeToString(b); }

    static byte[] fromB64url(String s) throws TagError {
        if (s == null || !s.matches("^[A-Za-z0-9_-]*$")) throw new TagError("card-error", "not base64url");
        try { return Base64.getUrlDecoder().decode(s); } catch (IllegalArgumentException e) { throw new TagError("card-error", "not base64url"); }
    }

    /** `n` symbols of Crockford base32, uniform (one random byte each, its low 5 bits). */
    public static String randomBase32(int n) {
        byte[] b = new byte[n];
        RNG.nextBytes(b);
        StringBuilder out = new StringBuilder(n);
        for (byte x : b) out.append(CROCKFORD.charAt(x & 31));
        return out.toString();
    }

    /**
     * The canonical form of a typed or read code: upper case; spaces, "-", ".",
     * "_" removed; O → 0, I and L → 1; then only alphabet symbols and exactly
     * `n` of them. Null otherwise (U and anything else).
     */
    public static String normalize(String input, int n) {
        if (input == null) return null;
        String s = input.toUpperCase(Locale.ROOT).replaceAll("[\\s._-]+", "").replace('O', '0').replace('I', '1').replace('L', '1');
        if (s.length() != n) return null;
        for (int i = 0; i < s.length(); i++) if (CROCKFORD.indexOf(s.charAt(i)) < 0) return null;
        return s;
    }

    /** "ABCDE-FGHJK-…" — groups of five. */
    public static String format(String code) { return code.replaceAll("(.{5})(?=.)", "$1-"); }

    public static String newCode() { return randomBase32(OFFLINE_CODE_SYMBOLS); }

    /* ------------------------------------------------------------- parse */

    /** https:// (or http:// on localhost, 127.0.0.1, [::1]) origin without path or user; null otherwise. */
    public static String safeOrigin(String value) {
        try {
            URI u = new URI(value);
            if (u.getRawUserInfo() != null || u.getHost() == null) return null;
            String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
            String host = u.getHost().toLowerCase(Locale.ROOT);
            boolean local = host.equals("localhost") || host.equals("127.0.0.1") || host.equals("[::1]") || host.equals("::1");
            if (!scheme.equals("https") && !(scheme.equals("http") && local)) return null;
            int port = u.getPort();
            boolean defaultPort = port == -1 || (scheme.equals("https") && port == 443) || (scheme.equals("http") && port == 80);
            String h = host.contains(":") && !host.startsWith("[") ? "[" + host + "]" : host;
            return scheme + "://" + h + (defaultPort ? "" : ":" + port);
        } catch (Exception e) {
            return null;
        }
    }

    /** The record body ("m5cet:nfc:v2:{…}") as a v2 tag. */
    public static Tag parse(String body) throws TagError {
        if (body == null || !body.startsWith(PREFIX)) throw new TagError("card-error", "not a v2 connection tag");
        JSONObject o;
        try { o = new JSONObject(body.substring(PREFIX.length())); } catch (JSONException e) { throw new TagError("card-error", "the tag's JSON is malformed"); }
        Object v = o.opt("v");
        if (!(v instanceof Number) || ((Number) v).doubleValue() != 2) throw new TagError("card-error", "unknown tag version");
        String t = o.optString("t");
        if ("inv".equals(t)) {
            String origin = o.opt("o") instanceof String ? safeOrigin(o.optString("o")) : null;
            String k = o.opt("k") instanceof String ? normalize(o.optString("k"), INVITE_SECRET_SYMBOLS) : null;
            if (origin == null || !(o.opt("id") instanceof String) || !ID22.matcher(o.optString("id")).matches() || k == null) throw new TagError("card-error", "a malformed invitation tag");
            return new Tag("inv", origin, o.optString("id"), k, 0, 0, null, null, null);
        }
        if ("off".equals(t)) {
            Object m = o.opt("m"), i = o.opt("i"), p = o.opt("p");
            if (!"argon2id".equals(o.opt("kdf")) || !isInt(p) || ((Number) p).intValue() != 1 || !isInt(m) || !isInt(i)) throw new TagError("card-error", "an unknown key derivation");
            int mem = ((Number) m).intValue(), passes = ((Number) i).intValue();
            if (mem < MIN_MEMORY_KIB || mem > MAX_MEMORY_KIB || passes < MIN_PASSES || passes > MAX_PASSES) throw new TagError("card-error", "the tag's key derivation is out of bounds");
            String s = o.opt("s") instanceof String ? o.optString("s") : "", n = o.opt("n") instanceof String ? o.optString("n") : "", c = o.opt("c") instanceof String ? o.optString("c") : "";
            if (!ID22.matcher(s).matches() || !IV16.matcher(n).matches() || !CT.matcher(c).matches()) throw new TagError("card-error", "a malformed offline tag");
            return new Tag("off", null, null, null, mem, passes, s, n, c);
        }
        throw new TagError("card-error", "unknown tag type");
    }

    private static boolean isInt(Object v) {
        if (!(v instanceof Number)) return false;
        double d = ((Number) v).doubleValue();
        return d == Math.rint(d) && Math.abs(d) < 1e9;
    }

    /** A JSON string as JavaScript's JSON.stringify writes it (org.json escapes "/" and more). */
    static String quote(String s) {
        StringBuilder b = new StringBuilder(s.length() + 2).append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\b': b.append("\\b"); break;
                case '\f': b.append("\\f"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    boolean lone = Character.isSurrogate(c) && !(Character.isHighSurrogate(c) && i + 1 < s.length() && Character.isLowSurrogate(s.charAt(i + 1)))
                        && !(Character.isLowSurrogate(c) && i > 0 && Character.isHighSurrogate(s.charAt(i - 1)));
                    if (c < 0x20 || lone) b.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
                    else b.append(c);
            }
        }
        return b.append('"').toString();
    }

    /** The record body: the prefix + JSON with the keys in § 16's order, no spaces. */
    public static String serialize(Tag tag) {
        if (tag.invite()) return PREFIX + "{\"v\":2,\"t\":\"inv\",\"o\":" + quote(tag.o) + ",\"id\":" + quote(tag.id) + ",\"k\":" + quote(tag.k) + "}";
        return PREFIX + "{\"v\":2,\"t\":\"off\",\"kdf\":\"argon2id\",\"m\":" + tag.m + ",\"i\":" + tag.i + ",\"p\":1,\"s\":" + quote(tag.s) + ",\"n\":" + quote(tag.n) + ",\"c\":" + quote(tag.c) + "}";
    }

    /* ------------------------------------------------------------ invite */

    /** § 16.3: {linkKey (32 B), code (12 digits)} of an invite — HKDF-SHA256(ikm = ASCII(k), salt = ASCII(id)). */
    public static Object[] inviteKeys(String id, String k) throws TagError {
        String secret = normalize(k, INVITE_SECRET_SYMBOLS);
        if (secret == null || id == null || !ID22.matcher(id).matches()) throw new TagError("invalid-argument", "a bad invitation id or secret");
        byte[] ikm = secret.getBytes(StandardCharsets.US_ASCII), salt = id.getBytes(StandardCharsets.US_ASCII);
        byte[] linkKey = Crypto.hkdf(ikm, salt, Crypto.utf8(LABEL + "/link"), 32);
        byte[] raw = Crypto.hkdf(ikm, salt, Crypto.utf8(LABEL + "/code"), 8);
        String code = new BigInteger(1, raw).mod(BigInteger.valueOf(1_000_000_000_000L)).toString();
        while (code.length() < 12) code = "0" + code;
        return new Object[]{linkKey, code};
    }

    /** A new invitation tag for the server at `origin` (the invite is then created there with inviteKeys). */
    public static Tag newInvite(String origin) throws TagError {
        String o = safeOrigin(origin);
        if (o == null) throw new TagError("invalid-argument", "the server's origin is not https");
        byte[] id = new byte[16];
        RNG.nextBytes(id);
        return new Tag("inv", o, b64url(id), randomBase32(INVITE_SECRET_SYMBOLS), 0, 0, null, null, null);
    }

    /* ----------------------------------------------------------- offline */

    static byte[] offlineAad(int m, int i, String s) { return Crypto.utf8(LABEL + "|off|argon2id|" + m + "|" + i + "|1|" + s); }

    /** § 16.4: K = Argon2id(v 0x13, password = ASCII(code), salt = ASCII(s as written), t = i, m = m, p = 1, 32 bytes). */
    public static byte[] offlineKey(String code, int m, int i, String s) {
        return Argon2.argon2id(code.getBytes(StandardCharsets.US_ASCII), s.getBytes(StandardCharsets.US_ASCII), i, m, 1, 32, null, null);
    }

    /** The room sealed for an offline tag under `code` (a canonical 20-symbol code); salt and IV given for tests, else random. */
    public static Tag sealOffline(Room room, String code, int m, int i, byte[] salt, byte[] iv) throws TagError {
        if (room.room == null || room.room.isEmpty() || room.passphrase == null || room.passphrase.isEmpty()) throw new TagError("invalid-argument", "a connection tag needs a room and a key");
        String canonical = normalize(code, OFFLINE_CODE_SYMBOLS);
        if (canonical == null) throw new TagError("invalid-argument", "the code is not 20 base32 symbols");
        if (salt == null) { salt = new byte[16]; RNG.nextBytes(salt); }
        if (iv == null) { iv = new byte[12]; RNG.nextBytes(iv); }
        String s = b64url(salt);
        StringBuilder plain = new StringBuilder("{\"room\":").append(quote(room.room)).append(",\"passphrase\":").append(quote(room.passphrase));
        if (room.name != null && !room.name.isEmpty()) plain.append(",\"name\":").append(quote(room.name));
        if (room.app != null && !room.app.isEmpty()) plain.append(",\"app\":").append(quote(room.app));
        plain.append('}');
        byte[] key = offlineKey(canonical, m, i, s);
        try {
            byte[] ct = Crypto.gcmSeal(key, iv, Crypto.utf8(plain.toString()), offlineAad(m, i, s));
            return new Tag("off", null, null, null, m, i, s, b64url(iv), b64url(ct));
        } finally {
            Crypto.wipe(key);
        }
    }

    /** Opens an offline tag with the code the writer was shown; a wrong code or a changed tag fails ("auth-failed"). */
    public static Room openOffline(Tag tag, String codeInput) throws TagError {
        String code = normalize(codeInput, OFFLINE_CODE_SYMBOLS);
        if (code == null) throw new TagError("invalid-argument", "the code is 20 base32 symbols");
        byte[] key = offlineKey(code, tag.m, tag.i, tag.s);
        byte[] plain;
        try {
            plain = Crypto.gcmOpen(key, fromB64url(tag.n), fromB64url(tag.c), offlineAad(tag.m, tag.i, tag.s));
        } catch (GeneralSecurityException e) {
            throw new TagError("auth-failed", "wrong code, or the tag was changed");
        } finally {
            Crypto.wipe(key);
        }
        try {
            JSONObject o = new JSONObject(new String(plain, StandardCharsets.UTF_8));
            if (!(o.opt("room") instanceof String) || !(o.opt("passphrase") instanceof String) || o.optString("room").isEmpty() || o.optString("passphrase").isEmpty()) throw new TagError("card-error", "the tag does not hold a room");
            return new Room(o.optString("room"), o.optString("passphrase"), o.opt("name") instanceof String ? o.optString("name") : "", o.opt("app") instanceof String ? o.optString("app") : "");
        } catch (JSONException e) {
            throw new TagError("card-error", "the tag does not hold a room");
        } finally {
            Crypto.wipe(plain);
        }
    }
}
