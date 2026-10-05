package cz.m5cet.app.p4;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Room messages in protocol 4 (docs/protocol-v4.md § 6; sender-keys4.ts):
 * sender keys with a per-chain ECDSA P-256 signing key. The owner signs
 * AAD || ciphertext with the chain's key; a receiver verifies BEFORE it
 * advances the chain, so a member who holds the chain can neither forge a
 * message nor burn indices. The chain's `cert` (the chain's own key signing
 * roomId, keyId and the owner's hello pk) binds it to its owner device: a
 * member who re-announces another member's chain as its own is refused. The
 * device key signs nothing here (F-30).
 *
 * Chains are found by (sending peer, keyId); each peer keeps its newest chain
 * and ONE older (messages in flight across a rotation).
 */
public final class SenderKeys4 {

    static final class OwnChain {
        final String keyId;
        byte[] ck;
        long index;
        final long createdAt;
        final Prim.P256 sign;
        final String cert;
        OwnChain(String keyId, byte[] ck, long createdAt, Prim.P256 sign, String cert) { this.keyId = keyId; this.ck = ck; this.createdAt = createdAt; this.sign = sign; this.cert = cert; }
    }

    static final class PeerChain {
        final String owner, ownerPk, keyId, spk;
        byte[] ck;
        long index;
        final LinkedHashMap<Long, byte[]> skipped = new LinkedHashMap<>();
        PeerChain(String owner, String ownerPk, String keyId, byte[] ck, long index, String spk) { this.owner = owner; this.ownerPk = ownerPk; this.keyId = keyId; this.ck = ck; this.index = index; this.spk = spk; }
    }

    private static String slot(String owner, String keyId) { return owner + "\u0000" + keyId; }

    /** § 6 AAD = join(LABEL.senderKey, roomId, id, keyId, n). */
    public static byte[] aad(String roomId, String id, String keyId, long n) throws P4Error {
        return Prim.join(P4.L_SENDER_KEY, roomId, id, keyId, n);
    }

    /** § 6: what a chain's `cert` signs (with the chain's spk) — join(LABEL.skCert, roomId, keyId, ownerPk). */
    public static byte[] certData(String roomId, String keyId, String ownerPk) throws P4Error {
        return Prim.join(P4.L_SK_CERT, roomId, keyId, ownerPk);
    }

    private final String roomId;
    private final String ownerPk;
    private final Rng rng;
    private OwnChain own;
    private final Map<String, PeerChain> chains = new LinkedHashMap<>();
    /** Peers that hold our current chain. */
    private final Set<String> sentTo = new HashSet<>();

    /** `ownerPk`: this device's hello pk — every chain names it in its cert. */
    public SenderKeys4(String roomId, String ownerPk, Rng rng) {
        this.roomId = roomId;
        this.ownerPk = ownerPk;
        this.rng = rng == null ? Rng.SYSTEM : rng;
    }

    /* -------------------------------------------------------- own chain */

    /** Is our chain missing or due for replacement (SENDER_KEY_ROTATE)? */
    public synchronized boolean due(long now) {
        return own == null || own.index >= P4.SENDER_KEY_ROTATE_MESSAGES || now - own.createdAt >= P4.SENDER_KEY_ROTATE_MS;
    }

    /**
     * Starts a new chain when there is none or it is due; true when it did
     * (then nobody holds it yet). Draws: "sk.keyId", "sk.chain", "sk.spk".
     */
    public synchronized boolean prepare(long now) throws P4Error {
        if (!due(now)) return false;
        String keyId = Prim.b64url(rng.bytes(12, "sk.keyId"));
        byte[] ck = rng.bytes(32, "sk.chain");
        Prim.P256 sign = rng.p256("ecdsa", "sk.spk");
        String cert = Prim.ecdsaSign(sign.privateKey, certData(roomId, keyId, ownerPk));
        if (own != null) Prim.wipe(own.ck);
        own = new OwnChain(keyId, ck, now, sign, cert);
        sentTo.clear();
        return true;
    }

    /** Drops our chain; the next prepare() starts a new one (a member left, was excluded, …). */
    public synchronized void rotate() {
        if (own != null) Prim.wipe(own.ck);
        own = null;
        sentTo.clear();
    }

    /** The current chain as an `sk` inner message for `peerId` — from its current index, nothing before. */
    public synchronized JSONObject chainFor(String peerId) throws P4Error {
        if (own == null) throw new P4Error("state", "no chain: call prepare() first");
        sentTo.add(peerId);
        try {
            return new JSONObject().put("t", "sk").put("keyId", own.keyId).put("chain", Prim.b64(own.ck)).put("index", own.index).put("spk", own.sign.spki).put("cert", own.cert);
        } catch (JSONException e) { throw new IllegalStateException(e); }
    }

