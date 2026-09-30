package cz.m5cet.app.ui.look;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The one-time move of 6.1's appearance keys into 6.2's (pure, tested):
 * a web accent (red, orange, green, blue, violet) that the template offers
 * as a colour variant becomes that variant, so the new picker shows it as
 * chosen; a #rrggbb accent stays (it still applies over any template); a
 * template id the app does not know falls back to the design's look.
 */
final class Migration {
    private Migration() {}

    static final double VERSION = 1;

    /** key → new value; nothing when the settings are already migrated. */
    static Map<String, Object> plan(double version, String preset, String accent, String variant, boolean presetKnown) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (version >= VERSION) return out;
        String p = preset == null || preset.isEmpty() ? "design" : preset;
        if (!presetKnown) { p = "design"; out.put("appearance.preset", "design"); }
        String a = accent == null ? "" : accent;
        if ((variant == null || variant.isEmpty()) && Palette.has(p, a)) {
            out.put("look.variant", a);
            out.put("appearance.accent", "");
        }
        out.put("look.v", VERSION);
        return out;
    }
}
