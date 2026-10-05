package cz.m5cet.app.chat;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

import cz.m5cet.app.core.Log;
import cz.m5cet.app.p4.Handshake;
import cz.m5cet.app.p4.Mailbox;
import cz.m5cet.app.p4.P4;
import cz.m5cet.app.p4.P4Error;
import cz.m5cet.app.p4.Prim;
import cz.m5cet.app.p4.Ratchet;
import cz.m5cet.app.p4.Rng;
import cz.m5cet.app.p4.SenderKeys4;

/**
 * 6.12: protocol 4 for one room (docs/protocol-v4.md §§ 1–8) — per peer the
 * hello v4 handshake, the pair ratchet and its resets, the room's sender
 * keys v4, private messages and file keys over the ratchet, the downgrade
 * rule. It knows peers by id and talks to them through a {@link Link} (the
 * data channels), so the JVM tests run two rooms against each other.
 *
 * Everything runs on the room's thread (RoomSession), in channel order: the
 * KEM, ratchet and reset messages travel only on the ordered data channel.
 *
 * Wire shapes (the spec's, on the data channel as JSON text):
 *   hello v4 { kind:"hello", v:4, …v3, e, k, n, mb, acc, sth, sig4 }
 *   { kind:"p4-kem", v:4, ct, r }    { kind:"p4", v:4, h, c }    { kind:"p4-reset", v:4, why }
 *   room message { v:4, id, sk, n, c, s }  (no kind; the payload is the chat payload)
 *   inner (in "p4"): sk (our chain), msg {id, p} (private messages, receipts, profiles),
 *   file {transferId, key} (before file-meta), media (ignored: no frame E2EE here)
 */
final class P4Room {
    interface Link {
        /** Text on the peer's data channel; false when it is not open. */
        boolean send(String peerId, String text);
        /** An opened chat payload from the peer: private (ratchet `msg`) or a room message (sender key v4). */
        void delivered(String peerId, JSONObject payload, Envelopes.Signer signer, boolean pairSealed);
        /** The pair session with the peer is up (messages for it went out). */
        void established(String peerId);
        /** The session broke (§ 5.5): send a new hello on this channel. */
        void rehello(String peerId);
        /** Reset flood (more than one per 10 s): close the channel. */
        void flood(String peerId);
    }

    /** What the hello carries besides the protocol-3 fields: own bundle, account attestation, newest STH (each may be null). */
    interface HelloExtras {
        JSONObject mailbox();
        JSONObject account();
        JSONObject sth();
    }

    static final class PeerState {
        Handshake.Pair hs;
        Handshake.Session session;
        /** The peer's last accepted hello (v4 or v3) and its device key. */
        JSONObject hello;
        String pk = "";
        /** The peer's current hello is a valid v4 one: it gets protocol 4 only. */
        boolean v4;
        /** Refused: a v3 hello from a device key seen with v4 before (§ 1). */
        boolean downgrade;
        Handshake.AccountCheck account;
        Mailbox.Bundle bundle;
        long lastReceivedReset, lastSentReset;
        /** What waits for the session: inner messages to encrypt, or ready text (room envelopes). */
        final List<String[]> pending = new ArrayList<>();
        /** File keys from `file` inner messages, by transfer id (the newest 64). */
        final LinkedHashMap<String, byte[]> fileKeys = new LinkedHashMap<>();
        long establishedAt;
        /** The peer hello answered (its e|n): the same hello again is a repeat, not a restart. */
        String acceptedTag;
    }

    static final int MAX_PENDING = 200;
    static final long RESET_GAP_MS = 10_000;
    private static final Pattern TRANSFER_ID = Pattern.compile("^[A-Za-z0-9_:.-]{1,96}$");

    final String roomId, check;
    private final ChatIdentity identity;
    private final P4Store store;
    private final HelloExtras extras;
    private final Link link;
    private final Rng rng;
    final SenderKeys4 senderKeys;
    /** Written on the room's thread; read also by the UI (the People widget). */
    private final Map<String, PeerState> peers = new java.util.concurrent.ConcurrentHashMap<>();

    P4Room(String roomId, String check, ChatIdentity identity, P4Store store, HelloExtras extras, Link link, Rng rng) {
        this.roomId = roomId;
        this.check = check;
        this.identity = identity;
        this.store = store;
        this.extras = extras;
        this.link = link;
        this.rng = rng == null ? Rng.SYSTEM : rng;
        this.senderKeys = new SenderKeys4(roomId, identity.publicKey, this.rng);
    }

    private PeerState state(String peerId) { return peers.computeIfAbsent(peerId, k -> new PeerState()); }

