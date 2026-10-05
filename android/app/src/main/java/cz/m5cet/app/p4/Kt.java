package cz.m5cet.app.p4;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Key transparency, client side (docs/protocol-v4.md § 14, F-13; kt.ts). The
 * server keeps an append-only Merkle log of every account key, device
 * certification and revocation and signs its tree heads with an Ed25519 key
 * the client pins per server. A server that wants to show one user a fake key
 * must put it in the log — where the owner's devices see it — or show
 * different users different logs; this catches both:
 *   * every new tree head must be consistent with the newest one kept;
 *   * a lookup's entries must be included in its (signed) head;
 *   * gossip: a peer's head (from its hello) of the same size with another
 *     root, or not consistent with ours, is a split view.
 */
public final class Kt {
    private Kt() {}

    /* ------------------------------------------------------------ entries */

    private static final Pattern B64_TEXT = Pattern.compile("^[A-Za-z0-9+/=_-]+$");

    private static String text(Object v) throws P4Error {
        if (!(v instanceof String) || !B64_TEXT.matcher((String) v).matches()) throw P4Error.malformed("KT entry field is not base64 text");
        return (String) v;
    }

    /** § 14.1: the canonical JSON of an entry (keys in KtEntry order, no spaces); the leaf bytes are its UTF-8. */
    public static String canonicalEntry(Object entry) throws P4Error {
        if (!(entry instanceof JSONObject)) throw P4Error.malformed("KT entry");
        JSONObject x = (JSONObject) entry;
        Object t = x.opt("t");
        if ("acct".equals(t)) return "{\"t\":\"acct\",\"u\":\"" + text(x.opt("u")) + "\",\"apk\":\"" + text(x.opt("apk")) + "\",\"ts\":" + Prim.count(x.opt("ts")) + "}";
        if ("dev".equals(t)) return "{\"t\":\"dev\",\"u\":\"" + text(x.opt("u")) + "\",\"apk\":\"" + text(x.opt("apk")) + "\",\"dpk\":\"" + text(x.opt("dpk")) + "\",\"exp\":" + Prim.count(x.opt("exp")) + ",\"ts\":" + Prim.count(x.opt("ts")) + "}";
        if ("rev".equals(t)) return "{\"t\":\"rev\",\"u\":\"" + text(x.opt("u")) + "\",\"apk\":\"" + text(x.opt("apk")) + "\",\"dpk\":\"" + text(x.opt("dpk")) + "\",\"ts\":" + Prim.count(x.opt("ts")) + "}";
        throw P4Error.malformed("unknown KT entry type");
    }

    /** § 14.1: u = b64url(H(LABEL.ktUser + username)). */
    public static String user(String username) { return Prim.b64url(Prim.H(Prim.utf8(P4.L_KT_USER + username))); }

    public static byte[] entryLeafHash(Object entry) throws P4Error { return Merkle.leafHash(canonicalEntry(entry)); }

    /* ---------------------------------------------------- signed tree heads */

    /** § 14.2: the bytes an STH's signature covers. */
    public static byte[] sthData(long size, String root, long ts) throws P4Error { return Prim.join(P4.L_KT_STH, size, root, ts); }

    public static boolean isSth(Object v) {
        if (!(v instanceof JSONObject)) return false;
        JSONObject s = (JSONObject) v;
        if (!Prim.isSafeCount(s.opt("size")) || !Prim.isSafeCount(s.opt("ts")) || !(s.opt("root") instanceof String) || !(s.opt("sig") instanceof String)) return false;
        try { Prim.unb64(s.opt("root"), 32); Prim.unb64(s.opt("sig"), 64); return true; } catch (P4Error e) { return false; }
    }

    /** Server (and tests): signs a tree head with the KT key's seed. */
    public static JSONObject signSth(byte[] ktSeed, long size, byte[] root, long ts) throws P4Error {
        String r = Prim.b64(root);
        try { return new JSONObject().put("size", size).put("root", r).put("ts", ts).put("sig", Prim.b64(Prim.ed25519Sign(ktSeed, sthData(size, r, ts)))); }
        catch (JSONException e) { throw new IllegalStateException(e); }
    }

