package cz.m5cet.app.chat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.BitSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.p4.Files4;
import cz.m5cet.app.p4.P4Error;
import cz.m5cet.app.p4.Rng;
import cz.m5cet.app.security.Crypto;
import cz.m5cet.app.security.FileVault;

/**
 * File transfer v2 (6.1), byte-compatible with client/src/lib/file-transfer.ts:
 * meta → chunks → end to every open channel (the server relays it — "proxy"
 * — only when no channel is open). The file key is HKDF(files key, salt =
 * transferId, info "file"); meta and end are signed bodies, chunks raw bytes;
 * the end carries SHA-256 over the chunks' SHA-256s. Chunks go as binary
 * frames to peers that announced "bin", as JSON to the others; missing
 * chunks are asked for again (file-need, three rounds).
 *
 * 6.12 (protocol 4, § 8): between protocol-4 peers the room key no longer
 * protects files — the sender picks a random FK per transfer and hands it to
 * each such peer over the pair ratchet (a `file` inner message) before the
 * meta; the key is HKDF(salt = transferId, FK, "m5cet/p4/file"), the AADs
 * are protocol 4's, meta and end bodies padded (not signed — the session
 * authenticates them). Older peers get the same file the protocol-3 way: one
 * transfer, two lanes.
 *
 * 6.12 review P07 (§ 8, proxied files): through the server (no channel, so no
 * ratchet) the FK goes as a mailbox item sealed to every present member's
 * authenticated devices, in a sealed hub signal before the meta
 * ({p4:"fk", transferId, item}); the frames carry v 4. A receiver keeps the FK
 * for (sender, transfer), waits up to 5 s for it after a v 4 proxied meta (the
 * transfer's later frames wait behind it) and uses it once. When some member
 * has no device to seal to, the room-derived key (v 2) — and the sender is told.
 *
 * The receiver keeps the (still encrypted) frames in a temporary file and
 * only at the end decrypts, verifies and stores the file in the vault
 * (FileVault) — nothing of it is on the disk in clear.
 */
final class Files {
    static final int CHUNK = 32_768;
    static final long MAX_BYTES = 2L * 1024 * 1024 * 1024;
    static final int MAX_CHUNKS = 2_000_000, MAX_RESEND_ROUNDS = 3;
    private static final Pattern ID = Pattern.compile("^[A-Za-z0-9_:.-]{1,96}$");

    private final RoomSession room;
    private final Map<String, In> incoming = new HashMap<>();
    private final Map<String, Out> outgoing = new HashMap<>();

    Files(RoomSession room) { this.room = room; }

    /* =============================================================== receive */

    private final class In {
        final String id, transport;
        final Peer from;
        final byte[] key;
        /** 6.12: a protocol-4 transfer (per-transfer key, protocol-4 AADs, padded bodies). */
        final boolean p4;
        JSONObject meta;
        String signer;
        int total, chunkSize;
        long size;
        final BitSet got = new BitSet();
        int[] lengths;
        File tmp;
        RandomAccessFile slots;
        int rounds = 0;
        ChatMessage message;
        long lastUi = 0;

        In(String id, Peer from, String transport, byte[] key, boolean p4) {
            this.id = id; this.from = from; this.transport = transport; this.key = key; this.p4 = p4;
        }

        int slot() { return 12 + chunkSize + 16; }

        void close() {
            try { if (slots != null) slots.close(); } catch (IOException ignored) { }
            if (tmp != null) //noinspection ResultOfMethodCallIgnored
                tmp.delete();
            Crypto.wipe(key);
        }
    }

    /* ------------------------------------------ proxied FKs (§ 8, review P07) */

    /** The keys of proxied transfers sealed to this device, and the metas that wait for theirs. */
    private final ProxyKeys proxyKeys = new ProxyKeys();

