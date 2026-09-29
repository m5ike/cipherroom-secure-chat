package cz.m5cet.app.chat;

import org.json.JSONObject;

import java.util.regex.Pattern;

/**
 * The checks of a decrypted payload (client/src/lib/validate.ts
 * validatePayload): bounded fields, the sender bound to the channel it came
 * from, never "us" or a reserved id, a clock that is not far in the future,
 * inline attachments only of safe types.
 */
public final class Payloads {
    private Payloads() {}

    static final int ID = 96, TEXT = 64_000, NAME = 48, REPLY = 400, DATA_URL = 1_000_000;
    static final long FUTURE_SKEW = 5 * 60 * 1000;
    private static final Pattern SAFE_MIME = Pattern.compile("^(image/(png|jpeg|gif|webp|avif|bmp)|audio/(mpeg|mp4|ogg|wav|webm|aac|flac)|video/(mp4|webm|ogg)|text/plain|application/pdf)$");
    private static final Pattern CONTROL = Pattern.compile("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]");

    static String str(Object v, int max) { return v instanceof String && ((String) v).length() <= max ? (String) v : null; }

    static String clean(Object v, int max, String fallback) {
        String s = v instanceof String ? CONTROL.matcher((String) v).replaceAll("") : "";
        if (s.length() > max) s = s.substring(0, max);
        return s.isEmpty() ? fallback : s;
    }

    public static String safeMime(String mime) {
        String m = mime == null ? "" : mime.trim().toLowerCase(java.util.Locale.ROOT).split(";")[0];
        return SAFE_MIME.matcher(m).matches() ? m : "application/octet-stream";
    }

    /** null when the payload is not acceptable (it is then not shown). */
    public static ChatMessage validate(JSONObject p, String transportSender, String myId) {
        if (p == null) return null;
        long now = System.currentTimeMillis();
        String id = str(p.opt("id"), ID);
        String senderId = str(p.opt("senderId"), ID);
        if (id == null || id.isEmpty() || senderId == null || senderId.isEmpty()) return null;
        if (senderId.equals("system") || senderId.equals("self") || senderId.equals("server") || senderId.equals("admin")) return null;
        if (senderId.equals(myId) || (transportSender != null && !senderId.equals(transportSender))) return null;
        Object c = p.opt("createdAt");
        long createdAt = c instanceof Number && Double.isFinite(((Number) c).doubleValue()) ? Math.min(((Number) c).longValue(), now + FUTURE_SKEW) : now;
        String senderName = clean(p.opt("senderName"), NAME, "peer-" + senderId.substring(Math.max(0, senderId.length() - 4)));

        ChatMessage m = new ChatMessage();
        m.id = id;
        m.senderId = senderId;
        m.senderName = senderName;
        m.createdAt = createdAt;
        String kind = p.optString("kind", "");
        if (kind.equals("audio-status")) {
            String s = p.optString("status");
            if (!s.equals("off") && !s.equals("joining") && !s.equals("live") && !s.equals("muted")) return null;
            m.kind = "audio-status";
            m.text = s;
            return m;
        }
        if (!kind.isEmpty() && !kind.equals("text")) return null;
        Object t = p.opt("text");
        String text = t == null || t == JSONObject.NULL ? "" : str(t, TEXT);
        if (text == null) return null;
        m.text = text;
        JSONObject a = p.optJSONObject("attachment");
        if (a != null) {
            String dataUrl = str(a.opt("dataUrl"), DATA_URL);
            String mime = safeMime(a.optString("mime"));
            if (dataUrl != null && dataUrl.startsWith("data:")) {
                m.fileName = clean(a.opt("name"), 200, "file").replaceAll("[\\\\/:*?\"<>|]", "_");
                m.fileMime = mime;
                m.fileSize = Math.max(0, a.optLong("size"));
                m.fileDataUrl = dataUrl;
            }
        }
        if (m.text.isEmpty() && m.fileDataUrl == null) return null;
        JSONObject r = p.optJSONObject("replyTo");
        if (r != null && str(r.opt("id"), ID) != null) {
            m.replyToId = r.optString("id");
            m.replyToSender = clean(r.opt("senderName"), NAME, "");
            m.replyToText = clean(r.opt("text"), REPLY, "");
        }
        return m;
    }
}
