package cz.m5cet.app.chat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * A message as the app shows and keeps it: the decrypted payload plus how it
 * arrived and where it is (6.1: the web client's message kinds, recipients,
 * expiry, the position in the header, function outputs, delivery states;
 * 6.2: every state with its time — the timeline — and a hide in this view).
 */
public final class ChatMessage {
    public String id;
    public String roomKey;
    /** "text" or "sys"; 6.10: "note" — a note to myself, only in this device's history, never sent (RoomSession.addNote). */
    public String kind = "text";
    public String senderId = "";
    public String senderName = "";
    public String text = "";
    public long createdAt;
    public boolean mine;
    /**
     * Mine: sending → sent | queued, then stored / forwarded (the relay) and
     * delivered / read (receipts); received messages: "received".
     */
    public String status = "received";
    public boolean verified;
    public boolean changed;
    public String replyToId, replyToSender, replyToText;
    public String fileName, fileMime, fileDataUrl;
    public long fileSize;
    /** The attachment is drawn as a picture (kind "image" with a safe image type). */
    public boolean fileImage;
    /** A file that came (or went) by chunked transfer: the local copy, and the transfer's progress 0–1 (−1 = done). */
    public String filePath;
    public double fileProgress = -1;
    public boolean fileVerified;

    // 6.1 — the web's message kinds (flags) and addressing
    /** flags.tap: visible only while held. */
    public boolean tap;
    /** flags.vanishSeconds: gone after this long on screen (per device). */
    public int vanishSeconds;
    /** How long it has been on screen so far (ms), and whether it is gone. */
    public long vanishedMs;
    public boolean vanished;
    /** flags.sealed: {salt, iv, v, it}; text holds the ciphertext until opened. */
    public JSONObject sealed;
    /** The plain text once opened (never stored), and — for my own — the code. */
    public String sealPlain, sealCode;
    /** flags.fn: a command's result (keyword, name, model, chain, call, events, outputs). */
    public JSONObject fn;
    /** The result as this device keeps it — every output, even those too large to share; drawn instead of {@link #fn} when set. */
    public JSONObject fnLocal;
    /** to: the names of the recipients of a private message (informational). */
    public final List<String> to = new ArrayList<>();
    public String forwardedFrom;
    /** ttlMinutes → an absolute expiry (0 = none). */
    public int ttlMinutes;
    public long expiresAt;
    /** loc: {lat, lon, acc, at} — the sender's position when it was written. */
    public JSONObject loc;
    /** A transcript of a call's audio (audio ↔ text calls): the recording it came from. */
    public String sourceAudio;
    /** Receipts per recipient (peer id → state) for my own messages. */
    public final JSONObject receipts = new JSONObject();
    /** Came through the server relay (no "delivered" receipt for those). */
    public boolean relayed;
    /** A read receipt went for it (not stored). */
    transient boolean readSent;

    // 6.2 — the timeline and a hide
    /** One step of a message's life: the state, when, and for whom or how (a recipient's name, "p2p", "relay"…). */
    public static final class Step {
        public final String state;
        public final long at;
        public final String meta;
        public Step(String state, long at, String meta) { this.state = state; this.at = at; this.meta = meta == null ? "" : meta; }
    }
    /**
     * Every state with its time, in the web's words (MessageInfoModal):
     * created, encrypted, sent, received, decrypted, displayed, discarded,
     * queued, stored, forwarded, delivered, read, revealed, opened, expired,
     * hidden, unhidden. Kept with the message in the history.
     */
    private final List<Step> timeline = new ArrayList<>();
    static final int TIMELINE_MAX = 200;
    /** Hidden in this device's view until this time (ms); {@link #UNTIL_SIGNIN} = until the app is unlocked again; 0 = shown. */
    public long hiddenUntil;
    public static final long UNTIL_SIGNIN = -1;
    /** A hide until the next sign-in: the unlock it belongs to (it ends with the next one). */
    public String hiddenFor;
    /** Deleted on this device: the list drops its row (not stored — the message is gone from the history). */
    public transient boolean deleted;

    public static ChatMessage system(String roomKey, String text) {
        ChatMessage m = new ChatMessage();
        m.id = "sys-" + Long.toString(System.nanoTime(), 36);
        m.roomKey = roomKey;
        m.kind = "sys";
        m.senderId = "system";
        m.text = text;
        m.createdAt = System.currentTimeMillis();
        return m;
    }

    public boolean expired(long now) { return expiresAt > 0 && now >= expiresAt; }

