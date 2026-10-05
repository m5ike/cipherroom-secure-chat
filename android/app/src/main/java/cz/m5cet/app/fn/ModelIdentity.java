package cz.m5cet.app.fn;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * 6.11: how a Functions model appears as the sender of its answers — a port
 * of client/src/lib/system-messenger.ts (the contract the web, this app and
 * the server share). A model's answer is an INCOMING message from
 * "system-messenger", the app's own internal sender (never a real member):
 * the nickname is the model's name, the avatar its icon (a lucide name or one
 * emoji) in a circle of its colour — the same colour on the web and here
 * (the same hash, the same HSL). Pure (org.json only).
 *
 * Honesty: a model's answer for the whole room is still sent by the caller's
 * own client (end-to-end encrypted, signed by them); peers show it under the
 * model's identity WITH "via &lt;caller&gt;", and a member can never pass a
 * message off as the system's ({@link #reservedSender}).
 */
public final class ModelIdentity {
    /** The internal sender of model answers (never a real member). */
    public static final String SYSTEM_MESSENGER_ID = "system-messenger";
    public static final String SYSTEM_MESSENGER_NAME = "system-messenger";

    /**
     * A run without any sign of life from the server (no event but the
     * stream's pings) for this long fails; an open question pauses it.
     */
    public static final long FN_RUN_TIMEOUT_MS = 30_000;

    /** Icons for models that do not name one, by keyword (DEFAULT_MODEL_ICONS). */
    public static final Map<String, String> DEFAULT_MODEL_ICONS;
    static final String FALLBACK_ICON = "bot";

    static {
        Map<String, String> m = new LinkedHashMap<>();
        String[] pairs = {
            "mail", "mail", "email", "mail", "hlr", "phone", "lookup", "search", "number", "hash", "phone", "phone", "call", "phone-call", "sms", "message-square-text",
            "dns", "globe", "whois", "globe", "ip", "network", "ping", "activity", "http", "globe", "url", "link", "ssl", "shield-check", "cert", "shield-check",
            "weather", "cloud-sun", "time", "clock", "calc", "calculator", "translate", "languages", "ai", "sparkles", "ask", "sparkles", "summary", "file-text",
            "emv", "credit-card", "emv-history", "receipt", "eid", "id-card", "nfc", "nfc", "qr", "qr-code", "code", "code", "run", "play", "help", "circle-help",
            "phone_bridge", "phone-forwarded", "phone-bridge", "phone-forwarded", "remind", "bell", "poll", "chart-bar", "dice", "dice-5",
        };
        for (int i = 0; i + 1 < pairs.length; i += 2) m.put(pairs[i], pairs[i + 1]);
        DEFAULT_MODEL_ICONS = Collections.unmodifiableMap(m);
    }

    /** A lucide icon's name (anything else is drawn as text: an emoji). */
    private static final Pattern LUCIDE = Pattern.compile("[a-z0-9]+(?:-[a-z0-9]+)*");
    private static final Pattern KEYWORD = Pattern.compile("[A-Za-z0-9_-]{1,40}");

    public final String keyword;
    /** The nickname: the model's name ("/keyword" without one). */
    public final String name;
    /** A lucide icon name, or one emoji. */
    public final String icon;
    /** The avatar's colour (#rrggbb), stable per keyword. */
    public final String color;

    private ModelIdentity(String keyword, String name, String icon, String color) {
        this.keyword = keyword;
        this.name = name;
        this.icon = icon;
        this.color = color;
    }

