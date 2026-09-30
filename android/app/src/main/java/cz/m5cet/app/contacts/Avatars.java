package cz.m5cet.app.contacts;

import java.util.Locale;

/**
 * 6.2 People: the round monogram of a person, exactly as the web draws it
 * (UserBadge.tsx Avatar): one letter — or a short emoji avatar — on a tint
 * of a hue derived from the name, so the same person has the same colour on
 * the web and on the phone.
 */
public final class Avatars {
    private Avatars() {}

    /** avatarGlyphFor(): a 1–2 character emoji avatar if one is given, else the name's first letter upper-cased, "?" for none. */
    public static String glyph(String name, String avatar) {
        String a = avatar == null ? "" : avatar.trim();
        if (!a.isEmpty() && !a.matches(".*[/:.].*") && a.codePointCount(0, a.length()) <= 2) return a;
        String n = name == null ? "" : name.trim();
        if (n.isEmpty()) return "?";
        return new String(Character.toChars(n.codePointAt(0))).toUpperCase(Locale.ROOT);
    }

    /** hueFor(): h = (h·31 + UTF-16 unit) mod 360 over the lower-cased name ("?" for none). */
    public static int hue(String name) {
        String key = (name == null || name.isEmpty() ? "?" : name).toLowerCase(Locale.ROOT);
        int h = 0;
        for (int i = 0; i < key.length(); i++) h = (h * 31 + key.charAt(i)) % 360;
        return h;
    }

    /** The monogram's background: hsl(h 62% 42% / 0.22), as #aarrggbb. */
    public static String background(String name) { return hex(hsl(hue(name), 0.62f, 0.42f, 0.22f)); }

    /** The letter's colour: hsl(h 70% 42%). */
    public static String foreground(String name) { return hex(hsl(hue(name), 0.70f, 0.42f, 1f)); }

    /** CSS hsl() → ARGB. */
    public static int hsl(float h, float s, float l, float alpha) {
        float c = (1 - Math.abs(2 * l - 1)) * s;
        float hp = ((h % 360) + 360) % 360 / 60f;
        float x = c * (1 - Math.abs(hp % 2 - 1));
        float r = 0, g = 0, b = 0;
        if (hp < 1) { r = c; g = x; }
        else if (hp < 2) { r = x; g = c; }
        else if (hp < 3) { g = c; b = x; }
        else if (hp < 4) { g = x; b = c; }
        else if (hp < 5) { r = x; b = c; }
        else { r = c; b = x; }
        float m = l - c / 2;
        int a = Math.round(alpha * 255);
        return (a << 24) | (Math.round((r + m) * 255) << 16) | (Math.round((g + m) * 255) << 8) | Math.round((b + m) * 255);
    }

    /** "#aarrggbb" — the form the design's colours take. */
    public static String hex(int argb) { return String.format(Locale.ROOT, "#%08x", argb); }
}
