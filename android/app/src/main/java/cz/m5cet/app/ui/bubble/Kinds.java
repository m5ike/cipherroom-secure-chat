package cz.m5cet.app.ui.bubble;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import cz.m5cet.app.chat.ChatMessage;

/**
 * What a message is (6.2), in the words the web and the audit journal share
 * (server/message-audit.ts KINDS): text, file, image, audio, video,
 * location, tap, vanish, sealed, fn, private, forwarded, reply, transcript —
 * and where a position message points.
 */
public final class Kinds {
    private Kinds() {}

    /** The web's and this app's position message: "📍 50.08804, 14.42076 (±12 m) https://…" ("📍 live …" while sharing). */
    private static final Pattern POSITION = Pattern.compile("^\\s*📍\\s*(?:live\\s+)?(-?\\d{1,2}(?:\\.\\d+)?),\\s*(-?\\d{1,3}(?:\\.\\d+)?)(?:\\s*\\(±\\s*(\\d+)\\s*m\\))?");

    public static List<String> of(ChatMessage m) {
        List<String> k = new ArrayList<>();
        String mime = m.fileMime == null ? "" : m.fileMime.toLowerCase(Locale.ROOT);
        if (!m.text.isEmpty() && !isPositionMessage(m)) k.add("text");
        if (m.fileName != null) k.add(m.fileImage || mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : mime.startsWith("video/") ? "video" : "file");
        if (position(m) != null) k.add("location");
        if (m.tap) k.add("tap");
        if (m.vanishSeconds > 0) k.add("vanish");
        if (m.sealed != null) k.add("sealed");
        if (m.fn != null || m.fnLocal != null) k.add("fn");
        if (!m.to.isEmpty()) k.add("private");
        if (m.forwardedFrom != null) k.add("forwarded");
        if (m.replyToId != null) k.add("reply");
        if (m.sourceAudio != null) k.add("transcript");
        return k;
    }

    /** A message whose point is the position (Tools › send position), not one that only carries it in the header. */
    public static boolean isPositionMessage(ChatMessage m) {
        return m.sealed == null && m.text != null && POSITION.matcher(m.text).find();
    }

    /** Where the message points: {lat, lon, acc, at} from loc, else from a position message's text; null when nowhere. */
    public static JSONObject position(ChatMessage m) {
        if (m.loc != null && m.loc.opt("lat") instanceof Number && m.loc.opt("lon") instanceof Number) {
            double lat = m.loc.optDouble("lat"), lon = m.loc.optDouble("lon");
            if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return m.loc;
        }
        if (m.sealed != null || m.text == null) return null;
        Matcher mt = POSITION.matcher(m.text);
        if (!mt.find()) return null;
        try {
            double lat = Double.parseDouble(mt.group(1)), lon = Double.parseDouble(mt.group(2));
            if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
            JSONObject o = new JSONObject().put("lat", lat).put("lon", lon);
            if (mt.group(3) != null) o.put("acc", Long.parseLong(mt.group(3)));
            return o;
        } catch (NumberFormatException | JSONException e) { return null; }
    }

    /** Only the header's position (location.inHeader): the small corner pin, not a map in the bubble. */
    public static boolean headerPosition(ChatMessage m) { return m.loc != null && !isPositionMessage(m); }
}
