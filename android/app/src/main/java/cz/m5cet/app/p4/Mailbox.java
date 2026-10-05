package cz.m5cet.app.p4;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.security.PrivateKey;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Messages for absent members (docs/protocol-v4.md § 7; mailbox.ts): sealed
 * for each recipient DEVICE, to that device's signed mailbox bundle (a P-256
 * key and an ML-KEM-768 key, renewed weekly):
 *
 *   ss1 = ECDH(eph, Rb.dh)          fresh per item
 *   ss2 = ECDH(Sb.dh, Rb.dh)        the sender's bundle — deniable authentication
 *   ss3 = ML-KEM.Encaps(Rb.kem)     post-quantum
 *   key, iv = HKDF(H(AAD), ss1 || ss2 || ss3, "m5cet/p4/mb", 44)
 *
 * A bundle's private keys outlive its expiry by MAILBOX_KEEP_MS and are then
 * wiped. They go through a {@link Store}; the app's store is the vault.
 */
public final class Mailbox {

    /* ------------------------------------------------------------ bundles */

    /** A signed mailbox bundle as it travels (hello `mb`, key directory, an item's `sb`). */
    public static final class Bundle {
        public final String id, dh, kem, sig;
        public final long exp;

        public Bundle(String id, String dh, String kem, long exp, String sig) { this.id = id; this.dh = dh; this.kem = kem; this.exp = exp; this.sig = sig; }

        public JSONObject json() {
            try { return new JSONObject().put("id", id).put("dh", dh).put("kem", kem).put("exp", exp).put("sig", sig); }
            catch (JSONException e) { throw new IllegalStateException(e); }
        }

        /** A bundle of the right shape (sizes, canonical base64), else null. */
        public static Bundle parse(Object value) {
            if (!(value instanceof JSONObject)) return null;
            JSONObject b = (JSONObject) value;
            Object id = b.opt("id"), dh = b.opt("dh"), kem = b.opt("kem"), exp = b.opt("exp"), sig = b.opt("sig");
            if (!(id instanceof String) || !(dh instanceof String) || !(kem instanceof String) || !Prim.isSafeCount(exp) || !(sig instanceof String)) return null;
            try {
                Prim.unb64url(id, 8);
                Prim.unb64(dh);
                Prim.unb64(kem, P4.KEM_EK);
                Prim.unb64(sig, 64);
            } catch (P4Error e) {
                return null;
            }
            return new Bundle((String) id, (String) dh, (String) kem, ((Number) exp).longValue(), (String) sig);
        }

        @Override public boolean equals(Object o) {
            if (!(o instanceof Bundle)) return false;
            Bundle x = (Bundle) o;
            return id.equals(x.id) && dh.equals(x.dh) && kem.equals(x.kem) && exp == x.exp && sig.equals(x.sig);
        }

        @Override public int hashCode() { return id.hashCode(); }
    }

    /** One own bundle with its private keys. */
    public static final class Keys {
        public final Bundle bundle;
        public final PrivateKey dh;
        public final byte[] kemDk;
        public final long created;

        public Keys(Bundle bundle, PrivateKey dh, byte[] kemDk, long created) { this.bundle = bundle; this.dh = dh; this.kemDk = kemDk; this.created = created; }

        /** For an encrypted store: the bundle, the ECDH key as PKCS#8 and the KEM key (all b64). */
        public JSONObject json() {
            try {
                return new JSONObject().put("bundle", bundle.json()).put("dh", Prim.b64(dh.getEncoded())).put("kem", Prim.b64(kemDk)).put("created", created);
            } catch (JSONException e) { throw new IllegalStateException(e); }
        }

        public static Keys parse(JSONObject o) throws P4Error {
            Bundle b = o == null ? null : Bundle.parse(o.opt("bundle"));
            if (b == null) throw P4Error.malformed("stored bundle");
            Prim.P256 dh = Prim.importP256Pkcs8(o.optString("dh"));
            if (!dh.spki.equals(b.dh)) throw P4Error.malformed("stored bundle key does not match");
            return new Keys(b, dh.privateKey, Prim.unb64(o.optString("kem"), P4.KEM_DK), o.optLong("created"));
        }
    }

    /** Where own bundles and their private keys live; the integrator encrypts them at rest. */
    public interface Store {
        List<Keys> all();
        void put(Keys keys);
        void remove(String id);
    }

