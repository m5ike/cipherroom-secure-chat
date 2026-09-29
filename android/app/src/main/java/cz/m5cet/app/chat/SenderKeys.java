package cz.m5cet.app.chat;

import org.json.JSONException;
import org.json.JSONObject;

import java.security.GeneralSecurityException;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

import cz.m5cet.app.security.Crypto;

/**
 * Pairwise channels and sender keys (client/src/lib/sender-keys.ts):
 *   hello      signed (device key) DH key + key check, per peer
 *   pair key   HKDF(ECDH, salt room, info "m5cet/pair/1|" + both device keys sorted)
 *   chain      MK = HMAC(CK, 0x01), CK' = HMAC(CK, 0x02); handed to each peer sealed with the pair key
 * Live messages use our chain; private ones the pair key; old keys are wiped.
 */
public final class SenderKeys {
    public static final int MAX_SKIP = 1000;
    public static final int ROTATE_MESSAGES = 500;
    public static final long ROTATE_MS = 60 * 60 * 1000L;

    private static byte[] mac(byte[] key, int b) { return Crypto.hmac256(key, new byte[]{(byte) b}); }

    /* ------------------------------------------------------------ own chain */

    static final class Own {
        final String keyId;
        byte[] chain;
        int index = 0;
        final long createdAt;

        Own(long now) {
            keyId = Crypto.b64url(Crypto.random(12));
            chain = Crypto.random(32);
            createdAt = now;
        }

        byte[] next() {
            byte[] key = mac(chain, 0x01);
            byte[] nextChain = mac(chain, 0x02);
            Crypto.wipe(chain);
            chain = nextChain;
            index++;
            return key;
        }

        JSONObject wire() throws JSONException {
            return new JSONObject().put("keyId", keyId).put("chain", Crypto.b64(chain)).put("index", index);
        }

        boolean due(long now) { return index >= ROTATE_MESSAGES || now - createdAt >= ROTATE_MS; }
    }

    /* --------------------------------------------------------- a peer's chain */

    static final class PeerChain {
        final String keyId;
        final String owner;
        byte[] chain;
        int index;
        final LinkedHashMap<Integer, byte[]> skipped = new LinkedHashMap<>();

        PeerChain(String keyId, String owner, byte[] chain, int index) { this.keyId = keyId; this.owner = owner; this.chain = chain; this.index = index; }

        byte[] keyFor(int n) {
            byte[] kept = skipped.remove(n);
            if (kept != null) return kept;
            if (n < index || n - index > MAX_SKIP) return null;
            while (index < n) {
                skipped.put(index, mac(chain, 0x01));
                advance();
                if (skipped.size() > MAX_SKIP) { Iterator<Integer> it = skipped.keySet().iterator(); it.next(); it.remove(); }
            }
            byte[] key = mac(chain, 0x01);
            advance();
            return key;
        }

        void advance() {
            byte[] next = mac(chain, 0x02);
            Crypto.wipe(chain);
            chain = next;
            index++;
        }

        void wipe() {
            Crypto.wipe(chain);
            for (byte[] k : skipped.values()) Crypto.wipe(k);
            skipped.clear();
        }
    }

    public static final class Pair {
        public final byte[] key;
        public final String peerPublicKey;
        Pair(byte[] key, String peerPublicKey) { this.key = key; this.peerPublicKey = peerPublicKey; }
    }

    private Own own;
    private final Map<String, PeerChain> chains = new LinkedHashMap<>();
    private final Map<String, Pair> pairs = new HashMap<>();
    private final Set<String> sentTo = new HashSet<>();

    private static byte[] helloContext(String room, String from, String to, String check, String dh) {
        return Crypto.utf8("m5cet/hello/1|" + room + "|" + from + "|" + to + "|" + check + "|" + dh);
    }

    /* ---------------------------------------------------------------- hello */

    public JSONObject hello(RoomKeys keys, ChatIdentity id, String from, String to, JSONObject user) {
        try {
            JSONObject h = new JSONObject().put("kind", "hello").put("v", 3).put("check", keys.check).put("pk", id.publicKey).put("dh", id.dhPublicKey)
                .put("sig", id.sign(helloContext(keys.room, from, to, keys.check, id.dhPublicKey)))
                .put("caps", new org.json.JSONArray());
            if (user != null) h.put("user", user);
            return h;
        } catch (JSONException e) { throw new IllegalStateException(e); }
    }

