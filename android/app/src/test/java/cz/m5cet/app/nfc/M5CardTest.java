package cz.m5cet.app.nfc;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.json.JSONObject;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import cz.m5cet.app.security.Crypto;

/**
 * The Java port of the M5Cet card format against what the web really seals
 * (client/src/lib/nfc/m5card.ts). The vectors below were produced by that very
 * module (buildCard + removeRecord); the test opens exactly those bytes, so the
 * container is byte-for-byte compatible in both directions.
 *
 * If m5card.ts changes, regenerate these constants (see the final report) — and
 * script/android-vectors.ts carries the same vectors for the shared fixture.
 */
public class M5CardTest {
    // A web-sealed container: [wifi (external, PIN 482915), message (internal, root 00..1f), one-time-message (external)].
    private static final String PIN = "482915";
    private static final byte[] ROOT = Crypto.unhex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
    private static final String CONTAINER =
        "TTVDRAEAAwgAAOs4ghAbgqD+MWKDi4euZa5QpEG9DLPxV8AH3c2zufccWgBHXKCj8vTwKQxjXKHrGhxZ1L/tPKcUreplYLNIl7DSbJQslwRqD/FuiC+EdNX4anQZh5Soz8vm3F6yTPWxsCX0iH2kwAZnsTYEAQCYC90QLUCQxFiYB3pHED+aPfE/pQxvp92T2KLfpmfztiUAL/jM7aW27KcxS3/osrN0C6m37lqb6BdBrk+PU4do7ulPkf/y6mYfAmznKU75xhavAwABIlWoEO5xQED6MiCMX0fVexwc/B0Mp437NiV5UHEtomrMACLEi3ai5yi/H0HhnHpTPFHsAJqg0e3NnCKCuz4MfoVF/yy2";
    private static final String AFTER_REMOVE_ONE_TIME =
        "TTVDRAEAAggAAOs4ghAbgqD+MWKDi4euZa5QpEG9DLPxV8AH3c2zufccWgBHXKCj8vTwKQxjXKHrGhxZ1L/tPKcUreplYLNIl7DSbJQslwRqD/FuiC+EdNX4anQZh5Soz8vm3F6yTPWxsCX0iH2kwAZnsTYEAQCYC90QLUCQxFiYB3pHED+aPfE/pQxvp92T2KLfpmfztiUAL/jM7aW27KcxS3/osrN0C6m37lqb6BdBrk+PU4do7ulPkf/y6mYfAmznKU75xhav";
    private static final int ONE_TIME_ID = 2250152;

    private static M5Card.Sealed byType(List<M5Card.Sealed> recs, String type) {
        for (M5Card.Sealed s : recs) if (s.type.equals(type)) return s;
        throw new IllegalStateException("no record " + type);
    }

    @Test
    public void opensWhatTheWebSealed() throws Exception {
        byte[] container = Crypto.unb64(CONTAINER);
        assertTrue(M5Card.isM5Card(container));
        List<M5Card.Sealed> recs = M5Card.decodeContainer(container);
        assertEquals(3, recs.size());
        M5Card.KeyProvider keys = M5Card.keys(PIN, ROOT);

        // external (PIN) record
        M5Card.Sealed wifi = byType(recs, "wifi");
        assertEquals(M5Card.MODE_EXTERNAL, wifi.mode);
        JSONObject w = M5Card.open(wifi, keys).data;
        assertEquals("M5cet", w.getString("ssid"));
        assertEquals("tajné heslo", w.getString("password"));

        // internal (account root) record
        M5Card.Sealed msg = byType(recs, "message");
        assertEquals(M5Card.MODE_INTERNAL, msg.mode);
        assertEquals("Ahoj z webu ✓ 🔒", M5Card.open(msg, keys).data.getString("text"));

        // one-time record
        M5Card.Sealed one = byType(recs, "one-time-message");
        assertTrue(one.oneTime);
        assertEquals("zmizím", M5Card.open(one, keys).data.getString("text"));
    }

    @Test
    public void wrongPinIsRejected() {
        byte[] container = Crypto.unb64(CONTAINER);
        M5Card.Sealed wifi = byType(M5Card.decodeContainer(container), "wifi");
        try { M5Card.open(wifi, M5Card.keys("000000", ROOT)); fail("wrong PIN opened"); }
        catch (Exception expected) { /* GeneralSecurityException */ }
    }

    @Test
    public void removeOneTimeMatchesTheWebByteForByte() {
        byte[] container = Crypto.unb64(CONTAINER);
        byte[] after = M5Card.removeRecord(container, ONE_TIME_ID);
        assertEquals(AFTER_REMOVE_ONE_TIME, Crypto.b64(after));
        assertEquals(2, M5Card.decodeContainer(after).size());
    }

    @Test
    public void javaRoundTripsExternalAndInternal() throws Exception {
        M5Card.KeyProvider keys = M5Card.keys("135790", ROOT);
        List<M5Card.Record> recs = new ArrayList<>();
        M5Card.Record ext = new M5Card.Record("url-login", M5Card.MODE_EXTERNAL, new JSONObject().put("url", "https://m5cet.cz").put("user", "sokol").put("password", "p"));
        M5Card.Record intr = new M5Card.Record("server-room", M5Card.MODE_INTERNAL, new JSONObject().put("server", "s").put("room", "team").put("passphrase", "pp"));
        intr.oneTime = true;
        recs.add(ext);
        recs.add(intr);
        byte[] container = M5Card.buildCard(recs, keys);
        assertTrue(M5Card.isM5Card(container));
        List<M5Card.Sealed> back = M5Card.decodeContainer(container);
        assertEquals(2, back.size());
        assertEquals("https://m5cet.cz", M5Card.open(byType(back, "url-login"), keys).data.getString("url"));
        M5Card.Record openedRoom = M5Card.open(byType(back, "server-room"), keys);
        assertEquals("team", openedRoom.data.getString("room"));
        assertTrue(openedRoom.oneTime);
    }

    @Test
    public void decodeSkipsUnknownRecordTypes() {
        // "M5CD" ver1 flags0 count1 | type=99 mode0 rflags0 id(3)=0 salt(len0) iv(len0) ct(u16=0)
        byte[] bad = {'M', '5', 'C', 'D', 1, 0, 1, (byte) 99, 0, 0, 0, 0, 0, 0, 0, 0, 0};
        assertTrue(M5Card.isM5Card(bad));
        assertEquals(0, M5Card.decodeContainer(bad).size()); // unknown type skipped, not fatal
    }

    @Test
    public void validatesPins() {
        assertTrue(M5Card.isValidPin("123456"));
        assertTrue(M5Card.isValidPin("123456789012345678"));
        assertFalse(M5Card.isValidPin("12345"));
        assertFalse(M5Card.isValidPin("1234567890123456789"));
        assertFalse(M5Card.isValidPin("12ab56"));
    }

    @Test
    public void notAnM5CardIsRejected() {
        assertFalse(M5Card.isM5Card(new byte[]{1, 2, 3}));
        assertFalse(M5Card.isM5Card("NOPE___".getBytes()));
        assertNotNull(Crypto.unb64(CONTAINER));
    }
}
