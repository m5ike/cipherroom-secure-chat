package cz.m5cet.app.push;

import java.util.Arrays;
import java.util.Calendar;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TimeZone;

/**
 * Notification templates (6.7) — the same rules as the server and the web
 * (client/src/lib/notify-template.ts): {name}, {name|fallback}, [optional
 * part], backslash escapes; values cleaned of control and bidi characters
 * and bounded; a privacy level decides which variables show at all.
 *
 * The server's notification comes with the template in the user's language
 * and the variables it may show; the app renders it again with what only it
 * knows — the room's own name (the server sees an opaque id) and, when it
 * decrypted the message itself, a preview. Pure Java: unit-tested on the JVM.
 */
public final class NotifyTemplate {
    private NotifyTemplate() {}

    public static final List<String> PRIVACY = Arrays.asList("neutral", "sender", "room", "content");
    public static final List<String> VARS = Arrays.asList("app", "sender", "room", "count", "time", "preview", "channel");
    public static final List<String> CHANNELS = Arrays.asList("android", "webpush", "email");
    public static final List<String> KINDS = Arrays.asList("message", "mention", "call", "function", "summon", "test");
    public static final int TITLE_MAX = 100, BODY_MAX = 240, TEMPLATE_MAX = 300;

    private static final Map<String, Integer> LIMITS = new HashMap<>();
    static {
        LIMITS.put("app", 40); LIMITS.put("sender", 64); LIMITS.put("room", 64); LIMITS.put("count", 6);
        LIMITS.put("time", 16); LIMITS.put("preview", 200); LIMITS.put("channel", 16);
    }

    public static int rank(String privacy) { int i = PRIVACY.indexOf(privacy); return i < 0 ? 0 : i; }

    /** The lower of two levels; an unknown level counts as neutral. */
    public static String min(String a, String b) {
        String x = PRIVACY.contains(a) ? a : "neutral", y = PRIVACY.contains(b) ? b : "neutral";
        return rank(x) <= rank(y) ? x : y;
    }

    /** What a level shows. */
    public static boolean visible(String var, String privacy) {
        switch (var) {
            case "sender": return rank(privacy) >= 1;
            case "room": return rank(privacy) >= 2;
            case "preview": return rank(privacy) >= 3;
            default: return VARS.contains(var);
        }
    }

    private static boolean unsafe(char c) {
        return c < 0x20 || (c >= 0x7f && c <= 0x9f) || c == 0x2028 || c == 0x2029;
    }

    private static boolean bidi(char c) {
        return (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2060 && c <= 0x2069) || c == 0xfeff;
    }

    /** One line, no control or bidi characters, at most `max` characters (an ellipsis when cut). */
    public static String clean(String v, int max) {
        if (v == null) return "";
        StringBuilder b = new StringBuilder(v.length());
        boolean space = false;
        for (int i = 0; i < v.length(); i++) {
            char c = v.charAt(i);
            if (bidi(c)) continue;
            // JavaScript's \s: Unicode spaces (no-break ones too), line and paragraph separators.
            if (unsafe(c) || Character.isWhitespace(c) || Character.isSpaceChar(c)) { space = b.length() > 0; continue; }
            if (space) { b.append(' '); space = false; }
            b.append(c);
        }
        String s = b.toString();
        if (s.length() <= max) return s;
        String cut = s.substring(0, Math.max(0, max - 1));
        int end = cut.length();
        while (end > 0 && Character.isWhitespace(cut.charAt(end - 1))) end--;
        return cut.substring(0, end) + "…";
    }

    /** The variables a level shows, cleaned; the rest are empty. A count of one is left out. */
    public static Map<String, String> visibleVars(Map<String, String> vars, String privacy) {
        Map<String, String> out = new HashMap<>();
        for (String k : VARS) out.put(k, visible(k, privacy) ? clean(vars.get(k), LIMITS.get(k)) : "");
        String count = out.get("count");
        if (!count.isEmpty()) {
            double n;
            try { n = Double.parseDouble(count); } catch (NumberFormatException e) { n = 0; }
            if (!(n > 1)) out.put("count", "");
        }
        return out;
    }

