package cz.m5cet.app.p4;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.Arrays;
import java.util.Iterator;

/**
 * Protocol 4 handshake (docs/protocol-v4.md §§ 2–4; handshake.ts): the hello
 * v4, the KEM message that answers it, and the key schedule that seeds the
 * pair ratchet. Each side sends ONE hello per data-channel open — the
 * protocol-3 fields and signature unchanged (a 6.11 peer reads it as protocol
 * 3), plus a fresh ephemeral P-256 key `e`, a fresh ML-KEM-768 key `k`, a nonce
 * `n`, its mailbox bundle, its account attestation, its newest KT tree head and
 * `sig4`. The session secret mixes ECDH(e, e') with BOTH KEM secrets under a
 * transcript hash of everything both hellos and both KEM ciphertexts said.
 */
public final class Handshake {
    private Handshake() {}

    /** The private halves of one hello; memory only, wiped once the session exists or the channel closes. */
    public static final class Secrets {
        public final Prim.P256 e;
        public final Kem.KeyPair k;
        Secrets(Prim.P256 e, Kem.KeyPair k) { this.e = e; this.k = k; }
        public void wipe() { Prim.wipe(k.dk); }
    }

    public static final class Built {
        public final JSONObject hello;
        public final Secrets secrets;
        Built(JSONObject hello, Secrets secrets) { this.hello = hello; this.secrets = secrets; }
    }

    /* ------------------------------------------------------------ digests */

    static boolean isNull(Object v) { return v == null || v == JSONObject.NULL; }

    /** § 2 mbDigest: b64(H(join(mb.id, mb.dh, b64(H(kem bytes)), mb.exp, mb.sig))), or "-". */
    public static String mbDigest(Object mb) throws P4Error {
        if (isNull(mb)) return "-";
        if (!(mb instanceof JSONObject)) throw P4Error.malformed("mb");
        JSONObject b = (JSONObject) mb;
        return Prim.hB64(Prim.join(str(b, "id"), str(b, "dh"), Prim.hB64(Prim.unb64(b.opt("kem"))), Prim.count(b.opt("exp")), str(b, "sig")));
    }

    /** § 2 accDigest: b64(H(join(acc.apk, acc.ac, acc.cv ?? 1, acc.exp ?? 0))), or "-". */
    public static String accDigest(Object acc) throws P4Error {
        if (isNull(acc)) return "-";
        if (!(acc instanceof JSONObject)) throw P4Error.malformed("acc");
        JSONObject a = (JSONObject) acc;
        Object cv = a.opt("cv"), exp = a.opt("exp");
        return Prim.hB64(Prim.join(str(a, "apk"), str(a, "ac"), cv == null ? 1L : Prim.count(cv), exp == null ? 0L : Prim.count(exp)));
    }

    static String str(JSONObject o, String field) throws P4Error {
        Object v = o.opt(field);
        if (!(v instanceof String)) throw P4Error.malformed(field);
        return (String) v;
    }

    /** § 2: the bytes `sig4` signs. `from` is the hello's sender, `to` its recipient. */
    public static byte[] sig4Data(String roomId, String from, String to, JSONObject h) throws P4Error {
        return Prim.join(P4.L_HELLO, roomId, from, to, str(h, "check"), str(h, "pk"), str(h, "dh"), str(h, "e"),
            Prim.hB64(Prim.unb64(h.opt("k"))), str(h, "n"), mbDigest(h.opt("mb")), accDigest(h.opt("acc")));
    }

    /** § 3: r = b64(H(join(e, b64(H(k)), n))) — names the hello a KEM message answers. */
    public static String helloRef(JSONObject h) throws P4Error {
        return Prim.hB64(Prim.join(str(h, "e"), Prim.hB64(Prim.unb64(h.opt("k"))), str(h, "n")));
    }

    /* -------------------------------------------------------------- hello */

