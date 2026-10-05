package cz.m5cet.app.p4;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

import cz.m5cet.app.security.Crypto;

/**
 * Where protocol 4 gets its randomness (rng.ts). Every random value — ephemeral
 * and ratchet P-256 keys, ML-KEM seeds and encapsulation messages, nonces,
 * chain keys, ids — is drawn through an Rng: {@link #SYSTEM} in the app, a
 * {@link Tape} in the vector tests, which replays the draws the web reference
 * recorded (bytes as b64, P-256 private keys as PKCS#8) and fails at once,
 * naming the draw, when this port draws in another order (§ 0).
 */
public interface Rng {
    /** `n` random bytes; `what` names the draw. */
    byte[] bytes(int n, String what) throws P4Error;

    /** A fresh P-256 key pair; `use` is "ecdh" or "ecdsa" (one key type in Java, kept for the tape). */
    Prim.P256 p256(String use, String what) throws P4Error;

    Rng SYSTEM = new Rng() {
        @Override public byte[] bytes(int n, String what) { return Crypto.random(n); }
        @Override public Prim.P256 p256(String use, String what) { return Prim.generateP256(); }
    };

    /** Replays a recorded tape; a draw of another kind, label or length than recorded throws `state`. */
    final class Tape implements Rng {
        private final JSONArray tape;
        private int at = 0;

        public Tape(JSONArray tape) { this.tape = tape; }

        public int remaining() { return tape.length() - at; }

        private JSONObject take(String what) throws P4Error {
            JSONObject entry = tape.optJSONObject(at);
            if (entry == null) throw new P4Error("state", "tape exhausted at draw \"" + what + "\"");
            if (!what.equals(entry.optString("what"))) throw new P4Error("state", "tape draw " + at + " is \"" + entry.optString("what") + "\", wanted \"" + what + "\"");
            at++;
            return entry;
        }

        @Override public byte[] bytes(int n, String what) throws P4Error {
            JSONObject entry = take(what);
            if (!entry.has("bytes")) throw new P4Error("state", "tape draw \"" + what + "\" is not bytes");
            byte[] out = Prim.unb64(entry.optString("bytes"));
            if (out.length != n) throw new P4Error("state", "tape draw \"" + what + "\" has " + out.length + " bytes, wanted " + n);
            return out;
        }

        @Override public Prim.P256 p256(String use, String what) throws P4Error {
            JSONObject entry = take(what);
            if (!use.equals(entry.optString("p256"))) throw new P4Error("state", "tape draw \"" + what + "\" is not a P-256 " + use + " key");
            Prim.P256 pair = Prim.importP256Pkcs8(entry.optString("pkcs8"));
            if (!pair.spki.equals(entry.optString("spki"))) throw new P4Error("state", "tape draw \"" + what + "\": public key does not match");
            return pair;
        }
    }

    /** Draws real randomness and records it, in the vectors' tape format (Java↔Java tests). */
    final class Recording implements Rng {
        public final List<JSONObject> tape = new ArrayList<>();

        @Override public byte[] bytes(int n, String what) {
            byte[] out = Crypto.random(n);
            try { tape.add(new JSONObject().put("what", what).put("bytes", Prim.b64(out))); } catch (org.json.JSONException ignored) { }
            return out.clone();
        }

        @Override public Prim.P256 p256(String use, String what) {
            Prim.P256 pair = Prim.generateP256();
            try { tape.add(new JSONObject().put("what", what).put("p256", use).put("pkcs8", pair.pkcs8()).put("spki", pair.spki)); } catch (org.json.JSONException ignored) { }
            return pair;
        }

        public JSONArray json() { return new JSONArray(tape); }
    }
}