    /** Renders one template with visible, cleaned variables (see visibleVars). */
    public static String render(String template, Map<String, String> vars, int max) {
        String src = template == null ? "" : template.length() > TEMPLATE_MAX ? template.substring(0, TEMPLATE_MAX) : template;
        StringBuilder out = new StringBuilder();
        StringBuilder part = null;
        boolean partOk = true;
        for (int i = 0; i < src.length(); i++) {
            char c = src.charAt(i);
            if (c == '\\' && i + 1 < src.length()) { (part != null ? part : out).append(src.charAt(i + 1)); i++; continue; }
            if (c == '[') { if (part == null) { part = new StringBuilder(); partOk = true; } else part.append('['); continue; }
            if (c == ']') { if (part == null) out.append(']'); else { if (partOk) out.append(part); part = null; } continue; }
            if (c == '{') {
                int j = i + 1;
                StringBuilder inner = new StringBuilder();
                while (j < src.length() && src.charAt(j) != '}') {
                    if (src.charAt(j) == '\\' && j + 1 < src.length()) { inner.append('\\').append(src.charAt(j + 1)); j += 2; continue; }
                    inner.append(src.charAt(j));
                    j++;
                }
                if (j >= src.length()) { (part != null ? part : out).append(src.substring(i)); break; }
                String in = inner.toString();
                int bar = -1;
                for (int k = 0; k < in.length(); k++) { if (in.charAt(k) == '\\') { k++; continue; } if (in.charAt(k) == '|') { bar = k; break; } }
                String name = (bar < 0 ? in : in.substring(0, bar)).trim();
                String fallback = bar < 0 ? null : in.substring(bar + 1).replaceAll("\\\\(.)", "$1");
                String value = VARS.contains(name) && vars.get(name) != null ? vars.get(name) : "";
                StringBuilder to = part != null ? part : out;
                if (!value.isEmpty()) to.append(value);
                else if (fallback != null) to.append(fallback);
                else if (part != null) partOk = false;
                i = j;
                continue;
            }
            (part != null ? part : out).append(c);
        }
        if (part != null && partOk) out.append(part);
        return clean(out.toString(), max);
    }

    /** Title and body; an empty title falls back to the app's name. */
    public static String[] notification(String titleTpl, String bodyTpl, Map<String, String> vars, String privacy) {
        Map<String, String> v = visibleVars(vars, privacy);
        String title = render(titleTpl, v, TITLE_MAX);
        if (title.isEmpty()) title = v.get("app").isEmpty() ? "M5cet" : v.get("app");
        return new String[]{ title, render(bodyTpl, v, BODY_MAX) };
    }

    /* ----------------------------------------------------------- quiet hours */

    private static int minutes(String hhmm) {
        if (hhmm == null || !hhmm.matches("([01]\\d|2[0-3]):[0-5]\\d")) return -1;
        return Integer.parseInt(hhmm.substring(0, 2)) * 60 + Integer.parseInt(hhmm.substring(3, 5));
    }

    /** Inside from–to (across midnight when from > to), in the phone's own time zone (or `tz`). */
    public static boolean inQuietHours(boolean on, String from, String to, String tz, long at) {
        int f = minutes(from), t = minutes(to);
        if (!on || f < 0 || t < 0 || f == t) return false;
        Calendar cal = Calendar.getInstance(tz == null || tz.isEmpty() ? TimeZone.getDefault() : TimeZone.getTimeZone(tz));
        cal.setTimeInMillis(at);
        int now = cal.get(Calendar.HOUR_OF_DAY) * 60 + cal.get(Calendar.MINUTE);
        return f < t ? now >= f && now < t : now >= f || now < t;
    }

    /* ------------------------------------------------------------ channels */

    /** "android,webpush" → the known channels, once each, in that order. */
    public static List<String> order(String csv) {
        java.util.ArrayList<String> out = new java.util.ArrayList<>();
        if (csv != null) for (String c : csv.split(",")) { String t = c.trim(); if (CHANNELS.contains(t) && !out.contains(t)) out.add(t); }
        return out;
    }

    /** One channel a place up (by -1) or down (+1); the rest keep their order. */
    public static String move(String csv, String channel, int by) {
        List<String> list = order(csv);
        int i = list.indexOf(channel), j = i + by;
        if (i < 0 || j < 0 || j >= list.size()) return String.join(",", list);
        list.set(i, list.get(j));
        list.set(j, channel);
        return String.join(",", list);
    }

    /** A channel used (added at the end) or not. */
    public static String use(String csv, String channel, boolean on) {
        List<String> list = order(csv);
        list.remove(channel);
        if (on && CHANNELS.contains(channel)) list.add(channel);
        return String.join(",", list);
    }
}
