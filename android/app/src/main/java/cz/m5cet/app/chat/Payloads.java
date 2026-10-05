package cz.m5cet.app.chat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The checks of a decrypted payload (client/src/lib/validate.ts
 * validatePayload): bounded fields, the sender bound to the channel it came
 * from, never "us" or a reserved id, a clock that is not far in the future,
 * inline attachments only of safe types (their data URL relabelled with the
 * safe type), and — 6.1 — the message kinds (flags), recipients, expiry,
 * the position in the header, and receipts.
 */
public final class Payloads {
    private Payloads() {}

    static final int ID = 96, TEXT = 64_000, NAME = 48, REPLY = 400, DATA_URL = 1_000_000, RECIPIENTS = 50, MAX_TTL_MINUTES = 10_080;
    static final int VANISH_MIN = 4, VANISH_MAX = 7200;
    static final long FUTURE_SKEW = 5 * 60 * 1000;
    private static final Pattern SAFE_MIME = Pattern.compile("^(image/(png|jpeg|gif|webp|avif|bmp)|audio/(mpeg|mp4|ogg|wav|webm|aac|flac)|video/(mp4|webm|ogg)|text/plain|application/pdf)$");
    private static final Pattern INLINE_IMAGE = Pattern.compile("^image/(png|jpeg|gif|webp|avif|bmp)$");
    private static final Pattern CONTROL = Pattern.compile("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]");
    private static final Pattern DATA_URL_HEAD = Pattern.compile("^data:([^;,]*)(;base64)?,", Pattern.CASE_INSENSITIVE);
    private static final Pattern FILE_NAME_BAD = Pattern.compile("[\\u0000-\\u001f\\u007f<>:\"/\\\\|?*\\u202a-\\u202e\\u2066-\\u2069]");
    private static final Pattern MODEL = Pattern.compile("^[a-z0-9][a-z0-9_-]{0,63}$");
    private static final Pattern CHAIN = Pattern.compile("^chn_[a-z0-9]{6,40}$");

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

    public static boolean inlineImage(String mime) { return mime != null && INLINE_IMAGE.matcher(mime).matches(); }

    /** safeFileName (validate.ts:44-48). */
    public static String safeFileName(Object v) {
        String s = v instanceof String ? FILE_NAME_BAD.matcher((String) v).replaceAll("_").trim() : "";
        int dots = 0;
        while (dots < s.length() && s.charAt(dots) == '.') dots++;
        if (dots > 0) s = "_" + s.substring(dots); // a run of leading dots → one "_" (validate.ts)
        if (s.isEmpty()) s = "file";
        return s.length() > 200 ? s.substring(0, 200) : s;
    }

    /** A decrypted payload: a chat message, an audio status, or a receipt. */
    public static final class Receipt {
        public final List<String> ids;
        public final String state;
        Receipt(List<String> ids, String state) { this.ids = ids; this.state = state; }
    }

    /** 6.1: a receipt payload {kind:"receipt", ids, state}; null when it is not one or not valid. */
    public static Receipt receipt(JSONObject p, String transportSender, String myId) {
        if (p == null || !"receipt".equals(p.optString("kind"))) return null;
        String senderId = str(p.opt("senderId"), ID);
        if (senderId == null || senderId.equals(myId) || (transportSender != null && !senderId.equals(transportSender))) return null;
        String state = p.optString("state");
        if (!state.equals("delivered") && !state.equals("read")) return null;
        JSONArray ids = p.optJSONArray("ids");
        if (ids == null) return null;
        List<String> out = new ArrayList<>();
        for (int i = 0; i < ids.length() && out.size() < 50; i++) {
            String id = str(ids.opt(i), 80);
            if (id != null && !id.isEmpty()) out.add(id);
        }
        return out.isEmpty() ? null : new Receipt(out, state);
    }