    public static final class MemoryStore implements Store {
        private final Map<String, Keys> rows = new LinkedHashMap<>();
        @Override public synchronized List<Keys> all() { return new ArrayList<>(rows.values()); }
        @Override public synchronized void put(Keys keys) { rows.put(keys.bundle.id, keys); }
        @Override public synchronized void remove(String id) { rows.remove(id); }
    }

    /** § 7.1: the bytes a bundle's `sig` covers. */
    public static byte[] signedData(String id, String dh, String kem, long exp) throws P4Error {
        return Prim.join(P4.L_MAILBOX_BUNDLE, id, dh, Prim.hB64(Prim.unb64(kem)), exp);
    }

    /** Checks a peer's bundle: null when it is valid at `now`, else "malformed", "bad-signature" or "expired". */
    public static String check(Object bundle, String devicePk, long now) {
        Bundle b = Bundle.parse(bundle instanceof Bundle ? ((Bundle) bundle).json() : bundle);
        if (b == null || !Prim.isP256Spki(b.dh)) return "malformed";
        try {
            if (!Prim.ecdsaVerify(devicePk, signedData(b.id, b.dh, b.kem, b.exp), b.sig)) return "bad-signature";
        } catch (P4Error e) {
            return "malformed";
        }
        return b.exp > now ? null : "expired";
    }

    /** § 7.1: a new signed bundle. Draws: "mailbox.id", "mailbox.dh", "mailbox.kem-seed". */
    public static Keys createBundle(Prim.DeviceSigner signer, long now, Rng rng) throws P4Error {
        String id = Prim.b64url(rng.bytes(8, "mailbox.id"));
        Prim.P256 dh = rng.p256("ecdh", "mailbox.dh");
        Kem.KeyPair kem = Kem.keygen(rng, "mailbox.kem-seed");
        long exp = now + P4.MAILBOX_LIFETIME_MS;
        String kemB64 = Prim.b64(kem.ek);
        String sig = signer.sign(signedData(id, dh.spki, kemB64, exp));
        return new Keys(new Bundle(id, dh.spki, kemB64, exp, sig), dh.privateKey, kem.dk, now);
    }

    /* ------------------------------------------------------------ sealing */

    /** § 7.2 AAD. */
    public static byte[] aad(String roomId, String id, String senderPk, String senderBundleId, String recipientBundleId, String eph, String kctHash) throws P4Error {
        return Prim.join(P4.L_MAILBOX, roomId, id, senderPk, senderBundleId, recipientBundleId, eph, kctHash);
    }

    private static byte[][] itemKey(byte[] aad, byte[] ss1, byte[] ss2, byte[] ss3) {
        byte[] ikm = Prim.concat(ss1, ss2, ss3);
        byte[] okm = Prim.hkdf(Prim.H(aad), ikm, P4.L_MAILBOX, 44);
        byte[][] out = {java.util.Arrays.copyOfRange(okm, 0, 32), java.util.Arrays.copyOfRange(okm, 32, 44)};
        Prim.wipe(ikm, okm);
        return out;
    }

    static boolean hasId(Object payload, String id) {
        return payload instanceof JSONObject && id.equals(((JSONObject) payload).opt("id"));
    }

    /** The parsed JSON object of `json`, or `malformed`. */
    static JSONObject object(String json) throws P4Error {
        try { return new JSONObject(json); } catch (JSONException e) { throw P4Error.malformed("not a JSON object"); }
    }

