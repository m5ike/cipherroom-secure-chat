package cz.m5cet.app.p4;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Hub join proof (docs/protocol-v4.md § 13, G-09; hub-proof.ts). A join
 * carries a proof that the joiner knows the room KEY: an Ed25519 key pair
 * derived from the room secret (hubSeed = RoomKeys.derive("m5cet/hub-auth/4",
 * 32 bytes)) signs the server's per-socket nonce. The server learns only the
 * public key (the room's verifier).
 */
public final class HubProof {
    private HubProof() {}

    /** The room's hub public key (raw 32 bytes, b64) — the same in every member's client. */
    public static String pub(byte[] seed) throws P4Error { return Prim.b64(Prim.ed25519Public(seed)); }

    /** § 13: the bytes the proof signs. The nonce is the server's: b64url of 24 bytes. */
    public static byte[] joinData(String roomId, String nonce) throws P4Error {
        Prim.unb64url(nonce, 24);
        return Prim.join(P4.L_HUB_JOIN, roomId, nonce);
    }

    /** § 13: the `proof` of a join frame: {pub, sig}. */
    public static JSONObject build(byte[] seed, String roomId, String nonce) throws P4Error {
        byte[] sig = Prim.ed25519Sign(seed, joinData(roomId, nonce));
        try { return new JSONObject().put("pub", pub(seed)).put("sig", Prim.b64(sig)); }
        catch (JSONException e) { throw new IllegalStateException(e); }
    }

    /** Server side (and tests): does `sig` prove the key behind `pub` for this room and nonce? Never throws. */
    public static boolean verify(String pub, String sig, String roomId, String nonce) {
        try {
            Prim.unb64(pub, 32);
            Prim.unb64(sig, 64);
            return Prim.ed25519Verify(pub, joinData(roomId, nonce), sig);
        } catch (P4Error e) {
            return false;
        }
    }
}
