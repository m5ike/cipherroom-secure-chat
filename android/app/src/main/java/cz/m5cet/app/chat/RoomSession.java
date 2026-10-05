package cz.m5cet.app.chat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.security.GeneralSecurityException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

import cz.m5cet.app.M5;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.net.WebSocket;
import cz.m5cet.app.p4.Handshake;
import cz.m5cet.app.p4.HubProof;
import cz.m5cet.app.p4.Kt;
import cz.m5cet.app.p4.Mailbox;
import cz.m5cet.app.p4.P4;
import cz.m5cet.app.p4.P4Error;
import cz.m5cet.app.p4.Pad;
import cz.m5cet.app.p4.Replay;
import cz.m5cet.app.profile.ProfileRoom;
import cz.m5cet.app.profile.Profiles;
import cz.m5cet.app.security.Crypto;
import cz.m5cet.app.security.Ec;

/**
 * One connected room (protocol 2 / crypto v3, like the web client): its own
 * signaling WebSocket, the room keys, the mesh of peers, sender keys, the
 * messages. Everything of a room runs on the room's own thread, in order.
 *
 * Several RoomSessions run at once — the server keeps one room per
 * connection, so each room has its own (docs/android-architecture.md §6).
 */
public final class RoomSession {
    public interface Listener {
        void onRoomChanged(RoomSession room);
        void onMessage(RoomSession room, ChatMessage message, boolean fresh);
    }

    public final String key;
    public final String room;
    public final String label;
    final String passphrase;
    final String userName;
    final M5 app;
    final Rooms rooms;
    final Calls calls;