    /**
     * § 7.2 with explicit sender keys: seals `payloadJson` (its UTF-8, padded;
     * its `id` must be `id`) for one recipient device. The recipient's bundle
     * is checked first. Draws: "mailbox.eph", "mailbox.kem-m".
     */
    public static JSONObject seal(String roomId, String id, String payloadJson, String recipientPk, Bundle recipient, String senderPk, JSONObject sacc, Keys sender, long now, Rng rng) throws P4Error {
        if (!hasId(object(payloadJson), id)) throw new P4Error("id-mismatch", "payload.id must be the message id");
        String problem = check(recipient, recipientPk, now);
        if (problem != null) throw new P4Error("expired".equals(problem) ? "expired" : "signature", "recipient bundle: " + problem);
        Prim.P256 eph = rng.p256("ecdh", "mailbox.eph");
        byte[] ss1 = Prim.ecdh(eph.privateKey, recipient.dh);
        byte[] ss2 = Prim.ecdh(sender.dh, recipient.dh);
        Kem.Encapsulated k = Kem.encaps(Prim.unb64(recipient.kem, P4.KEM_EK), rng, "mailbox.kem-m");
        byte[] a = aad(roomId, id, senderPk, sender.bundle.id, recipient.id, eph.spki, Prim.hB64(k.ct));
        byte[][] keyIv = itemKey(a, ss1, ss2, k.ss);
        byte[] plain = Pad.pad(Prim.utf8(payloadJson));
        byte[] c;
        try { c = Prim.aesGcmSeal(keyIv[0], keyIv[1], a, plain); } finally { Prim.wipe(ss1, ss2, k.ss, keyIv[0], keyIv[1], plain); }
        try {
            JSONObject item = new JSONObject().put("v", 4).put("kind", "mb").put("id", id).put("to", recipient.id).put("sb", sender.bundle.json()).put("spk", senderPk);
            if (sacc != null) item.put("sacc", sacc);
            return item.put("e", eph.spki).put("kct", Prim.b64(k.ct)).put("c", Prim.b64(c));
        } catch (JSONException e) { throw new IllegalStateException(e); }
    }

    /** An opened item: the payload, and who sent it (to check against the pins, § 7.3). */
    public static final class Opened {
        public final JSONObject payload;
        /** The sender's device key. */
        public final String spk;
        /** The sender's account attestation (check like a hello's `acc`), or null. */
        public final JSONObject sacc;
        /** The sender's bundle (verified with spk), to remember with the pin. */
        public final Bundle senderBundle;
        Opened(JSONObject payload, String spk, JSONObject sacc, Bundle senderBundle) { this.payload = payload; this.spk = spk; this.sacc = sacc; this.senderBundle = senderBundle; }
    }

    public static boolean isItem(Object v) {
        return v instanceof JSONObject && "mb".equals(((JSONObject) v).opt("kind")) && isV4(((JSONObject) v).opt("v"));
    }

    public static boolean isSet(Object v) {
        return v instanceof JSONObject && "mb-set".equals(((JSONObject) v).opt("kind")) && isV4(((JSONObject) v).opt("v"))
            && ((JSONObject) v).opt("items") instanceof JSONArray;
    }

    static boolean isV4(Object v) { return v instanceof Number && ((Number) v).doubleValue() == 4; }

    private static boolean itemShape(JSONObject m) {
        if (!isItem(m)) return false;
        for (String f : new String[]{"id", "to", "spk", "e", "kct", "c"}) if (!(m.opt(f) instanceof String)) return false;
        if (Bundle.parse(m.opt("sb")) == null) return false;
        Object sacc = m.opt("sacc");
        return sacc == null || sacc instanceof JSONObject;
    }

    /** § 7.3 with the recipient bundle's private keys. Throws on a broken item. */
    public static Opened open(JSONObject item, String roomId, Keys mine) throws P4Error {
        if (!itemShape(item)) throw P4Error.malformed("not a mailbox item");
        String id = item.optString("id"), to = item.optString("to"), spk = item.optString("spk"), e = item.optString("e");
        if (!to.equals(mine.bundle.id)) throw new P4Error("state", "item for another bundle");
        Bundle sb = Bundle.parse(item.opt("sb"));
        if (!Prim.ecdsaVerify(spk, signedData(sb.id, sb.dh, sb.kem, sb.exp), sb.sig)) throw new P4Error("signature", "sender bundle not signed by the sender key");
        byte[] kct = Prim.unb64(item.optString("kct"), P4.KEM_CT);
        byte[] c = Prim.unb64(item.optString("c"));
        byte[] ss1 = Prim.ecdh(mine.dh, e);
        byte[] ss2 = Prim.ecdh(mine.dh, sb.dh);
        byte[] ss3 = Kem.decaps(kct, mine.kemDk);
        byte[] a = aad(roomId, id, spk, sb.id, to, e, Prim.hB64(kct));
        byte[][] keyIv = itemKey(a, ss1, ss2, ss3);
        byte[] plain;
        try { plain = Prim.aesGcmOpen(keyIv[0], keyIv[1], a, c); } finally { Prim.wipe(ss1, ss2, ss3, keyIv[0], keyIv[1]); }
        JSONObject payload;
        try { payload = object(Prim.fromUtf8(Pad.unpad(plain))); } catch (P4Error x) { throw P4Error.malformed("item body is not padded JSON"); } finally { Prim.wipe(plain); }
        if (!hasId(payload, id)) throw new P4Error("id-mismatch", "payload.id is not the item id");
        Object sacc = item.opt("sacc");
        return new Opened(payload, spk, sacc instanceof JSONObject ? (JSONObject) sacc : null, sb);
    }