    PeerState peer(String peerId) { return peers.get(peerId); }

    private Prim.DeviceSigner signer() {
        return new Prim.DeviceSigner() {
            @Override public String publicKey() { return identity.publicKey; }
            @Override public String sign(byte[] data) { return identity.sign(data); }
        };
    }

    /* -------------------------------------------------------------- hello */

    /**
     * A new hello for this channel (open, or after a reset): the protocol-3
     * hello `v3` (SenderKeys.hello with caps and user) becomes a hello v4. The
     * previous session with the peer ends. Null when protocol 4 cannot be
     * offered (then send `v3` as it is).
     */
    JSONObject hello(String myId, String peerId, JSONObject v3) {
        PeerState ps = state(peerId);
        endSession(ps);
        try {
            ps.hs = Handshake.Pair.start(roomId, check, myId, peerId, v3, signer(), extras.mailbox(), extras.account(), extras.sth(), rng);
            return ps.hs.hello;
        } catch (P4Error | RuntimeException e) {
            Log.w("p4", "no hello v4: " + e.getMessage());
            ps.hs = null;
            return null;
        }
    }

    /**
     * Is a hello of ours waiting for the peer's? False also when a session
     * exists: a new hello from the peer then starts a new session (it
     * re-helloed), and ours goes first.
     */
    boolean helloSent(String peerId) { PeerState ps = peers.get(peerId); return ps != null && ps.hs != null; }

    /**
     * The peer's hello, after its protocol-3 part was accepted (SenderKeys.acceptHello):
     * "v4" (our KEM message went out), "legacy" (protocol 3) or "downgrade"
     * (refused: this device key spoke protocol 4 before).
     */
    /** Is this the very hello the current handshake (or session) already answered? Then nothing is to be done. */
    boolean repeatHello(String peerId, JSONObject raw) {
        PeerState ps = peers.get(peerId);
        return ps != null && ps.acceptedTag != null && (ps.session != null || ps.hs != null) && ps.acceptedTag.equals(tagOf(raw));
    }

    static String tagOf(JSONObject raw) { return raw.optString("e") + "|" + raw.optString("n"); }

    String onHello(String peerId, JSONObject raw, String ref, long now) {
        PeerState ps = state(peerId);
        ps.acceptedTag = tagOf(raw);
        String pk = raw.optString("pk");
        if (!pk.equals(ps.pk)) { ps.account = null; ps.bundle = null; }
        ps.pk = pk;
        ps.hello = raw;
        ps.downgrade = false;
        if (ps.hs == null) {
            // We could not offer protocol 4 on this channel (our hello went as protocol 3): the peer is
            // spoken to in protocol 3 — not a downgrade on its side.
            ps.v4 = false;
            return "legacy";
        }
        Handshake.Verdict verdict;
        try { verdict = ps.hs.acceptHello(raw, now); } catch (P4Error e) { verdict = null; }
        if (verdict == null || !verdict.ok) {
            ps.v4 = false;
            if (store.p4Seen(pk)) {
                ps.downgrade = true;
                endSession(ps);
                Log.w("p4", "protocol downgrade refused (" + (verdict == null ? "no handshake" : verdict.why) + ")");
                return "downgrade";
            }
            return "legacy";
        }
        ps.v4 = true;
        store.markP4(pk);
        ps.account = Handshake.verifyAccount(verdict.hello.opt("acc"), pk, now);
        if (verdict.mailbox != null) {
            ps.bundle = verdict.mailbox;
            store.rememberBundle(pk, verdict.mailbox, ref);
        }
        if (ps.hs.kem != null) link.send(peerId, ps.hs.kem.toString());
        maybeEstablish(peerId, ps);
        return "v4";
    }

    /* --------------------------------------------------------- KEM, frames */

    void onKem(String peerId, JSONObject raw) {
        PeerState ps = peers.get(peerId);
        if (ps == null || ps.hs == null) return;
        try {
            if (!ps.hs.acceptKem(raw)) return; // answers another hello of ours
        } catch (P4Error e) {
            reset(peerId, ps, e.code);
            return;
        }
        maybeEstablish(peerId, ps);
    }

    private void maybeEstablish(String peerId, PeerState ps) {
        if (ps.hs == null || !ps.hs.ready()) return;
        try {
            ps.session = ps.hs.establish();
        } catch (P4Error e) {
            Log.w("p4", "session failed: " + e.getMessage());
            reset(peerId, ps, e.code);
            return;
        }
        ps.hs = null;
        ps.establishedAt = System.currentTimeMillis();
        // A new pair session with a peer that held our chain: ours is replaced (§ 6).
        senderKeys.rehello(peerId);
        List<String[]> waiting = new ArrayList<>(ps.pending);
        ps.pending.clear();
        for (String[] w : waiting) {
            if ("inner".equals(w[0])) sendInnerNow(peerId, ps, w[1]);
            else link.send(peerId, w[1]);
        }
        link.established(peerId);
    }

