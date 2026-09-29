package cz.m5cet.app.chat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.security.GeneralSecurityException;
import java.util.ArrayDeque;
import java.util.ArrayList;
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
import cz.m5cet.app.security.Crypto;

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
    final Map<String, Peer> peers = new LinkedHashMap<>();
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

    void changed() { rooms.roomChanged(this); }

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
                    Log.i("room", "keys for " + label + " in " + (System.currentTimeMillis() - t0) + " ms");
                }
                if (identity == null) identity = rooms.identity();
                openSocket();
            } catch (Exception e) {
                Log.e("room", "cannot connect " + label, e);
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
            @Override public void onBinary(WebSocket w, byte[] data) { }
            @Override public void onClose(WebSocket w, int code, String reason) { post(() -> onClosed(w, code, reason)); }
        });
        ws = socket;
        socket.connect();
    }

    private void onOpened(WebSocket w) {
        if (w != ws) return;
        attempts = 0;
        try {
            JSONObject join = new JSONObject().put("type", "join").put("protocol", 2).put("room", keys.roomId)
                .put("name", userName).put("peerId", myId.isEmpty() ? "peer-" + Crypto.hex(Crypto.random(12)) : myId).put("away", false);
            if (!resumeSecret.isEmpty()) join.put("resume", resumeSecret);
            w.send(join.toString());
        } catch (JSONException ignored) { }
        if (heartbeat != null) heartbeat.cancel(false);
        heartbeat = Io.TIMER.scheduleWithFixedDelay(() -> post(() -> {
            WebSocket s = ws;
            if (s != null && s.isOpen()) s.send("{\"type\":\"ping\",\"t\":" + System.currentTimeMillis() + "}");
        }), 25, 25, TimeUnit.SECONDS);
    }

    private void onClosed(WebSocket w, int code, String reason) {
        if (w != ws) return;
        ws = null;
        if (heartbeat != null) { heartbeat.cancel(false); heartbeat = null; }
        status = "offline";
        Log.i("room", label + " signaling closed " + code + " " + reason);
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
            for (Peer p : peers.values()) p.close();
            peers.clear();
            senderKeys.clear();
            status = "offline";
            changed();
        });
    }

    void destroy() {
        disconnect();
        post(() -> { if (keys != null) keys.wipe(); exec.shutdown(); });
    }

    /* ---------------------------------------------------------- frames */

    private void onFrame(String text) {
        JSONObject f;
        try { f = new JSONObject(text); } catch (JSONException e) { return; }
        switch (f.optString("type")) {
            case "joined": {
                myId = f.optString("peerId", myId);
                resumeSecret = f.optString("resume", "");
                status = "joined";
                notice = "";
                JSONArray list = f.optJSONArray("peers");
                system(app.t("rooms.connected") + " · " + label);
                if (list != null) for (int i = 0; i < list.length(); i++) {
                    JSONObject p = list.optJSONObject(i);
                    if (p != null) createPeer(p.optString("peerId"), p.optString("name"), true);
                }
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
            case "peer-left": dropPeer(f.optString("peerId"), true); break;
            case "signal": onSignal(f.optString("source"), f.optJSONObject("payload")); break;
            case "rate-limited": notice = "rate limited: " + f.optString("frame"); changed(); break;
            case "closed-by-server": notice = f.optString("reason"); changed(); break;
            case "server-notice": onServerNotice(f); break;
            case "error": {
                notice = f.optString("message");
                Log.w("room", label + ": " + notice);
                // 6.0: the operator closed the room, or it is full — not a network problem to retry.
                String code = f.optString("code");
                if ("room-blocked".equals(code) || "room-full".equals(code)) {
                    system(("room-blocked".equals(code) ? "⛔ " : "👥 ") + notice);
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

    private void dropPeer(String peerId, boolean announce) {
        Peer p = peers.remove(peerId);
        senderKeys.forgetPeer(peerId);
        if (p != null) {
            p.close();
            if (announce) system(p.name + " ↘");
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
        JSONObject hello = senderKeys.hello(keys, identity, myId, p.id, null);
        p.send(hello.toString());
        calls.announce();
        changed();
    }

    void onPeerText(Peer p, String text) {
        JSONObject raw;
        try { raw = new JSONObject(text); } catch (JSONException e) { return; }
        String kind = raw.optString("kind", "");
        switch (kind) {
            case "key-check":
                if (!keys.check.equals(raw.optString("check"))) { notice = app.t("room.keyMismatch"); changed(); }
                return;
            case "hello": {
                String refused = senderKeys.acceptHello(keys, identity, raw, p.id, myId);
                if ("key-mismatch".equals(refused)) { notice = app.t("room.keyMismatch"); status = "mismatch"; changed(); return; }
                if (refused != null) { Log.w("room", "bad hello from " + p.name); return; }
                p.publicKey = raw.optString("pk");
                String verdict = rooms.pin(room, p.name, Crypto.b64url(Crypto.sha256(Crypto.unb64(p.publicKey))).substring(0, 16));
                p.verified = true;
                p.changed = "changed".equals(verdict);
                if (p.changed) system("⚠ " + p.name + ": identity changed");
                JSONObject sk = senderKeys.senderKeyFor(keys, myId, p.id);
                if (sk != null) p.send(sk.toString());
                changed();
                return;
            }
            case "sender-key":
                senderKeys.acceptSenderKey(keys, raw, p.id, myId);
                return;
            case "file-meta":
                system(p.name + ": 📎 " + app.t("notify.message"));
                return;
            default:
                if (kind.startsWith("file-")) return;
        }
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
        ChatMessage m = Payloads.validate(opened.payload, p.id, myId);
        if (m == null) return;
        if (!seen.add(m.id)) return;
        while (seen.size() > 20_000) seen.remove(seen.iterator().next());
        if ("audio-status".equals(m.kind)) { p.audio = m.text; changed(); return; }
        m.roomKey = key;
        m.verified = opened.signer != null && opened.signer.valid && !p.changed;
        m.changed = p.changed;
        add(m, true);
    }

    private void system(String text) { add(ChatMessage.system(key, text), false); }

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

    public void send(String text, ChatMessage replyTo, String fileName, String fileMime, String dataUrl, long fileSize) {
        post(() -> {
            if (keys == null) return;
            ChatMessage m = new ChatMessage();
            m.id = "msg-" + Crypto.hex(Crypto.random(12));
            m.roomKey = key;
            m.text = text == null ? "" : text;
            m.createdAt = System.currentTimeMillis();
            m.senderId = myId;
            m.senderName = userName;
            m.mine = true;
            m.verified = true;
            JSONObject payload = new JSONObject();
            try {
                payload.put("id", m.id).put("text", m.text).put("createdAt", m.createdAt).put("senderId", myId).put("senderName", userName);
                if (replyTo != null) {
                    m.replyToId = replyTo.id; m.replyToSender = replyTo.senderName; m.replyToText = replyTo.text.length() > 200 ? replyTo.text.substring(0, 200) : replyTo.text;
                    payload.put("replyTo", new JSONObject().put("id", m.replyToId).put("senderName", m.replyToSender).put("text", m.replyToText));
                }
                if (dataUrl != null) {
                    m.fileName = fileName; m.fileMime = fileMime; m.fileSize = fileSize; m.fileDataUrl = dataUrl;
                    payload.put("attachment", new JSONObject().put("kind", fileMime != null && fileMime.startsWith("image/") ? "image" : "file").put("name", fileName).put("mime", fileMime).put("size", fileSize).put("dataUrl", dataUrl));
                }
            } catch (JSONException e) { return; }
            int sent = deliver(payload);
            m.status = sent > 0 ? "sent" : "queued";
            add(m, false);
        });
    }

    /** To every open peer with the best key it can open (deliverToPeers in App.tsx). */
    int deliver(JSONObject payload) {
        String id = payload.optString("id");
        JSONObject roomEnvelope = null;
        JSONObject live = null;
        int sent = 0;
        for (Peer p : peers.values()) {
            if (!p.open()) continue;
            JSONObject envelope;
            if (senderKeys.hasPair(p.id)) {
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
        return sent;
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

    public List<ChatMessage> messagesCopy() {
        synchronized (messages) { return new ArrayList<>(messages); }
    }

    public int userCount() {
        int n = connected() ? 1 : 0;
        for (Peer p : peers.values()) if (!"closed".equals(p.status)) n++;
        return n;
    }

    public JSONArray usersScope() {
        JSONArray out = new JSONArray();
        try {
            if (connected()) out.put(new JSONObject().put("name", userName).put("me", true).put("verified", true).put("away", false).put("audio", calls.state()));
            for (Peer p : peers.values()) {
                if ("closed".equals(p.status)) continue;
                out.put(new JSONObject().put("name", p.name).put("me", false).put("verified", p.verified && !p.changed).put("changed", p.changed).put("away", false).put("audio", p.audio).put("status", p.status));
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
}
