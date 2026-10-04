package cz.m5cet.app.chat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

import cz.m5cet.app.M5;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.security.Crypto;
import cz.m5cet.app.security.Vault;

/**
 * Every room of the app, several connected at once (6.0): the saved rooms
 * (user tier — name, passphrase, nickname), which are selected, which are
 * connected, which one is on screen, unread counts, history.
 *
 * Smart switching: a notification or a shortcut opens its room; when the
 * room on screen is left, the one with the latest activity takes its
 * place; messages elsewhere only raise that room's badge; the room bar is
 * ordered by activity and swiped through.
 */
public final class Rooms {
    public interface Listener {
        void onRoomsChanged();
        void onRoomMessage(String roomKey, ChatMessage message);
        /** 6.1: a message already shown changed (delivery state, file progress, receipts, expiry). */
        default void onRoomMessageChanged(String roomKey, ChatMessage message) { }
    }

    public static final class Saved {
        public String key, room, label, passphrase, userName;
        public boolean selected;
        public long lastActive;

        JSONObject json() throws JSONException {
            return new JSONObject().put("key", key).put("room", room).put("label", label).put("passphrase", passphrase).put("userName", userName)
                .put("selected", selected).put("lastActive", lastActive);
        }

        static Saved of(JSONObject o) {
            Saved s = new Saved();
            s.key = o.optString("key"); s.room = o.optString("room"); s.label = o.optString("label", s.room);
            s.passphrase = o.optString("passphrase"); s.userName = o.optString("userName");
            s.selected = o.optBoolean("selected"); s.lastActive = o.optLong("lastActive");
            return s;
        }
    }

    private final M5 app;
    private final Map<String, Saved> saved = new LinkedHashMap<>();
    private final Map<String, RoomSession> sessions = new ConcurrentHashMap<>();
    final Map<String, String> pendingNames = new ConcurrentHashMap<>();
    private final CopyOnWriteArrayList<Listener> listeners = new CopyOnWriteArrayList<>();
    private volatile String active = "";
    private volatile boolean visible = false;
    private ChatIdentity identity;
    private boolean loaded = false;

    public Rooms(M5 app) { this.app = app; }

    /** A saved room as a connection card ({v:1, room, passphrase, name}) for NFC; null when unknown. */
    public synchronized JSONObject cardOf(String key) {
        Saved s = saved.get(key);
        if (s == null) return null;
        try { return new JSONObject().put("v", 1).put("room", s.room).put("passphrase", s.passphrase).put("name", s.userName == null ? "" : s.userName); }
        catch (JSONException e) { return null; }
    }

    public void addListener(Listener l) { listeners.add(l); }
    public void removeListener(Listener l) { listeners.remove(l); }

    /* ------------------------------------------------------------ storage */

    public synchronized void load() {
        if (loaded) return;
        JSONArray list = app.vault.json(Vault.Tier.USER, "rooms").optJSONArray("list");
        saved.clear();
        if (list != null) for (int i = 0; i < list.length(); i++) { Saved s = Saved.of(list.optJSONObject(i)); if (!s.key.isEmpty()) saved.put(s.key, s); }
        active = app.vault.json(Vault.Tier.USER, "rooms").optString("active", "");
        loaded = true;
        Log.i("rooms", saved.size() + " saved rooms");
        // What was connected before stays connected.
        for (Saved s : saved.values()) if (s.selected) connect(s.key);
        emit();
    }

    private synchronized void persist() {
        try {
            JSONArray list = new JSONArray();
            for (Saved s : saved.values()) list.put(s.json());
            app.vault.putJson(Vault.Tier.USER, "rooms", new JSONObject().put("list", list).put("active", active));
        } catch (JSONException ignored) { }
    }

    /** The chat identity if it exists (the settings show its fingerprint), without making one. */
    public synchronized ChatIdentity identityOrNull() {
        if (identity != null) return identity;
        return app.vault.unlocked() && app.vault.json(Vault.Tier.USER, "identity").has("signPkcs8") ? identity() : null;
    }

    synchronized ChatIdentity identity() {
        if (identity != null) return identity;
        JSONObject o = app.vault.json(Vault.Tier.USER, "identity");
        try {
            if (o.has("signPkcs8")) identity = ChatIdentity.fromPkcs8(o.getString("signPkcs8"), o.getString("publicKey"), o.getString("dhPkcs8"), o.getString("dhPublicKey"));
        } catch (Exception e) {
            Log.e("rooms", "the chat identity is unreadable — a new one", e);
        }
        if (identity == null) {
            identity = ChatIdentity.generate();
            try {
                app.vault.putJson(Vault.Tier.USER, "identity", new JSONObject().put("signPkcs8", identity.signPkcs8()).put("publicKey", identity.publicKey)
                    .put("dhPkcs8", identity.dhPkcs8()).put("dhPublicKey", identity.dhPublicKey));
            } catch (JSONException ignored) { }
        }
        return identity;
    }

