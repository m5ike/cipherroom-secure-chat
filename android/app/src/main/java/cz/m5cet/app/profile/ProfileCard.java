package cz.m5cet.app.profile;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import cz.m5cet.app.security.Crypto;

/**
 * 6.7: the user's profile card, as the web keeps it
 * (client/src/lib/profile/model.ts): a photo, a background, a public
 * nickname, an about text and typed fields — each with its audience:
 *
 *   me      only me — sealed in the account vault's "card" slot
 *   room    room members — end-to-end encrypted in the rooms (ProfileRoom)
 *   public  on the server (/api/profile), readable by username
 *
 * The audiences nest (public ⊂ room). Every new item is "only me"; the
 * public nickname is public once it is typed and saved. Pure (org.json
 * only): the same normalizers run over what the vault, the server or a
 * member hands over.
 */
public final class ProfileCard {
    private ProfileCard() {}

    public static final List<String> AUDIENCES = Arrays.asList("me", "room", "public");
    public static final List<String> FIELD_TYPES = Arrays.asList("name", "phone", "email", "address", "url", "social", "org", "birthday", "other");

    public static final int NICKNAME_CHARS = 40, ABOUT_CHARS = 600, LABEL_CHARS = 32, VALUE_CHARS = 200, ADDRESS_CHARS = 300, FIELDS = 24;
    /** Decoded bytes of the re-encoded images (both keep a room frame under one data channel message). */
    public static final int AVATAR_BYTES = 40 * 1024, COVER_BYTES = 72 * 1024;
    public static final int AVATAR_PX = 256, COVER_W = 1200, COVER_H = 400;
    /** Upper bound of a shared view's JSON (images base64-encoded). */
    public static final int SHARED_MAX_CHARS = (int) Math.ceil((AVATAR_BYTES + COVER_BYTES) * 4.0 / 3) + 40_000;

    private static final Pattern IMAGE = Pattern.compile("^data:image/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$");
    private static final Pattern CONTROL = Pattern.compile("[\\u0000-\\u0008\\u000b-\\u001f\\u007f\\u202a-\\u202e\\u2066-\\u2069]");
    private static final Pattern FIELD_ID = Pattern.compile("^[A-Za-z0-9_-]{1,24}$");

    public static boolean isAudience(Object v) { return v instanceof String && AUDIENCES.contains(v); }

    /** Who may see an item marked `item` when the viewer is `viewer`. */
    public static boolean visibleTo(String item, String viewer) {
        if ("me".equals(viewer)) return true;
        if ("room".equals(viewer)) return "room".equals(item) || "public".equals(item);
        return "public".equals(item);
    }

    /* ------------------------------------------------------------ values */

    private static String cap(String s, int max) {
        int n = s.codePointCount(0, s.length());
        return n <= max ? s : s.substring(0, s.offsetByCodePoints(0, max));
    }

    /** One line: no control or bidi-override characters, single spaces, capped. */
    public static String cleanLine(Object v, int max) {
        if (!(v instanceof String)) return "";
        String s = CONTROL.matcher((String) v).replaceAll("").replaceAll("[\\t\\n\\r]+", " ").replaceAll("\\s{2,}", " ").trim();
        return cap(s, max);
    }

    /** Several lines (about, address): at most one empty line in a row, capped. */
    public static String cleanText(Object v, int max) {
        if (!(v instanceof String)) return "";
        String s = ((String) v).replaceAll("\\r\\n?", "\n");
        s = CONTROL.matcher(s).replaceAll("").replace('\t', ' ').replaceAll("\\n{3,}", "\n\n").trim();
        return cap(s, max);
    }

    static int base64Bytes(String b64) {
        int pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
        return (b64.length() * 3) / 4 - pad;
    }

    /** A data: URL of a JPEG, PNG or WebP within `maxBytes`, else "". */
    public static String cleanImage(Object v, int maxBytes) {
        if (!(v instanceof String)) return "";
        String s = (String) v;
        if (s.length() > (int) Math.ceil(maxBytes * 4.0 / 3) + 40) return "";
        Matcher m = IMAGE.matcher(s);
        if (!m.matches()) return "";
        return base64Bytes(m.group(2)) <= maxBytes ? s : "";
    }