    private final ExecutorService exec = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "m5-room");
        t.setDaemon(true);
        return t;
    });

    RoomKeys keys;
    ChatIdentity identity;
    final SenderKeys senderKeys = new SenderKeys();
    /** 6.12: protocol 4 with this room's peers (made once the keys and the identity are known). */
    P4Room p4;
    /** 6.12: relayed messages for away members, sealed per device (§ 7.4). */
    final P4Relay relay = new P4Relay();
    /** 6.12: accepted message ids, persistent (§ 11). */
    private Replay.Guard replay;
    private Replay.MemoryStore replayStore;
    private ScheduledFuture<?> replaySave;
    /** 6.12 (§ 13): the hub's per-socket nonce, whether our join went out, whether it proved the room key. */
    private String hubNonce = "";
    private boolean joinSent = false;
    private ScheduledFuture<?> joinFallback;
    private volatile boolean proven = false;
    /** 6.12: messages held from a peer whose identity changed, until the user accepts it (§ 12.1). */
    private final Map<String, List<ChatMessage>> held = new HashMap<>();
    /** Changed on the room's thread only; other threads (file transfers) read it under its lock. */
    final Map<String, Peer> peers = Collections.synchronizedMap(new LinkedHashMap<>());
    /** 6.1: file transfer v2. */
    final Files files = new Files(this);
    /** Messages no channel took yet: sent again when one opens (outbox.ts: 200, 24 h). */
    private final List<Queued> outbox = new ArrayList<>();
    /** Receipts waiting to go (peer id → state → message ids), sent in batches. */
    private final Map<String, Map<String, List<String>>> receiptQueue = new HashMap<>();
    private ScheduledFuture<?> receiptTimer, expiryTimer;
    private final LinkedHashSet<String> seen = new LinkedHashSet<>();
    final List<ChatMessage> messages = new ArrayList<>();

    private WebSocket ws;
    private String myId = "";
    private String resumeSecret = "";
    private boolean wanted = false;
    private int attempts = 0;
    private ScheduledFuture<?> heartbeat, retry;
    private volatile String status = "offline";
    private volatile String notice = "";
    volatile int unread = 0;
    volatile long lastActivity = 0;

    RoomSession(M5 app, Rooms rooms, String key, String room, String label, String passphrase, String userName) {
        this.app = app;
        this.rooms = rooms;
        this.key = key;
        this.room = room;
        this.label = label;
        this.passphrase = passphrase;
        this.userName = userName;
        this.calls = new Calls(this);
    }

    void post(Runnable r) {
        if (exec.isShutdown()) return;
        exec.execute(() -> {
            try { r.run(); } catch (Throwable t) { Log.e("room", "room task failed", t); }
        });
    }

    public Calls calls() { return calls; }
    public String status() { return status; }
    public String notice() { return notice; }
    public String myId() { return myId; }
    public int unread() { return unread; }
    public long lastActivity() { return lastActivity; }
    public boolean connected() { return "joined".equals(status); }

    /** Something of the room changed (6.8: its call too — Calls.track works out what the call is for me). */
    void changed() { calls.track(); rooms.roomChanged(this); }

    /* ------------------------------------------------------------ connect */

    void connect() {
        post(() -> {
            if (wanted && ws != null && ws.isOpen()) return;
            wanted = true;
            status = "connecting";
            changed();
            try {
                if (keys == null) {
                    notice = app.t("app.decrypting");
                    long t0 = System.currentTimeMillis();
                    keys = RoomKeys.derive(room, passphrase);
                    Log.i("room", "keys for " + logName() + " in " + (System.currentTimeMillis() - t0) + " ms");
                }
                if (identity == null) identity = rooms.identity();
                if (p4 == null) startP4();
                foreground = app.inForeground();
                // 6.7: back as the same member after Android ended the process (the server kept us listed).
                if (myId.isEmpty() && resumeSecret.isEmpty()) {
                    String[] back = Resume.load(app, key);
                    if (back != null) { myId = back[0]; resumeSecret = back[1]; }
                }
                openSocket();
            } catch (Exception e) {
                Log.e("room", "cannot connect " + logName(), e);
                status = "offline";
                notice = e.getMessage() == null ? "" : e.getMessage();
                changed();
                scheduleRetry();
            }
        });
    }

    private String wsUrl() {
        String base = app.config.server();
        String ws = base.replaceFirst("(?i)^https://", "wss://").replaceFirst("(?i)^http://", "ws://");
        return ws + "/ws";
    }

    private void openSocket() {
        WebSocket socket = new WebSocket(wsUrl(), new WebSocket.Listener() {
            @Override public void onOpen(WebSocket w) { post(() -> onOpened(w)); }
            @Override public void onText(WebSocket w, String text) { post(() -> { if (w == ws) onFrame(text); }); }
            @Override public void onBinary(WebSocket w, byte[] data) { post(() -> { if (w == ws) files.onBinary(null, data); }); }
            @Override public void onClose(WebSocket w, int code, String reason) { post(() -> onClosed(w, code, reason)); }
        });
        ws = socket;
        socket.connect();
    }

    private void onOpened(WebSocket w) {
        if (w != ws) return;
        attempts = 0;
        // 6.12 (§ 13): the join waits for the server's hello — its nonce is what the join proof signs.
        // A server that sends no hello in time gets the join without a proof.
        hubNonce = "";
        joinSent = false;
        if (joinFallback != null) joinFallback.cancel(false);
        joinFallback = Io.TIMER.schedule(() -> post(() -> { if (w == ws && !joinSent) sendJoin(w); }), 4, TimeUnit.SECONDS);
        if (heartbeat != null) heartbeat.cancel(false);
        heartbeat = Io.TIMER.scheduleWithFixedDelay(() -> post(() -> {
            WebSocket s = ws;
            if (s != null && s.isOpen()) s.send("{\"type\":\"ping\",\"t\":" + System.currentTimeMillis() + "}");
        }), 25, 25, TimeUnit.SECONDS);
    }

    /** The join frame — with the proof that we hold the room key when the server gave a nonce (§ 13, blind ids only). */
    private void sendJoin(WebSocket w) {
        if (joinSent || w == null || !w.isOpen()) return;
        joinSent = true;
        if (joinFallback != null) { joinFallback.cancel(false); joinFallback = null; }
        try {
            JSONObject join = new JSONObject().put("type", "join").put("protocol", 2).put("room", keys.roomId)
                .put("name", userName).put("peerId", myId.isEmpty() ? "peer-" + Crypto.hex(Crypto.random(12)) : myId).put("away", false)
                .put("features", new JSONArray().put("bin")).put("foreground", foreground);
            if (!resumeSecret.isEmpty()) join.put("resume", resumeSecret);
            JSONObject proof = hubProof(keys, hubNonce);
            if (proof != null) join.put("proof", proof);
            w.send(join.toString());
            sentForeground = foreground;
        } catch (JSONException ignored) { }
    }

    /** § 13: {pub, sig} = Ed25519 from hubSeed = RoomKeys.derive("m5cet/hub-auth/4", 32) over join(…, roomId, nonce); null without a nonce or for a plain-name room. */
    static JSONObject hubProof(RoomKeys keys, String nonce) {
        if (keys == null || nonce == null || nonce.isEmpty() || !keys.roomId.startsWith("r3.")) return null;
        byte[] seed = keys.derive(P4.L_HUB_SEED, 32);
        try { return HubProof.build(seed, keys.roomId, nonce); }
        catch (P4Error e) { Log.w("room", "no join proof: " + e.getMessage()); return null; }
        finally { Crypto.wipe(seed); }
    }

    /** 6.12: protocol 4 for this room — the per-peer sessions and the room's replay window. */
    private void startP4() {
        P4Device dev = rooms.p4();
        p4 = new P4Room(keys.roomId, keys.check, identity, dev.store, new P4Room.HelloExtras() {
            @Override public JSONObject mailbox() { return dev.bundle(identity); }
            @Override public JSONObject account() { return dev.account(identity); }
            @Override public JSONObject sth() { return dev.sth(); }
        }, new P4Room.Link() {
            @Override public boolean send(String peerId, String text) { Peer p = peers.get(peerId); return p != null && p.send(text); }
            @Override public void delivered(String peerId, JSONObject payload, Envelopes.Signer signer, boolean pairSealed) {
                Peer p = peers.get(peerId);
                if (p != null) handleOpened(p, new Envelopes.Opened(payload, P4.VERSION, signer), pairSealed);
            }
            @Override public void established(String peerId) { onP4Established(peerId); }
            @Override public void rehello(String peerId) { Peer p = peers.get(peerId); if (p != null && p.open()) sendHello(p); }
            @Override public void flood(String peerId) {
                Peer p = peers.get(peerId);
                if (p == null) return;
                Log.w("room", "protocol-4 resets from a peer too often — channel closed");
                dropPeer(peerId, false);
            }
        }, null);
        replayStore = dev.store.replay(keys.roomId);
        replay = new Replay.Guard(replayStore, 64);
        dev.refreshKt(null);
        dev.upload(identity);
    }

    /**
     * § 11: is this message fresh and not seen before (remembered when it is)?
     * The persistent window, saved soon after. A protocol-3 message (an older
     * peer, its clock never held against it before) is checked for replay only.
     */
    private boolean freshMessage(ChatMessage m, Object createdAt, boolean p4Message) {
        if (replay == null) return true;
        long now = System.currentTimeMillis();
        String verdict = p4Message ? replay.check(keys.roomId, m.id, createdAt, now, false) : replay.checkId(keys.roomId, m.id, now);
        if (!"ok".equals(verdict)) { Log.w("room", "message refused: " + verdict); return false; }
        saveReplaySoon();
        return true;
    }

    private void saveReplaySoon() {
        if (replaySave != null || replayStore == null) return;
        Replay.MemoryStore store = replayStore;
        String roomId = keys.roomId;
        replaySave = Io.TIMER.schedule(() -> post(() -> {
            replaySave = null;
            Io.bg(() -> rooms.p4().store.saveReplay(roomId, store));
        }), 5, TimeUnit.SECONDS);
    }

    private void onClosed(WebSocket w, int code, String reason) {
        if (w != ws) return;
        ws = null;
        if (heartbeat != null) { heartbeat.cancel(false); heartbeat = null; }
        status = "offline";
        Log.i("room", logName() + " signaling closed " + code + " " + reason);
        changed();
        if (code == 4001 || code == 4003) { wanted = false; notice = code == 4001 ? "replaced" : "closed by the server"; return; }
        if (wanted) scheduleRetry();
    }

    private void scheduleRetry() {
        if (!wanted) return;
        long cap = Math.min(120_000L, 1000L << Math.min(attempts, 12));
        long delay = (long) (Math.random() * cap) + 250;
        attempts++;
        if (retry != null) retry.cancel(false);
        retry = Io.TIMER.schedule(() -> post(() -> { if (wanted && (ws == null || !ws.isOpen())) openSocket(); }), delay, TimeUnit.MILLISECONDS);
    }

    void disconnect() {
        post(() -> {
            wanted = false;
            if (retry != null) retry.cancel(false);
            if (heartbeat != null) heartbeat.cancel(false);
            WebSocket w = ws;
            ws = null;
            if (w != null) { w.send("{\"type\":\"leave\",\"away\":false}"); w.close(1000, "leave"); }
            calls.stop();
            files.clear();
            for (Peer p : new ArrayList<>(peers.values())) p.close();
            peers.clear();
            senderKeys.clear();
            if (p4 != null) p4.clear();
            relay.clear();
            if (joinFallback != null) { joinFallback.cancel(false); joinFallback = null; }
            if (replayStore != null && keys != null) { Replay.MemoryStore store = replayStore; String roomId = keys.roomId; Io.bg(() -> rooms.p4().store.saveReplay(roomId, store)); }
            status = "offline";
            changed();
        });
    }

    void destroy() {
        disconnect();
        // 6.8: a call still open here is recorded before the room's thread stops.
        post(() -> { calls.flush(); if (keys != null) keys.wipe(); exec.shutdown(); });
    }

    /* ---------------------------------------------------------- frames */

    private void onFrame(String text) {
        JSONObject f;
        try { f = new JSONObject(text); } catch (JSONException e) { return; }
        people.onFrame(f); // 6.2 people: signed-in connections, away members
        presence.onFrame(f); // 6.7 presence: foreground, last seen, held members
        switch (f.optString("type")) {
            case "hello": {
                // 6.12 (§ 13): the server's nonce for the join proof; the join goes out now.
                Object nonce = f.opt("nonce");
                hubNonce = nonce instanceof String ? (String) nonce : "";
                if (!joinSent) sendJoin(ws);
                break;
            }
            case "key-bundles": onKeyBundles(f); break;
            case "kt-lookup": onKtLookup(f); break;
            case "joined": {
                myId = f.optString("peerId", myId);
                resumeSecret = f.optString("resume", "");
                Resume.save(app, key, myId, resumeSecret);
                status = "joined";
                notice = "";
                proven = f.optBoolean("proven", false);
                cz.m5cet.app.rtc.Rtc.hubConnected(); // 6.12: TURN credentials only now (the server saw our hub socket)
                JSONArray list = f.optJSONArray("peers");
                system(app.t("rooms.connected") + " · " + label);
                if (list != null) for (int i = 0; i < list.length(); i++) {
                    JSONObject p = list.optJSONObject(i);
                    if (p != null) createPeer(p.optString("peerId"), p.optString("name"), true);
                }
                sendAuth();
                sendPresence(); // 6.7: the app went to the background while joining
                // Peers of an earlier connection that are gone for good.
                for (Peer p : new ArrayList<>(peers.values())) if (p.pc == null || "closed".equals(p.status)) dropPeer(p.id, false);
                changed();
                break;
            }
            case "peer-joined": {
                String id = f.optString("peerId");
                Peer p = peers.get(id);
                if (p != null) p.name = f.optString("name", p.name);
                rooms.pendingNames.put(key + "|" + id, f.optString("name"));
                system(f.optString("name") + " ↗");
                changed();
                break;
            }
            case "peer-updated": {
                Peer p = peers.get(f.optString("peerId"));
                if (p != null) { p.name = f.optString("name", p.name); changed(); }
                break;
            }
            // 6.7 held: the connection went, they did not leave — still listed, as away (RoomPresence).
            case "peer-left": dropPeer(f.optString("peerId"), true, f.optBoolean("held")); break;
            case "signal": onSignal(f.optString("source"), f.optJSONObject("payload")); break;
            case "rate-limited": notice = "rate limited: " + f.optString("frame"); changed(); break;
            // 6.1: files the server relays (nobody had an open channel to the sender).
            case "proxy-meta": case "proxy-chunk": case "proxy-end": case "proxy-cancel": {
                Peer from = peers.get(f.optString("from"));
                files.onJson(from, f, true);
                break;
            }
            case "proxy-need": files.onJson(null, f, true); break;
            // 6.1, with an account: the server keeps messages for members who are away.
            case "relay-deliver": onRelayDeliver(f.optJSONArray("items")); break;
            case "relay-status": onRelayStatus(f); break;
            case "auth-result": Log.i("room", logName() + " account: " + (f.optBoolean("ok") ? "on" : f.optString("message"))); break;
            case "proxy-ack": if (!f.optBoolean("accepted", true)) systemNotice("⚠ " + f.optString("reason")); break;
            case "closed-by-server": notice = f.optString("reason"); changed(); break;
            case "server-notice": onServerNotice(f); break;
            case "phone-bridge": {
                // 6.0: a call for this member (m5.telephony's phone bridge). The app shows it;
                // what the caller says arrives as private notices, taking the audio is the web app's.
                String ev = f.optString("event");
                if ("incoming".equals(ev)) system("☎ " + f.optString("from", "?") + " → " + f.optString("number") + (f.optString("label").isEmpty() ? "" : " · " + f.optString("label")));
                else if ("ended".equals(ev)) system("☎ " + f.optString("reason", "ended"));
                notice = "☎ " + f.optString("from", f.optString("number"));
                changed();
                break;
            }
            case "error": {
                notice = f.optString("message");
                Log.w("room", logName() + ": " + notice);
                // 6.0: the operator closed the room, or it is full — not a network problem to retry.
                String code = f.optString("code");
                if ("room-blocked".equals(code) || "room-full".equals(code)) {
                    system(("room-blocked".equals(code) ? "⛔ " : "👥 ") + notice);
                    disconnect();
                }
                // 6.12 (§ 13): the server refused our proof of the room key — not a network problem to retry.
                if ("room-proof".equals(code) || "room-proof-required".equals(code)) {
                    notice = tr("room-proof".equals(code) ? "p4.roomProof" : "p4.roomProofRequired");
                    system("⛔ " + notice);
                    disconnect();
                }
                changed();
                break;
            }
            default: break; // hello, pong, presence-ack, relay frames (accounts only)
        }
    }

    private void createPeer(String peerId, String name, boolean initiator) {
        if (peerId.isEmpty() || peerId.equals(myId) || peers.containsKey(peerId)) return;
        Peer p = new Peer(this, peerId, name == null || name.isEmpty() ? "peer-" + peerId.substring(Math.max(0, peerId.length() - 4)) : name, initiator);
        peers.put(peerId, p);
        p.start();
        changed();
    }

    private void dropPeer(String peerId, boolean announce) { dropPeer(peerId, announce, false); }

    private void dropPeer(String peerId, boolean announce, boolean held) {
        Peer p = peers.remove(peerId);
        senderKeys.forgetPeer(peerId);
        if (p4 != null) p4.peerGone(peerId);
        // Messages held behind a changed identity wait while the member is only away (6.7 held), and go when it left.
        List<ChatMessage> wasHeld = held ? null : this.held.remove(peerId);
        if (wasHeld != null && p != null) system("⚠ " + p.name + ": " + tr("p4.heldDropped").replace("{n}", Integer.toString(wasHeld.size())));
        if (profiles != null) profiles.forget(peerId);
        if (p != null) {
            p.close();
            if (announce) system(p.name + (held ? " ☾ " + app.t("presence.wentAway") : " ↘"));
        }
        changed();
    }

    /* --------------------------------------------------------- signals */

    private final ArrayDeque<Runnable> signalQueue = new ArrayDeque<>();
    private boolean signalBusy = false;

    /** A step that waits for WebRTC (setRemoteDescription…) holds the queue. */
    void hold() { signalBusy = true; }
    void release() { signalBusy = false; drainSignals(); }

    private void drainSignals() {
        while (!signalBusy && !signalQueue.isEmpty()) {
            try { signalQueue.poll().run(); } catch (Throwable t) { Log.e("room", "signal failed", t); }
        }
    }

    private void onSignal(String source, JSONObject payload) {
        signalQueue.add(() -> applySignal(source, payload));
        drainSignals();
    }

    private void applySignal(String source, JSONObject payload) {
        JSONObject sealed = payload == null ? null : payload.optJSONObject("sealed");
        if (sealed == null) { Log.w("room", "unsealed signal from " + source + " ignored"); return; }
        JSONObject desc;
        try {
            desc = Envelopes.openSignal(keys, source, myId, sealed);
        } catch (GeneralSecurityException e) {
            notice = app.t("room.keyMismatch");
            status = "mismatch";
            changed();
            return;
        }
        Peer p = peers.get(source);
        if (p == null) {
            createPeer(source, rooms.pendingNames.get(key + "|" + source), false);
            p = peers.get(source);
        }
        if (p != null) p.onSignal(desc);
    }

    void sendSignal(String target, JSONObject payload) {
        WebSocket w = ws;
        if (w == null || !w.isOpen() || keys == null) return;
        try { w.send(new JSONObject().put("type", "signal").put("target", target).put("payload", Envelopes.sealSignal(keys, myId, target, payload)).toString()); }
        catch (JSONException ignored) { }
    }

    /* ---------------------------------------------------- data channel */

    void onChannelOpen(Peer p) {
        sendHello(p);
        calls.announce();
        flushOutbox("channel");
        changed();
    }

    /**
     * Our hello on this channel: the protocol-3 hello (caps, user), made a
     * hello v4 (§ 2) — a 6.11 peer reads it as protocol 3. Sent when the
     * channel opens and again after a protocol-4 reset (§ 5.5).
     */
    private void sendHello(Peer p) {
        // caps: "bin" = we read binary file chunks; no "media" (call frames are not sealed by this app).
        JSONObject hello = senderKeys.hello(keys, identity, myId, p.id, null);
        try {
            // 6.7: "profile" = we speak the room's profile frames (ProfileRoom).
            hello.put("caps", new JSONArray().put("bin").put(ProfileRoom.CAP));
            String user = app.accountName();
            if (!user.isEmpty()) hello.put("user", user);
        } catch (JSONException ignored) { }
        JSONObject v4 = p4 == null ? null : p4.hello(myId, p.id, hello);
        p.send((v4 != null ? v4 : hello).toString());
    }

    void onPeerText(Peer p, String text) {
        JSONObject raw;
        try { raw = new JSONObject(text); } catch (JSONException e) { return; }
        String kind = raw.optString("kind", "");
        // 6.12 (§ 1): a device that spoke protocol 4 before and now does not is refused — nothing of it is read.
        if (p.downgrade && !"hello".equals(kind)) return;
        switch (kind) {
            case "key-check":
                if (!keys.check.equals(raw.optString("check"))) { notice = app.t("room.keyMismatch"); changed(); }
                return;
            case "hello": onHello(p, raw); return;
            case "p4-kem": if (p4 != null) p4.onKem(p.id, raw); return;
            case "p4": if (p4 != null) p4.onFrame(p.id, raw); return;
            case "p4-reset": if (p4 != null) p4.onReset(p.id, raw); return;
            case "sender-key":
                if (!isV4(p)) senderKeys.acceptSenderKey(keys, raw, p.id, myId);
                return;
            case "file-meta": case "file-chunk": case "file-end": case "file-cancel": case "file-need":
                if (raw.opt("transferId") instanceof String) { files.onJson(p, raw, false); return; }
                break;
            default: break;
        }
        // 6.12 (§ 6): a room message sealed with the peer's sender key v4.
        if (P4Room.isRoomEnvelope(raw)) {
            if (p4 == null || !p4.v4(p.id)) return;
            try {
                handleOpened(p, new Envelopes.Opened(p4.openRoom(p.id, raw), P4.VERSION, p4.signer(p.id)), false);
            } catch (P4Error e) {
                Log.w("room", "a protocol-4 room message did not open: " + e.code);
                if (!"replay".equals(e.code)) system("⚠ " + p.name + ": undecryptable message");
            }
            return;
        }
        // A protocol-4 peer speaks protocol 4 only: room-key, pair and sender-key v3 envelopes from it are not opened.
        if (isV4(p)) { Log.w("room", "a protocol-3 envelope from a protocol-4 peer ignored"); return; }
        Envelopes.Opened opened;
        try {
            String sealedWith = SenderKeys.kind(raw);
            opened = sealedWith.equals("sender-key") ? senderKeys.openLive(keys, raw, p.id)
                : sealedWith.equals("pair") ? senderKeys.openPrivate(keys, raw, p.id, myId)
                : Envelopes.openMessage(keys, raw);
        } catch (GeneralSecurityException e) {
            system("⚠ " + p.name + ": undecryptable message");
            return;
        }
        handleOpened(p, opened, "pair".equals(SenderKeys.kind(raw)));
    }

    /** The peer's current hello is protocol 4: it gets (and is heard in) protocol 4 only. */
    boolean isV4(Peer p) { return p4 != null && p4.v4(p.id); }

    /**
     * A peer's hello: the protocol-3 part (signature over the room name, the
     * pair key for an older peer), then protocol 4 (§ 2: sig4, the KEM message
     * back; the downgrade rule), the pins (§ 12) and what the hello says.
     */
    private void onHello(Peer p, JSONObject raw) {
        if (p4 != null && !p4.helloSent(p.id)) sendHello(p); // ours first: the KEM message answers the hello we sent
        String refused = senderKeys.acceptHello(keys, identity, raw, p.id, myId);
        if ("key-mismatch".equals(refused)) { notice = app.t("room.keyMismatch"); status = "mismatch"; changed(); return; }
        if (refused != null) { Log.w("room", "bad hello from " + p.id); return; }
        p.publicKey = raw.optString("pk");
        String proto = p4 == null ? "legacy" : p4.onHello(p.id, raw, people.account(p.id), System.currentTimeMillis());
        p.downgrade = "downgrade".equals(proto);
        p.protocol = proto;
        if (p.downgrade) {
            p.verified = false;
            p.beforeHello.clear();
            system("⚠ " + p.name + ": " + tr("p4.downgrade"));
            changed();
            return;
        }
        people.onHello(p.id, raw); // 6.2 people: the username it names, when the channel opened
        JSONArray caps = raw.optJSONArray("caps");
        p.caps = caps;
        p.bin = false;
        if (caps != null) for (int i = 0; i < caps.length(); i++) if ("bin".equals(caps.optString(i))) p.bin = true;
        p.verified = true;
        pinPeer(p, raw);
        if ("v4".equals(proto)) {
            rooms.p4().gossip(raw.opt("sth")); // § 14.4: their newest tree head against ours
            ktLookup(p);
            // Profiles, the chain and private messages wait for the session (onP4Established).
        } else {
            JSONObject sk = senderKeys.senderKeyFor(keys, myId, p.id);
            if (sk != null) p.send(sk.toString());
            profiles().hello(p.id, caps); // 6.7: the pair key exists now — they learn my profile's version
        }
        // What waited for this hello goes now, in the protocol it speaks (protocol 4: behind its session).
        List<Object[]> waiting = new ArrayList<>(p.beforeHello);
        p.beforeHello.clear();
        for (Object[] w : waiting) deliverTo(p, (JSONObject) w[0], (Boolean) w[1]);
        changed();
    }

    /** One payload to one peer whose protocol is known — deliver's choice for that peer. */
    private void deliverTo(Peer p, JSONObject payload, boolean priv) {
        if (p.downgrade || !p.open()) return;
        String id = payload.optString("id");
        if (isV4(p)) {
            if (priv) { p4.sendPrivate(p.id, payload); return; }
            try { p4.sendRoom(java.util.Collections.singletonList(p.id), id, payload.toString(), System.currentTimeMillis()); }
            catch (P4Error e) { Log.w("room", "cannot seal a protocol-4 room message: " + e.getMessage()); }
            return;
        }
        JSONObject envelope;
        if (priv && senderKeys.hasPair(p.id)) envelope = senderKeys.sealPrivate(keys, id, payload, myId, p.id, identity);
        else if (senderKeys.hasPair(p.id)) {
            if (!senderKeys.hasOurKey(p.id)) { JSONObject sk = senderKeys.senderKeyFor(keys, myId, p.id); if (sk != null) p.send(sk.toString()); }
            envelope = senderKeys.sealLive(keys, id, payload, identity);
        } else envelope = Envelopes.sealMessage(keys, id, payload, identity);
        if (envelope != null) p.send(envelope.toString());
    }

    /** The pair session with a protocol-4 peer is up: what waited for it goes now. */
    private void onP4Established(String peerId) {
        Peer p = peers.get(peerId);
        if (p == null) return;
        profiles().hello(p.id, p.caps); // 6.7: they learn my profile's version (sent over the ratchet)
        flushOutbox("p4");
        changed();
    }

    /**
     * An opened message from a peer (any protocol): a profile frame, a
     * receipt, a chat message — checked for freshness and replay (§ 11),
     * held while the sender's identity is "changed" (§ 12.1).
     */
    private void handleOpened(Peer p, Envelopes.Opened opened, boolean pairSealed) {
        // 6.7: a member's profile — only sealed for us alone (a pair envelope, or the ratchet).
        JSONObject profileFrame = profileFrame(opened.payload, p.id);
        if (profileFrame != null) { if (pairSealed) profiles().receive(p.id, profileFrame); return; }
        if (opened.signer != null && opened.signer.valid && opened.signer.accountValid) profiles().signedBy(p.id, opened.signer.accountKey);
        Payloads.Receipt receipt = Payloads.receipt(opened.payload, p.id, myId);
        if (receipt != null) { applyReceipt(p, receipt); return; }
        ChatMessage m = Payloads.validate(opened.payload, p.id, myId);
        if (m == null) return;
        if (!seen.add(m.id)) return;
        while (seen.size() > 20_000) seen.remove(seen.iterator().next());
        if ("audio-status".equals(m.kind)) { p.audio = m.text; calls.onPeerAudio(p, m.text); changed(); return; }
        if (!freshMessage(m, opened.payload.opt("createdAt"), opened.version == P4.VERSION)) return;
        m.roomKey = key;
        // 6.7 S15: the pinned key, under its name — 6.12 § 12.1: and "verified" only when the person verified it.
        m.verified = Verified.p2p(opened.signer, p.publicKey, p.changed, m.senderName, p.name) && Trust.VERIFIED.equals(p.trust);
        m.changed = p.changed;
        if (m.expired(System.currentTimeMillis())) return;
        arrived(m, "p2p");
        if (p.changed) { hold(p, m); return; }
        add(m, true);
        if (app.settings.bool("messages.receipts")) queueReceipt(p.id, "delivered", m.id);
        scheduleExpiry();
    }

    /* ------------------------------------------------- 6.12 identity (§ 12) */

    /**
     * The pins and the identity state of a peer whose hello was accepted: an
     * attested device (a valid account certificate in its hello v4) is pinned
     * by its account key, across rooms; any other by (room, name) as before.
     */
    private void pinPeer(Peer p, JSONObject raw) {
        String kid = Ec.kid(p.publicKey);
        Handshake.AccountCheck acc = p4 == null || !"v4".equals(p.protocol) ? null : p4.account(p.id);
        boolean attested = acc != null && acc.valid;
        PeerFacts.Facts facts = people.get(p.id);
        String user = facts == null ? "" : facts.username;
        String namePin = attested ? rooms.pinVerdict(room, p.name, kid) : rooms.pin(room, p.name, kid);
        String accountPin = attested ? rooms.p4().store.pinAccount(acc.publicKey, p.publicKey, user) : null;
        if (attested && "new".equals(namePin)) rooms.pin(room, p.name, kid);
        updateTrust(p, attested, accountPin, namePin);
    }

    private void updateTrust(Peer p, boolean attested, String accountPin, String namePin) {
        Handshake.AccountCheck acc = p4 == null ? null : p4.account(p.id);
        boolean devVerified = cz.m5cet.app.contacts.Store.verified(app, Ec.kid(p.publicKey));
        boolean accVerified = attested && acc != null && rooms.p4().store.accountVerified(acc.publicKey);
        boolean was = p.changed;
        p.trust = Trust.of(attested, accountPin, namePin, devVerified, accVerified, "revoked".equals(p.kt));
        p.changed = Trust.CHANGED.equals(p.trust);
        if (p.changed && !was) system("⚠ " + p.name + ": " + tr("p4.identityChanged"));
    }

    /** A message from a peer whose identity changed: kept out of the conversation until the person accepts (§ 12.1). */
    private void hold(Peer p, ChatMessage m) {
        List<ChatMessage> list = held.computeIfAbsent(p.id, k -> new ArrayList<>());
        list.add(m);
        while (list.size() > 200) list.remove(0);
        if (list.size() == 1) system("⚠ " + p.name + ": " + tr("p4.held"));
        changed();
    }

    /** How many messages of this peer are held (§ 12.1). */
    public int heldCount(String peerId) { List<ChatMessage> l = held.get(peerId); return l == null ? 0 : l.size(); }

    /**
     * People › verify: the person compared the safety number (on) or took the
     * verification back (off). On: the peer's changed identity is accepted —
     * its pins follow (the name's, and its account's, which counts as
     * verified everywhere) and its held messages appear.
     */
    public void identityVerified(String peerId, boolean on) {
        post(() -> {
            Peer p = peers.get(peerId);
            if (p == null || p.publicKey == null || p.publicKey.isEmpty()) return;
            Handshake.AccountCheck acc = p4 == null || !"v4".equals(p.protocol) ? null : p4.account(p.id);
            boolean attested = acc != null && acc.valid;
            PeerFacts.Facts facts = people.get(p.id);
            String user = facts == null ? "" : facts.username;
            if (on) {
                rooms.repin(room, p.name, Ec.kid(p.publicKey));
                if (attested) { rooms.p4().store.acceptAccount(acc.publicKey, p.publicKey, user); rooms.p4().store.setAccountVerified(acc.publicKey, true); }
                p.kt = "revoked".equals(p.kt) ? "accepted" : p.kt;
                updateTrust(p, attested, attested ? "match" : null, "match");
                List<ChatMessage> list = held.remove(peerId);
                if (list != null) for (ChatMessage m : list) { m.changed = false; add(m, true); }
            } else {
                if (attested) rooms.p4().store.setAccountVerified(acc.publicKey, false);
                updateTrust(p, attested, attested ? "match" : null, "match");
            }
            changed();
        });
    }

    /** § 14.4: an attested peer's device against key transparency (the hub's kt-lookup by its room reference). */
    private void ktLookup(Peer p) {
        Handshake.AccountCheck acc = p4 == null ? null : p4.account(p.id);
        String ref = people.account(p.id);
        P4Device dev = rooms.p4();
        if (acc == null || !acc.valid || ref.isEmpty() || dev.kt.key(dev.origin()) == null) return;
        try { sendServer(new JSONObject().put("type", "kt-lookup").put("ref", ref)); } catch (JSONException ignored) { }
    }

    private void onKtLookup(JSONObject f) {
        String ref = f.optString("ref");
        JSONObject lookup = f.optJSONObject("lookup");
        if (ref.isEmpty() || lookup == null) return; // key transparency is not running there
        P4Device dev = rooms.p4();
        for (Peer p : new ArrayList<>(peers.values())) {
            Handshake.AccountCheck acc = p4 == null ? null : p4.account(p.id);
            if (!ref.equals(people.account(p.id)) || acc == null || !acc.valid) continue;
            PeerFacts.Facts facts = people.get(p.id);
            String user = facts == null ? "" : facts.username;
            String pk = p.publicKey, apk = acc.publicKey;
            Io.bg(() -> {
                Kt.Checked c = dev.kt.lookup(dev.origin(), lookup, user.isEmpty() ? null : Kt.user(user), dev.fetcher());
                String state;
                if (!c.ok) state = "unverifiable";
                else {
                    Kt.Status st = Kt.deviceStatus(c.entries, apk, pk, System.currentTimeMillis());
                    boolean logged = false;
                    for (Kt.Entry e : c.entries) if ("acct".equals(e.entry.optString("t"))) logged = true;
                    state = st.ok ? "ok" : st.revoked || (logged && !st.account) ? "revoked" : "missing";
                }
                post(() -> {
                    if (peers.get(p.id) != p || "accepted".equals(p.kt)) return;
                    p.kt = state;
                    if ("revoked".equals(state)) updateTrust(p, true, "match", "match");
                    changed();
                });
            });
        }
    }

    /** "@name" mentions in a text (a relayed message to an away member named so wakes them as a mention). */
    static List<String> mentionNames(String text) {
        List<String> out = new ArrayList<>();
        if (text == null) return out;
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("@([\\p{L}\\p{N}._-]{1,40})").matcher(text);
        while (m.find() && out.size() < 20) out.add(m.group(1));
        return out;
    }

    /** A 6.12 text (the published design may not have it yet: English then). */
    String tr(String key) { return P4Texts.t(app, key); }

    private void system(String text) { add(ChatMessage.system(key, text), false); }

    /* ------------------------------------------------------ profiles (6.7) */

    private ProfileRoom.Exchange profiles;

    /** The room's side of the profile frames (ProfileRoom), on the room's thread. */
    private ProfileRoom.Exchange profiles() {
        if (profiles != null) return profiles;
        profiles = new ProfileRoom.Exchange(Profiles.of(app).cache, new ProfileRoom.Deps() {
            /** Sealed with the pair key to that one peer — never the room key, never via the server. */
            @Override public boolean send(String peerId, JSONObject frame) {
                Peer p = peers.get(peerId);
                if (p == null || !p.open() || keys == null || !canPrivate(peerId)) return false;
                try {
                    JSONObject payload = new JSONObject(frame.toString()).put("kind", "profile").put("id", "prof-" + Crypto.hex(Crypto.random(12)))
                        .put("createdAt", System.currentTimeMillis()).put("senderId", myId).put("senderName", userName);
                    // The sealed frame (base64 of the padded body, either protocol) stays under the limit.
                    if (Pad.paddedLength(Crypto.utf8(payload.toString()).length) * 4L / 3 + 2048 > ProfileRoom.FRAME_MAX_CHARS) return false;
                    return privateTo(p, payload);
                } catch (JSONException | RuntimeException e) { return false; }
            }
            @Override public JSONObject myView() { return Profiles.of(app).roomView(); }
            @Override public String ownerOf(String peerId) { Peer p = peers.get(peerId); return p == null || p.publicKey == null || p.publicKey.isEmpty() ? null : p.publicKey; }
            @Override public long now() { return System.currentTimeMillis(); }
        });
        return profiles;
    }

    /** A checked profile frame from this channel's peer (bound to it, never ours), or null. */
    private JSONObject profileFrame(JSONObject payload, String peerId) {
        if (payload == null || !"profile".equals(payload.optString("kind")) || !peerId.equals(payload.optString("senderId")) || peerId.equals(myId)) return null;
        return ProfileRoom.parse(payload);
    }

    /** 6.7: my profile changed — every member who speaks profiles learns its version. */
    public void profileChanged() { post(() -> { if (keys != null) profiles().changed(); }); }

    /** 6.7: what a member shares with the room (null: nothing, or an app without profiles). */
    public JSONObject profileOf(String peerId) { return Profiles.of(app).cache.of(peerId); }

    /** 6.7: the account key that signed a member's messages ("" = none yet). */
    public String accountKeyOf(String peerId) { ProfileRoom.Exchange x = profiles; return x == null ? "" : x.accountKey(peerId); }

    /**
     * 6.7 (audit N18 / F-10): how the log names this room — never by its name (the room name is the
     * salt of its key, and the log reaches the server through the "status" command).
     */
    String logName() { return "room#" + Integer.toHexString(System.identityHashCode(this) & 0xffff); }

    /**
     * 6.0: the operator speaks (the console, a function's m5room.wall_msg / user_msg /
     * user_flash) — plain text from the server, not in the room's encryption, and said
     * so. A wall or a private message stays in the conversation; a flash is a notice.
     */
    private void onServerNotice(JSONObject f) {
        String text = f.optString("text");
        if (text.isEmpty()) return;
        if (text.length() > 2000) text = text.substring(0, 2000);
        String kind = f.optString("kind", "wall");
        String from = f.optString("from", "operator");
        if ("flash".equals(kind) || "wake".equals(kind)) { notice = text; changed(); return; }
        ChatMessage m = ChatMessage.system(key, text);
        m.id = "notice-" + f.optString("id", Long.toString(System.nanoTime(), 36));
        m.senderName = ("message".equals(kind) ? "✉ " : f.optBoolean("pinned") ? "📌 " : "📣 ") + from;
        m.createdAt = f.optLong("at", System.currentTimeMillis());
        synchronized (messages) { for (ChatMessage x : messages) if (m.id.equals(x.id)) return; }
        add(m, false);
        notice = text;
        changed();
    }

    private void add(ChatMessage m, boolean fresh) {
        synchronized (messages) {
            messages.add(m);
            while (messages.size() > 600) messages.remove(0);
        }
        if (!"sys".equals(m.kind)) lastActivity = m.createdAt;
        rooms.onMessage(this, m, fresh && !m.mine && !"sys".equals(m.kind));
    }

    /* ------------------------------------------------------------ send */

    /** 5.x callers: text, a reply, an inline picture. */
    public void send(String text, ChatMessage replyTo, String fileName, String fileMime, String dataUrl, long fileSize) {
        Outgoing o = new Outgoing();
        o.text = text == null ? "" : text;
        o.replyTo = replyTo;
        if (dataUrl != null) { o.fileName = fileName; o.fileMime = fileMime; o.dataUrl = dataUrl; o.fileSize = fileSize; o.fileImage = Payloads.inlineImage(fileMime); }
        send(o);
    }

    /**
     * Sends a message (App.tsx sendChatPayload): the bubble shows at once as
     * "sending"; sealing (slow PBKDF2) happens off the room's thread; then it
     * goes to the recipients' channels (everyone, or only the selected peers
     * for a private message) — "sent" — or waits in the outbox — "queued".
     */
    public ChatMessage send(Outgoing o) {
        ChatMessage m = new ChatMessage();
        m.id = "msg-" + Crypto.hex(Crypto.random(12));
        m.roomKey = key;
        m.text = o.text == null ? "" : o.text;
        m.createdAt = System.currentTimeMillis();
        m.senderName = userName;
        m.mine = true;
        m.verified = true;
        m.status = "sending";
        m.mark("created", "", m.createdAt);
        m.tap = o.tap;
        m.vanishSeconds = o.vanishSeconds > 0 ? Math.max(Payloads.VANISH_MIN, Math.min(Payloads.VANISH_MAX, o.vanishSeconds)) : 0;
        m.to.addAll(o.recipientNames);
        m.forwardedFrom = o.forwardedFrom;
        m.loc = o.loc;
        m.fn = o.fn;
        m.fnLocal = o.fnLocal;
        m.sourceAudio = o.sourceAudio;
        if (o.ttlMinutes > 0) { m.ttlMinutes = Math.min(Payloads.MAX_TTL_MINUTES, o.ttlMinutes); m.expiresAt = m.createdAt + m.ttlMinutes * 60_000L; }
        if (o.replyTo != null) {
            m.replyToId = o.replyTo.id; m.replyToSender = o.replyTo.senderName;
            String q = o.replyTo.sealed != null ? "🔒" : !o.replyTo.visibleText().isEmpty() ? o.replyTo.visibleText() : (o.replyTo.fileName != null ? "📎 " + o.replyTo.fileName : "");
            m.replyToText = q.length() > 200 ? q.substring(0, 200) : q;
        }
        if (o.dataUrl != null) { m.fileName = o.fileName; m.fileMime = o.fileMime; m.fileSize = o.fileSize; m.fileDataUrl = o.dataUrl; m.fileImage = o.fileImage; }
        boolean seal = o.sealCode != null && !m.text.isEmpty();
        if (seal) { m.sealCode = o.sealCode.isEmpty() ? Sealed.newCode() : o.sealCode; m.sealPlain = m.text; }
        post(() -> { m.senderId = myId; add(m, false); });
        if (calls.audioText() && !m.text.isEmpty() && o.sealCode == null) {
            cz.m5cet.app.voice.CallAudio.get().say(app, m.text, id -> { if (id != null) { m.sourceAudio = id; rooms.messageChanged(this, m); } });
        }
        Runnable deliverIt = () -> post(() -> finishSend(m, o));
        if (seal) Io.bg(() -> {
            try {
                JSONObject meta = new JSONObject();
                m.text = Sealed.seal(m.sealPlain, m.sealCode, meta)[0];
                m.sealed = meta;
                m.mark("encrypted", "code");
                deliverIt.run();
            } catch (GeneralSecurityException e) {
                Log.e("room", "sealing failed", e);
                post(() -> { m.status = "queued"; systemNotice("⚠ " + e.getMessage()); });
            }
        });
        else deliverIt.run();
        return m;
    }

    private void finishSend(ChatMessage m, Outgoing o) {
        if (keys == null) { m.status = "queued"; m.mark("queued"); rooms.messageChanged(this, m); return; }
        m.senderId = myId;
        JSONObject payload = payloadOf(m);
        if (payload == null) return;
        java.util.Set<String> targets = o.recipients.isEmpty() ? null : o.recipients;
        m.mark("encrypted");
        String to = openNames(targets);
        int sent = deliver(payload, targets);
        if (sent > 0) m.raise("sent", to);
        else {
            m.status = "queued";
            m.mark("queued");
            synchronized (outbox) {
                outbox.add(new Queued(m, payload, targets));
                while (outbox.size() > 200) outbox.remove(0);
            }
        }
        // 6.12: a room message also goes to the members who are away (the relay, sealed per device — § 7.4).
        if (targets == null) relayToAway(payload, mentionNames(m.text));
        rooms.messageChanged(this, m);
        scheduleExpiry();
    }

    /** The payload of a message of mine, as the web builds it (App.tsx:3255-3267). */
    JSONObject payloadOf(ChatMessage m) {
        try {
            JSONObject payload = new JSONObject().put("id", m.id).put("text", m.text).put("createdAt", m.createdAt).put("senderId", myId).put("senderName", userName);
            // 6.11: a model's room answer replies to the command's own bubble, which is never sent — that quote stays here (and the command's arguments with it).
            if (m.replyToId != null && !m.replyToId.startsWith("fncall-")) payload.put("replyTo", new JSONObject().put("id", m.replyToId).put("senderName", m.replyToSender).put("text", m.replyToText));
            if (m.fileDataUrl != null) payload.put("attachment", new JSONObject().put("kind", m.fileImage ? "image" : "file").put("name", m.fileName).put("mime", m.fileMime).put("size", m.fileSize).put("dataUrl", m.fileDataUrl));
            if (m.ttlMinutes > 0) payload.put("ttlMinutes", m.ttlMinutes);
            JSONObject flags = new JSONObject();
            if (m.tap) flags.put("tap", true);
            if (m.vanishSeconds > 0) flags.put("vanishSeconds", m.vanishSeconds);
            if (m.sealed != null) flags.put("sealed", m.sealed);
            if (m.fn != null) flags.put("fn", m.fn);
            if (flags.length() > 0) payload.put("flags", flags);
            if (!m.to.isEmpty()) payload.put("to", new JSONArray(m.to));
            if (m.forwardedFrom != null) payload.put("forwardedFrom", m.forwardedFrom);
            if (m.loc != null) payload.put("loc", m.loc);
            return payload;
        } catch (JSONException e) { return null; }
    }

    /**
     * To the open peers with the best key each can open (deliverToPeers in
     * App.tsx). 6.12: a protocol-4 peer gets our sender key v4 (a room
     * message) or a ratchet `msg` (a private one) — while its session is still
     * being made, in order once it is; an older peer the sender-key or pair
     * envelope of protocol 3 when we share a pair key, the room envelope
     * otherwise. A downgraded peer gets nothing. targets = null: everyone;
     * else only those peers.
     */
    int deliver(JSONObject payload, java.util.Set<String> targets) {
        String id = payload.optString("id");
        JSONObject roomEnvelope = null, live = null;
        List<String> v4Room = new ArrayList<>();
        int sent = 0;
        for (Peer p : new ArrayList<>(peers.values())) {
            if (!p.open() || p.downgrade || (targets != null && !targets.contains(p.id))) continue;
            // 6.12: its hello has not said yet which protocol it speaks — the payload waits for it (onHello).
            if (p.protocol.isEmpty() && p4 != null) {
                if (p.beforeHello.size() < 200) { p.beforeHello.add(new Object[]{payload, targets != null}); sent++; }
                continue;
            }
            if (isV4(p)) {
                if (targets != null) { if (p4.sendPrivate(p.id, payload)) sent++; }
                else v4Room.add(p.id);
                continue;
            }
            JSONObject envelope;
            if (targets != null && senderKeys.hasPair(p.id)) {
                envelope = senderKeys.sealPrivate(keys, id, payload, myId, p.id, identity);
            } else if (senderKeys.hasPair(p.id)) {
                if (!senderKeys.hasOurKey(p.id)) {
                    JSONObject sk = senderKeys.senderKeyFor(keys, myId, p.id);
                    if (sk != null) p.send(sk.toString());
                }
                if (live == null) live = senderKeys.sealLive(keys, id, payload, identity);
                envelope = live;
            } else {
                if (roomEnvelope == null) roomEnvelope = Envelopes.sealMessage(keys, id, payload, identity);
                envelope = roomEnvelope;
            }
            if (p.send(envelope.toString())) sent++;
        }
        if (!v4Room.isEmpty()) {
            try { sent += p4.sendRoom(v4Room, id, payload.toString(), System.currentTimeMillis()); }
            catch (P4Error e) { Log.w("room", "cannot seal a protocol-4 room message: " + e.getMessage()); }
        }
        return sent;
    }

    int deliver(JSONObject payload) { return deliver(payload, null); }

    /** Can this peer get a private payload (a protocol-4 session — possibly still being made — or a protocol-3 pair key)? */
    boolean canPrivate(String peerId) {
        Peer p = peers.get(peerId);
        if (p == null || p.downgrade) return false;
        return p4 != null && p4.v4(peerId) || senderKeys.hasPair(peerId);
    }

    /** A private payload (receipt, profile frame) to one peer: the ratchet for a protocol-4 peer, the pair key for an older one. */
    boolean privateTo(Peer p, JSONObject payload) {
        if (p.downgrade) return false;
        if (isV4(p)) return p4.sendPrivate(p.id, payload);
        try {
            JSONObject sealed = senderKeys.sealPrivate(keys, payload.getString("id"), payload, myId, p.id, identity);
            return sealed != null && p.send(sealed.toString());
        } catch (JSONException e) { return false; }
    }

    /* ------------------------------------------------------------- relay */

    /** The account on this socket ({type:"auth"}): the relay then holds messages for us and reports states. */
    void sendAuth() {
        post(() -> {
            WebSocket w = ws;
            String token = app.account.token();
            if (w == null || !w.isOpen() || !connected() || token.isEmpty()) return;
            // 6.7: with notifications on, the server covers for this device while the app is closed
            // (keeps its messages, wakes it — server/notify) instead of dropping it from the room.
            boolean away = cz.m5cet.app.push.NotifyPrefs.get(app).awayWanted();
            try { w.send(new JSONObject().put("type", "auth").put("token", token).put("away", away).toString()); } catch (JSONException ignored) { }
        });
    }

    /** Relayed messages waiting for the key directory's answers (by message id): the payload, the recipients, the mentions. */
    private final Map<String, Object[]> relayWaiting = new LinkedHashMap<>();

    /**
     * 6.12 (§ 7.4): a room message for the signed-in members who are away —
     * each sealed for every known device of theirs (the key directory over the
     * hub, the bundles their hellos showed), the protocol-3 room envelope only
     * for those without any. Waits up to 3 s for the directory.
     */
    private void relayToAway(JSONObject payload, List<String> mentionNames) {
        if (keys == null || !connected()) return;
        java.util.Set<String> here = new java.util.HashSet<>();
        for (Peer p : new ArrayList<>(peers.values())) if (p.open()) { String a = people.account(p.id); if (!a.isEmpty()) here.add(a); }
        List<String> refs = new ArrayList<>(), mention = new ArrayList<>();
        for (PeerFacts.Away a : people.away()) {
            if (here.contains(a.account) || refs.contains(a.account)) continue;
            refs.add(a.account);
            if (mentionNames != null) for (String n : mentionNames) if (Verified.sameName(n, a.name)) mention.add(a.account);
            if (refs.size() >= 50) break;
        }
        if (refs.isEmpty()) return;
        String id = payload.optString("id");
        long now = System.currentTimeMillis();
        boolean waiting = false;
        for (String ref : refs) {
            if (relay.shouldAsk(ref, now)) { sendServer(P4Relay.askFrame(ref)); waiting = true; }
            else if (!relay.known(ref, now)) waiting = true;
        }
        if (!waiting) { sendRelay(id, payload, refs, mention); return; }
        relayWaiting.put(id, new Object[]{payload, refs, mention});
        while (relayWaiting.size() > 100) relayWaiting.remove(relayWaiting.keySet().iterator().next());
        Io.TIMER.schedule(() -> post(() -> {
            Object[] w = relayWaiting.remove(id);
            if (w != null) sendRelayParked(id, w);
        }), 3, TimeUnit.SECONDS);
    }

    @SuppressWarnings("unchecked")
    private void sendRelayParked(String id, Object[] w) { sendRelay(id, (JSONObject) w[0], (List<String>) w[1], (List<String>) w[2]); }

    /** The hub's key-bundles answer: cached, and the relayed messages that waited for it go. */
    private void onKeyBundles(JSONObject f) {
        String ref = relay.onKeyBundles(f, System.currentTimeMillis(), apk -> rooms.p4().store.accountAllowed(apk, people.userOf(f.optString("ref"))));
        // (an account key that is not the one pinned for the user's name is not sealed to — § 12.1 "changed")
        if (ref.isEmpty()) return;
        long now = System.currentTimeMillis();
        for (String id : new ArrayList<>(relayWaiting.keySet())) {
            Object[] w = relayWaiting.get(id);
            @SuppressWarnings("unchecked") List<String> refs = (List<String>) w[1];
            boolean all = true;
            for (String r : refs) if (!relay.known(r, now)) all = false;
            if (all) { relayWaiting.remove(id); sendRelayParked(id, w); }
        }
    }

    private void sendRelay(String id, JSONObject payload, List<String> refs, List<String> mention) {
        if (keys == null) return;
        long now = System.currentTimeMillis();
        Map<String, List<P4Relay.Device>> devices = new HashMap<>();
        for (String ref : refs) devices.put(ref, relay.devices(ref, rooms.p4().store.bundlesOfRef(ref, now), now));
        P4Device dev = rooms.p4();
        Mailbox box = dev.mailbox(identity);
        JSONObject sacc = dev.account(identity);
        String json = payload.toString();
        try {
            JSONObject frame = P4Relay.frame(id, refs, devices,
                d -> box.seal(keys.roomId, id, json, d.pk, d.bundle, sacc, now),
                () -> Envelopes.sealMessage(keys, id, payload, identity), mention);
            if (frame != null) sendServer(frame);
        } catch (JSONException e) {
            Log.w("room", "relay frame: " + e.getMessage());
        }
    }

    /**
     * relay-deliver: messages and states kept for us; each handled item is
     * acknowledged. 6.12: a message sealed for this device's mailbox (`mb`, or
     * its item of an `mb-set`, § 7.3), or a protocol-3 room envelope.
     */
    private void onRelayDeliver(JSONArray items) {
        if (items == null || keys == null) return;
        JSONArray ack = new JSONArray();
        long now = System.currentTimeMillis();
        for (int i = 0; i < items.length() && i < 500; i++) {
            JSONObject it = items.optJSONObject(i);
            if (it == null) continue;
            String itemId = it.optString("id");
            if ("status".equals(it.optString("kind"))) {
                JSONObject st = it.optJSONObject("status");
                if (st != null) raiseMine(it.optString("messageId"), st.optString("state"), st.optString("recipientName", "relay"));
                ack.put(itemId);
                continue;
            }
            JSONObject env = it.optJSONObject("envelope");
            JSONObject from = it.optJSONObject("from");
            if (env == null || from == null) { ack.put(itemId); continue; }
            Envelopes.Opened opened;
            String pinnedKid = "";
            boolean changedKey = false;
            if (P4Relay.isP4(env)) {
                Mailbox.Opened o;
                try { o = rooms.p4().mailbox(identity).open(env, keys.roomId, now); }
                catch (P4Error e) { Log.w("room", "a relayed protocol-4 message did not open: " + e.code); ack.put(itemId); continue; }
                if (o == null) continue; // not for this device: another device of the account may open it
                Handshake.AccountCheck acc = Handshake.verifyAccount(o.sacc, o.spk, now);
                rooms.p4().store.rememberBundle(o.spk, o.senderBundle, null);
                opened = new Envelopes.Opened(o.payload, P4.VERSION, new Envelopes.Signer(o.spk, true, acc == null ? null : acc.publicKey, acc != null && acc.valid));
                // § 7.3: the sender's key against the pins — an attested device is its account's (pinned across
                // rooms by account key); an unattested one is the name's pin in this room.
                if (acc == null || !acc.valid) {
                    String name = Payloads.clean(o.payload.opt("senderName"), Payloads.NAME, from.optString("name"));
                    pinnedKid = rooms.pinned(room, name);
                    changedKey = !pinnedKid.isEmpty() && !pinnedKid.equals(Ec.kid(o.spk));
                }
            } else {
                try { opened = Envelopes.openMessage(keys, env); }
                catch (GeneralSecurityException e) { continue; } // not acknowledged: another key may open it later
            }
            ack.put(itemId);
            ChatMessage m = Payloads.validate(opened.payload, from.optString("peerId"), myId);
            if (m == null || !seen.add(m.id) || "audio-status".equals(m.kind)) continue;
            if (!freshMessage(m, opened.payload.opt("createdAt"), opened.version == P4.VERSION)) continue;
            m.roomKey = key;
            m.relayed = true;
            if (opened.version == P4.VERSION) {
                m.changed = changedKey;
                m.verified = !changedKey && trustOfRelayed(opened.signer);
            } else {
                m.verified = Verified.relay(opened.signer, rooms.pinned(room, m.senderName)) && cz.m5cet.app.contacts.Store.verified(app, Ec.kid(opened.signer.publicKey)); // 6.7 S15 + 6.12 § 12.1
            }
            if (m.expired(System.currentTimeMillis())) continue;
            arrived(m, "relay");
            add(m, true);
        }
        if (ack.length() > 0) try { sendServer(new JSONObject().put("type", "relay-ack").put("ids", ack)); } catch (JSONException ignored) { }
        scheduleExpiry();
    }

    /** A relayed protocol-4 sender the person verified (its device key, or its account). */
    private boolean trustOfRelayed(Envelopes.Signer s) {
        if (s == null) return false;
        if (cz.m5cet.app.contacts.Store.verified(app, Ec.kid(s.publicKey))) return true;
        return s.accountValid && rooms.p4().store.accountVerified(s.accountKey);
    }

    /** relay-status: stored / forwarded / delivered / read for a message of mine (rejected: a notice). */
    private void onRelayStatus(JSONObject f) {
        String state = f.optString("state");
        String name = f.optJSONObject("recipient") == null ? "" : f.optJSONObject("recipient").optString("name");
        if ("rejected".equals(state)) { system("⚠ " + name + ": " + f.optString("reason")); return; }
        if ("duplicate".equals(state)) return;
        raiseMine(f.optString("messageId"), state, name);
    }

    private void raiseMine(String messageId, String state, String who) {
        ChatMessage hit = null;
        synchronized (messages) { for (int i = messages.size() - 1; i >= 0; i--) if (messages.get(i).id.equals(messageId)) { hit = messages.get(i); break; } }
        if (hit == null || !hit.mine) return;
        try { if (ChatMessage.rank(state) > ChatMessage.rank(hit.receipts.optString(who, ""))) hit.receipts.put(who.isEmpty() ? "relay" : who, state); } catch (JSONException ignored) { }
        hit.raise(state, who.isEmpty() ? "relay" : who);
        rooms.messageChanged(this, hit); // a new step of the timeline even when the status stays
    }

    /* ------------------------------------------------------------ outbox */

    /** A message no channel took yet. 6.12: the payload, sealed per peer when it goes (protocol 4 or 3 by peer). */
    static final class Queued {
        final ChatMessage message;
        final JSONObject payload;
        final java.util.Set<String> targets;
        final long createdAt = System.currentTimeMillis();
        int attempts = 0;
        Queued(ChatMessage m, JSONObject payload, java.util.Set<String> t) { message = m; this.payload = payload; targets = t; }
    }

    /** outbox.ts flush: to the peers that are open now; gone as soon as one took it, after 60 tries or 24 h. */
    void flushOutbox(String reason) {
        List<Queued> due = new ArrayList<>();
        synchronized (outbox) {
            long now = System.currentTimeMillis();
            for (Iterator<Queued> it = outbox.iterator(); it.hasNext(); ) {
                Queued q = it.next();
                if (now - q.createdAt > 24 * 3600_000L || q.attempts >= 60 || q.message.expired(now)) { it.remove(); continue; }
                due.add(q);
            }
        }
        if (due.isEmpty() || keys == null) return;
        List<Queued> done = new ArrayList<>();
        for (Queued q : due) {
            q.attempts++;
            if (deliver(q.payload, q.targets) > 0) done.add(q);
        }
        synchronized (outbox) { outbox.removeAll(done); }
        for (Queued q : done) {
            q.message.raise("sent");
            rooms.messageChanged(this, q.message);
            Log.d("room", "outbox → sent (" + reason + ")");
        }
    }

    /* ---------------------------------------------------------- receipts */

    /**
     * 6.1 receipts: a sealed payload {kind:"receipt", ids, state} to the one
     * peer, with our pair key (never the room key alone) — 6.12: over the
     * ratchet to a protocol-4 peer. Web clients before 6.1 drop unknown
     * payload kinds silently. "delivered" on arrival (not for relayed messages
     * — the relay reports those), "read" when shown and messages.readReceipts
     * allows it.
     */
    void queueReceipt(String peerId, String state, String messageId) {
        post(() -> {
            if (!canPrivate(peerId)) return;
            receiptQueue.computeIfAbsent(peerId, k -> new HashMap<>()).computeIfAbsent(state, k -> new ArrayList<>()).add(messageId);
            if (receiptTimer == null) receiptTimer = Io.TIMER.schedule(() -> post(this::sendReceipts), 400, TimeUnit.MILLISECONDS);
        });
    }

    private void sendReceipts() {
        receiptTimer = null;
        for (Map.Entry<String, Map<String, List<String>>> e : receiptQueue.entrySet()) {
            Peer p = peers.get(e.getKey());
            if (p == null || !p.open() || !canPrivate(p.id)) continue;
            for (Map.Entry<String, List<String>> st : e.getValue().entrySet()) {
                List<String> ids = st.getValue();
                for (int from = 0; from < ids.size(); from += 50) {
                    try {
                        JSONObject payload = new JSONObject().put("kind", "receipt").put("id", "rcpt-" + Crypto.hex(Crypto.random(12))).put("createdAt", System.currentTimeMillis())
                            .put("senderId", myId).put("senderName", userName).put("state", st.getKey()).put("ids", new JSONArray(ids.subList(from, Math.min(ids.size(), from + 50))));
                        privateTo(p, payload);
                    } catch (JSONException ignored) { }
                }
            }
        }
        receiptQueue.clear();
    }

    /** A peer's receipt for messages of mine: the state goes up (per peer; the bubble shows the highest). */
    private void applyReceipt(Peer p, Payloads.Receipt r) {
        java.util.Set<String> ids = new java.util.HashSet<>(r.ids);
        List<ChatMessage> changedOnes = new ArrayList<>();
        synchronized (messages) {
            for (int i = messages.size() - 1, n = 0; i >= 0 && n < 2000; i--, n++) {
                ChatMessage m = messages.get(i);
                if (!m.mine || !ids.contains(m.id)) continue;
                String before = m.receipts.optString(p.id, "");
                if (ChatMessage.rank(r.state) > ChatMessage.rank(before)) try { m.receipts.put(p.id, r.state); } catch (JSONException ignored) { }
                m.raise(r.state, p.name);
                changedOnes.add(m); // the timeline has the recipient's step even when the status stays
            }
        }
        for (ChatMessage m : changedOnes) rooms.messageChanged(this, m);
    }

    /** The UI showed these messages (room on screen, app unlocked): "read" to their senders. */
    public void markRead(List<ChatMessage> shown) {
        if (!app.settings.bool("messages.readReceipts")) return;
        for (ChatMessage m : shown) {
            if (m.mine || m.relayed || "sys".equals(m.kind) || m.readSent || m.senderId.isEmpty() || cz.m5cet.app.fn.ModelIdentity.reservedSender(m.senderId)) continue; // 6.11: no receipt to the app's own sender
            m.readSent = true;
            queueReceipt(m.senderId, "read", m.id);
        }
    }

    /* ------------------------------------------------------------ expiry */

    /** ttlMinutes: gone at expiresAt, for both sides (App.tsx:1888-1903). */
    private void scheduleExpiry() {
        long next = Long.MAX_VALUE;
        synchronized (messages) { for (ChatMessage m : messages) if (m.expiresAt > 0) next = Math.min(next, m.expiresAt); }
        if (next == Long.MAX_VALUE) return;
        if (expiryTimer != null) expiryTimer.cancel(false);
        long delay = Math.max(250, next - System.currentTimeMillis());
        expiryTimer = Io.TIMER.schedule(() -> post(this::expire), delay, TimeUnit.MILLISECONDS);
    }

    private void expire() {
        long now = System.currentTimeMillis();
        List<ChatMessage> gone = new ArrayList<>();
        synchronized (messages) {
            for (Iterator<ChatMessage> it = messages.iterator(); it.hasNext(); ) {
                ChatMessage m = it.next();
                if (m.expired(now)) { it.remove(); gone.add(m); }
            }
        }
        for (ChatMessage m : gone) { m.vanished = true; m.mark("expired", "ttl"); rooms.messageChanged(this, m); }
        if (!gone.isEmpty()) History.saveSoon(app, key, this);
        scheduleExpiry();
    }

    /** A vanishing message ran out on this device (the UI counts its time on screen). */
    public void vanished(ChatMessage m) {
        post(() -> { m.vanished = true; m.mark("expired", "vanish"); rooms.messageChanged(this, m); History.saveSoon(app, key, this); });
    }

    /* ------------------------------------- 6.2 bubbles (timeline, hide, delete) */

    /** A message that came in: created (the sender's clock), received and decrypted now — via "p2p" or "relay". */
    private static void arrived(ChatMessage m, String via) {
        long now = System.currentTimeMillis();
        m.mark("created", "", m.createdAt);
        m.mark("received", via, now);
        m.mark("decrypted", "", now);
    }

    /** The names of the open peers a message goes to now (the timeline's "sent"). */
    private String openNames(java.util.Set<String> targets) {
        List<String> names = new ArrayList<>();
        for (Peer p : new ArrayList<>(peers.values())) if (p.open() && (targets == null || targets.contains(p.id))) names.add(p.name);
        return String.join(", ", names);
    }

    /** The room as the server knows it (the audit journal hashes it like its other entries). */
    public String roomId() { RoomKeys k = keys; return k == null ? "" : k.roomId; }

    /** A step only this device keeps (displayed, revealed, opened, a hide ended): into the history soon. */
    public void touched(ChatMessage m) { History.saveSoon(app, key, this); }

    /** Hides the message in this view until then (ChatMessage.UNTIL_SIGNIN with the unlock it belongs to), or shows it again (until = 0). */
    public void hide(ChatMessage m, long until, String unlock, String why) {
        post(() -> {
            m.hiddenUntil = until;
            m.hiddenFor = until == ChatMessage.UNTIL_SIGNIN ? unlock : null;
            m.mark(until == 0 ? "unhidden" : "hidden", why);
            rooms.messageChanged(this, m);
            History.saveSoon(app, key, this);
        });
    }

    /**
     * Deleted on this device: out of the view, the outbox and the stored
     * history at once — not from anyone else's. Its file (and a transcript's
     * recording) goes too when no other message of any room points to it
     * (a forward shares the vault file).
     */
    public void deleteLocal(ChatMessage m) {
        post(() -> {
            synchronized (messages) { messages.remove(m); }
            synchronized (outbox) { outbox.removeIf(q -> q.message == m); }
            m.deleted = true;
            History.save(app, key, messagesCopy());
            rooms.messageChanged(this, m);
            String[] files = {m.filePath, m.sourceAudio};
            Io.bg(() -> {
                for (String id : files) {
                    if (id == null || id.isEmpty() || fileInUse(id)) continue;
                    try { cz.m5cet.app.security.FileVault.delete(app, id); } catch (IllegalArgumentException ignored) { }
                }
            });
        });
    }

    private boolean fileInUse(String id) {
        for (Rooms.Saved s : rooms.saved()) {
            RoomSession r = rooms.session(s.key);
            for (ChatMessage x : r != null ? r.messagesCopy() : History.load(app, s.key)) if (id.equals(x.filePath) || id.equals(x.sourceAudio)) return true;
        }
        return false;
    }

    /** audio ↔ text calls: what a peer said, as its message here (local only), with the recording behind it. */
    void addTranscript(String peerId, String text, String sourceId) {
        post(() -> {
            Peer p = peers.get(peerId);
            ChatMessage m = new ChatMessage();
            m.id = "call-" + Crypto.hex(Crypto.random(10));
            m.roomKey = key;
            m.senderId = peerId;
            m.senderName = p == null ? "?" : p.name;
            m.text = "🎙 " + text;
            m.createdAt = System.currentTimeMillis();
            m.verified = p != null && p.verified;
            m.sourceAudio = sourceId;
            add(m, true);
        });
    }

    /**
     * 6.5: a command call shows at once as the sender's own bubble — pulsing,
     * with a loading indicator under the query (App.tsx runChatCommand). The
     * call state lives in fnLocal (query / pending / progress / status), so
     * the renderer draws it and fnCallStatus replaces the loading in place.
     * Returns the message so the caller can settle it. 6.11: the model's
     * answer is its own message below (addModelAnswer), replying to this one;
     * the history keeps this bubble's status (ChatMessage.callState).
     */
    public ChatMessage startFnCall(String keyword, String name, String query, String icon) {
        ChatMessage m = new ChatMessage();
        m.id = "fncall-" + Crypto.hex(Crypto.random(10));
        m.roomKey = key;
        m.senderId = myId == null ? "" : myId;
        m.senderName = userName;
        m.text = query == null ? "" : query;
        m.createdAt = System.currentTimeMillis();
        m.mine = true;
        m.verified = true;
        m.status = "displayed";
        m.mark("displayed", "", m.createdAt);
        try {
            org.json.JSONObject fn = new org.json.JSONObject();
            fn.put("keyword", keyword).put("name", name).put("query", m.text).put("pending", true);
            if (icon != null) fn.put("icon", icon);
            m.fnLocal = fn;
        } catch (org.json.JSONException ignored) { }
        post(() -> { add(m, false); changed(); });
        return m;
    }

    /**
     * The loading becomes a short status chip: the answer is below it (6.11:
     * its own message), went to the room, or an error / a cancel. kind: ok,
     * error, info; code: what it was (timeout, cancelled, bad-input,
     * answered, sent…) — the icon, and the words when label is "".
     */
    public void fnCallStatus(ChatMessage m, String kind, String label, String code) {
        if (m == null) return;
        post(() -> {
            try {
                org.json.JSONObject fn = m.fnLocal != null ? m.fnLocal : new org.json.JSONObject();
                fn.put("pending", false);
                fn.remove("outputs");
                fn.remove("progress");
                org.json.JSONObject st = new org.json.JSONObject().put("kind", kind).put("label", label == null ? "" : label);
                if (code != null) st.put("code", code);
                fn.put("status", st);
                m.fnLocal = fn;
            } catch (org.json.JSONException ignored) { }
            rooms.messageChanged(this, m);
        });
    }

    /** 6.11: what a running command says it is doing (its progress: 0–1 or −1 when unknown, and a text) — under the loading. */
    public void fnCallProgress(ChatMessage m, double p, String text) {
        if (m == null) return;
        post(() -> {
            org.json.JSONObject fn = m.fnLocal;
            if (fn == null || !fn.optBoolean("pending")) return;
            try {
                String t = text == null ? "" : text.length() > 200 ? text.substring(0, 200) : text;
                fn.put("progress", new org.json.JSONObject().put("p", Double.isFinite(p) ? Math.max(-1, Math.min(1, p)) : -1).put("text", t));
            } catch (org.json.JSONException ignored) { }
            rooms.messageChanged(this, m);
        });
    }

    /**
     * 6.11: a model's answer as an INCOMING message from system-messenger —
     * the model's name as the sender, its identity (keyword, name, icon) for
     * the avatar, a reply to the command that asked (the call bubble, or the
     * message whose button or form it answers). Here only, never sent; the
     * history keeps it with what fits into a message (share), this run shows
     * every output (local).
     */
    public ChatMessage addModelAnswer(org.json.JSONObject identity, String text, org.json.JSONObject share, org.json.JSONObject local, ChatMessage replyTo) {
        ChatMessage m = new ChatMessage();
        m.id = "fn-" + Crypto.hex(Crypto.random(10));
        m.roomKey = key;
        m.senderId = cz.m5cet.app.fn.ModelIdentity.SYSTEM_MESSENGER_ID;
        m.senderName = identity == null ? cz.m5cet.app.fn.ModelIdentity.SYSTEM_MESSENGER_NAME : identity.optString("name", cz.m5cet.app.fn.ModelIdentity.SYSTEM_MESSENGER_NAME);
        m.text = text == null ? "" : text;
        m.createdAt = Math.max(System.currentTimeMillis(), replyTo == null ? 0 : replyTo.createdAt + 1);
        m.verified = true;
        m.model = identity;
        m.fn = share;
        m.fnLocal = local;
        m.mark("displayed", "", m.createdAt);
        if (replyTo != null) {
            m.replyToId = replyTo.id;
            m.replyToSender = replyTo.senderName;
            String q = replyTo.visibleText();
            m.replyToText = q.length() > 200 ? q.substring(0, 200) : q;
        }
        post(() -> add(m, false));
        return m;
    }

    /** A message of this room by id (null: not here). */
    public ChatMessage message(String id) {
        if (id == null) return null;
        synchronized (messages) { for (int i = messages.size() - 1; i >= 0; i--) if (id.equals(messages.get(i).id)) return messages.get(i); }
        return null;
    }

    /**
     * 6.10: a note to myself — kept in this room's history on this device and
     * never sent: no channel, no relay, no receipt (kind "note", which a peer's
     * payload can never be: Payloads takes only "text"). Mine, "displayed" like a
     * command call, its "to" naming only me so the bubble says it is private. The
     * NFC tool keeps a card read this way: the text, and a file (inline, or a
     * vault file for a large one).
     */
    public void addNote(String text, String fileName, String fileMime, String dataUrl, String filePath, long fileSize, String toLabel) {
        post(() -> {
            ChatMessage m = new ChatMessage();
            m.id = "note-" + Crypto.hex(Crypto.random(10));
            m.roomKey = key;
            m.kind = "note";
            m.senderId = myId == null ? "" : myId;
            m.senderName = userName;
            m.text = text == null ? "" : text;
            m.createdAt = System.currentTimeMillis();
            m.mine = true;
            m.verified = true;
            m.status = "displayed";
            m.mark("created", "", m.createdAt);
            if (toLabel != null && !toLabel.isEmpty()) m.to.add(toLabel);
            if (fileName != null) {
                m.fileName = fileName;
                m.fileMime = fileMime;
                m.fileDataUrl = dataUrl;
                m.filePath = filePath;
                m.fileSize = fileSize;
            }
            add(m, false);
            changed();
        });
    }

    /* ------------------------------------------------------------- files */

    void addFile(ChatMessage m) { if (!m.mine) arrived(m, ""); add(m, !m.mine); }
    void fileChanged(ChatMessage m) { rooms.messageChanged(this, m); }
    void fileDone(ChatMessage m) { rooms.messageChanged(this, m); History.saveSoon(app, key, this); }
    void systemNotice(String text) { post(() -> system(text)); }
    boolean canProxy() { WebSocket w = ws; return w != null && w.isOpen() && !peers.isEmpty(); }

    void sendServer(JSONObject frame) {
        WebSocket w = ws;
        if (w != null && w.isOpen()) w.send(frame.toString());
    }

    /**
     * Sends a file from the vault (FileVault id): the own bubble at once with
     * progress, then the transfer to every open channel (or via the server).
     */
    public ChatMessage sendFile(String vaultId, String name, String mime, long size, Outgoing o) {
        ChatMessage m = new ChatMessage();
        m.id = "file-" + Crypto.hex(Crypto.random(12));
        m.roomKey = key;
        m.createdAt = System.currentTimeMillis();
        m.senderName = userName;
        m.mine = true;
        m.verified = true;
        m.status = "sending";
        m.fileName = name;
        m.fileMime = Payloads.safeMime(mime);
        m.fileImage = Payloads.inlineImage(m.fileMime);
        m.fileSize = size;
        m.filePath = vaultId;
        m.fileProgress = 0;
        m.mark("created", "", m.createdAt);
        if (o != null) m.loc = o.loc;
        post(() -> { m.senderId = myId; add(m, false); files.send(vaultId, name, m.fileMime, size, m); });
        return m;
    }

    /** audio-status to everyone (sealed like a message). */
    void broadcastAudio(String state) {
        post(() -> {
            if (keys == null || myId.isEmpty()) return;
            try {
                JSONObject payload = new JSONObject().put("kind", "audio-status").put("id", "aud-" + Crypto.hex(Crypto.random(8))).put("createdAt", System.currentTimeMillis())
                    .put("senderId", myId).put("senderName", userName).put("status", state);
                deliver(payload);
            } catch (JSONException ignored) { }
        });
    }

    /* ------------------------------------------------------------ view */

    /** A peer's name ("" when gone). */
    public String peerName(String peerId) { Peer p = peers.get(peerId); return p == null ? null : p.name; }

    public List<ChatMessage> messagesCopy() {
        synchronized (messages) { return new ArrayList<>(messages); }
    }

    public int userCount() {
        int n = connected() ? 1 : 0;
        for (Peer p : new ArrayList<>(peers.values())) if (!"closed".equals(p.status)) n++;
        return n;
    }

    /** The other people in the room with an open channel: [{id, name}] (recipients, mentions). */
    public JSONArray peersScope() {
        JSONArray out = new JSONArray();
        for (Peer p : new ArrayList<>(peers.values())) {
            if (!p.open()) continue;
            try { out.put(new JSONObject().put("id", p.id).put("name", p.name)); } catch (JSONException ignored) { }
        }
        return out;
    }

    public JSONArray usersScope() {
        JSONArray out = new JSONArray();
        try {
            if (connected()) out.put(trustFields(new JSONObject().put("name", userName).put("me", true).put("verified", true).put("away", false).put("audio", calls.state()), null));
            for (Peer p : new ArrayList<>(peers.values())) {
                if ("closed".equals(p.status)) continue;
                out.put(trustFields(new JSONObject().put("name", p.name).put("me", false).put("verified", p.verified && !p.changed).put("changed", p.changed).put("away", false).put("audio", p.audio).put("status", p.status), p));
            }
        } catch (JSONException ignored) { }
        return out;
    }

    void restore(List<ChatMessage> history) {
        post(() -> {
            synchronized (messages) { messages.addAll(0, history); }
            for (ChatMessage m : history) seen.add(m.id);
            if (!history.isEmpty()) lastActivity = history.get(history.size() - 1).createdAt;
            changed();
        });
    }

    /* ---------------------------------------------------- 6.2 people */

    /** 6.2 People: usernames, signed-in connections, away members, statistics (PeerFacts). */
    final PeerFacts people = new PeerFacts();

    /**
     * 6.2: everyone of the room for the People widget — me, the peers and the
     * signed-in members who are away: [{id, name, me, channel (open |
     * connecting | closed | away), username, signedIn, since, audio, signed
     * (a valid hello), changed, publicKey, app, rtt (ms, -1 = unknown)}].
     * An away member's id is "away:" + the server's account reference.
     */
    public JSONArray peopleScope() {
        JSONArray out = new JSONArray();
        try {
            if (connected()) {
                String user = app.accountName();
                out.put(trustFields(new JSONObject().put("id", myId).put("name", userName).put("me", true).put("channel", "open").put("username", user)
                    .put("signedIn", !user.isEmpty()).put("since", (double) people.joinedAt).put("audio", calls.state()).put("signed", true)
                    .put("changed", false).put("publicKey", myPublicKey()).put("app", "").put("rtt", -1.0), null));
            }
            java.util.Set<String> here = new java.util.HashSet<>();
            for (Peer p : new ArrayList<>(peers.values())) {
                PeerFacts.Facts f = people.get(p.id);
                String account = people.account(p.id);
                if (!account.isEmpty()) here.add(account);
                cz.m5cet.app.contacts.RtcStats.Summary st = f == null ? null : f.stats;
                String channel = "open".equals(p.status) ? "open" : "closed".equals(p.status) ? "closed" : "connecting";
                out.put(trustFields(new JSONObject().put("id", p.id).put("name", p.name).put("me", false).put("channel", channel)
                    .put("username", f == null ? "" : f.username).put("signedIn", !account.isEmpty()).put("since", f == null ? 0.0 : (double) f.since)
                    .put("audio", p.audio).put("signed", p.verified).put("changed", p.changed).put("publicKey", p.publicKey == null ? "" : p.publicKey)
                    .put("app", f == null ? "" : f.app).put("rtt", st == null ? -1.0 : (double) st.rttMs), p));
            }
            for (PeerFacts.Away w : people.away()) {
                if (here.contains(w.account)) continue;
                out.put(new JSONObject().put("id", "away:" + w.account).put("name", w.name).put("me", false).put("channel", "away")
                    .put("username", people.userOf(w.account)).put("signedIn", true).put("since", (double) w.since).put("audio", "off")
                    .put("signed", false).put("changed", false).put("publicKey", "").put("app", "").put("rtt", -1.0));
            }
            addPresence(out);
        } catch (JSONException ignored) { }
        return out;
    }

    /**
     * 6.12: what a person row says of protocol 4 — trust (§ 12.1: new,
     * verified, account, changed) and its words, the protocol ("p4", or
     * "legacy" = older protocol, no PCS / PQ), whether the server says the
     * member proved the room key (§ 13: null when it does not say), messages
     * held, key transparency's word on an attested device. p = null: me.
     */
    JSONObject trustFields(JSONObject u, Peer p) throws JSONException {
        if (p == null) {
            u.put("trust", Trust.VERIFIED).put("protocol", p4 == null ? "legacy" : "p4").put("legacy", false).put("proven", proven).put("unproven", false).put("held", 0).put("kt", "").put("ktLabel", "");
            return u.put("trustLabel", "").put("protocolLabel", tr(p4 == null ? "p4.legacy" : "p4.protocol4"));
        }
        boolean legacy = "legacy".equals(p.protocol);
        Boolean pr = people.proven(p.id);
        u.put("trust", p.trust).put("trustLabel", tr("p4.trust." + p.trust)).put("protocol", "v4".equals(p.protocol) ? "p4" : p.protocol)
            .put("legacy", legacy).put("protocolLabel", legacy ? tr("p4.legacy") : "v4".equals(p.protocol) ? tr("p4.protocol4") : "")
            .put("downgrade", p.downgrade).put("proven", pr == null ? JSONObject.NULL : pr).put("unproven", Boolean.FALSE.equals(pr))
            .put("held", heldCount(p.id)).put("kt", p.kt)
            .put("ktLabel", p.kt.isEmpty() || "accepted".equals(p.kt) ? "" : tr("p4.kt." + p.kt));
        return u;
    }

    /**
     * 6.12 (§ 12.2): the two keys a safety number is made of — both account
     * keys when both sides are attested (a verified account stays verified on
     * every device), else both device keys. {mine, theirs}; "" when unknown.
     */
    public String[] safetyKeys(String peerId) {
        Peer p = peers.get(peerId);
        String theirs = p == null || p.publicKey == null ? "" : p.publicKey, mine = myPublicKey();
        Handshake.AccountCheck acc = p == null || p4 == null || !"v4".equals(p.protocol) ? null : p4.account(peerId);
        String my = identity == null ? "" : rooms.p4().myAccountKey(identity);
        if (acc != null && acc.valid && !my.isEmpty()) return new String[]{my, acc.publicKey};
        return new String[]{mine, theirs};
    }

    /** 6.12: the security info's alert — key transparency for this server ("" when none; § 14.4). */
    public String ktAlert() {
        String kind = rooms.p4().ktAlert();
        return kind.isEmpty() ? "" : tr("p4.kt.alert." + kind);
    }

    /** 6.2: a peer's connection statistics (null before the first reading). */
    public cz.m5cet.app.contacts.RtcStats.Summary peerStats(String peerId) {
        PeerFacts.Facts f = people.get(peerId);
        return f == null ? null : f.stats;
    }

    /** 6.2: this device's key in the room (the other half of a safety number); "" before it connected. */
    public String myPublicKey() { ChatIdentity i = identity; return i == null ? "" : i.publicKey; }

    /**
     * 6.2: the room is still settling — it is connecting, joined moments ago,
     * or a peer's channel is not open (or has not said hello) yet — so a
     * contact's "message via M5cet" waits a little before it says "not online".
     */
    public boolean peopleSettling(long now) {
        if (!connected()) return wanted && !"mismatch".equals(status);
        if (now - people.joinedAt < 8000) return true;
        for (Peer p : new ArrayList<>(peers.values())) {
            if ("closed".equals(p.status)) continue;
            if (!"open".equals(p.status) || people.get(p.id) == null) return true;
        }
        return false;
    }

    /** 6.2: reads each open peer connection's statistics; `each` runs after every reading (on a WebRTC thread). */
    public void refreshStats(Runnable each) {
        post(() -> {
            for (Peer p : new ArrayList<>(peers.values())) {
                if (p.pc == null || !"open".equals(p.status)) continue;
                String id = p.id;
                try {
                    p.pc.getStats(report -> {
                        Map<String, cz.m5cet.app.contacts.RtcStats.Entry> all = new HashMap<>();
                        for (Map.Entry<String, org.webrtc.RTCStats> e : report.getStatsMap().entrySet()) {
                            all.put(e.getKey(), new cz.m5cet.app.contacts.RtcStats.Entry(e.getValue().getType(), e.getValue().getMembers()));
                        }
                        people.stats(id, cz.m5cet.app.contacts.RtcStats.parse(all, System.currentTimeMillis()));
                        if (each != null) each.run();
                    });
                } catch (RuntimeException e) {
                    Log.d("room", "stats of " + id + ": " + e.getMessage());
                }
            }
        });
    }

    /* --------------------------------------------------- 6.2 bubbles */

    /* -------------------------------------------------- 6.7 presence */

    /** 6.7: who is online, away or far away (server frames), and the members whose connection went. */
    final RoomPresence presence = new RoomPresence();
    /** The app is in the foreground (what the room is told), and what the server knows. */
    private volatile boolean foreground = true;
    private boolean sentForeground = true;
    private long presenceAt = 0;
    private ScheduledFuture<?> presenceTimer;
    /** The server's rate limit: a burst, then one presence frame per 5 s — changes closer than this wait, and only the latest goes. */
    private static final long PRESENCE_GAP_MS = 6_000;

    /** 6.7: the app went to the background or came back — the room sees it (presence, last seen). */
    void setForeground(boolean on) {
        post(() -> { foreground = on; sendPresence(); });
    }

    private void sendPresence() {
        if (presenceTimer != null) { presenceTimer.cancel(false); presenceTimer = null; }
        WebSocket w = ws;
        if (w == null || !w.isOpen() || !connected() || foreground == sentForeground) return;
        long wait = presenceAt + PRESENCE_GAP_MS - System.currentTimeMillis();
        if (wait > 0) { presenceTimer = Io.TIMER.schedule(() -> post(this::sendPresence), wait, TimeUnit.MILLISECONDS); return; }
        // away stays false: the app keeps receiving in the background, the relay need not cover for it.
        w.send("{\"type\":\"presence\",\"away\":false,\"foreground\":" + foreground + "}");
        sentForeground = foreground;
        presenceAt = System.currentTimeMillis();
    }

    /** 6.7: each person's presence (.connected, .foreground, .lastSeen; contacts/LastSeen words it) and the held members, listed as away. */
    private void addPresence(JSONArray out) throws JSONException {
        long now = System.currentTimeMillis();
        java.util.Set<String> ids = new java.util.HashSet<>(), awayRefs = new java.util.HashSet<>();
        for (int i = 0; i < out.length(); i++) {
            JSONObject u = out.optJSONObject(i);
            if (u == null) continue;
            String id = u.optString("id");
            ids.add(id);
            if (u.optBoolean("me")) { u.put("connected", true).put("foreground", foreground).put("lastSeen", (double) now); continue; }
            if (id.startsWith("away:")) {
                String ref = id.substring(5);
                awayRefs.add(ref);
                long seen = presence.awayLastSeen(ref);
                u.put("connected", false).put("foreground", false).put("lastSeen", seen > 0 ? (double) seen : u.optDouble("since", 0));
                continue;
            }
            RoomPresence.Live lv = presence.live(id);
            u.put("connected", true).put("foreground", lv == null || lv.foreground).put("lastSeen", lv == null ? 0.0 : (double) lv.lastSeen);
        }
        for (RoomPresence.Held h : presence.held(ids, awayRefs)) {
            out.put(new JSONObject().put("id", h.peerId).put("name", h.name).put("me", false).put("channel", "held")
                .put("username", h.account.isEmpty() ? "" : people.userOf(h.account)).put("signedIn", !h.account.isEmpty()).put("since", (double) h.since)
                .put("audio", "off").put("signed", false).put("changed", false).put("publicKey", "").put("app", "").put("rtt", -1.0)
                .put("connected", false).put("foreground", false).put("lastSeen", (double) h.lastSeen));
        }
    }
}