    /** Is this tree head signed by `ktKey` (raw Ed25519 public key, b64)? Never throws. */
    public static boolean verifySth(Object sth, String ktKey) {
        if (!isSth(sth) || ktKey == null) return false;
        JSONObject s = (JSONObject) sth;
        try { return Prim.ed25519Verify(ktKey, sthData(s.optLong("size"), s.optString("root"), s.optLong("ts")), s.optString("sig")); }
        catch (P4Error e) { return false; }
    }

    static List<byte[]> decodeProof(Object proof) throws P4Error {
        if (!(proof instanceof JSONArray) || ((JSONArray) proof).length() > 64) throw P4Error.malformed("bad proof");
        JSONArray a = (JSONArray) proof;
        List<byte[]> out = new ArrayList<>();
        for (int i = 0; i < a.length(); i++) out.add(Prim.unb64(a.opt(i), 32));
        return out;
    }

    /* -------------------------------------------------------------- lookup */

    public static final class Entry {
        public final JSONObject entry;
        public final long index;
        Entry(JSONObject entry, long index) { this.entry = entry; this.index = index; }
    }

    public static final class Checked {
        public final boolean ok;
        /** bad-signature, malformed, not-included, wrong-user (or a KtState.update status). */
        public final String why;
        public final JSONObject sth;
        public final List<Entry> entries;
        Checked(boolean ok, String why, JSONObject sth, List<Entry> entries) { this.ok = ok; this.why = why; this.sth = sth; this.entries = entries; }
        static Checked no(String why) { return new Checked(false, why, null, Collections.emptyList()); }
    }

    /**
     * § 14.3/14.4: checks a lookup against its own tree head: the head's
     * signature, every entry's user `u` (when given) and its inclusion proof.
     */
    public static Checked verifyLookup(Object lookup, String ktKey, String u) {
        if (!(lookup instanceof JSONObject) || !(((JSONObject) lookup).opt("entries") instanceof JSONArray)) return Checked.no("malformed");
        JSONObject l = (JSONObject) lookup;
        if (!verifySth(l.opt("sth"), ktKey)) return Checked.no("bad-signature");
        JSONObject sth = l.optJSONObject("sth");
        byte[] root;
        try { root = Prim.unb64(sth.opt("root"), 32); } catch (P4Error e) { return Checked.no("malformed"); }
        List<Entry> out = new ArrayList<>();
        JSONArray items = l.optJSONArray("entries");
        for (int i = 0; i < items.length(); i++) {
            Object it = items.opt(i);
            byte[] leaf;
            List<byte[]> path;
            JSONObject item;
            try {
                if (!(it instanceof JSONObject) || !Prim.isSafeCount(((JSONObject) it).opt("index"))) throw P4Error.malformed("entry");
                item = (JSONObject) it;
                leaf = entryLeafHash(item.opt("entry"));
                path = decodeProof(item.opt("proof"));
            } catch (P4Error e) {
                return Checked.no("malformed");
            }
            JSONObject entry = item.optJSONObject("entry");
            if (u != null && !u.equals(entry.opt("u"))) return Checked.no("wrong-user");
            long index = item.optLong("index");
            if (!Merkle.verifyInclusion(leaf, index, sth.optLong("size"), path, root)) return Checked.no("not-included");
            out.add(new Entry(entry, index));
        }
        return new Checked(true, null, sth, out);
    }

    /** What the verified entries of one user say about account key `apk` and device key `dpk` (§ 14.4). */
    public static final class Status {
        public final boolean account, device, revoked, ok;
        Status(boolean account, boolean device, boolean revoked) { this.account = account; this.device = device; this.revoked = revoked; this.ok = account && device && !revoked; }
    }