    /** null when accepted; "key-mismatch" or "bad-signature" otherwise. */
    public synchronized String acceptHello(RoomKeys keys, ChatIdentity id, JSONObject hello, String from, String to) {
        String check = hello.optString("check");
        if (!keys.check.equals(check)) return "key-mismatch";
        String pk = hello.optString("pk");
        String dh = hello.optString("dh");
        if (!cz.m5cet.app.security.Ec.verify(pk, helloContext(keys.room, from, to, check, dh), hello.optString("sig"))) return "bad-signature";
        try {
            byte[] secret = id.sharedSecret(dh);
            String a = id.publicKey, b = pk;
            String info = "m5cet/pair/1|" + (a.compareTo(b) <= 0 ? a + "|" + b : b + "|" + a);
            byte[] key = Crypto.hkdf(secret, Crypto.utf8(keys.room), Crypto.utf8(info), 32);
            Crypto.wipe(secret);
            Pair old = pairs.put(from, new Pair(key, pk));
            if (old != null) Crypto.wipe(old.key);
            sentTo.remove(from);
            return null;
        } catch (GeneralSecurityException e) {
            return "bad-signature";
        }
    }

    public synchronized boolean hasPair(String peerId) { return pairs.containsKey(peerId); }
    public synchronized Pair pairOf(String peerId) { return pairs.get(peerId); }

    /* --------------------------------------------------------- distribution */

    private Own ensureOwn(long now) {
        if (own == null || own.due(now)) rotate();
        return own;
    }

    public synchronized void rotate() {
        if (own != null) Crypto.wipe(own.chain);
        own = new Own(System.currentTimeMillis());
        sentTo.clear();
    }

    public synchronized JSONObject senderKeyFor(RoomKeys keys, String from, String to) {
        Pair pair = pairs.get(to);
        if (pair == null) return null;
        Own o = ensureOwn(System.currentTimeMillis());
        try {
            byte[] iv = Crypto.random(12);
            byte[] ct = Crypto.gcmSeal(pair.key, iv, Crypto.utf8(o.wire().toString()), Envelopes.context("sender-key", keys.room, from, to));
            sentTo.add(to);
            return new JSONObject().put("kind", "sender-key").put("v", 3).put("iv", Crypto.b64(iv)).put("ct", Crypto.b64(ct));
        } catch (JSONException e) { throw new IllegalStateException(e); }
    }

    public synchronized boolean acceptSenderKey(RoomKeys keys, JSONObject message, String from, String to) {
        Pair pair = pairs.get(from);
        if (pair == null) return false;
        try {
            byte[] plain = Crypto.gcmOpen(pair.key, Crypto.unb64(message.optString("iv")), Crypto.unb64(message.optString("ct")), Envelopes.context("sender-key", keys.room, from, to));
            JSONObject wire = new JSONObject(Crypto.str(plain));
            String keyId = wire.optString("keyId", null);
            String chain = wire.optString("chain", null);
            Object idx = wire.opt("index");
            if (keyId == null || chain == null || !(idx instanceof Integer)) return false;
            PeerChain old = chains.remove(keyId);
            if (old != null) old.wipe();
            chains.put(keyId, new PeerChain(keyId, from, Crypto.unb64(chain), (Integer) idx));
            // Older chains of the same peer go, but one stays for messages in flight.
            java.util.List<PeerChain> olderOfPeer = new java.util.ArrayList<>();
            for (PeerChain c : chains.values()) if (c.owner.equals(from) && !c.keyId.equals(keyId)) olderOfPeer.add(c);
            for (int i = 0; i < olderOfPeer.size() - 1; i++) { olderOfPeer.get(i).wipe(); chains.remove(olderOfPeer.get(i).keyId); }
            return true;
        } catch (GeneralSecurityException | JSONException | IllegalArgumentException e) {
            return false;
        }
    }

    public synchronized boolean hasOurKey(String peerId) { return own != null && sentTo.contains(peerId); }

    public synchronized void forgetPeer(String peerId) {
        Pair p = pairs.remove(peerId);
        if (p != null) Crypto.wipe(p.key);
        sentTo.remove(peerId);
        Iterator<Map.Entry<String, PeerChain>> it = chains.entrySet().iterator();
        while (it.hasNext()) { PeerChain c = it.next().getValue(); if (c.owner.equals(peerId)) { c.wipe(); it.remove(); } }
        if (own != null && own.index > 0) rotate();
    }