    /* --------------------------------------------------------------- sets */

    /** § 7.4: one message for every known device of one away account. */
    public static JSONObject set(String id, List<JSONObject> items) throws P4Error {
        if (items.isEmpty()) throw P4Error.malformed("a set holds items of one message");
        JSONArray list = new JSONArray();
        for (JSONObject m : items) {
            if (!id.equals(m.optString("id"))) throw P4Error.malformed("a set holds items of one message");
            list.put(m);
        }
        try { return new JSONObject().put("v", 4).put("kind", "mb-set").put("id", id).put("items", list); }
        catch (JSONException e) { throw new IllegalStateException(e); }
    }

    /* ------------------------------------------------------------ mailbox */

    private final Store store;
    private final Prim.DeviceSigner signer;
    private final Rng rng;

    public Mailbox(Store store, Prim.DeviceSigner signer, Rng rng) {
        this.store = store;
        this.signer = signer;
        this.rng = rng == null ? Rng.SYSTEM : rng;
    }

    /** Renews and wipes as due; returns the bundle created (or null) — the ids wiped go into `wiped`. */
    public synchronized Bundle maintain(long now, List<String> wiped) throws P4Error {
        boolean fresh = false;
        for (Keys keys : store.all()) {
            if (now >= keys.bundle.exp + P4.MAILBOX_KEEP_MS) {
                Prim.wipe(keys.kemDk);
                store.remove(keys.bundle.id);
                if (wiped != null) wiped.add(keys.bundle.id);
            } else if (keys.bundle.exp - now > P4.MAILBOX_RENEW_BEFORE_MS) {
                fresh = true;
            }
        }
        if (fresh) return null;
        Keys keys = createBundle(signer, now, rng);
        store.put(keys);
        return keys.bundle;
    }

    /** The current bundle with its keys (renewing first when due). */
    public synchronized Keys current(long now) throws P4Error {
        maintain(now, null);
        List<Keys> all = new ArrayList<>();
        for (Keys k : store.all()) if (k.bundle.exp > now) all.add(k);
        Collections.sort(all, (a, b) -> Long.compare(b.bundle.exp, a.bundle.exp));
        return all.isEmpty() ? null : all.get(0);
    }

    /** § 7.2 with our current bundle. */
    public JSONObject seal(String roomId, String id, String payloadJson, String recipientPk, Bundle recipient, JSONObject sacc, long now) throws P4Error {
        Keys mine = current(now);
        if (mine == null) throw new P4Error("state", "no mailbox bundle");
        return seal(roomId, id, payloadJson, recipientPk, recipient, signer.publicKey(), sacc, mine, now, rng);
    }

    /**
     * § 7.3: opens an item or a set; null when nothing in it is addressed to a
     * bundle of this device. Keys past exp + MAILBOX_KEEP_MS are `wiped`.
     */
    public Opened open(JSONObject value, String roomId, long now) throws P4Error {
        List<JSONObject> items = new ArrayList<>();
        if (isSet(value)) {
            JSONArray list = value.optJSONArray("items");
            String id = value.optString("id");
            for (int i = 0; i < list.length(); i++) {
                JSONObject m = list.optJSONObject(i);
                if (!isItem(m) || !id.equals(m.optString("id"))) throw P4Error.malformed("set items of another message");
                items.add(m);
            }
        } else {
            items.add(value);
        }
        Map<String, Keys> kept = new LinkedHashMap<>();
        for (Keys k : store.all()) kept.put(k.bundle.id, k);
        for (JSONObject item : items) {
            Keys mine = item == null ? null : kept.get(item.optString("to"));
            if (mine == null) continue;
            if (now >= mine.bundle.exp + P4.MAILBOX_KEEP_MS) throw new P4Error("wiped", "the bundle's keys are past their retention");
            return open(item, roomId, mine);
        }
        return null;
    }
}