    /**
     * The account key is the user's CURRENT one (the latest `acct` entry), the
     * device is certified (a `dev` entry not expired at `now`), and no `rev` for
     * it comes after its latest `dev` entry.
     */
    public static Status deviceStatus(List<Entry> entries, String apk, String dpk, long now) {
        List<Entry> sorted = new ArrayList<>(entries);
        Collections.sort(sorted, (a, b) -> Long.compare(a.index, b.index));
        Entry lastAcct = null, lastDev = null;
        for (Entry e : sorted) {
            String t = e.entry.optString("t");
            if ("acct".equals(t)) lastAcct = e;
            if ("dev".equals(t) && apk.equals(e.entry.optString("apk")) && dpk.equals(e.entry.optString("dpk"))) lastDev = e;
        }
        boolean account = lastAcct != null && apk.equals(lastAcct.entry.optString("apk"));
        boolean device = lastDev != null && lastDev.entry.optLong("exp") > now;
        boolean revoked = false;
        for (Entry e : sorted) {
            if ("rev".equals(e.entry.optString("t")) && apk.equals(e.entry.optString("apk")) && dpk.equals(e.entry.optString("dpk")) && (lastDev == null || e.index > lastDev.index)) revoked = true;
        }
        return new Status(account, device, revoked);
    }

    /* --------------------------------------------------------------- state */

    /** A persistent alert: inconsistent, split-view or key-changed. */
    public static final class Alert {
        public final String kind;
        public final long at;
        public final String detail;
        public Alert(String kind, long at, String detail) { this.kind = kind; this.at = at; this.detail = detail; }
        public JSONObject json() {
            try { return new JSONObject().put("kind", kind).put("at", at).put("detail", detail); } catch (JSONException e) { throw new IllegalStateException(e); }
        }
        public static Alert parse(JSONObject o) { return o == null || o.optString("kind").isEmpty() ? null : new Alert(o.optString("kind"), o.optLong("at"), o.optString("detail")); }
    }

    /**
     * One server's state: its pinned KT key, the newest verified head, the
     * alert, and the heads signed by that key whose consistency the server
     * could not be asked to prove yet (it was unreachable — review P05):
     * [{sth, via: "update" | "gossip", since}], at most {@link #MAX_PENDING}.
     */
    public static final class OriginState {
        public final String key;
        public final JSONObject sth;
        public final Alert alert;
        public final JSONArray pending;
        public OriginState(String key, JSONObject sth, Alert alert) { this(key, sth, alert, null); }
        public OriginState(String key, JSONObject sth, Alert alert, JSONArray pending) {
            this.key = key; this.sth = sth; this.alert = alert; this.pending = pending == null || pending.length() == 0 ? null : pending;
        }
        OriginState withSth(JSONObject s) { return new OriginState(key, s, alert, pending); }
        OriginState withAlert(Alert a) { return new OriginState(key, sth, a, pending); }
        OriginState withPending(JSONArray p) { return new OriginState(key, sth, alert, p); }
        public JSONObject json() {
            try {
                JSONObject o = new JSONObject();
                if (key != null) o.put("key", key);
                if (sth != null) o.put("sth", sth);
                if (alert != null) o.put("alert", alert.json());
                if (pending != null) o.put("pending", pending);
                return o;
            } catch (JSONException e) { throw new IllegalStateException(e); }
        }
        public static OriginState parse(JSONObject o) {
            if (o == null) return null;
            String key = o.optString("key", "");
            return new OriginState(key.isEmpty() ? null : key, o.optJSONObject("sth"), Alert.parse(o.optJSONObject("alert")), o.optJSONArray("pending"));
        }
    }

    /** Heads waiting for a proof, kept per server (a full list keeps its oldest — their wait is what raises the alert). */
    public static final int MAX_PENDING = 8;

    /**
     * Thrown by a {@link ConsistencyFetcher} when the server could not be
     * reached at all (no answer). Anything else — an error answer, a proof
     * that does not verify — between two heads the pinned key signed is the
     * alert (§ 14.4, review P05); an unreachable server is retried, and the
     * alert is raised when the proof is still missing after
     * {@link #PENDING_MAX_MS}.
     */
    public static final class Unreachable extends Exception {
        public Unreachable(Throwable cause) { super(cause == null ? "unreachable" : cause.getMessage(), cause); }
    }

    /** How long a consistency proof may stay unanswered (server unreachable) before the alert (review P05). */
    public static final long PENDING_MAX_MS = 24 * 3600_000L;

    /** Persistent per-origin state (the app keeps it in the vault). */
    public interface Store {
        OriginState get(String origin);
        void set(String origin, OriginState state);
    }