    /** A "p4" frame: its inner message is handled; a failure may reset the session (§ 5.5). */
    void onFrame(String peerId, JSONObject raw) {
        PeerState ps = peers.get(peerId);
        if (ps == null || ps.session == null) return;
        Ratchet.Result r = ps.session.ratchet.decrypt(raw);
        if (!r.ok) {
            Log.w("p4", "a pair frame did not open: " + r.error + (r.reset ? " — reset" : ""));
            if (r.reset) reset(peerId, ps, r.error);
            return;
        }
        inner(peerId, ps, r.inner);
    }

    private void inner(String peerId, PeerState ps, JSONObject in) {
        switch (in.optString("t")) {
            case "sk":
                if (!senderKeys.acceptChain(peerId, ps.pk, in)) Log.w("p4", "a sender-key chain was refused (bad or foreign cert)");
                break;
            case "msg": {
                Object p = in.opt("p");
                String id = in.optString("id");
                if (!(p instanceof JSONObject) || id.isEmpty() || !id.equals(((JSONObject) p).opt("id"))) { Log.w("p4", "a private message with another id"); break; }
                link.delivered(peerId, (JSONObject) p, signerOf(ps), true);
                break;
            }
            case "file": {
                String tx = in.optString("transferId");
                try {
                    if (!TRANSFER_ID.matcher(tx).matches()) throw new P4Error("malformed");
                    ps.fileKeys.put(tx, Prim.unb64(in.opt("key"), 32));
                    while (ps.fileKeys.size() > 64) { String first = ps.fileKeys.keySet().iterator().next(); Prim.wipe(ps.fileKeys.remove(first)); }
                } catch (P4Error e) { Log.w("p4", "a bad file key"); }
                break;
            }
            default: break; // media (no frame E2EE on Android), unknown types: ignored (forward compatibility)
        }
    }

    /** The Signer of a protocol-4 message (§ 6): the hello's device key, valid; the account when attested. */
    static Envelopes.Signer signerOf(PeerState ps) {
        Handshake.AccountCheck a = ps.account;
        return new Envelopes.Signer(ps.pk, true, a == null ? null : a.publicKey, a != null && a.valid);
    }

    /* -------------------------------------------------------------- resets */

    void onReset(String peerId, JSONObject raw) {
        PeerState ps = peers.get(peerId);
        if (ps == null || !ps.v4) return;
        long now = System.currentTimeMillis();
        if (now - ps.lastReceivedReset < RESET_GAP_MS) { link.flood(peerId); return; }
        ps.lastReceivedReset = now;
        Log.w("p4", "the peer reset the session: " + raw.optString("why"));
        // Our own reset crossed theirs: the new hello is already out.
        if (ps.session == null && ps.hs != null && now - ps.lastSentReset < RESET_GAP_MS) return;
        endSession(ps);
        link.rehello(peerId);
    }

    private void reset(String peerId, PeerState ps, String why) {
        long now = System.currentTimeMillis();
        if (now - ps.lastSentReset < RESET_GAP_MS) { link.flood(peerId); return; }
        ps.lastSentReset = now;
        try { link.send(peerId, new JSONObject().put("kind", "p4-reset").put("v", 4).put("why", why == null ? "error" : why).toString()); }
        catch (JSONException ignored) { }
        endSession(ps);
        link.rehello(peerId);
    }

    private void endSession(PeerState ps) {
        ps.acceptedTag = null;
        if (ps.session != null) ps.session.wipe();
        if (ps.hs != null) ps.hs.wipe();
        ps.session = null;
        ps.hs = null;
    }

    /* ----------------------------------------------------------- queries */

    /** The peer's current hello is protocol 4 (it gets protocol 4 only). */
    boolean v4(String peerId) { PeerState ps = peers.get(peerId); return ps != null && ps.v4; }

    boolean ready(String peerId) { PeerState ps = peers.get(peerId); return ps != null && ps.v4 && ps.session != null; }

    boolean downgrade(String peerId) { PeerState ps = peers.get(peerId); return ps != null && ps.downgrade; }

    Handshake.AccountCheck account(String peerId) { PeerState ps = peers.get(peerId); return ps == null ? null : ps.account; }

    String helloPk(String peerId) { PeerState ps = peers.get(peerId); return ps == null ? "" : ps.pk; }

