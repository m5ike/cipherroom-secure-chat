package cz.m5cet.app.chat;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

/** 6.7 (audit N18): a sealed message cannot make the phone run PBKDF2 for hours. */
public class SealedBoundTest {
    @Test
    public void aHugeIterationCountFromTheSenderIsRefusedAtOnce() throws Exception {
        JSONObject meta = new JSONObject();
        String ct = Sealed.seal("zpráva", "WXYZ-2345-6789", meta)[0];
        assertEquals("zpráva", Sealed.open(ct, meta, "WXYZ-2345-6789"));
        long t0 = System.currentTimeMillis();
        assertNull(Sealed.open(ct, new JSONObject(meta.toString()).put("it", 2_000_000_000L), "WXYZ-2345-6789"));
        assertNull(Sealed.open(ct, new JSONObject(meta.toString()).put("it", 0), "WXYZ-2345-6789"));
        assertNull(Sealed.open(ct, new JSONObject(meta.toString()).put("it", -5), "WXYZ-2345-6789"));
        assertTrue("refused without deriving", System.currentTimeMillis() - t0 < 1000);
    }
}