    public synchronized boolean hasOurChain(String peerId) { return own != null && sentTo.contains(peerId); }

    /** The chain handed out by chainFor did not reach the peer after all (its channel refused it). */
    public synchronized void notSent(String peerId) { sentTo.remove(peerId); }

    public synchronized String currentKeyId() { return own == null ? null : own.keyId; }

    /** § 6: seals a room message (its JSON text, whose `id` must be `id`) with our current chain. */
    public synchronized JSONObject seal(String id, String payloadJson) throws P4Error {
        if (own == null) throw new P4Error("state", "no chain: call prepare() first");
        if (!Mailbox.hasId(Mailbox.object(payloadJson), id)) throw new P4Error("id-mismatch", "payload.id must be the message id");
        long n = own.index;
        byte[] a = aad(roomId, id, own.keyId, n);
        byte[][] step = Ratchet.kdfCk(own.ck);
        byte[][] keyIv = Prim.keyIv(step[0], P4.L_SENDER_KEY);
        byte[] plain = Pad.pad(Prim.utf8(payloadJson));
        byte[] c;
        try { c = Prim.aesGcmSeal(keyIv[0], keyIv[1], a, plain); } finally { Prim.wipe(step[0], keyIv[0], keyIv[1], plain); }
        String s = Prim.ecdsaSign(own.sign.privateKey, Prim.concat(a, c));
        Prim.wipe(own.ck);
        own.ck = step[1];
        own.index = n + 1;
        try { return new JSONObject().put("v", 4).put("id", id).put("sk", own.keyId).put("n", n).put("c", Prim.b64(c)).put("s", s); }
        catch (JSONException e) { throw new IllegalStateException(e); }
    }

    /* ------------------------------------------------------ peer chains */

    /**
     * A peer's chain from its `sk` inner message, delivered by the pair session
     * with `peerId` whose hello carried device key `peerPk`. Refused (false)
     * unless `cert` is the chain spk's signature over (roomId, keyId, peerPk), or
     * when that spk is already held for another owner device.
     */
    public synchronized boolean acceptChain(String peerId, String peerPk, Object raw) {
        if (!(raw instanceof JSONObject)) return false;
        JSONObject m = (JSONObject) raw;
        if (!"sk".equals(m.opt("t")) || !(m.opt("keyId") instanceof String) || !Prim.isSafeCount(m.opt("index")) || !(m.opt("spk") instanceof String) || !(m.opt("cert") instanceof String)) return false;
        String keyId = m.optString("keyId"), spk = m.optString("spk");
        byte[] ck;
        try { Prim.unb64url(keyId, 12); ck = Prim.unb64(m.opt("chain"), 32); } catch (P4Error e) { return false; }
        if (!Prim.isP256Spki(spk)) return false;
        boolean certified;
        try { certified = peerPk != null && Prim.ecdsaVerify(spk, certData(roomId, keyId, peerPk), m.optString("cert")); }
        catch (P4Error e) { certified = false; }
        if (!certified) { Prim.wipe(ck); return false; }
        for (PeerChain c : chains.values()) if (c.spk.equals(spk) && !c.ownerPk.equals(peerPk)) { Prim.wipe(ck); return false; }
        String s = slot(peerId, keyId);
        PeerChain prev = chains.get(s);
        if (prev != null) forget(prev);
        chains.put(s, new PeerChain(peerId, peerPk, keyId, ck, ((Number) m.opt("index")).longValue(), spk)); // last = newest
        List<PeerChain> older = new ArrayList<>();
        for (PeerChain c : chains.values()) if (c.owner.equals(peerId) && !c.keyId.equals(keyId)) older.add(c);
        for (int i = 0; i < older.size() - 1; i++) forget(older.get(i)); // grace for ONE older chain
        return true;
    }