    public synchronized void clear() {
        if (own != null) Crypto.wipe(own.chain);
        own = null;
        for (PeerChain c : chains.values()) c.wipe();
        chains.clear();
        for (Pair p : pairs.values()) Crypto.wipe(p.key);
        pairs.clear();
        sentTo.clear();
    }

    /* -------------------------------------------------------------- messages */

    public synchronized JSONObject sealLive(RoomKeys keys, String id, JSONObject payload, ChatIdentity identity) {
        Own o = ensureOwn(System.currentTimeMillis());
        int index = o.index;
        String keyId = o.keyId;
        byte[] key = o.next();
        byte[] ctx = Envelopes.context("msg-sk", keys.room, id, keyId, index);
        String plain = Envelopes.signBody(payload.toString(), ctx, identity);
        try {
            byte[] iv = Crypto.random(12);
            byte[] ct = Crypto.gcmSeal(key, iv, Crypto.utf8(plain), ctx);
            return new JSONObject().put("v", 3).put("id", id).put("sk", keyId).put("n", index).put("iv", Crypto.b64(iv)).put("ciphertext", Crypto.b64(ct));
        } catch (JSONException e) { throw new IllegalStateException(e); } finally { Crypto.wipe(key); }
    }

    public synchronized Envelopes.Opened openLive(RoomKeys keys, JSONObject envelope, String from) throws GeneralSecurityException {
        String sk = envelope.optString("sk", null);
        PeerChain chain = sk == null ? null : chains.get(sk);
        Object n = envelope.opt("n");
        String id = envelope.optString("id", null);
        if (chain == null || !chain.owner.equals(from) || !(n instanceof Integer) || id == null) throw new GeneralSecurityException("no sender key for this message");
        byte[] key = chain.keyFor((Integer) n);
        if (key == null) throw new GeneralSecurityException("message key already used or too far ahead");
        byte[] ctx = Envelopes.context("msg-sk", keys.room, id, sk, (Integer) n);
        try {
            Envelopes.Body b = Envelopes.readBody(Envelopes.open(key, envelope.optString("iv"), envelope.optString("ciphertext"), ctx), ctx);
            JSONObject payload = Envelopes.parse(b.body);
            if (!id.equals(payload.optString("id", null))) throw new GeneralSecurityException("envelope id mismatch");
            return new Envelopes.Opened(payload, 3, b.signer);
        } finally {
            Crypto.wipe(key);
        }
    }

    public synchronized JSONObject sealPrivate(RoomKeys keys, String id, JSONObject payload, String from, String to, ChatIdentity identity) {
        Pair pair = pairs.get(to);
        if (pair == null) return null;
        byte[] ctx = Envelopes.context("msg-pair", keys.room, id, from, to);
        String plain = Envelopes.signBody(payload.toString(), ctx, identity);
        try {
            byte[] iv = Crypto.random(12);
            return new JSONObject().put("v", 3).put("id", id).put("sk", "pair").put("iv", Crypto.b64(iv)).put("ciphertext", Crypto.b64(Crypto.gcmSeal(pair.key, iv, Crypto.utf8(plain), ctx)));
        } catch (JSONException e) { throw new IllegalStateException(e); }
    }

    public synchronized Envelopes.Opened openPrivate(RoomKeys keys, JSONObject envelope, String from, String to) throws GeneralSecurityException {
        Pair pair = pairs.get(from);
        String id = envelope.optString("id", null);
        if (pair == null || id == null) throw new GeneralSecurityException("no pair key with this peer");
        byte[] ctx = Envelopes.context("msg-pair", keys.room, id, from, to);
        Envelopes.Body b = Envelopes.readBody(Envelopes.open(pair.key, envelope.optString("iv"), envelope.optString("ciphertext"), ctx), ctx);
        JSONObject payload = Envelopes.parse(b.body);
        if (!id.equals(payload.optString("id", null))) throw new GeneralSecurityException("envelope id mismatch");
        if (b.signer != null && !b.signer.publicKey.equals(pair.peerPublicKey)) throw new GeneralSecurityException("signed by another device than the pair");
        return new Envelopes.Opened(payload, 3, b.signer);
    }

    /** "sender-key", "pair" or "room". */
    public static String kind(JSONObject envelope) {
        if (envelope.optInt("v") == 3 && "pair".equals(envelope.optString("sk", null))) return "pair";
        if (envelope.optInt("v") == 3 && envelope.has("sk") && envelope.opt("n") instanceof Integer) return "sender-key";
        return "room";
    }
}
