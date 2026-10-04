package cz.m5cet.app.ui;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

/** 6.7 (F-01): a design cannot carry decrypted content off the phone in an image address. */
public class DesignUrlsTest {
    private static final Expr.Translate TR = (k) -> k;

    /** The bubble's scope: a decrypted message. */
    private static Expr.Scope msg(String text) {
        JSONObject m = new JSONObject();
        try { m.put("text", text).put("photo", "data:image/png;base64,iVBORw0KGgo="); } catch (Exception e) { throw new IllegalStateException(e); }
        return n -> n.equals("msg") ? m : null;
    }

    private static String load(String raw, Expr.Scope sc) {
        return DesignUrls.image(raw, Expr.toText(Expr.value(raw, sc, TR)));
    }

    @Test
    public void aTemplatedRemoteImageIsNotFetched() {
        Expr.Scope sc = msg("the secret plaintext");
        assertEquals("", load("https://evil.example/{$msg.text}", sc));
        assertEquals("", load("https://evil.example/x.png?{$msg.text|upper}", sc));
        assertEquals("", load("=$msg.text", msg("https://evil.example/leak")));      // the data itself is a URL
        assertEquals("", load("{$msg.text}", msg("https://evil.example/leak")));
    }

    @Test
    public void localSourcesMayBeComputed() {
        Expr.Scope sc = msg("hi");
        assertEquals("data:image/png;base64,iVBORw0KGgo=", load("=$msg.photo", sc));
        assertEquals("asset:logo.png", load("asset:logo.png", sc));
        assertEquals("asset:hi", load("asset:{$msg.text}", sc));
    }

    @Test
    public void aFixedRemoteImageStays() {
        assertEquals("https://cdn.example/logo.png", load("https://cdn.example/logo.png", msg("x")));
        assertEquals("https://cdn.example/logo.png", DesignUrls.image(" https://cdn.example/logo.png ", "https://cdn.example/logo.png"));
    }

    @Test
    public void urlOpenOffersOnlyWhatThePersonCanReadInFull() {
        // 6.10 (G-20): the dialog showed 299 characters and opened all of them.
        assertTrue(DesignUrls.openable("https://help.example/android?x=1#top"));
        StringBuilder at = new StringBuilder("https://e.example/");
        while (at.length() < DesignUrls.URL_MAX) at.append('a');
        assertTrue(DesignUrls.openable(at.toString()));
        assertFalse("one more character", DesignUrls.openable(at + "a"));
        assertFalse(DesignUrls.openable("https://e.example/a b"));
        assertFalse(DesignUrls.openable("https://e.example/a\tb"));
        assertFalse(DesignUrls.openable("https://e.example/a\nb"));
        assertFalse("no-break space", DesignUrls.openable("https://e.example/a b"));
        assertFalse("right-to-left override", DesignUrls.openable("https://e.example/‮gnp.exe"));
        assertFalse("isolate", DesignUrls.openable("https://e.example/⁦x⁩"));
        assertFalse("zero-width space", DesignUrls.openable("https://e.example/a​b"));
        assertFalse("byte order mark", DesignUrls.openable("https://e.example/﻿"));
        assertFalse("a control character", DesignUrls.openable("https://e.example/\u0000"));
        assertFalse(DesignUrls.openable("http://e.example/"));
        assertFalse(DesignUrls.openable("https://"));
        assertFalse(DesignUrls.openable("javascript:alert(1)"));
        assertFalse(DesignUrls.openable(null));
    }

    @Test
    public void anythingElseIsRefused() {
        assertEquals("", DesignUrls.image("http://plain.example/x.png", "http://plain.example/x.png"));
        assertEquals("", DesignUrls.image("file:///sdcard/x.png", "file:///sdcard/x.png"));
        assertEquals("", DesignUrls.image("content://x/y", "content://x/y"));
        assertEquals("", DesignUrls.image(null, "https://cdn.example/a.png")); // no literal to compare with
        assertEquals("", DesignUrls.image("https://a", null));
        assertEquals("", DesignUrls.image("https://a.example/x", "https://b.example/x"));
    }
}