    public static final class MemoryStore implements Store {
        private final java.util.Map<String, OriginState> rows = new java.util.HashMap<>();
        @Override public synchronized OriginState get(String origin) { return rows.get(origin); }
        @Override public synchronized void set(String origin, OriginState state) { rows.put(origin, state); }
    }

    /** Fetches GET /api/kt/consistency?from=&to= → {from, to, proof}. */
    public interface ConsistencyFetcher {
        JSONObject fetch(long from, long to) throws Exception;
    }

    /** The outcome of {@link State#update} / {@link State#gossip}. */
    public static final class Outcome {
        /** ok, no-key, bad-signature, inconsistent, unknown, ignored, need-consistency, split-view, pending (server unreachable), unproven (pending too long). */
        public final String status;
        public final Alert alert;
        public final long from, to;
        Outcome(String status, Alert alert, long from, long to) { this.status = status; this.alert = alert; this.from = from; this.to = to; }
        static Outcome of(String status) { return new Outcome(status, null, 0, 0); }
    }

    public static final class State {
        private final Store store;
        private final java.util.function.LongSupplier clock;

        public State(Store store, java.util.function.LongSupplier clock) {
            this.store = store == null ? new MemoryStore() : store;
            this.clock = clock == null ? System::currentTimeMillis : clock;
        }

        private OriginState load(String origin) {
            OriginState s = store.get(origin);
            return s == null ? new OriginState(null, null, null) : s;
        }

        private Alert raise(String origin, OriginState st, String kind, String detail) {
            Alert alert = new Alert(kind, clock.getAsLong(), detail);
            // The first alert stays (persistent) until the user deals with it.
            Alert kept = st.alert != null ? st.alert : alert;
            store.set(origin, st.withAlert(kept));
            return kept;
        }

        /**
         * An alert of the app's own checks (review P04: this account's own
         * entries show a device or an account key it does not know) — kept like
         * the others: the first stays until the person dismisses it.
         */
        public synchronized Alert raiseAlert(String origin, String kind, String detail) { return raise(origin, load(origin), kind, detail); }

        /** § 14.2: pins the server's KT key on first use: "new", "match" or "changed" (an alert; the pin stays). */
        public synchronized String pinKey(String origin, String key) throws P4Error {
            Prim.unb64(key, 32);
            OriginState st = load(origin);
            if (st.key == null) { store.set(origin, new OriginState(key, st.sth, st.alert, st.pending)); return "new"; }
            if (st.key.equals(key)) return "match";
            raise(origin, st, "key-changed", "the server's key-transparency key changed");
            return "changed";
        }

        public synchronized String key(String origin) { return load(origin).key; }
        public synchronized JSONObject newest(String origin) { return load(origin).sth; }
        public synchronized Alert alert(String origin) { return load(origin).alert; }
        /** How many heads wait for a proof the server could not be asked for (review P05). */
        public synchronized int pendingCount(String origin) { JSONArray p = load(origin).pending; return p == null ? 0 : p.length(); }

        /** Clears the alert after the user saw it. */
        public synchronized void dismissAlert(String origin) {
            OriginState st = load(origin);
            store.set(origin, st.withAlert(null));
        }

        /** § 14.4: a tree head from the server. Kept when newer and consistent; a rewritten history raises the alert. */
        public synchronized Outcome update(String origin, Object sth, ConsistencyFetcher fetch) {
            OriginState st = load(origin);
            if (st.key == null) return Outcome.of("no-key");
            if (!verifySth(sth, st.key)) return Outcome.of("bad-signature");
            JSONObject head = (JSONObject) sth;
            JSONObject kept = st.sth;
            if (kept == null) { store.set(origin, st.withSth(head)); return Outcome.of("ok"); }
            long hs = head.optLong("size"), ks = kept.optLong("size");
            if (hs == ks) {
                if (!head.optString("root").equals(kept.optString("root"))) return new Outcome("inconsistent", raise(origin, st, "inconsistent", "two roots for tree size " + hs), 0, 0);
                if (head.optLong("ts") > kept.optLong("ts")) store.set(origin, st.withSth(head));
                return Outcome.of("ok");
            }
            JSONObject small = hs < ks ? head : kept, big = hs < ks ? kept : head;
            int proof = consistency(small, big, fetch);
            if (proof == UNREACHABLE) return waitForProof(origin, head, "update");
            if (proof == REFUSED) {
                return new Outcome("inconsistent", raise(origin, load(origin), "inconsistent", "tree " + small.optLong("size") + " is not a prefix of tree " + big.optLong("size")), 0, 0);
            }
            if (hs > ks) store.set(origin, load(origin).withSth(head));
            return Outcome.of("ok");
        }