    /** 6.7 (S15): the key id pinned for this name in this room ("" when none), without pinning anything. */
    synchronized String pinned(String room, String name) {
        if (name == null) return "";
        return app.vault.json(Vault.Tier.USER, "pins").optString(room + "\u0000" + name.trim().toLowerCase(java.util.Locale.ROOT), "");
    }

    /** Trust on first use: room + name → key id. "new", "match" or "changed". */
    synchronized String pin(String room, String name, String kid) {
        JSONObject pins = app.vault.json(Vault.Tier.USER, "pins");
        String slot = room + "\u0000" + name.trim().toLowerCase(java.util.Locale.ROOT);
        String old = pins.optString(slot, "");
        if (old.isEmpty()) {
            try { pins.put(slot, kid); } catch (JSONException ignored) { }
            app.vault.putJson(Vault.Tier.USER, "pins", pins);
            return "new";
        }
        return old.equals(kid) ? "match" : "changed";
    }

    /* ------------------------------------------------------------- rooms */

    public synchronized List<Saved> saved() {
        List<Saved> out = new ArrayList<>(saved.values());
        out.sort(Comparator.comparingLong((Saved s) -> -Math.max(s.lastActive, sessions.containsKey(s.key) ? sessions.get(s.key).lastActivity() : 0)));
        return out;
    }

    public RoomSession session(String key) { return sessions.get(key); }
    /** 6.8: whether the saved rooms are read (after an unlock; not after a full lock or a wipe). */
    public synchronized boolean loaded() { return loaded; }
    public String active() { return active; }
    public RoomSession activeSession() { return active.isEmpty() ? null : sessions.get(active); }

    /** The connected rooms for the room bar, most recently active first. */
    public List<RoomSession> connectedSessions() {
        List<RoomSession> out = new ArrayList<>(sessions.values());
        out.sort(Comparator.comparingLong((RoomSession r) -> -r.lastActivity()));
        return out;
    }

    public int connectedCount() {
        int n = 0;
        for (RoomSession r : sessions.values()) if (r.connected()) n++;
        return n;
    }

    public int unreadTotal() {
        int n = 0;
        for (RoomSession r : sessions.values()) n += r.unread();
        return n;
    }

    public int selectedCount() {
        int n = 0;
        synchronized (this) { for (Saved s : saved.values()) if (s.selected && !sessions.containsKey(s.key)) n++; }
        return n;
    }

    public int maxRooms() {
        JSONObject r = app.config.policy().optJSONObject("rooms");
        return r == null ? 8 : Math.max(1, Math.min(16, r.optInt("max", 8)));
    }

    /** Adds (or updates) a saved room and connects it. Returns its key. */
    public String add(String roomName, String passphrase, String userName, boolean connectNow) {
        String room = RoomKeys.normalizeRoom(roomName);
        Saved s;
        synchronized (this) {
            s = saved.get(room);
            if (s == null) { s = new Saved(); s.key = room; saved.put(room, s); }
            s.room = room;
            s.label = roomName.trim().isEmpty() ? room : roomName.trim();
            s.passphrase = passphrase;
            s.userName = userName;
            s.selected = true;
            s.lastActive = System.currentTimeMillis();
            persist();
        }
        app.config.setUserName(userName);
        if (connectNow) { connect(room); switchTo(room); }
        emit();
        return room;
    }

    public synchronized void toggleSelected(String key) {
        Saved s = saved.get(key);
        if (s == null) return;
        s.selected = !s.selected;
        persist();
        emit();
    }

    /** Connects every selected room (up to the policy's maximum). */
    public void connectSelected() {
        List<String> keys = new ArrayList<>();
        synchronized (this) { for (Saved s : saved.values()) if (s.selected) keys.add(s.key); }
        for (String k : keys) connect(k);
        if (active.isEmpty() && !keys.isEmpty()) switchTo(keys.get(0));
    }

    public void connect(String key) {
        Saved s;
        synchronized (this) { s = saved.get(key); }
        if (s == null) return;
        RoomSession r = sessions.get(key);
        if (r == null) {
            if (sessions.size() >= maxRooms()) { Log.w("rooms", "at most " + maxRooms() + " rooms at once"); return; }
            r = new RoomSession(app, this, key, s.room, s.label, s.passphrase, s.userName.isEmpty() ? app.config.userName() : s.userName);
            sessions.put(key, r);
            RoomSession session = r;
            Io.bg(() -> session.restore(History.load(app, key)));
        }
        synchronized (this) { s.selected = true; persist(); }
        r.connect();
        emit();
    }

