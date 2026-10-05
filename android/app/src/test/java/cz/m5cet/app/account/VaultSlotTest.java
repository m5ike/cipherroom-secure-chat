package cz.m5cet.app.account;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.json.JSONObject;
import org.junit.Test;

import java.security.GeneralSecurityException;

import cz.m5cet.app.security.Crypto;

/** 6.12 (F-26): vault slots v2 — opened as the web seals them (passkey.ts sealSlot), v1 still read, bound to the slot. */
public class VaultSlotTest {
    /** The web's sealSlot with the raw AES key (i * 11 + 5): the "card" at rev 1800000000123, the "registration" at …456. */
    static final String KEY = "BRAbJjE8R1JdaHN+iZSfqrXAy9bh7PcCDRgjLjlET1o=";
    static final String WEB_CARD = "TTVWMgAAAaMYXFB7CLeeZ7w1AcPkmCxknzruLap0CQHD50LedLgxr4Z/UkWo1J9CYU8+t0gBVbkR5fx+cQXziKPJHE6pouDvctllfjmWnH5bycKTDLb/PI2NjOiO5w==";
    static final String WEB_REGISTRATION = "TTVWMgAAAaMYXFHItUXCoIHThKywQWvS8KzLwYII0kthlsWJ0CYjqCRPchF0bQ061p+IjA==";

    @Test
    public void opensTheWebsV2Slots() throws Exception {
        byte[] key = Crypto.unb64(KEY);
        AccountKeys.Slot card = AccountKeys.openSlot(WEB_CARD, key, "card");
        assertFalse(card.legacy);
        assertEquals(1800000000123L, card.rev);
        assertEquals("Žofie", card.value.getString("nick"));
        assertTrue(card.value.getJSONObject("audiences").getBoolean("room"));
        assertEquals("A", AccountKeys.openSlot(WEB_REGISTRATION, key, "registration").value.getString("name"));
        // A slot's ciphertext handed back as another slot does not open.
        try { AccountKeys.openSlot(WEB_CARD, key, "profile"); fail(); } catch (GeneralSecurityException expected) { }
        try { AccountKeys.openSlot(WEB_REGISTRATION, key, "card"); fail(); } catch (GeneralSecurityException expected) { }
    }

    @Test
    public void sealsV2AndStillReadsV1() throws Exception {
        byte[] key = Crypto.unb64(KEY);
        JSONObject value = new JSONObject().put("x", 1).put("y", "z");
        String v2 = AccountKeys.sealSlot(value, key, "card", 42);
        assertTrue(Crypto.str(java.util.Arrays.copyOf(Crypto.unb64(v2), 4)).equals("M5V2"));
        AccountKeys.Slot back = AccountKeys.openSlot(v2, key, "card");
        assertEquals(42, back.rev);
        assertEquals("z", back.value.getString("y"));
        // Another revision in the header fails (it is in the AAD).
        byte[] raw = Crypto.unb64(v2);
        raw[11] ^= 1;
        try { AccountKeys.openSlot(Crypto.b64(raw), key, "card"); fail(); } catch (GeneralSecurityException expected) { }
        // A v1 part (6.11 and older) opens, marked legacy.
        AccountKeys.Slot old = AccountKeys.openSlot(AccountKeys.sealProfile(value, key), key, "card");
        assertTrue(old.legacy);
        assertEquals(0, old.rev);
        assertEquals(1, old.value.getInt("x"));
    }
}