    /** modelColor(): a stable colour for a keyword — HSL(hash % 360, 55 %, 45 %), readable with white text. */
    public static String modelColor(String keyword) {
        long h = 0;
        String k = keyword == null ? "" : keyword;
        // JavaScript: h = (h * 31 + charCodeAt(i)) >>> 0 — the same in 32 unsigned bits.
        for (int i = 0; i < k.length(); i++) h = (h * 31 + k.charAt(i)) & 0xFFFFFFFFL;
        double hue = h % 360;
        double s = 0.55, l = 0.45;
        double c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((hue / 60) % 2) - 1)), m = l - c / 2;
        double r, g, b;
        if (hue < 60) { r = c; g = x; b = 0; }
        else if (hue < 120) { r = x; g = c; b = 0; }
        else if (hue < 180) { r = 0; g = c; b = x; }
        else if (hue < 240) { r = 0; g = x; b = c; }
        else if (hue < 300) { r = x; g = 0; b = c; }
        else { r = c; g = 0; b = x; }
        return "#" + hex(r + m) + hex(g + m) + hex(b + m);
    }

    private static String hex(double v) {
        String s = Long.toHexString(Math.round(v * 255));
        return s.length() < 2 ? "0" + s : s;
    }

    /** modelIdentity(): the model's own icon, else one by its keyword (or the keyword's first part), else a bot. */
    public static ModelIdentity of(String keyword, String name, String icon) {
        String k = keyword == null ? "" : keyword;
        String kw = k.toLowerCase(Locale.ROOT);
        String own = icon == null ? "" : Js.trim(icon);
        String first = kw.split("[-_]", -1)[0];
        String ic = !own.isEmpty() ? own : DEFAULT_MODEL_ICONS.containsKey(kw) ? DEFAULT_MODEL_ICONS.get(kw)
            : DEFAULT_MODEL_ICONS.containsKey(first) ? DEFAULT_MODEL_ICONS.get(first) : FALLBACK_ICON;
        return new ModelIdentity(k, name == null || name.isEmpty() ? "/" + k : name, ic, modelColor(kw));
    }

    public static ModelIdentity of(Command c) { return of(c.keyword, c.name, c.icon); }

    /** The identity a message's fn flags (or a stored "model") carry: keyword, name, icon; null without a keyword. */
    public static ModelIdentity fromJson(JSONObject o) {
        if (o == null) return null;
        String kw = o.opt("keyword") instanceof String ? o.optString("keyword") : "";
        if (!KEYWORD.matcher(kw).matches()) return null;
        String name = o.opt("name") instanceof String ? o.optString("name") : "";
        return of(kw, name, safeIcon(o.opt("icon")));
    }

    /** {keyword, name, icon} — what goes into the fn flags and the history (the colour follows from the keyword). */
    public JSONObject toJson() {
        try { return new JSONObject().put("keyword", keyword).put("name", name).put("icon", icon); }
        catch (JSONException e) { throw new IllegalStateException(e); }
    }

    /** The icon is a lucide name (else: an emoji, drawn as text). */
    public boolean lucide() { return LUCIDE.matcher(icon).matches(); }

    /** The colour as ARGB. */
    public int argb() { return 0xFF000000 | Integer.parseInt(color.substring(1), 16); }

    /**
     * An icon as a peer may send it in the fn flags: a lucide name (≤ 40
     * characters) or one short emoji (no letters, digits, spaces, controls or
     * markup); null otherwise — the keyword's icon is used then.
     */
    public static String safeIcon(Object raw) {
        if (!(raw instanceof String)) return null;
        String s = Js.trim((String) raw);
        if (s.isEmpty() || s.length() > 40) return null;
        if (LUCIDE.matcher(s).matches()) return s;
        if (s.length() > 16 || s.codePointCount(0, s.length()) > 8) return null;
        for (int i = 0; i < s.length(); ) {
            int cp = s.codePointAt(i);
            i += Character.charCount(cp);
            if (Character.isLetterOrDigit(cp) || Character.isWhitespace(cp) || Character.isISOControl(cp) || "<>\"'&`\\/".indexOf(cp) >= 0) return null;
            int type = Character.getType(cp);
            if (type == Character.UNASSIGNED || type == Character.PRIVATE_USE || type == Character.SURROGATE) return null;
        }
        return s;
    }

    /** An id only this app gives — system-messenger and the older "function:&lt;keyword&gt;"; never a peer's (validate.ts isReservedSender). */
    public static boolean reservedSender(String id) {
        return id != null && (id.equals(SYSTEM_MESSENGER_ID) || id.startsWith("function:"));
    }
}
