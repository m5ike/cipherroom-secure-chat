package cz.m5cet.app.chat;

import org.json.JSONException;
import org.json.JSONObject;

import java.security.GeneralSecurityException;

import cz.m5cet.app.security.Crypto;
import cz.m5cet.app.security.Ec;

/**
 * Chat envelopes, sealed signals and file bodies (client/src/lib/envelope.ts):
 * AES-256-GCM with the context "m5cet/2|purpose|…" as associated data, a
 * body signed inside the encryption with the device's identity.
 */
public final class Envelopes {
    private Envelopes() {}

    public static byte[] context(Object... parts) {
        StringBuilder sb = new StringBuilder("m5cet/2");
        for (Object p : parts) sb.append('|').append(p instanceof Double && (Double) p == Math.rint((Double) p) ? String.valueOf(((Double) p).longValue()) : String.valueOf(p));
        return Crypto.utf8(sb.toString());
    }

    public static final class Signer {
        public final String publicKey;
        public final boolean valid;
        public final String accountKey;
        public final boolean accountValid;
        Signer(String publicKey, boolean valid, String accountKey, boolean accountValid) {
            this.publicKey = publicKey; this.valid = valid; this.accountKey = accountKey; this.accountValid = accountValid;
        }
    }

    public static final class Body {
        public final String body;
        public final Signer signer;
        Body(String body, Signer signer) { this.body = body; this.signer = signer; }
    }

    public static final class Opened {
        public final JSONObject payload;
        public final int version;
        public final Signer signer;
        Opened(JSONObject payload, int version, Signer signer) { this.payload = payload; this.version = version; this.signer = signer; }
    }

    /* ------------------------------------------------------------ bodies */

    public static String signBody(String body, byte[] ctx, ChatIdentity identity) {
        try {
            JSONObject inner = new JSONObject().put("b", body);
            if (identity != null) {
                inner.put("pk", identity.publicKey);
                inner.put("s", identity.sign(Crypto.concat(ctx, Crypto.utf8(body))));
            }
            return inner.toString();
        } catch (JSONException e) { throw new IllegalStateException(e); }
    }

    public static Body readBody(String plain, byte[] ctx) throws GeneralSecurityException {
        try {
            JSONObject inner = new JSONObject(plain);
            Object b = inner.opt("b");
            if (!(b instanceof String)) throw new GeneralSecurityException("malformed body");
            String body = (String) b;
            String pk = inner.optString("pk", null);
            String s = inner.optString("s", null);
            if (pk != null && s != null) {
                boolean valid = Ec.verify(pk, Crypto.concat(ctx, Crypto.utf8(body)), s);
                String apk = inner.optString("apk", null);
                String ac = inner.optString("ac", null);
                boolean accountValid = valid && apk != null && ac != null && verifyDeviceCert(apk, ac, pk);
                return new Body(body, new Signer(pk, valid, apk, accountValid));
            }
            return new Body(body, null);
        } catch (JSONException e) {
            throw new GeneralSecurityException("malformed body", e);
        }
    }

    /** identity.ts verifyDeviceCert (v1). 6.12: Ed25519 through Bouncy Castle — on every Android, not only 13+. */
    static boolean verifyDeviceCert(String accountKey, String cert, String devicePublicKey) {
        return cz.m5cet.app.p4.Handshake.verifyDeviceCertV1(accountKey, cert, devicePublicKey);
    }

    static JSONObject sealed(byte[] key, byte[] plain, byte[] ctx) {
        try {
            byte[] iv = Crypto.random(12);
            return new JSONObject().put("iv", Crypto.b64(iv)).put("ciphertext", Crypto.b64(Crypto.gcmSeal(key, iv, plain, ctx)));
        } catch (JSONException e) { throw new IllegalStateException(e); }
    }

    static String open(byte[] key, String iv, String ciphertext, byte[] ctx) throws GeneralSecurityException {
        try {
            return Crypto.str(Crypto.gcmOpen(key, Crypto.unb64(iv), Crypto.unb64(ciphertext), ctx));
        } catch (IllegalArgumentException e) {
            throw new GeneralSecurityException("bad base64", e);
        }
    }

