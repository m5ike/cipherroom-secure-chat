package cz.m5cet.app.nfc;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.Base64;

import cz.m5cet.app.net.Server;
import cz.m5cet.app.security.Crypto;

/**
 * 6.12: the server side of an NFC invitation tag (docs/protocol-v4.md § 16.3) —
 * an ordinary invite (server/share.ts, the web's lib/share-link.ts) made with
 * the id, link key and code the tag's secret derives (TagV2.inviteKeys):
 *
 *   proof   = b64url(PBKDF2-SHA256(code, "m5cet:share:v1:proof:" + id, 200 000, 32))
 *   wrapKey = HKDF(salt = id, linkKey ‖ serverKey ‖ PBKDF2(code, "m5cet:share:v1:enc:" + id), "m5cet:share:v1:wrap", 32)
 *   payload {v:1, room, passphrase, name, createdAt, server?} under AES-256-GCM(wrapKey), AAD = id
 *
 * The server keeps only what it cannot open. The crypto is pure (JVM tests);
 * create / redeem are blocking HTTP calls (a background thread).
 */
public final class ShareInvite {
    private ShareInvite() {}

    static final int PBKDF2_ITERATIONS = 200_000;
    /** Writers' defaults: 10 uses, 7 days (the server's maximum). */
    public static final int DEFAULT_USES = 10;
    public static final int DEFAULT_TTL_SEC = 7 * 24 * 3600;
    private static final SecureRandom RNG = new SecureRandom();

    static String b64url(byte[] b) { return Base64.getUrlEncoder().withoutPadding().encodeToString(b); }

    static byte[] fromB64url(String s) { return Base64.getUrlDecoder().decode(s); }

    static byte[] pbkdf2(String code, String salt) {
        return Crypto.pbkdf2(Crypto.utf8(code), Crypto.utf8(salt), PBKDF2_ITERATIONS, 32);
    }

    /** What the server checks (another salt than the encryption's). */
    public static String proof(String code, String id) {
        byte[] p = pbkdf2(code, "m5cet:share:v1:proof:" + id);
        try { return b64url(p); } finally { Crypto.wipe(p); }
    }

    static byte[] wrapKey(String code, String id, byte[] linkKey, byte[] serverKey) {
        byte[] codeKey = pbkdf2(code, "m5cet:share:v1:enc:" + id);
        byte[] ikm = Crypto.concat(linkKey, serverKey, codeKey);
        try { return Crypto.hkdf(ikm, Crypto.utf8(id), Crypto.utf8("m5cet:share:v1:wrap"), 32); }
        finally { Crypto.wipe(codeKey); Crypto.wipe(ikm); }
    }

    /** The sealed payload {iv, ciphertext} (b64url). */
    static String[] seal(String code, String id, byte[] linkKey, byte[] serverKey, JSONObject payload) {
        byte[] key = wrapKey(code, id, linkKey, serverKey);
        byte[] iv = new byte[12];
        RNG.nextBytes(iv);
        try { return new String[]{b64url(iv), b64url(Crypto.gcmSeal(key, iv, Crypto.utf8(payload.toString()), Crypto.utf8(id)))}; }
        finally { Crypto.wipe(key); }
    }

    /** Opens what the server answered; the payload must be {v:1, room, passphrase, name}. */
    static TagV2.Room open(String code, String id, byte[] linkKey, byte[] serverKey, String iv, String ciphertext) throws GeneralSecurityException {
        byte[] key = wrapKey(code, id, linkKey, serverKey);
        byte[] plain;
        try { plain = Crypto.gcmOpen(key, fromB64url(iv), fromB64url(ciphertext), Crypto.utf8(id)); }
        catch (IllegalArgumentException e) { throw new GeneralSecurityException("bad payload"); }
        finally { Crypto.wipe(key); }
        try {
            JSONObject o = new JSONObject(new String(plain, StandardCharsets.UTF_8));
            if (o.optInt("v") != 1 || !(o.opt("room") instanceof String) || !(o.opt("passphrase") instanceof String) || !(o.opt("name") instanceof String)) throw new GeneralSecurityException("bad payload");
            String server = o.optString("server", "");
            // A room on another signaling server is joined there — the app joins through its own only.
            if (!server.isEmpty()) throw new GeneralSecurityException("the invitation is for another server (" + server + ")");
            return new TagV2.Room(o.optString("room"), o.optString("passphrase"), o.optString("name"), "");
        } catch (JSONException e) {
            throw new GeneralSecurityException("bad payload");
        } finally {
            Crypto.wipe(plain);
        }
    }

