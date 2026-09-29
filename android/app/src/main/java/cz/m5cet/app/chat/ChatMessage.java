package cz.m5cet.app.chat;

import org.json.JSONException;
import org.json.JSONObject;

/** A message as the app shows and keeps it (the decrypted payload plus how it arrived). */
public final class ChatMessage {
    public String id;
    public String roomKey;
    /** "text" or "sys". */
    public String kind = "text";
    public String senderId = "";
    public String senderName = "";
    public String text = "";
    public long createdAt;
    public boolean mine;
    /** sent, queued, read (mine) or received. */
    public String status = "received";
    public boolean verified;
    public boolean changed;
    public String replyToId, replyToSender, replyToText;
    public String fileName, fileMime, fileDataUrl;
    public long fileSize;

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

    /** The scope the message layouts see as $msg. */
    public JSONObject scope() {
        JSONObject o = new JSONObject();
        try {
            o.put("id", id).put("text", text).put("sender", senderName).put("time", createdAt).put("mine", mine).put("status", status)
                .put("verified", verified).put("changed", changed);
            if (replyToId != null) o.put("replyTo", new JSONObject().put("id", replyToId).put("sender", replyToSender).put("text", replyToText));
            else o.put("replyTo", JSONObject.NULL);
            if (fileName != null) o.put("attachment", new JSONObject().put("name", fileName).put("size", fileSize).put("mime", fileMime == null ? "" : fileMime).put("image", fileMime != null && fileMime.startsWith("image/")));
            else o.put("attachment", JSONObject.NULL);
        } catch (JSONException ignored) { }
        return o;
    }

    public JSONObject toJson() {
        JSONObject o = scope();
        try {
            o.put("kind", kind).put("senderId", senderId).put("roomKey", roomKey);
            if (fileDataUrl != null && fileDataUrl.length() < 800_000) o.put("dataUrl", fileDataUrl);
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
        m.verified = o.optBoolean("verified");
        m.changed = o.optBoolean("changed");
        JSONObject r = o.optJSONObject("replyTo");
        if (r != null) { m.replyToId = r.optString("id"); m.replyToSender = r.optString("sender"); m.replyToText = r.optString("text"); }
        JSONObject a = o.optJSONObject("attachment");
        if (a != null) { m.fileName = a.optString("name"); m.fileSize = a.optLong("size"); m.fileMime = a.optString("mime"); m.fileDataUrl = o.optString("dataUrl", null); }
        return m;
    }
}
