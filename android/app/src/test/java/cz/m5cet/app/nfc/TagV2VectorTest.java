package cz.m5cet.app.nfc;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import cz.m5cet.app.InteropTest;
import cz.m5cet.app.security.Crypto;

/**
 * NFC connection tag v2 (protocol 4 § 16) against the web's vectors
 * (test/vectors/nfc-tag-v2.json, script/nfc-tag-vectors.ts): codes, the
 * offline tag's Argon2id key, AAD, ciphertext and exact body (both costs), the
 * invitation's link key, code and body; and the share invitation it rides on,
 * sealed by the web and opened here.
 */
public class TagV2VectorTest {
    static JSONObject vectors() throws Exception {
        java.nio.file.Path f = InteropTest.fixtures().getParent().resolve("vectors").resolve("nfc-tag-v2.json");
        return new JSONObject(new String(Files.readAllBytes(f), StandardCharsets.UTF_8));
    }

    @Test
    public void offlineTagsByteForByte() throws Exception {
        JSONArray cases = vectors().getJSONArray("offline");
        assertEquals(2, cases.length());
        for (int i = 0; i < cases.length(); i++) {
            JSONObject c = cases.getJSONObject(i);
            int m = c.getJSONObject("kdf").getInt("memoryKiB"), passes = c.getJSONObject("kdf").getInt("passes");
            assertEquals(c.getString("canonicalCode"), TagV2.normalize(c.getString("code"), TagV2.OFFLINE_CODE_SYMBOLS));
            assertEquals(c.getString("code"), TagV2.format(c.getString("canonicalCode")));
            JSONObject tag = c.getJSONObject("tag");
            assertEquals(c.getString("argon2idKeyHex"), Crypto.hex(TagV2.offlineKey(c.getString("canonicalCode"), m, passes, tag.getString("s"))));
            assertEquals(c.getString("aad"), new String(TagV2.offlineAad(m, passes, tag.getString("s")), StandardCharsets.US_ASCII));
            JSONObject plain = new JSONObject(c.getString("plaintext"));
            TagV2.Tag sealed = TagV2.sealOffline(new TagV2.Room(plain.getString("room"), plain.getString("passphrase"), plain.optString("name"), null),
                c.getString("code"), m, passes, Crypto.unhex(c.getString("saltHex")), Crypto.unhex(c.getString("ivHex")));
            assertEquals(c.getString("body"), TagV2.serialize(sealed));
            TagV2.Tag parsed = TagV2.parse(c.getString("body"));
            assertEquals(c.getString("body"), TagV2.serialize(parsed));
            TagV2.Room room = TagV2.openOffline(parsed, c.getString("code").toLowerCase(java.util.Locale.ROOT).replace("-", " "));
            assertEquals("brno-secure", room.room);
            assertEquals(plain.getString("passphrase"), room.passphrase);
            assertEquals("Alice", room.name);
            // A wrong code, or a changed parameter (it is in the AAD), fails.
            try { TagV2.openOffline(parsed, "7K3QD-M9X2V-PH4TW-8RZ6P"); fail(); } catch (TagV2.TagError e) { assertEquals("auth-failed", e.code); }
            if (m == 64) {
                String other = c.getString("body").replace("\"i\":1", "\"i\":2");
                try { TagV2.openOffline(TagV2.parse(other), c.getString("code")); fail(); } catch (TagV2.TagError e) { assertEquals("auth-failed", e.code); }
            }
        }
    }

    @Test
    public void invitationKeysAndBody() throws Exception {
        JSONObject v = vectors().getJSONObject("invite");
        Object[] keys = TagV2.inviteKeys(v.getString("id"), v.getString("k"));
        assertEquals(v.getString("linkKeyHex"), Crypto.hex((byte[]) keys[0]));
        assertEquals(v.getString("code"), keys[1]);
        TagV2.Tag tag = TagV2.parse(v.getString("body"));
        assertTrue(tag.invite());
        assertEquals(v.getString("origin"), tag.o);
        assertEquals(v.getString("body"), TagV2.serialize(tag));
    }

    @Test
    public void codesAndOrigins() throws Exception {
        assertEquals("0123456789ABCDEFGHJKMNPQRS", TagV2.normalize("o123-4567-89ab-cdef-ghjk-mnpq-rs", 26));
        assertEquals("1111", TagV2.normalize("iIlL", 4));
        assertNull(TagV2.normalize("UUUU", 4));
        assertNull(TagV2.normalize("ABC", 4));
        assertEquals(20, TagV2.newCode().length());
        assertNotNull(TagV2.normalize(TagV2.newCode(), 20));
        assertEquals("https://chat.example.org", TagV2.safeOrigin("https://chat.example.org/"));
        assertEquals("https://chat.example.org:8443", TagV2.safeOrigin("https://chat.example.org:8443"));
        assertEquals("http://localhost:5173", TagV2.safeOrigin("http://localhost:5173"));
        assertNull(TagV2.safeOrigin("http://chat.example.org"));
        assertNull(TagV2.safeOrigin("https://user:pw@chat.example.org"));
        assertNull(TagV2.safeOrigin("ftp://x"));
        TagV2.Tag inv = TagV2.newInvite("https://chat.example.org/");
        assertEquals(26, inv.k.length());
        assertEquals(inv.k, TagV2.parse(TagV2.serialize(inv)).k);
    }