    /** null when the payload is not acceptable (it is then not shown). */
    public static ChatMessage validate(JSONObject p, String transportSender, String myId) {
        if (p == null) return null;
        long now = System.currentTimeMillis();
        String id = str(p.opt("id"), ID);
        String senderId = str(p.opt("senderId"), ID);
        if (id == null || id.isEmpty() || senderId == null || senderId.isEmpty()) return null;
        if (senderId.equals("system") || senderId.equals("self") || senderId.equals("server") || senderId.equals("admin")) return null;
        // 6.11: the app's own sender of model answers and the older caller-only answers (validate.ts isReservedSender).
        if (cz.m5cet.app.fn.ModelIdentity.reservedSender(senderId)) return null;
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
        if (a != null) attachment(a, m);
        if (m.text.isEmpty() && m.fileName == null) return null;
        Object ttl = p.opt("ttlMinutes");
        if (ttl instanceof Number && ((Number) ttl).doubleValue() > 0) {
            double minutes = Math.min(MAX_TTL_MINUTES, ((Number) ttl).doubleValue());
            m.ttlMinutes = (int) Math.ceil(minutes);
            m.expiresAt = createdAt + Math.round(minutes * 60_000);
        }
        JSONObject flags = p.optJSONObject("flags");
        if (flags != null) flags(flags, m);
        JSONArray to = p.optJSONArray("to");
        if (to != null) for (int i = 0; i < to.length() && m.to.size() < RECIPIENTS; i++) {
            if (to.opt(i) instanceof String) m.to.add(clean(to.opt(i), NAME, "?"));
        }
        JSONObject r = p.optJSONObject("replyTo");
        if (r != null && str(r.opt("id"), ID) != null) {
            m.replyToId = r.optString("id");
            m.replyToSender = clean(r.opt("senderName"), NAME, "");
            m.replyToText = clean(r.opt("text"), REPLY, "");
        }
        if (p.opt("forwardedFrom") instanceof String) m.forwardedFrom = clean(p.opt("forwardedFrom"), NAME, null);
        m.loc = location(p.optJSONObject("loc"));
        return m;
    }

    /** validateAttachment (validate.ts:58-81). */
    static void attachment(JSONObject a, ChatMessage m) {
        Object du = a.opt("dataUrl");
        String dataUrl = str(du, DATA_URL);
        if (dataUrl == null) return;
        String mime = safeMime(a.optString("mime"));
        if (!dataUrl.isEmpty()) {
            Matcher h = DATA_URL_HEAD.matcher(dataUrl);
            if (!h.find()) return;
            dataUrl = "data:" + mime + (h.group(2) != null ? ";base64" : "") + "," + dataUrl.substring(h.end());
        }
        m.fileName = safeFileName(a.opt("name"));
        m.fileMime = mime;
        // Shown as a picture only when the sender said so and the type is a safe image (validate.ts:74).
        m.fileImage = "image".equals(a.optString("kind")) && inlineImage(mime);
        Object size = a.opt("size");
        m.fileSize = size instanceof Number && ((Number) size).doubleValue() >= 0 ? (long) Math.floor(((Number) size).doubleValue()) : 0;
        m.fileDataUrl = dataUrl.isEmpty() ? null : dataUrl;
    }

    /** validateFlags (validate.ts:85-113). */
    static void flags(JSONObject f, ChatMessage m) {
        if (f.optBoolean("tap", false) && Boolean.TRUE.equals(f.opt("tap"))) m.tap = true;
        Object v = f.opt("vanishSeconds");
        if (v instanceof Number && ((Number) v).doubleValue() > 0) m.vanishSeconds = (int) Math.max(VANISH_MIN, Math.min(VANISH_MAX, Math.round(((Number) v).doubleValue())));
        JSONObject s = f.optJSONObject("sealed");
        if (s != null) {
            String salt = str(s.opt("salt"), 64), iv = str(s.opt("iv"), 64);
            if (salt != null && iv != null && !salt.isEmpty() && !iv.isEmpty()) {
                JSONObject meta = new JSONObject();
                try {
                    meta.put("salt", salt).put("iv", iv);
                    if (s.opt("v") instanceof Number) meta.put("v", ((Number) s.opt("v")).intValue());
                    Object it = s.opt("it");
                    if (it instanceof Number) { long n = ((Number) it).longValue(); if (n >= 100_000 && n <= 5_000_000 && n == ((Number) it).doubleValue()) meta.put("it", n); }
                } catch (JSONException ignored) { }
                m.sealed = meta;
            }
        }
        JSONObject fn = f.optJSONObject("fn");
        if (fn != null) m.fn = fnMeta(fn);
    }