    /**
     * § 2: a hello v4 from the protocol-3 hello `v3` (check, pk, dh, sig, caps,
     * user — as SenderKeys.hello makes it). Draws: "hello.e", "hello.k", "hello.n".
     */
    public static Built buildHello(String roomId, String from, String to, JSONObject v3, Prim.DeviceSigner signer, Object mb, Object acc, Object sth, Rng rng) throws P4Error {
        if (!signer.publicKey().equals(v3.optString("pk"))) throw new P4Error("state", "the signer is not the hello's device key");
        Prim.P256 e = rng.p256("ecdh", "hello.e");
        Kem.KeyPair k = Kem.keygen(rng, "hello.k");
        String n = Prim.b64(rng.bytes(16, "hello.n"));
        try {
            JSONObject hello = new JSONObject();
            for (Iterator<String> it = v3.keys(); it.hasNext(); ) { String key = it.next(); hello.put(key, v3.get(key)); }
            JSONArray caps = new JSONArray();
            JSONArray old = v3.optJSONArray("caps");
            boolean has = false;
            if (old != null) for (int i = 0; i < old.length(); i++) { caps.put(old.get(i)); if (P4.CAP.equals(old.opt(i))) has = true; }
            if (!has) caps.put(P4.CAP);
            hello.put("kind", "hello").put("v", 4).put("caps", caps)
                .put("e", e.spki).put("k", Prim.b64(k.ek)).put("n", n)
                .put("mb", isNull(mb) ? JSONObject.NULL : mb).put("acc", isNull(acc) ? JSONObject.NULL : acc).put("sth", isNull(sth) ? JSONObject.NULL : sth);
            hello.put("sig4", signer.sign(sig4Data(roomId, from, to, hello)));
            return new Built(hello, new Secrets(e, k));
        } catch (JSONException x) { throw new IllegalStateException(x); }
    }

    /** What {@link #verifyHello} found. */
    public static final class Verdict {
        /** True: a valid v4 hello. False: `why` is key-mismatch, not-v4, malformed or bad-sig4 (treat as protocol 3, § 1). */
        public final boolean ok;
        public final String why;
        public final JSONObject hello;
        /** The peer's mailbox bundle when it is valid now; else null (`mailboxProblem` says why). */
        public final Mailbox.Bundle mailbox;
        public final String mailboxProblem;
        Verdict(boolean ok, String why, JSONObject hello, Mailbox.Bundle mailbox, String mailboxProblem) {
            this.ok = ok; this.why = why; this.hello = hello; this.mailbox = mailbox; this.mailboxProblem = mailboxProblem;
        }
        static Verdict no(String why) { return new Verdict(false, why, null, null, null); }
    }

    static boolean isAccShape(Object a) {
        if (!(a instanceof JSONObject)) return false;
        JSONObject acc = (JSONObject) a;
        if (!(acc.opt("apk") instanceof String) || !(acc.opt("ac") instanceof String)) return false;
        Object cv = acc.opt("cv"), exp = acc.opt("exp");
        if (cv == null) return exp == null;
        return cv instanceof Number && ((Number) cv).doubleValue() == 2 && Prim.isSafeCount(exp);
    }

    static boolean isSthShape(Object s) {
        if (!(s instanceof JSONObject)) return false;
        JSONObject sth = (JSONObject) s;
        return Prim.isSafeCount(sth.opt("size")) && sth.opt("root") instanceof String && Prim.isSafeCount(sth.opt("ts")) && sth.opt("sig") instanceof String;
    }

    /**
     * § 2: checks a peer's hello. `from` is the PEER's id, `to` ours. The
     * protocol-3 `sig` is checked by SenderKeys.acceptHello (over the readable
     * room name); a hello is protocol 4 only when both hold.
     */
    public static Verdict verifyHello(Object raw, String roomId, String from, String to, String check, long now) {
        if (!(raw instanceof JSONObject) || !"hello".equals(((JSONObject) raw).opt("kind"))) return Verdict.no("malformed");
        JSONObject h = (JSONObject) raw;
        if (!check.equals(h.opt("check"))) return Verdict.no("key-mismatch");
        Object v = h.opt("v");
        if (!(v instanceof Number) || ((Number) v).doubleValue() != 4) return Verdict.no("not-v4");
        try {
            for (String f : new String[]{"pk", "dh", "sig", "sig4"}) if (!(h.opt(f) instanceof String)) throw P4Error.malformed(f);
            if (!(h.opt("caps") instanceof JSONArray)) throw P4Error.malformed("caps");
            Prim.p256Public(h.opt("e"));
            Prim.unb64(h.opt("k"), P4.KEM_EK);
            Prim.unb64(h.opt("n"), 16);
            Object mb = h.opt("mb"), acc = h.opt("acc"), sth = h.opt("sth");
            if (mb != JSONObject.NULL && Mailbox.Bundle.parse(mb) == null) throw P4Error.malformed("mb");
            if (acc != JSONObject.NULL && !isAccShape(acc)) throw P4Error.malformed("acc");
            if (sth != JSONObject.NULL && !isSthShape(sth)) throw P4Error.malformed("sth");
            if (!Prim.ecdsaVerify(h.optString("pk"), sig4Data(roomId, from, to, h), h.optString("sig4"))) return Verdict.no("bad-sig4");
        } catch (P4Error e) {
            return Verdict.no("malformed");
        }
        Object mb = h.opt("mb");
        if (mb == JSONObject.NULL) return new Verdict(true, null, h, null, null);
        String problem = Mailbox.check(mb, h.optString("pk"), now);
        return problem != null ? new Verdict(true, null, h, null, problem) : new Verdict(true, null, h, Mailbox.Bundle.parse(mb), null);
    }