    @Test
    public void malformedTagsAreRefused() {
        String[] bad = {
            "m5cet:nfc:v2:{\"v\":3,\"t\":\"inv\"}",
            "m5cet:nfc:v2:{\"v\":2,\"t\":\"inv\",\"o\":\"http://evil.example\",\"id\":\"QEFCQ0RFRkdISUpLTE1OTw\",\"k\":\"0123456789ABCDEFGHJKMNPQRS\"}",
            "m5cet:nfc:v2:{\"v\":2,\"t\":\"off\",\"kdf\":\"argon2id\",\"m\":1048576,\"i\":3,\"p\":1,\"s\":\"EBESExQVFhcYGRobHB0eHw\",\"n\":\"oKGio6Slpqeoqaqr\",\"c\":\"xxxxxxxxxxxxxxxxxxxxxxxxxx\"}",
            "m5cet:nfc:v2:{\"v\":2,\"t\":\"off\",\"kdf\":\"pbkdf2\",\"m\":64,\"i\":1,\"p\":1,\"s\":\"EBESExQVFhcYGRobHB0eHw\",\"n\":\"oKGio6Slpqeoqaqr\",\"c\":\"xxxxxxxxxxxxxxxxxxxxxxxxxx\"}",
            "m5cet:nfc:v2:{\"v\":2,\"t\":\"x\"}",
            "m5cet:nfc:v2:not json",
        };
        for (String b : bad) {
            try { TagV2.parse(b); fail(b); } catch (TagV2.TagError e) { assertEquals("card-error", e.code); }
        }
    }

    /** The share invitation an invitation tag rides on: sealed by the web (lib/share-link.ts), opened here; the proof the server checks. */
    @Test
    public void shareInvitationSealedByTheWeb() throws Exception {
        String id = "QEFCQ0RFRkdISUpLTE1OTw", k = "0123456789ABCDEFGHJKMNPQRS";
        Object[] keys = TagV2.inviteKeys(id, k);
        String code = (String) keys[1];
        assertEquals("752592939447", code);
        assertEquals("-CygMqG2SOyIRHk4g4XR2HWNgzHOjNePieK-7EJxSpU", ShareInvite.proof(code, id));
        TagV2.Room room = ShareInvite.open(code, id, (byte[]) keys[0], ShareInvite.fromB64url("AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw"), "fPLXx5czTcWqq7V6",
            "rPVoM_mA633NCAnepDQ1fG6wd_fVRD_N2CgySRhI4W79D6wKQSfdrhrZewZ3RFeB3flN4mZYCEaDkhDkClE5hYxCV5Ez9Evc8u2Bc_mmqtgiaM1l2xdYaXKvHPjVWpWOKtAP1amA4YRqYJQOOLE-cLRCW98uFcVKE2HctqwCneA");
        assertEquals("brno-secure", room.room);
        assertEquals("Kq7xVm-2PnRt4-Wz9cLd-8HsJ3e", room.passphrase);
        // And back: what this app seals opens with the same keys.
        byte[] serverKey = new byte[32];
        serverKey[3] = 9;
        String[] sealed = ShareInvite.seal(code, id, (byte[]) keys[0], serverKey, new JSONObject().put("v", 1).put("room", "r").put("passphrase", "p").put("name", "n").put("createdAt", 1));
        assertEquals("r", ShareInvite.open(code, id, (byte[]) keys[0], serverKey, sealed[0], sealed[1]).room);
        try { ShareInvite.open("000000000000", id, (byte[]) keys[0], serverKey, sealed[0], sealed[1]); fail(); } catch (java.security.GeneralSecurityException expected) { }
    }

    @Test
    public void readingFormatsAndTheWeakOldTag() throws Exception {
        JSONObject c = vectors().getJSONArray("offline").getJSONObject(0);
        ConnTag.Read r = ConnTag.open(c.getString("body"), "", "https://chat.example.org");
        assertEquals("v2-off", r.format);
        assertEquals("code", r.need);
        r = ConnTag.open(c.getString("body"), c.getString("code"), "https://chat.example.org");
        assertEquals("brno-secure", r.room.room);
        assertFalse(r.weak);
        r = ConnTag.open(c.getString("body"), "7K3QD-M9X2V-PH4TW-8RZ6P", "");
        assertEquals("wrong-code", r.error);
        // An invitation of another server is not redeemed here.
        r = ConnTag.open(vectors().getJSONObject("invite").getString("body"), "", "https://other.example");
        assertEquals("other-server", r.error);
        assertEquals("https://chat.example.org", r.origin);
        r = ConnTag.open(vectors().getJSONObject("invite").getString("body"), "", "https://chat.example.org", false);
        assertEquals("redeem", r.need);
        // Format 1 still opens with its PIN — marked weak.
        String v1 = Nfc.seal(new JSONObject().put("v", 1).put("room", "old-room").put("passphrase", "old-pass"), "4321");
        r = ConnTag.open(v1, "", "");
        assertEquals("v1", r.format);
        assertTrue(r.weak);
        assertEquals("pin", r.need);
        r = ConnTag.open(v1, "4321", "");
        assertEquals("old-room", r.room.room);
        assertTrue(r.weak);
        assertEquals("wrong-pin", ConnTag.open(v1, "1234", "").error);
        assertEquals("", ConnTag.open("hello", "", "").format);
    }

    @Test
    public void jsonQuotingIsJavaScripts() {
        assertEquals("\"a/b\"", TagV2.quote("a/b"));
        assertEquals("\"\\\"\\\\\\n\\u0001ž😀\"", TagV2.quote("\"\\\n\u0001ž😀"));
    }
}