    /* ---------------------------------------------------------- messages */

    /** Sealed with the room's message key (relayed, queued, 3.0 peers). */
    public static JSONObject sealMessage(RoomKeys keys, String id, JSONObject payload, ChatIdentity identity) {
        byte[] ctx = context("msg", keys.room, id);
        String plain = signBody(payload.toString(), ctx, identity);
        try {
            return sealed(keys.message, Crypto.utf8(plain), ctx).put("v", keys.version).put("id", id);
        } catch (JSONException e) { throw new IllegalStateException(e); }
    }

    /**
     * Opens a protocol-3 room envelope (v: 3). 6.12 (protocol 4 § 1, F-20):
     * envelope versions 1 and 2 — only clients older than 3.1 made them — are
     * no longer opened.
     */
    public static Opened openMessage(RoomKeys keys, JSONObject envelope) throws GeneralSecurityException {
        int v = envelope.optInt("v", 1);
        if (v != 3) throw new GeneralSecurityException("envelope version " + v + " is no longer opened");
        if (v != keys.version) throw new GeneralSecurityException("envelope from another key version");
        String id = envelope.optString("id", "");
        if (id.isEmpty()) throw new GeneralSecurityException("envelope without id");
        byte[] ctx = context("msg", keys.room, id);
        Body b = readBody(open(keys.message, envelope.optString("iv"), envelope.optString("ciphertext"), ctx), ctx);
        JSONObject payload = parse(b.body);
        if (!id.equals(payload.optString("id", null))) throw new GeneralSecurityException("envelope id mismatch");
        return new Opened(payload, v, b.signer);
    }

    public static JSONObject parse(String json) throws GeneralSecurityException {
        try { return new JSONObject(json); } catch (JSONException e) { throw new GeneralSecurityException("not a JSON payload", e); }
    }

    /* ----------------------------------------------------------- signals */

    public static JSONObject sealSignal(RoomKeys keys, String from, String to, JSONObject payload) {
        try {
            JSONObject s = sealed(keys.signal, Crypto.utf8(payload.toString()), context("signal", keys.room, from, to)).put("v", 2);
            return new JSONObject().put("sealed", s);
        } catch (JSONException e) { throw new IllegalStateException(e); }
    }

    public static JSONObject openSignal(RoomKeys keys, String from, String to, JSONObject sealed) throws GeneralSecurityException {
        if (sealed == null || sealed.optInt("v") != 2) throw new GeneralSecurityException("not a sealed signal");
        return parse(open(keys.signal, sealed.optString("iv"), sealed.optString("ciphertext"), context("signal", keys.room, from, to)));
    }

    /* ------------------------------------------------------------- files */

    public static byte[] fileMetaContext(String transferId) { return context("file-meta", transferId); }
    public static byte[] fileChunkContext(String transferId, int seq, int total) { return context("chunk", transferId, seq, total); }
    public static byte[] fileEndContext(String transferId) { return context("file-end", transferId); }

    public static JSONObject sealFileBody(byte[] fileKey, byte[] ctx, JSONObject value, ChatIdentity identity) {
        return sealed(fileKey, Crypto.utf8(signBody(value.toString(), ctx, identity)), ctx);
    }

    public static JSONObject openFileBody(byte[] fileKey, byte[] ctx, String iv, String ciphertext) throws GeneralSecurityException {
        return parse(readBody(open(fileKey, iv, ciphertext, ctx), ctx).body);
    }

    /** A file frame's body with its signer (the end must be signed by the meta's signer). */
    public static Body openFileBodyFull(byte[] fileKey, byte[] ctx, String iv, String ciphertext) throws GeneralSecurityException {
        return readBody(open(fileKey, iv, ciphertext, ctx), ctx);
    }

    public static JSONObject sealChunk(byte[] fileKey, byte[] ctx, byte[] data) {
        return sealed(fileKey, data, ctx);
    }

    public static byte[] openChunk(byte[] fileKey, byte[] ctx, String iv, String ciphertext) throws GeneralSecurityException {
        return Crypto.gcmOpen(fileKey, Crypto.unb64(iv), Crypto.unb64(ciphertext), ctx);
    }
}