    /**
     * § 6: opens a peer's room message. The signature is verified before the
     * chain moves; the chain moves only when the message decrypts. Throws
     * malformed, no-chain, signature, replay, skip, aead, id-mismatch.
     */
    public synchronized JSONObject open(String peerId, Object raw) throws P4Error {
        if (!(raw instanceof JSONObject)) throw P4Error.malformed("not a protocol-4 sender-key message");
        JSONObject e = (JSONObject) raw;
        Object v = e.opt("v");
        if (!(v instanceof Number) || ((Number) v).doubleValue() != 4 || !(e.opt("id") instanceof String) || e.optString("id").isEmpty() || !(e.opt("sk") instanceof String)
            || !Prim.isSafeCount(e.opt("n")) || !(e.opt("c") instanceof String) || !(e.opt("s") instanceof String)) {
            throw P4Error.malformed("not a protocol-4 sender-key message");
        }
        String id = e.optString("id"), sk = e.optString("sk");
        PeerChain chain = chains.get(slot(peerId, sk));
        if (chain == null) throw new P4Error("no-chain", "no chain for this sender and key id");
        long n = ((Number) e.opt("n")).longValue();
        byte[] a = aad(roomId, id, sk, n);
        byte[] c = Prim.unb64(e.opt("c"));
        if (!Prim.ecdsaVerify(chain.spk, Prim.concat(a, c), e.opt("s"))) throw new P4Error("signature", "not signed by the chain's key");

        // Derive on the side; the chain changes only after the AEAD check.
        byte[] mk;
        byte[] nextCk = null;
        List<Object[]> skippedNow = new ArrayList<>();
        List<byte[]> fresh = new ArrayList<>();
        byte[] kept = chain.skipped.get(n);
        if (kept != null) {
            mk = kept;
        } else {
            if (n < chain.index) throw new P4Error("replay", "message key already used");
            if (n - chain.index > P4.MAX_SKIP) throw new P4Error("skip", "too far ahead");
            byte[] ck = chain.ck;
            for (long i = chain.index; i < n; i++) {
                byte[][] step = Ratchet.kdfCk(ck);
                skippedNow.add(new Object[]{i, step[0]});
                if (ck != chain.ck) fresh.add(ck);
                ck = step[1];
            }
            byte[][] last = Ratchet.kdfCk(ck);
            if (ck != chain.ck) fresh.add(ck);
            mk = last[0];
            nextCk = last[1];
        }
        byte[][] keyIv = Prim.keyIv(mk, P4.L_SENDER_KEY);
        byte[] plain;
        try {
            plain = Prim.aesGcmOpen(keyIv[0], keyIv[1], a, c);
        } catch (P4Error x) {
            if (kept == null) {
                Prim.wipe(mk, nextCk);
                for (byte[] b : fresh) Prim.wipe(b);
                for (Object[] s : skippedNow) Prim.wipe((byte[]) s[1]);
            }
            throw x;
        } finally {
            Prim.wipe(keyIv[0], keyIv[1]);
        }
        // Commit.
        if (kept != null) {
            chain.skipped.remove(n);
        } else {
            Prim.wipe(chain.ck);
            for (byte[] b : fresh) Prim.wipe(b);
            chain.ck = nextCk;
            chain.index = n + 1;
            for (Object[] s : skippedNow) chain.skipped.put((Long) s[0], (byte[]) s[1]);
            while (chain.skipped.size() > P4.MAX_SKIP) {
                Iterator<Map.Entry<Long, byte[]>> it = chain.skipped.entrySet().iterator();
                Prim.wipe(it.next().getValue());
                it.remove();
            }
        }
        Prim.wipe(mk);
        JSONObject payload;
        try { payload = Mailbox.object(Prim.fromUtf8(Pad.unpad(plain))); } catch (P4Error x) { throw P4Error.malformed("body is not padded JSON"); } finally { Prim.wipe(plain); }
        if (!Mailbox.hasId(payload, id)) throw new P4Error("id-mismatch", "payload.id is not the envelope id");
        return payload;
    }

    public synchronized boolean hasChain(String peerId, String keyId) { return chains.containsKey(slot(peerId, keyId)); }

    /** Does this peer hold any chain of ours … or we any of theirs (a v4 room message can be opened)? */
    public synchronized boolean hasAnyChainOf(String peerId) {
        for (PeerChain c : chains.values()) if (c.owner.equals(peerId)) return true;
        return false;
    }

    /* -------------------------------------------------------- lifecycle */

    /** A member left or was excluded: forget their chains and drop ours (§ 6). */
    public synchronized void peerLeft(String peerId) {
        for (PeerChain c : new ArrayList<>(chains.values())) if (c.owner.equals(peerId)) forget(c);
        rotate();
    }

    /** A new pair session with `peerId` (re-hello): when it held our chain, ours is replaced (§ 6). */
    public synchronized void rehello(String peerId) {
        if (sentTo.contains(peerId)) rotate();
    }

    public synchronized void clear() {
        rotate();
        for (PeerChain c : new ArrayList<>(chains.values())) forget(c);
    }

    private void forget(PeerChain chain) {
        Prim.wipe(chain.ck);
        for (byte[] k : chain.skipped.values()) Prim.wipe(k);
        chain.skipped.clear();
        chains.remove(slot(chain.owner, chain.keyId));
    }
}