    /** The FK of a proxied transfer from `from` (opened from its sealed signal; `spk` sealed it). The meta that waits for it goes now. */
    void proxyKey(String from, String transferId, byte[] fk, String spk) {
        if (from == null || from.isEmpty() || !ID.matcher(transferId).matches() || fk == null || fk.length != 32) return;
        List<Object> frames = proxyKeys.put(from, transferId, fk, spk);
        if (frames == null) return;
        for (Object frame : frames) {
            if (frame instanceof JSONObject) onJson(null, (JSONObject) frame, true);
            else onBinary(null, (byte[]) frame);
        }
    }

    /** No FK came in time: the transfer is dropped (its frames with it). */
    private void fkTimeout(String transferId, ProxyKeys.Waiting w) {
        if (!proxyKeys.expire(transferId, w)) return;
        Log.w("files", "a proxied protocol-4 file came without its key — not opened");
        room.systemNotice("⚠ " + room.tr("p4.file.noKey"));
    }

    /** A JSON file frame from a channel (p2p) or from the server (proxy). */
    void onJson(Peer p, JSONObject f, boolean proxy) {
        String kind = f.optString("kind", f.optString("type"));
        // The server relays proxied frames as proxy-meta / -chunk / -end / -cancel / -need.
        if (proxy && kind.startsWith("proxy-")) kind = "file-" + kind.substring("proxy-".length());
        String id = f.optString("transferId");
        if (!ID.matcher(id).matches()) return;
        // Behind its meta, which waits for the FK (review P07).
        if (proxy && !"file-need".equals(kind) && proxyKeys.queue(id, f)) return;
        switch (kind) {
            case "file-meta": onMeta(p, id, f, proxy); break;
            case "file-chunk": {
                In in = incoming.get(id);
                if (in == null) return;
                try { onChunk(in, f.optInt("seq", -1), Crypto.unb64(f.optString("iv")), Crypto.unb64(f.optString("ciphertext"))); }
                catch (IllegalArgumentException ignored) { }
                break;
            }
            case "file-end": onEnd(id, f); break;
            case "file-cancel": {
                In in = incoming.remove(id);
                if (in != null) { in.close(); failed(in, "cancelled"); }
                Out out = outgoing.get(id);
                if (out != null && proxy) out.cancelled = true;
                break;
            }
            case "file-need": {
                Out out = outgoing.get(id);
                if (out != null && System.currentTimeMillis() - out.startedAt < 10 * 60_000) resend(out, p, f.optJSONArray("seqs"));
                break;
            }
            default: break;
        }
    }

    /** A binary chunk: 'M' | 0x01 (p2p) / 0x11 (proxy) | version | L | id | seq u32 | iv 12 | ct+tag. */
    void onBinary(Peer p, byte[] b) {
        if (b.length < 37 || b[0] != 0x4D || (b[1] != 0x01 && b[1] != 0x11)) return;
        int l = b[3] & 0xff;
        if (l < 1 || l > 96 || b.length < 20 + l + 16) return;
        String id = new String(b, 4, l, StandardCharsets.UTF_8);
        if (!ID.matcher(id).matches()) return;
        if (p == null && proxyKeys.queue(id, b)) return; // behind its meta, which waits for the FK (review P07)
        In in = incoming.get(id);
        if (in == null) return;
        long seq = ByteBuffer.wrap(b, 4 + l, 4).getInt() & 0xffffffffL;
        byte[] iv = java.util.Arrays.copyOfRange(b, 8 + l, 20 + l);
        byte[] ct = java.util.Arrays.copyOfRange(b, 20 + l, b.length);
        onChunk(in, seq > Integer.MAX_VALUE ? -1 : (int) seq, iv, ct);
    }

