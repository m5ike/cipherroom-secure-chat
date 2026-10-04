package cz.m5cet.app.security;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** 6.10 (G-23): a room extra counts only from the app's own intent — its tag binds purpose and room to this process. */
public class IntentSealTest {
    private static final byte[] K1 = Crypto.unhex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
    private static final byte[] K2 = Crypto.unhex("ff0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");

    @Test
    public void aTagFitsItsRoomAndPurposeOnly() {
        String tag = IntentSeal.tag(K1, IntentSeal.REPLY, "room-a");
        assertEquals(22, tag.length()); // 128 bits, base64url
        assertTrue(IntentSeal.valid(K1, IntentSeal.REPLY, "room-a", tag));
        assertFalse("the room replaced (a mutable reply PendingIntent)", IntentSeal.valid(K1, IntentSeal.REPLY, "room-b", tag));
        assertFalse("another purpose", IntentSeal.valid(K1, IntentSeal.OPEN, "room-a", tag));
        assertFalse("another process", IntentSeal.valid(K2, IntentSeal.REPLY, "room-a", tag));
        assertNotEquals(tag, IntentSeal.tag(K1, IntentSeal.OPEN, "room-a"));
    }

    @Test
    public void nothingWithoutATag() {
        assertFalse(IntentSeal.valid(K1, IntentSeal.OPEN, "room-a", null));
        assertFalse(IntentSeal.valid(K1, IntentSeal.OPEN, "room-a", ""));
        assertFalse(IntentSeal.valid(K1, IntentSeal.OPEN, null, IntentSeal.tag(K1, IntentSeal.OPEN, "")));
        assertFalse("no room", IntentSeal.valid(K1, IntentSeal.OPEN, "", IntentSeal.tag(K1, IntentSeal.OPEN, "")));
        assertFalse(IntentSeal.valid(K1, null, "room-a", "x"));
        assertFalse("a token another app guessed", IntentSeal.valid(K1, IntentSeal.OPEN, "room-a", "AAAAAAAAAAAAAAAAAAAAAA"));
    }

    @Test
    public void thisProcessKeyWorksAndIsItsOwn() {
        String t = IntentSeal.tag(IntentSeal.OPEN, "rodina");
        assertTrue(IntentSeal.valid(IntentSeal.OPEN, "rodina", t));
        assertFalse(IntentSeal.valid(IntentSeal.OPEN, "prace", t));
        assertFalse("not a fixed key", IntentSeal.valid(K1, IntentSeal.OPEN, "rodina", t));
    }
}
