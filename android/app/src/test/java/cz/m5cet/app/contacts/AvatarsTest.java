package cz.m5cet.app.contacts;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/** The monogram and its colours, the same as the web's (UserBadge.tsx: avatarGlyphFor, hueFor; vectors from Node). */
public class AvatarsTest {
    @Test
    public void glyphs() {
        assertEquals("A", Avatars.glyph("alice", null));
        assertEquals("Ž", Avatars.glyph(" žofie", null));
        assertEquals("?", Avatars.glyph("", null));
        assertEquals("?", Avatars.glyph(null, null));
        assertEquals("😀", Avatars.glyph("😀x", null));
        assertEquals("SS", Avatars.glyph("ßtraße", null));
        // A short emoji avatar wins; anything that looks like a URL or path does not.
        assertEquals("🦊", Avatars.glyph("alice", "🦊"));
        assertEquals("A", Avatars.glyph("alice", "https://x"));
        assertEquals("A", Avatars.glyph("alice", "abc"));
    }

    @Test
    public void huesAsTheWebComputesThem() {
        assertEquals(0, Avatars.hue("alice"));
        assertEquals(314, Avatars.hue("tomáš"));
        assertEquals(201, Avatars.hue("Žofie"));
        assertEquals(63, Avatars.hue("?"));
        assertEquals(63, Avatars.hue(""));
        assertEquals(273, Avatars.hue("bystry-sokol-7k3q"));
        assertEquals(229, Avatars.hue("😀x"));
        assertEquals(Avatars.hue("Alice"), Avatars.hue("alice"));
    }

    @Test
    public void hslAsCssComputesIt() {
        assertEquals(0xffff0000, Avatars.hsl(0, 1f, 0.5f, 1f));
        assertEquals(0xff00ff00, Avatars.hsl(120, 1f, 0.5f, 1f));
        assertEquals(0xff0000ff, Avatars.hsl(240, 1f, 0.5f, 1f));
        assertEquals(0xff808080, Avatars.hsl(77, 0f, 0.5f, 1f));
        // hsl(0 70% 42%) = rgb(182, 32, 32); hsl(0 62% 42% / 0.22) = rgba(174, 41, 41, 0.22)
        assertEquals("#ffb62020", Avatars.foreground("alice"));
        assertEquals("#38ae2929", Avatars.background("alice"));
    }
}
