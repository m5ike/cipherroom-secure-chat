package cz.m5cet.app.fn;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * A button's CSS colour (what sanitizeButton() lets through: #hex, rgb(),
 * rgba(), hsl(), hsla(), a name) as an Android ARGB int — or null when it
 * cannot be read (an unknown name): the button keeps the theme's colour.
 */
final class CssColor {
    private CssColor() {}

    private static final Map<String, Integer> NAMES = new HashMap<>();

    static {
        String[] names = {
            "black", "000000", "white", "ffffff", "red", "ff0000", "green", "008000", "blue", "0000ff", "yellow", "ffff00",
            "orange", "ffa500", "purple", "800080", "gray", "808080", "grey", "808080", "silver", "c0c0c0", "maroon", "800000",
            "olive", "808000", "lime", "00ff00", "aqua", "00ffff", "cyan", "00ffff", "teal", "008080", "navy", "000080",
            "fuchsia", "ff00ff", "magenta", "ff00ff", "pink", "ffc0cb", "brown", "a52a2a", "gold", "ffd700", "indigo", "4b0082",
            "violet", "ee82ee", "coral", "ff7f50", "crimson", "dc143c", "tomato", "ff6347", "salmon", "fa8072", "turquoise", "40e0d0",
            "skyblue", "87ceeb", "steelblue", "4682b4", "royalblue", "4169e1", "darkgreen", "006400", "darkred", "8b0000",
            "orangered", "ff4500", "lightgray", "d3d3d3", "lightgrey", "d3d3d3", "darkgray", "a9a9a9", "darkgrey", "a9a9a9",
            "beige", "f5f5dc", "ivory", "fffff0", "khaki", "f0e68c", "lavender", "e6e6fa", "chocolate", "d2691e", "tan", "d2b48c",
        };
        for (int i = 0; i < names.length; i += 2) NAMES.put(names[i], 0xFF000000 | Integer.parseInt(names[i + 1], 16));
        NAMES.put("transparent", 0);
    }

    private static final String N = Js.S + "*([\\d.]+)(%?)" + Js.S + "*";
    private static final Pattern RGB = Pattern.compile("rgba?\\(" + N + "," + N + "," + N + "(?:," + N + ")?\\)", Pattern.CASE_INSENSITIVE);
    private static final Pattern HSL = Pattern.compile("hsla?\\(" + Js.S + "*([\\d.]+)(?:deg)?" + Js.S + "*," + N + "," + N + "(?:," + N + ")?\\)", Pattern.CASE_INSENSITIVE);

    static Integer parse(String css) {
        if (css == null) return null;
        String v = Js.trim(css).toLowerCase(Locale.ROOT);
        try {
            if (v.startsWith("#")) return hex(v.substring(1));
            Matcher m = RGB.matcher(v);
            if (m.matches()) {
                return argb(alpha(m.group(7), m.group(8)), channel(m.group(1), m.group(2)), channel(m.group(3), m.group(4)), channel(m.group(5), m.group(6)));
            }
            m = HSL.matcher(v);
            if (m.matches()) return hsl(Double.parseDouble(m.group(1)), Double.parseDouble(m.group(2)) / 100, Double.parseDouble(m.group(4)) / 100, alpha(m.group(6), m.group(7)));
        } catch (NumberFormatException e) {
            return null; // "1.2.3" passes the pattern, not a number
        }
        return NAMES.get(v);
    }

    private static Integer hex(String h) {
        if (!h.matches("[0-9a-f]+")) return null;
        switch (h.length()) {
            case 3: case 4: {
                int[] c = new int[4];
                for (int i = 0; i < 4; i++) c[i] = i < h.length() ? Integer.parseInt(h.substring(i, i + 1) + h.charAt(i), 16) : 255;
                return argb(c[3], c[0], c[1], c[2]);
            }
            case 6: case 8: {
                int a = h.length() == 8 ? Integer.parseInt(h.substring(6, 8), 16) : 255;
                return argb(a, Integer.parseInt(h.substring(0, 2), 16), Integer.parseInt(h.substring(2, 4), 16), Integer.parseInt(h.substring(4, 6), 16));
            }
            default: return null;
        }
    }

    private static int channel(String n, String pct) {
        double d = Double.parseDouble(n);
        return clamp(pct.isEmpty() ? d : d * 2.55);
    }

    private static int alpha(String n, String pct) {
        if (n == null) return 255;
        double d = Double.parseDouble(n);
        return clamp(pct.isEmpty() ? d * 255 : d * 2.55);
    }

    private static int clamp(double d) { return (int) Math.round(Math.max(0, Math.min(255, d))); }

    private static int argb(int a, int r, int g, int b) { return (a << 24) | (r << 16) | (g << 8) | b; }

    private static int hsl(double h, double s, double l, int a) {
        double hue = ((h % 360) + 360) % 360 / 360;
        s = Math.max(0, Math.min(1, s));
        l = Math.max(0, Math.min(1, l));
        double q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        double p = 2 * l - q;
        return argb(a, clamp(255 * hue(p, q, hue + 1 / 3.0)), clamp(255 * hue(p, q, hue)), clamp(255 * hue(p, q, hue - 1 / 3.0)));
    }

    private static double hue(double p, double q, double t) {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6.0) return p + (q - p) * 6 * t;
        if (t < 1 / 2.0) return q;
        if (t < 2 / 3.0) return p + (q - p) * (2 / 3.0 - t) * 6;
        return p;
    }
}