    /** Makes a room the one on screen (connecting it if needed); its badge clears. */
    public void switchTo(String key) {
        if (!sessions.containsKey(key)) connect(key);
        active = key;
        RoomSession r = sessions.get(key);
        if (r != null) r.unread = 0;
        synchronized (this) { Saved s = saved.get(key); if (s != null) s.lastActive = System.currentTimeMillis(); persist(); }
        app.notify.clearRoom(key);
        emit();
    }

    public void leave(String key) {
        String k = key == null || key.isEmpty() ? active : key;
        RoomSession r = sessions.remove(k);
        if (r != null) { History.save(app, k, r.messagesCopy()); r.destroy(); }
        synchronized (this) { Saved s = saved.get(k); if (s != null) s.selected = false; persist(); }
        if (k.equals(active)) {
            // Smart switching: the most recently active of the others.
            List<RoomSession> left = connectedSessions();
            active = left.isEmpty() ? "" : left.get(0).key;
        }
        emit();
    }

    public void forget(String key) {
        leave(key);
        synchronized (this) { saved.remove(key); persist(); }
        History.delete(app, key);
        emit();
    }

    /* ------------------------------------------- 6.7: clone and edit */

    /** A saved room by its key (a copy of what is stored), or null. */
    public synchronized Saved savedRoom(String key) {
        Saved s = key == null ? null : saved.get(key);
        try { return s == null ? null : Saved.of(s.json()); } catch (JSONException e) { return null; }
    }

    /**
     * A copy of a saved room under the next free name ("Team" → "Team 2",
     * "Team 2" → "Team 3"): the same passphrase and nickname, not selected,
     * not connected. Its key, or null for an unknown room.
     */
    public String copy(String key) {
        String k;
        synchronized (this) {
            Saved s = saved.get(key);
            if (s == null) return null;
            Saved c = new Saved();
            c.label = cloneName(s.label == null || s.label.isEmpty() ? s.room : s.label, saved.keySet());
            c.room = RoomKeys.normalizeRoom(c.label);
            c.key = c.room;
            c.passphrase = s.passphrase;
            c.userName = s.userName;
            c.selected = false;
            c.lastActive = System.currentTimeMillis();
            saved.put(c.key, c);
            persist();
            k = c.key;
        }
        emit();
        return k;
    }

    /** The name of a copy: the label with the next number no saved room has (a room's name is its key). */
    public static String cloneName(String label, java.util.Set<String> keys) {
        String base = label == null ? "" : label.trim();
        int next = 2;
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("^(.*\\S)\\s+(\\d{1,4})$").matcher(base);
        if (m.matches()) { base = m.group(1); next = Integer.parseInt(m.group(2)) + 1; }
        if (base.isEmpty()) base = "room";
        // A room's key keeps 48 characters: room for the number.
        if (base.length() > 40) base = base.substring(0, 40).trim();
        for (int i = next; i < next + 10000; i++) {
            String name = base + " " + i;
            if (!keys.contains(RoomKeys.normalizeRoom(name))) return name;
        }
        return base + " " + Long.toString(System.currentTimeMillis() % 100000);
    }

    /**
     * A saved room changed (its Edit): name, passphrase, nickname. A new name
     * is a new room — it takes the old one's place in the list (the old
     * one's history stays on the phone, as when it is joined again). A
     * connected room reconnects with what changed. The key it has now.
     */
    public String update(String oldKey, String roomName, String passphrase, String userName) {
        String room = RoomKeys.normalizeRoom(roomName);
        String label = roomName.trim().isEmpty() ? room : roomName.trim();
        Saved old;
        synchronized (this) { old = saved.get(oldKey); }
        if (old == null) return null;
        boolean changed = !room.equals(oldKey) || !label.equals(old.label) || !passphrase.equals(old.passphrase) || !userName.equals(old.userName);
        boolean connected = sessions.containsKey(oldKey), wasActive = oldKey.equals(active);
        if (changed && connected) leave(oldKey);
        synchronized (this) {
            if (!room.equals(oldKey)) saved.remove(oldKey);
            Saved s = saved.get(room);
            if (s == null) { s = new Saved(); s.key = room; saved.put(room, s); }
            s.room = room;
            s.label = label;
            s.passphrase = passphrase;
            s.userName = userName;
            s.selected = old.selected || connected;
            s.lastActive = Math.max(old.lastActive, s.lastActive);
            persist();
        }
        if (changed && connected) { connect(room); if (wasActive) switchTo(room); }
        emit();
        return room;
    }