    /** A field's value checked by its type; "" when it is not one. */
    public static String cleanValue(String type, Object v) {
        if ("address".equals(type) || "other".equals(type)) return cleanText(v, ADDRESS_CHARS);
        String s = cleanLine(v, VALUE_CHARS);
        if (s.isEmpty()) return "";
        switch (type) {
            case "phone": return s.matches("^\\+?[0-9][0-9 ()./-]{2,30}$") ? s : "";
            case "email": return s.matches("^[^\\s@<>\"]{1,64}@[^\\s@<>\"]{1,190}\\.[^\\s@<>\".]{2,63}$") ? s : "";
            // Shown as a link the viewer may open — never fetched by the app.
            case "url": return s.matches("(?i)^https?://[^\\s<>\"]{3,190}$") ? s : "";
            case "birthday": return s.matches("^(\\d{4}-\\d{2}-\\d{2}|--\\d{2}-\\d{2}|\\d{1,2}\\.\\s?\\d{1,2}\\.(\\s?\\d{4})?)$") ? s : "";
            default: return s;
        }
    }

    public static String newFieldId() { return Crypto.hex(Crypto.random(6)); }

    private static String typeOf(Object v) { return v instanceof String && FIELD_TYPES.contains(v) ? (String) v : "other"; }

    /* -------------------------------------------------------------- card */

    private static JSONObject item(String value, String audience) {
        try { return new JSONObject().put("value", value).put("audience", audience); } catch (JSONException e) { throw new IllegalStateException(e); }
    }

    /** An empty card: everything only for me; the nickname is meant to be public (typing one is the opt-in). */
    public static JSONObject empty() { return normalize(new JSONObject()); }

    private interface Clean { String of(Object v); }

    private static JSONObject item(Object raw, Clean clean, String fallback) {
        JSONObject o = raw instanceof JSONObject ? (JSONObject) raw : new JSONObject();
        Object aud = o.opt("audience");
        return item(clean.of(o.opt("value")), isAudience(aud) ? (String) aud : fallback);
    }

    /** A card from anywhere (the vault, the editor): every value checked, unknown audiences are "me". */
    public static JSONObject normalize(JSONObject in) {
        JSONObject o = in == null ? new JSONObject() : in;
        JSONArray fields = new JSONArray();
        Set<String> seen = new HashSet<>();
        JSONArray raw = o.optJSONArray("fields");
        try {
            for (int i = 0; raw != null && i < raw.length() && fields.length() < FIELDS; i++) {
                JSONObject f = raw.optJSONObject(i);
                if (f == null) f = new JSONObject();
                String type = typeOf(f.opt("type"));
                String id = f.optString("id", "");
                if (!FIELD_ID.matcher(id).matches() || seen.contains(id)) id = newFieldId();
                seen.add(id);
                Object aud = f.opt("audience");
                fields.put(new JSONObject().put("id", id).put("type", type)
                    .put("label", cleanLine(f.opt("label"), LABEL_CHARS))
                    // The editor keeps what is being typed; views drop what does not check out.
                    .put("value", "address".equals(type) || "other".equals(type) ? cleanText(f.opt("value"), ADDRESS_CHARS) : cleanLine(f.opt("value"), VALUE_CHARS))
                    .put("audience", isAudience(aud) ? aud : "me"));
            }
            JSONObject out = new JSONObject().put("v", 1)
                .put("nickname", item(o.opt("nickname"), v -> cleanLine(v, NICKNAME_CHARS), "public"))
                .put("about", item(o.opt("about"), v -> cleanText(v, ABOUT_CHARS), "me"))
                .put("avatar", item(o.opt("avatar"), v -> cleanImage(v, AVATAR_BYTES), "me"))
                .put("cover", item(o.opt("cover"), v -> cleanImage(v, COVER_BYTES), "me"))
                .put("fields", fields)
                .put("updatedAt", Math.max(0L, o.optLong("updatedAt", 0)));
            if (o.optBoolean("published")) out.put("published", true);
            return out;
        } catch (JSONException e) { throw new IllegalStateException(e); }
    }

    /* ------------------------------------------------------------- views */

    /** Two FNV-1a passes over a canonical text of the view: its cache key (not a security property). */
    static String rev(JSONObject view) {
        StringBuilder c = new StringBuilder();
        c.append(view.optString("nickname")).append('\u0000').append(view.optString("about")).append('\u0000')
            .append(view.optString("avatar")).append('\u0000').append(view.optString("cover"));
        JSONArray fields = view.optJSONArray("fields");
        for (int i = 0; fields != null && i < fields.length(); i++) {
            JSONObject f = fields.optJSONObject(i);
            c.append('\u0001').append(f.optString("type")).append('\u0000').append(f.optString("label")).append('\u0000').append(f.optString("value"));
        }
        int a = 0x811c9dc5, b = 0x9747b28c;
        for (int i = 0; i < c.length(); i++) {
            int ch = c.charAt(i);
            a = (a ^ ch) * 0x01000193;
            b = (b ^ ch) * 0x01000193;
            b = b ^ (b >>> 13);
        }
        return String.format("%08x%08x", a, b);
    }

