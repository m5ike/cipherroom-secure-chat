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
            @Override public void onBinary(WebSocket w, byte[] data) { post(() -> { if (w == ws) files.onBinary(null, data); }); }
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
                .put("name", userName).put("peerId", myId.isEmpty() ? "peer-" + Crypto.hex(Crypto.random(12)) : myId).put("away", false)
                .put("features", new JSONArray().put("bin"));
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
            files.clear();
            for (Peer p : new ArrayList<>(peers.values())) p.close();
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
        people.onFrame(f); // 6.2 people: signed-in connections, away members
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
                sendAuth();
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
            case "auth-result": Log.i("room", label + " account: " + (f.optBoolean("ok") ? "on" : f.optString("message"))); break;
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
        // caps: "bin" = we read binary file chunks; no "media" (call frames are not sealed by this app).
        JSONObject hello = senderKeys.hello(keys, identity, myId, p.id, null);
        try {
            hello.put("caps", new JSONArray().put("bin"));
            String user = app.accountName();
            if (!user.isEmpty()) hello.put("user", user);
        } catch (JSONException ignored) { }
        p.send(hello.toString());
        calls.announce();
        flushOutbox("channel");
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
                people.onHello(p.id, raw); // 6.2 people: the username it names, when the channel opened
                JSONArray caps = raw.optJSONArray("caps");
                p.bin = false;
                if (caps != null) for (int i = 0; i < caps.length(); i++) if ("bin".equals(caps.optString(i))) p.bin = true;
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
            case "file-meta": case "file-chunk": case "file-end": case "file-cancel": case "file-need":
                if (raw.opt("transferId") instanceof String) { files.onJson(p, raw, false); return; }
                break;
            default: break;
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
        Payloads.Receipt receipt = Payloads.receipt(opened.payload, p.id, myId);
        if (receipt != null) { applyReceipt(p, receipt); return; }
        ChatMessage m = Payloads.validate(opened.payload, p.id, myId);
        if (m == null) return;
        if (!seen.add(m.id)) return;
        while (seen.size() > 20_000) seen.remove(seen.iterator().next());
        if ("audio-status".equals(m.kind)) { p.audio = m.text; calls.onPeerAudio(p, m.text); changed(); return; }
        m.roomKey = key;
        m.verified = opened.signer != null && opened.signer.valid && !p.changed;
        m.changed = p.changed;
        if (m.expired(System.currentTimeMillis())) return;
        arrived(m, "p2p");
        add(m, true);
        if (app.settings.bool("messages.receipts")) queueReceipt(p.id, "delivered", m.id);
        scheduleExpiry();
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
                outbox.add(new Queued(m, Envelopes.sealMessage(keys, m.id, payload, identity), targets));
                while (outbox.size() > 200) outbox.remove(0);
            }
        }
        rooms.messageChanged(this, m);
        scheduleExpiry();
    }

    /** The payload of a message of mine, as the web builds it (App.tsx:3255-3267). */
    JSONObject payloadOf(ChatMessage m) {
        try {
            JSONObject payload = new JSONObject().put("id", m.id).put("text", m.text).put("createdAt", m.createdAt).put("senderId", myId).put("senderName", userName);
            if (m.replyToId != null) payload.put("replyTo", new JSONObject().put("id", m.replyToId).put("senderName", m.replyToSender).put("text", m.replyToText));
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
     * App.tsx): a sender-key envelope to peers we share a pair with (a pair
     * envelope when the message is private), the room envelope otherwise.
     * targets = null: everyone; else only those peers.
     */
    int deliver(JSONObject payload, java.util.Set<String> targets) {
        String id = payload.optString("id");
        JSONObject roomEnvelope = null;
        JSONObject live = null;
        int sent = 0;
        for (Peer p : new ArrayList<>(peers.values())) {
            if (!p.open() || (targets != null && !targets.contains(p.id))) continue;
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
        return sent;
    }

    int deliver(JSONObject payload) { return deliver(payload, null); }

    /* ------------------------------------------------------------- relay */

    /** The account on this socket ({type:"auth"}): the relay then holds messages for us and reports states. */
    void sendAuth() {
        post(() -> {
            WebSocket w = ws;
            String token = app.account.token();
            if (w == null || !w.isOpen() || !connected() || token.isEmpty()) return;
            try { w.send(new JSONObject().put("type", "auth").put("token", token).put("away", false).toString()); } catch (JSONException ignored) { }
        });
    }

    /** relay-deliver: messages (room key) and states kept for us; each handled item is acknowledged. */
    private void onRelayDeliver(JSONArray items) {
        if (items == null || keys == null) return;
        JSONArray ack = new JSONArray();
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
            try { opened = Envelopes.openMessage(keys, env); }
            catch (GeneralSecurityException e) { continue; } // not acknowledged: another key may open it later
            ack.put(itemId);
            ChatMessage m = Payloads.validate(opened.payload, from.optString("peerId"), myId);
            if (m == null || !seen.add(m.id) || "audio-status".equals(m.kind)) continue;
            m.roomKey = key;
            m.relayed = true;
            m.verified = opened.signer != null && opened.signer.valid;
            if (m.expired(System.currentTimeMillis())) continue;
            arrived(m, "relay");
            add(m, true);
        }
        if (ack.length() > 0) try { sendServer(new JSONObject().put("type", "relay-ack").put("ids", ack)); } catch (JSONException ignored) { }
        scheduleExpiry();
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

    static final class Queued {
        final ChatMessage message;
        final JSONObject envelope;
        final java.util.Set<String> targets;
        final long createdAt = System.currentTimeMillis();
        int attempts = 0;
        Queued(ChatMessage m, JSONObject e, java.util.Set<String> t) { message = m; envelope = e; targets = t; }
    }

    /** outbox.ts flush: to the peers that are open now; gone as soon as one took it, after 60 tries or 24 h. */
    void flushOutbox(String reason) {
        List<Queued> done = new ArrayList<>();
        synchronized (outbox) {
            long now = System.currentTimeMillis();
            for (Iterator<Queued> it = outbox.iterator(); it.hasNext(); ) {
                Queued q = it.next();
                if (now - q.createdAt > 24 * 3600_000L || q.attempts >= 60 || q.message.expired(now)) { it.remove(); continue; }
                q.attempts++;
                int sent = 0;
                for (Peer p : new ArrayList<>(peers.values())) {
                    if (!p.open() || (q.targets != null && !q.targets.contains(p.id))) continue;
                    if (p.send(q.envelope.toString())) sent++;
                }
                if (sent > 0) { it.remove(); done.add(q); }
            }
        }
        for (Queued q : done) {
            q.message.raise("sent");
            rooms.messageChanged(this, q.message);
            Log.d("room", "outbox → sent (" + reason + ")");
        }
    }

    /* ---------------------------------------------------------- receipts */

    /**
     * 6.1 receipts: a sealed payload {kind:"receipt", ids, state} to the one
     * peer, with our pair key (never the room key alone). Web clients before
     * 6.1 drop unknown payload kinds silently. "delivered" on arrival (not for
     * relayed messages — the relay reports those), "read" when shown and
     * messages.readReceipts allows it.
     */
    void queueReceipt(String peerId, String state, String messageId) {
        post(() -> {
            if (!senderKeys.hasPair(peerId)) return;
            receiptQueue.computeIfAbsent(peerId, k -> new HashMap<>()).computeIfAbsent(state, k -> new ArrayList<>()).add(messageId);
            if (receiptTimer == null) receiptTimer = Io.TIMER.schedule(() -> post(this::sendReceipts), 400, TimeUnit.MILLISECONDS);
        });
    }

    private void sendReceipts() {
        receiptTimer = null;
        for (Map.Entry<String, Map<String, List<String>>> e : receiptQueue.entrySet()) {
            Peer p = peers.get(e.getKey());
            if (p == null || !p.open() || !senderKeys.hasPair(p.id)) continue;
            for (Map.Entry<String, List<String>> st : e.getValue().entrySet()) {
                List<String> ids = st.getValue();
                for (int from = 0; from < ids.size(); from += 50) {
                    try {
                        JSONObject payload = new JSONObject().put("kind", "receipt").put("id", "rcpt-" + Crypto.hex(Crypto.random(12))).put("createdAt", System.currentTimeMillis())
                            .put("senderId", myId).put("senderName", userName).put("state", st.getKey()).put("ids", new JSONArray(ids.subList(from, Math.min(ids.size(), from + 50))));
                        p.send(senderKeys.sealPrivate(keys, payload.getString("id"), payload, myId, p.id, identity).toString());
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
            if (m.mine || m.relayed || "sys".equals(m.kind) || m.readSent || m.senderId.isEmpty()) continue;
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
     * call state lives in fnLocal (query / pending / status), so the renderer
     * draws it and settleFnCall* replace the loading in place. Returns the
     * message so the caller can settle it.
     */
    public ChatMessage startFnCall(String keyword, String name, String query) {
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
            m.fnLocal = fn;
        } catch (org.json.JSONException ignored) { }
        post(() -> { add(m, false); changed(); });
        return m;
    }

    /** The loading becomes the caller-only answer, inside the same bubble (the query stays). */
    public void fnCallResult(ChatMessage m, String text, org.json.JSONObject fnLocal) {
        if (m == null) return;
        post(() -> {
            m.text = text == null ? "" : text;
            m.fnLocal = fnLocal;
            rooms.messageChanged(this, m);
        });
    }

    /** The loading becomes a short status chip (a room answer that went out, or an error / status). */
    public void fnCallStatus(ChatMessage m, String kind, String label) {
        if (m == null) return;
        post(() -> {
            try {
                org.json.JSONObject fn = m.fnLocal != null ? m.fnLocal : new org.json.JSONObject();
                fn.put("pending", false);
                fn.remove("outputs");
                fn.put("status", new org.json.JSONObject().put("kind", kind).put("label", label == null ? "" : label));
                m.fnLocal = fn;
            } catch (org.json.JSONException ignored) { }
            rooms.messageChanged(this, m);
        });
    }

    /** A caller-only command result (App.tsx showFnResult): a message here only, from the model, never sent. */
    public void addLocalFn(String keyword, String name, String text, org.json.JSONObject fn) {
        post(() -> {
            ChatMessage m = new ChatMessage();
            m.id = "fn-" + Crypto.hex(Crypto.random(10));
            m.roomKey = key;
            m.senderId = "function:" + keyword;
            m.senderName = name;
            m.text = text == null ? "" : text;
            m.createdAt = System.currentTimeMillis();
            m.verified = true;
            m.fnLocal = fn;
            add(m, false);
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
            if (connected()) out.put(new JSONObject().put("name", userName).put("me", true).put("verified", true).put("away", false).put("audio", calls.state()));
            for (Peer p : new ArrayList<>(peers.values())) {
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
                out.put(new JSONObject().put("id", myId).put("name", userName).put("me", true).put("channel", "open").put("username", user)
                    .put("signedIn", !user.isEmpty()).put("since", (double) people.joinedAt).put("audio", calls.state()).put("signed", true)
                    .put("changed", false).put("publicKey", myPublicKey()).put("app", "").put("rtt", -1.0));
            }
            java.util.Set<String> here = new java.util.HashSet<>();
            for (Peer p : new ArrayList<>(peers.values())) {
                PeerFacts.Facts f = people.get(p.id);
                String account = people.account(p.id);
                if (!account.isEmpty()) here.add(account);
                cz.m5cet.app.contacts.RtcStats.Summary st = f == null ? null : f.stats;
                String channel = "open".equals(p.status) ? "open" : "closed".equals(p.status) ? "closed" : "connecting";
                out.put(new JSONObject().put("id", p.id).put("name", p.name).put("me", false).put("channel", channel)
                    .put("username", f == null ? "" : f.username).put("signedIn", !account.isEmpty()).put("since", f == null ? 0.0 : (double) f.since)
                    .put("audio", p.audio).put("signed", p.verified).put("changed", p.changed).put("publicKey", p.publicKey == null ? "" : p.publicKey)
                    .put("app", f == null ? "" : f.app).put("rtt", st == null ? -1.0 : (double) st.rttMs));
            }
            for (PeerFacts.Away w : people.away()) {
                if (here.contains(w.account)) continue;
                out.put(new JSONObject().put("id", "away:" + w.account).put("name", w.name).put("me", false).put("channel", "away")
                    .put("username", people.userOf(w.account)).put("signedIn", true).put("since", (double) w.since).put("audio", "off")
                    .put("signed", false).put("changed", false).put("publicKey", "").put("app", "").put("rtt", -1.0));
            }
        } catch (JSONException ignored) { }
        return out;
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
}
