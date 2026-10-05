package cz.m5cet.app.p4;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The pair ratchet of protocol 4 (docs/protocol-v4.md § 5; ratchet.ts): a
 * Double Ratchet (P-256 DH steps + HMAC chains) whose DH steps also run an
 * ML-KEM-768 step carried in the headers.
 *
 *   KDF_RK(rk, dhOut, kss) = HKDF(salt = rk, ikm = dhOut || kss, "m5cet/p4/rk", 64)
 *   KDF_CK(ck)             = (mk = HMAC(ck, 0x01), ck' = HMAC(ck, 0x02))
 *
 * Copy-on-write: a frame is processed on a copy of the state, committed only
 * after the AEAD check passed; what the attempt derived is wiped otherwise.
 * Failures are returned ({@link Result}), with `reset` on the second failure
 * of the session or a KEM ciphertext that cannot be decapsulated (§ 5.5). One
 * operation at a time (synchronized). Sessions live in memory only.
 */
public final class Ratchet {

    /* --------------------------------------------------------------- KDFs */

    /** § 5.1 KDF_RK; `kss` is the KEM shared secret or null (0 bytes). Returns {rk', ck}. */
    public static byte[][] kdfRk(byte[] rk, byte[] dhOut, byte[] kss) {
        byte[] ikm = kss != null ? Prim.concat(dhOut, kss) : dhOut.clone();
        byte[] okm = Prim.hkdf(rk, ikm, P4.L_RATCHET, 64);
        byte[][] out = {Arrays.copyOfRange(okm, 0, 32), Arrays.copyOfRange(okm, 32, 64)};
        Prim.wipe(ikm, okm);
        return out;
    }

    private static final byte[] ONE = {0x01}, TWO = {0x02};

    /** § 5.1 KDF_CK → {mk, ck'}. */
    public static byte[][] kdfCk(byte[] ck) {
        return new byte[][]{Prim.hmac(ck, ONE), Prim.hmac(ck, TWO)};
    }

    /** § 5.2 AAD = join(LABEL.pairAad, roomId, from, to, b64(TH), Hs) — Hs spliced in as its six parts. */
    public static byte[] pairAad(String roomId, String from, String to, byte[] th, JSONObject h) throws P4Error {
        Object kid = h.opt("kid"), kct = h.opt("kct"), kek = h.opt("kek");
        return Prim.join(P4.L_PAIR_AAD, roomId, from, to, Prim.b64(th),
            h.opt("dh"), Prim.count(h.opt("pn")), Prim.count(h.opt("n")),
            kid == null ? "-" : kid,
            kct == null ? "-" : Prim.hB64(Prim.unb64(kct)),
            kek == null ? "-" : Prim.hB64(Prim.unb64(kek)));
    }

    /* -------------------------------------------------------------- state */

    static final class KemKeys {
        final byte[] ek, dk;
        final String ekB64, kid;
        KemKeys(byte[] ek, byte[] dk) { this.ek = ek; this.dk = dk; this.ekB64 = Prim.b64(ek); this.kid = Kem.kid(ek); }
    }

    static final class Skipped {
        final String chain;
        final byte[] mk;
        Skipped(String chain, byte[] mk) { this.chain = chain; this.mk = mk; }
    }

    static final class State {
        byte[] rk;
        Prim.P256 dhs;
        String dhr;
        byte[] cks, ckr;
        long ns, nr, pn;
        /** Own KEM key pairs, oldest first; the last is the current one (announced as kek). At most 3. */
        List<KemKeys> myKem = new ArrayList<>();
        String peerKem, usedPeerKem;
        /** kid / kct of the step that started the current sending chain, sent with its n = 0. */
        String[] pendingKct;
        LinkedHashMap<String, Skipped> skipped = new LinkedHashMap<>();
        Map<String, Integer> perChain = new HashMap<>();

        State copy() {
            State s = new State();
            s.rk = rk; s.dhs = dhs; s.dhr = dhr; s.cks = cks; s.ckr = ckr; s.ns = ns; s.nr = nr; s.pn = pn;
            s.myKem = new ArrayList<>(myKem); s.peerKem = peerKem; s.usedPeerKem = usedPeerKem; s.pendingKct = pendingKct;
            s.skipped = new LinkedHashMap<>(skipped); s.perChain = new HashMap<>(perChain);
            return s;
        }

        /** Every secret byte array the state references (to wipe what a commit leaves behind). */
        Set<byte[]> secrets() {
            Set<byte[]> out = Collections.newSetFromMap(new IdentityHashMap<>());
            out.add(rk); out.add(cks);
            if (ckr != null) out.add(ckr);
            for (KemKeys k : myKem) out.add(k.dk);
            for (Skipped v : skipped.values()) out.add(v.mk);
            return out;
        }
    }

    private static final int KEEP_KEMS = 3;
    private static final Pattern KID_RE = Pattern.compile("^[A-Za-z0-9_-]{16}$");

    /** decrypt's answer: the inner message, or why not and whether to reset (§ 5.5). */
    public static final class Result {
        public final boolean ok;
        public final JSONObject inner;
        public final String error;
        public final boolean reset;
        public final String message;
        Result(boolean ok, JSONObject inner, String error, boolean reset, String message) { this.ok = ok; this.inner = inner; this.error = error; this.reset = reset; this.message = message; }
    }

    public final String role;
    private final String roomId, selfPeerId, peerPeerId;
    private final byte[] th;
    private final Rng rng;
    private State state;
    private int failures = 0;
    private boolean wiped = false;

    private Ratchet(State state, String role, String roomId, String selfPeerId, String peerPeerId, byte[] th, Rng rng) {
        this.state = state; this.role = role; this.roomId = roomId; this.selfPeerId = selfPeerId; this.peerPeerId = peerPeerId;
        this.th = th.clone(); this.rng = rng;
    }

    /** § 4: the initial state for role A or B. Draws (A): "init.dhs", "init.kem-seed"; (B): "init.kem-seed". */
    public static Ratchet create(String role, String roomId, String selfPeerId, String peerPeerId, byte[] th, byte[] rk0, byte[] ckB0,
                                 String peerE, Prim.P256 ownE, Rng rng) throws P4Error {
        Rng r = rng == null ? Rng.SYSTEM : rng;
        if (rk0.length != 32 || ckB0.length != 32) throw P4Error.malformed("root and chain keys are 32 bytes");
        State s = new State();
        if ("A".equals(role)) {
            s.dhs = r.p256("ecdh", "init.dhs");
            s.myKem.add(newKem(r, "init.kem-seed"));
            byte[] dhOut = Prim.ecdh(s.dhs.privateKey, peerE);
            byte[][] out = kdfRk(rk0, dhOut, null);
            Prim.wipe(dhOut);
            s.rk = out[0]; s.cks = out[1]; s.dhr = peerE; s.ckr = ckB0.clone();
        } else {
            if (ownE == null) throw new P4Error("state", "role B needs its hello key pair");
            s.myKem.add(newKem(r, "init.kem-seed"));
            s.rk = rk0.clone(); s.dhs = ownE; s.dhr = null; s.cks = ckB0.clone(); s.ckr = null;
        }
        return new Ratchet(s, role, roomId, selfPeerId, peerPeerId, th, r);
    }

    private static KemKeys newKem(Rng rng, String what) throws P4Error {
        Kem.KeyPair k = Kem.keygen(rng, what);
        return new KemKeys(k.ek, k.dk);
    }

    /** Counters and public keys (no secrets), for tests and the security info. */
    public synchronized String info() {
        State s = state;
        return "role=" + role + " ns=" + s.ns + " nr=" + s.nr + " pn=" + s.pn + " skipped=" + s.skipped.size() + " kems=" + s.myKem.size()
            + " peerKem=" + (s.peerKem != null) + " failures=" + failures + " wiped=" + wiped;
    }

    public synchronized boolean wiped() { return wiped; }
    public synchronized int skippedCount() { return state.skipped.size(); }

    /* ---------------------------------------------------------- sending */

    /** § 5.2: seals one inner message given as its JSON text (an object with a string `t`; its UTF-8 is padded and sealed as is). */
    public synchronized JSONObject encrypt(String innerJson) throws P4Error {
        if (wiped) throw new P4Error("state", "session wiped");
        JSONObject inner = Mailbox.object(innerJson);
        if (!(inner.opt("t") instanceof String)) throw P4Error.malformed("inner message needs a type t");
        State s = state;
        JSONObject h = new JSONObject();
        try {
            h.put("dh", s.dhs.spki).put("pn", s.pn).put("n", s.ns);
            if (s.ns == 0) {
                if (s.pendingKct != null) h.put("kid", s.pendingKct[0]).put("kct", s.pendingKct[1]);
                h.put("kek", s.myKem.get(s.myKem.size() - 1).ekB64);
            }
        } catch (JSONException e) { throw new IllegalStateException(e); }
        byte[][] step = kdfCk(s.cks);
        byte[] aad = pairAad(roomId, selfPeerId, peerPeerId, th, h);
        byte[][] keyIv = Prim.keyIv(step[0], P4.L_PAIR_KEY);
        byte[] plain = Pad.pad(Prim.utf8(innerJson));
        byte[] c;
        try { c = Prim.aesGcmSeal(keyIv[0], keyIv[1], aad, plain); } finally { Prim.wipe(step[0], keyIv[0], keyIv[1], plain); }
        byte[] old = s.cks;
        s.cks = step[1];
        long n = s.ns;
        s.ns += 1;
        if (n == 0) s.pendingKct = null;
        Prim.wipe(old);
        try { return new JSONObject().put("kind", "p4").put("v", 4).put("h", h).put("c", Prim.b64(c)); }
        catch (JSONException e) { throw new IllegalStateException(e); }
    }

    public JSONObject encrypt(JSONObject inner) throws P4Error { return encrypt(inner.toString()); }

    /* -------------------------------------------------------- receiving */

    /** § 5.4: opens one frame. Never throws; a failure says whether to reset (§ 5.5). */
    public synchronized Result decrypt(Object frame) {
        if (wiped) return new Result(false, null, "state", true, "session wiped");
        try {
            return new Result(true, open(frame), null, false, null);
        } catch (P4Error e) {
            failures += 1;
            return new Result(false, null, e.code, "kct".equals(e.code) || failures >= 2, e.getMessage());
        } catch (RuntimeException e) {
            failures += 1;
            return new Result(false, null, "malformed", failures >= 2, String.valueOf(e.getMessage()));
        }
    }

    private static final class Parsed {
        JSONObject h;
        byte[] ct, kct;
    }

    private Parsed parse(Object frame) throws P4Error {
        if (!(frame instanceof JSONObject)) throw P4Error.malformed("not a p4 frame");
        JSONObject f = (JSONObject) frame;
        Object v = f.opt("v");
        if (!"p4".equals(f.opt("kind")) || !(v instanceof Number) || ((Number) v).doubleValue() != 4 || !(f.opt("h") instanceof JSONObject)) throw P4Error.malformed("not a p4 frame");
        JSONObject raw = (JSONObject) f.opt("h");
        if (!(raw.opt("dh") instanceof String) || !Prim.isSafeCount(raw.opt("pn")) || !Prim.isSafeCount(raw.opt("n"))) throw P4Error.malformed("bad header");
        Parsed p = new Parsed();
        try {
            p.h = new JSONObject().put("dh", raw.opt("dh")).put("pn", ((Number) raw.opt("pn")).longValue()).put("n", ((Number) raw.opt("n")).longValue());
            Prim.unb64(raw.opt("dh"));
            if ((raw.opt("kid") == null) != (raw.opt("kct") == null)) throw P4Error.malformed("kid and kct go together");
            if (raw.opt("kid") != null) {
                if (!(raw.opt("kid") instanceof String) || !KID_RE.matcher((String) raw.opt("kid")).matches()) throw P4Error.malformed("bad kid");
                try { p.kct = Prim.unb64(raw.opt("kct"), P4.KEM_CT); } catch (P4Error e) { throw new P4Error("kct", "KEM ciphertext cannot be decapsulated"); }
                p.h.put("kid", raw.opt("kid")).put("kct", raw.opt("kct"));
            }
            if (raw.opt("kek") != null) { Prim.unb64(raw.opt("kek"), P4.KEM_EK); p.h.put("kek", raw.opt("kek")); }
        } catch (JSONException e) { throw P4Error.malformed("bad header"); }
        p.ct = Prim.unb64(f.opt("c"));
        if (p.ct.length < 16) throw P4Error.malformed("ciphertext too short");
        return p;
    }

    private JSONObject open(Object frame) throws P4Error {
        Parsed p = parse(frame);
        JSONObject h = p.h;
        String dh = h.optString("dh");
        long hn = h.optLong("n"), hpn = h.optLong("pn");
        byte[] aad = pairAad(roomId, peerPeerId, selfPeerId, th, h);
        State old = state;

        // 1. A stored skipped key: use it, delete it. (A kek here is ignored: § 5.4.)
        String slot = dh + "|" + hn;
        Skipped kept = old.skipped.get(slot);
        if (kept != null) {
            byte[] plain = openWith(kept.mk, aad, p.ct);
            State next = old.copy();
            dropSkipped(next, slot);
            commit(next, new ArrayList<>());
            return parseInner(plain);
        }

        State w = old.copy();
        List<byte[]> fresh = new ArrayList<>();
        boolean committed = false;
        try {
            Object kek = h.opt("kek");
            if (!dh.equals(w.dhr)) {
                // 2. A new chain from the peer.
                skipTo(w, hpn, fresh);                                                    // 2.1
                byte[] kss = null;
                if (h.opt("kct") != null) {                                               // 2.2
                    KemKeys mine = null;
                    for (KemKeys k : w.myKem) if (k.kid.equals(h.optString("kid"))) mine = k;
                    if (mine == null) throw new P4Error("kct", "KEM ciphertext for an unknown key");
                    kss = Kem.decaps(p.kct, mine.dk);
                    fresh.add(kss);
                }
                byte[] dhOut = Prim.ecdh(w.dhs.privateKey, dh);                           // 2.3
                fresh.add(dhOut);
                byte[][] r = kdfRk(w.rk, dhOut, kss);
                fresh.add(r[0]); fresh.add(r[1]);
                w.rk = r[0]; w.ckr = r[1]; w.pn = w.ns; w.ns = 0; w.nr = 0; w.dhr = dh;
                if (kek != null) takeKek(w, (String) kek);                                 // 3 (before 2.4)
                sendingStep(w, fresh);                                                     // 2.4
            } else if (kek != null) {
                takeKek(w, (String) kek);                                                  // 3
            }
            if (w.ckr == null) throw P4Error.malformed("no receiving chain");
            if (hn < w.nr) throw new P4Error("replay", "message key already used");
            skipTo(w, hn, fresh);                                                          // 4
            byte[][] step = kdfCk(w.ckr);
            fresh.add(step[0]); fresh.add(step[1]);
            w.ckr = step[1];
            w.nr += 1;
            byte[] plain = openWith(step[0], aad, p.ct);
            commit(w, fresh);
            committed = true;
            return parseInner(plain);
        } finally {
            if (!committed) {
                // Nothing of this attempt survives: wipe what it derived.
                Set<byte[]> live = old.secrets();
                for (byte[] b : fresh) if (!live.contains(b)) Prim.wipe(b);
                for (byte[] b : w.secrets()) if (!live.contains(b)) Prim.wipe(b);
            }
        }
    }

    /** § 5.3 sending ratchet step. Draws: "ratchet.dhs", ["ratchet.kem-m" when encapsulating], "ratchet.kem-seed". */
    private void sendingStep(State w, List<byte[]> fresh) throws P4Error {
        w.dhs = rng.p256("ecdh", "ratchet.dhs");
        byte[] kss = null;
        w.pendingKct = null;
        if (w.peerKem != null) {
            byte[] ek = Prim.unb64(w.peerKem, P4.KEM_EK);
            Kem.Encapsulated k = Kem.encaps(ek, rng, "ratchet.kem-m");
            kss = k.ss;
            fresh.add(k.ss);
            w.pendingKct = new String[]{Kem.kid(ek), Prim.b64(k.ct)};
            w.usedPeerKem = w.peerKem;
            w.peerKem = null;
        }
        KemKeys mine = newKem(rng, "ratchet.kem-seed");
        fresh.add(mine.dk);
        List<KemKeys> kems = new ArrayList<>(w.myKem);
        kems.add(mine);
        while (kems.size() > KEEP_KEMS) kems.remove(0);
        w.myKem = kems;
        byte[] dhOut = Prim.ecdh(w.dhs.privateKey, w.dhr);
        fresh.add(dhOut);
        byte[][] r = kdfRk(w.rk, dhOut, kss);
        fresh.add(r[0]); fresh.add(r[1]);
        w.rk = r[0];
        w.cks = r[1];
    }

    /** Makes `next` the state; wipes every secret neither it nor the old state still needs. */
    private void commit(State next, List<byte[]> fresh) {
        Set<byte[]> live = next.secrets();
        for (byte[] b : state.secrets()) if (!live.contains(b)) Prim.wipe(b);
        for (byte[] b : fresh) if (!live.contains(b)) Prim.wipe(b);
        state = next;
    }

    /** Forgets every secret of the session. */
    public synchronized void wipe() {
        if (wiped) return;
        wiped = true;
        for (byte[] b : state.secrets()) Prim.wipe(b);
        Prim.wipe(th);
        state.skipped.clear();
    }

    /* ------------------------------------------------------------ helpers */

    private static byte[] openWith(byte[] mk, byte[] aad, byte[] ct) throws P4Error {
        byte[][] keyIv = Prim.keyIv(mk, P4.L_PAIR_KEY);
        try { return Prim.aesGcmOpen(keyIv[0], keyIv[1], aad, ct); } finally { Prim.wipe(keyIv[0], keyIv[1]); }
    }

    private static void takeKek(State w, String kek) {
        if (!kek.equals(w.usedPeerKem)) w.peerKem = kek;
    }

    /** Stores the keys of the current receiving chain from Nr up to (not including) `until`. */
    private static void skipTo(State w, long until, List<byte[]> fresh) throws P4Error {
        if (w.ckr == null || w.dhr == null || until <= w.nr) return;
        if (until - w.nr > P4.MAX_SKIP) throw new P4Error("skip", "too many skipped messages");
        while (w.nr < until) {
            byte[][] step = kdfCk(w.ckr);
            fresh.add(step[0]); fresh.add(step[1]);
            storeSkipped(w, w.dhr, w.nr, step[0]);
            w.ckr = step[1];
            w.nr += 1;
        }
    }

    private static void storeSkipped(State w, String chain, long n, byte[] mk) {
        int count = w.perChain.getOrDefault(chain, 0);
        if (count >= P4.MAX_SKIP) {
            for (Map.Entry<String, Skipped> e : w.skipped.entrySet()) if (e.getValue().chain.equals(chain)) { dropSkipped(w, e.getKey()); break; }
        }
        w.skipped.put(chain + "|" + n, new Skipped(chain, mk));
        w.perChain.put(chain, w.perChain.getOrDefault(chain, 0) + 1);
        while (w.skipped.size() > P4.MAX_SKIPPED_TOTAL) {
            Iterator<String> it = w.skipped.keySet().iterator();
            dropSkipped(w, it.next());
        }
    }

    private static void dropSkipped(State w, String slot) {
        Skipped v = w.skipped.remove(slot);
        if (v == null) return;
        int left = w.perChain.getOrDefault(v.chain, 1) - 1;
        if (left > 0) w.perChain.put(v.chain, left); else w.perChain.remove(v.chain);
    }

    /** unpad, strict UTF-8, JSON, an object with a string `t`. */
    public static JSONObject parseInner(byte[] padded) throws P4Error {
        JSONObject value;
        try {
            value = Mailbox.object(Prim.fromUtf8(Pad.unpad(padded)));
        } catch (P4Error e) {
            throw P4Error.malformed("inner message is not padded JSON");
        } finally {
            Prim.wipe(padded);
        }
        if (!(value.opt("t") instanceof String)) throw P4Error.malformed("inner message needs a type t");
        return value;
    }
}