    /* ------------------------------------------------------------- sending */

    /** Encrypts and sends an inner message now, or keeps it for the session (in order). False: not a v4 peer. */
    boolean sendInner(String peerId, String innerJson) {
        PeerState ps = peers.get(peerId);
        if (ps == null || !ps.v4) return false;
        if (ps.session == null) return queue(ps, "inner", innerJson);
        return sendInnerNow(peerId, ps, innerJson);
    }

    private boolean queue(PeerState ps, String kind, String text) {
        if (ps.pending.size() >= MAX_PENDING) return false;
        ps.pending.add(new String[]{kind, text});
        return true;
    }

    private boolean sendInnerNow(String peerId, PeerState ps, String innerJson) {
        try {
            return link.send(peerId, ps.session.ratchet.encrypt(innerJson).toString());
        } catch (P4Error e) {
            Log.w("p4", "cannot seal for a peer: " + e.getMessage());
            return false;
        }
    }

    /** A private message (receipt, profile frame…) as a ratchet `msg`. */
    boolean sendPrivate(String peerId, JSONObject payload) {
        try {
            return sendInner(peerId, new JSONObject().put("t", "msg").put("id", payload.getString("id")).put("p", payload).toString());
        } catch (JSONException e) {
            return false;
        }
    }

    /**
     * A room message to these protocol-4 peers (§ 6): the chain is renewed
     * when due; a peer that does not hold our current chain gets it first (an
     * `sk` inner message, from the index this message will use), then the one
     * envelope for all — in order behind a session still being made. Returns
     * how many peers took it.
     */
    int sendRoom(List<String> peerIds, String id, String payloadJson, long now) throws P4Error {
        senderKeys.prepare(now);
        List<String> to = new ArrayList<>();
        for (String peerId : peerIds) {
            PeerState ps = peers.get(peerId);
            if (ps == null || !ps.v4) continue;
            if (!senderKeys.hasOurChain(peerId) && !sendInner(peerId, senderKeys.chainFor(peerId).toString())) { senderKeys.notSent(peerId); continue; }
            to.add(peerId);
        }
        if (to.isEmpty()) return 0;
        String text = senderKeys.seal(id, payloadJson).toString();
        int sent = 0;
        for (String peerId : to) {
            PeerState ps = peers.get(peerId);
            if (ps.session == null ? queue(ps, "raw", text) : link.send(peerId, text)) sent++;
        }
        return sent;
    }

    /** A file key for a transfer to this peer (§ 8): the `file` inner message, before the meta. */
    boolean sendFileKey(String peerId, String transferId, byte[] fk) {
        try { return sendInner(peerId, new JSONObject().put("t", "file").put("transferId", transferId).put("key", Prim.b64(fk)).toString()); }
        catch (JSONException e) { return false; }
    }

    /** The file key the peer sent for a transfer, or null (then it is not a protocol-4 transfer). */
    byte[] fileKey(String peerId, String transferId) {
        PeerState ps = peers.get(peerId);
        return ps == null ? null : ps.fileKeys.remove(transferId); // used once: the caller wipes it
    }

    /* ------------------------------------------------------------ receiving */

    /** Is this a protocol-4 room message ({v:4, id, sk, n, c, s}, no kind)? */
    static boolean isRoomEnvelope(JSONObject raw) {
        Object v = raw.opt("v");
        return !raw.has("kind") && v instanceof Number && ((Number) v).intValue() == P4.VERSION && raw.opt("sk") instanceof String && raw.has("s");
    }

    /** Opens a peer's room message (sender key v4); throws when it does not open. */
    JSONObject openRoom(String peerId, JSONObject envelope) throws P4Error {
        PeerState ps = peers.get(peerId);
        if (ps == null || !ps.v4) throw new P4Error("no-chain", "not a protocol-4 peer");
        return senderKeys.open(peerId, envelope);
    }

    Envelopes.Signer signer(String peerId) { PeerState ps = peers.get(peerId); return ps == null ? null : signerOf(ps); }

    /* ------------------------------------------------------------ lifecycle */

    /** The peer left (or its channel is gone for good): its session and chains go, our chain is replaced (§ 6). */
    void peerGone(String peerId) {
        PeerState ps = peers.remove(peerId);
        if (ps != null) {
            endSession(ps);
            for (byte[] k : ps.fileKeys.values()) Prim.wipe(k);
        }
        senderKeys.peerLeft(peerId);
    }

    void clear() {
        for (PeerState ps : peers.values()) endSession(ps);
        peers.clear();
        senderKeys.clear();
    }
}