    /** flags.fn (validate.ts:97-111); outputs are checked when they are drawn (FnOutputs). */
    static JSONObject fnMeta(JSONObject f) {
        String keyword = str(f.opt("keyword"), 40);
        if (keyword == null || keyword.isEmpty()) return null;
        JSONObject o = new JSONObject();
        try {
            o.put("keyword", keyword).put("name", clean(f.opt("name"), 120, keyword));
            String model = f.optString("model", "");
            if (MODEL.matcher(model).matches()) o.put("model", model);
            // 6.11: the model's icon (its avatar under "via <sender>"): a lucide name or one emoji, else none.
            String icon = cz.m5cet.app.fn.ModelIdentity.safeIcon(f.opt("icon"));
            if (icon != null) o.put("icon", icon);
            String chain = f.optString("chain", "");
            if (CHAIN.matcher(chain).matches()) o.put("chain", chain);
            Object call = f.opt("call");
            if (call instanceof Number && ((Number) call).doubleValue() == Math.floor(((Number) call).doubleValue()) && ((Number) call).intValue() >= 0 && ((Number) call).intValue() <= 9999) o.put("call", ((Number) call).intValue());
            JSONArray ev = f.optJSONArray("events");
            if (ev != null) {
                JSONArray keep = new JSONArray();
                java.util.Set<String> seen = new java.util.HashSet<>();
                for (int i = 0; i < ev.length(); i++) {
                    String e = ev.optString(i);
                    if ((e.equals("response") || e.equals("button") || e.equals("form") || e.equals("error")) && seen.add(e)) keep.put(e);
                }
                o.put("events", keep);
            }
            JSONArray outs = f.optJSONArray("outputs");
            if (outs != null && outs.toString().length() <= 900_000) {
                JSONArray keep = new JSONArray();
                for (int i = 0; i < outs.length() && keep.length() < 50; i++) if (outs.optJSONObject(i) != null) keep.put(outs.optJSONObject(i));
                o.put("outputs", keep);
            }
            if ("error".equals(f.optString("origin"))) o.put("origin", "error");
        } catch (JSONException e) { return null; }
        return o;
    }

    /** 6.1 loc: {lat −90..90, lon −180..180, acc ≥ 0, at}, rounded to 5 decimals. */
    static JSONObject location(JSONObject l) {
        if (l == null) return null;
        Object la = l.opt("lat"), lo = l.opt("lon");
        if (!(la instanceof Number) || !(lo instanceof Number)) return null;
        double lat = ((Number) la).doubleValue(), lon = ((Number) lo).doubleValue();
        if (!Double.isFinite(lat) || !Double.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
        JSONObject o = new JSONObject();
        try {
            o.put("lat", Math.round(lat * 1e5) / 1e5).put("lon", Math.round(lon * 1e5) / 1e5);
            Object acc = l.opt("acc");
            if (acc instanceof Number && ((Number) acc).doubleValue() >= 0 && ((Number) acc).doubleValue() < 1e6) o.put("acc", Math.round(((Number) acc).doubleValue()));
            Object at = l.opt("at");
            if (at instanceof Number) o.put("at", ((Number) at).longValue());
        } catch (JSONException e) { return null; }
        return o;
    }
}