    private void onMeta(Peer p, String id, JSONObject f, boolean proxy) {
        if (incoming.containsKey(id) || outgoing.containsKey(id)) return;
        int v = f.optInt("v", 1);
        if (v != 2 && v != 4) return; // v1 (3.0 and older) is not received here
        // 6.12 (§ 8): a protocol-4 transfer (v 4) opens only with the FK the sender's session handed us over the
        // ratchet before the meta — never the room key; over a protocol-4 peer's channel a v2 file is not taken.
        // Review P07: a proxied one with the FK its sender sealed to this device (a hub signal) — waited for up to 5 s.
        String from = proxy ? f.optString("from") : p == null ? "" : p.id;
        byte[] fk = null;
        String proxySigner = null;
        if (v == 4 && proxy) {
            ProxyKeys.Key k = from.isEmpty() ? null : proxyKeys.take(from, id);
            if (k == null) {
                ProxyKeys.Waiting w = proxyKeys.park(from, id, f);
                if (w == null) { Log.w("files", "a proxied protocol-4 file without its sender refused"); return; }
                w.timer = cz.m5cet.app.core.Io.TIMER.schedule(() -> room.post(() -> fkTimeout(id, w)), ProxyKeys.WAIT_MS, TimeUnit.MILLISECONDS);
                return;
            }
            fk = k.fk;
            proxySigner = k.spk;
        } else if (v == 4) {
            fk = p == null || room.p4 == null ? null : room.p4.fileKey(p.id, id);
        }
        if (v == 4 && fk == null) { Log.w("files", "a protocol-4 file without its key refused"); return; }
        if (v == 2 && p != null && !proxy && room.isV4(p)) { Log.w("files", "a protocol-3 file from a protocol-4 peer refused"); return; }
        In in;
        try {
            in = fk != null ? new In(id, p, proxy ? "proxy" : "p2p", Files4.fileKey(fk, id), true) : new In(id, p, proxy ? "proxy" : "p2p", room.keys.fileKey(id), false);
        } catch (P4Error e) {
            return;
        } finally {
            Crypto.wipe(fk);
        }
        try {
            JSONObject m;
            if (in.p4) {
                m = Envelopes.parse(Files4.openBody(in.key, Files4.metaAad(id), f.optString("iv"), f.optString("ciphertext")));
                // The session authenticated it — or, proxied, the device that sealed the FK to us (review P07).
                in.signer = proxy ? proxySigner : room.p4.helloPk(p.id);
            } else {
                Envelopes.Body body = Envelopes.openFileBodyFull(in.key, Envelopes.fileMetaContext(id), f.optString("iv"), f.optString("ciphertext"));
                if (body.signer != null && !body.signer.valid) throw new GeneralSecurityException("bad signature");
                m = Envelopes.parse(body.body);
                in.signer = body.signer == null ? null : body.signer.publicKey;
            }
            if (!id.equals(m.optString("transferId"))) throw new GeneralSecurityException("transfer id");
            long size = m.optLong("size", -1);
            int chunkSize = m.optInt("chunkSize", 0);
            int total = m.optInt("totalChunks", 0);
            if (size < 0 || size > MAX_BYTES || chunkSize < 1 || chunkSize > 1_048_576) throw new GeneralSecurityException("size");
            if (total != Math.max(1, (int) ((size + chunkSize - 1) / chunkSize)) || total > MAX_CHUNKS) throw new GeneralSecurityException("chunks");
            in.meta = m;
            in.size = size;
            in.chunkSize = chunkSize;
            in.total = total;
            in.lengths = new int[total];
            in.tmp = File.createTempFile("m5x-", ".part", room.app.getCacheDir());
            in.slots = new RandomAccessFile(in.tmp, "rw");
        } catch (Exception e) {
            Log.w("files", "file refused: " + e.getMessage());
            in.close();
            return;
        }
        incoming.put(id, in);
        ChatMessage m = new ChatMessage();
        m.id = id;
        m.roomKey = room.key;
        m.senderId = in.meta.optString("senderId", p == null ? "" : p.id);
        m.senderName = Payloads.clean(in.meta.opt("senderName"), Payloads.NAME, p == null ? "?" : p.name);
        m.createdAt = Math.min(in.meta.optLong("createdAt", System.currentTimeMillis()), System.currentTimeMillis() + Payloads.FUTURE_SKEW);
        m.fileName = Payloads.safeFileName(in.meta.opt("name"));
        m.fileMime = Payloads.safeMime(in.meta.optString("mime"));
        m.fileImage = Payloads.inlineImage(m.fileMime);
        m.fileSize = in.size;
        m.fileProgress = 0;
        m.verified = false;
        in.message = m;
        room.addFile(m);
    }