    /** What a created invite gives the writer: the token that ends it early, its limits. */
    public static final class Created {
        public final String revokeToken;
        public final long expiresAt;
        public final int maxUses;
        Created(String revokeToken, long expiresAt, int maxUses) { this.revokeToken = revokeToken; this.expiresAt = expiresAt; this.maxUses = maxUses; }
    }

    /** POST <o>/api/share/create for an invitation tag (blocking). */
    public static Created create(TagV2.Tag tag, TagV2.Room room, String name, int maxUses, int ttlSec) throws IOException, GeneralSecurityException {
        Object[] keys = TagV2.inviteKeys(tag.id, tag.k);
        byte[] linkKey = (byte[]) keys[0];
        String code = (String) keys[1];
        byte[] serverKey = new byte[32], revoke = new byte[32];
        RNG.nextBytes(serverKey);
        RNG.nextBytes(revoke);
        try {
            JSONObject payload = new JSONObject().put("v", 1).put("room", room.room).put("passphrase", room.passphrase)
                .put("name", name == null || name.trim().isEmpty() ? "guest" : name.trim()).put("createdAt", System.currentTimeMillis());
            String[] sealed = seal(code, tag.id, linkKey, serverKey, payload);
            JSONObject body = new JSONObject().put("id", tag.id).put("proof", proof(code, tag.id)).put("revokeToken", b64url(revoke)).put("serverKey", b64url(serverKey))
                .put("iv", sealed[0]).put("ciphertext", sealed[1]).put("maxUses", maxUses).put("ttlSec", ttlSec);
            JSONObject answer = new JSONObject(new String(Server.send(tag.o + "/api/share/create", "POST", Crypto.utf8(body.toString()), null, null, 64 * 1024), StandardCharsets.UTF_8));
            if (!answer.optBoolean("ok")) throw new IOException(answer.optString("reason", "the server did not make the invitation"));
            return new Created(b64url(revoke), answer.optLong("expiresAt"), answer.optInt("maxUses", maxUses));
        } catch (JSONException e) {
            throw new IOException("the server's answer is not JSON");
        } finally {
            Crypto.wipe(linkKey);
            Crypto.wipe(serverKey);
        }
    }

    /** POST <o>/api/share/redeem for an invitation tag (blocking): the room, or an error saying why not. */
    public static TagV2.Room redeem(TagV2.Tag tag) throws IOException, GeneralSecurityException {
        Object[] keys = TagV2.inviteKeys(tag.id, tag.k);
        byte[] linkKey = (byte[]) keys[0];
        String code = (String) keys[1];
        try {
            JSONObject body = new JSONObject().put("id", tag.id).put("proof", proof(code, tag.id));
            JSONObject answer;
            try {
                answer = new JSONObject(new String(Server.send(tag.o + "/api/share/redeem", "POST", Crypto.utf8(body.toString()), null, null, 64 * 1024), StandardCharsets.UTF_8));
            } catch (Server.HttpError e) {
                String reason = e.body == null ? "" : e.body.optString("reason", "");
                throw new IOException(reason.isEmpty() ? "not-found" : reason);
            }
            if (!answer.optBoolean("ok")) throw new IOException(answer.optString("reason", "not-found"));
            return open(code, tag.id, linkKey, fromB64url(answer.optString("serverKey")), answer.optString("iv"), answer.optString("ciphertext"));
        } catch (JSONException | IllegalArgumentException e) {
            throw new IOException("the server's answer is not usable");
        } finally {
            Crypto.wipe(linkKey);
        }
    }
}