    /** § 12.3: what an account attestation says about device key `pk`. */
    public static final class AccountCheck {
        public final String publicKey;
        public final boolean valid;
        public final int v;
        public final long exp;
        AccountCheck(String publicKey, boolean valid, int v, long exp) { this.publicKey = publicKey; this.valid = valid; this.v = v; this.exp = exp; }
    }

    /** v1 device certificates (protocol 3, identity.ts): Ed25519 over "m5cet/device-cert/1|" + device SPKI. */
    public static boolean verifyDeviceCertV1(String accountKey, String cert, String devicePk) {
        return Prim.ed25519Verify(accountKey, Prim.utf8("m5cet/device-cert/1|" + devicePk), cert);
    }

    /**
     * § 12.3: does the account `acc.apk` vouch for device key `pk`? v2 (`cv: 2`):
     * Ed25519 over join(LABEL.deviceCert, pk, exp), and exp > now. v1 (no `cv`):
     * the protocol-3 certificate, valid without expiry. Null without `acc`.
     */
    public static AccountCheck verifyAccount(Object acc, String pk, long now) {
        if (isNull(acc)) return null;
        if (!isAccShape(acc)) return new AccountCheck(acc instanceof JSONObject ? ((JSONObject) acc).optString("apk") : "", false, 1, 0);
        JSONObject a = (JSONObject) acc;
        if (a.opt("cv") != null) {
            long exp = a.optLong("exp");
            boolean valid = exp > now;
            if (valid) {
                try { valid = Prim.ed25519Verify(a.optString("apk"), Prim.join(P4.L_DEVICE_CERT, pk, exp), a.optString("ac")); }
                catch (P4Error e) { valid = false; }
            }
            return new AccountCheck(a.optString("apk"), valid, 2, exp);
        }
        return new AccountCheck(a.optString("apk"), verifyDeviceCertV1(a.optString("apk"), a.optString("ac"), pk), 1, 0);
    }

    /** § 12.3: a v2 device certificate {v:2, exp, sig} — the account key (its 32-byte Ed25519 seed) signs. */
    public static JSONObject certifyDeviceV2(byte[] accountSeed, String devicePk, long exp, long now) throws P4Error {
        if (exp < 0 || exp > now + P4.DEVICE_CERT_LIFETIME_MS) throw P4Error.malformed("certificate lifetime too long");
        byte[] sig = Prim.ed25519Sign(accountSeed, Prim.join(P4.L_DEVICE_CERT, devicePk, exp));
        try { return new JSONObject().put("v", 2).put("exp", exp).put("sig", Prim.b64(sig)); }
        catch (JSONException e) { throw new IllegalStateException(e); }
    }

    /* -------------------------------------------------------- KEM message */

    public static final class KemSent {
        public final JSONObject message;
        public final byte[] ct;
        public final byte[] ss;
        KemSent(JSONObject message, byte[] ct, byte[] ss) { this.message = message; this.ct = ct; this.ss = ss; }
    }

    /** § 3: the KEM message answering a peer's (accepted) hello. Draw: "hello.kem-m". */
    public static KemSent buildKemMessage(JSONObject peerHello, Rng rng) throws P4Error {
        Kem.Encapsulated k = Kem.encaps(Prim.unb64(peerHello.opt("k"), P4.KEM_EK), rng, "hello.kem-m");
        try {
            return new KemSent(new JSONObject().put("kind", "p4-kem").put("v", 4).put("ct", Prim.b64(k.ct)).put("r", helloRef(peerHello)), k.ct, k.ss);
        } catch (JSONException e) { throw new IllegalStateException(e); }
    }

