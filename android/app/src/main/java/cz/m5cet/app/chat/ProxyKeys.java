package cz.m5cet.app.chat;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import cz.m5cet.app.p4.Mailbox;
import cz.m5cet.app.p4.P4Error;
import cz.m5cet.app.p4.Prim;
import cz.m5cet.app.security.Crypto;

/**
 * 6.12 review P07 (docs/protocol-v4.md § 8): the keys of files the server
 * relays ("proxied" — no data channel, so no pair ratchet to carry them).
 * The sender seals each transfer's FK as a mailbox item to this device and
 * sends it in a hub signal before the meta; it is kept here for (sender,
 * transfer) and used once. A protocol-4 meta that comes before its key waits
 * (≤ 5 s), and the transfer's later frames wait behind it, in order. Pure
 * (JVM tests); Files and RoomSession use it on the room's thread.
 */
final class ProxyKeys {
    static final long WAIT_MS = 5_000;
    static final int MAX_KEYS = 64, MAX_WAITING_FRAMES = 4096;

    static final class Key {
        final byte[] fk;
        /** The device key that sealed it (the file's signer). */
        final String spk;
        Key(byte[] fk, String spk) { this.fk = fk; this.spk = spk; }
    }

    /** A meta waiting for its key: the sender, the frames in order (the meta first; JSON frames, binary chunks). */
    static final class Waiting {
        final String from;
        final List<Object> frames = new ArrayList<>();
        Object timer;
        Waiting(String from) { this.from = from; }
    }

    private final LinkedHashMap<String, Key> keys = new LinkedHashMap<>();
    private final Map<String, Waiting> waiting = new HashMap<>();

    static String slot(String from, String transferId) { return (from == null ? "" : from) + "\u0000" + transferId; }

    /**
     * The FK an opened signal item carries for `transferId` (payload
     * {id: transferId, t: "fk", fk: b64 32 B}), or null; when `expectedPk` is
     * known (the device the member's hello showed here) the item must be
     * sealed by it.
     */
    static byte[] fkOf(Mailbox.Opened o, String transferId, String expectedPk) {
        if (o == null || transferId == null || !"fk".equals(o.payload.optString("t")) || !transferId.equals(o.payload.optString("id"))) return null;
        if (expectedPk != null && !expectedPk.isEmpty() && !expectedPk.equals(o.spk)) return null;
        try { return Prim.unb64(o.payload.opt("fk"), 32); } catch (P4Error e) { return null; }
    }

    /** Keeps a key; returns the frames of the meta that waited for it (to handle now, in order), or null. */
    List<Object> put(String from, String transferId, byte[] fk, String spk) {
        Key old = keys.put(slot(from, transferId), new Key(fk, spk));
        if (old != null) Crypto.wipe(old.fk);
        while (keys.size() > MAX_KEYS) { String first = keys.keySet().iterator().next(); Crypto.wipe(keys.remove(first).fk); }
        Waiting w = waiting.get(transferId);
        if (w == null || !w.from.equals(from)) return null;
        waiting.remove(transferId);
        return w.frames;
    }

    /** The key for this transfer from this sender, removed (used once); null when none came. */
    Key take(String from, String transferId) { return keys.remove(slot(from, transferId)); }

    /** A protocol-4 meta without its key: it waits (false: one waits already, or no sender — refuse it). */
    Waiting park(String from, String transferId, JSONObject meta) {
        if (from == null || from.isEmpty() || waiting.containsKey(transferId)) return null;
        Waiting w = new Waiting(from);
        w.frames.add(meta);
        waiting.put(transferId, w);
        return w;
    }

    /** A later frame of a waiting transfer: kept behind its meta (true), or not waiting (false). */
    boolean queue(String transferId, Object frame) {
        Waiting w = waiting.get(transferId);
        if (w == null) return false;
        if (w.frames.size() < MAX_WAITING_FRAMES) w.frames.add(frame);
        return true;
    }

    boolean isWaiting(String transferId) { return waiting.containsKey(transferId); }

    /** Its key did not come in time: dropped (true when `w` was still waiting). */
    boolean expire(String transferId, Waiting w) {
        if (waiting.get(transferId) != w) return false;
        waiting.remove(transferId);
        return true;
    }

    /** Everything forgotten (keys wiped); the timers of the waiting ones, for the caller to cancel. */
    List<Object> clear() {
        List<Object> timers = new ArrayList<>();
        for (Waiting w : waiting.values()) if (w.timer != null) timers.add(w.timer);
        waiting.clear();
        for (Key k : keys.values()) Crypto.wipe(k.fk);
        keys.clear();
        return timers;
    }
}