    private void onChunk(In in, int seq, byte[] iv, byte[] ct) {
        if (seq < 0 || seq >= in.total || in.got.get(seq) || iv.length != 12 || ct.length < 16 || ct.length > in.chunkSize + 16) return;
        try {
            in.slots.seek((long) seq * in.slot());
            in.slots.write(iv);
            in.slots.write(ct);
            in.lengths[seq] = ct.length;
            in.got.set(seq);
        } catch (IOException e) {
            Log.w("files", "cannot keep a chunk: " + e.getMessage());
            return;
        }
        long now = System.currentTimeMillis();
        if (now - in.lastUi > 250) {
            in.lastUi = now;
            in.message.fileProgress = in.got.cardinality() / (double) in.total;
            room.fileChanged(in.message);
        }
    }

    private void onEnd(String id, JSONObject f) {
        In in = incoming.get(id);
        if (in == null) return;
        int have = in.got.cardinality();
        if (have < in.total) {
            if (in.rounds++ >= MAX_RESEND_ROUNDS) { incoming.remove(id); in.close(); failed(in, "missing chunks"); return; }
            JSONArray seqs = new JSONArray();
            for (int i = in.got.nextClearBit(0); i < in.total && seqs.length() < 5000; i = in.got.nextClearBit(i + 1)) seqs.put(i);
            try {
                JSONObject need = new JSONObject().put("kind", "file-need").put("transferId", id).put("seqs", seqs).put("transport", in.transport);
                if ("proxy".equals(in.transport)) room.sendServer(need.put("type", "proxy-need"));
                else if (in.from != null) in.from.send(need.toString());
            } catch (JSONException ignored) { }
            return;
        }
        incoming.remove(id);
        final JSONObject endFrame = f;
        Io.bg(() -> finish(in, endFrame));
    }

    /** Decrypts the chunks in order, checks the root and the signer, stores the file in the vault. */
    private void finish(In in, JSONObject f) {
        FileVault.Writer w = null;
        try {
            JSONObject end;
            if (in.p4) {
                end = Envelopes.parse(Files4.openBody(in.key, Files4.endAad(in.id), f.optString("iv"), f.optString("ciphertext")));
            } else {
                Envelopes.Body body = Envelopes.openFileBodyFull(in.key, Envelopes.fileEndContext(in.id), f.optString("iv"), f.optString("ciphertext"));
                if (in.signer != null && (body.signer == null || !body.signer.valid || !in.signer.equals(body.signer.publicKey))) throw new GeneralSecurityException("the end is not signed by the sender");
                end = Envelopes.parse(body.body);
            }
            if (end.optInt("totalChunks") != in.total || end.optLong("size") != in.size) throw new GeneralSecurityException("size");
            String rootB64 = end.optString("root");
            // 6.12 (F-16): the app is locked — the vault cannot take the file now. Checked in full, it stays
            // encrypted under its transfer key, which goes to the lock inbox; the unlock stores it (LockedRooms).
            if (LockedRooms.active()) {
                decryptSlots(in.slots, in.key, in.id, in.total, in.chunkSize, in.lengths, in.size, rootB64, null, in.p4);
                if (LockedRooms.keepFile(room.app, room.key, in.id, in.key, in.tmp, in.slots, in.chunkSize, in.total, in.size, in.lengths, rootB64, in.p4)) {
                    in.close();
                    done(in);
                    return;
                }
                // The inbox closed meanwhile (the app was unlocked): stored the usual way.
            }
            w = new FileVault.Writer(room.app, in.id);
            decryptSlots(in.slots, in.key, in.id, in.total, in.chunkSize, in.lengths, in.size, rootB64, w, in.p4);
            w.close();
            w = null;
            in.close();
            done(in);
        } catch (Exception e) {
            if (w != null) w.abort();
            in.close();
            Log.w("files", "file " + in.id + " failed: " + e.getMessage());
            room.post(() -> failed(in, e.getMessage()));
        }
    }