    /**
     * § 3: a KEM message for our hello → {ct, ss}; null when it answers another
     * hello (ignore it). A malformed one throws (`malformed` / `kct`).
     */
    public static byte[][] openKemMessage(Object raw, JSONObject ownHello, Secrets own) throws P4Error {
        if (!(raw instanceof JSONObject)) throw P4Error.malformed("not a KEM message");
        JSONObject m = (JSONObject) raw;
        Object v = m.opt("v");
        if (!"p4-kem".equals(m.opt("kind")) || !(v instanceof Number) || ((Number) v).doubleValue() != 4 || !(m.opt("r") instanceof String) || !(m.opt("ct") instanceof String)) {
            throw P4Error.malformed("not a KEM message");
        }
        if (!m.optString("r").equals(helloRef(ownHello))) return null;
        byte[] ct;
        try { ct = Prim.unb64(m.opt("ct"), P4.KEM_CT); } catch (P4Error e) { throw new P4Error("kct", "KEM ciphertext cannot be decapsulated"); }
        return new byte[][]{ct, Kem.decaps(ct, own.k.dk)};
    }

    /* ------------------------------------------------------- key schedule */

    /** One side's contribution to the transcript. */
    public static final class Party {
        final String pk, peerId, e, k, n;
        Party(String pk, String peerId, String e, String k, String n) { this.pk = pk; this.peerId = peerId; this.e = e; this.k = k; this.n = n; }
        static Party of(JSONObject hello, String peerId) { return new Party(hello.optString("pk"), peerId, hello.optString("e"), hello.optString("k"), hello.optString("n")); }
    }

    /** § 4: the side whose pk + "|" + peerId is smaller (ordinal) is A. */
    public static String roleOf(String selfPk, String selfPeerId, String peerPk, String peerPeerId) throws P4Error {
        String a = selfPk + "|" + selfPeerId, b = peerPk + "|" + peerPeerId;
        if (a.equals(b)) throw new P4Error("state", "both sides are the same device");
        return a.compareTo(b) < 0 ? "A" : "B";
    }

    /** § 4 TH. */
    public static byte[] transcriptHash(String roomId, String check, Party A, Party B, byte[] ctA, byte[] ctB) throws P4Error {
        return Prim.H(Prim.join(P4.L_TRANSCRIPT, roomId, check,
            A.pk, A.e, Prim.hB64(Prim.unb64(A.k)), A.n,
            B.pk, B.e, Prim.hB64(Prim.unb64(B.k)), B.n,
            Prim.hB64(ctA), Prim.hB64(ctB)));
    }

    /** § 4: okm = HKDF(TH, dh0 || ssA || ssB, LABEL.root, 96) → {RK0, CK_B0, SID}. */
    public static byte[][] rootSchedule(byte[] th, byte[] dh0, byte[] ssA, byte[] ssB) {
        byte[] ikm = Prim.concat(dh0, ssA, ssB);
        byte[] okm = Prim.hkdf(th, ikm, P4.L_ROOT, 96);
        byte[][] out = {Arrays.copyOfRange(okm, 0, 32), Arrays.copyOfRange(okm, 32, 64), Arrays.copyOfRange(okm, 64, 96)};
        Prim.wipe(ikm, okm);
        return out;
    }

    /** A pair session (§ 4): the role, TH, the export secret SID and the ratchet. */
    public static final class Session {
        public final String role;
        public final byte[] th;
        public final byte[] sid;
        public final Ratchet ratchet;
        Session(String role, byte[] th, byte[] sid, Ratchet ratchet) { this.role = role; this.th = th; this.sid = sid; this.ratchet = ratchet; }
        public void wipe() { ratchet.wipe(); Prim.wipe(sid); }
    }

