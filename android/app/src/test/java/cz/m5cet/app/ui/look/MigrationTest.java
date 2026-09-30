package cz.m5cet.app.ui.look;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Map;

/** 6.1's appearance keys → 6.2's, once. */
public class MigrationTest {
    @Test public void aWebAccentBecomesTheTemplatesVariant() {
        Map<String, Object> p = Migration.plan(0, "design", "violet", "", true);
        assertEquals("violet", p.get("look.variant"));
        assertEquals("", p.get("appearance.accent"));
        assertEquals(Migration.VERSION, p.get("look.v"));
        assertFalse(p.containsKey("appearance.preset"));
        // No preset stored yet is the design's look.
        assertEquals("blue", Migration.plan(0, "", "blue", "", true).get("look.variant"));
        // A template that offers the colour takes it too.
        assertEquals("red", Migration.plan(0, "ios", "red", "", true).get("look.variant"));
    }

    @Test public void anAccentTheTemplateDoesNotOfferStays() {
        Map<String, Object> p = Migration.plan(0, "nord", "red", "", true);
        assertFalse(p.containsKey("look.variant"));
        assertFalse(p.containsKey("appearance.accent"));
        assertEquals(Migration.VERSION, p.get("look.v"));
    }

    @Test public void aCustomColourStays() {
        Map<String, Object> p = Migration.plan(0, "design", "#12ab34", "", true);
        assertFalse(p.containsKey("look.variant"));
        assertFalse(p.containsKey("appearance.accent"));
    }

    @Test public void aChosenVariantIsKept() {
        Map<String, Object> p = Migration.plan(0, "design", "red", "teal", true);
        assertFalse(p.containsKey("look.variant"));
        assertFalse(p.containsKey("appearance.accent"));
    }

    @Test public void anUnknownTemplateFallsBackToTheDesign() {
        Map<String, Object> p = Migration.plan(0, "vaporwave", "green", "", false);
        assertEquals("design", p.get("appearance.preset"));
        assertEquals("green", p.get("look.variant"));
    }

    @Test public void onlyOnce() {
        assertTrue(Migration.plan(Migration.VERSION, "vaporwave", "red", "", false).isEmpty());
        assertTrue(Migration.plan(Migration.VERSION + 1, "design", "red", "", true).isEmpty());
    }
}