    private void done(In in) {
        room.post(() -> {
            ChatMessage m = in.message;
            m.filePath = in.id;
            m.fileProgress = -1;
            m.fileVerified = in.signer != null;
            // 6.12 § 12.1: "verified" only for a sender the person verified (a proxied protocol-4 file: the device that sealed its key).
            m.verified = m.fileVerified && (in.from != null ? Trust.VERIFIED.equals(in.from.trust)
                : !in.p4 || cz.m5cet.app.contacts.Store.verified(room.app, kidOf(in.signer)));
            room.fileDone(m);
        });
    }

    /**
     * The chunks of a received file (its slots file: iv 12 ‖ ct per slot of
     * 12 + chunkSize + 16 bytes) decrypted in order and checked against the
     * end's root; into the vault (w), or only checked (w null). 6.12: also the
     * unlock's way to store a file kept in the lock inbox (LockedRooms); `p4`:
     * a protocol-4 transfer (its chunks' AAD is protocol 4's, § 8).
     */
    static void decryptSlots(RandomAccessFile slots, byte[] key, String id, int total, int chunkSize, int[] lengths, long size, String rootB64, FileVault.Writer w, boolean p4)
        throws IOException, GeneralSecurityException {
        MessageDigest root = MessageDigest.getInstance("SHA-256");
        long bytes = 0;
        byte[] iv = new byte[12];
        int slot = 12 + chunkSize + 16;
        for (int seq = 0; seq < total; seq++) {
            if (lengths[seq] < 16 || lengths[seq] > chunkSize + 16) throw new GeneralSecurityException("chunk size");
            byte[] ct = new byte[lengths[seq]];
            slots.seek((long) seq * slot);
            slots.readFully(iv);
            slots.readFully(ct);
            byte[] plain = Crypto.gcmOpen(key, iv, ct, p4 ? Files4.chunkAad(id, seq, total) : Envelopes.fileChunkContext(id, seq, total));
            if (plain.length > chunkSize) throw new GeneralSecurityException("chunk too large");
            root.update(MessageDigest.getInstance("SHA-256").digest(plain));
            if (w != null) w.write(plain, 0, plain.length);
            bytes += plain.length;
        }
        if (bytes != size) throw new GeneralSecurityException("size");
        if (!Crypto.b64(root.digest()).equals(rootB64)) throw new GeneralSecurityException("the file does not match its hash");
    }

    private void failed(In in, String why) {
        if (in.message == null) return;
        in.message.fileProgress = -2;
        room.fileChanged(in.message);
        room.systemNotice("⚠ " + in.message.fileName + ": " + why);
    }

    /* ================================================================== send */

    /** One way a transfer goes: the peers on it and its key (protocol 4: from the FK; protocol 3: from the room key). */
    private static final class Lane {
        final boolean p4;
        final List<Peer> peers;
        final byte[] key;
        String endFrame;
        Lane(boolean p4, List<Peer> peers, byte[] key) { this.p4 = p4; this.peers = peers; this.key = key; }
    }

    private final class Out {
        final String id;
        String vaultId;
        final int total;
        final long size;
        final long startedAt = System.currentTimeMillis();
        final List<Lane> lanes = new ArrayList<>();
        volatile boolean cancelled;
        Out(String id, long size) { this.id = id; this.size = size; this.total = Math.max(1, (int) ((size + CHUNK - 1) / CHUNK)); }

        Lane laneOf(Peer p) {
            for (Lane l : lanes) if (p == null ? l.peers.isEmpty() : l.peers.contains(p)) return l;
            return null;
        }
    }