        /** § 14.4 gossip: a peer's tree head (from its hello) compared with ours. */
        public synchronized Outcome gossip(String origin, Object peerSth) {
            OriginState st = load(origin);
            if (st.key == null || st.sth == null) return Outcome.of("unknown");
            if (!verifySth(peerSth, st.key)) return Outcome.of("ignored");
            JSONObject peer = (JSONObject) peerSth;
            long ps = peer.optLong("size"), ks = st.sth.optLong("size");
            if (ps == ks) {
                if (peer.optString("root").equals(st.sth.optString("root"))) return Outcome.of("ok");
                return new Outcome("split-view", raise(origin, st, "split-view", "a peer saw another root for tree size " + ps), 0, 0);
            }
            return new Outcome("need-consistency", null, Math.min(ps, ks), Math.max(ps, ks));
        }

        /**
         * Finishes a need-consistency gossip with the server's proof; a newer
         * consistent peer head becomes ours. A server that answers with an
         * error, or a proof that does not verify, is the split-view alert
         * whatever its cause (review P05); one that cannot be reached is asked
         * again ({@link #retryPending}).
         */
        public synchronized Outcome resolveGossip(String origin, Object peerSth, ConsistencyFetcher fetch) {
            OriginState st = load(origin);
            if (st.key == null || st.sth == null) return Outcome.of("unknown");
            if (!verifySth(peerSth, st.key)) return Outcome.of("ignored");
            JSONObject peer = (JSONObject) peerSth, kept = st.sth;
            long ps = peer.optLong("size"), ks = kept.optLong("size");
            if (ps == ks) {
                if (peer.optString("root").equals(kept.optString("root"))) return Outcome.of("ok");
                return new Outcome("split-view", raise(origin, st, "split-view", "a peer saw another root for tree size " + ps), 0, 0);
            }
            JSONObject small = ps < ks ? peer : kept, big = ps < ks ? kept : peer;
            int proof = consistency(small, big, fetch);
            if (proof == UNREACHABLE) return waitForProof(origin, peer, "gossip");
            if (proof == REFUSED) {
                return new Outcome("split-view", raise(origin, load(origin), "split-view", "a peer's tree " + ps + " is not consistent with ours (" + ks + ")"), 0, 0);
            }
            if (ps > ks) store.set(origin, load(origin).withSth(peer));
            return Outcome.of("ok");
        }

        /**
         * Review P05: a head whose proof the server could not be asked for
         * waits (persistently) — "pending"; once one has waited longer than
         * PENDING_MAX_MS the alert is raised ("unproven").
         */
        private Outcome waitForProof(String origin, JSONObject head, String via) {
            OriginState st = load(origin);
            long now = clock.getAsLong();
            JSONArray list = st.pending == null ? new JSONArray() : st.pending;
            long oldest = now;
            boolean have = false;
            for (int i = 0; i < list.length(); i++) {
                JSONObject p = list.optJSONObject(i);
                if (p == null) continue;
                oldest = Math.min(oldest, p.optLong("since", now));
                if (sameHead(p.optJSONObject("sth"), head)) have = true;
            }
            JSONArray next = new JSONArray();
            for (int i = 0; i < list.length(); i++) next.put(list.opt(i));
            // A full list keeps its oldest heads: their wait is what raises the alert.
            if (!have && next.length() < MAX_PENDING) {
                try { next.put(new JSONObject().put("sth", head).put("via", via).put("since", now)); } catch (JSONException ignored) { }
            }
            store.set(origin, st.withPending(next));
            if (now - oldest > PENDING_MAX_MS) {
                return new Outcome("unproven", raise(origin, load(origin), "unproven", "the server has not proved its key history consistent for " + ((now - oldest) / 3600_000L) + " h"), 0, 0);
            }
            return Outcome.of("pending");
        }