    /** What the bubble shows as text: the opened seal, else the text (a sealed one stays hidden). */
    public String visibleText() {
        if (sealed != null) return sealPlain == null ? "" : sealPlain;
        return text;
    }

    /** flags.fn to draw: the full local copy when this device has it, else what came on the wire. */
    public JSONObject fnDraw() { return fnLocal != null ? fnLocal : fn; }

    static final String[] ORDER = {"sending", "queued", "sent", "stored", "forwarded", "delivered", "read"};

    static int rank(String s) {
        for (int i = 0; i < ORDER.length; i++) if (ORDER[i].equals(s)) return i;
        return -1;
    }

    /** Moves the status up (never down): sent < stored < forwarded < delivered < read; each move is a step of the timeline. */
    public boolean raise(String s) {
        if (!up(s)) return false;
        mark(s);
        return true;
    }

    /** A state for one recipient (a receipt, the relay's report): always a step naming them; the status only moves up. */
    public boolean raise(String s, String who) {
        mark(s, who);
        return up(s);
    }

    private boolean up(String s) {
        if (rank(s) > rank(status) || ("queued".equals(status) && rank(s) >= rank("sent"))) { status = s; return true; }
        return false;
    }

    /* ---------------------------------------------------------- timeline */

    public boolean mark(String state) { return mark(state, "", System.currentTimeMillis()); }
    public boolean mark(String state, String meta) { return mark(state, meta, System.currentTimeMillis()); }

    /** Adds a step; the same state with the same meta counts once (only hidden / unhidden repeat). */
    public boolean mark(String state, String meta, long at) {
        String mt = meta == null ? "" : meta;
        boolean repeats = "hidden".equals(state) || "unhidden".equals(state);
        synchronized (timeline) {
            if (!repeats) for (Step st : timeline) if (st.state.equals(state) && st.meta.equals(mt)) return false;
            timeline.add(new Step(state, at, mt));
            while (timeline.size() > TIMELINE_MAX) timeline.remove(1); // the first ("created") stays
            return true;
        }
    }

    public boolean has(String state) {
        synchronized (timeline) { for (Step st : timeline) if (st.state.equals(state)) return true; }
        return false;
    }

    /** The steps in the order they happened. */
    public List<Step> timeline() {
        List<Step> out;
        synchronized (timeline) { out = new ArrayList<>(timeline); }
        java.util.Collections.sort(out, (x, y) -> Long.compare(x.at, y.at));
        return out;
    }

    private JSONArray timelineJson() {
        JSONArray a = new JSONArray();
        synchronized (timeline) {
            for (Step st : timeline) {
                try {
                    JSONObject o = new JSONObject().put("state", st.state).put("at", st.at);
                    if (!st.meta.isEmpty()) o.put("meta", st.meta);
                    a.put(o);
                } catch (JSONException ignored) { }
            }
        }
        return a;
    }

    /** The scope the message layouts see as $msg. */
    public JSONObject scope() {
        JSONObject o = new JSONObject();
        try {
            o.put("id", id).put("text", vanished ? "" : visibleText()).put("sender", senderName).put("time", createdAt).put("mine", mine).put("status", status)
                .put("verified", verified).put("changed", changed);
            if (replyToId != null) o.put("replyTo", new JSONObject().put("id", replyToId).put("sender", replyToSender).put("text", replyToText));
            else o.put("replyTo", JSONObject.NULL);
            if (fileName != null) {
                boolean image = fileImage;
                o.put("attachment", new JSONObject().put("name", fileName).put("size", fileSize).put("mime", fileMime == null ? "" : fileMime)
                    .put("image", image).put("audio", fileMime != null && fileMime.startsWith("audio/")).put("video", fileMime != null && fileMime.startsWith("video/"))
                    .put("progress", fileProgress).put("done", fileProgress < 0).put("verified", fileVerified));
            } else o.put("attachment", JSONObject.NULL);
            o.put("tap", tap).put("vanish", vanishSeconds).put("vanished", vanished)
                .put("vanishLeft", vanishSeconds > 0 ? Math.max(0, vanishSeconds - vanishedMs / 1000.0) : 0)
                .put("sealed", sealed != null).put("opened", sealed == null || sealPlain != null).put("code", sealCode == null ? "" : sealCode)
                .put("private", !to.isEmpty()).put("to", String.join(", ", to))
                .put("forwarded", forwardedFrom == null ? "" : forwardedFrom)
                .put("expires", expiresAt)
                .put("loc", loc == null ? JSONObject.NULL : loc)
                .put("fn", fn == null ? JSONObject.NULL : new JSONObject().put("keyword", fn.optString("keyword")).put("name", fn.optString("name")))
                .put("source", sourceAudio != null)
                .put("kind", kind);
        } catch (JSONException ignored) { }
        return o;
    }