    /**
     * Sends a file (already in the vault under id) to every open channel, or
     * through the server when none is open. Runs on a background thread.
     */
    void send(String vaultId, String name, String mime, long size, ChatMessage bubble) {
        Io.bg(() -> {
            String id = "xfer-" + UUID.randomUUID();
            Out out = new Out(id, size);
            out.vaultId = vaultId;
            room.post(() -> outgoing.put(id, out));
            try (FileVault.Reader r = new FileVault.Reader(room.app, vaultId)) {
                List<Peer> peers = openPeers();
                boolean proxy = peers.isEmpty();
                if (proxy && !room.canProxy()) throw new IOException("nobody to send it to");
                if (proxy) planProxy(out, name); else planLanes(out, peers);
                String transport = proxy ? "proxy" : "p2p";
                JSONObject meta = new JSONObject().put("transferId", id).put("name", name.length() > 200 ? name.substring(0, 200) : name).put("mime", mime)
                    .put("size", size).put("totalChunks", out.total).put("chunkSize", CHUNK).put("senderId", room.myId()).put("senderName", room.userName)
                    .put("createdAt", System.currentTimeMillis());
                for (Lane lane : out.lanes) {
                    JSONObject sealedMeta = lane.p4 ? Files4.sealBody(lane.key, Files4.metaAad(id), meta.toString(), Rng.SYSTEM)
                        : Envelopes.sealFileBody(lane.key, Envelopes.fileMetaContext(id), meta, room.identity);
                    JSONObject metaFrame = new JSONObject().put("kind", "file-meta").put("transferId", id).put("transport", transport).put("v", lane.p4 ? 4 : 2)
                        .put("iv", sealedMeta.getString("iv")).put("ciphertext", sealedMeta.getString("ciphertext"));
                    broadcast(lane.peers, metaFrame, "proxy-meta");
                }
                MessageDigest root = MessageDigest.getInstance("SHA-256");
                byte[] buf = new byte[CHUNK];
                for (int seq = 0; seq < out.total && !out.cancelled; seq++) {
                    int n = Math.max(0, r.readAt((long) seq * CHUNK, buf, 0, CHUNK));
                    byte[] plain = java.util.Arrays.copyOf(buf, n);
                    root.update(MessageDigest.getInstance("SHA-256").digest(plain));
                    for (Lane lane : out.lanes) sendChunk(lane, id, seq, out, plain, transport);
                    if (bubble != null && (seq % 8 == 0 || seq == out.total - 1)) {
                        bubble.fileProgress = (seq + 1) / (double) out.total;
                        room.fileChanged(bubble);
                    }
                }
                if (out.cancelled) {
                    for (Lane lane : out.lanes) broadcast(lane.peers, new JSONObject().put("kind", "file-cancel").put("transferId", id).put("transport", transport), "proxy-cancel");
                    throw new IOException("cancelled");
                }
                JSONObject end = new JSONObject().put("root", Crypto.b64(root.digest())).put("totalChunks", out.total).put("size", size);
                for (Lane lane : out.lanes) {
                    JSONObject sealedEnd = lane.p4 ? Files4.sealBody(lane.key, Files4.endAad(id), end.toString(), Rng.SYSTEM)
                        : Envelopes.sealFileBody(lane.key, Envelopes.fileEndContext(id), end, room.identity);
                    JSONObject endFrame = new JSONObject().put("kind", "file-end").put("transferId", id).put("transport", transport).put("v", lane.p4 ? 4 : 2)
                        .put("iv", sealedEnd.getString("iv")).put("ciphertext", sealedEnd.getString("ciphertext"));
                    lane.endFrame = endFrame.toString();
                    broadcast(lane.peers, endFrame, "proxy-end");
                }
                if (bubble != null) { bubble.fileProgress = -1; bubble.raise(proxy ? "stored" : "sent"); room.fileChanged(bubble); }
                Log.i("files", "sent " + size + " B in " + out.total + " chunks (" + transport + ", " + out.lanes.size() + " lane(s))");
            } catch (Exception e) {
                Log.w("files", "sending failed: " + e.getMessage());
                if (bubble != null) { bubble.fileProgress = -2; room.fileChanged(bubble); }
                room.systemNotice("⚠ " + name + ": " + e.getMessage());
            }
        });
    }

