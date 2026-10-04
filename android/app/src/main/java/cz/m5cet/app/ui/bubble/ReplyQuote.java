package cz.m5cet.app.ui.bubble;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Locale;

import cz.m5cet.app.chat.ChatMessage;
import cz.m5cet.app.contacts.Avatars;

/**
 * 6.10: the message a reply answers, as the quote card on top of the reply
 * bubble draws it ($msg.replyTo, design message.in / message.out "quote"):
 *
 *   id      the original's id (a tap scrolls there: msg.quote)
 *   sender  who wrote it — "You" when it is mine
 *   text    one or two lines of it; a picture, a recording… without text
 *           says what it is
 *   icon    the kind's icon (image, audio-lines, video, paperclip, map-pin,
 *           lock), "" for a plain text
 *   color   the sender's colour (the web's monogram hue) for the bar and
 *           the name; tint the same, faint, for the card
 *   found   the original is in this room's history on this device
 *
 * What the reply carried (replyTo.sender / text, ≤ 200 characters) is used
 * when the original is not here; the original — when it is — tells the kind
 * and the latest state (opened, vanished). Pure (org.json only).
 */
public final class ReplyQuote {
    private ReplyQuote() {}

    /** The texts it needs (quote.*), in the app's language. */
    public interface Tr { String t(String key); }

    /** At most this many characters of the quoted text (two lines of a bubble). */
    public static final int CHARS = 140;

    /** $msg.replyTo for a reply (null when `reply` answers nothing); `original` null when it is not in the history here. */
    public static JSONObject of(ChatMessage reply, ChatMessage original, Tr tr) {
        if (reply == null || reply.replyToId == null || reply.replyToId.isEmpty()) return null;
        String kind = kind(original, reply.replyToText);
        boolean mine = original != null && original.mine;
        String name = original != null && !original.senderName.isEmpty() ? original.senderName : reply.replyToSender == null ? "" : reply.replyToSender;
        String sender = mine ? tr.t("quote.you") : name.isEmpty() ? "?" : name;
        String text = line(original != null && !"sealed".equals(kind) && !"vanished".equals(kind) ? original.visibleText() : quoted(reply.replyToText));
        if (text.isEmpty() && original != null && original.fileName != null && !"position".equals(kind)) text = line(original.fileName);
        if (text.isEmpty() || "sealed".equals(kind) || "vanished".equals(kind)) text = tr.t("quote." + label(kind));
        int c = Avatars.hsl(Avatars.hue(name.isEmpty() ? "?" : name), 0.70f, 0.42f, 1f);
        try {
            return new JSONObject().put("id", reply.replyToId).put("sender", sender).put("text", text).put("kind", kind).put("icon", icon(kind))
                .put("color", Avatars.hex(c)).put("tint", Avatars.hex((0x24 << 24) | (c & 0xFFFFFF)))
                .put("found", original != null).put("mine", mine);
        } catch (JSONException e) { return null; }
    }

    /**
     * text, image, audio, video, file, position, sealed (not opened here) or
     * vanished — from the original when it is here, else from what the reply
     * quoted ("📎 name" for a file, "🔒" for a sealed one, as RoomSession and
     * the web quote them).
     */
    public static String kind(ChatMessage o, String quotedText) {
        if (o != null) {
            if (o.vanished) return "vanished";
            if (o.sealed != null && o.sealPlain == null) return "sealed";
            if (Kinds.isPositionMessage(o)) return "position";
            if (o.fileName != null) {
                String mime = o.fileMime == null ? "" : o.fileMime.toLowerCase(Locale.ROOT);
                if (o.fileImage || mime.startsWith("image/")) return "image";
                if (mime.startsWith("audio/")) return "audio";
                if (mime.startsWith("video/")) return "video";
                return "file";
            }
            return "text";
        }
        String q = quotedText == null ? "" : quotedText.trim();
        if (q.equals("🔒")) return "sealed";
        if (q.startsWith("📎")) return "file";
        return "text";
    }

    public static String icon(String kind) {
        switch (kind) {
            case "image": return "image";
            case "audio": return "audio-lines";
            case "video": return "video";
            case "file": return "paperclip";
            case "position": return "map-pin";
            case "sealed": return "lock";
            case "vanished": return "timer";
            default: return "";
        }
    }

    /** The quote.* key that names a kind when there is no text to show. */
    static String label(String kind) {
        switch (kind) {
            case "image": return "photo";
            case "audio": case "video": case "file": case "position": case "sealed": case "vanished": return kind;
            default: return "empty";
        }
    }

    /** What the reply quoted, without the file's paperclip (the icon says it). */
    static String quoted(String q) {
        String s = q == null ? "" : q.trim();
        if (s.equals("🔒")) return "";
        if (s.startsWith("📎")) s = s.substring("📎".length()).trim();
        return s;
    }

    /** One paragraph: the line breaks and runs of spaces folded, at most CHARS (an ellipsis when cut). */
    public static String line(String s) {
        if (s == null) return "";
        String t = s.replaceAll("[\\u0000-\\u0008\\u000b-\\u001f\\u007f\\u202a-\\u202e\\u2066-\\u2069]", "").replaceAll("\\s+", " ").trim();
        if (t.codePointCount(0, t.length()) <= CHARS) return t;
        return t.substring(0, t.offsetByCodePoints(0, CHARS - 1)).trim() + "…";
    }
}