        static boolean sameHead(JSONObject a, JSONObject b) {
            return a != null && b != null && a.optLong("size") == b.optLong("size") && a.optString("root").equals(b.optString("root")) && a.optLong("ts") == b.optLong("ts");
        }

        /**
         * Asks again for the proofs that could not be asked for (review P05):
         * each pending head is checked against the head kept now — consistent
         * (gone; a newer one is kept), refused (the alert) or still unreachable
         * (waits; past PENDING_MAX_MS the alert). The worst outcome.
         */
        public synchronized Outcome retryPending(String origin, ConsistencyFetcher fetch) {
            OriginState st = load(origin);
            if (st.pending == null) return Outcome.of("ok");
            JSONArray list = st.pending;
            store.set(origin, st.withPending(null));
            Outcome worst = Outcome.of("ok");
            for (int i = 0; i < list.length(); i++) {
                JSONObject p = list.optJSONObject(i);
                if (p == null) continue;
                JSONObject head = p.optJSONObject("sth");
                Outcome o = "gossip".equals(p.optString("via")) ? resolveGossip(origin, head, fetch) : update(origin, head, fetch);
                if ("pending".equals(o.status) || "unproven".equals(o.status)) {
                    // Still waiting: keep its first time (waitForProof added it with now).
                    OriginState now = load(origin);
                    JSONArray kept = now.pending == null ? new JSONArray() : now.pending;
                    for (int j = 0; j < kept.length(); j++) {
                        JSONObject q = kept.optJSONObject(j);
                        if (q != null && sameHead(q.optJSONObject("sth"), head)) try { q.put("since", Math.min(q.optLong("since"), p.optLong("since"))); } catch (JSONException ignored) { }
                    }
                    store.set(origin, now.withPending(kept));
                    if (clock.getAsLong() - p.optLong("since") > PENDING_MAX_MS) o = new Outcome("unproven", raise(origin, load(origin), "unproven", "the server has not proved its key history consistent for " + ((clock.getAsLong() - p.optLong("since")) / 3600_000L) + " h"), 0, 0);
                }
                if (rank(o.status) > rank(worst.status)) worst = o;
            }
            return worst;
        }

        private static int rank(String status) {
            switch (status) {
                case "inconsistent": case "split-view": case "unproven": return 3;
                case "pending": return 2;
                case "ok": return 0;
                default: return 1;
            }
        }

        /** A lookup: its head goes through update first, then inclusion of every entry. */
        public Checked lookup(String origin, JSONObject lookup, String u, ConsistencyFetcher fetch) {
            Outcome upd = update(origin, lookup == null ? null : lookup.opt("sth"), fetch);
            if (!"ok".equals(upd.status)) return Checked.no(upd.status);
            return verifyLookup(lookup, key(origin), u);
        }
    }

    static final int CONSISTENT = 1, REFUSED = 0, UNREACHABLE = -1;

    /**
     * Is `small` a prefix of `big`? (Both already signature-checked; sizes
     * differ.) CONSISTENT; REFUSED — the proof does not verify, the answer is
     * not one, or the server answered with an error (review P05: a server that
     * signed both heads and will not prove them is the alert); UNREACHABLE —
     * the fetcher threw {@link Unreachable} (no answer at all).
     */
    static int consistency(JSONObject small, JSONObject big, ConsistencyFetcher fetch) {
        if (small.optLong("size") == 0) return CONSISTENT;
        try {
            JSONObject answer = fetch.fetch(small.optLong("size"), big.optLong("size"));
            if (answer == null || answer.optLong("from", -1) != small.optLong("size") || answer.optLong("to", -1) != big.optLong("size")) return REFUSED;
            return Merkle.verifyConsistency(small.optLong("size"), big.optLong("size"), Prim.unb64(small.opt("root"), 32), Prim.unb64(big.opt("root"), 32), decodeProof(answer.opt("proof"))) ? CONSISTENT : REFUSED;
        } catch (Unreachable e) {
            return UNREACHABLE;
        } catch (Exception e) {
            return REFUSED;
        }
    }

    static boolean consistent(JSONObject small, JSONObject big, ConsistencyFetcher fetch) { return consistency(small, big, fetch) == CONSISTENT; }
}