    /**
     * Protocol-4 peers with a session get a fresh FK each over the ratchet (on
     * the room's thread, before the meta goes); older peers and the server the
     * room-key lane. A protocol-4 peer still making its session, or a refused
     * (downgraded) one, does not get this file.
     */
    private void planLanes(Out out, List<Peer> peers) throws InterruptedException, P4Error, IOException {
        List<Peer> v4 = new ArrayList<>(), v3 = new ArrayList<>();
        byte[] fk = Crypto.random(32);
        try {
            CountDownLatch done = new CountDownLatch(1);
            room.post(() -> {
                try {
                    for (Peer p : peers) {
                        // A peer whose hello has not come yet (its protocol unknown) or a refused one does not get this file.
                        if (p.downgrade || (p.protocol.isEmpty() && room.p4 != null)) continue;
                        if (room.isV4(p)) { if (room.p4.ready(p.id) && room.p4.sendFileKey(p.id, out.id, fk)) v4.add(p); }
                        else v3.add(p);
                    }
                } finally { done.countDown(); }
            });
            if (!done.await(10, TimeUnit.SECONDS)) throw new InterruptedException("the room did not answer");
            if (!v4.isEmpty()) out.lanes.add(new Lane(true, v4, Files4.fileKey(fk, out.id)));
            if (!v3.isEmpty() || peers.isEmpty()) out.lanes.add(new Lane(false, v3, room.keys.fileKey(out.id)));
            if (out.lanes.isEmpty()) throw new IOException("the connections are still being secured — try again in a moment");
        } finally {
            Crypto.wipe(fk);
        }
    }

    /**
     * Review P07 (§ 8): through the server — under a fresh FK sealed to every
     * present member's authenticated devices (sent in signals before the meta);
     * the room-derived key only when some member has no such device, and the
     * person is told.
     */
    private void planProxy(Out out, String name) throws InterruptedException, P4Error {
        byte[] fk = Crypto.random(32);
        try {
            if (room.proxyFileKey(out.id, fk)) {
                out.lanes.add(new Lane(true, new ArrayList<>(), Files4.fileKey(fk, out.id)));
                room.systemNotice("🔐 " + room.tr("p4.file.proxyP4").replace("{name}", name));
            } else {
                out.lanes.add(new Lane(false, new ArrayList<>(), room.keys.fileKey(out.id)));
                room.systemNotice("⚠ " + room.tr("p4.file.proxyRoomKey").replace("{name}", name));
            }
        } finally {
            Crypto.wipe(fk);
        }
    }

    private List<Peer> openPeers() {
        List<Peer> out = new ArrayList<>();
        synchronized (room.peers) { for (Peer p : room.peers.values()) if (p.open()) out.add(p); }
        return out;
    }

    private void broadcast(List<Peer> peers, JSONObject frame, String proxyType) throws JSONException {
        if (peers.isEmpty()) { room.sendServer(new JSONObject(frame.toString()).put("type", proxyType)); return; }
        String text = frame.toString();
        for (Peer p : peers) p.send(text);
    }

