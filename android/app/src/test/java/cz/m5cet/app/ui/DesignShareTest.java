package cz.m5cet.app.ui;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

/**
 * 6.12 (security analysis G-20, the rest): the design's copy / share with a
 * computed text is shown first — exactly, hidden characters made visible,
 * never cut; the design's own text goes at once.
 */
public class DesignShareTest {
    private static final Expr.Translate TR = k -> k;

    private static Expr.Scope scope() {
        JSONObject msg = new JSONObject();
        try { msg.put("text", "the secret plaintext"); } catch (Exception e) { throw new IllegalStateException(e); }
        return n -> n.equals("msg") ? msg : null;
    }

    private static boolean computed(String raw) { return ActionGuard.computed(raw, raw == null ? null : Expr.value(raw, scope(), TR)); }

    @Test
    public void whichTextsAreConfirmedFirst() {
        // Read from data: shown and confirmed.
        assertTrue(computed("{$msg.text}"));
        assertTrue(computed("=$msg.text"));
        assertTrue(computed("Look: {$msg.text}"));
        assertTrue(computed("{$room.name}"));
        // The design's own words: at once.
        assertFalse(computed("https://help.example/android"));
        assertFalse(computed("{_'help.text'}"));
        assertFalse(computed("=_('help.text')"));
    }

    @Test
    public void theDialogShowsEverythingThatGoes() {
        assertEquals("plain text", DesignShare.shown("plain text"));
        assertEquals("two\nlines\tand a tab", DesignShare.shown("two\nlines\tand a tab"));
        assertEquals("Alice[U+202E]nimda", DesignShare.shown("Alice‮nimda"));
        assertEquals("a[U+200B]b[U+FEFF]", DesignShare.shown("a​b﻿"));
        assertEquals("bell[U+0007]", DesignShare.shown("bell\u0007"));
        assertEquals("emoji 🙂 kept", DesignShare.shown("emoji 🙂 kept"));
        assertEquals("", DesignShare.shown(null));
    }

    @Test
    public void tooLongIsRefusedNotCut() {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < DesignShare.MAX; i++) sb.append('x');
        assertTrue(DesignShare.fits(sb.toString()));
        assertFalse(DesignShare.fits(sb + "y"));
        // Code points: 2000 emoji fit (4000 chars).
        StringBuilder e = new StringBuilder();
        for (int i = 0; i < DesignShare.MAX; i++) e.append("🙂");
        assertTrue(DesignShare.fits(e.toString()));
        assertFalse(DesignShare.fits(null));
    }
}
