package cz.m5cet.app.chat;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.BeforeClass;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.util.Base64;

import cz.m5cet.app.InteropTest;
import cz.m5cet.app.nfc.Nfc;

/**
 * 6.1 parity with the web client (test/fixtures/android-interop.json, made
 * by script/android-vectors.ts from the web's own code): sealed messages,
 * the NFC connection card, the binary chunk frame, and what a payload with
 * every 6.1 field becomes after the checks.
 */
public class ParityTest {
    static JSONObject v;

    @BeforeClass public static void load() throws Exception {
        v = new JSONObject(new String(java.nio.file.Files.readAllBytes(InteropTest.fixtures().resolve("android-interop.json")), StandardCharsets.UTF_8));
    }

    @Test public void opensTheWebsSealedMessage() throws Exception {
        JSONObject s = v.getJSONObject("sealed");
        assertEquals(s.getString("plain"), Sealed.open(s.getString("ciphertext"), s.getJSONObject("meta"), s.getString("code")));
        assertNull(Sealed.open(s.getString("ciphertext"), s.getJSONObject("meta"), s.getString("wrong")));
    }

    @Test public void sealsWhatTheWebCanOpenAgain() throws Exception {
        JSONObject meta = new JSONObject();
        String ct = Sealed.seal("zpráva", "WXYZ-2345-6789", meta)[0];
        assertEquals(2, meta.getInt("v"));
        assertEquals(600_000, meta.getInt("it"));
        assertEquals("zpráva", Sealed.open(ct, meta, "wxyz 2345 6789"));
        String code = Sealed.newCode();
        assertTrue(code.matches("^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$"));
    }

    @Test public void readsAndWritesTheWebsNfcCard() throws Exception {
        JSONObject n = v.getJSONObject("nfc");
        JSONObject card = Nfc.open(n.getString("blob"), n.getString("pin"));
        assertNotNull(card);
        assertEquals("team", card.getString("room"));
        assertEquals(n.getJSONObject("card").getString("passphrase"), card.getString("passphrase"));
        assertNull(Nfc.open(n.getString("blob"), "000000"));
        String mine = Nfc.seal(card, "1234");
        assertTrue(mine.startsWith("m5cet:nfc:v1:"));
        assertEquals("team", Nfc.open(mine, "1234").getString("room"));
        assertFalse(Nfc.validPin("12a4"));
    }

    @Test public void buildsTheWebsBinaryChunkFrame() throws Exception {
        JSONObject c = v.getJSONObject("binaryChunk");
        byte[] frame = Files.binaryFrame(c.getString("transferId"), c.getInt("seq"), Base64.getDecoder().decode(c.getString("iv")), Base64.getDecoder().decode(c.getString("ct")), (byte) 0x01);
        assertArrayEquals(Base64.getDecoder().decode(c.getString("frame")), frame);
    }

    @Test public void checksAPayloadLikeTheWeb() throws Exception {
        JSONObject p = v.getJSONObject("payload");
        JSONObject web = p.getJSONObject("web");
        ChatMessage m = Payloads.validate(p.getJSONObject("input"), "p-alice", "p-me");
        assertNotNull(m);
        assertEquals(web.getString("text"), m.text);
        assertEquals(web.getInt("ttlMinutes"), m.ttlMinutes);
        assertEquals(web.getLong("createdAt") + web.getInt("ttlMinutes") * 60_000L, m.expiresAt);
        JSONObject flags = web.getJSONObject("flags");
        assertEquals(flags.getBoolean("tap"), m.tap);
        assertEquals(flags.getInt("vanishSeconds"), m.vanishSeconds);
        assertEquals(flags.getJSONObject("sealed").getString("salt"), m.sealed.getString("salt"));
        assertEquals(2, m.to.size());
        assertEquals(web.getString("forwardedFrom"), m.forwardedFrom);
        assertEquals(web.getJSONObject("replyTo").getString("text"), m.replyToText);
        JSONObject loc = web.getJSONObject("loc");
        assertEquals(loc.getDouble("lat"), m.loc.getDouble("lat"), 1e-9);
        assertEquals(loc.getDouble("lon"), m.loc.getDouble("lon"), 1e-9);
        assertEquals(loc.getLong("acc"), m.loc.getLong("acc"));
        JSONObject att = web.getJSONObject("attachment");
        assertEquals(att.getString("name"), m.fileName);
        assertEquals(att.getString("mime"), m.fileMime);
        assertEquals(att.getString("dataUrl"), m.fileDataUrl);
        assertEquals("image".equals(att.getString("kind")), m.fileImage);
    }

    @Test public void receiptsAreBoundedAndBoundToTheirSender() throws Exception {
        JSONObject r = new JSONObject().put("kind", "receipt").put("id", "rcpt-1").put("senderId", "p-a").put("state", "read")
            .put("ids", new org.json.JSONArray().put("msg-1").put(7).put("").put("msg-2"));
        Payloads.Receipt ok = Payloads.receipt(r, "p-a", "p-me");
        assertNotNull(ok);
        assertEquals(2, ok.ids.size());
        assertNull(Payloads.receipt(r, "p-b", "p-me"));
        assertNull(Payloads.receipt(r.put("state", "seen"), "p-a", "p-me"));
    }

    @Test public void deliveryStatesOnlyGoUp() throws Exception {
        ChatMessage m = new ChatMessage();
        m.status = "sending";
        assertTrue(m.raise("sent"));
        assertTrue(m.raise("delivered"));
        assertFalse(m.raise("sent"));
        assertTrue(m.raise("read"));
        assertEquals("read", m.status);
        m.status = "queued";
        assertTrue(m.raise("sent"));
    }
}