    public void disconnectAll() {
        for (String k : new ArrayList<>(sessions.keySet())) {
            RoomSession r = sessions.remove(k);
            if (r != null) { History.save(app, k, r.messagesCopy()); r.destroy(); }
        }
        synchronized (this) { loaded = false; saved.clear(); identity = null; }
        active = "";
        emit();
    }

    public void send(String key, String text, ChatMessage replyTo) {
        RoomSession r = sessions.get(key);
        if (r != null) { Outgoing o = new Outgoing(); o.text = text; o.replyTo = replyTo; r.send(o); }
    }

    /* ------------------------------------------------------------ events */

    public void setVisible(boolean v) {
        visible = v;
        RoomSession r = activeSession();
        if (v && r != null) { r.unread = 0; app.notify.clearRoom(r.key); emit(); }
    }

    /** 6.7: every room tells its members the app is back in the foreground (presence, last seen). */
    public void onForeground() {
        for (RoomSession r : sessions.values()) r.setForeground(true);
    }

    /** The app went to the background: rooms stay connected (6.7: and listed — as away after a while). */
    public void onBackground() {
        visible = false;
        for (RoomSession r : sessions.values()) { History.save(app, r.key, r.messagesCopy()); r.setForeground(false); }
    }

    void roomChanged(RoomSession r) { emit(); }

    /** 6.1: signed in or out — every room tells its signaling socket (relay for away members). */
    public void onAccountChanged() {
        for (RoomSession r : sessions.values()) r.sendAuth();
        emit();
        cz.m5cet.app.push.NotifyPrefs.get(app).onAccountChanged(); // 6.7: the settings and this device's link follow
    }

    /** 6.7: the open room the server knows by this id (a notification names it), or null. */
    public RoomSession byServerId(String id) {
        if (id == null || id.isEmpty()) return null;
        for (RoomSession r : sessions.values()) if (r.keys != null && id.equals(r.keys.roomId)) return r;
        return null;
    }

    /** 6.8: the room is on screen now (open, the app in front and unlocked). */
    public boolean onScreen(String key) { return visible && key != null && key.equals(active) && app.inForeground() && !app.lock.isLocked(); }

    void onMessage(RoomSession r, ChatMessage m, boolean fresh) {
        boolean onScreen = onScreen(r.key);
        if (fresh && !onScreen) {
            r.unread++;
            app.notify.message(r.key, r.label, m.senderName, notifyText(m), app.lock.isLocked());
        }
        // Read aloud (voice.autoplay) — only what is shown openly.
        if (fresh && onScreen && m.sealed == null && !m.tap && m.fileName == null) app.voice.speakIncoming(m.senderName, m.text);
        if (fresh || m.mine) History.saveSoon(app, r.key, r);
        for (Listener l : listeners) Io.main(() -> l.onRoomMessage(r.key, m));
        if (!onScreen) emit();
    }

    /** What a notification may say: nothing of a sealed or held message (web: 🔒). */
    static String notifyText(ChatMessage m) {
        if (m.sealed != null) return "🔒";
        if (m.tap) return "👁";
        if (m.fn != null) return "/" + m.fn.optString("keyword") + (m.text.isEmpty() ? "" : " · " + m.text);
        return m.text.isEmpty() ? "📎 " + m.fileName : m.text;
    }

    void messageChanged(RoomSession r, ChatMessage m) {
        if (m.mine || m.filePath != null) History.saveSoon(app, r.key, r);
        for (Listener l : listeners) Io.main(() -> l.onRoomMessageChanged(r.key, m));
    }

    private void emit() { Io.main(() -> { for (Listener l : listeners) l.onRoomsChanged(); }); }

    /** The rooms as the rooms screen sees them ($rooms). */
    public JSONArray scope() {
        JSONArray out = new JSONArray();
        for (Saved s : saved()) {
            RoomSession r = sessions.get(s.key);
            try {
                out.put(new JSONObject().put("key", s.key).put("name", s.label).put("room", s.room)
                    .put("users", r == null ? 0 : r.userCount()).put("unread", r == null ? 0 : r.unread())
                    .put("active", s.key.equals(active)).put("connected", r != null && r.connected())
                    .put("status", r == null ? "saved" : r.status()).put("selected", s.selected));
            } catch (JSONException ignored) { }
        }
        return out;
    }

    public static String hashKey(String key) { return Crypto.hex(Crypto.sha256(Crypto.utf8(key))).substring(0, 16); }

}
