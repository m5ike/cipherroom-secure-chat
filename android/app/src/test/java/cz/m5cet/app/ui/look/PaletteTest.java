package cz.m5cet.app.ui.look;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.HashSet;
import java.util.List;

/** The templates' colour variants: enough of them, and readable in both tones. */
public class PaletteTest {
    /** client/src/lib/theme-catalog.ts THEME_IDS, and the design's own look. */
    static final String[] TEMPLATES = {"design", "motorsport", "glass", "terminal", "midnight", "paper", "contrast", "ios", "windows", "aurora", "nord", "sakura", "ocean", "graphite"};

    @Test public void hslConvertsLikeCss() {
        assertEquals(0xFFFF0000, Palette.hsl(0, 1, 0.5));
        assertEquals(0xFF008000, Palette.hsl(120, 1, 0.251));
        assertEquals(0xFF0000FF, Palette.hsl(240, 1, 0.5));
        assertEquals(0xFF808080, Palette.hsl(77, 0, 0.502));
        assertEquals(Palette.hsl(-30, 0.5, 0.5), Palette.hsl(330, 0.5, 0.5));
        assertEquals("#1a2b3c", Palette.hex(0xFF1A2B3C));
    }

    @Test public void contrastIsWcag() {
        assertEquals(21, Palette.contrast(0xFFFFFFFF, 0xFF000000), 0.01);
        assertEquals(21, Palette.contrast(0xFF000000, 0xFFFFFFFF), 0.01);
        assertEquals(1, Palette.contrast(0xFF777777, 0xFF777777), 0.0001);
        assertEquals(0xFFFFFFFF, Palette.onColor(0xFF1D4ED8));
        assertEquals(Palette.INK, Palette.onColor(0xFFFACC15));
    }

    @Test public void everyTemplateHasSixOrMoreKnownVariants() {
        for (String t : TEMPLATES) {
            List<String> v = Palette.variants(t);
            assertTrue(t + " has " + v.size(), v.size() >= 6);
            assertEquals(t + " repeats a colour", v.size(), new HashSet<>(v).size());
            for (String id : v) assertTrue(t + ": " + id, Palette.known(id));
        }
    }

    @Test public void variantsAreReadableInBothTones() {
        for (String t : TEMPLATES) {
            for (String id : Palette.variants(t)) {
                int light = Palette.color(t, id, false), dark = Palette.color(t, id, true);
                // light: white text on it, and it as text on white
                assertTrue(t + "/" + id + " light " + Palette.hex(light), Palette.contrast(0xFFFFFFFF, light) >= 5.9);
                assertEquals(0xFFFFFFFF, Palette.onColor(light));
                // dark: it on the dark background, and dark text on it
                assertTrue(t + "/" + id + " dark " + Palette.hex(dark), Palette.contrast(dark, Palette.INK) >= Palette.target(t, true) - 0.1);
                assertTrue(Palette.contrast(Palette.onColor(dark), dark) >= 4.5);
            }
        }
    }

    @Test public void shadesAreTheLightestThatRead() {
        // A little lighter would not reach the contrast any more: the colour is as bright as it may be.
        for (String id : Palette.variants("glass")) {
            float[] hsl = hsl(Palette.color("glass", id, false));
            assertTrue(id, Palette.contrast(0xFFFFFFFF, Palette.hsl(hsl[0], hsl[1], hsl[2] + 0.02)) < 6);
        }
    }

    @Test public void brightTemplatesKeepBrightVariants() {
        for (String id : Palette.variants("terminal")) assertTrue(id, Palette.contrast(Palette.color("terminal", id, true), Palette.INK) >= 9.9);
        assertTrue(Palette.contrast(Palette.color("midnight", "violet", true), Palette.INK) < 9);
    }

    @Test public void lookupAndUnknowns() {
        assertTrue(Palette.has("ios", "red"));
        assertFalse(Palette.has("nord", "red"));
        assertFalse(Palette.has("ios", ""));
        assertFalse(Palette.has("ios", null));
        assertEquals(Palette.variants("design"), Palette.variants("no-such-template"));
        assertEquals(Palette.variants("design"), Palette.variants(null));
        assertNull(Palette.color("ios", "no-such-colour", false));
        assertNotNull(Palette.color("no-such-template", "red", true));
        // The design's list starts with the web's five accents (6.1's appearance.accent).
        assertEquals(List.of("red", "orange", "green", "blue", "violet"), Palette.variants("design").subList(0, 5));
    }

    /** ARGB → {h, s, l} (to step a shade a little lighter). */
    private static float[] hsl(int c) {
        double r = (c >> 16 & 0xFF) / 255.0, g = (c >> 8 & 0xFF) / 255.0, b = (c & 0xFF) / 255.0;
        double max = Math.max(r, Math.max(g, b)), min = Math.min(r, Math.min(g, b)), l = (max + min) / 2, d = max - min;
        double h = 0, s = d == 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
        if (d != 0) {
            if (max == r) h = 60 * (((g - b) / d) % 6);
            else if (max == g) h = 60 * ((b - r) / d + 2);
            else h = 60 * ((r - g) / d + 4);
        }
        return new float[]{(float) ((h + 360) % 360), (float) s, (float) l};
    }
}