    private static JSONObject withRev(JSONObject view) {
        try { return view.put("rev", rev(view)); } catch (JSONException e) { throw new IllegalStateException(e); }
    }

    /**
     * What `viewer` sees of the card: room members get "room" and "public"
     * items, the public only "public" ones, "me" (the preview) everything. A
     * field whose value does not check out for its type is left out.
     */
    public static JSONObject viewFor(JSONObject card, String viewer) {
        JSONObject c = normalize(card);
        try {
            JSONObject view = new JSONObject().put("v", 1);
            for (String key : new String[] { "nickname", "about", "avatar", "cover" }) {
                JSONObject it = c.getJSONObject(key);
                String value = it.optString("value");
                if (!value.isEmpty() && visibleTo(it.optString("audience"), viewer)) view.put(key, value);
            }
            JSONArray out = new JSONArray();
            JSONArray fields = c.getJSONArray("fields");
            for (int i = 0; i < fields.length(); i++) {
                JSONObject f = fields.getJSONObject(i);
                if (!visibleTo(f.optString("audience"), viewer)) continue;
                String value = cleanValue(f.optString("type"), f.optString("value"));
                if (!value.isEmpty()) out.put(new JSONObject().put("type", f.optString("type")).put("label", f.optString("label")).put("value", value));
            }
            view.put("fields", out).put("updatedAt", c.optLong("updatedAt"));
            return withRev(view);
        } catch (JSONException e) { throw new IllegalStateException(e); }
    }

    public static boolean isEmptyView(JSONObject view) {
        if (view == null) return true;
        JSONArray f = view.optJSONArray("fields");
        return view.optString("nickname").isEmpty() && view.optString("about").isEmpty() && view.optString("avatar").isEmpty()
            && view.optString("cover").isEmpty() && (f == null || f.length() == 0);
    }

    /**
     * A view handed to us (a member's frame, the server's answer): rebuilt
     * from checked values only, its rev recomputed. Null when it is not a
     * profile.
     */
    public static JSONObject normalizeShared(Object input) {
        if (!(input instanceof JSONObject)) return null;
        JSONObject o = (JSONObject) input;
        if (o.optInt("v", 0) != 1 || o.toString().length() > SHARED_MAX_CHARS) return null;
        try {
            JSONArray fields = new JSONArray();
            JSONArray raw = o.optJSONArray("fields");
            for (int i = 0; raw != null && i < raw.length() && fields.length() < FIELDS; i++) {
                JSONObject f = raw.optJSONObject(i);
                if (f == null) continue;
                String type = typeOf(f.opt("type"));
                String value = cleanValue(type, f.opt("value"));
                if (!value.isEmpty()) fields.put(new JSONObject().put("type", type).put("label", cleanLine(f.opt("label"), LABEL_CHARS)).put("value", value));
            }
            JSONObject view = new JSONObject().put("v", 1);
            String nickname = cleanLine(o.opt("nickname"), NICKNAME_CHARS), about = cleanText(o.opt("about"), ABOUT_CHARS);
            String avatar = cleanImage(o.opt("avatar"), AVATAR_BYTES), cover = cleanImage(o.opt("cover"), COVER_BYTES);
            if (!nickname.isEmpty()) view.put("nickname", nickname);
            if (!about.isEmpty()) view.put("about", about);
            if (!avatar.isEmpty()) view.put("avatar", avatar);
            if (!cover.isEmpty()) view.put("cover", cover);
            view.put("fields", fields).put("updatedAt", Math.max(0L, o.optLong("updatedAt", 0)));
            return withRev(view);
        } catch (JSONException e) { return null; }
    }

    /**
     * The name a room's name field starts with: the public nickname when one
     * is set, else what it had. The user can still change it for the room.
     */
    public static String prefill(JSONObject card, String current) {
        String nick = card == null ? "" : card.optJSONObject("nickname") == null ? "" : card.optJSONObject("nickname").optString("value").trim();
        return nick.isEmpty() ? (current == null ? "" : current) : nick;
    }

    /** The view to publish on the server: the public view without its rev (the server keeps its own). */
    public static JSONObject publicBody(JSONObject card) {
        JSONObject v = viewFor(card, "public");
        v.remove("rev");
        return v;
    }
}