    private void sendChunk(Lane lane, String id, int seq, Out out, byte[] plain, String transport) throws Exception {
        byte[] iv = Crypto.random(12);
        byte[] ct = Crypto.gcmSeal(lane.key, iv, plain, lane.p4 ? Files4.chunkAad(id, seq, out.total) : Envelopes.fileChunkContext(id, seq, out.total));
        if (lane.peers.isEmpty()) {
            room.sendServer(new JSONObject().put("type", "proxy-chunk").put("kind", "file-chunk").put("transferId", id).put("seq", seq)
                .put("transport", "proxy").put("v", lane.p4 ? 4 : 2).put("iv", Crypto.b64(iv)).put("ciphertext", Crypto.b64(ct)));
            Thread.sleep(Math.max(1, ct.length / 1600)); // ~1.6 MB/s: under the server's proxy budget
            return;
        }
        String json = null;
        byte[] binary = null;
        for (Peer p : lane.peers) {
            long waited = 0;
            while (p.open() && p.buffered() > 1_048_576 && waited < 10_000) { Thread.sleep(20); waited += 20; }
            if (!p.open()) continue;
            if (p.bin) {
                if (binary == null) binary = binaryFrame(id, seq, iv, ct, (byte) 0x01, lane.p4 ? 4 : 2);
                p.sendBinary(binary);
            } else {
                if (json == null) json = new JSONObject().put("kind", "file-chunk").put("transferId", id).put("seq", seq).put("transport", transport).put("v", lane.p4 ? 4 : 2)
                    .put("iv", Crypto.b64(iv)).put("ciphertext", Crypto.b64(ct)).toString();
                p.send(json);
            }
        }
    }

    static byte[] binaryFrame(String id, int seq, byte[] iv, byte[] ct, byte type) { return binaryFrame(id, seq, iv, ct, type, 2); }

    /** 6.12: `version` 4 for a protocol-4 transfer (the web's binary-frames.ts carries the frame's v). */
    static byte[] binaryFrame(String id, int seq, byte[] iv, byte[] ct, byte type, int version) {
        byte[] idb = id.getBytes(StandardCharsets.UTF_8);
        ByteBuffer b = ByteBuffer.allocate(4 + idb.length + 4 + 12 + ct.length);
        b.put((byte) 0x4D).put(type).put((byte) version).put((byte) idb.length).put(idb).putInt(seq).put(iv).put(ct);
        return b.array();
    }

    /** file-need: those chunks again (new IVs, the asking peer's lane), then the end frame again. */
    private void resend(Out out, Peer p, JSONArray seqs) {
        if (seqs == null || seqs.length() == 0 || seqs.length() > 5000) return;
        Lane lane = out.laneOf(p != null && p.open() ? p : null);
        if (lane == null) return;
        Io.bg(() -> {
            if (out.vaultId == null) return;
            try (FileVault.Reader r = new FileVault.Reader(room.app, out.vaultId)) {
                byte[] buf = new byte[CHUNK];
                List<Peer> to = new ArrayList<>();
                if (p != null && p.open()) to.add(p);
                Lane one = new Lane(lane.p4, to, lane.key);
                for (int i = 0; i < seqs.length(); i++) {
                    int seq = seqs.optInt(i, -1);
                    if (seq < 0 || seq >= out.total) continue;
                    int n = Math.max(0, r.readAt((long) seq * CHUNK, buf, 0, CHUNK));
                    sendChunk(one, out.id, seq, out, java.util.Arrays.copyOf(buf, n), to.isEmpty() ? "proxy" : "p2p");
                }
                if (lane.endFrame != null) {
                    if (to.isEmpty()) room.sendServer(new JSONObject(lane.endFrame).put("type", "proxy-end"));
                    else for (Peer x : to) x.send(lane.endFrame);
                }
            } catch (Exception e) {
                Log.w("files", "resend failed: " + e.getMessage());
            }
        });
    }

    /** A device key's id ("" when it is not one). */
    private static String kidOf(String pk) {
        try { return pk == null || pk.isEmpty() ? "" : cz.m5cet.app.security.Ec.kid(pk); } catch (RuntimeException e) { return ""; }
    }

    void clear() {
        for (In in : incoming.values()) in.close();
        incoming.clear();
        for (Object timer : proxyKeys.clear()) ((java.util.concurrent.ScheduledFuture<?>) timer).cancel(false);
        for (Out out : outgoing.values()) for (Lane l : out.lanes) Crypto.wipe(l.key);
        outgoing.clear();
    }

}