    public JSONObject toJson() {
        JSONObject o = scope();
        try {
            o.put("kind", kind).put("senderId", senderId).put("roomKey", roomKey).put("text", text); // a sealed message keeps its ciphertext
            if (fileDataUrl != null && fileDataUrl.length() < 800_000) o.put("dataUrl", fileDataUrl);
            if (filePath != null) o.put("filePath", filePath);
            if (sealed != null) o.put("sealedMeta", sealed);
            if (sealCode != null && mine) o.put("sealCode", sealCode);
            if (fn != null) o.put("fnMeta", fn);
            if (!to.isEmpty()) o.put("toList", new JSONArray(to));
            if (ttlMinutes > 0) o.put("ttlMinutes", ttlMinutes);
            if (vanishedMs > 0) o.put("vanishedMs", vanishedMs);
            if (sourceAudio != null) o.put("sourceAudio", sourceAudio);
            o.put("receipts", receipts).put("relayed", relayed);
            JSONArray tl = timelineJson();
            if (tl.length() > 0) o.put("timeline", tl);
            if (hiddenUntil != 0) o.put("hiddenUntil", hiddenUntil).put("hiddenFor", hiddenFor == null ? "" : hiddenFor);
        } catch (JSONException ignored) { }
        return o;
    }

    public static ChatMessage fromJson(JSONObject o) {
        ChatMessage m = new ChatMessage();
        m.id = o.optString("id");
        m.roomKey = o.optString("roomKey");
        m.kind = o.optString("kind", "text");
        m.senderId = o.optString("senderId");
        m.senderName = o.optString("sender");
        m.text = o.optString("text");
        m.createdAt = o.optLong("time");
        m.mine = o.optBoolean("mine");
        m.status = o.optString("status", "received");
        if ("sending".equals(m.status)) m.status = "queued";
        m.verified = o.optBoolean("verified");
        m.changed = o.optBoolean("changed");
        JSONObject r = o.optJSONObject("replyTo");
        if (r != null) { m.replyToId = r.optString("id"); m.replyToSender = r.optString("sender"); m.replyToText = r.optString("text"); }
        JSONObject a = o.optJSONObject("attachment");
        if (a != null) { m.fileName = a.optString("name"); m.fileSize = a.optLong("size"); m.fileMime = a.optString("mime"); m.fileDataUrl = o.optString("dataUrl", null); m.fileVerified = a.optBoolean("verified"); m.fileImage = a.optBoolean("image"); }
        m.filePath = o.optString("filePath", null);
        m.tap = o.optBoolean("tap");
        m.vanishSeconds = o.optInt("vanish");
        m.vanishedMs = o.optLong("vanishedMs");
        m.vanished = o.optBoolean("vanished");
        m.sealed = o.optJSONObject("sealedMeta");
        m.sealCode = o.optString("sealCode", null);
        if (m.sealCode != null && m.sealCode.isEmpty()) m.sealCode = null;
        m.fn = o.optJSONObject("fnMeta");
        JSONArray to = o.optJSONArray("toList");
        if (to != null) for (int i = 0; i < to.length(); i++) m.to.add(to.optString(i));
        String fwd = o.optString("forwarded", "");
        m.forwardedFrom = fwd.isEmpty() ? null : fwd;
        m.ttlMinutes = o.optInt("ttlMinutes");
        m.expiresAt = o.optLong("expires");
        m.loc = o.optJSONObject("loc");
        m.sourceAudio = o.optString("sourceAudio", null);
        JSONObject rc = o.optJSONObject("receipts");
        if (rc != null) for (java.util.Iterator<String> it = rc.keys(); it.hasNext(); ) { String k = it.next(); try { m.receipts.put(k, rc.opt(k)); } catch (JSONException ignored) { } }
        m.relayed = o.optBoolean("relayed");
        JSONArray tl = o.optJSONArray("timeline");
        if (tl != null) for (int i = 0; i < tl.length() && i < TIMELINE_MAX; i++) {
            JSONObject st = tl.optJSONObject(i);
            if (st != null && !st.optString("state").isEmpty()) m.timeline.add(new Step(st.optString("state"), st.optLong("at"), st.optString("meta", "")));
        }
        m.hiddenUntil = o.optLong("hiddenUntil");
        String hf = o.optString("hiddenFor", "");
        m.hiddenFor = hf.isEmpty() ? null : hf;
        return m;
    }
}