    /**
     * § 4: the session — TH, SID and the initial ratchet for our role. `sent` is
     * our KEM message {ct, ss}, `received` the peer's {ct, ss}. Wipes the
     * hello's KEM key and both KEM secrets.
     */
    public static Session establish(String roomId, String check, String selfPeerId, JSONObject selfHello, Secrets selfSecrets,
                                    String peerPeerId, JSONObject peerHello, byte[][] sent, byte[][] received, Rng rng) throws P4Error {
        Party self = Party.of(selfHello, selfPeerId), peer = Party.of(peerHello, peerPeerId);
        String role = roleOf(self.pk, self.peerId, peer.pk, peer.peerId);
        boolean a = "A".equals(role);
        byte[][] ofA = a ? sent : received, ofB = a ? received : sent;
        byte[] th = transcriptHash(roomId, check, a ? self : peer, a ? peer : self, ofA[0], ofB[0]);
        byte[] dh0 = Prim.ecdh(selfSecrets.e.privateKey, peerHello.opt("e"));
        byte[][] root = rootSchedule(th, dh0, ofA[1], ofB[1]);
        Prim.wipe(dh0);
        try {
            Ratchet r = Ratchet.create(role, roomId, selfPeerId, peerPeerId, th, root[0], root[1], peerHello.optString("e"), selfSecrets.e, rng);
            return new Session(role, th, root[2], r);
        } finally {
            Prim.wipe(root[0], root[1], sent[1], received[1], selfSecrets.k.dk);
        }
    }

    /* ------------------------------------------------- the whole exchange */

    /**
     * One data channel's handshake: {@link #hello} to send; acceptHello(peer's)
     * → the verdict and the KEM message to send; acceptKem(peer's); then, once
     * ready(), establish() → the session. wipe() when the channel closes first.
     */
    public static final class Pair {
        public final String roomId, check, selfPeerId, peerPeerId;
        public final JSONObject hello;
        private final Secrets secrets;
        private final Rng rng;
        private JSONObject peer;
        private byte[][] sent, received;
        private boolean done;

        private Pair(String roomId, String check, String selfPeerId, String peerPeerId, Built built, Rng rng) {
            this.roomId = roomId; this.check = check; this.selfPeerId = selfPeerId; this.peerPeerId = peerPeerId;
            this.hello = built.hello; this.secrets = built.secrets; this.rng = rng;
        }

        public static Pair start(String roomId, String check, String selfPeerId, String peerPeerId, JSONObject v3, Prim.DeviceSigner signer,
                                 Object mb, Object acc, Object sth, Rng rng) throws P4Error {
            Rng r = rng == null ? Rng.SYSTEM : rng;
            return new Pair(roomId, check, selfPeerId, peerPeerId, buildHello(roomId, selfPeerId, peerPeerId, v3, signer, mb, acc, sth, r), r);
        }

        /**
         * Checks the peer's hello; when it is a valid v4 hello, the KEM message
         * to send is `kem`. Idempotent (handshake.ts, 6.12): the SAME hello again
         * (its e, k, n) gets the same KEM message — a second encapsulation would
         * leave the sides with different secrets if the peer used the first.
         */
        public synchronized Verdict acceptHello(Object raw, long now) throws P4Error {
            if (done) throw new P4Error("state", "handshake finished");
            Verdict verdict = verifyHello(raw, roomId, peerPeerId, selfPeerId, check, now);
            if (!verdict.ok) return verdict;
            JSONObject h = verdict.hello;
            if (peer != null && sent != null && kem != null && h.optString("e").equals(peer.optString("e"))
                && h.optString("k").equals(peer.optString("k")) && h.optString("n").equals(peer.optString("n"))) {
                return verdict;
            }
            if (sent != null) Prim.wipe(sent[1]);
            peer = verdict.hello;
            KemSent built = buildKemMessage(peer, rng);
            sent = new byte[][]{built.ct, built.ss};
            kem = built.message;
            return verdict;
        }

        /** The KEM message to send after the last accepted hello (null before one). */
        public JSONObject kem;

        /** The peer's KEM message: false when it answers another hello of ours (ignored). */
        public synchronized boolean acceptKem(Object raw) throws P4Error {
            if (done) throw new P4Error("state", "handshake finished");
            byte[][] opened = openKemMessage(raw, hello, secrets);
            if (opened == null) return false;
            if (received != null) Prim.wipe(received[1]);
            received = opened;
            return true;
        }

        public synchronized boolean ready() { return !done && peer != null && sent != null && received != null; }

        /** The peer's hello once accepted. */
        public synchronized JSONObject peerHello() { return peer; }

        public synchronized Session establish() throws P4Error {
            if (!ready()) throw new P4Error("state", "handshake not complete");
            done = true;
            return Handshake.establish(roomId, check, selfPeerId, hello, secrets, peerPeerId, peer, sent, received, rng);
        }

        public synchronized void wipe() {
            done = true;
            secrets.wipe();
            if (sent != null) Prim.wipe(sent[1]);
            if (received != null) Prim.wipe(received[1]);
        }
    }
}
