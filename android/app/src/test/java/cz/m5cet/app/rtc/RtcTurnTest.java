package cz.m5cet.app.rtc;

import static org.junit.Assert.assertEquals;

import org.json.JSONObject;
import org.junit.Test;

/** 6.12: /api/turn answers STUN only ("pending") until the device's hub socket is live — never cached. */
public class RtcTurnTest {
    @Test
    public void pendingAnswerIsNeverCached() throws Exception {
        long now = 1_800_000_000_000L;
        assertEquals(0, Rtc.cacheUntil(new JSONObject().put("pending", true).put("ttlSeconds", 0).put("expiresAt", now), now));
        assertEquals(0, Rtc.cacheUntil(new JSONObject().put("pending", true).put("ttlSeconds", 3600), now));
        assertEquals(0, Rtc.cacheUntil(null, now));
    }

    @Test
    public void fullAnswerIsCachedForItsLifetime() throws Exception {
        long now = 1_800_000_000_000L;
        assertEquals(now + (3600 - 60) * 1000L, Rtc.cacheUntil(new JSONObject().put("ttlSeconds", 3600), now));
        assertEquals(now + 10 * 60_000L, Rtc.cacheUntil(new JSONObject().put("ttlSeconds", 0), now));
        assertEquals(now + 10 * 60_000L, Rtc.cacheUntil(new JSONObject().put("pending", false), now));
    }
}
